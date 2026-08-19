import { describe, expect, it } from 'vitest';

import { mentionsTarget, score } from '../eval/score.mjs';

function finding(lens, summary, detail) {
  return detail === undefined ? { lens, summary } : { lens, summary, detail };
}

function truthEntry(id, target, verdict) {
  return { id, target, verdict };
}

describe('mentionsTarget', () => {
  it('matches on the full target path', () => {
    expect(
      mentionsTarget(
        finding('l', 'removes src/practices/enact.ts as dead code'),
        'src/practices/enact.ts',
      ),
    ).toBe(true);
  });

  it('matches on the basename alone', () => {
    expect(mentionsTarget(finding('l', 'removes enact.ts, unused'), 'src/practices/enact.ts')).toBe(
      true,
    );
  });

  it('is case-insensitive', () => {
    expect(
      mentionsTarget(finding('l', 'Removes SRC/PRACTICES/ENACT.TS'), 'src/practices/enact.ts'),
    ).toBe(true);
  });

  it('checks detail as well as summary', () => {
    expect(
      mentionsTarget(
        finding('l', 'a vague summary', 'the file in question is src/practices/provision.ts'),
        'src/practices/provision.ts',
      ),
    ).toBe(true);
  });

  it('does not match an unrelated target', () => {
    expect(
      mentionsTarget(finding('l', 'renames a variable in lens.ts'), 'src/practices/enact.ts'),
    ).toBe(false);
  });
});

describe('score', () => {
  const truth = [
    truthEntry('t1', 'src/practices/enact.ts', 'not-a-defect'),
    truthEntry('t2', 'src/decorate/retrying.ts', 'defect'),
    truthEntry('t3', 'src/decorate/observing.ts', 'defect'),
  ];

  it('counts a finding naming a defect entry as matched, and it drives recall', () => {
    const result = score(
      [finding('blast-radius', 'src/decorate/retrying.ts is dead code, unwired')],
      truth,
    );
    expect(result.matched).toBe(1);
    expect(result.recall).toBeCloseTo(0.5);
    expect(result.confirmedFalsePositives).toBe(0);
    expect(result.unclassified).toBe(0);
  });

  // The requirement stated as most important: a finding naming a
  // not-a-defect entry is a confirmed false positive, never a hit — the
  // src/practices/* shape from design/tuned-constants-and-eval-harness.md's
  // own corpus entry 1, reproduced here as the regression it exists to
  // prevent.
  it('counts a finding naming a not-a-defect entry as a confirmed false positive, never a match', () => {
    const result = score(
      [finding('blast-radius', 'src/practices/enact.ts is unwired dead code, remove it')],
      truth,
    );
    expect(result.confirmedFalsePositives).toBe(1);
    expect(result.matched).toBe(0);
    expect(result.recall).toBe(0);
  });

  it('counts a finding naming nothing in the corpus as unclassified, not a false positive', () => {
    const result = score(
      [finding('honesty', 'the README overstates what the cli gate covers')],
      truth,
    );
    expect(result.unclassified).toBe(1);
    expect(result.confirmedFalsePositives).toBe(0);
    expect(result.matched).toBe(0);
  });

  it('reports full recall once every defect entry has been named by some finding', () => {
    const result = score(
      [
        finding('blast-radius', 'src/decorate/retrying.ts, dead'),
        finding('failure-modes', 'src/decorate/observing.ts, dead'),
      ],
      truth,
    );
    expect(result.recall).toBe(1);
  });

  it('perEntry names which lenses matched each truth entry, and which found none', () => {
    const result = score(
      [
        finding('blast-radius', 'src/decorate/retrying.ts, dead'),
        finding('failure-modes', 'src/decorate/retrying.ts, dead'),
      ],
      truth,
    );
    const found = result.perEntry.find((entry) => entry.id === 't2');
    expect(found.found).toBe(true);
    expect(found.matchedBy).toEqual(['blast-radius', 'failure-modes']);
    const unfound = result.perEntry.find((entry) => entry.id === 't3');
    expect(unfound.found).toBe(false);
    expect(unfound.matchedBy).toEqual([]);
  });

  it('reports agreement as a diagnostic that moves independently of recall', () => {
    const oneLens = score([finding('blast-radius', 'src/decorate/retrying.ts, dead')], truth);
    const twoLenses = score(
      [
        finding('blast-radius', 'src/decorate/retrying.ts, dead'),
        finding('failure-modes', 'src/decorate/retrying.ts, dead'),
      ],
      truth,
    );
    expect(twoLenses.agreement).toBeGreaterThan(oneLens.agreement);
    // Both runs found the same one defect — agreement rose, recall did not.
    expect(twoLenses.recall).toBe(oneLens.recall);
  });

  it('returns null recall when the corpus has no defect entries at all', () => {
    const result = score([], [truthEntry('t1', 'x.ts', 'not-a-defect')]);
    expect(result.recall).toBeNull();
  });

  it('refuses a truth entry with an unrecognised verdict', () => {
    expect(() => score([], [truthEntry('t1', 'x.ts', 'maybe')])).toThrow(/unrecognised verdict/);
  });

  it('is pure: calling it twice on the same inputs gives the same result', () => {
    const findings = [finding('blast-radius', 'src/decorate/retrying.ts, dead')];
    expect(score(findings, truth)).toEqual(score(findings, truth));
  });
});
