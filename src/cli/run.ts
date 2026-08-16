// The whole review, composed — every step from an environment to an exit code.
//
// Deliberately not the binary. Reading argv, touching stdin and calling
// process.exit belong at the process boundary; everything that DECIDES
// anything lives here, where a test can drive it with fakes and no network.
// The binary that wraps this should be short enough to read in one go, and
// should contain no branch that is not visible from here.
//
// THREE OF THE CHECKS BELOW DECIDE FACTS THAT ARE INDEPENDENTLY KNOWABLE:
// whether the settings resolve, whether the subject diff is non-empty, and
// whether the lens set can be reached. None of the three has a real
// dependency on either of the others — in particular, loadLensSet needs a
// lens source and, when the source requires one, a lens token; it has no
// real dependency on the API key. So all three are gathered before anything
// is reported. A run with a broken key file AND an unreachable lens source
// learns both in one pass, not one round trip per fact — the person fixes
// what they were told, re-runs, and is told the next thing, up to three
// times over for three things that were all knowable at once.
//
// What comes after those three is different: it is where a real dependency
// starts. Constructing the reviewer needs a valid API key — there is no
// meaningful reviewer without one. Running the panel needs both the reviewer
// and the loaded lens set — there is nothing to run it against otherwise.
// Those stages run only once every independently-checkable fact came back
// clean, and gathering the other three is not the same as continuing past
// these: the panel still does not run, and nothing spends money that should
// not, when anything at all is wrong. The only difference gathering makes is
// that the report, when something is wrong, is complete.
//
// One consequence of keeping "what can this next step actually verify" as
// the question, rather than "is the whole settings object ready": building
// the lens-set reader takes only the lens source and token (`LensReaderFactory`,
// below), never the full settings. Building the reviewer still takes the
// full, ready settings, because the key genuinely belongs to it. Bundling
// both into one factory keyed on "ready" is exactly how the API key ended up
// gating a check it has nothing to do with, and it is not a mistake this
// file wants to make twice.

import { loadLensSet } from '../review/load.js';
import { runPanel } from '../review/panel.js';
import type { Reviewer } from '../review/panel.js';
import type { Subject } from '../review/prompt.js';
import { exitCodeFor, renderReport } from '../review/report.js';
import type { SourceReader } from '../review/load.js';
import type { Verdict } from '../review/verdict.js';
import {
  renderMissing,
  resolveSettings,
  type KeyFileReader,
  type ReviewSettings,
} from '../review/settings.js';

export interface ReviewDeps {
  /** How one lens is reviewed. Needs the full, ready settings — the key is a
   * real dependency here, unlike for the lens-set reader below. */
  readonly review: Reviewer;
  /** The bar, if the composition could fetch one. */
  readonly practices?: string;
}

/** What building the lens-set reader actually needs — nothing else. */
export interface LensAccess {
  readonly lensSource: string;
  /** Absent, not present-and-undefined, when the source needs no token. */
  readonly lensToken?: string;
}

/**
 * Builds the reader used to fetch the lens set. Deliberately a function of
 * `LensAccess` and not of `ReviewSettings`: loadLensSet has no real
 * dependency on the API key, and taking the whole settings object here would
 * recreate the defect this file exists to fix — a check gated on "is
 * everything ready" rather than on what the check itself needs.
 */
export type LensReaderFactory = (access: LensAccess) => SourceReader;

export interface ReviewOutcome {
  readonly report: string;
  /** 0 only for an approval. Everything else, including "could not run", is red. */
  readonly exitCode: number;
  /**
   * The verdict the report was rendered from — the same structured object
   * `runPanel` produced, not a re-derivation of the markdown. Absent,
   * deliberately, on every path that returns before the panel ever runs: a
   * missing setting, a present-and-wrong one, an empty diff, an unreachable
   * lens set. An empty Verdict (zero findings, zero unran lenses) would be
   * indistinguishable from a panel that ran every lens and approved, and
   * those are opposite outcomes — so this is `undefined` rather than a
   * fabricated stand-in, the same way `Finding.evidence` is absent rather
   * than invented when nothing was actually checked.
   */
  readonly verdict?: Verdict;
}

