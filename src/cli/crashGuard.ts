// The decision a crash handler at review.ts's process boundary makes — kept
// separate from `process.on`, `process.stdout.write` and `process.exit`
// themselves, so it can be tested with fakes. Nothing here touches a global.
// See review.ts's own header for why nothing that decides belongs only
// inside a `process.on` callback.

export interface CrashOutcome {
  /**
   * Always appended to stdout — the same stream `review.yml` tees into
   * `review.md` and folds into the persisted artefact's `reportMarkdown`
   * field — and never a replacement for anything written before it.
   */
  readonly text: string;
  /**
   * Present only when `main()` had not yet settled when this crash arrived:
   * nothing else has reported a result, so this crash IS the result, and the
   * process must exit non-zero because nothing else will.
   *
   * Absent once `main()` has already settled: a verdict already stands,
   * correctly, and is unrelated to this crash by definition — `main()`'s own
   * promise chain never saw it (see review.ts's header comment on why this
   * exists at all). The caller must leave `process.exitCode` exactly as
   * `main()` already left it.
   */
  readonly exitCode?: number;
}

/**
 * What review.ts's `uncaughtException`/`unhandledRejection` handlers should
 * do, given whether `main()` has already settled.
 *
 * Before settling: reported exactly as the existing "could not run" boundary
 * failure, and the caller exits 1. Unchanged from before this file existed.
 *
 * After settling, three outcomes were possible and two are wrong:
 *
 *   - Overwriting the verdict already reported — today's bug, before this
 *     guard existed: a genuine approval, reported and exited on correctly by
 *     `main()`, read as a crash because these handlers stayed live for the
 *     whole process and fired on anything, at any time.
 *   - Ignoring the crash entirely — loses the fact that something failed,
 *     the same defect facing the other way: a reader would have no way to
 *     know a late, unrelated failure happened at all.
 *
 * What is done instead: the fact is recorded, appended after the verdict
 * already written, without touching the exit code. A reader of the job's
 * step summary, or of the persisted artefact's `reportMarkdown` field —
 * both fed by the exact same stdout stream this appends to — sees it in the
 * place they were already going to look, clearly marked as unrelated to the
 * verdict above it rather than folded into the same heading.
 */
export function crashOutcome(cause: unknown, mainAlreadySettled: boolean): CrashOutcome {
  if (!mainAlreadySettled) {
    return { text: `${boundaryFailureReport(cause)}\n`, exitCode: 1 };
  }
  const message = cause instanceof Error ? cause.message : String(cause);
  return {
    text:
      '\n---\n\n' +
      "**Note:** an unrelated failure occurred after this review's verdict " +
      `above was already final and did not change it: ${message}\n`,
  };
}

/**
 * The one report review.ts ever writes for a failure it did not itself
 * decide — as opposed to `runReview`'s own reports, which are a verdict
 * about the change. Shared by every place that can reach it (a crash before
 * `main()` has settled, via `crashOutcome` above, and a rejection of
 * `main()` itself, handled directly in review.ts) so the wording cannot
 * drift into two different descriptions of the same kind of failure.
 */
export function boundaryFailureReport(cause: unknown): string {
  return [
    '## Review: Could not run',
    '',
    `Unexpected failure at the process boundary: ${
      cause instanceof Error ? cause.message : String(cause)
    }`,
    '',
    'This is a defect in the runner, not a verdict about the change.',
  ].join('\n');
}
