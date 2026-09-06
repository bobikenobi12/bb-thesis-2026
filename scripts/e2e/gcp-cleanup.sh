#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# gcp-cleanup.sh — belt-and-suspenders teardown for the T2 real-cloud nightly (GCP/GKE).
#
# Cloned guard-for-guard from scripts/e2e/aws-cleanup.sh (BYOC A1.3), which itself cloned
# scripts/e2e/hcloud-cleanup.sh. The T2 harness tears the cluster down GRACEFULLY in-process via
# `tofu destroy` (provisioner.RunDestroy) on the normal path. But if the test PROCESS is hard-killed
# (a `go test -timeout` panic, a CI step SIGKILL, a runner crash), t.Cleanup never runs and REAL,
# billable GCP resources leak — most dangerously the OUT-OF-BAND ones tofu never tracked: the GKE
# node MIGs/instances/boot disks, the CSI-provisioned `pvc-*` persistent disks, and the LoadBalancer
# forwarding-rules/backend-services/target-pools the cloud controller created. This script is the
# guarantee: the nightly runs it in an `always()` step so the run's resources are gone no matter how
# the test ended.
#
# ─────────────────────────────  S A F E T Y  ─────────────────────────────
# The GCP project is (or may be) shared. An unfiltered delete would be catastrophic (cf. the
# shared-hcloud near-wipe; scope-destructive-cloud-ops memory). So this script NEVER deletes
# project-wide:
#
#   * DISCOVERY is label-driven. GCP labels are lowercase, `_`-namespaced (packages/core/cloud/tags.go
#     `gcpTagStyle`), so the unique per-run handle is the label key `alethia_project-id` with value
#     `e2e-<ENV>`. Every tofu-managed, taggable resource inherits it via var.classification_tags
#     merged into local.gcp_default_labels (B1.3). ENV = <run_id>-<attempt>, unique per run. GKE
#     clusters filter on `resourceLabels.<key>`; every other resource on `labels.<key>`.
#   * OUT-OF-BAND resources that do NOT inherit the tofu label (GKE node VMs carry GKE's own
#     `goog-k8s-cluster-name=<gke>` label; CSI `pvc-*` disks the same; k8s LoadBalancer front-ends
#     live in the run's VPC) are swept by a SECONDARY filter bound to THIS run's GKE cluster / VPC
#     name — discovered from the tofu-labelled cluster, and (if the cluster is already gone, the
#     likeliest hard-kill point) reconstructed from any leftover GKE-named instance/MIG whose name
#     embeds the unique `-<ENV>-`. The VPC name is `vpc-<short>-<ENV>-<project>` and the GKE name is
#     `gke-<short>-<ENV>-<project>` (infra/templates/project/gcp/locals.tf), so every secondary
#     binding still embeds this run's unique ENV — never project-wide.
#   * Refuses to run without a specific, plausibly-unique ENV + an explicit region; rejects
#     shared/prod values; asserts a non-empty scope before every mutating call; and — the last line
#     of defence — a leak NEVER exits green: verify_swept re-lists BOTH scopes (label/name-FILTERED)
#     and confirms each billable survivor before failing the step.
#
# Usage:
#   ALETHIA_E2E_ENV=<run_id>-<attempt> ALETHIA_E2E_REGION=europe-west3-a ./scripts/e2e/gcp-cleanup.sh
#   (positional $1 accepted for call-site symmetry with hcloud-cleanup.sh but IGNORED.)
#   ALETHIA_E2E_PROJECT=<project_name>  # the project_name used in resource NAMES (optional; helps the
#                                       # mid-destroy cluster reconstruction). Distinct from the GCP
#                                       # project ID.
#   ALETHIA_E2E_GCP_PROJECT_ID / CLOUDSDK_CORE_PROJECT / GOOGLE_CLOUD_PROJECT  # the GCP project the
#                                       # sweep runs in. Optional — falls back to the active gcloud
#                                       # config (the WIF auth step sets it in CI).
#   DRY_RUN=1 ...     # list what WOULD be deleted, delete nothing, verify nothing
#   PREFLIGHT=1 ...   # BEFORE provisioning: sweep PRIOR-run e2e orphans (any other e2e-<env>),
#                     #   NOT this run. Best-effort + loud (warns on residual, never exit 1).
#
# ── PREFLIGHT (stale-cluster preflight) ─────────────────────────────────────────────────────
# A prior nightly hard-killed before BOTH its graceful destroy AND its always() sweep leaks billable
# resources that keep costing until the NEXT run notices. PREFLIGHT=1 runs before provisioning and
# sweeps those orphans. It discovers every OTHER e2e run's handle by enumerating all values of the
# `alethia_project-id` label across the labelled resource types, keeps only `e2e-`-prefixed values,
# EXCLUDES this run, re-validates each against the same specificity + prod/shared denylist guards,
# and runs the identical scope-locked sweep+verify per orphan. It is safe to sweep another e2e-*
# handle because same-cloud nightly runs are SERIALIZED (the e2e-nightly concurrency group) — so any
# other e2e-* value is a prior-run orphan, never a concurrent sibling. Posture is best-effort: a
# residual orphan emits `::warning::` but does NOT fail (a flaky API call must not red an otherwise-
# healthy provisioning night; the per-run always() teardown stays the fail-closed guarantee for THIS
# run, and the next preflight retries).
#
# Requires: the `gcloud` CLI, authenticated (WIF in CI).
set -euo pipefail

# ── The probe contract (CLEAN / LEAKED / UNVERIFIABLE / UNATTRIBUTABLE), shared by all five cloud
#    sweepers. Read scripts/e2e/lib/sweep-probe.sh before touching any list below: `gc … 2>/dev/null
#    | grep -v '^[[:space:]]*$' || true` launders the CLI's exit status three times over, so an
#    expired credential answered every list with "nothing" and exit 0 — which verify_swept reads as
#    a clean project.
#
#    A FOURTH state was added after #3138 gated the third one over a case that was not a probe
#    failure: UNATTRIBUTABLE — the probe DID get an answer, and the answer is that something
#    exists which by design cannot be tied to this run. Reported loudly, never gates. Only
#    hetzner produces one today (#2463); the taxonomy is shared so the next cloud does not have
#    to re-derive it, and every sweeper's --self-test asserts both halves. ──
E2E_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib"
# shellcheck source-path=SCRIPTDIR source=lib/sweep-probe.sh
. "${E2E_LIB_DIR}/sweep-probe.sh"
probe_reset

