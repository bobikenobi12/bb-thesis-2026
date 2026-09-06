module "rds_maindb" {
  count = var.create_rds ? 1 : 0

  depends_on = [module.common_vpc]

  source = "./modules/rds"

  environment = var.environment

  aws_region     = var.region
  aws_account_id = var.aws_account_id
  project_name   = var.project_name

  rds_vpc_id  = try(module.common_vpc[0].vpc_id, null) != null ? module.common_vpc[0].vpc_id : var.vpc_id
  rds_subnets = try(module.common_vpc[0].database_subnets, null) != null ? module.common_vpc[0].database_subnets : var.vpc_private_subnet_ids
  # The cluster's node security group is what the DB admits traffic from — but a database is
  # provisionable WITHOUT a cluster (`create_rds = true, provision_eks = false`), and the unguarded
  # [0] failed the whole plan there (#1772). An empty list means "no cluster to admit";
  # rds_allowed_cidr_blocks remains the caller's other way in.
  #
  # THE SHAPE HERE IS THE TEMPLATE-WIDE RULE, and this site is where each rejected alternative was
  # measured. It is `try(module.eks[0].<out>, null) != null ? … : <fallback>` — a probe on ONE
  # OUTPUT OF ONE INSTANCE, with the traversal repeated OUTSIDE the try(). Three near-neighbours
  # all fail, each for a different reason:
  #
  #   - `length(module.eks) > 0` and `module.eks[*]` reference the module AS A WHOLE, and here that
  #     closes a dependency CYCLE `tofu validate` refuses outright: module.eks reads
  #     local.secrets_kms_key_arns + local.eso_secret_arns, both of which read module.rds_maindb,
  #     which would then wait on module.eks. (Those two locals now probe per instance for exactly
  #     this reason, which is what makes the aws graph robust rather than merely acyclic today.)
  #   - a bare `try(module.eks[0].node_security_group_id, [])` swallows every evaluation error, not
  #     just the empty-tuple one, so the day `node_security_group_id` is renamed in modules/eks a
  #     NORMAL `provision_eks = true` apply silently degrades to an Aurora cluster with no cluster
  #     ingress instead of failing the plan. Repeating the traversal outside the try() keeps that a
  #     validation error.
  #   - `var.provision_eks ?` — what this line used to say — adds no graph edge at all and IS
  #     short-circuited when known, which is why it was correct for #1772. It is wrong for #3351:
  #     under `tofu plan -refresh-only` the variable is TRUE while module.eks has no instance in
  #     state, so the index reaches an empty tuple and aborts the whole refresh. Only a predicate
  #     on the INSTANCE can tell those two states apart.
  #
  # Enforced by scripts/check-templates-refresh-safe.mjs; its header carries the full table (#3509).
  rds_security_groups = try(module.eks[0].node_security_group_id, null) != null ? [module.eks[0].node_security_group_id] : []

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
