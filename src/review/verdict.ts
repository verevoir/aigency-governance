// Aggregating what the panel said into one answer.
//
// Fails closed, and the definition of "closed" is stricter than it looks: the
// aggregate is computed against the lenses the definition DECLARED, not
// against the results that happened to arrive. A lens that produced nothing —
// crashed, timed out, was never dispatched — is a lens that did not review,
// and a panel missing a member has not approved anything.

export type Outcome = 'approved' | 'rejected' | 'could_not_run';

/**
 * What a finding claims to rest on — named so it can be checked, not
 * trusted (C2). Two shapes because a claim about the diff comes in two
 * directions and they are verified oppositely: `quote` says something is
 * THERE — verified by finding the text; `absence` says something is NOT
 * there — verified by not finding it. Collapsing them into one
 * `evidence: string` would make a finding about a gap read the same as one
 * about a line, and the two need opposite checks. See `verifyFindings.ts`
 * for where the check itself happens — this type only makes the claim
 * checkable.
 */
export type FindingEvidence =
  | { readonly kind: 'quote'; readonly text: string }
  | { readonly kind: 'absence'; readonly text: string };

export interface Finding {
  readonly lens: string;
  readonly summary: string;
  readonly detail?: string;
  /**
   * What this finding rests on, verbatim from the reviewer's reply.
   * Optional at this type only — a `Finding` built directly by code that has
   * already established trust another way (mainly tests) need not carry
   * one. A finding parsed from a real reply with no evidence line is
   * exactly the unverifiable case `verifyFindings.ts` exists to catch, and
   * it is treated as failing verification, never as passing by default.
   */
  readonly evidence?: FindingEvidence;
}

export interface LensResult {
  readonly lens: string;
  readonly outcome: Outcome;
  readonly findings: readonly Finding[];
  /** Why this lens could not run. Meaningless on the other two outcomes. */
  readonly reason?: string;
}

export interface Verdict {
  readonly outcome: Outcome;
  readonly results: readonly LensResult[];
  readonly findings: readonly Finding[];
  /** Lenses that were declared and did not return a review, with the reason. */
  readonly unran: readonly { readonly lens: string; readonly reason: string }[];
}

/** Thrown when the results and the definition disagree about who is on the panel. */
export class PanelMismatchError extends Error {
  override readonly name = 'PanelMismatchError';
}

/**
 * Combine per-lens results into one verdict.
 *
 * `could_not_run` outranks `rejected`. A rejection is information you can act
 * on; an incomplete review is a verdict that is not a verdict, and treating it
 * as merely "red for a different reason" is how it ends up being waved through
 * on the grounds that the findings were addressed.
 */
export function aggregate(declared: readonly string[], results: readonly LensResult[]): Verdict {
  const known = new Set(declared);
  const byLens = new Map<string, LensResult>();

  for (const result of results) {
    if (!known.has(result.lens)) {
      // The runner reviewed along a dimension the definition does not declare.
      // Silently keeping it would let a local edit add a lens; silently
      // dropping it would discard a real finding. Neither is acceptable.
      throw new PanelMismatchError(
        `result for undeclared lens ${JSON.stringify(result.lens)}; declared: ${declared.join(', ')}`,
      );
    }
    if (byLens.has(result.lens)) {
      throw new PanelMismatchError(`two results for lens ${JSON.stringify(result.lens)}`);
    }
    byLens.set(result.lens, result);
  }

  const ordered: LensResult[] = [];
  const unran: { lens: string; reason: string }[] = [];
  const findings: Finding[] = [];

  for (const lens of declared) {
    const result = byLens.get(lens) ?? {
      lens,
      outcome: 'could_not_run' as const,
      findings: [],
      reason: 'lens returned no result',
    };
    ordered.push(result);
    findings.push(...result.findings);
    if (result.outcome === 'could_not_run') {
      unran.push({ lens, reason: result.reason ?? 'no reason given' });
    }
  }

  const outcome: Outcome =
    unran.length > 0
      ? 'could_not_run'
      : ordered.some((result) => result.outcome === 'rejected')
        ? 'rejected'
        : 'approved';

  return { outcome, results: ordered, findings, unran };
}
