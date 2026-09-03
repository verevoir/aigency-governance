// Aggregating what the panel said into one answer.
//
// Fails closed, and the definition of "closed" is stricter than it looks: the
// aggregate is computed against the lenses the definition DECLARED, not
// against the results that happened to arrive. A lens that produced nothing —
// crashed, timed out, was never dispatched — is a lens that did not review,
// and a panel missing a member has not approved anything.
//
// A lens that reviewed and found nothing in its scope is not the same fact
// as a lens that did not review, and collapsing them is the defect this word
// exists to fix. verevoir/aigency-runtime-v2#38
// (https://github.com/verevoir/aigency-runtime-v2/pull/38) changed only
// GitHub Actions workflow YAML — no test-covered code at all — and its own
// `review / review` check run (id 97088772135) concluded could_not_run,
// annotated "nothing was reviewed". The run and its annotation are
// retrievable and checkable by anyone who reads the check run; what
// happened lens by lens on that run is not claimed here — it lives only in
// that run's job summary, which has no API.
// `out_of_scope` holds the completed-but-empty case apart from a genuine
// failure: it does not hold up the panel the way an unrun lens does. Whether
// an ALL-out-of-scope panel counts as approved or as its own separate
// non-green result is a policy decision, not a technical one, and it is
// isolated to one line in `aggregate` below — see the comment there.

export type Outcome = 'approved' | 'rejected' | 'could_not_run' | 'out_of_scope';

export interface Finding {
  readonly lens: string;
  readonly summary: string;
  readonly detail?: string;
  /**
   * Whether this finding, on its own, must sink the verdict. A rejection
   * requires at least one; an approval may carry any number so long as none
   * of them are. Set exactly once, by the reviewing lens, when its reply is
   * parsed — see parseReply.ts and replyContract.ts's severity tags. Never
   * inferred from the diff, never defaulted to false, and never settable by
   * whoever authored the change under review: severity is the reviewer's
   * call or it means nothing at all.
   */
  readonly blocking: boolean;
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
  // anything else says.
  //
  // OPERATOR DECISION, MADE (was isolated to one line here and pending — see
  // verevoir/aigency-harness#8): an all-out_of_scope panel now reads as
  // approved. A change nothing had anything to evaluate is a completed
  // judgement, not a failure, and must not be reported the same colour as a
  // review that did not happen. Per-lens out_of_scope results are still
  // tracked in `outOfScope` above and reported in full by report.ts; this
  // only decided what the PANEL's own outcome read as when every declared
  // lens landed there, and it now falls out of the same rule as any other
  // clean panel below rather than needing a branch of its own.
  //
  // MACHINE DISTINGUISHABILITY (raised by this PR's own self-review,
  // failure-modes lens): a consumer reading only `verdict.outcome` (or
  // report.ts's `exitCodeFor`) can no longer tell "reviewed and clean" apart
  // from "nothing to review at all" — both are now `'approved'`, exit code
  // 0. Not lost, only moved: `verdict.outOfScope` still names every lens
  // that landed there, so a consumer wanting the distinction can check
  // `verdict.outOfScope.length === verdict.results.length` (all of them, the
  // case this decision affects) versus `0` (none). A dedicated `Outcome`
  // value for this case would be a real, separate change and is left as a
  // follow-up rather than done here.
  //
  // SEVERITY-WEIGHTED: the panel is rejected when a BLOCKING finding exists
  // among what was actually collected, checked directly rather than trusted
  // solely from a lens's own verdict word — so a Reviewer implementation
  // that bypasses parseReply's contract cannot smuggle a blocking finding
  // through under a lens that claims 'approved'. `result.outcome ===
  // 'rejected'` is kept as a second, OR'd condition rather than dropped:
  // parseReply guarantees a rejection always carries a blocking finding, so
  // the two agree on every reply that came through the real contract, and
  // this is an independent check on the same fact, not a redundant one. A
  // non-blocking (smell) finding trips neither condition — it does not set a
  // lens's outcome to 'rejected' (parseReply.ts) and it is not blocking — so
  // it is collected into `findings` above and reported, and never sinks this.
  const outcome: Outcome =
    unran.length > 0
      ? 'could_not_run'
      : findings.some((finding) => finding.blocking) ||
          ordered.some((result) => result.outcome === 'rejected')
        ? 'rejected'
        : 'approved';

  return { outcome, results: ordered, findings, unran, outOfScope };
}
