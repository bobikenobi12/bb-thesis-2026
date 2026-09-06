# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# RDS + S3 data-tier invariants.
# Split out of checks.tf so each feature owns its file (IaC rule: one file per component).
# Add new checks for THIS feature here; never append to checks.tf.


# When an RDS cluster is created, a database name must be supplied.
check "rds_db_name_present_when_created" {
  assert {
    condition     = !var.create_rds || length(trimspace(var.rds_config.db_name)) > 0
    error_message = "create_rds is true but rds_config.db_name is empty; set a database name."
  }
}


# Keyless RDS IAM auth (#722): when the RDS engine flag is on, the app IRSA role must also be created
# (one iam_auth toggle drives both, via the provider tfvars) — otherwise the DB accepts IAM tokens but
# no workload identity can mint one and the keyless binding fails closed.
check "keyless_rds_iam_irsa_wired" {
  assert {
    # The `provision_eks` term is not a loophole, it is the truth (#1772): the IRSA role federates to
    # THIS cluster's OIDC provider, so a cluster-less shape has no identity to mint tokens with and
    # the role is correctly absent. Naming it keeps the message actionable — without the term this
    # would tell an operator to "set rds_iam_irsa" on a shape where rds_iam_irsa changes nothing.
    #
    # `length()` and not the instance probe used for module OUTPUTS (#3509): this asserts the module's
    # EXPANSION, reads nothing out of it, and a check block is a graph leaf — so the whole-module edge
    # that rules `length()` out elsewhere costs nothing here, and no probe could ask this question.
    condition     = !var.rds_iam_auth_enabled || !var.provision_eks || length(module.rds_iam_auth) == 1
    error_message = "rds_iam_auth_enabled is on but the app RDS-IAM IRSA role is missing; set rds_iam_irsa (the iam_auth toggle should drive both)."
  }
}


# Aurora engine/family agreement (#1504). Every template default is Aurora-PostgreSQL-shaped, so a
# MySQL engine that arrives without a matching cluster_family silently composes a MySQL cluster on a
# `aurora-postgresql16` parameter group. Note the family forms differ by engine: Aurora MySQL is
# MAJOR.MINOR ("aurora-mysql8.0"), Aurora PostgreSQL is MAJOR only ("aurora-postgresql16").
# This check WARNS; terraform_data.rds_engine_shape_guard below is the hard gate.
check "rds_cluster_family_matches_engine" {
  assert {
    condition = !var.create_rds || (
      strcontains(var.rds_config.engine, "mysql")
      ? startswith(var.rds_config.cluster_family, "aurora-mysql")
      : startswith(var.rds_config.cluster_family, "aurora-postgresql")
    )
    error_message = "rds_config.cluster_family (${var.rds_config.cluster_family}) does not match rds_config.engine (${var.rds_config.engine}); Aurora MySQL needs aurora-mysqlX.Y and Aurora PostgreSQL needs aurora-postgresqlX."
  }
}


# Aurora engine/port agreement (#1504). The port default is 5432, so a MySQL cluster that inherits it
# listens on the Postgres port and every keyless binding (which stamps the port onto the app's wire)
# connects to nothing.
check "rds_port_matches_engine" {
  assert {
    condition = !var.create_rds || (
      strcontains(var.rds_config.engine, "mysql")
      ? var.rds_config.db_port == 3306
      : var.rds_config.db_port == 5432
    )
    error_message = "rds_config.db_port (${var.rds_config.db_port}) does not match rds_config.engine (${var.rds_config.engine}); use 3306 for Aurora MySQL and 5432 for Aurora PostgreSQL."
  }
}


# Aurora engine/log-export agreement (#1504). Aurora MySQL rejects the "postgresql" log type outright
# (and vice versa), so a mismatched export set fails at apply — after the cluster starts creating.
check "rds_log_exports_match_engine" {
  assert {
    condition = !var.create_rds || alltrue([
      for l in var.rds_logs_exports :
      strcontains(var.rds_config.engine, "mysql")
      ? contains(["audit", "error", "general", "slowquery"], l)
      : l == "postgresql"
    ])
    error_message = "rds_logs_exports ${jsonencode(var.rds_logs_exports)} is not valid for rds_config.engine (${var.rds_config.engine}); Aurora MySQL accepts audit/error/general/slowquery and Aurora PostgreSQL accepts postgresql."
  }
}


