# The eval sweep

`sweep.mjs` measures review _fan width_ — how many lenses a review panel is
split into — against two questions: where does the width/quality trade-off
sit, and does the answer move when the practice corpus that defines the
lenses grows or shrinks?

This is a kept, committed, **re-runnable measurement**, not a diagnostic
thrown away after use. Run it again whenever the practice corpus, the model,
or the lens-partitioning strategy changes, and compare results files.

## Headline metrics

For each `(width, practiceCount)` configuration, repeated `--repeats` times:

- **Recall** — of the labelled findings in a case's `truth.json`, how many
  did the panel actually surface.
- **Confirmed false positives** — findings the panel raised that the case's
  truth explicitly marks as not real.
- **Run-to-run stability** — whether the same configuration produces the
  same verdict across its repeats. This is _why_ `--repeats` defaults to 3
  and not 1: a single sample cannot show stability, only a point.
- **Cost** — prompt characters sent (a proxy visible before spending) and,
  once a run has actually happened, the token usage each call reports.

**Inter-lens agreement is recorded as a diagnostic and must never be tuned
against.** A configuration whose lenses all converge on the same skim scores
_well_ on agreement precisely when it has stopped working — five lenses that
all say "looks fine" agree perfectly and caught nothing. Agreement is worth
recording (it explains a stability number, it flags a width that has
collapsed into one redundant read), but optimising _for_ it selects for
exactly the failure mode the sweep exists to detect.

## The bracket, not a leaderboard

The harness does not need a precise optimum — "10 good, 15 bad" is enough to
act on; nobody needs "12 is the limit". Each width gets a **verdict**, not a
rank: `good`, `bad`, or `indistinguishable`, computed by
`eval/criterion.mjs`'s `classifyWidth`. Widths are never ranked against each
other on small differences — three repeats over three cases cannot separate
neighbours, and presenting an ordering would imply a precision the data does
not have.

**The rule, stated once, named, with its reasoning attached** (the full text
is `CRITERION_RULE` in `eval/criterion.mjs`, and is also printed into every
results file's `criterion` field, so a reader never has to leave `results/`
to know what "good" meant that run):

> A width is **good** if, across the repeats, every `defect` corpus entry is
> caught (named by a finding) in at least `CATCH_THRESHOLD_OF_3` (2) of 3
> repeats, **and** every `not-a-defect` entry is correctly rejected (never
> named by any finding) in at least `REJECT_THRESHOLD_OF_3` (2) of 3
> repeats. It is **bad** if any entry fails its own threshold with enough
> usable data to judge. It is **indistinguishable** if fewer than
> `MIN_USABLE_REPEATS_OF_3` (2) of 3 repeats produced a usable score for
> some entry and nothing failed outright — too few usable calls to judge,
> not a verdict about quality.

