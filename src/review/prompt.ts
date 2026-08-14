// Assembling what a reviewer is shown.
//
// Split into two parts on purpose, and the split is the whole point of this
// module: `shared` is byte-identical for every lens in a run, `perLens` is the
// only thing that differs. The diff and the practices are the large payloads
// and they live in the shared half, so a five-lens panel sends one big prefix
// five times rather than five different ones — which is what makes a provider
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
}

export interface Prompt {
  /** Identical for every lens reviewing this subject. */
  readonly shared: string;
  /** The only part that varies by lens. */
  readonly perLens: string;
}

/**
 * Build the prompt for one lens.
 *
 * `practices` is the bar this change is judged against, fetched from the
 * corpus by the composition. It is optional and its absence is NOT silently
 * equivalent to an empty bar: when it is missing the prompt says so, so a
 * reviewer judging against nothing knows it is judging against nothing.
 */
export function buildPrompt(lens: Lens, subject: Subject, practices?: string): Prompt {
  const bar =
    practices === undefined || practices.trim() === ''
      ? 'No practices were supplied for this run. Judge against the lens below and say so in your reasoning if the absence matters.'
      : practices;

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
