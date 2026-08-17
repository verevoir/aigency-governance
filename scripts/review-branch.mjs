// Review the current branch's own work against main, not just the HEAD
// commit review-head.mjs reviews.
//
// The gap this closes: CI reviews a pull request's diff — everything the
// branch carries against its base — and review-head.mjs reviews one commit.
// Those are different subjects, so a green run of review-head.mjs says
// nothing about whether CI's check will pass, and a red CI check cannot be
// reproduced locally with the tool this repository already has. The binary
// underneath was always capable of this: dist/cli/review.js computes no
// diff itself, it only reads one handed to it on stdin (see review.ts's own
// header). Only review-head.mjs pins it to `git show HEAD`. This script
// pins it to the branch's diff instead.
//
// THE DIFF IS `git diff main...HEAD` — three dots, not two. Two dots would
// diff the tip of main against this branch's tip directly, which includes
// everything that has landed on main since this branch was cut, and is not
// this branch's own work. Three dots diffs against the merge base, which is
// exactly what a pull request's diff is: the branch's own changes, nothing
// main did without it.
//
// THREE OUTCOMES, and keeping them apart is the point of this file as much
// as the reviewing is:
//
//   - too large — refused before anything is sent anywhere. This is a
//     refusal to judge, not a judgement, and the wording says so explicitly
//     — a reader must not be able to mistake "too big to review" for
//     "reviewed and rejected". Nothing is written to the report files: there
//     is nothing to report, only a refusal to try.
//   - empty — nothing to review, and NOT an error. review-head.mjs treats an
//     empty diff as one, deliberately: asking it to review "this commit"
//     and getting nothing back is almost always a wiring mistake (a diff
//     computed against the wrong base, a shallow clone). A branch with no
//     changes against main is not that — it is the ordinary state of a
//     branch just cut, or one whose changes were reverted, or one already
//     folded into main. Nothing is wrong, there is nothing to do, and this
//     exits 0 rather than reusing review-head.mjs's exit 1. Diverging from
//     that precedent on purpose, said here rather than left for two scripts
//     to be found silently disagreeing.
//   - reviewable — spawns the same binary review-head.mjs spawns, feeds it
//     the branch diff on stdin, and writes the report and the structured
//     verdict to files — see reportTarget.mjs for why `base: 'branch'`
//     matters: a different filename from review-head.mjs's own report, in
//     the same directory, so a branch review and a commit review can never
//     silently overwrite one another.
//
// THE CAP: AIGENCY_REVIEW_BRANCH_MAX_CHARS, optional, defaulting to 200,000
// characters. A present-but-invalid value is refused rather than replaced —
// the same shape AIGENCY_REVIEW_MAX_TOKENS already uses in settings.ts,
// chosen over provision.ts's fully-required `maxChars` because this is an
// environment string arriving from outside the process, not a function
// parameter a caller already has in hand and has already had to think
// about. The default itself is a starting estimate, not a measured one, and
// said as such: roughly 50,000 tokens at ~4 characters per token, which
// leaves the bulk of a 200,000-token context window free for the system
// prompt, the lens definitions and the completion budget even before
// accounting for margin. review-head.mjs's own AIGENCY_REVIEW_MAX_TOKENS
// override carries the same honesty about where a number like this comes
// from — raised once from a real failure, not a guess — and the evidence
// should move this one the same way if it turns out wrong.
//
// Declared as a `release` step in aigency.json, not a `gate`, for the same
// reason `review` is: this bills real money, one model call per lens, and a
// gate that bills on every verification is a gate someone turns off.

import { spawn } from 'node:child_process';
// Imported, not assumed — the flat eslint config declares no environment
// globals, so in a plain .mjs file `console` and `process` are genuinely
// undeclared without this. Same convention every other script here follows.
import console from 'node:console';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

import { assessDiffCap } from './diffCap.mjs';
import {
  describeReportOutcome,
  ensureReportDir,
  probeReportFile,
  REPORT_DIR,
  reportTargetPaths,
} from './reportTarget.mjs';

