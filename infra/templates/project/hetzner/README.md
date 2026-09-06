<!--
SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
SPDX-License-Identifier: AGPL-3.0-only
-->

# Talos Kubernetes on Hetzner Cloud

Minimal, self-managed [Talos Linux](https://www.talos.dev/) Kubernetes cluster on
Hetzner Cloud: a single control plane + N workers, on a cheap, currently-orderable
amd64 shared-vCPU path by default (`cpx22`; override to `cax*` for ARM when capacity
permits). Modeled on
[hcloud-talos/terraform-hcloud-talos](https://github.com/hcloud-talos/terraform-hcloud-talos).

The runner copies this template verbatim, feeds it a `.tfvars.json`, then runs
`tofu init` (partial S3 backend) → `plan` → `apply`.

## How it works

1. **Image (cached; built in-apply only on a miss):** the snapshot is a pure
   function of `talos_version` × architecture × `region` × the requested
   extension set, so it is looked up before it is built. On a **hit**
   (`data "hcloud_images"`, selector `alethia.io/cache==talos-image` plus the
   four key dimensions) nothing is built at all. On a **miss** a Talos
   [Image Factory](https://factory.talos.dev/) schematic is built with the
   `siderolabs/qemu-guest-agent` extension; the `hcloud` disk image (`raw.xz`)
   URL is derived per architecture and uploaded + snapshotted into Hetzner via
   the `hcloud-talos/imager` provider (`imager_image`), and the result is stamped
   with the cache labels so the next apply is a hit. Only the architecture(s)
   actually referenced by `control_plane_arch` / `worker_arch` are considered.
   See [The Talos snapshot cache](#the-talos-snapshot-cache).
2. **Network:** one `hcloud_network` + `/24` node subnet carved from
   `network_cidr`, plus a firewall allowing Talos apid (50000/50001), the
   Kubernetes API (6443), and all intra-cluster traffic. With
   `provision_network = false` the network is not created — the one named by
   `network_id` is looked up instead and its `ip_range` becomes the supernet
   everything downstream derives from (see *Bringing your own network*).
3. **Bootstrap:** `talos_machine_secrets` → `talos_machine_configuration`
   (controlplane + worker, patched to disable the default CNI + kube-proxy and
   set the pod/service CIDRs + install disk) → `talos_machine_configuration_apply`
   per node → `talos_machine_bootstrap` → `talos_cluster_kubeconfig`.
4. **CNI + cloud integration:** [Cilium](https://cilium.io/) in
   kube-proxy-replacement / native-routing mode, the
   [hcloud cloud-controller-manager](https://github.com/hetznercloud/hcloud-cloud-controller-manager),
   and the [hcloud CSI driver](https://github.com/hetznercloud/csi-driver) — all
   rendered offline from their Helm charts (`helm_template` data sources) and
   exported via the `bootstrap_manifests` output — the runner applies them with
   `kubectl` **after** apply (Talos ships CNI=none, so nodes stay NotReady until
   then). They are deliberately NOT embedded as Talos `cluster.inlineManifests`:
   the machine config rides in Hetzner cloud-init `user_data` (32 KiB cap) and
   Cilium's rendered manifest alone busts it; post-apply also matches how the
   managed clouds do their post-cluster work. There is deliberately **no in-tofu
   `kubectl` provider** wired from the cluster's own (known-after-apply) kubeconfig
   — that made `tofu plan -out` (the runner's path) unresolvable, so the runner
   could never deploy this template.

## The Talos snapshot cache

Building the Talos snapshot takes about **five minutes** on a good day. It runs
before anything else exists, so losing it loses the whole apply — and it has blown
its OpenTofu `create` deadline twice (`failed to create snapshot: context deadline
exceeded: remaining running actions: […]`, which is Hetzner still working when the
provider gave up). Nothing about the snapshot varies per cluster, so it is cached
per Hetzner project (#3027).

### The cache key

Four dimensions, each stamped as a label on the snapshot:

| Label | Value |
| --- | --- |
| `alethia.io/cache` | `talos-image` — the marker every tool keys on |
| `alethia.io/talos-version` | `talos_version` |
| `alethia.io/talos-arch` | `x86` / `arm` |
| `alethia.io/talos-location` | `region` |
| `alethia.io/talos-schematic` | 32 hex chars of `sha256(requested extension list)` |

The last one is the dimension it is dangerous to omit: the snapshot's content is
(version × extensions), so adding or renaming an extension produces different bytes
at the same Talos version. Changing the extension list therefore supersedes every
cached entry automatically.

### Why it survives a teardown

A cache entry carries **no `cluster` label**. `scripts/e2e/hcloud-cleanup.sh`
deletes exactly what is labelled `cluster=<this run>` in an account shared with
production, so a cache entry is outside its selector *by construction* — nothing
in the sweeper was weakened to allow it, and the per-cluster image built under
`talos_image_cache = "disabled"` is still reclaimed exactly as before. The sweeper
reports the cache entries it is skipping on every run.

### A miss is a miss, not a blip

The lookup uses `data "hcloud_images"` (plural), not `hcloud_image` (singular).
The singular one raises `Resource not found` on a zero-match selector, so it
cannot express a miss at all. The plural one returns an empty list **only** when
the API answered successfully with nothing; every failure — a rotated token, a
throttle, a 5xx — is a Terraform error instead. On top of that, an unfiltered
image listing runs as a positive control: if the cache selector matched nothing
*and* the unfiltered listing also matched nothing, the plan fails rather than
rebuilding on a lookup that could not see. Set `talos_image_cache = "disabled"`
to proceed anyway.

A **hit** is validated too: every label the key asks for, plus the architecture,
is re-asserted against the image Hetzner actually returned, so a selector that
silently stopped filtering fails the plan instead of booting a cluster from the
wrong snapshot.

### Retention and invalidation

Cached snapshots are **retained indefinitely**. Nothing deletes them on a timer —
an image costs roughly EUR 0.02/month against 5–15 minutes of critical-path wall
clock per apply, rolling `talos_version` back is an ordinary debugging move, and
an automatic time-based delete in an account shared with prod is not a risk worth
taking for two cents.

To invalidate **without deleting anything**, set `talos_image_cache = "refresh"`:
it rebuilds and stamps a newer entry, which wins the lookup from that apply
onward. To reclaim:

```bash
scripts/e2e/hcloud-image-cache.sh                                   # list (read-only)
scripts/e2e/hcloud-image-cache.sh --prune-superseded --yes-delete   # duplicates only
scripts/e2e/hcloud-image-cache.sh --prune-version v1.12.4 --yes-delete
```

`--prune-superseded` never removes the newest entry of a key, so it cannot delete
an image the current configuration would hit; every delete re-describes the image
first and refuses it if it has acquired a `cluster` label. Neither prune mode
deletes anything without `--yes-delete`.

`scripts/check-hetzner-image-cache.mjs` (CI) fails if the label, the `count` gate,
the key dimensions or the sweeper's skip-list ever stop agreeing.

## Verification

`tofu validate` checks the configuration; a **real `tofu apply` is the true
verification step** and **requires `HCLOUD_TOKEN`** in the environment (the
`hcloud` and `imager` providers read it from there — there is no token
variable). Agents must never run `tofu plan` / `tofu apply`.

## Inputs

| Variable | Default | Description |
| --- | --- | --- |
| `project_name` | _(required)_ | Combined with `environment` into the cluster name. |
| `environment` | _(required)_ | Environment name (dev/staging/prod). |
| `region` | `fsn1` | Hetzner location. |
| `talos_version` | `v1.13.6` | Talos Linux version. |
| `talos_image_cache` | `enabled` | Talos snapshot cache: `enabled` (reuse a matching cached snapshot), `refresh` (rebuild and supersede it), `disabled` (rebuild per cluster, no cache entry). See [The Talos snapshot cache](#the-talos-snapshot-cache). |
| `kubernetes_version` | `1.35.6` | Kubernetes version — concrete **patch** (Talos uses it as the component image tag); coupled to `talos_version`. Empty → Talos default (1.36). |
| `control_plane_count` | `1` | Number of control-plane nodes. |
| `control_plane_server_type` | `cpx22` | CP server type (2 vCPU / 4 GB, amd64; orderable). `cax11` ARM is capacity-unreliable, `cpx11` retired. |
| `control_plane_arch` | `amd64` | CP arch (`arm64` for cax*, `amd64` for cx*/cpx*/ccx*). |
| `worker_count` | `1` | Number of worker nodes. |
| `worker_server_type` | `cpx22` | Worker server type (2 vCPU / 4 GB, amd64; orderable). |
| `worker_arch` | `amd64` | Worker arch. |
| `provision_network` | `true` | Create the private network, or attach the existing one named by `network_id`. |
| `network_id` | `""` | Existing hcloud network (numeric id **or** name) to attach to when `provision_network = false`. |
| `network_cidr` | `10.0.0.0/16` | Private network CIDR. Used only when `provision_network = true`; on an existing network its own `ip_range` is the supernet. |
| `pod_cidr` | `10.0.128.0/17` | Cilium pod CIDR. Must be a **subnet** of `network_cidr` (native routing) and not overlap the service/node subnets. |
| `service_cidr` | `10.0.96.0/19` | Service CIDR. Must be a **subnet** of `network_cidr` and not overlap the pod/node subnets. |
| `hcloud_token` | `""` | Optional; **only** for the in-cluster hcloud CCM secret. The providers use `HCLOUD_TOKEN` from the env. May be supplied via `TF_VAR_hcloud_token`. |
| `dns_provider` | `native` | Pluggable-connector guard. `native` creates the hcloud zone; any other slug means a connector (Cloudflare, …) owns DNS and nothing native is created. |
| `cloud_dns_enabled` | `false` | Create and manage the hcloud DNS zone here. |
| `dns_main_domain` | `""` | Apex domain of the zone. **Required** when `cloud_dns_enabled` is true. |
| `dns_hosted_zone` | `""` | Existing hcloud zone id, used when `cloud_dns_enabled` is false. |
| `dns_zone_ttl` | `3600` | Default TTL (seconds) for records in the created zone. |
| `buckets` | `[]` | Object Storage buckets (see below). Empty → the minio provider is never exercised. |
| `hetzner_s3_endpoint` | `fsn1.your-objectstorage.com` | S3 endpoint **host** (no scheme). Only used when `buckets` is non-empty. |
| `hetzner_s3_region` | `fsn1` | Object Storage location (`fsn1`/`nbg1`/`hel1`). |
| `hetzner_s3_access_key` (sensitive) | `""` | S3 access key (see Object Storage note). |
| `hetzner_s3_secret_key` (sensitive) | `""` | S3 secret key. |

## Object Storage (S3-compatible buckets) — `buckets.tf`

Hetzner Object Storage is a **separate product** from the Hetzner Cloud API: it speaks the
S3 API at `https://<location>.your-objectstorage.com` and authenticates with an S3
access-key/secret-key pair — **not** the Cloud API token. There is **no API to mint** those
keys; the customer generates them by hand in the Hetzner Console (Object Storage → your
bucket location → S3 credentials). Alethia stores them encrypted and exports them to the
runner as `HETZNER_S3_ACCESS_KEY` / `HETZNER_S3_SECRET_KEY` (→ `TF_VAR_hetzner_s3_*`).

Buckets are provisioned with the Hetzner-docs-endorsed [`aminueza/minio`](https://registry.terraform.io/providers/aminueza/minio)
provider (`~> 3.3`) in `s3_compat_mode`. Each `buckets` entry:

| Field | Effect on Hetzner |
| --- | --- |
| `name` | Bucket name (namespaced `project-environment-<name>`). |
| `versioning` | Enabled via `minio_s3_bucket_versioning` when `true`. |
| `public_access` | `true` → `public-read` ACL, else `private`. |
| `encryption_enabled` | **Informational** — Hetzner encrypts at rest automatically; no per-bucket toggle. |
| `cors_origins` | **Ignored** — the provider does not apply CORS to a non-MinIO backend (`s3_compat_mode` skips it). |

Object Storage exists only in `fsn1`/`nbg1`/`hel1`; a cluster in a compute-only region
(ash/hil/sin) falls back to `fsn1` for buckets.

## Outputs

| Output | Description |
| --- | --- |
| `talos_cluster_name` | `project_name-environment` (non-empty; gates kubeconfig setup). |
| `talos_cluster_endpoint` | `https://<control-plane-ip>:6443`. |
| `kubeconfig` (sensitive) | Raw kubeconfig. |
| `talosconfig` (sensitive) | Talos client configuration. |
| `bucket_names` | Provisioned Object Storage bucket names (empty when none). |
| `bucket_endpoints` | Per-bucket S3 URLs (`https://<endpoint>/<bucket>`). |
| `network_id` | The network the cluster is attached to — created here, or the existing one. |
| `dns_zone_id` | The hcloud DNS zone id (created here, else `dns_hosted_zone`). |
| `dns_name_servers` | Authoritative name servers to delegate at the registrar; empty when using an existing zone. |

## DNS — `dns.tf`

Hetzner's DNS moved onto the **Cloud API** in 2025: zones are project-scoped, authenticated
by the same `HCLOUD_TOKEN` this template already uses, and zones can no longer be created
under the retired `dns.hetzner.com` console. The `hcloud` provider carries it natively from
**1.56** (`hcloud_zone`, `hcloud_zone_rrset`), which is why `required_providers` pins
`>= 1.56` — a lower resolution would fail on an unknown resource type.

`cloud_dns_enabled` creates and owns the zone (`mode = "primary"`); the console sets it when
the DNS component is on **and** no existing zone id was supplied, exactly as the AWS template
decides `cloud_dns_enabled` for Route 53. With an existing zone, nothing is created and
`dns_hosted_zone` is reported on `dns_zone_id` so the rest of the platform reads one name
either way. `dns_provider != "native"` suppresses the zone entirely — a pluggable DNS
connector owns the records then.

**This is not the same question as TLS or WAF on Hetzner.** Those two remain documented
exclusions (`infra/offer-exclusions.yaml`): a managed certificate is issued in-cluster by
cert-manager and never travels through OpenTofu, and Hetzner sells no web application
firewall at all. DNS was simply missing (#1816).

## Bringing your own network — `network.tf`

`provision_network = false` attaches the cluster to a network you already have, named by
`network_id` (numeric id or name). Everything topological is then derived from **that
network's `ip_range`**, not from `network_cidr`: the node subnet, every server's private IP,
the firewall's intra-cluster rules and Cilium's `ipv4NativeRoutingCIDR`.

Two consequences worth reading before using it:

- **The node subnet is still created**, in your network. Servers draw their private IP from a
  subnet and hcloud publishes no `hcloud_network_subnet` **data** source, so there is nothing
  to look up and attach to. Alethia adds its own `/24` (the first of the network's range).
  That range must be free — a collision is refused by the Hetzner API at apply, and no
  plan-time check can see it.
- **`pod_cidr` and `service_cidr` must be subnets of the existing network's range.** Cilium
  runs in native-routing mode over it, so pods outside that range break cross-node
  pod→apiserver traffic — a cluster that comes up Ready and then fails the datapath. A
  fail-closed precondition (`terraform_data.byo_network_guard`) blocks the plan rather than
  letting that ship, alongside the `check` block that reports it.

**Known gap — the console cannot reach this yet (#1896).** The template and
`hetznerProvider.ProviderTfvars` are complete, but the canvas's "Existing network" control is a
picker over the synced `cloud_networks` inventory, and Hetzner's inventory sync
(`apps/console/lib/cloud-providers/inventory/tokencloud.ts`) lists **regions only** — it never
calls `/v1/networks`. So the picker is empty on Hetzner, and `networkSchema` refuses to save
`provision_network = false` with no id. Today the brownfield path is reachable only by a caller
that sets `network_id` itself. #1896 adds the inventory; nothing in this template changes when it
lands.

## Notes / limits

- Single control plane uses the CP's **public IP** as the API endpoint. For HA
  (`control_plane_count > 1`) add a floating-IP VIP — documented upgrade, not
  wired here to keep the minimal path cheap.
- `install.disk` is pinned to `/dev/sda` (correct for Hetzner Cloud VMs).

## No cluster-less shape — an explicit exclusion (#1772)

Every other project template has a `provision_<cluster>` flag — `provision_eks`,
`provision_gke`, `provision_aks`, `provision_ack` — that turns the Kubernetes cluster off
while the rest of the template still provisions. **Hetzner deliberately has no such flag.
This is a documented exclusion, not an oversight and not a gap left for later.**

The reason is structural. On the managed clouds the cluster is *one component among many*:
those templates also provision a managed database, a cache, queues, object storage, a
registry, DNS and secrets, so "everything except the cluster" is a coherent and genuinely
useful shape — a database for an app that runs elsewhere, or a registry-only project.
**Here the template *is* the cluster.** Talos on `hcloud_server`, its network, its
firewall, its CNI and its bootstrap are the entire content; the only non-cluster resources
are the optional Object Storage buckets in `buckets.tf`, which are a separate Hetzner
product reached with separate credentials. A `provision_cluster = false` flag would gate
the whole template and leave a tree that provisions nothing but a bucket — so it would not
be a *shape*, it would be an off switch.

Two things worth knowing before assuming a cluster-less Hetzner shape exists anyway:

- **`control_plane_count = 0` is NOT that shape.** `network.tf` does
  `local.control_plane_public_ip = local.control_plane_public_ips[0]`, which is the same
  empty-index crash #1772 fixed on AWS. It is left unguarded because zero control planes
  is not a supported configuration — guarding it would advertise a shape that cannot work.
- **Until #1816 this template had no `*.tftest.hcl` at all**, so
  `.github/workflows/infra-templates.yml` emitted
  `::notice::no *.tftest.hcl for hetzner — skipping` and none of its guards had ever been
  executed by CI. `checks_dns_and_network.tftest.hcl` is the first, so that step now runs —
  but it covers only the DNS and network guards. The rest of this template's `check` blocks
  and preconditions are still unexecuted, which is a real coverage gap, and a different one
  from the cluster-less shape this section is about.
