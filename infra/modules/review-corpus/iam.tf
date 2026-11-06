locals {
  object_prefix  = "projects/_/buckets/${google_storage_bucket.corpus.name}/objects/"
  pool_principal = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}"

  # The whole identity: <repo id>@<ref>|<owner/name>/<workflow path>@<ref>. It is
  # compared as one exact string, so BOTH the repository+ref AND the workflow
  # file must match.
  publisher_identity = "${var.corpus_repo_id}@refs/heads/main|${var.corpus_repo}/${var.publish_workflow_path}@refs/heads/main"
  deployer_identity  = "${var.governance_repo_id}@refs/heads/main|${var.governance_repo}/${var.deploy_workflow_path}@refs/heads/main"
}

# Additive IAM only: every grant here is a single-member resource, so applying
# or destroying this module never removes a grant someone else made.

# --- publisher: writes the corpus bucket, from the corpus repo's main only ---

resource "google_service_account" "publisher" {
  project      = var.project_id
  account_id   = "${var.name_prefix}-publisher"
  display_name = "Corpus publisher"
  description  = "Publishes the practices corpus to its bucket."

  depends_on = [google_project_service.apis]
}

# The publisher can CREATE objects only under corpus/, manifests/ and refs/main,
# and can OVERWRITE (delete) only refs/main. It cannot read, list or delete
# anything else. Both grants are conditional on the object name.
resource "google_storage_bucket_iam_member" "publisher_create" {
  bucket = google_storage_bucket.corpus.name
  role   = "roles/storage.objectCreator"
  member = "serviceAccount:${google_service_account.publisher.email}"

  condition {
    title       = "create-corpus-manifests-ref"
    description = "Create objects under corpus/ and manifests/, and refs/main."
    expression  = "resource.name.startsWith('${local.object_prefix}corpus/') || resource.name.startsWith('${local.object_prefix}manifests/') || resource.name == '${local.object_prefix}refs/main'"
  }
}

resource "google_storage_bucket_iam_member" "publisher_overwrite_ref" {
  bucket = google_storage_bucket.corpus.name
  role   = "roles/storage.objectUser"
  member = "serviceAccount:${google_service_account.publisher.email}"

  condition {
    title       = "overwrite-refs-main-only"
    description = "Overwrite the refs/main pointer, and nothing else."
    expression  = "resource.name == '${local.object_prefix}refs/main'"
  }
}

# Main only, by numeric id, from one workflow file: the principal is the WHOLE
# string <corpus_repo_id>@refs/heads/main|<repo>/<workflow>@refs/heads/main, an
# exact match. A branch such as main-evil, a tag, a re-registered repository
# name, or any OTHER workflow on main has a different repo_id_workflow and
# cannot assume the publisher.
resource "google_service_account_iam_member" "publisher_wif" {
  service_account_id = google_service_account.publisher.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "${local.pool_principal}/attribute.repo_id_workflow/${local.publisher_identity}"
}

# --- reader: reads the corpus bucket, from any repository of the owner id ---

resource "google_service_account" "reader" {
  project      = var.project_id
  account_id   = "${var.name_prefix}-reader"
  display_name = "Corpus reader"
  description  = "Reads the practices corpus for the review."

  depends_on = [google_project_service.apis]
}

resource "google_storage_bucket_iam_member" "reader" {
  bucket = google_storage_bucket.corpus.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.reader.email}"
}

resource "google_service_account_iam_member" "reader_wif" {
  service_account_id = google_service_account.reader.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "${local.pool_principal}/attribute.repository_owner_id/${var.github_owner_id}"
}

# --- deployer: applies this module, from the governance repo's main only ----
# Everything below exists only when create_deployer is true. With it false the
# module makes no project-level grant at all (for a shared project).
#
# WHAT THE DEPLOYER CAN DO, stated plainly (infra/INSTALL.md has the table):
#   - Project level, two PREDEFINED roles that cannot be narrowed to this
#     module's resources: roles/serviceusage.serviceUsageAdmin (enable and
#     disable ANY API in the project) and roles/iam.workloadIdentityPoolAdmin
#     (change ANY identity pool or provider in the project, including this
#     module's provider condition, which is the trust boundary).
#   - Project level, one CUSTOM role (deployer_project): read the project's IAM
#     policy, and create service accounts. Creating a service account is a
#     project-level permission; it cannot be scoped to a name.
#   - Resource level: roles/iam.serviceAccountAdmin on this module's own service
#     accounts only (so it can manage them and change who may impersonate
#     them), and roles/storage.admin on this module's two buckets only.
# It holds no owner, editor, project IAM admin or security admin role, so the
# project's own IAM policy changes only through a local apply by a person. It
# CAN widen access to the module's own resources and rewrite the provider's
# trust condition: that is an accepted residual risk. It is why the shipped
# installation uses a DEDICATED project and why a shared project sets
# create_deployer = false.

resource "google_service_account" "deployer" {
  count = var.create_deployer ? 1 : 0

  project      = var.project_id
  account_id   = "${var.name_prefix}-deployer"
  display_name = "Infrastructure deployer"
  description  = "Applies this module on merge to main."

  depends_on = [google_project_service.apis]
}

resource "google_service_account_iam_member" "deployer_wif" {
  count = var.create_deployer ? 1 : 0

  service_account_id = google_service_account.deployer[0].name
  role               = "roles/iam.workloadIdentityUser"
  member             = "${local.pool_principal}/attribute.repo_id_workflow/${local.deployer_identity}"
}

