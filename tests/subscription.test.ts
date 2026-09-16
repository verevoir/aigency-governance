// No real network call, no real credential: every case here drives
// `subscriptionReviewer` against a mocked `chat()` from
// `@verevoir/llm/anthropic`, so the assertions are about what this
// composition SENDS to `chat()` and how it turns what `chat()` returns or
// throws into what `runPanel` (panel.ts) needs — never about which
// credential actually authenticated, which is `@verevoir/llm`'s own,
// already-tested responsibility (see that package's `src/anthropic/auth.test.ts`).
import { beforeEach, describe, expect, it, vi } from 'vitest';

const chat = vi.fn();
vi.mock('@verevoir/llm/anthropic', () => ({ chat: (...args: unknown[]) => chat(...args) }));

// Imported AFTER the mock is registered — vi.mock is hoisted above imports
// by vitest, but this module imports '@verevoir/llm/anthropic' at its own
// top level, so the mock must be declared first in source order regardless.
const { EMPTY_REPLY_PATTERN, subscriptionReviewer } = await import('../src/review/subscription.js');
const { NoRoomToAnswerError } = await import('../src/review/panel.js');
type Prompt = import('../src/review/prompt.js').Prompt;

const PROMPT: Prompt = {
  shared: 'SHARED-MARKER-7d13: the bar and the diff, identical for every lens',
  perLens: 'PERLENS-MARKER-4e02: the one dimension this reviewer reads along',
};

function usage(outputTokens: number) {
  return { outputTokens, inputTokens: 900, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
}

async function failureOf(work: Promise<unknown>): Promise<Error> {
  try {
    await work;
  } catch (cause) {
    return cause as Error;
  }
  throw new Error('expected the call to throw, and it returned');
}

beforeEach(() => {
  chat.mockReset();
});

describe('the wire format', () => {
  it('sends the shared half as the system prompt, verbatim', async () => {
    chat.mockResolvedValue({
      content: 'VERDICT: approved',
      usage: usage(12),
      stopReason: 'end_turn',
    });
    await subscriptionReviewer()('honesty', PROMPT);
    expect(chat).toHaveBeenCalledWith(expect.objectContaining({ systemPrompt: PROMPT.shared }));
  });

  it('sends the per-lens half as the single user turn, verbatim', async () => {
    chat.mockResolvedValue({
      content: 'VERDICT: approved',
      usage: usage(12),
      stopReason: 'end_turn',
    });
    await subscriptionReviewer()('honesty', PROMPT);
    expect(chat).toHaveBeenCalledWith(
      expect.objectContaining({ turns: [{ role: 'user', content: PROMPT.perLens }] }),
    );
  });

  // The property that matters most about this route: it never forces a
  // credential — `@verevoir/llm/anthropic`'s own ambient resolution
  // (CLAUDE_CODE_OAUTH_TOKEN preferred, ANTHROPIC_API_KEY fallback) is what
  // decides which credential authenticates, not this file.
  it('sends no apiKey at all — credential resolution belongs to @verevoir/llm, not here', async () => {
    chat.mockResolvedValue({
      content: 'VERDICT: approved',
      usage: usage(12),
      stopReason: 'end_turn',
    });
    await subscriptionReviewer()('honesty', PROMPT);
    const call = chat.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(call).toBeDefined();
    expect('apiKey' in (call ?? {})).toBe(false);
  });

  it('sends the configured model as `model`, when one is given', async () => {
    chat.mockResolvedValue({
      content: 'VERDICT: approved',
      usage: usage(12),
      stopReason: 'end_turn',
    });
    await subscriptionReviewer({ model: 'claude-pinned-for-this-test' })('honesty', PROMPT);
    expect(chat).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'claude-pinned-for-this-test' }),
    );
  });

  it('sends no `model` field at all when none is configured — never an empty string', async () => {
    chat.mockResolvedValue({
      content: 'VERDICT: approved',
      usage: usage(12),
      stopReason: 'end_turn',
    });
    await subscriptionReviewer()('honesty', PROMPT);
    const call = chat.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(call).toBeDefined();
    expect('model' in (call ?? {})).toBe(false);
  });

  it('sends the configured maxTokens, when one is given', async () => {
    chat.mockResolvedValue({
      content: 'VERDICT: approved',
      usage: usage(12),
      stopReason: 'end_turn',
    });
    await subscriptionReviewer({ maxTokens: 8192 })('honesty', PROMPT);
    expect(chat).toHaveBeenCalledWith(expect.objectContaining({ maxTokens: 8192 }));
  });

  it('returns the reply content and nothing else', async () => {
    chat.mockResolvedValue({
      content: 'VERDICT: rejected\nFINDING: [blocking] a real finding',
      usage: usage(40),
      stopReason: 'end_turn',
    });
    const reply = await subscriptionReviewer()('honesty', PROMPT);
    expect(reply).toBe('VERDICT: rejected\nFINDING: [blocking] a real finding');
  });
});

