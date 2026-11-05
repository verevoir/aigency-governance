# aigency-governance

The review, defined once and run two ways (ADR 009). This repository holds the
definition — the lens set — and the runner that reads it. Nothing that consumes
the review holds a copy of either.

## Add the review to a repository

One file, and that is the whole of it.

`.github/workflows/review.yml`:

```yaml
name: review
on: pull_request
jobs:
  review:
    uses: verevoir/aigency-governance/.github/workflows/review.yml@main
    secrets:
      anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
      governance-token: ${{ secrets.GOVERNANCE_TOKEN }}
```

**The workflow's own input is `governance-token` — that name is fixed. The
name of the secret behind it, on the right of `secrets.`, is not.** Nothing
downstream ever reads the secret's own name, only its value, so your
repository may call it anything, as long as it is mapped to
`governance-token` on the left. `GOVERNANCE_TOKEN` above is shown because it
is what the one real consumer that exists (`aigency-runtime-v2`) actually
uses — not because that name is required. This is stated explicitly because
an unmarked example reads as a requirement, and getting it wrong is not
loud: a secret referenced by a name that does not exist on your repository
resolves to an empty string, which still satisfies the reusable workflow's
`required: true`, and the run fails two steps later at the cross-repository
checkout with `Repository not found` — a message that does not point back
at a naming mismatch in your own workflow file.
`design/stories/S01e-name-the-token-what-it-is.md` in
`verevoir/aigency-rebuild` records this exact failure shape once already,
for this same input: a caller referenced a secret that did not exist at
all, and the run failed silently one step downstream rather than naming
the missing secret.

Your repository gets no copy of the lens set, the prompts or the runner. They
arrive fresh on every run, from `main` here — which is the point of there being
one home: a fix to the bar reaches every repository on its next run, rather than
whenever someone remembers to re-vendor it.

Two optional inputs exist and most repositories should leave both alone:
`governance-ref` pins which revision of the reviewer runs, defaulting to `main`
so a fix reaches you without you doing anything, and `model` overrides the
pinned judge. Changing the second means your repository is judged by a different
model from every other one, which is a bar that has moved without anyone
deciding to move it.

### The two secrets, and where to put them

**Settings → Secrets and variables → Actions → New repository secret.**

