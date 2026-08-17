// The first end-to-end evidence that this thing actually runs.
//
// A gate rather than a test, because what it checks cannot be checked
// in-process: that `rootDir` put the emitted file where `bin` says it is,
// that the shebang survived emit, and that node starts it. A sibling project
// in this rebuild shipped a container that started a file it had never
// emitted, and no unit test could have caught it — the failure was entirely
// in where the bytes landed.
//
// It costs nothing to run. An empty diff makes `runReview` return before the
// deps factory is called, so no client is built and no request is made; the
// keys below are deliberately not real ones, and if this ever starts needing
// one, something has moved that should not have.
//
// Two scenarios, not one. The panel's first real review found that nothing
// in this repository actually proves `review.ts` WIRES `keyFileReader()`
// into `runReview` — every unit test drives `resolveSettings` or `runReview`
// directly with an injected fake, and none of them touch the process
// boundary where that wiring either happens or doesn't. `review.ts` is
// deliberately kept free of anything a unit test could exercise (see its own
// header), so the only honest place to prove the wiring is here, running the
// real compiled binary against a real file on disk.
//
// Two more scenarios below, added when AIGENCY_REVIEW_REPORT arrived: whether
// the files it writes actually land, and whether writing them ever moves
// what goes to stdout — the one channel this feature exists alongside, not
// instead of. Both cost nothing too: the empty-diff guard still returns
// before a panel could run.

import { spawn } from 'node:child_process';
// Imported, not assumed. The flat config declares no environment globals, and
// typescript-eslint only switches `no-undef` off for TypeScript — so in a
// plain .mjs `console` is genuinely undeclared. Same reason `process` is
// imported below rather than reached for as a global.
import console from 'node:console';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { buildFreshness } from './buildFreshness.mjs';

const BIN = 'dist/cli/review.js';
const SRC = 'src';
const DIST = 'dist';

// Three outcomes, not two: the artifact ran and met the bar, the artifact
// ran and did not, and the artifact could not be judged because it is not
// current. The third is not a variant of the second — reporting it as one is
// exactly how this gate passed for the wrong reason the night this check was
// added. run_gates runs the declared gates, not the bootstrap chain that
// produces dist/ — aigency.json's `commands` is a flat array with no way to
// say "this gate requires that bootstrap to have run first" — so a dist/
// built from a previous commit was spawned as current, and this gate, the
// only one that runs the artifact rather than the source, judged code that
// no longer existed. This check is a guard against that symptom, not a fix
// for the underlying gap: the declaration still cannot express the
// dependency, and nothing here changes that.
const freshness = await buildFreshness(SRC, DIST);
if (freshness.stale) {
  console.error(
    `${DIST}/ is stale, not broken — this gate cannot judge it.\n\n` +
      `${freshness.reason}.\n\n` +
      'This is not a verdict about the emitted binary: it was never asked to ' +
      'prove anything about the source that is here now. Run `npm run build` ' +
      '(prepare_repository runs it as part of bootstrap) and re-run this gate.',
  );
  process.exit(1);
}
// Said, not just satisfied: a guard that only speaks to refuse is
// indistinguishable, from outside, from a guard that is not there at all —
// deleting this whole check would change nothing an onlooker could see on
// the passing path. One line, printed only here, naming the two
// directories actually compared, so a caller — and the test that spawns
// this script — has something to point at that only a guard which ran can
// have produced. The review panel's honesty lens found this gap; see
// check-staleness-guard.mjs.
console.log(
  `${DIST}/ is current: no file under ${SRC}/ is newer than the newest file under ${DIST}/.`,
);

try {
  await access(BIN);
} catch {
  console.error(
    `${BIN} is not there.\n\n` +
      'The build did not emit where `bin` points. This is the failure ' +
      'tsconfig.build.json exists to prevent: with the root inferred rather ' +
      'than stated, tsc emits dist/src/... and every path in package.json is ' +
      'wrong. Run `npm run build` and check what appeared under dist/.',
  );
  process.exit(1);
}

