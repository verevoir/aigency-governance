import { describe, expect, it } from 'vitest';

import * as enactModule from '../src/practices/enact.js';
import { createPracticeGate, type Judge } from '../src/practices/enact.js';
import type { Practice } from '../src/practices/provision.js';
import type { ReadResult, SourceReader } from '../src/review/load.js';

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
  return { id, title: 'T', body: 'x'.repeat(chars - 1) };
}

function allow(): Judge {
  return () => Promise.resolve({ allow: true });
}

function refuseWith(reason: string): Judge {
  return () => Promise.resolve({ allow: false, reason });
}

describe('createPracticeGate', () => {
  it('returns both provision and enact, bound to the same source and reader', () => {
    const gate = createPracticeGate(
      's',
      readerReturning({ kind: 'missing', reason: 'x' }),
      AMPLE_BOUND,
    );
    expect(typeof gate.provision).toBe('function');
    expect(typeof gate.enact).toBe('function');
  });

  // The module-surface half of "there is no way to construct an enact
  // without a provision": the exported namespace has exactly one function,
  // the factory, and it is the only path to an `enact`. This is a real
  // runtime check of the export list — it is not the same claim as "nobody
  // can ever hold an `enact` without a `provision`", which is a stronger,
  // structural fact this test cannot reach: once a caller has destructured
  // `{ enact }` off a gate and discarded the `provision` reference, nothing
  // at runtime stops them keeping only the one. What this test does prove is
  // narrower and still real — there is no second export, no bare `enact`
  // function, and no factory that returns `enact` alone, so OBTAINING one in
  // the first place is never possible without obtaining `provision` in the
  // same call.
  it('exports exactly one function — there is no standalone enact to import', () => {
    const functionExports = Object.entries(enactModule)
      .filter(([, value]) => typeof value === 'function')
      .map(([name]) => name);
    expect(functionExports).toEqual(['createPracticeGate']);
  });

  describe('the three outcomes', () => {
    it('enacted: a matched practice, and the judge allows', async () => {
      const gate = createPracticeGate(
        's',
        readerReturning({ kind: 'text', text: ONE_PRACTICE }),
        AMPLE_BOUND,
      );
      const outcome = await gate.enact('no-anonymous-path', allow());
      expect(outcome.kind).toBe('enacted');
    });

    it('refused: a matched practice, and the judge refuses with a reason', async () => {
      const gate = createPracticeGate(
        's',
        readerReturning({ kind: 'text', text: ONE_PRACTICE }),
        AMPLE_BOUND,
      );
      const outcome = await gate.enact(
        'no-anonymous-path',
        refuseWith('does not satisfy the rule'),
      );
      expect(outcome.kind).toBe('refused');
      if (outcome.kind !== 'refused') throw new Error('unreachable');
      expect(outcome.reason).toBe('does not satisfy the rule');
    });

    it('could-not-consult: the corpus cannot be read, and the judge is never asked', async () => {
      let judgeCalls = 0;
      const judge: Judge = () => {
        judgeCalls += 1;
        return Promise.resolve({ allow: true });
      };
      const gate = createPracticeGate(
        's',
        readerReturning({ kind: 'unreachable', reason: 'ECONNREFUSED' }),
        AMPLE_BOUND,
      );
      const outcome = await gate.enact('anything', judge);
      expect(outcome.kind).toBe('could-not-consult');
      if (outcome.kind !== 'could-not-consult') throw new Error('unreachable');
      expect(outcome.why).toBe('unreachable');
      expect(outcome.reason).toBe('ECONNREFUSED');
      // The fail-closed half of item 2: not just that could-not-consult was
      // returned, but that the judge — which could only ever have said
      // "allow" here — was never given the chance to decide anything.
      expect(judgeCalls).toBe(0);
    });
  });

  // Item 3: the distinction the third outcome exists to protect. One line
  // apart in the code, a world apart in meaning.
  describe('nothing-matched vs could-not-consult', () => {
    it('nothing-matched proceeds to enactment — the bar was read and had nothing to say', async () => {
      let judgeCalls = 0;
      let seenPractices: readonly Practice[] | undefined;
      const judge: Judge = (_capability, practices) => {
        judgeCalls += 1;
        seenPractices = practices;
        return Promise.resolve({ allow: true });
      };
      const gate = createPracticeGate(
        's',
        readerReturning({ kind: 'text', text: ONE_PRACTICE }),
        AMPLE_BOUND,
      );
      const outcome = await gate.enact('a capability nothing governs', judge);
      expect(outcome.kind).toBe('enacted');
      expect(judgeCalls).toBe(1);
      expect(seenPractices).toEqual([]);
    });

    it('unavailable does not proceed — could-not-consult, distinct from nothing-matched', async () => {
      const gate = createPracticeGate(
        's',
        readerReturning({ kind: 'missing', reason: 'HTTP 404' }),
        AMPLE_BOUND,
      );
      const outcome = await gate.enact('anything', allow());
      expect(outcome.kind).toBe('could-not-consult');
      expect(outcome.kind).not.toBe('nothing-matched' as never);
    });
  });

  // Item 4: every outcome carries what was consulted.
  describe('the consulted record', () => {
    it('is present, and names the source and query, on enacted', async () => {
      const gate = createPracticeGate(
        's',
        readerReturning({ kind: 'text', text: ONE_PRACTICE }),
        AMPLE_BOUND,
      );
      const outcome = await gate.enact('no-anonymous-path', allow());
      expect(outcome.consulted.source).toBe('s');
      expect(outcome.consulted.query).toBe('no-anonymous-path');
      expect(outcome.consulted.practiceIds).toEqual(['no-anonymous-path']);
    });

    it('is present, and names the source and query, on refused', async () => {
      const gate = createPracticeGate(
        's',
        readerReturning({ kind: 'text', text: ONE_PRACTICE }),
        AMPLE_BOUND,
      );
      const outcome = await gate.enact('no-anonymous-path', refuseWith('no'));
      expect(outcome.consulted.source).toBe('s');
      expect(outcome.consulted.query).toBe('no-anonymous-path');
      expect(outcome.consulted.practiceIds).toEqual(['no-anonymous-path']);
    });

    it('is present, and names the source and query, on could-not-consult, even though nothing was read', async () => {
      const gate = createPracticeGate(
        'https://example.test/practices.json',
        readerReturning({ kind: 'missing', reason: 'HTTP 404' }),
        AMPLE_BOUND,
      );
      const outcome = await gate.enact('anything', allow());
      expect(outcome.consulted.source).toBe('https://example.test/practices.json');
      expect(outcome.consulted.query).toBe('anything');
      expect(outcome.consulted.practiceIds).toEqual([]);
    });

    it('records consideredCount on a nothing-matched enactment', async () => {
      const gate = createPracticeGate(
        's',
        readerReturning({ kind: 'text', text: ONE_PRACTICE }),
        AMPLE_BOUND,
      );
      const outcome = await gate.enact('a capability nothing governs', allow());
      expect(outcome.consulted.consideredCount).toBe(1);
    });

    // The elision flag surviving into the record when the bound drops
    // something — "approved against the bar" and "approved against as much
    // of the bar as fit" are different claims, and the record is what lets
    // a reader tell them apart later.
    it('carries elided when the bound drops a practice the judge never saw', async () => {
      const practices = [
        practiceOfSize('common-a', 40),
        practiceOfSize('common-b', 40),
        practiceOfSize('common-c', 40),
      ];
      let seenPractices: readonly Practice[] | undefined;
      const judge: Judge = (_capability, p) => {
        seenPractices = p;
        return Promise.resolve({ allow: true });
      };
      // A bound of 90 fits exactly two of three 40-char practices.
      const gate = createPracticeGate(
        's',
        readerReturning({ kind: 'text', text: corpusOf(practices) }),
        90,
      );
      const outcome = await gate.enact('common', judge);
      expect(outcome.kind).toBe('enacted');
      expect(seenPractices?.map((p) => p.id)).toEqual(['common-a', 'common-b']);
      expect(outcome.consulted.elided).toEqual({ omittedCount: 1, source: 's' });
      expect(outcome.consulted.practiceIds).toEqual(['common-a', 'common-b']);
    });

    it('carries no elided when nothing was dropped', async () => {
      const gate = createPracticeGate(
        's',
        readerReturning({ kind: 'text', text: ONE_PRACTICE }),
        AMPLE_BOUND,
      );
      const outcome = await gate.enact('no-anonymous-path', allow());
      expect(outcome.consulted.elided).toBeUndefined();
    });
  });
});
