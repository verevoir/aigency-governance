# dead-decorators

## What this case is

The `blast-radius` lens, reviewing `s24a/lens-set` against `main`
(`verevoir/aigency-governance` PR #1), found `src/decorate/retrying.ts` and
`src/decorate/observing.ts` — two generic async-operation decorators — added and
re-exported through the package's public barrel, with no caller anywhere in the
diff's actual review pipeline; the only callers anywhere in the change were their
own dedicated test file.

**Ground truth: `defect`.** Unlike `practices-not-dead-code`, this one really was
dead everywhere, not just in the diff shown: PR #1's own body states the finding
recurred "across three separate findings across three runs, same modules" before
the modules were removed entirely. This is the corpus's deliberate contrast case
— the same lens, on the same shape of claim ("this is unwired"), reaching the
right verdict this time. A configuration should catch this one, not just
correctly reject `practices-not-dead-code`.

## Provenance

**`verdict: defect` — `provenance: verified-directly`.**

- The finding text is copied verbatim from
  `.review-report/branch__main__s24a-lens-set.json`, read directly in this pass.
- PR #1's own body (`verevoir/aigency-governance#1`, read via `read_pull_request`
  in this pass) confirms the fix: "the dead `src/decorate/retrying.ts`/`observing.ts`
  modules plus their test file, removed entirely per the review's own repeated
  recommendation (three separate findings across three runs, same modules)," fixed
  at commit `7b9e3e4609e80bb595c7be6f337f9422de846620`.
- Independently re-confirmed in this pass: both files are present, complete, and
  unmodified at `7b9e3e4609e80bb595c7be6f337f9422de846620~1` (the immediate parent
  of the fix commit), and `src/decorate/` no longer exists anywhere on `main` or on
  `s24a/lens-set`'s head as of `7b9e3e4609e80bb595c7be6f337f9422de846620` itself —
  both checked directly via the remote repository in this pass.
- Not independently re-verified in this pass: that these modules had _zero_
  callers on _every_ branch, at every point across all three flagged review runs
  (as opposed to just the one commit pair checked here). PR #1's claim of "three
  separate findings across three runs" is taken as reported, not re-derived —
  only one of those three runs' report files (`branch__main__s24a-lens-set.json`)
  was actually read in this pass.

## `diff.txt`

Present, and narrower than the original diff for the same reason as
`practices-not-dead-code`: the full `main`-vs-`s24a/lens-set` diff was hundreds of
KB and no tool here extracts an arbitrary slice of a historical diff mechanically.

What's included: a hand-built "new file" diff for `src/decorate/retrying.ts` and
`src/decorate/observing.ts`, using their complete, verified content fetched at
`7b9e3e4609e80bb595c7be6f337f9422de846620~1` — the last commit before they were
deleted, confirmed identical to their addition (nothing in the retrievable history
suggests either file's body was ever modified, only the barrel's export of them and
then their existence). As with the other case, the `index` blob hash is a
disclosed placeholder, and `@@` hunk line counts are hand-counted, not
machine-verified.

**Deliberately not included**: the `src/index.ts` barrel hunk. Checking history at
`7b9e3e4609e80bb595c7be6f337f9422de846620~1`, the barrel had _already_ stopped
re-exporting these two decorators by that point (an intermediate fix — the file
carries a comment there explaining the un-export) — but the finding's own
`evidence` quote (`export { retrying, RetryPolicyError, type RetryPolicy, type
Sleep } from './decorate/retrying.js';`) shows the barrel _did_ export them at the
time this specific finding was raised, which must therefore be an earlier commit
than `~1` that this pass has no sha for. Rather than guess at that earlier
`index.ts`'s exact content, the barrel hunk is left out of `diff.txt` entirely; the
two decorator files' own content is unaffected by which commit is used, since
their bodies never changed.