Correct rejection is not optional and is not special-cased to one entry: a
configuration that catches every real defect by flagging _everything_,
including `eval/corpus/practices-not-dead-code`'s correct-rejection entry
(named as `CORRECT_REJECTION_CASE_ID`, the corpus's sharpest such case), is
not good, and a rule scored on recall alone would rank exactly that
configuration top. Every `not-a-defect` entry in the corpus is held to the
same bar, not only the named one.

**Binary chop is only valid between a known-good point and a known-bad
point — never assumed from zero.** The design record
(`design/tuned-constants-and-eval-harness.md`) predicts an **interior
optimum**: total attention is per-lens breadth plus combiner breadth, so
quality is expected to rise and then fall as width grows, rather than
increasing monotonically. A narrow fan and a wide fan are predicted to fail
for **opposite reasons** — per-lens crowding at the narrow end, combiner
overload at the wide end — so nothing may be assumed to improve
monotonically from either end. If width 8 comes back `good` and width 21
comes back `bad`, that bracket is already actionable on its own; narrowing
it further with a chop to 13 or 14 is optional, not required. If both come
back `good`, the informative direction to test next is _up_, not between
them — the interior-optimum prediction says the failure, if there is one, is
farther out.

Failures are recorded as data, not dropped: a lens that comes back
`could_not_run` — a truncated `max_tokens` reply, a transport failure that
outlasted retry, an unparseable reply — is a real property of that
configuration (a wide fan may fail more often) and is counted per
configuration, never silently excluded from the total.

## Running it

```
node eval/sweep.mjs
```

**Defaults to a dry run.** No model is called and nothing is spent. It
prints: total configurations, total model calls the full sweep would make,
the total prompt characters it would send, and which inputs (the practice
corpus, the labelled corpus, `partition.mjs`, `score.mjs`) were found versus
missing. A sweep of 8 widths × 2 corpus sizes × 3 repeats is well over a
thousand calls at the wide end — see this number before it is charged, not
after.

To actually spend money:

```
node eval/sweep.mjs --spend
```

This requires `ANTHROPIC_API_KEY` (env, `ANTHROPIC_API_KEY_FILE`, or the
default key file at `$XDG_CONFIG_HOME/verevoir/anthropic.key` — see
`src/review/settings.ts` for the full resolution order; `resolveSettings`
does not read `CLAUDE_CODE_OAUTH_TOKEN` at all under its current contract)
and needs the
practice corpus, at least one labelled corpus case, `eval/partition.mjs` and
`eval/score.mjs` all present; missing any of them refuses to spend and says
which one.

Every call — across every configuration, case and repeat in the whole sweep,
not just within one configuration — goes through a single pool capped at
`--concurrency` (default **4**). This is the direct fix for the predecessor
of this file, `scripts/_diag-hypothesis.mjs`, which fired all 10 of its calls
simultaneously and got back ten HTTP 429s and zero data; a width-34
configuration fires 34 lenses, and the cap applies regardless of how many
configurations are queued behind it.

Other flags: `--widths 1,3,8,21` (or `--widths=1,3,8,21`; both forms work,
default `1,2,3,5,8,13,21,34`), `--practice-counts full,half`, `--repeats 3`,
`--practices-file PATH`, `--corpus-dir PATH`, `--results-dir PATH`.
`node eval/sweep.mjs --help` prints all of them.

**Before a real run, check the quota first — it costs a rounding error:**

```
node eval/sweep.mjs --probe --spend
```

Makes exactly **one** model call and reports success, HTTP 429, or a
transport failure, then exits 0 or 1 to match. This exists because stage 1's
first real run spent 49 minutes and 72 calls to learn what one call now
answers immediately — see Measurements below. Declared as the release
command `eval-sweep-probe`; run it before any real `--spend` run, and stop
if it comes back red.

**A real run also aborts itself on a sustained wall.** If 20 consecutive
calls (across the whole sweep, not per configuration) come back HTTP 429
with no success in between, the run stops dispatching new calls, writes the
partial results file with an explicit `abortReason`, and exits non-zero,
rather than grinding through the rest of the retry ladder for every
remaining call. The threshold is `MAX_CONSECUTIVE_429` in `eval/sweep.mjs`,
with its own comment stating why 20 and what the trade is.

**A run that aborted, crashed, or was interrupted can be finished, not
restarted:**

```
node eval/sweep.mjs --spend --resume eval/results/<the-partial-file>.json
```

Adopts that file's own `axes` and `--repeats` (a resume finishes the same
sweep; it does not start a differently-scoped one) and skips configurations
it already completed rather than re-spending on them. Refuses rather than
silently mixing results if the current corpus's case set or practice-corpus
size do not match what the file was produced against. **Known limitation:**
resume does not verify the model or credential match the resumed file's —
only the corpus signature, the practice-corpus size, and `--repeats`.

**`--widths` exists precisely so a first real run can be scoped from the
command line rather than by editing this file.** The default sweep is 8
widths × 2 corpus sizes × 3 repeats — well over a thousand calls — and a
first `--spend` run should be a deliberately small slice, e.g.
`node eval/sweep.mjs --spend --widths 1,3,8,21`. Whatever widths a run
actually used are recorded in its results file under `axes.widths` — not the
default list — so a later reader always sees what produced that file, never
what _would_ have produced it had nothing been scoped down.

