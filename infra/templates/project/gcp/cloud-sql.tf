module "cloud_sql" {
  source = "./modules/cloud-sql"
  count  = var.create_cloud_sql ? 1 : 0

  depends_on = [module.vpc_network]

  project_id   = var.project_id
  region       = local.gcp_region_key
  environment  = var.environment
  project_name = var.project_name

  network_self_link = try(module.vpc_network[0].network_self_link, null) != null ? module.vpc_network[0].network_self_link : var.network_id

  engine         = var.cloud_sql_engine
  engine_version = var.cloud_sql_engine_version
  edition        = var.cloud_sql_edition
  tier           = var.cloud_sql_tier
  disk_size      = var.cloud_sql_disk_size

  high_availability = var.cloud_sql_high_availability

  backup_enabled        = var.cloud_sql_backup_enabled
  backup_retention_days = var.cloud_sql_backup_retention_days

  iam_auth = var.cloud_sql_iam_auth
  port     = var.cloud_sql_port

  # Keyless app DB user (#722): when IAM auth is on, register the app GSA as a
  # CLOUD_IAM_SERVICE_ACCOUNT database user so the workload logs in with an IAM token, no password.
  app_iam_sa_email = local.enable_app_db_iam ? one(data.google_service_account.app_db_adopted[*].email) : null

  authorized_networks = var.cloud_sql_authorized_networks

  labels = local.gcp_default_labels
}
