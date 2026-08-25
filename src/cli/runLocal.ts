// The whole LOCAL review composed — every step from an environment to an
// exit code, but through the real `claude` CLI rather than the Anthropic
// API. Mirrors `run.ts`'s ordering discipline (settle what is cheap to check
// before anything reaches a subprocess) without sharing its code:
// `runReview`'s settings resolution treats `ANTHROPIC_API_KEY` as required —
// correctly, for the substrate it drives — and this composition needs no
// credential of any kind. Teaching `resolveSettings` a key-optional path for
// one specific transport would put a which-transport-is-this branch inside
// the one module whose whole job is not deciding that.
//
// Deliberately NOT re-exported from `src/index.ts`. This is a local,
// operator-run composition for THIS repository's own iteration, not a
// second published surface for consumers to build against — see
// `scripts/review-head.mjs`'s header for the framing.

import { loadLensSet, type SourceReader } from '../review/load.js';
import { runPanel } from '../review/panel.js';
import type { Subject } from '../review/prompt.js';
import { exitCodeFor, renderReport } from '../review/report.js';
import { checkClaudeCliAvailable, claudeCliReviewer, type CliRunner } from '../review/claudeCli.js';
import { DEFAULT_LENS_SOURCE } from '../review/settings.js';

/** What this composition needs from outside itself — a way to read the lens
 * set, and a way to run one `claude` CLI invocation. Both are interfaces a
 * test can satisfy with a plain function; neither implies a real filesystem,
 * network call or subprocess. */
export interface LocalReviewDeps {
  readonly read: SourceReader;
  readonly run: CliRunner;
}

export interface ReviewOutcome {
  readonly report: string;
  readonly exitCode: number;
}

function present(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === '' ? undefined : value;
}

function couldNotRun(subject: string, reason: string): ReviewOutcome {
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
    ].join('\n'),
    exitCode: 1,
  };
}

/** Same shape as {@link couldNotRun}, plus which lens set this run was
 * attempting to read — used only once a source is actually known, mirroring
 * `run.ts`'s own `couldNotRun(subject, source, reason)`: a reader told a
 * lens set "could not be read" needs to know WHICH one before they can go
 * looking. */
function lensSetCouldNotRun(subject: string, source: string, reason: string): ReviewOutcome {
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

/**
 * Run a review through `claude -p` instead of the Anthropic API.
 *
 * `env` supplies only what this composition actually needs: which lens set
 * to load. No API key of any kind is read, resolved, or required — this
 * composition has no credential to check, and nothing here would know what
 * to do with one if it found it.
 */
export async function runLocalReview(
  env: Record<string, string | undefined>,
  subject: Subject,
  deps: LocalReviewDeps,
): Promise<ReviewOutcome> {
  // Before anything else, because a workflow problem must be fixed whatever
  // else is true, and it costs nothing to check first.
  if (subject.diff.trim() === '') {
    return couldNotRun(
      subject.title,
      [
        'The diff was empty, so there was nothing to review.',
        '',
        'This is almost always a wiring problem rather than an empty change:',
        'a diff computed against the wrong base, a shallow clone with no merge',
        'base to compare against, or a fetch depth of 1. Check how the diff was',
        'produced before concluding the change is empty.',
      ].join('\n'),
    );
  }

  // Checked once, before the panel, not left for the panel to discover five
  // times over: one lens finding `claude` unusable is one failure to read;
  // five lenses each hitting the same wall independently is the same fact
  // told five confusing ways. Costs nothing against a billed key either way
  // — see checkClaudeCliAvailable's own doc comment.
  const availability = await checkClaudeCliAvailable(deps.run);
  if (!availability.ok) {
    return couldNotRun(
      subject.title,
      [
        `The claude CLI is not usable: ${availability.reason ?? 'unknown reason'}`,
        '',
        'This script never falls back to a billed API key. Install or log in the',
        'Claude Code CLI (claude setup-token, or an interactive login) and re-run.',
      ].join('\n'),
    );
  }

  const lensSource = present(env['AIGENCY_REVIEW_LENSES']) ?? DEFAULT_LENS_SOURCE;
  const loaded = await loadLensSet(lensSource, deps.read);
  if (loaded.kind === 'unavailable') {
    return lensSetCouldNotRun(
      subject.title,
      lensSource,
      `The lens set could not be read (${loaded.why}): ${loaded.reason}`,
    );
  }

  const panelRun = await runPanel(loaded.set, subject, claudeCliReviewer(deps.run));
  return {
    report: renderReport(panelRun.verdict, { source: loaded.source, subject: subject.title }),
    exitCode: exitCodeFor(panelRun.verdict.outcome),
  };
}
