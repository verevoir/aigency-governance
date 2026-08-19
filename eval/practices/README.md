# Seed practice corpus

45 practices, drawn from the planning repository at `/Users/adsurg/Projects/EE/aigency`
(read-only source — nothing there was written to). Each practice below states
exactly the file and section it was drawn from, because a practice with no
provenance is the failure this corpus exists to avoid.

Source repository for every citation below: `/Users/adsurg/Projects/EE/aigency`
(the planning repo, NOT `aigency-governance`).

## Schema

Conforms to `Corpus` / `Practice` as defined in `src/practices/provision.ts`:

```ts
export interface Practice {
  readonly id: string;
  readonly title: string;
  readonly body: string;
}
export interface Corpus {
  readonly version: number;
  readonly practices: readonly Practice[];
}
```

`version: 1` is `SUPPORTED_CORPUS_VERSION`. `id`, `title` and `body` must all
be non-empty strings; ids must be unique within the corpus (enforced by
`parseCorpus`).

## Provenance

| id                                             | source file                                                                          | section / ADR paragraph                                                                                                                                      |
| ---------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| adr001-events-published-not-pulled             | decisions/001-the-runtime-owns-the-log-and-publishes-events.md                       | "Decision" — "Events are published outward... Consumers never read the runtime's store."                                                                     |
| adr001-consumer-idempotent                     | decisions/001-...md                                                                  | "Consequences" — "Delivery is at-least-once, so consumers must be idempotent... on (conversationId, sequence)."                                              |
| adr001-contract-additive                       | decisions/001-...md                                                                  | "Consequences" — "Tolerant readers on both sides... a consumer ignores fields it does not know."                                                             |
| adr001-no-shared-package                       | decisions/001-...md                                                                  | "Consequences" — "Wire-level, language-neutral, no shared package."                                                                                          |
| adr002-envelope-is-reference                   | decisions/002-inbound-packages-name-work-they-do-not-carry-it.md                     | "Decision" — "An inbound package is a reference to work, plus enough to be idempotent. It is never the work itself."                                         |
| adr002-unknown-envelope-fails-loud             | decisions/002-...md                                                                  | "An unrecognised envelope fails loudly"                                                                                                                      |
| adr003-verdict-from-system-not-model           | decisions/003-verification-is-a-property-of-a-turn-not-a-tool-call.md                | "Decision" — "A turn that changed source state runs the repository's declared gates at outcome time. The system produces the verdict. The model never does." |
| adr003-claimed-verdict-matches-system          | decisions/003-...md                                                                  | The rule table — "a verdict / a different one → refused — a lie beside the truth"                                                                            |
| adr004-usage-event-fields                      | decisions/004-accounting-is-an-event-metrics-are-a-subscriber.md                     | "Decision" — the field table (model, inputTokens/outputTokens, cacheReadTokens/cacheCreationTokens, port, purpose)                                           |
| adr006-span-shape                              | decisions/006-work-is-spans-and-the-flame-chart-is-a-lens.md                         | "Decision" — "Every span carries three measures: duration, tokens..., and cost."                                                                             |
| adr006-span-rollup                             | decisions/006-...md                                                                  | "Decision" — "A span's totals include its descendants. Roll-up is a fold over the tree."                                                                     |
| adr006-span-three-states                       | decisions/006-...md                                                                  | "During, not only at the end" — "Three states — running, finished, failed — and never two."                                                                  |
| adr006-unparented-span-marked                  | decisions/006-...md                                                                  | "What it costs" — "a span whose parent is unknown is attached to the root and marked, never silently orphaned."                                              |
| adr007-decorator-not-inline                    | decisions/007-cross-cutting-concerns-are-composed-not-written.md                     | "Decision" — "A port is decorated, not instrumented."                                                                                                        |
| adr007-decorator-preserves-outcome             | decisions/007-...md                                                                  | "What must not be hidden" — "A decorator may not change an outcome."                                                                                         |
| adr007-error-mapping-preserves-distinction     | decisions/007-...md                                                                  | "What must not be hidden" — "Error mapping preserves the distinction."                                                                                       |
| adr008-smoke-test-can-fail                     | decisions/008-steel-thread-first-and-canary-before-merge.md                          | "What this requires" — "A smoke test that is honest. It must be able to fail."                                                                               |
| adr009-review-definition-referenced-not-copied | decisions/009-the-review-is-one-definition-with-two-runners.md                       | "The failure this must not reproduce" — referenced via `uses:`, never vendored                                                                               |
| adr009-synthesis-favors-findings               | decisions/009-...md                                                                  | "What both runners must hold" — "Synthesis resolves ambiguity toward MORE findings."                                                                         |
| adr009-three-review-outcomes                   | decisions/009-...md                                                                  | "What both runners must hold" — "Three outcomes, not two (B5)."                                                                                              |
| adr010-conversation-serialized                 | decisions/010-a-conversation-is-an-actor.md                                          | "Decision" — "A conversation is the unit of serialisation and the unit of parallelism."                                                                      |
| adr010-lease-not-lock                          | decisions/010-...md                                                                  | "The mechanism: a lease, not a lock"                                                                                                                         |
| adr011-install-vs-ci                           | decisions/011-dependencies-are-declared-cooled-and-few.md                            | "Decision, in three parts" §1 — "install prepares, ci verifies"                                                                                              |
| adr011-audit-blocks-prepare                    | decisions/011-...md                                                                  | "Decision" §2 — "install → audit... A bad result blocks preparation."                                                                                        |
| adr011-dependency-reason-recorded              | decisions/011-...md                                                                  | "The discipline already in place" — "A runtime dependency is a decision with a name attached and a reason recorded."                                         |
| adr012-cross-repo-dep-pinned-sha               | decisions/012-a-cross-repository-dependency-is-a-pinned-git-install.md               | "Decision" — "pinned to a commit sha... No registry, no npm workspace, no vendored copy."                                                                    |
| adr013-merge-keys-on-declared-gates            | decisions/013-the-merge-bar-is-declared-blocking-gates-and-cost-is-declared-too.md   | "Decision" — "A merge keys on all of a repository's declared blocking gates being green, and nothing else."                                                  |
| adr013-costed-gate-never-implicit              | decisions/013-...md                                                                  | "Decision" — "Cost is declared, and a costed gate is never run implicitly."                                                                                  |
| adr014-worktree-not-clone                      | decisions/014-the-unit-of-parallelism-is-a-worktree-not-a-repository.md              | "Decision" — "The unit of parallel write is a worktree."                                                                                                     |
| adr014-worktree-torn-down                      | decisions/014-...md                                                                  | "What it obliges the belt to grow" — symmetry, "the thing that destroys is easy to omit"                                                                     |
| adr015-mutating-verb-has-observer              | decisions/015-the-belt-can-change-a-repository-but-cannot-observe-it.md              | "Decision, for the replacement"                                                                                                                              |
| adr016-bytes-move-by-reference                 | decisions/016-bytes-must-not-travel-through-the-model.md                             | "Decision" — "Verbs take references wherever a payload can be named instead of carried."                                                                     |
| adr016-command-output-captured                 | decisions/016-...md                                                                  | "Decision" — "every command the belt runs has its output captured and returned."                                                                             |
| adr017-command-declares-dependency             | decisions/017-a-declared-command-cannot-say-what-it-depends-on.md                    | "The decision" — "A command declares what it requires, by name."                                                                                             |
| adr017-gate-precondition-not-self-satisfied    | decisions/017-...md                                                                  | "And the dependency is not satisfied by running it"                                                                                                          |
| adr018-two-build-obligations                   | decisions/018-a-dependency-that-has-never-been-installed-has-never-needed-prepare.md | "The decision" — the two build obligations                                                                                                                   |
| constraint-a1-claimed-subset-obtained          | recon/constraints.md                                                                 | §A "Honesty of the record" — A1                                                                                                                              |
| constraint-b2-empty-vs-missing                 | recon/constraints.md                                                                 | §B "Failure must be distinguishable from silence" — B2                                                                                                       |
| constraint-c1-mutation-proves-behaviour        | recon/constraints.md                                                                 | §C "Verification that actually verifies" — C1                                                                                                                |
| constraint-c4-gates-declared-not-from-claim    | recon/constraints.md                                                                 | §C — C4                                                                                                                                                      |
| constraint-f1-credentials-absence-fails        | recon/constraints.md                                                                 | §F "Credentials and blast radius" — F1                                                                                                                       |
| constraint-f2-no-secret-in-output              | recon/constraints.md                                                                 | §F — F2                                                                                                                                                      |
| wa-stage-by-path                               | design/working-agreement.md                                                          | "The failure modes to watch for in yourself" — "Committing someone else's work under your message."                                                          |
| wa-negative-claims-verified                    | design/working-agreement.md                                                          | "Stage the work, and review each stage" — "Verify every negative claim before acting on it."                                                                 |
| wa-comment-no-false-property                   | design/working-agreement.md                                                          | "Write down why, at the site" — "A comment that claims a property the code does not have is worse than none."                                                |

