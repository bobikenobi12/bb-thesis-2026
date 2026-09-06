#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# alibaba-cleanup.sh — belt-and-suspenders teardown for the T2 real-cloud nightly (Alibaba/ACK).
#
# Cloned guard-for-guard from scripts/e2e/aws-cleanup.sh (BYOC A1.3) and hcloud-cleanup.sh
# (A1.3). The T2 harness tears the cluster down GRACEFULLY in-process via `tofu destroy`
# (provisioner.RunDestroy) on the normal path. But if the test PROCESS is hard-killed (a
# `go test -timeout` panic, a CI step SIGKILL, a runner crash), t.Cleanup never runs and REAL,
# billable Alibaba resources leak — most dangerously the OUT-OF-BAND ones tofu never tracked:
# the ACK node-pool ECS instances, the CCM-created SLB/ALB load balancers, and the CSI-created
# `pvc-*` cloud disks. This script is the guarantee: the nightly runs it in an `always()` step
# so the run's resources are gone no matter how the test ended.
#
# ─────────────────────────────  S A F E T Y  ─────────────────────────────
# The Alibaba account is SHARED (like the hcloud + AWS accounts). An unfiltered delete would be
# catastrophic (cf. the shared-hcloud near-wipe; scope-destructive-cloud-ops memory). So:
#
#   * DISCOVERY is tag-driven. Every resource the alibaba project template creates inherits the
#     unique per-run handle `alethia:project-id=e2e-<ENV>` (locals.common_tags → every module's
#     `tags`; see infra/templates/project/alibaba/locals.tf + packages/core/cloud/tags.go
#     alibabaTagStyle). Alibaba tag filters (`--Tag.N.Key`/`--Tag.N.Value`) are EXACT matches, no
#     wildcards. ENV = <run_id>-<attempt>, unique per run.
#   * OUT-OF-BAND resources that do NOT inherit the template `tags` (CSI `pvc-*` cloud disks; the
#     CCM's SLB/ALB) are swept by a SECONDARY filter bound to THIS run's ACK cluster — discovered
#     from the tagged/named ACK cluster, keyed on the `ack.aliyun.com=<cluster_id>` tag ACK stamps
#     on cluster-owned cloud resources. If the cluster is already gone (a mid-destroy kill), the
#     cluster is re-found from any ACK cluster whose NAME embeds `-<ENV>` (the ACK name is
#     `<project>-<env>`, locals.ack_name) so the orphans are still found + swept + VERIFIED. Still
#     never account-wide: the secondary equality match on `<cluster_id>` (unique per run) excludes
#     every other run's / prod's resources.
#   * Refuses to run without a specific, plausibly-unique ENV + an explicit region; rejects
#     shared/prod values; asserts a non-empty scope before every mutating call; and — the last
#     line of defence — a leak NEVER exits green: verify_swept re-lists the tagged + cluster-owned
#     scopes and fails the step on any surviving BILLABLE resource (ACK/ECS/disks/SLB/ALB), so a
#     real leak can't false-GREEN.
#
# Usage:
#   ALETHIA_E2E_ENV=<run_id>-<attempt> ALETHIA_E2E_REGION=eu-central-1 ./scripts/e2e/alibaba-cleanup.sh
#   (positional $1 accepted for call-site symmetry with hcloud-cleanup.sh but IGNORED — the managed
#    sweepers read their scope from ALETHIA_E2E_ENV / _PROJECT / _REGION.)
#   ALETHIA_E2E_PROJECT=<project>   # optional; when set the ACK cluster name (<project>-<env>) is
#                                   # matched EXACTLY in addition to the tag, tightening discovery.
#   DRY_RUN=1 ...     # list what WOULD be deleted, delete + verify nothing
#   PREFLIGHT=1 ...   # BEFORE provisioning: sweep PRIOR-run e2e orphans (any other e2e-<env>),
#                     #   NOT this run. Best-effort + loud (warns on residual, never exit 1).
#
# Requires: the `aliyun` CLI (authenticated — keyless AssumeRoleWithOIDC in CI) + jq.
set -euo pipefail

# ── The probe contract (CLEAN / LEAKED / UNVERIFIABLE / UNATTRIBUTABLE), shared by all five cloud
#    sweepers. Read scripts/e2e/lib/sweep-probe.sh before touching any lister below: `ali … 2>/dev/null
#    | jq … 2>/dev/null | grep -v '^$' || true` launders the CLI's exit status FOUR times over —
#    and the jq stage adds one the other clouds do not have, because jq exits 0 on empty input, so
#    a non-JSON error page becomes an empty id list and a clean-looking teardown.
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

# ── `--self-test` exercises the three-state probe contract against a stubbed `aliyun` and exits.
# It sets its own ENV/REGION so the guards below are left exactly as they protect the real path. ──
SELF_TEST=0
if [ "${1:-}" = "--self-test" ]; then
	SELF_TEST=1
	ALETHIA_E2E_ENV="selftest-4177-1"
	ALETHIA_E2E_REGION="eu-central-1"
	# The probe retries are a real-cloud kindness (a transient 5xx must not red a healthy teardown)
	# and pure dead time against a stub. The retry LOOP is still exercised; it just does not wait.
	PROBE_RETRY_DELAY=0
fi

