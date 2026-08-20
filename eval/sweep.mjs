// The eval sweep: how review fan width — the number of lenses a review is
// split across — trades off against recall, confirmed false positives,
// run-to-run stability and cost, and whether the answer moves when the
// practice corpus does. Kept, committed, and re-runnable: this is a
// measurement, not a diagnostic thrown away after use.
//
// This replaces `scripts/_diag-hypothesis.mjs`, whose retry-with-backoff
// transport is reused wholesale below (see `callOnce`) because it was
// already correct. Its credential-resolution assumption —
// `settings.credential.{source,value}`, picking x-api-key vs a Bearer
// header — was NOT reused at the time this file was first written: it did
// not match ReviewSettings's THEN-current contract (`{ apiKey, model,
// maxTokens, lensSource, lensToken? }`, nothing else), confirmed by running
// this file for real and hitting `Cannot read properties of undefined
// (reading 'source')`. That has since changed: the subscription-OAuth
// credential support originally built on the unmerged
// s26/subscription-oauth-locally branch has been PORTED onto this branch's
// src/review/settings.ts and src/review/anthropic.ts — a COPY of work that
// remains unmerged on s26, not a cherry-pick (no verb on this belt reports a
// sha or commit ancestry to cherry-pick from — finding H44). Whoever lands
// s26 onto main will hit a real conflict on those two files; this comment is
// that notice, left where the next reader will find it. `headersFor` below
// now mirrors settings.ts's real, credential-aware contract rather than
// assuming api-key. Three other things _diag-hypothesis.mjs got wrong,
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
// Stage 2 additions, made after this file's own first real run (72 calls,
// 49 minutes, zero successes, all HTTP 429 - see eval/README.md's
// Measurements section):
//
//   4. --probe makes exactly ONE model call and reports success, HTTP 429,
//      or a transport failure - "is the quota serving right now" now costs
//      a rounding error instead of the full retry ladder.
//   5. MAX_CONSECUTIVE_429 aborts a sweep after a sustained run of 429s
//      instead of grinding to the end of the retry ladder for every
//      remaining call the way that first run did.
//   6. --resume continues an aborted or interrupted run from its own
//      partial results file, without re-spending on configurations it
//      already completed.
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
import {
  classifyWidth,
  CRITERION_RULE,
  CATCH_THRESHOLD_OF_3,
  REJECT_THRESHOLD_OF_3,
  MIN_USABLE_REPEATS_OF_3,
  CORRECT_REJECTION_CASE_ID,
} from './criterion.mjs';

// resolveSettings requires AIGENCY_REVIEW_LENSES_TOKEN whenever
// AIGENCY_REVIEW_LENSES resolves to its default (a private-repo HTTPS URL) -
// correct for the production review path, which fetches a LensSet over HTTP.
// This file never does: every LensSet it uses comes from partition.mjs
// against eval/practices/practices.json, and settings.lensSource /
// settings.lensToken are read by nothing below. Pointing at a local file
// (which needs no token) clears the requirement without changing what this
// file actually uses settings for - the same workaround _diag-hypothesis.mjs
// used for the identical reason. Only applied if the caller has not already
// set the variable themselves.
if (process.env.AIGENCY_REVIEW_LENSES === undefined) {
  process.env.AIGENCY_REVIEW_LENSES = './review/lenses.json';
}

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');

const DEFAULT_WIDTHS = [1, 2, 3, 5, 8, 13, 21, 34];
const DEFAULT_PRACTICE_COUNTS = ['full', 'half'];
const DEFAULT_REPEATS = 3;
const DEFAULT_CONCURRENCY = 4;

