# Installing the keyless review corpus

This installs, into a GCP project, everything needed for GitHub Actions to read
a private practices corpus **with no stored secret**: a private bucket for the
corpus, a Workload Identity Federation (WIF) pool that trusts GitHub's OIDC
tokens, three least-privilege service accounts, and a bucket for OpenTofu's own
state. It is one reusable module, `infra/modules/review-corpus/`, plus one
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

Create one, or use an existing project and skip to the grants:

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

| Where                              | Value                                                                       |
| ---------------------------------- | --------------------------------------------------------------------------- |
| `provider "google"`                | `project` and `region`                                                      |
| `module "review_corpus"` arguments | `project_id`, `region`, `github_owner`, `github_owner_id`, `corpus_repo`, `corpus_repo_id`, `governance_repo`, `governance_repo_id` |
| commented `backend "gcs"`          | `bucket` = `review-tfstate-<project_id>` (or `<name_prefix>-tfstate-<id>`)  |

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

## 4. Bootstrap: first apply, on local state

The state bucket does not exist yet, so the first apply runs with the
`backend "gcs"` block **commented out** (as shipped).

```sh
cd "infra/installations/$NAME"
tofu init
tofu apply
```

Review the plan, answer `yes`. This creates everything, including the state
bucket. Local state is written to `terraform.tfstate` in that directory; it is
git-ignored and must never be committed.

## 5. Move the state into its bucket

Uncomment the `backend "gcs"` block in `main.tf` (remove the leading `# ` from
its four lines, keep the bucket name you set in step 3), then:

```sh
tofu init -migrate-state
```

Answer `yes` to copy the state. Check, then remove the local copy:

```sh
tofu plan
rm -f terraform.tfstate terraform.tfstate.backup
```

`tofu plan` should report no changes. Commit the `.terraform.lock.hcl` that
`tofu init` wrote, and the edited `main.tf`, through a pull request.

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

| Variable            | Value (output)  | Set on                                                    | Used by                                |
| ------------------- | --------------- | --------------------------------------------------------- | -------------------------------------- |
| `INFRA_WIF_PROVIDER`  | `wif_provider`  | the governance repo (`$GOV_REPO`)                         | `infra.yml`, the apply job             |
| `INFRA_DEPLOYER_SA`   | `deployer_sa`   | the governance repo                                       | `infra.yml`, the apply job             |
| `CORPUS_WIF_PROVIDER` | `wif_provider`  | the corpus repo (`$CORPUS_REPO`)                          | the corpus repo's publish workflow     |
| `CORPUS_PUBLISHER_SA` | `publisher_sa`  | the corpus repo                                           | the corpus repo's publish workflow     |
| `CORPUS_BUCKET`       | `corpus_bucket` | the corpus repo, and every repo that runs the review      | publish, and the review's corpus fetch |
| `CORPUS_WIF_PROVIDER` | `wif_provider`  | every repo that runs the review (or the org)              | the review workflow (pass B)           |
| `CORPUS_READER_SA`    | `reader_sa`     | every repo that runs the review (or the org)              | the review workflow (pass B)           |

For the review-running repositories:

```sh
gh variable set CORPUS_WIF_PROVIDER --repo OWNER/REPO --body "$(tofu output -raw wif_provider)"
gh variable set CORPUS_READER_SA    --repo OWNER/REPO --body "$(tofu output -raw reader_sa)"
gh variable set CORPUS_BUCKET       --repo OWNER/REPO --body "$(tofu output -raw corpus_bucket)"
```

Organisation variables (`gh variable set ... --org YOUR-ORG --visibility all`)
save repeating this, but on GitHub Free they do not reach private repositories:
set repository variables there. `state_bucket` is not needed by any workflow.

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

The provider maps `attribute.repo_id_ref` to
`assertion.repository_id + '@' + assertion.ref`. The publisher is bound to the
principal `attribute.repo_id_ref/<corpus_repo_id>@refs/heads/main`, and the
deployer to `attribute.repo_id_ref/<governance_repo_id>@refs/heads/main`. A
principalSet member is an **exact string match**; there is no prefix or wildcard
matching. So a run on `refs/heads/main-evil` presents `<id>@refs/heads/main-evil`,
a tag presents `<id>@refs/tags/...`, and a pull request presents
`<id>@refs/pull/N/merge`: none equals `<id>@refs/heads/main`, so none can assume
the service account. A repository that took over a deleted name has a different
numeric id and fails the same way. The provider additionally rejects any token
whose `repository_owner_id` is not `github_owner_id`.

