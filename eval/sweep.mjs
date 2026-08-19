// The eval sweep: how review fan width — the number of lenses a review is
// split across — trades off against recall, confirmed false positives,
// run-to-run stability and cost, and whether the answer moves when the
// practice corpus does. Kept, committed, and re-runnable: this is a
// measurement, not a diagnostic thrown away after use.
//
// This replaces `scripts/_diag-hypothesis.mjs`, whose credential resolution
// and retry-with-backoff transport are reused wholesale below (see
// `callOnce`) because they were already correct. Three things it got wrong,
// fixed here:
//
//   1. It fired all 10 calls at once and got ten HTTP 429s back — zero data.
//      Every call in a sweep, across every configuration, case and repeat,
//      goes through ONE pool capped at `--concurrency` (default 4). See
//      `runPool`.
//   2. It never priced itself before spending. This runner DEFAULTS TO A DRY
//      RUN that calls no model at all and prints exactly what a real run
//      would cost — configurations, model calls, prompt characters — before
//      anything is charged. Actually calling the API requires the explicit
//      `--spend` flag.
//   3. It called itself "deleted after use". This file is the opposite: a
//      kept, re-runnable measurement, because run-to-run stability is one of
//      the headline metrics and a single sample can never show it.
//
// This file imports rather than reimplements the pieces owned by sibling
// work: `./partition.mjs` (splits a practice corpus into a width-lens
// `LensSet`), `./score.mjs` (scores findings against a case's labelled
// truth), `./practices/practices.json` (the corpus) and
// `./corpus/<case-id>/{subject.md,diff.txt,truth.json}` (labelled cases).
// Those files may not exist yet — every reference to them below is
// defensive: absence is reported, never a crash.

import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import console from 'node:console';

import { buildPrompt } from '../dist/review/prompt.js';
import { parseReply } from '../dist/review/parseReply.js';
import { aggregate } from '../dist/review/verdict.js';
import { resolveSettings, renderMissing } from '../dist/review/settings.js';
import { keyFileReader } from '../dist/review/readers.js';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');

