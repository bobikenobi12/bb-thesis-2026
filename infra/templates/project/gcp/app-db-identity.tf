#########################################################################
##        Keyless app→Cloud SQL identity (Workload Identity)  #722      ##
#########################################################################
# When Cloud SQL has IAM authentication enabled, the app workload connects to it KEYLESSLY:
# a Google service account is bound (via GKE Workload Identity) to the in-cluster app KSA and
# registered as a CLOUD_IAM_SERVICE_ACCOUNT database user (see modules/cloud-sql). The app pod runs
# the Cloud SQL Auth Proxy sidecar (--auto-iam-authn), which mints a short-lived IAM token from this
# identity — the workload holds NO database password.
#
# The KSA the app runs as is created + annotated by the generated GitOps manifests (the keyless
# manifest lane, #722): namespace/name below MUST match `manifests` keylessKSANamespace/keylessKSAName.
#
# ADOPTION, and why this template no longer creates the account or grants its roles:
#
#   `roles/cloudsql.client` and `roles/cloudsql.instanceUser` are PROJECT-scoped only. A Cloud SQL
#   instance is not IAM-policy-bearing — the Admin API exposes no get/setIamPolicy on instances and
#   there is no google_sql_database_instance_iam_member in the provider, so the zone-scoped /
#   per-secret trick used for external-dns and external-secrets has no Cloud SQL analogue. Google's
#   own recipe narrows to an instance by putting a CONDITION on a project-level binding; the binding
#   is still project-level.
#
#   Writing one needs resourcemanager.projects.setIamPolicy, which the provisioner deliberately does
#   NOT hold — #300 stripped project-scoped IAM from this template precisely to drop that
#   owner-equivalent permission. #722 reintroduced two project bindings here a week later and they
#   were the only survivors of that purge; they 403 on every apply. GCP has no principal-pattern
#   condition (no aws:PrincipalArn analogue), so the grant also cannot be pre-written against a
#   per-deploy identity, whose email derives from region/environment/project_name.
#
#   So the account is created and granted ONCE by the customer in the connector bootstrap module
#   (infra/connector/gcp), under their own admin rights, and adopted here via
#   var.cloud_sql_app_service_account_email. Same shape as external_secrets_service_account_email.
#
#   TRADE-OFF, accepted deliberately: one stable account per customer GCP project replaces one per
#   environment, so it becomes a Cloud SQL database user on EVERY instance in that project — one
#   environment's app identity can log in to another environment's instance. The SQL GRANTs issued
#   by the keyless bootstrap Job still scope what it may do inside each database. This is accepted
#   because the isolation boundary that matters is the customer's GCP project, and it is stated in
#   the connector docs rather than left to be discovered.
#
#   OPT-IN: leaving the variable empty leaves keyless off and the app keeps using the BUILT_IN
#   password user. Nothing 403s either way.

locals {
  # Coupling point with packages/core/manifests (keylessKSAName / keylessKSANamespace).
  app_ksa_namespace = "default"
  app_ksa_name      = "alethia-app"

  # What the OPERATOR ASKED FOR, cluster-independent — checks_data.tf judges this, so the
  # keyless_cloud_sql_app_identity_wired warning keeps firing on a cluster-less shape instead of
  # going silent the moment the build predicate learned about the cluster.
  app_db_iam_requested = var.create_cloud_sql && var.cloud_sql_iam_auth

  # Whether the operator supplied an account to adopt. Keyless cannot be wired without one — see
  # the ADOPTION note above — so this is the second half of the build predicate.
  app_db_adopted = var.cloud_sql_app_service_account_email != ""

  # What gets BUILT additionally needs the cluster, for the same reason as registry-pull.tf's
  # enable_gar_pull: google_service_account_iam_member.app_db_wi below binds this GSA into the GKE
  # WORKLOAD IDENTITY POOL, which is created BY the cluster and named as a plain STRING — so with
  # `create_cloud_sql = true, cloud_sql_iam_auth = true, provision_gke = false` it planned clean and
  # failed at APPLY with "Error 400: Identity Pool does not exist". Azure gates the equivalent local
  # on `var.provision_aks` (app-db-identity.tf) and AWS's RDS-IAM IRSA role now gates on
  # `var.provision_eks`; this is the GCP parity for #1772.
  #
  # Consequence, deliberately: with no cluster — or with no adopted account — cloud-sql.tf registers
  # no CLOUD_IAM_SERVICE_ACCOUNT database user. That is the honest answer (the identity's whole
  # purpose is to be impersonated by an in-cluster KSA), and the check in checks_data.tf still says
  # so out loud rather than letting it pass unremarked.
  enable_app_db_iam = var.provision_gke && local.app_db_iam_requested && local.app_db_adopted
}

# The adopted account. READ, never created — a wrong or absent email then fails the PLAN, loudly,
# instead of provisioning a cluster whose app can authenticate to nothing (same rationale as
# data.google_service_account.external_secrets_adopted in workload-identity.tf).
data "google_service_account" "app_db_adopted" {
  count      = local.enable_app_db_iam ? 1 : 0
  project    = var.project_id
  account_id = var.cloud_sql_app_service_account_email
}

# Bind the adopted GSA to the app KSA via Workload Identity, so a pod running as that KSA
# impersonates it with no static key. This is a GSA-SCOPED policy write — iam.serviceAccounts.
# setIamPolicy, which the provisioner holds through the custom alethiaServiceAccountProvisioner role
# — not a project one, which is the whole point. `member` names the WI pool as a STRING, so the
# dependency on the cluster must be explicit (same race as external_dns_wi — Identity Pool does not
# exist otherwise).
resource "google_service_account_iam_member" "app_db_wi" {
  count              = local.enable_app_db_iam ? 1 : 0
  service_account_id = one(data.google_service_account.app_db_adopted[*].name)
  role               = "roles/iam.workloadIdentityUser"
  member             = "serviceAccount:${var.project_id}.svc.id.goog[${local.app_ksa_namespace}/${local.app_ksa_name}]"

  depends_on = [module.gke]
}

# MIGRATION (#722 → adoption), and why there are no `removed` blocks here.
#
# google_project_iam_member.app_db_client / .app_db_instance_user are simply deleted from the
# configuration. They can never be in state to migrate: creating them is the call that 403s, so the
# apply dies before they are recorded. The only shape that holds them is a project whose provisioner
# WAS given setIamPolicy — and that same credential can destroy them, so the ordinary path works.
#
# google_service_account.app_db (the per-deployment identity) CAN be in state, since it is created
# before the grants that fail. Deleting it from the configuration destroys it, which is right: it is
# replaced by the adopted account, and the provisioner holds iam.serviceAccounts.delete. An
# environment that had one switches identity; if none was adopted, keyless goes off and the app
# falls back to the BUILT_IN password user.
#
# `removed { lifecycle { destroy = ... } }` would express the above more precisely, but it is NOT
# USABLE on the engine that runs this template: OpenTofu 1.9.0 — the version the runner applies and
# `check (gcp)` pins — rejects it with "Blocks of type `lifecycle` are not expected here"
# (opentofu/opentofu#2556; the parser gained it later). A bare `removed` block parses on 1.9.0, but
# OpenTofu documents no default for the omitted `destroy`, and the two possible defaults differ by
# whether a live service account is deleted. Deleting the resources outright is the behaviour we can
# actually name.

