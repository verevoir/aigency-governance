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
// AND ALL THREE ARE ALSO POSITIONAL ARGUMENTS: `node review-branch.mjs
// [base] [head] [cap]`. PRECEDENCE IS POSITIONAL, THEN ENVIRONMENT, THEN
// DEFAULT, in that order, for each of the three independently — the cap
// follows the same rule as the two refs, for the same reason. Positional
// wins because it is the one channel that can carry a VALUE into a declared
// command in aigency.json: a declared command's argv is fixed at the moment
// it is written into the declaration; a declared `env` block, if any, can
// only forward a variable already sitting in the process that started the
// belt, by name — it cannot set one (checked directly, the hard way, by
// trying to declare one here first). So a base, head or cap a declared step
// needs to name can only reach it through argv, which is why positional
// comes first for all three. AIGENCY_REVIEW_BRANCH_BASE/_HEAD/_MAX_CHARS
// remain real and still work for a human invoking this script directly
// from a shell, which is why environment stays beneath positional rather
// than being removed.
//
// AN EMPTY OR WHITESPACE-ONLY POSITIONAL ARGUMENT IS TREATED AS ABSENT, the
// same way an empty environment variable already is (see `present`, used
// for all three: base, head and cap) — it falls through to the next
// precedence level rather than pinning a ref to the empty string, or the
// cap to a value that would parse as zero, either of which the checks
// below would otherwise have to refuse.
//
// MORE THAN THREE POSITIONAL ARGUMENTS IS REFUSED, by count alone, before
// any of base, head or cap is looked at: a fourth position has nothing
// declared to mean, and silently ignoring it would hide a caller's mistake
// rather than name it.
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
// THE CAP: AIGENCY_REVIEW_BRANCH_MAX_CHARS, or the third positional
// argument, optional, defaulting to 200,000 characters — same precedence as
// the two refs: positional wins, then environment, then default. A
// present-but-invalid value, from whichever source supplied it, is refused
// by name before anything is measured or spawned — the same shape
// AIGENCY_REVIEW_MAX_TOKENS already uses in settings.ts, chosen over
// provision.ts's fully-required `maxChars` because this arrives from
// outside the process, not a function parameter a caller already has in
// hand and has already had to think about. The default is a starting
// estimate, not a measured one: roughly 50,000 tokens at ~4 characters per
// token, leaving the bulk of a 200,000-token context window free for the
// system prompt, the lens definitions and the completion budget even before
// margin. The first real subject run against it — a four-story stack,
// 448,103 characters — refused at 2.24x the cap, which confirmed the grain
// was wrong (a whole stack was never a reviewable subject) rather than the
// cap being far off. That is the finding AIGENCY_REVIEW_BRANCH_BASE/_HEAD
// exist to act on, by making a single pull request's own pair of refs
// nameable instead of reviewing everything at once. The positional cap
// exists for the same reason the positional refs do: a declared step's
// argv is the one channel that can carry a value at all, and a one-off
// raise for one over-sized pull request belongs in that declaration,
// visible, rather than in this default.
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

/** Whether `ref` names something in this repository, and — when it does
 * not — whether that is because it genuinely does not exist or because git
 * failed for some other reason. Used only to decide whether to refuse and
 * what to say; never to learn anything else about the ref.
 *
 * `git rev-parse --verify --quiet` suppresses its own error message for the
 * ordinary "this does not resolve" case, so an empty stderr on a non-zero
 * exit really does mean absent. Anything else on stderr — a corrupt
 * repository, a permission error, whatever git actually said — is a
 * different problem, and is carried through as `detail` rather than
 * discarded, so it does not get reported identically to a plain absent ref
 * (a review found exactly that collapse in an earlier version of this
 * function). */
async function checkRef(ref) {
  const result = await capture('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  if (result.code === 0) {
    return { exists: true };
  }
  const stderr = result.err.trim();
  return { exists: false, detail: stderr === '' ? undefined : stderr };
}

const DEFAULT_MAX_CHARS = 200_000;

