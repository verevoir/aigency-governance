# practices-not-dead-code

## What this case is

The `blast-radius` lens, reviewing `s24a/lens-set` against `main`
(`verevoir/aigency-governance` PR #1), recommended — across multiple runs — that
`src/practices/enact.ts` and `src/practices/provision.ts` be removed as unwired
dead code: nothing added in that diff's own review-pipeline code (`src/cli/run.ts`,
`src/cli/review.ts`, `src/review/*`) imports either module, and neither is
exported from the public barrel (`src/index.ts`).

**Ground truth: `not-a-defect`.** True of the diff in isolation against `main`,
false of the stack: `s23/api-and-bar` (PR #4), three branches up from PR #1, imports
`PracticeGate`, `Judge`, `EnactOutcome` from `practices/enact.js` and
`ProvisionResult` from `practices/provision.js` directly into `src/api/handler.ts`
— real production code, not a test file, and the literal subject of that PR ("S23:
provision and enact behind a wire, not an import"). S23 is the story that was
always going to consume S15 (these two modules); the finding is a correct
description of this diff shown alone and a wrong conclusion about the change as a
whole.

This is the corpus's sharpest entry: a configuration must be scored on
_rejecting_ this finding, not on repeating it.

## Provenance

**`verdict: not-a-defect` — `provenance: verified-directly`.**

- The finding's own text, `evidence` quote, and `detail` field (confirming the
  citation was mechanically re-verified against the diff, not invented) are copied
  verbatim from `.review-report/branch__main__s24a-lens-set.json`, read directly in
  this pass.
- The rebuttal is copied from PR #1's own body (`verevoir/aigency-governance#1`,
  "Status as of 2026-08-19" section), read directly via `read_pull_request` in this
  pass: "Checked directly, across every branch built on top of this one:
  `s23/api-and-bar` (PR #4, three branches up) imports `PracticeGate`, `Judge`,
  `EnactOutcome` from `practices/enact.js` and `ProvisionResult` from
  `practices/provision.js` directly into `src/api/handler.ts`."
- Re-confirmed independently in this pass: `src/practices/enact.ts` and
  `src/practices/provision.ts` are present, unmodified, at commit
  `7b9e3e4609e80bb595c7be6f337f9422de846620` (PR #1's head, merged into `main`) —
  fetched and read in full from `https://github.com/verevoir/aigency-governance` at
  that ref. PR #1's own body states these modules were never touched after their
  first addition ("the `practices/*` modules remain, and they were never the
  source of the decorator-sized reduction to begin with"), so this content is the
  same content the original flagged diff added.

## `diff.txt`

Present, but **narrower than the diff the lens actually saw**. The original diff
(`main` vs `s24a/lens-set`) was reported by PR #1's own body as 315,702–333,093
characters across 42 files — far too large to reproduce here, and no tool in this
pass generates an arbitrary historical `git diff` to extract only the relevant
slice mechanically.

What's included instead: a hand-built "new file" diff for exactly the two files
the finding is about, using their complete, verified content fetched at
`7b9e3e4609e80bb595c7be6f337f9422de846620` (confirmed unmodified since first
added, per PR #1's own body). This is legitimate, not fabricated — every `+` line
is a byte-exact copy of a real committed file, and a new-file diff is mechanical
(one hunk, the whole file, no algorithmic guessing about what changed). Two things
are honestly synthetic and disclosed as such: the `index` line's blob hash (a
placeholder — no git tooling was available in this pass to compute the real SHA-1),
and the `@@` hunk line counts, which are hand-counted from the fetched text rather
than machine-verified (accurate to within a line or two, not guaranteed exact).

Not included: the surrounding pipeline files (`src/cli/run.ts`, `src/cli/review.ts`,
`src/review/*`) and `src/index.ts`'s barrel, which the finding's summary also
references as evidence of "no consumer" — omitted because reproducing them
faithfully at the exact reviewed commit was not attempted in this pass, not because
they're unimportant to the finding.
