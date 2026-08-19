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

import type { CredentialSource } from './settings.js';
import type { Finding, Outcome, Verdict } from './verdict.js';

const HEADING: Record<Outcome, string> = {
  approved: 'Approved',
  rejected: 'Rejected',
  could_not_run: 'Could not run',
};

// Named for a reader, not for the code that produced it. 'via API key' and
// 'via subscription OAuth' are both true, complete sentences fragments once
// appended after 'Judged by N lens(es) from `source`,' - see the attribution
// line below. Never the credential's value: this map's domain is
// CredentialSource, which is a KIND, not a Credential, which would also carry
// the secret - the type itself is what makes a leak here unreachable rather
// than merely avoided.
const CREDENTIAL_LABEL: Record<CredentialSource, string> = {
  'api-key': 'API key',
  'subscription-oauth': 'subscription OAuth',
};

export interface ReportContext {
  /** Where the lens set was read from, so a reader knows whose bar this was. */
  readonly source: string;
  /** What was reviewed. */
  readonly subject: string;
  /**
   * Which credential judged this. Named so a local development run can never
   * be mistaken for a production verdict, and so a CI-versus-local
   * credential mismatch is visible in the report itself rather than assumed
   * from wherever the run happened to be started. Costs one line.
   */
  readonly credentialSource: CredentialSource;
}

/**
 * The process exit code for an outcome.
 *
 * `could_not_run` is **red**. That is the whole point of the third outcome:
 * a review that did not happen must not be reported in the same colour as one
 * that happened and approved. A green badge over a review that never ran is
 * worse than a red one over a review that failed, because nobody investigates
 * green.
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
    lines.push('Every lens reviewed and none had a finding.', '');
  }

  // Whose idea of correct, and how much of it ran. A reader who cannot tell
  // which definition judged a change cannot tell whether the bar moved. Which
  // credential ran it is the same kind of fact, extended: a reader who cannot
  // tell whether this was a paid, production run or a local subscription run
  // cannot tell whether a clean verdict here means what a clean verdict on
  // main means.
  const attribution =
    `Judged by ${verdict.results.length} lens(es) from \`${context.source}\`, ` +
    `via ${CREDENTIAL_LABEL[context.credentialSource]}.`;
  lines.push('---', '', attribution);

  return lines.join('\n');
}
