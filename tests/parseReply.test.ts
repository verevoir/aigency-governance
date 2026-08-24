import { describe, expect, it } from 'vitest';

import { parseReply } from '../src/review/parseReply.js';
import {
  APPROVED_WORD,
  CANNOT_RUN_WORD,
  FINDING_MARKER,
  REASON_MARKER,
  REJECTED_WORD,
  REPLY_CONTRACT,
  VERDICT_MARKER,
} from '../src/review/replyContract.js';

const LENS = 'correctness';

function parse(...lines: string[]): ReturnType<typeof parseReply> {
  return parseReply(LENS, lines.join('\n'));
}

describe('parseReply — the three answers it can give', () => {
  it('reads a clean approval', () => {
    const result = parse('Looks fine to me.', '', `${VERDICT_MARKER} ${APPROVED_WORD}`);
    expect(result).toEqual({ lens: LENS, outcome: 'approved', findings: [] });
  });

  it('reads a rejection and carries every finding, tagged with the lens', () => {
    const result = parse(
      `${VERDICT_MARKER} ${REJECTED_WORD}`,
      `${FINDING_MARKER} the retry loop has no ceiling`,
      `${FINDING_MARKER} the catch returns a default`,
    );
    expect(result.outcome).toBe('rejected');
    expect(result.findings).toEqual([
      { lens: LENS, summary: 'the retry loop has no ceiling' },
      { lens: LENS, summary: 'the catch returns a default' },
    ]);
  });

  it('reads a declared could_not_run and takes its reason', () => {
    const result = parse(
      `${VERDICT_MARKER} ${CANNOT_RUN_WORD}`,
      `${REASON_MARKER} the diff was truncated`,
    );
    expect(result.outcome).toBe('could_not_run');
    expect(result.reason).toBe('the diff was truncated');
  });

  it('supplies a reason when a could_not_run gives none', () => {
    const result = parse(`${VERDICT_MARKER} ${CANNOT_RUN_WORD}`);
    expect(result.reason).toBe('reviewer gave no reason');
  });

  it('falls back when the REASON: line is present but empty', () => {
    const result = parse(`${VERDICT_MARKER} ${CANNOT_RUN_WORD}`, REASON_MARKER);
    expect(result.reason).toBe('reviewer gave no reason');
  });
});

describe('parseReply — replies it cannot read', () => {
  it('refuses an empty reply', () => {
    expect(parseReply(LENS, '').reason).toBe('reply was empty');
  });

  it('refuses a reply that is only whitespace', () => {
    expect(parseReply(LENS, '   \n\n  ').reason).toBe('reply was empty');
  });

  it('refuses a reply with no verdict line, saying so', () => {
    const result = parse('I read the diff and I have thoughts.');
    expect(result.outcome).toBe('could_not_run');
    expect(result.reason).toContain(`no ${VERDICT_MARKER} line`);
  });

  // Not "take the last one" — two verdict lines means two claims, and any
  // rule for choosing between them is a guess that leaves no trace.
  it('refuses two verdict lines rather than picking one', () => {
    const result = parse(
      `${VERDICT_MARKER} ${APPROVED_WORD}`,
      `${VERDICT_MARKER} ${REJECTED_WORD}`,
    );
    expect(result.outcome).toBe('could_not_run');
    expect(result.reason).toContain(`2 ${VERDICT_MARKER} lines`);
  });

  // The message must describe the reply that arrived. An empty marker was
  // written; reporting it as absent is a false statement in the one string a
  // human reads when a panel goes red for no obvious reason.
  it('calls an empty verdict line empty, not absent', () => {
    const result = parse(VERDICT_MARKER);
    expect(result.outcome).toBe('could_not_run');
    expect(result.reason).toContain(`empty ${VERDICT_MARKER} line`);
    expect(result.reason).not.toContain(`no ${VERDICT_MARKER} line`);
  });

  it('counts an empty verdict line as one of the two', () => {
    const result = parse(VERDICT_MARKER, `${VERDICT_MARKER} ${APPROVED_WORD}`);
    expect(result.outcome).toBe('could_not_run');
    expect(result.reason).toContain(`2 ${VERDICT_MARKER} lines`);
  });

  it('refuses an unrecognised verdict, quoting what it got', () => {
    const result = parse(`${VERDICT_MARKER} maybe`);
    expect(result.outcome).toBe('could_not_run');
    expect(result.reason).toContain('maybe');
  });

  // Pinned as intent, not discovered as behaviour. The contract says "exactly
  // as described"; a reviewer that cannot follow a three-word instruction is
  // better visible than quietly interpreted.
  it('refuses a verdict with trailing punctuation', () => {
    const result = parse(`${VERDICT_MARKER} ${APPROVED_WORD}.`);
    expect(result.outcome).toBe('could_not_run');
    expect(result.reason).toContain('unrecognised');
  });

  it('refuses an approval that also reports findings', () => {
    const result = parse(
      `${VERDICT_MARKER} ${APPROVED_WORD}`,
      `${FINDING_MARKER} but the bound moved`,
    );
    expect(result.outcome).toBe('could_not_run');
    expect(result.reason).toContain('1 finding(s)');
  });

  // The gap the failure-modes lens found on this PR's own review: outOfScope()
  // was a structural mirror of cannotRun() and had inherited none of the
  // approved-with-findings guard above — a reply declaring out_of_scope while
  // also naming a finding was silently read as a clean, empty-findings
  // out_of_scope result, with the contradiction thrown away.
  it('refuses an out_of_scope that also reports findings', () => {
    const result = parse(
      `${VERDICT_MARKER} ${OUT_OF_SCOPE_WORD}`,
      `${FINDING_MARKER} but the bound moved`,
    );
    expect(result.outcome).toBe('could_not_run');
    expect(result.reason).toContain('1 finding(s)');
  });

  // THE regression test. Before the fix this returned `approved`: the bare
  // marker was dropped, so the guard above never saw it. The realistic
  // trigger is a reviewer writing the marker on its own line with the text
  // beneath — a formatting habit, not a malformed reply.
  it('refuses an approval carrying an empty finding marker', () => {
    const result = parse(
      `${VERDICT_MARKER} ${APPROVED_WORD}`,
      FINDING_MARKER,
      'The retry loop has no ceiling.',
    );
    expect(result.outcome).toBe('could_not_run');
    expect(result.reason).toContain(`empty ${FINDING_MARKER} line`);
  });

  it('refuses a rejection that names nothing', () => {
    const result = parse(`${VERDICT_MARKER} ${REJECTED_WORD}`);
    expect(result.outcome).toBe('could_not_run');
    expect(result.reason).toContain('without naming a finding');
  });

  it('distinguishes a rejection with empty markers from one with none at all', () => {
    const result = parse(`${VERDICT_MARKER} ${REJECTED_WORD}`, FINDING_MARKER);
    expect(result.outcome).toBe('could_not_run');
    expect(result.reason).toContain('named nothing');
  });

  // A reviewer that quotes the instructions back produces three indented
  // verdict lines. Same family as the marker-on-its-own-line habit, and the
  // safe direction is the same one.
  it('refuses a reply that quotes the contract back', () => {
    const result = parseReply(LENS, `Here is what you asked for:\n\n${REPLY_CONTRACT}`);
    expect(result.outcome).toBe('could_not_run');
    // Pinned to the reason, not just the colour. Without this the test passes
    // against a parser broken in almost any direction, since could_not_run is
    // what this parser returns whenever it is unsure.
    expect(result.reason).toContain(`3 ${VERDICT_MARKER} lines`);
  });
});

