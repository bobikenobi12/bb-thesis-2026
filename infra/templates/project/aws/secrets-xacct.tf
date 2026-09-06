# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Cross-account KEYLESS Secrets Manager read identity (#1262, part of #1206). When a project selects the
# `aws-sm-xacct` secrets connector, the in-cluster External Secrets Operator (running under its IRSA
# role) assumes the customer's TARGET-account role to read Secrets Manager across accounts — no stored
# key (ESO's `spec.provider.aws.role`). This CLUSTER-side change grants the EXISTING external-secrets
# IRSA role ONLY `sts:AssumeRole` on that one target role (least-privilege); the
# secretsmanager:GetSecretValue permission lives on the target role, which the customer creates in the
# secrets account and trusts this cluster's IRSA — the "trust bootstrap" (Model B, target-side, see
# infra/connector/aws/secrets-xacct). It rides `secrets_xacct_provider`, NOT `secrets_provider`, so the
# cluster's own native store is untouched.

variable "secrets_xacct_target_role_arn" {
  description = "Cross-account role ARN in the secrets account that the aws-sm-xacct External Secrets Operator assumes to read Secrets Manager. Set by the runner from provider_config.target_role_arn; empty unless secrets_xacct_provider = aws-sm-xacct."
  type        = string
  default     = ""
}

locals {
  enable_secrets_xacct = var.provision_eks && var.secrets_xacct_target_role_arn != ""
  # The external-secrets operator's IRSA role NAME, derived from its ARN
  # (arn:aws:iam::<acct>:role/<name>). ESO's operator ServiceAccount is annotated with this role, so
  # adding the assume permission here is what lets `spec.provider.aws.role` reach the target account.
  #
  # This local was NOT one of #1772's thirteen break sites, and the reasoning recorded here for why
  # the bare index was safe held for #1772 and NOT for #3351: (1) `enable_secrets_xacct` above
  # already carries `var.provision_eks`, so on a cluster-less shape the condition is FALSE; and
  # (2) OpenTofu SHORT-CIRCUITS a conditional whose condition is known at plan time. Both are still
  # true, and both are beside the point under `-refresh-only`, where the condition is TRUE —
  # `provision_eks` is set — while `module.eks` has no instance in state yet. The index then reaches
  # an empty tuple and aborts the whole refresh (#3351/#3509). The predicate had to move onto the
  # module instance itself; `enable_secrets_xacct` stays because it also carries the xacct feature
  # gate, which no module count expresses.
  #
  # STILL fail-closed, which is why this is a probe and not a `try()`. A bare
  # `try(module.eks[0].eks_irsa_external_secrets_arn, "")` would swallow a future RENAME of that
  # output into "" → `element(split("/", ""), 1)` → an aws_iam_role_policy with an empty `role`,
  # demoting a loud plan error into a mid-apply one on the greenfield path. Repeating the traversal
  # OUTSIDE the try() keeps a renamed output a validation error; only the empty tuple is caught.
  eso_irsa_role_name = local.enable_secrets_xacct && try(module.eks[0].eks_irsa_external_secrets_arn, null) != null ? element(split("/", module.eks[0].eks_irsa_external_secrets_arn), 1) : ""
}

resource "aws_iam_role_policy" "secrets_xacct_assume" {
  count = local.enable_secrets_xacct ? 1 : 0

  name = "alethia-secrets-xacct-assume"
  role = local.eso_irsa_role_name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "AssumeCrossAccountSecretsReadRole"
      Effect   = "Allow"
      Action   = "sts:AssumeRole"
      Resource = var.secrets_xacct_target_role_arn
    }]
  })
}
