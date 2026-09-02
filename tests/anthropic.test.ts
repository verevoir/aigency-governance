// No network, and no wire format to assert on any more — `@verevoir/llm`
// owns that now. Every case here runs through a fake `ChatFn` that records
// what it was handed and answers with whatever the case needs, so the
// assertions are about what THIS FILE hands to `chat()` and how it reads
// back what `chat()` can throw, not about bytes reaching a provider.
import { describe, expect, it } from 'vitest';

import {
  anthropicReviewer,
  redact,
  type AnthropicConfig,
  type ChatFn,
} from '../src/review/anthropic.js';
import { NoRoomToAnswerError } from '../src/review/panel.js';
import type { Prompt } from '../src/review/prompt.js';

const API_KEY = 'sk-ant-api03-THE-SECRET-VALUE-DO-NOT-LOG';

const CONFIG: AnthropicConfig = {
  apiKey: API_KEY,
  model: 'claude-pinned-for-this-test',
  maxTokens: 1234,
};

// Same config, deliberately with no `apiKey` key at all — not `apiKey:
// undefined`, which `exactOptionalPropertyTypes` treats as a different,
// disallowed shape. This is what `settings.ts` hands `anthropicReviewer`
// when no BYOK credential was resolved.
const NO_KEY_CONFIG: AnthropicConfig = {
  model: 'claude-pinned-for-this-test',
  maxTokens: 1234,
};

// Two markers, neither a substring of the other, so `not.toContain` in one
// direction cannot be satisfied by the other half's text.
const PROMPT: Prompt = {
  shared: 'SHARED-MARKER-6f21: the bar and the diff, identical for every lens',
  perLens: 'PERLENS-MARKER-9a04: the one dimension this reviewer reads along',
};

type CallArgs = Parameters<ChatFn>[0];

interface FakeCall {
  readonly impl: ChatFn;
  /** Every call, in order. */
  readonly sent: CallArgs[];
}

function fakeCall(respond: () => ReturnType<ChatFn>): FakeCall {
  const sent: CallArgs[] = [];
  return {
    sent,
    impl: (options) => {
      sent.push(options);
      return respond();
    },
  };
}

/** A successful `chat()` reply carrying the given text. */
function replying(content: string): FakeCall {
  return fakeCall(() =>
    Promise.resolve({
      content,
      usage: {
        provider: 'anthropic',
        model: 'claude-pinned-for-this-test',
        direction: 'reasoning',
        route: 'api-key',
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      },
      stopReason: 'end_turn',
    }),
  );
}

/** A `chat()` call that rejects with an Error carrying the given message. */
function throwing(message: string): FakeCall {
  return fakeCall(() => Promise.reject(new Error(message)));
}

/** The single call this reviewer made, or a failure saying it made none. */
function only(call: FakeCall): CallArgs {
  const first = call.sent[0];
  if (first === undefined) {
    throw new Error('chat() was never called');
  }
  return first;
}

/**
 * The error a call threw, or a failure saying it did not throw.
 *
 * Without the last line, every `not.toContain(API_KEY)` below would pass
 * against a transport that never threw at all — which is precisely the
 * condition those tests exist to rule out.
 */
async function failureOf(work: Promise<unknown>): Promise<Error> {
  try {
    await work;
  } catch (cause) {
    return cause as Error;
  }
  throw new Error('expected the call to throw, and it returned');
}

