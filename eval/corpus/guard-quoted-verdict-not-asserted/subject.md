# guard-quoted-verdict-not-asserted

## What this case is

Reported directly by the operator (adam@alwaysagile.ltd) in this conversation,
about an incident earlier the same day (2026-08-20), in this same working
session: a turn's entire report was refused by this repository's
verdict-claims guard because the turn **quoted a gate-verdict token verbatim
while reading `design/tuned-constants-and-eval-harness.md` aloud** —
reproducing a verdict string that already existed in that design document's
own text, not asserting a new verdict of its own. The guard could not
distinguish quotation from assertion, treated the quoted token as if the
turn itself were claiming that verdict, rejected the whole report, and the
turn's work was destroyed and its output redacted.

Ground truth: **`not-a-defect`** — the turn had done nothing wrong; the
quoted text was a faithful reproduction of source material, not a
fabricated or unearned claim.

## Why this is recorded distinctly from a review-lens false positive

The actor that got it wrong here is a report/verdict-claims guard, not one
of this project's `correctness`/`honesty`/`failure-modes`/`verification`/
`blast-radius` review lenses. It is included in this corpus on the
operator's own direction, because it is the same class of error the corpus
exists to probe, and a real and recurring confusion: mistaking _reporting_
something (quoting, citing, describing) for _doing_ it (asserting, claiming,
having verified). A configuration that would make the same mistake on a
diff-shaped version of this pattern — code that quotes or logs a value that
looks like a claim, versus code that actually makes that claim — is exactly
what this entry exists to test for. Whoever scores against it should note:
this entry is diff-less by nature (see below), and should be read as testing
that pattern in general, not as evidence about diff-shaped lens findings.

## Provenance

**`verdict: not-a-defect` — `provenance: verified-directly (on the
operator's account)`.** The operator gave this account directly and
firsthand in this conversation, naming the specific mechanism precisely (a
gate-verdict token quoted, not asserted, while reading a named design
document aloud) — and explicitly authorized recording it at this corpus's
stronger provenance level, while asking that it be attributed plainly to the
operator's own account rather than to independent verification performed by
this pass. This pass did not, and could not, independently re-run the guard
or re-read the original destroyed report: the incident is not re-creatable
from this pass, since the guard's own rejection is what destroyed the
artifact that would prove it directly. Recorded as the operator's account,
not this pass's own observation, per the operator's own instruction.

## `diff.txt`

**Absent.** The incident is about a turn's own report being rejected by a
guard, not about a change to reviewable source — there is no diff to show a
lens, and none was requested. Kept as a case without a diff rather than
fabricated or dropped, per this corpus's standing rule.
