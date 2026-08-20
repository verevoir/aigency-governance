# verification-wiring-gap

## What this case is

`.review-report/head.json` — a real review run against this repository's own
`HEAD` commit at the time — has the `verification` lens rejecting on exactly
one finding: `lensFetchHeaders(url, access.lensToken)` is the security-critical
call site (it decides which host gets the bearer token), but every test in
`tests/readers.test.ts` at that point exercised `lensFetchHeaders` only as a
pure function in isolation — none of them proved the real call site actually
wires the real `url` and `access.lensToken` into it, so a regression at the
call site itself (passing `access.lensSource` where `url` was meant, or
swapping the two arguments) would pass every existing test.

**Ground truth: `defect`, real at the time and since fixed.** Confirmed
directly against current `main` in this pass: `src/review/readers.ts` now
has a dedicated `lensReaderFor(access, rawFetch)` (line 175) whose own doc
comment names this exact finding — "it passed the right values in the right
order: `access.lensSource` where..." — and `tests/readers.test.ts` has a
`describe('lensReaderFor', ...)` block (from line 333) whose own leading
comment says "Driving `lensReaderFor` end to end, through a fake ... site
got it right," with `lensSource: source, lensToken: TOKEN` supplied together
and the result checked. `src/cli/review.ts` (line 43) wires
`read: lensReaderFor(settings, fetch)` — the composed function, not the bare
`lensFetchHeaders` — into the real reader. The gap the finding named is
closed by exactly the kind of end-to-end test it asked for.

## Provenance

**`verdict: defect` — `provenance: verified-directly`**, on both halves:

- The finding's own text is copied verbatim from `.review-report/head.json`,
  read directly in this pass — real output from a real review run, not
  reconstructed.
- The fix is independently confirmed against current `main` in this pass, by
  reading `src/review/readers.ts` (the `lensReaderFor` function and its doc
  comment) and `tests/readers.test.ts` (the `lensReaderFor` describe block),
  and by grepping `src/cli/review.ts` to confirm the composed function, not
  the bare one, is what is actually wired into `runReview`.

Not established in this pass: the exact commit `head.json` was reviewing, or
when the `lensReaderFor` fix landed relative to it — no tool available in
this pass maps a `.review-report/head.json` file back to the git sha it was
generated against, and the working tree here is checked out to whatever is
currently on disk, not to that historical HEAD.

## `diff.txt`

**Still absent, and a real attempt was made and failed.** `scripts/review-head.mjs`
reviews a single commit (`git show HEAD`), so what's needed is one specific
sha, not a branch pair — unlike `truncation-mechanism-overclaim`, no report
filename or `.md` header names a ref here to work from. A later pass
confirmed the fix (`lensReaderFor`) is real, on `main`, but did not locate
the pre-fix commit: no tool available in this pass lists git log or walks
commit history, so a sha this specific could not be found without either
guessing or spending many rounds bisecting branch tips by hand. `refs.json`
is intentionally not written for this case rather than guessed at.

**Absent for the original reason too:** The finding is about a call site that, at the time of the
flagged run, lived directly in `review.ts`/`readers.ts` with only unit
coverage of the bare function; the fix restructured it into a new named
function (`lensReaderFor`) rather than adding a test to the same shape of
code, which means there is no single small "before" diff to reconstruct by
hand the way `practices-not-dead-code` and `dead-decorators` could — the
before-state's exact commit is not identified in this pass, and no tool here
computes a diff against an unidentified historical ref. Kept as a case
without a diff rather than dropped, and without a fabricated one.