const DEFAULT_WIDTHS = [1, 2, 3, 5, 8, 13, 21, 34];
const DEFAULT_PRACTICE_COUNTS = ['full', 'half'];
const DEFAULT_REPEATS = 3;
const DEFAULT_CONCURRENCY = 4;
const VALID_PRACTICE_COUNTS = new Set(['full', 'half']);

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function requirePositiveInt(value, flag) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${flag} must be a positive integer, got ${JSON.stringify(value)}`);
  }
  return n;
}

// Value-taking flags accept EITHER `--flag=value` OR the two-argv-element
// `--flag value` shape (e.g. `--widths 1,3,8,21`) — a first real run needs to
// be scoped from a command line, without editing this file, and a sweep
// whose axes can only be changed by editing the source is a sweep whose past
// runs cannot be reproduced from a command line.
const VALUE_FLAGS = new Set([
  'concurrency',
  'repeats',
  'widths',
  'practice-counts',
  'practices-file',
  'corpus-dir',
  'results-dir',
]);

function applyOption(options, key, value) {
  switch (key) {
    case 'concurrency':
      options.concurrency = requirePositiveInt(value, '--concurrency');
      break;
    case 'repeats':
      options.repeats = requirePositiveInt(value, '--repeats');
      break;
    case 'widths':
      options.widths = value.split(',').map((v) => requirePositiveInt(v.trim(), '--widths'));
      break;
    case 'practice-counts':
      options.practiceCounts = value.split(',').map((v) => v.trim());
      for (const mode of options.practiceCounts) {
        if (!VALID_PRACTICE_COUNTS.has(mode)) {
          throw new Error(
            `--practice-counts entries must be "full" or "half", got ${JSON.stringify(mode)}`,
          );
        }
      }
      break;
    case 'practices-file':
      options.practicesFile = value;
      break;
    case 'corpus-dir':
      options.corpusDir = value;
      break;
    case 'results-dir':
      options.resultsDir = value;
      break;
    default:
      throw new Error(`unknown option: --${key}`);
  }
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--spend') {
      options.spend = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (!arg.startsWith('--')) {
      throw new Error(`unrecognised argument: ${arg}`);
    }
    const eq = arg.indexOf('=');
    if (eq > 0) {
      applyOption(options, arg.slice(2, eq), arg.slice(eq + 1));
      continue;
    }
    const key = arg.slice(2);
    if (!VALUE_FLAGS.has(key)) {
      throw new Error(`unknown option: --${key}`);
    }
    const value = argv[i + 1];
    if (value === undefined) {
      throw new Error(`--${key} requires a value`);
    }
    i += 1;
    applyOption(options, key, value);
  }
  return options;
}

function printHelp() {
  console.log(
    [
      'Usage: node eval/sweep.mjs [options]',
      '',
      'Sweeps review fan width against the practice corpus. Defaults to a DRY RUN',
      'that calls no model and spends nothing.',
      '',
      'Options:',
      '  --spend                  Actually call the model. Without this, nothing is charged.',
      `  --concurrency N          Cap on simultaneous model calls (default ${DEFAULT_CONCURRENCY}).`,
      `  --widths 1,3,8,21        Fan widths to sweep (default ${DEFAULT_WIDTHS.join(',')}).`,
      `  --practice-counts full,half  Corpus sizes to sweep (default ${DEFAULT_PRACTICE_COUNTS.join(',')}).`,
      `  --repeats N              Repeats per configuration (default ${DEFAULT_REPEATS}).`,
      '  --practices-file PATH    Override eval/practices/practices.json.',
      '  --corpus-dir PATH        Override eval/corpus.',
      '  --results-dir PATH       Override eval/results.',
      '  --help                   This message.',
      '',
      'Every value-taking flag above also accepts --flag=value, e.g. --widths=1,3,8,21.',
    ].join('\n'),
  );
}

// ---------------------------------------------------------------------------
// Inputs: practices, corpus, partition.mjs, score.mjs — every one optional
// at the point this file is written, so every load reports absence rather
// than throwing.
// ---------------------------------------------------------------------------

async function loadPractices(path) {
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch (cause) {
    const code = cause?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { found: false, path, reason: `not found (${code})` };
    }
    return { found: false, path, reason: `could not read: ${cause.message}` };
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (cause) {
    return { found: false, path, reason: `not valid JSON: ${cause.message}` };
  }
  const practices = Array.isArray(doc?.practices) ? doc.practices : null;
  if (practices === null) {
    return { found: false, path, reason: 'JSON has no `practices` array' };
  }
  return { found: true, path, practices, count: practices.length };
}

async function loadCorpus(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (cause) {
    const code = cause?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { found: false, dir, reason: `not found (${code})`, cases: [], incomplete: [] };
    }
    return {
      found: false,
      dir,
      reason: `could not read: ${cause.message}`,
      cases: [],
      incomplete: [],
    };
  }
  const cases = [];
  const incomplete = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const id = entry.name;
    const base = join(dir, id);
    const files = {
      'subject.md': join(base, 'subject.md'),
      'diff.txt': join(base, 'diff.txt'),
      'truth.json': join(base, 'truth.json'),
    };
    const missing = [];
    for (const [label, path] of Object.entries(files)) {
      try {
        await access(path);
      } catch {
        missing.push(label);
      }
    }
    if (missing.length > 0) {
      incomplete.push({ id, missing });
    } else {
      cases.push({
        id,
        subjectPath: files['subject.md'],
        diffPath: files['diff.txt'],
        truthPath: files['truth.json'],
      });
    }
  }
  return { found: true, dir, cases, incomplete };
}

/**
 * A case's `subject.md` has no format this file can assume — the corpus is
 * owned by a sibling track. Rather than guess a heading convention, the
 * whole file becomes `description` and the case id becomes `title`: the
 * one mapping that needs no assumption about `subject.md`'s internal shape.
 */
async function loadCases(cases) {
  const subjects = [];
  const errors = [];
  for (const c of cases) {
    try {
      const [description, diff] = await Promise.all([
        readFile(c.subjectPath, 'utf8'),
        readFile(c.diffPath, 'utf8'),
      ]);
      let truth = null;
      let truthError = null;
      try {
        truth = JSON.parse(await readFile(c.truthPath, 'utf8'));
      } catch (cause) {
        truthError = `truth.json could not be parsed: ${cause.message}`;
      }
      subjects.push({ id: c.id, title: c.id, description, diff, truth, truthError });
    } catch (cause) {
      errors.push({ id: c.id, error: cause.message });
    }
  }
  return { subjects, errors };
}

async function loadOptionalModule(relPath, exportName) {
  const url = new URL(relPath, import.meta.url);
  try {
    const mod = await import(url.href);
    const fn = mod[exportName];
    if (typeof fn !== 'function') {
      return {
        found: false,
        path: relPath,
        error: `module does not export a function named "${exportName}"`,
      };
    }
    return { found: true, path: relPath, fn };
  } catch (cause) {
    if (cause?.code === 'ERR_MODULE_NOT_FOUND') {
      return { found: false, path: relPath, error: 'not found' };
    }
    return { found: false, path: relPath, error: `import failed: ${cause.message}` };
  }
}

/**
 * `full` is the whole corpus. `half` is a deterministic prefix slice of it —
 * not a random sample, and not a "representative" hand pick — because the
 * whole point of the practiceCount axis is that the SAME slice is used every
 * time this runs, so a difference between runs is a difference in the
 * measurement, not in which half happened to be drawn. Documented here
 * because it is a real modelling choice a reader of results.json needs to
 * know: the first half of `practices.json`'s declared order, not a random
 * or stratified half.
 */
function selectPractices(all, mode) {
  if (mode === 'full') {
    return all;
  }
  if (mode === 'half') {
    return all.slice(0, Math.ceil(all.length / 2));
  }
  throw new Error(`unknown practiceCount mode: ${JSON.stringify(mode)}`);
}

function buildConfigurations(widths, practiceCounts) {
  const configs = [];
  for (const practiceCount of practiceCounts) {
    for (const width of widths) {
      configs.push({ practiceCount, width });
    }
  }
  return configs;
}

function buildLensSetForConfig(config, practicesResult, partitionModule) {
  if (!practicesResult.found) {
    return {
      lensSet: null,
      practiceSubsetSize: null,
      error: `practices corpus not found at ${practicesResult.path} (${practicesResult.reason})`,
    };
  }
  if (!partitionModule.found) {
    return {
      lensSet: null,
      practiceSubsetSize: null,
      error: `eval/partition.mjs not available: ${partitionModule.error}`,
    };
  }
  const subset = selectPractices(practicesResult.practices, config.practiceCount);
  try {
    const lensSet = partitionModule.fn(subset, config.width, {});
    return { lensSet, practiceSubsetSize: subset.length, error: null };
  } catch (cause) {
    return {
      lensSet: null,
      practiceSubsetSize: subset.length,
      error: `partition() threw for width=${config.width} practiceCount=${config.practiceCount}: ${cause.message}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Git sha, read from `.git` directly rather than spawning `git`: this
