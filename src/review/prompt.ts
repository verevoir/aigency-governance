// Assembling what a reviewer is shown.
//
// Split into two parts on purpose, and the split is the whole point of this
// module: `shared` is byte-identical for every lens in a run, `perLens` is the
// only thing that differs. The diff and the practices are the large payloads
// and they live in the shared half, so a lens panel sends one big prefix
// once per lens rather than a different one each time — which is what makes a provider
// cache hit possible at all.
//
// Whether the cache is actually hit is MEASURED elsewhere, not asserted here
// (G1). What this module guarantees is the only half it can: that the prefix
// really is identical, which is a structural property and cheap to check.

import type { Lens } from './lensSet.js';
import { REPLY_CONTRACT } from './replyContract.js';

/** The change under review. */
export interface Subject {
  readonly title: string;
  readonly description: string;
  readonly diff: string;
  /**
   * The code cited by this diff's own added lines, already resolved and
   * rendered — see citations.ts's `renderCitedContext`. Computed once at the
   * CLI boundary (cli/review.ts), the same way `practices` is fetched once
   * by the composition rather than per lens. Absent or blank means there
   * was nothing to cite (the ordinary case for a code diff), and
   * `buildPrompt` omits the section entirely rather than rendering an empty
   * heading — see its own body below.
   */
  readonly citedContext?: string;
}

/**
 * The two halves of what a reviewer is shown.
 *
 * **`shared` must precede `perLens` in whatever is finally sent.** This is a
 * contract the type cannot enforce and the tests cannot catch: a transport
 * that concatenated them the other way round would pass every assertion in
 * this repository and quietly make every prefix different, which is the exact
 * property the split exists to create. `renderPrompt` below is the right
 * answer for any caller that wants one string; a caller that needs them apart
 * — to send `shared` as a cacheable block and `perLens` as the message after
 * it — is the case this shape exists for, and is on its honour.
 */
export interface Prompt {
  /** Identical for every lens reviewing this subject. Goes first. */
  readonly shared: string;
  /** The only part that varies by lens. Goes last. */
  readonly perLens: string;
}

/** The two halves in the one order that preserves the shared prefix. */
export function renderPrompt(prompt: Prompt): string {
  return `${prompt.shared}\n\n${prompt.perLens}`;
}

/**
 * What a reviewer is told when no practices were supplied. Exported because
 * the tests assert on it, and a sentence typed in two places drifts the same
 * way the reply markers would have.
 */
export const NO_PRACTICES_NOTICE =
  'No practices were supplied for this run. Judge against the lens below and say so in your reasoning if the absence matters.';

/**
 * Build the prompt for one lens.
 *
 * `practices` is the bar this change is judged against, fetched from the
 * corpus by the composition. It is optional and its absence is NOT silently
 * equivalent to an empty bar: when it is missing the prompt says so, so a
 * reviewer judging against nothing knows it is judging against nothing.
 */
export function buildPrompt(lens: Lens, subject: Subject, practices?: string): Prompt {
  const bar = practices === undefined || practices.trim() === '' ? NO_PRACTICES_NOTICE : practices;

  // Absent or blank means nothing was cited in this diff's own added lines
  // — the ordinary case for a code diff — and the section is left out
  // entirely rather than rendered as an empty heading over nothing.
  const citedSection =
    subject.citedContext !== undefined && subject.citedContext.trim() !== ''
      ? ['', '## Cited code', '', subject.citedContext]
      : [];

  const shared = [
    'You are one lens of a review panel. Several reviewers are reading this same change, each along a different dimension, and their verdicts are combined. Review only your own dimension: another lens is covering the rest, and a finding outside your dimension is noise in someone else’s report.',
    '',
    '## The bar',
    '',
    bar,
    '',
    '## The change',
    '',
    `Title: ${subject.title}`,
    '',
    subject.description,
    '',
    '## The diff',
    '',
    '```diff',
    subject.diff,
    '```',
    ...citedSection,
    '',
    '## How to answer',
    '',
    REPLY_CONTRACT,
  ].join('\n');

  const perLens = [
    `## Your lens: ${lens.title}`,
    '',
    lens.focus,
    '',
    `Review the change above along this dimension and nothing else. Answer in the form described.`,
  ].join('\n');

  return { shared, perLens };
}
