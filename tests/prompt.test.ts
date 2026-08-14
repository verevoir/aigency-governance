import { describe, expect, it } from 'vitest';

import type { Lens } from '../src/review/lensSet.js';
import { buildPrompt, type Subject } from '../src/review/prompt.js';
import { REPLY_CONTRACT } from '../src/review/replyContract.js';

const CORRECTNESS: Lens = {
  id: 'correctness',
  title: 'Correctness',
  focus: 'does the change do what its description says it does',
};
const HONESTY: Lens = {
  id: 'honesty',
  title: 'Honesty of the record',
  focus: 'does anything report a state it did not observe',
};

const SUBJECT: Subject = {
  title: 'Add a retry to the fetch',
  description: 'Three attempts with exponential backoff.',
  diff: '-const attempts = 1;\n+const attempts = 3;',
};

// The property that makes a five-lens panel affordable. It is structural and
// cheap to check here; whether a provider actually hits its cache is measured
// elsewhere and is not claimed by these tests.
describe('buildPrompt — the shared half', () => {
  it('is byte-identical across two different lenses', () => {
    expect(buildPrompt(CORRECTNESS, SUBJECT).shared).toBe(buildPrompt(HONESTY, SUBJECT).shared);
  });

  it('stays identical when practices are supplied', () => {
    const bar = 'A comment claiming a property the code does not have is worse than none.';
    expect(buildPrompt(CORRECTNESS, SUBJECT, bar).shared).toBe(
      buildPrompt(HONESTY, SUBJECT, bar).shared,
    );
  });

  it('changes when the subject changes', () => {
    const other: Subject = { ...SUBJECT, diff: '+const attempts = 4;' };
    expect(buildPrompt(CORRECTNESS, SUBJECT).shared).not.toBe(
      buildPrompt(CORRECTNESS, other).shared,
    );
  });

  it('carries the diff, the title and the description verbatim', () => {
    const { shared } = buildPrompt(CORRECTNESS, SUBJECT);
    expect(shared).toContain(SUBJECT.diff);
    expect(shared).toContain(SUBJECT.title);
    expect(shared).toContain(SUBJECT.description);
  });

  it('carries the reply contract verbatim', () => {
    expect(buildPrompt(CORRECTNESS, SUBJECT).shared).toContain(REPLY_CONTRACT);
  });

  // The other side of the same property, and the one that actually breaks:
  // a lens detail leaking into the shared half makes every prefix different
  // while every test asserting identity still passes for a single lens.
  it('leaks nothing lens-specific into the cacheable half', () => {
    const { shared } = buildPrompt(CORRECTNESS, SUBJECT);
    expect(shared).not.toContain(CORRECTNESS.focus);
    expect(shared).not.toContain(CORRECTNESS.title);
  });
});

describe('buildPrompt — the bar', () => {
  it('includes supplied practices verbatim', () => {
    const bar = 'Missing, empty and broken are three answers.';
    expect(buildPrompt(CORRECTNESS, SUBJECT, bar).shared).toContain(bar);
  });

  // A reviewer judging against nothing must know it is judging against
  // nothing. An absent bar that renders as a blank section is indistinguishable
  // from a bar with nothing in it, and the reviewer would proceed either way.
  it('says the bar is absent rather than rendering an empty one', () => {
    for (const practices of [undefined, '', '   ', '\n\n']) {
      expect(buildPrompt(CORRECTNESS, SUBJECT, practices).shared).toContain(
        'No practices were supplied',
      );
    }
  });

  it('does not announce an absent bar when one was supplied', () => {
    const bar = 'Missing, empty and broken are three answers.';
    expect(buildPrompt(CORRECTNESS, SUBJECT, bar).shared).not.toContain(
      'No practices were supplied',
    );
  });
});

describe('buildPrompt — the per-lens half', () => {
  it('differs between lenses', () => {
    expect(buildPrompt(CORRECTNESS, SUBJECT).perLens).not.toBe(
      buildPrompt(HONESTY, SUBJECT).perLens,
    );
  });

  it('carries the lens focus and title verbatim', () => {
    const { perLens } = buildPrompt(HONESTY, SUBJECT);
    expect(perLens).toContain(HONESTY.focus);
    expect(perLens).toContain(HONESTY.title);
  });

  // If the diff were repeated here, the split would buy nothing: the large
  // payload would travel once per lens either way.
  it('repeats none of the large payload', () => {
    const { perLens } = buildPrompt(CORRECTNESS, SUBJECT);
    expect(perLens).not.toContain(SUBJECT.diff);
    expect(perLens).not.toContain(REPLY_CONTRACT);
  });
});
