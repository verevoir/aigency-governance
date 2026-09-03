// Turning a verdict into something a person reads.
//
// Two rules shape this, and both come from the same place — a report is the
// only part of a review most people will ever see, so anything it fails to
// say is, in practice, not true.
//
//   The outcome is stated in the first line, in words. A reader who stops
//   there must not be able to come away with the wrong impression.
//   Lenses that did NOT run are reported BEFORE findings. An incomplete
//   review is a verdict that is not a verdict, and burying that under a list
//   of findings invites exactly the reading where the findings get addressed
//   and the gap does not.

import type { Finding, Outcome, Verdict } from './verdict.js';

// `out_of_scope` stays in this map because `Outcome` is shared with
// LensResult (a single lens can still land there — see verdict.ts's
// `outOfScope`), and the map must stay total over the type. aggregate() no
// longer selects it as the PANEL's own outcome for any input: an
// all-out_of_scope panel now reads as approved (verdict.ts), so this entry
// is unreachable from `renderReport`'s own `verdict.outcome` today. Left in
// rather than deleted, because narrowing the map's key type to exclude it
// would be a bigger, separate change for no behaviour this file needs.
const HEADING: Record<Outcome, string> = {
  approved: 'Approved',
  rejected: 'Rejected',
  could_not_run: 'Could not run',
  out_of_scope: 'Nothing in scope',
};

export interface ReportContext {
  /** Where the lens set was read from, so a reader knows whose bar this was. */
  readonly source: string;
  /** What was reviewed. */
  readonly subject: string;
}

/**
 * The process exit code for an outcome.
 *
 * Only `approved` is zero. `could_not_run` is red because a review that did
 * not happen must not be reported in the same colour as one that happened and
 * approved — a green badge over a review that never ran is worse than a red
 * one over a review that failed, because nobody investigates green.
 * `out_of_scope` is likewise non-zero, though `aggregate` (verdict.ts) no
 * longer produces it as a PANEL's own outcome for any input — an
 * all-out_of_scope panel reads as `approved` now. Kept here rather than
 * dropped: this function does not know that, and should not need to; if a
 * future `aggregate` ever hands back `out_of_scope` again, this still gives
 * the right, non-zero answer without anyone having to remember to update it.
 */
export function exitCodeFor(outcome: Outcome): number {
  return outcome === 'approved' ? 0 : 1;
}

function findingsByLens(findings: readonly Finding[]): Map<string, Finding[]> {
  const grouped = new Map<string, Finding[]>();
  for (const finding of findings) {
    const existing = grouped.get(finding.lens);
    if (existing === undefined) {
      grouped.set(finding.lens, [finding]);
    } else {
      existing.push(finding);
    }
  }
  return grouped;
}

