#########################################################################
##                     GKE Outputs                                    ##
#########################################################################

output "gke_cluster_name" {
  description = "Name of the GKE cluster"
  value       = try(module.gke[0].cluster_name, null) != null ? module.gke[0].cluster_name : null
}

output "gke_cluster_endpoint" {
  description = "Endpoint of the GKE cluster"
  value       = try(module.gke[0].cluster_endpoint, null) != null ? module.gke[0].cluster_endpoint : null
  sensitive   = true
}

output "gke_cluster_ca_certificate" {
  description = "Base64-encoded CA certificate of the GKE cluster"
  value       = try(module.gke[0].cluster_ca_certificate, null) != null ? module.gke[0].cluster_ca_certificate : null
  sensitive   = true
}

#########################################################################
##                     Cloud SQL Outputs                               ##
#########################################################################

output "cloud_sql_connection_name" {
  description = "Cloud SQL instance connection name for Cloud SQL Proxy"
  value       = try(module.cloud_sql[0].connection_name, null) != null ? module.cloud_sql[0].connection_name : null
}

output "cloud_sql_ip" {
  description = "Private IP address of the Cloud SQL instance"
  value       = try(module.cloud_sql[0].instance_ip, null) != null ? module.cloud_sql[0].instance_ip : null
}

output "cloud_sql_database" {
  description = "Name of the Cloud SQL database"
  value       = try(module.cloud_sql[0].database_name, null) != null ? module.cloud_sql[0].database_name : null
}

# Keyless DB auth (#722): the app's IAM login identity + the GSA email the generated KSA is
# annotated with. Null unless Cloud SQL IAM auth is enabled. A binding's `username` facet resolves
# from cloud_sql_iam_user; the manifest lane annotates the app KSA with cloud_sql_app_gsa_email.
output "cloud_sql_iam_user" {
  description = "Keyless app database username — the CLOUD_IAM_SERVICE_ACCOUNT user (#722)"
  value       = local.enable_app_db_iam && try(module.cloud_sql[0].app_iam_user, null) != null ? module.cloud_sql[0].app_iam_user : null
}

output "cloud_sql_app_gsa_email" {
  description = "Email of the app Cloud SQL Workload-Identity GSA — annotated onto the generated app KSA (#722). The account adopted via cloud_sql_app_service_account_email; null when keyless is not wired."
  value       = local.enable_app_db_iam ? one(data.google_service_account.app_db_adopted[*].email) : null
}

# Keyless bootstrap (#722 R5): the Secret Manager secret id holding the BUILT_IN admin (default user)
# credentials. The bootstrap Job's ExternalSecret pulls username+password from it (via the gcpsm
# ClusterSecretStore) to connect as admin and grant the app IAM user its scoped privileges.
output "cloud_sql_credentials_secret" {
  description = "Secret Manager secret id of the Cloud SQL admin (default user) credentials — the keyless bootstrap Job's admin ExternalSecret RemoteKey (#722)"
  value       = try(module.cloud_sql[0].credentials_secret_id, null) != null ? module.cloud_sql[0].credentials_secret_id : null
}

#########################################################################
##                     Artifact Registry Outputs                       ##
#########################################################################

output "artifact_registry_urls" {
  description = "Map of Artifact Registry repository URLs"
  # Guarded on the MODULE, not on a copy of its count predicate. `provision_artifact_registry` alone
  # is NOT that predicate: the module also requires `registry_provider == "native"` (artifact-registry.tf),
  # because a pluggable registry connector means Artifact Registry is not ours to create. The console
  # sets `provision_artifact_registry` from the mere PRESENCE of a registry row, so selecting any
  # connector left this indexing [0] of an empty module and failed the WHOLE apply with "Invalid
  # index" — a crash a mile from its cause.
  #
  # Guarded by an instance PROBE rather than the `length(module.artifact_registry) > 0` this used
  # to carry: `length()` reads the module as a WHOLE and closes dependency cycles elsewhere in
  # these templates (#3509, measured in aws/rds.tf), so the probe is the one shape used
  # everywhere — and neither can drift from the count the way a duplicated predicate did — the probe
  # answers "does this instance have this output", which is the count's own answer.
  value = try(module.artifact_registry[0].repository_urls, null) != null ? module.artifact_registry[0].repository_urls : {}
}

