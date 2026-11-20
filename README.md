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
      governance-token: ${{ secrets.GOVERNANCE_TOKEN }}
```

Callers should pin this workflow by commit SHA, as above, not a branch. That
pin also fixes the reviewer version, so keep it current: bump the SHA when this
repository changes the reviewer pin or the workflow. The existing callers still
use `@main` until their pin PRs land.

The caller may trigger it with `on: pull_request` (above) or
`on: pull_request_target`; read
[Triggering it with pull_request_target](#triggering-it-with-pull_request_target)
before choosing the second. Any other event fails the first step, naming the
event it got.

### What the workflow does, and its interface

- **The reviewer is pinned and installed from npm.** The workflow installs the
  published `@verevoir/review` at one exact version, declared once in
  `review.yml` (`REVIEWER_PACKAGE`; transitive dependencies are pinned from
  `@verevoir/review` 0.3.5, which bundles its two runtime dependencies (`@verevoir/llm`, `@anthropic-ai/sdk`)), into the runner's temporary directory,
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
- **It reviews the same commit under either trigger.** Under both
  `pull_request` and `pull_request_target` the tree checked out is GitHub's
  test merge of the pull request into its base (`refs/pull/<number>/merge`),
  the diff is that merge against the base, and the checks listed for the
  reviewer are those on the pull request's head commit. Under `pull_request`
  that is checkout's default, because the event's `github.ref` and
  `github.sha` are the merge ref and its merge commit; under
  `pull_request_target` the workflow names the ref. Both checkouts use
  `fetch-depth: 0`: without full history `origin/<base>` does not exist, and
  step **Work out what changed** fails with `unknown revision`.

| Kind   | Name                   | Required | Meaning                                                                                                                                                                                                                                |
| ------ | ---------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| secret | `anthropic-api-key`    | **yes**  | The key the panel calls a model with, once per lens.                                                                                                                                                                                   |
| secret | `governance-token`     | **yes**  | Reads the private `verevoir/aigency-guardrails` corpus. Must have `contents: read` on it.                                                                                                                                              |
| input  | `guardrails-ref`       | no       | Revision of `aigency-guardrails` the lenses are derived from. Default `main`.                                                                                                                                                          |
| input  | `model`                | no       | Overrides the pinned judge. Blank means the reviewer's own default.                                                                                                                                                                    |
| input  | `governance-ref`       | no       | **Accepted but unused.** Callers that pass it keep working; it selects nothing.                                                                                                                                                        |
| input  | `outside-author-label` | no       | `pull_request_target` only. The label a maintainer adds to run the review for an author who is not `OWNER`, `MEMBER` or `COLLABORATOR`. Default `review:run`; blank admits no outside author. See [Who it runs for](#who-it-runs-for). |

**Every caller's job must grant `contents: read` and `checks: read`**, as the
example above does. A called workflow cannot exceed its caller's grant, and
`review.yml` needs `checks: read` to list the pull request's other checks. If
the calling job grants less (and the repository default is the restricted
`read`, which does not include `checks`), the run fails at startup with no jobs,
and the check silently does not appear.

**`aigency-guardrails` is private, so the token behind `governance-token` needs
`contents: read` on `verevoir/aigency-guardrails`.** A token that can read only
your own repository, including the default `GITHUB_TOKEN`, cannot do this and
fails the corpus checkout with `Repository not found`. **Migration:** existing
callers' `GOVERNANCE_TOKEN` previously needed only read access to this
repository; it now also needs `contents: read` on `aigency-guardrails`.

**The workflow's own input is `governance-token` — that name is fixed. The
name of the secret behind it, on the right of `secrets.`, is not.** Nothing
downstream ever reads the secret's own name, only its value, so your
repository may call it anything, as long as it is mapped to
`governance-token` on the left. `GOVERNANCE_TOKEN` above is shown because it
is the name existing consumers use — not because that name is required.
This is stated explicitly because an unmarked example reads as a requirement,
and getting it wrong is not loud: a secret referenced by a name that does not
exist on your repository resolves to an empty string, which still satisfies the
reusable workflow's `required: true`, and the run fails later at the
cross-repository corpus checkout with `Repository not found` — a message that
does not point back at a naming mismatch in your own workflow file.
`design/stories/S01e-name-the-token-what-it-is.md` in
`verevoir/aigency-rebuild` records this exact failure shape once already,
for this same input: a caller referenced a secret that did not exist at
all, and the run failed silently one step downstream rather than naming
the missing secret.

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

| Name                | What it is for                                                                                                                                                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ANTHROPIC_API_KEY` | Satisfies `anthropic-api-key`. The panel calls a model once per lens.                                                                                                                                                                |
| `GOVERNANCE_TOKEN`  | Satisfies `governance-token`. Required. It reads `verevoir/aigency-guardrails`, which is private, so it must have `contents: read` on that repository. The default `GITHUB_TOKEN` is scoped to _your_ repository and cannot do this. |

