# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# external-secrets + cross-account Secrets Manager invariants.
# Split out of checks.tf so each feature owns its file (IaC rule: one file per component).
# Add new checks for THIS feature here; never append to checks.tf.


# The external-secrets operator's IRSA role must exist whenever EKS is provisioned — without it
# the AWS ClusterSecretStore is (correctly) not rendered and ExternalSecrets can never sync.
check "eks_irsa_external_secrets_arn_present" {
  assert {
    condition     = !var.provision_eks || length(trimspace(try(module.eks[0].eks_irsa_external_secrets_arn, null) != null ? module.eks[0].eks_irsa_external_secrets_arn : "")) > 0
    error_message = "provision_eks is true but the external-secrets IRSA role reported no ARN — the ESO ClusterSecretStore cannot authenticate."
  }
}


# Cross-account Secrets Manager (#1262): if aws-sm-xacct is selected, the external-secrets IRSA role
# needs a target-account role to assume — a missing ARN is a misconfigured connector, so fail loudly.
check "secrets_xacct_target_configured" {
  assert {
    condition     = var.secrets_xacct_provider != "aws-sm-xacct" || var.secrets_xacct_target_role_arn != ""
    error_message = "secrets_xacct_provider = aws-sm-xacct requires secrets_xacct_target_role_arn (the target-account role the external-secrets operator assumes for cross-account Secrets Manager read)."
  }
}