// Resolved relative to this file, not to the process's cwd. Every git
// command below deliberately runs against whatever cwd this process was
// started with, since that is the working tree being reviewed — but the
// compiled binary is a fixed build artifact of THIS repository, not of
// whatever tree happens to be current, and the two must not be conflated.
// Also what makes this testable against a constructed fixture repository
// elsewhere on disk without needing to reproduce a full build inside it.
const BIN = fileURLToPath(new URL('../dist/cli/review.js', import.meta.url));

function capture(command, args, input, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...extraEnv },
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

function present(value) {
  return value === undefined || value.trim() === '' ? undefined : value;
}

const DEFAULT_MAX_CHARS = 200_000;

// Parsed before anything else runs, including before git is touched — an
// invalid cap is a configuration mistake, not a fact about this branch, and
// should fail exactly as fast as a bad AIGENCY_REVIEW_MAX_TOKENS does.
let maxChars = DEFAULT_MAX_CHARS;
const rawCap = present(process.env['AIGENCY_REVIEW_BRANCH_MAX_CHARS']);
if (rawCap !== undefined) {
  const parsed = Number(rawCap);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    console.error(
      `AIGENCY_REVIEW_BRANCH_MAX_CHARS must be a positive whole number, got ${JSON.stringify(rawCap)}`,
    );
    process.exit(1);
  }
  maxChars = parsed;
}

const branch = await capture('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
if (branch.code !== 0) {
  console.error(`git rev-parse failed (${String(branch.code)}):\n${branch.err}`);
  process.exit(1);
}
const branchName = branch.out.trim();
const title = `${branchName} vs main`;

// Three dots: the branch's own work against the merge base, not main's tip
// against this branch's tip. See the file header.
const diff = await capture('git', ['diff', 'main...HEAD']);
if (diff.code !== 0) {
  console.error(`git diff failed (${String(diff.code)}):\n${diff.err}`);
  process.exit(1);
}

const assessment = assessDiffCap(diff.out, maxChars);

if (assessment.kind === 'empty') {
  // Not an error — see the file header for why this diverges from
  // review-head.mjs's treatment of an empty diff.
  console.log(`${title}: nothing to review — the branch carries no changes against main.`);
  process.exit(0);
}

if (assessment.kind === 'too-large') {
  const over = assessment.chars - assessment.maxChars;
  console.error(
    `${title}: the diff is ${String(assessment.chars)} characters, ${String(over)} over the ` +
      `${String(assessment.maxChars)}-character cap.\n\n` +
      'This is a refusal to review, not a review that found a problem: nothing was judged, ' +
      'nothing was sent to a model, and this is not a rejection. Review a narrower range, ' +
      'review a single commit instead (see review-head.mjs), or raise ' +
      'AIGENCY_REVIEW_BRANCH_MAX_CHARS if a diff this size is genuinely expected here.',
  );
  process.exit(1);
}

console.log(`Reviewing ${title}.`);
console.log(
  `Diff is ${String(assessment.chars)} characters, under the ${String(maxChars)}-character cap.\n`,
);

// A different filename from review-head.mjs's own report, in the same
// directory — see reportTarget.mjs's reportTargetPaths for why the base
// matters: a commit's report and a branch's report must never be able to
// overwrite one another.
const report = reportTargetPaths(REPORT_DIR, 'branch');
await ensureReportDir(report.dir);

const review = await capture(process.execPath, [BIN, title], diff.out, {
  // The checked-out definition, not the published one — same reasoning as
  // review-head.mjs: no token needed, and the runner and the lens set are
  // then the same revision.
  AIGENCY_REVIEW_LENSES: './review/lenses.json',
  AIGENCY_REVIEW_MAX_TOKENS: '16384',
  AIGENCY_REVIEW_REPORT: report.markdown,
});

console.log(review.out);
if (review.err.trim() !== '') {
  console.error(review.err);
}

const markdownProbe = await probeReportFile(report.markdown);
const jsonProbe = await probeReportFile(report.json);
console.log(describeReportOutcome(report, markdownProbe, jsonProbe));

process.exit(review.code ?? 1);