#########################################################################
##                     Secret Manager Outputs                          ##
#########################################################################

output "custom_secret_ids" {
  description = "List of Secret Manager secret IDs"
  value       = module.secret_manager.secret_ids
}

output "custom_secret_names" {
  description = "List of Secret Manager secret names"
  value       = module.secret_manager.secret_names
}


#########################################################################
##                     Memorystore Outputs                             ##
#########################################################################

# ONE pair of cache outputs for both engines: `endpointOutputKey` (packages/core/manifests) maps
# cloud+kind to a single output name, so a service bound to "the cache" reads `memorystore_host`
# whichever engine backs it. A separate `valkey_*` key would force every consumer to learn the engine,
# and one that forgot would resolve to null — which is the failure this lane exists to remove.
# The two toggles are mutually exclusive, so at most one side is non-null.
output "memorystore_host" {
  description = "Hostname or IP of the Memorystore Redis instance"
  value = try(coalesce(
    try(module.memorystore[0].host, null) != null ? module.memorystore[0].host : null,
    try(module.memorystore_valkey[0].host, null) != null ? module.memorystore_valkey[0].host : null,
  ), null)
}

output "memorystore_port" {
  description = "Port of the Memorystore Redis instance"
  value = try(coalesce(
    try(module.memorystore[0].port, null) != null ? module.memorystore[0].port : null,
    try(module.memorystore_valkey[0].port, null) != null ? module.memorystore_valkey[0].port : null,
  ), null)
}

#########################################################################
##                     Cloud DNS Outputs                               ##
#########################################################################

# Every output in this block guards on the MODULE INSTANCE, not on a copy of
# its count predicate. `var.cloud_dns_enabled` alone is NOT that predicate: cloud-dns.tf also
# requires `dns_provider == "native"`, because selecting the Cloudflare DNS connector means the zone
# is not ours to create. The two outputs below used to index `[0]` off `var.cloud_dns_enabled`, so a
# DNS-enabled project on the Cloudflare connector planned an "Invalid index" and failed the WHOLE
# apply — the identical bug, and the identical fix, as `artifact_registry_urls` above (whose note
# records how far from its cause that crash lands). The guard is the instance probe rather than the
# `length(module.cloud_dns) > 0` these carried between then and #3509 — `length()` reads the module
# as a WHOLE, which closes dependency cycles elsewhere (aws/rds.tf measured it). Neither can drift
# from the count the way a duplicated predicate did; only the probe is safe in every position.
output "cloud_dns_name_servers" {
  description = "Name servers for the Cloud DNS managed zone"
  value       = try(module.cloud_dns[0].name_servers, null) != null ? module.cloud_dns[0].name_servers : []
}

# Resolves from EITHER source, because `cloud_dns_enabled` is the CREATE gate and not "a zone
# exists" (#2294, mirroring azure/outputs.tf:126 and aws/outputs.tf:26). A brought zone leaves the
# module absent, and returning null here is not a harmless empty: CertManagerSolver() fails closed
# when this output is missing — the cloudDNS solver is rendered with an explicit `hostedZoneName`
# precisely because the zone-scoped IAM grant carries no `dns.managedZones.list` permission to find
# the zone with. So a null here does not degrade to "cert-manager figures it out"; it means every
# DNS01 challenge stops issuing, on a project whose DNS the customer configured correctly.
# Reads local.external_dns_zone, which resolves the created case from the MODULE'S OWN OUTPUT and
# the brought case from the caller's variable — see locals.tf for why re-deriving the created name
# is wrong. One local, read by both this output and the external-dns roles/dns.admin grant, so the
# two can never disagree about which zone the project has.
#
# Still null when no Cloud DNS zone serves the project: DNS off, or a pluggable DNS connector owns
# it. On the Cloudflare connector `cloud_dns_zone_name` may well be set — the caller named their
# Cloudflare zone — and exporting it here would make CertManagerSolver() render a cloudDNS solver
# for a zone Cloud DNS does not serve.
output "cloud_dns_zone_name" {
  description = "The Cloud DNS zone serving this project — created in-template when cloud_dns_enabled, else the existing cloud_dns_zone_name supplied by the caller. Null when no Cloud DNS zone serves the project (DNS off, or a pluggable DNS connector owns it)."
  value       = local.external_dns_zone != "" ? local.external_dns_zone : null
}