ENV="${ALETHIA_E2E_ENV:-}"
# Region is AUTHORITATIVE from ALETHIA_E2E_REGION only. A silent fallback to an ambient region that
# differs from where the run provisioned would make every (regional) tag query empty → delete
# nothing, verify nothing, exit green while the real region bills (aws-cleanup grill F3).
REGION="${ALETHIA_E2E_REGION:-}"
PROJECT="${ALETHIA_E2E_PROJECT:-}"
DRY_RUN="${DRY_RUN:-0}"
PREFLIGHT="${PREFLIGHT:-0}"
DELETE_RETRIES="${DELETE_RETRIES:-5}"
DETACH_TIMEOUT="${DETACH_TIMEOUT:-180}"
# ── PREFLIGHT budget (#2257, ported from aws-cleanup.sh by #2330). The preflight's "never blocks
# the caller" promise is carried by `exit 0` at the end of its loop — which is only reached if the
# loop ENDS. Unbounded, it cannot promise that: on run 31459117502 the AWS equivalent consumed 86
# of a 90-minute job cap, the job hit its cap, GitHub marked it CANCELLED, and the always()
# teardown died mid-step leaving ~$105/mo standing. A best-effort step that can consume its caller
# is not best-effort.
#
# e2e-orphan-reaper.yml already passes both bounds to all four clouds; until this port only aws
# READ them, so the reaper's own 75-minute cap was the sole bound here — and hitting that cap is
# the same cancel-mid-sweep failure this issue exists to fix. Two bounds, both reported:
PREFLIGHT_BUDGET_SECONDS="${PREFLIGHT_BUDGET_SECONDS:-900}" # wall-clock for the whole sweep loop
PREFLIGHT_MAX_ENVS="${PREFLIGHT_MAX_ENVS:-3}"               # orphans attempted per run

# ── Guard 1: a specific ENV is REQUIRED. No ENV ⇒ no filter ⇒ hard refuse. ──
if [ -z "$ENV" ]; then
	echo "✗ REFUSING TO RUN: ALETHIA_E2E_ENV is unset." >&2
	echo "  This script only ever deletes resources tagged alethia:project-id=e2e-<ENV> — never" >&2
	echo "  account-wide. Set ALETHIA_E2E_ENV to the unique per-run value (<run_id>-<attempt>)." >&2
	exit 2
fi

# ── Guard 2: ENV must be specific enough to be a single run, not a broad/shared prefix. ──
if ! printf '%s' "$ENV" | grep -Eq '^[a-z0-9][a-z0-9._-]{4,62}$'; then
	echo "✗ REFUSING TO RUN: ENV '$ENV' is not a valid, specific handle ([a-z0-9][a-z0-9._-]{4,62})." >&2
	echo "  Refusing so a typo can't widen the tag filter." >&2
	exit 2
fi
case "$ENV" in
prod | prod-* | production | production-* | staging | staging-* | main | alethia | alethia-* | data)
	echo "✗ REFUSING TO RUN: ENV '$ENV' looks like shared/prod infra, not a nightly run." >&2
	exit 2
	;;
esac

# ── Guard 3: an explicit region is REQUIRED (no silent ambient fallback — grill F3). ──
if [ -z "$REGION" ]; then
	echo "✗ REFUSING TO RUN: ALETHIA_E2E_REGION is unset." >&2
	echo "  Tag discovery is regional; a wrong/empty region deletes+verifies nothing and false-greens." >&2
	exit 2
fi

# The self-test shadows `ali` with a shell function, so it needs no aliyun binary — and the CI
# runner that runs it has none. jq IS still required: the self-test drives real jq filters.
for bin in aliyun jq; do
	[ "$bin" = "aliyun" ] && [ "$SELF_TEST" = "1" ] && continue
	if ! command -v "$bin" >/dev/null 2>&1; then
		echo "✗ the '$bin' CLI is not installed." >&2
		exit 2
	fi
done

TAGK="alethia:project-id"          # the Alibaba sweep-handle key (alibabaTagStyle: colon-namespaced)
PROJECT_ID_TAG="e2e-${ENV}"        # its unique per-run value (config.ID = e2e-<env>)
CLUSTER_NAME=""                    # the ACK cluster name (<project>-<env>); may be derived below
CLUSTER_ID=""                      # the ACK cluster id — the secondary (out-of-band) scope

# ── ali <product> <ApiName> [--params…] — every aliyun call goes through here so the region is
#    pinned on ONE line. `--region` sets the endpoint region AND populates RegionId for RPC APIs,
#    so a call can never silently hit the wrong (or a default) region. ──
ali() { aliyun "$@" --region "$REGION"; }

# The per-run banner is for the normal (belt-and-suspenders) path; PREFLIGHT prints its own below.
if [ "$PREFLIGHT" != "1" ] && [ "$SELF_TEST" != "1" ]; then
	echo "→ alibaba belt-and-suspenders cleanup in ${REGION}, scope ${TAGK}=${PROJECT_ID_TAG}"
	[ "$DRY_RUN" = "1" ] && echo "  (DRY_RUN=1 — listing only, deleting nothing)"
fi

# assert_scope fails closed if the scope ever became empty (defensive — the guards above already
# ensure it can't, but never issue a tag-less aliyun call).
assert_scope() {
	if [ -z "${PROJECT_ID_TAG#e2e-}" ]; then
		echo "✗ INTERNAL: empty scope — aborting before an unfiltered operation." >&2
		exit 3
	fi
}

# looks_gone <stderr-text> — true if an aliyun delete error means the resource is already absent
# (idempotency: eventual consistency can list an already-deleted id; a NotFound on delete is
# success, not failure). Covers Alibaba's `Invalid<Res>Id.NotFound`, the generic `NotFound`, the
# ACK `ErrorClusterNotFound`, and the "does not exist" family.
looks_gone() {
	printf '%s' "$1" | grep -Eqi 'NotFound|does not exist|not exist|InvalidResourceId\.NotFound|ErrorClusterNotFound|InvalidLoadBalancerId|Forbidden\.InstanceNotFound'
}

# retry_delete <human> <cmd...> — delete with backoff. "Already gone" = success. NEVER returns
# non-zero (so `set -e` can't abort the sweep BEFORE verify_swept, the real gate — aws grill F4);
# an unresolved failure logs a WARN and lets verify catch it authoritatively.
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

