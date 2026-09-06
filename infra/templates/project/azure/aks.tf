module "aks" {
  source = "./modules/aks"
  count  = var.provision_aks ? 1 : 0

  # The role assignment is a HARD dependency, not an ordering preference: AKS encrypts as its own
  # identity, and a cluster created against a key that identity cannot yet use fails outright
  # (#2004).
  depends_on = [module.vnet, azurerm_role_assignment.aks_secrets_kms]

  location        = var.location
  environment     = var.environment
  project_name    = var.project_name
  cluster_name    = local.aks_name
  cluster_version = var.aks_cluster_version

  cluster_identity_id = local.azure_secrets_encryption ? one(azurerm_user_assigned_identity.aks[*].id) : ""
  secrets_kms_key_id  = local.azure_secrets_encryption ? one(azurerm_key_vault_key.aks_secrets[*].id) : ""

  # Derived in checks_naming.tf (NAMING-002), not left to Azure: the auto-derived
  # "MC_<resource_group>_<cluster_name>_<location>" rendered 82 characters against an 80-character
  # cap on the e2e nightly and failed the apply mid-create (#1921).
  node_resource_group = local.azure_aks_node_resource_group
  resource_group_name = azurerm_resource_group.main.name
  vnet_subnet_id      = try(module.vnet[0].private_subnet_id, null) != null ? module.vnet[0].private_subnet_id : one(data.azurerm_subnet.existing[*].id)

  machine_types     = var.aks_instance_types
  node_min_size     = var.aks_node_min_size
  node_max_size     = var.aks_node_max_size
  node_desired_size = var.aks_node_desired_size
  disk_size_gb      = var.aks_disk_size_gb

  # OS-disk PLACEMENT (Managed vs Ephemeral). Null by default = the argument is not rendered, so
  # every existing cluster plans unchanged. AKS carries no OS-disk SKU or IOPS to expose.
  os_disk_type = var.aks_os_disk_type

  # Spot node pool (aws parity: eks_ng_capacity_type). Off by default; when on it is an ADDITIONAL
  # pool beside the on-demand ones, because AKS refuses a Spot default pool and the three spot
  # arguments are ForceNew.
  spot_enabled         = var.aks_spot_enabled
  spot_max_price       = var.aks_spot_max_price
  spot_eviction_policy = var.aks_spot_eviction_policy
  spot_node_min_size   = var.aks_spot_node_min_size
  spot_node_max_size   = var.aks_spot_node_max_size

  # BYOC B4.1 access-control knobs (both default-empty = behavior-preserving)
  admin_group_object_ids = var.aks_admin_group_object_ids
  authorized_ip_ranges   = var.aks_authorized_ip_ranges

  # BYOC AZ-SELF-ADMIN — grant the apply/runner identity RBAC Cluster Admin (default true).
  enable_creator_admin = var.aks_enable_creator_admin

  tags = local.azure_default_tags
}
