// The transport: one lens, one model call.
//
// This is the only file in the repository that talks to a provider, and it is
// where the prompt split stops being a convention and becomes a wire format.
// `shared` goes in the `system` block, marked cacheable; `perLens` goes in the
// user message. That ordering is the contract `Prompt` documents and no type
// can enforce — here it is enforced by a test, because here there is finally
// something to test.
//
// It returns raw reply text and nothing else. What a reply MEANS is the
// parser's job; a transport that started interpreting would give the system
// two places where a verdict is decided.
//
// Usage figures come back on every response and are deliberately discarded
// here. Accounting is its own story with its own shape (four numbers kept
// apart, per provider call), and a half-implementation that recorded a total
// would be worse than none — it would look like accounting exists.
//
// TWO CREDENTIALS, ONE REQUEST SHAPE. `config.credential` (settings.ts) names
// which of an API key and a subscription OAuth token authenticated this call,
// and the ONLY thing that decides is which header carries it — see
// `headersFor` below. Everything else about the request is identical: same
// URL, same body, same model field, same `max_tokens`, same response
// envelope, same `stop_reason` values, same failure shapes in `textFrom`. A
// caller cannot tell from the response which credential was used, and that is
// the point — it is why `NoRoomToAnswerError`, the retry a caller wraps this
// in, and every other piece of behaviour this file already had continues to
// mean the same thing regardless of which credential resolved.
//
// The alternative that was NOT built here is shelling out to a CLI that
// already knows how to use a subscription token — the natural-looking
// shortcut, and worth saying explicitly why it was rejected rather than
// leaving the next person to wonder. A CLI is a DIFFERENT code path: a
// different response envelope (whatever that program chooses to print, not
// this API's JSON), no `stop_reason` this file could read, and
// `NoRoomToAnswerError` — the class that exists specifically because a
// truncated-thinking reply is otherwise indistinguishable from a transport
// fault — blind through it, because the signal it depends on would never
// arrive. Every failure shape this file and its tests already
// establish (a truncated body, a non-JSON reply, a tool_use block with no
// text, a max_tokens cutoff) would need re-establishing against a second
// transport, in a second file, and the two would drift the moment either one
// changed — the exact shape of defect this project keeps finding and fixing
// under other names. An OAuth token against the same Messages API this file
// already calls is a different CREDENTIAL on the SAME path: same request
// shape, same response envelope, same model selection, same failure shapes.
// Parity is preserved because nothing downstream of `headersFor` had to
// learn a second way to fail.

import type { Credential } from './settings.js';
import type { Prompt } from './prompt.js';
import { NoRoomToAnswerError, type Reviewer } from './panel.js';

/** A POST, shaped so the global `fetch` satisfies it without adaptation. */
export type HttpPost = (
  url: string,
  init: {
    readonly method: string;
    readonly headers: Record<string, string>;
    readonly body: string;
  },
) => Promise<{ readonly ok: boolean; readonly status: number; text(): Promise<string> }>;

export interface AnthropicConfig {
  readonly credential: Credential;
  /**
   * Pinned, never defaulted by the caller's environment. CI and a laptop must
   * judge the same commit with the same model or the two runs are not
   * comparable — and a judge that varies silently is a bar that moves.
   */
  readonly model: string;
  readonly maxTokens: number;
  /** Overridable for tests and for a proxy. */
  readonly baseUrl?: string;
}

const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';

/**
 * The one place a `Credential` decides anything: which header carries it.
 *
 * An API key goes in `x-api-key`, unchanged from before this file knew about
 * a second credential. A subscription OAuth token goes in `authorization` as
 * a bearer token — the standard shape for that kind of credential, and
 * distinct from `x-api-key` so a provider that inspects headers cannot
 * confuse the two. Nothing else in the request differs: no extra field, no
 * different endpoint, no different body — see the file header for why that
 * identity is the entire safety argument for adding this rather than a
 * second transport.
 */
function headersFor(credential: Credential): Record<string, string> {
  return credential.source === 'api-key'
    ? { 'x-api-key': credential.value }
    : { authorization: `Bearer ${credential.value}` };
}

/**
 * Remove anything secret from text that is about to be thrown, logged or
 * returned.
 *
 * This is a heuristic and must be documented as one: it replaces exact
 * occurrences of the strings it is given. A provider that returned half a key,
 * or one transformed in any way, would defeat it. It is here because the
 * alternative — trusting that a key never appears in an error — is a hope, and
 * an error message is the single most likely place for a request to be echoed
 * back at us.
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

interface TextBlock {
  readonly type: string;
  readonly text?: string;
}

/**
 * Pull the reply text out of a response body.
 *
 * Throws rather than returning `''` when there is no text. An empty string
 * would travel to `parseReply`, which would correctly call it `reply was
 * empty` — a true statement about the reply and a false one about what
 * happened, because the reply never arrived. The two are different failures
 * and only one of them is the model's fault.
 */
