// Direct coverage for the layer that catches a manufactured finding (C2,
// C3) — see verifyFindings.ts's header for the design this pins. Every
// other test in this suite exercises `findingIsVerified` and
// `verifyLensResult` only through `panel.ts` or `run.ts`, one remove from
// the arithmetic they actually do; this file is the arithmetic itself.

import { describe, expect, it } from 'vitest';

import type { Finding, LensResult } from '../src/review/verdict.js';
import {
  checkEvidence,
  findingIsVerified,
  verifyLensResult,
} from '../src/review/verifyFindings.js';

const LENS = 'correctness';

// A realistic diff, not a one-liner — the manufactured-finding case below
// needs a body plausible enough that a convincing claim about it is
// believable right up until it is checked.
const DIFF = `--- a/src/retry.ts
+++ b/src/retry.ts
@@
-function retry(fn) {
-  while (true) {
-    try {
-      return fn();
-    } catch {
-      continue;
-    }
-  }
-}
+function retry(fn, maxAttempts) {
+  for (let attempt = 0; attempt < maxAttempts; attempt++) {
+    try {
+      return fn();
+    } catch {
+      continue;
+    }
+  }
+  throw new Error('retry exhausted');
+}
`;

function quoteFinding(summary: string, text: string): Finding {
  return { lens: LENS, summary, evidence: { kind: 'quote', text } };
}
function absentFinding(summary: string, text: string): Finding {
  return { lens: LENS, summary, evidence: { kind: 'absence', text } };
}
function bareFinding(summary: string): Finding {
  return { lens: LENS, summary };
}

describe('findingIsVerified', () => {
  it('passes a quote that is actually in the diff', () => {
    const finding = quoteFinding(
      'bounds the retry loop',
      'for (let attempt = 0; attempt < maxAttempts; attempt++)',
    );
    expect(findingIsVerified(finding, DIFF)).toBe(true);
  });

  it('catches a quote that is not in the diff', () => {
    const finding = quoteFinding('adds logging on each attempt', 'console.log(attempt)');
    expect(findingIsVerified(finding, DIFF)).toBe(false);
  });

  it('passes an absence that is genuinely absent', () => {
    const finding = absentFinding('adds no logging', 'console.log(');
    expect(findingIsVerified(finding, DIFF)).toBe(true);
  });

  it('catches an absence claim about text the diff actually contains', () => {
    const finding = absentFinding('does not bound the attempts', 'maxAttempts');
    expect(findingIsVerified(finding, DIFF)).toBe(false);
  });

  it('refuses a finding with no evidence at all — unverifiable, not innocent', () => {
    expect(findingIsVerified(bareFinding('something is wrong here'), DIFF)).toBe(false);
  });

  it('refuses blank evidence text', () => {
    expect(findingIsVerified(quoteFinding('x', ''), DIFF)).toBe(false);
    expect(findingIsVerified(absentFinding('y', ''), DIFF)).toBe(false);
  });

  // `''.includes('')` and `!diff.includes('')` would otherwise "verify" a
  // quote against any diff and refuse every absence outright — the header
  // calls this out explicitly, so it gets its own case, distinct from
  // simply-empty.
  it('refuses whitespace-only evidence text, quote and absence alike', () => {
    expect(findingIsVerified(quoteFinding('x', '   \n\t '), DIFF)).toBe(false);
    expect(findingIsVerified(absentFinding('y', '  '), DIFF)).toBe(false);
  });

  // The realistic failure this file exists for: not garbled, not empty —
  // plausible, specific, well-formed, and simply never in the diff. This is
  // what a wrong reviewer actually produces, not a truncated or malformed
  // reply.
  it('catches a manufactured finding that is plausible but was never in the diff', () => {
    const manufactured = quoteFinding(
      'the retry loop has no upper bound, so a permanently failing call spins forever',
      'while (attempts < Infinity)',
    );
    expect(findingIsVerified(manufactured, DIFF)).toBe(false);
  });
});