// command's declared env allow-list carries only CLAUDE_CODE_OAUTH_TOKEN
// (finding H87 — an env var not on the list does not reach the process), so
// PATH is not guaranteed to be there for a spawned child to find a `git`
// binary with. Reading the ref file needs no PATH at all.
// ---------------------------------------------------------------------------

async function readGitSha(repoRoot) {
  try {
    const head = (await readFile(join(repoRoot, '.git', 'HEAD'), 'utf8')).trim();
    if (head.startsWith('ref: ')) {
      const refPath = head.slice('ref: '.length).trim();
      try {
        return (await readFile(join(repoRoot, '.git', refPath), 'utf8')).trim();
      } catch {
        const packed = await readFile(join(repoRoot, '.git', 'packed-refs'), 'utf8').catch(
          () => null,
        );
        if (packed !== null) {
          const line = packed.split('\n').find((l) => l.endsWith(` ${refPath}`));
          if (line !== undefined) {
            return line.split(' ')[0];
          }
        }
        return undefined;
      }
    }
    return /^[0-9a-f]{40}$/.test(head) ? head : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Concurrency-capped pool. `limit` workers pull from a shared index, so at
// most `limit` calls are ever in flight regardless of how many
// configurations, cases and repeats the plan holds — the fix for
// `_diag-hypothesis.mjs` firing all 10 of its calls at once and getting back
// ten HTTP 429s.
// ---------------------------------------------------------------------------

async function runPool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function runner() {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) {
        return;
      }
      results[i] = await worker(items[i], i);
    }
  }
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () =>
    runner(),
  );
  await Promise.all(runners);
  return results;
}

