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

This requires `CLAUDE_CODE_OAUTH_TOKEN` (or an `ANTHROPIC_API_KEY` — see
`src/review/settings.ts` for the full resolution order) and needs the
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
