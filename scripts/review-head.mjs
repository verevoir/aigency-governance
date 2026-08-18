// Review the HEAD commit with the panel this repository builds.
//
// A declared release step rather than a gate, deliberately: it costs money —
// one model call per lens — and a gate runs whenever anything is verified. A
// check that quietly bills you every time you ask whether the tests pass is a
// check nobody leaves on.
//
// It reviews HEAD rather than the whole branch because the whole branch is
// thousands of lines and there is no diff cap anywhere yet. One commit is a
// real subject, small enough to be affordable, and the first honest test of
// whether the panel finds anything.

import { spawn } from 'node:child_process';
import console from 'node:console';
import process from 'node:process';

function capture(command, args, input) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      env: {
        ...process.env,
        // The checked-out definition, not the published one: no token needed,
        // and the runner and the lens set are then the same revision.
        AIGENCY_REVIEW_LENSES: './review/lenses.json',
        // No override here any more. This used to raise the ceiling to 16384
        // "for this run only", on the reasoning that the evidence rather than
        // the guess should decide the default. The evidence came in: PR #1's
        // own CI check, at the untouched default of 4096, produced exactly
        // the truncated-thinking-block failure this comment predicted - and
        // 16384 would not have been enough either. DEFAULT_MAX_TOKENS in
        // settings.ts is now 65536, evidence-based rather than raised twice
        // in two places that could quietly drift apart.
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => (out += String(chunk)));
    child.stderr.on('data', (chunk) => (err += String(chunk)));
    if (input !== undefined) {
      child.stdin.end(input);
    } else {
      child.stdin.end();
    }
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

const subject = await capture('git', ['show', '--format=%s', '--no-patch', 'HEAD']);
const diff = await capture('git', ['show', '--format=', 'HEAD']);

if (diff.code !== 0) {
  console.error(`git show failed (${diff.code}):\n${diff.err}`);
  process.exit(1);
}

// Reported rather than reviewed. An empty diff would be refused downstream
// anyway, but saying it here names the cause as "this commit has no changes"
// rather than making the runner infer it.
if (diff.out.trim() === '') {
  console.error('HEAD has no diff to review.');
  process.exit(1);
}

console.log(`Reviewing HEAD: ${subject.out.trim()}`);
console.log(`Diff is ${String(diff.out.split('\n').length)} lines.\n`);

const review = await capture(
  process.execPath,
  ['dist/cli/review.js', subject.out.trim()],
  diff.out,
);

console.log(review.out);
if (review.err.trim() !== '') {
  console.error(review.err);
}
process.exit(review.code ?? 1);