// ---------------------------------------------------------------------------
// The transport: credential resolution and retry-with-backoff carried over
// from `_diag-hypothesis.mjs` unchanged, because it was already correct —
// only the caller around it (the concurrency-capped pool above) changes.
// ---------------------------------------------------------------------------

function headersFor(credential) {
  return credential.source === 'api-key'
    ? { 'x-api-key': credential.value }
    : { authorization: `Bearer ${credential.value}` };
}

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

async function callOnce(lens, subject, settings) {
  const prompt = buildPrompt(lens, subject);
  const body = JSON.stringify({
    model: settings.model,
    max_tokens: settings.maxTokens,
    system: [{ type: 'text', text: prompt.shared, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: prompt.perLens }],
  });

  const MAX_ATTEMPTS = 6;
  let response;
  let rawText;
  let elapsedMs;
  let attempts = 0;
  for (;;) {
    attempts += 1;
    const started = Date.now();
    response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        ...headersFor(settings.credential),
      },
      body,
    });
    rawText = await response.text();
    elapsedMs = Date.now() - started;
    if (response.status !== 429 || attempts >= MAX_ATTEMPTS) {
      break;
    }
    const retryAfter = response.headers.get('retry-after');
    const waitMs = retryAfter !== null ? Number(retryAfter) * 1000 : attempts * 15000;
    console.log(
      `${lens.id}: HTTP 429 (attempt ${attempts} of ${MAX_ATTEMPTS}), waiting ${waitMs}ms before retrying`,
    );
    await sleep(Number.isFinite(waitMs) && waitMs > 0 ? waitMs : attempts * 15000);
  }

  if (!response.ok) {
    return {
      lens: lens.id,
      outcome: 'could_not_run',
      findings: [],
      reason: `HTTP ${response.status}: ${rawText.slice(0, 300)}`,
      elapsedMs,
      attempts,
    };
  }

  const parsed = JSON.parse(rawText);
  const usage = parsed.usage ?? {};
  const content = Array.isArray(parsed.content) ? parsed.content : [];
  const text = content
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');
  const blockKinds = content.map((b) => b.type).join(',');

  let result;
  if (text === '') {
    // A lens that hit `stop_reason: max_tokens` with no text is a real
    // property of this configuration — a wide fan may fail more often — so
    // it is reported as `could_not_run`, counted, and never dropped.
    result = {
      lens: lens.id,
      outcome: 'could_not_run',
      findings: [],
      reason: `no text: blocks=[${blockKinds}] stop_reason=${parsed.stop_reason}`,
    };
  } else {
    result = parseReply(lens.id, text);
  }

  return { ...result, usage, elapsedMs, attempts, stopReason: parsed.stop_reason };
}

// ---------------------------------------------------------------------------
// Dry run: prints the cost of a real run without spending anything.
// ---------------------------------------------------------------------------

