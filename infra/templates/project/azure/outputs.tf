#########################################################################
##                     AKS Outputs                                    ##
#########################################################################

output "aks_cluster_name" {
  description = "Name of the AKS cluster"
  value       = try(module.aks[0].cluster_name, null) != null ? module.aks[0].cluster_name : null
}

output "aks_cluster_endpoint" {
  description = "Endpoint of the AKS cluster"
  value       = try(module.aks[0].cluster_endpoint, null) != null ? module.aks[0].cluster_endpoint : null
  sensitive   = true
}

output "aks_cluster_ca_certificate" {
  description = "Base64-encoded CA certificate of the AKS cluster (public; consumed by the runner to build a CLI-free kubeconfig)"
  value       = try(module.aks[0].cluster_ca_certificate, null) != null ? module.aks[0].cluster_ca_certificate : null
  sensitive   = true
}

#########################################################################
##                     Resource Group Outputs                          ##
#########################################################################

output "resource_group_name" {
  description = "Name of the Azure resource group"
  value       = azurerm_resource_group.main.name
}

#########################################################################
##                     Azure DB Outputs                                ##
#########################################################################

output "azure_db_fqdn" {
  description = "Fully qualified domain name of the Azure Database flexible server"
  value       = try(module.azure_db[0].server_fqdn, null) != null ? module.azure_db[0].server_fqdn : null
}

# Keyless DB auth (#722, #1464): the app's Entra login identity + the UAMI client id the generated KSA
# is annotated with. Non-null for BOTH engines when keyless is enabled with AKS (gated on
# enable_app_db_identity). A binding's `username` facet resolves from azure_db_aad_user; the manifest
# lane annotates the app KSA with azure_db_client_id.
output "azure_db_aad_user" {
  description = "Keyless app database username — the Entra (UAMI) principal name (#722)"
  value       = local.enable_app_db_identity ? one(azurerm_user_assigned_identity.app_db[*].name) : null
}

output "azure_db_client_id" {
  description = "Client id of the app Entra Workload-Identity UAMI — annotated onto the generated app KSA; also the MySQL keyless bind value (`db-bootstrap --app-client-id`) (#722)"
  value       = local.enable_app_db_identity ? one(azurerm_user_assigned_identity.app_db[*].client_id) : null
}

# Keyless least-privilege (#722 R5): the dedicated DB-admin identity the bootstrap Job runs as, and
# the app UAMI id the Job binds the app's scoped Entra login to (Postgres: OID via pgaadauth SECURITY
# LABEL; MySQL: client id via CREATE AADUSER).
output "azure_db_admin_client_id" {
  description = "Client id of the dedicated DB-admin Entra Workload-Identity UAMI — annotated onto the bootstrap Job KSA (#722)"
  value       = local.enable_app_db_identity ? one(azurerm_user_assigned_identity.db_admin[*].client_id) : null
}

output "azure_db_app_oid" {
  description = "Object (principal) id of the app UAMI — the POSTGRES bootstrap Job binds the app's scoped role to it via `db-bootstrap --app-oid` (MySQL binds on azure_db_client_id instead) (#722)"
  value       = local.enable_app_db_identity ? one(azurerm_user_assigned_identity.app_db[*].principal_id) : null
}

output "azure_db_admin_user" {
  description = "Entra login name (UAMI principal name) the keyless bootstrap Job connects as — the dedicated DB admin (#722)"
  value       = local.enable_app_db_identity ? one(azurerm_user_assigned_identity.db_admin[*].name) : null
}

output "azure_db_name" {
  description = "Name of the default Azure Database flexible server database (the keyless bootstrap Job's admin connection target, #722)"
  value       = try(module.azure_db[0].database_name, null) != null ? module.azure_db[0].database_name : null
}

#########################################################################
##                     ACR Outputs                                     ##
#########################################################################

output "acr_login_server" {
  description = "Login server URL of the Azure Container Registry"
  # Guarded on the MODULE, not on a copy of its count predicate. `provision_acr` alone is NOT that
  # predicate: the module also requires `registry_provider == "native"` (acr.tf), because a pluggable
  # registry connector means the ACR is not ours to create. The console sets `provision_acr` from the
  # mere PRESENCE of a registry row, so selecting any connector left this indexing [0] of an empty
  # module and failed the WHOLE apply with "Invalid index" — a crash a mile from its cause.
  #
  # Guarded by an instance PROBE rather than the `length(module.acr) > 0` this used to carry:
  # `length()` reads the module as a WHOLE and closes dependency cycles elsewhere in these
  # templates (#3509, measured in aws/rds.tf), so the probe is the one shape used everywhere —
  # and neither can drift from the count the way a duplicated predicate did — the probe
  # answers "does this instance have this output", which is the count's own answer.
  value = try(module.acr[0].login_server, null) != null ? module.acr[0].login_server : null
}

#########################################################################
##                     Key Vault Outputs                               ##
#########################################################################

output "custom_secret_ids" {
  description = "List of Key Vault secret IDs"
  value       = module.key_vault.secret_ids
}

#########################################################################
##                     Azure Cache Outputs                             ##
#########################################################################

