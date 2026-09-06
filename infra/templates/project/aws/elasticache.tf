module "elasticache" {

  source = "./modules/redis"

  count = var.create_elasticache_redis ? 1 : 0

  aws_region   = var.region
  environment  = var.environment
  product_name = var.project_name

  # Derived at the root (checks_naming.tf, NAMING-004) rather than composed inside the module, so
  # the length budget against ElastiCache's 40-character cap is reachable from `tofu test`.
  redis_name                = local.aws_redis_name
  redis_user_name           = local.aws_redis_user_name
  redis_user_group_name     = local.aws_redis_user_group_name
  redis_default_user_id     = local.aws_redis_default_user_id
  aws_elasticache_user_name = var.aws_elasticache_user_name

  vpc_id                     = try(module.common_vpc[0].vpc_id, null) != null ? module.common_vpc[0].vpc_id : var.vpc_id
  subnet_ids                 = try(module.common_vpc[0].database_subnets, null) != null ? slice(module.common_vpc[0].database_subnets, 0, 2) : var.vpc_private_subnet_ids
  cluster_size               = var.redis_cluster_size
  instance_type              = var.redis_instance_type
  automatic_failover_enabled = var.redis_automatic_failover_enabled
  multi_az_enabled           = var.redis_multi_az_enabled
  engine_version             = var.redis_engine_version
  family                     = var.redis_family
  allowed_cidr_blocks        = local.redis_allowed_cidr_blocks
  allowed_security_group_ids = var.redis_allowed_security_group_ids
  redis_tags                 = local.aws_default_tags

}
