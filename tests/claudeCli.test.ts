// No subprocess, no CLI on PATH, no `@verevoir/llm/claude-cli` spawn: every
// case here drives `claudeCliReviewer` against a mocked `chat()`, so the
// assertions are about what this composition SENDS to `chat()` and how it
// turns what `chat()` throws into what `runPanel` (panel.ts) needs — never
// about whether a real `claude` binary is installed or logged in.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const chat = vi.fn();
vi.mock('@verevoir/llm/claude-cli', () => ({ chat: (...args: unknown[]) => chat(...args) }));

// Imported AFTER the mock is registered — vi.mock is hoisted above imports by
// vitest, so this ordering in the source is fine, but the mock must be
// declared before this module (which imports '@verevoir/llm/claude-cli' at
// its own top level) is loaded.
const { augmentBareExit, claudeCliReviewer } = await import('../src/review/claudeCli.js');
const { NoRoomToAnswerError } = await import('../src/review/panel.js');
type Prompt = import('../src/review/prompt.js').Prompt;

const PROMPT: Prompt = {
  shared: 'SHARED-MARKER-6f21: the bar and the diff, identical for every lens',
  perLens: 'PERLENS-MARKER-9a04: the one dimension this reviewer reads along',
};

beforeEach(() => {
  chat.mockReset();
});

/**
 * The error a call threw, or a failure saying it did not throw.
 *
 * `claudeCliReviewer()(...)` resolves `Promise<string>` — `.catch((e) => e as
 * Error)` on it types the whole chain as `Promise<string | Error>`, which does
 * not typecheck once `.message` is read back off it. This awaits properly and
 * returns what was actually thrown, typed as `Error` because it genuinely is
 * one by the time this returns: every case in this file rejects with either an
 * `Error` or a `NoRoomToAnswerError`, never a bare string.
 */
async function failureOf(work: Promise<unknown>): Promise<Error> {
  try {
    await work;
  } catch (cause) {
    return cause as Error;
  }
  throw new Error('expected the call to throw, and it returned');
}

describe('the wire format', () => {
  it('sends the shared half as the system prompt, verbatim', async () => {
    chat.mockResolvedValue({ content: 'VERDICT: approved', usage: {}, stopReason: 'end_turn' });
    await claudeCliReviewer()('honesty', PROMPT);
    expect(chat).toHaveBeenCalledWith(expect.objectContaining({ systemPrompt: PROMPT.shared }));
  });

  it('sends the per-lens half as the single user turn, verbatim', async () => {
    chat.mockResolvedValue({ content: 'VERDICT: approved', usage: {}, stopReason: 'end_turn' });
    await claudeCliReviewer()('honesty', PROMPT);
    expect(chat).toHaveBeenCalledWith(
      expect.objectContaining({ turns: [{ role: 'user', content: PROMPT.perLens }] }),
    );
  });

  it('sends no apiKey at all — this transport never carries a credential of its own', async () => {
    chat.mockResolvedValue({ content: 'VERDICT: approved', usage: {}, stopReason: 'end_turn' });
    await claudeCliReviewer()('honesty', PROMPT);
    const call = chat.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(call).toBeDefined();
    expect('apiKey' in (call ?? {})).toBe(false);
  });

  it('sends the configured model as `model`, when one is given', async () => {
    chat.mockResolvedValue({ content: 'VERDICT: approved', usage: {}, stopReason: 'end_turn' });
    await claudeCliReviewer({ model: 'claude-pinned-for-this-test' })('honesty', PROMPT);
    expect(chat).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'claude-pinned-for-this-test' }),
    );
  });

  it('sends no `model` field at all when none is configured — never an empty string', async () => {
    chat.mockResolvedValue({ content: 'VERDICT: approved', usage: {}, stopReason: 'end_turn' });
    await claudeCliReviewer()('honesty', PROMPT);
    const call = chat.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(call).toBeDefined();
    expect('model' in (call ?? {})).toBe(false);
  });

  it('returns the reply content and nothing else', async () => {
    chat.mockResolvedValue({
      content: 'VERDICT: rejected\nFINDING: [blocking] a real finding',
      usage: {},
      stopReason: 'end_turn',
    });
    const reply = await claudeCliReviewer()('honesty', PROMPT);
    expect(reply.content).toBe('VERDICT: rejected\nFINDING: [blocking] a real finding');
  });
});

