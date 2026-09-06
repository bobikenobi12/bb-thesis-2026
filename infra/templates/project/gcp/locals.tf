locals {
  gcp_regions_short = {
    "us-central1"             = "uc1"
    "us-east1"                = "ue1"
    "us-east4"                = "ue4"
    "us-east5"                = "ue5"
    "us-south1"               = "us1"
    "us-west1"                = "uw1"
    "us-west2"                = "uw2"
    "us-west3"                = "uw3"
    "us-west4"                = "uw4"
    "northamerica-northeast1" = "nn1"
    "northamerica-northeast2" = "nn2"
    "southamerica-east1"      = "se1"
    "southamerica-west1"      = "sw1"
    "europe-west1"            = "ew1"
    "europe-west2"            = "ew2"
    "europe-west3"            = "ew3"
    "europe-west4"            = "ew4"
    "europe-west6"            = "ew6"
    "europe-west8"            = "ew8"
    "europe-west9"            = "ew9"
    "europe-west10"           = "e10"
    "europe-west12"           = "e12"
    "europe-north1"           = "en1"
    "europe-central2"         = "ec2"
    "europe-southwest1"       = "es1"
    "asia-east1"              = "ae1"
    "asia-east2"              = "ae2"
    "asia-northeast1"         = "an1"
    "asia-northeast2"         = "an2"
    "asia-northeast3"         = "an3"
    "asia-south1"             = "as1"
    "asia-south2"             = "as2"
    "asia-southeast1"         = "at1"
    "asia-southeast2"         = "at2"
    "australia-southeast1"    = "au1"
    "australia-southeast2"    = "au2"
    "me-west1"                = "mw1"
    "me-central1"             = "mc1"
    "africa-south1"           = "af1"
  }

  # Platform base labels. Classification + sweep-handle labels (var.classification_tags) are merged
  # in UNDER these — base labels sit on the merge RHS so they always WIN a key collision, keeping
  # the sweep handles and platform bookkeeping authoritative. This local is applied to every
  # taggable GCP resource (GKE, Cloud SQL, Memorystore, Cloud Storage, Artifact Registry, ...).
  gcp_base_labels = {
    "environment" = var.environment
    "service"     = var.project_name
    "managed-by"  = "opentofu"
  }

  gcp_default_labels = merge(var.classification_tags, local.gcp_base_labels)

  # var.region may be a REGION (europe-west3) or a ZONE (europe-west3-a) — a zonal GKE cluster is a
  # valid, cheaper topology (the T2 e2e default provisions one), and the GKE module passes
  # `location = var.region` verbatim, so a zone is intentional there. But the short-name lookup below
  # is keyed by REGION, and a zone value ("europe-west3-a") has no map key → a plan-time "key does not
  # exist in map". So derive the region key first: strip a trailing "-<letter>" zone suffix when
  # present, otherwise use var.region as-is. Every short-name reference indexes by this derived key.
  gcp_region_key = can(regex("-[a-z]$", var.region)) ? substr(var.region, 0, length(var.region) - 2) : var.region

  # Naming conventions. ONLY ids that something actually consumes belong here.
  #
  # This block also held vpc_name, cloud_sql_name, memorystore_name, cloud_armor_name and
  # secret_manager_prefix, none of which any resource ever read — every module builds its own id by
  # suffixing "-<kind>" instead. A derived name that nothing consumes is indistinguishable from a
  # live naming contract, and that is not free: #1716 was a GKE id that overflowed its cap
  # mid-apply, and answering "do its siblings share the bug?" meant reading six near-identical
  # interpolations to establish that five of them cannot overflow anything because they reach no
  # resource. The next reader may well answer it the other way.
  #
  # So: adding a name back here means WIRING it up, and a newly-consumed id is a new length
  # constraint on the shared "<environment>-<project_name>" stem — it needs its own budget row in
  # checks_naming.tf (NAMING-001).
  gke_name       = "gke-${local.gcp_regions_short[local.gcp_region_key]}-${var.environment}-${var.project_name}"
  cloud_dns_name = "dns-${local.gcp_regions_short[local.gcp_region_key]}-${var.environment}-${var.project_name}"

  # The Cloud DNS zone this project actually serves: the one we create, or the one the caller
  # BROUGHT — same idea as external_secrets_adopted below, and for the same reason. Everything that
  # grants on, or points at, the zone reads THIS and never `var.cloud_dns_enabled` directly, so
  # bringing a zone cannot be honoured in one place and missed in another.
  #
  # That split is exactly what #2294 was. `cloud_dns_enabled` is the CREATE gate; three separate
  # sites read it as if it meant "a zone exists", and each would have failed differently for a
  # brought zone — a null output that makes CertManagerSolver() fail closed, an external-dns IAM
  # binding that never gets created, and a precondition that refuses the create path.
  #
  # Empty means there is genuinely no CLOUD DNS zone to address. Two distinct ways that happens, and
  # the second is easy to get wrong:
  #
  #   * DNS is off entirely; or
  #   * a PLUGGABLE DNS CONNECTOR owns the zone (`dns_provider != "native"`, e.g. Cloudflare). Then
  #     `cloud_dns_zone_name` may well be set — the caller named their Cloudflare zone — and it is
  #     still NOT a Cloud DNS managed zone. Granting roles/dns.admin on it would fail the apply
  #     against a zone that does not exist in Cloud DNS, and exporting it would make
  #     CertManagerSolver() render a cloudDNS solver for a zone Cloudflare serves. The native guard
  #     wraps BOTH branches for that reason, not just the create branch.
  #
  # The created branch reads the MODULE'S OWN OUTPUT and never re-derives the name. That is not
  # stylistic: modules/cloud-dns builds `name = "${project_name}-${environment}-${zone_name}"`, so
  # the real zone is `alethia-nl-production-dns-ew3-production-alethia-nl` while `cloud_dns_name` is
  # only the last third of it. A re-derivation here would have pointed the roles/dns.admin grant at
  # a zone name that does not exist — an apply-time failure on the ONE path that previously worked.
  # (The `tofu test` in checks_ingress_armor.tftest.hcl caught exactly that during this change.)
  #
  # Guarded on the MODULE INSTANCE rather than on a copy of the module's count predicate, for the
  # reason outputs.tf sets out: a duplicated predicate drifted from the count once already and
  # planned an "Invalid index" that failed the whole apply. The probe replaced a
  # `length(module.cloud_dns) > 0` guard under #3509 — this local is read by module inputs, and
  # `length()` reads the module as a WHOLE, which is the edge that closes cycles (aws/rds.tf).
  #
  # Derived here rather than inline so `tofu test` can assert on it, and so the output and the IAM
  # grant read ONE value: the two cannot disagree about which zone the project has.
  external_dns_zone = try(module.cloud_dns[0].zone_name, null) != null ? module.cloud_dns[0].zone_name : (var.dns_provider == "native" ? var.cloud_dns_zone_name : "")

  # The external-dns GSA this deploy uses: the caller's adopted one, or the one we created.
  # Read by the zone-scoped grant, both Workload Identity bindings (external-dns AND cert-manager,
  # which shares this identity) and the output — never the resource — so adoption cannot be
  # honoured in one place and missed in another. A half-adopted deploy would grant the zone to one
  # identity and bind the KSA to the other, and external-dns would authenticate successfully as a
  # principal with no write anywhere.
  external_dns_adopted = var.provision_gke && var.external_dns_service_account_email != ""
  external_dns_sa_email = var.provision_gke ? (
    local.external_dns_adopted
    ? one(data.google_service_account.external_dns_adopted[*].email)
    : one(google_service_account.external_dns[*].email)
  ) : ""
  external_dns_sa_name = var.provision_gke ? (
    local.external_dns_adopted
    ? one(data.google_service_account.external_dns_adopted[*].name)
    : one(google_service_account.external_dns[*].name)
  ) : ""

  # The external-secrets GSA this deploy uses: the caller's adopted one, or the one we created.
  # Everything that grants to, binds, or exports the ESO identity reads these — never the resource
  # directly — so adoption cannot be honoured in one place and missed in another. A half-adopted
  # deploy would grant the created SA while the target project trusts the adopted one, and ESO would
  # authenticate as an identity with no read grant anywhere.
  external_secrets_adopted = var.provision_gke && var.external_secrets_service_account_email != ""
  external_secrets_sa_email = var.provision_gke ? (
    local.external_secrets_adopted
    ? one(data.google_service_account.external_secrets_adopted[*].email)
    : one(google_service_account.external_secrets[*].email)
  ) : ""
  external_secrets_sa_name = var.provision_gke ? (
    local.external_secrets_adopted
    ? one(data.google_service_account.external_secrets_adopted[*].name)
    : one(google_service_account.external_secrets[*].name)
  ) : ""

  # Whether the customer asked for provisioned boot-disk performance at all. Hoisted to the ROOT
  # rather than left inside modules/gke because `tofu test` can read `local.` in an assert and
  # cannot reach into a module — and modules/gke is unplannable under mocks (its computed-only
  # `master_auth` block cannot be overridden; see checks_cluster_optional.tftest.hcl). A predicate
  # that decides whether an apply is blocked has to be reachable from a test.
  gke_boot_disk_performance_requested = var.gke_volume_iops != null || var.gke_volume_throughput != null
}
