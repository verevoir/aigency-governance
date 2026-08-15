import { describe, expect, it } from 'vitest';

import { CorpusError, parseCorpus, provision } from '../src/practices/provision.js';
import type { ReadResult, SourceReader } from '../src/review/load.js';

const ONE_PRACTICE = JSON.stringify({
  version: 1,
  practices: [
    {
      id: 'no-anonymous-path',
      title: 'No anonymous path',
      body: 'Only a present credential yields headers.',
    },
  ],
});

function readerReturning(result: ReadResult): SourceReader {
  return () => Promise.resolve(result);
}

describe('parseCorpus', () => {
  it('parses a well-formed corpus', () => {
    const corpus = parseCorpus(ONE_PRACTICE);
    expect(corpus.practices).toHaveLength(1);
    expect(corpus.practices[0]?.id).toBe('no-anonymous-path');
  });

  // The one that matters most: a corpus of none matches nothing, for every
  // query, forever — which is indistinguishable from a query that genuinely
  // found nothing in a real corpus. Refused here rather than discovered as a
  // suspiciously permanent nothing-matched.
  it('refuses an empty corpus, naming why', () => {
    const empty = JSON.stringify({ version: 1, practices: [] });
    expect(() => parseCorpus(empty)).toThrow(CorpusError);
    expect(() => parseCorpus(empty)).toThrow('an empty corpus matches nothing');
  });

  it('refuses a duplicate id', () => {
    const dup = JSON.stringify({
      version: 1,
      practices: [
        { id: 'a', title: 'A', body: 'x' },
        { id: 'a', title: 'B', body: 'y' },
      ],
    });
    expect(() => parseCorpus(dup)).toThrow('is declared more than once');
  });
});

describe('provision', () => {
  it('returns matching practices', async () => {
    const outcome = await provision(
      'anonymous',
      's',
      readerReturning({ kind: 'text', text: ONE_PRACTICE }),
    );
    expect(outcome.kind).toBe('practices');
    if (outcome.kind !== 'practices') throw new Error('unreachable');
    expect(outcome.practices).toHaveLength(1);
    expect(outcome.practices[0]?.id).toBe('no-anonymous-path');
  });

  // B4: an empty answer names its own search. "No practices matched" and "no
  // practices matched across the 47 in the corpus at this URL" are different
  // answers, and only the second lets a caller tell an empty corpus apart
  // from a query that was simply wrong.
  it('reports nothing-matched carrying the query, the source and how many were considered', async () => {
    const outcome = await provision(
      'nothing here matches this',
      'https://example.test/practices.json',
      readerReturning({ kind: 'text', text: ONE_PRACTICE }),
    );
    expect(outcome).toEqual({
      kind: 'nothing-matched',
      query: 'nothing here matches this',
      source: 'https://example.test/practices.json',
      consideredCount: 1,
    });
  });

  it('reports a missing corpus as missing', async () => {
    const outcome = await provision(
      'q',
      's',
      readerReturning({ kind: 'missing', reason: 'HTTP 404' }),
    );
    expect(outcome).toEqual({
      kind: 'unavailable',
      source: 's',
      why: 'missing',
      reason: 'HTTP 404',
    });
  });

  it('reports an unreachable corpus as unreachable', async () => {
    const outcome = await provision(
      'q',
      's',
      readerReturning({ kind: 'unreachable', reason: 'ECONNREFUSED' }),
    );
    expect(outcome).toEqual({
      kind: 'unavailable',
      source: 's',
      why: 'unreachable',
      reason: 'ECONNREFUSED',
    });
  });

  it('reports a corpus that will not parse as malformed, carrying the parser reason', async () => {
    const outcome = await provision(
      'q',
      's',
      readerReturning({ kind: 'text', text: '{ not json' }),
    );
    expect(outcome.kind).toBe('unavailable');
    if (outcome.kind !== 'unavailable') throw new Error('unreachable');
    expect(outcome.why).toBe('malformed');
    expect(outcome.reason).toContain('not valid JSON');
  });

  // The failure `nothing-matched` carrying its own search exists to prevent:
  // an empty corpus is refused at parse time, never answered as though the
  // query simply found nothing in a real one.
  it('reports an empty corpus as malformed, not as nothing-matched', async () => {
    const outcome = await provision(
      'anything',
      's',
      readerReturning({ kind: 'text', text: JSON.stringify({ version: 1, practices: [] }) }),
    );
    expect(outcome.kind).toBe('unavailable');
    if (outcome.kind !== 'unavailable') throw new Error('unreachable');
    expect(outcome.why).toBe('malformed');
    expect(outcome.reason).toContain('an empty corpus matches nothing');
  });

  it('calls the reader exactly once', async () => {
    let calls = 0;
    const counting: SourceReader = () => {
      calls += 1;
      return Promise.resolve({ kind: 'text', text: ONE_PRACTICE });
    };
    await provision('anonymous', 's', counting);
    expect(calls).toBe(1);
  });

  // Cheapness stated in a comment is a wish; asserted against a fake that
  // could offer a write and is never given the chance to, it is a property.
  // The fake bundles both capabilities; only `.read` is ever bound into what
  // `provision` receives. This documents — and would catch a regression in —
  // a signature that is read-only by construction, not by convention: there
  // is no reference through which `provision` could reach `fake.write` even
  // if it wanted to.
  it('touches no writing port, even when the fake next to the reader has one', async () => {
    const calls = { reads: 0, writes: 0 };
    const fake = {
      read: (): Promise<ReadResult> => {
        calls.reads += 1;
        return Promise.resolve({ kind: 'text', text: ONE_PRACTICE });
      },
      write: (): Promise<void> => {
        calls.writes += 1;
        return Promise.resolve();
      },
    };
    await provision('anonymous', 's', fake.read);
    expect(calls.reads).toBe(1);
    expect(calls.writes).toBe(0);
  });
});
