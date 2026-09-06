# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Cross-account KEYLESS OCI ECR Helm chart-repo pull identity (#1185) — the helm_registry analogue of
# registry-pull.tf (the image-pull side). When a project connects an ECR OCI Helm chart repo, an
# in-cluster refresher Deployment (argocd/alethia-helm-repo-pull) mints a short-lived ECR token — for a
# PRIVATE cross-account registry it assumes the customer's TARGET-account role (which trusts this
# cluster's OIDC and grants ECR pull); for ECR PUBLIC (public.ecr.aws) it reads under this cluster's own
# identity. This CLUSTER-side IRSA role grants ONLY `sts:AssumeRole` on the exact target-role list, plus
# (when a public repo is connected) `ecr-public:GetAuthorizationToken` — never broader. The ECR pull
# permissions for a private repo live on the customer's target role, not here (the target-side trust
# bootstrap). It rides its OWN guards (helm_repo_pull_*), separate from registry_provider /
# registry_pull_provider, so the native registry and the image-pull identity are untouched. Dark unless
# the runner sets the guards (ALETHIA_XACCT_HELM_ECR_ENABLED + a connected ECR chart repo).

variable "helm_repo_pull_target_role_arns" {
  description = "Cross-account role ARNs in the registry account(s) that the keyless OCI ECR Helm refresher assumes to mint chart-pull tokens. Set by the runner from each ECR helm_registry's provider_config.target_role_arn; empty unless a private ECR chart repo is connected."
  type        = list(string)
  default     = []
}

variable "helm_repo_pull_public_enabled" {
  description = "Whether any connected ECR OCI Helm chart repo is ECR Public (public.ecr.aws). When true the cluster identity is granted ecr-public:GetAuthorizationToken so the refresher can mint a public-registry token under its own IRSA (no cross-account role)."
  type        = bool
  default     = false
}

locals {
  # Two predicates, deliberately — see the same split in registry-pull.tf. What the OPERATOR ASKED
  # FOR is cluster-independent and is what checks_helm.tf must keep judging; what gets BUILT
  # additionally needs a cluster.
  helm_repo_pull_requested = length(var.helm_repo_pull_target_role_arns) > 0 || var.helm_repo_pull_public_enabled

  # `provision_eks` is part of the build predicate, not just of the role body (#1772): the IRSA role
  # below federates to module.eks[0].oidc_provider_arn, so a cluster-less shape with a connected ECR
  # chart repo failed at PLAN ("Invalid index … module.eks is empty tuple"). The refresher is an
  # in-cluster Deployment — with no cluster there is nothing to annotate. Azure's registry-pull.tf
  # carries its own `var.provision_aks` term for the same reason; this is the AWS parity.
  enable_helm_repo_pull = var.provision_eks && local.helm_repo_pull_requested
  # Coupling point with packages/core/manifests (the helm-repo-pull refresher KSA the wiring emits) —
  # the refresher lives in the argocd namespace, where ArgoCD reads repo credentials.
  helm_repo_pull_ksa_namespace = "argocd"
  helm_repo_pull_ksa_name      = "alethia-helm-repo-pull"

  # Least-privilege statements, assembled per what is connected. Both shapes use list-typed Action +
  # Resource so the concat elements share a type (Terraform requires it) and IAM accepts them.
  helm_repo_pull_statements = concat(
    length(var.helm_repo_pull_target_role_arns) > 0 ? [{
      Sid      = "AssumeTargetEcrRoles"
      Effect   = "Allow"
      Action   = ["sts:AssumeRole"]
      Resource = var.helm_repo_pull_target_role_arns
    }] : [],
    var.helm_repo_pull_public_enabled ? [{
      Sid      = "PublicEcrToken"
      Effect   = "Allow"
      Action   = ["ecr-public:GetAuthorizationToken", "sts:GetServiceBearerToken"]
      Resource = ["*"]
    }] : [],
  )
}

resource "aws_iam_policy" "helm_repo_pull" {
  count = local.enable_helm_repo_pull ? 1 : 0

  name_prefix = "helm_repo_pull"
  description = "Cross-account ECR OCI Helm chart-repo pull (assume the registry-account role(s) / read ECR Public) for cluster ${local.eks_name}"
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = local.helm_repo_pull_statements
  })
}

module "helm_repo_pull" {
  source  = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts-eks"
  count   = local.enable_helm_repo_pull ? 1 : 0
  version = "5.34.0"

  assume_role_condition_test = "StringEquals"
  create_role                = true
  role_name                  = "helm-repo-pull-${local.eks_name}"
  role_policy_arns = {
    helm_repo_pull = one(aws_iam_policy.helm_repo_pull[*].arn)
  }
  oidc_providers = {
    main = {
      provider_arn               = try(module.eks[0].oidc_provider_arn, null) != null ? module.eks[0].oidc_provider_arn : ""
      namespace_service_accounts = ["${local.helm_repo_pull_ksa_namespace}:${local.helm_repo_pull_ksa_name}"]
    }
  }
}

output "helm_repo_pull_irsa_arn" {
  description = "IRSA role ARN annotating the keyless OCI ECR Helm chart-repo pull refresher KSA (empty unless a keyless ECR chart repo is connected)."
  value       = try(module.helm_repo_pull[0].iam_role_arn, null) != null ? module.helm_repo_pull[0].iam_role_arn : ""
}
