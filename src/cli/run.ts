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
import { provision, type Elided, type Practice } from '../practices/provision.js';

export interface ReviewDeps {
  /** How the lens set is fetched. */
  readonly read: SourceReader;
  /** How one lens is reviewed. */
  readonly review: Reviewer;
  /** The bar, if the composition could fetch one — supplied directly, as
   * text. Kept for callers (and this repository's own tests) that already
   * resolve a bar some other way; a composition that instead names a
   * corpus to consult should use `practicesConsult` below, not this. */
  readonly practices?: string;
  /**
   * How to consult the practices corpus named by `settings.practicesSource`,
   * when one is configured. `review.ts` builds this from the same source
   * string that reaches `settings`, using the same kind of reader the lens
   * set already uses (`readerFor`) — picked by that source's own scheme,
   * not the lens set's.
   *
   * THIS IS THE JOIN. `provision` (`../practices/provision.js`) and
   * `buildPrompt`/`runPanel` accepting a `practices` string both already
   * existed, both already tested, and nothing before this field called one
   * from the other — `ReviewDeps.practices` stayed `undefined`
   * unconditionally on every real path, so every lens judged against
   * `NO_PRACTICES_NOTICE` regardless of what any corpus held. Absent
   * exactly when no corpus is configured, which is a legitimate choice —
   * see `resolvePractices` below for why an absent `practicesConsult` and a
   * `practicesConsult` that fails to read must not be reported the same
   * way.
   */
  readonly practicesConsult?: { readonly source: string; readonly read: SourceReader };
}

export interface ReviewOutcome {
  readonly report: string;
  /** 0 only for an approval. Everything else, including "could not run", is red. */
  readonly exitCode: number;
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

function couldNotRun(subject: string, source: string, reason: string): ReviewOutcome {
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
  };
}

/** Turn matched practices into the text the shared prompt half carries.
 * Plain concatenation, in the order `provision` returned them (declaration
 * order in the corpus, per its own bounding rule — see provision.ts). */
function renderPracticesBar(practices: readonly Practice[]): string {
  return practices.map((practice) => `### ${practice.title}\n\n${practice.body}`).join('\n\n');
}

/** Appends elision to a bar that already has one — written INTO the bar
 * itself, not only into a side channel a prompt reader would never see. A
 * partial bar and a complete one must not read the same, the same
 * principle `provision.ts`'s own `elided` marker exists for in the first
 * place; this is what carries that marker the rest of the way to the
 * reviewer actually judging against it. */
function withElisionNote(bar: string, elided: Elided): string {
  return (
    `${bar}\n\n---\n\n` +
    `NOTE: ${String(elided.omittedCount)} further practice(s) from ${elided.source} were ` +
    'not included in this bar — they did not fit the configured bound ' +
    '(AIGENCY_REVIEW_PRACTICES_MAX_CHARS). This bar is partial, not complete.'
  );
}

type PracticesResolution =
  | { readonly kind: 'bar'; readonly text: string }
  | { readonly kind: 'none' }
  | { readonly kind: 'could-not-run'; readonly source: string; readonly reason: string };

/**
 * What the panel is judged against, resolved once per run — the decision
 * `review.ts` must not make itself (see this module's own header).
 *
 * THREE OUTCOMES THAT MUST NOT COLLAPSE INTO ONE ANOTHER:
 *
 *   - `wired.practices` supplied directly is honoured as-is — the existing
 *     shape this repository's own tests already drive.
 *   - No corpus configured at all (`practicesConsult` absent) is `none`: a
 *     real, legitimate choice, not a fault. The panel runs, every lens sees
 *     `NO_PRACTICES_NOTICE`, exactly as before this join existed.
 *   - A corpus that IS configured and cannot be read is `could-not-run`,
 *     failing the WHOLE review — never silently downgraded to `none`. The
 *     same discipline `enact.ts` already applies to this same `provision`
 *     call for capability gating: asking a reviewer to judge against a bar
 *     it could not actually see is worse than not reviewing at all, because
 *     the resulting approval or rejection would look exactly like one that
 *     really did consult the corpus.
 *
 * Collapsing the second and third into each other is the exact defect this
 * whole join exists to close: a broken corpus and an unconfigured one must
 * not read the same, any more than either may read the same as a populated
 * one.
 */
async function resolvePractices(wired: ReviewDeps, maxChars: number): Promise<PracticesResolution> {
  if (wired.practices !== undefined) {
    return { kind: 'bar', text: wired.practices };
  }
  if (wired.practicesConsult === undefined) {
    return { kind: 'none' };
  }

  const { source, read } = wired.practicesConsult;

  // The empty query is deliberate, not a filter never finished. This panel
  // judges one diff along several independent lens dimensions at once (see
  // prompt.ts on the shared prefix), not one capability the way `enact.ts`
  // does — there is no narrower query that would not arbitrarily exclude a
  // practice some lens actually needed. Every practice's id/title/body is a
  // non-empty string (parseCorpus requires it), so an empty needle matches
  // every one of them: `provision('', ...)` returns the whole corpus,
  // bounded to fit. `nothing-matched` is therefore structurally
  // unreachable from a real, non-empty corpus — but it is still handled
  // below rather than assumed away, because "cannot happen" and "is
  // handled" are different claims and only the type system checks the
  // second.
  const outcome = await provision('', source, read, maxChars);

  if (outcome.kind === 'unavailable') {
    return {
      kind: 'could-not-run',
      source: outcome.source,
      reason: `${outcome.why}: ${outcome.reason}`,
    };
  }
  if (outcome.kind === 'nothing-matched') {
    return {
      kind: 'could-not-run',
      source: outcome.source,
      reason:
        `an unfiltered query matched none of the ${String(outcome.consideredCount)} ` +
        'practice(s) the corpus declared — this should be impossible with an empty ' +
        'query against a non-empty corpus, and points at a defect in provision() or ' +
        'the corpus, not a legitimate absence of practices',
    };
  }

  const bar = renderPracticesBar(outcome.practices);
  return {
    kind: 'bar',
    text: outcome.elided === undefined ? bar : withElisionNote(bar, outcome.elided),
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
    );
  }

  // Consulted after the lens set, before the panel: a corpus that cannot be
  // read must stop the run before anything is billed, exactly like a lens
  // set that cannot be read — see `resolvePractices`'s own header for why
  // this fails the whole review rather than silently reviewing bar-less.
  const practicesResolution = await resolvePractices(wired, settings.practicesMaxChars);
  if (practicesResolution.kind === 'could-not-run') {
    return couldNotRun(
      subject.title,
      practicesResolution.source,
      `The practices corpus could not be read (${practicesResolution.reason}).`,
    );
  }
  const practices = practicesResolution.kind === 'bar' ? practicesResolution.text : undefined;

  const run = await runPanel(loaded.set, subject, wired.review, practices);
  return {
    report: renderReport(run.verdict, {
      source: loaded.source,
      subject: subject.title,
      model: settings.model,
    }),
    exitCode: exitCodeFor(run.verdict.outcome),
  };
}
