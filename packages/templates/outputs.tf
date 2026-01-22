output "eks_cluster_arn" {
  value = module.eks[0].eks_cluster_arn
}

output "eks_cluster_name" {
  value = module.eks[0].eks_cluster_id
}

output "eks_cluster_endpoint" {
  value = module.eks[0].eks_cluster_endpoint
}

#output "eks_cluster_version" {
#  value = module.eks[0].eks_cluster_version
#}

output "eks_irsa_external_dns_arn" {
  value = module.eks[0].eks_irsa_external_dns_arn
}

output "rds_iam_auth_irsa_arn" {
  value = module.rds_iam_auth[0].iam_role_arn
}

output "node_iam_role_name" {
  value = module.eks[0].node_iam_role_name
}

output "node_security_group" {
  value = module.eks[0].node_security_group_id
}

output "az1" {
  value = data.aws_availability_zones.available.names[0]
}

output "az2" {
  value = data.aws_availability_zones.available.names[1]
}

output "az3" {
  value = data.aws_availability_zones.available.names[2]
}

output "subnet1" {
  value = var.provision_vpc ? module.common_vpc[0].private_subnets[0] : var.vpc_private_subnet_ids[0]
}

output "subnet2" {
  value = var.provision_vpc ? module.common_vpc[0].private_subnets[1] : var.vpc_private_subnet_ids[1]
}

output "subnet3" {
  value = var.provision_vpc ? module.common_vpc[0].private_subnets[2] : var.vpc_private_subnet_ids[2]
}

## RDS
output "rds_cluster_endpoint" {
  description = "RDS Cluster endpoint"
  value       = var.create_rds ? module.rds_maindb[0].rds_cluster_endpoint : null
}

output "rds_master_credentials_secret_arn" {
  description = "RDS Master Credentials Secret ARN"
  value       = var.create_rds ? module.rds_maindb[0].rds_master_credentials_secret_arn : null
}

output "rds_master_credentials_secret_name" {
  description = "RDS Master Credentials Secret Name"
  value       = var.create_rds ? module.rds_maindb[0].rds_master_credentials_secret_name : null
}

output "rds_extra_credentials_secret_arn" {
  description = "RDS Extra Credentials Secret ARN"
  value       = var.create_rds ? module.rds_maindb[0].rds_extra_credentials_secret_arn : null
}

output "rds_extra_credentials_secret_name" {
  description = "RDS Extra Credentials Secret Name"
  value       = var.create_rds ? module.rds_maindb[0].rds_extra_credentials_secret_name : null
}

output "rds_cluster_identifier" {
  description = "The RDS Cluster Identifier"
  value       = var.create_rds ? module.rds_maindb[0].rds_cluster_identifier : null
}

output "rds_cluster_arn" {
  description = "The RDS Cluster ARN"
  value       = var.create_rds ? module.rds_maindb[0].rds_cluster_arn : null
}

output "rds_credentials_kms_key_arn" {
  description = "RDS Credentials kms key arn"
  value       = var.create_rds ? module.rds_maindb[0].rds_credentials_kms_key_arn : null
}

# WAF
output "waf_webacl_arn" {
  description = "RDS Credentials kms key arn"
  value       = var.application_waf_enabled ? module.wafv2_application.webacl_arn : null
}

# ECR
output "ecr_repository_names" {
  description = "Names of the repository"
  value       = module.ecr.repository_names
}
output "ecr_repository_urls_map" {
  description = "The URL of the repositories"
  value       = module.ecr.repository_urls_map
}

# Elasticache Redis

output "redis_reader_endpoint_address" {
  description = "The address of the endpoint for the reader node in the replication group, if the cluster mode is disabled."
  value       = var.create_elasticache_redis ? module.elasticache[0].redis_reader_endpoint_address : null
}

output "redis_primary_endpoint_address" {
  description = "Redis primary or configuration endpoint, whichever is appropriate for the given cluster mode"
  value       = var.create_elasticache_redis ? module.elasticache[0].redis_primary_endpoint_address : null
}
output "irsa_rds_role_arn" {
  description = "ARN of the IAM Role for access to rds database"
  value       = var.create_elasticache_redis ? module.rds_iam_auth[0].iam_role_arn : null
}

output "karpenter_queue_name" {
  description = "Interruption queue name for karpenter"
  value       = var.enable_karpenter ? module.karpenter[0].queue_name : null
}


output "karpenter_sa_role" {
  description = "IRSA role for karpenter SA"
  value       = var.enable_karpenter ? module.irsa_karpenter.iam_role_arn : null
}

output "fluentbit_sa_role_arn" {
  description = "IAM Role ARN for Fluent Bit Service Account"
  value       = module.irsa_fluentbit_cloudwatch.iam_role_arn
}

# Custom Secrets

output "custom_secret_arns" {
  value = module.custom_secrets_password_module.secret_arns
}

output "custom_secret_names" {
  value = module.custom_secrets_password_module.secret_names
}

output "custom_secret_versions" {
  value = module.custom_secrets_password_module.secret_versions
}

output "custom_secret_values" {
  value     = module.custom_secrets_password_module.secret_values
  sensitive = true
}

output "region_short" {
  value = local.aws_regions_short[var.region]
}