describe('failures reach the caller as a throw, never as a returned reply', () => {
  it('rethrows a plain chat() failure unchanged when it already carries a reason', async () => {
    chat.mockRejectedValue(new Error('claude -p exited with code 1: some real stderr reason'));
    const error = await failureOf(claudeCliReviewer()('honesty', PROMPT));
    expect(error.message).toBe('claude -p exited with code 1: some real stderr reason');
  });

  it('leaves a spawn-level failure (claude missing from PATH) completely untouched', async () => {
    chat.mockRejectedValue(
      new Error('claudeCli.chat(): could not run the claude CLI — spawn claude ENOENT'),
    );
    const error = await failureOf(claudeCliReviewer()('honesty', PROMPT));
    expect(error.message).toBe(
      'claudeCli.chat(): could not run the claude CLI — spawn claude ENOENT',
    );
    // Distinct wording from the not-logged-in case below — a missing binary
    // and an unauthenticated one must never collapse onto the same message.
    expect(error.message).not.toContain('not logged into a subscription');
  });

  it('never returns a string — a rejection is always a throw, not a reply', async () => {
    chat.mockRejectedValue(new Error('claude -p exited with code 1'));
    const error = await failureOf(claudeCliReviewer()('honesty', PROMPT));
    expect(error).toBeInstanceOf(Error);
  });

  // The known gap this file discloses rather than papers over. See
  // claudeCli.ts's own header and augmentBareExit's doc comment.
  it('appends a labelled hint to the exact bare-exit shape the not-logged-in case produces', async () => {
    chat.mockRejectedValue(new Error('claude -p exited with code 1'));
    const error = await failureOf(claudeCliReviewer()('honesty', PROMPT));
    expect(error.message).toContain('claude -p exited with code 1');
    expect(error.message).toContain('not logged into a subscription');
    // Labelled as a guess, not asserted as fact — the reason this exists at
    // all is that the real reason could not be recovered.
    expect(error.message).toContain('GUESS');
    expect(error.message).not.toContain('DECODED');
  });

  it('appends the same hint to a bare signal-killed exit', async () => {
    chat.mockRejectedValue(new Error('claude -p was killed by signal SIGTERM'));
    const error = await failureOf(claudeCliReviewer()('honesty', PROMPT));
    expect(error.message).toContain('claude -p was killed by signal SIGTERM');
    expect(error.message).toContain('not logged into a subscription');
  });

  it('does not touch a message merely resembling the pattern with something extra', async () => {
    chat.mockRejectedValue(new Error('claude -p exited with code 1 and something else'));
    const error = await failureOf(claudeCliReviewer()('honesty', PROMPT));
    expect(error.message).toBe('claude -p exited with code 1 and something else');
  });

  it('a non-Error rejection is still stringified into a throw', async () => {
    chat.mockRejectedValue('a raw string rejection');
    const error = await failureOf(claudeCliReviewer()('honesty', PROMPT));
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('a raw string rejection');
  });
});

