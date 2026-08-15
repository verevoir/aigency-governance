// No network. Every case runs through a fake `HttpPost` that records what it
// was handed and answers with whatever the case needs, so the assertions are
// about the bytes this module produces and the way it reads bytes back.
//
// The wire-format group is the load-bearing one. `Prompt` documents an
// ordering contract — the shared half first, in a cacheable block, the
// per-lens half after it — that no type can enforce and that, until this
// module existed, nothing in the repository could check. These tests are the
// only guard that contract has.
import { describe, expect, it } from 'vitest';

import {
  anthropicReviewer,
  redact,
  type AnthropicConfig,
  type HttpPost,
} from '../src/review/anthropic.js';
import type { Prompt } from '../src/review/prompt.js';

const API_KEY = 'sk-ant-api03-THE-SECRET-VALUE-DO-NOT-LOG';

const CONFIG: AnthropicConfig = {
  apiKey: API_KEY,
  model: 'claude-pinned-for-this-test',
  maxTokens: 1234,
};

// Two markers, neither a substring of the other, so `not.toContain` in one
// direction cannot be satisfied by the other half's text.
const PROMPT: Prompt = {
  shared: 'SHARED-MARKER-6f21: the bar and the diff, identical for every lens',
  perLens: 'PERLENS-MARKER-9a04: the one dimension this reviewer reads along',
};

// Everything JSON has an opinion about: newlines, quotes, backslashes, fences
// and non-ASCII. Verbatim is asserted against this one, so a transport that
// trimmed, escaped twice or normalised would go red rather than pass on a
// prompt too tidy to catch it.
const AWKWARD: Prompt = {
  shared: '## The bar\n\n"quoted" \\ backslashed — em dash ✅\n\n```diff\n+const a = 1;\n```\n',
  perLens: '## Your lens: honesty\n\nfocus with a “curly” quote\t and a trailing space \n',
};

type PostResponse = Awaited<ReturnType<HttpPost>>;

interface Sent {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

interface FakePost {
  readonly impl: HttpPost;
  /** Every request, in order. */
  readonly sent: Sent[];
}

function fakePost(respond: () => Promise<PostResponse>): FakePost {
  const sent: Sent[] = [];
  return {
    sent,
    impl: (url, init) => {
      sent.push({ url, method: init.method, headers: init.headers, body: init.body });
      return respond();
    },
  };
}

function serving(status: number, body: string): FakePost {
  return fakePost(() =>
    Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      text: () => Promise.resolve(body),
    }),
  );
}

/** A 200 carrying a well-formed messages-API reply of one text block per argument. */
function replying(...texts: string[]): FakePost {
  return serving(200, JSON.stringify({ content: texts.map((text) => ({ type: 'text', text })) }));
}

interface SystemBlock {
  readonly type: string;
  readonly text: string;
  readonly cache_control?: { readonly type: string };
}

interface RequestBody {
  readonly model: string;
  readonly max_tokens: number;
  readonly system: readonly SystemBlock[];
  readonly messages: readonly { readonly role: string; readonly content: string }[];
}

/** The single request this reviewer sent, parsed. Throws if it sent none. */
function bodyOf(post: FakePost): RequestBody {
  const first = post.sent[0];
  if (first === undefined) {
    throw new Error('nothing was posted');
  }
  return JSON.parse(first.body) as RequestBody;
}

