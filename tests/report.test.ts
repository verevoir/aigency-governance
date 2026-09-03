import { describe, expect, it } from 'vitest';

import { exitCodeFor, renderReport } from '../src/review/report.js';
import { aggregate, type LensResult } from '../src/review/verdict.js';

const DECLARED = ['correctness', 'honesty', 'blast-radius'];
const CONTEXT = { source: 'review/lenses.json', subject: 'PR #1: add a retry' };

function approved(lens: string): LensResult {
  return { lens, outcome: 'approved', findings: [] };
}
function rejected(lens: string, ...summaries: string[]): LensResult {
  return {
    lens,
    outcome: 'rejected',
    findings: summaries.map((summary) => ({ lens, summary, blocking: true })),
  };
}
function approvedWithSmell(lens: string, ...summaries: string[]): LensResult {
  return {
    lens,
    outcome: 'approved',
    findings: summaries.map((summary) => ({ lens, summary, blocking: false })),
  };
}
function couldNotRun(lens: string, reason: string): LensResult {
  return { lens, outcome: 'could_not_run', findings: [], reason };
}
function outOfScope(lens: string, reason: string): LensResult {
  return { lens, outcome: 'out_of_scope', findings: [], reason };
}

describe('exitCodeFor', () => {
  // Named for what it checks. The universal — that ONLY `rejected` and
  // `could_not_run` are non-zero — is carried by the tests below, and this
  // one passed a mutation that broke it. A test name asserting more than its
  // body is the same defect as a comment doing so.
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

  // FAIL NOISY, DO NOT BLOCK (operator resolution; see verdict.ts's
  // `aggregate`): a panel where every declared lens found nothing in its own
  // scope must not stop a merge, so this matches `approved`'s exit code —
  // even though it is a DIFFERENT outcome word and heading (see
  // renderReport's tests below), because "nothing to review" and "reviewed
  // and found nothing wrong" are different facts that both happen to be
  // fine to merge.
  it('is zero for out_of_scope, matching approved — it must not block a merge', () => {
    expect(exitCodeFor('out_of_scope')).toBe(0);
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
  // heading line. Includes the all-out_of_scope panel: it does not block a
  // merge, but it is not an approval either, and must not read as one.
  it('never puts the word Approved in a heading that is not an approval', () => {
    for (const results of [
      [rejected('correctness', 'x')],
      [approved('correctness')],
      DECLARED.map((lens) => outOfScope(lens, 'nothing to judge')),
    ]) {
      const verdict = aggregate(DECLARED, results);
      // Guards the test itself: every case in this list must actually be a
      // non-approval, or the assertion below would be vacuously true.
      expect(verdict.outcome).not.toBe('approved');
      const report = renderReport(verdict, CONTEXT);
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
        findings: [
          { lens: 'correctness', summary: 's', detail: 'the long version', blocking: true },
        ],
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
        findings: [{ lens: 'correctness', summary: 'the summary', detail: '', blocking: true }],
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

// PR #38 (aigency-runtime-v2): a lens that reviewed and found nothing in its
// scope is named — by lens and reason — the same way an unrun lens is, but
// must not be mistaken for one, and must not make an approval overclaim.
describe('renderReport, when a lens has nothing in its scope', () => {
  // FAIL NOISY, DO NOT BLOCK (operator resolution; see verdict.ts's
  // `aggregate`): an all-out_of_scope panel gets its OWN heading, not
  // "Approved" — it must not read as a real review that found nothing
  // wrong, even though (see exitCodeFor's tests above) it does not block a
  // merge either. verevoir/aigency-harness#8.
  it('states "Nothing in scope", not "Approved", in the first line when every lens is out of scope', () => {
    const verdict = aggregate(
      DECLARED,
      DECLARED.map((lens) => outOfScope(lens, 'nothing to judge')),
    );
    const report = renderReport(verdict, CONTEXT);
    expect(report.split('\n')[0]).toContain('Nothing in scope');
    expect(report.split('\n')[0]).not.toContain('Approved');
    // And it still does not block: the two questions get separate answers.
    expect(exitCodeFor(verdict.outcome)).toBe(0);
  });

  // The message body for the all-out-of-scope case — its own sentence, not
  // a reuse of the partial-out-of-scope one, which would read as a vacuous
  // "every lens with something in scope" when there were none.
  it("says explicitly that nothing was in any lens's scope, in words", () => {
    const report = renderReport(
      aggregate(
        DECLARED,
        DECLARED.map((lens) => outOfScope(lens, 'nothing to judge')),
      ),
      CONTEXT,
    );
    expect(report).toContain("Nothing in this change was within any lens's declared scope.");
  });

  it('names a lens that had nothing in scope, with its reason, before any findings', () => {
    const verdict = aggregate(DECLARED, [
      approved('correctness'),
      rejected('honesty', 'a real finding'),
      outOfScope('blast-radius', 'workflow YAML only, nothing about credential scope here'),
    ]);
    const report = renderReport(verdict, CONTEXT);
    expect(report).toContain(
      '- **blast-radius** — workflow YAML only, nothing about credential scope here',
    );
    expect(report.indexOf('nothing in scope')).toBeGreaterThan(-1);
    expect(report.indexOf('nothing in scope')).toBeLessThan(report.indexOf('finding(s)'));
    // The count line itself, with real, non-uniform numbers — 1 out-of-scope,
    // 1 rejected, 1 approved of 3 declared lenses — the same shape as the
    // sibling `unran` count assertion above ('2 of 3 lenses did not review').
    // Also found missing by this PR's own review: without this, swapping or
    // hardcoding either number in report.ts's out-of-scope heading line would
    // go uncaught by every test in this diff.
    expect(report).toContain('1 of 3 lens(es) had nothing in scope');
  });

  // The collapse this story exists to undo, at the report layer: one lens
  // opting out (a PARTIAL out-of-scope panel, not all of them) must not read
  // as an incomplete review, and must still read as a genuine approval.
  it('still reads Approved, not Could not run or Nothing in scope, when only one lens is out_of_scope and the rest approve', () => {
    const report = renderReport(
      aggregate(DECLARED, [
        approved('correctness'),
        approved('honesty'),
        outOfScope('blast-radius', 'nothing to judge'),
      ]),
      CONTEXT,
    );
    expect(report.split('\n')[0]).toContain('Approved');
  });

  // The overclaim this story exists to fix: "every lens reviewed" is false
  // the moment one of them reported nothing in scope instead.
  it('does not claim every lens reviewed when approving with a lens out of scope', () => {
    const report = renderReport(
      aggregate(DECLARED, [
        approved('correctness'),
        approved('honesty'),
        outOfScope('blast-radius', 'nothing to judge'),
      ]),
      CONTEXT,
    );
    expect(report).not.toContain('Every lens reviewed and none had a finding');
  });

  // The message body for the approved-with-an-out-of-scope-lens branch — the
  // positive half of the pair above it. The negative assertion above stays
  // true regardless of what the new string actually says, so it alone cannot
  // catch the new message being deleted or garbled; this pins the text
  // report.ts actually prints in that case. Also found missing by this PR's
  // own review.
  it('says explicitly what happened when it approves with a lens out of scope', () => {
    const report = renderReport(
      aggregate(DECLARED, [
        approved('correctness'),
        approved('honesty'),
        outOfScope('blast-radius', 'nothing to judge'),
      ]),
      CONTEXT,
    );
    expect(report).toContain(
      'Every lens with something in scope reviewed it and found nothing. See above for the ' +
        'lens(es) that had nothing in scope for this change.',
    );
  });
});

// Severity-weighted approval must not become severity-weighted invisibility:
// a smell finding does not sink the verdict, but it must still be SEEN.
describe('renderReport, severity-weighted findings', () => {
  it('approves while still printing a non-blocking finding, tagged', () => {
    const verdict = aggregate(DECLARED, [
      approvedWithSmell('correctness', 'stray trailing-newline edit to README'),
      approved('honesty'),
      approved('blast-radius'),
    ]);
    const report = renderReport(verdict, CONTEXT);
    expect(report.split('\n')[0]).toContain('Approved');
    expect(report).toContain('[smell] stray trailing-newline edit to README');
  });

  it('names the blocking/non-blocking split in the heading when the two are mixed', () => {
    const verdict = aggregate(DECLARED, [
      rejected('correctness', 'a real defect'),
      approvedWithSmell('honesty', 'a naming nit'),
      approved('blast-radius'),
    ]);
    const report = renderReport(verdict, CONTEXT);
    expect(report).toContain('2 finding(s) (1 blocking, 1 non-blocking)');
  });

  it('does not name a split when every finding is the same severity', () => {
    const report = renderReport(aggregate(DECLARED, [rejected('correctness', 'x')]), CONTEXT);
    expect(report).toContain('1 finding(s)');
    expect(report).not.toContain('blocking, ');
  });

  it('says in prose that a listed smell finding did not hold the approval up', () => {
    const verdict = aggregate(DECLARED, [
      approvedWithSmell('correctness', 'a naming nit'),
      approved('honesty'),
      approved('blast-radius'),
    ]);
    expect(renderReport(verdict, CONTEXT)).toContain('1 non-blocking finding(s) are listed above');
  });

  // Found by this PR's own self-review (correctness + verification lenses):
  // the heading-split condition is `smellCount > 0` alone, not "the two
  // severities are mixed" as an earlier version of the neighbouring comment
  // in report.ts used to claim -- an all-smell approval (blockingCount ===
  // 0, smellCount > 0) was an untested branch where the code and its own
  // comment disagreed.
  it('names the split even when every finding is non-blocking (an all-smell panel)', () => {
    const verdict = aggregate(DECLARED, [
      approvedWithSmell('correctness', 'a naming nit', 'a stray blank line'),
      approved('honesty'),
      approved('blast-radius'),
    ]);
    const report = renderReport(verdict, CONTEXT);
    expect(report).toContain('2 finding(s) (0 blocking, 2 non-blocking)');
  });

  // THE regression test for a blocking finding this PR's own self-review
  // raised (honesty lens): the approved-outcome sentence used to claim
  // "found nothing" / "none had a finding" unconditionally, so an approval
  // carrying a smell finding rendered a self-contradicting report --
  // approving while stating, in the very same paragraph, that nothing was
  // found. This asserts the negative directly rather than trusting the
  // positive wording elsewhere: neither phrase may appear anywhere in a
  // report that also lists a finding.
  it('never claims "found nothing" or "none had a finding" when the approval carries any finding', () => {
    const verdict = aggregate(DECLARED, [
      approvedWithSmell('correctness', 'a naming nit'),
      approved('honesty'),
      approved('blast-radius'),
    ]);
    const report = renderReport(verdict, CONTEXT);
    expect(report).not.toContain('found nothing');
    expect(report).not.toContain('none had a finding');
  });

  // The same contradiction, in the partial-out-of-scope branch: a smell
  // riding alongside a lens that had nothing in scope must not produce
  // "reviewed it and found nothing" either.
  it('never claims "found nothing" when approving with both a smell and an out-of-scope lens', () => {
    const verdict = aggregate(DECLARED, [
      approvedWithSmell('correctness', 'a naming nit'),
      approved('honesty'),
      outOfScope('blast-radius', 'nothing to judge'),
    ]);
    const report = renderReport(verdict, CONTEXT);
    expect(report.split('\n')[0]).toContain('Approved');
    // Not a blanket "found nothing" search: the out-of-scope section above
    // legitimately says a lens "found nothing within its own declared
    // dimension", which is true and not the contradiction under test. What
    // must not appear is the SUMMARY sentence claiming the whole approval
    // found nothing while a finding is listed.
    expect(report).not.toContain('reviewed it and found nothing');
    expect(report).toContain('Nothing it found held this up.');
  });
});
