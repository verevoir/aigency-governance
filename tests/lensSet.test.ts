import { describe, expect, it } from 'vitest';

import { LensSetError, parseLensSet } from '../src/review/lensSet.js';

const ONE_LENS = {
  version: 1,
  lenses: [{ id: 'correctness', title: 'Correctness', focus: 'does it do what it says' }],
};

function parse(document: unknown): ReturnType<typeof parseLensSet> {
  return parseLensSet(JSON.stringify(document));
}

// Every rejection below is asserted on its MESSAGE as well as its type. A
// suite that only checks `toThrow(LensSetError)` passes when the validator
// rejects the right document for the wrong reason, and refactoring the
// validator is exactly when that happens.
function expectRefusal(document: unknown, fragment: string): void {
  expect(() => parse(document)).toThrow(LensSetError);
  expect(() => parse(document)).toThrow(fragment);
}

describe('parseLensSet', () => {
  it('returns the declared lenses in declaration order', () => {
    const set = parse({
      version: 1,
      lenses: [
        { id: 'b-second', title: 'B', focus: 'bbb' },
        { id: 'a-first', title: 'A', focus: 'aaa' },
      ],
    });
    expect(set.lenses.map((lens) => lens.id)).toEqual(['b-second', 'a-first']);
    expect(set.version).toBe(1);
  });

  it('keeps title and focus verbatim', () => {
    const set = parse(ONE_LENS);
    expect(set.lenses[0]?.title).toBe('Correctness');
    expect(set.lenses[0]?.focus).toBe('does it do what it says');
  });

  it('refuses text that is not JSON', () => {
    expect(() => parseLensSet('{ not json')).toThrow(LensSetError);
    expect(() => parseLensSet('{ not json')).toThrow('not valid JSON');
  });

  it('refuses a JSON array at the top level', () => {
    expectRefusal([ONE_LENS], 'must be a JSON object');
  });

  it('refuses a JSON scalar at the top level', () => {
    expectRefusal('a lens set', 'must be a JSON object');
  });

  it('refuses null at the top level', () => {
    expectRefusal(null, 'must be a JSON object');
  });

  // A version the runner does not understand is refused rather than read
  // optimistically. The failing direction that matters is the HIGHER one: a
  // future document may add a field that changes what a lens means.
  it('refuses a version above the one it understands', () => {
    expectRefusal({ ...ONE_LENS, version: 2 }, 'this runner understands 1');
  });

  it('refuses a version below the one it understands', () => {
    expectRefusal({ ...ONE_LENS, version: 0 }, 'this runner understands 1');
  });

  it('refuses a missing version rather than assuming the current one', () => {
    expectRefusal({ lenses: ONE_LENS.lenses }, 'this runner understands 1');
  });

  it('refuses a version that is the right number as a string', () => {
    expectRefusal({ ...ONE_LENS, version: '1' }, 'this runner understands 1');
  });

  it('refuses a missing lenses array', () => {
    expectRefusal({ version: 1 }, 'must carry a `lenses` array');
  });

  it('refuses a lenses field that is an object', () => {
    expectRefusal({ version: 1, lenses: { correctness: {} } }, 'must carry a `lenses` array');
  });

  // The one that matters most: a panel of zero approves everything it is
  // shown, and does it in green.
  it('refuses an empty panel, naming why', () => {
    expectRefusal({ version: 1, lenses: [] }, 'a panel of none approves everything');
  });

  it('refuses a lens that is not an object', () => {
    expectRefusal({ version: 1, lenses: ['correctness'] }, 'lenses[0] must be an object');
  });

  it('refuses a lens that is an array', () => {
    expectRefusal({ version: 1, lenses: [[]] }, 'lenses[0] must be an object');
  });

  it('names the offending index, not just the failure', () => {
    expectRefusal(
      { version: 1, lenses: [ONE_LENS.lenses[0], { id: 'ok', title: '', focus: 'f' }] },
      'lenses[1].title',
    );
  });

  it('refuses an id that does not match the pattern', () => {
    expectRefusal(
      { version: 1, lenses: [{ id: 'Correctness', title: 'C', focus: 'f' }] },
      'must match',
    );
  });

  it('refuses an id that starts with a digit', () => {
    expectRefusal({ version: 1, lenses: [{ id: '1st', title: 'C', focus: 'f' }] }, 'must match');
  });

  it('refuses an empty id', () => {
    expectRefusal(
      { version: 1, lenses: [{ id: '', title: 'C', focus: 'f' }] },
      'lenses[0].id must be a non-empty string',
    );
  });

  // Two lenses under one id collapse in any map keyed by id — the panel loses
  // a member and still reports the count it was handed.
  it('refuses a duplicate id', () => {
    expectRefusal(
      {
        version: 1,
        lenses: [
          { id: 'correctness', title: 'A', focus: 'aaa' },
          { id: 'correctness', title: 'B', focus: 'bbb' },
        ],
      },
      'is declared more than once',
    );
  });

  it('refuses an empty title', () => {
    expectRefusal(
      { version: 1, lenses: [{ id: 'a', title: '', focus: 'f' }] },
      'title must be a non-empty string',
    );
  });

  it('refuses a whitespace-only focus', () => {
    expectRefusal(
      { version: 1, lenses: [{ id: 'a', title: 'A', focus: '   ' }] },
      'focus must be a non-empty string',
    );
  });

  it('refuses a numeric title rather than coercing it', () => {
    expectRefusal(
      { version: 1, lenses: [{ id: 'a', title: 7, focus: 'f' }] },
      'title must be a non-empty string',
    );
  });
});
