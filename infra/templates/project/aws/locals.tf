locals {
  aws_regions_short = {
    "ap-east-1"      = "ae1"
    "ap-northeast-1" = "an1"
    "ap-northeast-2" = "an2"
    "ap-northeast-3" = "an3"
    "ap-south-1"     = "as0"
    "ap-southeast-1" = "as1"
    "ap-southeast-2" = "as2"
    "ca-central-1"   = "cc1"
    "eu-central-1"   = "ec1"
    "eu-north-1"     = "en1"
    "eu-south-1"     = "es1"
    "eu-west-1"      = "ew1"
    "eu-west-2"      = "ew2"
    "eu-west-3"      = "ew3"
    "af-south-1"     = "fs1"
    "me-south-1"     = "ms1"
    "sa-east-1"      = "se1"
    "us-east-1"      = "ue1"
    "us-east-2"      = "ue2"
    "us-west-1"      = "uw1"
    "us-west-2"      = "uw2"
  }

  # Platform base tags. Classification + sweep-handle tags (var.classification_tags) are merged in
  # UNDER these — base tags sit on the merge RHS so they always WIN a key collision, keeping the
  # sweep handles and platform bookkeeping authoritative. This local fans out to ECR, EKS, the VPC,
  # RDS, ElastiCache and SQS (see the `*_tags`/`resources_tags` module inputs), and via the EKS
  # module into the EBS-CSI driver's extraVolumeTags for dynamically-provisioned volumes.
  aws_base_tags = {
    "platform:environment" = "${var.environment}"
    "platform:customer"    = "${var.project_name}"
    "Project"              = "${var.project_name}"
    "Environment"          = "${var.environment}"
    "CostCenter"           = "n/a"
    "Application"          = "alethia"
    "ManagedBy"            = "opentofu"
  }

  aws_default_tags = merge(var.classification_tags, local.aws_base_tags)


  # Exactly three AZs, derived statically from the region (a/b/c) so `length(local.azs)` is known at
  # PLAN time. The VPC module's NAT/subnet `count`s are `length(azs)`; sourcing azs from
  # `data.aws_availability_zones` makes them unknown under the runner's assume-role provider (resolved
  # only at apply) → `tofu plan -out` fails "Invalid count argument" (#551). The subnet lists are
  # hardcoded to three, so three AZs is also the correct count (not the ~6 the data source returns).
  azs = ["${var.region}a", "${var.region}b", "${var.region}c"]

  vpc_name = "vpc-${local.aws_regions_short[var.region]}-${var.environment}-${var.project_name}-common"

  vpc_s3_endpoint_name = "s3-gateway-vpc-${local.aws_regions_short[var.region]}-${var.environment}-${var.project_name}-common"

  eks_name = "eks-${local.aws_regions_short[var.region]}-${var.environment}-${var.project_name}"

  # compact function will remove null elements from list to not interfere with jsonencode afterwards
  secrets_kms_key_arns = compact([
    try(module.rds_maindb[0].rds_credentials_kms_key_arn, null) != null ? module.rds_maindb[0].rds_credentials_kms_key_arn : null,
    try(module.elasticache[0].redis_secret_kms_key_arn, null) != null ? module.elasticache[0].redis_secret_kms_key_arn : null
  ])

  # Secrets the external-secrets operator may read: the project's custom secrets (their names all
  # share the awssm-passgen prefix, see custom_secrets.tf — the trailing * also covers the random
  # 6-char suffix Secrets Manager appends to every ARN) plus the RDS credential secrets. This
  # scopes the operator's IRSA policy to the project's secrets — never account-wide "*".
  eso_secret_arns = concat(
    ["arn:aws:secretsmanager:${var.region}:${var.aws_account_id}:secret:${local.aws_regions_short[var.region]}-${var.environment}-${var.project_name}-*"],
    compact([
      try(module.rds_maindb[0].rds_master_credentials_secret_arn, null) != null ? module.rds_maindb[0].rds_master_credentials_secret_arn : null,
      try(module.rds_maindb[0].rds_extra_credentials_secret_arn, null) != null ? module.rds_maindb[0].rds_extra_credentials_secret_arn : null,
    ])
  )

  karpenter_queue_name           = "queue-${var.region}-${var.environment}-karpenter"
  karpenter_namespace            = "karpenter"
  karpenter_service_account_name = "karpenter"

  redis_allowed_cidr_blocks = concat(var.redis_allowed_cidr_blocks, [var.vpc_cidr])

}

