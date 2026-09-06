# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Application Gateway v2 + the Application Gateway Ingress Controller (AGIC) — Azure's ingress
# path, and the only thing an Azure WAF policy can be bound to.
#
# Two facts drive the whole file:
#
#  1. Until now this template had NO ingress controller at all. `azure_waf_enabled` created an
#     azurerm_web_application_firewall_policy (modules/azure-waf) and associated it with nothing,
#     so the canvas WAF switch bought a billed policy that inspected zero requests.
#
#  2. The Azure attach is NOT the AWS one. On AWS the web ACL is bound by an annotation the runner
#     puts on an Ingress (`alb.ingress.kubernetes.io/wafv2-acl-arn`), so the bind lives in
#     Kubernetes. Azure has no such annotation: a WAF policy attaches to the Application Gateway
#     resource (`firewall_policy_id`, or per-listener) and is therefore an APPLY-time fact of this
#     template. That is why the bind is here in tofu and not in the runner, and why the `waf`
#     InfraServiceDecision reads a different predicate on azure than on aws
#     (packages/core/argocd/decisions.go wafAttachments).
#
# The gateway is opt-in, defaulting to "follow the WAF switch" — see locals.tf
# (request_application_gateway) for why, and variables.tf for the cost note.

################################################################################
# Public frontend
################################################################################

# A v2 gateway's public frontend must be a Standard-SKU STATIC public IP; the provider rejects
# Basic/Dynamic on v2. external-dns publishes records against Ingress objects AGIC reconciles onto
# this address, so it must not move between applies.
resource "azurerm_public_ip" "application_gateway" {
  count = local.enable_application_gateway ? 1 : 0

  name                = "${local.azure_app_gateway_name}-pip"
  location            = var.location
  resource_group_name = azurerm_resource_group.main.name
  allocation_method   = "Static"
  sku                 = "Standard"

  tags = local.azure_default_tags
}

################################################################################
# Application Gateway
################################################################################

resource "azurerm_application_gateway" "this" {
  count = local.enable_application_gateway ? 1 : 0

  name                = local.azure_app_gateway_name
  location            = var.location
  resource_group_name = azurerm_resource_group.main.name

  # WAF_v2 is a REQUIREMENT of the association, not a preference: a Standard_v2 gateway refuses
  # firewall_policy_id, and OWASP 3.2 (the rule set modules/azure-waf pins) is only offered on the
  # WAF tier. Both this and firewall_policy_id below read the SAME local, so the pair cannot
  # diverge into "WAF SKU, no policy" (a costlier gateway that filters nothing) or "policy on a
  # Standard SKU" (an apply-time rejection).
  sku {
    name     = local.app_gateway_waf_attached ? "WAF_v2" : "Standard_v2"
    tier     = local.app_gateway_waf_attached ? "WAF_v2" : "Standard_v2"
    capacity = var.azure_application_gateway_capacity
  }

  # ── THE ATTACH ──────────────────────────────────────────────────────────────────────────────
  # Gateway-scoped: every listener AGIC creates inherits it, including ones that do not exist yet.
  # A per-listener firewall_policy_id would have been attached to the placeholder listener below
  # and then thrown away the first time AGIC rewrote the listener set.
  # `null`, not `""`, and the difference is measured: the schema marks `firewall_policy_id`
  # OPTIONAL, so null reads as "no policy attached" while "" would be an invalid resource id. The
  # sibling `subnet_id` below is REQUIRED and takes "" for the same reason inverted — a null there
  # fails the plan with "Missing required argument" (#3509).
  firewall_policy_id = local.app_gateway_waf_attached && try(module.azure_waf[0].policy_id, null) != null ? module.azure_waf[0].policy_id : null

  gateway_ip_configuration {
    name      = "appgw-ip-config"
    subnet_id = try(module.vnet[0].application_gateway_subnet_id, null) != null ? module.vnet[0].application_gateway_subnet_id : ""
  }

  frontend_ip_configuration {
    name                 = "appgw-frontend-ip"
    public_ip_address_id = one(azurerm_public_ip.application_gateway[*].id)
  }

  frontend_port {
    name = "appgw-frontend-port-http"
    port = 80
  }

  # ── Placeholder data plane ──────────────────────────────────────────────────────────────────
  # An Application Gateway cannot be created empty: the API requires at least one backend pool,
  # one HTTP setting, one listener and one routing rule. AGIC then takes OWNERSHIP of exactly
  # those collections and rewrites them from the cluster's Ingress objects on every reconcile,
  # which is what `ignore_changes` below is for — without it each `tofu apply` would revert the
  # live routing configuration to these placeholders and take every published service down until
  # AGIC noticed and put it back.
  #
  # Deliberately a dead end: an empty backend pool answers nothing, so a request that arrives
  # before any Ingress exists gets a 502 rather than being routed somewhere unintended.
  backend_address_pool {
    name = "placeholder-pool"
  }

  backend_http_settings {
    name                  = "placeholder-http-settings"
    cookie_based_affinity = "Disabled"
    port                  = 80
    protocol              = "Http"
    request_timeout       = 30
  }

  http_listener {
    name                           = "placeholder-listener"
    frontend_ip_configuration_name = "appgw-frontend-ip"
    frontend_port_name             = "appgw-frontend-port-http"
    protocol                       = "Http"
  }

  request_routing_rule {
    name                       = "placeholder-rule"
    priority                   = 1000
    rule_type                  = "Basic"
    http_listener_name         = "placeholder-listener"
    backend_address_pool_name  = "placeholder-pool"
    backend_http_settings_name = "placeholder-http-settings"
  }

  tags = local.azure_default_tags

  lifecycle {
    ignore_changes = [
      # Everything AGIC owns. Sourced from the controller's own reconcile surface, not guessed:
      # it rewrites the listener/rule/pool/settings graph wholesale from the Ingress objects.
      backend_address_pool,
      backend_http_settings,
      frontend_port,
      http_listener,
      probe,
      redirect_configuration,
      request_routing_rule,
      rewrite_rule_set,
      ssl_certificate,
      url_path_map,
      # AGIC stamps these two tags on the gateway it manages. Ignored BY KEY rather than ignoring
      # `tags` wholesale, so the classification + sweep-handle tags (local.azure_default_tags,
      # BYOC B1.2) stay enforced and drift on them is still a diff.
      tags["managed-by-k8s-ingress"],
      tags["ingress-for-aks-cluster-id"],
    ]
  }
}

