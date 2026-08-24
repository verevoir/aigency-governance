// Aggregating what the panel said into one answer.
//
// Fails closed, and the definition of "closed" is stricter than it looks: the
// aggregate is computed against the lenses the definition DECLARED, not
// against the results that happened to arrive. A lens that produced nothing —
// crashed, timed out, was never dispatched — is a lens that did not review,
// and a panel missing a member has not approved anything.
//
// A LENS THAT REVIEWED AND FOUND NOTHING IN ITS SCOPE IS NOT THE SAME FACT AS
// A LENS THAT DID NOT REVIEW, AND COLLAPSING THEM WAS A REAL DEFECT, NOT A
// HYPOTHETICAL ONE. verevoir/aigency-runtime-v2#38
// (https://github.com/verevoir/aigency-runtime-v2/pull/38) changed only
// GitHub Actions workflow YAML — no test-covered code at all — and its own
// `review / review` check run (id 97088772135) still concluded could_not_run,
// annotated "nothing was reviewed", for a diff where the `verification`
// lens's declared mandate (review/lenses.json: judging changed tests) had
// nothing to attach to. The per-lens breakdown lives only in that run's job
// summary, which has no API and is not re-quoted here as confirmed fact — the
// PR content and the run's own could_not_run conclusion are what a reader can
// check, and that alone shows the collapse this word exists to fix.
// `out_of_scope` holds that fact apart from a genuine failure: it does not
// hold up the panel the way an unrun lens does. Whether an ALL-out-of-scope
// panel counts as approved or as its own separate non-green result is a
// policy decision, not a technical one, and it is isolated to one line in
// `aggregate` below — see the comment there.

export type Outcome = 'approved' | 'rejected' | 'could_not_run' | 'out_of_scope';

export interface Finding {
  readonly lens: string;
  readonly summary: string;
  readonly detail?: string;
}

export interface LensResult {
  readonly lens: string;
  readonly outcome: Outcome;
  readonly findings: readonly Finding[];
  /** Why this lens could not run, or why it found nothing in scope.
   * Meaningless on `approved` and `rejected`. */
  readonly reason?: string;
}

export interface Verdict {
  readonly outcome: Outcome;
  readonly results: readonly LensResult[];
  readonly findings: readonly Finding[];
  /** Lenses that were declared and did not return a review, with the reason. */
  readonly unran: readonly { readonly lens: string; readonly reason: string }[];
  /** Lenses that reviewed and found nothing within their declared scope, with
   * the reason — a completed judgement, not an incomplete one. Kept apart
   * from `unran`: membership here does not, by itself, hold up the panel's
   * outcome the way `unran` does. See `aggregate` for how it does affect the
   * outcome. */
  readonly outOfScope: readonly { readonly lens: string; readonly reason: string }[];
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
  const outOfScope: { lens: string; reason: string }[] = [];
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
    } else if (result.outcome === 'out_of_scope') {
      outOfScope.push({ lens, reason: result.reason ?? 'no reason given' });
    }
  }

  // could_not_run still outranks everything (S25, unchanged): any lens that
  // did not review at all holds up the whole panel, regardless of what
  // anything else says. A rejection outranks an approval, as before.
  const outcome: Outcome =
    unran.length > 0
      ? 'could_not_run'
      : ordered.some((result) => result.outcome === 'rejected')
        ? 'rejected'
        : // OPERATOR DECISION, ISOLATED TO THIS ONE LINE: when every declared
          // lens came back out_of_scope, the verdict reads as its own non-green
          // result rather than as an approval — a change nothing actually
          // evaluated should not read as one that passed. To make it read as
          // an approval instead, change the string literal on the line below
          // from 'out_of_scope' to 'approved'. Nothing else needs to move:
          // report.ts's exitCodeFor already treats anything other than
          // 'approved' as red, and its HEADING map already has an entry for
          // this outcome.
          outOfScope.length === declared.length
          ? 'out_of_scope'
          : 'approved';

  return { outcome, results: ordered, findings, unran, outOfScope };
}
