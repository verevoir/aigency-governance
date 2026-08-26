# PR #5's nine review passes — recovered, honestly partial

PR #5 (`S26: run the panel on a subscription OAuth token, locally`,
`s26/subscription-oauth-locally`) is closed and withdrawn under
`decisions/022` (see its own body, and `aigency-rebuild`'s
`decisions/024-the-reviewer-does-not-learn-subscription-auth-it-shells-out.md`
on `meta/self-review-story`). Its nine review passes are the richest single
record of this panel's actual behaviour this project has produced. An
earlier draft of this paragraph also claimed a total of twenty findings,
every one adjudicated true, all but one fixed — **that claim is retracted
here, because it does not sum from what this document itself recovered,
and the per-finding fix status was never itemized here either.** What can
actually be summed, from this document's own per-pass counts (pass 2: 2,
pass 3: 4, pass 4: 3, pass 5: 4, pass 7: 1, pass 8: 1, pass 9: 1 — see 'Per
pass' below, and the 'Pass 6' section for where pass 2's count is stated),
is **at least 16 findings, individually attested across seven of the nine
passes.** Pass 1 is known to have had at least one further finding, but no
count for it survives anywhere reachable; pass 6's count exists only as
the operator's own contemporaneous report, not independently verified,
and this document's own 'Pass 6' section already states plainly that it
does not reconcile against the rest. **The honest total across all nine
passes is therefore at least 16, with an unknown further count in passes 1
and 6, and — per 'What is genuinely gone', below — no route left to
establish it more precisely than that.** Closing the pull request made
this record hard to reach. This file is the recovery attempt, done once
the pull request was already closed, and it reports both what was
recovered and what was not — a partial record honestly labelled, per the
instruction that produced it.

**This is the gap the review-artefact-persistence work (branch
`review-artifact-persistence`, this same repository) exists to close.** Had
that mechanism existed while PR #5 was live, none of this recovery would
have been necessary — every pass would already be a retained artefact. It
did not exist yet. This file is the cost of that, made concrete.

## What was established about recovery itself, this pass

- **Closing a pull request does not delete its check runs — confirmed, not
  assumed.** `read_pull_request_review` against the closed PR #5 still
  returns a result: `verdict: "rejected"`, one matched run
  (`review / review`, id `97673740219`), and its content recoverable from
  the underlying CI job log. Closed status did not make the verb return
  nothing.
