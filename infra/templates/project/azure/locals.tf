locals {
  azure_locations_short = {
    "eastus"             = "eus"
    "eastus2"            = "eu2"
    "westus"             = "wus"
    "westus2"            = "wu2"
    "westus3"            = "wu3"
    "centralus"          = "cus"
    "northcentralus"     = "ncu"
    "southcentralus"     = "scu"
    "westcentralus"      = "wcu"
    "canadacentral"      = "cac"
    "canadaeast"         = "cae"
    "brazilsouth"        = "brs"
    "westeurope"         = "weu"
    "northeurope"        = "neu"
    "uksouth"            = "uks"
    "ukwest"             = "ukw"
    "francecentral"      = "frc"
    "francesouth"        = "frs"
    "germanywestcentral" = "gwc"
    "switzerlandnorth"   = "szn"
    "norwayeast"         = "noe"
    "swedencentral"      = "sec"
    "polandcentral"      = "plc"
    "italynorth"         = "itn"
    "eastasia"           = "eas"
    "southeastasia"      = "sea"
    "japaneast"          = "jpe"
    "japanwest"          = "jpw"
    "koreacentral"       = "krc"
    "koreasouth"         = "krs"
    "centralindia"       = "cin"
    "southindia"         = "sin"
    "westindia"          = "win"
    "australiaeast"      = "aue"
    "australiasoutheast" = "aus"
    "southafricanorth"   = "san"
    "uaenorth"           = "uan"
    "qatarcentral"       = "qtc"
  }

  # Platform base tags. Classification + sweep-handle tags (var.classification_tags) are merged in
  # UNDER these — base tags sit on the merge RHS so they always WIN a key collision, keeping the
  # sweep handles and platform bookkeeping authoritative. This local is applied to every taggable
  # Azure resource (AKS, the DB, Key Vault, Service Bus, Redis, ACR, Storage, Cosmos, ...).
  azure_base_tags = {
    "Environment" = title(var.environment)
    "Service"     = var.project_name
    "ManagedBy"   = "opentofu"
  }

  azure_default_tags = merge(var.classification_tags, local.azure_base_tags)

  # Naming conventions
  location_short = local.azure_locations_short[var.location]

  aks_name = "aks-${local.location_short}-${var.environment}-${var.project_name}"

  # THE REST OF THIS BLOCK WAS DEAD, AND WORSE THAN DEAD (#1886).
  #
  # Ten more names lived here — vnet_name, azure_db_name, azure_cache_name, azure_dns_name,
  # azure_waf_name, key_vault_name, acr_name, service_bus_name, cosmos_db_name and
  # storage_account_name — and NOTHING read a single one of them. `aks_name` above is the only
  # entry with consumers.
  #
  # They were not merely unused. They stated a convention the template does not use:
  #
  #   here (dead)          cosmos-<location_short>-<environment>-<project_name>
  #   modules/cosmos-db    <project_name>-<environment>-cosmos
  #
  # so anyone reading the root to find out what a resource is called got the wrong answer, in the
  # wrong order, with an extra segment. #1873 created the pattern by moving the Key Vault name to
  # checks_naming.tf and leaving `key_vault_name` sitting here; #1886 would have added six more
  # orphans on top. The live derivations are all in checks_naming.tf (NAMING-002), which is also
  # where their length budgets are, so there is one place to look.

  # The external-secrets managed identity this deploy uses: the caller's adopted one, or the one we
  # created. Everything that federates, grants to, or exports the ESO identity reads these — never
  # the resource directly — so adoption cannot be honoured in one place and missed in another. A
  # half-adopted deploy would grant Key Vault access to the created identity while the target
  # subscription trusts the adopted one, and ESO would authenticate as a principal with no read grant.
  #
  # Adoption requires BOTH inputs (the data source is keyed on name + resource group, not a resource
  # id); a check block rejects supplying only one rather than silently falling back to create.
  external_secrets_adopted = var.provision_aks && var.external_secrets_identity_name != "" && var.external_secrets_identity_resource_group != ""
  external_secrets_identity_id = var.provision_aks ? (
    local.external_secrets_adopted
    ? one(data.azurerm_user_assigned_identity.external_secrets_adopted[*].id)
    : one(azurerm_user_assigned_identity.external_secrets[*].id)
  ) : ""
  external_secrets_client_id = var.provision_aks ? (
    local.external_secrets_adopted
    ? one(data.azurerm_user_assigned_identity.external_secrets_adopted[*].client_id)
    : one(azurerm_user_assigned_identity.external_secrets[*].client_id)
  ) : ""
  external_secrets_principal_id = var.provision_aks ? (
    local.external_secrets_adopted
    ? one(data.azurerm_user_assigned_identity.external_secrets_adopted[*].principal_id)
    : one(azurerm_user_assigned_identity.external_secrets[*].principal_id)
  ) : ""

  # ── Application Gateway / AGIC: the gateway's four decisions ──
  #
  # These are LOGIC, not names, which is why they stayed here when #1886 moved the derived names to
  # checks_naming.tf: nothing about them has a length budget, and they read as a chain — request,
  # feasibility, WAF coupling, in-cluster half.
  #
  # The gateway is opt-in because a v2 gateway is a standing hourly cost, and `null` means "follow
  # the WAF switch" rather than "off": turning the WAF on and getting a policy attached to nothing
  # would be the exact defect the WAF decision exists to report.
  request_application_gateway = var.azure_application_gateway_enabled != null ? var.azure_application_gateway_enabled : var.azure_waf_enabled

  # A gateway needs a subnet of its own, and only the VNet this template creates can carve one
  # (modules/vnet azurerm_subnet.application_gateway) — a brownfield VNet is the caller's and we
  # will not go carving subnets in it. So `provision_vnet` is a hard term. An EXPLICIT request on a
  # brownfield network is refused at plan (checks_ingress.tf) rather than silently dropped; the
  # IMPLIED one (WAF on, brownfield) degrades to today's behaviour and says so.
  enable_application_gateway = local.request_application_gateway && var.provision_vnet

  # The WAF_v2 SKU and firewall_policy_id are driven from this ONE term so they cannot diverge:
  # a Standard_v2 gateway rejects a firewall policy association outright, and a WAF_v2 gateway
  # with no policy is a more expensive gateway that filters nothing.
  app_gateway_waf_attached = local.enable_application_gateway && var.azure_waf_enabled

  # AGIC is the in-cluster half: no cluster, no controller (and no OIDC issuer to federate its
  # identity to). The gateway itself is still built — it is useful, and billed, either way.
  enable_agic = local.enable_application_gateway && var.provision_aks
}