# ── `--self-test` exercises the three-state probe contract against a stubbed `gcloud` and exits.
# It sets its own ENV/REGION so the guards below are left exactly as they protect the real path,
# and shadows `gc` with a shell function so nothing authenticates and no CLI is needed. ──
SELF_TEST=0
if [ "${1:-}" = "--self-test" ]; then
	SELF_TEST=1
	ALETHIA_E2E_ENV="selftest-4177-1"
	ALETHIA_E2E_REGION="europe-west3-a"
	# The probe retries are a real-cloud kindness (a transient 5xx must not red a healthy teardown)
	# and pure dead time against a stub. The retry LOOP is still exercised; it just does not wait.
	PROBE_RETRY_DELAY=0
fi

ENV="${ALETHIA_E2E_ENV:-}"
# Region is AUTHORITATIVE from ALETHIA_E2E_REGION only. A silent fallback to an ambient region that
# differs from where the run provisioned would make the regional scoping wrong. The nightly hands
# this script the cluster's ZONE (europe-west3-a), while regional managed-service commands require
# the parent REGION (europe-west3), so normalize the final `-<letter>` exactly once here.
REGION="${ALETHIA_E2E_REGION:-}"
case "$REGION" in
*-[a-z]) REGION="${REGION%-?}" ;;
esac
# The project_name segment used in resource NAMES (gke-<short>-<ENV>-<project>). Optional — only used
# to tighten the mid-destroy cluster/VPC reconstruction. NOT the GCP project ID.
PROJECT_NAME="${ALETHIA_E2E_PROJECT:-}"
# The GCP project the sweep operates in. Optional — defaults to the active gcloud config.
GCP_PROJECT="${ALETHIA_E2E_GCP_PROJECT_ID:-${CLOUDSDK_CORE_PROJECT:-${GOOGLE_CLOUD_PROJECT:-}}}"
DRY_RUN="${DRY_RUN:-0}"
PREFLIGHT="${PREFLIGHT:-0}"
DELETE_RETRIES="${DELETE_RETRIES:-5}"
# ── PREFLIGHT budget (#2257, ported from aws-cleanup.sh by #2330). The preflight's "never blocks
# the caller" promise is carried by `exit 0` at the end of its loop — which is only reached if the
# loop ENDS. Unbounded, it cannot promise that: each sweep_env legitimately burns minutes, and on
# run 31459117502 the AWS equivalent consumed 86 of a 90-minute job cap, so the job hit its cap,
# GitHub marked it CANCELLED, and the always() teardown died mid-step leaving ~$105/mo standing.
# A best-effort step that can consume its caller is not best-effort.
#
# This matters twice over now: e2e-orphan-reaper.yml passes PREFLIGHT_BUDGET_SECONDS and
# PREFLIGHT_MAX_ENVS to all four clouds, and until this port only aws READ them — the other three
# silently ignored the bounds and were held up by the reaper's timeout-minutes alone, which is the
# same cancel-mid-sweep failure this whole issue is about. Two bounds, both reported:
PREFLIGHT_BUDGET_SECONDS="${PREFLIGHT_BUDGET_SECONDS:-900}" # wall-clock for the whole sweep loop
PREFLIGHT_MAX_ENVS="${PREFLIGHT_MAX_ENVS:-3}"               # orphans attempted per run

# ── Guard 1: a specific ENV is REQUIRED. No ENV ⇒ no filter ⇒ hard refuse. ──
if [ -z "$ENV" ]; then
	echo "✗ REFUSING TO RUN: ALETHIA_E2E_ENV is unset." >&2
	echo "  This script only ever deletes resources labelled alethia_project-id=e2e-<ENV> (or named" >&2
	echo "  with the unique -<ENV>-) — never project-wide. Set ALETHIA_E2E_ENV to the unique per-run" >&2
	echo "  value (<run_id>-<attempt>)." >&2
	exit 2
fi

# ── Guard 2: ENV must be specific enough to be a single run, not a broad/shared prefix. ──
if ! printf '%s' "$ENV" | grep -Eq '^[a-z0-9][a-z0-9._-]{4,62}$'; then
	echo "✗ REFUSING TO RUN: ENV '$ENV' is not a valid, specific handle ([a-z0-9][a-z0-9._-]{4,62})." >&2
	echo "  Refusing so a typo can't widen the label filter." >&2
	exit 2
fi
case "$ENV" in
prod | prod-* | production | production-* | staging | staging-* | main | alethia | alethia-* | data)
	echo "✗ REFUSING TO RUN: ENV '$ENV' looks like shared/prod infra, not a nightly run." >&2
	exit 2
	;;
esac

# ── Guard 3: an explicit region is REQUIRED (no silent ambient fallback). ──
if [ -z "$REGION" ]; then
	echo "✗ REFUSING TO RUN: ALETHIA_E2E_REGION is unset." >&2
	echo "  The run's region must be explicit; refusing rather than guessing an ambient one." >&2
	exit 2
fi

# The self-test shadows `gc` with a shell function, so it needs no binary — and the CI runner that
# runs it has none. Requiring it here would make the hermetic test unrunnable where it is meant to run.
if [ "$SELF_TEST" != "1" ] && ! command -v gcloud >/dev/null 2>&1; then
	echo "✗ the 'gcloud' CLI is not installed." >&2
	echo "  Install it: https://cloud.google.com/sdk/docs/install." >&2
	exit 2
fi

# The value of the alethia_project-id label carried by every tofu-managed resource for THIS run.
PID_LABEL="e2e-${ENV}"
CLUSTER=""         # discovered below (gke-<short>-<ENV>-<project>); may be found via ENV-embed fallback
CLUSTER_LOCATION="" # the cluster's zone or region (zonal in T2)
NETWORK=""         # the run's VPC name (vpc-<short>-<ENV>-<project>) — secondary bind for LB/firewall

# The per-run banner is for the normal (belt-and-suspenders) path; PREFLIGHT prints its own below.
if [ "$PREFLIGHT" != "1" ] && [ "$SELF_TEST" != "1" ]; then
	echo "→ gcp belt-and-suspenders cleanup in ${REGION}, scope alethia_project-id=${PID_LABEL}"
	[ "$DRY_RUN" = "1" ] && echo "  (DRY_RUN=1 — listing only, deleting nothing)"
fi

# gc — every gcloud call goes through here so the optional --project is applied uniformly and
# set -u-safely (an unset GCP_PROJECT means "use the active config", never an empty --project).
gc() {
	if [ -n "$GCP_PROJECT" ]; then
		gcloud --project "$GCP_PROJECT" "$@"
	else
		gcloud "$@"
	fi
}

# gc_list <type> <gcloud args…> — every scoped LIST in this file goes through here.
#
# It captures gcloud's REAL exit status before anything filters it, and records the resource type
# as UNVERIFIABLE when the call did not answer. The `2>/dev/null | grep -v '' || true` shape this
# replaces reported an expired credential, a disabled API and a throttle as an empty list and exit
# 0 — indistinguishable from a project with nothing in it, which is exactly what verify_swept then
# announced.
gc_list() {
	local ptype="$1"
	shift
	probe_run "$ptype" gc "$@" | grep -v '^[[:space:]]*$' || true
}

