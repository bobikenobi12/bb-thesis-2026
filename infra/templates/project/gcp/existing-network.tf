# Brownfield networking: when `provision_network = false`, attach GKE to an EXISTING VPC network instead
# of creating one. The console sends `network_id` (the network's name or self-link); we data-source the
# network, resolve the subnetwork that lives in `local.gcp_region_key` (subnet self-links embed the
# region, while var.region may be a zone), and
# read that subnet's pod/service secondary-range names — mirroring how the AWS template consumes an
# existing VPC + its subnets. Greenfield (provision_network = true) is untouched: these data sources have
# count = 0 and the `module.vpc_network` seam is used as before.
#
# NOTE: verify against a real GKE + existing network. Assumption: the existing network has one subnetwork
# per region, with pod/service secondary ranges (matched by name, else by order).

data "google_compute_network" "existing" {
  count   = var.provision_network ? 0 : 1
  name    = var.network_id
  project = var.project_id
}

locals {
  # The existing network's subnetwork (self-links look like
  # .../regions/<region>/subnetworks/<name>). Prefer the user's explicit selection
  # (var.subnet_ids, #1352); otherwise fall back to auto-discovering the one subnetwork that
  # lives in the region derived from var.region. The explicit selection removes the region-regex guess.
  existing_subnet_self_link = var.provision_network ? "" : (
    length(var.subnet_ids) > 0 ? var.subnet_ids[0] : try(
      [
        for s in one(data.google_compute_network.existing[*].subnetworks_self_links) : s
        if length(regexall("/regions/${local.gcp_region_key}/", s)) > 0
      ][0],
      "",
    )
  )
}

data "google_compute_subnetwork" "existing" {
  count     = var.provision_network ? 0 : 1
  self_link = local.existing_subnet_self_link
}

locals {
  existing_secondary = var.provision_network ? [] : one(data.google_compute_subnetwork.existing[*].secondary_ip_range)

  # GKE needs the pod + service secondary-range NAMES. Match by name, else fall back to declared order.
  existing_pods_range_name = var.provision_network ? "pods" : try(
    [for r in local.existing_secondary : r.range_name if length(regexall("pod", lower(r.range_name))) > 0][0],
    try(local.existing_secondary[0].range_name, "pods"),
  )
  existing_services_range_name = var.provision_network ? "services" : try(
    [for r in local.existing_secondary : r.range_name if length(regexall("svc|service", lower(r.range_name))) > 0][0],
    try(local.existing_secondary[1].range_name, "services"),
  )
}
