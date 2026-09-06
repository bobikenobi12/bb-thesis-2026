# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

module "cluster" {
  source = "./modules/cluster"
  count  = var.provision_ack ? 1 : 0

  depends_on = [module.network]

  cluster_name = local.ack_name

  secrets_encryption_key_id = local.alibaba_secrets_encryption ? one(alicloud_kms_key.ack_secrets[*].id) : ""
  # The FULL version ACK's create API accepts (e.g. "1.35.7-aliyun.1"), resolved from the declared
  # minor against what this region actually offers. Passing the bare minor is what produced
  # `400: no ros component exists … version: 1.35` on the first real alibaba apply — see
  # ack-version.tf for why this is resolved rather than hardcoded.
  cluster_version = local.ack_resolved_version

  vswitch_ids = local.vswitch_ids

  # #1987: [] unless the project set a network allow-list, in which case modules/network created a
  # group for it. Brownfield has no such group, which checks_network.tf reports rather than drops.
  security_group_ids = try(module.network[0].operator_allow_list_security_group_ids, null) != null ? module.network[0].operator_allow_list_security_group_ids : []

  instance_types    = var.ack_instance_types
  node_min_size     = var.ack_node_min_size
  node_max_size     = var.ack_node_max_size
  node_desired_size = var.ack_node_desired_size
  disk_size_gb      = var.ack_disk_size_gb

  # Node system disk (aws parity: eks_volume_type / eks_volume_iops). disk_category defaults to
  # cloud_essd — the value the module hardcoded — and both performance figures default to null, so
  # an existing project's node pool renders exactly as it did.
  # The two performance figures arrive already resolved against the category (locals.tf) — the
  # module assigns them verbatim, so there is one place that decides which of Alibaba's two
  # mutually exclusive arguments is transmitted, and a test can read it.
  disk_category          = var.ack_disk_category
  disk_performance_level = local.ack_system_disk_performance_level
  disk_provisioned_iops  = local.ack_system_disk_provisioned_iops

  # Interruptible capacity (aws parity: eks_ng_capacity_type). NoSpot = on-demand = today.
  node_capacity_type = var.ack_node_capacity_type
  spot_price_limit   = local.ack_spot_price_limits

  tags = local.common_tags
}