describe('parseReply — how it reads a line', () => {
  it('matches a marker indented by whitespace', () => {
    const result = parse(`    ${VERDICT_MARKER} ${APPROVED_WORD}`);
    expect(result.outcome).toBe('approved');
  });

  it('accepts a verdict word in any case', () => {
    expect(parse(`${VERDICT_MARKER} APPROVED`).outcome).toBe('approved');
    expect(parse(`${VERDICT_MARKER} Approved`).outcome).toBe('approved');
  });

  it('ignores prose above the markers', () => {
    const result = parse(
      'I looked at this for a while.',
      'VERDICT is a strong word but here goes.',
      `${VERDICT_MARKER} ${APPROVED_WORD}`,
    );
    expect(result.outcome).toBe('approved');
  });

  it('matches an indented finding marker and trims its text', () => {
    const result = parse(
      `${VERDICT_MARKER} ${REJECTED_WORD}`,
      `   ${FINDING_MARKER}    the bound moved   `,
    );
    expect(result.findings).toEqual([{ lens: LENS, summary: 'the bound moved' }]);
  });

  it('matches an indented reason marker', () => {
    const result = parse(`${VERDICT_MARKER} ${CANNOT_RUN_WORD}`, `  ${REASON_MARKER}  truncated  `);
    expect(result.reason).toBe('truncated');
  });

  // Weak by construction, and kept anyway. `parseReply` has no throw site, so
  // this passes for any total function including one that ignores its input
  // entirely. It is a tripwire for a future refactor that introduces one, and
  // it is not evidence that the parsing is robust — the cases above are.
  it('never throws, whatever it is handed', () => {
    const inputs = [
      '',
      '\n',
      'VERDICT',
      `${VERDICT_MARKER}${FINDING_MARKER}`,
      ' ',
      'x'.repeat(5000),
    ];
    for (const input of inputs) {
      expect(() => parseReply(LENS, input)).not.toThrow();
    }
  });
});

// The drift this whole pair of modules exists to prevent: the prompt showing
// a form the parser does not accept. Asserted by round-tripping the exact
// strings the contract advertises, so a change to either side that does not
// change the other goes red here.
describe('the contract round-trips', () => {
  it('accepts each verdict line the contract advertises', () => {
    expect(parseReply(LENS, `${VERDICT_MARKER} ${APPROVED_WORD}`).outcome).toBe('approved');
    expect(
      parseReply(LENS, `${VERDICT_MARKER} ${REJECTED_WORD}\n${FINDING_MARKER} a real finding`)
        .outcome,
    ).toBe('rejected');
    expect(parseReply(LENS, `${VERDICT_MARKER} ${CANNOT_RUN_WORD}`).outcome).toBe('could_not_run');
  });

  // DORMANT, deliberately. `REPLY_CONTRACT` is built by interpolating these
  // six constants, so this asserts that a string contains substrings the
  // compiler put there — no edit to the parser can turn it red. It is a
  // tripwire for one specific future change: someone retyping the contract as
  // literal prose, which is exactly the drift `replyContract.ts` exists to
  // prevent. Until that day it buys nothing, and saying so is cheaper than
  // letting the green tick imply otherwise. The live version of this
  // assertion is the round-trip test above.
  it('interpolates every marker into the contract (dormant tripwire)', () => {
    for (const marker of [VERDICT_MARKER, FINDING_MARKER, REASON_MARKER]) {
      expect(REPLY_CONTRACT).toContain(marker);
    }
    for (const word of [APPROVED_WORD, REJECTED_WORD, CANNOT_RUN_WORD]) {
      expect(REPLY_CONTRACT).toContain(word);
    }
  });
});
