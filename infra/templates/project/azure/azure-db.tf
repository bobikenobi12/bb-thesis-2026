module "azure_db" {
  source = "./modules/azure-db"
  count  = var.create_azure_db ? 1 : 0

  depends_on = [module.vnet]

  location            = var.location
  environment         = var.environment
  project_name        = var.project_name
  resource_group_name = azurerm_resource_group.main.name

  engine                = var.azure_db_engine
  engine_version        = var.azure_db_engine_version
  sku_name              = var.azure_db_sku_name
  storage_mb            = var.azure_db_storage_mb
  high_availability     = var.azure_db_high_availability
  backup_retention_days = var.azure_db_backup_retention_days
  port                  = var.azure_db_port
  iam_auth              = var.azure_db_iam_auth
  subnet_id             = try(module.vnet[0].database_subnet_id, null) != null ? module.vnet[0].database_subnet_id : var.vnet_id

  # MySQL validates Entra tokens with an identity attached to the SERVER (PostgreSQL takes an inline
  # authentication block instead). The dedicated db_admin identity doubles as it, so no third identity
  # exists and the app identity still never holds admin rights. Empty ⇒ Entra auth stays off.
  aad_identity_id = local.enable_mysql_entra ? one(azurerm_user_assigned_identity.db_admin[*].id) : ""

  # BYOC B4.1 DB CIDR allow-list (default-empty = behavior-preserving)
  allowed_cidrs = var.azure_db_allowed_cidrs

  tags = local.azure_default_tags
}
