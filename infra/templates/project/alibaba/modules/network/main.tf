# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

terraform {
  required_version = ">= 1.6"
  required_providers {
    alicloud = {
      source  = "aliyun/alicloud"
      version = ">= 1.230"
    }
  }
}

locals {
  # Carve one vswitch per slot out of the VPC CIDR. The COUNT is the static
  # var.vswitch_count (plan-known under a deferred/keyless provider — #621); the zone
  # each slot lands in comes from the DISCOVERED var.zone_ids via element() (wraps when
  # a region has fewer zones than slots — multiple vswitches per zone are valid).
  zones = var.zone_ids
}

# VPC
resource "alicloud_vpc" "this" {
  vpc_name   = var.vpc_name
  cidr_block = var.network_cidr
  tags       = var.tags
}

# One vswitch (subnet) per slot — a STATIC count; zones assigned by element() wrap.
resource "alicloud_vswitch" "this" {
  count = var.vswitch_count

  vpc_id       = alicloud_vpc.this.id
  vswitch_name = "${var.vswitch_prefix}-${count.index}"
  cidr_block   = cidrsubnet(var.network_cidr, 4, count.index)
  zone_id      = element(local.zones, count.index)
  tags         = var.tags
}

# NAT gateway for outbound access (single, dev/test friendly).
resource "alicloud_nat_gateway" "this" {
  count = var.single_cloud_nat ? 1 : 0

  vpc_id           = alicloud_vpc.this.id
  nat_gateway_name = "ngw-${var.vpc_name}"
  vswitch_id       = try(alicloud_vswitch.this[0].id, null)
  nat_type         = "Enhanced"
  tags             = var.tags
}

# Elastic IP bound to the NAT gateway.
resource "alicloud_eip_address" "nat" {
  count = var.single_cloud_nat ? 1 : 0

  address_name = "eip-${var.vpc_name}"
  tags         = var.tags
}

resource "alicloud_eip_association" "nat" {
  count = var.single_cloud_nat ? 1 : 0

  allocation_id = one(alicloud_eip_address.nat[*].id)
  instance_id   = one(alicloud_nat_gateway.this[*].id)
}

# SNAT entries so vswitch traffic egresses through the NAT gateway.
resource "alicloud_snat_entry" "this" {
  count = var.single_cloud_nat ? var.vswitch_count : 0

  snat_table_id     = one(alicloud_nat_gateway.this[*].snat_table_ids)
  source_vswitch_id = alicloud_vswitch.this[count.index].id
  snat_ip           = one(alicloud_eip_address.nat[*].ip_address)

  depends_on = [alicloud_eip_association.nat]
}

# ── #1987: the project's extra ingress allow-list ───────────────────────────────────────────────
# Alibaba is the only cloud whose template carried NO security-group surface at all, so the group
# is created here and attached to the ACK node pool by the caller. It is created only when the
# allow-list is non-empty: an always-created group attached to nothing would be exactly the
# "looks like a control, gates nothing" shape this issue exists to remove.
resource "alicloud_security_group" "operator_allow_list" {
  count = length(var.allowed_cidr_blocks) > 0 ? 1 : 0

  # `security_group_name`, not `name`: the latter is deprecated from provider 1.239.0 and validate
  # warns on it.
  security_group_name = "${var.vpc_name}-operator-allow"
  description         = "Extra source ranges permitted by this project's network allow-list (#1987)."
  vpc_id              = alicloud_vpc.this.id
  tags                = var.tags
}

# One rule per CIDR: alicloud_security_group_rule takes a single cidr_ip, unlike the AWS/GCP forms
# that accept a list. for_each is keyed on the CIDR itself so reordering the list does not churn
# resource addresses (a count-indexed list here would destroy and recreate live rules on reorder).
resource "alicloud_security_group_rule" "operator_allow_list" {
  for_each = length(var.allowed_cidr_blocks) > 0 ? toset(var.allowed_cidr_blocks) : toset([])

  type              = "ingress"
  ip_protocol       = "all"
  port_range        = "-1/-1"
  policy            = "accept"
  priority          = 1
  security_group_id = one(alicloud_security_group.operator_allow_list[*].id)
  cidr_ip           = each.value
}
