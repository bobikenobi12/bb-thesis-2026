#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# azure-cleanup.sh — belt-and-suspenders teardown for the T2 real-cloud nightly (Azure/AKS).
#
# Cloned guard-for-guard from scripts/e2e/aws-cleanup.sh (BYOC A1.3) + scripts/e2e/hcloud-cleanup.sh.
# The T2 harness tears the cluster down GRACEFULLY in-process via `tofu destroy`
# (provisioner.RunDestroy) on the normal path. But if the test PROCESS is hard-killed (a `go test
# -timeout` panic, a CI step SIGKILL, a runner crash), t.Cleanup never runs and REAL, billable Azure
# resources leak — most dangerously the OUT-OF-BAND ones tofu never tracked: everything AKS
# auto-creates in its NODE resource group (the VMSS node agent pools, their managed disks, the
# standard Load Balancer + its public IPs, NSGs). This script is the guarantee: the nightly runs it
# in an `always()` step so the run's resources are gone no matter how the test ended.
#
# ─────────────────────────────  S A F E T Y  ─────────────────────────────
# The Azure subscription is the SHARED platform subscription. An unfiltered delete would be
# catastrophic (cf. the shared-hcloud near-wipe; scope-destructive-cloud-ops memory). So:
#
#   * Azure PIVOTS ON THE RESOURCE GROUP. The project template (infra/templates/project/azure) puts
#     the whole environment in ONE resource group `rg-<project>-<env>` that carries our unique per-run
#     handle tag `alethia:project-id=e2e-<ENV>` (azureTagStyle, colon-namespaced). AKS then
#     auto-creates a SECOND, node resource group `MC_<rg>_<aks>_<location>` holding every out-of-band
#     Kubernetes resource (VMSS/disks/LB/public-IPs/NSGs). Deleting a resource group cascades to
#     everything inside it, so a scoped RG delete is the whole teardown.
#   * DISCOVERY is tag-driven + env-embedded. The MAIN RG is found by the EXACT handle tag
#     (`az group list --tag alethia:project-id=e2e-<ENV>`, an exact match — no wildcard); the NODE RG
#     is found from `az aks show ... --query nodeResourceGroup` and (fallback, for a mid-destroy kill
#     where the parent AKS is already gone) by the `MC_` name prefix that embeds our unique `-<ENV>`.
#   * BEFORE deleting ANY resource group, assert_rg_in_scope requires it to EITHER carry the handle
#     tag OR embed `-<ENV>` in its name. The node RG has no handle tag (AKS-managed), so it clears via
#     the env-embed; the main RG clears via the tag. This is the defense that an ENV typo can't widen
#     the blast radius — a group that neither is tagged nor embeds this run's unique ENV is SKIPPED.
#   * Refuses to run without a specific, plausibly-unique ENV + an explicit region; rejects
#     shared/prod values; asserts a non-empty scope before every mutating call; and — the last line of
#     defence — a leak NEVER exits green: verify_swept re-lists the tagged RGs, the env-embedded node
#     RGs, and any surviving AKS/VMSS/public-IP embedding this run's ENV, and FAILS the step on any
#     billable survivor, so a stuck delete can't false-GREEN.
#
# Usage:
#   ALETHIA_E2E_ENV=<run_id>-<attempt> ALETHIA_E2E_REGION=germanywestcentral ./scripts/e2e/azure-cleanup.sh
#   (positional $1 accepted for call-site symmetry with the other sweepers but IGNORED.)
#   DRY_RUN=1 ...     # list what WOULD be deleted, delete + verify nothing
#   PREFLIGHT=1 ...   # BEFORE provisioning: sweep PRIOR-run e2e orphans (any other e2e-<env>),
#                     #   NOT this run. Best-effort + loud (warns on residual, never exit 1).
#
# ── PREFLIGHT (stale-cluster preflight) ─────────────────────────────────────────────────────
# A prior nightly hard-killed before BOTH its graceful destroy AND its always() sweep leaks billable
# resources that keep costing until the NEXT run notices. PREFLIGHT=1 runs before provisioning and
# sweeps those orphans. It discovers every OTHER e2e run's handle by reading the `alethia:project-id`
# tag value off every resource group in the subscription, keeps only `e2e-`-prefixed values, EXCLUDES
# this run, re-validates each against the same specificity + prod/shared denylist guards, and runs the
# identical scope-locked sweep+verify per orphan. It is safe to sweep another e2e-* handle because
# same-cloud nightly runs are SERIALIZED (the workflow concurrency group) — so any other e2e-* value is
# a prior-run orphan, never a concurrent sibling. Posture is best-effort: a residual orphan emits
# `::warning::` but does NOT fail (a flaky API call must not red an otherwise-healthy provisioning
# night; the per-run always() teardown stays the fail-closed guarantee for THIS run).
#
# Requires: the Azure CLI `az` (authenticated — OIDC `azure/login` in CI).
set -euo pipefail

