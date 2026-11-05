# aigency-governance

The review, as one reusable GitHub workflow. It runs the published
`@verevoir/review` panel (`aigency-review`) over a pull request's diff, with
the lenses derived from the practices in `verevoir/aigency-guardrails`. Nothing
that consumes the review holds a copy of the runner or the lens set.

## Add the review to a repository

One file, and that is the whole of it.

`.github/workflows/review.yml`:

```yaml
name: review
on: pull_request
jobs:
  review:
    permissions:
      contents: read
      checks: read
    uses: verevoir/aigency-governance/.github/workflows/review.yml@<commit-sha> # <tag or date>
    secrets:
      anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
      guardrails-app-private-key: ${{ secrets.GUARDRAILS_APP_PRIVATE_KEY }}
```

Callers should pin this workflow by commit SHA, as above, not a branch. That
pin also fixes the reviewer version, so keep it current: bump the SHA when this
repository changes the reviewer pin or the workflow. The existing callers still
use `@main` until their pin PRs land.

### What the workflow does, and its interface

- **The reviewer is pinned and installed from npm.** The workflow installs the
  published `@verevoir/review` at one exact version, declared once in
  `review.yml` (`REVIEWER_PACKAGE`; transitive dependencies are pinned from
  `@verevoir/review` 0.3.2, which bundles them), into the runner's temporary directory,
  outside your repository, with `--ignore-scripts`, and runs it there. It is
  not built from this repository. Your pull request's tree is only read, as the
  diff and as `--context-root` files; nothing in it is installed or run.
  Callers should pin this workflow by SHA, so that pin pins the reviewer
  version too.
- **The lenses come from the practices corpus.** `verevoir/aigency-guardrails`
  is checked out at `guardrails-ref` (default `main`) and the lenses are
  derived from `corpus/practices`. The job summary records the reviewer version
  and the corpus commit the verdict was judged against.
- **The job** has `timeout-minutes: 20` and permissions of exactly
  `contents: read` and `checks: read`. Nothing is written to your repository.

| Kind   | Name                         | Required           | Meaning                                                                                                                                                                                                                                                              |
| ------ | ---------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| secret | `anthropic-api-key`          | **yes**            | The key the panel calls a model with, once per lens.                                                                                                                                                                                                                 |
| secret | `guardrails-app-private-key` | **yes, in effect** | The private key of the GitHub App that reads the private `verevoir/aigency-guardrails` corpus. Declared optional so that a missing key fails the first step by name; a missing required secret would be a startup failure and the check would silently never appear. |
| secret | `governance-token`           | no                 | **No longer used.** Accepted only so a caller that still passes it gets a named failure (the missing `guardrails-app-private-key`) rather than a startup failure.                                                                                                    |
| input  | `guardrails-app-client-id`   | no                 | Client ID of the GitHub App. Not sensitive. Default `Iv23lid18mHn32QW1lbL`; leave it alone.                                                                                                                                                                          |
| input  | `guardrails-ref`             | no                 | Revision of `aigency-guardrails` the lenses are derived from. Default `main`.                                                                                                                                                                                        |
| input  | `model`                      | no                 | Overrides the pinned judge. Blank means the reviewer's own default.                                                                                                                                                                                                  |
| input  | `governance-ref`             | no                 | **Accepted but unused.** Kept so callers that still pass it keep working; it no longer selects anything.                                                                                                                                                             |

**Every caller's job must grant `contents: read` and `checks: read`**, as the
example above does. A called workflow cannot exceed its caller's grant, and
`review.yml` needs `checks: read` to list the pull request's other checks. If
the calling job grants less (and the repository default is the restricted
`read`, which does not include `checks`), the run fails at startup with no jobs,
and the check silently does not appear.

**`aigency-guardrails` is private, so the workflow reads it with a GitHub App
token, not a personal access token.** The App is installed only on
`verevoir/aigency-guardrails`, with `Contents` read-only. At the start of each
run the workflow mints a token from the App's private key (`guardrails-app-private-key`)
and uses it for the corpus checkout alone: the token can read
`aigency-guardrails` and nothing else, it is created for that run, and it is
revoked when the job ends. It is not persisted into the checkout's git config,
and no other step receives it. The default `GITHUB_TOKEN` cannot read the
corpus, because it is scoped to your repository alone.

