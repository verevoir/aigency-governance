// The whole review, composed — every step from an environment to an exit code.
//
// Deliberately not the binary. Reading argv, touching stdin and calling
// process.exit belong at the process boundary; everything that DECIDES
// anything lives here, where a test can drive it with fakes and no network.
// The binary that wraps this should be short enough to read in one go, and
// should contain no branch that is not visible from here.
//
// The order below is not arbitrary. Each step is a gate on the next, and each
// failure costs money if it is checked late: a missing key discovered after
// five model calls has already been paid for. So configuration is settled
// first, then the definition is fetched, and only then does anything reach a
// provider.

import { loadLensSet } from '../review/load.js';
import { runPanel } from '../review/panel.js';
import type { Reviewer } from '../review/panel.js';
import type { Subject } from '../review/prompt.js';
import { exitCodeFor, renderReport } from '../review/report.js';
import type { SourceReader } from '../review/load.js';
import {
  renderMissing,
  resolveSettings,
  type KeyFileReader,
  type ReviewSettings,
} from '../review/settings.js';

export interface ReviewDeps {
  /** How the lens set is fetched. */
  readonly read: SourceReader;
  /** How one lens is reviewed. */
  readonly review: Reviewer;
  /** The bar, if the composition could fetch one. */
  readonly practices?: string;
}

export interface ReviewOutcome {
  readonly report: string;
  /** 0 only for an approval. Everything else, including "could not run", is red. */
  readonly exitCode: number;
  /**
   * Non-blocking facts `resolveSettings` found while still reaching `ready`
   * — see `ReviewSettings.warnings`'s own doc comment. Absent, never an
   * empty array, when there is nothing to say. Not part of `report`: the
   * report is what a reviewer judges the change against, and a warning
   * about this repository's OWN configuration is not a fact about the
   * change under review — it belongs at the process boundary (stderr),
   * which is where `review.ts` sends it.
   */
  readonly warnings?: readonly string[];
}

/**
 * The default when no reader is supplied: every path is absent, so
 * `resolveSettings` behaves exactly as it did before the file source
 * existed, and this module never touches a real filesystem unless the process
 * boundary explicitly hands it one. The real implementation, `keyFileReader`
 * in readers.ts, is what review.ts actually wires — matching how `wired.read`
 * for the lens set is constructed there rather than here.
 */
const noKeyFile: KeyFileReader = () => Promise.resolve({ kind: 'absent' });

function couldNotRun(
  subject: string,
  source: string,
  reason: string,
  warnings?: readonly string[],
): ReviewOutcome {
  return {
    report: [
      '## Review: Could not run',
      '',
      `**${subject}**`,
      '',
      reason,
      '',
      'Nothing was reviewed. This is a red result and not a passing one — a green',
      'badge over a review that never ran is worse than a red one over a review',
      'that failed, because nobody investigates green.',
      '',
      '---',
      '',
      `Lens set: \`${source}\`.`,
    ].join('\n'),
    exitCode: 1,
    ...(warnings !== undefined ? { warnings } : {}),
  };
}

/**
 * Run a review.
 *
 * `deps` is a factory rather than a value because the reviewer needs the
 * settings — specifically the key — and the settings are not known until this
 * function has resolved them. Taking a ready-made reviewer would mean the
 * caller resolving settings too, in a second place, which is where the two
 * would drift.
 *
 * It is also what makes the most important assertion in the suite possible:
 * the factory is not called at all when the configuration is incomplete, so a
 * run that cannot be configured cannot spend money.
 */
export async function runReview(
  env: Record<string, string | undefined>,
  subject: Subject,
  deps: (settings: ReviewSettings) => ReviewDeps,
  readKeyFile: KeyFileReader = noKeyFile,
): Promise<ReviewOutcome> {
  const resolved = await resolveSettings(env, readKeyFile);

  if (resolved.kind === 'incomplete') {
    return { report: renderMissing(resolved.missing, resolved.problems), exitCode: 1 };
  }
  if (resolved.kind === 'invalid') {
    return {
      report: [
        'The review could not run: the configuration is present and wrong.',
        '',
        ...resolved.problems.map((problem) => `  ${problem}`),
        '',
        'This is a red result, not a passing one. Nothing was reviewed.',
      ].join('\n'),
      exitCode: 1,
    };
  }

  const { settings } = resolved;

  // Nothing to review is not the same as nothing wrong with it. A workflow
  // that computed its diff against the wrong base, or cloned shallowly, hands
  // this an empty string — and five lenses would each read it, find nothing,
  // and approve. That is the most likely way this stops working without
  // anybody noticing, so it is checked here rather than trusted upstream.
  //
  // After the settings, because a configuration problem must be fixed
  // whatever the diff turns out to be. Before the factory, because an empty
  // diff should cost nothing.
  if (subject.diff.trim() === '') {
    return {
      report: [
        '## Review: Could not run',
        '',
        `**${subject.title}**`,
        '',
        'The diff was empty, so there was nothing to review.',
        '',
        'This is almost always a wiring problem rather than an empty change:',
        'a diff computed against the wrong base, a shallow clone with no merge',
        'base to compare against, or a fetch depth of 1. Check how the diff was',
        'produced before concluding the change is empty.',
        '',
        'Nothing was reviewed. This is a red result and not a passing one.',
      ].join('\n'),
      exitCode: 1,
      ...(settings.warnings !== undefined ? { warnings: settings.warnings } : {}),
    };
  }

  const wired = deps(settings);

  const loaded = await loadLensSet(settings.lensSource, wired.read);
  if (loaded.kind === 'unavailable') {
    // The three reasons stay apart all the way to the report. A reader who is
    // told only "could not load" cannot tell whether to fix a URL, wait for an
    // outage, or revert a bad commit to the definition.
    return couldNotRun(
      subject.title,
      loaded.source,
      `The lens set could not be read (${loaded.why}): ${loaded.reason}`,
      settings.warnings,
    );
  }

  const run = await runPanel(loaded.set, subject, wired.review, wired.practices);
  return {
    report: renderReport(run.verdict, { source: loaded.source, subject: subject.title }),
    exitCode: exitCodeFor(run.verdict.outcome),
    ...(settings.warnings !== undefined ? { warnings: settings.warnings } : {}),
  };
}
