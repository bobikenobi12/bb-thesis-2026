module "valey" {

  source = "./modules/valkey"

  count = var.create_elasticache_valkey ? 1 : 0

  aws_region   = var.region
  environment  = var.environment
  product_name = var.project_name

  vpc_id     = try(module.common_vpc[0].vpc_id, null) != null ? module.common_vpc[0].vpc_id : var.vpc_id
  subnet_ids = try(module.common_vpc[0].database_subnets, null) != null ? slice(module.common_vpc[0].database_subnets, 0, 2) : var.vpc_private_subnet_ids

  redis_allowed_security_group_ids = var.redis_allowed_security_group_ids

  snapshot_time                 = var.valkey_snapshot_time
  engine_version                = var.valkey_engine_version
  data_storage_max              = var.valkey_data_storage_max
  ecpu_per_second_max           = var.valkey_ecpu_per_second_max
  create_valkey_user_and_secret = var.valkey_create_valkey_user_and_secret

}