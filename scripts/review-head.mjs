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
import { fileURLToPath, URL } from 'node:url';

import {
  describeReportOutcome,
  ensureReportDir,
  probeReportFile,
  reportTargetPaths,
} from './reportTarget.mjs';

// Resolved relative to this file, not to the process's cwd — the same
// choice review-branch.mjs makes for the identical reason (see its own
// header): the compiled binary is a fixed build artifact of THIS
// repository, not of whatever tree happens to be current when this script
// runs, and for real usage (cwd = this repository's root) the two resolve
// to the same absolute path either way. What this buys is testability: a
// fixture repository built elsewhere on disk, with its own HEAD this
// script's git calls operate against, can still find the real compiled
// reviewer without needing dist/ reproduced inside the fixture. A bare
// relative path here was the gap a test found: spawning that path against a
// fixture's cwd crashed with MODULE_NOT_FOUND rather than reaching the
// reviewer at all.
const BIN = fileURLToPath(new URL('../dist/cli/review.js', import.meta.url));

function capture(command, args, input, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      env: {
        ...process.env,
        // The checked-out definition, not the published one: no token needed,
        // and the runner and the lens set are then the same revision.
        AIGENCY_REVIEW_LENSES: './review/lenses.json',
        // Raised for this run only, and the default is deliberately not moved.
        // The first attempt failed with a response carrying one block and no
        // text, which is what a reply truncated during extended thinking looks
        // like. If that was the cause the error now says so, and the evidence
        // rather than the guess should decide the default.
        AIGENCY_REVIEW_MAX_TOKENS: '16384',
        ...extraEnv,
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

// Ignored by git and outliving a build, unlike dist/ — see reportTarget.mjs.
// The report is the paid-for output a run of this step used to produce and
// then discard entirely; this is where it lands now.
const report = reportTargetPaths();
await ensureReportDir(report.dir);

const review = await capture(process.execPath, [BIN, subject.out.trim()], diff.out, {
  AIGENCY_REVIEW_REPORT: report.markdown,
});

console.log(review.out);
if (review.err.trim() !== '') {
  console.error(review.err);
}

// Told, not assumed: the directory was created above, but the write itself
// happens inside the spawned process and can still fail (judgement 2 in
// reportFile.ts) — checked here rather than claimed unconditionally. And
// checked separately for each file: the markdown and the JSON are two
// distinct writes in writeReportFiles, so one succeeding says nothing about
// the other. Checking only the markdown and then claiming both existed is
// exactly what the review panel's own honesty lens found against an earlier
// version of this block.
const markdownProbe = await probeReportFile(report.markdown);
const jsonProbe = await probeReportFile(report.json);
console.log(describeReportOutcome(report, markdownProbe, jsonProbe));

process.exit(review.code ?? 1);