# Keyless rds-db:connect scoping (#1504 → #1509): when IAM auth is on, the cluster resource id must
# actually resolve. Upstream emits join("", …), so an absent cluster yields "" rather than null — and
# an empty resource id would silently widen the connect ARN to a wildcard.
check "rds_cluster_resource_id_resolvable_when_iam_auth" {
  assert {
    # try(): with create_rds off the module is an EMPTY TUPLE and the index raises instead of
    # failing the check — the whole point is a clean, actionable failure, so collapse any
    # unresolvable id to false. The index replaced `one(module.rds_maindb[*]…)` (#3509): the splat
    # reads the module as a whole, and this file's other checks must not order behind it. A renamed
    # output is still caught — it makes the condition FALSE, so the check reports rather than passes.
    condition     = !var.rds_iam_auth_enabled || length(trimspace(try(module.rds_maindb[0].rds_cluster_resource_id, null) != null ? module.rds_maindb[0].rds_cluster_resource_id : "")) > 0
    error_message = "rds_iam_auth_enabled is on but rds_cluster_resource_id is empty; the rds-db:connect ARN cannot be scoped to this cluster."
  }
}


# Fail-closed apply gate for the Aurora engine invariants (#1504). The four `check` blocks above only
# WARN — they surface the violation loudly at plan time but never stop an apply — so this
# terraform_data precondition is the actual gate, matching terraform_data.compat_k8s_guard (COMPAT-001).
#
# It matters here because the failure is silent by construction: a MySQL engine composed onto the
# Aurora-PostgreSQL-shaped defaults produces a plan that SUCCEEDS and a cluster that never serves. That
# includes the case where the tfvars writer could not derive a family and deliberately omitted the key
# (packages/core/cloud/aws_provider.go), and the case where a customer's provider_config passthrough
# overrides rds_config with a mismatched pair. No bypass variable — an engine and its parameter-group
# family are not a matter of opinion.
resource "terraform_data" "rds_engine_shape_guard" {
  lifecycle {
    precondition {
      condition = !var.create_rds || (
        strcontains(var.rds_config.engine, "mysql")
        ? startswith(var.rds_config.cluster_family, "aurora-mysql")
        : startswith(var.rds_config.cluster_family, "aurora-postgresql")
      )
      error_message = "RDS-ENGINE-001: rds_config.cluster_family '${var.rds_config.cluster_family}' does not match rds_config.engine '${var.rds_config.engine}'. Apply blocked fail-closed — Aurora MySQL needs an aurora-mysqlX.Y family, Aurora PostgreSQL an aurora-postgresqlX family."
    }

    precondition {
      condition = !var.create_rds || (
        strcontains(var.rds_config.engine, "mysql")
        ? var.rds_config.db_port == 3306
        : var.rds_config.db_port == 5432
      )
      error_message = "RDS-ENGINE-002: rds_config.db_port ${var.rds_config.db_port} does not match rds_config.engine '${var.rds_config.engine}'. Apply blocked fail-closed — use 3306 for Aurora MySQL and 5432 for Aurora PostgreSQL."
    }

    precondition {
      condition = !var.create_rds || alltrue([
        for l in var.rds_logs_exports :
        strcontains(var.rds_config.engine, "mysql")
        ? contains(["audit", "error", "general", "slowquery"], l)
        : l == "postgresql"
      ])
      error_message = "RDS-ENGINE-003: rds_logs_exports ${jsonencode(var.rds_logs_exports)} is not valid for rds_config.engine '${var.rds_config.engine}'. Apply blocked fail-closed — Aurora MySQL accepts audit/error/general/slowquery, Aurora PostgreSQL accepts postgresql."
    }
  }
}


# Every S3 bucket must keep public access blocked (block_public_acls / restrict_public_buckets must
# not be explicitly false). null is allowed — the module defaults those to a blocked posture.
check "s3_buckets_block_public_access" {
  assert {
    condition = alltrue([
      for b in var.bucket_configuration :
      b.block_public_acls != false && b.restrict_public_buckets != false
    ])
    error_message = "Every S3 bucket must keep block_public_acls and restrict_public_buckets non-false (public access blocked)."
  }
}