################################################################################
# Tag-filtered discovery (primary scope) — one function per service. Each is tag-mandatory;
# none ever returns an unscoped list. jq's `?` swallows a missing key so an empty/oddly-shaped
# response degrades to "none", not an error.
################################################################################

# ali_jq <type> <jqPath> <ali args…> — the ONE place an aliyun response is turned into ids.
#
# Two stages, two failure modes, and until this change both were laundered into "no resources":
#
#   1. the API call — captured through probe_run, so its REAL exit status decides, not the pipe's;
#   2. the jq parse — jq exits 0 on EMPTY input, so `ali … 2>/dev/null | jq …` turned an HTML error
#      page, a throttle body or a truncated response into an empty id list and exit 0. That second
#      laundering is unique to this cloud (only alibaba pipes through jq), and it is the reason a
#      response that arrives but cannot be read is now UNVERIFIABLE too.
ali_jq() {
	local ptype="$1" jqpath="$2"
	shift 2
	local raw out
	raw="$(probe_run "$ptype" ali "$@")" || return 0
	[ -n "$raw" ] || return 0
	if ! out="$(printf '%s' "$raw" | jq -r "$jqpath" 2>&1)"; then
		probe_note_unverifiable "$ptype" "response arrived but could not be parsed as JSON"
		return 0
	fi
	printf '%s\n' "$out" | grep -v '^$' || true
}

# tagged_ids <type> <product> <DescribeApi> <jqPath> — generic ECS/VPC RPC lister, filtered on our
# project-id tag.
tagged_ids() {
	assert_scope
	local ptype="$1" product="$2" api="$3" jqpath="$4"
	ali_jq "$ptype" "$jqpath" "$product" "$api" \
		--PageSize 100 \
		--Tag.1.Key "$TAGK" --Tag.1.Value "$PROJECT_ID_TAG"
}

tagged_instances() { tagged_ids ecs-instance ecs DescribeInstances '.Instances.Instance[]?.InstanceId'; }
tagged_disks() { tagged_ids cloud-disk ecs DescribeDisks '.Disks.Disk[]?.DiskId'; }
tagged_security_groups() { tagged_ids security-group ecs DescribeSecurityGroups '.SecurityGroups.SecurityGroup[]?.SecurityGroupId'; }
tagged_vpcs() { tagged_ids vpc vpc DescribeVpcs '.Vpcs.Vpc[]?.VpcId'; }
tagged_vswitches() { tagged_ids vswitch vpc DescribeVSwitches '.VSwitches.VSwitch[]?.VSwitchId'; }
tagged_nat_gateways() { tagged_ids nat-gateway vpc DescribeNatGateways '.NatGateways.NatGateway[]?.NatGatewayId'; }
tagged_eips() { tagged_ids eip vpc DescribeEipAddresses '.EipAddresses.EipAddress[]?.AllocationId'; }

# SLB (classic) tag filter param spelling differs per API version; use the documented Tag.N.Key.
tagged_slbs() { tagged_ids slb slb DescribeLoadBalancers '.LoadBalancers.LoadBalancer[]?.LoadBalancerId'; }
# ALB lister is ROA-ish RPC (`ListLoadBalancers` → `.LoadBalancers[].LoadBalancerId`).
tagged_albs() {
	assert_scope
	ali_jq alb '.LoadBalancers[]?.LoadBalancerId' alb ListLoadBalancers \
		--Tag.1.Key "$TAGK" --Tag.1.Value "$PROJECT_ID_TAG"
}

################################################################################
# Cluster discovery + out-of-band (cluster-owned) scope. The ACK CCM/CSI stamp
# `ack.aliyun.com=<cluster_id>` on the SLB/ALB/disks they create out-of-band; those do NOT carry
# the template project-id tag, so they are swept via this SECONDARY, cluster-scoped filter. It is
# only ever populated once CLUSTER_ID is known (a unique per-run value) — never account-wide.
################################################################################

