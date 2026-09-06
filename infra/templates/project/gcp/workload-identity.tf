#########################################################################
##            Workload Identity for cluster add-ons                    ##
#########################################################################
# Binds a Google service account to the in-cluster external-dns KSA via GKE
# Workload Identity, so external-dns manages Cloud DNS with NO static key.
# The GSA email is exported as `external_dns_service_account` and rendered onto
# the external-dns ServiceAccount by the ArgoCD Application
# (iam.gke.io/gcp-service-account annotation). This is the GCP analogue of the
# AWS IRSA role the EKS path uses.

# ADOPTION (var.external_dns_service_account_email): when set, this template does NOT create the
# GSA — it uses the caller's pre-existing one. Same shape as external_secrets below, and for a
# reason that is specific and load-bearing (#2811).
#
# external-dns's Google provider calls managedZones.List(PROJECT) unconditionally on every
# reconcile, including the first. `dns.managedZones.list` is a PROJECT-level permission and
# `gcloud iam list-testable-permissions` on a managed zone does not offer it at all — so no
# zone-scoped binding can ever satisfy external-dns, and the zone-scoped roles/dns.admin below,
# correct as it is for WRITES, leaves the controller in CrashLoopBackOff on `Error 403: Forbidden`
# while ArgoCD reports the Application Synced.
#
# The remedy is a project-level binding, and writing one needs resourcemanager.projects.
# setIamPolicy — which the provisioner deliberately does NOT hold (#300 removed project-scoped IAM
# across this template) and which is self-escalating: a principal that can write project IAM can
# grant itself owner. That verb has no narrower form, so it follows the ruling already made for
# serviceusage.services.enable — it becomes an ONBOARDING step the customer performs once.
# infra/connector/gcp creates a standing external-dns GSA and grants it a custom role holding
# exactly `dns.managedZones.list`, and this template adopts it.
#
# Empty (the default) keeps the create-our-own behaviour byte-identical. That path still cannot
# list zones, so DNSProvider()/cert-manager continue to work exactly as before for everything that
# does not need a project-level read — this is opt-in, and it is the only path that WORKS.
resource "google_service_account" "external_dns" {
  count        = var.provision_gke && var.external_dns_service_account_email == "" ? 1 : 0
  project      = var.project_id
  account_id   = "extdns-${substr(sha256(local.gke_name), 0, 8)}"
  display_name = "external-dns (${var.project_name})"
}

# The adopted GSA. Read rather than created, so a wrong or absent email fails the PLAN loudly
# instead of provisioning a cluster whose external-dns authenticates as nothing.
data "google_service_account" "external_dns_adopted" {
  count      = var.provision_gke && var.external_dns_service_account_email != "" ? 1 : 0
  project    = var.project_id
  account_id = var.external_dns_service_account_email
}

# Least-privilege: grant external-dns dns.admin on the PROJECT'S managed zone only,
# not project-wide. Project-wide dns.admin forced the provisioner to hold
# resourcemanager.projectIamAdmin (owner-equivalent) to write it; the zone-scoped
# binding needs only dns.admin on the one zone this project serves.
#
# The zone may be one we CREATED or one the caller BROUGHT (#2294). Both need the binding, and the
# distinction is invisible from here — a zone-scoped grant addresses a zone by NAME, so the same
# resource covers both cases once the name resolves from either source. Gating this on
# `cloud_dns_enabled` alone was correct only while that variable meant "DNS is in play"; now that it
# is the CREATE gate, doing so would leave a brought zone with NO binding, and external-dns and
# cert-manager's DNS01 solver (which shares this identity) would fail to write into the customer's
# own zone while every plan stayed green.
#
# Still no binding when there is no zone at all: local.external_dns_zone is "" and the count is 0.
resource "google_dns_managed_zone_iam_member" "external_dns_dns" {
  count        = var.provision_gke && local.external_dns_zone != "" ? 1 : 0
  project      = var.project_id
  managed_zone = local.external_dns_zone
  role         = "roles/dns.admin"
  member       = "serviceAccount:${local.external_dns_sa_email}"
}

resource "google_service_account_iam_member" "external_dns_wi" {
  count              = var.provision_gke ? 1 : 0
  service_account_id = local.external_dns_sa_name
  role               = "roles/iam.workloadIdentityUser"
  member             = "serviceAccount:${var.project_id}.svc.id.goog[external-dns/external-dns-sa]"

  # The `<project>.svc.id.goog` Workload Identity pool only exists once a WI-enabled cluster does.
  # `member` names it as a STRING, so OpenTofu infers no dependency edge and schedules this binding
  # concurrently with the cluster → "Error 400: Identity Pool does not exist". Observed live on a
  # real apply. The edge must be explicit.
  depends_on = [module.gke]
}

# The SAME GSA, bound to a SECOND KSA: cert-manager's DNS01 solver. It writes a TXT record
# into the project's managed zone and deletes it again — precisely the operation the
# zone-scoped `roles/dns.admin` above already grants, so cert-manager reuses external-dns's
# identity rather than minting a parallel one with an identical policy.
#
# Workload Identity binds ONE KSA per member string, so this second binding is what makes
# the iam.gke.io/gcp-service-account annotation infra/templates/argocd/cert-manager.yaml
# puts on `cert-manager:cert-manager` actually resolve. Without it the token exchange is
# refused and every DNS01 challenge fails inside a certificate that simply never issues.
#
# NOTE the zone-scoped grant is why the cloudDNS solver is rendered with an explicit
# `hostedZoneName` (InfraFacts.GCPDNSZoneName, root output `cloud_dns_zone_name`): a
# zone-scoped binding does not carry the project-level `dns.managedZones.list` permission
# cert-manager would otherwise need to FIND the zone. CertManagerSolver() fails closed when
# that output is absent, so we never ship an issuer that cannot look its zone up.
resource "google_service_account_iam_member" "cert_manager_wi" {
  count              = var.provision_gke ? 1 : 0
  service_account_id = local.external_dns_sa_name
  role               = "roles/iam.workloadIdentityUser"
  member             = "serviceAccount:${var.project_id}.svc.id.goog[cert-manager/cert-manager]"

  # Same Identity-Pool race as external_dns_wi above — the edge must be explicit.
  depends_on = [module.gke]
}

