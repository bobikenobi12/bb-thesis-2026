# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Cross-subscription KEYLESS ACR pull identity (PR B). When a project selects the `acr-xacct` registry,
# the in-cluster refresher (default/alethia-registry-pull) gets an AAD token via this user-assigned
# managed identity (federated through AKS Workload Identity) and exchanges it for an ACR refresh token
# against the TARGET ACR — no stored key. It works cross-subscription because the target ACR granted
# this identity AcrPull (the "trust bootstrap" — target-side, see the PR B design doc). Cluster-side we
# only create the UAMI + federated credential + expose its client id; it rides `registry_pull_provider`,
# so the cluster's native ACR is untouched.

locals {
  enable_acr_pull = var.registry_pull_provider == "acr-xacct" && var.provision_aks
  # Coupling point with packages/core/manifests (the registry-pull refresher KSA the wiring PR emits).
  acr_pull_ksa_namespace = "default"
  acr_pull_ksa_name      = "alethia-registry-pull"
}

resource "azurerm_user_assigned_identity" "acr_pull" {
  count               = local.enable_acr_pull ? 1 : 0
  name                = "${local.aks_name}-acrpull"
  resource_group_name = azurerm_resource_group.main.name
  location            = var.location
}

resource "azurerm_federated_identity_credential" "acr_pull" {
  count               = local.enable_acr_pull ? 1 : 0
  name                = "acr-pull"
  resource_group_name = azurerm_resource_group.main.name
  parent_id           = one(azurerm_user_assigned_identity.acr_pull[*].id)
  audience            = ["api://AzureADTokenExchange"]
  issuer              = try(module.aks[0].oidc_issuer_url, null) != null ? module.aks[0].oidc_issuer_url : ""
  subject             = "system:serviceaccount:${local.acr_pull_ksa_namespace}:${local.acr_pull_ksa_name}"
}

output "acr_pull_client_id" {
  description = "Client id of the cross-subscription ACR pull identity annotating the refresher KSA (empty unless acr-xacct). The customer grants this AcrPull on the target ACR."
  value       = try(azurerm_user_assigned_identity.acr_pull[0].client_id, "")
}
