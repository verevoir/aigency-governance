// Whether the staleness guard added to check-cli.mjs actually does anything.
//
// buildFreshness.mjs, the pure function underneath the guard, is covered
// thoroughly by tests/buildFreshness.test.mjs. The guard itself — the code
// in check-cli.mjs that reads freshness.stale, prints, and calls
// process.exit(1) — was not exercised by anything: the review panel's
// verification lens found this against the commit that introduced it. An
// inverted condition, a wrong exit code, or a guard silently skipped would
// have passed every existing test. That is the same defect one level up —
// a check nobody checks — which is exactly what the guard exists to catch
// one level down, in dist/.
//
// This spawns the real check-cli.mjs as a process, the same way it spawns
// the real dist/cli/review.js — see its own header, "what it checks cannot
// be checked in-process" — against two constructed temporary trees. Neither
// depends on a modification time. The stale fixture has no dist/ at all,
// which is one of buildFreshness's three real reasons for staleness and
// needs no file and no clock. The fresh fixture (the control) has a dist/
// holding one file and no src/ at all, so the modification-time comparison
// in buildFreshness is never reached — it is guarded there by
// `srcNewest !== undefined` — rather than won by racing a clock to prove it
// wasn't reached.
//
// An earlier version of this file claimed the fresh fixture proved the
// guard "was reached and passed rather than never run", on the strength of
// check-cli.mjs going on to fail at its next check — dist/cli/review.js
// genuinely is not there in this fixture. That claim was wrong, and the
// review panel's honesty lens found it: a guard that is silent when it
// passes cannot be told apart from a guard that was never invoked at all,
// because a deleted guard falls straight through to that exact same next
// failure. The control could rule out a false positive — the guard did not
// wrongly refuse a fresh tree — but it could not rule out the guard simply
// not existing. So the guard was changed to say, on the passing branch and
// only there, what it compared. That line is a statement only a guard that
// actually ran can make; the fresh fixture below asserts it directly,
// rather than inferring the guard ran from what happens after it. The
// mtime-comparison branch of buildFreshness itself is already covered, with
// gaps of 1000 real seconds, by tests/buildFreshness.test.mjs; this script
// does not re-prove it, only that check-cli.mjs's own wiring around the
// result is correct.
//
// A standalone script and its own gate, not a vitest test living inside
// `npm run test`, for the same reason check-cli.mjs is one: `verify` is
// meant to be the fast in-process bar (typecheck, test, lint), and this is
// process-spawn integration testing, the same shape of check as the one
// other place in this repository that does it. This does not run the `cli`
// gate command recursively — it spawns check-cli.mjs's own script directly,
// once per fixture, with a controlled cwd, not the `cli` gate declaration
// itself.

import { spawn } from 'node:child_process';
import console from 'node:console';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import process from 'node:process';

const CHECK_CLI = resolvePath('scripts/check-cli.mjs');

function run(cwd) {
  return new Promise((settle) => {
    const child = spawn(process.execPath, [CHECK_CLI], {
      cwd,
      env: { PATH: process.env.PATH },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.on('close', (code) => settle({ code, stdout, stderr, out: stdout + stderr }));
  });
}

const problems = [];

const staleDir = await mkdtemp(join(tmpdir(), 'aigency-staleness-guard-stale-'));
const freshDir = await mkdtemp(join(tmpdir(), 'aigency-staleness-guard-fresh-'));

try {
  // Stale: an empty directory. No dist/, so buildFreshness's first branch —
  // "does not exist" — fires before anything about src/ or a clock is even
  // looked at.
  const stale = await run(staleDir);
  if (stale.code === 0) {
    problems.push('[stale dist] expected a non-zero exit, got 0');
  }
  if (!stale.out.includes('is stale, not broken')) {
    problems.push(
      `[stale dist] expected the output to name staleness specifically, got: ${stale.out}`,
    );
  }

  // Fresh, the control, and the discriminating case: dist/ exists and holds
  // a file; src/ does not exist at all. buildFreshness's mtime comparison is
  // guarded by `srcNewest !== undefined`, so with no src/ the comparison is
  // never reached and the result is simply "not stale" — no clock race. If
  // check-cli.mjs's staleness message appears here too, the guard fired when
  // it should not have; only the exit-code assertion above would not catch a
  // guard hard-wired to always refuse, which is why this check is the one
  // that actually distinguishes a working guard from a broken one.
  await mkdir(join(freshDir, 'dist'), { recursive: true });
  await writeFile(join(freshDir, 'dist', 'placeholder.js'), '// not a real build\n', 'utf8');

  const fresh = await run(freshDir);
  if (fresh.out.includes('is stale, not broken')) {
    problems.push(
      '[fresh dist] the staleness guard fired even though dist/ was not stale — a guard ' +
        `hard-wired to always refuse would pass every other assertion here, got: ${fresh.out}`,
    );
  }
  // The discriminating assertion. Everything else in this fixture — the
  // exit code, the later "is not there" failure below — would look
  // identical if the guard had been deleted entirely, since execution would
  // fall straight through to that same next check. Only this line is
  // printed exclusively from inside the guard's own passing branch in
  // check-cli.mjs, so only a guard that actually ran and compared the two
  // directories can have produced it.
  if (!fresh.out.includes('dist/ is current')) {
    problems.push(
      '[fresh dist] expected the guard to say the build is current, naming what it compared ' +
        `— a silent pass here is indistinguishable from a guard that never ran — got: ${fresh.out}`,
    );
  }
  if (fresh.code === 0) {
    problems.push(
      '[fresh dist] expected a non-zero exit — dist/cli/review.js genuinely is not there in ' +
        'this fixture — got 0, meaning the fixture is no longer constructed as intended',
    );
  }
  if (!fresh.out.includes('is not there')) {
    problems.push(
      '[fresh dist] expected the run to fail at the next check instead (dist/cli/review.js is ' +
        `not there), got: ${fresh.out}`,
    );
  }
} finally {
  await rm(staleDir, { recursive: true, force: true });
  await rm(freshDir, { recursive: true, force: true });
}

if (problems.length > 0) {
  console.error(
    `The staleness guard's own wiring did not behave as expected:\n${problems
      .map((p) => `  - ${p}`)
      .join('\n')}`,
  );
  process.exit(1);
}

console.log(
  'The staleness guard in check-cli.mjs refuses a genuinely stale dist/, and does not fire ' +
    'against a fresh one.',
);