# all_clusters — the ACK cluster inventory in this region as compact JSON lines
# {id,name,tags}. `aliyun cs GET /api/v1/clusters` returns {"clusters":[…]} (or, on older CLIs, a
# bare array) — handle both.
all_clusters() {
	ali_jq ack-cluster '(.clusters // .)[]? | {id: .cluster_id, name: .name, region: .region_id,
			pid: ((.tags // []) | map(select(.key == "'"$TAGK"'") | .value) | first) }' \
		cs GET /api/v1/clusters
}

# ── Discover THIS run's ACK cluster for the out-of-band secondary sweeps. First by the project-id
#    tag on the cluster; if the cluster is already gone or untagged (a mid tofu-destroy kill), fall
#    back to any cluster whose NAME embeds `-<ENV>` (ack_name = <project>-<env>) — and, when
#    ALETHIA_E2E_PROJECT is set, the EXACT `<project>-<env>` name. Never guessed past this run. ──
discover_cluster() {
	assert_scope
	local rows exact="" byname="" bytag=""
	rows="$(all_clusters)"
	[ -z "$rows" ] && {
		echo "  · no ACK clusters visible (nothing out-of-band to sweep, or already gone)"
		return 0
	}
	# Only ever consider clusters in THIS region (region_id must match).
	rows="$(printf '%s\n' "$rows" | jq -c "select(.region == \"$REGION\")" 2>/dev/null || true)"

	bytag="$(printf '%s\n' "$rows" | jq -r "select(.pid == \"$PROJECT_ID_TAG\") | .id + \"\t\" + .name" 2>/dev/null | head -n1 || true)"
	byname="$(printf '%s\n' "$rows" | jq -r "select(.name | test(\"-${ENV}(\$|-)\")) | .id + \"\t\" + .name" 2>/dev/null | head -n1 || true)"
	if [ -n "$PROJECT" ]; then
		exact="$(printf '%s\n' "$rows" | jq -r "select(.name == \"${PROJECT}-${ENV}\") | .id + \"\t\" + .name" 2>/dev/null | head -n1 || true)"
	fi

	local pick="${bytag:-${exact:-$byname}}"
	if [ -n "$pick" ]; then
		CLUSTER_ID="$(printf '%s' "$pick" | cut -f1)"
		CLUSTER_NAME="$(printf '%s' "$pick" | cut -f2)"
		echo "  · cluster (secondary scope): ${CLUSTER_NAME} [${CLUSTER_ID}]"
	else
		echo "  · no cluster found for ENV ${ENV} (nothing out-of-band to sweep, or already gone)"
	fi
}

# cluster_tagged_ids <product> <api> <jqpath> — resources carrying the ACK `ack.aliyun.com=<id>`
# tag (out-of-band CCM/CSI resources). Empty when CLUSTER_ID unknown (never account-wide).
cluster_tagged_ids() {
	[ -z "$CLUSTER_ID" ] && return 0
	local ptype="$1" product="$2" api="$3" jqpath="$4"
	ali_jq "$ptype" "$jqpath" "$product" "$api" \
		--PageSize 100 \
		--Tag.1.Key "ack.aliyun.com" --Tag.1.Value "$CLUSTER_ID"
}

cluster_instance_ids() { cluster_tagged_ids ecs-instance ecs DescribeInstances '.Instances.Instance[]?.InstanceId'; }
cluster_disk_ids() { cluster_tagged_ids cloud-disk ecs DescribeDisks '.Disks.Disk[]?.DiskId'; }
cluster_slb_ids() { cluster_tagged_ids slb slb DescribeLoadBalancers '.LoadBalancers.LoadBalancer[]?.LoadBalancerId'; }
cluster_alb_ids() {
	[ -z "$CLUSTER_ID" ] && return 0
	ali_jq alb '.LoadBalancers[]?.LoadBalancerId' alb ListLoadBalancers \
		--Tag.1.Key "ack.aliyun.com" --Tag.1.Value "$CLUSTER_ID"
}

################################################################################
# Sweep, in strict dependency order:
#   1. SLB / ALB   — CCM out-of-band; free their listeners before subnets/cluster go
#   2. ACK cluster — reclaims the node-pool ECS instances (+ most cluster-owned infra)
#   3. orphan ECS  — any node instance the cluster delete didn't reclaim
#   4. CSI disks   — dynamically-provisioned pvc-* cloud disks (detach-safe)
#   5. VPC residue — SNAT → NAT → EIP → security groups → vswitches → VPC
################################################################################

# ── 1. Load balancers (SLB classic + ALB), both tagged + cluster-owned (CCM). ──
sweep_load_balancers() {
	assert_scope
	local ids id
	ids="$({
		tagged_slbs
		cluster_slb_ids
	} | grep -v '^$' | sort -u || true)"
	if [ -z "$ids" ]; then
		echo "  · SLB load balancers: none"
	else
		echo "  · SLB load balancers: $(printf '%s' "$ids" | grep -c .) to delete"
		while IFS= read -r id; do
			[ -n "$id" ] || continue
			retry_delete "slb ${id}" ali slb DeleteLoadBalancer --LoadBalancerId "$id"
		done <<<"$ids"
	fi
	ids="$({
		tagged_albs
		cluster_alb_ids
	} | grep -v '^$' | sort -u || true)"
	if [ -z "$ids" ]; then
		echo "  · ALB load balancers: none"
	else
		echo "  · ALB load balancers: $(printf '%s' "$ids" | grep -c .) to delete"
		while IFS= read -r id; do
			[ -n "$id" ] || continue
			retry_delete "alb ${id}" ali alb DeleteLoadBalancer --LoadBalancerId "$id"
		done <<<"$ids"
	fi
}

# ── 2. ACK cluster (tofu-managed; sweep only if leaked past a killed destroy). Deleting the
#       cluster reclaims its node-pool ECS + most cluster-owned infra. ──
sweep_cluster() {
	[ -z "$CLUSTER_ID" ] && {
		echo "  · ACK cluster: none"
		return 0
	}
	retry_delete "ack cluster ${CLUSTER_NAME} [${CLUSTER_ID}]" ali cs DELETE "/clusters/${CLUSTER_ID}"
	if [ "$DRY_RUN" != "1" ]; then
		local waited=0
		while [ "$waited" -lt "$DETACH_TIMEOUT" ]; do
			# describe returns non-zero (ErrorClusterNotFound) once the cluster is gone.
			ali cs GET "/api/v1/clusters/${CLUSTER_ID}" >/dev/null 2>&1 || break
			echo "  · waiting for ACK cluster ${CLUSTER_ID} to delete… (${waited}s/${DETACH_TIMEOUT}s)"
			sleep 15
			waited=$((waited + 15))
		done
	fi
}

# ── 3. Orphan ECS instances (tagged node-pool ECS + cluster-owned). Terminate any node the
#       cluster delete didn't reclaim; they hold ENIs + disks blocking the VPC/disk teardown. ──
sweep_instances() {
	assert_scope
	local ids id
	ids="$({
		tagged_instances
		cluster_instance_ids
	} | grep -v '^$' | sort -u || true)"
	[ -z "$ids" ] && {
		echo "  · ECS instances: none"
		return 0
	}
	echo "  · ECS instances: $(printf '%s' "$ids" | grep -c .) to terminate"
	while IFS= read -r id; do
		[ -n "$id" ] || continue
		# --Force stops-then-releases a running instance in one call; --TerminateSubscription
		# releases any (unexpected) subscription instance too.
		retry_delete "ecs ${id}" ali ecs DeleteInstance --InstanceId "$id" --Force true
	done <<<"$ids"
}

