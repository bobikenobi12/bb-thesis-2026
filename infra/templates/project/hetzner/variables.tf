# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

variable "project_name" {
  description = "Project name; combined with environment to form the cluster name."
  type        = string
}

variable "environment" {
  description = "Environment name (e.g. dev, staging, prod)."
  type        = string
}

# Per-cloud classification labels emitted by the console (packages/core/cloud/tags.go, B1.2): the
# project's frozen classification dimensions plus the mandatory `alethia_project-id` /
# `alethia_environment-id` sweep handles (K8s/Talos label charset — `_`-namespaced, alnum bounds).
# Merged into local.default_labels (applied to every hcloud resource) and the CSI driver's
# volumeExtraLabels; the platform base labels always WIN a key collision (they sit on the merge RHS).
variable "classification_tags" {
  description = "Classification + sweep-handle labels to stamp on every hcloud resource + dynamically-provisioned volume. Platform base labels override on conflict."
  type        = map(string)
  default     = {}
}

variable "region" {
  description = "Hetzner Cloud location (e.g. fsn1, nbg1, hel1, ash, hil)."
  type        = string
  default     = "fsn1"
}

variable "talos_version" {
  # SSOT for the Talos↔Kubernetes window: packages/core/compat/matrix.json → components[talos].
  # The compat couplings drift test asserts this default is a recorded matrix release and that
  # kubernetes_version's minor stays inside its window (#1214).
  description = "Talos Linux version (e.g. v1.13.6)."
  type        = string
  default     = "v1.13.6"
}

# ── The Talos snapshot cache (#3027). Three modes, because an operator needs three different
#    things from it and a bare on/off cannot give them all.
#
# The snapshot `imager_image` builds is a pure function of (talos_version × architecture × location ×
# extension set). Rebuilding it per cluster cost 5–15 minutes on the critical path of every apply and
# was the dominant flake of the Hetzner floor — it blew its tofu deadline twice (#2458, run
# 33080748841) on the one resource that runs before any cluster exists, so losing it lost the run.
#
#   "enabled"  (default) look the cache up; a hit skips the build entirely; a miss builds and stamps
#              a persistent cache entry so the next apply hits. The entry carries NO `cluster` label,
#              which is what makes it invisible to the per-run teardown sweep — see image.tf.
#   "refresh"  skip the lookup; always build; stamp a NEWER entry, which wins the `most_recent`
#              lookup from then on. THE INVALIDATION LEVER: it supersedes a poisoned or suspect
#              cached snapshot without deleting anything, so a rollback is one more `refresh` away.
#   "disabled" skip the lookup; always build; stamp NO cache entry. Exactly the pre-#3027 behaviour:
#              a per-cluster image labelled `cluster=<name>`, reclaimed by the run's own teardown.
#              This is also the escape hatch from the lookup's trustworthiness gate — see image.tf.
#
# Cache entries are RETAINED INDEFINITELY and nothing deletes them on a timer. Reclaiming is a
# deliberate, human-invoked operation: `scripts/e2e/hcloud-image-cache.sh`. The reasoning (cost,
# rollback, and blast radius in an account shared with prod) is in image.tf's header.
variable "talos_image_cache" {
  description = "Talos snapshot cache mode: enabled (reuse a matching cached snapshot), refresh (rebuild and supersede the cached entry), disabled (rebuild per cluster, no cache entry — pre-#3027 behaviour)."
  type        = string
  default     = "enabled"

  validation {
    # A typo must be a REFUSAL, not a silent fallback. `var.talos_image_cache == "enabled"` decides
    # whether the lookup runs at all, so a misspelling that fell through to the default branch would
    # quietly restore the unconditional rebuild this variable exists to remove — green, slower, and
    # with nothing in the plan saying why.
    condition     = contains(["enabled", "refresh", "disabled"], var.talos_image_cache)
    error_message = "talos_image_cache must be exactly one of \"enabled\", \"refresh\" or \"disabled\"."
  }
}