# ── The probe contract (CLEAN / LEAKED / UNVERIFIABLE / UNATTRIBUTABLE), shared by all five cloud
#    sweepers. Read scripts/e2e/lib/sweep-probe.sh before touching any list below: `az … -o tsv
#    2>/dev/null | grep … || true` launders the CLI's exit status three times over, so an expired
#    login, a throttle or a wrong subscription answered every list with "nothing" and exit 0 —
#    which verify_swept reads as an empty subscription.
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

# ── `--self-test` exercises the three-state probe contract against a stubbed `az` and exits. It
# sets its own ENV/REGION so the guards below are left exactly as they protect the real path. ──
SELF_TEST=0
if [ "${1:-}" = "--self-test" ]; then
	SELF_TEST=1
	ALETHIA_E2E_ENV="selftest-4177-1"
	ALETHIA_E2E_REGION="swedencentral"
	# The probe retries are a real-cloud kindness (a transient 5xx must not red a healthy teardown)
	# and pure dead time against a stub. The retry LOOP is still exercised; it just does not wait.
	PROBE_RETRY_DELAY=0
fi

ENV="${ALETHIA_E2E_ENV:-}"
# Region is AUTHORITATIVE from ALETHIA_E2E_REGION only — no silent ambient fallback. Azure resource
# groups are subscription-global, so region does not scope discovery, but requiring it keeps the
# contract identical to the AWS sweeper and documents the run's location in the log.
REGION="${ALETHIA_E2E_REGION:-}"
DRY_RUN="${DRY_RUN:-0}"
PREFLIGHT="${PREFLIGHT:-0}"
DELETE_RETRIES="${DELETE_RETRIES:-5}"
# `az group delete --no-wait` returns immediately; an RG lingers in "Deleting" for minutes (an AKS
# teardown is ~10-15m). We fire all deletes async, then WAIT (bounded) for them to complete so
# verify_swept confirms a real teardown rather than false-REDing an in-flight delete.
DELETE_WAIT_TIMEOUT="${DELETE_WAIT_TIMEOUT:-1500}" # seconds to wait for RG deletes to complete
# ── PREFLIGHT budget (#2257, ported from aws-cleanup.sh by #2330). The preflight's "never blocks
# the caller" promise is carried by `exit 0` at the end of its loop — which is only reached if the
# loop ENDS. Unbounded, it cannot promise that: on run 31459117502 the AWS equivalent consumed 86
# of a 90-minute job cap, the job hit its cap, GitHub marked it CANCELLED, and the always()
# teardown died mid-step leaving ~$105/mo standing.
#
# Azure is the WORST case of the four, which is why the default budget here is larger than the
# aws 900s but the env cap is smaller: sweep_env waits on wait_rgs_gone TWICE, each bounded by
# DELETE_WAIT_TIMEOUT (1500s), so a single stubborn orphan can legitimately burn ~50 minutes. Two
# such orphans exceed e2e-orphan-reaper.yml's 75-minute job cap on their own — and that cap being
# hit is the same cancel-mid-sweep failure this issue exists to fix. Until this port the reaper
# passed both bounds and azure silently ignored them.
PREFLIGHT_BUDGET_SECONDS="${PREFLIGHT_BUDGET_SECONDS:-1800}" # wall-clock for the whole sweep loop
PREFLIGHT_MAX_ENVS="${PREFLIGHT_MAX_ENVS:-2}"                # orphans attempted per run