// AIGENCY_REVIEW_LENSES is never read on this path — the empty-diff guard
// returns before a reader exists. It is load-bearing anyway: without it the
// source defaults to raw.githubusercontent.com, which requires a token, and
// the run would report the missing token instead of reaching the guard. So it
// pins the ordering from outside the process, and deleting it as unused
// configuration would quietly turn this gate into a test of something else.
//
// Not covered here, and worth knowing: this runs `node <path>`, not the
// installed `aigency-review`. tsc does not set the execute bit; npm sets it
// when it links `bin`. The path everyone will actually use is unproven.
function runEmptyDiff(extraEnv) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, 'the cli smoke test'], {
      env: {
        PATH: process.env.PATH,
        AIGENCY_REVIEW_LENSES: './review/lenses.json',
        ...extraEnv,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // stdout and stderr kept apart, not just concatenated: `out` stays the
    // combined view every check below already reads, and `stdout` alone is
    // what proves AIGENCY_REVIEW_REPORT never moves the channel CI reads
    // into the job summary — a claim `out` cannot support on its own, since
    // it would hide a message that leaked onto the wrong stream.
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.stdin.end('');
    child.on('close', (code) => resolve({ code, stdout, stderr, out: stdout + stderr }));
  });
}

const problems = [];

function checkRefused(label, { code, out }) {
  if (code !== 1) {
    problems.push(`[${label}] expected exit 1 for an empty diff, got ${code}`);
  }
  if (!out.includes('The diff was empty')) {
    problems.push(`[${label}] expected the report to say the diff was empty`);
  }
  if (!out.includes('not a passing one')) {
    problems.push(`[${label}] expected the report to say the result is red`);
  }
  return out;
}

// Scenario 1: the key arrives the way CI supplies it today — ANTHROPIC_API_KEY
// set directly in the environment. This is the path every existing workflow
// relies on and the whole reason the environment variable stays first in the
// precedence.
const direct = await runEmptyDiff({
  ANTHROPIC_API_KEY: 'not-a-real-key-and-must-never-need-to-be',
});
checkRefused('ANTHROPIC_API_KEY', direct);

// Scenario 2: no ANTHROPIC_API_KEY at all — only a file, via
// ANTHROPIC_API_KEY_FILE, the way a laptop is meant to supply it now. This is
// the seam the panel found untested: if `review.ts` merely imported
// `keyFileReader` without actually passing it to `runReview`, or passed
// something that never reaches disk, this run would fall back to reporting
// ANTHROPIC_API_KEY as unconfigured instead of reaching the empty-diff guard
// — exactly what the assertions below distinguish.
const keyDir = await mkdtemp(join(tmpdir(), 'aigency-review-cli-check-'));
const keyPath = join(keyDir, 'anthropic.key');
try {
  // The trailing newline is deliberate: it is what `echo … > file` produces,
  // and this is also incidental coverage that the real `keyFileReader()`
  // wired in by `review.ts` reads all the way through a real disk read, not
  // a stand-in for one.
  await writeFile(keyPath, 'not-a-real-key-and-must-never-need-to-be\n', 'utf8');

  const viaFile = await runEmptyDiff({ ANTHROPIC_API_KEY_FILE: keyPath });
  const out = checkRefused('ANTHROPIC_API_KEY_FILE', viaFile);
  if (out.includes('ANTHROPIC_API_KEY')) {
    problems.push(
      '[ANTHROPIC_API_KEY_FILE] the report mentions ANTHROPIC_API_KEY as unconfigured — ' +
        'the key on disk was not found, so review.ts is not actually wiring ' +
        'keyFileReader() into runReview',
    );
  }
} finally {
  await rm(keyDir, { recursive: true, force: true });
}