variable "kubernetes_version" {
  # MUST be a concrete PATCH (e.g. 1.35.6), not a bare minor: Talos installs this verbatim as
  # the control-plane component image tag (registry.k8s.io/kube-apiserver:v<this>), and upstream
  # only publishes patch tags — a bare "1.35" yields an unpullable image (ImagePullBackOff).
  # Coupled to talos_version: Talos v1.13.6 supports k8s 1.31–1.36; we pin 1.35 (the newest minor
  # Cilium v1.19 officially tests). Leave empty ("") only to let Talos pick its own default (1.36).
  # SSOT for every component↔k8s window this minor must satisfy (talos / cilium / hcloud-csi):
  # packages/core/compat/matrix.json → components[*]; the compat drift test evaluates this pinned
  # version against the whole Hetzner component set and fails on any incompatibility (#1214).
  description = "Kubernetes version (concrete patch, e.g. 1.35.6); coupled to talos_version. Empty → Talos default."
  type        = string
  default     = "1.35.6"
}

variable "control_plane_count" {
  description = "Number of control-plane nodes."
  type        = number
  default     = 1
}

variable "control_plane_server_type" {
  description = "Hetzner server type for control-plane nodes (cax* = arm64, cx*/cpx*/ccx* = amd64). Default cpx22 (2 vCPU / 4 GB, amd64) is a currently-orderable shared type; cax11 (ARM) is capacity-unreliable and cpx11 is retired."
  type        = string
  default     = "cpx22"
}

variable "control_plane_arch" {
  description = "CPU architecture of the control-plane server type: arm64 (cax*) or amd64 (cx*/cpx*/ccx*)."
  type        = string
  default     = "amd64"

  validation {
    condition     = contains(["arm64", "amd64"], var.control_plane_arch)
    error_message = "control_plane_arch must be either \"arm64\" or \"amd64\"."
  }
}

variable "worker_count" {
  description = "Number of worker nodes."
  type        = number
  default     = 1
}

variable "worker_server_type" {
  description = "Hetzner server type for worker nodes (cax* = arm64, cx*/cpx*/ccx* = amd64). Default cpx22 (2 vCPU / 4 GB, amd64) is a currently-orderable shared type; cax11 (ARM) is capacity-unreliable and cpx11 is retired."
  type        = string
  default     = "cpx22"
}

variable "worker_arch" {
  description = "CPU architecture of the worker server type: arm64 (cax*) or amd64 (cx*/cpx*/ccx*)."
  type        = string
  default     = "amd64"

  validation {
    condition     = contains(["arm64", "amd64"], var.worker_arch)
    error_message = "worker_arch must be either \"arm64\" or \"amd64\"."
  }
}

# ── Private network: create one, or attach the one you already have ───────────────
#
# Greenfield (the default) creates `hcloud_network.this` from network_cidr. Brownfield
# (provision_network = false) attaches to the network named by network_id and takes its
# ip_range as the topology supernet — network_cidr is then IGNORED, because the network
# already exists and its range is not ours to choose.
#
# One thing brownfield still CREATES: the node subnet. Servers take their private IP from a
# subnet, and hcloud publishes no subnet data source, so there is nothing to look up and
# attach to — Alethia carves its own /24 (the first of the network's range) inside the
# network you named. That subnet range must be free; a collision is refused by the Hetzner
# API at apply, and no plan-time check can see it.
variable "provision_network" {
  description = "Create the private network (true, default), or attach the existing one named by network_id (false)."
  type        = bool
  default     = true
}

variable "network_id" {
  description = "Existing hcloud network to attach to when provision_network is false — its numeric id, or its name. Ignored when provision_network is true."
  type        = string
  default     = ""
}

variable "network_cidr" {
  description = "CIDR for the private Hetzner network the nodes attach to. Used only when provision_network is true; on an existing network the network's own ip_range is the supernet."
  type        = string
  default     = "10.0.0.0/16"
}

