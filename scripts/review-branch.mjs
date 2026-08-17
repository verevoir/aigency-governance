// Review a branch's own work against a base — not necessarily the branch
// currently checked out, and not necessarily against main.
//
// The gap this closes: CI reviews a pull request's diff — everything the
// head carries against its base — and review-head.mjs reviews one commit.
// Those are different subjects, so a green run of review-head.mjs says
// nothing about whether CI's check will pass, and a red CI check cannot be
// reproduced locally with the tool this repository already had. The binary
// underneath was always capable of this: dist/cli/review.js computes no
// diff itself, it only reads one handed to it on stdin (see review.ts's own
// header). Only review-head.mjs pins it to `git show HEAD`. This script
// pins it to a diff between two refs instead.
//
// BOTH ENDS ARE NAMEABLE: AIGENCY_REVIEW_BRANCH_BASE (default `main`) and
// AIGENCY_REVIEW_BRANCH_HEAD (default `HEAD`). A diff between two refs needs
// no checkout — `git diff A...B` answers a question about two names, not
// about whatever happens to be on disk — so a tree parked on one branch can
// review a completely different one. That matters concretely here: nothing
// on this belt can check out a branch, so before this existed the script
// could only ever review whichever branch the tree already happened to be
// parked on, which is not necessarily the branch — or the pull request —
// anyone actually wants reviewed.
//
// THE DIFF IS `${base}...${head}` — three dots, not two. Two dots would diff
// the base's tip against the head's tip directly, which includes everything
// the base has done since the two diverged, and is not the head's own work.
// Three dots diffs against the merge base, which is exactly what a pull
// request's diff is: the head's own changes, nothing the base did without it.
//
// A REF THAT DOES NOT EXIST IS REFUSED BY NAME, before the diff is computed
// or measured and before anything is spawned that costs anything. `git diff`
// given a bad ref fails with "unknown revision", which names the string that
// failed to resolve but not which of the two positions it came from, nor
// whether the other one was fine — not an answer a person can act on without
// re-reading the command. Both refs are checked with `git rev-parse
// --verify` first, and if both are wrong, both are named — the same
// gather-every-independently-knowable-problem discipline `runReview` already
// uses in src/cli/run.ts, applied here to the two facts that are knowable
// before any diff exists to compute.
//
// THREE OUTCOMES, once both refs are confirmed to exist, and keeping them
// apart is as much the point of this file as the reviewing is:
//
//   - too large — refused before anything is sent anywhere. This is a
//     refusal to judge, not a judgement, and the wording says so explicitly
//     — a reader must not be able to mistake "too big to review" for
//     "reviewed and rejected". Nothing is written to the report files: there
//     is nothing to report, only a refusal to try.
//   - empty — nothing to review, and NOT an error. review-head.mjs treats an
//     empty diff as one, deliberately: asking it to review "this commit" and
//     getting nothing back is almost always a wiring mistake (a diff
//     computed against the wrong base, a shallow clone). A head with no
//     changes against its base is not that — it is the ordinary state of a
//     branch just cut, or one whose changes were reverted, or one already
//     folded into its base. Nothing is wrong, there is nothing to do, and
//     this exits 0 rather than reusing review-head.mjs's exit 1. Diverging
//     from that precedent on purpose, said here rather than left for two
//     scripts to be found silently disagreeing.
//   - reviewable — spawns the same binary review-head.mjs spawns, feeds it
//     the diff on stdin, and writes the report and the structured verdict to
//     files.
//
// THE REPORT PATH IS DERIVED FROM BOTH REFS, not a fixed name. `branch.md`
// was fine while only one pair of refs was ever reviewable from a given
// tree; once the base and the head can each be named, two different
// reviews — say, two different pull requests checked from the same tree,
// one after the other — must not be able to silently overwrite one another,
// and a reader finding a report later must be able to tell which pair it was
// answering about without re-running anything. So the filename itself
// carries both refs, sanitised for the filesystem, e.g.
// `branch__main__s24a-lens-set.md`. This is not the only place the refs are
// recorded: `title` — `${head} vs ${base}` — is passed to the reviewer as
// the subject of what is being judged and appears inside the rendered
// report's own content, the same way review-head.mjs's commit subject does.
// Both are kept, deliberately: the filename is what stops two runs from
// colliding on disk before either report is ever opened; the in-report title
// is what tells a reader who has the file open, with no filename visible —
// piped through another tool, attached to a message — what it is actually
// looking at.
//
// THE CAP: AIGENCY_REVIEW_BRANCH_MAX_CHARS, optional, defaulting to 200,000
// characters. A present-but-invalid value is refused rather than replaced —
// the same shape AIGENCY_REVIEW_MAX_TOKENS already uses in settings.ts,
// chosen over provision.ts's fully-required `maxChars` because this is an
// environment string arriving from outside the process, not a function
// parameter a caller already has in hand and has already had to think about.
// The default is a starting estimate, not a measured one: roughly 50,000
// tokens at ~4 characters per token, leaving the bulk of a 200,000-token
// context window free for the system prompt, the lens definitions and the
// completion budget even before margin. The first real subject run against
// it — a four-story stack, 448,103 characters — refused at 2.24x the cap,
// which confirmed the grain was wrong (a whole stack was never a reviewable
// subject) rather than the cap being far off. That is the finding
// AIGENCY_REVIEW_BRANCH_BASE/_HEAD exist to act on, by making a single pull
// request's own pair of refs nameable instead of reviewing everything at
// once.
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