// Fail fast on a sustained rate-limit wall rather than grinding through the
// full retry ladder for every remaining call the way this file's first real
// run did (49 minutes, 72 calls, zero successes, to learn what --probe now
// answers in one). Counted at the level of FINISHED calls, not raw HTTP
// attempts: each call's own retry ladder (MAX_ATTEMPTS in callOnce) already
// exists to ride out a short transient blip, so counting every individual
// attempt here would double-count that and risk aborting on the exact kind
// of blip the retry ladder is designed to survive.
//
// 20 is a judgement call, not a measured optimum, and the trade is named
// rather than hidden: set it too low and a run that would have recovered on
// its own gets aborted for nothing, wasting the calls already spent and
// requiring a --resume to finish; set it too high and a genuinely dead
// quota still costs most of an hour to discover, which is the exact
// experience this constant exists to prevent. At concurrency 4, 20
// consecutive whole-call 429s is on the order of 5 full rounds of the
// concurrency window failing outright — a threshold that reports a dead
// quota within minutes rather than an hour, while still tolerating a
// handful of stray 429s during an otherwise-working run.
const MAX_CONSECUTIVE_429 = 20;

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
  'credential',
  'resume',
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
    case 'credential':
      if (value !== 'oauth' && value !== 'api-key') {
        throw new Error(`--credential must be "oauth" or "api-key", got ${JSON.stringify(value)}`);
      }
      options.credential = value;
      break;
    case 'resume':
      options.resume = value;
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
    if (arg === '--probe') {
      options.probe = true;
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
      '  --probe                  Make exactly ONE model call and report success/429/transport-failure. Requires --spend.',
      '  --credential=oauth|api-key  Required with --spend. Refuses before any model call unless this matches the credential actually eligible to serve one (observed the same way --probe reports it) — naming both what was asked for and what is available rather than guessing.',
      `  --resume PATH            Continue an aborted/partial --spend run from its results file; adopts that file's own axes and --repeats, and does not re-spend on configurations it already completed.`,
      '  --help                   This message.',
      '',
      'Every value-taking flag above also accepts --flag=value, e.g. --widths=1,3,8,21.',
      `A --spend run aborts automatically after ${MAX_CONSECUTIVE_429} consecutive HTTP 429 responses`,
      'with no success in between (see MAX_CONSECUTIVE_429 in the source for why), writing a partial',
      'results file rather than grinding through the rest of the retry ladder for every remaining call.',
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
// command's declared env allow-list carries only ANTHROPIC_API_KEY,
// ANTHROPIC_API_KEY_FILE, XDG_CONFIG_HOME and HOME (finding H87 — an env
// var not on the list does not reach the process), so PATH is not
// guaranteed to be there for a spawned child to find a `git` binary with.
// Reading the ref file needs no PATH at all.
// ---------------------------------------------------------------------------

/**
 * Which credential source was even ELIGIBLE to serve a call, observed from
 * the environment exactly as src/review/settings.ts resolves it — without
 * modifying that file, which is the subject of the still-open
 * s26/subscription-oauth-locally routing question. `defaultKeyFilePath`'s
 * fallback (XDG_CONFIG_HOME/verevoir/anthropic.key, else
 * HOME/.config/verevoir/anthropic.key) is mirrored exactly, not guessed.
 * Presence and existence ONLY: never a secret's value, a prefix, or a
 * length. This is printed by --probe and recorded in every results file's
 * provenance block, because a results file that records what a run cost is
 * incomplete if it cannot say what paid for it.
 */
async function describeCredentialSources(env) {
  const present = (value) => typeof value === 'string' && value.trim() !== '';

  const apiKeyEnvPresent = present(env.ANTHROPIC_API_KEY);
  const apiKeyFileEnvPresent = present(env.ANTHROPIC_API_KEY_FILE);
  const apiKeyFilePath = apiKeyFileEnvPresent ? env.ANTHROPIC_API_KEY_FILE : null;
  const apiKeyFileExists = apiKeyFilePath === null ? null : await pathExists(apiKeyFilePath);

  const xdgConfigHome = present(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : undefined;
  const home = present(env.HOME) ? env.HOME : undefined;
  const conventionalKeyFilePath =
    xdgConfigHome !== undefined
      ? `${xdgConfigHome}/verevoir/anthropic.key`
      : home !== undefined
        ? `${home}/.config/verevoir/anthropic.key`
        : null;
  const conventionalKeyFileExists =
    conventionalKeyFilePath === null ? null : await pathExists(conventionalKeyFilePath);

  const claudeCodeOauthTokenEnvPresent = present(env.CLAUDE_CODE_OAUTH_TOKEN);

  return {
    anthropicApiKeyEnvPresent: apiKeyEnvPresent,
    anthropicApiKeyFileEnvPresent: apiKeyFileEnvPresent,
    anthropicApiKeyFilePath: apiKeyFilePath,
    anthropicApiKeyFileExists: apiKeyFileExists,
    conventionalKeyFilePath,
    conventionalKeyFileExists,
    claudeCodeOauthTokenEnvPresent,
  };
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function printCredentialSources(credentialSources) {
  console.log('Credential sources observed (presence/existence only, never a secret value):');
  console.log(
    `  ANTHROPIC_API_KEY present: ${String(credentialSources.anthropicApiKeyEnvPresent)}`,
  );
  console.log(
    `  ANTHROPIC_API_KEY_FILE present: ${String(credentialSources.anthropicApiKeyFileEnvPresent)}`,
  );
  if (credentialSources.anthropicApiKeyFilePath !== null) {
    console.log(
      `    -> ${credentialSources.anthropicApiKeyFilePath} exists: ${String(credentialSources.anthropicApiKeyFileExists)}`,
    );
  }
  if (credentialSources.conventionalKeyFilePath !== null) {
    console.log(
      `  conventional key file ${credentialSources.conventionalKeyFilePath} exists: ${String(credentialSources.conventionalKeyFileExists)}`,
    );
  } else {
    console.log(
      '  conventional key file: neither XDG_CONFIG_HOME nor HOME is set, nowhere to look',
    );
  }
  console.log(
    `  CLAUDE_CODE_OAUTH_TOKEN present: ${String(credentialSources.claudeCodeOauthTokenEnvPresent)}`,
  );
}

/**
 * Which credential is actually eligible to serve a call TODAY, given what
 * `describeCredentialSources` observed — decided the same way
 * src/review/settings.ts's own resolution chain decides (OAuth first, then
 * the API key chain — see resolveCredential in settings.ts), without
 * calling into that file.
 *
 * Updated: the OAuth support this depends on has been PORTED onto this
 * branch's settings.ts and anthropic.ts from the unmerged
 * s26/subscription-oauth-locally branch — a COPY of work that stays
 * unmerged there, not a cherry-pick (no verb on this belt reports a sha or
 * commit ancestry to cherry-pick from — finding H44). Whoever lands s26
 * will hit a real conflict on those two files.
 *
 * Mirrors only what `describeCredentialSources` actually observes: the
 * CLAUDE_CODE_OAUTH_TOKEN environment variable's presence. settings.ts's
 * OAuth chain also has file-based fallbacks
 * (AIGENCY_REVIEW_OAUTH_TOKEN_FILE, the conventional
 * anthropic-oauth.token path) that this function does not yet check — a
 * real, narrower gap than before, stated rather than hidden: this can
 * under-report OAuth eligibility (refuse --credential=oauth when a file
 * source would in fact have supplied one) but cannot over-report it.
 */
function credentialActuallyEligible(sources) {
  if (sources.claudeCodeOauthTokenEnvPresent) {
    return 'oauth';
  }
  const apiKeyEligible =
    sources.anthropicApiKeyEnvPresent ||
    (sources.anthropicApiKeyFileEnvPresent && sources.anthropicApiKeyFileExists === true) ||
    sources.conventionalKeyFileExists === true;
  return apiKeyEligible ? 'api-key' : null;
}

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

// `onItemDone`, when given, fires synchronously as each individual call
// resolves — before the whole pool has finished — so a caller can persist
// progress incrementally rather than only after every call in the sweep is
// done. Optional and additive: a caller that only wants the final array is
// unaffected.
//
// `shouldAbort`, when given, is checked before a runner pulls its NEXT item —
// never mid-call — so a caller can stop dispatching new work (a sustained
// 429 wall, say) without cancelling requests already in flight. Items never
// dispatched are left `undefined` in the returned array; the caller's own
// bookkeeping (`onItemDone`) is the source of truth for what actually ran.
async function runPool(items, limit, worker, onItemDone, shouldAbort) {
  const results = new Array(items.length);
  let next = 0;
  async function runner() {
    for (;;) {
      if (shouldAbort && shouldAbort()) {
        return;
      }
      const i = next;
      next += 1;
      if (i >= items.length) {
        return;
      }
      const result = await worker(items[i], i);
      results[i] = result;
      if (onItemDone) {
        onItemDone(items[i], result, i);
      }
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

// The real (and only) header this codebase's production request path
// sends — see src/review/anthropic.ts, which now sends 'x-api-key' for an
// api-key credential, or a Bearer authorization header for a subscription
// OAuth one, via its own headersFor(config.credential). The OAuth support
// was ported from s26/subscription-oauth-locally onto settings.ts and
// anthropic.ts — see the file header above for the full account.
function headersFor(settings) {
  return settings.credential.source === 'api-key'
    ? { 'x-api-key': settings.credential.value }
    : { authorization: `Bearer ${settings.credential.value}` };
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
    // A transport-level exception — no response arrived at all — is a
    // different fact from an HTTP 429: a 429 means the server answered and
    // said "not now"; this means the request never completed. Collapsing
    // the two into one reason would send whoever reads it looking for the
    // wrong fix — the same distinction panel.ts keeps between
    // NoRoomToAnswerError and an ordinary reviewer throw ("no room to
    // answer" vs "reviewer threw"), and the same split readers.ts's
    // httpReader keeps between "fetch failed" and "body unreadable". Caught
    // here so a network failure is data — a `could_not_run` result carrying
    // its reason, counted per configuration — never an uncaught throw that
    // discards the rest of the sweep, which is exactly what happened the
    // first time this file ran for real.
    try {
      response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
          ...headersFor(settings),
        },
        body,
      });
    } catch (cause) {
      return {
        lens: lens.id,
        outcome: 'could_not_run',
        findings: [],
        reason: `transport failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        elapsedMs: Date.now() - started,
        attempts,
      };
    }
    try {
      rawText = await response.text();
    } catch (cause) {
      return {
        lens: lens.id,
        outcome: 'could_not_run',
        findings: [],
        reason: `response unreadable: ${cause instanceof Error ? cause.message : String(cause)}`,
        elapsedMs: Date.now() - started,
        attempts,
      };
    }
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
// Probe: exactly one model call, so "is the quota serving right now" costs a
// rounding error and takes as long as one request, instead of grinding
// through --spend's full retry ladder across every remaining call to find
// out. Reports success, HTTP 429, or a transport throw, and exits non-zero
// on anything but a real reply, so a caller — a human, or a release step
// gated on this one — can decide whether to proceed without reading prose.
// ---------------------------------------------------------------------------

async function runProbe({ spend, practicesResult, partitionModule, subjects }) {
  if (!spend) {
    console.error('--probe requires --spend (it makes exactly one real, billed model call).');
    process.exitCode = 1;
    return;
  }
  if (!practicesResult.found) {
    console.error(
      `Cannot probe: practices corpus missing at ${practicesResult.path} (${practicesResult.reason})`,
    );
    process.exitCode = 1;
    return;
  }
  if (!partitionModule.found) {
    console.error(`Cannot probe: eval/partition.mjs not available — ${partitionModule.error}`);
    process.exitCode = 1;
    return;
  }
  if (subjects.length === 0) {
    console.error('Cannot probe: no usable corpus case found.');
    process.exitCode = 1;
    return;
  }

  // The smallest possible real call: width=1 against the full corpus is one
  // lens, one prompt. The probe exists to answer "is the transport working",
  // not to sample any particular configuration.
  const built = buildLensSetForConfig(
    { practiceCount: 'full', width: 1 },
    practicesResult,
    partitionModule,
  );
  if (!built.lensSet) {
    console.error(`Cannot probe: ${built.error}`);
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
  const lens = built.lensSet.lenses[0];
  const subject = subjects[0];

  console.log('=== eval/sweep.mjs: PROBE (exactly one call) ===');
  printCredentialSources(await describeCredentialSources(process.env));
  console.log(
    `model=${settings.model} credential=${settings.credential.source} lens=${lens.id} subject=${subject.id}`,
  );

  const result = await callOnce(lens, subject, settings);

  console.log(`outcome: ${result.outcome}`);
  if (result.reason) {
    console.log(`reason:  ${result.reason}`);
  }
  console.log(`elapsedMs: ${result.elapsedMs ?? 'n/a'}  attempts: ${result.attempts ?? 'n/a'}`);
  if (result.usage) {
    console.log(`usage: ${JSON.stringify(result.usage)}`);
  }

  if (result.outcome === 'could_not_run') {
    console.error('Probe did not get a usable reply. Do not proceed to a real spend.');
    process.exitCode = 1;
  } else {
    console.log('Probe got a usable reply. The transport is working right now.');
    process.exitCode = 0;
  }
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

  let widths = options.widths ?? DEFAULT_WIDTHS;
  let practiceCounts = options.practiceCounts ?? DEFAULT_PRACTICE_COUNTS;
  let repeats = options.repeats ?? DEFAULT_REPEATS;
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const spend = options.spend === true;

  // The guard: no default that guesses. A --spend run must name which
  // credential it is authorised to bill, and this refuses before a single
  // model call if that name does not match what is actually eligible to
  // serve one — "resolveSettings found something" is not the operator
  // choosing which credential pays for it.
  if (spend) {
    if (options.credential === undefined) {
      console.error(
        'Refusing to --spend without --credential=oauth|api-key: a run that spends money ' +
          'must say which credential it is authorised to bill, not accept whatever ' +
          'resolveSettings happens to find. Pass --credential=oauth or --credential=api-key.',
      );
      process.exitCode = 1;
      return;
    }
    const observedSources = await describeCredentialSources(process.env);
    const eligible = credentialActuallyEligible(observedSources);
    if (eligible !== options.credential) {
      console.error(
        `Refusing to --spend: --credential=${options.credential} was requested, but the ` +
          `credential actually eligible to serve a call today is ${eligible ?? 'none observed'}. ` +
          'Asked for vs. available, named plainly rather than guessed:',
      );
      printCredentialSources(observedSources);
      process.exitCode = 1;
      return;
    }
  }

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

  if (options.probe) {
    await runProbe({ spend, practicesResult, partitionModule, subjects });
    return;
  }

  // --resume: a run that hit MAX_CONSECUTIVE_429 (or crashed, or was killed)
  // left a partial results file behind. Resuming means finishing THAT sweep,
  // not starting a differently-scoped one — so its own axes and repeat count
  // are adopted here rather than whatever this command line separately
  // asked for, and anything it already completed is carried over rather
  // than re-spent on. Refuses rather than silently mixing results when the
  // corpus this run sees does not match the one the file was produced
  // against — comparing across two different corpora would not be comparing
  // the same thing.
  let alreadyDone = new Map();
  if (options.resume) {
    let raw;
    try {
      raw = await readFile(options.resume, 'utf8');
    } catch (cause) {
      console.error(`Cannot resume: could not read ${options.resume}: ${cause.message}`);
      process.exitCode = 1;
      return;
    }
    let resumeDoc;
    try {
      resumeDoc = JSON.parse(raw);
    } catch (cause) {
      console.error(`Cannot resume: ${options.resume} is not valid JSON: ${cause.message}`);
      process.exitCode = 1;
      return;
    }
    if (resumeDoc?.measurement !== 'eval-sweep' || !Array.isArray(resumeDoc.configurations)) {
      console.error(
        `Cannot resume: ${options.resume} does not look like an eval-sweep results file.`,
      );
      process.exitCode = 1;
      return;
    }
    const resumedCaseIds = [...(resumeDoc.corpus?.caseIds ?? [])].sort();
    const currentCaseIds = [...subjects.map((s) => s.id)].sort();
    const caseIdsMatch =
      resumedCaseIds.length === currentCaseIds.length &&
      resumedCaseIds.every((id, i) => id === currentCaseIds[i]);
    if (!caseIdsMatch) {
      console.error(
        `Cannot resume: ${options.resume} ran against corpus cases [${resumedCaseIds.join(', ')}]; ` +
          `the current corpus has [${currentCaseIds.join(', ')}]. Refusing to mix results from a different corpus.`,
      );
      process.exitCode = 1;
      return;
    }
    if (resumeDoc.practiceCorpus?.totalCount !== practicesResult.count) {
      console.error(
        `Cannot resume: ${options.resume} ran against ${resumeDoc.practiceCorpus?.totalCount} practices; ` +
          `the current corpus has ${practicesResult.count}. Refusing to mix results from a different practice corpus.`,
      );
      process.exitCode = 1;
      return;
    }
    if (resumeDoc.repeats !== repeats) {
      console.error(
        `Cannot resume: ${options.resume} used --repeats ${resumeDoc.repeats}; this run asked for ${repeats}. ` +
          `Resume requires the same repeat count as the run being resumed.`,
      );
      process.exitCode = 1;
      return;
    }
    if (options.widths || options.practiceCounts) {
      console.log(
        `--resume ${options.resume}: ignoring --widths/--practice-counts on this command line ` +
          `and using the resumed file's own axes instead — a resume finishes the same sweep, ` +
          `it does not start a differently-scoped one.`,
      );
    }
    widths = resumeDoc.axes?.widths ?? widths;
    practiceCounts = resumeDoc.axes?.practiceCounts ?? practiceCounts;
    for (const cfg of resumeDoc.configurations) {
      alreadyDone.set(`${cfg.practiceCount}:${cfg.width}`, cfg);
    }
    console.log(
      `Resuming from ${options.resume}: ${alreadyDone.size} configuration(s) already completed ` +
        `and carried over as-is; this run will not re-spend on them. NOTE: resume verifies the ` +
        `corpus case set, the practice-corpus size, and --repeats match — it does not verify the ` +
        `model or credential used are the same as the resumed file's.`,
    );
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

  const configKeyOf = (cb) => `${cb.practiceCount}:${cb.width}`;
  // Configurations a resumed run already completed are not re-executed, but
  // still count toward runConfigs.length (the planned total) — they are
  // seeded straight into configurationsOut below instead.
  const remainingConfigs = runConfigs.filter((cb) => !alreadyDone.has(configKeyOf(cb)));

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
  if (alreadyDone.size > 0) {
    console.log(
      `${alreadyDone.size} configuration(s) carried over from the resumed file; ` +
        `${remainingConfigs.length} configuration(s) remain to run this session.`,
    );
  }

  const calls = [];
  for (const cb of remainingConfigs) {
    for (const subject of subjects) {
      for (let repeatIndex = 0; repeatIndex < repeats; repeatIndex += 1) {
        for (const lens of cb.lensSet.lenses) {
          calls.push({ cb, subject, repeatIndex, lens });
        }
      }
    }
  }

  // Every call is tracked back to its configuration as it completes, not
  // regrouped once at the end — persistence below fires the moment a
  // configuration's own calls are all in, so a crash partway through the
  // sweep loses only the configurations still in flight, never the ones
  // already finished.
  const expectedByConfig = new Map();
  const byConfig = new Map();
  for (const cb of remainingConfigs) {
    const key = configKeyOf(cb);
    expectedByConfig.set(key, subjects.length * repeats * cb.lensSet.lenses.length);
    byConfig.set(key, { cb, cases: new Map(), doneCount: 0 });
  }

  const sha = await readGitSha(REPO_ROOT);
  const credentialSources = await describeCredentialSources(process.env);
  const generatedAt = new Date().toISOString();
  await mkdir(resultsDir, { recursive: true });
  const fileName = `${generatedAt.slice(0, 10)}-${settings.model}.json`;
  const filePath = join(resultsDir, fileName);

  // Seeded with whatever a resumed run already completed, so the file this
  // session writes is one coherent, complete-so-far record — not a second
  // file that only makes sense read alongside the first. A resumed file
  // from before the bracket verdict existed would carry configurations with
  // no `bracket` field — computed defensively here rather than left absent,
  // so every configuration in THIS file's output carries one.
  const configurationsOut = [...alreadyDone.values()].map((cfg) =>
    cfg.bracket ? cfg : { ...cfg, bracket: classifyWidth(cfg) },
  );

  function scoreOneConfiguration(entry) {
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
    const configResult = {
      practiceCount: entry.cb.practiceCount,
      width: entry.cb.width,
      practiceSubsetSize: entry.cb.practiceSubsetSize,
      lensSet: entry.cb.lensSet,
      cases: casesOut,
    };
    // The bracket verdict, not a rank: see eval/criterion.mjs. Computed here
    // so it is always present alongside the raw scores that produced it —
    // never a number a reader has to re-derive by re-running classifyWidth
    // against the raw results by hand.
    configResult.bracket = classifyWidth(configResult);
    return configResult;
  }

  // Consecutive-429 abort tracking — see MAX_CONSECUTIVE_429's own comment
  // for the threshold and the trade it makes. Reset by anything that is NOT
  // a 429 (a success, a different failure — anything), because the claim
  // being tested is specifically "the last N calls, in a row, came back 429".
  let consecutive429 = 0;
  let aborted = false;
  let abortReason = null;

  // `partial` plus the completed/planned counts are the elision announcing
  // itself — the same discipline lensSet.ts applies to its own output: a
  // results file that has only completed some of its planned configurations
  // says so plainly, so a crash, an abort, or an interruption is never read
  // back as a finished run.
  function buildResultsDoc(partial) {
    return {
      measurement: 'eval-sweep',
      generatedAt,
      model: settings.model,
      // Read off settings.credential.source now that ReviewSettings carries
      // a Credential (ported from s26/subscription-oauth-locally onto this
      // branch's settings.ts — see the file header). Was a hardcoded
      // (src/review/anthropic.ts) has exactly one way to send it. Recorded
      // anyway, explicitly, rather than omitted — a results file that
      // cannot say what produced it is the exact failure this harness
      // exists to prevent, even when the value never varies.
      credentialSource: settings.credential.source,
      // Recorded explicitly rather than omitted: a results file that cannot
      // say what produced it is the exact failure this harness exists to
      // prevent.
      gitSha: sha ?? null,
      gitShaObtained: sha !== undefined,
      concurrencyCap: concurrency,
      credentialSources,
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
      // Stated here, not just in eval/criterion.mjs's source comments — a
      // good/bad verdict with no stated criterion is exactly as unfounded
      // as a precise number with no derivation, so a reader of THIS file
      // never has to go find the source to know what a run's `bracket`
      // verdicts meant.
      criterion: {
        catchThresholdOf3: CATCH_THRESHOLD_OF_3,
        rejectThresholdOf3: REJECT_THRESHOLD_OF_3,
        minUsableRepeatsOf3: MIN_USABLE_REPEATS_OF_3,
        correctRejectionCaseId: CORRECT_REJECTION_CASE_ID,
        rule: CRITERION_RULE,
      },
      resumedFrom: options.resume ?? null,
      abortReason,
      partial,
      configurationsCompleted: configurationsOut.length,
      configurationsPlanned: runConfigs.length,
      configurations: configurationsOut,
    };
  }

  // Writes are chained, never concurrent: two configurations completing in
  // the same tick must not race to write the same file — each write waits
  // for the previous one to land before starting. Trailing newline because
  // prettier expects one at EOF, and this is a tracked, committed file lint
  // actually checks.
  let writeChain = Promise.resolve();
  function persist(partial) {
    const doc = buildResultsDoc(partial);
    writeChain = writeChain.then(() =>
      writeFile(filePath, `${JSON.stringify(doc, null, 2)}\n`, 'utf8'),
    );
    return writeChain;
  }

  // Written once before any call resolves, so a crash on the very first call
  // still leaves a file on disk honestly reporting what a resumed run
  // already had (or zero of N, on a fresh run) — never the total silence
  // stage 1's first real run left.
  await persist(configurationsOut.length < runConfigs.length);

  console.log(`Dispatching ${calls.length} model call(s) at concurrency ${concurrency}...`);
  await runPool(
    calls,
    concurrency,
    (call) => callOnce(call.lens, call.subject, settings),
    (call, result) => {
      const is429 =
        result.outcome === 'could_not_run' &&
        typeof result.reason === 'string' &&
        result.reason.startsWith('HTTP 429:');
      if (is429) {
        consecutive429 += 1;
        if (consecutive429 >= MAX_CONSECUTIVE_429 && !aborted) {
          aborted = true;
          abortReason =
            `${consecutive429} consecutive HTTP 429 responses with no success in between ` +
            `(threshold MAX_CONSECUTIVE_429=${MAX_CONSECUTIVE_429}) — stopping rather than ` +
            `grinding through the rest of the retry ladder for every remaining call.`;
          console.error(`ABORTING: ${abortReason}`);
        }
      } else {
        consecutive429 = 0;
      }

      const key = configKeyOf(call.cb);
      const entry = byConfig.get(key);
      if (!entry.cases.has(call.subject.id)) {
        entry.cases.set(call.subject.id, new Map());
      }
      const caseEntry = entry.cases.get(call.subject.id);
      if (!caseEntry.has(call.repeatIndex)) {
        caseEntry.set(call.repeatIndex, []);
      }
      caseEntry.get(call.repeatIndex).push(result);
      entry.doneCount += 1;

      if (entry.doneCount === expectedByConfig.get(key)) {
        const scored = scoreOneConfiguration(entry);
        configurationsOut.push(scored);
        console.log(
          `  configuration width=${entry.cb.width} practiceCount=${entry.cb.practiceCount}: ` +
            `bracket=${scored.bracket.verdict}`,
        );
        persist(configurationsOut.length < runConfigs.length);
      }
    },
    () => aborted,
  );

  await persist(configurationsOut.length < runConfigs.length || aborted);
  await writeChain;

  if (configurationsOut.length > 0) {
    console.log(
      'Bracket verdicts (good/bad/indistinguishable — not a ranking; see criterion.mjs):',
    );
    for (const cfg of configurationsOut) {
      console.log(
        `  width=${cfg.width} practiceCount=${cfg.practiceCount}: ${cfg.bracket.verdict}`,
      );
    }
  }

  if (aborted) {
    console.error(
      `Sweep aborted: ${abortReason}\n` +
        `${configurationsOut.length} of ${runConfigs.length} configuration(s) completed before the abort; ` +
        `partial results written to ${filePath}. Resume with --resume ${filePath} once the quota recovers.`,
    );
    process.exitCode = 1;
  } else {
    console.log(
      `Written to ${filePath} (${configurationsOut.length} of ${runConfigs.length} configuration(s) completed)`,
    );
  }
}

main().catch((cause) => {
  console.error(cause?.stack ?? String(cause));
  process.exitCode = 1;
});
