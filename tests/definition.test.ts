import { describe, expect, it } from 'vitest';

import lenses from '../review/lenses.json' with { type: 'json' };
import { parseLensSet } from '../src/review/lensSet.js';

// The definition this repository ships is checked by the same validator every
// runner uses. Without this, `review/lenses.json` is the one file in the
// system that nothing verifies — and it is the file that decides whether a
// review happens at all.
describe('the shipped lens set', () => {
  const set = parseLensSet(JSON.stringify(lenses));

  it('passes the validator every runner applies to it', () => {
    expect(() => parseLensSet(JSON.stringify(lenses))).not.toThrow();
  });

  // A lens whose focus is a stub parses cleanly and reviews along nothing.
  // The panel would keep its member count and lose the member.
  it('gives every lens a focus with something in it', () => {
    for (const lens of set.lenses) {
      expect(lens.focus.length, `lens ${lens.id} focus is a stub`).toBeGreaterThan(40);
    }
  });

  it('declares a panel, not a single reviewer', () => {
    expect(set.lenses.length).toBeGreaterThan(1);
  });
});
