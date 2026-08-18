// Checking a finding against the diff it claims to be about.
//
// A finding that asserts a search cannot be verified by asking the model
// whether it searched — that is the same "look and see" oracle this project
// has already learned not to trust (C1). What CAN be checked mechanically is
// narrower and cheaper: whether the evidence a finding names is actually
// there. The diff a lens reviewed is bytes this process already holds, so a
// quote that is not a substring of it, or an ABSENT claim about text the
// diff plainly contains, is not a judgement call — it is arithmetic.
//
// This does not prove a finding is RIGHT. A finding whose evidence checks out
// can still be a bad reading of good evidence, and that is not this file's
// business. What it rules out is narrower and is the one C2 named: a finding
// that cites a search it did not run, because what it cites is not in the
// material it was given. That is the failure this project has already paid
// for once — a reviewer asserted "grep across the whole source tree finds no
// test file referencing X"; the tests existed, in a file it never opened —
// and C3 records that the layer catching a manufactured finding is
// load-bearing and must be kept. This file is that layer for this panel.
//
// THREE OUTCOMES, NOT TWO — AND WHAT "TRUNCATED" ACTUALLY TURNED OUT TO MEAN.
// The working theory going in was that a citation could be cut short by
// generation stopping mid-quote, and that this would look like "a prefix of
// a real diff line". It cannot: if `text` is a character-exact prefix of
// content that is really in the diff, `text` is thereby already a substring
// of the diff at that same position, so `diff.includes(text)` already
// succeeds — a genuine same-line, same-bytes truncation was never something
// the old check got wrong. Building that check and writing the test for it
// first is what surfaced this: the test failed with `'verified'`, not
// `'truncated'`, on a fixture designed to need the new branch, because the
// new branch was unreachable by construction. That result is kept — see
// `checkEvidence`'s tests — because a mechanism proven to do nothing is worth
// more on the record than one quietly not shipped.
//
// What DOES make a genuine citation fail `diff.includes` is a BYTE
// difference before the match, and the one this project actually hit, twice,
// identically: a sentence a source comment wraps across two physical lines
// (`// ...is\n// covered...`) is quoted by a reviewer the way a person reads
// wrapped prose — joined into one sentence with a space. The diff contains a
// real newline and the next line's `//` there instead of that space, so the
// exact bytes never match, even though every word of the citation is real
// and in order. That is `truncated` here: not shorter, but RESHAPED by a
// source wrap the citation reasonably read through. Reconstructing that
// requires recognising `//` and `#` as single-line comment continuations —
// a narrow, explicit, documented pair, not general comment-syntax awareness
// — and only ever WIDENS what counts as "genuinely there"; it can never let
// truly invented content match, because it only reformats bytes the diff
// already contains, never invents new ones. That keeps the fabrication
// guard intact: a text that matches nothing in the diff, joined or not, is
// unverifiable regardless of what markers surround it.
//
// THE COLLATERAL RULE IS UNCHANGED, ON PURPOSE, ARGUED RATHER THAN ASSUMED.
// A single genuinely `unverifiable` finding — fabricated, or matching
// nothing even in the joined, marker-stripped reading — still withholds
// every OTHER finding in the same lens result, `truncated` and `verified`
// ones included. The case against that: it discards evidence nobody gets to
// weigh, including findings this file has just proven are not fabricated.
// The case for it, and the one this file still comes down on: a reply that
// manufactured one claim has shown it will assert something that is not
// there, and there is no mechanical way to tell that the rest of the SAME
// reply was any more careful — verifying that finding B's quote is a real
// (or genuinely reshaped) substring does not verify that the CLAIM built on
// top of it is sound, and a model that fabricated evidence once has given a
// specific, concrete reason to distrust its judgement elsewhere in that same
// reply, not just its citations. A manufactured finding costs more than a
// missed one — a missed finding leaves the code as it was; a manufactured
// one causes a change that was not needed and a reviewer who trusted it —
// so the asymmetry stays deliberate. What DID change is which findings are
// subject to that asymmetry at all: a `truncated` finding was never accused
// of inventing anything, so it no longer sits in the same bucket as one that
// was.
//
// TWO SUBTLER GAPS FOUND IN THIS FILE'S OWN FIRST VERSION, AND FIXED HERE.
// First: `joinedProse` collapsed whitespace only on the diff side; the
// quote text was compared raw. A genuine citation quoted with a double
// space or a tab where the diff has a single space would fail to match and
// read as `unverifiable` — the exact defect this file exists to prevent,
// in a narrower form, found on a re-read rather than by a second incident.
// Fixed by applying the same whitespace collapse to the quote before
// comparing (`normalizeWhitespace`, applied to both sides). This cannot
// manufacture a match that was not already there: collapsing runs of
// whitespace to one space never changes which non-space characters are
// present or their order, so a fabricated citation still fails to appear
// in `prose` after normalisation, same as before it.
//
// Second: the original comparison required strictly more prose after the
// match (`at + text.length < prose.length`) before calling it `truncated`
// — a leftover from the disproven "cut short" theory, where "something
// must follow" was a sensible check on a citation that stopped mid-
// sentence. Under the reshape explanation that theory was replaced with,
// the classification signal is "found in the joined prose but not in the
// raw diff", which says nothing about what comes after the match. A
// citation of a diff's FINAL sentence is exactly as genuine as one with
// more text following it, and the strict inequality misclassified it as
// `unverifiable` — fabricated — for a reason unconnected to the actual
// question being asked. Dropped, not kept-with-a-reason: no reason for it
// survived the reshape explanation. This does not loosen the fabrication
// guard either — `prose` is built only from bytes the diff already
// contains, reformatted, so text that was never in the diff still does not
// appear in `prose` regardless of where in it a match is sought.
//
// FAILS LOUD, NOT SILENT, for the outcome that remains `unverifiable`. A
// finding that cannot be verified is not dropped — dropping it would let
// the rest of a rejection stand as if nothing in it needed a second look,
// which is a quieter version of the exact defect C2 describes. Instead the
// whole lens result is downgraded to `could_not_run`, the same channel an
// unreadable reply already uses (see `parseReply.ts`), carrying a reason
// that names every finding that failed and what about it did not check
// out. `could_not_run` outranking `rejected` in `aggregate` (verdict.ts) is
// what makes that withholding visible at the level a reader actually looks
// at.
//
// Wired into `runPanel` (panel.ts), the only place that holds both a parsed
// `LensResult` and the `Subject.diff` it was parsed against.

