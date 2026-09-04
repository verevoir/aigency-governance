// Reading a reviewer's reply.
//
// Every ambiguity here resolves to could_not_run, never to approved. That is
// the only safe direction: an unreadable reply that lands as "approved" is a
// green badge over a review that did not happen, and it is indistinguishable
// from a real approval afterwards. An unreadable reply that lands as
// could_not_run is loud, wrong at worst, and fixable.
//
// Five of the refusals below are stricter than they look, and all five are
// deliberate. Two of them are now scoped to severity rather than to any
// finding at all — see replyContract.ts and severityOf() below for what sets
// it, and verdict.ts's aggregate() for what it does to the panel:
//
//   Rejected with no BLOCKING finding is refused. A rejection nobody can act
//   on stalls the change and names nothing to fix, and one made only of
//   smells is not a rejection — it is an approval with notes that used the
//   wrong word.
//   Approved carrying a BLOCKING finding is refused. The reviewer said two
//   things; picking one means guessing which, and the guess is invisible in
//   the result. A SMELL finding is not this contradiction: approved may carry
//   any number of those.
//   Out of scope WITH ANY finding, blocking or not, is refused for the same
//   reason: a lens that says its dimension has nothing to attach to and then
//   names something wrong said two contradictory things, not one.
//   An empty VERDICT: line is refused as an empty line, not reported as an
//   absent one. It was written; saying otherwise is a false statement about
//   the reply in the string a human reads when debugging a red panel.
//   An empty FINDING: line under an approval is refused. This one is here
//   because the code got it wrong first: the marker was dropped, the
//   approved-with-a-blocking-finding guard never fired, and a reviewer that
//   began to name a concern was read as approving cleanly.

import {
  APPROVED_WORD,
  BLOCKING_TAG,
  CANNOT_RUN_WORD,
  FINDING_MARKER,
  OUT_OF_SCOPE_WORD,
  REASON_MARKER,
  REJECTED_WORD,
  SMELL_TAG,
  VERDICT_MARKER,
} from './replyContract.js';
import type { Finding, LensResult } from './verdict.js';

// Matches a severity tag at the start of a finding line, once the FINDING:
// marker itself has already been stripped. Built from the same constants the
// prompt advertises — replyContract.ts's drift pair, one level deeper.
const SEVERITY_TAG = new RegExp(`^\\[(${BLOCKING_TAG}|${SMELL_TAG})\\]\\s*`, 'i');

/**
 * Split a finding line into its severity and its text.
 *
 * Fails closed: no tag, or a tag this pattern does not recognise, reads as
 * ${BLOCKING_TAG} rather than as absent or as non-blocking. Severity is
 * written by the reviewer, never inferred — an unlabelled concern does not
 * get to be smaller than one that was labelled, and a typo in the bracket
 * must not quietly downgrade a real finding.
 *
 * NAMED LIMITATION (found by this PR's own self-review, failure-modes
 * lens): an absent tag and a malformed one (`[minor]`, `[blcoking]`) both
 * land here as identical `blocking: true` findings, with no structured
 * signal that the tag was unrecognised rather than never written — only
 * the raw bracket text surviving inside `summary` hints at it. Elsewhere
 * this codebase is careful to keep "absent" and "malformed" as distinct,
 * explicitly-named reasons (see this file's header on the empty-VERDICT-
 * line guard). Not fixed here: no information is lost (the raw text is
 * preserved) and the fail-closed direction is the safe one either way, so
 * this is recorded as a real, accepted gap rather than built around.
 */
function severityOf(lens: string, raw: string): Finding {
  const match = SEVERITY_TAG.exec(raw);
  if (match === null) {
    return { lens, summary: raw, blocking: true };
  }
  return {
    lens,
    summary: raw.slice(match[0].length).trim(),
    blocking: match[1]?.toLowerCase() === BLOCKING_TAG,
  };
}

/**
 * Every line carrying this marker, with the marker stripped — **including the
 * ones that carried nothing after it.**
 *
 * Dropping empties here is what this function used to do, and it was wrong in
 * a way worth recording: it reported "no such line" where the truth was "the
 * line was there and said nothing", and the three call sites below want
 * different things from that distinction. One of them wanted it badly enough
 * that the old behaviour returned `approved` for a reply that had started to
 * name a concern and produced a bare marker — the exact green-over-nothing
 * this file's header says is impossible. The helper no longer decides; each
 * call site does, in the open.
 */
function taggedLines(lines: readonly string[], marker: string): string[] {
  return lines
    .filter((line) => line.trimStart().startsWith(marker))
    .map((line) => line.trimStart().slice(marker.length).trim());
}

function cannotRun(lens: string, reason: string): LensResult {
  return { lens, outcome: 'could_not_run', findings: [], reason };
}

// Structurally identical to cannotRun, and deliberately a separate function
// rather than a shared helper with a parameter: the two outcomes read the
// same reply shape (a word, then a REASON: line) but mean different things —
// see replyContract.ts's header — and a caller here should never have to
// pass an outcome literal to get the right one.
function outOfScope(lens: string, reason: string): LensResult {
  return { lens, outcome: 'out_of_scope', findings: [], reason };
}

/**
 * Turn a reviewer's reply into a result for one lens. Never throws: a lens
 * that cannot be read is a lens that did not review, which the aggregate
 * already knows how to hold.
 */
