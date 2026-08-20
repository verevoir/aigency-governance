# Seed practice corpus

90 practices, drawn from the planning repository at `/Users/adsurg/Projects/EE/aigency`
(read-only source — nothing there was written to). Each practice below states
exactly the file and section it was drawn from, because a practice with no
provenance is the failure this corpus exists to avoid.

Source repository for every citation below: `/Users/adsurg/Projects/EE/aigency`
(the planning repo, NOT `aigency-governance`).

**History:** the first 45 (rows 1–45 below) landed in PR #7. The next 45
(rows 46–90) were added in a second pass over unused sources, to give a
fan-width sweep enough corpus to test whether the optimal width scales with
corpus size. **Every id from the first 45 is unchanged** — `partition` sorts
by id, so renumbering would have silently changed every lens set at every
width already swept. New ids were added, never renamed.

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

## Provenance — the original 45

| id                                             | source file                                                                          | section / paragraph                                                                                                                                          |
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

## Provenance — the second 45

Sources mined for this pass: `recon/threat-model.md` and `recon/contracts.md`
(previously untouched), `recon/constraints.md` §§B, C, D, E, G, M (previously
only A, B2, C1, C4, F1, F2 were used), `recon/harness-findings-overnight.md`
H39–H93 (previously untouched), and a second, less conservative pass over the
same 18 ADRs' "what it costs" / consequence clauses.

