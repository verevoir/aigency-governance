// Reading a reviewer's reply.
//
// Every ambiguity here resolves to could_not_run, never to approved. That is
// the only safe direction: an unreadable reply that lands as "approved" is a
// green badge over a review that did not happen, and it is indistinguishable
// from a real approval afterwards. An unreadable reply that lands as
// could_not_run is loud, wrong at worst, and fixable.
//
// APPROVED/REJECTED ARE DERIVED FROM BLOCKING FINDINGS, NOT ASKED FOR AS A
// SEPARATE JUDGEMENT. This changed from an earlier version of this file that
// asked a reviewer for two independent assertions — a VERDICT word, and a
// set of severity-tagged findings — and then only CHECKED the two against
// each other, discarding the whole reply as could_not_run on any
// disagreement because there was no principled way to pick a side.
// verevoir/aigency-harness#113 is why that was wrong specifically for the
// approved-with-a-blocking-finding shape: the blast-radius lens returned
// exactly that, reproducibly, and the old code threw away a real, concrete,
// actionable finding because a one-word summary sitting next to it
// disagreed. A blocking finding is evidence — the reviewer wrote a specific
// sentence about a specific problem — and the VERDICT word is a summary of
// the same judgement that can simply be wrong even when the finding is
// right. So now: any blocking finding present means outcome 'rejected',
// full stop, whatever the VERDICT word said, for both APPROVED_WORD and
// REJECTED_WORD replies alike. See the derivation block below.
//
// This is NOT symmetric with the reverse contradiction, and deliberately
// so. A REJECTED_WORD reply with NO blocking finding still refuses (reads
// could_not_run) rather than being silently turned into an approval —
// there the reviewer's own claim has no evidence behind it to derive
// anything FROM. Only a blocking finding is strong enough evidence to
// override a contradicting word; an absence of evidence is not itself
// evidence of the opposite.
//
// The remaining refusals below are stricter than they look, and all are
// deliberate. Two are scoped to severity rather than to any finding at all
// — see replyContract.ts and severityOf() below for what sets it, and
// verdict.ts's aggregate() for what it does to the panel:
//
//   Rejected with no BLOCKING finding is refused. A rejection nobody can act
//   on stalls the change and names nothing to fix, and one made only of
//   smells is not a rejection — it is an approval with notes that used the
//   wrong word. There is no evidence here to derive a rejection FROM, unlike
//   the approved-with-a-blocking-finding case above.
//   Out of scope WITH ANY finding, blocking or not, is refused — kept as a
//   refusal, not a derivation, because out_of_scope is a categorically
//   different claim (this dimension has no material here at all) from
//   approved/rejected, and a stray finding contradicting it is not
//   necessarily the same kind of trustworthy evidence a blocking finding is
//   when the reviewer was actively judging.
//   An empty VERDICT: line is refused as an empty line, not reported as an
//   absent one. It was written; saying otherwise is a false statement about
//   the reply in the string a human reads when debugging a red panel.
//   An empty FINDING: line under an approved or rejected verdict is refused.
//   Its severity cannot be assessed — it might have been a blocking finding
//   that got garbled — so it can be neither derived from nor safely ignored.
//   This is the same defect class the derivation above exists to fix, one
//   step earlier: something a reviewer started to say must not quietly
//   vanish from consideration, in either direction.

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
  // does not (replyContract.ts). Computed once here because the derivation
  // below, and the rejected-with-no-evidence guard beneath it, both need it.
  const blockingFindings = findings.filter((finding) => finding.blocking);

  if (verdict === APPROVED_WORD || verdict === REJECTED_WORD) {
    // THE DERIVATION. See the file header: this is the fix for
    // verevoir/aigency-harness#113. Concrete evidence (a blocking finding)
    // outranks a one-word summary claim, in EITHER direction — an
    // APPROVED_WORD reply carrying a blocking finding derives to rejected
    // exactly the same way a REJECTED_WORD reply carrying one does. This is
    // not a second judgement asked of the reviewer; it is the only judgement
    // that was ever load-bearing, computed once, here.
    if (blockingFindings.length > 0) {
      return { lens, outcome: 'rejected', findings };
    }

    // A garbled FINDING: line with no assessable severity or text. Whether
    // it would have been blocking cannot be known from what is left of it,
    // so — unlike a real blocking finding — it cannot be derived from, and
    // unlike its total absence, it cannot be safely ignored either: the
    // reviewer started to name something. could_not_run is the only shape
    // that does not risk quietly stripping a real defect.
    if (emptyFindings > 0) {
      return cannotRun(
        lens,
        `reply carried ${emptyFindings} empty ${FINDING_MARKER} line(s) — named nothing ` +
          'that could be assessed for severity',
      );
    }

    if (verdict === REJECTED_WORD) {
      // No blocking finding to derive a rejection from, and nothing
      // ambiguous either (handled above) — the reviewer said rejected with
      // no evidence behind it. This is the asymmetric half of the file
      // header's rule: an absence of evidence is not evidence of the
      // opposite, so this refuses rather than being silently turned into an
      // approval.
      return cannotRun(
        lens,
        findings.length > 0
          ? `reply said ${REJECTED_WORD} while naming only non-blocking (${SMELL_TAG}) ` +
              `finding(s); a rejection requires at least one blocking finding`
          : `reply said ${REJECTED_WORD} without naming a finding`,
      );
    }

    // verdict === APPROVED_WORD, no blocking or ambiguous findings: a real
    // approval, possibly carrying smell findings.
    return { lens, outcome: 'approved', findings };
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
    // Still a REFUSAL, not a derivation, unlike APPROVED_WORD/REJECTED_WORD
    // above — see the file header for why: out_of_scope is a categorically
    // different claim from approved/rejected, and a stray finding
    // contradicting "nothing here is in my dimension" is not the same kind
    // of trustworthy evidence a blocking finding is when the reviewer was
    // actively judging the change.
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