# assert_scope fails closed if the scope ever became empty (defensive — the guards above already
# ensure it can't, but never issue a label-less mutating call).
assert_scope() {
	if [ -z "${PID_LABEL#e2e-}" ]; then
		echo "✗ INTERNAL: empty scope — aborting before an unfiltered operation." >&2
		exit 3
	fi
}

# looks_gone <stderr-text> — true if a gcloud delete error means the resource is already absent
# (idempotency: eventual consistency can list an already-deleted resource; a NotFound on delete is
# success, not failure). The task's canonical strings plus gcloud's phrasings.
looks_gone() {
	printf '%s' "$1" | grep -Eqi 'was not found|does not exist|notFound|not found|could not fetch resource|no longer exists'
}

# retry_delete <human> <cmd...> — delete with backoff. "Already gone" = success. NEVER returns
# non-zero (so `set -e` can't abort the sweep BEFORE verify_swept, the real gate); an unresolved
# failure logs a WARN and lets verify catch it authoritatively.
retry_delete() {
	local human="$1"
	shift
	if [ "$DRY_RUN" = "1" ]; then
		echo "      would delete ${human}"
		return 0
	fi
	local attempt=1 delay=3 err
	while [ "$attempt" -le "$DELETE_RETRIES" ]; do
		if err="$("$@" 2>&1)"; then
			echo "      deleted ${human}"
			return 0
		fi
		if looks_gone "$err"; then
			echo "      ${human} already gone"
			return 0
		fi
		echo "      retry ${attempt}/${DELETE_RETRIES}: ${human} not deletable yet (waiting ${delay}s)" >&2
		sleep "$delay"
		attempt=$((attempt + 1))
		delay=$((delay * 2))
	done
	echo "      WARN: could not delete ${human} after ${DELETE_RETRIES} attempts (verify_swept will gate)" >&2
	return 0
}

# ── Scope-locked discovery. Every list is label- or name-FILTERED; none ever returns an unscoped
#    project-wide list. ──

# list_gke_clusters — "name<TAB>location" for GKE clusters carrying THIS run's project-id label.
list_gke_clusters() {
	assert_scope
	gc_list gke-cluster container clusters list \
		--filter="resourceLabels.alethia_project-id=${PID_LABEL}" \
		--format="value(name,location)"
}

# ── Discover THIS run's GKE cluster (for the out-of-band secondary sweeps) + its VPC. First the
#    tofu-labelled cluster; if it is already gone (the likeliest hard-kill point — mid tofu-destroy),
#    reconstruct the name from any leftover GKE-named node instance/MIG whose name embeds the unique
#    `-<ENV>-`. Never guessed, never broadened past this run's ENV. ──
discover_cluster() {
	local line cand
	line="$(list_gke_clusters | head -n1)"
	if [ -n "$line" ]; then
		CLUSTER="$(printf '%s' "$line" | awk '{print $1}')"
		CLUSTER_LOCATION="$(printf '%s' "$line" | awk '{print $2}')"
	else
		# Fallback: scan node instance names for our unique ENV. GKE node VMs are named
		# gke-<cluster>-<nodepool>-<hash>-<rand>, and cluster == gke-<short>-<ENV>-<project>, so a
		# name matching `gke-<short>-<ENV>[-<project>]` reconstructs the cluster prefix. When the
		# project_name is known we anchor on it (tightest); otherwise take the gke-…-<ENV>- prefix.
		if [ -n "$PROJECT_NAME" ]; then
			cand="$(gc_list instance compute instances list --format="value(name)" |
				grep -oE "gke-[a-z0-9]+-${ENV}-${PROJECT_NAME}" | head -n1 || true)"
		else
			cand="$(gc_list instance compute instances list --format="value(name)" |
				grep -E -- "-${ENV}-" | grep -oE "gke-[a-z0-9]+-${ENV}-[a-z0-9-]+" |
				sed -E 's/-[a-z0-9]+-[a-z0-9]+-grp$//; s/-default-pool.*$//' | sort -u | head -n1 || true)"
		fi
		[ -n "$cand" ] && CLUSTER="$cand"
	fi
	if [ -n "$CLUSTER" ]; then
		# The VPC shares the cluster's <short>-<ENV>-<project> tail (vpc- vs gke- prefix).
		NETWORK="vpc-${CLUSTER#gke-}"
		echo "  · cluster (secondary scope): ${CLUSTER}${CLUSTER_LOCATION:+ @ ${CLUSTER_LOCATION}}  · vpc: ${NETWORK}"
	else
		# No cluster ⇒ still try to bind LB/network residue to a VPC named with our ENV.
		NETWORK="$(gc_list network compute networks list --format="value(name)" |
			grep -E "^vpc-.*-${ENV}-" | head -n1 || true)"
		echo "  · no GKE cluster found for ENV ${ENV} (already gone, or nothing out-of-band to sweep)${NETWORK:+ · vpc: ${NETWORK}}"
	fi
}

# build_node_filter — bind GKE node VMs/MIGs to THIS run: GKE's own cluster-name label when the
# cluster is known, always ORed with the unique `-<ENV>-` name embedding.
build_node_filter() {
	local f="name~-${ENV}-"
	[ -n "$CLUSTER" ] && f="labels.goog-k8s-cluster-name=${CLUSTER} OR ${f}"
	printf '%s' "$f"
}

# build_lb_filter — bind out-of-band LoadBalancer front-ends to THIS run: our VPC (name embeds ENV)
# or the unique `-<ENV>-` name embedding, or a description referencing the cluster.
build_lb_filter() {
	local f="name~-${ENV}-"
	[ -n "$NETWORK" ] && f="network~/${NETWORK}\$ OR ${f}"
	[ -n "$CLUSTER" ] && f="${f} OR description~${CLUSTER}"
	printf '%s' "$f"
}

# ── 1. LoadBalancer residue (out-of-band, cloud-controller-created): forwarding-rules →
#       backend-services → target-pools → firewall. Deleted front-to-back so a delete never orphans
#       a still-referenced backend. Bound to the run's VPC/ENV. ──
list_forwarding_rules() { # name<TAB>region ("" region ⇒ global)
	assert_scope
	gc_list forwarding-rule compute forwarding-rules list --filter="$(build_lb_filter)" \
		--format="value(name,region.basename())"
}
list_backend_services() { # name<TAB>region
	assert_scope
	gc_list backend-service compute backend-services list --filter="$(build_lb_filter)" \
		--format="value(name,region.basename())"
}
list_target_pools() { # name<TAB>region (target pools are always regional)
	assert_scope
	gc_list target-pool compute target-pools list --filter="$(build_lb_filter)" \
		--format="value(name,region.basename())"
}
list_firewalls() { # name (firewall rules are global)
	assert_scope
	gc_list firewall compute firewall-rules list --filter="$(build_lb_filter)" \
		--format="value(name)"
}

