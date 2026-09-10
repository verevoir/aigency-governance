// The first end-to-end evidence that this thing actually runs.
//
// A gate rather than a test, because what it checks cannot be checked
// in-process: that `rootDir` put the emitted file where `bin` says it is,
// that the shebang line tsc emitted matches what it was given verbatim, and
// that node starts the file. A sibling project in this rebuild shipped a
// container that started a file it had never emitted, and no unit test could
// have caught it — the failure was entirely in where the bytes landed.
//
// A review found this claimed more than it checked: the shebang line was
// never read, only asserted about in prose. Reading it back and comparing it
// exactly is cheap enough to do rather than to merely narrow the sentence —
// see below, right after the existence check. What is still NOT checked, and
// is not cheap enough to be worth adding here, stays named further down:
// this runs `node <path>` rather than executing the file directly, so
// whether the execute bit npm sets when it LINKS `bin` survives is unproven
// by anything in this file.
//
// It costs nothing to run. An empty diff makes `runReview` return before the
// deps factory is called, so no client is built and no request is made; the
// keys below are deliberately not real ones, and if this ever starts needing
// one, something has moved that should not have.
//
// Three scenarios, not one. The panel's first real review found that nothing
// in this repository actually proves `review.ts` WIRES `keyFileReader()`
// into `runReview` — every unit test drives `resolveSettings` or `runReview`
// directly with an injected fake, and none of them touch the process
// boundary where that wiring either happens or doesn't. `review.ts` is
// deliberately kept free of anything a unit test could exercise (see its own
// header), so the only honest place to prove the wiring is here, running the
// real compiled binary against a real file on disk. The third scenario
// proves the newer half of that same wiring: that no key configured at all
// resolves to the keyless route rather than blocking the run — see its own
// comment below.

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

const BIN = 'dist/cli/review.js';
const EXPECTED_SHEBANG = '#!/usr/bin/env node';

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

// The check the header now actually makes true: read the first line back
// and compare it exactly, rather than only asserting in prose that tsc
// preserved it. Cheap — one file read, no process, no exec bit needed — and
// it is the literal claim a reader of the header would expect this gate to
// have made.
const firstLine = (await readFile(BIN, 'utf8')).split('\n')[0];
if (firstLine !== EXPECTED_SHEBANG) {
  console.error(
    `${BIN}'s first line is ${JSON.stringify(firstLine)}, expected exactly ` +
      `${JSON.stringify(EXPECTED_SHEBANG)}.\n\n` +
      'The shebang did not survive emit — `node <path>` still starts the file ' +
      'regardless, which is exactly why this is checked separately rather than ' +
      'inferred from the process below starting successfully.',
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
//
// The env passed to the child is built from scratch here — PATH and
// AIGENCY_REVIEW_LENSES plus whatever `extraEnv` names — never a spread of
// this process's own `process.env`. That is what makes "no key configured"
// (scenario 3, below) actually mean that to the child: a variable simply
// left out of `extraEnv` is absent to the child, not merely unset in a
// caller-visible way, so there is no accidental leak of this process's own
// environment (an ANTHROPIC_API_KEY that happens to be set on the machine
// running this gate, say) into a scenario meant to have none.
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
    let out = '';
    child.stdout.on('data', (chunk) => (out += String(chunk)));
    child.stderr.on('data', (chunk) => (out += String(chunk)));
    child.stdin.end('');
    child.on('close', (code) => resolve({ code, out }));
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

// Scenario 3: no key configured anywhere. `extraEnv` names only `HOME`,
// pointed at a fresh, empty directory — ANTHROPIC_API_KEY and
// ANTHROPIC_API_KEY_FILE are simply never named, which (per runEmptyDiff's
// own comment above) is what makes them genuinely absent to the child, and
// the empty HOME means the conventional default path
// (~/.config/verevoir/anthropic.key) finds nothing either. This is the
// laptop default settings.ts's route selection exists for: before it, this
// exact environment reported ANTHROPIC_API_KEY as unconfigured and refused
// before ever reaching the empty-diff guard. Now it must resolve to the
// keyless route and reach that same guard — proving `review.ts` actually
// wires the keyless path through end to end, not merely that
// `resolveSettings` CAN be told to return it against an injected fake
// (settings.test.ts already covers that half in isolation).
const noKeyDir = await mkdtemp(join(tmpdir(), 'aigency-review-cli-check-nokey-'));
try {
  const noKey = await runEmptyDiff({ HOME: noKeyDir });
  const out = checkRefused('no key configured (keyless route)', noKey);
  if (out.includes('ANTHROPIC_API_KEY')) {
    problems.push(
      '[no key configured] the report mentions ANTHROPIC_API_KEY as unconfigured — an ' +
        'absent key should resolve to the keyless route now, not block the run',
    );
  }
} finally {
  await rm(noKeyDir, { recursive: true, force: true });
}

if (problems.length > 0) {
  console.error(
    `The binary ran and did the wrong thing:\n${problems.map((p) => `  - ${p}`).join('\n')}`,
  );
  process.exit(1);
}

console.log(
  `${BIN} started, resolved the key from an env var and a file on disk, resolved to the ` +
    'keyless route with no key configured at all, and refused an empty diff every time.',
);
