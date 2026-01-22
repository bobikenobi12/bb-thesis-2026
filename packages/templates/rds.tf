module "rds_maindb" {
  count = var.create_rds ? 1 : 0

  depends_on = [module.common_vpc]

  source = "git::git@github.com:itgix/tf-module-rds.git?ref=v1.0.6"

  environment = var.environment

  aws_region     = var.region
  aws_account_id = var.aws_account_id
  project_name   = var.project_name

  rds_vpc_id          = var.provision_vpc ? module.common_vpc[0].vpc_id : var.vpc_id
  rds_subnets         = var.provision_vpc ? module.common_vpc[0].database_subnets : var.vpc_private_subnet_ids
  rds_security_groups = [module.eks[0].node_security_group_id]

  rds_allowed_cidr_blocks = var.rds_allowed_cidr_blocks

  rds_config = ({
    engine         = var.rds_config.engine
    engine_version = var.rds_config.engine_version
    engine_mode    = var.rds_config.engine_mode
    cluster_family = var.rds_config.cluster_family
    cluster_size   = var.rds_config.cluster_size
    db_port        = var.rds_config.db_port
    db_name        = var.rds_config.db_name
  })

  rds_scaling_config = var.rds_scaling_config
  rds_instance_type  = var.rds_instance_type

  rds_iam_auth_enabled = var.rds_iam_auth_enabled
  rds_default_username = var.rds_default_username

  rds_logs_exports = var.rds_logs_exports

  #enable_rds_s3_exports = var.enable_rds_s3_exports

  rds_tags = local.aws_default_tags

  rds_backup_retention_period = var.rds_backup_retention_period

  rds_cluster_parameters = var.rds_cluster_parameters
}
