output "vpc_id" {
  value = try(module.common_vpc[0].vpc_id, null) != null ? module.common_vpc[0].vpc_id : var.vpc_id
}

# Every cluster output below is guarded on the MODULE INSTANCE, never on a copy of its count
# predicate. The count is `var.provision_eks` today, and restating it here would be correct today
# and silently wrong the day the predicate grows a second term — the exact drift that made
# `provision_artifact_registry` diverge from its module on GCP (see gcp/outputs.tf). Until #1772
# these eight indexed [0] with NO guard at all, so `provision_eks = false` could not even PLAN:
#   Invalid index … module.eks is empty tuple.
#
# The guard is `try(module.eks[0].<out>, null) != null ? …`, not the `length(module.eks) > 0` these
# carried between #1772 and #3509. `length()` fixed the same crash but reads the module as a WHOLE,
# and that coarser edge closes dependency cycles elsewhere in this template — aws/rds.tf measured
# it, and its comment is where the whole rule is argued. Neither shape can drift from the count the
# way a duplicated predicate can; only one of them is safe in every position, so only one is used.
#
# `-refresh-only` is the second reason and the one that closed #3351: the count predicate can be
# TRUE while the module has no instance IN STATE, and no copy of the predicate can tell.
output "eks_cluster_arn" {
  value = try(module.eks[0].eks_cluster_arn, null) != null ? module.eks[0].eks_cluster_arn : null
}

output "eks_cluster_name" {
  value = try(module.eks[0].eks_cluster_id, null) != null ? module.eks[0].eks_cluster_id : null
}

output "eks_cluster_endpoint" {
  value = try(module.eks[0].eks_cluster_endpoint, null) != null ? module.eks[0].eks_cluster_endpoint : null
}

output "route53_zone_id" {
  description = "The Route 53 hosted zone id (created in-template when cloud_dns_enabled, else the existing dns_hosted_zone)."
  value       = try(module.route53[0].zone_id, null) != null ? module.route53[0].zone_id : var.dns_hosted_zone
}

output "route53_name_servers" {
  description = "Authoritative name servers for the created zone (delegate these at the registrar); empty when using an existing zone."
  value       = try(module.route53[0].name_servers, null) != null ? module.route53[0].name_servers : []
}

#output "eks_cluster_version" {
#  value = module.eks[0].eks_cluster_version
#}

output "eks_irsa_external_dns_arn" {
  value = try(module.eks[0].eks_irsa_external_dns_arn, null) != null ? module.eks[0].eks_irsa_external_dns_arn : null
}

output "eks_irsa_alb_controller_arn" {
  value = try(module.eks[0].eks_irsa_alb_controller_arn, null) != null ? module.eks[0].eks_irsa_alb_controller_arn : null
}

output "eks_irsa_external_secrets_arn" {
  description = "IRSA role ARN for the external-secrets operator (gates the AWS ClusterSecretStore render)"
  value       = try(module.eks[0].eks_irsa_external_secrets_arn, null) != null ? module.eks[0].eks_irsa_external_secrets_arn : null
}

output "rds_iam_auth_irsa_arn" {
  value = try(module.rds_iam_auth[0].iam_role_arn, null) != null ? module.rds_iam_auth[0].iam_role_arn : null
}

# Keyless DB auth (#722): the region the RDS auth-token refresher signs tokens for.
output "aws_region" {
  description = "AWS region (used by the keyless RDS auth-token refresher sidecar)"
  value       = var.region
}

output "node_iam_role_name" {
  value = try(module.eks[0].node_iam_role_name, null) != null ? module.eks[0].node_iam_role_name : null
}

output "node_security_group" {
  value = try(module.eks[0].node_security_group_id, null) != null ? module.eks[0].node_security_group_id : null
}

