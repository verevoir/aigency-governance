// The contract between the prompt and the parser.
//
// These two are the classic drift pair: the prompt tells a reviewer how to
// answer, the parser decides what an answer means, and nothing connects them
// except a person remembering. When they drift the failure is silent and
// expensive — every reply parses as unreadable, every lens reports
// could_not_run, and the panel is red for a reason that has nothing to do
// with the code under review.
//
// So the markers live here, once, and both sides import them. The instruction
// text is BUILT from the same constants the parser matches on, which is why
// it is a template rather than prose with the words typed in again.

export const VERDICT_MARKER = 'VERDICT:';
export const FINDING_MARKER = 'FINDING:';
export const REASON_MARKER = 'REASON:';

export const APPROVED_WORD = 'approved';
export const REJECTED_WORD = 'rejected';
export const CANNOT_RUN_WORD = 'could_not_run';
// A peer of the three above, not a softer spelling of CANNOT_RUN_WORD. The
// distinction this word exists to make: could_not_run is a review that was
// OWED and did not happen — a genuine failure, and it holds up the whole
// panel's verdict (see verdict.ts's S25 ordering, unchanged by this word).
// out_of_scope is a review that DID happen and concluded, correctly, that
// this lens's dimension has no material in this change — a diff that touches
// no test, read by a lens whose entire mandate is judging tests, say. One is
// an incomplete panel; the other is a complete panel where a member had
// nothing to add. Conflating them was a real defect, not a hypothetical one:
// verevoir/aigency-runtime-v2#38
// (https://github.com/verevoir/aigency-runtime-v2/pull/38) changed only
// GitHub Actions workflow YAML -- no test-covered code at all -- and its own
// `review / review` check run (id 97088772135) concluded could_not_run,
// annotated "nothing was reviewed". That is the whole-panel failure this
// word exists to separate from a lens that reviewed and correctly found
// nothing in its scope: the `verification` lens's declared mandate
// (review/lenses.json) is judging changed tests, the natural lens to have
// hit this. The per-lens breakdown itself lives only in that run's job
// summary, which has no API and is not re-quoted here as a confirmed fact --
// the PR content and the run's own could_not_run conclusion are what a
// reader can check.
export const OUT_OF_SCOPE_WORD = 'out_of_scope';

/**
 * The output instructions given to every reviewer, identical for every lens.
 *
 * Note what it does NOT say: it never asks for a summary, a rating or a
 * narrative. A reviewer that writes prose above these lines is fine — the
 * parser reads markers, not the whole reply — but anything the parser cannot
 * find is not a verdict, and the instructions say so plainly rather than
 * hoping.
 */
export const REPLY_CONTRACT = `End your reply with these lines, exactly as described.

One verdict line, and only one:

  ${VERDICT_MARKER} ${APPROVED_WORD}
  ${VERDICT_MARKER} ${REJECTED_WORD}
  ${VERDICT_MARKER} ${CANNOT_RUN_WORD}
  ${VERDICT_MARKER} ${OUT_OF_SCOPE_WORD}

Rules that decide whether your reply can be read at all:

- ${REJECTED_WORD} requires at least one finding. Write each as its own line
  beginning ${FINDING_MARKER}, stating what is wrong in one sentence. A
  rejection nobody can act on is not a rejection and will be discarded.
- ${APPROVED_WORD} requires no findings at all. If you have something to
  report, you are rejecting. Do not approve and then list concerns.
- ${CANNOT_RUN_WORD} is the honest answer when you TRIED to review and could
  not — the diff was truncated, something you needed in order to judge it was
  missing or corrupted, or you otherwise have no basis for a judgement at
  all. Give the reason on a line beginning ${REASON_MARKER}. This means a
  review that was owed did not happen, and it holds up the whole panel's
  verdict — prefer it over guessing, but do not reach for it merely because
  your dimension has nothing to say about this change; that is
  ${OUT_OF_SCOPE_WORD}, below.
- ${OUT_OF_SCOPE_WORD} is the honest answer when you DID review — you read
  the whole change — and your own dimension genuinely has no material in it
  at all. Give the reason on a line beginning ${REASON_MARKER}. This is a
  completed judgement, not a failure, and it does not hold up the panel the
  way ${CANNOT_RUN_WORD} does. Reach for this ONLY when your stated focus has
  nothing to attach to here — never because a change is small, boring, or not
  to your taste. If your dimension DOES apply and the change falls short of
  it — a changed behaviour with no changed test, reviewed by the lens whose
  focus is exactly that — that is a finding for ${REJECTED_WORD}, not an
  absence of scope.
- Two verdict lines means you said two things and neither will be used.`;