# ── Guard 1: a specific ENV is REQUIRED. No ENV ⇒ no filter ⇒ hard refuse. ──
if [ -z "$ENV" ]; then
	echo "✗ REFUSING TO RUN: ALETHIA_E2E_ENV is unset." >&2
	echo "  This script only ever deletes resource groups tagged alethia:project-id=e2e-<ENV> or whose" >&2
	echo "  name embeds -<ENV> — never subscription-wide. Set ALETHIA_E2E_ENV to the unique per-run" >&2
	echo "  value (<run_id>-<attempt>)." >&2
	exit 2
fi

# ── Guard 2: ENV must be specific enough to be a single run, not a broad/shared prefix. ──
if ! printf '%s' "$ENV" | grep -Eq '^[a-z0-9][a-z0-9._-]{4,62}$'; then
	echo "✗ REFUSING TO RUN: ENV '$ENV' is not a valid, specific handle ([a-z0-9][a-z0-9._-]{4,62})." >&2
	echo "  Refusing so a typo can't widen the tag/name filter." >&2
	exit 2
fi
case "$ENV" in
prod | prod-* | production | production-* | staging | staging-* | main | alethia | alethia-* | data)
	echo "✗ REFUSING TO RUN: ENV '$ENV' looks like shared/prod infra, not a nightly run." >&2
	exit 2
	;;
esac

# ── Guard 3: an explicit region is REQUIRED (no silent ambient fallback — parity with AWS). ──
if [ -z "$REGION" ]; then
	echo "✗ REFUSING TO RUN: ALETHIA_E2E_REGION is unset." >&2
	echo "  Required for parity + run provenance; set it to the run's Azure location." >&2
	exit 2
fi

# The self-test shadows `az` with a shell function, so it needs no binary — and the CI runner that
# runs it has none. Requiring it here would make the hermetic test unrunnable where it is meant to run.
if [ "$SELF_TEST" != "1" ] && ! command -v az >/dev/null 2>&1; then
	echo "✗ the 'az' CLI is not installed." >&2
	echo "  Install it: https://learn.microsoft.com/cli/azure/install-azure-cli" >&2
	exit 2
fi

TAG_KEY="alethia:project-id"
PROJECT_ID_TAG="e2e-${ENV}"

export AZURE_CORE_ONLY_SHOW_ERRORS="${AZURE_CORE_ONLY_SHOW_ERRORS:-true}"

# The per-run banner is for the normal (belt-and-suspenders) path; PREFLIGHT prints its own below.
if [ "$PREFLIGHT" != "1" ] && [ "$SELF_TEST" != "1" ]; then
	echo "→ azure belt-and-suspenders cleanup in ${REGION}, scope ${TAG_KEY}=${PROJECT_ID_TAG}"
	[ "$DRY_RUN" = "1" ] && echo "  (DRY_RUN=1 — listing only, deleting nothing)"
fi

# assert_scope — a STRING check on the tag handle, and nothing more. It makes no cloud call, so it
# cannot tell a working login from an expired one; it exists only so an empty scope can never reach
# a mutating call. What catches a credential that cannot see the subscription is az_list: every
# list below records UNVERIFIABLE when the API does not answer, and finalize_verification gates.
assert_scope() {
	if [ -z "${PROJECT_ID_TAG#e2e-}" ]; then
		echo "✗ INTERNAL: empty scope — aborting before an unfiltered operation." >&2
		exit 3
	fi
}

# az_list <type> <az args…> — every scoped LIST in this file goes through here. It captures az's
# REAL exit status before anything filters it, and records <type> as UNVERIFIABLE when the call did
# not answer. The callers still pipe the output through their own `grep -i -- "-${ENV}"` scoping;
# what changed is that the filtering is now DOWNSTREAM of the exit-status decision.
az_list() {
	local ptype="$1"
	shift
	probe_run "$ptype" az "$@" || true
}