// Positional argv, if present, wins over environment — see the file header
// for why positional comes first, for all three positions, and what an
// empty, missing or extra argument means.
const positionalArgs = process.argv.slice(2);
if (positionalArgs.length > 3) {
  console.error(
    `at most three positional arguments are accepted (base, head, cap); got ${String(positionalArgs.length)}: ` +
      positionalArgs.map((arg) => JSON.stringify(arg)).join(', '),
  );
  process.exit(1);
}
const baseArg = present(positionalArgs[0]);
const headArg = present(positionalArgs[1]);
const capArg = present(positionalArgs[2]);

// Parsed before anything else runs, including before git is touched — an
// invalid cap is a configuration mistake, not a fact about this branch, and
// should fail exactly as fast as a bad AIGENCY_REVIEW_MAX_TOKENS does. Same
// precedence as the two refs below: the positional argument, if present, is
// validated in preference to the environment variable, and whichever one
// supplied the raw value is named in the refusal.
let maxChars = DEFAULT_MAX_CHARS;
const rawCap = capArg ?? present(process.env['AIGENCY_REVIEW_BRANCH_MAX_CHARS']);
const rawCapSource =
  capArg !== undefined ? 'the third positional argument (cap)' : 'AIGENCY_REVIEW_BRANCH_MAX_CHARS';
if (rawCap !== undefined) {
  const parsed = Number(rawCap);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    console.error(`${rawCapSource} must be a positive whole number, got ${JSON.stringify(rawCap)}`);
    process.exit(1);
  }
  maxChars = parsed;
}

const baseRefRaw = baseArg ?? present(process.env['AIGENCY_REVIEW_BRANCH_BASE']);
const baseRef = baseRefRaw ?? 'main';
const headRefRaw = headArg ?? present(process.env['AIGENCY_REVIEW_BRANCH_HEAD']);
const headRef = headRefRaw ?? 'HEAD';

// Both checked, and both named if both are wrong — see the file header.
// This is the only git this script runs before knowing the two refs are
// real; everything that follows (the diff itself, the reviewer) is real
// spend or real measurement, and neither happens until this passes.
function refProblem(kind, ref, check) {
  if (check.exists) {
    return undefined;
  }
  return check.detail === undefined
    ? `the ${kind} ref, ${JSON.stringify(ref)}, does not exist in this repository`
    : `the ${kind} ref, ${JSON.stringify(ref)}, could not be resolved: ${check.detail}`;
}

const refProblems = [];
const baseProblem = refProblem('base', baseRef, await checkRef(baseRef));
if (baseProblem !== undefined) {
  refProblems.push(baseProblem);
}
const headProblem = refProblem('head', headRef, await checkRef(headRef));
if (headProblem !== undefined) {
  refProblems.push(headProblem);
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
  // Raised from 16384 after two separate real runs hit the identical
  // failure — a reply that was one thinking block, no text at all,
  // stop_reason max_tokens — on two different lenses (honesty, then
  // correctness), on two differently-sized diffs (303,719 characters, then
  // ~155,000). A reply that spends its whole budget thinking and returns
  // nothing is indistinguishable from one that had nothing to say, and that
  // is exactly the failure this number exists to prevent.
  //
  // Both failures exhausted the budget completely rather than running out
  // near the end of a reply, so neither one carries evidence of how close
  // it came — a truncated-mid-output failure would say "nearly enough";
  // this says nothing about the size of the gap. Doubling assumes a small
  // gap and there is no evidence here that it is small, so this raises
  // further: 65536, four times the original 16384. The basis for that
  // specific number is the diff itself — the largest diff this script will
  // ever hand a lens, under its own default 200,000-character cap, is
  // roughly 50,000 tokens of raw content, and a thorough lens plausibly
  // reasons in a similar order of magnitude before writing anything down.
  // 65536 gives real headroom above that, not just a small margin past two
  // exhausted runs.
  //
  // If this still exhausts at this size, that stops looking like a budget
  // problem and starts looking like something else — a model that thinks
  // in proportion to prompt complexity regardless of the ceiling offered,
  // which a bigger ceiling cannot fix and only an explicit thinking-budget
  // parameter would.
  AIGENCY_REVIEW_MAX_TOKENS: '65536',
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