On GitHub Free, organization secrets do not reach private repositories, so a
private caller must set `GOVERNANCE_TOKEN` (and `ANTHROPIC_API_KEY`) as
repository secrets.

If `anthropic-api-key` is missing or blank, the step "Confirm the key is
available before doing anything expensive" fails and names it. It runs before
any checkout, install or model call. A blank value counts as missing: an unset secret in Actions arrives as
the empty string, which still satisfies `required: true`. A blank
`governance-token` fails the same step with a message naming the repository
secret to add. An under-scoped one fails later, at the corpus checkout, with
`Repository not found`.

**Governance's own self-review.** `review-pr.yml` calls
`verevoir/aigency-governance/.github/workflows/review.yml@main`, so the review
definition comes from main, so a PR's changes to `review.yml` do not affect its
own review; they take effect from the next PR after merge, and the shape tests
in this repository still check `review.yml` before merge. `review-pr.yml` itself
is read from the PR, like any workflow file, so this guards against accidental
self-review drift, not against a same-repository writer, who can already run
workflows with the repository's secrets. Fork PRs receive no secrets. `@main` is
deliberate here because main is the base; other callers should pin by SHA.

## What comes back

The CLI reports one of four outcomes, and its exit code decides the check:

| Outcome          | Heading                       | Exit | What it means                                                                                                                                                                                                                               |
| ---------------- | ----------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| approved         | `## Review: Approved`         | 0    | Every lens that had something in scope reviewed it, and nothing held the change up. Non-blocking findings may still be listed.                                                                                                              |
| nothing in scope | `## Review: Nothing in scope` | 0    | Every lens completed its judgement and found nothing within its own declared dimension (a docs-only diff, say). A completed review, reported under its own heading; the check is green.                                                     |
| rejected         | `## Review: Rejected`         | 1    | At least one lens raised a blocking finding. The report says what.                                                                                                                                                                          |
| could not run    | `## Review: Could not run`    | 1    | The review did not happen: bad arguments, an unreadable corpus, no `lens:` tags, an empty diff, a missing key, and so on. Red **on purpose**: a green badge over a review that never ran is worse than a red one over a review that failed. |

So the check is green for approved and nothing in scope, and red for everything
else. A lens that did not run is named in the report before any findings, and
it keeps the panel from approving: addressing the findings and not noticing the
gap is the failure that matters.

The CLI appends its report to the job summary itself, and the workflow does not
append it again. The **Review** step also prints the report to the job log,
bracketed by `::stop-commands::<token>` and `::<token>::`, and step **Collect
the other checks** prints the names of the pull request's checks the same way.
A fork's own jobs choose those names. Each token is random and made in its
step (`openssl rand -hex 32`; `openssl` is already on the runner), so neither
the reviewer nor the pull request can know it. Nothing printed between them
(such as `::error::` or `::add-mask::` text the model quotes from the pull
request, or a check named like one) is read as a workflow command. The
reviewer's stderr is written to a file and printed inside the bracket too,
because the runner reads stderr on a separate pipe and a line written there
could otherwise be processed after the resume; it is not part of the report,
so the verdict is unaffected. Commands resume after the reviewer exits,
whatever its exit status. If no token can be made, the step fails by name and
prints nothing it was given.

Stop-commands does not stop problem matchers: the runner passes every line
that is not a workflow command to the registered matchers, which turn a
matching line into an annotation. `actions/setup-node` registers three (owners
`tsc`, `eslint-stylish` and `eslint-compact`), so step **Remove setup-node's
problem matchers** removes them, after the last action and before either
print. When the CLI
exits 1, the **Take the verdict** step adds an
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

