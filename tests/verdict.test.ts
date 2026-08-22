import { describe, expect, it } from 'vitest';

import { aggregate, PanelMismatchError, type LensResult } from '../src/review/verdict.js';

const DECLARED = ['correctness', 'honesty', 'blast-radius'];

function approved(lens: string): LensResult {
  return { lens, outcome: 'approved', findings: [] };
}
function rejected(lens: string, summary: string): LensResult {
  return { lens, outcome: 'rejected', findings: [{ lens, summary }] };
}
function couldNotRun(lens: string, reason: string): LensResult {
  return { lens, outcome: 'could_not_run', findings: [], reason };
}
function outOfScope(lens: string, reason: string): LensResult {
  return { lens, outcome: 'out_of_scope', findings: [], reason };
}

describe('aggregate', () => {
  it('approves only when every declared lens approved', () => {
    const verdict = aggregate(DECLARED, DECLARED.map(approved));
    expect(verdict.outcome).toBe('approved');
    expect(verdict.findings).toEqual([]);
    expect(verdict.unran).toEqual([]);
  });

  it('rejects when any lens rejects, and carries the findings', () => {
    const verdict = aggregate(DECLARED, [
      approved('correctness'),
      rejected('honesty', 'comment claims a property the code lacks'),
      approved('blast-radius'),
    ]);
    expect(verdict.outcome).toBe('rejected');
    expect(verdict.findings).toHaveLength(1);
    expect(verdict.findings[0]?.summary).toBe('comment claims a property the code lacks');
  });

  // The precedence that decides whether an incomplete review can be waved
  // through once its findings are addressed. It cannot.
  it('reports could_not_run even when another lens rejected', () => {
    const verdict = aggregate(DECLARED, [
      approved('correctness'),
      rejected('honesty', 'a real finding'),
      couldNotRun('blast-radius', 'model returned no content'),
    ]);
    expect(verdict.outcome).toBe('could_not_run');
    expect(verdict.unran).toEqual([{ lens: 'blast-radius', reason: 'model returned no content' }]);
    // The findings that DID arrive are still reported — an incomplete review
    // is not an excuse to discard what it managed to see.
    expect(verdict.findings).toHaveLength(1);
  });

  // Fails closed against the DEFINITION, not against what arrived. A lens
  // that was never dispatched leaves no trace in the results.
  it('treats a declared lens with no result at all as could_not_run', () => {
    const verdict = aggregate(DECLARED, [approved('correctness'), approved('honesty')]);
    expect(verdict.outcome).toBe('could_not_run');
    expect(verdict.unran).toEqual([{ lens: 'blast-radius', reason: 'lens returned no result' }]);
  });

  it('does not approve an empty result set against a non-empty panel', () => {
    const verdict = aggregate(DECLARED, []);
    expect(verdict.outcome).toBe('could_not_run');
    expect(verdict.unran).toHaveLength(3);
  });

  it('supplies a reason for a could_not_run that gave none', () => {
    const verdict = aggregate(
      ['correctness'],
      [{ lens: 'correctness', outcome: 'could_not_run', findings: [] }],
    );
    expect(verdict.unran).toEqual([{ lens: 'correctness', reason: 'no reason given' }]);
  });

  it('orders results by the declaration, not by arrival', () => {
    const verdict = aggregate(DECLARED, [
      approved('blast-radius'),
      approved('honesty'),
      approved('correctness'),
    ]);
    expect(verdict.results.map((result) => result.lens)).toEqual(DECLARED);
  });

  it('collects findings in declaration order', () => {
    const verdict = aggregate(DECLARED, [
      rejected('blast-radius', 'third'),
      rejected('correctness', 'first'),
      rejected('honesty', 'second'),
    ]);
    expect(verdict.findings.map((finding) => finding.summary)).toEqual([
      'first',
      'second',
      'third',
    ]);
  });

  // A result for a lens nobody declared means the runner and the definition
  // disagree about the panel. Keeping it would let a local edit add a lens;
  // dropping it would discard a real finding.
  it('refuses a result for an undeclared lens, naming what was declared', () => {
    expect(() => aggregate(DECLARED, [approved('invented')])).toThrow(PanelMismatchError);
    expect(() => aggregate(DECLARED, [approved('invented')])).toThrow(
      'correctness, honesty, blast-radius',
    );
  });

  it('refuses two results for the same lens', () => {
    expect(() =>
      aggregate(DECLARED, [approved('correctness'), rejected('correctness', 'x')]),
    ).toThrow(PanelMismatchError);
  });
});

// PR #38 (aigency-runtime-v2): a lens that reviewed and found nothing in its
// scope is not the same fact as a lens that did not review at all, and the
// two must not collapse into the same outcome.
describe('aggregate, when a lens has nothing in its scope', () => {
  it('still approves when the rest reviewed normally and one lens had nothing in scope', () => {
    const verdict = aggregate(DECLARED, [
      approved('correctness'),
      approved('honesty'),
      outOfScope(
        'blast-radius',
        'diff touches only workflow YAML, nothing about credential scope here',
      ),
    ]);
    expect(verdict.outcome).toBe('approved');
    expect(verdict.outOfScope).toEqual([
      {
        lens: 'blast-radius',
        reason: 'diff touches only workflow YAML, nothing about credential scope here',
      },
    ]);
  });

  // The collapse this story exists to undo: out_of_scope must not join
  // `unran` and must not, by itself, hold up the panel the way an unrun lens
  // does.
  it('keeps out_of_scope out of unran — it did not fail to review', () => {
    const verdict = aggregate(DECLARED, [
      approved('correctness'),
      approved('honesty'),
      outOfScope('blast-radius', 'nothing to judge'),
    ]);
    expect(verdict.unran).toEqual([]);
  });

  // S25's ordering, unchanged: a genuine could_not_run still outranks a
  // rejected, even with a third lens reporting out_of_scope alongside them.
  it('still lets could_not_run outrank rejected, with a third lens out_of_scope (S25 unchanged)', () => {
    const verdict = aggregate(DECLARED, [
      rejected('correctness', 'a real finding'),
      couldNotRun('honesty', 'model returned no content'),
      outOfScope('blast-radius', 'nothing to judge'),
    ]);
    expect(verdict.outcome).toBe('could_not_run');
  });

  // out_of_scope must not outrank a rejection either — a lens skimming its
  // way to a cheap opt-out must not be able to bury a real finding.
  it('lets a rejection stand even when every other lens is out_of_scope', () => {
    const verdict = aggregate(DECLARED, [
      rejected('correctness', 'a real finding'),
      outOfScope('honesty', 'nothing to judge'),
      outOfScope('blast-radius', 'nothing to judge'),
    ]);
    expect(verdict.outcome).toBe('rejected');
  });

  // The operator-decision branch, built as specified: all lenses out of scope
  // reads as its own non-green outcome, not as an approval.
  it('reports its own outcome, not approved, when every declared lens is out_of_scope', () => {
    const verdict = aggregate(
      DECLARED,
      DECLARED.map((lens) => outOfScope(lens, 'nothing to judge')),
    );
    expect(verdict.outcome).toBe('out_of_scope');
    expect(verdict.outOfScope).toHaveLength(3);
  });

  it('supplies a reason for an out_of_scope that gave none', () => {
    const verdict = aggregate(
      ['correctness'],
      [{ lens: 'correctness', outcome: 'out_of_scope', findings: [] }],
    );
    expect(verdict.outOfScope).toEqual([{ lens: 'correctness', reason: 'no reason given' }]);
  });
});
