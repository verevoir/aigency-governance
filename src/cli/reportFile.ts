// Where AIGENCY_REVIEW_REPORT sends the report, and what it sends.
//
// review.ts is kept free of anything a unit test could exercise (see its own
// header) — deciding the two paths, what the JSON sibling holds, and what
// happens when the write fails is not boundary work in that sense: it is a
// decision, and it belongs where a test can drive it directly, against a
// real temporary directory, rather than through a subprocess. The one thing
// that stays genuinely untestable in-process is confirming stdout never
// moves when this is wired in — that is proven end to end, against the real
// compiled binary, in scripts/check-cli.mjs.

import { writeFile } from 'node:fs/promises';

import type { Verdict } from '../review/verdict.js';
import type { ReviewOutcome } from './run.js';

export interface ReportPaths {
  readonly markdown: string;
  readonly json: string;
}

/**
 * The JSON sibling of a markdown path.
 *
 * The rule: the final path segment's extension — the substring after its
 * last `.`, when that `.` is not the segment's first character — is replaced
 * with `json`. A name with no extension (`report`), or a dotfile whose only
 * `.` is its first character (`.review`), gets `.json` appended rather than
 * substituted. Either way the two files can never collide on the same name.
 */
export function reportPaths(markdownPath: string): ReportPaths {
  const slash = markdownPath.lastIndexOf('/');
  const dir = slash === -1 ? '' : markdownPath.slice(0, slash + 1);
  const base = slash === -1 ? markdownPath : markdownPath.slice(slash + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0
    ? { markdown: markdownPath, json: `${markdownPath}.json` }
    : { markdown: markdownPath, json: `${dir}${base.slice(0, dot)}.json` };
}

/**
 * What the JSON sibling holds.
 *
 * A panel that ran gets its Verdict written exactly as `runPanel` produced
 * it — as-is, not reshaped, because a shaped form is a second definition of
 * what the panel found, and the two definitions drift the day a field is
 * added to one and not the other.
 *
 * A panel that did not run has no Verdict to be honest about — see the
 * comment on `ReviewOutcome.verdict` in run.ts — so this is not a fabricated
 * empty one. `{ ran: false, report }` is a distinct, recognisable shape: a
 * missing file, an empty file and "no panel ran, here is why" read as three
 * different things to whoever finds this file, and only the third is
 * distinguishable from this writer having a bug.
 */
export type ReportJson = Verdict | { readonly ran: false; readonly report: string };

export function reportJson(outcome: ReviewOutcome): ReportJson {
  return outcome.verdict ?? { ran: false, report: outcome.report };
}

/**
 * Writes both files for a run. Real fs, not injected: this is the one
 * genuinely boundary-shaped piece here, and its failures are deterministic
 * enough — ENOENT for a missing directory, EISDIR for a path that is one —
 * to test directly against a real temporary directory rather than a fake.
 */
export async function writeReportFiles(
  markdownPath: string,
  outcome: ReviewOutcome,
): Promise<void> {
  const paths = reportPaths(markdownPath);
  await writeFile(paths.markdown, `${outcome.report}\n`, 'utf8');
  await writeFile(paths.json, `${JSON.stringify(reportJson(outcome), null, 2)}\n`, 'utf8');
}

export interface ReportFileOutcome {
  readonly exitCode: number;
  /** Set only when the write itself failed. Not a verdict about the change —
   * the wording matches review.ts's own boundary-failure text, and for the
   * same reason: a caller must not read a runner problem as a judgement
   * about the code. */
  readonly failureMessage?: string;
}

/**
 * Decides what AIGENCY_REVIEW_REPORT changes about the exit code.
 *
 * Unset, or present and blank — blank counts as unset here the same way it
 * does for every other setting in this system, since an empty string is
 * exactly what an unset GitHub Actions variable interpolates to: the
 * outcome's own exit code, untouched. This is the overwhelmingly common case
 * and it must stay silent — no write attempted, nothing to fail.
 *
 * Set, and the write succeeds: still the outcome's own exit code. The files
 * existing changes nothing about whether the change passed review.
 *
 * Set, and the write fails: exit 1, always — even overriding a genuine
 * approval's 0. The caller asked for the report to land somewhere and it did
 * not, so whatever the panel decided is now unreadable; a green build for a
 * review nobody can read is worse than a red one that says why. This is the
 * one asymmetric case, and the message says plainly that it is a runner
 * defect and not a judgement about the change, so nobody mistakes the two.
 */
export async function withReportFile(
  reportPath: string | undefined,
  outcome: ReviewOutcome,
): Promise<ReportFileOutcome> {
  if (reportPath === undefined || reportPath.trim() === '') {
    return { exitCode: outcome.exitCode };
  }
  try {
    await writeReportFiles(reportPath, outcome);
    return { exitCode: outcome.exitCode };
  } catch (cause) {
    return {
      exitCode: 1,
      failureMessage:
        `Could not write the report to ${reportPath}: ` +
        `${cause instanceof Error ? cause.message : String(cause)}\n\n` +
        'This is a defect in the runner, not a verdict about the change.',
    };
  }
}