# #1987. ADDITIVE, never restrictive: these ranges are permitted IN ADDITION to the rules the
# template already writes, so the empty default is behaviour-preserving and cannot lock the
# external runner out of a cluster it still has to provision. Read by hcloud_firewall.this.
variable "network_allowed_cidr_blocks" {
  type        = list(string)
  default     = []
  description = "Extra source CIDRs permitted inbound to this network's nodes, on top of the template's own rules. Empty (the default) adds nothing."

  validation {
    # alltrue([]) is true, so the empty default passes without a special case.
    condition     = alltrue([for c in var.network_allowed_cidr_blocks : can(cidrhost(c, 0))])
    error_message = "network_allowed_cidr_blocks must all be valid CIDRs (e.g. 10.1.0.0/16)."
  }
}

# Pod + service CIDRs are SUBNETS of network_cidr (Cilium native routing over the
# Hetzner private network). Keeping pods inside the network supernet — and setting
# ipv4NativeRoutingCIDR = network_cidr in cilium.tf — is what the canonical
# hcloud-k8s reference does for a private-network cluster, and it is REQUIRED for
# cross-node reachability: a control-plane pod (the apiserver) replies to a remote
# worker pod over the host netns, and the node's `network_cidr via <gw> dev eth1`
# route only covers the reply when the pod IP is inside network_cidr. Disjoint pod
# CIDRs (e.g. 10.244.0.0/16) leave the host with no route to remote pods AND fall
# outside the private-network firewall allow rule → cross-node pod→apiserver breaks.
#
# NULL BY DEFAULT, and that is the fix for the brownfield path rather than a convenience. These used
# to default to a split of 10.0.0.0/16 — the DEFAULT network_cidr — while `provision_network = false`
# ignores network_cidr entirely and takes the attached network's own ip_range as the supernet. The
# canvas hides the CIDR field on that path too, so a user attaching a 10.20.0.0/16 got pod/service
# CIDRs from a network they were not using, and the byo_network_guard precondition below then
# blocked the apply fail-closed. Unset means "derive from the network that actually resolved", which
# is correct on BOTH paths; a caller that names them explicitly still overrides, and is still held
# to the same invariants.
variable "pod_cidr" {
  description = "Pod network CIDR (Cilium). Defaults to the upper half of the resolved network's range. Must be a SUBNET of it and not overlap service_cidr or the node subnet."
  type        = string
  default     = null
}

variable "service_cidr" {
  description = "Service network CIDR. Defaults to a /19 inside the resolved network's range. Must be a SUBNET of it and not overlap pod_cidr or the node subnet."
  type        = string
  default     = null
}

# Optional, for the in-cluster hcloud-cloud-controller-manager secret ONLY.
# The hcloud/imager providers themselves read HCLOUD_TOKEN from the env (never
# this variable). The runner may pass the same token via TF_VAR_hcloud_token so
# the CCM (which runs inside the cluster and cannot see our env) can create
# LoadBalancers / route the private network. If left empty the CCM secret is
# still created empty and can be patched out-of-band later.
variable "hcloud_token" {
  description = "Hetzner token for the in-cluster hcloud CCM secret (optional; env HCLOUD_TOKEN drives the providers)."
  type        = string
  default     = ""
  sensitive   = true
}

# ── DNS (hcloud Zones) — see dns.tf ────────────────────────────────────────
#
# Hetzner's DNS moved onto the Cloud API in 2025 (zones are project-scoped and authenticated
# by the same HCLOUD_TOKEN as everything else here; zones can no longer be created under the
# retired dns.hetzner.com console). The hcloud provider carries it natively from 1.56 —
# `hcloud_zone`, `hcloud_zone_rrset` — which is why this is a build and not the architectural
# ceiling that Hetzner TLS and WAF genuinely are (see infra/offer-exclusions.yaml).

variable "cloud_dns_enabled" {
  description = "Create and manage the hcloud DNS zone in-template (parity with Route 53 / Cloud DNS / Azure DNS). When false, an existing zone id (dns_hosted_zone) is used and nothing is created."
  type        = bool
  default     = false
}