async function computeSummary({
  widths,
  practiceCounts,
  repeats,
  practicesResult,
  subjects,
  partitionModule,
}) {
  const configurations = buildConfigurations(widths, practiceCounts);
  const casesCount = subjects.length;

  let promptCharTotal = 0;
  const configSummaries = [];
  for (const config of configurations) {
    const built = buildLensSetForConfig(config, practicesResult, partitionModule);
    const callsForConfig = casesCount * config.width * repeats;
    let promptChars = 0;
    const promptErrors = [];
    if (built.lensSet && casesCount > 0) {
      for (const subject of subjects) {
        for (const lens of built.lensSet.lenses) {
          try {
            const prompt = buildPrompt(lens, subject);
            promptChars += (prompt.shared.length + prompt.perLens.length) * repeats;
          } catch (cause) {
            promptErrors.push(`${subject.id}/${lens.id}: ${cause.message}`);
          }
        }
      }
    }
    promptCharTotal += promptChars;
    configSummaries.push({
      practiceCount: config.practiceCount,
      width: config.width,
      practiceSubsetSize: built.practiceSubsetSize,
      lensCount: built.lensSet ? built.lensSet.lenses.length : null,
      lensSetError: built.error,
      calls: callsForConfig,
      promptChars,
      promptErrors,
    });
  }

  const totalModelCalls = configSummaries.reduce((sum, c) => sum + c.calls, 0);

  return { configurations, configSummaries, totalModelCalls, promptCharTotal, casesCount };
}

