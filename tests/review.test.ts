// Proves `cli/review.ts`'s own dispatch — `reviewerFor` — actually routes to
// the right transport and forwards what `settings` said, not merely that
// constructing it doesn't throw. The `cli` gate's own scenarios
// (`scripts/check-cli.mjs`) all drive an EMPTY diff through the real
// compiled binary, which makes `runReview` return before `review()` (the
// `Reviewer` `reviewerFor` builds) is ever called — they prove
// `resolveSettings` reaches `ready`/`keyless` and that construction doesn't
// throw at import time, nothing about which reviewer actually gets built or
// what it sends once invoked. This file closes that gap directly: a stubbed
// global `fetch` stands in for the billed route's one real seam, and a
// mocked `@verevoir/llm/claude-cli` stands in for the keyless route's —
// the same mock shape `tests/claudeCli.test.ts` uses, so a divergence
// between what that suite proves about `claudeCliReviewer` alone and what
// actually reaches it through `reviewerFor` would show up here, not there.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const chat = vi.fn();
vi.mock('@verevoir/llm/claude-cli', () => ({ chat: (...args: unknown[]) => chat(...args) }));

// Imported after the mock is registered — vi.mock is hoisted above imports
// by vitest, but this module (via claudeCli.ts) imports
// '@verevoir/llm/claude-cli' at its own top level, so the mock must be
// declared first in source order regardless.
const { reviewerFor } = await import('../src/cli/review.js');
type Prompt = import('../src/review/prompt.js').Prompt;
type ReviewSettings = import('../src/review/settings.js').ReviewSettings;

const PROMPT: Prompt = {
  shared: 'SHARED-MARKER-2b71: the bar and the diff, identical for every lens',
  perLens: 'PERLENS-MARKER-9c04: the one dimension this reviewer reads along',
};

const BILLED: ReviewSettings = {
  route: 'billed',
  apiKey: 'sk-ant-review-dot-ts-test-marker',
  model: 'claude-review-dot-ts-pinned-model',
  maxTokens: 4321,
  lensSource: 'https://lenses.test/set.json',
};

const KEYLESS: ReviewSettings = {
  route: 'keyless',
  model: 'claude-review-dot-ts-pinned-model',
  maxTokens: 4321,
  lensSource: 'https://lenses.test/set.json',
};

function approvedTextResponse(): {
  ok: boolean;
  status: number;
  text(): Promise<string>;
} {
  return {
    ok: true,
    status: 200,
    text: () =>
      Promise.resolve(JSON.stringify({ content: [{ type: 'text', text: 'VERDICT: approved' }] })),
  };
}

beforeEach(() => {
  chat.mockReset();
  vi.unstubAllGlobals();
});

describe('reviewerFor, given billed settings', () => {
  it('builds a reviewer that calls fetch, not chat()', async () => {
    const fetchMock = vi.fn().mockResolvedValue(approvedTextResponse());
    vi.stubGlobal('fetch', fetchMock);

    const reply = await reviewerFor(BILLED)('honesty', PROMPT);

    expect(reply).toBe('VERDICT: approved');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(chat).not.toHaveBeenCalled();
  });

  it('sends the configured apiKey as the x-api-key header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(approvedTextResponse());
    vi.stubGlobal('fetch', fetchMock);

    await reviewerFor(BILLED)('honesty', PROMPT);

    const [, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(init.headers['x-api-key']).toBe(BILLED.apiKey);
  });

  it('sends the configured model and maxTokens in the request body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(approvedTextResponse());
    vi.stubGlobal('fetch', fetchMock);

    await reviewerFor(BILLED)('honesty', PROMPT);

    const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(init.body) as { model: string; max_tokens: number };
    expect(body.model).toBe(BILLED.model);
    expect(body.max_tokens).toBe(BILLED.maxTokens);
  });

  it('posts to the real Anthropic Messages endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(approvedTextResponse());
    vi.stubGlobal('fetch', fetchMock);

    await reviewerFor(BILLED)('honesty', PROMPT);

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
  });
});

describe('reviewerFor, given keyless settings', () => {
  it('builds a reviewer that calls chat(), not fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    chat.mockResolvedValue({ content: 'VERDICT: approved', usage: {}, stopReason: 'end_turn' });

    const reply = await reviewerFor(KEYLESS)('honesty', PROMPT);

    expect(reply).toBe('VERDICT: approved');
    expect(chat).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forwards the configured model as chat()’s model field', async () => {
    chat.mockResolvedValue({ content: 'VERDICT: approved', usage: {}, stopReason: 'end_turn' });

    await reviewerFor(KEYLESS)('honesty', PROMPT);

    expect(chat).toHaveBeenCalledWith(expect.objectContaining({ model: KEYLESS.model }));
  });

  // The property that matters most about this route: it must never carry an
  // apiKey through, whatever `settings` happened to hold (a `keyless`
  // settings object has no `apiKey` field at all — the type forbids it — but
  // this is the behavioural half of that guarantee, proven against the call
  // reviewerFor actually makes).
  it('never sends an apiKey', async () => {
    chat.mockResolvedValue({ content: 'VERDICT: approved', usage: {}, stopReason: 'end_turn' });

    await reviewerFor(KEYLESS)('honesty', PROMPT);

    const call = chat.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(call).toBeDefined();
    expect('apiKey' in (call ?? {})).toBe(false);
  });

  it('sends the shared and per-lens prompt halves exactly as the billed route does', async () => {
    chat.mockResolvedValue({ content: 'VERDICT: approved', usage: {}, stopReason: 'end_turn' });

    await reviewerFor(KEYLESS)('honesty', PROMPT);

    expect(chat).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPrompt: PROMPT.shared,
        turns: [{ role: 'user', content: PROMPT.perLens }],
      }),
    );
  });
});