# looks_gone <stderr-text> — true if an az delete/show error means the resource group is already
# absent (idempotency: a NotFound on delete is success, not failure).
looks_gone() {
	printf '%s' "$1" | grep -Eqi 'could not be found|does not exist|ResourceGroupNotFound|was not found|NotFound'
}

# rg_has_handle_tag <rg> — true iff the resource group carries our EXACT project-id handle tag.
rg_has_handle_tag() {
	local rg="$1" val
	val="$(probe_confirm resource-group az group show --name "$rg" --query "tags.\"${TAG_KEY}\"" -o tsv || true)"
	[ "$val" = "$PROJECT_ID_TAG" ]
}

# assert_rg_in_scope <rg> — FAIL-CLOSED scope gate run before every RG delete. A group is in scope
# ONLY if it carries the handle tag OR its name embeds this run's unique -<ENV>. Returns non-zero
# (caller SKIPS the delete) for anything else — the defense that an ENV typo can't widen scope.
assert_rg_in_scope() {
	assert_scope
	local rg="$1"
	[ -n "$rg" ] || return 1
	if rg_has_handle_tag "$rg"; then
		return 0
	fi
	case "$rg" in
	*"-${ENV}"* | *"-${ENV}_"*) return 0 ;;
	esac
	return 1
}

# retry_delete_rg <rg> — scope-gated, NotFound-tolerant async RG delete. NEVER returns non-zero (so
# `set -e` can't abort the sweep BEFORE verify_swept, the real gate); an unresolved failure logs a
# WARN and lets verify catch it authoritatively. A group that fails the scope gate is LOUDLY skipped.
retry_delete_rg() {
	assert_scope
	local rg="$1"
	[ -n "$rg" ] || return 0
	if ! assert_rg_in_scope "$rg"; then
		echo "      ✗ SKIP ${rg}: neither carries ${TAG_KEY}=${PROJECT_ID_TAG} nor embeds -${ENV} — refusing to delete out-of-scope group" >&2
		return 0
	fi
	if [ "$DRY_RUN" = "1" ]; then
		echo "      would delete resource-group ${rg}"
		return 0
	fi
	local attempt=1 delay=3 err
	while [ "$attempt" -le "$DELETE_RETRIES" ]; do
		if err="$(az group delete --name "$rg" --yes --no-wait 2>&1)"; then
			echo "      deleting resource-group ${rg} (async)"
			return 0
		fi
		if looks_gone "$err"; then
			echo "      resource-group ${rg} already gone"
			return 0
		fi
		echo "      retry ${attempt}/${DELETE_RETRIES}: ${rg} not deletable yet (waiting ${delay}s)" >&2
		sleep "$delay"
		attempt=$((attempt + 1))
		delay=$((delay * 2))
	done
	echo "      WARN: could not start delete of ${rg} after ${DELETE_RETRIES} attempts (verify_swept will gate)" >&2
	return 0
}

# rg_exists <rg> — true iff the resource group still exists (any provisioning state).
rg_exists() {
	[ "$(az_list resource-group group exists --name "$1")" = "true" ]
}

# wait_rgs_gone <rg...> — bounded poll until every named resource group is gone. Async deletes were
# fired by retry_delete_rg; here we confirm they COMPLETE so verify_swept judges the end state, not an
# in-flight delete. Times out loudly (verify_swept then fails on any survivor).
wait_rgs_gone() {
	[ "$DRY_RUN" = "1" ] && return 0
	[ "$#" -eq 0 ] && return 0
	local waited=0 rg live
	while [ "$waited" -lt "$DELETE_WAIT_TIMEOUT" ]; do
		live=0
		for rg in "$@"; do
			[ -n "$rg" ] || continue
			rg_exists "$rg" && live=$((live + 1))
		done
		[ "$live" -eq 0 ] && {
			[ "$waited" -gt 0 ] && echo "  · all target resource groups deleted after ${waited}s"
			return 0
		}
		echo "  · waiting for ${live} resource group(s) to finish deleting… (${waited}s/${DELETE_WAIT_TIMEOUT}s)"
		sleep 20
		waited=$((waited + 20))
	done
	echo "  WARN: resource group(s) still deleting after ${DELETE_WAIT_TIMEOUT}s — verify_swept will gate" >&2
}