# Predefined project roles that GCP offers no narrower form of (see above).
resource "google_project_iam_member" "deployer" {
  for_each = var.create_deployer ? toset([
    "roles/serviceusage.serviceUsageAdmin",
    "roles/iam.workloadIdentityPoolAdmin",
  ]) : toset([])

  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.deployer[0].email}"
}

# The two project-level permissions that are not available per resource:
# reading the project IAM policy (so a plan can refresh the project grants it
# cannot change) and creating a service account. It cannot set any policy.
resource "google_project_iam_custom_role" "deployer_project" {
  count = var.create_deployer ? 1 : 0

  project     = var.project_id
  role_id     = "${replace(var.name_prefix, "-", "_")}_deployer_project"
  title       = "Deployer project permissions"
  description = "Read the project IAM policy, and create service accounts. Nothing that sets a policy."

  permissions = [
    "resourcemanager.projects.get",
    "resourcemanager.projects.getIamPolicy",
    "iam.roles.get",
    "iam.serviceAccounts.create",
  ]
}

resource "google_project_iam_member" "deployer_project" {
  count = var.create_deployer ? 1 : 0

  project = var.project_id
  role    = google_project_iam_custom_role.deployer_project[0].name
  member  = "serviceAccount:${google_service_account.deployer[0].email}"
}

# Service account administration on THIS module's accounts only, not
# project-wide: the deployer cannot touch, or impersonate through, any other
# service account in the project. (A service account created later, outside
# this module, is not in this list; adding one is a local apply.)
resource "google_service_account_iam_member" "deployer_sa_admin" {
  for_each = var.create_deployer ? {
    publisher = google_service_account.publisher.name
    reader    = google_service_account.reader.name
    deployer  = google_service_account.deployer[0].name
    planner   = google_service_account.planner[0].name
  } : {}

  service_account_id = each.value
  role               = "roles/iam.serviceAccountAdmin"
  member             = "serviceAccount:${google_service_account.deployer[0].email}"
}

# Bucket-level, not project-level: the deployer administers these two buckets
# (settings, their IAM, and the state objects) and no others. On the corpus
# bucket that includes changing who can read or write the corpus.
resource "google_storage_bucket_iam_member" "deployer" {
  for_each = var.create_deployer ? {
    corpus = google_storage_bucket.corpus.name
    state  = google_storage_bucket.state.name
  } : {}

  bucket = each.value
  role   = "roles/storage.admin"
  member = "serviceAccount:${google_service_account.deployer[0].email}"
}

# --- planner: the READ-ONLY twin of the deployer, for plans and drift checks ---
# Same workflow identity, a different service account: the workflow picks which
# one it authenticates as. It can read what a plan refreshes and nothing else:
# no write to the state bucket (plans run with -lock=false), no grant of any
# kind. It exists so the scheduled drift check never holds write credentials.

resource "google_service_account" "planner" {
  count = var.create_deployer ? 1 : 0

  project      = var.project_id
  account_id   = "${var.name_prefix}-planner"
  display_name = "Infrastructure planner (read-only)"
  description  = "Plans this module and detects drift. Cannot change anything."

  depends_on = [google_project_service.apis]
}

resource "google_service_account_iam_member" "planner_wif" {
  count = var.create_deployer ? 1 : 0

  service_account_id = google_service_account.planner[0].name
  role               = "roles/iam.workloadIdentityUser"
  member             = "${local.pool_principal}/attribute.repo_id_workflow/${local.deployer_identity}"
}

# Project-level, read-only: everything a plan refreshes that is not a bucket.
resource "google_project_iam_custom_role" "planner" {
  count = var.create_deployer ? 1 : 0

  project     = var.project_id
  role_id     = "${replace(var.name_prefix, "-", "_")}_planner"
  title       = "Planner (read-only)"
  description = "Read-only: project IAM policy, service accounts and their policies, identity pools, enabled APIs."

  permissions = [
    "resourcemanager.projects.get",
    "resourcemanager.projects.getIamPolicy",
    "iam.roles.get",
    "iam.serviceAccounts.get",
    "iam.serviceAccounts.getIamPolicy",
    "iam.workloadIdentityPools.get",
    "iam.workloadIdentityPoolProviders.get",
    "serviceusage.services.get",
    "serviceusage.services.list",
  ]
}

resource "google_project_iam_member" "planner" {
  count = var.create_deployer ? 1 : 0

  project = var.project_id
  role    = google_project_iam_custom_role.planner[0].name
  member  = "serviceAccount:${google_service_account.planner[0].email}"
}

# Bucket-level, read-only: the settings and IAM policy of the two buckets.
resource "google_project_iam_custom_role" "planner_bucket" {
  count = var.create_deployer ? 1 : 0

  project     = var.project_id
  role_id     = "${replace(var.name_prefix, "-", "_")}_planner_bucket"
  title       = "Planner bucket read (read-only)"
  description = "Read a bucket's settings and IAM policy. Reads no object."

  permissions = [
    "storage.buckets.get",
    "storage.buckets.getIamPolicy",
  ]
}

resource "google_storage_bucket_iam_member" "planner" {
  for_each = var.create_deployer ? {
    corpus = google_storage_bucket.corpus.name
    state  = google_storage_bucket.state.name
  } : {}

  bucket = each.value
  role   = google_project_iam_custom_role.planner_bucket[0].name
  member = "serviceAccount:${google_service_account.planner[0].email}"
}

# The state objects, read-only: a plan reads state and never locks it.
resource "google_storage_bucket_iam_member" "planner_state_read" {
  count = var.create_deployer ? 1 : 0

  bucket = google_storage_bucket.state.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.planner[0].email}"
}
