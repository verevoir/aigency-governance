// Direct coverage for the layer that catches a manufactured finding (C2,
// C3) — see verifyFindings.ts's header for the design this pins. Every
// other test in this suite exercises `findingIsVerified` and
// `verifyLensResult` only through `panel.ts` or `run.ts`, one remove from
// the arithmetic they actually do; this file is the arithmetic itself.

import { describe, expect, it } from 'vitest';

import type { Finding, LensResult } from '../src/review/verdict.js';
import { findingIsVerified, verifyLensResult } from '../src/review/verifyFindings.js';

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
});