# The SAME GSA, bound to a THIRD KSA: the MARKETPLACE external-dns add-on
# (apps/console/lib/addons/catalog.ts, EXTERNAL_DNS_ADDON_SA = "addon-external-dns-sa").
#
# A distinct KSA from the rail's `external-dns-sa` on purpose: both Applications deploy into the
# `external-dns` namespace, so naming one object would put two ArgoCD Applications on it. The zone
# grant it needs is the one this GSA already carries, so — exactly as with cert-manager above — the
# add-on reuses this identity rather than minting a parallel one with an identical policy.
resource "google_service_account_iam_member" "external_dns_addon_wi" {
  count              = var.provision_gke ? 1 : 0
  service_account_id = local.external_dns_sa_name
  role               = "roles/iam.workloadIdentityUser"
  member             = "serviceAccount:${var.project_id}.svc.id.goog[external-dns/addon-external-dns]"

  # Same Identity-Pool race as external_dns_wi above — the edge must be explicit.
  depends_on = [module.gke]
}

# GSA for the external-secrets operator: bound to its KSA via Workload Identity so the
# gcpsm ClusterSecretStore reads Secret Manager with NO static key. Exported as
# `external_secrets_service_account` and rendered onto the operator's ServiceAccount
# (iam.gke.io/gcp-service-account annotation) by the ArgoCD Application.
#
# ADOPTION (var.external_secrets_service_account_email): when set, this template does NOT create the
# GSA — it uses the caller's pre-existing one instead. The reason is cross-project reads. A
# cross-project grant in the TARGET project names this GSA by email, and GCP does not treat a
# same-named recreation as the same identity: destroying the SA rewrites the binding to
# `deleted:serviceAccount:…?uid=<old-uid>`, which the new SA does not inherit. GCP IAM also has no
# principal-pattern condition (no `aws:PrincipalArn` analogue), so there is no way to write a
# durable grant against a per-run identity. Adopting a stable GSA is what lets the target-project
# grant be applied ONCE instead of on every provision.
#
# Empty (the default) keeps the create-our-own behavior byte-identical — this is opt-in.
resource "google_service_account" "external_secrets" {
  count        = var.provision_gke && var.external_secrets_service_account_email == "" ? 1 : 0
  project      = var.project_id
  account_id   = "extsec-${substr(sha256(local.gke_name), 0, 8)}"
  display_name = "external-secrets (${var.project_name})"
}

# The adopted GSA. Read rather than created, so a wrong/absent email fails the plan loudly instead
# of silently provisioning a cluster whose ESO can authenticate to nothing.
data "google_service_account" "external_secrets_adopted" {
  count      = var.provision_gke && var.external_secrets_service_account_email != "" ? 1 : 0
  project    = var.project_id
  account_id = var.external_secrets_service_account_email
}

# Least-privilege: secretAccessor is granted PER SECRET (the ones this template creates via
# modules/secret-manager), not project-wide — a project-level binding would force the
# provisioner to hold resourcemanager.projectIamAdmin (same rationale as the zone-scoped
# external-dns binding above). Keyed by the secret's declared name (known at plan time).
resource "google_secret_manager_secret_iam_member" "external_secrets_accessor" {
  # Gated on secrets_provider == "native": when a pluggable provider takes over, the
  # native secrets aren't created, so granting per-secret secretAccessor on them would
  # fail the apply (parity with Alibaba's eso_rrsa_enabled gating).
  for_each = var.provision_gke && var.secrets_provider == "native" ? { for s in var.custom_secrets : s.name => s } : {}

  project   = var.project_id
  secret_id = "${var.environment}-${var.project_name}-${each.key}"
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${local.external_secrets_sa_email}"

  depends_on = [module.secret_manager]
}

# Parity with the AWS path (which grants ESO read on the RDS master/extra credential
# secrets): the Cloud SQL module stores DB credentials in its own Secret Manager secret
# outside custom_secrets, so grant secretAccessor on it too — otherwise an ExternalSecret
# syncing DB creds succeeds on AWS but PermissionDenies on GCP.
resource "google_secret_manager_secret_iam_member" "external_secrets_sql_accessor" {
  count = var.provision_gke && var.create_cloud_sql ? 1 : 0

  project   = var.project_id
  secret_id = try(module.cloud_sql[0].credentials_secret_id, null) != null ? module.cloud_sql[0].credentials_secret_id : ""
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${local.external_secrets_sa_email}"
}

resource "google_service_account_iam_member" "external_secrets_wi" {
  count              = var.provision_gke ? 1 : 0
  service_account_id = local.external_secrets_sa_name
  role               = "roles/iam.workloadIdentityUser"
  member             = "serviceAccount:${var.project_id}.svc.id.goog[external-secrets-operator/external-secrets-operator-sa]"

  # Same race as external_dns_wi: the WI pool only exists once the cluster does, and `member`
  # references it as a string, so the dependency must be explicit.
  depends_on = [module.gke]
}