## Inputs this file does not own

- `eval/partition.mjs` — `partition(practices, width, opts) -> LensSet`.
  Splits a practice subset into `width` disjoint lenses. `sweep.mjs` selects
  the practiceCount subset (see below) and hands it to `partition`; it does
  not shape lenses itself.
- `eval/score.mjs` — `score(findings, truth, opts) -> { matched, recall,
confirmedFalsePositives, unclassified, perEntry, agreement }`. Scores one
  case's aggregated findings against its `truth.json`.
- `eval/practices/practices.json` — the practice corpus.
- `eval/corpus/<case-id>/{subject.md,diff.txt,truth.json}` — labelled cases.
  `subject.md`'s internal format is not assumed here — the case id becomes
  the subject's title and the whole file becomes its description, the one
  mapping that needs no convention from the file's contents.

If any of these are absent when `sweep.mjs` runs, the dry run reports them as
missing rather than crashing, and `--spend` refuses to proceed rather than
running a partial, silently-smaller sweep.

## The `practiceCount` axis

`full` is the entire corpus. `half` is a **deterministic prefix slice** of
it — the first `ceil(n / 2)` practices in `practices.json`'s declared order —
not a random or stratified sample. The point of this axis is comparing the
same measurement across two corpus sizes; a slice that changed between runs
would make that comparison meaningless. This is a modelling choice worth
knowing when reading a results file, not a hidden implementation detail.

**The scaling experiment has a ceiling set by corpus size, measured, not
assumed.** A width can only be swept against a `practiceCount` mode if that
mode's subset holds at least `width` practices — `partition.mjs` refuses
rather than emit an empty lens, and correctly so (an empty lens approves
everything it sees). At the corpus's current 45 practices, `half` is 23, so
width 34 — the top of the default sweep — is infeasible against `half` and
that configuration reports `lensSetError` with 0 calls costed for it rather
than crashing the run. This was not a hypothetical worked out in advance; it
is what the dry run against the real corpus and the real `partition.mjs`
actually produced. To ask the scaling question (does the optimal width move
with corpus size?) at the wide end of the default sweep, the practice corpus
needs to roughly double from where it stands today — otherwise the widest
configurations only ever run against `full` and the `half` side of that
comparison is silently missing exactly where it would be most informative.

## Lenses carry the practice bar; nothing else does

Each call sends `buildPrompt(lens, subject)` with **no separate `practices`
argument**. The lenses produced by `partition.mjs` already carry their slice
of the corpus in `lens.focus` — that is the entire point of partitioning
practices into lenses rather than reviewing against one flat bar with a
fixed panel. Passing the practices a second time as the generic "bar" would
double-count them and, worse, make the shared prompt prefix depend on which
lens is calling, defeating the cache-friendly shared/per-lens split
`prompt.ts` exists to preserve.

## Results

A real (`--spend`) run writes `eval/results/<iso-date>-<model-id>.json`.
Every result records what produced it, so a number is never left with a lost
derivation: the model id, the date, the git sha (or explicitly that no sha
could be obtained), the concurrency cap, every axis value swept, the corpus
and practice-set sizes, and the **full generated `LensSet`** for each
configuration — not just its width, but the actual lenses `partition.mjs`
produced, so a later reader can see exactly what each lens's mandate was
without re-running the partition.

**The file is written incrementally, not once at the end.** A `--spend` run
persists after every configuration completes — every call belonging to that
`(width, practiceCount)` scored and folded in — rather than assembling the
whole document only once every call in the sweep has resolved. It always
carries `partial` (`true` until the last planned configuration lands),
`configurationsCompleted` and `configurationsPlanned`, so a run that crashes
or is interrupted partway through leaves an honest, readable record of
whatever it actually finished, instead of losing everything collected up to
that point. This exists because the harness's own first real run did exactly
that — see Measurements below — and the fix is the same discipline
`lensSet.ts` already applies to its own output: an elision announces itself.

## Measurements