| id                                                       | source file                         | section / quoted line                                                                                                                                                                                                                               |
| -------------------------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| threat-config-fails-closed                               | recon/threat-model.md               | "under a model where projects are competing companies, the unconfigured case must not be a working case" (§ "What isolation would have to mean here", point 4-adjacent discussion, line ~175)                                                       |
| threat-scope-checked-against-caller                      | recon/threat-model.md               | Actor 2 finding — "nothing in the documented contract restricts which absolute path a turn may name" (line ~46)                                                                                                                                     |
| threat-no-cross-tenant-context                           | recon/threat-model.md               | "An agent that holds one project's material while acting on another's has already combined them, whatever the storage does... no technical isolation downstream of the model closes a combination that already happened upstream of it" (line ~100) |
| threat-minimal-command-environment                       | recon/threat-model.md               | "construct a minimal environment from nothing, containing only the allow-listed names and nothing else" (line ~163)                                                                                                                                 |
| threat-scope-checks-are-logged                           | recon/threat-model.md               | "That argues for scoping being enforced _and audited_ — every scope check, and every refusal, landing on the conversation's own log as an event" (line ~237)                                                                                        |
| contracts-no-silent-version-substitution                 | recon/contracts.md                  | §1 route table note — "**400** if `n`... that version has not happened yet, and it must not redirect to the current one... a reader who asked for version 12 and was quietly given version 9 has been told a different thing"                       |
| contracts-fault-names-no-internals                       | recon/contracts.md                  | §1 — "a genuine server fault is **500**, and its body names that something failed without naming anything internal"                                                                                                                                 |
| contracts-argv-is-array-not-shell-string                 | recon/contracts.md                  | §3 "The toolbelt" — "argv is a bounded list, never a shell string"                                                                                                                                                                                  |
| contracts-shim-forwards-verbatim                         | recon/contracts.md                  | §2 "MCP" — "no interpretation of replies. Errors surface verbatim... both are metadata about the call, not readings of the reply"                                                                                                                   |
| constraint-b1-failure-visible-in-conversation            | recon/constraints.md                | §B — B1                                                                                                                                                                                                                                             |
| constraint-b3-empty-deliverable-is-not-success           | recon/constraints.md                | §B — B3                                                                                                                                                                                                                                             |
| constraint-b4-empty-search-states-its-scope              | recon/constraints.md                | §B — B4                                                                                                                                                                                                                                             |
| constraint-b5-unloadable-rubric-is-not-a-rejection       | recon/constraints.md                | §B — B5                                                                                                                                                                                                                                             |
| constraint-c2-reviewer-claims-are-grounded               | recon/constraints.md                | §C — C2                                                                                                                                                                                                                                             |
| constraint-c3-verify-layer-catches-fabrication           | recon/constraints.md                | §C — C3                                                                                                                                                                                                                                             |
| constraint-d1-collateral-follows-meaning-not-contract    | recon/constraints.md                | §D — D1                                                                                                                                                                                                                                             |
| constraint-e-size-flags-a-question-not-a-verdict         | recon/constraints.md                | §E — E5, the "Requirement" blockquote ("Size is a symptom, not the thing being measured... Targets, stated as targets rather than limits")                                                                                                          |
| constraint-g1-cache-hit-is-measured                      | recon/constraints.md                | §G — G1                                                                                                                                                                                                                                             |
| constraint-g4-billing-port-is-announced                  | recon/constraints.md                | §G — G4                                                                                                                                                                                                                                             |
| constraint-m1-edit-not-whole-file-rewrite                | recon/constraints.md                | §M — M1                                                                                                                                                                                                                                             |
| constraint-m2-target-comes-from-the-call                 | recon/constraints.md                | §M — M2                                                                                                                                                                                                                                             |
| h52-bounded-read-needs-a-write-counterpart               | recon/harness-findings-overnight.md | H52                                                                                                                                                                                                                                                 |
| h55-supplied-id-checked-for-collision                    | recon/harness-findings-overnight.md | H55                                                                                                                                                                                                                                                 |
| h61-refusal-states-cause-and-remedy                      | recon/harness-findings-overnight.md | H61 (and H62, the same pattern for `merge_pull_request`)                                                                                                                                                                                            |
| h70-clean-with-upstream-is-not-published                 | recon/harness-findings-overnight.md | H70                                                                                                                                                                                                                                                 |
| h73-destructive-op-names-what-is-at-risk                 | recon/harness-findings-overnight.md | H73                                                                                                                                                                                                                                                 |
| h77-truncation-states-both-sizes                         | recon/harness-findings-overnight.md | H77                                                                                                                                                                                                                                                 |
| h78-partial-commit-names-what-it-left-out                | recon/harness-findings-overnight.md | H78                                                                                                                                                                                                                                                 |
| h79-verify-on-a-clean-prepared-tree                      | recon/harness-findings-overnight.md | H79                                                                                                                                                                                                                                                 |
| h81-outcome-kind-is-visible-not-just-pass-fail           | recon/harness-findings-overnight.md | H81                                                                                                                                                                                                                                                 |
| h83-ambiguous-verdict-is-refused                         | recon/harness-findings-overnight.md | H83                                                                                                                                                                                                                                                 |
| h85-overstated-safeguard-worse-than-understated-progress | recon/harness-findings-overnight.md | H85                                                                                                                                                                                                                                                 |
| h88-limit-states-its-source                              | recon/harness-findings-overnight.md | H88                                                                                                                                                                                                                                                 |
| h90-claim-checked-against-the-system                     | recon/harness-findings-overnight.md | H90                                                                                                                                                                                                                                                 |
| h93-diagnostic-reports-on-success-too                    | recon/harness-findings-overnight.md | H93                                                                                                                                                                                                                                                 |
| h60-guard-refusal-does-not-discard-good-work             | recon/harness-findings-overnight.md | H60                                                                                                                                                                                                                                                 |
| h68-narration-matches-the-actual-artifact                | recon/harness-findings-overnight.md | H68                                                                                                                                                                                                                                                 |
| h84-defect-class-fix-covers-every-instance               | recon/harness-findings-overnight.md | H84                                                                                                                                                                                                                                                 |
| adr001-publication-never-blocks-turn                     | decisions/001-...md                 | "Consequences" — "Publication is optional and failure-tolerant... A consumer that is down, slow or absent must not affect a turn"                                                                                                                   |
| adr002-idempotency-key-survives-redelivery               | decisions/002-...md                 | "Idempotency is the envelope adapter's job" — "Prefer derivation. A key that requires state to enforce is a key that fails when the state is cold."                                                                                                 |
| adr003-changed-state-is-a-successful-write               | decisions/003-...md                 | "What it costs" — "'Changed source state' needs a sharp definition. It is _a write through the belt that succeeded_..."                                                                                                                             |
| adr004-accounting-never-fails-a-turn                     | decisions/004-...md                 | "Consequences" — "Nothing about accounting may fail a turn."                                                                                                                                                                                        |
| adr006-span-recording-never-fails-a-turn                 | decisions/006-...md                 | "What it costs" — "It must be cheap and it must never fail a turn — a span that cannot be recorded is a lost measurement, not a lost turn."                                                                                                         |
| adr007-decorator-order-stated-at-wiring-site             | decisions/007-...md                 | "Decorator order is semantics, not style" — "The wiring site states which was chosen and why"                                                                                                                                                       |
| adr008-additive-during-the-canary-window                 | decisions/008-...md                 | "What this requires" — "Backwards compatibility for the duration of the shift... a change to the published event contract or the HTTP surface must be additive across a release."                                                                   |