# ── 4. CSI cloud disks (tagged pvc-* + cluster-owned CSI fallback). Detach then delete. ──
sweep_disks() {
	assert_scope
	local ids id
	[ "$DRY_RUN" != "1" ] && sleep 10
	ids="$({
		tagged_disks
		cluster_disk_ids
	} | grep -v '^$' | sort -u || true)"
	[ -z "$ids" ] && {
		echo "  · cloud disks: none"
		return 0
	}
	echo "  · cloud disks: $(printf '%s' "$ids" | grep -c .) to delete"
	while IFS= read -r id; do
		[ -n "$id" ] || continue
		[ "$DRY_RUN" = "1" ] && {
			echo "      would delete disk ${id}"
			continue
		}
		ali ecs DetachDisk --DiskId "$id" >/dev/null 2>&1 || true
		retry_delete "disk ${id}" ali ecs DeleteDisk --DiskId "$id"
	done <<<"$ids"
}

# ── 5. VPC teardown (all tagged): SNAT entries → NAT gateways → EIPs → security groups →
#       vswitches → VPC. Dependency order; retry_delete's backoff absorbs residual races. ──
sweep_network() {
	assert_scope
	local nats nat eips eip sgs sg vsws vsw vpcs vpc

	# SNAT entries hang off the NAT gateway's snat table; delete them before the NAT gateway.
	nats="$(tagged_nat_gateways)"
	while IFS= read -r nat; do
		[ -n "$nat" ] || continue
		# List this NAT's snat table + entries, then delete each entry.
		local stid entries eid
		stid="$(ali vpc DescribeNatGateways --NatGatewayId "$nat" 2>/dev/null |
			jq -r '.NatGateways.NatGateway[]?.SnatTableIds.SnatTableId[]?' 2>/dev/null | head -n1 || true)"
		if [ -n "$stid" ]; then
			entries="$(ali vpc DescribeSnatTableEntries --SnatTableId "$stid" 2>/dev/null |
				jq -r '.SnatTableEntries.SnatTableEntry[]?.SnatEntryId' 2>/dev/null | grep -v '^$' || true)"
			while IFS= read -r eid; do
				[ -n "$eid" ] || continue
				retry_delete "snat-entry ${eid}" ali vpc DeleteSnatEntry --SnatTableId "$stid" --SnatEntryId "$eid"
			done <<<"$entries"
		fi
	done <<<"$nats"

	# NAT gateways (--Force detaches remaining bindings).
	while IFS= read -r nat; do
		[ -n "$nat" ] || continue
		retry_delete "nat-gateway ${nat}" ali vpc DeleteNatGateway --NatGatewayId "$nat" --Force true
	done <<<"$nats"
	if [ "$DRY_RUN" != "1" ] && [ -n "$nats" ]; then
		local waited=0 live
		while [ "$waited" -lt "$DETACH_TIMEOUT" ]; do
			live="$(tagged_nat_gateways | grep -c . || true)"
			[ "${live:-0}" -eq 0 ] && break
			echo "  · waiting for ${live} NAT gateway(s) to delete… (${waited}s/${DETACH_TIMEOUT}s)"
			sleep 10
			waited=$((waited + 10))
		done
	fi

	# EIPs (unassociate-then-release; ReleaseEipAddress refuses while still bound).
	eips="$(tagged_eips)"
	while IFS= read -r eip; do
		[ -n "$eip" ] || continue
		[ "$DRY_RUN" != "1" ] && ali vpc UnassociateEipAddress --AllocationId "$eip" >/dev/null 2>&1 || true
		retry_delete "eip ${eip}" ali vpc ReleaseEipAddress --AllocationId "$eip"
	done <<<"$eips"

	# Security groups (now unreferenced by any deleted ECS).
	sgs="$(tagged_security_groups)"
	while IFS= read -r sg; do
		[ -n "$sg" ] || continue
		retry_delete "security-group ${sg}" ali ecs DeleteSecurityGroup --SecurityGroupId "$sg"
	done <<<"$sgs"

	# Vswitches (subnets), then the VPC.
	vsws="$(tagged_vswitches)"
	while IFS= read -r vsw; do
		[ -n "$vsw" ] || continue
		retry_delete "vswitch ${vsw}" ali vpc DeleteVSwitch --VSwitchId "$vsw"
	done <<<"$vsws"

	vpcs="$(tagged_vpcs)"
	while IFS= read -r vpc; do
		[ -n "$vpc" ] || continue
		retry_delete "vpc ${vpc}" ali vpc DeleteVpc --VpcId "$vpc"
	done <<<"$vpcs"
}

################################################################################
# Final verification: a leak must NEVER exit green. Re-list the BILLABLE scopes (tagged + cluster-
# owned) authoritatively and fail the step on any survivor. Non-billable network residue
# (vswitch/SG/VPC still tagged) is a NOTICE, not a hard fail — it ages out or points at an
# upstream billable already caught above.
################################################################################
alive_cluster() {
	[ -z "$CLUSTER_ID" ] && return 0
	all_clusters | jq -r "select(.id == \"$CLUSTER_ID\") | .id" 2>/dev/null | grep -v '^$' || true
}
alive_instances() { {
	tagged_instances
	cluster_instance_ids
} | grep -v '^$' | sort -u || true; }
alive_disks() { {
	tagged_disks
	cluster_disk_ids
} | grep -v '^$' | sort -u || true; }
alive_slbs() { {
	tagged_slbs
	cluster_slb_ids
} | grep -v '^$' | sort -u || true; }
alive_albs() { {
	tagged_albs
	cluster_alb_ids
} | grep -v '^$' | sort -u || true; }
alive_nats() { tagged_nat_gateways; }
alive_eips() { tagged_eips; }

