# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# The zone-vs-region split, which nothing else in this directory exercises.
#
# `var.region` on GCP carries a ZONE ("europe-west3-a") so the GKE cluster is zonal and the capacity
# preflight has a zonal question to ask. Everything regional — Firestore, Cloud SQL, Artifact
# Registry, Cloud Storage, brownfield subnet discovery, the short-name map — must consume the derived
# `local.gcp_region_key` instead, because a zone is not a key in `gcp_regions_short` and a regional
# API rejects it outright.
#
# WHY THIS FILE HAD TO EXIST. Every other `*.tftest.hcl` here sets `region = "europe-west3"`, a bare
# REGION. In that state `local.gcp_region_key == var.region` identically, so the derivation is a
# no-op and reverting locals.tf's normalization to a plain `var.region` leaves all of them green.
# Twelve mocked plans covered this template and not one could tell the two apart — the derivation was
# asserted only by a Go test matching file CONTENTS, which is not a plan.
#
# Providers are mocked and nothing is provisioned, so this needs no credentials and runs on any PR.

mock_provider "google" {}
mock_provider "google-beta" {}
mock_provider "random" {}

variables {
  project_id   = "mock-project"
  environment  = "staging"
  project_name = "alethia"

  # Everything off. This file is about location derivation, not about any one component, and a
  # failure here should be unambiguous.
  provision_gke               = false
  provision_artifact_registry = false
  create_cloud_sql            = false
  create_memorystore          = false
  create_memorystore_valkey   = false
  create_pubsub               = false
  create_cloud_storage        = false
  cloud_dns_enabled           = false
  cloud_armor_enabled         = false
  create_firestore            = false
}

# ── A ZONE: the shape the nightly actually dispatches ────────────────────────────────
#
# This is the run the whole file exists for. With the normalization reverted, `gcp_region_key`
# becomes "europe-west3-a", the first assert fails, and `local.gke_name` fails harder still — a zone
# is not a key in gcp_regions_short, so the plan errors rather than merely disagreeing.
run "a_zone_normalizes_to_its_region_for_regional_consumers" {
  command = plan

  variables {
    region = "europe-west3-a"
  }

  assert {
    condition     = local.gcp_region_key == "europe-west3"
    error_message = "A zonal var.region must derive the REGION key for regional APIs, got '${local.gcp_region_key}'. Firestore, Cloud SQL, Artifact Registry and Cloud Storage are all regional and reject a zone."
  }

  # The two must be DISTINCT here, which is precisely what a bare-region fixture cannot show. If this
  # ever passes trivially again, the suite has stopped testing the thing.
  assert {
    condition     = local.gcp_region_key != var.region
    error_message = "var.region '${var.region}' and the derived key '${local.gcp_region_key}' are identical, so this run proves nothing the other twelve fixtures did not already."
  }

  # The short-name map is keyed by region. This is the assertion that would have caught the original
  # "key does not exist in map" plan failure.
  assert {
    condition     = local.gke_name == "gke-ew3-staging-alethia"
    error_message = "Derived names must index gcp_regions_short by the REGION key, got '${local.gke_name}'."
  }
}

# ── A BARE REGION: the backward-compatible case ──────────────────────────────────────
#
# Not decoration. Without it a "normalization" that unconditionally chopped two characters off every
# region would satisfy the run above and quietly corrupt every caller that still passes a region —
# which is every other fixture in this directory, and any operator following the docs.
run "a_bare_region_is_passed_through_untouched" {
  command = plan

  variables {
    region = "europe-west3"
  }

  assert {
    condition     = local.gcp_region_key == "europe-west3"
    error_message = "A bare region must pass through unchanged, got '${local.gcp_region_key}'."
  }

  assert {
    condition     = local.gke_name == "gke-ew3-staging-alethia"
    error_message = "Derived names must be identical whether the caller passed a zone or its region, got '${local.gke_name}'."
  }
}