**`GUARDRAILS_APP_PRIVATE_KEY` is a long-lived credential.** It is the
private key of the verevoir `guardrails-reader` App, and a copy sits in every
caller that stores it. What changed from the personal access token is what a
leak grants: only tokens that can read `aigency-guardrails`, each created per
run and revoked at job end, instead of a PAT's wider reach. There is no
long-lived personal access token, but there is one long-lived App key, scoped
by the App's installation to reading one repository.

### Rotating the App key

1. Generate a new private key on the App.
2. Update `GUARDRAILS_APP_PRIVATE_KEY` in every caller: repository secrets for
   private repositories, and the organization secret for public ones.
3. Confirm one caller's review run passes.
4. Delete the old key on the App.

**On a suspected leak,** delete the key on the App first, which revokes it at
once, then rotate as above. Reviews fail fast, naming the key, until callers
have the new one.

**Migration.** A caller that bumps its pin to this commit swaps
`governance-token` for `guardrails-app-private-key` in the same change, as the
example above shows. A caller still on an earlier SHA keeps using its
`GOVERNANCE_TOKEN` until it bumps. Once a caller is on this commit it can
delete `GOVERNANCE_TOKEN`.

**The workflow's own input is `guardrails-app-private-key` — that name is
fixed. The name of the secret behind it, on the right of `secrets.`, is not.**
Nothing downstream ever reads the secret's own name, only its value, so your
repository may call it anything, as long as it is mapped to
`guardrails-app-private-key` on the left. `GUARDRAILS_APP_PRIVATE_KEY` above is
shown because it is the name callers are told to use — not because that name is
required. A secret referenced by a name that does not exist on your repository
resolves to an empty string; the first step of the job then fails and names
`guardrails-app-private-key`, so a naming mismatch is reported rather than
surfacing later as a generic failure.

Your repository gets no copy of the lens set, the prompts or the runner. The
reviewer arrives at the version this workflow pins, and the bar arrives from the
practices corpus at `guardrails-ref` — which is the point of there being one
home: a fix to the corpus reaches every repository on its next run, rather than
whenever someone remembers to re-vendor it.

Most repositories should leave `guardrails-ref` and `model` alone. Changing
`model` means your repository is judged by a different model from every other
one, which is a bar that has moved without anyone deciding to move it.

### The secrets, and where to put them

**Settings → Secrets and variables → Actions → New repository secret.**

The names below are illustrative; the workflow inputs they satisfy are fixed.

