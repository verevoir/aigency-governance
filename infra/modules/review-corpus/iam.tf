locals {
  object_prefix  = "projects/_/buckets/${google_storage_bucket.corpus.name}/objects/"
  pool_principal = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}"

  # <repo id>@<ref>|<owner/name>/<workflow path>@<ref>, compared as one exact
  # string, so the repository, the ref AND the workflow file must all match.
  publisher_identity      = "${var.corpus_repo_id}@refs/heads/main|${var.corpus_repo}/${var.publish_workflow_path}@refs/heads/main"
  infra_workflow_identity = "${var.governance_repo_id}@refs/heads/main|${var.governance_repo}/${var.deploy_workflow_path}@refs/heads/main"
  # The deployer's identity also names the GitHub environment, so a token from
  # a job that names none (the planner's) cannot satisfy it.
  deployer_identity = "${local.infra_workflow_identity}|${var.deploy_environment}"
}

# Additive IAM only: every grant is a single-member resource, so applying or
# destroying this module never removes a grant someone else made.

# --- publisher: writes the corpus bucket, from the corpus repo's main only ---

resource "google_service_account" "publisher" {
  project      = var.project_id
  account_id   = "${var.name_prefix}-publisher"
  display_name = "Corpus publisher"
  description  = "Publishes the practices corpus to its bucket."

  depends_on = [google_project_service.apis]
}

# Create only under corpus/, manifests/ and refs/main; overwrite (which needs
# delete) only refs/main. objectUser is understood to carry objects.get (from
# memory of the role's permissions; unverified here), so the publisher can read
# refs/main and nothing else.
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
# Everything from here on exists only when create_deployer is true.
#
# The deployer CAN widen access (full table: infra/INSTALL.md section 7). Two
# project-wide predefined roles, for which no narrower form was VERIFIED (the
# provider schema and GCP docs were not checked; one may exist): workloadIdentityPoolAdmin
# can rewrite the provider's trust condition, and serviceUsageAdmin reaches any
# API. It also administers this module's service accounts and buckets. That is an
# accepted residual risk, which is why the shipped installation uses a DEDICATED
# project and a shared project sets create_deployer = false. It holds no owner,
# editor or project IAM admin role.

resource "google_service_account" "deployer" {
  count = var.create_deployer ? 1 : 0

  project      = var.project_id
  account_id   = "${var.name_prefix}-deployer"
  display_name = "Infrastructure deployer"
  description  = "Applies this module on merge to main, behind the deploy environment."

  depends_on = [google_project_service.apis]
}

resource "google_service_account_iam_member" "deployer_wif" {
  count = var.create_deployer ? 1 : 0

  service_account_id = google_service_account.deployer[0].name
  role               = "roles/iam.workloadIdentityUser"
  member             = "${local.pool_principal}/attribute.repo_id_workflow_env/${local.deployer_identity}"
}

resource "google_project_iam_member" "deployer" {
  for_each = var.create_deployer ? toset([
    "roles/serviceusage.serviceUsageAdmin",
    "roles/iam.workloadIdentityPoolAdmin",
  ]) : toset([])

  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.deployer[0].email}"
}

# Project-level permissions with no per-resource form: read the project IAM
# policy (so a plan can refresh it) and create service accounts. Sets no policy.
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

# Service account administration on THIS module's accounts only. A service
# account created later, outside this module, is not covered.
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

# Bucket-level: these two buckets, including who may read or write the corpus.
resource "google_storage_bucket_iam_member" "deployer" {
  for_each = var.create_deployer ? {
    corpus = google_storage_bucket.corpus.name
    state  = google_storage_bucket.state.name
  } : {}

  bucket = each.value
  role   = "roles/storage.admin"
  member = "serviceAccount:${google_service_account.deployer[0].email}"
}

# --- planner: the read-only twin, for plans and drift checks ----------------
# Bound to the same workflow file but NOT to the environment, so the plan and
# drift jobs never hold write credentials. Plans run with -lock=false, so it
# writes nothing, state included.

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
  member             = "${local.pool_principal}/attribute.repo_id_workflow/${local.infra_workflow_identity}"
}

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