// A same-line, byte-exact truncation, tried first and kept as a documented
// negative result: if `text` is a character-exact prefix of content really
// in the diff, `text` is thereby already a substring of the diff at that
// same position, so plain `diff.includes(text)` already succeeds. There is
// no length-based, single-line "cut short" case that fails today's check —
// the arithmetic makes it impossible. This fixture exists to pin that down
// rather than let it be re-discovered the hard way a second time.
const SINGLE_LINE_DIFF = `--- a/src/thing.ts
+++ b/src/thing.ts
@@
+export function tooLong(): void {
+throw new Error('this message is long enough to be truncated mid-sentence by a token limit');
+}
`;
const A_TRUE_PREFIX_OF_A_REAL_LINE =
  "throw new Error('this message is long enough to be truncated mid-sentence by a token";

// The real case, verbatim: the exact 80-character string this project's own
// review report showed twice (the ellipsis the preview appended is not part
// of the citation and is left off here), and the actual two-line excerpt of
// scripts/check-cli.mjs it was quoting. The sentence it is drawn from wraps
// across a source line — "...specifically is" ends one comment line,
// "covered directly..." begins the next — the way a person reading wrapped
// prose reads it as one sentence, joined by a space where the source has a
// newline and the next line's `//`. That reshaping, not a length cut, is
// what made this fail before this file's fix.
const CHECK_CLI_DIFF = `--- a/scripts/check-cli.mjs
+++ b/scripts/check-cli.mjs
@@
+// failure must fail the run loudly rather than pass silently with an
+// unreadable report; overriding a genuine approval's 0 specifically is
+// covered directly in tests/reportFile.test.ts, with a fake outcome, since
+// forcing a real approval here would cost a real model call.
`;
const REAL_OBSERVED_QUOTE =
  "overriding a genuine approval's 0 specifically is covered directly in tests/repo";

// A citation that would only match if a `//` were stripped from somewhere
// other than a genuine line start — proving the marker-stripping in
// `joinedProse` cannot be walked into matching content it should not.
const FABRICATED_ACROSS_MARKERS = 'is covered by a mechanism that does not exist anywhere here';

describe('checkEvidence — the three-way check, and what "truncated" actually turned out to mean', () => {
  it('an exact quote is verified', () => {
    expect(
      checkEvidence(
        { kind: 'quote', text: 'for (let attempt = 0; attempt < maxAttempts; attempt++)' },
        DIFF,
      ),
    ).toBe('verified');
  });

  // The negative result, pinned: a true prefix of a real line is ALREADY
  // verified by plain substring matching. There is no separate "truncated"
  // outcome for this shape, because there cannot be one.
  it('a true, byte-exact prefix of a real single line is verified outright, not truncated', () => {
    expect(
      checkEvidence({ kind: 'quote', text: A_TRUE_PREFIX_OF_A_REAL_LINE }, SINGLE_LINE_DIFF),
    ).toBe('verified');
  });

  it('a quote matching nothing at all, joined or not, is unverifiable', () => {
    expect(
      checkEvidence(
        { kind: 'quote', text: 'while (attempts < Infinity) { spin(); }' },
        SINGLE_LINE_DIFF,
      ),
    ).toBe('unverifiable');
    expect(checkEvidence({ kind: 'quote', text: FABRICATED_ACROSS_MARKERS }, CHECK_CLI_DIFF)).toBe(
      'unverifiable',
    );
  });

  // The real, twice-observed case: not a raw match (the source wrap sits
  // between "is" and "covered"), but a genuine prefix of the diff's content
  // once read as joined prose. This is the case that was wrongly treated
  // the same as a fabrication before this fix.
  it('the real observed case — a citation across a source line-wrap — is truncated, not unverifiable', () => {
    expect(checkEvidence({ kind: 'quote', text: REAL_OBSERVED_QUOTE }, CHECK_CLI_DIFF)).toBe(
      'truncated',
    );
  });

  // Gap #1, found on a re-read of this file's own first version: `joinedProse`
  // collapsed the diff's whitespace but the quote was compared raw. A
  // citation quoted with a double space — exactly the formatting variance a
  // reviewer's prose can introduce — failed to match before this fix, even
  // though every word is real and in order. Fails on the code as it stood
  // before this change: it asserted 'unverifiable'.
  it('a citation with different internal whitespace from the diff still verifies as truncated, not unverifiable', () => {
    const withDoubleSpace = REAL_OBSERVED_QUOTE.replace(
      'specifically is covered',
      'specifically is  covered',
    );
    expect(checkEvidence({ kind: 'quote', text: withDoubleSpace }, CHECK_CLI_DIFF)).toBe(
      'truncated',
    );
    const withTab = REAL_OBSERVED_QUOTE.replace('0 specifically', '0\tspecifically');
    expect(checkEvidence({ kind: 'quote', text: withTab }, CHECK_CLI_DIFF)).toBe('truncated');
  });

  // Gap #2: the original check required strictly more prose after the
  // match, a leftover from the disproven "cut short" theory. A citation of
  // the diff's FINAL sentence — nothing left over after it — is exactly as
  // genuine as one with more text following it. Fails on the code as it
  // stood before this change: it asserted 'unverifiable'.
  it('a citation ending at the very end of the diff is truncated, not unverifiable for having nothing after it', () => {
    const finalSentence = 'since forcing a real approval here would cost a real model call.';
    expect(checkEvidence({ kind: 'quote', text: finalSentence }, CHECK_CLI_DIFF)).toBe('truncated');
  });

  // Proves the guard still holds after both fixes above: normalising
  // whitespace and dropping the trailing-content requirement both WIDEN
  // what can match, so each needs its own proof that a genuinely invented
  // word still fails. Mirrors the existing FABRICATED_ACROSS_MARKERS case,
  // for the whitespace/boundary changes specifically.
  it('an inserted word still fails, even though the rest of the citation is real and whitespace differs too', () => {
    const withInventedWord = REAL_OBSERVED_QUOTE.replace('specifically is', 'specifically is  not');
    expect(checkEvidence({ kind: 'quote', text: withInventedWord }, CHECK_CLI_DIFF)).toBe(
      'unverifiable',
    );
  });

  it('an absence claim has no truncated form — genuinely absent, or unverifiable, nothing between', () => {
    expect(checkEvidence({ kind: 'absence', text: 'console.log(' }, DIFF)).toBe('verified');
    expect(checkEvidence({ kind: 'absence', text: 'maxAttempts' }, DIFF)).toBe('unverifiable');
    // Joined prose is deliberately not consulted for an absence claim — see
    // checkEvidence's own comment on why.
    expect(
      checkEvidence({ kind: 'absence', text: 'overriding a genuine approval' }, CHECK_CLI_DIFF),
    ).toBe('unverifiable');
  });
});