import type { Finding, FindingEvidence, LensResult } from './verdict.js';

const QUOTE_PREVIEW = 80;

function preview(text: string): string {
  return text.length > QUOTE_PREVIEW ? `${text.slice(0, QUOTE_PREVIEW)}…` : text;
}

/** What checking a finding's evidence against the diff established. */
export type EvidenceCheck = 'verified' | 'truncated' | 'unverifiable';

function stripDiffMarker(line: string): string {
  return line.startsWith('+') || line.startsWith('-') || line.startsWith(' ')
    ? line.slice(1)
    : line;
}

// Deliberately narrow: `//` and `#` are the two single-line comment leaders
// common enough, across enough of what this project's own diffs contain, to
// name explicitly, rather than reaching for a general "strip anything that
// looks like a comment" rule that would have to guess. Widening this list is
// a decision to make by finding another real case, the way this pair was —
// not by generalising ahead of one.
const LINE_COMMENT_MARKERS = ['//', '#'];

function stripLineCommentMarker(line: string): string {
  const trimmed = line.trimStart();
  const marker = LINE_COMMENT_MARKERS.find((candidate) => trimmed.startsWith(candidate));
  return marker === undefined ? line : trimmed.slice(marker.length).trimStart();
}

/**
 * Collapse runs of whitespace to one space and trim. Applied to BOTH sides
 * of the truncated-quote comparison — the diff, joined into prose, and the
 * quote itself — so neither side gets normalisation the other does not.
 * See the file header for why applying it only to the diff was a gap.
 */
function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * The diff, read the way a citation quoting its prose would: each content
 * line's leading unified-diff marker and, if present, a single-line comment
 * leader stripped, then every line joined by one space rather than left
 * broken across the newline a source wrap put there. This can only ever
 * reveal bytes the diff already contains in a different arrangement — it
 * strips and rejoins, it never invents.
 */
function joinedProse(diff: string): string {
  return normalizeWhitespace(
    diff.split('\n').map(stripDiffMarker).map(stripLineCommentMarker).join(' '),
  );
}

function checkQuote(text: string, diff: string): EvidenceCheck {
  if (diff.includes(text)) {
    return 'verified';
  }
  // Both sides read the same way — see the file header for why comparing
  // raw quote text against collapsed prose was a gap, and why no
  // requirement that anything follow the match survived the reshape
  // explanation.
  return joinedProse(diff).includes(normalizeWhitespace(text)) ? 'truncated' : 'unverifiable';
}