sweep_load_balancers() {
	assert_scope
	local name region
	# forwarding-rules
	if [ -z "$NETWORK" ] && [ -z "$CLUSTER" ]; then
		echo "  · load-balancer residue: no VPC/cluster scope — skipping (nothing to bind to)"
		return 0
	fi
	local any=0
	while IFS=$'\t' read -r name region; do
		[ -n "$name" ] || continue
		any=1
		if [ -n "$region" ]; then
			retry_delete "forwarding-rule ${name} (${region})" gc compute forwarding-rules delete "$name" --region="$region" --quiet
		else
			retry_delete "forwarding-rule ${name} (global)" gc compute forwarding-rules delete "$name" --global --quiet
		fi
	done <<<"$(list_forwarding_rules)"
	while IFS=$'\t' read -r name region; do
		[ -n "$name" ] || continue
		any=1
		if [ -n "$region" ]; then
			retry_delete "backend-service ${name} (${region})" gc compute backend-services delete "$name" --region="$region" --quiet
		else
			retry_delete "backend-service ${name} (global)" gc compute backend-services delete "$name" --global --quiet
		fi
	done <<<"$(list_backend_services)"
	while IFS=$'\t' read -r name region; do
		[ -n "$name" ] || continue
		any=1
		[ -n "$region" ] || region="$REGION"
		retry_delete "target-pool ${name} (${region})" gc compute target-pools delete "$name" --region="$region" --quiet
	done <<<"$(list_target_pools)"
	while IFS= read -r name; do
		[ -n "$name" ] || continue
		any=1
		retry_delete "firewall-rule ${name}" gc compute firewall-rules delete "$name" --quiet
	done <<<"$(list_firewalls)"
	[ "$any" = "0" ] && echo "  · load-balancer residue: none"
	return 0
}

# ── 2. GKE cluster (tofu-managed). Deleting the cluster reclaims its node MIGs + instances + boot
#       disks in one API call — so this runs before the orphan-instance sweep, which only catches a
#       cluster whose delete already happened but leaked nodes (mid-destroy). Synchronous so the
#       reclaim completes before we verify. ──
sweep_gke() {
	assert_scope
	if [ -z "$CLUSTER" ]; then
		echo "  · GKE cluster: none"
		return 0
	fi
	if [ -z "$CLUSTER_LOCATION" ]; then
		# Reconstructed cluster (mid-destroy): the cluster object is already gone — nothing to delete;
		# the orphan-instance + pvc-disk sweeps below reclaim what leaked.
		echo "  · GKE cluster ${CLUSTER}: object already gone (mid-destroy) — sweeping leaked nodes/disks"
		return 0
	fi
	retry_delete "gke cluster ${CLUSTER} (${CLUSTER_LOCATION})" \
		gc container clusters delete "$CLUSTER" --location="$CLUSTER_LOCATION" --quiet
}

# ── 3. Orphan node instances (out-of-band; only when the cluster delete leaked them). ──
list_orphan_instances() { # name<TAB>zone
	assert_scope
	gc_list instance compute instances list --filter="$(build_node_filter)" \
		--format="value(name,zone.basename())"
}
sweep_instances() {
	assert_scope
	local name zone any=0
	while IFS=$'\t' read -r name zone; do
		[ -n "$name" ] || continue
		any=1
		retry_delete "instance ${name} (${zone})" gc compute instances delete "$name" --zone="$zone" --quiet
	done <<<"$(list_orphan_instances)"
	[ "$any" = "0" ] && echo "  · orphan instances: none"
	return 0
}

# ── 4. CSI-provisioned pvc-* persistent disks. GKE does NOT reclaim these when the cluster is
#       deleted (they're runtime-provisioned, not tofu-tracked), so they are the classic GCP leak.
#       Bound to THIS cluster via GKE's own `goog-k8s-cluster-name` label (a bare pvc-<uuid> can't be
#       safely attributed without it). ──
list_pvc_disks() { # name<TAB>zone<TAB>region
	assert_scope
	local f
	if [ -n "$CLUSTER" ]; then
		f="labels.goog-k8s-cluster-name=${CLUSTER} AND name~^pvc-"
	else
		# No cluster to bind to ⇒ only sweep pvc-* disks that carry OUR tofu project-id label (rare;
		# most CSI disks carry only GKE's cluster label). Honest limitation — see verify_swept notice.
		f="labels.alethia_project-id=${PID_LABEL} AND name~^pvc-"
	fi
	gc_list pvc-disk compute disks list --filter="$f" \
		--format="value(name,zone.basename(),region.basename())"
}
sweep_pvc_disks() {
	assert_scope
	local name zone region any=0
	while IFS=$'\t' read -r name zone region; do
		[ -n "$name" ] || continue
		any=1
		if [ -n "$zone" ]; then
			retry_delete "pvc disk ${name} (${zone})" gc compute disks delete "$name" --zone="$zone" --quiet
		else
			retry_delete "pvc disk ${name} (${region})" gc compute disks delete "$name" --region="$region" --quiet
		fi
	done <<<"$(list_pvc_disks)"
	[ "$any" = "0" ] && echo "  · CSI pvc-* disks: none"
	return 0
}

# ── 5. Tagged network residue (tofu-managed; sweep only if a killed destroy leaked it). Reserved
#       static addresses BILL, so they're swept + verified; routers/subnets/networks are non-billable
#       residue (verify emits a notice). Bound by our project-id label where the resource supports
#       labels (addresses do), else by the unique `-<ENV>-` name embedding. ──
list_addresses() { # name<TAB>region ("" ⇒ global)
	assert_scope
	gc_list address compute addresses list --filter="labels.alethia_project-id=${PID_LABEL} OR name~-${ENV}-" \
		--format="value(name,region.basename())"
}
list_routers() { # name<TAB>region
	assert_scope
	gc_list router compute routers list --filter="name~-${ENV}-" \
		--format="value(name,region.basename())"
}
list_subnets() { # name<TAB>region
	assert_scope
	gc_list subnet compute networks subnets list --filter="name~-${ENV}-" \
		--format="value(name,region.basename())"
}
list_networks() { # name
	assert_scope
	gc_list network compute networks list --filter="name~-${ENV}-" \
		--format="value(name)"
}
sweep_network() {
	assert_scope
	local name region
	while IFS=$'\t' read -r name region; do
		[ -n "$name" ] || continue
		if [ -n "$region" ]; then
			retry_delete "address ${name} (${region})" gc compute addresses delete "$name" --region="$region" --quiet
		else
			retry_delete "address ${name} (global)" gc compute addresses delete "$name" --global --quiet
		fi
	done <<<"$(list_addresses)"
	# Routers must go before their subnets, subnets before the network.
	while IFS=$'\t' read -r name region; do
		[ -n "$name" ] || continue
		[ -n "$region" ] || region="$REGION"
		retry_delete "router ${name} (${region})" gc compute routers delete "$name" --region="$region" --quiet
	done <<<"$(list_routers)"
	while IFS=$'\t' read -r name region; do
		[ -n "$name" ] || continue
		[ -n "$region" ] || region="$REGION"
		retry_delete "subnet ${name} (${region})" gc compute networks subnets delete "$name" --region="$region" --quiet
	done <<<"$(list_subnets)"
	while IFS= read -r name; do
		[ -n "$name" ] || continue
		retry_delete "network ${name}" gc compute networks delete "$name" --quiet
	done <<<"$(list_networks)"
	return 0
}

