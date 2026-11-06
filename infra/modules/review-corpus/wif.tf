resource "google_iam_workload_identity_pool" "github" {
  project                   = var.project_id
  workload_identity_pool_id = local.pool_id
  display_name              = "GitHub Actions"
  description               = "Keyless access for GitHub Actions workflows, federated by OIDC."

  depends_on = [google_project_service.apis]
}

resource "google_iam_workload_identity_pool_provider" "github" {
  project                            = var.project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = local.pool_id
  display_name                       = "GitHub OIDC"

  # repo_id_workflow is <repo id>@<ref>|<workflow ref>. repo_id_workflow_env is
  # the same string plus |<environment>, where the environment claim exists
  # only on a job that names an environment: has() keeps a job without one
  # from failing the mapping, and gives it an empty environment.
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

  # A LITERAL expression, not a local, so a scanner (Checkov CKV_GCP_125) can see
  # that it pins the numeric owner id. The owner-id check can never be dropped: a
  # custom allowed_owner_condition is only ANDed on, so it can narrow, never widen.
  attribute_condition = "assertion.repository_owner_id == '${var.github_owner_id}'${var.allowed_owner_condition == null ? "" : " && (${var.allowed_owner_condition})"}"

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}
