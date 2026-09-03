import { describe, expect, it } from 'vitest';

import { aggregate, PanelMismatchError, type LensResult } from '../src/review/verdict.js';

const DECLARED = ['correctness', 'honesty', 'blast-radius'];

function approved(lens: string): LensResult {
  return { lens, outcome: 'approved', findings: [] };
}
function rejected(lens: string, summary: string): LensResult {
  return { lens, outcome: 'rejected', findings: [{ lens, summary, blocking: true }] };
}
function couldNotRun(lens: string, reason: string): LensResult {
  return { lens, outcome: 'could_not_run', findings: [], reason };
}
function outOfScope(lens: string, reason: string): LensResult {
  return { lens, outcome: 'out_of_scope', findings: [], reason };
}
// An approval carrying only smell (non-blocking) findings — the shape a
// well-formed reply produces for the placeholder-test calibration case.
function approvedWithSmell(lens: string, summary: string): LensResult {
  return { lens, outcome: 'approved', findings: [{ lens, summary, blocking: false }] };
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

  // The operator decision, made: all lenses out of scope is a completed
  // judgement with nothing wrong found — it reads as approved, not as its
  // own non-green result. verevoir/aigency-harness#8.
  it('approves, rather than reporting its own outcome, when every declared lens is out_of_scope', () => {
    const verdict = aggregate(
      DECLARED,
      DECLARED.map((lens) => outOfScope(lens, 'nothing to judge')),
    );
    expect(verdict.outcome).toBe('approved');
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

// Severity-weighted approval: a blocking finding sinks the panel, a
// non-blocking (smell) one is reported and does not. Proven directly against
// aggregate() with hand-built LensResults, independent of parseReply, so
// this pins the AGGREGATION policy itself rather than merely the parser that
// happens to feed it today.
describe('aggregate, severity-weighted', () => {
  it('approves a lens that carries only smell findings', () => {
    const verdict = aggregate(DECLARED, [
      approvedWithSmell(
        'correctness',
        "placeholder test: honestly named, doesn't assert anything real",
      ),
      approved('honesty'),
      approved('blast-radius'),
    ]);
    expect(verdict.outcome).toBe('approved');
    expect(verdict.findings).toHaveLength(1);
    expect(verdict.findings[0]?.blocking).toBe(false);
  });

  // Defense in depth: aggregate() does not merely trust a lens's own outcome
  // word. If a Reviewer implementation ever bypassed parseReply's contract
  // and produced a lens that claims 'approved' while still carrying a
  // blocking finding (parseReply itself refuses to construct this shape —
  // see parseReply.test.ts), the panel must not read as approved anyway.
  it('still rejects the panel when a blocking finding arrives on a lens marked approved', () => {
    const verdict = aggregate(DECLARED, [
      {
        lens: 'correctness',
        outcome: 'approved',
        findings: [{ lens: 'correctness', summary: 'smuggled past the contract', blocking: true }],
      },
      approved('honesty'),
      approved('blast-radius'),
    ]);
    expect(verdict.outcome).toBe('rejected');
  });

  // The mirror of the test above, isolating the OTHER half of the OR:
  // `ordered.some((result) => result.outcome === 'rejected')`. Every
  // `rejected()`-built fixture elsewhere in this file also attaches a
  // blocking finding, so `findings.some(blocking)` is already true whenever
  // `outcome === 'rejected'` is, in every case this suite otherwise
  // exercises — meaning the OR'd clause could be deleted outright and the
  // rest of this suite would stay green. Found by this PR's own self-review
  // (verification lens). This builds the shape parseReply.ts itself refuses
  // to produce — `outcome: 'rejected'` with no blocking finding at all — the
  // same "bypassed the contract" scenario as the sibling test above, but for
  // the direction that clause alone protects against.
  it('still rejects the panel when a lens reports outcome "rejected" but carries no blocking finding at all', () => {
    const verdict = aggregate(DECLARED, [
      { lens: 'correctness', outcome: 'rejected', findings: [] },
      approved('honesty'),
      approved('blast-radius'),
    ]);
    expect(verdict.outcome).toBe('rejected');
  });

  // A conformance suite only ever exercised against a conformant fixture is a
  // check that has never been seen to reject — exactly the fault this whole
  // project exists to catch, so it is blocking, not a smell.
  it('rejects for a blocking finding naming a check that has never been seen to reject', () => {
    const verdict = aggregate(DECLARED, [
      rejected('correctness', 'conformance suite only ever run against a conformant fixture'),
      approved('honesty'),
      approved('blast-radius'),
    ]);
    expect(verdict.outcome).toBe('rejected');
  });

  // A stray, out-of-scope trailing-newline edit to a README, fired five times
  // across one pull request — a smell each time, not a reason to hold up an
  // otherwise-sound change.
  it('approves despite five repeated non-blocking findings', () => {
    const smells = Array.from({ length: 5 }, (_, i) => ({
      lens: 'blast-radius',
      summary: `stray trailing-newline edit to README (${i + 1})`,
      blocking: false,
    }));
    const verdict = aggregate(DECLARED, [
      approved('correctness'),
      approved('honesty'),
      { lens: 'blast-radius', outcome: 'approved', findings: smells },
    ]);
    expect(verdict.outcome).toBe('approved');
    expect(verdict.findings).toHaveLength(5);
  });

  // could_not_run still outranks a smell-only panel, same as it outranks a
  // rejection — absence of a blocking finding is not evidence of soundness
  // when a lens never looked at all.
  it('still reports could_not_run over an approval-with-smells when another lens did not review', () => {
    const verdict = aggregate(DECLARED, [
      approvedWithSmell('correctness', 'a style nit'),
      couldNotRun('honesty', 'model returned no content'),
      approved('blast-radius'),
    ]);
    expect(verdict.outcome).toBe('could_not_run');
  });
});