| Name                         | What it is for                                                                                                                                                         |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`          | Satisfies `anthropic-api-key`. The panel calls a model once per lens.                                                                                                  |
| `GUARDRAILS_APP_PRIVATE_KEY` | Satisfies `guardrails-app-private-key`. The private key of the GitHub App that reads `verevoir/aigency-guardrails`, from which each run mints its own read-only token. |

On GitHub Free, organization secrets do not reach private repositories, so a
private caller must set `GUARDRAILS_APP_PRIVATE_KEY` (and `ANTHROPIC_API_KEY`)
as repository secrets. An organization secret does reach public repositories.

If `anthropic-api-key` is missing or blank, the first step of the job fails and
names it. A blank value counts as missing: an unset secret in Actions arrives as
the empty string. A blank `guardrails-app-private-key` fails the same step with
a message naming the secret to map, and saying `governance-token` is no longer
used.

Only two secrets are declared optional in the interface, each for its own
reason. `guardrails-app-private-key` is optional so that a missing key fails
the first step by name: a missing _required_ secret is a startup failure, and
the check then silently never appears. `governance-token` is optional because
it is no longer used, and is accepted only so a caller that still passes it
gets that named failure. `anthropic-api-key` stays `required: true`.

**If minting the token fails,** the `actions/create-github-app-token` step's
own error is shown, and a following step adds one naming
`guardrails-app-private-key` and the App installation. Two shapes to expect:

- **A malformed key.** The secret is set but is not the App's complete private
  key. Check that it is the whole PEM, header and footer lines included, with no
  added quotes or lost line breaks.
- **The App is not installed on `aigency-guardrails`.** The key is fine but the
  App has no installation that includes `verevoir/aigency-guardrails`. Check the
  App's installation, and that it grants `Contents` read-only.

### Trigger and trust

Callers use `on: pull_request`. A fork's pull request gets no secrets, so the
review fails closed and the App key is never spent on an outside diff.

A same-repository pull request is different: the review job holds both secrets
while it checks out that pull request's tree. That is safe only because the tree
is never _executed_ by the job. It is read as the diff and as `--context-root`
files, and nothing in it is installed, built or run.

The risk: a pull request's own caller workflow is what runs, so a
same-repository pull request can edit or repoint its own review.

The mitigation lives outside this repository: the operator's merge automation
enforces it, and nothing in this repository shows or tests it. It does not
auto-merge a pull request that changes `.github/workflows/`, `.github/actions/`
or the other operator-owned files, and it accepts a verdict only from a run that
called this `review.yml` at an allowlisted SHA. A repository without equivalent
checks, for example one that auto-merges on green, does not get this
protection.

The residual: anyone with push access can bypass the gate by hand.

**Governance's own self-review.** `review-pr.yml` calls
`verevoir/aigency-governance/.github/workflows/review.yml@main`, so the review
definition comes from main, so a PR's changes to `review.yml` do not affect its
own review; they take effect from the next PR after merge, and the shape tests
in this repository still check `review.yml` before merge. `review-pr.yml` itself
is read from the PR, like any workflow file, so this guards against accidental
self-review drift, not against a same-repository writer, who can already run
workflows with the repository's secrets. Fork PRs receive no secrets. `@main` is
deliberate here because main is the base; other callers should pin by SHA.
`review-pr.yml` switches to the App key in a follow-up pull request. Until then,
governance's own review fails fast at the first step, naming
`guardrails-app-private-key`.

### The transition

On merge, every caller still on `@main` breaks at once, because `main` then
requires the App key. The order that contains this is manual:

1. `aigency-runtime-v2` pins this workflow by SHA first, with the key mapped,
   and only then does this change merge.
2. `aigency-harness` also calls `@main`, but its review is already failing at
   startup (its job does not grant `checks: read`), so it moves in the
   caller-bump sweep.
3. Governance's own `review-pr.yml` still passes only `governance-token`. It
   switches to the App key in the immediate follow-up pull request.

What a stale caller sees: the `review` check goes red at its first step,
"Confirm the key is available before doing anything expensive", with
`guardrails-app-private-key is empty`, the secret to map, and the note that
`governance-token` is no longer used. It is a named failure, not a startup
failure, so the check still appears. Nothing is reviewed until the caller maps
the key.

## What comes back

The CLI reports one of four outcomes, and its exit code decides the check:

| Outcome          | Heading                       | Exit | What it means                                                                                                                                                                                                                               |
| ---------------- | ----------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| approved         | `## Review: Approved`         | 0    | Every lens that had something in scope reviewed it, and nothing held the change up. Non-blocking findings may still be listed.                                                                                                              |
| nothing in scope | `## Review: Nothing in scope` | 0    | Every lens completed its judgement and found nothing within its own declared dimension (a docs-only diff, say). A completed review, reported under its own heading; the check is green.                                                     |
| rejected         | `## Review: Rejected`         | 1    | At least one lens raised a blocking finding. The report says what.                                                                                                                                                                          |
| could not run    | `## Review: Could not run`    | 1    | The review did not happen: bad arguments, an unreadable corpus, no `lens:` tags, an empty diff, a missing key, and so on. Red **on purpose**: a green badge over a review that never ran is worse than a red one over a review that failed. |

So the check is green for approved and nothing in scope (which now exits 0, not
1), and red for everything else. A lens that did not run is named in the report before any findings, and
it keeps the panel from approving: addressing the findings and not noticing the
gap is the failure that matters.

