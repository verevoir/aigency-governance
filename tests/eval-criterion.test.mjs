import { describe, expect, it } from 'vitest';

import {
  CATCH_THRESHOLD_OF_3,
  classifyWidth,
  CRITERION_RULE,
  MIN_USABLE_REPEATS_OF_3,
  REJECT_THRESHOLD_OF_3,
} from '../eval/criterion.mjs';

function perEntry(id, verdict, found) {
  return { id, target: `${id}.ts`, verdict, found, matchedBy: found ? ['lens'] : [] };
}

function usableScore(entries) {
  return {
    matched: 0,
    recall: 0,
    confirmedFalsePositives: 0,
    unclassified: 0,
    perEntry: entries,
    agreement: 0,
  };
}

function unusableScore(message) {
  return { error: message };
}

function repeat(repeatIndex, score, couldNotRunCount = 0) {
  return { repeatIndex, results: [], couldNotRunCount, verdictOutcome: 'rejected', score };
}

function configOf(cases) {
  return {
    practiceCount: 'full',
    width: 8,
    practiceSubsetSize: 60,
    lensSet: { lenses: [] },
    cases,
  };
}

describe('constants', () => {
  it('are all 2 of 3, per eval/README.md', () => {
    expect(CATCH_THRESHOLD_OF_3).toBe(2);
    expect(REJECT_THRESHOLD_OF_3).toBe(2);
    expect(MIN_USABLE_REPEATS_OF_3).toBe(2);
  });

  it('CRITERION_RULE names all three constants, so a results file never has to leave itself', () => {
    expect(CRITERION_RULE).toContain('CATCH_THRESHOLD_OF_3');
    expect(CRITERION_RULE).toContain('REJECT_THRESHOLD_OF_3');
    expect(CRITERION_RULE).toContain('MIN_USABLE_REPEATS_OF_3');
  });
});

describe('classifyWidth', () => {
  it('is good when every defect is caught >=2/3 and every not-a-defect is rejected >=2/3', () => {
    const config = configOf([
      {
        caseId: 'c1',
        repeats: [
          repeat(
            0,
            usableScore([perEntry('d1', 'defect', true), perEntry('n1', 'not-a-defect', false)]),
          ),
          repeat(
            1,
            usableScore([perEntry('d1', 'defect', true), perEntry('n1', 'not-a-defect', false)]),
          ),
          repeat(
            2,
            usableScore([perEntry('d1', 'defect', false), perEntry('n1', 'not-a-defect', true)]),
          ),
        ],
      },
    ]);
    expect(classifyWidth(config).verdict).toBe('good');
  });

  it('is bad when a defect entry is caught fewer than 2 of 3 usable repeats', () => {
    const config = configOf([
      {
        caseId: 'c1',
        repeats: [
          repeat(0, usableScore([perEntry('d1', 'defect', true)])),
          repeat(1, usableScore([perEntry('d1', 'defect', false)])),
          repeat(2, usableScore([perEntry('d1', 'defect', false)])),
        ],
      },
    ]);
    expect(classifyWidth(config).verdict).toBe('bad');
  });

  it('is bad, not good, for a configuration that catches every defect by flagging everything', () => {
    // A recall-only rule would rank this top; the criterion must not.
    const config = configOf([
      {
        caseId: 'c1',
        repeats: [
          repeat(
            0,
            usableScore([perEntry('d1', 'defect', true), perEntry('n1', 'not-a-defect', true)]),
          ),
          repeat(
            1,
            usableScore([perEntry('d1', 'defect', true), perEntry('n1', 'not-a-defect', true)]),
          ),
          repeat(
            2,
            usableScore([perEntry('d1', 'defect', true), perEntry('n1', 'not-a-defect', true)]),
          ),
        ],
      },
    ]);
    expect(classifyWidth(config).verdict).toBe('bad');
  });

  it('holds every not-a-defect entry to the same bar, not only a named one', () => {
    const config = configOf([
      {
        caseId: 'c1',
        repeats: [
          repeat(
            0,
            usableScore([
              perEntry('n1', 'not-a-defect', false),
              perEntry('n2', 'not-a-defect', true),
            ]),
          ),
          repeat(
            1,
            usableScore([
              perEntry('n1', 'not-a-defect', false),
              perEntry('n2', 'not-a-defect', true),
            ]),
          ),
          repeat(
            2,
            usableScore([
              perEntry('n1', 'not-a-defect', false),
              perEntry('n2', 'not-a-defect', false),
            ]),
          ),
        ],
      },
    ]);
    // n1 is correctly rejected 3/3; n2 only 1/3. One failing entry is enough.
    expect(classifyWidth(config).verdict).toBe('bad');
  });

  it('is indistinguishable when fewer than 2 of 3 repeats produced a usable score and nothing failed outright', () => {
    const config = configOf([
      {
        caseId: 'c1',
        repeats: [
          repeat(0, usableScore([perEntry('d1', 'defect', true)])),
          repeat(1, unusableScore('truth.json was empty or absent for this case')),
          repeat(2, unusableScore('score() threw: boom')),
        ],
      },
    ]);
    expect(classifyWidth(config).verdict).toBe('indistinguishable');
  });

  it('is indistinguishable, not good, when every repeat is unusable', () => {
    const config = configOf([
      {
        caseId: 'c1',
        repeats: [
          repeat(0, unusableScore('x')),
          repeat(1, unusableScore('x')),
          repeat(2, unusableScore('x')),
        ],
      },
    ]);
    expect(classifyWidth(config).verdict).toBe('indistinguishable');
  });

  it('does not treat couldNotRunCount as a usability signal', () => {
    const config = configOf([
      {
        caseId: 'c1',
        repeats: [
          repeat(0, usableScore([perEntry('d1', 'defect', true)]), 3),
          repeat(1, usableScore([perEntry('d1', 'defect', true)])),
          repeat(2, usableScore([perEntry('d1', 'defect', true)])),
        ],
      },
    ]);
    expect(classifyWidth(config).verdict).toBe('good');
  });
});