describe('what this file hands to chat()', () => {
  it('sends the shared half as systemPrompt, verbatim', async () => {
    const call = replying('ok');
    await anthropicReviewer(CONFIG, call.impl)('honesty', PROMPT);
    expect(only(call).systemPrompt).toBe(PROMPT.shared);
  });

  it('sends the per-lens half as the single user turn, verbatim', async () => {
    const call = replying('ok');
    await anthropicReviewer(CONFIG, call.impl)('honesty', PROMPT);
    expect(only(call).turns).toEqual([{ role: 'user', content: PROMPT.perLens }]);
  });

  // Both directions, and they are not the same assertion twice. Given the two
  // verbatim checks above, each kills a mutant the other cannot: this one
  // kills a systemPrompt that also carried the per-lens half, and the next
  // kills a turn that carried the shared half instead of (or as well as) the
  // per-lens one.
  it('keeps the per-lens half out of systemPrompt entirely', async () => {
    const call = replying('ok');
    await anthropicReviewer(CONFIG, call.impl)('honesty', PROMPT);
    expect(only(call).systemPrompt).not.toContain(PROMPT.perLens);
  });

  it('keeps the shared half out of the turns entirely', async () => {
    const call = replying('ok');
    await anthropicReviewer(CONFIG, call.impl)('honesty', PROMPT);
    expect(JSON.stringify(only(call).turns)).not.toContain(PROMPT.shared);
  });

  // Literals rather than the config fields, so a transport reading the wrong
  // field cannot make the assertion true by supplying its own answer.
  it('sends the configured model and token ceiling, unchanged', async () => {
    const call = replying('ok');
    await anthropicReviewer(CONFIG, call.impl)('honesty', PROMPT);
    expect(only(call).model).toBe('claude-pinned-for-this-test');
    expect(only(call).maxTokens).toBe(1234);
  });

  it('sends the configured apiKey as BYOK', async () => {
    const call = replying('ok');
    await anthropicReviewer(CONFIG, call.impl)('honesty', PROMPT);
    expect(only(call).apiKey).toBe(API_KEY);
  });

  // The load-bearing negative: `null`, not merely falsy or omitted, because
  // `null` is `chat()`'s own documented signal to fall back to a
  // platform-resolved credential (env `ANTHROPIC_API_KEY`, or —
  // preferentially — `CLAUDE_CODE_OAUTH_TOKEN`) rather than "no key was
  // asked for". An implementation that sent `undefined` here would still
  // typecheck and would still work against the real `chat()`, but would not
  // be this file DELIBERATELY choosing the documented signal — this test is
  // what pins that it is.
  it('sends null when no apiKey is configured, not merely omits the field', async () => {
    const call = replying('ok');
    await anthropicReviewer(NO_KEY_CONFIG, call.impl)('honesty', PROMPT);
    expect(only(call).apiKey).toBeNull();
  });

  it('returns the reply text and nothing else', async () => {
    const call = replying('VERDICT: approved');
    const reply = await anthropicReviewer(CONFIG, call.impl)('honesty', PROMPT);
    expect(reply).toBe('VERDICT: approved');
  });
});

describe('the api key', () => {
  it('never reaches the error from a chat() call that threw with the key in its message', async () => {
    const call = throwing(`upstream said: invalid key ${API_KEY}`);
    const error = await failureOf(anthropicReviewer(CONFIG, call.impl)('honesty', PROMPT));
    expect(error.message).not.toContain(API_KEY);
    // The mask proves the key was in the text and was removed, rather than
    // the message having been discarded wholesale.
    expect(error.message).toContain('***');
  });

  // The empty-secrets guard in `redact`, reached the way production reaches
  // it: no key configured means nothing to redact, and an error message must
  // survive untouched rather than being masked between every character.
  it('being unconfigured does not turn an error message into masks', async () => {
    const call = throwing('upstream exploded');
    const error = await failureOf(anthropicReviewer(NO_KEY_CONFIG, call.impl)('honesty', PROMPT));
    expect(error.message).toBe('upstream exploded');
    expect(error.message).not.toContain('***');
  });
});