# AZ outputs are the greenfield subnet AZs (local.azs = region+a/b/c). On brownfield (provision_vpc
# = false) the cluster attaches to the user's existing subnets, which may live in OTHER AZs — so
# emitting the hardcoded region+a/b/c would LIE (#1352). We gate on provision_vpc and emit null
# there rather than a wrong AZ; the real per-subnet AZ is surfaced from cloud inventory in the UI,
# not computed here (data.aws_availability_zones is unknown at plan under assume-role — #551).
output "az1" {
  value = var.provision_vpc ? local.azs[0] : null
}

output "az2" {
  value = var.provision_vpc ? local.azs[1] : null
}

output "az3" {
  value = var.provision_vpc ? local.azs[2] : null
}

output "subnet1" {
  value = try(module.common_vpc[0].private_subnets, null) != null ? module.common_vpc[0].private_subnets[0] : try(var.vpc_private_subnet_ids[0], null)
}

output "subnet2" {
  value = try(module.common_vpc[0].private_subnets, null) != null ? module.common_vpc[0].private_subnets[1] : try(var.vpc_private_subnet_ids[1], null)
}

output "subnet3" {
  value = try(module.common_vpc[0].private_subnets, null) != null ? module.common_vpc[0].private_subnets[2] : try(var.vpc_private_subnet_ids[2], null)
}

## RDS
output "rds_cluster_endpoint" {
  description = "RDS Cluster endpoint"
  value       = try(module.rds_maindb[0].rds_cluster_endpoint, null) != null ? module.rds_maindb[0].rds_cluster_endpoint : null
}

output "rds_master_credentials_secret_arn" {
  description = "RDS Master Credentials Secret ARN"
  value       = try(module.rds_maindb[0].rds_master_credentials_secret_arn, null) != null ? module.rds_maindb[0].rds_master_credentials_secret_arn : null
}

output "rds_master_credentials_secret_name" {
  description = "RDS Master Credentials Secret Name"
  value       = try(module.rds_maindb[0].rds_master_credentials_secret_name, null) != null ? module.rds_maindb[0].rds_master_credentials_secret_name : null
}

# Keyless bootstrap (#722 R5): the initial database name — the bootstrap Job's admin connection target
# (PGDATABASE) and the object in its `GRANT CONNECT ON DATABASE` for the app's least-priv role.
output "rds_database_name" {
  description = "Initial RDS database name (the keyless bootstrap Job's admin connection target, #722)"
  value       = var.create_rds ? var.rds_config.db_name : null
}

output "rds_extra_credentials_secret_arn" {
  description = "RDS Extra Credentials Secret ARN"
  value       = try(module.rds_maindb[0].rds_extra_credentials_secret_arn, null) != null ? module.rds_maindb[0].rds_extra_credentials_secret_arn : null
}

output "rds_extra_credentials_secret_name" {
  description = "RDS Extra Credentials Secret Name"
  value       = try(module.rds_maindb[0].rds_extra_credentials_secret_name, null) != null ? module.rds_maindb[0].rds_extra_credentials_secret_name : null
}

output "rds_cluster_identifier" {
  description = "The RDS Cluster Identifier"
  value       = try(module.rds_maindb[0].rds_cluster_identifier, null) != null ? module.rds_maindb[0].rds_cluster_identifier : null
}

output "rds_cluster_arn" {
  description = "The RDS Cluster ARN"
  value       = try(module.rds_maindb[0].rds_cluster_arn, null) != null ? module.rds_maindb[0].rds_cluster_arn : null
}

# Keyless RDS IAM auth (#1504): the cluster resource id (cluster-XXXX) that scopes the app's
# rds-db:connect ARN to THIS cluster instead of the current dbuser:*/alethia_app wildcard (#1509).
output "rds_cluster_resource_id" {
  description = "The RDS Cluster resource id (cluster-XXXX) — scopes the keyless rds-db:connect ARN"
  value       = try(module.rds_maindb[0].rds_cluster_resource_id, null) != null ? module.rds_maindb[0].rds_cluster_resource_id : null
}

output "rds_credentials_kms_key_arn" {
  description = "RDS Credentials kms key arn"
  value       = try(module.rds_maindb[0].rds_credentials_kms_key_arn, null) != null ? module.rds_maindb[0].rds_credentials_kms_key_arn : null
}

