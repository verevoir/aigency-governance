import { describe, expect, it } from 'vitest';

import type { LensSet } from '../src/review/lensSet.js';
import { NoRoomToAnswerError, runPanel, type Reviewer } from '../src/review/panel.js';
import type { Subject } from '../src/review/prompt.js';
import {
  APPROVED_WORD,
  FINDING_MARKER,
  REJECTED_WORD,
  VERDICT_MARKER,
} from '../src/review/replyContract.js';

const SET: LensSet = {
  version: 1,
  lenses: [
    { id: 'correctness', title: 'Correctness', focus: 'does it do what it says' },
    { id: 'honesty', title: 'Honesty', focus: 'does it report what it observed' },
    { id: 'blast-radius', title: 'Blast radius', focus: 'what does it touch that it need not' },
  ],
};

const SUBJECT: Subject = { title: 'a change', description: 'some prose', diff: '+const x = 1;' };

const APPROVE = `${VERDICT_MARKER} ${APPROVED_WORD}`;
const REJECT = `${VERDICT_MARKER} ${REJECTED_WORD}\n${FINDING_MARKER} a real finding`;

function replying(byLens: Record<string, string>): Reviewer {
  return (lensId) => Promise.resolve(byLens[lensId] ?? APPROVE);
}

describe('runPanel', () => {
  it('dispatches every declared lens exactly once', async () => {
    const seen: string[] = [];
    await runPanel(SET, SUBJECT, (lensId) => {
      seen.push(lensId);
      return Promise.resolve(APPROVE);
    });
    expect([...seen].sort()).toEqual(['blast-radius', 'correctness', 'honesty']);
  });

  it('approves when every lens approves', async () => {
    const run = await runPanel(SET, SUBJECT, replying({}));
    expect(run.verdict.outcome).toBe('approved');
    expect(run.verdict.findings).toEqual([]);
  });

  it('rejects when one lens rejects, carrying its finding', async () => {
    const run = await runPanel(SET, SUBJECT, replying({ honesty: REJECT }));
    expect(run.verdict.outcome).toBe('rejected');
    expect(run.verdict.findings).toEqual([{ lens: 'honesty', summary: 'a real finding' }]);
  });

  // The reason this uses allSettled rather than all. With `all`, the first
  // rejection abandons the lenses that had already finished — four completed
  // reviews discarded, and the report unable to say which four.
  //
  // Proven by mutation, and the proof is weaker than it looks: swapping in
  // `Promise.all` makes this test go red by THROWING out of `runPanel` at the
  // await, not by failing an assertion. The `toHaveLength(2)` line below — the
  // one that actually encodes "the finished reviews survived" — is never
  // reached under the mutation. So this goes red reliably and reports "something
  // threw" rather than "completed work was discarded". That cannot be written
  // around: under correct code there is nothing to catch. It is a limit worth
  // stating rather than a gap worth closing.
  it('keeps the reviews that finished when one reviewer throws', async () => {
    const run = await runPanel(SET, SUBJECT, (lensId) =>
      lensId === 'honesty' ? Promise.reject(new Error('socket hang up')) : Promise.resolve(REJECT),
    );
    expect(run.verdict.outcome).toBe('could_not_run');
    expect(run.verdict.unran).toEqual([
      { lens: 'honesty', reason: 'reviewer threw: socket hang up' },
    ]);
    expect(run.verdict.findings).toHaveLength(2);
  });

  // Rejects with a bare string on purpose. The rule that would object to that,
  // `@typescript-eslint/prefer-promise-reject-errors`, exists to stop us
  // WRITING non-Error rejections; a reviewer transport we do not control can
  // produce one anyway, and the branch that stringifies it is unreachable from
  // a test that only rejects with Errors. The previous version of this test
  // rejected with `new Error` and its name was a claim its body did not make.
  // No disable directive here: that rule is type-checked and this config loads
  // only `tseslint.configs.recommended`, so it is not enabled — and a disable
  // for a rule that is not on is itself a comment claiming something untrue.
  it('reports a NoRoomToAnswerError with its own reason, not "reviewer threw"', async () => {
    const run = await runPanel(SET, SUBJECT, (lensId) =>
      lensId === 'honesty'
        ? Promise.reject(
            new NoRoomToAnswerError(
              'response carried no text: 1 block(s) [thinking], stop_reason max_tokens',
            ),
          )
        : Promise.resolve(REJECT),
    );
    expect(run.verdict.unran).toEqual([
      {
        lens: 'honesty',
        reason:
          'no room to answer: response carried no text: 1 block(s) [thinking], stop_reason max_tokens',
      },
    ]);
  });

  it('does not lose a rejection that was not an Error', async () => {
    const run = await runPanel(SET, SUBJECT, (lensId) =>
      lensId === 'correctness' ? Promise.reject('rate limited') : Promise.resolve(APPROVE),
    );
    expect(run.verdict.unran[0]?.reason).toBe('reviewer threw: rate limited');
  });

  // A transport failure and an unreadable reply are the same fact from here:
  // this lens did not review. Neither may read as approval.
  it('treats an unreadable reply as could_not_run', async () => {
    const run = await runPanel(SET, SUBJECT, replying({ 'blast-radius': 'I have thoughts.' }));
    expect(run.verdict.outcome).toBe('could_not_run');
    expect(run.verdict.unran[0]?.lens).toBe('blast-radius');
  });

  it('returns one prompt per lens, all sharing a byte-identical prefix', async () => {
    const run = await runPanel(SET, SUBJECT, replying({}));
    expect(run.prompts.size).toBe(3);
    const halves = [...run.prompts.values()];
    expect(new Set(halves.map((prompt) => prompt.shared)).size).toBe(1);
    expect(new Set(halves.map((prompt) => prompt.perLens)).size).toBe(3);
  });

  // Without this, `prompts` could report something other than what was sent,
  // and the shared-prefix claim above would be about a different object than
  // the one the reviewer saw.
  it('reports the same prompts it dispatched', async () => {
    const received = new Map<string, string>();
    const run = await runPanel(SET, SUBJECT, (lensId, prompt) => {
      received.set(lensId, prompt.perLens);
      return Promise.resolve(APPROVE);
    });
    expect(received.size).toBe(3);
    for (const [lensId, perLens] of received) {
      expect(run.prompts.get(lensId)?.perLens).toBe(perLens);
    }
  });

  it('passes the practices through to every lens', async () => {
    const run = await runPanel(SET, SUBJECT, replying({}), 'the bar, as written');
    for (const prompt of run.prompts.values()) {
      expect(prompt.shared).toContain('the bar, as written');
    }
  });

  // NOTE ON THE FAILURE MODE: a serial implementation DEADLOCKS here rather
  // than failing an assertion — the first reviewer would await a gate that
  // only opens once the last one has started. A timeout is a blunt signal,
  // but it is unambiguous, and there is no way to assert concurrency that
  // does not depend on one.
  it('dispatches every lens before any of them finishes', async () => {
    const started: string[] = [];
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const run = await runPanel(SET, SUBJECT, async (lensId) => {
      started.push(lensId);
      if (started.length === SET.lenses.length) {
        open();
      }
      await gate;
      return APPROVE;
    });
    expect(started).toHaveLength(3);
    expect(run.verdict.outcome).toBe('approved');
  });
});
