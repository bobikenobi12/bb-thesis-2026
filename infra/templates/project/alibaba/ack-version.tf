# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Resolving the ACK Kubernetes MINOR to the full version ACK's create API actually accepts.
#
# WHAT BROKE. The first real alibaba apply this repo has ever run (32836116442, 2026-08-25) died
# 211s in with
#
#   400: no ros component exists. clusterType: ManagedKubernetes, version: 1.35
#
# ACK builds a managed cluster from a ROS component named for a version, and it looks that name up
# by EXACT STRING. We were passing the bare minor `1.35`. The region offers exactly three versions —
#
#   1.36.2-aliyun.1 · 1.35.7-aliyun.1 · 1.34.10-aliyun.1
#
# — so 1.35 IS available, under a spelling we never sent. The error quotes our own string back.
#
# WHY NOT JUST HARDCODE `1.35.7-aliyun.1`. Because the minor is the shape the whole system speaks:
# packages/core/compat/matrix.json records `k8s_cloud.alibaba = ["1.35","1.34","1.33"]`, the other
# four clouds are minors too, and checks_compat.tf gates on the minor. Pinning a PATCH here would
# satisfy today's guard (`split(".", "1.35.7-aliyun.1")[1]` still parses `35`) and then rot silently
# the first time Alibaba retires that patch — reintroducing this exact 400 with no code change to
# blame.
#
# So: keep declaring the minor, and resolve it against what the region actually offers, at plan time.

# Every version ACK offers for a managed cluster in this region. Unfiltered on purpose: the data
# source's own `kubernetes_version` argument matches exactly, which is the very thing that cannot
# work here — we hold a minor and the catalogue holds patches.
data "alicloud_cs_kubernetes_version" "available" {
  count        = var.provision_ack ? 1 : 0
  cluster_type = "ManagedKubernetes"
}

locals {
  # The offered versions whose patch line belongs to the requested minor. The trailing dot matters:
  # without it "1.3" would match "1.34.10-aliyun.1", and a typo'd minor would silently provision a
  # cluster the operator did not ask for.
  ack_version_candidates = var.provision_ack ? [
    for m in one(data.alicloud_cs_kubernetes_version.available[*].metadata) : m.version
    if startswith(m.version, "${var.ack_cluster_version}.")
  ] : []

  # The version handed to alicloud_cs_managed_kubernetes. When nothing matches this is deliberately
  # left as the raw minor rather than defaulted to some other version: the guard below fails the
  # apply, and a silent substitution would be worse than the 400 it replaces — the operator would
  # get a cluster on a Kubernetes version they did not choose.
  ack_resolved_version = length(local.ack_version_candidates) > 0 ? local.ack_version_candidates[0] : var.ack_cluster_version
}

# Fail-closed apply gate, mirroring terraform_data.compat_k8s_guard in checks_compat.tf: a `check`
# block only WARNS, so the precondition is the actual gate.
#
# This fires when the minor is inside the compat window but the region offers no patch for it —
# genuinely possible, because the window in matrix.json is a statement about what Alethia supports
# and this is a statement about what one region ships today. Those can disagree, and when they do
# the honest outcome is a named failure at plan time rather than a 400 from inside the create call
# that names ROS and not the version.
resource "terraform_data" "ack_version_resolvable" {
  count = var.provision_ack ? 1 : 0
  lifecycle {
    precondition {
      condition = length(local.ack_version_candidates) > 0
      error_message = format(
        "ACK Kubernetes minor '%s' has no patch release in this region. ACK offers: %s. The compat window (packages/core/compat/matrix.json k8s_cloud.alibaba) says what Alethia supports; this says what the region ships — they disagree. Align ack_cluster_version with an offered minor, or the matrix if Alibaba has retired it.",
        var.ack_cluster_version,
        join(", ", var.provision_ack ? [for m in one(data.alicloud_cs_kubernetes_version.available[*].metadata) : m.version] : []),
      )
    }
  }
}