export function renderReport(verdict: Verdict, context: ReportContext): string {
  const lines: string[] = [
    `## Review: ${HEADING[verdict.outcome]}`,
    '',
    `**${context.subject}**`,
    '',
  ];

  // First, because it is the thing that invalidates everything below it.
  if (verdict.unran.length > 0) {
    lines.push(
      `### ${verdict.unran.length} of ${verdict.results.length} lenses did not review`,
      '',
      'This review is incomplete. The findings below are what the lenses that did run',
      'happened to see; they are not the whole of what is there.',
      '',
    );
    for (const { lens, reason } of verdict.unran) {
      lines.push(`- **${lens}** — ${reason}`);
    }
    lines.push('');
  }

  // Also before findings, so a lens that opts out does so visibly rather than
  // silently — same placement rule as `unran`, above, and the same reason.
  // Unlike `unran`, this is not an incomplete review: each of these lenses
  // looked at the whole change and reported, correctly, that its dimension
  // had nothing to attach to.
  if (verdict.outOfScope.length > 0) {
    lines.push(
      `### ${verdict.outOfScope.length} of ${verdict.results.length} lens(es) had nothing in scope`,
      '',
      'A completed judgement, not an incomplete one: each lens below reviewed the whole',
      'change and found nothing within its own declared dimension.',
      '',
    );
    for (const { lens, reason } of verdict.outOfScope) {
      lines.push(`- **${lens}** — ${reason}`);
    }
    lines.push('');
  }

  const grouped = findingsByLens(verdict.findings);
  const blockingCount = verdict.findings.filter((finding) => finding.blocking).length;
  const smellCount = verdict.findings.length - blockingCount;
  if (grouped.size > 0) {
    // The severity split is stated in the heading, not left to be counted from
    // the tags below, whenever at least one finding is non-blocking
    // (smellCount > 0) — including an approval whose findings are ENTIRELY
    // smells, where it reads "(0 blocking, N non-blocking)" and tells a
    // reader who stops at the heading that nothing here held the approval
    // up. Omitted only when every finding shares blocking's severity
    // (smellCount === 0): a rejected panel made only of blocking findings
    // has nothing to split.
    lines.push(
      `### ${verdict.findings.length} finding(s)` +
        (smellCount > 0 ? ` (${blockingCount} blocking, ${smellCount} non-blocking)` : ''),
      '',
    );
    for (const [lens, findings] of grouped) {
      lines.push(`#### ${lens}`, '');
      for (const finding of findings) {
        // Reported loudly regardless of severity (constraint: a non-blocking
        // finding must still be SEEN). The tag is what a reader uses to tell
        // "fix this" from "worth a look" — a finding rendered with no severity
        // at all would be the exact blindness a smell-vs-blocking split exists
        // to avoid re-introducing.
        lines.push(`- [${finding.blocking ? 'blocking' : 'smell'}] ${finding.summary}`);
        if (finding.detail !== undefined && finding.detail !== '') {
          lines.push(`  ${finding.detail}`);
        }
      }
      lines.push('');
    }
  }

  if (verdict.outcome === 'approved') {
    const allOutOfScope =
      verdict.outOfScope.length > 0 && verdict.outOfScope.length === verdict.results.length;
    // Must not overclaim (see the file header): "every lens reviewed" is false
    // the moment one of them reported nothing in scope instead, and "every
    // lens with something in scope reviewed it" is a vacuous, misleading
    // thing to say when NO lens had anything in scope — that case gets its
    // own sentence rather than reusing the partial-out-of-scope one.
    const base = allOutOfScope
      ? "Nothing in this change was within any lens's declared scope. Each lens reviewed the " +
        'whole change and completed its judgement; none had anything to evaluate. See above for ' +
        'the reason each lens gave.'
      : verdict.outOfScope.length > 0
        ? 'Every lens with something in scope reviewed it and found nothing. See above for the ' +
          'lens(es) that had nothing in scope for this change.'
        : 'Every lens reviewed and none had a finding.';
    // The severity split again, in prose this time: an approval that carries
    // smell findings must not read as silent — a reader who reads only the
    // first line must not come away thinking nothing at all was found.
    // Carry-forward: a smell that survives to merge must not simply vanish
    // once this pull request stops being a place anyone looks. This report
    // cannot file the follow-up itself — nothing in this system has a
    // create-an-issue capability — so it names the step in words, using the
    // `owner/repo#123` format this codebase already uses elsewhere in
    // comments (verdict.ts, parseReply.ts) to CITE an already-filed issue.
    // That is not quite the same thing as this: those are references to
    // issues that already exist; this is the first place asking that one be
    // filed. Named honestly as borrowing a format, not as an established
    // workflow this project already follows for filing review follow-ups.
    // Either way it is a real, named gap: whoever merges must actually open
    // the issue by hand, and a merge that skips this step loses the finding
    // for real.
    const suffix =
      smellCount > 0
        ? ` ${smellCount} non-blocking finding(s) are listed above; none of them held this up. ` +
          'If this merges as-is, file each as a follow-up issue before merging, referenced ' +
          'as `owner/repo#123` — the tracked-reference format this codebase already uses ' +
          'elsewhere (see verdict.ts, parseReply.ts), used here for the first time to ask ' +
          'that an issue actually be filed rather than merely cited.'
        : '';
    lines.push(base + suffix, '');
  }

  // Whose idea of correct, and how much of it ran. A reader who cannot tell
  // which definition judged a change cannot tell whether the bar moved.
  const attribution = `Judged by ${verdict.results.length} lens(es) from \`${context.source}\`.`;
  lines.push('---', '', attribution);

  return lines.join('\n');
}
