// The transport: one lens, one model call — via `@verevoir/llm`, never a
// hand-rolled request to a provider. Only `@verevoir/llm` may talk to a
// model provider's SDK/API in this project; this file used to violate that
// boundary directly against `api.anthropic.com` with a raw `fetch`, in the
// tool that judges every repository's changes, including this one's.
//
// This file's job is now narrower than it was: shape ONE model call
// correctly (the shared/per-lens split `Prompt` documents), and translate
// what `@verevoir/llm`'s `chat()` can throw into what `runPanel` already
// knows how to read — a `NoRoomToAnswerError` when the model was cut off by
// its own token ceiling before it could answer, a plain `Error` otherwise.
//
// WHICH CREDENTIAL IS USED IS `llm`'S DECISION, NOT THIS FILE'S. This file
// hands `chat()` an explicit `apiKey` only when `settings.ts` resolved one
// (from `ANTHROPIC_API_KEY`, env or file) — BYOK, which wins outright. When
// none was found, `config.apiKey` is `undefined` and this file passes
// `null`, which is `chat()`'s documented "no BYOK — use the platform
// default" signal: `chat()` then reads `CLAUDE_CODE_OAUTH_TOKEN` from the
// environment itself, ahead of a metered `ANTHROPIC_API_KEY`, so the exact
// same call — CI or a laptop, no branch here at all — bills a Claude
// subscription rather than the metered key whenever one is available. That
// is what "the transport choice stops being its concern at all" means in
// practice: this file never asks which credential is in play, and could not
// tell you which one served any given call.
//
// It returns raw reply text and nothing else, same as before. What a reply
// MEANS is the parser's job; a transport that started interpreting would
// give the system two places where a verdict is decided.
//
// Usage figures come back on every `chat()` reply and are deliberately
// discarded here, same as before: accounting is its own story with its own
// shape, and a half-implementation that recorded a total would be worse
// than none — it would look like accounting exists.

import { chat } from '@verevoir/llm/anthropic';
import type { ChatReply } from '@verevoir/llm';

import type { Prompt } from './prompt.js';
import { NoRoomToAnswerError, type Reviewer } from './panel.js';

/**
 * What this file actually calls, injected so a test never makes a real
 * model call. Deliberately narrower than `@verevoir/llm`'s own
 * `ChatOptions` — this file only ever sends a single user turn and never
 * touches retries, progress or abort — but every field named here is a
 * real `ChatOptions` field with the same meaning, so the real `chat`
 * (`@verevoir/llm/anthropic`'s, the default) satisfies this type without
 * adaptation: it accepts every field `ChatOptions` requires and more,
 * structurally compatible with this narrower shape.
 */
export type ChatFn = (options: {
  readonly systemPrompt: string;
  // A mutable array, not `readonly ...[]`, to structurally match
  // `@verevoir/llm`'s own `Turn[]` — `chat()` never mutates what it is
  // handed, but a readonly array is not assignable to a mutable parameter
  // type, so this shape has to match exactly for the real `chat` to satisfy
  // this type as its default.
  readonly turns: { readonly role: 'user'; readonly content: string }[];
  readonly apiKey?: string | null;
  readonly model: string;
  readonly maxTokens: number;
}) => Promise<ChatReply>;

export interface AnthropicConfig {
  /**
   * BYOK credential, when `settings.ts` resolved one. `undefined` — never an
   * empty string, since `settings.ts`'s own `present()` treats blank as
   * absent — means "no explicit credential; let `@verevoir/llm` find one
   * itself" (see the file header).
   */
  readonly apiKey?: string;
  /**
   * Pinned, never defaulted by the caller's environment. CI and a laptop must
   * judge the same commit with the same model or the two runs are not
   * comparable — and a judge that varies silently is a bar that moves.
   * Passed to `chat()` as the exact-id override, so the pin holds regardless
   * of which credential route `chat()` chooses internally.
   */
  readonly model: string;
  readonly maxTokens: number;
}

/**
 * Remove anything secret from text that is about to be thrown, logged or
 * returned.
 *
 * This is a heuristic and must be documented as one: it replaces exact
 * occurrences of the strings it is given. A provider that returned half a
 * key, or one transformed in any way, would defeat it. It is here because the
 * alternative — trusting that a key never appears in an error — is a hope, and
 * an error message is the single most likely place for a request to be echoed
 * back at us. Kept even though `chat()` now owns the wire format: an explicit
 * BYOK key still passes through this file on every call, and an error
 * `chat()` throws could in principle echo it back.
 */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret !== '') {
      out = out.split(secret).join('***');
    }
  }
  return out;
}

/**
 * The substring `@verevoir/llm/anthropic`'s own `chat()` puts in its error
 * message specifically when a reply carried no text because the token
 * ceiling was hit before the model wrote an answer — that package's
 * `anthropic.chat: response had no text content (stop_reason=...)`, with
 * `stop_reason` interpolated as `max_tokens` in exactly this case. Matched
 * as a substring rather than parsed, because this file has no access to
 * `chat()`'s internals beyond the message it throws; if `llm` ever changes
 * this wording, the failure degrades to a plain `Error` (still reported,
 * still correct, just not distinguished as precisely) rather than throwing
 * on a message it no longer recognises.
 */
const MAX_TOKENS_STOP_REASON = 'stop_reason=max_tokens';

/**
 * A `Reviewer` backed by `@verevoir/llm/anthropic`'s `chat()`.
 *
 * Every failure throws. `runPanel` turns a throw into `could_not_run` for that
 * lens and lets the others finish, which is exactly the handling this wants —
 * so there is nothing to gain here from catching, and something to lose: a
 * caught error that returned a string would be parsed as a reply.
 */
export function anthropicReviewer(config: AnthropicConfig, call: ChatFn = chat): Reviewer {
  const secrets = config.apiKey !== undefined ? [config.apiKey] : [];

  return async (_lensId: string, prompt: Prompt): Promise<string> => {
    let reply: ChatReply;
    try {
      reply = await call({
        systemPrompt: prompt.shared,
        turns: [{ role: 'user', content: prompt.perLens }],
        apiKey: config.apiKey ?? null,
        model: config.model,
        maxTokens: config.maxTokens,
      });
    } catch (cause) {
      const message = redact(cause instanceof Error ? cause.message : String(cause), secrets);
      // See MAX_TOKENS_STOP_REASON's own doc comment: this is the one case
      // `runPanel` reports with its own precise language ("no room to
      // answer") rather than the generic "reviewer threw" that would send a
      // reader looking for a flaky connection instead of a token ceiling.
      throw message.includes(MAX_TOKENS_STOP_REASON)
        ? new NoRoomToAnswerError(message)
        : new Error(message);
    }
    return reply.content;
  };
}
