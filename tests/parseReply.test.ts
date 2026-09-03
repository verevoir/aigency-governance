import { describe, expect, it } from 'vitest';

import { parseReply } from '../src/review/parseReply.js';
import {
  APPROVED_WORD,
  BLOCKING_TAG,
  CANNOT_RUN_WORD,
  FINDING_MARKER,
  OUT_OF_SCOPE_WORD,
  REASON_MARKER,
  REJECTED_WORD,
  REPLY_CONTRACT,
  SMELL_TAG,
  VERDICT_MARKER,
} from '../src/review/replyContract.js';

const LENS = 'correctness';

function parse(...lines: string[]): ReturnType<typeof parseReply> {
  return parseReply(LENS, lines.join('\n'));
}

describe('parseReply — the four answers it can give', () => {
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
    // No severity tag on either line, so both fail closed to blocking.
    expect(result.findings).toEqual([
      { lens: LENS, summary: 'the retry loop has no ceiling', blocking: true },
      { lens: LENS, summary: 'the catch returns a default', blocking: true },
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

  // The fourth answer, read structurally like could_not_run — a word, then a
  // reason — but landing on a different outcome. See replyContract.ts's
  // header for why the two are not interchangeable.
  it('reads a declared out_of_scope and takes its reason', () => {
    const result = parse(
      `${VERDICT_MARKER} ${OUT_OF_SCOPE_WORD}`,
      `${REASON_MARKER} this diff touches only workflow YAML, nothing test-covered to judge`,
    );
    expect(result.outcome).toBe('out_of_scope');
    expect(result.reason).toBe(
      'this diff touches only workflow YAML, nothing test-covered to judge',
    );
  });

  it('supplies a reason when an out_of_scope gives none', () => {
    const result = parse(`${VERDICT_MARKER} ${OUT_OF_SCOPE_WORD}`);
    expect(result.reason).toBe('reviewer gave no reason');
  });

  it('accepts the out_of_scope word in any case, matching the other verdict words', () => {
    expect(parse(`${VERDICT_MARKER} OUT_OF_SCOPE`).outcome).toBe('out_of_scope');
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

  it('refuses an approval that also reports a blocking finding', () => {
    const result = parse(
      `${VERDICT_MARKER} ${APPROVED_WORD}`,
      `${FINDING_MARKER} but the bound moved`,
    );
    expect(result.outcome).toBe('could_not_run');
    // Untagged, so it fails closed to blocking and trips this guard.
    expect(result.reason).toContain('1 blocking finding(s)');
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

  // A reviewer that quotes the instructions back produces one indented
  // VERDICT: line per verdict word the contract advertises. Same family as
  // the marker-on-its-own-line habit, and the safe direction is the same one.
  it('refuses a reply that quotes the contract back', () => {
    const reply = `Here is what you asked for:\n\n${REPLY_CONTRACT}`;
    // Counted from `reply` itself -- the exact string handed to the parser
    // two lines below -- not from REPLY_CONTRACT read separately. That
    // separation was mistaken twice for a hardcoded literal disconnected
    // from its input; deriving the expectation from the same variable the
    // parser sees makes that mistake structurally impossible to repeat.
    const verdictLinesInReply = reply
      .split('\n')
      .filter((line) => line.trim().startsWith(VERDICT_MARKER)).length;
    const result = parseReply(LENS, reply);
    expect(result.outcome).toBe('could_not_run');
    // Pinned to the reason, not just the colour. Without this the test passes
    // against a parser broken in almost any direction, since could_not_run is
    // what this parser returns whenever it is unsure.
    expect(result.reason).toContain(`${verdictLinesInReply} ${VERDICT_MARKER} lines`);
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
    expect(result.findings).toEqual([{ lens: LENS, summary: 'the bound moved', blocking: true }]);
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

// Severity tags: what sets `blocking`, and the fail-closed default when it
// is absent or unrecognised. This is the reviewer-only channel the whole
// design leans on — see verdict.ts's Finding and replyContract.ts's header.
describe('parseReply — severity tags on findings', () => {
  it('reads an explicit [blocking] tag', () => {
    const result = parse(
      `${VERDICT_MARKER} ${REJECTED_WORD}`,
      `${FINDING_MARKER} [${BLOCKING_TAG}] the retry loop has no ceiling`,
    );
    expect(result.findings).toEqual([
      { lens: LENS, summary: 'the retry loop has no ceiling', blocking: true },
    ]);
  });

  it('reads an explicit [smell] tag as non-blocking, and approves alongside it', () => {
    const result = parse(
      `${VERDICT_MARKER} ${APPROVED_WORD}`,
      `${FINDING_MARKER} [${SMELL_TAG}] the naming is inconsistent with the rest of the file`,
    );
    expect(result.outcome).toBe('approved');
    expect(result.findings).toEqual([
      {
        lens: LENS,
        summary: 'the naming is inconsistent with the rest of the file',
        blocking: false,
      },
    ]);
  });

  it('reads the tag case-insensitively', () => {
    const result = parse(
      `${VERDICT_MARKER} ${APPROVED_WORD}`,
      `${FINDING_MARKER} [SMELL] a style nit`,
    );
    expect(result.findings[0]?.blocking).toBe(false);
  });

  // Fails closed, the same direction as every other ambiguity this parser
  // resolves. An untagged finding is not evidence the reviewer meant smell;
  // severity is written, never inferred.
  it('treats a finding with no severity tag as blocking', () => {
    const result = parse(
      `${VERDICT_MARKER} ${REJECTED_WORD}`,
      `${FINDING_MARKER} the catch returns a default`,
    );
    expect(result.findings[0]?.blocking).toBe(true);
  });

  it('treats an unrecognised tag as blocking rather than as smell or as absent', () => {
    const result = parse(
      `${VERDICT_MARKER} ${REJECTED_WORD}`,
      `${FINDING_MARKER} [minor] the catch returns a default`,
    );
    expect(result.findings[0]?.blocking).toBe(true);
    // The bogus tag stays visible in the summary rather than being silently
    // consumed — a human reading the report can still see what was written.
    expect(result.findings[0]?.summary).toContain('[minor]');
  });

  // Found by this PR's own self-review (failure-modes lens): a finding line
  // that is a severity tag and nothing else -- no text after `[blocking]` or
  // `[smell]` -- used to survive as a real finding with an empty summary,
  // because the empty-line check ran on the raw text ("[blocking]", not
  // empty) rather than on what severityOf() actually produced after
  // stripping the tag (empty). A blocking verdict with an empty summary is
  // exactly this project's signature defect: something absent reading as
  // something present.
  it('treats a tag-only finding line, with no text after the tag, as empty rather than as a real finding', () => {
    const result = parse(
      `${VERDICT_MARKER} ${APPROVED_WORD}`,
      `${FINDING_MARKER} [${BLOCKING_TAG}]`,
    );
    expect(result.outcome).toBe('could_not_run');
    expect(result.reason).toContain(`empty ${FINDING_MARKER} line`);
  });

  it('treats a tag-only finding line as empty under a rejection too', () => {
    const result = parse(`${VERDICT_MARKER} ${REJECTED_WORD}`, `${FINDING_MARKER} [${SMELL_TAG}]`);
    expect(result.outcome).toBe('could_not_run');
    expect(result.reason).toContain('named nothing');
  });

  it('still refuses an approval that carries a blocking finding alongside a smell one', () => {
    const result = parse(
      `${VERDICT_MARKER} ${APPROVED_WORD}`,
      `${FINDING_MARKER} [${SMELL_TAG}] a style nit`,
      `${FINDING_MARKER} [${BLOCKING_TAG}] the retry loop has no ceiling`,
    );
    expect(result.outcome).toBe('could_not_run');
    expect(result.reason).toContain('1 blocking finding(s)');
  });

  // A rejection made entirely of smells is a contradiction under the new
  // contract, same family as "rejected without naming a finding" — the
  // reviewer should have approved with notes instead.
  it('refuses a rejection whose only findings are non-blocking', () => {
    const result = parse(
      `${VERDICT_MARKER} ${REJECTED_WORD}`,
      `${FINDING_MARKER} [${SMELL_TAG}] a style nit`,
    );
    expect(result.outcome).toBe('could_not_run');
    expect(result.reason).toContain('non-blocking');
    expect(result.reason).toContain('at least one blocking finding');
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
    expect(
      parseReply(LENS, `${VERDICT_MARKER} ${OUT_OF_SCOPE_WORD}\n${REASON_MARKER} no material here`)
        .outcome,
    ).toBe('out_of_scope');
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
    for (const word of [
      APPROVED_WORD,
      REJECTED_WORD,
      CANNOT_RUN_WORD,
      OUT_OF_SCOPE_WORD,
      BLOCKING_TAG,
      SMELL_TAG,
    ]) {
      expect(REPLY_CONTRACT).toContain(word);
    }
  });
});