describe('augmentBareExit', () => {
  it('matches an ordinary bare exit code', () => {
    expect(augmentBareExit('claude -p exited with code 1')).toContain('not logged into');
  });

  it('matches a bare signal kill', () => {
    expect(augmentBareExit('claude -p was killed by signal SIGKILL')).toContain('not logged into');
  });

  it('leaves a message carrying stderr completely unchanged', () => {
    const message = 'claude -p exited with code 1: Not logged in · Please run /login';
    expect(augmentBareExit(message)).toBe(message);
  });

  it('leaves an unrelated message completely unchanged', () => {
    const message = 'claudeCli.chat(): could not run the claude CLI — spawn claude ENOENT';
    expect(augmentBareExit(message)).toBe(message);
  });

  it('is idempotent — augmenting an already-augmented message changes nothing further', () => {
    const once = augmentBareExit('claude -p exited with code 1');
    expect(augmentBareExit(once)).toBe(once);
  });

  // The permanence this hint's own wording now asserts — see the file
  // header and augmentBareExit's doc comment for why this is stated as a
  // standing operator decision, not a version detail awaiting a patch.
  it('states the gap is a standing decision, not a version detail awaiting a fix', () => {
    const message = augmentBareExit('claude -p exited with code 1');
    expect(message).toContain('will not be fixed or republished');
    expect(message).toContain('not just today');
  });
});

describe('a truncated reply is refused, not returned as though it were complete', () => {
  it('throws NoRoomToAnswerError when stopReason is max_tokens, even though content arrived', async () => {
    chat.mockResolvedValue({
      content: 'VERDICT: appro',
      usage: {
        outputTokens: 65536,
        inputTokens: 900,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
      stopReason: 'max_tokens',
    });

    const error = await failureOf(claudeCliReviewer()('honesty', PROMPT));

    expect(error).toBeInstanceOf(NoRoomToAnswerError);
    expect(error.message).toContain('no room to answer');
    expect(error.message).toContain('max_tokens');
    // The output tokens actually spent, and how much text arrived, both
    // named — stopReason and usage read and acted on, not pulled off the
    // reply and discarded.
    expect(error.message).toContain('65536');
    expect(error.message).toContain('14'); // 'VERDICT: appro'.length
  });

  it('is not fooled by an EMPTY reply at max_tokens either — the same case anthropic.ts catches', async () => {
    chat.mockResolvedValue({
      content: '',
      usage: {
        outputTokens: 65536,
        inputTokens: 900,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
      stopReason: 'max_tokens',
    });

    const error = await failureOf(claudeCliReviewer()('honesty', PROMPT));

    expect(error).toBeInstanceOf(NoRoomToAnswerError);
  });

  it('returns the content normally for any other stopReason', async () => {
    chat.mockResolvedValue({
      content: 'VERDICT: approved',
      usage: {
        outputTokens: 12,
        inputTokens: 900,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
      stopReason: 'end_turn',
    });

    const reply = await claudeCliReviewer()('honesty', PROMPT);

    expect(reply.content).toBe('VERDICT: approved');
  });

  it('does not fire on a stopReason that merely contains "max_tokens" as a substring', async () => {
    chat.mockResolvedValue({
      content: 'VERDICT: approved',
      usage: {
        outputTokens: 12,
        inputTokens: 900,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
      stopReason: 'not_max_tokens_really',
    });

    const reply = await claudeCliReviewer()('honesty', PROMPT);

    expect(reply.content).toBe('VERDICT: approved');
  });
});

// A sanity check that this suite is actually exercising the module under
// test's own exported symbols, and NoRoomToAnswerError travels unharmed
// alongside. This transport DOES construct one itself, for a truncated
// reply — see the 'a truncated reply is refused' block above — but that is a
// throw from inside claudeCliReviewer's own try, never a caught rejection.
// This test is the other direction: a NoRoomToAnswerError arriving AS a
// chat() rejection (in principle — chat() does not do this today, but
// nothing here should assume it never will) must not be swallowed or
// rewrapped into a plain Error on its way through the catch block.
describe('panel-level plumbing this file must not interfere with', () => {
  it('lets a NoRoomToAnswerError-shaped rejection pass through with its message intact', async () => {
    chat.mockRejectedValue(new NoRoomToAnswerError('no room to answer: stop_reason max_tokens'));
    const error = await failureOf(claudeCliReviewer()('honesty', PROMPT));
    expect(error.message).toContain('no room to answer');
    expect(error).toBeInstanceOf(NoRoomToAnswerError);
  });
});