## What was left out, and why

**Most of `recon/constraints.md` §D, §E, §G, §L and §M were not carried over
as individually-checkable practices.** §D (D1–D3) and most of §M describe
specific historical incidents ("collateral search must find readers of a
field whose meaning changes") that are true and important but read as
narrative post-mortems rather than a rule a reviewer can hold a diff against
without also holding the whole incident in mind. §L is explicitly "not yet
fixed" — open gaps in the belt, not yet a bar anything can be judged against.
§G (economics) beyond G1/G4-adjacent items and §E (scope/budget) beyond the
line-count target are softer, and are called out below.

**ADR 005 (governance is a service from day one)** contributes no practice.
Its content is a single architectural placement decision plus a correction
about a since-retracted claim ("the parity harness... has not been built");
neither is a rule checkable against an arbitrary diff.

## Can this corpus be grown later?

**Yes, mechanically.** `parseCorpus` requires only `version: 1` and a
non-empty `practices` array of `{id, title, body}` objects with unique ids.
Doubling the corpus is a matter of appending entries — no format change,
no version bump needed unless the shape itself changes. Growing it is a
matter of returning to the sources not yet drawn on: §D, §E (beyond the
size target), §G and §M of `recon/constraints.md` all contain real,
under-exploited material, plus the eighteen ADRs already read here have
more per-ADR "what it costs" and "what this does not fix" clauses than were
pulled into checkable rules — those sections were written as honest limits,
not as rules, but several could be rephrased as one. A second pass over the
same eighteen ADRs, taken less conservatively, could plausibly add another
15–20 without leaving the same source set.

## Practices that are not mechanically checkable against a diff

Named explicitly, because these are the ones likely to limit what a lens can
actually do with them — a lens asked to check these against a diff alone,
with no access to runtime behaviour, test runs, or process history, cannot
fully verify them from the diff's text:

- **`adr008-smoke-test-can-fail`** — whether a smoke test "can actually
  fail" is a claim about its runtime behaviour under a broken deployment,
  not something visible from reading the test's source.
- **`adr010-conversation-serialized`** / **`adr010-lease-not-lock`** — both
  are properties of concurrent runtime behaviour (does a second turn for the
  same conversation actually get blocked?), not statically visible in a
  diff to the leasing code.
- **`adr011-audit-blocks-prepare`** — requires observing `prepare_repository`
  actually stop on a bad audit result, not just reading the bootstrap
  declaration.
- **`adr013-costed-gate-never-implicit`** — requires observing `run_gates`'
  actual behaviour when `names` is omitted, not just reading the
  `costed: true` flag in configuration.
- **`adr014-worktree-torn-down`** — a lifecycle property (was the worktree
  actually removed after the stream finished?) with no trace in a single
  diff.
- **`adr015-mutating-verb-has-observer`** — checking this fully requires
  knowing the _entire_ verb inventory, not just the verbs touched by one
  diff; a diff adding one mutating verb cannot show whether an observer was
  ever added anywhere.
- **`constraint-c1-mutation-proves-behaviour`** — the practice is literally
  about a testing _process_ (break it, watch it fail, restore it) rather
  than a static property; a diff can show a test but not that it was
  watched failing.
- **`wa-negative-claims-verified`** — whether a negative claim in a PR
  description or comment was actually checked is a claim about the author's
  process, not something a diff's content proves either way.

These eight remain in the corpus because they are real, well-sourced rules —
but a lens that can only read diff text, with no access to CI history, test
run logs, or runtime traces, will be able to do no better than flag them for
human judgement rather than mechanically confirm or refute them. That gap is
worth knowing going into a width sweep: some findable-in-principle rules are
not findable by a text-only lens no matter how the corpus is partitioned.
