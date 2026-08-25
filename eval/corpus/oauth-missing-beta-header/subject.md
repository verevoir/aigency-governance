# oauth-missing-beta-header

## What this case is

The rarest kind of entry this corpus can hold: not a false positive correctly
rejected or accepted, but a **miss on a defect independently known to be
true** -- a real, verified bug that one review pass caught and a later pass,
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
paths -- "same request shape, same response envelope, same failure shapes" --
and that "nothing downstream of `headersFor` had to learn a second way to
fail." The original finding (reported below, not independently re-read from
raw check-run output in this pass -- see Provenance) holds that this claim is
false for the one thing that actually differs: Anthropic's Messages API
requires an additional `anthropic-beta: oauth-2025-04-20`-shaped header to
accept an OAuth bearer token at all, and `headersFor` never sends one for
either credential.

**Ground truth: `defect`.** A `correctness`-shaped review pass (`s24a/lens-set`
review PR #5's head at commit `624ef6c09b201b98a4d963942726a2652cfb5ba3`,
check run `97084904599`, per `design/tuned-constants-and-eval-harness.md` in
`verevoir/aigency-rebuild`) raised this. A later pass over the same PR at
commit `87101960f98abf2ed29c946c20929f1ec964b56c` (check run `97590054942`)
did not raise it -- over a file confirmed, directly, byte-for-byte identical
between the two heads. This is a recall failure with ground truth attached,
not an ordinary variance case: the input did not change, the finding did.

## Why this case exists

`design/tuned-constants-and-eval-harness.md` (`verevoir/aigency-rebuild`,
branch `meta/self-review-story`) named this as the single best-verified
ground-truth entry in its six-item candidate list, and the one candidate
absent from this corpus. It is added here on that basis, verified again
independently in this pass rather than carried over unchecked.

## Provenance

**`verdict: defect` -- `provenance: verified-directly`, in the specific,
narrow sense below -- split deliberately rather than flattened into one
label, because two different kinds of claim are bundled in this entry and
they were not established with the same confidence:**