# ACM
output "acm_certificate_arn" {
  description = "Wildcard ACM certificate ARN for the configured domain"
  value       = try(module.acm[0].acm_certificate_arn, null) != null ? module.acm[0].acm_certificate_arn : null
}

# WAF
# Read by the runner (argocd.InfraFacts.WAFWebACLArn) and attached to the ArgoCD ALB ingress via the
# alb.ingress.kubernetes.io/wafv2-acl-arn annotation. REGIONAL scope, which is the only scope an ALB
# can associate with — the CloudFront-scoped ACL next door is deliberately not exported here.
output "waf_webacl_arn" {
  description = "Regional WAFv2 web ACL ARN for the application WAF — the ALB ingress associates with it"
  value       = var.application_waf_enabled ? module.wafv2_application.webacl_arn : null
}

# ECR
output "ecr_repository_names" {
  description = "Names of the repository"
  value       = module.ecr.repository_names
}
output "ecr_repository_urls_map" {
  description = "Repository URLs keyed by the component's logical name (registry / service name) — the W2 BUILD job and the manifest renderer resolve each service's push destination here"
  value       = module.ecr.repository_urls_map
}
output "ecr_build_role_arn" {
  description = "IRSA role ARN the in-cluster build ServiceAccount assumes to push images (W2 kaniko builds)"
  value       = try(module.irsa_ecr_build[0].iam_role_arn, null) != null ? module.irsa_ecr_build[0].iam_role_arn : null
}
output "ecr_build_service_account" {
  description = "The namespace:serviceaccount the build IRSA role trusts — the kaniko Job renderer must schedule builds under exactly this identity"
  # Guarded on the ROLE, not on provision_ecr: the pair must resolve together. Naming an identity the
  # renderer would schedule builds under while ecr_build_role_arn is null hands it a ServiceAccount
  # that can push nothing (#1772 — the role now also requires provision_eks).
  #
  # `length()` and not the instance probe every other module reference in this file now uses (#3509):
  # this value is a LOCAL, so there is no module output to probe. A pure existence test is the only
  # shape that expresses "does the role exist", and the whole-module edge it costs cannot cycle from
  # a root output, which is a graph leaf.
  value = length(module.irsa_ecr_build) > 0 ? "${local.ecr_build_namespace}:${local.ecr_build_service_account}" : null
}

# ElastiCache — Redis (replication group) or Valkey (serverless)
#
# ONE pair of output names for both engines, because the consumer is engine-blind: `endpointOutputKey`
# (packages/core/manifests/generate.go) maps cloud+kind to a single output name, so a service bound to
# "the cache" reads `redis_primary_endpoint_address` whichever engine backs it. Naming the Valkey
# endpoint separately would force every consumer to learn the engine, and one that forgot would
# silently resolve to null — the exact failure this lane exists to remove.
#
# The two toggles are mutually exclusive (the provider derives both from the one chosen engine), so
# at most one side is non-null.

output "redis_reader_endpoint_address" {
  description = "Read-only cache endpoint, when the provisioned engine exposes one"
  value = try(coalesce(
    try(module.elasticache[0].redis_reader_endpoint_address, null) != null ? module.elasticache[0].redis_reader_endpoint_address : null,
    try(module.valey[0].valkey_reader_endpoint_address, null) != null ? module.valey[0].valkey_reader_endpoint_address : null,
  ), null)
}

output "redis_primary_endpoint_address" {
  description = "Primary cache endpoint — Redis replication group or serverless Valkey, whichever was provisioned"
  value = try(coalesce(
    try(module.elasticache[0].redis_primary_endpoint_address, null) != null ? module.elasticache[0].redis_primary_endpoint_address : null,
    try(module.valey[0].valkey_primary_endpoint_address, null) != null ? module.valey[0].valkey_primary_endpoint_address : null,
  ), null)
}
output "irsa_rds_role_arn" {
  description = "ARN of the IAM Role for access to rds database"
  value       = try(module.rds_iam_auth[0].iam_role_arn, null) != null ? module.rds_iam_auth[0].iam_role_arn : null
}

