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

Rules that decide whether your reply can be read at all:

- ${REJECTED_WORD} requires at least one finding. Write each as its own line
  beginning ${FINDING_MARKER}, stating what is wrong in one sentence. A
  rejection nobody can act on is not a rejection and will be discarded.
- ${APPROVED_WORD} requires no findings at all. If you have something to
  report, you are rejecting. Do not approve and then list concerns.
- ${CANNOT_RUN_WORD} is the honest answer when you could not do the review —
  the diff was truncated, the change is outside what you were asked to look
  at, or you have no basis for a judgement. Give the reason on a line
  beginning ${REASON_MARKER}. This is a legitimate answer and it is preferred
  over guessing.
- Two verdict lines means you said two things and neither will be used.`;