# ── Container Registry EE — the SUBSCRIPTION-billed outlier (#2333). ──────────────────────────────
#
# Every other resource above is discovered by TAG. This one cannot be: `alicloud_cr_ee_instance`
# takes no `tags` argument at all, so the tag filter the rest of this script is built on does not
# reach it. It is therefore scoped by NAME — the same secondary-scope shape `discover_cluster` uses
# for the ACK cluster, and bounded the same way: a name must embed THIS run's ENV, never a prefix
# that could match another run or prod.
#
# Why it earns a check of its own rather than a row in the tag sweep: it is the ONLY prepaid
# resource in the whole Alibaba module tree (`modules/cr/main.tf`: `payment_type = "Subscription"`,
# `period = 1`). Everything else is pay-as-you-go and stops costing when it is deleted; this one is
# a monthly commitment. Until now `verify_swept` checked seven resource classes and not this, so a
# standing subscription could not fail the sweep and the teardown reported clean — the precise
# failure aws-cleanup.sh's own header warns about: "a sweeper that reports clean without looking is
# more expensive than no sweeper, because it stops anyone else looking."
#
# WHETHER IT SURVIVES TEARDOWN AT ALL IS GENUINELY UNSETTLED, and this check is what settles it.
# docs/research/alibaba-cr-ee-subscription-release.md has the full reconciliation: the pinned
# provider (1.286.0) DOES call `RefundInstance` with `ImmediatelyRelease = "1"` on delete, while
# Alibaba's own ACR documentation states "Terraform cannot release subscription-based Container
# Registry instances … Manually unsubscribe from the instance in the console". Documentation cannot
# close that; a real teardown can. Find an instance ⇒ the docs are right and the parity board's
# warning stands. Find none ⇒ the refund works and the Alibaba full bar can be re-admitted.
#
# ⚠️ LIMIT, STATED RATHER THAN HIDDEN. `local.cr_name` renders `cr-<project>-<environment>` and
# falls back to `substr(...,0,22)-<sha7>` above 30 characters (checks_naming.tf, NAMING-003). The
# digest form does NOT reliably embed the full ENV, so this discovery would not see it. That form is
# unreachable at current lengths — the e2e fixture renders 27 of 30 — and NAMING-003 is the check
# that keeps it so. If that budget is ever relaxed, this discovery has to be revisited with it.
#
# This function NEVER deletes. Refunding a subscription is a billing operation, not a sweep, and a
# teardown script that can issue refunds has a far larger blast radius than this problem justifies.
alive_cr_instances() {
	assert_scope
	# `--version` is explicit: the `cr` product carries both 2016-06-07 and 2018-12-01, and only the
	# latter has ListInstance. Letting the CLI pick would make this silently version-dependent.
	#
	# Spelled out rather than routed through ali_jq because the filter needs `jq --arg`, which
	# ali_jq's positional shape cannot carry. The two-stage split is identical: the API call decides
	# the exit status through probe_run, and a response that arrives but will not parse is
	# UNVERIFIABLE rather than "no subscription". A subscription is the worst thing in this file to
	# report as "none" — it is a monthly commitment, and a missed one recurs every month.
	local raw out
	raw="$(probe_run cr-ee-instance-subscription ali cr ListInstance --version 2018-12-01 --PageSize 100)" || return 0
	[ -n "$raw" ] || return 0
	if ! out="$(printf '%s' "$raw" | jq -r --arg env "$ENV" \
		'.Instances[]? | select((.InstanceName // "") | contains("-" + $env)) | "\(.InstanceName)[\(.InstanceId)]"' 2>&1)"; then
		probe_note_unverifiable cr-ee-instance-subscription "response arrived but could not be parsed as JSON"
		return 0
	fi
	printf '%s\n' "$out" | grep -v '^$' || true
}

verify_swept() {
	assert_scope
	local leaks="" x
	join() { printf '%s' "$1" | tr '\n' ' '; }
	x="$(alive_cluster)"; [ -n "$x" ] && leaks="${leaks}ack-cluster: $(join "$x")\n"
	x="$(alive_instances)"; [ -n "$x" ] && leaks="${leaks}ecs-instance: $(join "$x")\n"
	x="$(alive_disks)"; [ -n "$x" ] && leaks="${leaks}cloud-disk: $(join "$x")\n"
	x="$(alive_slbs)"; [ -n "$x" ] && leaks="${leaks}slb: $(join "$x")\n"
	x="$(alive_albs)"; [ -n "$x" ] && leaks="${leaks}alb: $(join "$x")\n"
	x="$(alive_nats)"; [ -n "$x" ] && leaks="${leaks}nat-gateway: $(join "$x")\n"
	x="$(alive_eips)"; [ -n "$x" ] && leaks="${leaks}eip: $(join "$x")\n"
	# Collected separately from the list above: this one is not merely billable, it is a monthly
	# SUBSCRIPTION that `tofu destroy` may be unable to release, so the operator needs a different
	# instruction ("unsubscribe in the console") rather than "investigate + remove". Merging it into
	# the generic line would give exactly the wrong advice.
	local cr_alive
	cr_alive="$(alive_cr_instances)"
	if [ -n "$leaks" ] || [ -n "$cr_alive" ]; then
		if [ -n "$leaks" ]; then
			echo "  ✗ billable resources still alive:" >&2
			printf '%b' "  $leaks" >&2
			echo "::error::alibaba cleanup INCOMPLETE — billable resources for run ${ENV} still exist and are BILLING. Investigate + remove (stay scope-locked; never account-wide)." >&2
		fi
		if [ -n "$cr_alive" ]; then
			echo "  ✗ SUBSCRIPTION still alive: cr-ee-instance: $(join "$cr_alive")" >&2
			echo "::error::alibaba cleanup INCOMPLETE — a SUBSCRIPTION-billed Container Registry EE instance for run ${ENV} is still standing: $(join "$cr_alive"). This is a MONTHLY commitment, not an hourly resource. Release it in the Container Registry console — this script deliberately will not refund a subscription. See docs/research/alibaba-cr-ee-subscription-release.md (#2333)." >&2
		fi
		return 1
	fi
	# Non-billable network residue (vswitch/SG/VPC still tagged) is a NOTICE, not a hard fail.
	local residue
	residue="$({
		tagged_vswitches
		tagged_security_groups
		tagged_vpcs
	} | grep -v '^$' | sort -u || true)"
	# shellcheck disable=SC2086
	[ -n "$residue" ] && echo "::notice::alibaba cleanup: network residue still tagged (non-billable, will age out): $(printf '%s ' $residue)"
	return 0
}