### What each service account can do in the bucket

| Service account | Bucket permission                                                                                                                                                                 |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| reader          | `roles/storage.objectViewer` on the corpus bucket, and nothing else: it cannot create, overwrite or delete.                                                                       |
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

| Object                 | Contents                                                                  |
| ---------------------- | ------------------------------------------------------------------------- |
| `corpus/<sha>/…`       | The corpus files of commit `<sha>`, immutable once written.               |
| `manifests/<sha>.json` | The manifest for `<sha>`, **outside** the `corpus/` prefix.               |
| `refs/main`            | The pointer: the `<sha>` that `main` currently is. Written last.          |

A reader reads `refs/main`, then `manifests/<sha>.json`, then `corpus/<sha>/…`.
The reader never lists or trusts anything under `corpus/` to decide what is
current.

## 7. From then on, every change deploys on merge

Change anything under `infra/` through a pull request. The `infra` workflow:

- on the pull request runs `tofu fmt -check -recursive`, `tofu init
  -backend=false` and `tofu validate`, with **no cloud credentials**;
- on merge to `main` authenticates as the deployer through OIDC, then runs
  `tofu init` and `tofu apply`. Applies are serialised by a concurrency group.

The deployer can only be assumed by `$GOV_REPO` on `refs/heads/main`. Protect
`main` accordingly: a merge to it is a deploy.

Changes the deployer cannot make (it holds no role that can grant roles): the
module's project-level grants and its custom role. Changing those means a local
`tofu apply` by a person with the bootstrap rights from step 2. This is
deliberate: the deployer cannot widen its own access.

### The deployer's roles

Granted by the module. No `roles/owner`, no `roles/editor`, no role that can
set a project IAM policy.

| Role                                     | Scope                    | Why                                                                                                                        |
| ---------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `roles/serviceusage.serviceUsageAdmin`   | project                  | Manage the five `google_project_service` resources (read and enable the APIs).                                              |
| `roles/iam.workloadIdentityPoolAdmin`    | project                  | Manage the identity pool and its OIDC provider.                                                                            |
| `roles/iam.serviceAccountAdmin`          | project                  | Manage the three service accounts and the identity bindings on them.                                                       |
| `roles/storage.admin`                    | the two buckets only     | Manage each bucket's settings and IAM, and (for the state bucket) read and write the OpenTofu state objects.               |
| custom `<prefix>_deployer_refresh`       | project                  | Read-only: `resourcemanager.projects.get`, `resourcemanager.projects.getIamPolicy`, `iam.roles.get`, so a plan can refresh the project grants it cannot change. |

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
   block. If the state bucket was deleted, the backend block must be commented
   out again for the bootstrap.
2. Repeat steps 4 to 6: `tofu init`, `tofu apply` on local state, uncomment the
   backend, `tofu init -migrate-state`, and set the variables again. The
   variables change, because the identity pool name changed.
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
  create_deployer = false      # no deployer SA, no custom role, no project-level grants
  name_prefix     = "rvw-corp" # unique in the project: every id carries it
}
```

- `manage_apis = false`: the module enables no API. Enable the five it needs
  yourself, once (`iam`, `iamcredentials`, `sts`, `cloudresourcemanager`,
  `storage`). With `true` it still never disables an API or a dependent
  service, on destroy or otherwise.
- `create_deployer = false`: the module's only grants are bucket-level and
  service-account-level. Nothing is granted at project level. Without a
  deployer there is no deploy-on-merge: apply by hand (steps 4 and 5), and
  `deployer_sa` is null.
- All IAM is additive (single-member grants); the module never replaces a
  policy or a role's member list.
- Every id carries `name_prefix` (buckets, pool, provider, service accounts,
  the custom role) and the pool also `pool_suffix`. Choose a prefix no other
  installation or pool in the project uses.

**The deployer's project-level roles (service usage admin, workload identity
pool admin, service account admin) are broad across a project. The deployer
belongs in a DEDICATED project.** In a shared project, leave `create_deployer`
false.

## Later

- **Per-branch publishing.** Serve a `guardrails-ref` other than `main` with a
  SEPARATE publisher service account, bound to the corpus repository's branch
  workflows and limited by an IAM condition to its own prefix (for example
  `resource.name.startsWith("projects/_/buckets/BUCKET/objects/branches/")`),
  so branch workflows can never write `refs/main` or the `main` corpus.
