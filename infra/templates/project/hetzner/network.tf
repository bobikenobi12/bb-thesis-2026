# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

locals {
  # Is the network id we were handed a numeric hcloud id, or a name? The console sends the id
  # from cloud inventory, but a human filling the field in reaches for the name, and the data
  # source accepts either — on different arguments. Deciding here keeps the branch in one place.
  existing_network_is_id = can(tonumber(trimspace(var.network_id)))

  # Carve a /24 node subnet out of the network CIDR for the servers' private IPs.
  node_subnet_cidr = cidrsubnet(local.network_ip_range, 24 - tonumber(split("/", local.network_ip_range)[1]), 0)

  # Deterministic private IPs. Hetzner reserves the first host of a subnet and
  # the .1 gateway, so we start control planes at .101 and workers at .201.
  control_plane_private_ips = [
    for i in range(var.control_plane_count) : cidrhost(local.node_subnet_cidr, i + 101)
  ]
  worker_private_ips = [
    for i in range(var.worker_count) : cidrhost(local.node_subnet_cidr, i + 201)
  ]
}

# Private network the whole cluster attaches to — created here, or brought by the user.
#
# #1816: this resource used to be unconditional, so `provision_network = false` on the canvas
# produced a SECOND network beside the one the user meant to attach to, and nothing said so.
resource "hcloud_network" "this" {
  count = var.provision_network ? 1 : 0

  name     = local.cluster_name
  ip_range = var.network_cidr
  labels   = local.default_labels
}

# Adding `count` to a resource that had none renames its address (`…this` -> `…this[0]`), which
# tofu would otherwise plan as DESTROY + CREATE — of the network every existing Hetzner cluster
# is attached to. This moves the state entry instead; without it, upgrading the template tears
# down live clusters.
moved {
  from = hcloud_network.this
  to   = hcloud_network.this[0]
}

# The existing network, when the user brought one. hcloud's data source takes an id OR a name,
# so we hand it whichever `network_id` turned out to be.
data "hcloud_network" "existing" {
  count = var.provision_network ? 0 : 1

  id   = local.existing_network_is_id ? tonumber(trimspace(var.network_id)) : null
  name = local.existing_network_is_id ? null : trimspace(var.network_id)
}

locals {
  # The network everything else in this template attaches to, and the range it routes.
  # ONE pair of names, so nothing downstream has to know which branch produced them.
  #
  # `tostring` on the brownfield branch is load-bearing, not decoration: hcloud types the
  # RESOURCE's id as a string and the DATA SOURCE's id as a number, so an unconverted ternary
  # unifies the two by coercion and the type of this local depends on which branch is live.
  network_id       = var.provision_network ? one(hcloud_network.this[*].id) : tostring(one(data.hcloud_network.existing[*].id))
  network_ip_range = var.provision_network ? var.network_cidr : one(data.hcloud_network.existing[*].ip_range)

  # The pod and service CIDRs, derived from the network that ACTUALLY RESOLVED rather than from the
  # network_cidr the caller asked for — on the brownfield path those are different values, and the
  # resolved one is the only one Cilium's native routing and the private-network firewall cover.
  #
  # Fixed by construction, not by a check. The split is the same one checks.tf documents and the Go
  # provider used to compute: pod = the upper half (a /17 of a /16), service = the fourth eighth (a
  # /19), both disjoint from the node subnet, which is the FIRST /24. Deriving it here means the
  # invariant holds for any network a user attaches, instead of holding for 10.0.0.0/16 and blocking
  # the apply for everything else.
  #
  # The preconditions in checks_network.tf stay, and they are no longer the normal path: they are
  # the net for a caller that passes pod_cidr / service_cidr explicitly. They also still catch the
  # one case this derivation cannot serve — a network too small to carve a /24 node subnet and two
  # disjoint blocks out of, which is anything longer than about a /22.
  pod_cidr     = coalesce(var.pod_cidr, cidrsubnet(local.network_ip_range, 1, 1))
  service_cidr = coalesce(var.service_cidr, cidrsubnet(local.network_ip_range, 3, 3))
}

