import { describe, expect, it } from 'vitest';

import { partition } from '../eval/partition.mjs';
import { parseLensSet } from '../src/review/lensSet.js';
import { parseCorpus } from '../src/practices/provision.js';

// Ids given out of order deliberately — sorting by id, not by input order,
// is exactly what the determinism guarantee below depends on.
const IDS = ['p-05', 'p-01', 'p-03', 'p-02', 'p-04'];

function practice(id) {
  return { id, title: `Title for ${id}`, body: `BODY-${id}` };
}

const PRACTICES = IDS.map(practice);

// The fixtures above must be practices the REAL corpus parser would accept,
// not just objects this test happens to like the shape of — round-tripped
// through parseCorpus itself, the same discipline applied to parseLensSet
// below, so this suite cannot drift from the production validator in either
// direction.
function assertValidCorpus(practices) {
  const corpus = { version: 1, practices };
  expect(() => parseCorpus(JSON.stringify(corpus))).not.toThrow();
  return parseCorpus(JSON.stringify(corpus));
}

describe('PRACTICES fixture', () => {
  it('is a valid corpus per the real parseCorpus validator', () => {
    const parsed = assertValidCorpus(PRACTICES);
    expect(parsed.practices).toHaveLength(PRACTICES.length);
  });
});

describe('partition', () => {
  it('is deterministic: the same inputs produce a byte-identical lens set', () => {
    const a = partition(PRACTICES, 3);
    const b = partition(
      PRACTICES.map((p) => ({ ...p })),
      3,
    );
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('sorts practices by id before splitting, so input order does not matter', () => {
    const reversed = [...PRACTICES].reverse();
    expect(partition(reversed, 1)).toEqual(partition(PRACTICES, 1));
  });

  it('produces slices that are disjoint and exhaustive', () => {
    const set = partition(PRACTICES, 2);
    const covered = PRACTICES.filter((p) =>
      set.lenses.some((lens) => lens.focus.includes(p.body)),
    ).map((p) => p.id);
    expect(covered.sort()).toEqual([...IDS].sort());
    // No practice counted twice, across lenses.
    expect(new Set(covered).size).toBe(covered.length);
  });

  it('throws when width exceeds the number of practices, rather than emitting an empty lens', () => {
    expect(() => partition(PRACTICES, PRACTICES.length + 1)).toThrow(RangeError);
    expect(() => partition(PRACTICES, PRACTICES.length + 1)).toThrow(
      /exceeds the number of practices/,
    );
  });

  it('allows width equal to the number of practices, one practice per lens', () => {
    const set = partition(PRACTICES, PRACTICES.length);
    expect(set.lenses).toHaveLength(PRACTICES.length);
    expect(set.lenses.every((lens) => lens.focus.split('\n').length === 1)).toBe(true);
  });

  it('rejects a width below 1', () => {
    expect(() => partition(PRACTICES, 0)).toThrow(RangeError);
  });

  it('rejects a non-integer width', () => {
    expect(() => partition(PRACTICES, 1.5)).toThrow(RangeError);
  });

  it('rejects an unknown strategy', () => {
    expect(() => partition(PRACTICES, 2, { strategy: 'bogus' })).toThrow(/unknown strategy/);
  });

  it('defaults to the contiguous strategy', () => {
    expect(partition(PRACTICES, 2)).toEqual(partition(PRACTICES, 2, { strategy: 'contiguous' }));
  });

  it('round-robin distributes practices differently from contiguous', () => {
    const contiguous = partition(PRACTICES, 2, { strategy: 'contiguous' });
    const roundRobin = partition(PRACTICES, 2, { strategy: 'round-robin' });
    expect(roundRobin).not.toEqual(contiguous);
  });

  it('zero-pads generated ids so lexicographic order matches numeric order', () => {
    const set = partition(PRACTICES, PRACTICES.length);
    expect(set.lenses.map((lens) => lens.id)).toEqual([
      'lens-01',
      'lens-02',
      'lens-03',
      'lens-04',
      'lens-05',
    ]);
  });

  // The point of the whole exercise: the real runner must accept what this
  // module produces. A partitioner that emits something parseLensSet
  // refuses is useless regardless of how good its own idea of "valid" is.
  it('round-trips every generated set through parseLensSet unchanged', () => {
    for (const width of [1, 2, 3, 4, 5]) {
      for (const strategy of ['contiguous', 'round-robin']) {
        const set = partition(PRACTICES, width, { strategy });
        expect(parseLensSet(JSON.stringify(set))).toEqual(set);
      }
    }
  });

  // The design point that is easy to get backwards: the per-lens slice must
  // land in `focus` (the per-lens half of the prompt), never passed as the
  // shared `practices` argument to buildPrompt/runPanel — see the file
  // header of eval/partition.mjs. Asserted here as a property of the
  // output: every lens's `focus` names only ITS OWN slice's bodies, and no
  // lens's focus contains every practice's body (which is what passing the
  // whole corpus through the shared channel would look like).
  it('puts each slice in the per-lens focus field, not a shared field', () => {
    const set = partition(PRACTICES, PRACTICES.length);
    for (const lens of set.lenses) {
      const containedBodies = PRACTICES.filter((p) => lens.focus.includes(p.body));
      expect(containedBodies).toHaveLength(1);
    }
  });
});