**2026-08-20 — first real spend, 0 of 72 calls succeeded.** `eval-sweep-smoke`
(`--spend --widths 1,3`, concurrency 4, model `claude-sonnet-5`, credential
`subscription-oauth`) ran for 49 minutes and every one of its 72 calls
returned **HTTP 429** at every attempt of the retry ladder — the run was then
killed outright by a bare `fetch()` throw the harness did not yet catch (see
the fix above and in `callOnce`). **$0 billed**: no call ever reached
`response.ok`, so no usage was ever reported to bill against. No scoring
data exists for this run and no results file was produced (the incremental
persistence described above did not exist yet at the time of this run).

This **falsifies the concurrency hypothesis**, not confirms it. The
predecessor to this harness, `_diag-hypothesis.mjs`, fired all 10 of its
calls simultaneously and got ten-for-ten HTTP 429s; that failure was
attributed to firing everything at once, and this harness's concurrency cap
(default 4) was built specifically to fix it. At a cap of 4, over a sustained
49-minute window, the wall did not clear — every attempt at every backoff
interval (15s/30s/45s/60s/75s) still came back 429, which reads as a quota
exhausted for the credential over that whole window rather than a burst
limiter that a lower concurrency would satisfy. The harness has **not yet
produced a fan-width number** — recall, confirmed false positives,
run-to-run stability and cost all remain unmeasured. Quota is not something
this file can fix; the next real run is a decision for whoever holds the
credential, not a retry loop.

**2026-08-20 — stage 2 probe, quota still down, stage 2 not run.** Before
spending on the authorised stage 2 sweep (widths 8, 21, both corpus arms,
522 calls), `eval-sweep-probe` (one call) was run to check the quota first
instead of finding out 49 minutes in again. First call: a bare **transport
failure** (`transport failed: fetch failed`, one attempt — a network-level
exception, not a reply from the API at all, and not retried since only an
HTTP 429 triggers this file's retry ladder). Run a second time immediately
after to tell a network blip from a persistent problem: this one reached the
API and came back a confirmed **HTTP 429** after exhausting its own retry
ladder — `{"type":"rate_limit_error","message":"Error"}` with a real
`request_id`, not a guess. Combined, the wall identified in stage 1 is
still up. Per the operator's own decision rule (probe 429s → stop, do not
spend on the sweep), **stage 2 was not run.** `eval-sweep-stage2` remains
declared and ready to run once `eval-sweep-probe` comes back green.

**2026-08-20 — confirmed defect (now fixed): `sweep.mjs` assumed a
`settings.credential.{source,value}` shape that `resolveSettings` does not
produce.** Surfaced by running `eval-sweep-probe` for real against a
freshly-rebuilt `dist/`: `TypeError: Cannot read properties of undefined
(reading 'source')`. `ReviewSettings` (`src/review/settings.ts`) is `{
apiKey, model, maxTokens, lensSource, lensToken? }` — no `credential` field
— and `src/review/anthropic.ts`, the real production request path, sends
`'x-api-key': config.apiKey` unconditionally; there is no OAuth-bearer
alternative anywhere in this codebase's actual request-building code. This
file's `headersFor`/credential logic was copied from
`scripts/_diag-hypothesis.mjs`, which made the identical assumption and
would crash identically if run against the current, freshly-built `dist/`.
This session's _earlier_ stage-2 probe calls (the ones reporting
`credential=subscription-oauth` and a real HTTP 429, above) ran against a
`dist/` that had not yet been rebuilt from the currently-committed
`src/review/settings.ts` — rebuilding it (via the repository's own `build`
bootstrap step) surfaced the mismatch immediately as a crash rather than
silently sending whatever header the stale assumption produced. **Fixed**:
`headersFor` now sends `'x-api-key': settings.apiKey` unconditionally,
matching `anthropic.ts` exactly, and `aigency.json`'s `eval-sweep*` commands
now declare `ANTHROPIC_API_KEY`, `ANTHROPIC_API_KEY_FILE`,
`XDG_CONFIG_HOME` and `HOME` — the variables `resolveSettings` actually
reads — in place of `CLAUDE_CODE_OAUTH_TOKEN`, which it does not read at
all. A lesson for this harness generally: a shared, production settings
module can change contract out from under a script that imports it, and the
only way this was caught was running the real thing against a freshly built
`dist/`, not by reading the source in isolation.

