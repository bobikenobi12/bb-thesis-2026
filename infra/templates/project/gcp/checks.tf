# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Plan-time invariant checks for the GCP project template (per infra IaC rule #2). These assert the
# naming, hardening, and conditional-completeness invariants the design depends on, so a careless
# edit or bad tfvars fails loudly at plan time rather than provisioning something broken/insecure.
#
# CONVENTION: this file holds only the CORE, rarely-touched invariants. A new feature's checks go in
# their own checks_<feature>.tf — OpenTofu loads every *.tf in the directory, and a single shared
# append-point is what made concurrent feature branches conflict here repeatedly.

locals {
  # Kubernetes major/minor parsed from gke_cluster_version ("1.35" -> 1 / 35). -1 when unparseable, so a
  # missing/garbage version fails the COMPAT-001 guard closed rather than passing vacuously. The window
  # literals below are the GCP supported minors from the compat matrix
  # (packages/core/compat/matrix.json -> k8s_cloud.gcp = 1.33-1.35). Keep them in lockstep with
  # matrix.json (the Go/TS drift guards couplings_drift_test.go + apps/console check:compat keep code honest).
  gke_k8s_major = can(tonumber(split(".", var.gke_cluster_version)[0])) ? tonumber(split(".", var.gke_cluster_version)[0]) : -1
  gke_k8s_minor = can(tonumber(split(".", var.gke_cluster_version)[1])) ? tonumber(split(".", var.gke_cluster_version)[1]) : -1
}

# project_name is the root of every naming convention and must be non-empty.
check "project_name_non_empty" {
  assert {
    condition     = length(trimspace(var.project_name)) > 0
    error_message = "project_name must be non-empty (it seeds every resource name)."
  }
}

# The <environment>-<project_name> naming-stem invariant moved to checks_naming.tf (NAMING-001),
# where it is paired with the terraform_data precondition that actually BLOCKS an over-long stem.
# It lived here as a `check` alone, which only warns — see #1716.

# A GKE Kubernetes master version must be set when GKE is provisioned.
check "gke_cluster_version_present" {
  assert {
    condition     = !var.provision_gke || length(trimspace(var.gke_cluster_version)) > 0
    error_message = "provision_gke is true but gke_cluster_version is empty."
  }
}

# The Artifact Registry module and the output that reads it must agree about whether it exists.
#
# They didn't: the module's count required `registry_provider == "native"` while the output only
# checked `provision_artifact_registry`, and the console derives that flag from the PRESENCE of a
# registry row, not its provider. Selecting any registry connector therefore indexed [0] of an empty
# module and failed the whole apply with "Invalid index". The output now guards on the module
# INSTANCE (`try(module.artifact_registry[0].<out>, null) != null ? …`, #3509); this check keeps
# reading `length()`, which is right HERE — it is asserting the module's EXPANSION against the
# predicate, not reading an output, and a check block is a graph leaf that cannot cycle. It asserts
# the pairing so a future edit can't reintroduce the skew silently.
check "artifact_registry_output_matches_module" {
  assert {
    condition     = (length(module.artifact_registry) > 0) == (var.provision_artifact_registry && var.registry_provider == "native")
    error_message = "The Artifact Registry module count and its provisioning predicate have diverged — a pluggable registry_provider means Artifact Registry is not created, and any output reading module.artifact_registry[0] would fail the apply."
  }
}
