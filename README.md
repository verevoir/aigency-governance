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
      governance-token: ${{ secrets.AIGENCY_GOVERNANCE_TOKEN }}
```

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

| Name                       | What it is for                                                                                                                                                                                                                                                                                 |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`        | The panel calls a model once per lens.                                                                                                                                                                                                                                                         |
| `AIGENCY_GOVERNANCE_TOKEN` | Read access to this repository, which is private. The default `GITHUB_TOKEN` is scoped to _your_ repository and cannot see it, so a run without this fails at the checkout with `Repository not found`. A fine-grained token with `contents: read` on `verevoir/aigency-governance` is enough. |

Forget one and the run names it, says what it is for, and says where it goes —
at the moment it finds it missing, not in a document you have to go and find. It
reports **every** missing setting at once rather than the first, because the
person reading that log does not yet know what else is wrong.

A value that is present and blank counts as missing. That is not pedantry: an
unset secret in Actions arrives as the empty string, and an empty key sent to
the provider comes back as a 401, which would be reported truthfully and
uselessly as "the review could not run: HTTP 401".

## What comes back

Three outcomes. **Two of them are red.**

| Outcome       | Exit | What it means                                                                                                                                                                   |
| ------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| approved      | 0    | Every lens reviewed, and none had a finding.                                                                                                                                    |
| rejected      | 1    | At least one lens found something. The report says what, grouped by lens.                                                                                                       |
| could not run | 1    | The review did not happen. Red **on purpose**: a green badge over a review that never ran is worse than a red one over a review that failed, because nobody investigates green. |

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

```sh
npm install && npm run build
export ANTHROPIC_API_KEY=sk-...
export AIGENCY_REVIEW_LENSES=./review/lenses.json
git diff --merge-base origin/main HEAD | node dist/cli/review.js "what you are reviewing"
```

`AIGENCY_REVIEW_LENSES` matters: without it the source defaults to the published
copy over HTTP, which needs a token, and you get a missing-token report instead
of a review.

### Or a subscription, for free

`CLAUDE_CODE_OAUTH_TOKEN` — the token Claude Code's own runtime already sets,
not an `AIGENCY_...` name of this project's own invention — authenticates
against a subscription rather than a billed key when it is present, instead
of `ANTHROPIC_API_KEY`: same request, same response, same failure shapes (see
`src/review/anthropic.ts`'s own header for why that identity is the whole
safety argument for this), just a different header on the wire. Every real
diagnosis this repository's own history records — a missing key, a token
ceiling, a broken build — was found by running the panel locally against the
exact diff, and API rates are expensive enough to discourage doing that. This
is the cheap version of the same thing.

Working outside Claude Code and want the same thing? Set
`AIGENCY_REVIEW_OAUTH_TOKEN_FILE` to a path holding the token, or place it at
the conventional default path — see the table below. There is no
`AIGENCY_REVIEW_OAUTH_TOKEN` environment variable: the primary source reads
the name a caller already has rather than asking every caller to alias it,
see `src/review/settings.ts`'s file header for why that distinction matters.

When both are set, the OAuth token wins — deterministically, not by accident
of which happened to be checked first (see `src/review/settings.ts`'s file
header for the full argument). CI is not affected by this today:
`CLAUDE_CODE_OAUTH_TOKEN` is not named in any workflow in this repository
right now, so a GitHub Actions run — which starts with none of a
contributor's local environment regardless — does not have it. That is a
fact about this repository's current workflow files, not a property this
code reads, checks or enforces: if a workflow is ever edited to set that
variable, this paragraph would stop being true and nothing here would catch
it. The report a run produces says which one judged it, on its last line:
"via API key" or "via subscription OAuth" — never the credential's value,
only which kind it was.

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

| Variable                      | Default                            | Notes                                                                                                                                                                                                                                                                       |
| ----------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`           | —                                  | Required.                                                                                                                                                                                                                                                                   |
| `AIGENCY_REVIEW_LENSES`       | the published `review/lenses.json` | A URL or a path.                                                                                                                                                                                                                                                            |
| `AIGENCY_REVIEW_LENSES_TOKEN` | `GITHUB_TOKEN`                     | Only needed when the lens set comes from `raw.githubusercontent.com`, which is the published default. Any other `https://` source is fetched anonymously and no token is sent.                                                                                              |
| `AIGENCY_REVIEW_MODEL`        | pinned in `src/review/settings.ts` | Leave it alone unless you know why. The same commit judged by two models is two verdicts.                                                                                                                                                                                   |
| `AIGENCY_REVIEW_MAX_TOKENS`   | 65536                              | A value that is present and not a positive whole number is refused, never silently replaced by this default. Raised from 4096 on direct evidence: this repository's own review check hit the old default on a large diff and lost four of five lenses to a truncated reply. |

The two OAuth settings, kept in a table of their own rather than merged into
the one above: Prettier reformats a GFM table's column widths from its widest
cell, so appending these two — the longest variable names of any row here —
to the table above would force every one of its existing rows' padding to be
rewritten too, a cosmetic change to lines this addition has no other reason to
touch. Confirmed by trying it: `npm run format` rewrote the merged table back
to that fully-realigned form byte for byte. Kept separate, this table's own
width is sized to its own two rows and the other one is untouched.

| Variable                          | Default | Notes                                                                                                                                                                                                                                                                                                           |
| --------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLAUDE_CODE_OAUTH_TOKEN`         | —       | A subscription credential, tried before `ANTHROPIC_API_KEY` — see "Or a subscription, for free" above. Set by Claude Code's own runtime, not by this project; not set by any workflow in this repository today — a fact about the current workflow files, not something this code enforces.                     |
| `AIGENCY_REVIEW_OAUTH_TOKEN_FILE` | —       | A path to read the OAuth token from, tried when the variable above is unset — the option for working outside Claude Code. Falls back further to `$XDG_CONFIG_HOME/verevoir/anthropic-oauth.token` (`~/.config/verevoir/anthropic-oauth.token` when unset), the same shape `ANTHROPIC_API_KEY_FILE` already had. |

A third table, for the same reason as the split above — this one row alone,
so it costs nothing in either neighbour's column widths:

| Variable                                | Default | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AIGENCY_REVIEW_ALLOW_API_KEY_FALLBACK` | `true`  | Set to `false` to refuse falling back to a billed `ANTHROPIC_API_KEY` when the subscription resolves to nothing — the mode every local run through `scripts/review-head.mjs` already uses, so purchased credits are never spent by a laptop run. Not meant to be set by hand for CI, which never sets it and always allows the fallback. Only `true` and `false` are accepted; any other value is refused as invalid, spending nothing. |

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
