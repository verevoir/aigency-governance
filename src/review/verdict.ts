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
// an ALL-out-of-scope panel is reported as its own outcome, and whether that
// outcome blocks a merge, are two SEPARATE questions — see the "FAIL NOISY,
// DO NOT BLOCK" comment in `aggregate` below for how this resolves both.

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
// A lens's own way of saying "I found nothing blocking here", written as a
// FINDING line whose severity tag is still [blocking] -- because that is
// the only shape the reply contract describes for a finding line at all --
// with the finding's own TEXT beginning with the word "none" instead of
// naming a concern. Real, live example: verevoir/aigency-runtime-v2#62's own
// review job. The correctness, honesty and verification lenses each wrote
// `VERDICT: approved`, and each also wrote a line such as
// "FINDING: [blocking] none — resolvePort correctly returns 8090 fallback
// and respects PORT when set, matching the diff's claim and comments; tests
// verify both branches." parseReply.ts's own derivation (see that file's
// header) then reads the [blocking] tag on that finding as real evidence
// and turns the lens's outcome to 'rejected' -- correctly, given only what
// parseReply can see, which is a marker and a severity tag, never finding
// TEXT. The old aggregate() then tallied all three as real blocking
// findings and rejected a change its own gates, and that same reviewing
// pass's own stated reasoning, had just called clean.
//
// Detected here, at the aggregation layer, on the TEXT the lens actually
// wrote -- the same "trust the evidence, not the label" principle already
// applied one line below to the outcome word, applied to a shape
// parseReply.ts cannot see and is not asked to: this changes no per-lens
// severity or finding logic, only which of the results that logic produced
// are treated as real evidence during combination. `\bnone\b`, not a bare
// substring match, so a finding that legitimately starts "nonetheless" or
// "nonexistent" is not caught by this.
const NONE_SENTINEL = /^none\b/i;

function isNoneSentinel(finding: Finding): boolean {
  return NONE_SENTINEL.test(finding.summary.trim());
}

/**
 * Whether a 'rejected' lens result has no real evidence behind it -- every
 * finding it carries (and it carries at least one; see below) is a
 * none-sentinel. Kept apart, deliberately, from a 'rejected' result with NO
 * findings at all: that shape stays trusted exactly as before -- see the
 * OR'd check this feeds, and the "carries no blocking finding at all"
 * fixture in verdict.test.ts, which pins the bypass-defense reason that
 * check exists for and which none-sentinel handling must not weaken.
 */
function isRejectionEvidenceless(result: LensResult): boolean {
  return result.findings.length > 0 && result.findings.every(isNoneSentinel);
}

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
    // None-sentinel findings are dropped from the combined list here, once,
    // so every downstream consumer -- the blocking tally below, and
    // report.ts's rendering, which groups strictly from `verdict.findings`
    // -- sees the same, already-filtered set. Nothing else about a result is
    // touched: a lens's own outcome word and its full, unfiltered
    // `result.findings` are still exactly what parseReply produced.
    findings.push(...result.findings.filter((finding) => !isNoneSentinel(finding)));
    if (result.outcome === 'could_not_run') {
      unran.push({ lens, reason: result.reason ?? 'no reason given' });
    } else if (result.outcome === 'out_of_scope') {
      outOfScope.push({ lens, reason: result.reason ?? 'no reason given' });
    }
  }

  // Every declared lens landed on out_of_scope: nothing in the change was
  // within anything's declared dimension.
  const allOutOfScope = outOfScope.length > 0 && outOfScope.length === ordered.length;

  // could_not_run still outranks everything (S25, unchanged): any lens that
  // did not review at all holds up the whole panel, regardless of what
  // anything else says.
  //
  // FAIL NOISY, DO NOT BLOCK — the operator's resolution of a disagreement
  // this PR's own self-review had with itself. Round 1 folded an
  // all-out_of_scope panel into 'approved' outright (verevoir/aigency-harness#8:
  // nothing in scope must not stop a merge). The failure-modes lens then
  // correctly objected that doing so erased a real distinction — "no lens
  // found anything to review" is not the same statement as "reviewed and
  // found nothing wrong" — at exactly the two places a machine consumer
  // looks: `verdict.outcome` and report.ts's `exitCodeFor`. Both were right,
  // and the fix is not to pick a side: an all-out_of_scope panel keeps its
  // OWN outcome word, 'out_of_scope', below, distinct from 'approved' —
  // while report.ts's `exitCodeFor` maps THAT outcome to the same
  // non-blocking exit code as 'approved'. The gate never blocks on it; the
  // outcome and the rendered report never claim it is the same thing as a
  // real review that found nothing wrong.
  //
  // A second, separate limitation surfaced alongside this one, named here
  // rather than acted on: an all-out_of_scope result on a change like a
  // design document is often really "the lens set has nothing built to
  // judge prose", not "there was nothing worth judging". Fixing that would
  // mean a lens that can review an argument rather than a diff, which is a
  // real, separate piece of work — out of scope for this change, which is
  // about aggregation policy, not sensor coverage.
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
          ordered.some(
            (result) => result.outcome === 'rejected' && !isRejectionEvidenceless(result),
          )
        ? 'rejected'
        : allOutOfScope
          ? 'out_of_scope'
          : 'approved';

  return { outcome, results: ordered, findings, unran, outOfScope };
}
