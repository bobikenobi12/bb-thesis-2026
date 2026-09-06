# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

#########################################################################
##            Workload Identity (RRSA) for cluster add-ons             ##
#########################################################################
# RAM role for the external-secrets operator, trusted via the cluster's RRSA OIDC
# provider (RAM Roles for Service Accounts), so the alibaba ClusterSecretStore reads
# KMS Secrets Manager with NO static AccessKey. The role ARN is exported as
# `external_secrets_ram_role_arn` and rendered into the store's auth.rrsa block by the
# ArgoCD Application. This is the Alibaba analogue of the AWS IRSA role the EKS path uses.

data "alicloud_account" "current" {}

locals {
  # The role only exists when there are native KMS secrets to read (mirrors kms.tf's guard)
  # AND the ACK cluster (whose RRSA provider the trust policy needs) is provisioned.
  eso_rrsa_enabled = var.provision_ack && length(var.custom_secrets) > 0 && var.secrets_provider == "native"
}

resource "alicloud_ram_role" "external_secrets" {
  count = local.eso_rrsa_enabled ? 1 : 0

  role_name   = "${local.name_prefix}-extsecrets"
  description = "external-secrets operator RRSA role for cluster ${local.ack_name} — keyless read of the project's KMS secrets."

  # Trust ONLY this cluster's RRSA OIDC provider, and only the operator's exact
  # ServiceAccount subject + the fixed RRSA audience — any other pod/SA is rejected.
  assume_role_policy_document = jsonencode({
    Version = "1"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Federated = try(module.cluster[0].rrsa_oidc_provider_arn, null) != null ? [module.cluster[0].rrsa_oidc_provider_arn] : [] }
      Condition = {
        StringEquals = {
          "oidc:iss" = try(module.cluster[0].rrsa_oidc_issuer_url, null) != null ? module.cluster[0].rrsa_oidc_issuer_url : ""
          "oidc:aud" = "sts.aliyuncs.com"
          "oidc:sub" = "system:serviceaccount:external-secrets-operator:external-secrets-operator-sa"
        }
      }
    }]
  })

  max_session_duration = 3600
}

# Least-privilege: read-only on the PROJECT'S secrets only. modules/kms names every secret
# "<secret_prefix>-<name>" (see kms.tf / locals.tf), so the grant is scoped to that name
# prefix — never account-wide "*".
resource "alicloud_ram_policy" "external_secrets_read" {
  count = local.eso_rrsa_enabled ? 1 : 0

  policy_name = "${local.name_prefix}-extsecrets-read"
  description = "Read-only access to the ${local.secret_prefix}-* KMS secrets for the external-secrets operator."
  policy_document = jsonencode({
    Version = "1"
    Statement = [{
      Effect   = "Allow"
      Action   = ["kms:GetSecretValue", "kms:DescribeSecret"]
      Resource = ["acs:kms:${var.region}:${data.alicloud_account.current.id}:secret/${local.secret_prefix}-*"]
    }]
  })
}

resource "alicloud_ram_role_policy_attachment" "external_secrets_read" {
  count = local.eso_rrsa_enabled ? 1 : 0

  role_name   = one(alicloud_ram_role.external_secrets[*].id)
  policy_name = one(alicloud_ram_policy.external_secrets_read[*].policy_name)
  policy_type = "Custom"
}