# ── Discovery ────────────────────────────────────────────────────────────────
# main_rgs — the environment's primary resource group(s): tag-discovered (authoritative) UNION any
# `rg-`-prefixed group whose name embeds -<ENV> (belt-and-suspenders if the tag failed to apply). Both
# are re-gated by assert_rg_in_scope at delete time.
main_rgs() {
	assert_scope
	{
		az_list resource-group group list --tag "${TAG_KEY}=${PROJECT_ID_TAG}" --query "[].name" -o tsv
		az_list resource-group group list --query "[?starts_with(name,'rg-')].name" -o tsv | grep -i -- "-${ENV}" || true
	} | grep -v '^$' | sort -u || true
}

# node_rgs_of <main-rg> — the AKS-managed node resource group(s) for the AKS cluster(s) in <main-rg>.
# These normally cascade when the main RG is deleted; recorded so verify can confirm and so an orphan
# (parent gone mid-destroy) can be swept directly.
node_rgs_of() {
	local rg="$1"
	[ -n "$rg" ] || return 0
	az_list aks-node-rg aks list --resource-group "$rg" --query "[].nodeResourceGroup" -o tsv | grep -v '^$' || true
}

# orphan_node_rgs — `MC_`-prefixed node resource groups whose name embeds -<ENV> (an AKS node RG left
# behind after its parent AKS/main-RG was torn down). Now parent-less, so directly deletable.
orphan_node_rgs() {
	assert_scope
	az_list aks-node-rg group list --query "[?starts_with(name,'MC_')].name" -o tsv | grep -i -- "-${ENV}" | grep -v '^$' | sort -u || true
}

# ── Soft-deleted Key Vaults ─────────────────────────────────────────────────────────────────────
#
# Deleting the resource group does NOT remove this environment's Key Vault — it SOFT-deletes it.
# The vault then survives the "successful" teardown as a proxy resource that nothing here purged and
# nothing here verified: not a leak in the billing sense (Microsoft: an object in the deleted state
# supports only purge/recover, "so no bill"), but a real survivor holding a real name.
#
# It is a NOTICE rather than a leak, and the distinction is deliberate:
#   * It costs nothing, so failing the nightly on it would red healthy runs over zero euros.
#   * The name it holds is per-RUN unique — the vault name derives from `<project_name>-<environment>`
#     and `environment` is this run's ENV — so it cannot block the next nightly. It CAN block a
#     customer rebuilding the same project + environment, which is a template problem
#     (infra/templates/project/azure/modules/key-vault/main.tf), not a sweeper one.
#   * And when purge protection is on it CANNOT be purged at all, by design. Reporting an
#     unfixable condition as a failure trains people to ignore the output.
# What it must not be is invisible, which is what it was.
#
# Scope: name-matched on this run's ENV, the same handle every other lookup here uses, and the
# purge is re-gated on that match immediately before it is issued.
deleted_key_vaults() {
	assert_scope
	az_list soft-deleted-key-vault keyvault list-deleted --query "[].name" -o tsv | grep -i -- "-${ENV}" | grep -v '^$' | sort -u || true
}

# sweep_deleted_key_vaults — purge what CAN be purged. A vault created with purge protection on
# refuses this until its retention window expires; that failure is expected, and is reported rather
# than retried.
sweep_deleted_key_vaults() {
	assert_scope
	local vaults v
	vaults="$(deleted_key_vaults)"
	if [ -z "$vaults" ]; then
		echo "  · soft-deleted key vaults: none"
		return 0
	fi
	echo "  · soft-deleted key vaults: $(printf '%s' "$vaults" | grep -c .) to purge"
	while IFS= read -r v; do
		[ -n "$v" ] || continue
		# Never purge a vault whose name does not carry this run's ENV.
		printf '%s' "$v" | grep -qi -- "-${ENV}" || continue
		if [ "$DRY_RUN" = "1" ]; then
			echo "      would purge key vault ${v}"
			continue
		fi
		if az keyvault purge --name "$v" --no-wait >/dev/null 2>&1; then
			echo "      purged key vault ${v}"
		else
			echo "      key vault ${v} cannot be purged (purge protection holds it for the retention window) — it costs nothing and ages out"
		fi
	done <<<"$vaults"
}