/** A filesystem-safe stand-in for a ref name — a branch can contain `/`,
 * which would otherwise turn one path segment into a nested directory. */
function sanitizeRef(ref) {
  return ref.replace(/[^A-Za-z0-9._-]+/g, '-');
}

/** Whether `ref` names something in this repository. Used only to decide
 * whether to refuse — never to learn anything else about the ref. */
async function refExists(ref) {
  const result = await capture('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  return result.code === 0;
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

const baseRefRaw = present(process.env['AIGENCY_REVIEW_BRANCH_BASE']);
const baseRef = baseRefRaw ?? 'main';
const headRefRaw = present(process.env['AIGENCY_REVIEW_BRANCH_HEAD']);
const headRef = headRefRaw ?? 'HEAD';

// Both checked, and both named if both are wrong — see the file header.
// This is the only git this script runs before knowing the two refs are
// real; everything that follows (the diff itself, the reviewer) is real
// spend or real measurement, and neither happens until this passes.
const refProblems = [];
if (!(await refExists(baseRef))) {
  refProblems.push(`the base ref, ${JSON.stringify(baseRef)}, does not exist in this repository`);
}
if (!(await refExists(headRef))) {
  refProblems.push(`the head ref, ${JSON.stringify(headRef)}, does not exist in this repository`);
}
if (refProblems.length > 0) {
  console.error(
    refProblems.length === 1
      ? refProblems[0]
      : `${String(refProblems.length)} refs could not be resolved, both named rather than ` +
          `stopping at the first:\n` +
          refProblems.map((problem, index) => `  ${String(index + 1)}. ${problem}`).join('\n'),
  );
  process.exit(1);
}

// Only when the head was left at its default: resolves 'HEAD' to the actual
// branch name for the title and the report filename, matching what this
// script printed before AIGENCY_REVIEW_BRANCH_HEAD existed. An explicitly
// named head is already a real name and needs no resolving.
let headDisplay = headRef;
if (headRefRaw === undefined) {
  const abbrev = await capture('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (abbrev.code === 0) {
    const name = abbrev.out.trim();
    if (name !== '') {
      headDisplay = name;
    }
  }
}

const title = `${headDisplay} vs ${baseRef}`;

// Three dots: the head's own work against the merge base, not the base's
// tip against the head's tip. See the file header.
const diff = await capture('git', ['diff', `${baseRef}...${headRef}`]);
if (diff.code !== 0) {
  console.error(`git diff failed (${String(diff.code)}):\n${diff.err}`);
  process.exit(1);
}

const assessment = assessDiffCap(diff.out, maxChars);

if (assessment.kind === 'empty') {
  // Not an error — see the file header for why this diverges from
  // review-head.mjs's treatment of an empty diff.
  console.log(`${title}: nothing to review — the head carries no changes against the base.`);
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

// A filename derived from both refs, so two different pairs reviewed from
// the same tree can never overwrite one another — see the file header.
const reportBase = `branch__${sanitizeRef(baseRef)}__${sanitizeRef(headDisplay)}`;
const report = reportTargetPaths(REPORT_DIR, reportBase);
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