output "karpenter_queue_name" {
  description = "Interruption queue name for karpenter"
  value       = try(module.karpenter[0].queue_name, null) != null ? module.karpenter[0].queue_name : null
}


# The ONE output on this file whose module guard is not sufficient on its own. module.irsa_karpenter
# counts on `provision_eks` alone — deliberately, see the note at irsa.tf, so an already-applied
# cluster does not churn its IAM — while `enable_karpenter` DEFAULTS TO FALSE. Guarding on the module
# alone would therefore flip this output from null to a live role ARN on the ordinary greenfield
# shape (provision_eks = true, enable_karpenter = false) and tell any consumer that Karpenter is
# installed when it is not. Both terms are required: the feature must be ON and the role must EXIST.
output "karpenter_sa_role" {
  description = "IRSA role for karpenter SA"
  value       = var.enable_karpenter && try(module.irsa_karpenter[0].iam_role_arn, null) != null ? module.irsa_karpenter[0].iam_role_arn : null
}

# Label-at-source for Karpenter-launched EC2 (BYOC A1.2). Karpenter provisions instances/volumes
# via its OWN ec2:CreateFleet/RunInstances calls — NOT via OpenTofu — so the provider `default_tags`
# (main.tf) and the EKS module `tags` NEVER reach them. The ONLY lever that stamps the classification
# + sweep-handle tags (alethia:project-id / alethia:environment-id) onto Karpenter nodes is
# `spec.tags` on the EC2NodeClass CR, which is applied post-apply by the runner. This output surfaces
# the exact tag map (local.aws_default_tags — classification/sweep handles merged UNDER the winning
# platform base tags, identical to eks_tags / the EBS-CSI extraVolumeTags) so the EC2NodeClass
# renderer stamps it verbatim. Without it a guarded, environment-scoped sweeper cannot reclaim
# Karpenter-launched EC2 (the CSI-PVC / orphan-instance leak class, gap G2). The tags are
# non-sensitive, so harvesting this output into execution_metadata is safe.
output "karpenter_node_tags" {
  description = "Tag map the Karpenter EC2NodeClass spec.tags MUST carry so Karpenter-launched EC2/EBS inherit the classification + sweep-handle tags (provider default_tags do not reach Karpenter resources). Null when Karpenter is disabled."
  # Guarded on module.karpenter, matching its sibling karpenter_queue_name (and therefore also
  # carrying `provision_eks`, which module.karpenter's count gained in #1772). On `enable_karpenter =
  # true, provision_eks = false` the raw-flag form emitted a live tag map for an EC2NodeClass that
  # will never be rendered — this output IS consumed (packages/core/provisioner/karpenter.go), so a
  # non-null there is a positive claim about a Karpenter that does not exist. Unchanged on greenfield.
  #
  # `length()` rather than the instance probe, for the same reason as ecr_build_service_account: the
  # value is a LOCAL, so there is no output to probe, and a root output cannot cycle (#3509).
  value = length(module.karpenter) > 0 ? local.aws_default_tags : null
}

output "fluentbit_sa_role_arn" {
  description = "IAM Role ARN for Fluent Bit Service Account"
  value       = try(module.irsa_fluentbit_cloudwatch[0].iam_role_arn, null) != null ? module.irsa_fluentbit_cloudwatch[0].iam_role_arn : null
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

# NOTE: The plaintext generated secret VALUES are intentionally NOT exported as a root
# output. The runner harvests root outputs into jobs.execution_metadata (persisted in the
# console Postgres), so re-exporting `module.custom_secrets_password_module.secret_values`
# leaked cleartext credentials into the DB. The values already live in AWS Secrets Manager;
# consumers use `custom_secret_arns` / `custom_secret_names` / `custom_secret_versions` to
# fetch them. The module keeps its `secret_values` output for in-module version seeding only.

output "region_short" {
  value = local.aws_regions_short[var.region]
}