#########################################################################
##                     Cloud Armor Outputs                             ##
#########################################################################

# Cloud Armor's entire reason to exist is to be ATTACHED. The module has exported policy_id and
# policy_self_link since it was written and the root exported neither, so the security policy was
# created behind the canvas WAF switch, billed, and associated with nothing: a project could carry
# the policy, the bill, and zero inspected requests, and no surface said so (#1419).
#
# The runner reads `cloud_armor_policy_name` and renders a GKE BackendConfig whose
# `spec.securityPolicy.name` binds the policy to the GCLB backend service the platform Ingress
# provisions. Null when the switch is off — precisely the "attach nothing" signal the Go side wants,
# since an empty securityPolicy name is not "no WAF", it is a BackendConfig the ingress controller
# rejects (the GCP shape of the empty-wafv2-annotation trap on AWS).
output "cloud_armor_policy_name" {
  description = "Name of the Cloud Armor security policy — the value a GKE BackendConfig's spec.securityPolicy.name takes. Null when cloud_armor_enabled is false."
  value       = try(module.cloud_armor[0].policy_name, null) != null ? module.cloud_armor[0].policy_name : null
}

output "cloud_armor_policy_id" {
  description = "Fully-qualified id of the Cloud Armor security policy. Null when cloud_armor_enabled is false."
  value       = try(module.cloud_armor[0].policy_id, null) != null ? module.cloud_armor[0].policy_id : null
}

output "cloud_armor_policy_self_link" {
  description = "Self link of the Cloud Armor security policy, for cross-project references. Null when cloud_armor_enabled is false."
  value       = try(module.cloud_armor[0].policy_self_link, null) != null ? module.cloud_armor[0].policy_self_link : null
}

#########################################################################
##                     Networking Outputs                              ##
#########################################################################

output "network_self_link" {
  description = "Self-link of the VPC network"
  value       = try(module.vpc_network[0].network_self_link, null) != null ? module.vpc_network[0].network_self_link : var.network_id
}

output "private_subnet_self_link" {
  description = "Self-link of the private subnetwork"
  value       = try(module.vpc_network[0].private_subnet_self_link, null) != null ? module.vpc_network[0].private_subnet_self_link : null
}

#########################################################################
##                     General Outputs                                 ##
#########################################################################

output "region_short" {
  description = "Short form of the deployment region"
  value       = local.gcp_regions_short[local.gcp_region_key]
}

output "project_id" {
  description = "GCP project ID"
  value       = var.project_id
}

#########################################################################
##            Workload Identity Outputs (cluster add-ons)             ##
#########################################################################

output "gcp_project_id" {
  description = "GCP project id (for Workload Identity annotations)"
  value       = var.project_id
}

output "external_dns_service_account" {
  description = "external-dns Google service account email (Workload Identity). The adopted GSA when external_dns_service_account_email is set, otherwise the one this template created."
  value       = var.provision_gke ? local.external_dns_sa_email : null
}

output "external_secrets_service_account" {
  description = "external-secrets operator Google service account email (Workload Identity; gates the gcpsm ClusterSecretStore render). The adopted GSA when external_secrets_service_account_email is set, otherwise the one this template created."
  value       = var.provision_gke ? local.external_secrets_sa_email : null
}

#########################################################################
##                    Cloud Storage Outputs                            ##
#########################################################################

# Surfaced so the state of the `public_access` switch is legible from the outputs — and so
# checks_storage.tftest.hcl can assert BOTH halves of it from the root, which is the only place
# tofu's test harness can see (a *.tftest.hcl under modules/ is never executed).
output "cloud_storage_public_access_prevention" {
  description = "Map of bucket suffixes to the public_access_prevention each bucket is planned with"
  value       = try(module.cloud_storage[0].bucket_public_access_prevention, null) != null ? module.cloud_storage[0].bucket_public_access_prevention : {}
}

output "cloud_storage_publicly_readable_buckets" {
  description = "Bucket suffixes that carry an allUsers reader binding"
  value       = try(module.cloud_storage[0].publicly_readable_buckets, null) != null ? module.cloud_storage[0].publicly_readable_buckets : []
}
