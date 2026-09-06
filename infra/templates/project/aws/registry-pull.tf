# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Cross-account KEYLESS ECR pull identity (PR B). When a project selects the `ecr-xacct` registry, an
# in-cluster refresher Deployment (default/alethia-registry-pull) assumes the customer's TARGET-account
# role to mint a short-lived ECR pull token — no stored key. This CLUSTER-side IRSA role grants ONLY
# `sts:AssumeRole` on that one target role; the ECR pull permissions live on the target role, which the
# customer creates in the registry account and trusts this cluster's OIDC (the "trust bootstrap" —
# target-side, see the PR B design doc). It rides `registry_pull_provider`, NOT `registry_provider`, so
# the cluster's own native ECR repo is untouched.

variable "registry_pull_target_role_arn" {
  description = "Cross-account role ARN in the registry account that the ecr-xacct refresher assumes to mint ECR pull tokens. Set by the runner from provider_config.target_role_arn; empty unless registry_pull_provider = ecr-xacct."
  type        = string
  default     = ""
}

locals {
  # Two predicates, deliberately. What the OPERATOR ASKED FOR is cluster-independent and is what the
  # misconfiguration checks in checks_registry.tf must keep judging; what gets BUILT additionally
  # needs a cluster. Folding the cluster term into a single local would have silently disarmed those
  # checks on every cluster-less shape — a wrong `registry_pull_target_role_arn` would then plan
  # clean and be discovered when a pod could not pull.
  ecr_pull_requested = var.registry_pull_provider == "ecr-xacct"

  # `provision_eks` is part of the build predicate (#1772): the IRSA role below federates to
  # module.eks[0].oidc_provider_arn, so `registry_pull_provider = ecr-xacct` on a cluster-less shape
  # failed at PLAN ("Invalid index … module.eks is empty tuple"). The refresher is an in-cluster
  # Deployment — with no cluster there is no KSA to annotate. Azure's registry-pull.tf already
  # includes `var.provision_aks` in the identical local; this is the AWS parity.
  enable_ecr_pull = var.provision_eks && local.ecr_pull_requested
  # Coupling point with packages/core/manifests (the registry-pull refresher KSA the wiring PR emits).
  registry_pull_ksa_namespace = "default"
  registry_pull_ksa_name      = "alethia-registry-pull"
}

resource "aws_iam_policy" "ecr_pull_xacct" {
  count = local.enable_ecr_pull ? 1 : 0

  name_prefix = "ecr_pull_xacct"
  description = "Cross-account ECR pull (assume the registry-account role) for cluster ${local.eks_name}"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "AssumeTargetEcrRole"
      Effect   = "Allow"
      Action   = "sts:AssumeRole"
      Resource = var.registry_pull_target_role_arn
    }]
  })
}

module "ecr_pull_xacct" {
  source  = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts-eks"
  count   = local.enable_ecr_pull ? 1 : 0
  version = "5.34.0"

  assume_role_condition_test = "StringEquals"
  create_role                = true
  role_name                  = "ecr-pull-xacct-${local.eks_name}"
  role_policy_arns = {
    ecr_pull = one(aws_iam_policy.ecr_pull_xacct[*].arn)
  }
  oidc_providers = {
    main = {
      provider_arn               = try(module.eks[0].oidc_provider_arn, null) != null ? module.eks[0].oidc_provider_arn : ""
      namespace_service_accounts = ["${local.registry_pull_ksa_namespace}:${local.registry_pull_ksa_name}"]
    }
  }
}

output "ecr_pull_irsa_arn" {
  description = "IRSA role ARN annotating the cross-account ECR pull refresher KSA (empty unless ecr-xacct)."
  value       = try(module.ecr_pull_xacct[0].iam_role_arn, null) != null ? module.ecr_pull_xacct[0].iam_role_arn : ""
}