# ── Final verification: a leak must NEVER exit green. Re-list the tagged main RGs, the env-embedded
#    node RGs, and any surviving AKS/VMSS/public-IP embedding this run's ENV. grep -i so an Azure
#    case-normalized RG name can't hide a survivor. ──
alive_tagged_rgs() {
	az_list resource-group group list --tag "${TAG_KEY}=${PROJECT_ID_TAG}" --query "[].name" -o tsv | grep -v '^$' || true
}
alive_env_rgs() {
	az_list resource-group group list --query "[].name" -o tsv | grep -i -- "-${ENV}" | grep -v '^$' | sort -u || true
}
alive_aks() {
	az_list aks-cluster aks list --query "[].name" -o tsv | grep -i -- "-${ENV}" | grep -v '^$' || true
}
alive_vmss() {
	az_list vmss vmss list --query "[].resourceGroup" -o tsv | grep -i -- "-${ENV}" | grep -v '^$' || true
}
alive_public_ips() {
	az_list public-ip network public-ip list --query "[].resourceGroup" -o tsv | grep -i -- "-${ENV}" | grep -v '^$' || true
}

verify_swept() {
	assert_scope
	local leaks="" x
	join() { printf '%s' "$1" | tr '\n' ' '; }
	x="$(alive_tagged_rgs)"; [ -n "$x" ] && leaks="${leaks}resource-group(tagged): $(join "$x")\n"
	x="$(alive_env_rgs)"; [ -n "$x" ] && leaks="${leaks}resource-group(env-embedded): $(join "$x")\n"
	x="$(alive_aks)"; [ -n "$x" ] && leaks="${leaks}aks-cluster: $(join "$x")\n"
	x="$(alive_vmss)"; [ -n "$x" ] && leaks="${leaks}vmss(in rg): $(join "$x")\n"
	x="$(alive_public_ips)"; [ -n "$x" ] && leaks="${leaks}public-ip(in rg): $(join "$x")\n"
	if [ -n "$leaks" ]; then
		echo "  ✗ billable resources still alive:" >&2
		printf '%b' "  $leaks" >&2
		echo "::error::azure cleanup INCOMPLETE — billable resources for run ${ENV} still exist and are BILLING. Investigate + remove (stay scope-locked; never subscription-wide)." >&2
		return 1
	fi
	# Non-billable survivor: a soft-deleted Key Vault the RG delete left behind and purge protection
	# will not let go of. Free, and its name is per-run unique so it blocks nothing here — but it is
	# a survivor, and a teardown that never mentions it is claiming more than it checked.
	x="$(deleted_key_vaults)"
	[ -n "$x" ] && echo "::notice::azure cleanup: key vault(s) remain SOFT-DELETED for run ${ENV} (free; purge protection holds the name until the 7-day retention window expires): $(join "$x")"
	return 0
}

# ── sweep_env <env> — the full scope-locked sweep + verify for ONE run's ENV. Sets the
#    ENV/PROJECT_ID_TAG globals the discovery/verify functions read, then runs them in dependency
#    order: delete the MAIN RGs (this cascades AKS → its node RG + the DB/redis/etc), wait, then sweep
#    any ORPHAN node RG a mid-destroy kill left parent-less, wait, verify. Returns verify_swept's
#    status (0 clean / 1 leak); DRY_RUN lists only and returns 0. Used by PREFLIGHT per orphan too. ──
sweep_env() {
	ENV="$1"
	PROJECT_ID_TAG="e2e-${ENV}"
	assert_scope

	local mains rg nodes deleted=()
	mains="$(main_rgs)"
	if [ -n "$mains" ]; then
		echo "  · main resource groups: $(printf '%s' "$mains" | grep -c .) to delete"
		while IFS= read -r rg; do
			[ -n "$rg" ] || continue
			nodes="$(node_rgs_of "$rg")"
			[ -n "$nodes" ] && echo "      · ${rg} → node RG(s): $(printf '%s' "$nodes" | tr '\n' ' ')(cascade)"
			retry_delete_rg "$rg"
			deleted+=("$rg")
		done <<<"$mains"
	else
		echo "  · main resource groups: none"
	fi
	wait_rgs_gone "${deleted[@]}"

	# Orphan node RGs (parent AKS/main-RG already gone) — now directly deletable.
	local orphans orphan_deleted=()
	orphans="$(orphan_node_rgs)"
	if [ -n "$orphans" ]; then
		echo "  · orphan node resource groups (MC_… embedding -${ENV}): $(printf '%s' "$orphans" | grep -c .) to delete"
		while IFS= read -r rg; do
			[ -n "$rg" ] || continue
			retry_delete_rg "$rg"
			orphan_deleted+=("$rg")
		done <<<"$orphans"
		wait_rgs_gone "${orphan_deleted[@]}"
	else
		echo "  · orphan node resource groups: none"
	fi

	# After the RGs are gone: the vault they soft-deleted on the way out.
	sweep_deleted_key_vaults

	[ "$DRY_RUN" = "1" ] && return 0
	verify_swept
}

