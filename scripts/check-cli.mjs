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
// key below is deliberately not a real one, and if this ever starts needing
// one, something has moved that should not have.

import { spawn } from 'node:child_process';
// Imported, not assumed. The flat config declares no environment globals, and
// typescript-eslint only switches `no-undef` off for TypeScript — so in a
// plain .mjs `console` is genuinely undeclared. Same reason `process` is
// imported below rather than reached for as a global.
import console from 'node:console';
import { access } from 'node:fs/promises';
import process from 'node:process';

const BIN = 'dist/cli/review.js';

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
const child = spawn(process.execPath, [BIN, 'the cli smoke test'], {
  env: {
    PATH: process.env.PATH,
    ANTHROPIC_API_KEY: 'not-a-real-key-and-must-never-need-to-be',
    AIGENCY_REVIEW_LENSES: './review/lenses.json',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let out = '';
child.stdout.on('data', (chunk) => (out += String(chunk)));
child.stderr.on('data', (chunk) => (out += String(chunk)));
child.stdin.end('');

const code = await new Promise((resolve) => child.on('close', resolve));

const problems = [];
if (code !== 1) {
  problems.push(`expected exit 1 for an empty diff, got ${code}`);
}
if (!out.includes('The diff was empty')) {
  problems.push('expected the report to say the diff was empty');
}
if (!out.includes('not a passing one')) {
  problems.push('expected the report to say the result is red');
}

if (problems.length > 0) {
  console.error(
    `The binary ran and did the wrong thing:\n${problems.map((p) => `  - ${p}`).join('\n')}\n\nIt said:\n${out}`,
  );
  process.exit(1);
}

console.log(`${BIN} started, read an empty diff, refused it, and exited 1.`);
