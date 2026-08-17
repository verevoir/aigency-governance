import { describe, expect, it } from 'vitest';

import {
  CorpusError,
  parseCorpus,
  practiceSize,
  provision,
  type Practice,
} from '../src/practices/provision.js';
import type { ReadResult, SourceReader } from '../src/review/load.js';

// A bound large enough to be a no-op for tests that are not about bounding
// at all — chosen far above anything a small fixture corpus could produce.
const AMPLE_BOUND = 100_000;

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

function corpusOf(practices: readonly Practice[]): string {
  return JSON.stringify({ version: 1, practices });
}

function practiceOfSize(id: string, chars: number): Practice {
  // A single-character title, not an empty one — the corpus parser refuses
  // an empty title, since a title with nothing in it is the same defect
  // `parseLensSet` refuses for a lens. The title's one character is folded
  // into the requested size so the arithmetic in each test stays exact.
  return { id, title: 'T', body: 'x'.repeat(chars - 1) };
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

describe('practiceSize', () => {
  it('is the length of title and body, not the id', () => {
    const practice: Practice = { id: 'a-very-long-identifier', title: 'ab', body: 'cde' };
    expect(practiceSize(practice)).toBe(5);
  });
});

describe('provision', () => {
  it('returns matching practices', async () => {
    const outcome = await provision(
      'anonymous',
      's',
      readerReturning({ kind: 'text', text: ONE_PRACTICE }),
      AMPLE_BOUND,
    );
    expect(outcome.kind).toBe('practices');
    if (outcome.kind !== 'practices') throw new Error('unreachable');
    expect(outcome.practices).toHaveLength(1);
    expect(outcome.practices[0]?.id).toBe('no-anonymous-path');
    expect(outcome.elided).toBeUndefined();
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
      AMPLE_BOUND,
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
      AMPLE_BOUND,
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
      AMPLE_BOUND,
    );
    expect(outcome).toEqual({
      kind: 'unavailable',
      source: 's',
      why: 'unreachable',
      reason: 'ECONNREFUSED',
    });
  });

  // A reader that rejects with something other than an Error must not have
  // its reason collapsed to "undefined" — the same defect, and the same fix,
  // as loadLensSet's identical catch block.
  it('does not lose a rejection that was not an Error', async () => {
    const outcome = await provision('q', 's', () => Promise.reject('ECONNRESET'), AMPLE_BOUND);
    expect(outcome.kind).toBe('unavailable');
    if (outcome.kind !== 'unavailable') throw new Error('unreachable');
    expect(outcome.why).toBe('unreachable');
    expect(outcome.reason).toContain('ECONNRESET');
    expect(outcome.reason).not.toContain('undefined');
  });

  it('reports a corpus that will not parse as malformed, carrying the parser reason', async () => {
    const outcome = await provision(
      'q',
      's',
      readerReturning({ kind: 'text', text: '{ not json' }),
      AMPLE_BOUND,
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
      AMPLE_BOUND,
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
    await provision('anonymous', 's', counting, AMPLE_BOUND);
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
    await provision('anonymous', 's', fake.read, AMPLE_BOUND);
    expect(calls.reads).toBe(1);
    expect(calls.writes).toBe(0);
  });

  describe('bounding — measured against the payload, never against the count', () => {
    it('returns everything, with no elision marker, when the corpus fits under the bound', async () => {
      const practices = [
        practiceOfSize('common-a', 30),
        practiceOfSize('common-b', 30),
        practiceOfSize('common-c', 30),
      ];
      const outcome = await provision(
        'common',
        's',
        readerReturning({ kind: 'text', text: corpusOf(practices) }),
        1000,
      );
      expect(outcome.kind).toBe('practices');
      if (outcome.kind !== 'practices') throw new Error('unreachable');
      expect(outcome.practices).toHaveLength(3);
      expect(outcome.elided).toBeUndefined();
    });

    it('returns a prefix and names the count dropped and the source, when the corpus exceeds the bound', async () => {
      // Every practice matches "common"; three at 40 chars each. A bound of
      // 90 fits exactly two (80) and no more (120 would exceed 90).
      const practices = [
        practiceOfSize('common-a', 40),
        practiceOfSize('common-b', 40),
        practiceOfSize('common-c', 40),
      ];
      const outcome = await provision(
        'common',
        'https://example.test/practices.json',
        readerReturning({ kind: 'text', text: corpusOf(practices) }),
        90,
      );
      expect(outcome.kind).toBe('practices');
      if (outcome.kind !== 'practices') throw new Error('unreachable');
      expect(outcome.practices.map((practice) => practice.id)).toEqual(['common-a', 'common-b']);
      expect(outcome.elided).toEqual({
        omittedCount: 1,
        source: 'https://example.test/practices.json',
      });
    });

    // The chosen case for a single practice larger than the whole bound: it
    // is dropped, not truncated, and counted the same as any other omission.
    // Truncating would quote half a governance rule as though it were the
    // whole rule — a wrong answer shaped like a right one — which is worse
    // than an honest, visible omission naming that nothing fit.
    it('drops a single over-large practice entirely, rather than truncating it', async () => {
      const practices = [practiceOfSize('common-huge', 500)];
      const outcome = await provision(
        'common',
        's',
        readerReturning({ kind: 'text', text: corpusOf(practices) }),
        100,
      );
      expect(outcome).toEqual({
        kind: 'practices',
        practices: [],
        elided: { omittedCount: 1, source: 's' },
      });
    });

    // The one that matters most: the returned payload never exceeds the
    // bound, checked as an actual measurement of what came back rather than
    // by counting how many practices survived.
    it('never returns a payload whose measured size exceeds the bound', async () => {
      const practices = [
        practiceOfSize('common-a', 41),
        practiceOfSize('common-b', 41),
        practiceOfSize('common-c', 41),
        practiceOfSize('common-d', 41),
      ];
      const bound = 100;
      const outcome = await provision(
        'common',
        's',
        readerReturning({ kind: 'text', text: corpusOf(practices) }),
        bound,
      );
      expect(outcome.kind).toBe('practices');
      if (outcome.kind !== 'practices') throw new Error('unreachable');
      const measured = outcome.practices.reduce(
        (total, practice) => total + practiceSize(practice),
        0,
      );
      expect(measured).toBeLessThanOrEqual(bound);
      // And it is a real bound, not a vacuous one that happened to keep
      // everything: something was actually cut.
      expect(outcome.practices.length).toBeLessThan(practices.length);
      expect(outcome.elided?.omittedCount).toBe(practices.length - outcome.practices.length);
    });
  });
});
