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
   - `src/review/anthropic.ts` read directly at the branch's then-current tip
     (`979bf81d841ee32ea50826a85b5aa8e8b33c98b4`) in this pass:
     `headersFor` was unchanged — the omission was present in the live code
     at that point, not only at the two historic shas.
   - `grep` for `anthropic-beta` run in this pass across the entire
     `s26/subscription-oauth-locally` branch and separately across `main`:
     zero matches in either. The header is never sent and never mentioned
     anywhere in this codebase.
   - **Re-verified again, live, on 2026-08-25**, immediately ahead of PR #5's
     planned closure: both `624ef6c...` and `87101960...` still resolve;
     `headersFor` at both is still byte-for-byte identical to the form above.
     Not a re-derivation from memory of the earlier pass — read fresh, a
     second time, before relying on the shas for anything further.

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
tip, the diff is `main` vs `s26/subscription-oauth-locally`'s tip at build
time, scoped to `src/review/anthropic.ts`, rather than the exact
`624ef6c`/`8710196` snapshots. Given point 1 above (the file is unchanged
from `624ef6c` all the way through every point checked, including the
2026-08-25 re-verification), this substitution does not weaken what the diff
demonstrates — the omission it shows is the same omission at every one of
those points.

## Durability after PR #5's branch is deleted (added 2026-08-25)

The operator has decided to remove the subscription-OAuth feature entirely;
PR #5 will be closed and `s26/subscription-oauth-locally` may be deleted.
That forced two questions this section answers plainly, in the reverse order
from how the case was originally framed:

**What survives.** `diff.txt`, committed in this same directory, is a real
file in this repository's own git history — its content does not depend on
`s26/subscription-oauth-locally` continuing to exist, only on this commit
(and whatever it is later merged or carried into) continuing to exist. The
same is true of this file and of `truth.json`. **The case, as a scoreable
artifact, survives the branch's deletion.** This is now the primary framing:
diff.txt is the evidence; `refs.json`'s `base`/`head` are a record of where
it came from, not a live dependency anything still reads at score time.

**What does not survive `refs.json`'s own `base`/`head` fields, unchanged
from the original analysis.** Those two fields will still stop resolving
once the branch is gone — confirmed by reading `make-diffs.mjs`, which
hardcodes an `origin/<ref>` prefix and cannot address a raw sha, so pinning
`head` to a sha directly was, and remains, rejected: it would not make the
case more durable, it would just make the next full-corpus `make-diffs.mjs`
run fail this one case outright (a failure the script handles safely — it
does not overwrite an already-good `diff.txt` on a failed regeneration —
but a failure nonetheless).

**CORRECTION (2026-08-25, later the same day): the paragraph that used to
stand here said independent re-verification of the two shas would likely
not survive the branch's deletion, because no preserving ref had been
found. That is now wrong, in the good direction, and is corrected here
rather than silently edited away.** The operator created and pushed two
lightweight tags directly at the two shas:

```
624ef6c09b201b98a4d963942726a2652cfb5ba3    refs/tags/corpus/oauth-missing-beta-header/base
87101960f98abf2ed29c946c20929f1ec964b56c    refs/tags/corpus/oauth-missing-beta-header/head
```

Confirmed resolvable from the belt in this pass — `read_file` against
`https://github.com/verevoir/aigency-governance` succeeded through both
`refs/tags/corpus/oauth-missing-beta-header/base` and the bare
`corpus/oauth-missing-beta-header/base` ref form (and the equivalent `/head`
forms), returning `headersFor` content byte-identical to every earlier read
at these shas. **This is real, demonstrated evidence, not restated hope**:
a lightweight tag, unlike a branch, is not removed by any routine action —
including the deletion of `s26/subscription-oauth-locally` itself — and
requires a separate, deliberate act to remove. The reasoning that produced
the earlier, more pessimistic paragraph was correct at the time it was
written (no preserving ref existed then); the fact on the ground has since
changed, and the honest thing is to say so plainly rather than have the two
paragraphs read as if they always agreed.

**What this does and does not buy.** It buys future independent
re-verification of the code-level claim: anyone can still fetch
`refs/tags/corpus/oauth-missing-beta-header/{base,head}` and re-run the same
byte-comparison this pass and the original pass both did, even after the
branch and PR #5 itself are gone. It does **not** make `refs.json`'s
`base`/`head` fields resolve, and it does not let `make-diffs.mjs` (as it
stands) regenerate `diff.txt` from these tags — see the sizing note below.
`diff.txt`, already committed, remains the artifact `score()` actually
reads; the tags are additional provenance, not a replacement path into the
scoring pipeline.

**Sizing `make-diffs.mjs` accepting a tag, asked and not actioned.** The
script's `origin/${refs.head}` construction resolves a remote-tracking
branch ref; a tag is fetched to `refs/tags/<name>` directly, with no
`origin/` prefix, so the same string substitution that would work for a sha
does not work for a tag either — this is a distinct case, not a special
case of the sha problem. Teaching it to accept a tag is **plausibly small in
lines** (a conditional on a new `refType` field, or a fallback that retries
unprefixed if the `origin/`-prefixed form fails) but is not zero-decision:
it needs a schema choice for how `refs.json` states "this is a tag, not a
branch" and a decision about whether that fallback should apply repo-wide or
only where declared. Not implemented in this pass, per instruction — sized,
not built.

**Both original reasons `anthropic.ts` was kept broken all session no
longer apply, as a fact about this case, not as an instruction being acted
on here.** It was left alone (a) to stay the corpus's calibration point and
(b) to keep the objects it was found in reachable while no preserving ref
existed. (a) is now moot because the feature it belongs to is being removed
with PR #5, not repaired — a fix and a deletion are different events and
this record should not blur them. (b) is now moot because the tags above
anchor the objects independent of the code's fate. Neither of these facts
changes anything this pass did to the file: it remains untouched here,
exactly as instructed.

## A further ref-durability test (added 2026-08-25, same session)

Tested, in this pass, whether GitHub's pull-request ref offers a path to the
same commits independent of the source branch name, per a question raised
after the durability section above was written. Both `refs/pull/5/head` and
`pull/5/head` resolve `src/review/anthropic.ts` successfully today, read
directly, while `s26/subscription-oauth-locally` still exists and PR #5 is
still open. **This is not evidence that either ref survives the branch's
deletion** — testing that would require the deletion to have already
happened, which it has not in this pass, and triggering it is not this
pass's to do. GitHub's own general behaviour for an intra-repository pull
request is that `refs/pull/N/head` is maintained independently of the head
branch and typically outlives its deletion — stated here as informed
expectation, not as something demonstrated in this repository. If it holds,
it is a second, independent path to the same commits beyond `diff.txt`;
until observed to survive an actual deletion, `diff.txt` remains the primary,
demonstrated-durable evidence this case rests on, exactly as the section
above already states.

## A known scoring limitation this entry inherits, not introduced by it

`eval/README.md`'s 2026-08-20 measurement entry records that `eval/score.mjs`'s
default matcher (`mentionsTarget`) requires each truth entry's `target`
field. `truth.json` for this case now carries one (added in a later pass than
the one that wrote the paragraph below, which is left here as it was written,
for the historical record): the matcher's remaining, separately-tracked
limitation is that it can only match a finding whose own prose happens to
name the target file — a limitation established directly against this
corpus's real captured text in a later pass, not resolved by adding `target`
alone. A reader should not conclude this entry can be run through the current
sweep and produce a real number without accounting for that.