/**
 * The default when no reader is supplied: every path is absent, so
 * `resolveSettings` behaves exactly as it did before the file source
 * existed, and this module never touches a real filesystem unless the process
 * boundary explicitly hands it one. The real implementation, `keyFileReader`
 * in readers.ts, is what review.ts actually wires — matching how the lens
 * reader for the lens set is constructed there rather than here.
 */
const noKeyFile: KeyFileReader = () => Promise.resolve({ kind: 'absent' });

function settingsInvalidText(problems: readonly string[]): string {
  return [
    'The review could not run: the configuration is present and wrong.',
    '',
    ...problems.map((problem) => `  ${problem}`),
    '',
    'This is a red result, not a passing one. Nothing was reviewed.',
  ].join('\n');
}

function diffEmptyText(title: string): string {
  return [
    '## Review: Could not run',
    '',
    `**${title}**`,
    '',
    'The diff was empty, so there was nothing to review.',
    '',
    'This is almost always a wiring problem rather than an empty change:',
    'a diff computed against the wrong base, a shallow clone with no merge',
    'base to compare against, or a fetch depth of 1. Check how the diff was',
    'produced before concluding the change is empty.',
    '',
    'Nothing was reviewed. This is a red result and not a passing one.',
  ].join('\n');
}

function lensSetUnavailableText(subject: string, source: string, reason: string): string {
  return [
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
  ].join('\n');
}

/** One independently-knowable problem, gathered rather than reported on its
 * own the moment it is found. */
interface Problem {
  /** Short, only shown as part of a numbered list when there is more than
   * one problem — never shown standalone. */
  readonly heading: string;
  /** The problem's own report, exactly as it would read if it were the only
   * thing wrong. */
  readonly text: string;
}

/**
 * Several independent problems, reported together.
 *
 * This is the whole point: a caller with two things wrong learns both from
 * one run, not one per re-run. The problems arrive in `problems` already in
 * the order that matters — settled configuration first, because whatever
 * else is true a broken or missing setting has to be fixed regardless, then
 * the diff, then the lens set, matching the order the file header explains.
 * That first entry is the one to fix next; the rest are named so fixing it
 * does not cost a second, third or fourth run to learn about them.
 */
function renderGathered(title: string, problems: readonly Problem[]): string {
  const lines = [
    '## Review: Could not run',
    '',
    `**${title}**`,
    '',
    `${String(problems.length)} problems were found, checked independently rather than`,
    'stopping at the first. The first one below is the one to fix next — nothing',
    'after it can be confirmed fixed until it is — but the rest are named now,',
    'rather than waiting for a re-run to surface each of them in turn.',
    '',
  ];
  problems.forEach((problem, index) => {
    lines.push(
      `### Problem ${String(index + 1)} of ${String(problems.length)}: ${problem.heading}`,
      '',
      problem.text,
      '',
    );
  });
  lines.push(
    '---',
    '',
    'Nothing was reviewed. This is a red result, not a passing one. Gathering these',
    'is not the same as continuing: the panel still has not run, and nothing has',
    'spent money that should not have. The only difference from stopping at the',
    'first problem found is that this report is complete.',
  );
  return lines.join('\n');
}

/**
 * Run a review.
 *
 * `deps` is a factory rather than a value because the reviewer needs the
 * settings — specifically the key — and the settings are not known until this
 * function has resolved them. Taking a ready-made reviewer would mean the
 * caller resolving settings too, in a second place, which is where the two
 * would drift. It is also what makes the most important assertion in the
 * suite possible: the factory is not called at all when the configuration is
 * incomplete, so a run that cannot be configured cannot spend money.
 *
 * `buildReader` is a separate factory, deliberately: it takes only
 * `LensAccess`, so it can run — and the lens set can be checked — even when
 * `deps` cannot yet be called because the key is missing or wrong. See the
 * file header.
 */
