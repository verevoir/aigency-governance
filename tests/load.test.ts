import { describe, expect, it } from 'vitest';

import { loadLensSet, type ReadResult, type SourceReader } from '../src/review/load.js';

const VALID = JSON.stringify({
  version: 1,
  lenses: [{ id: 'correctness', title: 'Correctness', focus: 'does it do what it says' }],
});

function readerReturning(result: ReadResult): SourceReader {
  return () => Promise.resolve(result);
}

describe('loadLensSet', () => {
  it('loads a valid definition and echoes the source it came from', async () => {
    const outcome = await loadLensSet(
      'https://example.test/lenses.json',
      readerReturning({ kind: 'text', text: VALID }),
    );
    expect(outcome.kind).toBe('loaded');
    expect(outcome.source).toBe('https://example.test/lenses.json');
    if (outcome.kind !== 'loaded') throw new Error('unreachable');
    expect(outcome.set.lenses).toHaveLength(1);
  });

  it('passes the source it was given to the reader unchanged', async () => {
    const seen: string[] = [];
    const reader: SourceReader = (source) => {
      seen.push(source);
      return Promise.resolve({ kind: 'text', text: VALID });
    };
    await loadLensSet('./review/lenses.json', reader);
    expect(seen).toEqual(['./review/lenses.json']);
  });

  // The three unavailable reasons are kept apart on purpose. `missing` is a
  // configuration mistake, `unreachable` is an outage and `malformed` is a bad
  // commit — three different people fix them.
  it('reports a missing definition as missing', async () => {
    const outcome = await loadLensSet(
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

  it('reports an unreachable definition as unreachable', async () => {
    const outcome = await loadLensSet(
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

  it('reports a definition that will not parse as malformed, carrying the parser reason', async () => {
    const outcome = await loadLensSet(
      's',
      readerReturning({ kind: 'text', text: '{ "version": 1, "lenses": [] }' }),
    );
    expect(outcome.kind).toBe('unavailable');
    if (outcome.kind !== 'unavailable') throw new Error('unreachable');
    expect(outcome.why).toBe('malformed');
    expect(outcome.reason).toContain('a panel of none approves everything');
  });

  // A reader that throws reported nothing at all, which is not the same as
  // reporting absence — so it must not land on `missing`.
  it('treats a reader that throws as unreachable, not missing', async () => {
    const outcome = await loadLensSet('s', () => Promise.reject(new Error('socket hang up')));
    expect(outcome.kind).toBe('unavailable');
    if (outcome.kind !== 'unavailable') throw new Error('unreachable');
    expect(outcome.why).toBe('unreachable');
    expect(outcome.reason).toContain('socket hang up');
  });

  it('treats a reader that throws synchronously as unreachable', async () => {
    const outcome = await loadLensSet('s', () => {
      throw new Error('bad url');
    });
    expect(outcome.kind).toBe('unavailable');
    if (outcome.kind !== 'unavailable') throw new Error('unreachable');
    expect(outcome.why).toBe('unreachable');
  });

  // A reader that rejects with something other than an Error — a string, a
  // plain object — must not have its reason collapsed to "undefined". Casting
  // an unknown value straight to Error before reading `.message` does exactly
  // that: the actual thrown value is discarded and the reason reads like a
  // reason while carrying nothing.
  it('does not lose a rejection that was not an Error', async () => {
    const outcome = await loadLensSet('s', () => Promise.reject('socket hang up'));
    expect(outcome.kind).toBe('unavailable');
    if (outcome.kind !== 'unavailable') throw new Error('unreachable');
    expect(outcome.why).toBe('unreachable');
    expect(outcome.reason).toContain('socket hang up');
    expect(outcome.reason).not.toContain('undefined');
  });

  it('never throws for any input the reader can produce', async () => {
    const cases: ReadResult[] = [
      { kind: 'text', text: 'not json at all' },
      { kind: 'missing', reason: '' },
      { kind: 'unreachable', reason: '' },
    ];
    for (const result of cases) {
      await expect(loadLensSet('s', readerReturning(result))).resolves.toBeDefined();
    }
  });
});
