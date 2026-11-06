terraform {
  required_version = "~> 1.12"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.50.0"
    }
  }

  # Remote state, with locking. The block is PARTIAL on purpose: the bucket and
  # prefix are passed at init, so no installation value is baked in here:
  #   tofu init -backend-config="bucket=$TF_STATE_BUCKET" \
  #             -backend-config="prefix=$TF_STATE_PREFIX"
  # CI reads them from the repository variables TF_STATE_BUCKET and
  # TF_STATE_PREFIX and fails if either is unset. The bucket is created once, by
  # an operator, before the first init: see infra/INSTALL.md step 4.
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
