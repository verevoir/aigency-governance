import { describe, expect, it } from 'vitest';

import lenses from '../review/design-lenses.json' with { type: 'json' };
import { parseLensSet } from '../src/review/lensSet.js';

// The design lens set is checked by the same validator every lens set is
// checked by. It is loaded as a SECOND, separate source from the
// implementation lens set (`review/lenses.json`) — for design review, not
// for a diff — so nothing here may assume it is merged with that file.
describe('the shipped design lens set', () => {
  const set = parseLensSet(JSON.stringify(lenses));

  it('passes the validator every runner applies to it', () => {
    expect(() => parseLensSet(JSON.stringify(lenses))).not.toThrow();
  });

  // A lens whose focus is a stub parses cleanly and reviews along nothing.
  it('gives every lens a focus with something in it', () => {
    for (const lens of set.lenses) {
      expect(lens.focus.length, `lens ${lens.id} focus is a stub`).toBeGreaterThan(40);
    }
  });

  it('declares a panel, not a single reviewer', () => {
    expect(set.lenses.length).toBeGreaterThan(1);
  });

  // The implementation lens set and the design lens set are loaded from
  // different sources and must not collide if a caller ever held both.
  it('shares no lens id with the implementation lens set', async () => {
    const implementationLenses = (await import('../review/lenses.json', { with: { type: 'json' } }))
      .default as { lenses: { id: string }[] };
    const designIds = new Set(set.lenses.map((lens) => lens.id));
    for (const lens of implementationLenses.lenses) {
      expect(designIds.has(lens.id), `id ${lens.id} collides across the two lens sets`).toBe(false);
    }
  });
});