describe('failures reach the caller as a throw, never as a returned reply', () => {
  it('rethrows an ordinary chat() failure with its message intact', async () => {
    chat.mockRejectedValue(new Error('fetch failed: getaddrinfo ENOTFOUND api.anthropic.com'));
    const error = await failureOf(subscriptionReviewer()('honesty', PROMPT));
    expect(error.message).toBe('fetch failed: getaddrinfo ENOTFOUND api.anthropic.com');
  });

  it('a non-Error rejection is still stringified into a throw', async () => {
    chat.mockRejectedValue('a raw string rejection');
    const error = await failureOf(subscriptionReviewer()('honesty', PROMPT));
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('a raw string rejection');
  });
});

describe('a truncated reply is refused, not returned as though it were complete', () => {
  it('throws NoRoomToAnswerError when stopReason is max_tokens, even though content arrived', async () => {
    chat.mockResolvedValue({
      content: 'VERDICT: appro',
      usage: usage(65536),
      stopReason: 'max_tokens',
    });

    const error = await failureOf(subscriptionReviewer()('honesty', PROMPT));

    expect(error).toBeInstanceOf(NoRoomToAnswerError);
    expect(error.message).toContain('no room to answer');
    expect(error.message).toContain('max_tokens');
    expect(error.message).toContain('65536');
    expect(error.message).toContain('14'); // 'VERDICT: appro'.length
  });

  it('returns the content normally for any other stopReason', async () => {
    chat.mockResolvedValue({
      content: 'VERDICT: approved',
      usage: usage(12),
      stopReason: 'end_turn',
    });

    const reply = await subscriptionReviewer()('honesty', PROMPT);

    expect(reply).toBe('VERDICT: approved');
  });

  it('does not fire on a stopReason that merely contains "max_tokens" as a substring', async () => {
    chat.mockResolvedValue({
      content: 'VERDICT: approved',
      usage: usage(12),
      stopReason: 'not_max_tokens_really',
    });

    const reply = await subscriptionReviewer()('honesty', PROMPT);

    expect(reply).toBe('VERDICT: approved');
  });

  // The case `@verevoir/llm/anthropic`'s own `chat()` does not return at
  // all — it throws a plain Error carrying the stop_reason in its message
  // (see that package's `chat()`, the "no text content" branch) rather than
  // resolving with empty content the way `claude-cli`'s `chat()` does. This
  // reviewer must recover the stop_reason from that thrown message and
  // still report NoRoomToAnswerError, not an undifferentiated throw.
  it('recognises an empty max_tokens reply from the THROWN shape chat() actually produces', async () => {
    chat.mockRejectedValue(
      new Error('anthropic.chat: response had no text content (stop_reason=max_tokens)'),
    );

    const error = await failureOf(subscriptionReviewer()('honesty', PROMPT));

    expect(error).toBeInstanceOf(NoRoomToAnswerError);
    expect(error.message).toContain('no room to answer');
    expect(error.message).toContain('max_tokens');
  });

  it('does NOT reclassify an empty reply for any other stop_reason as no-room-to-answer', async () => {
    chat.mockRejectedValue(
      new Error('anthropic.chat: response had no text content (stop_reason=tool_use)'),
    );

    const error = await failureOf(subscriptionReviewer()('honesty', PROMPT));

    expect(error).not.toBeInstanceOf(NoRoomToAnswerError);
    expect(error.message).toBe(
      'anthropic.chat: response had no text content (stop_reason=tool_use)',
    );
  });

  it('EMPTY_REPLY_PATTERN matches the exact shape chat() throws and nothing looser', () => {
    expect(
      EMPTY_REPLY_PATTERN.test(
        'anthropic.chat: response had no text content (stop_reason=max_tokens)',
      ),
    ).toBe(true);
    expect(EMPTY_REPLY_PATTERN.test('some other error entirely')).toBe(false);
  });
});