**2026-08-20 — confirmed defect: the real corpus `truth.json` files do not
match `score.mjs`'s matcher contract, and it crashes on any non-empty
findings array.** Found while building the bracket criterion above, and
verified with a temporary, non-committed vitest case (not left in the tree)
rather than asserted from reading alone: `eval/score.mjs`'s default matcher
(`mentionsTarget`) requires each truth entry's `target` field; every entry
in all three of `eval/corpus/{dead-decorators,practices-not-dead-code,
readme-drift}/truth.json`, as committed, carries only `lens`, `summary`,
`evidence`, `verdict`, `provenance` — **no `id`, no `target`**. Calling
`score()` with a non-empty findings array against any of the three throws
`Cannot read properties of undefined (reading 'toLowerCase')`, confirmed for
all three cases. `sweep.mjs` already catches this (`score: { error: ... }`
per repeat, never an uncaught crash), so a real run would not itself abort —
but every repeat where a lens actually raised a finding would score as
unusable, and `classifyWidth`'s `MIN_USABLE_REPEATS_OF_3` would read most
real configurations as `indistinguishable` rather than `good` or `bad`,
regardless of what the panel actually said. **A real spend right now would
mostly measure this bug, not fan width.** This is a defect in the corpus
data / `score.mjs` contract, both owned by a sibling track, not something
fixed in this change — flagging it here rather than either spending past it
silently or patching sibling-owned matching logic without their sign-off.
Until it is fixed (either the corpus's truth entries gain `id`/`target`, or
`score.mjs`'s matcher is given a fallback for entries that carry `evidence`
instead), a real `eval-sweep-stage2` run is not recommended even once the
quota recovers.

**2026-08-20 — OAuth-credentialed probe, one real call, still HTTP 429.**
With `dist/` rebuilt from the ported `src/review/settings.ts` (see the
credential-shape entry above) and `--credential oauth` supplied, a real
probe call ran and reported `credential=subscription-oauth` in its own
output — the first call this harness made that is _verified_, not assumed,
to have gone over the subscription-OAuth path. Result: six retries on the
existing 15/30/45/60/75s backoff ladder, ~229s total, HTTP 429 throughout
with `{"type":"rate_limit_error","message":"Error"}` and a real
`request_id` each time. This was a single call, so concurrency was not a
factor at all. **Conclusion: the subscription quota, not the harness, is
the current binding constraint on running this eval.** No stage-2 spend was
attempted, per the standing rule (probe fails → stop).

**2026-08-20 — two traps found getting to that verified probe, recorded so
the next person doesn't spend the same time on them:**

1. `eval-sweep-probe`'s declared command predated the `--spend` credential
   guard (added in a later turn) and carried no `--credential` flag at all.
   The guard refuses any `--spend` with no `--credential` given, so the
   step was refusing _unconditionally_, before attempting any call,
   regardless of what was actually eligible — a red result that looked like
   the quota wall but was actually a stale declaration. Fixed by declaring
   `--credential oauth` explicitly on the step, matching
   `eval-sweep-smoke`/`eval-sweep-stage2`.
2. **Green gates do not imply a current `dist/`.** `run_gates` never
   rebuilds `dist/`; only `prepare_repository`'s `build` bootstrap step
   does, and this file imports compiled `dist/review/*`, not `src/`. A
   `--spend` run against a stale `dist/` measures old compiled behaviour
   while its results file records the _current_ branch's sha — false
   provenance, discovered here as a `TypeError` when `dist/` still
   predated the OAuth port. `sweep.mjs` now refuses `--spend` (and
   `--probe --spend`) outright if any file under `src/` is newer than the
   oldest file under `dist/`, naming the mtime finding and the remedy
   (`prepare_repository`, or the `build` step) rather than running against
   an unknown build — see `checkBuildFreshness` and the `buildFreshness`
   field now recorded in every results file's provenance.
