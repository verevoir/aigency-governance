resource "google_iam_workload_identity_pool" "github" {
  project                   = var.project_id
  workload_identity_pool_id = local.pool_id
  display_name              = "GitHub Actions"
  description               = "Keyless access for GitHub Actions workflows, federated by OIDC."

  depends_on = [google_project_service.apis]
}

resource "google_iam_workload_identity_pool_provider" "github" {
  #checkov:skip=CKV_GCP_125:Owner-wide trust is the operator's deliberate design: the condition pins the numeric repository_owner_id, and any repository of that owner may read the corpus. Narrowing it to named repositories is the operator's decision, not the scanner's.
  project                            = var.project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = local.pool_id
  display_name                       = "GitHub OIDC"

  # repo_id_workflow is <repo id>@<ref>|<workflow ref>; _env adds |<environment>,
  # and has() gives a job with no environment an empty one rather than failing the
  # mapping. See infra/INSTALL.md section 6, "Why `main-evil` or a tag cannot match".
  attribute_mapping = {
    "google.subject"                 = "assertion.sub"
    "attribute.repository"           = "assertion.repository"
    "attribute.repository_owner"     = "assertion.repository_owner"
    "attribute.repository_id"        = "assertion.repository_id"
    "attribute.repository_owner_id"  = "assertion.repository_owner_id"
    "attribute.ref"                  = "assertion.ref"
    "attribute.job_workflow_ref"     = "assertion.job_workflow_ref"
    "attribute.repo_id_workflow"     = "assertion.repository_id + '@' + assertion.ref + '|' + assertion.job_workflow_ref"
    "attribute.repo_id_workflow_env" = "assertion.repository_id + '@' + assertion.ref + '|' + assertion.job_workflow_ref + '|' + (has(assertion.environment) ? assertion.environment : '')"
  }

  # The owner-id check is a literal and always applies; a validated
  # allowed_owner_condition is only ANDed on, so it narrows trust, never widens it.
  # See infra/INSTALL.md section 6, "What each service account can do in the bucket".
  attribute_condition = "assertion.repository_owner_id == '${var.github_owner_id}'${var.allowed_owner_condition == null ? "" : " && (${var.allowed_owner_condition})"}"

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}