describe('failures', () => {
  it('wraps a plain chat() failure as a plain Error, message preserved', async () => {
    const call = throwing('socket hang up');
    const error = await failureOf(anthropicReviewer(CONFIG, call.impl)('honesty', PROMPT));
    expect(error.message).toBe('socket hang up');
    expect(error).not.toBeInstanceOf(NoRoomToAnswerError);
  });

  it('wraps a non-Error throw using String()', async () => {
    const call = fakeCall(() => Promise.reject('a bare string rejection'));
    const error = await failureOf(anthropicReviewer(CONFIG, call.impl)('honesty', PROMPT));
    expect(error.message).toBe('a bare string rejection');
  });

  // The failure that actually happened on the first real run: four lenses
  // returned one thinking block and nothing else, having hit the token
  // ceiling before they wrote a word of the verdict. `@verevoir/llm`'s own
  // `chat()` reports this case with `stop_reason=max_tokens` in its error
  // message — recognised here, translated into the same precise class
  // `runPanel` has always depended on, so its handling did not need to
  // change when the transport did.
  it('throws NoRoomToAnswerError when chat() reports the reply was cut off by the token ceiling', async () => {
    const call = throwing('anthropic.chat: response had no text content (stop_reason=max_tokens)');
    const error = await failureOf(anthropicReviewer(CONFIG, call.impl)('honesty', PROMPT));
    expect(error).toBeInstanceOf(NoRoomToAnswerError);
    expect(error.message).toContain('max_tokens');
  });

  // The boundary, proven rather than assumed: a no-text failure for a
  // DIFFERENT stop reason must NOT get this class — it is not what
  // NoRoomToAnswerError is a claim about, and letting it through here would
  // make the class mean "chat() had no text", not "cut off before
  // answering".
  it('does not classify an unrelated "no text content" failure as NoRoomToAnswerError', async () => {
    const call = throwing('anthropic.chat: response had no text content (stop_reason=tool_use)');
    const error = await failureOf(anthropicReviewer(CONFIG, call.impl)('honesty', PROMPT));
    expect(error).not.toBeInstanceOf(NoRoomToAnswerError);
  });

  it('does not classify an ordinary transport failure as NoRoomToAnswerError', async () => {
    const call = throwing('fetch failed');
    const error = await failureOf(anthropicReviewer(CONFIG, call.impl)('honesty', PROMPT));
    expect(error).not.toBeInstanceOf(NoRoomToAnswerError);
  });

  // Redaction and classification are two different pieces of this function,
  // and this proves neither one silently disables the other: a
  // NoRoomToAnswerError must still have the key scrubbed out of it.
  it('redacts the api key from a NoRoomToAnswerError message too', async () => {
    const call = throwing(
      `response had no text content (stop_reason=max_tokens) for key ${API_KEY}`,
    );
    const error = await failureOf(anthropicReviewer(CONFIG, call.impl)('honesty', PROMPT));
    expect(error).toBeInstanceOf(NoRoomToAnswerError);
    expect(error.message).not.toContain(API_KEY);
    expect(error.message).toContain('***');
  });
});

describe('redact', () => {
  it('replaces every occurrence, not only the first', () => {
    expect(redact('a KEY b KEY c KEY', ['KEY'])).toBe('a *** b *** c ***');
  });

  it('replaces each secret it is given', () => {
    expect(redact('KEY and TOKEN together', ['KEY', 'TOKEN'])).toBe('*** and *** together');
  });

  it('leaves the text alone when the secret list is empty', () => {
    expect(redact('nothing to hide here', [])).toBe('nothing to hide here');
  });

  // An empty string splits between every character, so without the guard the
  // join would put a mask between each one and leave the message unreadable.
  it('ignores an empty-string secret rather than masking between every character', () => {
    expect(redact('abc', [''])).toBe('abc');
  });

  it('still redacts the real secrets when an empty one is in the list', () => {
    expect(redact('the KEY is here', ['', 'KEY'])).toBe('the *** is here');
  });

  // The documented limit, stated as a test rather than only as a comment: the
  // match is exact, so a key the provider echoed back in pieces or transformed
  // is not caught. This is the heuristic's known edge, not a bug it hides.
  it('does not catch a secret the text did not reproduce exactly', () => {
    expect(redact('key: sk-ant-01…truncated', ['sk-ant-0123456789'])).toBe(
      'key: sk-ant-01…truncated',
    );
  });
});