export async function runReview(
  env: Record<string, string | undefined>,
  subject: Subject,
  deps: (settings: ReviewSettings) => ReviewDeps,
  buildReader: LensReaderFactory,
  readKeyFile: KeyFileReader = noKeyFile,
): Promise<ReviewOutcome> {
  const resolved = await resolveSettings(env, readKeyFile);

  const problems: Problem[] = [];

  if (resolved.kind === 'incomplete') {
    problems.push({
      heading: 'the configuration',
      text: renderMissing(resolved.missing, resolved.problems),
    });
  } else if (resolved.kind === 'invalid') {
    problems.push({ heading: 'the configuration', text: settingsInvalidText(resolved.problems) });
  }

  // Nothing to review is not the same as nothing wrong with it. A workflow
  // that computed its diff against the wrong base, or cloned shallowly, hands
  // this an empty string — and five lenses would each read it, find nothing,
  // and approve. That is the most likely way this stops working without
  // anybody noticing, so it is checked here, independently of whether the
  // settings resolved.
  if (subject.diff.trim() === '') {
    problems.push({ heading: 'the diff', text: diffEmptyText(subject.title) });
  }

  // The lens source and token, resolved whether or not the settings as a
  // whole came back ready — see the fields on `SettingsResult` in
  // settings.ts. This is the fix: the lens set is checked here even when the
  // API key is missing, because checking it has no real dependency on the
  // key.
  const lensSource = resolved.kind === 'ready' ? resolved.settings.lensSource : resolved.lensSource;
  const lensToken = resolved.kind === 'ready' ? resolved.settings.lensToken : resolved.lensToken;
  const reader = buildReader(lensToken === undefined ? { lensSource } : { lensSource, lensToken });
  const loaded = await loadLensSet(lensSource, reader);
  if (loaded.kind === 'unavailable') {
    // The three reasons (`missing`, `unreachable`, `malformed`) stay apart
    // all the way to the report. A reader who is told only "could not load"
    // cannot tell whether to fix a URL, wait for an outage, or revert a bad
    // commit to the definition.
    problems.push({
      heading: 'the lens set',
      text: lensSetUnavailableText(
        subject.title,
        loaded.source,
        `The lens set could not be read (${loaded.why}): ${loaded.reason}`,
      ),
    });
  }

  if (problems.length === 1) {
    const only = problems[0];
    if (only === undefined) {
      // Unreachable: the length check above guarantees an element at 0.
      // Thrown rather than defaulted, matching the guard below — a state
      // that cannot happen should fail loudly if it somehow does.
      throw new Error('runReview: problems.length was 1 but problems[0] was undefined');
    }
    // Alone, reported exactly as it would read if it were the only thing
    // ever checked — no numbered list, no mention of problems that were not
    // found.
    return { report: only.text, exitCode: 1 };
  }
  if (problems.length > 1) {
    return { report: renderGathered(subject.title, problems), exitCode: 1 };
  }

  // Every independently-knowable fact came back clean. What is left
  // genuinely depends on that: the reviewer needs a valid key, and the panel
  // needs both the reviewer and the loaded lens set. This is unreachable in
  // practice — every branch above that could leave either of these unready
  // also pushed a problem — and asserted here so a future change to the
  // gathering above fails loudly rather than reaching the panel silently
  // half-configured.
  if (resolved.kind !== 'ready' || loaded.kind !== 'loaded') {
    throw new Error(
      'runReview: reached the panel with the configuration or the lens set unresolved',
    );
  }

  const wired = deps(resolved.settings);

  const run = await runPanel(loaded.set, subject, wired.review, wired.practices);
  return {
    report: renderReport(run.verdict, { source: loaded.source, subject: subject.title }),
    exitCode: exitCodeFor(run.verdict.outcome),
    // The same Verdict the report was rendered from — not recomputed, not
    // re-derived from the markdown above.
    verdict: run.verdict,
  };
}
