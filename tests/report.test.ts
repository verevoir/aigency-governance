import { describe, expect, it } from 'vitest';

import { exitCodeFor, renderReport } from '../src/review/report.js';
import { aggregate, type LensResult } from '../src/review/verdict.js';

const DECLARED = ['correctness', 'honesty', 'blast-radius'];
const CONTEXT = {
  source: 'review/lenses.json',
  subject: 'PR #1: add a retry',
  model: 'claude-sonnet-5',
};

function approved(lens: string): LensResult {
  return { lens, outcome: 'approved', findings: [] };
}
function rejected(lens: string, ...summaries: string[]): LensResult {
  return { lens, outcome: 'rejected', findings: summaries.map((summary) => ({ lens, summary })) };
}
function couldNotRun(lens: string, reason: string): LensResult {
  return { lens, outcome: 'could_not_run', findings: [], reason };
}
function outOfScope(lens: string, reason: string): LensResult {
  return { lens, outcome: 'out_of_scope', findings: [], reason };
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

  // The operator decision (verdict.ts, aggregate): a change nothing actually
  // evaluated is not reported the same colour as one that passed.
  it('is non-zero for out_of_scope', () => {
    expect(exitCodeFor('out_of_scope')).toBe(1);
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
    for (const results of [
      [rejected('correctness', 'x')],
      [approved('correctness')],
      DECLARED.map((lens) => outOfScope(lens, 'nothing to judge')),
    ]) {
      const report = renderReport(aggregate(DECLARED, results), CONTEXT);
      expect(report.split('\n')[0]).not.toContain('Approved');
    }
  });

  // Asserts the footer is a footer. The previous version said "footer" and
  // checked "anywhere in the string", so moving the attribution to the top
  // would have passed.
  // Not "on the last line" any more — see report.ts's own comment above
  // its `Model requested`/`Model served` push calls: those two lines are
  // deliberately fixed-format and grepped by exact prefix downstream
  // (review.yml's Assemble step), and were added, on purpose, AFTER the
  // attribution line this test used to expect to be last. That is real,
  // load-bearing production behaviour, not an accident this test happens
  // to catch — so the fix here is to assert what the report now actually,
  // correctly ends with, not to move the model line back before the
  // attribution.
  it('puts the source and lens count immediately before the model line(s), not last', () => {
    const report = renderReport(aggregate(DECLARED, DECLARED.map(approved)), CONTEXT);
    const lines = report.split('\n');
    const attributionAt = lines.findIndex((line) => line.startsWith('Judged by'));
    expect(attributionAt).toBeGreaterThan(-1);
    expect(lines[attributionAt]).toContain('Judged by 3 lens(es)');
    expect(lines[attributionAt]).toContain('review/lenses.json');
    // CONTEXT here carries no servedModel, so exactly one fixed-format line
    // follows the attribution — "Model requested" — and it is the report's
    // actual last line now.
    expect(lines[attributionAt + 1]).toBe('Model requested: `claude-sonnet-5`');
    expect(lines[lines.length - 1]).toBe('Model requested: `claude-sonnet-5`');
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

// PR #38 (aigency-runtime-v2): a lens that reviewed and found nothing in its
// scope is named — by lens and reason — the same way an unrun lens is, but
// must not be mistaken for one, and must not make an approval overclaim.
describe('renderReport, when a lens has nothing in its scope', () => {
  it('states "Nothing in scope" in the first line when every lens is out of scope', () => {
    const report = renderReport(
      aggregate(
        DECLARED,
        DECLARED.map((lens) => outOfScope(lens, 'nothing to judge')),
      ),
      CONTEXT,
    );
    expect(report.split('\n')[0]).toContain('Nothing in scope');
  });

  // The message body for a fully out-of-scope review — the paragraph under
  // the heading, not the heading word itself. Found missing by this PR's own
  // review (verification lens, PR #8): every test in this block checked the
  // heading, the bullet list, or the absence of the old overclaim string, but
  // none asserted the message report.ts actually prints for this outcome.
  // Deleting or garbling it in report.ts's `out_of_scope` branch left every
  // test here green.
  it('says explicitly that every lens found nothing within scope, in words', () => {
    const report = renderReport(
      aggregate(
        DECLARED,
        DECLARED.map((lens) => outOfScope(lens, 'nothing to judge')),
      ),
      CONTEXT,
    );
    expect(report).toContain(
      'Every lens looked at the whole change and found nothing within its declared scope.',
    );
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
  // opting out must not read as an incomplete review.
  it('still reads Approved, not Could not run, when only one lens is out_of_scope and the rest approve', () => {
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

// Finding Two's shape fix (aigency-governance PR #11's own review):
// ServedModelSink now accumulates every distinct model observed, rather
// than keeping only the last. These pin what the report actually SAYS for
// each of the three states that shape can now express — see ServedModels's
// own doc comment in report.ts for why the type is a non-empty tuple rather
// than a plain array.
describe('renderReport, servedModel', () => {
  it('omits the line entirely when nothing was observed', () => {
    const report = renderReport(aggregate(DECLARED, DECLARED.map(approved)), CONTEXT);
    expect(report).not.toContain('Model served');
  });

  it('reports a single observed model plainly when every call agreed', () => {
    const report = renderReport(aggregate(DECLARED, DECLARED.map(approved)), {
      ...CONTEXT,
      servedModel: ['claude-sonnet-5'] as const,
    });
    expect(report).toContain('Model served: `claude-sonnet-5`');
  });

  // The state the old single-slot shape could not express at all: more than
  // one distinct value observed. Marked, not merely listed, so a reader
  // cannot mistake a joined list for the name of one oddly-punctuated model.
  it('marks disagreement explicitly, naming every distinct value, when more than one model was observed', () => {
    const report = renderReport(aggregate(DECLARED, DECLARED.map(approved)), {
      ...CONTEXT,
      servedModel: ['claude-opus-5', 'claude-sonnet-5'] as const,
    });
    expect(report).toContain('Model served: `DISAGREED: claude-opus-5, claude-sonnet-5`');
  });

  // A one-model report and a two-model report must never read the same —
  // the exact ambiguity Finding Two exists to remove.
  it('is never the same text for a one-model run and a two-model run', () => {
    const oneModel = renderReport(aggregate(DECLARED, DECLARED.map(approved)), {
      ...CONTEXT,
      servedModel: ['claude-sonnet-5'] as const,
    });
    const twoModel = renderReport(aggregate(DECLARED, DECLARED.map(approved)), {
      ...CONTEXT,
      servedModel: ['claude-opus-5', 'claude-sonnet-5'] as const,
    });
    expect(oneModel).not.toBe(twoModel);
  });
});
