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
  /**
   * The model that was ASKED for. Always known — it is what the caller
   * configured, never learned from a response — so this is required, not
   * optional, unlike `servedModel` below.
   */
  readonly model: string;
  /**
   * The distinct models a response said actually SERVED the panel's calls,
   * if anything in this run identified one. Absent, not defaulted to
   * `model`: a run where nothing said so — no lens's response carried the
   * field, or the composition never captured it — must not be reported as
   * having confirmed agreement it never actually observed. A request
   * silently downgraded is exactly the case this field exists to catch,
   * and it can only catch it by being allowed to disagree with `model`.
   *
   * A non-empty tuple, not a plain array — enforced at the type level so
   * the empty case cannot silently reach the renderer below carrying a
   * meaning ("nothing observed") that omitting the field already carries.
   * One entry means every observed call agreed, reported plainly; more
   * than one means they did not, reported as its own, third, explicitly
   * marked state — see the rendering below for why that marker is needed
   * and what it must stay compatible with.
   */
  readonly servedModel?: ServedModels;
}

/**
 * Every distinct model observed serving a run's calls. Sorted by whoever
 * constructs it (see run.ts) rather than by this module, because the calls
 * this comes from are dispatched concurrently (panel.ts) — arrival order
 * carries no meaning, and a report that varied only by which network
 * response happened to land first would be a smaller version of the exact
 * defect this type replaces.
 */
export type ServedModels = readonly [string, ...string[]];

/**
 * The process exit code for an outcome.
 *
 * Only `approved` is zero. `could_not_run` is red because a review that did
 * not happen must not be reported in the same colour as one that happened and
 * approved — a green badge over a review that never ran is worse than a red
 * one over a review that failed, because nobody investigates green.
 * `out_of_scope` is red too, by an operator decision made once, in a single
 * line inside `aggregate` (verdict.ts) — see the comment there. This function
 * does not encode that decision a second time: it falls out of "only approved
 * is zero" automatically, so flipping that one line is sufficient on its own.
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
  if (grouped.size > 0) {
    lines.push(`### ${verdict.findings.length} finding(s)`, '');
    for (const [lens, findings] of grouped) {
      lines.push(`#### ${lens}`, '');
      for (const finding of findings) {
        lines.push(`- ${finding.summary}`);
        if (finding.detail !== undefined && finding.detail !== '') {
          lines.push(`  ${finding.detail}`);
        }
      }
      lines.push('');
    }
  }

  if (verdict.outcome === 'approved') {
    // Must not overclaim (see the file header): "every lens reviewed" is false
    // the moment one of them reported nothing in scope instead.
    lines.push(
      verdict.outOfScope.length > 0
        ? 'Every lens with something in scope reviewed it and found nothing. See above for the ' +
            'lens(es) that had nothing in scope for this change.'
        : 'Every lens reviewed and none had a finding.',
      '',
    );
  }

  if (verdict.outcome === 'out_of_scope') {
    lines.push(
      'Every lens looked at the whole change and found nothing within its declared scope.',
      'Nothing was evaluated, so this is reported as its own result rather than as an',
      "approval — see verdict.ts's aggregate() for the single line that decides this.",
      '',
    );
  }

  // Whose idea of correct, and how much of it ran. A reader who cannot tell
  // which definition judged a change cannot tell whether the bar moved.
  const attribution = `Judged by ${verdict.results.length} lens(es) from \`${context.source}\`.`;
  lines.push('---', '', attribution);

  // Two fixed-format lines, not folded into the attribution prose above and
  // not phrased differently depending on whether they agree — something
  // downstream (review.yml's own artefact-assembly step, at the time this
  // was written) greps these by exact prefix, the same way "Take the
  // verdict" already greps this file's own heading rather than re-deriving
  // the outcome. A line whose wording depends on its own content would break
  // that the first time the content changed.
  //
  // "Model served" is omitted entirely, not printed as "unknown", when
  // nothing in this run identified one — an absent line and an empty value
  // must not read the same to whatever is parsing this: one means "nothing
  // to report", grep would find nothing to report either way, but the two
  // are worth keeping honestly distinct in the source even though both
  // collapse to "no served model on record" downstream.
  //
  // When something WAS observed, this is still exactly one line, still one
  // backtick-quoted value — checked directly against review.yml's own
  // extraction (`sed -n 's/^Model served: \`\(.*\)\`$/\1/p' | head -n 1`)
  // before choosing this shape, so it keeps working unmodified. Agreement
  // (one distinct value) is printed plainly, as before. Disagreement (more
  // than one) is printed as every distinct value observed, joined inside
  // the same pair of backticks and prefixed `DISAGREED:` — a marker a
  // reader (human, or that same sed line reading the field back out of the
  // artefact) cannot mistake for the name of one unusually-punctuated
  // model. This is the third state the single-slot shape this replaced
  // could not express at all: it could only ever show one value or none.
  lines.push(`Model requested: \`${context.model}\``);
  if (context.servedModel !== undefined) {
    const [first, ...rest] = context.servedModel;
    lines.push(
      rest.length === 0
        ? `Model served: \`${first}\``
        : `Model served: \`DISAGREED: ${[first, ...rest].join(', ')}\``,
    );
  }

  return lines.join('\n');
}