/**
 * Check one finding's evidence against the diff, three ways. A finding with
 * no evidence at all, or blank evidence text, is `unverifiable` — a bare
 * claim gets no benefit of the doubt, and every string `includes('')`, so an
 * empty quote would otherwise "verify" against any diff at all.
 */
export function checkEvidence(evidence: FindingEvidence | undefined, diff: string): EvidenceCheck {
  if (evidence === undefined || evidence.text.trim() === '') {
    return 'unverifiable';
  }
  if (evidence.kind === 'absence') {
    // An absence claim has no truncated form: "this is not there" is not a
    // quote that can be cited short. It is either genuinely absent
    // (verified) or the diff contains it after all (unverifiable) — checked
    // against the raw diff only, deliberately: the joined-prose reading
    // exists to give a real citation the benefit of a source wrap, not to
    // give an absence claim more ways to be found wrong.
    return diff.includes(evidence.text) ? 'unverifiable' : 'verified';
  }
  return checkQuote(evidence.text, diff);
}

/**
 * Whether one finding's evidence actually holds up against the diff.
 *
 * Kept as a boolean for existing callers: `true` for both `verified` and
 * `truncated`, since both mean the citation is genuine — only
 * `unverifiable` means it is not. Use `checkEvidence` directly where the
 * distinction between "matches outright" and "matches, reshaped by a source
 * wrap" matters.
 */
export function findingIsVerified(finding: Finding, diff: string): boolean {
  return checkEvidence(finding.evidence, diff) !== 'unverifiable';
}

function describeFailure(finding: Finding): string {
  const evidence = finding.evidence;
  if (evidence === undefined) {
    return `${JSON.stringify(finding.summary)} — carried no evidence`;
  }
  return evidence.kind === 'quote'
    ? `${JSON.stringify(finding.summary)} — quoted evidence not found in the diff: ${JSON.stringify(preview(evidence.text))}`
    : `${JSON.stringify(finding.summary)} — claimed absence of ${JSON.stringify(preview(evidence.text))}, which the diff contains`;
}

const TRUNCATION_NOTE =
  'Evidence citation confirmed genuine, reshaped by a source line wrap the diff breaks with a real newline — not invented.';

function flagTruncated(finding: Finding): Finding {
  return {
    ...finding,
    detail:
      finding.detail === undefined ? TRUNCATION_NOTE : `${finding.detail}\n\n${TRUNCATION_NOTE}`,
  };
}

/**
 * Verify a lens's findings against the diff it reviewed.
 *
 * A no-op for `approved` and `could_not_run` — neither carries a claim to
 * check, and this function's only concern is claims. For `rejected`, every
 * finding is checked three ways (see `checkEvidence`):
 *
 *   - If every finding is `verified` or `truncated` — nothing fabricated —
 *     the result stands. `truncated` findings are returned with a note
 *     appended to `detail`, flagging the citation as reshaped rather than
 *     silently treating it the same as an exact match; everything else is
 *     unchanged, and if nothing was `truncated` either, the original result
 *     is returned by reference, exactly as before this file drew the
 *     distinction.
 *   - If any finding is `unverifiable`, the WHOLE result is downgraded to
 *     `could_not_run` — see the file header for why that withholding still
 *     reaches findings that were not themselves accused of anything.
 */
export function verifyLensResult(result: LensResult, diff: string): LensResult {
  if (result.outcome !== 'rejected') {
    return result;
  }

  const checked = result.findings.map((finding) => ({
    finding,
    check: checkEvidence(finding.evidence, diff),
  }));
  const failed = checked.filter((c) => c.check === 'unverifiable');

  if (failed.length > 0) {
    const reason = [
      `${String(failed.length)} of ${String(result.findings.length)} finding(s) did not verify ` +
        'against the diff, so the whole rejection is withheld:',
      ...failed.map((c) => `  - ${describeFailure(c.finding)}`),
    ].join('\n');
    return { lens: result.lens, outcome: 'could_not_run', findings: [], reason };
  }

  const anyTruncated = checked.some((c) => c.check === 'truncated');
  if (!anyTruncated) {
    return result;
  }
  return {
    ...result,
    findings: checked.map((c) => (c.check === 'truncated' ? flagTruncated(c.finding) : c.finding)),
  };
}
