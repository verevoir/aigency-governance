// Review the HEAD commit with the panel this repository builds — through the
// real `claude` CLI (`claude -p`, a subscription credential), not the
// Anthropic API.
//
// THIS USED TO SPEND A PURCHASED KEY, HERE SPECIFICALLY. The header this
// replaced said "it costs money — one model call per lens", true of the
// Anthropic-backed `dist/cli/review.js`, and this script called exactly
// that. During active iteration on THIS repository, that meant every local
// run before every commit spent the same metered credit a CI merge-gate run
// does — the wrong trade for a script run many times a day against small,
// changing diffs. `dist/cli/reviewLocal.js` runs the identical panel and the
// identical reply contract (parseReply.ts is unchanged; see
// `src/review/claudeCli.ts`'s file header for what stays the same and what
// doesn't) against `claude -p` — a subscription route, already paid for,
// with a separate balance from the metered key. Nothing about what a lens
// sees or how a verdict is read changed; only which substrate answers.
//
// STILL A RELEASE STEP, NOT A GATE — but not for the reason it used to be.
// It no longer costs purchased credit, but it does need the `claude` CLI
// installed and logged into a subscription, takes real wall-clock time (one
// subprocess per lens), and — like the Anthropic path before it — REFUSES
// rather than falls back: if `claude` is not usable, this reports could-not-
// run and exits red. It never reaches for a billed key instead. A gate that
// can fail because the operator's laptop isn't logged in is not a fact about
// the commit being verified, which is the same reason a gate must not run
// anything that can fail for reasons unrelated to the code (see
// `aigency.json`'s own `review` step description for how this is declared).
//
// It reviews HEAD rather than the whole branch because the whole branch is
// thousands of lines and there is no diff cap anywhere yet. One commit is a
// real subject, small enough to review in reasonable time, and the first
// honest test of whether the panel finds anything.

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

console.log(`Reviewing HEAD via claude -p (subscription, not billed API credit): ${subject.out.trim()}`);
console.log(`Diff is ${String(diff.out.split('\n').length)} lines.\n`);

const review = await capture(
  process.execPath,
  ['dist/cli/reviewLocal.js', subject.out.trim()],
  diff.out,
);

console.log(review.out);
if (review.err.trim() !== '') {
  console.error(review.err);
}
process.exit(review.code ?? 1);