- **The route is narrower than "closing doesn't delete logs" makes it
  sound.** `read_pull_request_review` surfaces only the **most recently
  matched check run** for a pull request — there is no verb on this belt
  that retrieves a specific *historic* check run by id, even when the id is
  known. This limit is not new to this pass; it is already recorded,
  independently, in `aigency-rebuild`'s
  `design/tuned-constants-and-eval-harness.md` (entries 6 and 7, repeated
  at least four times across that document while it was being written
  live) and in `recon/harness-findings/README.md` ("no verb re-runs a
  concluded check run"). This pass confirms it again, now against a fully
  closed pull request rather than a merely-superseded run.
- **Practical effect: only the pull request's *final* check run (pass 9)
  was reachable by any tool available this pass.** Passes 1–8 are only as
  recoverable as they were already recorded, live, by an earlier session,
  in `aigency-rebuild`'s design document — some of that recording is
  directly-verified quotation, most of it is reported counts or
  paraphrase. Nothing this pass did could add a byte to what that document
  already preserved for passes 1–8; this file consolidates and cites it
  rather than duplicating it.
- **A GitHub log-redaction artifact, worth flagging rather than smoothing
  over:** the pass-9 finding text recovered below contains a literal
  `authorization: ***` — GitHub's own secret-masker in the job log, not the
  panel's actual wording. Whatever the finding originally said after
  `authorization:` is not recoverable byte-for-byte; the masker treated
  part of the panel's own prose as if it were a live credential. Reported
  here as a limit on what "verbatim" can mean for job-log recovery, not
  silently accepted as the finding's true content.

## Per pass

| Pass | Head sha | Check run id | Verdict | Findings verbatim? |
|---|---|---|---|---|
| 1 | `624ef6c` | `97084904599` | rejected (finding present) | **No** — not recoverable by any tool this pass; reported/paraphrased only, in `tuned-constants-and-eval-harness.md` entry 6 |
| 2 | `8710196` | `97590054942` | rejected (this finding absent) | **No** — count/presence only |
| 3 | `c1573ce` | `97599017858` | rejected, 4 findings (this finding absent) | **No** — count only |
| 4 | `979bf81` | `97603896359` | rejected, 3 findings | **Partial** — see below |
| 5 | (not recorded in what's reachable) | (not recorded) | rejected, 4 findings | **Partial** — see below |
| 6 | unknown | unknown | reported only, count disputed | **No** — not independently verified by anything reachable |
| 7 | `d0a9ca39f62caa6486955d658ca2c8be1c8c163b` | `97646304765` | rejected, 1 finding (`honesty`) | **No** — recorded elsewhere as "quoted in full" but the quote itself was not extractable by any tool available this pass; see pointer below |
| 8 | `1ea8318…` (full sha not recorded in what's reachable) | `97657604608` | rejected, 1 finding (`verification`) | **Yes, with ellipses** — quoted below |
| 9 | `b444e2f4af7a8ddce218bc68e283447e6bd0a0a4` | `97673740219` | rejected, 1 finding (`correctness`) | **Yes, full** — recovered fresh this pass from the CI job log itself, below |

### Pass 4 — `979bf81`, check run `97603896359`, rejected, 3 findings

Recorded in `tuned-constants-and-eval-harness.md` (`aigency-rebuild`,
`meta/self-review-story`) as verified live against `read_pull_request_review`
at the time. Reproduced here as that document states it — this is that
document's own account, not independently re-read this pass (the run is no
longer the PR's most recent, so it is no longer reachable):

- **`failure-modes`** — the OAuth chain's own `unreadable` branch discards
  `blankEnvVar`/`missingExplicitPath` the same way the sibling API-key-chain
  branch was already fixed not to; the exact mirror of an asymmetry pass 3
  had closed, now on the other side.
- **`verification`** — a newly-added leak test asserting the OAuth token is
  absent from a rendered report holds vacuously, because the code path it
  forces never writes `credential.value` into the fields the assertion
  reads.
- **`blast-radius`** — a README settings-table reformat riding along,
  touching rows the change didn't need to touch.

### Pass 5 — 4 findings, one inside `settings.ts`

`tuned-constants-and-eval-harness.md` records this pass as independently
verified at the time, and separately records that its own verification
found a discrepancy with the operator's account it was built from: the
account held that none of pass five's findings were in `settings.ts`; the
check run itself showed one — an `honesty` finding specifically about
`src/review/settings.ts` — was. The other three (`failure-modes`,
`verification`, `blast-radius`) were outside `settings.ts`. The exact
finding text is not reproduced verbatim in what this pass could extract;
the head sha and check run id for this pass are likewise not stated
explicitly in the reachable text. Read `tuned-constants-and-eval-harness.md`
directly (search "pass five" / "pass 5") for whatever more it holds.

### Pass 6 — reported only, and disputed against this document's own counts

The operator's own running account for a sixth pass — "seven passes... 4,
4, 3, 3, and now 1 finding. Eighteen total, zero recurrences" — is recorded
in `tuned-constants-and-eval-harness.md` as carried, explicitly, **as
reported, not reconciled**: set against that same document's own
independently-verified counts (pass 2: 2, pass 3: 4, pass 4: 3, pass 5: 4),
the two accountings do not obviously sum to the same total, and that
document declines to force a match. Nothing here adds anything further —
this pass's check run id and head sha are not established anywhere
reachable.

### Pass 7 — `d0a9ca39f62caa6486955d658ca2c8be1c8c163b`, check run `97646304765`, rejected, 1 finding (`honesty`)

`tuned-constants-and-eval-harness.md` (around its "Pass 7 — the current,
live check run" heading) states this was verified directly at the time,
against the live check run, its report recovered from the CI job log (the
producer had published nothing to the check run's structured output for
this one), and states the single `honesty` finding was "quoted in full
because its content is the point." **That quoted text itself could not be
extracted by any tool available this pass** — the source document is 459
lines and exceeds what a single read can return, and no phrase this pass
guessed at matched it under `grep`. This is a real, named gap in this
recovery, not a silent one: **go to
`design/tuned-constants-and-eval-harness.md` in `aigency-rebuild` at
`meta/self-review-story` directly and read the "Pass 7" section** for the
finding this file could not pull free.

### Pass 8 — check run `97657604608`, rejected, 1 finding (`verification`)

Quoted in `tuned-constants-and-eval-harness.md`, with the document's own
ellipsis truncations, reproduced verbatim as it appears there:

> "The malformed-value validation for `AIGENCY_REVIEW_ALLOW_API_KEY_FALLBACK`...
> is exercised only by unit tests that call `resolveSettings` with a fake
> environment object... `scripts/check-cli.mjs` only adds a scenario for the
> exact literal `'false'` and never spawns the real binary with a malformed
> value... to prove the real `process.env` actually reaches this specific
> check."

This was the pass predicted, before it ran, by the conversation doing the
work at the time — asked what a further pass would find, it named this gap
specifically, and pass 8 found exactly that instance.

### Pass 9 — `b444e2f4af7a8ddce218bc68e283447e6bd0a0a4`, check run `97673740219`, rejected, 1 finding (`correctness`)

**Recovered fresh this pass**, in full, directly from the CI job log via
`read_pull_request_review` against the still-closed pull request. This is
the pass whose finding — the `anthropic-beta` header omission — became the
eval corpus's only verified ground-truth logic defect
(`eval/corpus/oauth-missing-beta-header/`, tags
`corpus/oauth-missing-beta-header/base` and `/head`). Full report text as
recovered (note the `***` redaction artifact flagged above):

> ## Review: Rejected
>
> **S26: run the panel on a subscription OAuth token, locally**
>
> ### 1 finding(s)
>
> #### correctness
>
> - `headersFor` in `src/review/anthropic.ts` sends only `authorization: ***`
>   for a subscription OAuth credential and omits the `anthropic-beta`
>   header Anthropic's API requires to accept a Claude-subscription OAuth
>   token on the Messages endpoint, so a real `CLAUDE_CODE_OAUTH_TOKEN`
>   would fail authentication in practice — contradicting the file's and
>   README's central claim that the OAuth path is an identical request
>   differing only by header, and leaving the entire "run the panel on a
>   subscription token, locally" feature non-functional against the real
>   API despite being fully covered by mocked tests that never exercise
>   this gap.
>
> ---
>
> Judged by 5 lens(es) from
> `/home/runner/work/aigency-governance/aigency-governance/.aigency-review/review/lenses.json`,
> via API key.

## What is genuinely gone, stated plainly

**Passes 1, 2, 3, 5 (partially), 6 and most of 7 have no recoverable
verbatim finding text reachable from this repository's own belt, this
pass, and no tool exists here that could reach it either — not because the
attempt was shallow, but because no verb available anywhere in this session
retrieves a specific historic check run by id.** What survives of them
survives only because an earlier session, working live while those passes
were current, chose to quote or record them into
`design/tuned-constants-and-eval-harness.md` before they scrolled out of
reach. Where that earlier session did not quote verbatim — passes 1, 2, 3,
and most of 5 and 6 — the exact words are gone. Not "not yet found":
gone. GitHub's 90-day job-log retention did not save them, because nothing
ever asked GitHub for that specific run's log at a time when it was still
the PR's current run.

**This is the finding the operator asked for if the earlier passes turned
out to be genuinely gone: the cost of never having persisted them was real,
is now realised, and is only partially recoverable after the fact — even
with the fix (job-log recovery working on a closed PR) confirmed working,
because that fix only ever reaches the *most recent* run, never the ones
superseded before anyone thought to keep them.**
