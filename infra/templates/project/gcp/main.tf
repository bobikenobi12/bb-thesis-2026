terraform {
  required_version = "~> 1.1"
  backend "http" {}

  required_providers {
    google = {
      source = "hashicorp/google"
      # >= 6.15.0 for `vulnerability_scanning_config` on google_artifact_registry_repository
      # (#1844). The lockfile already resolves 6.50.0, so this moves the CONSTRAINT to match what is
      # actually required, not the resolved version.
      version = ">= 6.15.0, < 7.0"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = ">= 5.0, < 7.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.0"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = local.gcp_region_key
}

provider "google-beta" {
  project = var.project_id
  region  = local.gcp_region_key
}

# These two are declared for completeness and define no resources — ArgoCD and the add-ons are
# installed post-apply by the runner. A provider block cannot take a `count`, so the `provision_gke`
# gate has to live in the expression (#1772 parity with aws/main.tf).
#
# They survive `provision_gke = false` today only by accident: with zero kubernetes_*/helm_*
# resources in the root, tofu prunes an unused provider config and never evaluates its body. Add ONE
# — even at `count = 0`, and scripts/check-templates-plan-safe.sh explicitly permits an offline
# `data "helm_template"` — and the plan dies with "Invalid index … module.gke is empty tuple", which
# is exactly how the AWS template shipped an unusable `provision_eks = false` for its whole life.
#
# An explicit ternary, NOT `try()`: `try()` swallows every evaluation error, not just the
# empty-tuple one, so a future rename of `cluster_endpoint` would silently point the provider at
# the fallback instead of failing loudly. `azure/main.tf` already uses this exact form in a
# provider block, so it is proven. `""` rather than `null`: the kubernetes provider rejects a null
# host as a type error. Do NOT add `mock_provider "kubernetes"` to the .tftest.hcl files to
# "cover" this — measured on aws: mocking the provider replaces the configuration wholesale, so
# the body is never evaluated and the mock HIDES this class of bug instead of catching it.
provider "kubernetes" {
  host                   = try(module.gke[0].cluster_endpoint, null) != null ? "https://${module.gke[0].cluster_endpoint}" : ""
  token                  = data.google_client_config.default.access_token
  cluster_ca_certificate = try(module.gke[0].cluster_ca_certificate, null) != null ? base64decode(module.gke[0].cluster_ca_certificate) : ""
}

provider "helm" {
  kubernetes {
    host                   = try(module.gke[0].cluster_endpoint, null) != null ? "https://${module.gke[0].cluster_endpoint}" : ""
    token                  = data.google_client_config.default.access_token
    cluster_ca_certificate = try(module.gke[0].cluster_ca_certificate, null) != null ? base64decode(module.gke[0].cluster_ca_certificate) : ""
  }
}

data "google_client_config" "default" {}
data "google_project" "current" {}
