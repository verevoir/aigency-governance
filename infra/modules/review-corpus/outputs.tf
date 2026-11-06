output "wif_provider" {
  description = "Full resource name of the OIDC provider, for google-github-actions/auth."
  value       = google_iam_workload_identity_pool_provider.github.name
}

output "publisher_sa" {
  description = "Email of the service account that publishes the corpus."
  value       = google_service_account.publisher.email
}

output "reader_sa" {
  description = "Email of the service account that reads the corpus."
  value       = google_service_account.reader.email
}

output "deployer_sa" {
  description = "Email of the service account that applies this module, or null when create_deployer is false."
  value       = one(google_service_account.deployer[*].email)
}

output "corpus_bucket" {
  description = "Name of the bucket holding the corpus."
  value       = google_storage_bucket.corpus.name
}

output "state_bucket" {
  description = "Name of the bucket holding this installation's OpenTofu state."
  value       = google_storage_bucket.state.name
}