################################################################################
# AGIC workload identity
################################################################################

# AGIC talks to Azure Resource Manager to rewrite the gateway, so it needs an identity. Same shape
# as the external-dns / external-secrets identities in workload-identity.tf: a user-assigned
# managed identity federated to the AKS OIDC issuer and the controller's KSA, so the controller
# holds NO static credential. The client id is exported as `ingress_client_id` and rendered onto
# the ServiceAccount by the AGIC Application (armAuth.type=workloadIdentity), which is what makes
# InfraFacts.AzureIngressClient — read from that output since it was added, and empty ever since,
# because no template exported it — actually carry a value.
resource "azurerm_user_assigned_identity" "agic" {
  count = local.enable_agic ? 1 : 0

  name                = "${local.aks_name}-agic"
  resource_group_name = azurerm_resource_group.main.name
  location            = var.location
}

resource "azurerm_federated_identity_credential" "agic" {
  count = local.enable_agic ? 1 : 0

  name                = "agic"
  resource_group_name = azurerm_resource_group.main.name
  parent_id           = one(azurerm_user_assigned_identity.agic[*].id)
  audience            = ["api://AzureADTokenExchange"]
  issuer              = try(module.aks[0].oidc_issuer_url, null) != null ? module.aks[0].oidc_issuer_url : ""
  # Must match the namespace + ServiceAccount the AGIC Application creates
  # (infra/templates/argocd/azure-application-gateway-ingress.yaml: destination.namespace `agic`,
  # and `fullnameOverride: ingress-azure`, which is what fixes the chart's otherwise
  # release-name-derived ServiceAccount name).
  subject = "system:serviceaccount:agic:ingress-azure"
}

# The two grants Microsoft documents for AGIC, and only those: Contributor on the GATEWAY (it
# rewrites that one resource) and Reader on the resource group (it resolves the gateway and the
# subnet through it). Notably NOT Contributor on the resource group — the controller has no reason
# to be able to modify the cluster, the database or the vault.
resource "azurerm_role_assignment" "agic_gateway" {
  count = local.enable_agic ? 1 : 0

  scope                = one(azurerm_application_gateway.this[*].id)
  role_definition_name = "Contributor"
  principal_id         = one(azurerm_user_assigned_identity.agic[*].principal_id)
}

resource "azurerm_role_assignment" "agic_resource_group_reader" {
  count = local.enable_agic ? 1 : 0

  scope                = azurerm_resource_group.main.id
  role_definition_name = "Reader"
  principal_id         = one(azurerm_user_assigned_identity.agic[*].principal_id)
}