# ── finalize_verification — THE EXIT-CODE CONTRACT.
#
#   0  every probe answered, and nothing billable for this run survived.
#   1  a LEAK: the API listed something still standing and billing.
#   4  UNVERIFIABLE: at least one probe could not answer, so nothing here proves the subscription
#      is empty. This runs on the `always()` teardown path the T2 harness defers to as the
#      guarantee, so "could not look" has to red the step rather than pass as a log line.
#
# A confirmed leak outranks "could not check", so the sweep + verify runs first.
finalize_verification() {
	if ! sweep_env "$ENV"; then
		return 1
	fi
	probe_gate azure "run ${ENV}" || return 4
	# probe_clean_suffix is EMPTY on a genuinely clean run and carries any UNATTRIBUTABLE finding
	# otherwise, so this sentence can never read as "the account is empty" when it is not. Shared
	# by all five sweepers — the taxonomy is one contract, not five that drift.
	echo "✓ azure cleanup verified complete for run ${ENV} — no billable resources remain$(probe_clean_suffix)"
	return 0
}

# ── list_orphan_envs — every OTHER e2e run's ENV that still has a project-id-tagged resource group in
#    this subscription (prior-run orphans). Reads the `alethia:project-id` tag value off every RG,
#    keeps only `e2e-`-prefixed values, strips the prefix, EXCLUDES this run (SELF_ENV), and
#    re-validates each against the SAME specificity + prod/shared denylist guards as the top-of-file
#    ENV guards — so a preflight can never widen past a genuine prior nightly. Empty ⇒ nothing to sweep. ──
list_orphan_envs() {
	local vals v oenv
	vals="$(az_list orphan-scan group list --query "[?tags.\"${TAG_KEY}\"].tags.\"${TAG_KEY}\"" -o tsv | grep -v '^$' || true)"
	while IFS= read -r v; do
		[ -n "$v" ] || continue
		case "$v" in e2e-*) ;; *) continue ;; esac # e2e-prefixed values only — never a prod project-id
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
	echo "→ azure STALE PREFLIGHT in ${REGION}: sweeping prior-run e2e orphans (excludes this run ${SELF_ENV})"
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
		probe_report_discovery azure "the preflight orphan scan"
		echo "✓ preflight: no prior-run e2e orphans in this subscription — nothing to sweep"
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
		echo "::error::sweep by hand, scope-locked: ALETHIA_E2E_ENV=<env> ALETHIA_E2E_REGION=${REGION} ./scripts/e2e/azure-cleanup.sh"
		residual=1
	fi
	if [ "$residual" = "1" ]; then
		echo "⚠ preflight finished with residual orphans (see warnings above) — continuing (best-effort, non-fatal)"
	else
		# ⚠️ Not "the subscription is clean" — "every orphan this preflight could SEE is swept".
		# The discovery listing can fail too, and preflight is explicitly non-blocking, so the
		# honest report here is a warning; the always() teardown is what gates.
		probe_report_discovery azure "the preflight orphan scan"
		echo "✓ preflight complete — all prior-run e2e orphans in this subscription swept"
	fi
	exit 0 # preflight never blocks the provisioning run
