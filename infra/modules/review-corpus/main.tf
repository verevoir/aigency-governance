locals {
  corpus_bucket = "${var.name_prefix}-corpus-${var.project_id}"

  state_bucket = "${var.name_prefix}-tfstate-${var.project_id}"

  pool_id = var.pool_suffix == "" ? "${var.name_prefix}-github" : "${var.name_prefix}-github-${var.pool_suffix}"
}

# Only the APIs this module needs, and none at all when manage_apis is false
# (a shared project owns its APIs). A teardown never switches an API off, nor
# anything that depends on one.
resource "google_project_service" "apis" {
  for_each = var.manage_apis ? toset([
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "sts.googleapis.com",
    "cloudresourcemanager.googleapis.com",
    "storage.googleapis.com",
  ]) : toset([])

  project                    = var.project_id
  service                    = each.value
  disable_on_destroy         = false
  disable_dependent_services = false
}

# The practices corpus, published by the corpus repository's CI.
resource "google_storage_bucket" "corpus" {
  #checkov:skip=CKV_GCP_62:No log bucket in this module; a log bucket is new cost and scope, left for the operator's decision. The alternative is GCP Cloud Audit Logs (Admin Activity logs are on and Data Access logs for Cloud Storage are off by default, from memory of GCP's documentation and unverified here; Data Access is a project setting this module does not manage).
  name                        = local.corpus_bucket
  project                     = var.project_id
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false

  versioning {
    enabled = true
  }

  lifecycle_rule {
    condition {
      days_since_noncurrent_time = var.noncurrent_retention_days
    }
    action {
      type = "Delete"
    }
  }

  depends_on = [google_project_service.apis]
}

# Remote state for this installation. It outlives a teardown on purpose.
resource "google_storage_bucket" "state" {
  #checkov:skip=CKV_GCP_62:No log bucket in this module; a log bucket is new cost and scope, left for the operator's decision. The alternative is GCP Cloud Audit Logs (Admin Activity logs are on and Data Access logs for Cloud Storage are off by default, from memory of GCP's documentation and unverified here; Data Access is a project setting this module does not manage).
  name                        = local.state_bucket
  project                     = var.project_id
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false

  versioning {
    enabled = true
  }

  lifecycle {
    prevent_destroy = true
  }

  depends_on = [google_project_service.apis]
}
