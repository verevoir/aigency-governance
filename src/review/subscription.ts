// The subscription route: one lens, one model call, through
// `@verevoir/llm/anthropic`'s own `chat()` — which already prefers
// `CLAUDE_CODE_OAUTH_TOKEN` over `ANTHROPIC_API_KEY` when both are
// configured, falling back to the metered key loudly (once, session-wide)
// on a 401. See that package's `src/anthropic/client.ts`
// (`resolveAnthropicAuth`) and its own CHANGELOG (0.21.0 / 0.21.1) for the
// precedence this reviewer INHERITS rather than reimplements.
//
// WHY THIS EXISTS ALONGSIDE anthropic.ts AND claudeCli.ts.
// `anthropic.ts` is this repository's own hand-rolled HTTP client, billing
// ONLY `ANTHROPIC_API_KEY` — the historical CI route, and unchanged by this
// file. `claudeCli.ts` shells out to a `claude` binary that must already be
// installed and already logged in — the right default for a laptop, per
// that file's own header, and NOT what CI does: this repository's CI never
// installs a `claude` binary at all. This transport closes the actual gap:
// a CI route that can spend a subscription credential
// (`CLAUDE_CODE_OAUTH_TOKEN`) INSTEAD OF the metered key, without spawning
// a subprocess or requiring any binary on the runner — `@verevoir/llm/anthropic`
// is a plain HTTP client over `@anthropic-ai/sdk`, the same shape
// `anthropic.ts` already is, just with credential resolution this
// repository does not have to reimplement.
//
// ROUTE PRECEDENCE IS settings.ts's DECISION, NOT THIS FILE'S. `settings.ts`
// selects this reviewer whenever `CLAUDE_CODE_OAUTH_TOKEN` is configured,
// REGARDLESS of whether `ANTHROPIC_API_KEY` is also present — matching
// `verevoir/llm`'s own antagonistic-review workflow, which hands
// `claude-code-base-action` both credentials and lets the action prefer the
// subscription token. This IS a precedence change from this repository's
// prior behaviour, where a present `ANTHROPIC_API_KEY` always won outright:
// see settings.ts's own header for the reasoning.
//
// A FAILURE NEVER BECOMES A REPLY, mirroring anthropic.ts and claudeCli.ts:
// every branch below throws; `runPanel` turns a throw into `could_not_run`
// for that lens, never a returned string.
//
// A TRUNCATED REPLY NEVER BECOMES A COMPLETE ONE. Unlike `claudeCli.ts`'s
// `chat()`, `@verevoir/llm/anthropic`'s `chat()` never RETURNS empty
// content — it throws directly, embedding `stop_reason=<reason>` in the
// message text (see that package's own `chat()`, the "no text content"
// throw). `EMPTY_REPLY_PATTERN` recognises that exact shape so a genuinely
// empty max_tokens reply is reported the same way a non-empty truncated one
// is below, rather than as an undifferentiated "reviewer threw". Separately,
// this reviewer also checks the case `chat()` does NOT protect against on
// its own: non-empty content that stopped at `max_tokens` — `chat()` logs a
// `console.warn` and returns it as though it were finished, exactly the
// behaviour `anthropic.ts`'s own `textFrom()` and `claudeCli.ts`'s own
// `stopReason` check exist to refuse. This reviewer refuses it the same
// way, before it can reach the parser as a plausible-looking but truncated
// verdict.

import { chat } from '@verevoir/llm/anthropic';

import { NoRoomToAnswerError, type Reviewer } from './panel.js';
import type { Prompt } from './prompt.js';

export interface SubscriptionOptions {
  /**
   * Sent as `model`, pinned to the same value every other route sends — see
   * settings.ts's `DEFAULT_MODEL` doc comment. Omitted entirely when
   * absent, leaving the adapter's own catalog resolution untouched.
   */
  readonly model?: string;
  /**
   * Sent as `maxTokens`. `settings.ts` always supplies one in practice; this
   * stays optional so a caller constructing this reviewer directly is not
   * forced to invent a value, in which case the adapter's own default
   * (16384) applies.
   */
  readonly maxTokens?: number;
}

const TRUNCATED_STOP_REASON = 'max_tokens';

/**
 * Recognises `@verevoir/llm/anthropic`'s own empty-reply message shape
 * (`anthropic.chat: response had no text content (stop_reason=...)`) and
 * pulls the `stop_reason` back out of it. Exported so the exact shape this
 * matches is asserted by a test, not merely read in this comment.
 */
export const EMPTY_REPLY_PATTERN =
  /^anthropic\.chat: response had no text content \(stop_reason=([^)]*)\)$/;

export function subscriptionReviewer(options: SubscriptionOptions = {}): Reviewer {
  return async (_lensId: string, prompt: Prompt): Promise<string> => {
    let reply: Awaited<ReturnType<typeof chat>>;
    try {
      reply = await chat({
        systemPrompt: prompt.shared,
        turns: [{ role: 'user', content: prompt.perLens }],
        ...(options.model === undefined ? {} : { model: options.model }),
        ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      const emptyMatch = EMPTY_REPLY_PATTERN.exec(message);
      if (emptyMatch?.[1] === TRUNCATED_STOP_REASON) {
        throw new NoRoomToAnswerError(
          `no room to answer: stop_reason ${TRUNCATED_STOP_REASON} (reply carried no text at all)`,
        );
      }
      throw new Error(message);
    }

    if (reply.stopReason === TRUNCATED_STOP_REASON) {
      // Refused, not returned — see the file header's TRUNCATED REPLY
      // paragraph. `usage.outputTokens` and `content.length` are named so a
      // reader can tell a ceiling hit early (little text, budget exhausted
      // on reasoning) from one hit late (most of the answer arrived, only
      // the tail was cut) — the same distinction `claudeCli.ts` draws.
      throw new NoRoomToAnswerError(
        `no room to answer: stop_reason ${TRUNCATED_STOP_REASON} (${String(reply.usage.outputTokens)} ` +
          `output token(s) spent before the ceiling cut the reply off, ${String(reply.content.length)} ` +
          'character(s) of reply text had arrived)',
      );
    }

    return reply.content;
  };
}