| Name                | What it is for                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY` | The panel calls a model once per lens.                                                                                                                                                                                                                                                                                                                                                                                                |
| `GOVERNANCE_TOKEN`  | **An illustrative name — the workflow input it satisfies, `governance-token`, is what's fixed; see the note above the first example.** Read access to this repository, which is private. The default `GITHUB_TOKEN` is scoped to _your_ repository and cannot see it, so a run without this fails at the checkout with `Repository not found`. A fine-grained token with `contents: read` on `verevoir/aigency-governance` is enough. |

Forget one and the run names it, says what it is for, and says where it goes —
at the moment it finds it missing, not in a document you have to go and find. It
reports **every** missing setting at once rather than the first, because the
person reading that log does not yet know what else is wrong.

A value that is present and blank counts as missing. That is not pedantry: an
unset secret in Actions arrives as the empty string, and an empty key sent to
the provider comes back as a 401, which would be reported truthfully and
uselessly as "the review could not run: HTTP 401".

## What comes back

Four outcomes. **Three of them are red.**

| Outcome          | Exit | What it means                                                                                                                                                                                                                                                                                                                                    |
| ---------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| approved         | 0    | Every lens that had something in scope reviewed it, and none had a finding.                                                                                                                                                                                                                                                                      |
| rejected         | 1    | At least one lens found something. The report says what, grouped by lens.                                                                                                                                                                                                                                                                        |
| could not run    | 1    | The review did not happen. Red **on purpose**: a green badge over a review that never ran is worse than a red one over a review that failed, because nobody investigates green.                                                                                                                                                                  |
| nothing in scope | 1    | Every declared lens looked at the change and found nothing within its own dimension — a CI-only or docs-only diff, say, reviewed by a lens whose whole mandate is judging tests. A completed review, not a failed one; red by operator policy, not by necessity, because a change nothing evaluated should not read the same as one that passed. |

A single lens can report it had nothing in scope without the whole panel doing
so — the report names it and its reason, above the findings, the same way an
unrun lens is named, but it does not count as incomplete. Only when **every**
declared lens says so does the panel-level outcome become `nothing in scope`
rather than `approved` — see `aggregate` in `src/review/verdict.ts` for the one
line that decision lives on.

The report goes to the job summary, and the verdict also appears on the Checks
tab as an annotation. It is not posted as a pull request comment, deliberately —
that would need `pull-requests: write` granted by your workflow, and this job
reads a contributor-authored diff and a contributor-authored title. Write access
is the last thing that path should have.

An approval emits no annotation — only the job summary. The Checks tab entry
appears when the review does **not** approve, which is deliberate: the workflow
gates it on the review having actually failed, so a run that died before
reviewing does not get annotated as though it had rejected something.

An incomplete review reports the lenses that did **not** run before it reports
any findings, because addressing the findings and not noticing the gap is the
failure that matters.

### On a fork's pull request

Secrets are not passed to workflows triggered from a fork, so **both** arrive
blank. The run fails at the very first step in the job — "Confirm the key is
available before doing anything expensive" — which checks the key,
unconditionally, before either checkout runs. Neither the governance-repo
checkout nor the caller's own checkout is ever attempted.

The outcome is right: the run is red, and your key is not spent reviewing a diff
written by someone outside your repository. The message is not the one you
would expect from the rest of this document, and it is not either of the two
you might guess: it is not `Repository not found` (that checkout never runs),
and it is not the Node-level `ANTHROPIC_API_KEY is not configured` report from
`resolveSettings` (that code never runs either — the check is a shell
condition inside the workflow itself). It is
`ANTHROPIC_API_KEY is not available to this workflow.`, from the workflow
step's own `::error` lines.

## Running it locally

Two routes, selected automatically by whether a billed key is configured —
nobody has to choose. **The default is keyless**, because the operator's
metered `ANTHROPIC_API_KEY` credits are reserved for GitHub Actions, and a
laptop run should never spend against them without being asked to.

### Keyless (the default) — through your own `claude` CLI subscription

```sh
npm install && npm run build
export AIGENCY_REVIEW_LENSES=./review/lenses.json
git diff --merge-base origin/main HEAD | node dist/cli/review.js "what you are reviewing"
```

No `ANTHROPIC_API_KEY` set anywhere (not the environment, not
`ANTHROPIC_API_KEY_FILE`, not the conventional default path) is what selects
this route. It calls `@verevoir/llm/claude-cli`'s `chat()`, which shells out to
your already-logged-in `claude` CLI (`claude setup-token`, or an interactive
login) — the same, single `claude -p` implementation this codebase and
`@verevoir/llm` share; nothing here hand-rolls a second one. It spends nothing
against `ANTHROPIC_API_KEY`, whether or not one happens to be set on your
machine for something else.

**A known, permanent limitation, and the workaround this repository ships for
it — read this before assuming a bare failure means nothing more than "try
again".** `@verevoir/llm`'s `claude-cli` adapter (0.26.0, the version this
repository depends on) reads the CLI's own `stdout` only on a _clean_ exit.
On a non-zero exit it reports only the bare exit code (or terminating
signal) plus `stderr` — and the single most likely first-run failure, `claude
-p` not being logged into any subscription, exits 1 with `stderr` **empty**
and its real reason (`"Not logged in · Please run /login"`) sitting in the
JSON envelope's `result` field on `stdout`, which that adapter never reads on
this path. **The operator has decided this will not be fixed or republished**
— a real, weighed decision about what a publish to `@verevoir/llm` would
carry, not an oversight — so this gap is permanent for the version this
repository depends on, not a stopgap awaiting a patch release.

Because of that, `src/review/claudeCli.ts`'s `augmentBareExit` recognises
exactly that bare, reason-less shape and appends a labelled, best-effort
hint: that the likely cause is not being logged in, and what to run
(`claude setup-token`, or an interactive `claude` login) to fix it. Read the
hint for what it is, stated in its own wording every time it fires: **a
GUESS, not a decoded reason** — this repository cannot recover the true
cause `@verevoir/llm` dropped, only infer the single most likely one, and it
says so rather than presenting an inference as a fact. It touches nothing
other than this one exact failure shape: a message that already carries a
`stderr` reason, or a distinct spawn-level failure (`claude` missing from
`PATH` entirely), is left completely untouched, in its own, already-legible
wording.

**What this can never do, and what to check if a review reads suspiciously
clean:** a `claude` that cannot be reached — not logged in, not installed,
killed by a signal, anything else — always throws, and `runPanel` turns that
throw into `could_not_run` for that lens, exactly as a thrown `anthropic.ts`
failure does. There is no path anywhere in this transport that turns an
unreachable `claude` into an approved, or an empty, review. If a report says
`could_not_run`, read the reason it carries — including the hint above, when
it fires — rather than assuming the change was clean.

**A truncated reply is refused for the same reason, not returned as though it
were finished.** `chat()` reports `stopReason` and token `usage` alongside the
reply text; this route reads both rather than discarding them. When
`stopReason` is `max_tokens` — the CLI's own output-token ceiling cut the
reply off — `claudeCliReviewer` throws (`NoRoomToAnswerError`, naming the
output tokens spent and how much text had arrived) instead of returning the
cut-off text as a finished verdict, and that lens reports `could_not_run` too.
This checks `stopReason` even when SOME text came back, not only when the
reply is empty: a partial VERDICT with a truncated finding list is exactly as
misleading as an empty one, and this route has no confirmed guarantee (unlike
the billed route's own zero-text case) that a ceiling hit always produces
empty content.

### Billed — through the Anthropic API

```sh
npm install && npm run build
export ANTHROPIC_API_KEY=sk-...
export AIGENCY_REVIEW_LENSES=./review/lenses.json
git diff --merge-base origin/main HEAD | node dist/cli/review.js "what you are reviewing"
```

Setting `ANTHROPIC_API_KEY` (directly, via `ANTHROPIC_API_KEY_FILE`, or at the
conventional default path — see the Settings table below) selects this route
instead — the same one GitHub Actions always uses, since it always has the
key configured as a repository secret. Use it locally when you specifically
want to spend against that key, e.g. to compare a `claude -p` verdict against
an API one.

`AIGENCY_REVIEW_LENSES` matters on either route: without it the source
defaults to the published copy over HTTP, which needs a token, and you get a
missing-token report instead of a review.

Run `npm run build` after changing anything under `src/`. The `cli` gate covers
less than its name suggests: it starts the emitted binary, so the CLI boundary
and settings resolution genuinely are exercised — but it stops at the empty-diff
guard. Everything downstream of that guard is invisible to it: `load`, `panel`,
`prompt`, `anthropic`, `parseReply` and `report`. `readers` is only partly
covered — the gate's second scenario drives `keyFileReader()` through
`review.ts`'s real wiring specifically to prove that one path exists, but the
readers that fetch the lens set itself (`httpReader`, `fileReader`,
`lensReaderFor`) are not reached by anything here. A stale build of any of the
fully-uncovered modules passes.

<!--
  A recurring shape, worth being able to find again: prose in this repository
  asserting something the code does not do, or no longer does, once the code
  it described has moved on. Two instances lived in this very file until this
  commit — the fork-PR failure sequence above, and this readers-coverage
  claim. Two more lived elsewhere: a truncation-classification message that
  named one specific cause for three different code paths, and this project's
  own CLI gate once asserting a shebang check it never performed. All four
  were fixed the same way — not by finding new logic, but by making an
  existing sentence true, either by narrowing the claim or by making the code
  do what the claim already said. The defects in this repository are rarely
  in the logic. They are in the sentences describing the logic, once the
  logic has changed and the sentence has not.
-->

## Settings

| Variable                             | Default                                                                                      | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------ | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`                  | — (keyless when unset)                                                                       | Not required. Configured (directly, via `ANTHROPIC_API_KEY_FILE`, or at the default key-file path) selects the billed Anthropic API route; left unset on every source selects the keyless `claude -p` route by default (via `@verevoir/llm/claude-cli`) — see "Running it locally" above for the permanent upstream gap that route works around.                                                                                                                                                                                                                                                          |
| `ANTHROPIC_API_KEY_FILE`             | — (default: `$XDG_CONFIG_HOME/verevoir/anthropic.key` or `~/.config/verevoir/anthropic.key`) | A path to read the billed key from, trimmed of surrounding whitespace. **Naming this variable is itself an act of configuration, so a path that does not exist blocks the run (`invalid`) exactly like a blank or unreadable one — it does not fall through to the conventional default path or to keyless.** Only the _conventional default_ path (below) is allowed to be absent and fall through to keyless, because nobody named it; a path you name yourself being missing, blank, or unreadable are all the same fact: a broken billed setup, never silently mistaken for a deliberate keyless run. |
| `AIGENCY_REVIEW_LENSES`              | the published `review/lenses.json`                                                           | A URL or a path.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `AIGENCY_REVIEW_LENSES_TOKEN`        | `GITHUB_TOKEN`                                                                               | Only needed when the lens set comes from `raw.githubusercontent.com`, which is the published default. Any other `https://` source is fetched anonymously and no token is sent.                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `AIGENCY_REVIEW_MODEL`               | pinned in `src/review/settings.ts`                                                           | Leave it alone unless you know why. The same commit judged by two models is two verdicts.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `AIGENCY_REVIEW_MAX_TOKENS`          | 65536                                                                                        | A value that is present and not a positive whole number is refused, never silently replaced by this default. Raised from 4096 on direct evidence: this repository's own review check hit the old default on a large diff and lost four of five lenses to a truncated reply.                                                                                                                                                                                                                                                                                                                               |
| `AIGENCY_REVIEW_PRACTICES`           | unset                                                                                        | A URL or a path to a practices corpus (see `src/practices/provision.ts` for the shape it must be in). Unset is a legitimate choice, not a fault — unlike the lens set there is no published default, so every lens judges against a plain notice that no practices were supplied. Configured-but-unreadable is a different, red outcome: the whole review fails rather than silently falling back to no bar.                                                                                                                                                                                              |
| `AIGENCY_REVIEW_PRACTICES_MAX_CHARS` | 20000                                                                                        | Bounds the practices text sent to every lens, measured in characters. A value present and not a positive whole number is refused, exactly like `AIGENCY_REVIEW_MAX_TOKENS`. Unmeasured against a real corpus yet — a starting point, not a proven number.                                                                                                                                                                                                                                                                                                                                                 |

## If the diff is empty

The run refuses it rather than approving. An empty diff usually means a wiring
problem — a diff computed against the wrong base, or a shallow clone with no
merge base — and five lenses reviewing nothing would each find nothing wrong.
That is the most likely way this stops working without anybody noticing, so it
is checked rather than trusted.

## What this is not

It is not a substitute for a human reviewer, and it does not merge anything. It
produces a verdict and a report; what happens next is a decision someone else
makes.
