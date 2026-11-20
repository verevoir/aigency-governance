terraform {
  required_version = "~> 1.12"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.50.0"
    }
  }

  # Remote state, with locking. PARTIAL so no installation value is baked in: init
  # gets them by -backend-config from TF_STATE_BUCKET and TF_STATE_PREFIX. See
  # infra/INSTALL.md sections 4 and 5, "Create the state bucket" and "Bootstrap".
  backend "gcs" {}
}

provider "google" {
  project = "ai-gency"
  region  = "europe-west2"
}

module "review_corpus" {
  source = "../../modules/review-corpus"

  project_id         = "ai-gency"
  region             = "europe-west2"
  github_owner       = "verevoir"
  github_owner_id    = "266172281"
  corpus_repo        = "verevoir/aigency-guardrails"
  corpus_repo_id     = "1238645336"
  governance_repo    = "verevoir/aigency-governance"
  governance_repo_id = "1334340199"
}

output "wif_provider" {
  value = module.review_corpus.wif_provider
}

output "publisher_sa" {
  value = module.review_corpus.publisher_sa
}

output "reader_sa" {
  value = module.review_corpus.reader_sa
}

output "deployer_sa" {
  value = module.review_corpus.deployer_sa
}

output "planner_sa" {
  value = module.review_corpus.planner_sa
}

output "corpus_bucket" {
  value = module.review_corpus.corpus_bucket
}

output "state_bucket" {
  value = module.review_corpus.state_bucket
}