// Scenario 3: AIGENCY_REVIEW_REPORT set, and the path is writable. The
// empty-diff guard still returns before a panel could ever run, so this
// costs nothing and exercises the no-panel shape from reportFile.ts — a
// missing file, an empty one and "no panel ran, here is why" must not read
// the same to whoever finds this.
const reportDir = await mkdtemp(join(tmpdir(), 'aigency-review-cli-report-'));
try {
  // Directly inside the temporary directory mkdtemp already created — this
  // scenario is about a writable path, and writeReportFiles does not create
  // directories, so a nested subdirectory nobody made would fail for a
  // reason unrelated to what is under test here. The genuinely-unwritable
  // case is scenario 4, below.
  const reportPath = join(reportDir, 'report.md');
  const jsonPath = join(reportDir, 'report.json');

  const withReport = await runEmptyDiff({
    ANTHROPIC_API_KEY: 'not-a-real-key-and-must-never-need-to-be',
    AIGENCY_REVIEW_REPORT: reportPath,
  });
  checkRefused('AIGENCY_REVIEW_REPORT (writable)', withReport);

  // The property the whole feature must not violate, checked directly
  // against a baseline run of the same case with the variable unset, rather
  // than by reading review.ts and trusting the reasoning.
  if (withReport.stdout !== direct.stdout) {
    problems.push(
      '[AIGENCY_REVIEW_REPORT] stdout differs from the same run without the ' +
        'variable set — this channel must be untouched by the new one',
    );
  }
  if (withReport.stderr.trim() !== '') {
    problems.push(
      `[AIGENCY_REVIEW_REPORT] expected empty stderr on a successful write, got: ${withReport.stderr}`,
    );
  }

  let markdown;
  try {
    markdown = await readFile(reportPath, 'utf8');
  } catch (cause) {
    problems.push(`[AIGENCY_REVIEW_REPORT] the markdown file was not written: ${cause.message}`);
  }
  if (markdown !== undefined && markdown !== withReport.stdout) {
    problems.push(
      '[AIGENCY_REVIEW_REPORT] the markdown file does not match what was printed to stdout',
    );
  }

  let parsedJson;
  try {
    parsedJson = JSON.parse(await readFile(jsonPath, 'utf8'));
  } catch (cause) {
    problems.push(
      `[AIGENCY_REVIEW_REPORT] the JSON file was not written or did not parse: ${cause.message}`,
    );
  }
  if (parsedJson !== undefined) {
    if (parsedJson.ran !== false || typeof parsedJson.report !== 'string') {
      problems.push(
        '[AIGENCY_REVIEW_REPORT] expected the JSON to say { ran: false, report }, got: ' +
          JSON.stringify(parsedJson),
      );
    }
  }
} finally {
  await rm(reportDir, { recursive: true, force: true });
}

// Scenario 4: AIGENCY_REVIEW_REPORT set to a path that cannot be written —
// the parent directory does not exist and nothing here creates one. A write
// failure must fail the run loudly rather than pass silently with an
// unreadable report; overriding a genuine approval's 0 specifically is
// covered directly in tests/reportFile.test.ts, with a fake outcome, since
// forcing a real approval here would cost a real model call.
{
  const unwritable = await runEmptyDiff({
    ANTHROPIC_API_KEY: 'not-a-real-key-and-must-never-need-to-be',
    AIGENCY_REVIEW_REPORT: '/this/directory/does/not/exist/report.md',
  });
  checkRefused('AIGENCY_REVIEW_REPORT (unwritable)', unwritable);

  if (unwritable.stdout !== direct.stdout) {
    problems.push(
      '[AIGENCY_REVIEW_REPORT (unwritable)] stdout differs from the same run without the ' +
        'variable set, even though the write failed — stdout must still not move',
    );
  }
  if (!unwritable.stderr.includes('defect in the runner')) {
    problems.push(
      '[AIGENCY_REVIEW_REPORT (unwritable)] expected stderr to name this as a runner ' +
        `defect, got: ${unwritable.stderr}`,
    );
  }
}

if (problems.length > 0) {
  console.error(
    `The binary ran and did the wrong thing:\n${problems.map((p) => `  - ${p}`).join('\n')}`,
  );
  process.exit(1);
}

console.log(
  `${BIN} started, resolved the key from both an env var and a file on disk, and refused an empty diff both times.`,
);
