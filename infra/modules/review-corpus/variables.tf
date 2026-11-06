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

variable "name_prefix" {
  description = "Prefix for every named resource, so several installations can live in one project."
  type        = string
  default     = "review"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,9}$", var.name_prefix))
    error_message = "name_prefix must be 2-10 characters: a lowercase letter, then lowercase letters, digits or dashes."
  }
}

variable "pool_suffix" {
  description = "Appended to the identity pool id. GCP soft-deletes pools for 30 days and a deleted id cannot be reused, so change this on a reinstall."
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
  description = "Whether to create the deployer service account, its custom role and its project-level grants. Set false in a shared project: the module's only grants are then bucket-level and service-account-level."
  type        = bool
  default     = true
}

variable "allowed_owner_condition" {
  description = "The CEL attribute condition on the provider. The owner-id check (assertion.repository_owner_id equals github_owner_id) is always applied; a value here is ANDed with it and can only narrow trust."
  type        = string
  default     = null
}