# ── Final verification: a leak must NEVER exit green. Re-list BOTH scopes (label/name-FILTERED) and
#    FAIL loudly on any surviving BILLABLE resource (GKE clusters, node instances, PD disks,
#    forwarding-rules, reserved addresses). Non-billable residue (networks/subnets/routers/firewall/
#    backend-services/target-pools) is a NOTICE — it ages out or points at an upstream billable
#    already caught above. ──
# ── Managed services (the non-compute kinds a max-config project provisions). The original sweep
#    covered only GKE/instances/disks/LBs/network — so a killed destroy on a full project left
#    Cloud SQL and Memorystore RUNNING AND BILLING while verify_swept still reported "no billable
#    resources remain". Observed for real: a Firestore database survived a "successful" destroy
#    (provider deletion_policy defaults to ABANDON) and the sweeper never noticed.
#
# ── THE SECOND BUG, WHICH IS WHY THESE READ THE WAY THEY DO ────────────────────────────────────
#    Every list here was NAME-filtered on `e2e-<ENV>-`, and NO RESOURCE IN THIS TEMPLATE IS EVER
#    NAMED THAT WAY. `e2e-<ENV>` is the value of the alethia_project-id LABEL; the NAMES are built
#    from project_name + environment (infra/templates/project/gcp/*.tf), so they render
#    `alethia-nl-<ENV>-sql`, `alethia-nl-<ENV>-assets`, `<ENV>-alethia-nl-api-key`, and so on. Not
#    one of them starts with, or even contains, `e2e-<ENV>-`. Every filter below matched exactly
#    nothing, in the sweep AND in verify_swept, so a hard-killed run left Cloud SQL, the GCS bucket
#    and the Artifact Registry repo billing while the step printed "no billable resources remain" —
#    the failure the header above claims to have closed.
#
#    The fix is to scope on the LABEL the resources actually carry, exactly as the compute half
#    (list_gke_clusters) already does, NOT to widen the name filter. Widening it is the more
#    dangerous direction by a distance: these run against a project shared with real work
#    (a client-owned project), and a broad name match there deletes someone else's database. The label value is
#    unique per run and guard-validated at the top of this file; a name prefix is neither.
#
#    Proven present, by reading the template rather than by assumption — every root module is
#    handed `labels = local.gcp_default_labels`, into which var.classification_tags (carrying
#    alethia_project-id) is merged, and each module applies it to its resource:
#      cloud-sql.tf:34         → modules/cloud-sql/main.tf:145      settings.user_labels
#      memorystore.tf:18       → modules/memorystore/main.tf:41     labels
#      memorystore-valkey.tf   → modules/memorystore-valkey:53      labels
#      cloud-storage.tf:12     → modules/cloud-storage/main.tf:112  labels
#      artifact-registry.tf:12 → modules/artifact-registry:38       labels
#      pubsub.tf:11            → modules/pubsub/main.tf:47          labels
#      secret-manager.tf:13    → modules/secret-manager/main.tf:16  labels
#      cloud-dns.tf:28         → modules/cloud-dns/main.tf:7        labels
#    Cloud SQL is the one that is not `labels.<key>`: the API field is settings.userLabels, so its
#    filter path differs. Getting that path wrong fails the same silent way the name filter did.
#
#    FIRESTORE IS THE ONE GENUINE EXCEPTION. google_firestore_database has no labels field at all —
#    modules/firestore/main.tf accepts a `labels` variable and never applies it, because there is
#    nothing to apply it to. So Firestore keeps a NAME filter, but the narrowest safe one: the
#    database id is deterministic, `<project_name>-<environment>-firestore`, so we anchor on the
#    full `<project>-<ENV>-firestore` when ALETHIA_E2E_PROJECT is known and otherwise fall back to
#    the `-<ENV>-` embedding the compute half already relies on. Both still carry this run's unique
#    ENV; neither is a bare `e2e-` prefix. ──

# BILLABLE managed services
list_sql_instances() {
	assert_scope
	# Cloud SQL exposes labels as settings.userLabels, NOT labels.
	gc_list cloud-sql sql instances list --filter="settings.userLabels.alethia_project-id=${PID_LABEL}" \
		--format="value(name)"
}
list_redis_instances() {
	assert_scope
	gc_list memorystore redis instances list --region "${REGION}" \
		--filter="labels.alethia_project-id=${PID_LABEL}" \
		--format="value(name)"
}
list_buckets() {
	assert_scope
	gc_list bucket storage buckets list --filter="labels.alethia_project-id=${PID_LABEL}" \
		--format="value(name)"
}
list_artifact_repos() {
	assert_scope
	gc_list artifact-repo artifacts repositories list --location "${REGION}" \
		--filter="labels.alethia_project-id=${PID_LABEL}" \
		--format="value(name)"
}
# NON-BILLABLE residue (still reclaimed — a stale one blocks re-creating the same name)
list_firestore_dbs() {
	assert_scope
	# No labels on google_firestore_database (see the block above) — the deterministic database id
	# is the narrowest handle there is. With the project name known this is an exact name;
	# without it, the same `-<ENV>-` embedding every other unlabellable lookup in this file uses.
	local f="name~-${ENV}-"
	[ -n "$PROJECT_NAME" ] && f="name~^(.*/)?${PROJECT_NAME}-${ENV}-firestore\$"
	gc_list firestore firestore databases list --filter="$f" --format="value(name)"
}
list_pubsub_topics() {
	assert_scope
	gc_list pubsub-topic pubsub topics list --filter="labels.alethia_project-id=${PID_LABEL}" \
		--format="value(name)"
}
list_secrets() {
	assert_scope
	gc_list secret secrets list --filter="labels.alethia_project-id=${PID_LABEL}" \
		--format="value(name)"
}
list_dns_zones() {
	assert_scope
	gc_list dns-zone dns managed-zones list --filter="labels.alethia_project-id=${PID_LABEL}" \
		--format="value(name)"
}

