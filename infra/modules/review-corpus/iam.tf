locals {
  object_prefix  = "projects/_/buckets/${google_storage_bucket.corpus.name}/objects/"
  pool_principal = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}"
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

# Main only, by numeric id: the principal is the WHOLE string
# <corpus_repo_id>@refs/heads/main, an exact match. A branch such as main-evil,
# a tag, or a repository that re-registered the old name has a different
# repo_id_ref and cannot assume the publisher.
resource "google_service_account_iam_member" "publisher_wif" {
  service_account_id = google_service_account.publisher.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "${local.pool_principal}/attribute.repo_id_ref/${var.corpus_repo_id}@refs/heads/main"
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
  member             = "${local.pool_principal}/attribute.repo_id_ref/${var.governance_repo_id}@refs/heads/main"
}

# The deployer's roles are listed, with a reason each, in infra/INSTALL.md.
# No owner, no editor, and no role that can grant roles.
resource "google_project_iam_member" "deployer" {
  for_each = var.create_deployer ? toset([
    "roles/serviceusage.serviceUsageAdmin",
    "roles/iam.workloadIdentityPoolAdmin",
    "roles/iam.serviceAccountAdmin",
  ]) : toset([])

  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.deployer[0].email}"
}

# Refreshing the project grants above means reading the project's IAM policy,
# which none of the roles above allows. This role adds that read and nothing else.
resource "google_project_iam_custom_role" "deployer_refresh" {
  count = var.create_deployer ? 1 : 0

  project     = var.project_id
  role_id     = "${replace(var.name_prefix, "-", "_")}_deployer_refresh"
  title       = "Deployer state refresh"
  description = "Read-only: lets the deployer refresh the project IAM grants it manages."

  permissions = [
    "resourcemanager.projects.get",
    "resourcemanager.projects.getIamPolicy",
    "iam.roles.get",
  ]
}

resource "google_project_iam_member" "deployer_refresh" {
  count = var.create_deployer ? 1 : 0

  project = var.project_id
  role    = google_project_iam_custom_role.deployer_refresh[0].name
  member  = "serviceAccount:${google_service_account.deployer[0].email}"
}

# Bucket-level, not project-level: the deployer administers these two buckets
# (settings, their IAM, and the state objects) and no others.
resource "google_storage_bucket_iam_member" "deployer" {
  for_each = var.create_deployer ? {
    corpus = google_storage_bucket.corpus.name
    state  = google_storage_bucket.state.name
  } : {}

  bucket = each.value
  role   = "roles/storage.admin"
  member = "serviceAccount:${google_service_account.deployer[0].email}"
}
