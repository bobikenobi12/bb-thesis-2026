# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Plan-time invariant checks for the Azure project template (per infra IaC rule #2). These assert the
# naming, hardening, and conditional-completeness invariants the design depends on, so a careless
# edit or bad tfvars fails loudly at plan time rather than provisioning something broken/insecure.
#
# CONVENTION: this file holds only the CORE, rarely-touched invariants. A new feature's checks go in
# their own checks_<feature>.tf — OpenTofu loads every *.tf in the directory, and a single shared
# append-point is what made concurrent feature branches conflict here repeatedly.

locals {
  # Key Vault naming moved to checks_naming.tf (NAMING-002). It is no longer asserted here — it is
  # DERIVED there, because the composition had no length budget and an assertion could only warn
  # while the plan failed anyway (#1873).
  #
  # Storage Account naming followed it there (#1886), and its old guard is worth a sentence because
  # it was wrong in two independent ways. It read:
  #
  #   azure_storage_name_stem_len = length(replace(lower("${var.environment}${var.project_name}"), …))
  #   check "storage_account_name_within_limit" { condition = local.azure_storage_name_stem_len <= 24 }
  #
  #   1. `check` only WARNS. Even at 25 the plan proceeded and Azure refused the name — the exact
  #      failure mode #1873 shipped for months.
  #   2. It measured the wrong string. The module composes "<project_name><environment>st" — the
  #      opposite order, plus a two-character suffix the stem did not carry — so the guard passed at
  #      a stem of 24 while the name Azure saw was 26.
  #
  # Both are moot now: the name is derived inside its cap in checks_naming.tf and the assertion
  # there is over the OUTPUT.

  # Kubernetes major/minor parsed from aks_cluster_version ("1.35" -> 1 / 35). -1 when unparseable, so a
  # missing/garbage version fails the COMPAT-001 guard closed rather than passing vacuously. The window
  # literals below are the Azure supported minors from the compat matrix
  # (packages/core/compat/matrix.json -> k8s_cloud.azure = 1.33-1.35). Keep them in lockstep with
  # matrix.json (the Go/TS drift guards couplings_drift_test.go + apps/console check:compat keep code honest).
  aks_k8s_major = can(tonumber(split(".", var.aks_cluster_version)[0])) ? tonumber(split(".", var.aks_cluster_version)[0]) : -1
  aks_k8s_minor = can(tonumber(split(".", var.aks_cluster_version)[1])) ? tonumber(split(".", var.aks_cluster_version)[1]) : -1
}

# project_name is the root of every naming convention and must be non-empty.
check "project_name_non_empty" {
  assert {
    condition     = length(trimspace(var.project_name)) > 0
    error_message = "project_name must be non-empty (it seeds every resource name)."
  }
}

# An AKS Kubernetes version must be set when AKS is provisioned.
check "aks_cluster_version_present" {
  assert {
    condition     = !var.provision_aks || length(trimspace(var.aks_cluster_version)) > 0
    error_message = "provision_aks is true but aks_cluster_version is empty."
  }
}

# The ACR module and the output that reads it must agree about whether it exists.
#
# They didn't: the module's count required `registry_provider == "native"` while the output only
# checked `provision_acr`, and the console derives that flag from the PRESENCE of a registry row, not
# its provider. Selecting any registry connector therefore indexed [0] of an empty module and failed
# the whole apply with "Invalid index". The output now guards on the module
# INSTANCE (`try(module.acr[0].<out>, null) != null ? …`, #3509); this check keeps
# reading `length()`, which is right HERE — it is asserting the module's EXPANSION against the
# predicate, not reading an output, and a check block is a graph leaf that cannot cycle. It asserts
# the pairing so a future edit can't reintroduce the skew silently.
check "acr_output_matches_module" {
  assert {
    condition     = (length(module.acr) > 0) == (var.provision_acr && var.registry_provider == "native")
    error_message = "The ACR module count and its provisioning predicate have diverged — a pluggable registry_provider means the ACR is not created, and any output reading module.acr[0] would fail the apply."
  }
}
