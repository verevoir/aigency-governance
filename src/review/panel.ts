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
import { aggregate, type GenAiUsage, type LensResult, type Verdict } from './verdict.js';

/**
 * What a Reviewer actually returns: the reply content `parseReply` turns
 * into a verdict, plus this call's own token usage, when the transport
 * reported one. `usage` absent means not reported -- never defaulted to
 * zero.
 */
export interface ReviewerReply {
  readonly content: string;
  readonly usage?: GenAiUsage;
}

/**
 * Whatever actually asks a model. Takes the two prompt halves separately so a
 * composition can cache the shared one; returns the reply content plus this
 * call's own usage, because deciding what a reply MEANS is the parser's job
 * and not the transport's, but the transport is the only thing that ever
 * sees a usage figure at all.
 */
export type Reviewer = (lensId: string, prompt: Prompt) => Promise<ReviewerReply>;

/**
 * Thrown by a Reviewer when a reply arrived but its entire output budget
 * was spent before any of it became an answer - the ceiling cut the model
 * off, not the transport, and not the model choosing badly. Any Reviewer
 * implementation may throw this instead of a bare Error to say so
 * specifically; runPanel reports it with its own reason, distinguishable
 * at a glance from an ordinary transport failure, because the two point at
 * different fixes: raise the budget or shrink the subject, versus fix the
 * connection.
 */
export class NoRoomToAnswerError extends Error {
  override readonly name = 'NoRoomToAnswerError';
}

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
      const result = parseReply(lens.id, reply.content);
      // Usage is carried onto the result exactly as the transport reported
      // it for this call -- absent stays absent, never defaulted to zero.
      return reply.usage === undefined ? result : { ...result, usage: reply.usage };
    }),
  );

  const results = settled.map((outcome, index): LensResult => {
    const lens = set.lenses[index]?.id ?? '';
    if (outcome.status === 'fulfilled') {
      return outcome.value;
    }
    // The reviewer threw — a transport failure, a truncated reply, or
    // something neither of those. It reads as could_not_run carrying the
    // reason, exactly like an unreadable reply, because from the panel's
    // side they are all the same fact: this lens did not review. But the
    // WORDING must not claim more agreement between those causes than
    // exists — a NoRoomToAnswerError is not a transport failure, and saying
    // "reviewer threw" about it reads as one, which is exactly what sent an
    // earlier investigation looking for a flaky socket instead of a token
    // ceiling.
    const cause = outcome.reason as unknown;
    const message = cause instanceof Error ? cause.message : String(cause);
    const reason =
      cause instanceof NoRoomToAnswerError
        ? `no room to answer: ${message}`
        : `reviewer threw: ${message}`;
    return { lens, outcome: 'could_not_run', findings: [], reason };
  });

  return {
    verdict: aggregate(
      set.lenses.map((lens) => lens.id),
      results,
    ),
    prompts,
  };
}
