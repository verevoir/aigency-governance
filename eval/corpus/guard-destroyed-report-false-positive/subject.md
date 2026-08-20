# guard-destroyed-report-false-positive

## What this case is

`recon/harness-findings-overnight.md` (planning repo, `/Users/adsurg/Projects/EE/aigency`,
read-only to this track) — H60's own heading, retrieved verbatim via `grep` in
this pass at line 99: "A guard destroyed a whole turn's report on a false
positive." This is a harness-level finding, not a diff-level lens finding:
some guard, on some earlier session's turn, rejected and discarded the
turn's entire report incorrectly — the underlying report was not actually
the problem; the guard's own detection mechanism produced a false positive,
and the cost fell on the whole report rather than the disputed part of it.

Ground truth for this corpus: **`not-a-defect`** — per the heading's own
framing (explicitly worded as the guard being wrong, a false positive), the
underlying turn/report was fine; what failed was the guard's classification
of it, not the work it classified.

## What is NOT known in this pass

The recon file is 59.9KB; `read_file` returns it as a truncated preview
only, and no tool available in this pass supports a windowed or paginated
read of an arbitrary byte range, or a per-heading extract beyond
exact-substring `grep`. The heading itself (line 99) was retrieved directly
and verbatim in this pass — that much is real and confirmed. The body
paragraph elaborating exactly which guard, on which turn, checking what
specifically, was **not** retrieved in this pass: no probe grep for
plausible body phrasing was attempted, deliberately, per this session's
standing method note against grep-hunting a large file for content whose
exact wording cannot be predicted — that is exploration, not verification,
and risks landing on an unrelated match elsewhere in a 55-finding file and
mistaking it for H60's own body.

## Why this is recorded distinctly from a review-lens false positive

The actor that got it wrong here is a report/verdict guard, not one of this
project's `correctness`/`honesty`/`failure-modes`/`verification`/`blast-radius`
review lenses. It is included in this corpus anyway because it is the same
class of error the corpus exists to probe: something was raised as wrong,
and it was not. Whoever scores against this entry should read it as testing
that pattern in general, not as evidence about diff-shaped lens findings
specifically — this entry has no diff (see below).

## Provenance

**`verdict: not-a-defect` — `provenance: reported-not-rechecked`.** The
heading text is a real, specific, verbatim claim from a real source
(`recon/harness-findings-overnight.md`, confirmed present at line 99 by
direct `grep` in this pass), but this pass did not independently re-verify
the incident's specifics — which guard, which turn, what exactly was flagged
and why it was wrong — beyond that heading. Recorded at the weaker of this
corpus's two provenance levels for exactly that reason, consistent with the
design record's own discipline about not flattening how strongly a label was
checked.

## `diff.txt`

**Absent.** This is a harness/guard-behavior finding, not a change to
reviewable source — there is no diff to show a lens. Kept as a case without
a diff rather than fabricated or dropped, per this corpus's standing rule.
