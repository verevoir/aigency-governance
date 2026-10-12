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

/**
 * One model call's token usage, following the OTel GenAI semantic
 * conventions (`gen_ai.usage.input_tokens` / `output_tokens`, plus the two
 * cache figures when the transport reports them). A field a transport did
 * not report is OMITTED, never defaulted to zero -- "we do not know" and
 * "zero of this kind" are different facts, and only the transport that made
 * the call can tell them apart.
 */
export interface GenAiUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadInputTokens?: number;
  readonly cacheCreationInputTokens?: number;
}

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
  /** This call's token usage, when the reviewer reported one. Absent for
   * a lens that did not run, and may be absent even for one that did, if
   * its transport never reported a figure -- never synthesized. */
  readonly usage?: GenAiUsage;
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
// are treated as real evidence during combination.
//
// TIGHT ON PURPOSE, after two real findings of its own, from two rounds of
// review on this very fix.
//
// Round 1 (PR #23, honesty + failure-modes lenses): an earlier version of
// this pattern was /^none\b/i -- word-bounded, but still matching ANY
// finding text that merely STARTS with the word "none", including ordinary
// prose. A genuine blocking finding phrased as "None of the retry paths
// have a ceiling" would have been silently stripped from both the tally and
// the rendered report by that pattern -- folding a real, unaddressed
// rejection into a silent approval if it happened to be a lens's only
// finding. Fixed by requiring the word to be followed by nothing (the bare
// sentinel) or by a dash separator and the reason, never by further words.
//
// Round 2 (PR #23, correctness lens): that fix kept the /i flag, so it
// remained CASE-insensitive -- a genuine finding phrased "None — the retry
// loop has no ceiling" (capital N, dash) still matched, and would still
// have been silently stripped. The observed real sentinel
// (aigency-runtime-v2#62's own report text -- "none — resolvePort
// correctly returns..."; "none - both tests exercise...") is lowercase in
// every instance, and nothing in replyContract.ts's REPLY_CONTRACT
// instructs a lens to write this sentinel at all -- it is emergent
// behaviour a lens falls into when it has nothing to report, not a
// documented shape with a defined casing. There is no basis for reading
// any casing other than the one actually observed as the deliberate
// "nothing here" signal. So the /i flag is gone: only an EXACT-CASE "none"
// is read as the sentinel now. "None", "NONE", or any other casing is real
// prose, kept, counted, and rendered like any other finding -- the same
// treatment "None of the retry paths have a ceiling" already gets, now
// extended to "None — the retry loop has no ceiling" too.
//
// So this matches only the one concrete shape the observed sentinel
// actually takes, exactly as observed: the bare word "none", lowercase,
// with nothing else, or "none", lowercase, immediately followed by a dash
// separator and the reason -- "none — resolvePort correctly returns the
// 8090 fallback..." (an em dash) and "none - both tests exercise
// resolvePort directly..." (a hyphen) are both real examples from that
// same report, so both dash characters are recognised. Anything that
// differs from this -- a capital letter, or ordinary words with no
// separator -- matches nothing here and is kept, counted, and rendered
// exactly like any other blocking finding.
const NONE_SENTINEL = /^none(?:\s*$|\s*[-—]\s)/;

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
    // report.ts's rendering, which groups strictly from the `verdict`'s
    // `findings` -- sees the same, already-filtered set. Nothing else about
    // a result is touched: a lens's own outcome word and its full,
    // unfiltered `result`'s `findings` are still exactly what parseReply
    // produced.
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

/**
 * Sum token usage across every lens result, field by field. A field absent
 * from every result stays absent in the total too -- "no lens reported this"
 * is not the same fact as "the total is zero", and only distinguishing them
 * lets a reader tell a transport that never wired usage apart from one that
 * genuinely spent nothing of that kind. Returns `undefined` when nothing
 * anywhere reported any figure at all, so a caller can omit the whole
 * section rather than print an all-absent total.
 */
export function sumUsage(results: readonly LensResult[]): GenAiUsage | undefined {
  const fields = [
    'inputTokens',
    'outputTokens',
    'cacheReadInputTokens',
    'cacheCreationInputTokens',
  ] as const;
  const total: Record<string, number> = {};
  for (const field of fields) {
    let sum: number | undefined;
    for (const result of results) {
      const value = result.usage?.[field];
      if (value !== undefined) {
        sum = (sum ?? 0) + value;
      }
    }
    if (sum !== undefined) {
      total[field] = sum;
    }
  }
  return Object.keys(total).length > 0 ? (total as GenAiUsage) : undefined;
}
