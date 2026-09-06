#########################################################################
##     Keyless app→database identity (Entra Workload Identity)  #722    ##
#########################################################################
# When the Flexible Server has Entra (AAD) authentication enabled, the app workload connects to it
# KEYLESSLY: a user-assigned managed identity is federated (via AKS Workload Identity) to the app KSA,
# so the app authenticates with a short-lived Entra access token (scope ossrdbms-aad.database.windows.net
# — shared by PostgreSQL, MySQL and MariaDB) minted from its own identity — no password. The app pod
# runs the token-refresher + a local proxy (see the manifest keyless lane + Lane D); this mirrors the
# external-dns / external-secrets federated-identity pattern.
#
# BOTH ENGINES (#1464): the app identity, its federation, and the outputs are engine-agnostic and are
# created for PostgreSQL and MySQL alike. What differs is only the RUNTIME bind the bootstrap Job issues
# (see below) and the app-pod proxy wire protocol (the manifest lanes' concern, #1449/#1441), not this
# identity plumbing.
#
# LEAST-PRIVILEGE (#722 R5): the app identity is NOT the server's Entra administrator. A SEPARATE
# `db_admin` managed identity is registered as the sole Entra administrator; it is federated only to
# the one-shot bootstrap Job's KSA (default/alethia-db-bootstrap). That Job (an ArgoCD PreSync hook)
# logs in as the admin, creates a SCOPED login for the app, and exits:
#   - Postgres: a role bound to the app UAMI's OBJECT id via a pgaadauth SECURITY LABEL (--app-oid).
#   - MySQL:    CREATE AADUSER '<alias>' IDENTIFIED BY '<app UAMI CLIENT id>' (--app-client-id).
# granted only working privileges. The app UAMI (`app_db`) therefore only ever logs in as that scoped
# role/user — never as a superuser/admin.
#
# The federated subjects (namespace/name of each KSA) MUST match `manifests`:
#   app_db   → keylessKSANamespace/keylessKSAName          (the app pod)
#   db_admin → keylessKSANamespace/keylessBootstrapKSAName (the bootstrap Job pod)

locals {
  # Coupling point with packages/core/manifests (keylessKSAName / keylessBootstrapKSAName /
  # keylessKSANamespace).
  azure_app_ksa_namespace  = "default"
  azure_app_ksa_name       = "alethia-app"
  azure_bootstrap_ksa_name = "alethia-db-bootstrap"
  # PostgreSQL keyless: gates the Postgres-specific Entra-admin registration (a Flexible Server
  # `active_directory_administrator` keyed on server NAME). The app-side identity itself is no longer
  # gated on this — see enable_app_db_identity below — but the PG admin resource still keys off it.
  enable_app_db_aad = var.create_azure_db && var.azure_db_iam_auth && var.provision_aks && var.azure_db_engine == "postgres"

  # The SERVER side of MySQL Entra: a MySQL Flexible Server carries the dedicated db_admin identity as
  # its Entra administrator (a SEPARATE resource keyed on server ID). This lets an operator — and the
  # bootstrap Job — authenticate without a password. Note: no provision_aks term (the server admin is
  # useful even without a cluster).
  enable_mysql_entra = var.create_azure_db && var.azure_db_iam_auth && var.azure_db_engine == "mysql"

  # Either path needs the dedicated admin identity.
  enable_db_admin_identity = local.enable_app_db_aad || local.enable_mysql_entra

  # The APP-side keyless identity — the app UAMI, its app-KSA + bootstrap-KSA federations, and the
  # keyless outputs — is engine-agnostic and now covers MySQL too (#1464). The app's actual DB login is
  # granted at RUNTIME by the bootstrap Job (Postgres: pgaadauth SECURITY LABEL on the app OID; MySQL:
  # CREATE AADUSER … IDENTIFIED BY '<app client id>'); this template only creates the identity and
  # federates it. Federation needs the AKS OIDC issuer, so the MySQL branch also requires provision_aks
  # (enable_mysql_entra alone omits it). The app UAMI is never the admin — least-privilege holds for both.
  enable_app_db_identity = local.enable_app_db_aad || (local.enable_mysql_entra && var.provision_aks)
}

########################################################################
# App identity — the pod's login identity, federated to the app KSA.   #
# Scoped (NOT admin): the bootstrap Job binds it to a least-priv role. #
########################################################################