## What was left out, and why

**Still left out of both passes:** ADR 005 (a placement decision plus a
retracted-claim correction, neither checkable against a diff); `recon/constraints.md`
§L (explicitly "not yet fixed" — open gaps, not yet a bar); most of §D beyond
D1 (D2/D3 are narrative post-mortems about one specific accident, not
generalisable rules); most of §E beyond the size requirement (E1–E4 are
about turn-budget process, not something visible in a diff); most of §G
beyond G1/G4 (G2/G3 are economic commentary, not checkable rules); most of
§M beyond M1/M2 (M3, M5, M6 are meta/system-level findings about the belt
itself, not rules a diff can be checked against; M4 restates B2 in a
narrower instance and was judged redundant).

**From `recon/threat-model.md`:** most of it is a _risk assessment_, not a
set of rules — worked examples reasoning about actor tiers, what a given
mechanism does and does not close. Five checkable, generalisable rules were
extracted; the rest (the actor-by-actor risk narrative, the specific
recommendation to separate credential scope and filesystem root per project)
is architecture-decision material for `decisions/`, not corpus material.

**From `recon/harness-findings-overnight.md`:** roughly 20 of the 55
findings (H39–H93) were left out, mostly because they describe a specific
tool defect in the _harness itself_ (e.g. H40 "`refresh_repository` is
absent", H49 "nothing closes a pull request", H58 "`read_pull_request`
returns no `labels` field") rather than a checkable property of a _diff_.
These are real and valuable but belong in the harness's own backlog, not in
a corpus a review lens holds a diff against.

**Not used at all, still:** `design/working-agreement.md`'s "What good looks
like" section (qualitative conduct — "diagnosed why it had missed
something" — not mechanically checkable) and its "watching for the wrong
signal" / "declaring quiet" items (too narrow to one tool's behaviour).

## Can this corpus be grown further?

**Yes, and demonstrably rather than just structurally.** The mechanism is
unchanged — `parseCorpus` needs only `version: 1` and unique-id
`{id,title,body}` entries, so appending more is a pure addition. But beyond
that: this pass deliberately stopped at 45 new entries once it reached a
strong, non-redundant set, while holding **more than a dozen further
sourced-but-weaker or more-redundant candidates in reserve** rather than
including them to pad toward a round number — for example `adr008`'s
"abandoned canary cleanup is a scripted action" clause, `adr010`'s
"expiry vs. release are different facts" clause, `adr011`'s "lockfile
explosion must be accounted for in the recorded reason" clause, `adr013`'s
"a mismarked cost flag is a silent bill or a silent gap" clause, and
`adr016`'s "copy a file and compare it byte-for-byte" test description were
all read, judged real, and set aside as close cousins of practices already
included. A third pass could plausibly add another 15–20 from that reserve
plus §D2/D3, §E1–E4 and §G2/G3 of `constraints.md` reworked into more
general (rather than incident-specific) form, and a genuinely fresh source —
`design/stories/*` — was not touched by either pass at all.

## Practices that are not mechanically checkable against a diff

The original eight, unchanged:

- `adr008-smoke-test-can-fail`
- `adr010-conversation-serialized`
- `adr010-lease-not-lock`
- `adr011-audit-blocks-prepare`
- `adr013-costed-gate-never-implicit`
- `adr014-worktree-torn-down`
- `adr015-mutating-verb-has-observer`
- `constraint-c1-mutation-proves-behaviour`
- `wa-negative-claims-verified`

(That is nine listed, not eight — the original report undercounted:
`wa-negative-claims-verified` was already flagged in the Part 2 prose but the
bulleted list itself only carried eight of the nine categories at the time.
Corrected here.)

**Twelve more from this pass**, for the same reason — each requires runtime
observation, whole-codebase inventory knowledge, or knowledge of a process
that happened outside the diff itself, none of which a diff-reading lens can
confirm from the diff's text alone:

- `threat-no-cross-tenant-context` — whether two projects' material actually
  got combined in one prompt is a runtime/process fact, not visible in a
  diff to the assembly code alone.
- `constraint-b1-failure-visible-in-conversation` — requires observing that
  a real failure actually produced a marker in a real conversation.
- `constraint-c2-reviewer-claims-are-grounded` — a claim about _this review's
  own_ process, not a property of the diff being reviewed.
- `constraint-c3-verify-layer-catches-fabrication` — requires observing a
  verify layer's behaviour over an actual fabricated finding, not just
  reading its code.
- `constraint-d1-collateral-follows-meaning-not-contract` — requires knowing
  every reader of a field across the whole codebase, not just the diff.
- `constraint-g1-cache-hit-is-measured` — requires the actual reported
  token split from a real call, not visible in a diff alone.
- `h52-bounded-read-needs-a-write-counterpart` — requires knowing the
  _entire_ verb inventory, the same limitation already named for
  `adr015-mutating-verb-has-observer`.
- `h60-guard-refusal-does-not-discard-good-work` — requires observing a real
  false-positive scenario play out, not visible from reading guard code.
- `h68-narration-matches-the-actual-artifact` — requires comparing a tool
  call's actual runtime narration against its actual runtime output; a diff
  to the tool's code cannot show either.
- `h79-verify-on-a-clean-prepared-tree` — a property of the CI/local
  environment's state, not of the diff.
- `h84-defect-class-fix-covers-every-instance` — requires knowing the whole
  codebase's other instances of a shape, not just the diff that fixed one.
- `h90-claim-checked-against-the-system` — a claim about _this review's own_
  verification process, not a property of the diff.

**Running total: 21 of 90 (≈23%) are not mechanically checkable against a
diff alone**, up from 9 of 45 (20%) before this pass. The ratio rose
slightly rather than staying flat — this pass drew more heavily on
`recon/harness-findings-overnight.md` and `recon/threat-model.md`, both of
which are process-and-runtime-observation-heavy sources by nature (a harness
defect log and a risk assessment), compared to the first pass's heavier
weighting toward ADR "Decision" sections, which state static, structural
rules almost by construction. That correlation — narrative/process sources
yield more unverifiable-from-a-diff practices than decision-record sources
do — is itself worth carrying into how the sweep is read: a wider corpus
built by continuing to mine process logs will likely keep raising this
ratio, which is a real property of the domain, not an artifact of corpus
construction.

## A third axis: `appliesTo` — does this practice govern a diff, or the belt/process?

Added after the 90-practice pass, in response to a real confound: the corpus
was mined from ADRs, constraints, the threat model and harness findings, so
it carries two different kinds of practice side by side. Some state a rule
about **the software product being built** — event contracts, decorator
patterns, span shapes, error mapping, security boundaries, API design — the
kind of thing a lens can hold any code diff against. Others state a rule
about **the belt, the harness tooling, or this project's own working
method** — worktree lifecycle, checkout/commit tool behaviour,
dependency-pinning mechanics for this specific monorepo, git staging
discipline, review-process self-conduct. A lens handed the second kind
against an arbitrary code diff has nothing in the diff to check it against.

At narrow width this barely matters — a process practice is one of roughly
eleven in a slice and gets crowded out by more relevant neighbours. At wide
width, where each lens gets very few practices, a lens that draws mostly or
entirely process practices contributes nothing to judging the diff — the
fan silently loses a member, for a reason that has nothing to do with
attention or the combiner. That is the confound this axis exists to make
visible and filterable.

**Definitions used:**

- `"diff"` — a lens holding an arbitrary code diff (application logic, API
  handlers, tests, config files) could meaningfully judge a change against
  this practice.
- `"process"` — the practice governs the behaviour of the development
  harness/belt itself (its verbs: checkout, commit, refresh, run_gates,
  worktree create/remove, dependency install/audit/build lifecycle), or a
  team/reviewer working discipline not expressed in application code (git
  staging practice, verifying a claim before acting, a review's own
  self-conduct). Note some `process` practices _would_ be diff-checkable
  against a diff to the harness's own source (e.g. a PR implementing a belt
  verb inside `aigency-runtime-v2`) — the tag reflects applicability to a
  **typical, arbitrary** product-code diff, which is what a width sweep's
  subject diffs are expected to be, not an absolute claim that no diff
  could ever exercise it.

