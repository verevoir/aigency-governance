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

  // aggregate() does not build Finding values, it only carries them — but
  // nothing above proves that, since every finding used so far has no
  // evidence to lose. Whole-value comparison so a future reshaping that
  // dropped the field would fail here rather than pass on a summary-only
  // check.
  it("carries a finding's evidence through unchanged", () => {
    const withEvidence: LensResult = {
      lens: 'honesty',
      outcome: 'rejected',
      findings: [
        {
          lens: 'honesty',
          summary: 'claims a search that was not run',
          evidence: { kind: 'quote', text: 'grep -r X src/' },
        },
      ],
    };

    const verdict = aggregate(DECLARED, [
      approved('correctness'),
      withEvidence,
      approved('blast-radius'),
    ]);

    expect(verdict.findings).toEqual([
      {
        lens: 'honesty',
        summary: 'claims a search that was not run',
        evidence: { kind: 'quote', text: 'grep -r X src/' },
      },
    ]);
  });
});