sweep_managed_services() {
	assert_scope
	local n
	echo "  · Cloud SQL:"
	for n in $(list_sql_instances); do retry_delete "sql instance ${n}" gc sql instances delete "${n}" --quiet; done
	echo "  · Memorystore:"
	for n in $(list_redis_instances); do retry_delete "redis ${n}" gc redis instances delete "${n}" --region "${REGION}" --quiet; done
	echo "  · buckets:"
	for n in $(list_buckets); do retry_delete "bucket ${n}" gc storage rm -r "gs://${n}" --quiet; done
	echo "  · artifact repos:"
	for n in $(list_artifact_repos); do retry_delete "artifact repo ${n}" gc artifacts repositories delete "${n}" --location "${REGION}" --quiet; done
	echo "  · Firestore:"
	for n in $(list_firestore_dbs); do retry_delete "firestore ${n}" gc firestore databases delete --database="${n##*/}" --quiet; done
	echo "  · Pub/Sub:"
	for n in $(list_pubsub_topics); do retry_delete "topic ${n}" gc pubsub topics delete "${n##*/}" --quiet; done
	echo "  · secrets:"
	for n in $(list_secrets); do retry_delete "secret ${n}" gc secrets delete "${n##*/}" --quiet; done
	echo "  · DNS zones:"
	for n in $(list_dns_zones); do retry_delete "dns zone ${n}" gc dns managed-zones delete "${n}" --quiet; done
}

verify_swept() {
	assert_scope
	local leaks="" residue="" x
	join() { printf '%s' "$1" | tr '\n' ' '; }

	x="$(list_gke_clusters | awk '{print $1}')"; [ -n "$x" ] && leaks="${leaks}gke-cluster: $(join "$x")\n"
	x="$(list_orphan_instances | awk '{print $1}')"; [ -n "$x" ] && leaks="${leaks}instance: $(join "$x")\n"
	x="$(list_pvc_disks | awk '{print $1}')"; [ -n "$x" ] && leaks="${leaks}pvc-disk: $(join "$x")\n"
	x="$(list_forwarding_rules | awk '{print $1}')"; [ -n "$x" ] && leaks="${leaks}forwarding-rule: $(join "$x")\n"
	x="$(list_addresses | awk '{print $1}')"; [ -n "$x" ] && leaks="${leaks}address: $(join "$x")\n"
	# managed services — Cloud SQL and Memorystore in particular BILL, and were previously invisible
	x="$(list_sql_instances)"; [ -n "$x" ] && leaks="${leaks}cloud-sql: $(join "$x")\n"
	x="$(list_redis_instances)"; [ -n "$x" ] && leaks="${leaks}memorystore: $(join "$x")\n"
	x="$(list_buckets)"; [ -n "$x" ] && leaks="${leaks}bucket: $(join "$x")\n"
	x="$(list_artifact_repos)"; [ -n "$x" ] && leaks="${leaks}artifact-repo: $(join "$x")\n"

	if [ -n "$leaks" ]; then
		echo "  ✗ billable resources still alive:" >&2
		printf '%b' "  $leaks" >&2
		echo "::error::gcp cleanup INCOMPLETE — billable resources for run ${ENV} still exist and are BILLING. Investigate + remove (stay scope-locked; never project-wide)." >&2
		return 1
	fi

	x="$(list_firestore_dbs)"; [ -n "$x" ] && residue="${residue}firestore: $(join "$x")\n"
	x="$(list_pubsub_topics)"; [ -n "$x" ] && residue="${residue}pubsub-topic: $(join "$x")\n"
	x="$(list_secrets)"; [ -n "$x" ] && residue="${residue}secret: $(join "$x")\n"
	x="$(list_dns_zones)"; [ -n "$x" ] && residue="${residue}dns-zone: $(join "$x")\n"
	x="$(list_backend_services | awk '{print $1}')"; [ -n "$x" ] && residue="${residue}backend-service: $(join "$x")\n"
	x="$(list_target_pools | awk '{print $1}')"; [ -n "$x" ] && residue="${residue}target-pool: $(join "$x")\n"
	x="$(list_firewalls)"; [ -n "$x" ] && residue="${residue}firewall: $(join "$x")\n"
	x="$(list_subnets | awk '{print $1}')"; [ -n "$x" ] && residue="${residue}subnet: $(join "$x")\n"
	x="$(list_routers | awk '{print $1}')"; [ -n "$x" ] && residue="${residue}router: $(join "$x")\n"
	x="$(list_networks)"; [ -n "$x" ] && residue="${residue}network: $(join "$x")\n"
	if [ -n "$residue" ]; then
		# shellcheck disable=SC2059
		echo "::notice::gcp cleanup: non-billable network residue still present (will age out): $(printf "$residue" | tr '\n' ' ')"
	fi
	return 0
}

# ── finalize_verification — THE EXIT-CODE CONTRACT.
#
#   0  every probe answered, and nothing billable for this run survived.
#   1  a LEAK: the API listed something still standing and billing.
#   4  UNVERIFIABLE: at least one probe could not answer, so nothing here proves the project is
#      empty. This runs on the `always()` teardown path the T2 harness defers to as the guarantee,
#      so "could not look" has to red the step rather than pass as a line in a log.
#
# A confirmed leak outranks "could not check", so verify_swept runs first.
finalize_verification() {
	if ! verify_swept; then
		return 1
	fi
	probe_gate gcp "run ${ENV}" || return 4
	# probe_clean_suffix is EMPTY on a genuinely clean run and carries any UNATTRIBUTABLE finding
	# otherwise, so this sentence can never read as "the account is empty" when it is not. Shared
	# by all five sweepers — the taxonomy is one contract, not five that drift.
	echo "✓ gcp cleanup verified complete for run ${ENV} — no billable resources remain$(probe_clean_suffix)"
	return 0
}

# ── sweep_env <env> — the full scope-locked sweep + verify for ONE run's ENV. Sets the
#    ENV/PID_LABEL/CLUSTER/NETWORK globals the sweep functions read, then runs them in the same
#    strict dependency order as the normal path. Returns verify_swept's status (0 clean / 1 leak);
#    DRY_RUN lists only and returns 0. Used by PREFLIGHT to sweep each discovered prior-run orphan. ──
sweep_env() {
	ENV="$1"
	PID_LABEL="e2e-${ENV}"
	CLUSTER=""
	CLUSTER_LOCATION=""
	NETWORK=""
	assert_scope
	discover_cluster
	sweep_load_balancers
	sweep_gke
	sweep_instances
	sweep_pvc_disks
	sweep_managed_services
	sweep_network
	[ "$DRY_RUN" = "1" ] && return 0
	verify_swept
}