fi

# ── Self-test. `az` is stubbed, so this touches no subscription and needs no login. What is under
# test is the THREE-STATE contract: an empty subscription and a subscription this script could not
# look at must not produce the same answer, and the second must not exit 0.
#
# $ST_OUT and $ST_RC are varied INDEPENDENTLY on purpose. Every list in this file used to read
# `az … -o tsv 2>/dev/null | grep … || true`, and the OUTPUT half of that always worked — a test
# that varies only the output passes just as happily with the fix removed. ──
if [ "$SELF_TEST" = "1" ]; then
	st_fails=0
	# DRY_RUN so the stubbed sweep deletes nothing and skips the RG wait loops; verify_swept is
	# called explicitly below, because that is the half under test.
	DRY_RUN=1
	az() {
		if [ -n "$ST_OUT" ]; then printf '%s\n' "$ST_OUT"; fi
		if [ "$ST_RC" -ne 0 ]; then printf '%s\n' "${ST_ERR:-ERROR: az failed}" >&2; fi
		return "$ST_RC"
	}

	echo "→ azure-cleanup.sh self-test (ENV=${ENV})"
	st_case() { # <name> <output> <rc> <expected rc> <expect unverifiable: yes|no>
		probe_reset
		ST_OUT="$2" ST_RC="$3" ST_ERR="ERROR: Please run 'az login' to setup account."
		local rc=0 unv=no
		if verify_swept >/dev/null 2>&1; then
			probe_gate azure "run ${ENV}" >/dev/null 2>&1 || rc=$?
		else
			rc=1
		fi
		probe_has_unverifiable && unv=yes
		if [ "$rc" = "$4" ] && [ "$unv" = "$5" ]; then
			echo "  ✓ $1"
		else
			echo "  ✗ $1 — expected rc=$4/unverifiable=$5, got rc=${rc}/unverifiable=${unv}" >&2
			st_fails=$((st_fails + 1))
		fi
	}
	st_case "an empty subscription, honestly listed, is CLEAN and exits 0" "" 0 0 no
	st_case "a surviving resource group is a LEAK and exits 1" "rg-${ENV}-alethia" 0 1 no
	# THE REGRESSION. Before this change the case below and the first case were byte-identical:
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
	probe_note_unattributable imager-upload-helpers "unlabelled — cannot be tied to this run"
	st_parity "an UNATTRIBUTABLE finding is reported loudly and does NOT gate" 0 yes no yes
	probe_reset
	ST_OUT="" ST_RC=1 ST_ERR="ERROR: Please run 'az login' to setup account."
	probe_note_unattributable imager-upload-helpers "unlabelled — cannot be tied to this run"
	st_parity "…and it never masks an API failure, which still exits 4" 4 no yes yes

	# The type NAMES the report, so a human knows what to check by hand.
	probe_reset
	ST_OUT="" ST_RC=1 ST_ERR="AuthorizationFailed"
	alive_aks >/dev/null 2>&1 || true
	case "$(probe_unverifiable_types)" in
	*aks-cluster*) echo "  ✓ the ledger names the resource type that could not be checked" ;;
	*)
		echo "  ✗ the ledger names the resource type that could not be checked — got '$(probe_unverifiable_types)'" >&2
		st_fails=$((st_fails + 1))
		;;
	esac
	unset -f az

	if [ "$st_fails" -ne 0 ]; then
		echo "✗ azure-cleanup.sh self-test: ${st_fails} failure(s)" >&2
		exit 1
	fi
	echo "✓ azure-cleanup.sh self-test passed"
	exit 0
fi

# ── Normal (belt-and-suspenders) path — the full scope-locked sweep + verify for THIS run. ──
if [ "$DRY_RUN" = "1" ]; then
	sweep_env "$ENV"
	echo "✓ azure DRY RUN complete for ${TAG_KEY}=${PROJECT_ID_TAG} (nothing deleted, nothing verified)"
	exit 0
fi

st_rc=0
finalize_verification || st_rc=$?
exit "$st_rc"