This is a judgement call in the same way the mechanically-checkable flag
is — recorded per practice rather than left implicit, so it can be
inspected and disputed practice by practice rather than trusted as a
black-box count.

**Kept strictly distinct from `mechanicallyCheckable`, on purpose.** The two
answer different questions and collapsing them would lose exactly the
distinction that makes each useful:

- A practice can be `appliesTo: "diff"` and still _not_ mechanically
  checkable — e.g. `adr008-smoke-test-can-fail` is squarely about product
  code (a smoke test's honesty) but confirming it needs the test observed
  running against a broken deployment, not just read.
- A practice can be `appliesTo: "process"` and still mechanically
  checkable — e.g. `adr014-worktree-not-clone` is about belt mechanics but
  is a static, readable property (does the code call `git worktree` or
  `git clone`) wherever it does apply.

## The cross-tabulation (90 practices)

|                          | mechanically checkable | not mechanically checkable | total |
| ------------------------ | ---------------------- | -------------------------- | ----- |
| **`appliesTo: diff`**    | 53                     | 7                          | 60    |
| **`appliesTo: process`** | 16                     | 14                         | 30    |
| **total**                | 69                     | 21                         | 90    |

33% of the corpus (30 of 90) is tagged `process`, and it is NOT weighted
toward the second pass — I drafted a first version of this paragraph
claiming it was, checked it against the actual file rather than my
assumption, and it was wrong, so the corrected version stands here instead.
**The original 45 already carried 18 process practices (40% of that batch)**
— mostly the adr011–adr018 "what it costs"/mechanics clauses (dependency
audit, worktree lifecycle, gate preconditions, build obligations), plus
`wa-stage-by-path` and `wa-negative-claims-verified`. **The second pass
added the other 12 (27% of that batch)** — mostly from
`recon/harness-findings-overnight.md` and the review-process items in
`recon/constraints.md` §C (C2, C3). So the process share was already
substantial before this pass, and this pass's own harness-heavy sourcing
actually _diluted_ it slightly (27% of new material vs. 40% of the
original) rather than concentrating it. Growing the corpus further from the
same kind of source
(`recon/harness-findings-overnight.md`'s remaining ~20 unused findings,
`design/stories/*`) will very likely keep raising the process share for the
same structural reason it raised the not-checkable share: harness/process
sources describe belt behaviour and working method almost by definition,
while ADR "Decision" sections and `recon/constraints.md`'s A/B/C/F letters
state product-code rules almost by construction.

## Where the tags live, and a real limitation: `parseCorpus` drops them

Read directly from `src/practices/provision.ts`, `parseCorpus`'s validation
loop returns a **freshly constructed object**, not the raw parsed entry:

```ts
return {
  id,
  title: requireString(fields['title'], `${where}.title`),
  body: requireString(fields['body'], `${where}.body`),
};
```

It reads only `fields['id']`, `fields['title']` and `fields['body']` off
each raw JSON object. Any other key — including `appliesTo` and
`mechanicallyCheckable`, now present on every entry in `practices.json` —
is present in the raw file and **silently absent** from anything obtained
through `parseCorpus`, `provision`, or `enact`. This does not break
validation (unknown keys are simply never read, not rejected), so the file
still parses cleanly and any existing width-partitioning logic built on top
of `parseCorpus`/`provision` is unaffected by the new fields. But **any
code that wants to filter or group by these tags must read `practices.json`
as raw JSON**, not by going through the corpus/practice plumbing this
repository ships — that plumbing is deliberately narrow to the three fields
a prompt actually needs, and the tags were never going to survive it.
Reported rather than assumed, per the instruction — the tags are additive,
safe, and currently inert to everything except a reader of the raw file.

## My reading: should the `process` practices stay in the corpus?

Both real arguments apply, and I don't think they cancel out cleanly —
here is where I land and why.

**For staying:** every one of the 30 is a genuine, sourced practice of this
project, several with strong provenance (they are literally titled after
real incidents — H70, H73, H79). A reviewer whose job actually is to judge
a diff _to the harness itself_ (a PR implementing a belt verb, a PR
changing `aigency.json`'s command declarations) would find a meaningful
fraction of them directly on-topic — `constraint-m2-target-comes-from-the-
call`, `adr017-gate-precondition-not-self-satisfied`, and others are exactly
what such a reviewer should check. Deleting them discards real material for
a reviewer type that may exist later, and does so irreversibly for this
corpus (ids are supposed to be permanent per the id-stability constraint).

**For treating them as noise for this experiment specifically:** the width
sweep's whole premise, as I understand it, is diffs that are representative
of _ordinary product-code review_ — not diffs to the belt's own verb
implementations. Against that population of subject diffs, a `process`
practice does not fail to apply occasionally; it **never** applies, for
every single diff the sweep will ever show it. That is categorically worse
than the `mechanicallyCheckable: false` practices, which at least _try_ to
say something about the diff in front of them (a lens can flag
`adr008-smoke-test-can-fail` for human follow-up even without confirming it
from the diff alone) — a `process` practice handed a product-code diff has
no foothold at all, not even a partial one. At width 45 on a 90-practice
corpus, a lens landing mostly on the `process` third of the corpus is
structurally closer to a lens given nothing to do than one that got unlucky
with irrelevant-but-related material.

**My recommendation:** keep all 90 in `practices.json` (provenance and the
full record stay complete, and nothing about the id-stability constraint is
violated), but **exclude `appliesTo: "process"` from whatever corpus the
width sweep actually partitions**, using the tag now recorded for exactly
that filter. That leaves 60 diff-applicable practices to sweep against —
still comfortably above the 45-practice ceiling that motivated doubling the
corpus in the first place, so the scaling question (does optimal width grow
with corpus size) stays answerable. If it matters to also test the sweep's
sensitivity to exactly the confound you named — does a wide fan degrade
disproportionately when a fixed fraction of the corpus is irrelevant to the
subject diffs — that is a legitimate second sweep to run deliberately, on
the full 90, compared against the clean-60 run; but I would not want that
comparison to happen by accident because nothing filtered the corpus before
the first sweep ran. That decision — clean corpus by default, contaminated
corpus as a deliberate second condition — is yours; I've filtered nothing
myself, only tagged.