function printDryRunReport(ctx) {
  const {
    widths,
    practiceCounts,
    repeats,
    concurrency,
    practicesResult,
    corpusResult,
    subjectErrors,
    partitionModule,
    scoreModule,
    summary,
  } = ctx;

  console.log('=== eval/sweep.mjs: DRY RUN (no API calls, nothing spent) ===');
  console.log('Pass --spend to actually call the model.');
  console.log('');
  console.log(`Concurrency cap: ${concurrency}`);
  console.log(`Widths: ${widths.join(', ')}`);
  console.log(`Practice counts: ${practiceCounts.join(', ')}`);
  console.log(`Repeats per configuration: ${repeats}`);
  console.log('');

  console.log('Inputs:');
  console.log(
    practicesResult.found
      ? `  practices: FOUND at ${practicesResult.path} (${practicesResult.count} practices)`
      : `  practices: MISSING at ${practicesResult.path} — ${practicesResult.reason}`,
  );
  console.log(
    corpusResult.found
      ? `  corpus:    FOUND at ${corpusResult.dir} (${corpusResult.cases.length} usable case(s), ${corpusResult.incomplete.length} incomplete)`
      : `  corpus:    MISSING at ${corpusResult.dir} — ${corpusResult.reason}`,
  );
  if (corpusResult.found && corpusResult.incomplete.length > 0) {
    for (const inc of corpusResult.incomplete) {
      console.log(`             incomplete case "${inc.id}": missing ${inc.missing.join(', ')}`);
    }
  }
  if (subjectErrors.length > 0) {
    for (const e of subjectErrors) {
      console.log(`             case "${e.id}" could not be read: ${e.error}`);
    }
  }
  console.log(
    partitionModule.found
      ? `  partition: FOUND at eval/partition.mjs`
      : `  partition: MISSING — ${partitionModule.error}`,
  );
  console.log(
    scoreModule.found
      ? `  score:     FOUND at eval/score.mjs`
      : `  score:     MISSING — ${scoreModule.error}`,
  );
  console.log('');

  console.log(`Total configurations (width × practiceCount): ${summary.configurations.length}`);
  console.log(
    `Total model calls this sweep would make: ${summary.totalModelCalls.toLocaleString()}`,
  );
  console.log(
    `Total prompt characters this sweep would send: ${summary.promptCharTotal.toLocaleString()}` +
      (summary.casesCount === 0
        ? ' (0 because no usable corpus case was found — see Inputs above)'
        : ''),
  );
  console.log('');

  console.log('Per configuration:');
  for (const c of summary.configSummaries) {
    const lensPart = c.lensCount === null ? 'lens set: unavailable' : `${c.lensCount} lens(es)`;
    console.log(
      `  width=${String(c.width).padStart(2)} practiceCount=${c.practiceCount.padEnd(4)} ` +
        `${lensPart}, ${c.calls.toLocaleString()} call(s), ${c.promptChars.toLocaleString()} prompt char(s)` +
        (c.lensSetError ? ` — ${c.lensSetError}` : ''),
    );
  }
  console.log('');
  console.log(JSON.stringify(summary, null, 2));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const widths = options.widths ?? DEFAULT_WIDTHS;
  const practiceCounts = options.practiceCounts ?? DEFAULT_PRACTICE_COUNTS;
  const repeats = options.repeats ?? DEFAULT_REPEATS;
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const spend = options.spend === true;

  const practicesFile =
    options.practicesFile ?? join(REPO_ROOT, 'eval', 'practices', 'practices.json');
  const corpusDir = options.corpusDir ?? join(REPO_ROOT, 'eval', 'corpus');
  const resultsDir = options.resultsDir ?? join(REPO_ROOT, 'eval', 'results');

  const [practicesResult, corpusResult, partitionModule, scoreModule] = await Promise.all([
    loadPractices(practicesFile),
    loadCorpus(corpusDir),
    loadOptionalModule('./partition.mjs', 'partition'),
    loadOptionalModule('./score.mjs', 'score'),
  ]);

  let subjects = [];
  let subjectErrors = [];
  if (corpusResult.found && corpusResult.cases.length > 0) {
    const loaded = await loadCases(corpusResult.cases);
    subjects = loaded.subjects;
    subjectErrors = loaded.errors;
  }

  const summary = await computeSummary({
    widths,
    practiceCounts,
    repeats,
    practicesResult,
    corpusResult,
    subjects,
    partitionModule,
  });

  if (!spend) {
    printDryRunReport({
      widths,
      practiceCounts,
      repeats,
      concurrency,
      practicesResult,
      corpusResult,
      subjectErrors,
      partitionModule,
      scoreModule,
      summary,
    });
    return;
  }

  // -------------------------------------------------------------------
  // Spend path: only reached with --spend. Never exercised by the dry run.
  // -------------------------------------------------------------------

  if (!practicesResult.found) {
    console.error(
      `Cannot spend: practices corpus missing at ${practicesResult.path} — ${practicesResult.reason}`,
    );
    process.exitCode = 1;
    return;
  }
  if (!corpusResult.found || subjects.length === 0) {
    console.error(`Cannot spend: no usable corpus case found under ${corpusDir}`);
    process.exitCode = 1;
    return;
  }
  if (!partitionModule.found) {
    console.error(`Cannot spend: eval/partition.mjs not available — ${partitionModule.error}`);
    process.exitCode = 1;
    return;
  }
  if (!scoreModule.found) {
    console.error(`Cannot spend: eval/score.mjs not available — ${scoreModule.error}`);
    process.exitCode = 1;
    return;
  }

  const settingsResult = await resolveSettings(process.env, keyFileReader());
  if (settingsResult.kind === 'incomplete') {
    console.error(renderMissing(settingsResult.missing, settingsResult.problems));
    process.exitCode = 1;
    return;
  }
  if (settingsResult.kind === 'invalid') {
    console.error(`Settings invalid:\n${settingsResult.problems.join('\n')}`);
    process.exitCode = 1;
    return;
  }
  const settings = settingsResult.settings;

  const configBuilds = summary.configurations.map((config) => ({
    ...config,
    ...buildLensSetForConfig(config, practicesResult, partitionModule),
  }));
  const runConfigs = configBuilds.filter((cb) => cb.lensSet);
  const skippedConfigs = configBuilds.filter((cb) => !cb.lensSet);

  console.log(
    `Spending: model=${settings.model} maxTokens=${settings.maxTokens} ` +
      `credential=${settings.credential.source} concurrency=${concurrency} ` +
      `total model calls=${summary.totalModelCalls.toLocaleString()}`,
  );
  if (skippedConfigs.length > 0) {
    console.log(`Skipping ${skippedConfigs.length} configuration(s) with no lens set:`);
    for (const cb of skippedConfigs) {
      console.log(`  width=${cb.width} practiceCount=${cb.practiceCount}: ${cb.error}`);
    }
  }

  const calls = [];
  for (const cb of runConfigs) {
    for (const subject of subjects) {
      for (let repeatIndex = 0; repeatIndex < repeats; repeatIndex += 1) {
        for (const lens of cb.lensSet.lenses) {
          calls.push({ cb, subject, repeatIndex, lens });
        }
      }
    }
  }

  console.log(`Dispatching ${calls.length} model call(s) at concurrency ${concurrency}...`);
  const raw = await runPool(calls, concurrency, (call) =>
    callOnce(call.lens, call.subject, settings),
  );

  // Regroup flat call results back into configuration → case → repeat.
  const byConfig = new Map();
  for (let i = 0; i < calls.length; i += 1) {
    const call = calls[i];
    const key = `${call.cb.practiceCount}:${call.cb.width}`;
    if (!byConfig.has(key)) {
      byConfig.set(key, { cb: call.cb, cases: new Map() });
    }
    const configEntry = byConfig.get(key);
    if (!configEntry.cases.has(call.subject.id)) {
      configEntry.cases.set(call.subject.id, new Map());
    }
    const caseEntry = configEntry.cases.get(call.subject.id);
    if (!caseEntry.has(call.repeatIndex)) {
      caseEntry.set(call.repeatIndex, []);
    }
    caseEntry.get(call.repeatIndex).push(raw[i]);
  }

  const configurationsOut = [];
  for (const entry of byConfig.values()) {
    const declaredIds = entry.cb.lensSet.lenses.map((l) => l.id);
    const casesOut = [];
    for (const [caseId, repeatsMap] of entry.cases) {
      const subject = subjects.find((s) => s.id === caseId);
      const repeatsOut = [];
      for (const [repeatIndex, lensResults] of repeatsMap) {
        // Fails closed, same as production: a lens that never returned is
        // `could_not_run`, counted, never dropped (see `aggregate`).
        const verdict = aggregate(declaredIds, lensResults);
        let score;
        if (subject.truthError !== null) {
          score = { error: subject.truthError };
        } else if (subject.truth === null) {
          score = { error: 'truth.json was empty or absent for this case' };
        } else {
          try {
            score = scoreModule.fn(verdict.findings, subject.truth, {});
          } catch (cause) {
            score = { error: `score() threw: ${cause.message}` };
          }
        }
        repeatsOut.push({
          repeatIndex,
          results: lensResults,
          couldNotRunCount: verdict.unran.length,
          verdictOutcome: verdict.outcome,
          score,
        });
      }
      repeatsOut.sort((a, b) => a.repeatIndex - b.repeatIndex);
      casesOut.push({ caseId, repeats: repeatsOut });
    }
    configurationsOut.push({
      practiceCount: entry.cb.practiceCount,
      width: entry.cb.width,
      practiceSubsetSize: entry.cb.practiceSubsetSize,
      lensSet: entry.cb.lensSet,
      cases: casesOut,
    });
  }

  const sha = await readGitSha(REPO_ROOT);
  const generatedAt = new Date().toISOString();
  const resultsDoc = {
    measurement: 'eval-sweep',
    generatedAt,
    model: settings.model,
    credentialSource: settings.credential.source,
    // Recorded explicitly rather than omitted: a results file that cannot
    // say what produced it is the exact failure this harness exists to
    // prevent.
    gitSha: sha ?? null,
    gitShaObtained: sha !== undefined,
    concurrencyCap: concurrency,
    repeats,
    axes: { widths, practiceCounts },
    practiceCorpus: { path: practicesFile, totalCount: practicesResult.count },
    corpus: {
      dir: corpusDir,
      caseCount: subjects.length,
      caseIds: subjects.map((s) => s.id),
      incomplete: corpusResult.incomplete,
    },
    skippedConfigurations: skippedConfigs.map((cb) => ({
      practiceCount: cb.practiceCount,
      width: cb.width,
      reason: cb.error,
    })),
    configurations: configurationsOut,
  };

  await mkdir(resultsDir, { recursive: true });
  const fileName = `${generatedAt.slice(0, 10)}-${settings.model}.json`;
  const filePath = join(resultsDir, fileName);
  await writeFile(filePath, JSON.stringify(resultsDoc, null, 2), 'utf8');
  console.log(`Written to ${filePath}`);
}

main().catch((cause) => {
  console.error(cause?.stack ?? String(cause));
  process.exitCode = 1;
});
