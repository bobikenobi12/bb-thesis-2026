module "valey" {

  source = "git::git@github.com:itgix/tf-module-valkey.git?ref=main"

  count = var.create_elasticache_valkey ? 1 : 0

  aws_region   = var.region
  environment  = var.environment
  product_name = var.project_name

  vpc_id     = var.provision_vpc ? module.common_vpc[0].vpc_id : var.vpc_id
  subnet_ids = var.provision_vpc ? slice(module.common_vpc[0].database_subnets, 0, 2) : var.vpc_private_subnet_ids

  redis_allowed_security_group_ids = var.redis_allowed_security_group_ids

  snapshot_time                 = var.valkey_snapshot_time
  engine_version                = var.valkey_engine_version
  data_storage_max              = var.valkey_data_storage_max
  ecpu_per_second_max           = var.valkey_ecpu_per_second_max
  create_valkey_user_and_secret = var.valkey_create_valkey_user_and_secret

}