function only(post: FakePost): Sent {
  const first = post.sent[0];
  if (first === undefined) {
    throw new Error('nothing was posted');
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

describe('the wire format', () => {
  it('sends the shared half as the system block, verbatim', async () => {
    const post = replying('ok');
    await anthropicReviewer(CONFIG, post.impl)('honesty', AWKWARD);
    expect(bodyOf(post).system.map((block) => block.text)).toEqual([AWKWARD.shared]);
  });

  it('sends the per-lens half as the user message, verbatim', async () => {
    const post = replying('ok');
    await anthropicReviewer(CONFIG, post.impl)('honesty', AWKWARD);
    expect(bodyOf(post).messages).toEqual([{ role: 'user', content: AWKWARD.perLens }]);
  });

  // Both directions, and they are not the same assertion twice. Given the two
  // verbatim checks above, each kills a mutant the other cannot: this one
  // kills a second system block carrying the per-lens half, and the next kills
  // a second message — or a message content — carrying the shared half. Each
  // also asserts its own half IS present, so neither can pass by an empty
  // container.
  it('keeps the per-lens half out of the system block entirely', async () => {
    const post = replying('ok');
    await anthropicReviewer(CONFIG, post.impl)('honesty', PROMPT);
    const system = JSON.stringify(bodyOf(post).system);
    expect(system).toContain(PROMPT.shared);
    expect(system).not.toContain(PROMPT.perLens);
  });

  it('keeps the shared half out of the messages entirely', async () => {
    const post = replying('ok');
    await anthropicReviewer(CONFIG, post.impl)('honesty', PROMPT);
    const messages = JSON.stringify(bodyOf(post).messages);
    expect(messages).toContain(PROMPT.perLens);
    expect(messages).not.toContain(PROMPT.shared);
  });

  // The whole reason for the split: the shared prefix is only worth being
  // identical if it is marked for caching.
  it('marks the shared block cacheable', async () => {
    const post = replying('ok');
    await anthropicReviewer(CONFIG, post.impl)('honesty', PROMPT);
    const system = bodyOf(post).system;
    expect(system).toHaveLength(1);
    expect(system[0]?.type).toBe('text');
    expect(system[0]?.cache_control).toEqual({ type: 'ephemeral' });
  });

  // Literals rather than the config fields, so a transport reading the wrong
  // field cannot make the assertion true by supplying its own answer.
  it('sends the configured model and token ceiling, unchanged', async () => {
    const post = replying('ok');
    await anthropicReviewer(CONFIG, post.impl)('honesty', PROMPT);
    const body = bodyOf(post);
    expect(body.model).toBe('claude-pinned-for-this-test');
    expect(body.max_tokens).toBe(1234);
  });

  it('posts to /v1/messages on the provider host by default', async () => {
    const post = replying('ok');
    await anthropicReviewer(CONFIG, post.impl)('honesty', PROMPT);
    expect(only(post).url).toBe('https://api.anthropic.com/v1/messages');
    expect(only(post).method).toBe('POST');
  });

  it('posts to the configured baseUrl when one is given', async () => {
    const post = replying('ok');
    const config = { ...CONFIG, baseUrl: 'https://proxy.test/anthropic' };
    await anthropicReviewer(config, post.impl)('honesty', PROMPT);
    expect(only(post).url).toBe('https://proxy.test/anthropic/v1/messages');
  });

  it('carries the api version and a JSON content type in the headers', async () => {
    const post = replying('ok');
    await anthropicReviewer(CONFIG, post.impl)('honesty', PROMPT);
    expect(only(post).headers['anthropic-version']).toBe('2023-06-01');
    expect(only(post).headers['content-type']).toBe('application/json');
  });

  it('returns the reply text and nothing else', async () => {
    const post = replying('VERDICT: approved');
    const reply = await anthropicReviewer(CONFIG, post.impl)('honesty', PROMPT);
    expect(reply).toBe('VERDICT: approved');
  });
});

describe('the api key', () => {
  // The positive control. Without it the two redaction tests below could both
  // pass on a transport that never sent the key anywhere — nothing to leak is
  // not the same property as nothing leaked.
  it('is sent in the request headers', async () => {
    const post = replying('ok');
    await anthropicReviewer(CONFIG, post.impl)('honesty', PROMPT);
    expect(only(post).headers['x-api-key']).toBe(API_KEY);
  });

  it('never reaches the error from a request that threw with the key in its message', async () => {
    const post = fakePost(() => Promise.reject(new Error(`connect failed for key ${API_KEY}`)));
    const error = await failureOf(anthropicReviewer(CONFIG, post.impl)('honesty', PROMPT));
    expect(error.message).toContain('request failed');
    expect(error.message).not.toContain(API_KEY);
    // The mask proves the key was in the text and was removed, rather than the
    // message having been discarded wholesale.
    expect(error.message).toContain('***');
  });

  it('never reaches the error from a non-ok response whose body echoed it back', async () => {
    const post = serving(401, `{"error":{"message":"invalid x-api-key: ${API_KEY}"}}`);
    const error = await failureOf(anthropicReviewer(CONFIG, post.impl)('honesty', PROMPT));
    expect(error.message).toContain('401');
    expect(error.message).not.toContain(API_KEY);
    expect(error.message).toContain('***');
  });

  // The empty-secret guard in `redact`, reached the way production reaches it.
  // Without the guard, an unset key masks between every character and the
  // reason the call failed is destroyed.
  it('being empty does not turn an error message into masks', async () => {
    const post = serving(500, 'upstream exploded');
    const reviewer = anthropicReviewer({ ...CONFIG, apiKey: '' }, post.impl);
    const error = await failureOf(reviewer('honesty', PROMPT));
    expect(error.message).toContain('upstream exploded');
    expect(error.message).not.toContain('***');
  });
});

describe('failures', () => {
  it('throws with the status and the body when the response is not ok', async () => {
    const post = serving(529, 'overloaded_error');
    const error = await failureOf(anthropicReviewer(CONFIG, post.impl)('honesty', PROMPT));
    expect(error.message).toContain('529');
    expect(error.message).toContain('overloaded_error');
  });

  it('throws that the response was not JSON when it was not', async () => {
    const post = serving(200, '<html>502 Bad Gateway</html>');
    const error = await failureOf(anthropicReviewer(CONFIG, post.impl)('honesty', PROMPT));
    expect(error.message).toBe('response was not JSON');
  });

  it('throws when the body carries no content array', async () => {
    const post = serving(200, '{"id":"msg_01","role":"assistant"}');
    const error = await failureOf(anthropicReviewer(CONFIG, post.impl)('honesty', PROMPT));
    expect(error.message).toBe('response carried no content array');
  });

  // A string `content` is JSON, and is not an array. Reading it as one would
  // give a per-character walk rather than an error.
  it('throws when content is present but is not an array', async () => {
    const post = serving(200, '{"content":"approved"}');
    const error = await failureOf(anthropicReviewer(CONFIG, post.impl)('honesty', PROMPT));
    expect(error.message).toBe('response carried no content array');
  });

  it('throws naming the block count when content is empty', async () => {
    const post = serving(200, '{"content":[]}');
    const error = await failureOf(anthropicReviewer(CONFIG, post.impl)('honesty', PROMPT));
    expect(error.message).toBe('response carried no text: 0 block(s) [], stop_reason absent');
  });

  // The case the count is in the message for: blocks arrived, none was text.
  // Returning `''` here would reach `parseReply` and be reported as an empty
  // reply, which blames the model for a reply it did send.
  it('throws rather than returning empty when the only block is a tool_use', async () => {
    const post = serving(200, '{"content":[{"type":"tool_use","id":"tu_1"}]}');
    const error = await failureOf(anthropicReviewer(CONFIG, post.impl)('honesty', PROMPT));
    expect(error.message).toBe(
      'response carried no text: 1 block(s) [tool_use], stop_reason absent',
    );
  });

  // The failure that actually happened on the first real run: four lenses
  // returned one thinking block and nothing else, having hit the token
  // ceiling before they wrote a word of the verdict. The old message said
  // "no text (1 block(s))" for this AND for the tool_use case above, so the
  // run could not be diagnosed from its own output. Both distinguishing
  // fields are asserted, because either one alone leaves the two cases
  // telling the same story.
  it('names the block kind and the stop reason for a truncated thinking block', async () => {
    const post = serving(200, '{"content":[{"type":"thinking"}],"stop_reason":"max_tokens"}');
    const error = await failureOf(anthropicReviewer(CONFIG, post.impl)('honesty', PROMPT));
    expect(error.message).toContain('thinking');
    expect(error.message).toContain('max_tokens');
  });

  it('joins two text blocks into one reply', async () => {
    const post = replying('VERDICT: rejected\n', 'FINDING: the second block');
    const reply = await anthropicReviewer(CONFIG, post.impl)('honesty', PROMPT);
    expect(reply).toBe('VERDICT: rejected\nFINDING: the second block');
  });

  // The middle block carries a `text` field of its own, and that is the point:
  // with a block that has none, dropping the `type === 'text'` filter still
  // produces the right answer via `?? ''`, and this test would pass against a
  // transport that concatenated every block it was sent.
  it('skips a non-text block even when that block carries text of its own', async () => {
    const post = serving(
      200,
      JSON.stringify({
        content: [
          { type: 'text', text: 'before ' },
          { type: 'thinking', thinking: 'private', text: 'NOT-FOR-THE-PARSER' },
          { type: 'text', text: 'after' },
        ],
      }),
    );
    const reply = await anthropicReviewer(CONFIG, post.impl)('honesty', PROMPT);
    expect(reply).toBe('before after');
    expect(reply).not.toContain('NOT-FOR-THE-PARSER');
  });

  // The `typeof block.text === 'string'` half of the filter. Without it, `join`
  // coerces and a reply of `42` reaches the parser as if the model had said it.
  it('throws rather than coercing a text block whose text is not a string', async () => {
    const post = serving(200, '{"content":[{"type":"text","text":42}]}');
    const error = await failureOf(anthropicReviewer(CONFIG, post.impl)('honesty', PROMPT));
    expect(error.message).toBe('response carried no text: 1 block(s) [text], stop_reason absent');
  });

  // The 500-character cap on an echoed error body. Without it a provider that
  // returns the whole request in its error puts the whole request in ours.
  it('truncates a long error body rather than echoing all of it', async () => {
    const post = serving(500, `${'A'.repeat(600)}TAIL-MARKER`);
    const error = await failureOf(anthropicReviewer(CONFIG, post.impl)('honesty', PROMPT));
    expect(error.message).toContain('AAAA');
    expect(error.message).not.toContain('TAIL-MARKER');
    expect(error.message.length).toBeLessThan(600);
  });

  // The regression test for the defect the review panel found in this very
  // file. This test previously pinned the WRONG behaviour, with a comment
  // explaining that it was doing so: `.catch(() => '')` turned a body that
  // never arrived into the empty string, which read as `response was not
  // JSON`. It now pins the right one, and the second assertion is the
  // load-bearing half — without it a transport that went back to swallowing
  // the error could satisfy a looser check, and the whole point is that the
  // broken transport and the malformed body no longer say the same thing.
  it('reports a 2xx body that failed to read as unreadable, not as non-JSON', async () => {
    const post = fakePost(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.reject(new Error('aborted mid-body')),
      }),
    );
    const error = await failureOf(anthropicReviewer(CONFIG, post.impl)('honesty', PROMPT));
    expect(error.message).toBe('response body could not be read: aborted mid-body');
    expect(error.message).not.toContain('response was not JSON');
  });

  // The same failure on the other side of the ok check, which is a separate
  // branch and would otherwise be the one piece of this fix with no test.
  // The status is the more useful fact and must survive: an unreadable body
  // on a 429 is still a 429, and reporting only the read failure would lose
  // the reason to back off.
  it('keeps the status when a non-ok response also fails to read', async () => {
    const post = fakePost(() =>
      Promise.resolve({
        ok: false,
        status: 429,
        text: () => Promise.reject(new Error('aborted mid-body')),
      }),
    );
    const error = await failureOf(anthropicReviewer(CONFIG, post.impl)('honesty', PROMPT));
    expect(error.message).toContain('429');
    expect(error.message).toContain('aborted mid-body');
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
