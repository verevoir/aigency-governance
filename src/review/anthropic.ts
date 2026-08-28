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
  readonly apiKey: string;
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

/**
 * A place to learn which model actually served a call, once a response says
 * so — separate from `AnthropicConfig.model` because that field is what was
 * ASKED for, dictated by the caller, and needs no capture; this is what
 * came back, which only a response can say. See `servedModelFrom` for why
 * the two can differ at all.
 *
 * One mutable slot, not a list, and overwritten rather than reconciled: a
 * panel makes several otherwise-identical calls for one run (one per lens),
 * and the ordinary case — every call served by the same snapshot — only
 * needs one value kept. A caller that wants to know whether every lens
 * agreed is not what this composition serves today; if calls ever did
 * disagree, the last one observed is what this reports, silently, and that
 * is a real limit worth knowing about rather than a claim of consensus.
 */
export interface ServedModelSink {
  value?: string;
}

const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';

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
 * The model that actually served a response, read from the response's own
 * top-level `model` field — present on Anthropic's Messages API responses
 * because a REQUESTED model name is not always what SERVED it: a name can
 * resolve, on the provider's side, to a specific dated snapshot, and only
 * the response says which one. This is exactly the case a silent downgrade
 * would look like from the caller's side — the request looked identical,
 * only the answer changed — which is why it is worth capturing at all.
 *
 * Returns `undefined` when the field is absent or not a string, deliberately
 * rather than falling back to the requested model: a response that does not
 * say cannot be turned into a claim that it agreed.
 */
function servedModelFrom(body: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  const document = parsed as { model?: unknown };
  return typeof document.model === 'string' && document.model !== '' ? document.model : undefined;
}

/**
 * A `Reviewer` backed by the Anthropic messages API.
 *
 * Every failure throws. `runPanel` turns a throw into `could_not_run` for that
 * lens and lets the others finish, which is exactly the handling this wants —
 * so there is nothing to gain here from catching, and something to lose: a
 * caught error that returned a string would be parsed as a reply.
 */
export function anthropicReviewer(
  config: AnthropicConfig,
  post: HttpPost,
  /**
   * Optional: a caller that wants to know which model actually served the
   * panel's calls passes a sink here and reads it back once the panel has
   * finished. Omitted entirely for anything that does not care — a test
   * driving this reviewer directly, for instance — rather than forcing every
   * caller to plumb one through.
   */
  servedModel?: ServedModelSink,
): Reviewer {
  const url = `${config.baseUrl ?? DEFAULT_BASE_URL}/v1/messages`;
  const secrets = [config.apiKey];

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
          'x-api-key': config.apiKey,
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

    // Captured here, before textFrom, and unconditionally on a readable
    // success body — even if textFrom goes on to throw (an empty reply, a
    // truncated one). Which model produced a broken reply is still real
    // information about that reply, and is not the reply's own fault to
    // withhold.
    if (servedModel !== undefined) {
      const observed = servedModelFrom(raw);
      if (observed !== undefined) {
        servedModel.value = observed;
      }
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
