# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

#########################################################################
##          Cluster-admin RAM grants on the ACK cluster (#2005)        ##
#########################################################################
# CUSTOMIZABILITY-PARITY.md used to call cluster admins "granted outside the template" on Alibaba
# — cloud-inherent, nothing to wire. Checking the pinned provider refuted that:
# alicloud_cs_kubernetes_permissions (aliyun/alicloud 1.286.0) is precisely a cluster-admin
# binding. role_type "cluster" + role_name "admin" is cluster-scoped admin, and is_ram_role
# targets the RAM roles the keyless model (RRSA — workload-identity.tf) already deals in.
#
# ⚠️ REPLACE, NOT MERGE — the design constraint this file exists to carry, from the provider's own
# docs: this operation "overwrites the permissions that have been granted to the specified RAM
# user". Each apply writes the principal's ENTIRE ACK permission set. Two consequences, both
# deliberate:
#
#   - ONE resource per uid (the for_each below), so everything this template grants a principal
#     composes in a single place. A second resource for the same uid would silently revoke this
#     one — which is why variables.tf rejects duplicate uids instead of letting the map
#     comprehension keep the last writer.
#   - The knob is for principals whose ACK grants this template OWNS. Listing a uid here erases,
#     silently and on every apply, any binding that principal was given by hand or by another
#     system. That is the provider's semantics, not a choice this template gets to soften — so it
#     is stated here and on the variable, not discovered in an incident.
#
# The `if var.provision_ack` filter keeps the permissions block from indexing the count-0 cluster
# module on a cluster-less plan (the runner's 1.9.0 evaluates every disjunct — see
# infra-templates.yml). Admins on a cluster-less project are NOT silently dropped though:
# checks_cluster_admins.tf blocks that plan fail-closed.

resource "alicloud_cs_kubernetes_permissions" "cluster_admin" {
  for_each = { for admin in var.ack_cluster_admins : admin.uid => admin if var.provision_ack }

  uid = each.value.uid

  permissions {
    cluster     = try(module.cluster[0].cluster_id, null) != null ? module.cluster[0].cluster_id : ""
    role_type   = "cluster"
    role_name   = "admin"
    is_ram_role = each.value.is_ram_role
  }
}
