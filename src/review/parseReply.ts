// Reading a reviewer's reply.
//
// Every ambiguity here resolves to could_not_run, never to approved. That is
// the only safe direction: an unreadable reply that lands as "approved" is a
// green badge over a review that did not happen, and it is indistinguishable
// from a real approval afterwards. An unreadable reply that lands as
// could_not_run is loud, wrong at worst, and fixable.
//
// Four of the refusals below are stricter than they look, and all four are
// deliberate:
//
//   Rejected with no findings is refused. A rejection nobody can act on
//   stalls the change and names nothing to fix.
//   Approved WITH findings is refused. The reviewer said two things; picking
//   one means guessing which, and the guess is invisible in the result.
//   An empty VERDICT: line is refused as an empty line, not reported as an
//   absent one. It was written; saying otherwise is a false statement about
//   the reply in the string a human reads when debugging a red panel.
//   An empty FINDING: line under an approval is refused. This one is here
//   because the code got it wrong first: the marker was dropped, the
//   approved-with-findings guard never fired, and a reviewer that began to
//   name a concern was read as approving cleanly.

import {
  ABSENT_MARKER,
  APPROVED_WORD,
  CANNOT_RUN_WORD,
  EVIDENCE_MARKER,
  FINDING_MARKER,
  REASON_MARKER,
  REJECTED_WORD,
  VERDICT_MARKER,
} from './replyContract.js';
import type { Finding, LensResult } from './verdict.js';

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

/**
 * Findings and the evidence that follows each one, read in one pass.
 *
 * A finding's evidence is the line immediately after it — blank lines are
 * skipped, but the first non-blank line decides, and if that line is not
 * `EVIDENCE:` or `ABSENT:` the finding carries no evidence at all. Generous
 * about formatting (a reviewer's habit of a blank line before the next thing
 * does not cost it its evidence), strict about content: text anywhere else
 * in the reply is never scavenged for a match, because that would let a
 * finding "find" evidence that was never offered for it.
 *
 * An empty summary is handled exactly as it always was — counted, not kept,
 * and never looked ahead for evidence, because there is nothing here for
 * evidence to be evidence OF. What this function does NOT do is decide
 * whether the evidence it read holds up against a diff; that check needs the
 * diff, which a reply's text alone does not carry, and belongs to
 * `verifyFindings.ts`.
 */
function parseFindings(
  lines: readonly string[],
  lens: string,
): { findings: Finding[]; emptyFindings: number } {
  const findings: Finding[] = [];
  let emptyFindings = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (!line.trimStart().startsWith(FINDING_MARKER)) {
      continue;
    }
    const summary = line.trimStart().slice(FINDING_MARKER.length).trim();
    if (summary === '') {
      emptyFindings++;
      continue;
    }

    let evidence: Finding['evidence'];
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j] ?? '';
      if (next.trim() === '') {
        continue;
      }
      const trimmed = next.trimStart();
      if (trimmed.startsWith(EVIDENCE_MARKER)) {
        const text = trimmed.slice(EVIDENCE_MARKER.length).trim();
        if (text !== '') {
          evidence = { kind: 'quote', text };
        }
      } else if (trimmed.startsWith(ABSENT_MARKER)) {
        const text = trimmed.slice(ABSENT_MARKER.length).trim();
        if (text !== '') {
          evidence = { kind: 'absence', text };
        }
      }
      break;
    }

    findings.push(evidence === undefined ? { lens, summary } : { lens, summary, evidence });
  }

  return { findings, emptyFindings };
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
  const { findings, emptyFindings } = parseFindings(lines, lens);

  if (verdict === APPROVED_WORD) {
    if (findings.length > 0) {
      return cannotRun(
        lens,
        `reply said ${APPROVED_WORD} while reporting ${findings.length} finding(s)`,
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
    return { lens, outcome: 'approved', findings: [] };
  }

  if (verdict === REJECTED_WORD) {
    if (findings.length === 0) {
      return cannotRun(
        lens,
        emptyFindings > 0
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

  return cannotRun(lens, `reply carried an unrecognised verdict ${JSON.stringify(verdict)}`);
}
