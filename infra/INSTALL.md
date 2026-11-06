# Installing the keyless review corpus

This installs, into a GCP project, everything needed for GitHub Actions to read
a private practices corpus **with no stored secret**: a private bucket for the
corpus, a Workload Identity Federation (WIF) pool that trusts GitHub's OIDC
tokens, four service accounts (publisher, reader, deployer and a read-only
planner), and a bucket for OpenTofu's own state. It is one reusable module, `infra/modules/review-corpus/`, plus one
small root per installation under `infra/installations/`.

It uses **OpenTofu** (`tofu`), not Terraform.

Where a command needs a value, set it once in your shell first. Every command
below then pastes as it stands:

```sh
export PROJECT_ID=my-review-project     # the GCP project (step 2)
export NAME=my-installation             # the new installation's directory name (step 3)
export GOV_REPO=my-org/my-governance    # the repository holding this infra/ directory
export CORPUS_REPO=my-org/my-guardrails # the repository holding the corpus
```

## 1. Prerequisites

- OpenTofu 1.12 or newer: `tofu version`
  (<https://opentofu.org/docs/intro/install/>).
- The `gcloud` CLI, authenticated as someone with the rights listed in step 2
  on the target project:

  ```sh
  gcloud auth login
  gcloud auth application-default login
  ```

- A GitHub organisation (or user) that owns the repositories. Optionally the
  `gh` CLI (`gh auth login`), used in step 6; the same can be done in the web UI.

## 2. Create or choose a project

Create a **dedicated** project: the deployer's reach (section 7) is too broad to
share a project with other workloads. Or, if you accept the residual risk there,
use an existing project and skip to the grants:

```sh
gcloud projects create "$PROJECT_ID"
gcloud billing projects link "$PROJECT_ID" --billing-account=YOUR-BILLING-ACCOUNT-ID
gcloud config set project "$PROJECT_ID"
```

The person running the bootstrap (step 4) needs, on the project, the ability to
enable APIs, create buckets, identity pools and service accounts, and to grant
project roles. `roles/owner` for the bootstrap person is the simple answer; the
deployer service account this installs never gets it.

The module enables only these APIs: `iam`, `iamcredentials`, `sts`,
`cloudresourcemanager` and `storage`. It never disables them. It does not enable
`serviceusage.googleapis.com`, which is on by default in new projects; if yours
has it off, run `gcloud services enable serviceusage.googleapis.com` once.

## 3. Copy the installation to a new name and set its values

```sh
cp -R infra/installations/verevoir "infra/installations/$NAME"
rm -rf "infra/installations/$NAME/.terraform"
```

In `infra/installations/$NAME/main.tf` change, and only change:

| Where                              | Value                                                                                                                               |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `provider "google"`                | `project` and `region`                                                                                                              |
| `module "review_corpus"` arguments | `project_id`, `region`, `github_owner`, `github_owner_id`, `corpus_repo`, `corpus_repo_id`, `governance_repo`, `governance_repo_id` |
| `backend "gcs" {}`                 | nothing: it is partial, the bucket and prefix are passed at init (steps 5 and 6)                                                    |

The three `*_id` values are the **numeric GitHub ids**, as quoted strings. Trust
is pinned on them, not on the names, because a name can be re-registered by
someone else after a rename or deletion and an id cannot. The names are labels
for humans. Look the ids up (replace OWNER and REPO; for a user rather than an
organisation use `users/OWNER`):

```sh
gh api orgs/OWNER --jq .id
gh api repos/OWNER/REPO --jq .id
```

Optional module arguments: `manage_apis` and `create_deployer` (both default
`true`; see "Shared project"), `name_prefix` (default `review`; change it to run a
second installation in the same project), `pool_suffix` (default empty; see
step 8) and `allowed_owner_condition` (optional; the owner-id check
is always applied and a value here is ANDed with it, so it can only narrow
trust). The module itself holds no project- or organisation-specific
value and is not edited.

If you also want the workflow in `.github/workflows/infra.yml` to deploy your
copy, change its two `infra/installations/verevoir` paths to your directory.

## 4. Create the state bucket (once, by an operator)

OpenTofu's state lives in a bucket (remote, with locking), and a bucket cannot
hold the state that creates it, so an operator creates this one bucket by hand,
in the same project, **versioned**, with **uniform bucket-level access** and
public access prevention enforced, and in the same location as the module's
`region`:

```sh
export STATE_BUCKET="review-tfstate-$PROJECT_ID"   # <name_prefix>-tfstate-<project_id>
export REGION=europe-west2                        # the module's region
# A new project has the Storage API off. The module manages it later (step 5).
gcloud services enable storage.googleapis.com --project="$PROJECT_ID"
gcloud storage buckets create "gs://$STATE_BUCKET" --project="$PROJECT_ID" \
  --location="$REGION" --uniform-bucket-level-access --public-access-prevention
gcloud storage buckets update "gs://$STATE_BUCKET" --versioning
gcloud storage buckets describe "gs://$STATE_BUCKET"   # check all three settings
```

The name must be the one the module computes (`<name_prefix>-tfstate-<project_id>`),
because the module manages this same bucket and step 5 imports it.

## 5. Bootstrap: first apply, on remote state

The `backend "gcs" {}` block is partial: pass the bucket and prefix at init.
There is no local state and nothing to migrate.

```sh
cd "infra/installations/$NAME"
export TF_STATE_BUCKET="$STATE_BUCKET" TF_STATE_PREFIX=review-corpus
tofu init -backend-config="bucket=$TF_STATE_BUCKET" -backend-config="prefix=$TF_STATE_PREFIX"
tofu import module.review_corpus.google_storage_bucket.state "$TF_STATE_BUCKET"
tofu plan
tofu apply
```

The import brings the hand-made bucket under the module. In the plan, the state
bucket should show no change; if it does, the bucket was not made as step 4
says, so fix the bucket rather than apply. Review the whole plan, answer `yes`.
Commit the `.terraform.lock.hcl` that `tofu init` wrote through a pull request.
The first apply is local and by a person: it is the only way the project-level
grants, the custom roles and each new service account are made (section 7).

## 6. Put the outputs into repository variables

These are **variables, not secrets**: none of them is sensitive. Read the
outputs:

```sh
tofu output
```

Set them with `gh` (run from the installation directory; each command is
complete as written), or in the web UI under **Settings → Secrets and
variables → Actions → Variables**:

```sh
gh variable set INFRA_WIF_PROVIDER --repo "$GOV_REPO" --body "$(tofu output -raw wif_provider)"
gh variable set INFRA_DEPLOYER_SA  --repo "$GOV_REPO" --body "$(tofu output -raw deployer_sa)"

gh variable set CORPUS_WIF_PROVIDER --repo "$CORPUS_REPO" --body "$(tofu output -raw wif_provider)"
gh variable set CORPUS_PUBLISHER_SA --repo "$CORPUS_REPO" --body "$(tofu output -raw publisher_sa)"
gh variable set CORPUS_BUCKET       --repo "$CORPUS_REPO" --body "$(tofu output -raw corpus_bucket)"
```

| Variable              | Value (output)  | Set on                                               | Used by                                |
| --------------------- | --------------- | ---------------------------------------------------- | -------------------------------------- |
| `INFRA_WIF_PROVIDER`  | `wif_provider`  | the governance repo (`$GOV_REPO`)                    | `infra.yml`, the apply job             |
| `INFRA_DEPLOYER_SA`   | `deployer_sa`   | the governance repo                                  | `infra.yml`, the apply job             |
| `INFRA_PLANNER_SA`    | `planner_sa`    | the governance repo                                  | `infra.yml`, the plan and drift jobs   |
| `TF_STATE_BUCKET`     | `state_bucket`  | the governance repo                                  | `infra.yml`, every job with state      |
| `TF_STATE_PREFIX`     | your prefix     | the governance repo                                  | `infra.yml`, every job with state      |
| `CORPUS_WIF_PROVIDER` | `wif_provider`  | the corpus repo (`$CORPUS_REPO`)                     | the corpus repo's publish workflow     |
| `CORPUS_PUBLISHER_SA` | `publisher_sa`  | the corpus repo                                      | the corpus repo's publish workflow     |
| `CORPUS_BUCKET`       | `corpus_bucket` | the corpus repo, and every repo that runs the review | publish, and the review's corpus fetch |
| `CORPUS_WIF_PROVIDER` | `wif_provider`  | every repo that runs the review (or the org)         | the review workflow (pass B)           |
| `CORPUS_READER_SA`    | `reader_sa`     | every repo that runs the review (or the org)         | the review workflow (pass B)           |

For the review-running repositories:

```sh
gh variable set CORPUS_WIF_PROVIDER --repo OWNER/REPO --body "$(tofu output -raw wif_provider)"
gh variable set CORPUS_READER_SA    --repo OWNER/REPO --body "$(tofu output -raw reader_sa)"
gh variable set CORPUS_BUCKET       --repo OWNER/REPO --body "$(tofu output -raw corpus_bucket)"
```

Organisation variables (`gh variable set ... --org YOUR-ORG --visibility all`)
save repeating this, but on GitHub Free they do not reach private repositories:
set repository variables there.

The governance repository also needs the planner and the remote-state location.
The `infra` workflow **fails**, before it authenticates, if `TF_STATE_BUCKET` or
`TF_STATE_PREFIX` is unset, so it can never apply or plan from empty state:

```sh
gh variable set INFRA_PLANNER_SA --repo "$GOV_REPO" --body "$(tofu output -raw planner_sa)"
gh variable set TF_STATE_BUCKET  --repo "$GOV_REPO" --body "$(tofu output -raw state_bucket)"
gh variable set TF_STATE_PREFIX  --repo "$GOV_REPO" --body "$TF_STATE_PREFIX"
```

Then, in the governance repository, create the environment `infra-apply`
(**Settings → Environments**) and add **required reviewers**. The apply job
waits there, after the plan job has printed the plan. The apply job then plans
again and applies that second plan, so the approval covers the printed plan, not
the second one; if state or `main` changed in between, read the apply job's own
plan output, which is in its log, before approving a long-queued run.

The corpus repository's own CI publishes to the bucket as the publisher
service account; that workflow lives in that repository and uses
`CORPUS_WIF_PROVIDER`, `CORPUS_PUBLISHER_SA` and `CORPUS_BUCKET`.

**The publisher can be assumed only from `refs/heads/main` of the corpus
repository, identified by its numeric id.** A workflow run from any other branch (including a modified
workflow pushed to a branch) cannot authenticate, so it cannot write to the
bucket. The consequence: only `main` of the corpus is served keylessly; a
`guardrails-ref` other than `main` is not available from the bucket (see
"Later").

### Why `main-evil` or a tag cannot match

The provider maps `attribute.repo_id_workflow` to
`assertion.repository_id + '@' + assertion.ref + '|' + assertion.job_workflow_ref`.
The publisher is bound to the principal
`attribute.repo_id_workflow/<corpus_repo_id>@refs/heads/main|<corpus_repo>/<publish_workflow_path>@refs/heads/main`,
and the deployer to
`attribute.repo_id_workflow/<governance_repo_id>@refs/heads/main|<governance_repo>/<deploy_workflow_path>@refs/heads/main`.
The workflow paths default to `.github/workflows/publish-corpus.yml` and
`.github/workflows/infra.yml` (inputs `publish_workflow_path` and
`deploy_workflow_path`). A
principalSet member is an **exact string match**; there is no prefix or wildcard
matching. So a run on `refs/heads/main-evil` presents `<id>@refs/heads/main-evil`,
a tag presents `<id>@refs/tags/...`, and a pull request presents
`<id>@refs/pull/N/merge`: none equals `<id>@refs/heads/main`, so none can assume
the service account. A repository that took over a deleted name has a different
numeric id and fails the same way. The provider additionally rejects any token
whose `repository_owner_id` is not `github_owner_id`.

### Why the workflow file is part of the identity

The repository and ref say where the code came from, not which code ran. Any
workflow file on `main` that requests `id-token: write` could otherwise assume
the publisher or deployer, so one new or edited workflow merged for another
purpose would gain write access to the corpus or to the infrastructure. The OIDC
`job_workflow_ref` claim names the workflow file (and its ref) that is running,
so it is folded into the same exact-match string: only
`publish-corpus.yml` on `main` of the corpus repository can publish, and only
`infra.yml` on `main` of the governance repository can deploy. A different
workflow file, even on `main`, presents a different string and is refused.
Renaming the workflow file means changing the input and re-applying locally.

### What each service account can do in the bucket

| Service account | Bucket permission                                                                                                                                                                                                                                                       |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| reader          | `roles/storage.objectViewer` on the corpus bucket, and nothing else: it cannot create, overwrite or delete.                                                                                                                                                             |
| publisher       | `roles/storage.objectCreator`, conditional: create objects only under `corpus/`, `manifests/` and the object `refs/main`. Plus `roles/storage.objectUser`, conditional: `resource.name` equals exactly the object `refs/main`, so only that pointer can be overwritten. |

Overwriting an object needs delete permission, which is why the second grant
exists and why it is limited to the one object. The publisher therefore cannot
overwrite or delete anything under `corpus/` or `manifests/` (objects are
immutable once written; a republish of the same `<sha>` fails), and cannot read
or list. Publish in this order: `corpus/<sha>/…`, then `manifests/<sha>.json`,
then `refs/main`. Use an upload that does not first read the object (for example
`gcloud storage cp`, or the JSON API with `ifGenerationMatch=0` for new
objects). If a first publish is refused for a read or list the conditions do not
allow, record it: the fallback is `roles/storage.objectAdmin` on the corpus
bucket, a **residual** risk (the publisher, from `main` only, could then rewrite
any corpus object).

### Bucket layout (the contract with the corpus repository)

| Object                 | Contents                                                         |
| ---------------------- | ---------------------------------------------------------------- |
| `corpus/<sha>/…`       | The corpus files of commit `<sha>`, immutable once written.      |
| `manifests/<sha>.json` | The manifest for `<sha>`, **outside** the `corpus/` prefix.      |
| `refs/main`            | The pointer: the `<sha>` that `main` currently is. Written last. |

A reader reads `refs/main`, then `manifests/<sha>.json`, then `corpus/<sha>/…`.
The reader never lists or trusts anything under `corpus/` to decide what is
current.

**`refs/main` has no ordering guard in the bucket.** It is a last-written
pointer, and the publisher's grants cannot tell an older publish from a newer
one. The guard belongs to the corpus repository's publish workflow, which is
part of this contract: it must run under a `concurrency` group with
`cancel-in-progress: false` (so publishes are serialised), and it must write
`refs/main` last, only for the commit that `main` currently is. This module
cannot enforce that; a publish workflow without it can leave readers on an
older sha without anyone noticing.

## 7. From then on, every change deploys on merge

Change anything under `infra/` through a pull request. The `infra` workflow:

- on the pull request runs `tofu fmt -check -recursive`, `tofu init
-backend=false` and `tofu validate`, with **no cloud credentials**;
- on merge to `main` runs a **plan job** as the read-only planner (prints the
  plan), then an **apply job** that waits for the `infra-apply` environment's
  required reviewers, authenticates as the deployer through OIDC, re-plans and
  applies exactly that saved plan. Applies are serialised by a concurrency group;
- every Monday, and on demand, runs a **drift job** as the planner:
  `tofu plan -detailed-exitcode` fails the job when the real estate and the
  code differ (exit 2) or the plan errors (exit 1). It never applies;
- in every job that uses state, fails before authenticating if `TF_STATE_BUCKET`
  or `TF_STATE_PREFIX` is unset.

The deployer and the planner can only be assumed by the `infra.yml` workflow of
`$GOV_REPO` on `refs/heads/main`. Protect `main` accordingly: a merge to it is a
deploy, gated by the `infra-apply` approval.

Changes the deployer cannot make: the module's project-level grants and its
custom roles (it holds no role that sets a project IAM policy), and a service
account that is new (its resource-level administrator grant does not exist
yet). Those need a local `tofu apply` by a person with the bootstrap rights
from step 2.

### The deployer's reach, and the residual risk

The deployer is **not** unable to widen access. It can:

- rewrite the identity provider's trust condition, or any other pool or
  provider in the project (`roles/iam.workloadIdentityPoolAdmin`, project-wide);
- enable or disable any API in the project (`roles/serviceusage.serviceUsageAdmin`,
  project-wide);
- change who can impersonate this module's four service accounts, and so write
  the corpus (`roles/iam.serviceAccountAdmin` on those accounts);
- change who can read or write either bucket, and read or write the state
  (`roles/storage.admin` on those two buckets).

It cannot set the project's own IAM policy and holds no owner, editor, project
IAM admin or security admin role, and it cannot touch service accounts that are
not this module's. The two project-wide roles are **predefined roles that GCP
offers no narrower form of**; they are not scoped by an IAM condition because
this document does not claim support for one that it has not verified. That
is an **accepted residual risk**, and the reason the installation needs a
**dedicated project** (section 2) and the reason a shared project sets
`create_deployer = false`. The mitigation is the control on merge: `main` is
protected and the apply job waits for the `infra-apply` reviewers.

### The deployer's roles

Granted by the module. No `roles/owner`, no `roles/editor`, no project IAM admin.

| Role                                   | Scope                                   | Why                                                                                                                                   |
| -------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `roles/serviceusage.serviceUsageAdmin` | project (not narrowable)                | Manage the five `google_project_service` resources.                                                                                   |
| `roles/iam.workloadIdentityPoolAdmin`  | project (not narrowable)                | Manage the identity pool and its OIDC provider. Can rewrite the trust condition: residual risk above.                                 |
| `roles/iam.serviceAccountAdmin`        | the module's four service accounts only | Manage them and the identity bindings on them. Granted per account, not project-wide.                                                 |
| `roles/storage.admin`                  | the two buckets only                    | Manage each bucket's settings and IAM, and (for the state bucket) read and write the OpenTofu state objects.                          |
| custom `<prefix>_deployer_project`     | project                                 | `resourcemanager.projects.get`, `resourcemanager.projects.getIamPolicy`, `iam.roles.get` (refresh), and `iam.serviceAccounts.create`. |

### The planner's roles (read-only)

The planner is the deployer's read-only twin, used by the plan and drift jobs.
It can write nothing: plans run with `-lock=false`, and it has no grant that
changes anything.

| Role                             | Scope                 | Why                                                                                                  |
| -------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------- |
| custom `<prefix>_planner`        | project               | Read the project IAM policy, service accounts and their policies, pools, providers and enabled APIs. |
| custom `<prefix>_planner_bucket` | the two buckets only  | `storage.buckets.get` and `storage.buckets.getIamPolicy`: a bucket's settings and IAM. No object.    |
| `roles/storage.objectViewer`     | the state bucket only | Read the state objects.                                                                              |

A failed drift job is the alert: GitHub notifies the person who last edited the
schedule, and the run stays red until the code and the estate agree again. Fix
it by applying (merge a change, or a local apply for project-level grants), or
by reverting the out-of-band change.

The permission lists of the three custom roles are written from the GCP
permission names and have not been exercised against a real project: the first
local apply (step 5) is where an invalid name would be reported.

## 8. Teardown

Teardown is deliberately a few explicit steps, because two things protect you
from losing data or reusing a name too soon.

1. **The state bucket has `prevent_destroy`.** `tofu destroy` refuses while the
   state bucket is in the plan. Take it out of state first (the bucket itself is
   kept, and deleted by hand at the end). Run from the installation directory:

   ```sh
   tofu state rm module.review_corpus.google_storage_bucket.state
   ```

2. **The corpus bucket must be empty, with every version.** It is versioned, so
   an ordinary delete leaves noncurrent versions behind and the destroy fails.
   This removes every object version, **and then the bucket itself**; the
   destroy copes with a bucket that is already gone:

   ```sh
   gcloud storage rm --recursive --all-versions "gs://$(tofu output -raw corpus_bucket)"
   ```

3. Destroy the rest:

   ```sh
   tofu destroy
   ```

4. Delete the state bucket when you are sure you want the state gone (keep it
   if you may reinstall into the same project):

   ```sh
   gcloud storage rm --recursive --all-versions "gs://review-tfstate-$PROJECT_ID"
   ```

   Use your `name_prefix` in place of `review` if you changed it.

5. Remove the repository variables from step 6 (`gh variable delete NAME --repo OWNER/REPO`).

### The 30-day WIF soft-delete

GCP does not delete a Workload Identity pool or provider immediately: it is
**soft-deleted for 30 days**, and during that time its id is still taken. A
reinstall with the same pool id fails with "already exists" (or a pool that is
in the deleted state). There are two ways round it:

- **Use a new id (preferred): set `pool_suffix`.** In the installation's
  `module "review_corpus"` block add, for example, `pool_suffix = "r2"`. The
  pool becomes `<name_prefix>-github-r2`, so nothing collides. Use a different
  suffix each time.
- **Or undelete the old pool and import it:** `gcloud iam
workload-identity-pools undelete <pool-id> --location=global`, then
  `tofu import` it. Only worth it if you want the old id back.

## 9. Reinstall

After a teardown, into the same or a new project:

1. Choose a `pool_suffix` you have not used (step 8) and add it to the module
   block. If the state bucket was deleted, create it again (step 4).
2. Repeat steps 4 to 6: create the state bucket if it is gone, `tofu init` with
   the backend config, `tofu import` the state bucket, `tofu apply`, and set the
   variables again. The variables change, because the identity pool name
   changed.
3. Pass B workflows read the new values from the variables; nothing else needs
   editing.
4. Re-run the corpus repository's publish workflow to repopulate the new corpus
   bucket.

If the state bucket survived (you skipped step 8.4), `tofu init` reads the old
state: remove the stale state (`tofu state list`, then `tofu state rm` each
entry) or point `prefix` at a new value so you start clean.

## Shared project

To install into a project that already hosts other workloads, make the module
touch as little as possible:

```hcl
module "review_corpus" {
  source = "../../modules/review-corpus"

  # ... project_id, region, github_owner(_id), corpus_repo(_id), governance_repo(_id) ...

  manage_apis     = false      # no google_project_service at all
  create_deployer = false      # no deployer or planner SA, no custom role, no project-level grants
  name_prefix     = "rvw-corp" # unique in the project: every id carries it
}
```

- `manage_apis = false`: the module enables no API. Enable the five it needs
  yourself, once (`iam`, `iamcredentials`, `sts`, `cloudresourcemanager`,
  `storage`). With `true` it still never disables an API or a dependent
  service, on destroy or otherwise.
- `create_deployer = false`: the module's only grants are bucket-level and
  service-account-level. Nothing is granted at project level. Without a
  deployer there is no deploy-on-merge and no planner: apply by hand
  (steps 4 and 5), and `deployer_sa` and `planner_sa` are null. The drift
  job needs the planner, so it cannot run either.
- All IAM is additive (single-member grants); the module never replaces a
  policy or a role's member list.
- Every id carries `name_prefix` (buckets, pool, provider, service accounts,
  the custom role) and the pool also `pool_suffix`. Choose a prefix no other
  installation or pool in the project uses.

**The deployer's two project-wide roles (service usage admin, workload identity
pool admin) reach every API and every identity pool in the project, and cannot
be narrowed (section 7). The deployer belongs in a DEDICATED project.** In a
shared project, set `create_deployer` false.

## Later

- **Per-branch publishing.** Serve a `guardrails-ref` other than `main` with a
  SEPARATE publisher service account, bound to the corpus repository's branch
  workflows and limited by an IAM condition to its own prefix (for example
  `resource.name.startsWith("projects/_/buckets/BUCKET/objects/branches/")`),
  so branch workflows can never write `refs/main` or the `main` corpus.
