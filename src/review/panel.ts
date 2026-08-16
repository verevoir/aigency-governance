// Running the panel.
//
// Every lens is dispatched, and a lens that throws takes only itself down.
// `Promise.allSettled` rather than `Promise.all` is the entire reason: with
// `all`, the first rejection abandons the results of lenses that had already
// finished, so one flaky call would discard four completed reviews and the
// report would be unable to say which four.

import type { LensSet } from './lensSet.js';
import { parseReply } from './parseReply.js';
import { buildPrompt, type Prompt, type Subject } from './prompt.js';
import { aggregate, type LensResult, type Verdict } from './verdict.js';
import { verifyLensResult } from './verifyFindings.js';

/**
 * Whatever actually asks a model. Takes the two prompt halves separately so a
 * composition can cache the shared one; returns raw reply text, because
 * deciding what a reply MEANS is the parser's job and not the transport's.
 */
export type Reviewer = (lensId: string, prompt: Prompt) => Promise<string>;

export interface PanelRun {
  readonly verdict: Verdict;
  /** The prompts as dispatched, so a caller can prove the prefix was shared. */
  readonly prompts: ReadonlyMap<string, Prompt>;
}

export async function runPanel(
  set: LensSet,
  subject: Subject,
  review: Reviewer,
  practices?: string,
): Promise<PanelRun> {
  const prompts = new Map<string, Prompt>();
  for (const lens of set.lenses) {
    prompts.set(lens.id, buildPrompt(lens, subject, practices));
  }

  const settled = await Promise.allSettled(
    set.lenses.map(async (lens): Promise<LensResult> => {
      // Non-null: every lens id was just written into the map above.
      const prompt = prompts.get(lens.id) as Prompt;
      const reply = await review(lens.id, prompt);
      // A finding that cannot be verified against the diff it claims to be
      // about is a finding no one should act on (C2, C3) — see
      // verifyFindings.ts for what this does to the result and why.
      return verifyLensResult(parseReply(lens.id, reply), subject.diff);
    }),
  );

  const results = settled.map((outcome, index): LensResult => {
    const lens = set.lenses[index]?.id ?? '';
    if (outcome.status === 'fulfilled') {
      return outcome.value;
    }
    // The reviewer threw — a transport failure, not a judgement. It reads as
    // could_not_run carrying the reason, exactly like an unreadable reply,
    // because from the panel's side they are the same fact: this lens did not
    // review.
    const cause = outcome.reason as unknown;
    const message = cause instanceof Error ? cause.message : String(cause);
    return { lens, outcome: 'could_not_run', findings: [], reason: `reviewer threw: ${message}` };
  });

  return {
    verdict: aggregate(
      set.lenses.map((lens) => lens.id),
      results,
    ),
    prompts,
  };
}
