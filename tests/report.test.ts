import { describe, expect, it } from 'vitest';

import { exitCodeFor, renderReport } from '../src/review/report.js';
import { aggregate, type LensResult } from '../src/review/verdict.js';

const DECLARED = ['correctness', 'honesty', 'blast-radius'];
const CONTEXT = { source: 'review/lenses.json', subject: 'PR #1: add a retry' };

function approved(lens: string): LensResult {
  return { lens, outcome: 'approved', findings: [] };
}
function rejected(lens: string, ...summaries: string[]): LensResult {
  return { lens, outcome: 'rejected', findings: summaries.map((summary) => ({ lens, summary })) };
}
function couldNotRun(lens: string, reason: string): LensResult {
  return { lens, outcome: 'could_not_run', findings: [], reason };
}

describe('exitCodeFor', () => {
  // Named for what it checks. The universal — that ONLY an approval is zero —
  // is carried by the two tests below, and this one passed a mutation that
  // broke it. A test name asserting more than its body is the same defect as
  // a comment doing so.
  it('is zero for an approval', () => {
    expect(exitCodeFor('approved')).toBe(0);
  });

  it('is non-zero for a rejection', () => {
    expect(exitCodeFor('rejected')).toBe(1);
  });

  // The requirement the third outcome exists for. A review that did not happen
  // must not be the same colour as one that happened and approved.
  it('is non-zero for could_not_run', () => {
    expect(exitCodeFor('could_not_run')).toBe(1);
  });
});

describe('renderReport', () => {
  it('states the outcome in the first line', () => {
    for (const [results, word] of [
      [DECLARED.map(approved), 'Approved'],
      [[approved('correctness'), rejected('honesty', 'x'), approved('blast-radius')], 'Rejected'],
      [[approved('correctness'), approved('honesty')], 'Could not run'],
    ] as const) {
      const report = renderReport(aggregate(DECLARED, results), CONTEXT);
      expect(report.split('\n')[0]).toContain(word);
    }
  });

  // A reader who stops at the heading must not come away with the wrong
  // impression, so the word for one outcome must not appear in another's
  // heading line.
  // Both non-approving outcomes, not just one. A `could_not_run` heading
  // reading "Approved with gaps" would have passed the previous version.
  it('never puts the word Approved in a heading that is not an approval', () => {
    for (const results of [[rejected('correctness', 'x')], [approved('correctness')]]) {
      const report = renderReport(aggregate(DECLARED, results), CONTEXT);
      expect(report.split('\n')[0]).not.toContain('Approved');
    }
  });

  // Asserts the footer is a footer. The previous version said "footer" and
  // checked "anywhere in the string", so moving the attribution to the top
  // would have passed.
  it('puts the source and lens count on the last line', () => {
    const report = renderReport(aggregate(DECLARED, DECLARED.map(approved)), CONTEXT);
    const lines = report.split('\n');
    expect(lines[lines.length - 1]).toContain('Judged by 3 lens(es)');
    expect(lines[lines.length - 1]).toContain('review/lenses.json');
  });

  it('names the subject', () => {
    const report = renderReport(aggregate(DECLARED, DECLARED.map(approved)), CONTEXT);
    expect(report).toContain('PR #1: add a retry');
  });

  it('carries every finding', () => {
    const verdict = aggregate(DECLARED, [
      rejected('correctness', 'first', 'second'),
      rejected('honesty', 'third'),
      approved('blast-radius'),
    ]);
    const report = renderReport(verdict, CONTEXT);
    for (const summary of ['first', 'second', 'third']) {
      expect(report).toContain(summary);
    }
    expect(report).toContain('3 finding(s)');
  });

  // Proves the grouping, not merely that both headings exist. The previous
  // version passed against a renderer that printed every heading and then
  // every finding.
  it('puts each finding under its own lens heading', () => {
    const report = renderReport(
      aggregate(DECLARED, [rejected('correctness', 'a-finding'), rejected('honesty', 'b-finding')]),
      CONTEXT,
    );
    const lines = report.split('\n');
    const positions = [
      lines.findIndex((line) => line === '#### correctness'),
      lines.findIndex((line) => line.includes('a-finding')),
      lines.findIndex((line) => line === '#### honesty'),
      lines.findIndex((line) => line.includes('b-finding')),
    ];
    expect(positions.every((at) => at > -1)).toBe(true);
    expect([...positions].sort((left, right) => left - right)).toEqual(positions);
  });

  it('includes a finding detail when there is one', () => {
    const verdict = aggregate(DECLARED, [
      {
        lens: 'correctness',
        outcome: 'rejected',
        findings: [{ lens: 'correctness', summary: 's', detail: 'the long version' }],
      },
    ]);
    expect(renderReport(verdict, CONTEXT)).toContain('the long version');
  });

  // The missing/empty/broken split, in the one place this file makes it.
  // Without this, dropping the `!== ''` guard leaves the suite green and the
  // report grows a line of two spaces under every finding that carries an
  // empty detail.
  it('renders no line at all for an empty detail', () => {
    const verdict = aggregate(DECLARED, [
      {
        lens: 'correctness',
        outcome: 'rejected',
        findings: [{ lens: 'correctness', summary: 'the summary', detail: '' }],
      },
    ]);
    const lines = renderReport(verdict, CONTEXT).split('\n');
    const at = lines.findIndex((line) => line.includes('the summary'));
    expect(lines[at + 1]).toBe('');
  });

  // The ordering rule. Burying an incomplete review under a findings list is
  // how the findings get addressed and the gap does not.
  it('reports lenses that did not run BEFORE any findings', () => {
    const verdict = aggregate(DECLARED, [
      rejected('correctness', 'a real finding'),
      couldNotRun('honesty', 'model returned no content'),
      approved('blast-radius'),
    ]);
    const report = renderReport(verdict, CONTEXT);
    expect(report.indexOf('did not review')).toBeGreaterThan(-1);
    expect(report.indexOf('did not review')).toBeLessThan(report.indexOf('finding(s)'));
  });

  it('names each lens that did not run, with its reason', () => {
    const verdict = aggregate(DECLARED, [approved('correctness')]);
    const report = renderReport(verdict, CONTEXT);
    expect(report).toContain('2 of 3 lenses did not review');
    expect(report).toContain('- **honesty** — lens returned no result');
  });

  it('says the review is incomplete in words, not only in a count', () => {
    const verdict = aggregate(DECLARED, [approved('correctness')]);
    expect(renderReport(verdict, CONTEXT)).toContain('This review is incomplete');
  });

  // An approval has nothing to list, so it has to say something. A report that
  // is a heading and a footer reads like a run that did nothing.
  it('says explicitly that every lens reviewed when it approves', () => {
    const report = renderReport(aggregate(DECLARED, DECLARED.map(approved)), CONTEXT);
    expect(report).toContain('Every lens reviewed and none had a finding');
  });

  // Cannot fail alone — delete the whole `approved` branch and this passes.
  // It is load-bearing only as the negative half of the pair above it, and
  // that pair together does pin the branch. Kept, and labelled, rather than
  // dressed up as an independent guard.
  it('claims nothing about completeness when it did not approve', () => {
    const report = renderReport(aggregate(DECLARED, [approved('correctness')]), CONTEXT);
    expect(report).not.toContain('Every lens reviewed');
  });
});
