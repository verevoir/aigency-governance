# readme-drift

## What this case is

`aigency-governance`'s own README carries an HTML comment, left in place
deliberately as a marker (read directly in this pass, at commit
`7b9e3e4609e80bb595c7be6f337f9422de846620` and on current `main`):

> A recurring shape, worth being able to find again: prose in this repository
> asserting something the code does not do, or no longer does, once the code it
> described has moved on. Two instances lived in this very file until this commit
> — the fork-PR failure sequence above, and this readers-coverage claim. Two more
> lived elsewhere: a truncation-classification message that named one specific
> cause for three different code paths, and this project's own CLI gate once
> asserting a shebang check it never performed. All four were fixed the same way
> — not by finding new logic, but by making an existing sentence true, either by
> narrowing the claim or by making the code do what the claim already said.

That names four instances. This case carries all four as separate `truth.json`
entries, **all `verdict: defect`**, at two different provenance strengths — two
are backed by a real, hand-verified diff in this pass; two are backed only by the
marker's own claim plus (for one of them) a real evidence quote from an actual
review report, with no diff obtained.

1. **fork-PR failure sequence** (README, "On a fork's pull request") — the
   README described a specific failure order (governance-token secret missing →
   checkout of the private governance repo fails with `Repository not found`)
   that the code no longer produces, superseded by a fail-fast key check added
   since (the workflow now checks the key first, unconditionally, before either
   checkout runs, and reports `ANTHROPIC_API_KEY is not available to this
workflow.` instead).
2. **readers-coverage overstatement** (README, "Running it locally") — claimed
   the `cli` gate leaves the whole `readers` module invisible; narrowed to what
   is and isn't actually covered (the gate's second scenario does exercise
   `keyFileReader()` through `review.ts`'s real wiring).
3. **truncation-classification message** — named in the marker only; not
   independently located or diffed in this pass.
4. **CLI-gate shebang claim** — `scripts/check-cli.mjs`'s header once asserted
   the gate proved "the shebang survived emit," without the code ever reading
   the shebang back to check it; fixed by adding the exact-comparison read this
   entry's own evidence quote shows was missing.

## Provenance

**Instances 1 and 2 — `provenance: verified-directly`.** Both are backed by a
real diff in `diff.txt` (see below): full README.md content fetched at
`7b9e3e4609e80bb595c7be6f337f9422de846620~1` (before) and
`7b9e3e4609e80bb595c7be6f337f9422de846620` (after), read directly in this pass,
compared by hand. PR #1's own body (`verevoir/aigency-governance#1`, read via
`read_pull_request` in this pass) independently names both as fixed at that same
commit.

**Instance 3 (truncation-classification message) — `provenance:
reported-not-rechecked`.** Only the marker's own naming of it was read in this
pass. No prior commit, report, or diff pinning the specific broken sentence was
located — grepping the retrievable `.review-report/*` files in this repository
did not surface it, and the marker gives no file or commit to check against. This
is the entry the design record itself would call out for not overclaiming: real
enough to include (the marker is a real, committed artifact, not invented here),
not strong enough to certify beyond that.

**Instance 4 (CLI-gate shebang claim) — `provenance: verified-directly`, but
without a diff.** The finding text and its `evidence` quote are copied verbatim
from `.review-report/branch__main__s24a-lens-set.json`, read directly in this
pass — real output from a real review run, not the marker's paraphrase. The fix
is independently confirmed: `scripts/check-cli.mjs`'s current header (read
directly on current `main` in this pass) says "A review found this claimed more
than it checked: the shebang line was never read, only asserted about in prose,"
and the code now reads `BIN`'s first line and compares it exactly against
`EXPECTED_SHEBANG`. What's **not** obtained: the diff itself. Checking
`scripts/check-cli.mjs` at `7b9e3e4609e80bb595c7be6f337f9422de846620~1` and `~3`
in this pass found the fix _already present_ at both — meaning this particular
defect was introduced and fixed earlier in `s24a/lens-set`'s own 33-commit
history, at a commit this pass has no sha for. Rather than guess at one, no diff
is included for this instance.

## `diff.txt`

Covers **instances 1 and 2 only** — a hand-built, two-hunk unified diff of
`README.md` between `7b9e3e4609e80bb595c7be6f337f9422de846620~1` (before) and
`7b9e3e4609e80bb595c7be6f337f9422de846620` (after), both fetched and read in full
in this pass. Every `+`/`-`/context line is byte-exact from those two real
fetches. The `@@` hunk line numbers are hand-counted from the fetched text, not
machine-diffed — accurate to within a line or two, not guaranteed exact; the
`index` blob-hash line is a disclosed placeholder for the same reason as the
other two cases in this corpus.

Instances 3 and 4 have no corresponding hunks in `diff.txt`, for the reasons
given above — their entries in `truth.json` stand without a diff, per this
corpus's own rule of recording the case and the reason rather than dropping it or
inventing one.
