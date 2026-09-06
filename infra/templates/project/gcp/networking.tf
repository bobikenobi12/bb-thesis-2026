module "vpc_network" {
  source = "./modules/vpc-network"
  count  = var.provision_network ? 1 : 0

  project_id   = var.project_id
  region       = local.gcp_region_key
  environment  = var.environment
  project_name = var.project_name

  network_cidr     = var.network_cidr
  gke_cluster_name = local.gke_name

  pod_ip_range     = var.pods_cidr_range
  service_ip_range = var.services_cidr_range

  single_cloud_nat = var.single_cloud_nat

  labels = local.gcp_default_labels
}

# ── #1987: the project's extra ingress allow-list ───────────────────────────────────────────────
# Lives at the ROOT rather than inside modules/vpc-network for two reasons. It has to cover the
# BROWNFIELD path too (the module is count = 0 when provision_network is false, so a rule written
# inside it would silently not exist for a project attached to an existing VPC — the shape that
# makes a security control look present and do nothing). And a root local is reachable by
# `tofu test`, which cannot see into a module — the same reasoning checks_naming.tf records for
# gke_node_pool_name.
locals {
  # The network to attach the rule to, resolved for both paths exactly as gke.tf resolves it.
  allow_list_network = try(module.vpc_network[0].network_name, null) != null ? module.vpc_network[0].network_name : one(data.google_compute_network.existing[*].name)

  # Built from the SAME stem the NAMING-001 budget is computed against, and deliberately not from
  # the resolved network name: plain variables are known at plan time, so this is assertable before
  # any resource exists. checks_naming.tf already reserves "stem + 24" for a VPC firewall against
  # GCP's 63-char cap; this suffix is 21, inside that budget.
  allow_list_firewall_name = "${var.project_name}-${var.environment}-vpc-allow-operator"
}

resource "google_compute_firewall" "operator_allow_list" {
  count = length(var.network_allowed_cidr_blocks) > 0 ? 1 : 0

  name        = local.allow_list_firewall_name
  project     = var.project_id
  network     = local.allow_list_network
  description = "Extra source ranges permitted by this project's network allow-list (#1987)."

  direction     = "INGRESS"
  priority      = 1000
  source_ranges = var.network_allowed_cidr_blocks

  allow { protocol = "tcp" }
  allow { protocol = "udp" }
  allow { protocol = "icmp" }
}