1. **The code-level omission -- verified directly, in this pass, against
   retrievable sources, not assumed from the design doc.**
   - Full shas resolved from the design doc's short prefixes (`624ef6c`,
     `8710196...`) against this repository's real commit history on
     `s26/subscription-oauth-locally`, read directly in this pass:
     `624ef6c09b201b98a4d963942726a2652cfb5ba3` ("local runs refuse rather
     than fall back to a paid credential") and
     `87101960f98abf2ed29c946c20929f1ec964b56c` ("Surface an OAuth attempt
     even when the API key chain is tried next...") -- the second is an
     ancestor of, not identical to, the branch's current tip; two more
     commits (`c1573ce...`, `979bf81d...`) landed after it.
   - `src/review/anthropic.ts` read directly at both shas in this pass:
     byte-for-byte identical. `headersFor` is exactly the two-branch form
     quoted above at both points.
   - `src/review/anthropic.ts` read directly at the branch's then-current tip
     (`979bf81d841ee32ea50826a85b5aa8e8b33c98b4`) in this pass:
     `headersFor` was unchanged -- the omission was present in the live code
     at that point, not only at the two historic shas.
   - `grep` for `anthropic-beta` run in this pass across the entire
     `s26/subscription-oauth-locally` branch and separately across `main`:
     zero matches in either. The header is never sent and never mentioned
     anywhere in this codebase.
   - **Re-verified again, live, on 2026-08-25**, immediately ahead of PR #5's
     planned closure: both `624ef6c...` and `87101960...` still resolve;
     `headersFor` at both is still byte-for-byte identical to the form above.
     Not a re-derivation from memory of the earlier pass -- read fresh, a
     second time, before relying on the shas for anything further.

2. **That Anthropic's Messages API actually requires this header for an
   OAuth bearer token to be accepted -- `reported`, not independently
   verified in this pass.** This is an external fact about a third-party
   API, not something readable from this repository's own source. It is
   carried from the original `correctness`-lens finding as synthesised in
   `design/tuned-constants-and-eval-harness.md`; no tool available in this
   pass reaches Anthropic's own API documentation to check it directly. If
   this external claim were wrong, the code-level fact above (the header is
   never sent) would still stand, but the _defect_ label would not -- this
   distinction is why the label is `verified-directly` for the omission and
   `reported` for why the omission matters. Recorded honestly rather than
   folded into one blanket `verified-directly`.

3. **That the finding was raised by pass 1 and absent from pass 3 --
   `reported`, not independently re-read.** No tool available in this pass
   retrieves a specific historic check run's content by id (`97084904599`,
   `97590054942`). This history is carried from
   `design/tuned-constants-and-eval-harness.md`'s own account, which states
   the same limitation about itself. It does not affect this entry's
   scoring value either way: what a configuration is tested against here is
   whether it catches the defect _now_, shown the diff below -- not whether
   it reproduces the specific pass-1/pass-3 history.

4. **Lens attribution (`correctness`) is carried from the same source and
   under the same limitation as point 3 -- reported, not re-derived.** It is
   recorded in `truth.json` as attribution only; `score.mjs`'s matcher does
   not condition on which lens raised a finding, so this does not affect
   scoring.

## `diff.txt`

Produced by `eval/corpus/make-diffs.mjs` from the real `refs.json` above --
not hand-reconstructed. Because `origin/<ref>` can only address a branch
tip, the diff is `main` vs `s26/subscription-oauth-locally`'s tip at build
time, scoped to `src/review/anthropic.ts`, rather than the exact
`624ef6c`/`8710196` snapshots. Given point 1 above (the file is unchanged
from `624ef6c` all the way through every point checked, including the
2026-08-25 re-verification), this substitution does not weaken what the diff
demonstrates -- the omission it shows is the same omission at every one of
those points.

## Durability after PR #5's branch is deleted (added 2026-08-25)

The operator has decided to remove the subscription-OAuth feature entirely;
PR #5 will be closed and `s26/subscription-oauth-locally` may be deleted.
That forced two questions this section answers plainly, in the reverse order
from how the case was originally framed:

**What survives.** `diff.txt`, committed in this same directory, is a real
file in this repository's own git history -- its content does not depend on
`s26/subscription-oauth-locally` continuing to exist, only on this commit
(and whatever it is later merged or carried into) continuing to exist. The
same is true of this file and of `truth.json`. **The case, as a scoreable
artifact, survives the branch's deletion.** This is now the primary framing:
diff.txt is the evidence; `refs.json`'s `base`/`head` are a record of where
it came from, not a live dependency anything still reads at score time.

**What does not survive, or is not known to.** `refs.json`'s `base`/`head`
will stop resolving once the branch is gone -- confirmed by reading
`make-diffs.mjs` in this pass, which hardcodes an `origin/<ref>` prefix and
cannot address a raw sha, so pinning `head` to a sha was considered and
rejected: it would not make the case more durable, it would just make the
next full-corpus `make-diffs.mjs` run fail this one case outright (a failure
the script handles safely -- it does not overwrite an already-good diff.txt
on a failed regeneration -- but a failure nonetheless). The two historical
shas (`624ef6c...`, `87101960...`) are recorded in `refs.json` under
`verifiedShas` as **provenance**: proof of what was independently checked,
twice, not a claim that they remain independently re-checkable afterward. No
merge or other preserving ref onto either sha was found in this pass, so it
is **not established** that either commit stays fetchable once its only
branch is deleted -- the honest assumption is that a future reader cannot
repeat the byte-comparison this pass and the original pass both did. **This
is stated as a real limit, not softened**: if this case's ground truth is
ever challenged, that specific re-verification path is likely gone, and only
the prose and diff already captured here would remain to stand on.

**What would close that gap, not done here:** a lightweight tag pushed to
`origin` pointing at each of the two shas, taken before the branch is
deleted, would keep the objects fetchable independent of the branch's own
ref. Naming it here as the cheap mitigation available, not applying it --
creating tags was not part of this task and is left for whoever owns the
closure of PR #5 to decide.

## A known scoring limitation this entry inherits, not introduced by it

`eval/README.md`'s 2026-08-20 measurement entry records that `eval/score.mjs`'s
default matcher (`mentionsTarget`) requires each truth entry's `target`
field. `truth.json` for this case now carries one (added in a later pass than
the one that wrote the paragraph below, which is left here as it was written,
for the historical record): the matcher's remaining, separately-tracked
limitation is that it can only match a finding whose own prose happens to
name the target file -- a limitation established directly against this
corpus's real captured text in a later pass, not resolved by adding `target`
alone. A reader should not conclude this entry can be run through the current
sweep and produce a real number without accounting for that.
