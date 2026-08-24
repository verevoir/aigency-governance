# oauth-missing-beta-header

## What this case is

The rarest kind of entry this corpus can hold: not a false positive correctly
rejected or accepted, but a **miss on a defect independently known to be
true** — a real, verified bug that one review pass caught and a later pass,
over provably unchanged code, did not mention at all.

`src/review/anthropic.ts`'s `headersFor` sends exactly one header for a
subscription-OAuth credential:

```
function headersFor(credential: Credential): Record<string, string> {
  return credential.source === 'api-key'
    ? { 'x-api-key': credential.value }
    : { authorization: `Bearer ${credential.value}` };
}
```

The file's own header comment claims full parity between the two credential
paths — "same request shape, same response envelope, same failure shapes" —
and that "nothing downstream of `headersFor` had to learn a second way to
fail." The original finding (reported below, not independently re-read from
raw check-run output in this pass — see Provenance) holds that this claim is
false for the one thing that actually differs: Anthropic's Messages API
requires an additional `anthropic-beta: oauth-2025-04-20`-shaped header to
accept an OAuth bearer token at all, and `headersFor` never sends one for
either credential.

**Ground truth: `defect`.** A `correctness`-shaped review pass (`s24a/lens-set`
review PR #5's head at commit `624ef6c09b201b98a4d963942726a2652cfb5ba3`,
check run `97084904599`, per `design/tuned-constants-and-eval-harness.md` in
`verevoir/aigency-rebuild`) raised this. A later pass over the same PR at
commit `87101960f98abf2ed29c946c20929f1ec964b56c` (check run `97590054942`)
did not raise it — over a file confirmed, directly, byte-for-byte identical
between the two heads. This is a recall failure with ground truth attached,
not an ordinary variance case: the input did not change, the finding did.

## Why this case exists

`design/tuned-constants-and-eval-harness.md` (`verevoir/aigency-rebuild`,
branch `meta/self-review-story`) named this as the single best-verified
ground-truth entry in its six-item candidate list, and the one candidate
absent from this corpus. It is added here on that basis, verified again
independently in this pass rather than carried over unchecked.

## Provenance

**`verdict: defect` — `provenance: verified-directly`, in the specific,
narrow sense below — split deliberately rather than flattened into one
label, because two different kinds of claim are bundled in this entry and
they were not established with the same confidence:**

1. **The code-level omission — verified directly, in this pass, against
   retrievable sources, not assumed from the design doc.**
   - Full shas resolved from the design doc's short prefixes (`624ef6c`,
     `8710196...`) against this repository's real commit history on
     `s26/subscription-oauth-locally`, read directly in this pass:
     `624ef6c09b201b98a4d963942726a2652cfb5ba3` ("local runs refuse rather
     than fall back to a paid credential") and
     `87101960f98abf2ed29c946c20929f1ec964b56c` ("Surface an OAuth attempt
     even when the API key chain is tried next...") — the second is an
     ancestor of, not identical to, the branch's current tip; two more
     commits (`c1573ce...`, `979bf81d...`) landed after it.
   - `src/review/anthropic.ts` read directly at both shas in this pass:
     byte-for-byte identical. `headersFor` is exactly the two-branch form
     quoted above at both points.
   - `src/review/anthropic.ts` read directly at the branch's current tip
     (`979bf81d841ee32ea50826a85b5aa8e8b33c98b4`) in this pass:
     `headersFor` is unchanged — the omission is present in the live code
     today, not only at the two historic shas.
   - `grep` for `anthropic-beta` run in this pass across the entire
     `s26/subscription-oauth-locally` branch and separately across `main`:
     zero matches in either. The header is never sent and never mentioned
     anywhere in this codebase.

2. **That Anthropic's Messages API actually requires this header for an
   OAuth bearer token to be accepted — `reported`, not independently
   verified in this pass.** This is an external fact about a third-party
   API, not something readable from this repository's own source. It is
   carried from the original `correctness`-lens finding as synthesised in
   `design/tuned-constants-and-eval-harness.md`; no tool available in this
   pass reaches Anthropic's own API documentation to check it directly. If
   this external claim were wrong, the code-level fact above (the header is
   never sent) would still stand, but the _defect_ label would not — this
   distinction is why the label is `verified-directly` for the omission and
   `reported` for why the omission matters. Recorded honestly rather than
   folded into one blanket `verified-directly`.

3. **That the finding was raised by pass 1 and absent from pass 3 —
   `reported`, not independently re-read.** No tool available in this pass
   retrieves a specific historic check run's content by id (`97084904599`,
   `97590054942`). This history is carried from
   `design/tuned-constants-and-eval-harness.md`'s own account, which states
   the same limitation about itself. It does not affect this entry's
   scoring value either way: what a configuration is tested against here is
   whether it catches the defect _now_, shown the diff below — not whether
   it reproduces the specific pass-1/pass-3 history.

4. **Lens attribution (`correctness`) is carried from the same source and
   under the same limitation as point 3 — reported, not re-derived.** It is
   recorded in `truth.json` as attribution only; `score.mjs`'s matcher does
   not condition on which lens raised a finding, so this does not affect
   scoring.

## `diff.txt`

Produced by `eval/corpus/make-diffs.mjs` from the real `refs.json` above —
not hand-reconstructed. Because `origin/<ref>` can only address a branch
tip, the diff is `main` vs `s26/subscription-oauth-locally`'s current tip,
scoped to `src/review/anthropic.ts`, rather than the exact
`624ef6c`/`8710196` snapshots. Given point 1 above (the file is unchanged
from `624ef6c` all the way to the current tip), this substitution does not
weaken what the diff demonstrates — the omission it shows is the same
omission at every one of those points — but it is named here rather than
left for a reader to assume the diff is pinned to the exact historic shas,
which it is not.

## A known scoring limitation this entry inherits, not introduced by it

`eval/README.md`'s 2026-08-20 measurement entry records that `eval/score.mjs`'s
default matcher (`mentionsTarget`) requires each truth entry's `target`
field, and that every existing corpus `truth.json` (as committed, at that
time) carries only `lens`, `summary`, `evidence`, `verdict`, `provenance` —
no `id`, no `target` — so `score()` throws on any non-empty findings array
against them. This entry's `truth.json` is built to match the same,
already-established shape of the other diff-bearing cases, per instruction,
and therefore inherits the same limitation: it is not scoreable by
`score()` as committed today, same as `dead-decorators`, `readme-drift` and
`truncation-mechanism-overclaim` already are not. Fixing that contract gap
is explicitly out of scope for this pass — `eval/README.md` names it as
owned by a sibling track — but a reader should not conclude this entry can
be run through the current sweep and produce a real number; today, none of
the diff-bearing cases can.