# The node subnet is created on BOTH paths. Servers draw their private IP from a subnet, and the
# hcloud provider ships no `hcloud_network_subnet` DATA source (checked against 1.67.0's schema),
# so on a brought network there is nothing to look up — we add our own /24 inside it.
resource "hcloud_network_subnet" "nodes" {
  network_id   = local.network_id
  type         = "cloud"
  network_zone = data.hcloud_location.selected.network_zone
  ip_range     = local.node_subnet_cidr
}

# Pre-allocate public IPv4s so the control-plane public IPs are known BEFORE the
# machine config / cert SANs are rendered — this breaks the server<->config
# dependency cycle (the same approach the reference module uses).
resource "hcloud_primary_ip" "control_plane_ipv4" {
  count       = var.control_plane_count
  name        = "${local.cluster_name}-cp-${count.index + 1}-ipv4"
  location    = data.hcloud_location.selected.name
  type        = "ipv4"
  auto_delete = false
  labels      = merge(local.default_labels, { role = "control-plane" })
}

resource "hcloud_primary_ip" "worker_ipv4" {
  count       = var.worker_count
  name        = "${local.cluster_name}-worker-${count.index + 1}-ipv4"
  location    = data.hcloud_location.selected.name
  type        = "ipv4"
  auto_delete = false
  labels      = merge(local.default_labels, { role = "worker" })
}

locals {
  control_plane_public_ips = [for ip in hcloud_primary_ip.control_plane_ipv4 : ip.ip_address]
  control_plane_public_ip  = local.control_plane_public_ips[0]
  worker_public_ips        = [for ip in hcloud_primary_ip.worker_ipv4 : ip.ip_address]
}

# Firewall: allow Talos apid (50000/50001), the Kubernetes API (6443), and all
# intra-cluster traffic on the private network.
resource "hcloud_firewall" "this" {
  name   = local.cluster_name
  labels = local.default_labels

  rule {
    description = "Talos apid"
    direction   = "in"
    protocol    = "tcp"
    port        = "50000"
    source_ips  = ["0.0.0.0/0", "::/0"]
  }

  rule {
    description = "Talos apid (trustd)"
    direction   = "in"
    protocol    = "tcp"
    port        = "50001"
    source_ips  = ["0.0.0.0/0", "::/0"]
  }

  rule {
    description = "Kubernetes API server"
    direction   = "in"
    protocol    = "tcp"
    port        = "6443"
    source_ips  = ["0.0.0.0/0", "::/0"]
  }

  rule {
    description = "Intra-cluster TCP (private network)"
    direction   = "in"
    protocol    = "tcp"
    port        = "any"
    source_ips  = [local.network_ip_range]
  }

  rule {
    description = "Intra-cluster UDP (private network)"
    direction   = "in"
    protocol    = "udp"
    port        = "any"
    source_ips  = [local.network_ip_range]
  }

  rule {
    description = "Intra-cluster ICMP (private network)"
    direction   = "in"
    protocol    = "icmp"
    source_ips  = [local.network_ip_range]
  }

  # Extra operator-supplied source ranges (#1987). ADDITIVE: each CIDR gets its own inbound rules
  # alongside the fixed ones above, so an empty list — the default — changes nothing. Split by
  # protocol because hcloud requires `port` on tcp/udp and REJECTS it on icmp.
  dynamic "rule" {
    for_each = length(var.network_allowed_cidr_blocks) > 0 ? ["tcp", "udp"] : []
    content {
      description = "Operator allow-list (${rule.value})"
      direction   = "in"
      protocol    = rule.value
      port        = "any"
      source_ips  = var.network_allowed_cidr_blocks
    }
  }

  dynamic "rule" {
    for_each = length(var.network_allowed_cidr_blocks) > 0 ? [1] : []
    content {
      description = "Operator allow-list (icmp)"
      direction   = "in"
      protocol    = "icmp"
      source_ips  = var.network_allowed_cidr_blocks
    }
  }
}
