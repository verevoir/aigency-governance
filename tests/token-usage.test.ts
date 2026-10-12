// sumUsage (verdict.ts) and the "### Tokens" section it feeds (report.ts).
//
// Absent stays absent, never a fabricated zero — see GenAiUsage's own doc
// comment (verdict.ts) for why that distinction matters all the way to the
// rendered line.

import { describe, expect, it } from 'vitest';

import { renderReport, type ReportContext } from '../src/review/report.js';
import { sumUsage, type LensResult, type Verdict } from '../src/review/verdict.js';

function result(lens: string, usage?: LensResult['usage']): LensResult {
  return { lens, outcome: 'approved', findings: [], ...(usage === undefined ? {} : { usage }) };
}

const CONTEXT: ReportContext = { source: 'test', subject: 'a change' };

describe('sumUsage', () => {
  it('totals each field across every lens that reported it', () => {
    const results = [
      result('correctness', { inputTokens: 100, outputTokens: 10 }),
      result('honesty', { inputTokens: 200, outputTokens: 20, cacheReadInputTokens: 5 }),
    ];
    expect(sumUsage(results)).toEqual({
      inputTokens: 300,
      outputTokens: 30,
      cacheReadInputTokens: 5,
    });
  });

  it('leaves a field absent when no lens reported it, rather than defaulting to zero', () => {
    const results = [
      result('correctness', { inputTokens: 100 }),
      result('honesty', { inputTokens: 200 }),
    ];
    const total = sumUsage(results);
    expect(total).toEqual({ inputTokens: 300 });
    expect(total).not.toHaveProperty('outputTokens');
  });

  it('returns undefined when nothing anywhere reported any usage at all', () => {
    expect(sumUsage([result('correctness'), result('honesty')])).toBeUndefined();
  });
});

describe('renderReport — the Tokens section', () => {
  it("shows 'not recorded' for a lens whose transport reported no usage at all, alongside one that did", () => {
    const verdict: Verdict = {
      outcome: 'approved',
      results: [result('correctness', { inputTokens: 50, outputTokens: 5 }), result('honesty')],
      findings: [],
      unran: [],
      outOfScope: [],
    };
    const report = renderReport(verdict, CONTEXT);
    expect(report).toContain('**correctness** — 50 input, 5 output');
    expect(report).toContain('**honesty** — not recorded');
  });

  it('prints no Tokens section at all when no lens anywhere reported any usage', () => {
    const verdict: Verdict = {
      outcome: 'approved',
      results: [result('correctness'), result('honesty')],
      findings: [],
      unran: [],
      outOfScope: [],
    };
    expect(renderReport(verdict, CONTEXT)).not.toContain('### Tokens');
  });
});