variable "dns_main_domain" {
  description = "Apex domain of the zone (e.g. example.com). Required when cloud_dns_enabled is true."
  type        = string
  default     = ""
}

variable "dns_hosted_zone" {
  description = "Existing hcloud DNS zone id, used when cloud_dns_enabled is false. Reported on the dns_zone_id output so the rest of the platform reads one name either way."
  type        = string
  default     = ""
}

variable "dns_zone_ttl" {
  description = "Default TTL (seconds) for records in the created zone."
  type        = number
  default     = 3600
}

# ── Object Storage (S3-compatible) — see buckets.tf ────────────────────────────────

variable "buckets" {
  description = <<-EOT
    Object Storage buckets to provision via the aminueza/minio provider. Empty = none
    (the minio provider is then never exercised). `cors_origins` is IGNORED on Hetzner
    (the provider does not apply CORS to a non-MinIO backend); `encryption_enabled` is
    informational (Hetzner encrypts at rest automatically, no per-bucket toggle).
  EOT
  type = list(object({
    name               = string
    versioning         = optional(bool, false)
    encryption_enabled = optional(bool, true)
    public_access      = optional(bool, false)
    cors_origins       = optional(list(string), [])
  }))
  default = []
}

variable "hetzner_s3_endpoint" {
  description = "Hetzner Object Storage S3 endpoint HOST, no scheme (e.g. fsn1.your-objectstorage.com). Only used when var.buckets is non-empty."
  type        = string
  default     = "fsn1.your-objectstorage.com"
}

variable "hetzner_s3_region" {
  description = "Hetzner Object Storage location/region (fsn1, nbg1, hel1)."
  type        = string
  default     = "fsn1"
}

variable "hetzner_s3_access_key" {
  description = "Hetzner Object Storage S3 access key (distinct from the Cloud API token; manually generated in the Hetzner Console). Empty when no buckets are provisioned."
  type        = string
  default     = ""
  sensitive   = true
}

variable "hetzner_s3_secret_key" {
  description = "Hetzner Object Storage S3 secret key. Empty when no buckets are provisioned."
  type        = string
  default     = ""
  sensitive   = true
}

variable "admin_kubeconfig_cert_lifetime" {
  description = "TTL for the Talos admin kubeconfig client cert (.cluster.adminKubeconfig.certLifetime). Pinned LOW (default 24h) so placement-minted kubeconfigs are short-lived; the Talos default is 1 year. Go time.Duration format."
  type        = string
  default     = "24h0m0s"
  validation {
    # A parseable, non-trivial duration — reject an empty/garbage value that would silently fall back
    # to Talos's 1-year default and defeat the short-lived posture.
    condition     = can(regex("^[0-9]+(h|m|s|ms)([0-9]+(m|s|ms))*$", var.admin_kubeconfig_cert_lifetime))
    error_message = "admin_kubeconfig_cert_lifetime must be a Go duration like 24h0m0s or 1h."
  }
}

# In-cluster container-registry hosts the kubelet must be able to pull from over plain HTTP.
#
# A Hetzner `registry` node is an in-cluster Harbor exposed as a ClusterIP with TLS off (Hetzner has
# no registry product and a canvas node carries no domain, so the cluster network is the only address
# it has). containerd attempts HTTPS for any non-localhost host, so without a mirror entry the
# kubelet cannot pull from it AT ALL — and the failure surfaces as an auth error, not a TLS one.
#
# SINGLE-CLOUD BY NATURE: no other cloud has an in-cluster registry, because every other cloud
# provisions a real one whose nodes authenticate with their own identity. Recorded as such in the
# template-parity board — never by widening template_parity.baseline, which may only decrease.
variable "incluster_registry_hosts" {
  description = "In-cluster registry hosts (registry-<name>.registries.svc.cluster.local) to trust over plain HTTP via a containerd mirror. Empty on a cluster with no registry node."
  type        = list(string)
  default     = []
}