The CLI appends its report to the job summary itself, and the workflow does not
append it again. When the CLI exits 1, the **Take the verdict** step adds an
annotation to the Checks tab: one saying the review did not approve if the report
heading is `Rejected`; an empty, missing, `Could not run` or unrecognised report
is reported as could-not-run. A green
run emits no annotation, only the job summary. The report is not posted as a
pull request comment, deliberately — that would need `pull-requests: write`
granted by your workflow, and this job reads a contributor-authored diff and a
contributor-authored title.

An empty diff is refused as `Could not run` rather than approved. It usually
means a wiring problem — a diff computed against the wrong base, or a shallow
clone with no merge base — and lenses reviewing nothing would each find nothing
wrong.

### On a fork's pull request

Secrets are not passed to workflows triggered from a fork, so both arrive
blank. The run fails at the very first step in the job — "Confirm the key is
available before doing anything expensive" — which checks `anthropic-api-key`
before any checkout or install runs. The corpus is never fetched and the
reviewer is never installed.

The outcome is right: the run is red, and your key is not spent reviewing a
diff written by someone outside your repository. The message is
`ANTHROPIC_API_KEY is not available to this workflow.`, from the workflow
step's own `::error` lines.

## Running it locally

Run the published CLI against a checkout of the practices corpus. It needs full
history for `--base` (`fetch-depth: 0` in CI; a normal clone locally), and a
`claude` login or an `ANTHROPIC_API_KEY`:

```sh
npx -y -p @verevoir/review@<version> aigency-review \
  --base origin/main \
  --title "what you are reviewing" \
  --practices /path/to/aigency-guardrails/corpus/practices
```

The version to use is `REVIEWER_PACKAGE` in `.github/workflows/review.yml`, the
one place it lives.

The diff can instead come from stdin, as the workflow does it:

```sh
git diff --merge-base origin/main HEAD | npx -y -p @verevoir/review@<version> aigency-review \
  --practices /path/to/aigency-guardrails/corpus/practices \
  --context-root .
```

Other flags the workflow uses: `--description-file <path>` (the PR description),
`--checks-file <path>` (CI check results, shown to the lenses verbatim) and
`--context-root <dir>` (a checked-out tree, so touched files are shown in full;
in CI it is the pull request's merge commit). `--print-lenses` with `--practices` prints the derived lenses and
exits without a model call. `aigency-review --help` lists the rest, and the
`@verevoir/review` README is the reference.

The route is chosen by the environment: `ANTHROPIC_API_KEY` (or
`ANTHROPIC_API_KEY_FILE`) selects the billed API route; with neither set the
CLI uses your logged-in `claude` CLI. GitHub Actions always has the key
configured, so it always uses the billed route.

## Settings

Read by the `aigency-review` CLI, not by this repository:

| Variable                    | Default                                                                                  | Notes                                                                                                                                           |
| --------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`         | — (the `claude` CLI route when unset)                                                    | Selects the billed Anthropic API route. In the workflow it comes from `anthropic-api-key`.                                                      |
| `ANTHROPIC_API_KEY_FILE`    | — (then `$XDG_CONFIG_HOME/verevoir/anthropic.key` or `~/.config/verevoir/anthropic.key`) | A path to read the key from. A path you name that is missing, blank or unreadable blocks the run rather than falling back to the keyless route. |
| `AIGENCY_REVIEW_MODEL`      | the reviewer's own pinned default                                                        | In the workflow, set from the `model` input; blank means the default. The same commit judged by two models is two verdicts.                     |
| `AIGENCY_REVIEW_MAX_TOKENS` | the reviewer's own default                                                               | A value that is present and not a positive whole number is refused, never silently replaced.                                                    |
| `GITHUB_STEP_SUMMARY`       | set by GitHub Actions                                                                    | When set, the CLI appends its report there.                                                                                                     |

## What this is not

It is not a substitute for a human reviewer, and it does not merge anything. It
produces a verdict and a report; what happens next is a decision someone else
makes.