# ── finalize_verification — THE EXIT-CODE CONTRACT.
#
#   0  every probe answered, and nothing billable for this run survived.
#   1  a LEAK: the API listed something still standing and billing (or a standing SUBSCRIPTION).
#   4  UNVERIFIABLE: at least one probe could not answer, so nothing here proves the account is
#      empty. This runs on the `always()` teardown path the T2 harness defers to as the guarantee,
#      so "could not look" has to red the step rather than pass as a log line.
#
# A confirmed leak outranks "could not check", so verify_swept runs first.
finalize_verification() {
	if ! verify_swept; then
		return 1
	fi
	probe_gate alibaba "run ${ENV}" || return 4
	# probe_clean_suffix is EMPTY on a genuinely clean run and carries any UNATTRIBUTABLE finding
	# otherwise, so this sentence can never read as "the account is empty" when it is not. Shared
	# by all five sweepers — the taxonomy is one contract, not five that drift.
	echo "✓ alibaba cleanup verified complete for run ${ENV} — no billable resources remain$(probe_clean_suffix)"
	return 0
}

# ── sweep_env <env> — the full scope-locked sweep + verify for ONE run's ENV. Sets the
#    ENV/PROJECT_ID_TAG/CLUSTER_* globals the sweep functions read, then runs them in the same
#    strict dependency order as the normal path. Returns verify_swept's status (0 clean / 1 leak);
#    DRY_RUN lists only and returns 0. Used by PREFLIGHT to sweep each discovered prior-run orphan. ──
sweep_env() {
	ENV="$1"
	PROJECT_ID_TAG="e2e-${ENV}"
	CLUSTER_NAME=""
	CLUSTER_ID=""
	assert_scope
	discover_cluster
	sweep_load_balancers
	sweep_cluster
	sweep_instances
	sweep_disks
	sweep_network
	[ "$DRY_RUN" = "1" ] && return 0
	verify_swept
}

# ── list_orphan_envs — every OTHER e2e run's ENV that still has an ACK cluster tagged/named in
#    this region (prior-run orphans). Alibaba has no cheap account-wide tag-VALUE enumerator like
#    AWS's get-tag-values, so we enumerate the ACK cluster inventory (the run's most expensive +
#    always-present resource) and read each cluster's project-id tag (or, if untagged, its
#    `-<env>`-embedded name). Keeps only `e2e-`-prefixed handles, EXCLUDES this run (SELF_ENV), and
#    re-validates each against the SAME specificity + prod/shared denylist guards as the top-of-file
#    ENV guards — so a preflight can never widen past a genuine prior nightly. Same-cloud nightly
#    runs are SERIALIZED (the e2e-nightly concurrency group), so any other e2e-* handle is a
#    prior-run orphan, never a concurrent sibling. Empty output ⇒ nothing to sweep. ──
list_orphan_envs() {
	local rows v oenv
	rows="$(all_clusters | jq -c "select(.region == \"$REGION\")" 2>/dev/null || true)"
	{
		# From the project-id tag…
		printf '%s\n' "$rows" | jq -r '.pid // empty' 2>/dev/null || true
		# …and from any cluster NAME that embeds an e2e handle (untagged / mid-destroy clusters).
		printf '%s\n' "$rows" | jq -r '.name // empty' 2>/dev/null |
			grep -oE 'e2e-[a-z0-9][a-z0-9._-]{4,62}' 2>/dev/null || true
	} | while IFS= read -r v; do
		[ -n "$v" ] || continue
		case "$v" in e2e-*) ;; *) continue ;; esac
		oenv="${v#e2e-}"
		[ "$oenv" = "$SELF_ENV" ] && continue
		printf '%s' "$oenv" | grep -Eq '^[a-z0-9][a-z0-9._-]{4,62}$' || continue
		case "$oenv" in
		prod | prod-* | production | production-* | staging | staging-* | main | alethia | alethia-* | data) continue ;;
		esac
		printf '%s\n' "$oenv"
	done | sort -u
}

# ── PREFLIGHT: sweep prior-run e2e orphans (NOT this run), best-effort + loud. ──
SELF_ENV="$ENV"
if [ "$PREFLIGHT" = "1" ]; then
	echo "→ alibaba STALE PREFLIGHT in ${REGION}: sweeping prior-run e2e orphans (excludes this run ${SELF_ENV})"
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
		probe_report_discovery alibaba "the preflight orphan scan in ${REGION}"
		echo "✓ preflight: no prior-run e2e orphans in ${REGION} — nothing to sweep"
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
		echo "::error::sweep by hand, scope-locked: ALETHIA_E2E_ENV=<env> ALETHIA_E2E_REGION=${REGION} ./scripts/e2e/alibaba-cleanup.sh"
		residual=1
	fi
	if [ "$residual" = "1" ]; then
		echo "⚠ preflight finished with residual orphans (see warnings above) — continuing (best-effort, non-fatal)"
	else
		# ⚠️ Not "the account is clean" — "every orphan this preflight could SEE is swept". The
		# cluster inventory can fail too, and preflight is explicitly non-blocking, so the honest
		# report here is a warning; the always() teardown is what gates.
		probe_report_discovery alibaba "the preflight orphan scan in ${REGION}"
		echo "✓ preflight complete — all prior-run e2e orphans in ${REGION} swept"
	fi
	exit 0 # preflight never blocks the provisioning run