# ── list_orphan_envs — every OTHER e2e run's ENV that still has labelled resources in this project
#    (prior-run orphans). Enumerates all values of the `alethia_project-id` label across the labelled
#    resource types (GKE clusters primarily; disks/addresses too), keeps only `e2e-`-prefixed values,
#    strips the prefix, EXCLUDES this run (SELF_ENV), and re-validates each against the SAME
#    specificity + prod/shared denylist guards as the top-of-file ENV guards — so a preflight can
#    never widen past a genuine prior nightly. Empty output ⇒ nothing to sweep. ──
list_orphan_envs() {
	local vals v oenv
	vals="$(
		{
			# Through gc_list, so a listing that FAILS is recorded rather than folded into "no
			# orphans". The preflight does not gate on it (it never blocks its caller), but it warns
			# — "nothing to sweep" and "could not look" are not the same report.
			gc_list orphan-scan container clusters list --format="value(resourceLabels.alethia_project-id)"
			gc_list orphan-scan compute disks list --format="value(labels.alethia_project-id)"
			gc_list orphan-scan compute addresses list --format="value(labels.alethia_project-id)"
			# The managed services too, now that they are discoverable by label. Without these a run
			# killed AFTER its GKE cluster went but BEFORE Cloud SQL did left an orphan no preflight
			# could ever name — the compute half found nothing, so the whole ENV went unswept while
			# a db-custom instance billed by the hour.
			gc_list orphan-scan sql instances list --format="value(settings.userLabels.alethia_project-id)"
			gc_list orphan-scan storage buckets list --format="value(labels.alethia_project-id)"
		} | grep -E '^e2e-' | sort -u || true
	)"
	while IFS= read -r v; do
		[ -n "$v" ] || continue
		oenv="${v#e2e-}"
		[ "$oenv" = "$SELF_ENV" ] && continue # skip THIS run (its own teardown handles it)
		printf '%s' "$oenv" | grep -Eq '^[a-z0-9][a-z0-9._-]{4,62}$' || continue
		case "$oenv" in
		prod | prod-* | production | production-* | staging | staging-* | main | alethia | alethia-* | data) continue ;;
		esac
		printf '%s\n' "$oenv"
	done <<<"$vals" | sort -u
}

# ── PREFLIGHT: sweep prior-run e2e orphans (NOT this run), best-effort + loud. ──
SELF_ENV="$ENV"
if [ "$PREFLIGHT" = "1" ]; then
	echo "→ gcp STALE PREFLIGHT in ${REGION}: sweeping prior-run e2e orphans (excludes this run ${SELF_ENV})"
	[ "$DRY_RUN" = "1" ] && echo "  (DRY_RUN=1 — listing only, deleting nothing)"
	orphans="$(list_orphan_envs || true)"
	if [ -z "$orphans" ]; then
		# ── REPORT BEFORE THE EARLY RETURN. ────────────────────────────────────────────────────
		#
		# This branch is reached BOTH when discovery answered "nothing" and when discovery never
		# answered at all — an expired session or a throttled API yields an empty orphan list, and
		# the ✓ line below then prints over an account nobody looked at, exit 0, with the
		# `probe_warn_unverifiable` call at the bottom of this block never reached. That log is
		# byte-identical to a genuinely empty account, and scripts/e2e/reaper-result.mjs recorded it
		# as `clean` — evidence about resources that BILL.
		#
		# hcloud-cleanup.sh has always reported here; the other four did not. See
		# scripts/e2e/lib/sweep-probe.sh's probe_report_discovery header for why the marker is
		# positive rather than another warning.
		probe_report_discovery gcp "the preflight orphan scan"
		echo "✓ preflight: no prior-run e2e orphans — nothing to sweep"
		exit 0
	fi
	# shellcheck disable=SC2086
	echo "  orphan run ENVs found: $(printf '%s ' $orphans)"
	echo "  budget: ${PREFLIGHT_BUDGET_SECONDS}s wall-clock, at most ${PREFLIGHT_MAX_ENVS} orphan(s) this run"
	residual=0
	attempted=0
	deadline=$(($(date +%s) + PREFLIGHT_BUDGET_SECONDS))
	# Anything the bounds stop us from reaching is NAMED, not silently dropped — an unswept orphan
	# is BILLING, so "we ran out of budget" has to be as visible as "we tried and failed".
	skipped=""
	while IFS= read -r oenv; do
		[ -n "$oenv" ] || continue
		if [ "$attempted" -ge "$PREFLIGHT_MAX_ENVS" ]; then
			skipped="${skipped}${oenv} (cap) "
			continue
		fi
		now=$(date +%s)
		if [ "$now" -ge "$deadline" ]; then
			skipped="${skipped}${oenv} (budget) "
			continue
		fi
		attempted=$((attempted + 1))
		echo "── preflight sweep: prior run ${oenv} (${attempted}/${PREFLIGHT_MAX_ENVS}, $((deadline - now))s budget left) ──"
		if ! sweep_env "$oenv"; then
			echo "::warning::preflight could not fully sweep prior-run orphan ${oenv} (still billing) — the always() teardown / next preflight will retry. NOT failing this provisioning run."
			residual=1
		fi
	done <<<"$orphans"
	if [ -n "$skipped" ]; then
		# ::error:: (not ::warning::) because a bounded preflight that keeps deferring the SAME
		# orphan every night is how an orphan survives long enough to eat a job cap. This is the
		# signal that a human has to sweep it by hand; it still does not fail the step.
		echo "::error::preflight left orphan(s) UNSWEPT and BILLING — bounds reached before they were reached: ${skipped}"
		echo "::error::sweep by hand, scope-locked: ALETHIA_E2E_ENV=<env> ALETHIA_E2E_REGION=${REGION} ./scripts/e2e/gcp-cleanup.sh"
		residual=1
	fi
	if [ "$residual" = "1" ]; then
		echo "⚠ preflight finished with residual orphans (see warnings above) — continuing (best-effort, non-fatal)"
	else
		# ⚠️ Not "the project is clean" — "every orphan this preflight could SEE is swept". The
		# discovery listings can fail too, and preflight is explicitly non-blocking, so the honest
		# report here is a warning; the always() teardown is what gates.
		probe_report_discovery gcp "the preflight orphan scan"
		echo "✓ preflight complete — all prior-run e2e orphans swept"
	fi
	exit 0 # preflight never blocks the provisioning run
fi

