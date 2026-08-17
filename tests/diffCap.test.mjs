// assessDiffCap, driven directly — no script, no subprocess, no disk. Each
// test constructs a diff string and reads back which of the three outcomes
// it produced.

import { describe, expect, it } from 'vitest';

import { assessDiffCap } from '../scripts/diffCap.mjs';

describe('assessDiffCap', () => {
  it('is empty for a diff with nothing in it', () => {
    expect(assessDiffCap('', 100)).toEqual({ kind: 'empty' });
  });

  it("is empty for a diff that is whitespace only — matching the trim check review-head.mjs already makes on git show's output", () => {
    expect(assessDiffCap('   \n\n  \t', 100)).toEqual({ kind: 'empty' });
  });

  // Empty and reviewable told apart, not just "not reviewable" versus
  // everything else — a test that only checked one flag could not show
  // these are two different outcomes rather than one outcome two ways.
  it('tells empty and reviewable apart, rather than collapsing "nothing" into "small"', () => {
    const nothing = assessDiffCap('', 100);
    const oneChar = assessDiffCap('x', 100);
    expect(nothing.kind).toBe('empty');
    expect(oneChar.kind).toBe('reviewable');
    expect(nothing).not.toEqual(oneChar);
  });

  // The discriminating pair: one character under the cap and one character
  // over it must land on opposite sides — proof the boundary is where it
  // claims to be, not just that some large diff and some small diff differ.
  it('is reviewable at exactly the cap, and too-large one character past it', () => {
    expect(assessDiffCap('x'.repeat(10), 10)).toEqual({ kind: 'reviewable', chars: 10 });
    expect(assessDiffCap('x'.repeat(11), 10)).toEqual({
      kind: 'too-large',
      chars: 11,
      maxChars: 10,
    });
  });

  it('is reviewable for a diff well under the cap, carrying its measured size', () => {
    expect(assessDiffCap('x'.repeat(5), 100)).toEqual({ kind: 'reviewable', chars: 5 });
  });

  // Both numbers, not one — a refusal that named only "too large" would
  // need a second run to learn whether the cap is nearly right or wildly
  // wrong.
  it('carries both the actual size and the cap when too large', () => {
    expect(assessDiffCap('x'.repeat(1000), 100)).toEqual({
      kind: 'too-large',
      chars: 1000,
      maxChars: 100,
    });
  });

  // The precedent this follows — practices/provision.ts drops a single
  // over-large practice whole rather than truncating it. There is no
  // truncated variant to disprove directly, so this pins the positive: the
  // outcome for an over-large diff carries only the measurement, never a
  // shortened copy of the diff itself.
  it('carries no diff content at all when too large — only the measurement', () => {
    const outcome = assessDiffCap('x'.repeat(1000), 100);
    expect(Object.keys(outcome).sort()).toEqual(['chars', 'kind', 'maxChars']);
  });

  it('measures characters, not lines — many short lines can total fewer characters than the cap allows', () => {
    const manyShortLines = 'a\n'.repeat(50); // 50 lines, 100 characters
    expect(manyShortLines.length).toBe(100);
    expect(assessDiffCap(manyShortLines, 150)).toEqual({ kind: 'reviewable', chars: 100 });
  });

  it('measures characters, not lines — a single long line can be too-large even though it is one line', () => {
    const oneHugeLine = 'x'.repeat(500);
    expect(assessDiffCap(oneHugeLine, 100)).toEqual({
      kind: 'too-large',
      chars: 500,
      maxChars: 100,
    });
  });

  it('measures the untrimmed diff for the size it reports, not a trimmed one', () => {
    const padded = `  ${'x'.repeat(10)}  `;
    expect(assessDiffCap(padded, 100)).toEqual({ kind: 'reviewable', chars: padded.length });
  });
});