This section is about `on: pull_request`. Under `on: pull_request_target` a
fork's pull request does get the secrets, and is reviewed only when its author
is trusted (whoever pushed the commit) or a maintainer adds the opt-in label;
see [Who it runs for](#who-it-runs-for).

Under `pull_request`, secrets are not passed to workflows triggered from a
fork, so both arrive blank. The run fails at the step "Confirm the key is
available before doing anything expensive", which checks `anthropic-api-key`
before any checkout or install runs. Only the event check runs before it. The
corpus is never fetched and the reviewer is never installed.

Under `pull_request` that outcome is right: the run is red, and your key is
not spent reviewing a diff written by someone outside your repository. The message is
`ANTHROPIC_API_KEY is not available to this workflow.`, from the workflow
step's own `::error` lines.

## Triggering it with pull_request_target

```yaml
on:
  pull_request_target:
    types: [opened, synchronize, reopened, labeled]
```

The rest of the caller is the same as the `pull_request` example above. List
`labeled` in `types`: GitHub's default types for this event leave it out, and
without it the opt-in label never starts a run, so an outside author's pull
request can never be reviewed. Use an `anthropic-api-key` with a spend cap set
on the provider's side, so that even a maintainer's mistake has a ceiling.

Under `pull_request_target`, GitHub runs the caller's workflow **as it is on
the base branch**, and passes the caller's secrets **even to a fork's pull
request**. Its `github.ref` and `github.sha` are the base branch tip, not the
pull request. Checking out that default would review the base against itself:
an empty diff, reported as `Could not run`. So under this event the workflow
names the pull request's merge ref explicitly.

### What it protects

- **A pull request cannot edit or skip its own review.** The job definition
  that runs comes from the base branch, so a pull request that edits the
  caller (removes the job, changes the pinned SHA, passes different inputs)
  does not change the review of that pull request. Under `pull_request` the
  caller is read from the pull request itself. This holds in GitHub's
  `pull_request_target` semantics and in your caller's `uses:` pin, not in
  `review.yml`.
- **Fork pull requests can be reviewed.** The secrets reach the job, so a
  fork's change can be reviewed instead of failing for a missing key. Whether
  it is depends on who opened the pull request, not on who pushed to it; see
  [Who it runs for](#who-it-runs-for).
- **The fork's code does not run with those secrets.** This is what makes
  the first two safe, and it is held in `.github/workflows/review.yml`:
  - step **Check out the pull request (pull_request_target)** checks out
    `refs/pull/<number>/merge` with `persist-credentials: false`, so no token
    is left in the checkout's git config;
  - step **Install the reviewer** installs the pinned `@verevoir/review` with
    `working-directory: ${{ runner.temp }}`, `--prefix` in `RUNNER_TEMP` and
    `--ignore-scripts`, so no `package.json`, `.npmrc` or lifecycle script
    from the pull request is read or run;
  - step **Review** runs the reviewer from `RUNNER_TEMP`, with its working
    directory there too. The checkout is passed only as data:
    `--context-root`, and the diff on stdin;
  - the job's `permissions:` are `contents: read` and `checks: read`, so the
    job's `GITHUB_TOKEN` cannot write to your repository;
  - step **Fetch the practices corpus** checks out the bar from
    `verevoir/aigency-guardrails`, not from the pull request, also with
    `persist-credentials: false`.

  `tests/review-workflow.test.ts` ("executes nothing from the checkout",
  "sets persist-credentials: false on every checkout") pins these.

- **The reviewer reads only inside the checkout, and only regular files.**
  The checkout reaches the reviewer as `--context-root`, and the pull request
  chooses the paths read from it: the diff names the changed files, and its
  added lines can cite files and ADRs. The reviewer never follows a symbolic
  link in any component of a path, refuses any path that resolves outside the
  context root, and reads regular files only. So a pull request cannot point
  it at `/proc/self/environ`, or at anything else outside the checkout, by
  naming the path or by committing a symlink to it. These rules are in
  `@verevoir/review` 0.3.5, not in `review.yml`:
  - `dist/context-files.js`: `unsafePathReason` refuses a path that is
    absolute, has a `..` segment or contains a NUL, without touching it;
    `hasSymlinkComponent` lstats each component and refuses the path if any
    is a symlink, even one pointing inside the root; `buildFileContext` then
    refuses a real path outside the root's real path, and reads only a
    regular file of at most 16 KiB.
  - `dist/references.js` (`buildReferences`) imports the same
    `unsafePathReason` and `hasSymlinkComponent` and applies the same root
    check. For a cited path it only stats the file; for an ADR it reads the
    first heading. Its directory listings do not descend into a symlinked
    directory.

  A change to `REVIEWER_PACKAGE` must keep these rules. Check them in the new
  version before moving the pin.

- **It reviews the commit the event is about.** Step **Confirm the merge ref
  is built on this event's head** fails if the merge ref's second parent is
  not the event's head commit, rather than reviewing one commit and reporting
  the verdict against another. GitHub rebuilds that ref asynchronously after
  a push; a `pull_request` run waits for it and a `pull_request_target` run
  does not, so just after a push the ref can still hold the previous head's
  merge. Re-run the check once the pull request shows as mergeable. A pull
  request that conflicts with its base is expected to fail earlier, at step
  **Check out the pull request (pull_request_target)**, with checkout's own
  error, because GitHub builds no merge ref for it.
- **Other events are refused.** Step **Refuse an event this workflow cannot
  review** fails by name on anything but `pull_request` and
  `pull_request_target`.
- **Nothing the pull request or the model controls becomes a workflow
  command or an annotation.** The names of the pull request's checks are
  chosen by whoever wrote its jobs, a fork included, and the reviewer's report
  quotes the pull request. Step **Collect the other checks** prints the check
  names, and step **Review** the report and the reviewer's stderr, between
  `::stop-commands::<token>` and `::<token>::`, each with a fresh token, so no
  workflow command in them runs. Step **Remove setup-node's problem
  matchers** runs before both, so no problem matcher is registered when
  either prints; see [What comes back](#what-comes-back).

### Who it runs for

Under `pull_request_target`, step **Admit the author before spending
anything** runs second, after the event check and before any secret is read,
anything is checked out or the model is called. The review goes ahead only if:

- the pull request's `author_association` is `OWNER`, `MEMBER` or
  `COLLABORATOR`; or
- the event is `labeled`, and the label just added is `outside-author-label`
  (default `review:run`).

Otherwise the run fails with
`review not run: outside author <association>; a maintainer adds label <name> to run it`.
Both fail closed: a blank association counts as an outside author, and a
blank `outside-author-label` means no label admits anyone.

The gate judges the pull request's author, not whoever triggered the event:
`author_association` describes the person who opened the pull request, and the
event's sender is not checked. So spend follows the author's trust. On a
trusted author's pull request every push is reviewed and spends the key,
whoever made it, including anyone the author lets push to the pull request's
head branch (a collaborator on the author's fork, say). See
[The residual risk](#the-residual-risk).

On an outside author's pull request, the label admits one event, not the pull
request. A later push, by the author or anyone else, is a `synchronize` event
and fails the gate again, even with the label
still on the pull request, so a maintainer removes and re-adds it to review
the new head, after reading what changed. The head reviewed is the one at
the moment the label is added: the `labeled` event carries the pull
request's head at that moment, and step **Confirm the merge ref is built on
this event's head** fails if the merge ref is built on any other head. So a
push landing between the maintainer reading the head and adding the label is
reviewed without having been read. A push after the label is added is not
reviewed under that label. On an outside author's pull request, spending
happens only when a maintainer acts. Under `pull_request` this step does not run: there GitHub does not pass the
secrets to a fork's pull request at all.

What the associations mean is GitHub's, not this workflow's. GitHub defines
`MEMBER` as "Author is a member of the organization that owns the
repository" and `COLLABORATOR` as "Author has been invited to collaborate on
the repository". Neither definition names a permission level. It follows
that an organization member with no access to the repository counts as
`MEMBER`, and that a collaborator with the Read role counts as
`COLLABORATOR`. Anyone who can add labels (triage access and above) can
admit a run.

### What it does not protect

Anyone with write access to the repository can push a branch with a workflow
of their own, triggered `on: push`, that reads the same secrets. Nothing in
the review, under either trigger, stops that. `pull_request_target` moves
where the review's definition comes from; it does not narrow who can reach
the secrets.

### The residual risk

The pull request's content (the diff, its title and description, the files
under `--context-root`, the names of its checks) reaches the model as data.
A pull request written to manipulate the model (prompt injection) could sway
the verdict. No step executes that content, so it cannot run code. When the
check names or what the model echoes reach the job log, no workflow command in
them runs and no problem matcher is registered, so they cannot forge an
annotation or mask a value: steps **Collect the other checks** and **Review**
print them inside a `::stop-commands::` bracket, after step **Remove
setup-node's problem matchers**. That last guarantee holds only while no
action runs after the removal step. A setup step added later, or a
`setup-node` version bump that registers a matcher under another owner, needs
the same removal. The verdict is input to a human decision, not a merge.

**Spending the key.** Under `pull_request_target`, GitHub's approval gate for
outside contributors does not apply, and every model call is paid for with
the caller's `anthropic-api-key`. GitHub's
[Enterprise Server 3.12 page on approving workflow runs from public forks](https://docs.github.com/en/enterprise-server@3.12/actions/managing-workflow-runs-and-deployments/managing-workflow-runs/approving-workflow-runs-from-public-forks)
says workflows triggered by `pull_request_target` "will always run,
regardless of approval settings". The current github.com version of that page
does not carry that sentence. Without a gate, anyone could open or push to
a fork's pull request, as often as they like, with a diff and description of
any size, and spend that key. The mitigation is step **Admit the author before
spending anything** (see [Who it runs for](#who-it-runs-for)): an outside
author's pull request is reviewed only on the event of a maintainer adding
the label, once per push. A trusted author's pull request is not gated this
way, whoever pushes to it; see the next paragraph.

**Pushes to a trusted author's pull request spend under the author's trust.**
The gate reads `github.event.pull_request.author_association`, the trust of
whoever opened the pull request, not of whoever triggered the event. On
`synchronize`, a push by anyone the author lets push to the head branch (a
collaborator on the author's fork, say) runs a full review and spends the key
without a maintainer acting. No code from that push runs (see
[What it protects](#what-it-protects)); only cost is at stake. The planned
mitigation, tracked as a follow-up, is to admit `synchronize` only when the
event's sender is the pull request's author, and otherwise to require the
label.

**Every label spends on a trusted author's pull request.** Callers list
`labeled` in their `types` so the opt-in label can start a run. The gate admits
`OWNER`, `MEMBER` and `COLLABORATOR` authors on any action, so every label
added to their pull request, whatever its name, starts a full review and
spends the key. That spend is not gated.

What is left is spend a maintainer chose, at the size of the diff they
admitted; the spend of trusted authors; and the spend of anyone a trusted
author lets push to their pull request's head branch. A spend-capped key
bounds all three.

### Concurrency, if your caller sets it

Under `pull_request_target`, `github.ref` is the base branch, so a
`concurrency` group keyed on `github.ref` would put every open pull request
in one group and cancel reviews of other pull requests. Key it on
`github.event.pull_request.number` instead. `review.yml` itself sets no
concurrency.

### Not yet confirmed by a real run

The workflow's tests are local: text-level checks, plus the gate, the
merge-ref check, the matcher removal and the two stop-commands brackets run
under bash. No real
`pull_request_target` run has been observed yet. In particular, it is not yet
confirmed that:

- the check this produces is attached where branch protection's required
  checks look for it: a `pull_request_target` run's `GITHUB_SHA` is the base
  branch's commit, not the pull request's head;
- the label flow behaves as described on GitHub: a `labeled` event carrying
  the label's name, an outside author's push failing the gate with the label
  still on, and removing and re-adding it starting a fresh run;
- a pull request that conflicts with its base fails at step **Check out the
  pull request (pull_request_target)**, because GitHub builds no merge ref
  for it;
- the runner honours `::stop-commands::` for the check names and the
  reviewer's output as documented, and `::remove-matcher` removes
  setup-node's matchers before those prints.

From 2 December 2026, GitHub plans to block `pull_request_target` workflows
in **public** repositories that have no applicable Actions event policy, so a
public caller needs an event policy that allows `pull_request_target`; private
and internal repositories are not affected
([Securely using pull_request_target](https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target)).

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