function textFrom(body: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error('response was not JSON');
  }
  const document = parsed as { content?: unknown; stop_reason?: unknown };
  const content = document.content;
  if (!Array.isArray(content)) {
    throw new Error('response carried no content array');
  }
  const text = (content as TextBlock[])
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text ?? '')
    .join('');
  if (text === '') {
    // Name the block kinds and the stop reason. The first version said only
    // "no text (N block(s))", which is true and undiagnosable: four lenses
    // failed with it and the cause could not be established from the message.
    // A reply that is one thinking block truncated at the token ceiling and a
    // reply that is one tool_use block are different problems, and the two
    // fields that separate them were both already in the response.
    const kinds = (content as TextBlock[]).map((block) => block.type).join(', ');
    const stop = typeof document.stop_reason === 'string' ? document.stop_reason : 'absent';
    const message = `response carried no text: ${String(content.length)} block(s) [${kinds}], stop_reason ${stop}`;
    // stop_reason max_tokens with zero text is a specific, recognisable fact:
    // the entire output budget went to reasoning and nothing was left to
    // answer with. That is not the provider being unreachable and not the
    // model answering badly - it is the model being cut off before it could
    // answer - and NoRoomToAnswerError says so precisely rather than arriving
    // at the panel wearing the generic word "threw", which reads as a
    // transport fault and sent an earlier investigation looking for one. Any
    // other stop reason with no text (a bare tool_use block, an absent
    // stop_reason) stays a plain Error: this class is reserved for the one
    // case it is actually true of.
    throw stop === 'max_tokens' ? new NoRoomToAnswerError(message) : new Error(message);
  }
  return text;
}

/**
 * A `Reviewer` backed by the Anthropic messages API.
 *
 * Every failure throws. `runPanel` turns a throw into `could_not_run` for that
 * lens and lets the others finish, which is exactly the handling this wants —
 * so there is nothing to gain here from catching, and something to lose: a
 * caught error that returned a string would be parsed as a reply.
 */
export function anthropicReviewer(config: AnthropicConfig, post: HttpPost): Reviewer {
  const url = `${config.baseUrl ?? DEFAULT_BASE_URL}/v1/messages`;
  const secrets = [config.credential.value];

  return async (_lensId: string, prompt: Prompt): Promise<string> => {
    const body = JSON.stringify({
      model: config.model,
      max_tokens: config.maxTokens,
      // The shared half, marked cacheable. This is the ordering contract from
      // `Prompt` made real: identical bytes for every lens, sent first, so a
      // five-lens panel pays for the diff once.
      system: [{ type: 'text', text: prompt.shared, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: prompt.perLens }],
    });

    let response: Awaited<ReturnType<HttpPost>>;
    try {
      response = await post(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'anthropic-version': ANTHROPIC_VERSION,
          ...headersFor(config.credential),
        },
        body,
      });
    } catch (cause) {
      throw new Error(redact(`request failed: ${(cause as Error).message}`, secrets));
    }

    // Three outcomes, not two, and the panel reviewing this file on its first
    // real run is what found that. The previous version was
    // `await response.text().catch(() => '')` — a body that failed to arrive
    // became the empty string, which reached `textFrom` and was reported as
    // "response was not JSON": the same words a genuinely malformed body
    // produces. That collapses "the transport broke mid-response" and "the
    // provider sent us garbage" into one message, and they are fixed by
    // different people. It was also the exact catch-that-returns-a-default
    // this module warns against two functions down, in the file that warns
    // about it.
    let raw = '';
    let bodyError: string | undefined;
    try {
      raw = await response.text();
    } catch (cause) {
      bodyError = (cause as Error).message;
    }

    if (!response.ok) {
      // Status first. It is the more useful fact, and a body that also failed
      // to read is a detail on top of it rather than a replacement for it.
      throw new Error(
        redact(
          bodyError === undefined
            ? `HTTP ${String(response.status)}: ${raw.slice(0, 500)}`
            : `HTTP ${String(response.status)}, and the body could not be read: ${bodyError}`,
          secrets,
        ),
      );
    }

    if (bodyError !== undefined) {
      throw new Error(redact(`response body could not be read: ${bodyError}`, secrets));
    }

    try {
      return textFrom(raw);
    } catch (cause) {
      const message = redact((cause as Error).message, secrets);
      // Preserve the class through redaction rather than rewrap into a plain
      // Error: a NoRoomToAnswerError that lost its type here would still say
      // the right words but stop being distinguishable to anything reading
      // the exception itself, only to something re-parsing the message.
      throw cause instanceof NoRoomToAnswerError
        ? new NoRoomToAnswerError(message)
        : new Error(message);
    }
  };
}