resource "azurerm_user_assigned_identity" "app_db" {
  count               = local.enable_app_db_identity ? 1 : 0
  name                = "${local.aks_name}-appdb"
  resource_group_name = azurerm_resource_group.main.name
  location            = var.location
}

resource "azurerm_federated_identity_credential" "app_db" {
  count               = local.enable_app_db_identity ? 1 : 0
  name                = "app-db"
  resource_group_name = azurerm_resource_group.main.name
  parent_id           = one(azurerm_user_assigned_identity.app_db[*].id)
  audience            = ["api://AzureADTokenExchange"]
  issuer              = try(module.aks[0].oidc_issuer_url, null) != null ? module.aks[0].oidc_issuer_url : ""
  subject             = "system:serviceaccount:${local.azure_app_ksa_namespace}:${local.azure_app_ksa_name}"
}

########################################################################
# Dedicated DB-admin identity — the ONLY Entra administrator. Federated #
# solely to the bootstrap Job's KSA, so no app pod can assume it.       #
########################################################################

resource "azurerm_user_assigned_identity" "db_admin" {
  count               = local.enable_db_admin_identity ? 1 : 0
  name                = "${local.aks_name}-dbadmin"
  resource_group_name = azurerm_resource_group.main.name
  location            = var.location
}

resource "azurerm_federated_identity_credential" "db_admin" {
  count               = local.enable_app_db_identity ? 1 : 0
  name                = "db-admin"
  resource_group_name = azurerm_resource_group.main.name
  parent_id           = one(azurerm_user_assigned_identity.db_admin[*].id)
  audience            = ["api://AzureADTokenExchange"]
  issuer              = try(module.aks[0].oidc_issuer_url, null) != null ? module.aks[0].oidc_issuer_url : ""
  subject             = "system:serviceaccount:${local.azure_app_ksa_namespace}:${local.azure_bootstrap_ksa_name}"
}

# Register the DEDICATED admin identity (not the app) as the server's Entra administrator, so the
# bootstrap Job can create the app's scoped role. The app identity holds no admin rights.
resource "azurerm_postgresql_flexible_server_active_directory_administrator" "db_admin" {
  count               = local.enable_app_db_aad ? 1 : 0
  server_name         = try(module.azure_db[0].server_name, null) != null ? module.azure_db[0].server_name : ""
  resource_group_name = azurerm_resource_group.main.name
  tenant_id           = data.azurerm_client_config.current.tenant_id
  object_id           = one(azurerm_user_assigned_identity.db_admin[*].principal_id)
  principal_name      = one(azurerm_user_assigned_identity.db_admin[*].name)
  principal_type      = "ServicePrincipal"
}

# MySQL's Entra administrator is a SEPARATE resource keyed on the server ID, and it requires the
# server to already carry a user-assigned identity (passed in as `aad_identity_id` — the same
# db_admin identity, so no third principal exists). PostgreSQL's equivalent keys on the server NAME
# and needs no server identity at all; assuming they were the same shape is exactly the class of
# mistake #1382 was.
resource "azurerm_mysql_flexible_server_active_directory_administrator" "db_admin" {
  count = local.enable_mysql_entra ? 1 : 0

  server_id   = try(module.azure_db[0].server_id, null) != null ? module.azure_db[0].server_id : ""
  identity_id = one(azurerm_user_assigned_identity.db_admin[*].id)
  login       = one(azurerm_user_assigned_identity.db_admin[*].name)
  object_id   = one(azurerm_user_assigned_identity.db_admin[*].principal_id)
  tenant_id   = data.azurerm_client_config.current.tenant_id
}

# Keyless MySQL is dead without the app UAMI: the app authenticates to MySQL with its own Entra token,
# so if the app identity is missing (or its keyless outputs resolve null) the app can never log in —
# exactly the silent-null class of failure #1382 was. Assert the app identity exists whenever a keyless
# MySQL cluster is provisioned with AKS.
check "mysql_keyless_app_identity" {
  assert {
    condition     = !(local.enable_mysql_entra && var.provision_aks) || length(azurerm_user_assigned_identity.app_db) == 1
    error_message = "Keyless MySQL on AKS must create the app UAMI so the app can authenticate to MySQL via its own Entra token."
  }
}