# ── Self-test. `gc` is stubbed, so this touches no project and needs no credentials. What is under
# test is the THREE-STATE contract: an empty project and a project this script could not look at
# must not produce the same answer, and the second must not exit 0.
#
# $ST_OUT and $ST_RC are varied INDEPENDENTLY on purpose. Every list in this file used to read
# `gc … 2>/dev/null | grep -v '' || true`, and the OUTPUT half of that always worked — a test that
# varies only the output passes just as happily with the fix removed. ──
if [ "$SELF_TEST" = "1" ]; then
	st_fails=0
	if [ "$REGION" = "europe-west3" ]; then
		echo "  ✓ a zonal nightly location is normalized for regional cleanup commands"
	else
		echo "  ✗ zonal nightly location normalized to '${REGION}', want 'europe-west3'" >&2
		st_fails=$((st_fails + 1))
	fi
	gc() {
		if [ -n "$ST_OUT" ]; then printf '%s\n' "$ST_OUT"; fi
		if [ "$ST_RC" -ne 0 ]; then printf '%s\n' "${ST_ERR:-ERROR: (gcloud) request failed}" >&2; fi
		return "$ST_RC"
	}

	echo "→ gcp-cleanup.sh self-test (ENV=${ENV})"
	st_case() { # <name> <output> <rc> <expected finalize rc> <expect unverifiable: yes|no>
		probe_reset
		ST_OUT="$2" ST_RC="$3" ST_ERR="ERROR: (gcloud.container.clusters.list) Your credentials have expired"
		CLUSTER="" CLUSTER_LOCATION="" NETWORK=""
		local rc=0 unv=no
		finalize_verification >/dev/null 2>&1 || rc=$?
		probe_has_unverifiable && unv=yes
		if [ "$rc" = "$4" ] && [ "$unv" = "$5" ]; then
			echo "  ✓ $1"
		else
			echo "  ✗ $1 — expected rc=$4/unverifiable=$5, got rc=${rc}/unverifiable=${unv}" >&2
			st_fails=$((st_fails + 1))
		fi
	}
	st_case "an empty project, honestly listed, is CLEAN and exits 0" "" 0 0 no
	st_case "a surviving billable resource is a LEAK and exits 1" "gke-ew3-x-alethia" 0 1 no
	# THE REGRESSION. Before this change the case below and the case above-above were byte-identical:
	# empty stdout, exit 0, "no billable resources remain".
	st_case "a list that FAILED is UNVERIFIABLE and exits 4, NOT 0" "" 1 4 yes

	# ── CLOUD PARITY FOR THE FOURTH STATE (#3138 follow-up). ─────────────────────────────────────
	#
	# The four-state taxonomy is ONE contract, in scripts/e2e/lib/sweep-probe.sh. Every sweeper
	# asserts it here rather than trusting that sourcing the library is enough, because the thing
	# that actually breaks is a CALLER — a "✓ verified complete" line that forgot the qualifier, or a
	# finalize_verification reading the wrong ledger. hetzner is the only cloud with an
	# unattributable resource today (the imager upload helpers, #2463); the next one must not have to
	# re-derive the answer, and must not be able to ship the loud half without the non-gating half.
	#
	# BOTH halves, because either alone is satisfiable by the wrong change: an UNATTRIBUTABLE finding
	# must not move the exit code, AND an API failure must still move it to 4.
	st_parity() { # <name> <rc> <the ✓ line (STDOUT) names it: yes|no> <unverifiable: yes|no> <the annotation (STDERR) names it: yes|no>
		local rc=0 out named=no ann=no unv=no errf
		# STDOUT AND STDERR ARE READ SEPARATELY, and that is the point of this helper. The ::warning::
		# goes to stderr and would match either way, so folding them together with 2>&1 would let the
		# ✓ line silently lose its qualifier — "verified complete — no billable resources remain",
		# full stop, over an account that still holds something — and this test would not notice.
		errf="$(mktemp "${TMPDIR:-/tmp}/alethia-st-parity.XXXXXX")"
		out="$(finalize_verification 2>"$errf")" || rc=$?
		case "$out" in *UNATTRIBUTABLE*) named=yes ;; esac
		if grep -q 'UNATTRIBUTABLE' "$errf"; then ann=yes; fi
		rm -f "$errf"
		probe_has_unverifiable && unv=yes
		if [ "$rc" = "$2" ] && [ "$named" = "$3" ] && [ "$unv" = "$4" ] && [ "$ann" = "$5" ]; then
			echo "  ✓ $1"
		else
			echo "  ✗ $1 — expected rc=$2/✓-line=$3/unverifiable=$4/annotation=$5, got rc=${rc}/✓-line=${named}/unverifiable=${unv}/annotation=${ann}" >&2
			st_fails=$((st_fails + 1))
		fi
	}
	probe_reset
	ST_OUT="" ST_RC=0 ST_ERR=""
	CLUSTER="" CLUSTER_LOCATION="" NETWORK=""
	probe_note_unattributable imager-upload-helpers "unlabelled — cannot be tied to this run"
	st_parity "an UNATTRIBUTABLE finding is reported loudly and does NOT gate" 0 yes no yes
	probe_reset
	ST_OUT="" ST_RC=1 ST_ERR="ERROR: (gcloud) Your credentials have expired"
	CLUSTER="" CLUSTER_LOCATION="" NETWORK=""
	probe_note_unattributable imager-upload-helpers "unlabelled — cannot be tied to this run"
	st_parity "…and it never masks an API failure, which still exits 4" 4 no yes yes

	# The type NAMES the report, so a human knows what to check by hand. A ledger that only said
	# "something failed" would send them to look at everything.
	probe_reset
	ST_OUT="" ST_RC=1 ST_ERR="PERMISSION_DENIED"
	list_sql_instances >/dev/null 2>&1 || true
	case "$(probe_unverifiable_types)" in
	*cloud-sql*) echo "  ✓ the ledger names the resource type that could not be checked" ;;
	*)
		echo "  ✗ the ledger names the resource type that could not be checked — got '$(probe_unverifiable_types)'" >&2
		st_fails=$((st_fails + 1))
		;;
	esac
	unset -f gc

	if [ "$st_fails" -ne 0 ]; then
		echo "✗ gcp-cleanup.sh self-test: ${st_fails} failure(s)" >&2
		exit 1
	fi
	echo "✓ gcp-cleanup.sh self-test passed"
	exit 0
fi

# ── Orchestrate, in strict dependency order. ──
discover_cluster
sweep_load_balancers
sweep_gke
sweep_instances
sweep_pvc_disks
sweep_managed_services
sweep_network

if [ "$DRY_RUN" = "1" ]; then
	echo "✓ gcp DRY RUN complete for alethia_project-id=${PID_LABEL} (nothing deleted, nothing verified)"
	exit 0
fi

echo "→ verifying nothing billable for run ${ENV} survived…"
st_rc=0
finalize_verification || st_rc=$?
exit "$st_rc"