describe('verifyLensResult', () => {
  it('is a no-op for approved, returned by reference', () => {
    const result: LensResult = { lens: LENS, outcome: 'approved', findings: [] };
    expect(verifyLensResult(result, DIFF)).toBe(result);
  });

  it('is a no-op for could_not_run, returned by reference', () => {
    const result: LensResult = {
      lens: LENS,
      outcome: 'could_not_run',
      findings: [],
      reason: 'model returned no content',
    };
    expect(verifyLensResult(result, DIFF)).toBe(result);
  });

  it('returns a rejection unchanged, by reference, when every finding verifies', () => {
    const result: LensResult = {
      lens: LENS,
      outcome: 'rejected',
      findings: [
        quoteFinding('bounds the retry loop', 'maxAttempts'),
        absentFinding('adds no logging', 'console.log('),
      ],
    };
    expect(verifyLensResult(result, DIFF)).toBe(result);
  });

  it('downgrades the whole result to could_not_run when one finding fails to verify', () => {
    const good = quoteFinding('bounds the retry loop', 'maxAttempts');
    const manufactured = quoteFinding('adds logging on each attempt', 'console.log(attempt)');
    const result: LensResult = { lens: LENS, outcome: 'rejected', findings: [good, manufactured] };

    const verified = verifyLensResult(result, DIFF);

    expect(verified).toEqual({
      lens: LENS,
      outcome: 'could_not_run',
      findings: [],
      reason:
        '1 of 2 finding(s) did not verify against the diff, so the whole rejection is withheld:\n' +
        '  - "adds logging on each attempt" — quoted evidence not found in the diff: ' +
        '"console.log(attempt)"',
    });
  });

  // The deliberate asymmetry the file header names: a sound finding does not
  // survive alongside a manufactured one in the same reply, because a reply
  // that manufactured one claim cannot be mechanically trusted on the rest.
  it('withholds a sound finding alongside a manufactured one in the same reply', () => {
    const good = quoteFinding('bounds the retry loop', 'maxAttempts');
    const manufactured = absentFinding('adds no error handling', 'try {');
    const result: LensResult = { lens: LENS, outcome: 'rejected', findings: [good, manufactured] };

    const verified = verifyLensResult(result, DIFF);

    expect(verified.outcome).toBe('could_not_run');
    expect(verified.findings).toEqual([]);
    // The sound finding is gone from the result too, not merely unmentioned
    // in the reason — this is the withholding, not a filter.
    expect(verified.reason).not.toContain('bounds the retry loop');
  });

  it('names every failing finding, not just the first, when more than one fails', () => {
    const first = quoteFinding('a', 'this text is nowhere in the diff');
    const second = absentFinding('b', 'maxAttempts'); // present, so the claim fails
    const result: LensResult = { lens: LENS, outcome: 'rejected', findings: [first, second] };

    const verified = verifyLensResult(result, DIFF);

    expect(verified.outcome).toBe('could_not_run');
    expect(verified.reason).toContain('2 of 2 finding(s)');
    expect(verified.reason).toContain('this text is nowhere in the diff');
    expect(verified.reason).toContain('maxAttempts');
  });

  it('truncates a long quote preview in the failure reason', () => {
    const longText = 'x'.repeat(100);
    const result: LensResult = {
      lens: LENS,
      outcome: 'rejected',
      findings: [quoteFinding('too long to quote in full', longText)],
    };

    const verified = verifyLensResult(result, DIFF);

    expect(verified.reason).toContain(`${'x'.repeat(80)}…`);
    expect(verified.reason).not.toContain('x'.repeat(81));
  });

  // The behaviour this whole file exists to add, proven with the real,
  // twice-observed citation rather than an imagined one. Before this fix,
  // this exact case — a real quote, reshaped by a source line-wrap, nothing
  // else wrong with the reply — was withheld identically to a fabrication.
  // This test fails on the code as it stood before this change: it asserted
  // `unverifiable`, not `truncated`.
  it('the real observed finding survives, marked as reshaped, rather than being withheld', () => {
    const result: LensResult = {
      lens: LENS,
      outcome: 'rejected',
      findings: [
        quoteFinding('the write-failure test only proves the pure function', REAL_OBSERVED_QUOTE),
      ],
    };

    const verified = verifyLensResult(result, CHECK_CLI_DIFF);

    expect(verified.outcome).toBe('rejected');
    expect(verified.findings).toHaveLength(1);
    expect(verified.findings[0]?.detail).toContain('reshaped by a source line wrap');
    // Everything else about the finding is untouched.
    expect(verified.findings[0]?.summary).toBe(
      'the write-failure test only proves the pure function',
    );
    expect(verified.findings[0]?.evidence).toEqual({ kind: 'quote', text: REAL_OBSERVED_QUOTE });
  });

  // The boundary fix, at this level: a finding quoting exactly the diff's
  // final sentence survives as truncated rather than being withheld for
  // having nothing after it. Fails on the code as it stood before this
  // change: outcome would have been 'could_not_run'.
  it("a finding quoting the diff's final sentence survives, rather than being withheld for having nothing after it", () => {
    const finalSentence = 'since forcing a real approval here would cost a real model call.';
    const result: LensResult = {
      lens: LENS,
      outcome: 'rejected',
      findings: [
        quoteFinding('the fake-outcome justification is buried at the end', finalSentence),
      ],
    };

    const verified = verifyLensResult(result, CHECK_CLI_DIFF);

    expect(verified.outcome).toBe('rejected');
    expect(verified.findings).toHaveLength(1);
    expect(verified.findings[0]?.detail).toContain('reshaped by a source line wrap');
  });

  // The collateral rule, argued in the file header and pinned here: a
  // truncated finding does not escape being withheld when a SIBLING in the
  // same reply is genuinely unverifiable. Only a reply with nothing
  // fabricated in it gets its truncated findings kept.
  it('a truncated finding is still withheld when a sibling in the same reply is unverifiable', () => {
    const truncated = quoteFinding('cut short but real', REAL_OBSERVED_QUOTE);
    const manufactured = quoteFinding('invented entirely', FABRICATED_ACROSS_MARKERS);
    const result: LensResult = {
      lens: LENS,
      outcome: 'rejected',
      findings: [truncated, manufactured],
    };

    const verified = verifyLensResult(result, CHECK_CLI_DIFF);

    expect(verified.outcome).toBe('could_not_run');
    expect(verified.findings).toEqual([]);
    expect(verified.reason).not.toContain('cut short but real');
  });
});