fi

# ── Self-test. `ali` is stubbed, so this touches no account and needs no credentials (jq is real —
# the two-stage parse is half of what is under test). What is under test is the THREE-STATE
# contract: an empty account and an account this script could not look at must not produce the same
# answer, and the second must not exit 0.
#
# $ST_OUT and $ST_RC are varied INDEPENDENTLY on purpose. Every lister in this file used to read
# `ali … 2>/dev/null | jq … 2>/dev/null | grep -v '^$' || true`, and the OUTPUT half of that always
# worked — a test that varies only the output passes just as happily with the fix removed. ──
if [ "$SELF_TEST" = "1" ]; then
	st_fails=0
	# Two response slots, because the Container Registry lister reads a DIFFERENT document shape
	# (`.Instances[]` — a flat array) from the ECS/VPC listers (`.Instances.Instance[]`). A single
	# blanket body would fail one filter or the other for a reason that has nothing to do with what
	# is under test, and a self-test that goes red for the wrong reason teaches people to skip it.
	ali() {
		case "$*" in
		*ListInstance*) printf '%s\n' "$ST_CR" ;;
		*) if [ -n "$ST_OUT" ]; then printf '%s\n' "$ST_OUT"; fi ;;
		esac
		if [ "$ST_RC" -ne 0 ]; then printf '%s\n' "${ST_ERR:-ERROR: SDK.ServerError}" >&2; fi
		return "$ST_RC"
	}

	echo "→ alibaba-cleanup.sh self-test (ENV=${ENV})"
	st_case() { # <name> <output> <rc> <expected finalize rc> <expect unverifiable: yes|no> [cr body]
		probe_reset
		ST_OUT="$2" ST_RC="$3" ST_CR="${6:-{\"Instances\":[]\}}"
		ST_ERR="ERROR: SDK.InvalidCredential specified access key is not found"
		CLUSTER_ID="" CLUSTER_NAME=""
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
	st_case "an empty account, honestly listed, is CLEAN and exits 0" '{}' 0 0 no
	st_case "a surviving ECS instance is a LEAK and exits 1" \
		'{"Instances":{"Instance":[{"InstanceId":"i-gw8abc"}]}}' 0 1 no
	# THE REGRESSION. Before this change the case below and the first case were byte-identical:
	# empty stdout, exit 0, "no billable resources remain".
	st_case "a call that FAILED is UNVERIFIABLE and exits 4, NOT 0" "" 1 4 yes

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
	ST_OUT='{}' ST_RC=0 ST_CR='{"Instances":[]}' ST_ERR=""
	CLUSTER_ID="" CLUSTER_NAME=""
	probe_note_unattributable imager-upload-helpers "unlabelled — cannot be tied to this run"
	st_parity "an UNATTRIBUTABLE finding is reported loudly and does NOT gate" 0 yes no yes
	probe_reset
	ST_OUT="" ST_RC=1 ST_CR="" ST_ERR="ERROR: SDK.InvalidCredential specified access key is not found"
	CLUSTER_ID="" CLUSTER_NAME=""
	probe_note_unattributable imager-upload-helpers "unlabelled — cannot be tied to this run"
	st_parity "…and it never masks an API failure, which still exits 4" 4 no yes yes
	# THE JQ HALF, which no other cloud in this repo has. jq exits 0 on empty input and its own
	# parse failure was swallowed by `2>/dev/null || true`, so an HTML error page or a truncated
	# body — an exit-0 response that is not JSON — produced an empty id list and a clean teardown.
	st_case "a 200 that is NOT JSON is UNVERIFIABLE, not an empty account" \
		'<html><body>502 Bad Gateway</body></html>' 0 4 yes '<html>502</html>' 

	# The type NAMES the report, so a human knows what to check by hand — and for the CR EE
	# subscription the instruction is different ("unsubscribe in the console"), so it must not be
	# folded into a generic line.
	probe_reset
	ST_OUT="" ST_RC=1 ST_ERR="Forbidden.RAM"
	alive_cr_instances >/dev/null 2>&1 || true
	case "$(probe_unverifiable_types)" in
	*cr-ee-instance-subscription*) echo "  ✓ an unverifiable SUBSCRIPTION is named as one" ;;
	*)
		echo "  ✗ an unverifiable SUBSCRIPTION is named as one — got '$(probe_unverifiable_types)'" >&2
		st_fails=$((st_fails + 1))
		;;
	esac
	unset -f ali

	if [ "$st_fails" -ne 0 ]; then
		echo "✗ alibaba-cleanup.sh self-test: ${st_fails} failure(s)" >&2
		exit 1
	fi
	echo "✓ alibaba-cleanup.sh self-test passed"
	exit 0
fi

# ── Orchestrate, in strict dependency order. ──
discover_cluster
sweep_load_balancers
sweep_cluster
sweep_instances
sweep_disks
sweep_network

if [ "$DRY_RUN" = "1" ]; then
	echo "✓ alibaba DRY RUN complete for ${TAGK}=${PROJECT_ID_TAG} (nothing deleted, nothing verified)"
	exit 0
fi

echo "→ verifying nothing billable for run ${ENV} survived…"
st_rc=0
finalize_verification || st_rc=$?
exit "$st_rc"
