import { describe, expect, it } from 'vitest';
import { buildDryRunSummary } from '../eval/sweep.mjs';

function practice(id, appliesTo) {
  return { id, title: id, body: 'x', appliesTo, mechanicallyCheckable: true };
}

describe('buildDryRunSummary', () => {
  it('carries the swept axes through unchanged and reports counts from its inputs, not recomputed guesses', () => {
    const practicesResult = {
      practices: [
        practice('a', 'diff'),
        practice('b', 'diff'),
        practice('c', 'process'),
        practice('d', 'process'),
        practice('e', 'process'),
      ],
    };
    const summary = {
      configurations: [{}, {}, {}],
      casesCount: 7,
      totalModelCalls: 4242,
    };

    const result = buildDryRunSummary({
      widths: [1, 3, 8],
      practiceCounts: ['full', 'half'],
      practicesResult,
      summary,
    });

    // The axes swept: passed straight through, not derived.
    expect(result.widths).toEqual([1, 3, 8]);
    expect(result.practiceCounts).toEqual(['full', 'half']);

    // Counts: taken from the objects computeSummary/loadPractices actually
    // produced, not recomputed independently of them.
    expect(result.configurationCount).toBe(3);
    expect(result.caseCount).toBe(7);
    expect(result.practicesLoaded).toBe(5);
    expect(result.totalModelCalls).toBe(4242);

    // diffApplicableCount: a real filter on appliesTo === 'diff', proven by
    // a fixture mixing both tags — 2 of 5, not "all" or "none", so a filter
    // that let everything through (or dropped appliesTo entirely, as
    // parseCorpus once did) would fail this rather than pass by accident.
    expect(result.diffApplicableCount).toBe(2);

    // A timestamp is present and parses, so a reader can tell one dry run
    // apart from the next.
    expect(typeof result.generatedAt).toBe('string');
    expect(Number.isNaN(Date.parse(result.generatedAt))).toBe(false);
  });

  it('reports zero diff-applicable practices when none carry appliesTo: "diff"', () => {
    const result = buildDryRunSummary({
      widths: [1],
      practiceCounts: ['full'],
      practicesResult: { practices: [practice('a', 'process'), practice('b', 'process')] },
      summary: { configurations: [{}], casesCount: 0, totalModelCalls: 0 },
    });

    expect(result.diffApplicableCount).toBe(0);
    expect(result.practicesLoaded).toBe(2);
  });
});
