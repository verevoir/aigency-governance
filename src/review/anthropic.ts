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
import type { Reviewer } from './panel.js';

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
  const content = (parsed as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    throw new Error('response carried no content array');
  }
  const text = (content as TextBlock[])
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text ?? '')
    .join('');
  if (text === '') {
    throw new Error(`response carried no text (${String(content.length)} block(s))`);
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

    const raw = await response.text().catch(() => '');
    if (!response.ok) {
      throw new Error(redact(`HTTP ${String(response.status)}: ${raw.slice(0, 500)}`, secrets));
    }

    try {
      return textFrom(raw);
    } catch (cause) {
      throw new Error(redact((cause as Error).message, secrets));
    }
  };
}