output "azure_cache_hostname" {
  description = "Hostname of the Azure Cache for Redis instance"
  value       = try(module.azure_cache[0].hostname, null) != null ? module.azure_cache[0].hostname : null
}

#########################################################################
##                     Azure DNS Outputs                               ##
#########################################################################

output "azure_dns_name_servers" {
  description = "Name servers for the Azure DNS zone (empty when attaching to a zone you already own — its delegation is already in place)."
  value       = try(module.azure_dns[0].name_servers, null) != null ? module.azure_dns[0].name_servers : []
}

# The zone downstream bindings should use, resolved IDENTICALLY on both paths so a consumer never
# has to know which one ran — the aws parity shape (outputs.tf:25, route53_zone_id). Without this
# there was no way to name the existing zone at all: the module output only ever described a zone
# the template had just created (#1992).
output "azure_dns_zone_name" {
  description = "The Azure DNS zone serving this project — created in-template when azure_dns_enabled, else the existing azure_dns_zone_name supplied by the caller."
  value       = try(module.azure_dns[0].zone_name, null) != null ? module.azure_dns[0].zone_name : var.azure_dns_zone_name
}

#########################################################################
##          Application Gateway / WAF Outputs                          ##
#########################################################################

# The gateway AGIC manages — and the WAF policy's ONLY attachment site on Azure. The runner reads
# this to decide whether an ingress controller shipped (argocd ingressControllers) and whether the
# web ACL is genuinely bound (argocd wafAttachments); null means neither.
output "application_gateway_name" {
  description = "Name of the Application Gateway — the AGIC chart's appgw.name, and the resource a WAF policy binds to"
  value       = local.enable_application_gateway ? one(azurerm_application_gateway.this[*].name) : null
}

# modules/azure-waf has exported policy_id since it was written; nothing re-exported it, so the
# runner had no way to see that a policy existed at all. Null when the switch is off — which
# ExtractOutput turns into "", exactly the "there is nothing to attach" signal the decision wants.
output "waf_policy_id" {
  description = "Resource id of the Azure WAF policy (null when azure_waf_enabled is off) — bound to the Application Gateway via firewall_policy_id"
  value       = try(module.azure_waf[0].policy_id, null) != null ? module.azure_waf[0].policy_id : null
}

#########################################################################
##                     General Outputs                                 ##
#########################################################################

output "location_short" {
  description = "Short form of the deployment location"
  value       = local.azure_locations_short[var.location]
}

#########################################################################
##            Workload Identity Outputs (cluster add-ons)             ##
#########################################################################

output "azure_tenant_id" {
  description = "Azure AD tenant id (for workload-identity annotations)"
  value       = data.azurerm_client_config.current.tenant_id
}

output "azure_subscription_id" {
  description = "Subscription the project's resources live in — the AGIC chart's appgw.subscriptionId"
  value       = data.azurerm_client_config.current.subscription_id
}

output "external_dns_client_id" {
  description = "external-dns managed identity client id (Workload Identity)"
  value       = var.provision_aks ? one(azurerm_user_assigned_identity.external_dns[*].client_id) : null
}

# InfraFacts.AzureIngressClient has read an `ingress_client_id` output since the facts struct
# gained a per-cloud ingress identity, and NO template ever exported one — so the fact was
# permanently "", and any render gate reading it could never open. This is that output, emitted at
# last, rather than a second name for the same thing.
output "ingress_client_id" {
  description = "AGIC managed identity client id (Workload Identity) — rendered onto the AGIC ServiceAccount as armAuth.identityClientID; gates the AGIC ArgoCD Application"
  value       = local.enable_agic ? one(azurerm_user_assigned_identity.agic[*].client_id) : null
}

output "external_secrets_client_id" {
  description = "external-secrets operator managed identity client id (Workload Identity; gates the azurekv ClusterSecretStore render). The adopted identity when external_secrets_identity_name/_resource_group are set, otherwise the one this template created."
  value       = var.provision_aks ? local.external_secrets_client_id : null
}

output "key_vault_uri" {
  description = "URI of the project Key Vault (the azurekv ClusterSecretStore's vaultUrl)"
  value       = module.key_vault.vault_uri
}

#########################################################################
##                    Storage Account Outputs                          ##
#########################################################################

# Surfaced so the two bucket switches are legible from the plan — and so checks_storage.tftest.hcl
# can assert them from the ROOT, which is the only place tofu's test harness runs.
output "storage_container_access_types" {
  description = "Map of container name to the container_access_type it is planned with"
  value       = try(module.storage_account[0].container_access_types, null) != null ? module.storage_account[0].container_access_types : {}
}

output "storage_blob_versioning_enabled" {
  description = "Whether blob versioning is planned on the project's storage account"
  value       = try(module.storage_account[0].blob_versioning_enabled, null) != null ? module.storage_account[0].blob_versioning_enabled : null
}

output "storage_allow_nested_items_to_be_public" {
  description = "Whether the storage account permits public containers"
  value       = try(module.storage_account[0].allow_nested_items_to_be_public, null) != null ? module.storage_account[0].allow_nested_items_to_be_public : null
}
