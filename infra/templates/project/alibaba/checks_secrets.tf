# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# RRSA workload-identity + external-secrets invariants.
# Split out of checks.tf so each feature owns its file (IaC rule: one file per component).
# Add new checks for THIS feature here; never append to checks.tf.

check "ack_rrsa_provider_present" {
  assert {
    # The `try()` brings this into line with the identical assertion on aws (checks_secrets.tf),
    # which has always carried one, and with its own sibling below.
    #
    # CORRECTED (#1920). This note used to say OpenTofu's short-circuiting IS reliable and that the
    # `try()` was therefore belt-and-braces against a future reordering. That was measured on the
    # wrong binary. Short-circuiting is VERSION-DEPENDENT, and it is ABSENT in the version this
    # product ships — so the `try()` is load-bearing, today, exactly where it stands:
    #
    #   fixture: !requested || (… && module.x[0].out != null), module absent
    #   1.9.0   (apps/runner/Dockerfile.base TOFU_VERSION, compat matrix `tofu`) → Invalid index
    #   1.10.10 (what infra-templates.yml gated with until #1931) and 1.12.3     → plans clean
    #
    # Strip the `try()` here and the alibaba template stops planning on every cluster-less project,
    # which is how the same expression on gcp (checks_data.tf) took the gcp nightly leg down at
    # `planning`. The template gate did not see it because it ran 1.10.10; #1931 coupled that env
    # to compat matrix `static_couplings[tofu]`, so it now runs the engine the runner applies.
    #
    # What the note got right, and still holds: the `try()` cannot hide a rename, because the
    # surrounding `length(trimspace(…)) > 0` fails the check on "" just as loudly.
    condition     = !var.provision_ack || length(trimspace(try(module.cluster[0].rrsa_oidc_provider_arn, null) != null ? module.cluster[0].rrsa_oidc_provider_arn : "")) > 0
    error_message = "ACK RRSA (workload identity) did not report an OIDC provider ARN — in-cluster components can't assume RAM roles."
  }
}

check "external_secrets_rrsa_role_present" {
  assert {
    condition     = !local.eso_rrsa_enabled || length(trimspace(try(alicloud_ram_role.external_secrets[0].arn, ""))) > 0
    error_message = "Native KMS secrets exist on an ACK cluster but the external-secrets RRSA role reported no ARN — the ESO ClusterSecretStore cannot authenticate."
  }
}
