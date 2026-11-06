terraform {
  required_version = "~> 1.12"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.50.0"
    }
  }

  # BOOTSTRAP: the state bucket this block points at is created by this very
  # configuration, so the first apply must run on LOCAL state with this block
  # commented out. Once that apply succeeds, uncomment the block and run
  #   tofu init -migrate-state
  # to move the state into the bucket. See infra/INSTALL.md steps 4 and 5.
  #
  # backend "gcs" {
  #   bucket = "review-tfstate-ai-gency"
  #   prefix = "review-corpus"
  # }
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

output "corpus_bucket" {
  value = module.review_corpus.corpus_bucket
}

output "state_bucket" {
  value = module.review_corpus.state_bucket
}
