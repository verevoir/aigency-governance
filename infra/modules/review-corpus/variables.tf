variable "project_id" {
  description = "The GCP project ID that will hold the buckets, the identity pool and the service accounts."
  type        = string
}

variable "region" {
  description = "The location for both buckets, for example europe-west2."
  type        = string
}

variable "github_owner" {
  description = "The GitHub organisation or user that owns every repository allowed to authenticate. A label for docs only: trust is pinned on github_owner_id."
  type        = string
}

variable "github_owner_id" {
  description = "The numeric GitHub id of github_owner, as a string. Trust is pinned on this id, not the name: a name can be re-registered after a rename or deletion, an id cannot."
  type        = string

  validation {
    condition     = can(regex("^[0-9]+$", var.github_owner_id))
    error_message = "github_owner_id must be a numeric string, for example \"266172281\"."
  }
}

variable "corpus_repo_id" {
  description = "The numeric GitHub id of corpus_repo, as a string. The publisher is bound to this id."
  type        = string

  validation {
    condition     = can(regex("^[0-9]+$", var.corpus_repo_id))
    error_message = "corpus_repo_id must be a numeric string."
  }
}

variable "governance_repo_id" {
  description = "The numeric GitHub id of governance_repo, as a string. The deployer is bound to this id."
  type        = string

  validation {
    condition     = can(regex("^[0-9]+$", var.governance_repo_id))
    error_message = "governance_repo_id must be a numeric string."
  }
}

variable "corpus_repo" {
  description = "The repository (owner/name) that holds the practices corpus and publishes it to the bucket."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", var.corpus_repo))
    error_message = "corpus_repo must look like owner/name."
  }
}

variable "governance_repo" {
  description = "The repository (owner/name) whose main branch deploys this module."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", var.governance_repo))
    error_message = "governance_repo must look like owner/name."
  }
}

variable "publish_workflow_path" {
  description = "Path, in corpus_repo, of the one workflow file allowed to publish. The publisher can be assumed only from this workflow on refs/heads/main."
  type        = string
  default     = ".github/workflows/publish-corpus.yml"

  validation {
    condition     = can(regex("^[A-Za-z0-9_./-]+$", var.publish_workflow_path)) && !startswith(var.publish_workflow_path, "/")
    error_message = "publish_workflow_path must be a relative file path such as .github/workflows/publish-corpus.yml."
  }
}

variable "deploy_workflow_path" {
  description = "Path, in governance_repo, of the one workflow file allowed to deploy. The deployer can be assumed only from this workflow on refs/heads/main."
  type        = string
  default     = ".github/workflows/infra.yml"

  validation {
    condition     = can(regex("^[A-Za-z0-9_./-]+$", var.deploy_workflow_path)) && !startswith(var.deploy_workflow_path, "/")
    error_message = "deploy_workflow_path must be a relative file path such as .github/workflows/infra.yml."
  }
}

variable "name_prefix" {
  description = "Prefix for every named resource, so several installations can live in one project. At most 10 characters so the longest derived name fits: the pool id is <prefix>-github-<pool_suffix>, at most 10 + 8 + 12 = 30 of the 32 characters GCP allows."
  type        = string
  default     = "review"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,9}$", var.name_prefix))
    error_message = "name_prefix must be 2-10 characters: a lowercase letter, then lowercase letters, digits or dashes."
  }
}

variable "pool_suffix" {
  description = "Appended to the identity pool id. GCP soft-deletes pools for 30 days (from memory of GCP's documentation; not verified here) and a deleted id cannot be reused, so change this on a reinstall. At most 12 characters: see name_prefix for the pool id length budget."
  type        = string
  default     = ""

  validation {
    condition     = can(regex("^[a-z0-9-]{0,12}$", var.pool_suffix))
    error_message = "pool_suffix must be at most 12 lowercase letters, digits or dashes."
  }
}

variable "manage_apis" {
  description = "Whether this module enables the project APIs it needs. Set false in a shared project that manages its own APIs: no google_project_service is then created."
  type        = bool
  default     = true
}

variable "create_deployer" {
  description = "Whether to create the deployer and planner service accounts, their custom roles and their project-level grants. The deployer holds project-wide service usage and identity pool admin roles that cannot be narrowed, so it belongs in a DEDICATED project. Set false in a shared project: the module's only grants are then bucket-level and service-account-level."
  type        = bool
  default     = true
}

variable "deploy_environment" {
  description = "Name of the GitHub environment the deployer's job must run in. The deployer can be assumed only by a token whose environment claim is this name, so the planner's jobs, which name no environment, cannot assume it. The environment's required reviewers are what gate an apply, and are set in GitHub, not here."
  type        = string
  default     = "infra-apply"

  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]+$", var.deploy_environment))
    error_message = "deploy_environment must be letters, digits, dots, dashes or underscores."
  }
}

variable "noncurrent_retention_days" {
  description = "Days an overwritten or deleted corpus object version is kept before it is removed. The default 30 is a judgement, not a measurement: a month to notice a bad refs/main overwrite (the only object the publisher overwrites) and restore it. Too short and a bad publish cannot be recovered after a long absence; too long and old versions cost storage, which is small here. Corpus bucket only: the state bucket keeps every version."
  type        = number
  default     = 30

  validation {
    condition     = var.noncurrent_retention_days >= 1 && var.noncurrent_retention_days == floor(var.noncurrent_retention_days)
    error_message = "noncurrent_retention_days must be a whole number of days, at least 1."
  }
}

variable "allowed_owner_condition" {
  description = "An extra CEL condition on the provider. The owner-id check (assertion.repository_owner_id equals github_owner_id) is always applied; a value here is ANDed after it and can only narrow trust. It is spliced into the expression as text, so it may not contain parentheses, || or && (or //), which are what would let a value close its group and widen trust: use one plain comparison such as assertion.repository == 'owner/name'."
  type        = string
  default     = null

  validation {
    condition     = var.allowed_owner_condition == null || !can(regex("[()]|[|][|]|&&|//", var.allowed_owner_condition))
    error_message = "allowed_owner_condition must not contain parentheses, ||, && or //."
  }
}