export function parseReply(lens: string, text: string): LensResult {
  if (text.trim() === '') {
    return cannotRun(lens, 'reply was empty');
  }

  const lines = text.split('\n');
  const verdicts = taggedLines(lines, VERDICT_MARKER);

  if (verdicts.length === 0) {
    return cannotRun(lens, `reply carried no ${VERDICT_MARKER} line`);
  }
  // Not "take the last one". Two verdict lines means the reviewer said two
  // things, and every rule for choosing between them is a guess that would
  // not appear anywhere in the result. An empty marker counts as one of them:
  // it is a line the reviewer wrote, and treating it as absent is how the old
  // helper made "carried no VERDICT line" a false statement about a reply
  // that carried one.
  if (verdicts.length > 1) {
    return cannotRun(lens, `reply carried ${verdicts.length} ${VERDICT_MARKER} lines`);
  }

  const verdict = verdicts[0]?.toLowerCase() ?? '';
  if (verdict === '') {
    return cannotRun(lens, `reply carried an empty ${VERDICT_MARKER} line`);
  }

  // Kept apart because they mean different things. A named finding is
  // information; an empty marker is a reviewer that was about to say
  // something. Neither may be read as silence.
  const findingLines = taggedLines(lines, FINDING_MARKER);
  // A line that is a severity tag and nothing else — `FINDING: [blocking]`
  // with no text following — must count as EMPTY, the same as a bare
  // `FINDING:` marker. Filtering on `raw !== ''` alone missed this: the raw
  // text ("[blocking]") is not empty, only what remains after severityOf()
  // strips the tag is. Left unfixed, this manufactured a real finding with
  // an empty summary — a blocking verdict with nothing in it for an author
  // to act on, this project's own signature defect (something absent
  // reading as present) wearing new clothes. So the empty check runs AFTER
  // severityOf, on the summary it actually produced, not on the pre-strip
  // line.
  const findings: Finding[] = findingLines
    .filter((raw) => raw !== '')
    .map((raw) => severityOf(lens, raw))
    .filter((finding) => finding.summary !== '');
  const emptyFindings = findingLines.length - findings.length;
  // Severity-weighted: a BLOCKING finding sinks a verdict, a SMELL finding
  // does not (replyContract.ts). Computed once here because both guards
  // below need it, in opposite directions — approved refuses this being
  // non-empty, rejected requires it.
  const blockingFindings = findings.filter((finding) => finding.blocking);

  if (verdict === APPROVED_WORD) {
    if (blockingFindings.length > 0) {
      return cannotRun(
        lens,
        `reply said ${APPROVED_WORD} while reporting ${blockingFindings.length} blocking finding(s)`,
      );
    }
    // The path the old code got wrong. A bare marker under an approval is not
    // a clean approval; it is the one shape where "I could not tell" is the
    // only honest reading.
    if (emptyFindings > 0) {
      return cannotRun(
        lens,
        `reply said ${APPROVED_WORD} with ${emptyFindings} empty ${FINDING_MARKER} line(s)`,
      );
    }
    // Smell findings, if any, ride along — an approval is not required to have
    // nothing to say, only nothing that blocks.
    return { lens, outcome: 'approved', findings };
  }

  if (verdict === REJECTED_WORD) {
    if (blockingFindings.length === 0) {
      return cannotRun(
        lens,
        findings.length > 0
          ? `reply said ${REJECTED_WORD} while naming only non-blocking (${SMELL_TAG}) ` +
              `finding(s); a rejection requires at least one blocking finding`
          : emptyFindings > 0
            ? `reply said ${REJECTED_WORD} with ${emptyFindings} empty ${FINDING_MARKER} line(s) and named nothing`
            : `reply said ${REJECTED_WORD} without naming a finding`,
      );
    }
    return { lens, outcome: 'rejected', findings };
  }

  if (verdict === CANNOT_RUN_WORD) {
    const reasons = taggedLines(lines, REASON_MARKER).filter((reason) => reason !== '');
    return cannotRun(lens, reasons[0] ?? 'reviewer gave no reason');
  }

  if (verdict === OUT_OF_SCOPE_WORD) {
    // Read only when the reviewer wrote exactly this word — matching how
    // CANNOT_RUN_WORD is read just above. Neither is this parser's default
    // for an ambiguous reply; every ambiguity still resolves to could_not_run,
    // per the file header. This is the model's own explicit, honest signal.
    //
    // Mirrors the APPROVED_WORD guard above: a reply declaring out_of_scope
    // while also naming findings said two contradictory things, and the
    // contradiction must be surfaced, not silently resolved by keeping one
    // half (the verdict) and dropping the other (the findings).
    //
    // What this does NOT do, deliberately: preserve those findings anywhere
    // in the returned result. Discarding them here is the same gap
    // `cannotRun()` above has always had — a lens that DID produce findings
    // and then wrote a contradictory or unreadable verdict has never had
    // those findings survive parseReply, on any verdict word, and that is
    // tracked as verevoir/aigency-rebuild#H099. This branch is structurally
    // new; the hole it inherits is not. A fix that preserves findings across
    // a malformed verdict is a real behaviour change, belongs to H099's
    // actual remedy, applies equally to CANNOT_RUN_WORD above, and is out of
    // scope for this PR, which surfaces the contradiction rather than
    // resolving what to do with the findings it names.
    if (findings.length > 0) {
      return cannotRun(
        lens,
        `reply said ${OUT_OF_SCOPE_WORD} while reporting ${findings.length} finding(s)`,
      );
    }
    const reasons = taggedLines(lines, REASON_MARKER).filter((reason) => reason !== '');
    return outOfScope(lens, reasons[0] ?? 'reviewer gave no reason');
  }

  return cannotRun(lens, `reply carried an unrecognised verdict ${JSON.stringify(verdict)}`);
}
