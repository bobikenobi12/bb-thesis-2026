#########################################################################
##            Workload Identity for cluster add-ons                    ##
#########################################################################
# Creates a user-assigned managed identity for external-dns and federates it to
# the AKS OIDC issuer + the in-cluster external-dns KSA, so external-dns manages
# Azure DNS with NO static secret. The identity's client id is exported as
# `external_dns_client_id` and rendered onto the external-dns ServiceAccount by
# the ArgoCD Application (azure.workload.identity/client-id annotation). This is
# the Azure analogue of the AWS IRSA role the EKS path uses.

resource "azurerm_user_assigned_identity" "external_dns" {
  count               = var.provision_aks ? 1 : 0
  name                = "${local.aks_name}-extdns"
  resource_group_name = azurerm_resource_group.main.name
  location            = var.location
  tags                = local.azure_default_tags
}

resource "azurerm_federated_identity_credential" "external_dns" {
  count               = var.provision_aks ? 1 : 0
  name                = "external-dns"
  resource_group_name = azurerm_resource_group.main.name
  parent_id           = one(azurerm_user_assigned_identity.external_dns[*].id)
  audience            = ["api://AzureADTokenExchange"]
  issuer              = try(module.aks[0].oidc_issuer_url, null) != null ? module.aks[0].oidc_issuer_url : ""
  subject             = "system:serviceaccount:external-dns:external-dns-sa"
}

# The SAME managed identity, federated to a SECOND KSA: cert-manager's DNS01 solver. It
# writes a TXT record into the project's Azure DNS zone and deletes it again — exactly what
# the "DNS Zone Contributor" assignment below already permits, so cert-manager reuses
# external-dns's identity instead of a parallel one carrying an identical role.
#
# A federated identity credential maps ONE subject, so this second RESOURCE (not a second
# subject on the first) is what makes the azure.workload.identity/client-id annotation
# infra/templates/argocd/cert-manager.yaml puts on `cert-manager:cert-manager` resolve.
# Without it the AKS OIDC token is rejected at exchange and every DNS01 challenge fails
# inside a certificate that simply never issues.
resource "azurerm_federated_identity_credential" "cert_manager" {
  count               = var.provision_aks ? 1 : 0
  name                = "cert-manager"
  resource_group_name = azurerm_resource_group.main.name
  parent_id           = one(azurerm_user_assigned_identity.external_dns[*].id)
  audience            = ["api://AzureADTokenExchange"]
  issuer              = try(module.aks[0].oidc_issuer_url, null) != null ? module.aks[0].oidc_issuer_url : ""
  subject             = "system:serviceaccount:cert-manager:cert-manager"
}

# The SAME managed identity, federated to a THIRD KSA: the MARKETPLACE external-dns add-on
# (apps/console/lib/addons/catalog.ts, EXTERNAL_DNS_ADDON_SA = "addon-external-dns-sa").
#
# A distinct KSA from the rail's `external-dns-sa`: both Applications deploy into the
# `external-dns` namespace, so naming one object would put two ArgoCD Applications on it. And a
# federated identity credential maps ONE subject, so — as with cert_manager above — this is a
# second RESOURCE rather than a second subject on the first.
resource "azurerm_federated_identity_credential" "external_dns_addon" {
  count               = var.provision_aks ? 1 : 0
  name                = "external-dns-addon"
  resource_group_name = azurerm_resource_group.main.name
  parent_id           = one(azurerm_user_assigned_identity.external_dns[*].id)
  audience            = ["api://AzureADTokenExchange"]
  issuer              = try(module.aks[0].oidc_issuer_url, null) != null ? module.aks[0].oidc_issuer_url : ""
  subject             = "system:serviceaccount:external-dns:addon-external-dns"
}

# DNS Zone Contributor over the resource group so external-dns (and cert-manager's DNS01
# solver, which shares the identity above) can manage records.
resource "azurerm_role_assignment" "external_dns_dns" {
  count                = var.provision_aks ? 1 : 0
  scope                = azurerm_resource_group.main.id
  role_definition_name = "DNS Zone Contributor"
  principal_id         = one(azurerm_user_assigned_identity.external_dns[*].principal_id)
}

# User-assigned identity for the external-secrets operator, federated to its KSA, so the
# azurekv ClusterSecretStore reads Key Vault secrets with NO static secret. The client id is
# exported as `external_secrets_client_id` and rendered onto the operator's ServiceAccount
# (azure.workload.identity/client-id annotation + the azure.workload.identity/use pod label).
#
# ADOPTION (var.external_secrets_identity_name + _resource_group): when both are set this template
# does NOT create the identity — it federates and grants against the caller's pre-existing one.
# The reason is cross-subscription reads. A role assignment in the TARGET subscription binds the
# identity's OBJECT ID, which Azure regenerates on every create, so a pre-applied grant is dead the
# moment the identity is recreated; a stable NAME buys nothing. Adopting a standing identity is what
# lets the target-subscription grant be applied ONCE.
#
# Both empty (the default) keeps the create-our-own behavior byte-identical — this is opt-in.
resource "azurerm_user_assigned_identity" "external_secrets" {
  count               = var.provision_aks && !local.external_secrets_adopted ? 1 : 0
  name                = "${local.aks_name}-extsecrets"
  resource_group_name = azurerm_resource_group.main.name
  location            = var.location
  tags                = local.azure_default_tags
}

# The adopted identity. Read rather than created, so a wrong/absent name fails the plan loudly
# instead of provisioning a cluster whose ESO can authenticate to nothing.
data "azurerm_user_assigned_identity" "external_secrets_adopted" {
  count               = var.provision_aks && local.external_secrets_adopted ? 1 : 0
  name                = var.external_secrets_identity_name
  resource_group_name = var.external_secrets_identity_resource_group
}

resource "azurerm_federated_identity_credential" "external_secrets" {
  count = var.provision_aks ? 1 : 0
  # The credential name must be unique PER IDENTITY. When the identity is ours it is used by exactly
  # one cluster and the constant name is fine; an ADOPTED identity may be shared, and a constant name
  # would make two clusters fight over one credential — each apply overwriting the other's issuer, so
  # whichever applied last is the only cluster whose ESO can authenticate. Azure also caps federated
  # credentials at 20 per identity, so a destroyed cluster must free its own slot: the name is keyed
  # on the cluster, and `tofu destroy` removes exactly that one.
  name = local.external_secrets_adopted ? "external-secrets-${local.aks_name}" : "external-secrets"
  # An adopted identity lives in the caller's resource group, not ours.
  resource_group_name = local.external_secrets_adopted ? var.external_secrets_identity_resource_group : azurerm_resource_group.main.name
  parent_id           = local.external_secrets_identity_id
  audience            = ["api://AzureADTokenExchange"]
  issuer              = try(module.aks[0].oidc_issuer_url, null) != null ? module.aks[0].oidc_issuer_url : ""
  subject             = "system:serviceaccount:external-secrets-operator:external-secrets-operator-sa"
}

# Least-privilege: read-only secret access (get/list) on THIS project's vault only — the vault
# is RBAC-authorized (see modules/key-vault), so "Key Vault Secrets User" scoped to the vault
# is the narrowest built-in read role.
resource "azurerm_role_assignment" "external_secrets_kv" {
  count                = var.provision_aks ? 1 : 0
  scope                = module.key_vault.vault_id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = local.external_secrets_principal_id
}
