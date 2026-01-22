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

  aws_default_tags = {
    "platform:environment" = "${var.environment}"
    "platform:customer"    = "${var.project_name}"
    "Project"              = "${var.project_name}"
    "Environment"          = "${var.environment}"
    "CostCenter"           = "n/a"
    "Application"          = "adp"
    "ManagedBy"            = "Terraform"
  }


  vpc_name = "vpc-${local.aws_regions_short[var.region]}-${var.environment}-${var.project_name}-common"

  vpc_s3_endpoint_name = "s3-gateway-vpc-${local.aws_regions_short[var.region]}-${var.environment}-${var.project_name}-common"

  eks_name = "eks-${local.aws_regions_short[var.region]}-${var.environment}-${var.project_name}"

  # compact function will remove null elements from list to not interfere with jsonencode afterwards
  secrets_kms_key_arns = compact([
    length(module.rds_maindb) > 0 ? module.rds_maindb[0].rds_credentials_kms_key_arn : null,
    length(module.elasticache) > 0 ? module.elasticache[0].redis_secret_kms_key_arn : null
  ])

  karpenter_queue_name           = "queue-${var.region}-${var.environment}-karpenter"
  karpenter_namespace            = "karpenter"
  karpenter_service_account_name = "karpenter"

  redis_allowed_cidr_blocks = concat(var.redis_allowed_cidr_blocks, [var.vpc_cidr])

}

