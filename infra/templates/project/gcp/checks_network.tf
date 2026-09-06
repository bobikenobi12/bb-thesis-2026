# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# VPC / subnet / brownfield-network invariants.
# Split out of checks.tf so each feature owns its file (IaC rule: one file per component).
# Add new checks for THIS feature here; never append to checks.tf.

# When a network is provisioned in-template, the primary/pod/service CIDRs must be valid.
check "network_cidrs_valid_when_provisioned" {
  assert {
    condition     = !var.provision_network || (can(cidrhost(var.network_cidr, 0)) && can(cidrhost(var.pods_cidr_range, 0)) && can(cidrhost(var.services_cidr_range, 0)))
    error_message = "provision_network is true but one of network_cidr / pods_cidr_range / services_cidr_range is not a valid IPv4 CIDR."
  }
}

# When an existing network is used (provision_network = false) its self-link must be supplied.
# (The former subnetwork_id half of this assertion was dead — nothing consumed that variable, so it
# forced callers to supply a value that no resource read. #1352 replaces it: the subnetwork is now
# either the user's var.subnet_ids selection or auto-discovered in-region, and the fail-closed
# brownfield_subnet_resolved guard below asserts one actually resolved.)
check "existing_network_id_present" {
  assert {
    condition     = var.provision_network || length(trimspace(var.network_id)) > 0
    error_message = "provision_network is false (existing network) but network_id is empty; supply the network self-link."
  }
}

# A brownfield deploy must resolve exactly one subnetwork — either from the user's explicit
# var.subnet_ids selection or by auto-discovering the subnetwork in the region derived from
# var.region. WARN companion to
# the fail-closed guard below; surfaces the "no subnet in region" case at plan instead of apply.
check "brownfield_subnet_resolved_warn" {
  assert {
    condition     = var.provision_network || length(trimspace(local.existing_subnet_self_link)) > 0
    error_message = "provision_network is false but no subnetwork resolved for region '${local.gcp_region_key}' — select subnet_ids or ensure the existing network has a subnetwork in this region."
  }
}

# Standard GKE clusters (non-Autopilot) keep nodes private by design; do not disable private nodes.
check "gke_private_nodes_when_standard" {
  assert {
    condition     = !var.provision_gke || var.gke_enable_autopilot || var.gke_enable_private_nodes
    error_message = "Standard GKE clusters must keep gke_enable_private_nodes = true (private nodes)."
  }
}

# When Cloud DNS is enabled we CREATE a zone, and the only thing the caller must supply is the
# domain — the zone's own name is derived (local.cloud_dns_name).
#
# This used to also require `cloud_dns_zone_name`, which is exactly backwards once
# `cloud_dns_enabled` is the CREATE gate (#2294): that variable carries the id of a zone the caller
# already OWNS, and supplying it is precisely what turns creation OFF. So the old condition refused
# the create path unless you named a zone you were not creating, and passed on the attach path only
# because the flag it keyed off was never false there. Azure hit the identical inversion in #1992
# and its checks_network.tf records the same correction.
#
# `check` never blocks an apply — it only warns — so this states an invariant rather than enforcing
# one; the enforcement is the count on module.cloud_dns.
check "cloud_dns_fields_present_when_enabled" {
  assert {
    condition     = !var.cloud_dns_enabled || length(trimspace(var.cloud_dns_domain)) > 0
    error_message = "cloud_dns_enabled is true (creating a zone) but cloud_dns_domain is empty; the domain is what the created zone serves."
  }
}

# Fail-closed brownfield-subnet gate (#1352): on an existing network a subnetwork MUST resolve —
# from the user's var.subnet_ids selection or auto-discovery in the region derived from var.region. Previously an
# unresolved subnet fell through to an empty self-link and failed deep inside `tofu apply`; this
# lifecycle precondition moves it to a hard plan-time block.
resource "terraform_data" "brownfield_subnet_guard" {
  lifecycle {
    precondition {
      condition     = var.provision_network || length(trimspace(local.existing_subnet_self_link)) > 0
      error_message = "provision_network is false but no subnetwork resolved for region '${local.gcp_region_key}'. Select subnet_ids, or ensure the existing network (${var.network_id}) has a subnetwork in this region. Apply blocked fail-closed."
    }
  }
}
