#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# hcloud-cleanup.sh — belt-and-suspenders teardown for the T2 real-cloud nightly.
#
# The T2 harness (test/e2e/t2_provision_test.go) tears the cluster down GRACEFULLY
# in-process via `tofu destroy` (provisioner.RunDestroy). That covers the normal path.
# But if the test PROCESS is hard-killed (a `go test -timeout` panic, a CI step
# SIGKILL, a runner crash), t.Cleanup never runs and REAL, billable hcloud resources
# leak. This script is the guarantee: the nightly workflow runs it in an `always()`
# step so the run's resources are destroyed no matter how the test ended.
#
# ─────────────────────────────  S A F E T Y  ─────────────────────────────
# The hcloud account is SHARED with prod + other test clusters. An unfiltered delete
# once nearly wiped prod (see the scope-destructive-cloud-ops memory). So this script
# NEVER deletes account-wide: EVERY hcloud call is scoped to the label selector
# `cluster=<CLUSTER_NAME>` — the exact label the hetzner template stamps on every
# resource it creates (servers, network, firewall, primary IPs, images). The cluster
# name is unique per run (derived from the GitHub run id/attempt), so the filter can
# only ever match THIS run's resources. The script refuses to run without a specific,
# plausibly-unique cluster name, and asserts the selector is non-empty before every
# call.
#
# Three things the label selector alone cannot reach, each handled explicitly below rather than
# left silently absent — an unswept type that nobody mentions is indistinguishable from a swept one:
#
#   * hcloud_zone (dns.tf, #1816) DOES carry cluster=<name>; it was simply missing from the purge
#     and verify lists. Added — one line each, gated on the CLI actually supporting `hcloud zone`.
#   * The CCM's ingress load balancer carries NO cluster label and cannot be made to (see
#     sweep_unlabelled_lbs). It is bound to this run through its private-network attachment.
#   * Hetzner Object Storage is a different product on a different API. Swept over S3 when the
#     run's credentials are present, and reported as explicitly UNVERIFIED when they are not.
#
# Usage:
#   HCLOUD_TOKEN=... ./scripts/e2e/hcloud-cleanup.sh <cluster-name>
#   HCLOUD_TOKEN=... ALETHIA_E2E_CLUSTER_NAME=<cluster-name> ./scripts/e2e/hcloud-cleanup.sh
#   DRY_RUN=1 ...    # list what WOULD be deleted, delete nothing
#
# Exit codes (the verification contract — see finalize_verification):
#   0  every probe answered, and nothing labelled cluster=<name> survived
#   1  a LEAK: the API listed something still standing and billing
#   2  refused to run (missing/implausible cluster name, no token, missing CLI)
#   3  INTERNAL: empty selector reached a scoped call
#   4  UNVERIFIABLE: a type could not be looked at, so nothing here proves the account is empty
#
# UNATTRIBUTABLE is a FOURTH probe state with NO exit code of its own: the probe answered, and the answer
# is that something exists which by design carries nothing tying it to this run (the imager upload
# helpers — see report_imager_helpers). It is reported loudly and never gates, because a condition
# this script can never resolve would red every run forever. #3138 gated it and hetzner went
# permanently red; see scripts/e2e/lib/sweep-probe.sh's header for the boundary.
set -euo pipefail

# ── The probe contract (CLEAN / LEAKED / UNVERIFIABLE / UNATTRIBUTABLE), shared by all five sweepers.
#
# The exit code is gated on UNVERIFIABLE and NOT on UNATTRIBUTABLE. #2549 was diagnosed and fixed
# HERE, in this file, for exactly two probes — and never generalised: not to the other four clouds,
# and not even to list_ids twenty lines below, which every purge and the whole of verify_swept run
# through. scripts/e2e/lib/sweep-probe.sh is that fix, generalised, and it gates.
#
# #3138 then over-applied it: the imager upload helpers are not a failed probe, and gating on them
# made this leg red on every run. That is the fourth state, and the boundary between the two is in
# sweep-probe.sh's header — read it before adding a note to either ledger. ──
E2E_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib"
# shellcheck source-path=SCRIPTDIR source=lib/sweep-probe.sh
. "${E2E_LIB_DIR}/sweep-probe.sh"
probe_reset

SELF_TEST=0
if [ "${1:-}" = "--self-test" ]; then
	SELF_TEST=1
	set -- "selftest-cluster"
	# `hcloud` is stubbed below, so nothing authenticates and nothing is called. This exists only to
	# satisfy the token guard, and is deliberately not a plausible token.
	HCLOUD_TOKEN="self-test-no-hcloud-call-is-made"
	export HCLOUD_TOKEN
	# The probe retries are a real-cloud kindness (a transient 5xx must not red a healthy teardown)
	# and pure dead time against a stub. The retry LOOP is still exercised; it just does not wait.
	PROBE_RETRY_DELAY=0
fi
CLUSTER_NAME="${1:-${ALETHIA_E2E_CLUSTER_NAME:-}}"
DRY_RUN="${DRY_RUN:-0}"
# A volume cannot be deleted while attached, and `hcloud server delete` detaches asynchronously —
# so both a wait and per-item retries are required, else the sweep races the detach and leaks.
DETACH_TIMEOUT="${DETACH_TIMEOUT:-120}" # seconds to wait for volumes to detach after server delete
DELETE_RETRIES="${DELETE_RETRIES:-5}"   # per-resource delete attempts (exponential backoff)
# ── PREFLIGHT (#2330). Discovery mode: sweep PRIOR-run e2e orphans rather than this run. See the
# block above the purge sequence for what it discriminates on and why it is not the cluster name.
# Bounded like the other four sweepers (#2257): an unbounded best-effort sweep can consume its
# caller's job budget, which is how run 31459117502 was cancelled at its cap and leaked a stack.
PREFLIGHT="${PREFLIGHT:-0}"
# ── CAPTURE MODE (#3481). Writes THIS run's Load Balancer ids to a file while the private network
# still exists, so the teardown sweep has a run-scoped binding afterwards.
#
# The CCM-created ingress Load Balancer carries no hcloud label and cannot be made to; its only
# binding to this run is its private-network attachment. On the GRACEFUL path `tofu destroy` deletes
# that network FIRST, so by the time the sweep runs the binding is already gone and the fallback
# below asks a PROJECT-WIDE question instead — which means any other run's load balancer reds this
# leg. A failed teardown verifies cleanly and a successful one does not, which is exactly backwards.
#
# Capturing beforehand is the only durable binding the tree supports today: hetzner has no
# `elbv2.k8s.aws/cluster`-style secondary tag for the AWS sweeper to lean on.
CAPTURE_LBS=""
if [ "${1:-}" = "--capture-lbs" ]; then
	CAPTURE_LBS="${2:-}"
	[ -n "$CAPTURE_LBS" ] || { echo "--capture-lbs needs a file path" >&2; exit 2; }
	shift 2
	CLUSTER_NAME="${1:-${ALETHIA_E2E_CLUSTER_NAME:-}}"
fi
# The file the teardown sweep reads back. Set by the harness; absent is a normal state (a hard-kill
# never got to capture), and it falls through to the project-wide question below.
LB_CAPTURE_FILE="${ALETHIA_E2E_HCLOUD_LB_IDS:-}"
PREFLIGHT_BUDGET_SECONDS="${PREFLIGHT_BUDGET_SECONDS:-900}" # wall-clock for the whole sweep loop
PREFLIGHT_MAX_ENVS="${PREFLIGHT_MAX_ENVS:-3}"               # orphans attempted per run

# ── Guard 1: a specific cluster name is REQUIRED. No name ⇒ we would have no filter
#    ⇒ hard refuse (never fall through to an account-wide delete). ──
if [ -z "$CLUSTER_NAME" ]; then
	echo "✗ REFUSING TO RUN: no cluster name given." >&2
	echo "  Pass the unique per-run cluster name as \$1 or ALETHIA_E2E_CLUSTER_NAME." >&2
	echo "  This script only ever deletes resources labelled 'cluster=<name>' — never account-wide." >&2
	exit 2
fi

# ── Guard 2: the name must be specific enough to be a single run's cluster, not a
#    broad/shared prefix. Enforce the label-value grammar + a minimum length, and
#    reject a short list of dangerous bare names that could match shared infra. ──
if ! printf '%s' "$CLUSTER_NAME" | grep -Eq '^[a-z0-9][a-z0-9._-]{4,62}$'; then
	echo "✗ REFUSING TO RUN: cluster name '$CLUSTER_NAME' is not a valid, specific label value" >&2
	echo "  (need [a-z0-9][a-z0-9._-]{4,62}). Refusing so a typo can't become a broad delete." >&2
	exit 2
fi
case "$CLUSTER_NAME" in
prod | prod-* | production | production-* | staging | staging-* | alethia | alethia-data | main)
	echo "✗ REFUSING TO RUN: '$CLUSTER_NAME' looks like shared/prod infra, not a nightly run." >&2
	exit 2
	;;
esac

if [ -z "${HCLOUD_TOKEN:-}" ]; then
	echo "✗ HCLOUD_TOKEN is unset — nothing to authenticate with." >&2
	exit 2
fi

# The self-test shadows `hcloud` with a shell function, so it needs no binary — and CI runners do
# not have one (the nightly installs it only for the hetzner leg). Requiring it here would make the
# hermetic test unrunnable in the one place it is meant to run.
if [ "$SELF_TEST" != "1" ] && ! command -v hcloud >/dev/null 2>&1; then
	echo "✗ the 'hcloud' CLI is not installed." >&2
	echo "  Install it: https://github.com/hetznercloud/cli (e.g. 'brew install hcloud')." >&2
	exit 2
fi

# The single, non-empty selector every call is scoped by. Asserted before each use.
SELECTOR="cluster=${CLUSTER_NAME}"

# ── THE ONE THING THIS SCRIPT DELIBERATELY DOES NOT DELETE, NAMED (#3027). ──────────────────────
#
# infra/templates/project/hetzner/image.tf caches the Talos snapshot per
# (talos_version × architecture × location × extension set), because rebuilding a byte-identical
# one cost 5–15 minutes on the critical path of every apply and was the floor's dominant flake (it
# blew its tofu deadline twice — #2458 and run 33080748841 — on the resource that runs before any
# cluster exists, so losing it lost the whole run).
#
# A cache entry carries `alethia.io/cache=talos-image` and, deliberately, NO `cluster` label. That
# absence is the entire mechanism: this script's selector is `cluster=<name>`, so a cache entry is
# outside it BY CONSTRUCTION. Nothing here was weakened to allow that — the labelled purge below
# still deletes every image it ever deleted, including the per-cluster snapshot the template still
# builds under `talos_image_cache = "disabled"`.
#
# The constant exists anyway, and is REPORTED on every sweep, for two reasons:
#
#   1. An unswept type nobody mentions is indistinguishable from a swept one. This file's header
#      already makes that argument for the CCM load balancer and the imager upload helpers; the
#      cache is the third such type and the only one that is unswept ON PURPOSE.
#   2. It is the SKIP-LIST BY NAME that #3027 asks for. `scripts/check-hetzner-image-cache.mjs`
#      fails CI when this string, the template's label and hcloud-image-cache.sh's selector stop
#      being the same string — so the sweeper and the emitter cannot drift apart silently, which is
#      the failure mode where a "cached" image quietly starts being deleted every run again.
#
# Reclaiming cache entries is a separate, explicitly-flagged operation:
# `scripts/e2e/hcloud-image-cache.sh --prune-superseded --yes-delete`.
IMAGE_CACHE_LABEL_KEY="alethia.io/cache"
IMAGE_CACHE_LABEL_VALUE="talos-image"
IMAGE_CACHE_SELECTOR="${IMAGE_CACHE_LABEL_KEY}==${IMAGE_CACHE_LABEL_VALUE}"

# Hetzner Object Storage is a SEPARATE PRODUCT from the Hetzner Cloud API — S3 at
# <region>.your-objectstorage.com, its own access-key pair, no hcloud labels, invisible to the
# hcloud CLI. So it can only be swept with S3 credentials, and only reported honestly without them.
# Same env names the runner exports at claim (packages/core/cloud/hetzner_provider.go:217-222).
S3_ACCESS_KEY="${HETZNER_S3_ACCESS_KEY:-}"
S3_SECRET_KEY="${HETZNER_S3_SECRET_KEY:-}"
S3_REGION="${HETZNER_S3_REGION:-${ALETHIA_E2E_HCLOUD_REGION:-fsn1}}"
S3_ENDPOINT="${HETZNER_S3_ENDPOINT:-${S3_REGION}.your-objectstorage.com}"
# The sweep/verify below record — via probe_note_unverifiable / probe_run — every type that could
# not be LOOKED AT, as distinct from looked at and found clean. The two are not the same answer;
# the final banner must not conflate them, and since this change the exit code must not either.

# ⚠️ A CAPTURE PERFORMS NONE OF THE SWEEP'S SIDE EFFECTS. It used to fall through both the banner
# and the zone probe below: an extra `hcloud zone list` round-trip inside the teardown window, and,
# when that failed, a "DNS zones for <cluster> were NOT swept and NOT verified" warning emitted by
# an invocation that sweeps nothing — whose probe_note_unverifiable is then thrown away by its own
# `exit 0`. (The dispatch itself stays below, where capture_run_lbs and the helpers it calls are
# actually defined.)
[ -n "$CAPTURE_LBS" ] || [ "$SELF_TEST" = "1" ] || echo "→ hcloud belt-and-suspenders cleanup for label ${SELECTOR}"
[ -z "$CAPTURE_LBS" ] && [ "$DRY_RUN" = "1" ] && echo "  (DRY_RUN=1 — listing only, deleting nothing)"

# ── Does this hcloud CLI know about DNS zones? `hcloud zone` is recent (the template gained
#    hcloud_zone with #1816, provider 1.56+). An older CLI makes `hcloud zone list` fail, and
#    list_ids swallows that into an empty list — which reads exactly like "no zones", the
#    report-clean-without-looking failure this whole file exists to prevent. Probe once, loudly.
ZONE_SUPPORTED=0
if [ -n "$CAPTURE_LBS" ]; then
	: # a capture sweeps no zones, so probing for zone support would only cost a call and a warning
elif [ "$SELF_TEST" = "1" ]; then
	: # no CLI to probe under the self-test; the zone path is not what it exercises
elif hcloud zone list -o noheader >/dev/null 2>&1; then
	ZONE_SUPPORTED=1
else
	# Either the CLI predates `hcloud zone`, or the token cannot read zones. The probe cannot tell
	# them apart and does not need to: both mean this script could not look, which is reported —
	# never silently folded into "none".
	echo "::warning::'hcloud zone list' failed (CLI without DNS zone support, or a token that cannot read zones). DNS zones for ${SELECTOR} were NOT swept and NOT verified — check them by hand in the Hetzner Console."
	probe_note_unverifiable dns-zones "hcloud zone list unavailable"
fi

# assert_selector fails closed if the selector ever became empty (defensive — the
# guards above already ensure it can't, but never issue a label-less hcloud call).
assert_selector() {
	if [ -z "${SELECTOR#cluster=}" ]; then
		echo "✗ INTERNAL: empty selector — aborting before an unfiltered delete." >&2
		exit 3
	fi
}

# list_ids <resource> — ids of resources of <resource> carrying our label, one per line.
#
# THE GAP #2549 LEFT OPEN. This one line is what every purge and the whole of verify_swept read,
# and it laundered its status exactly like the load-balancer fallback that issue was filed against:
# `2>/dev/null … || true`, so an expired token or a 5xx returned an empty list and exit 0 — which
# verify_swept reads as "nothing survived". Every resource type at once. It goes through probe_run
# now, so a failed list is UNVERIFIABLE and gates.
list_ids() {
	assert_selector
	probe_run "$1" hcloud "$1" list --selector "$SELECTOR" -o noheader -o columns=id || true
}

# purge <resource> [human-label] — delete every labelled resource of <resource>, with retries.
# Idempotent: an empty list is a clean no-op. A delete can legitimately fail transiently — most
# importantly a volume that is still ATTACHED (the API refuses: "The Volume must not be attached
# to a Server") because the server's delete detaches ASYNCHRONOUSLY. So retry with backoff rather
# than logging a single WARN and moving on. Anything still standing at the end is caught by the
# final verification sweep, which FAILS the step (see verify_swept) — a leak must never exit green.
purge() {
	local resource="$1"
	local label="${2:-$1}"
	local ids
	ids="$(list_ids "$resource")"
	if [ -z "$ids" ]; then
		echo "  · ${label}: none"
		return 0
	fi
	local count
	count="$(printf '%s\n' "$ids" | grep -c . || true)"
	echo "  · ${label}: ${count} to delete"
	while IFS= read -r id; do
		[ -n "$id" ] || continue
		if [ "$DRY_RUN" = "1" ]; then
			echo "      would delete ${resource} ${id}"
			continue
		fi
		local attempt=1 delay=3 ok=0
		while [ "$attempt" -le "$DELETE_RETRIES" ]; do
			if hcloud "$resource" delete "$id" >/dev/null 2>&1; then
				echo "      deleted ${resource} ${id}"
				ok=1
				break
			fi
			# Already gone (a concurrent tofu destroy won the race) ⇒ success, not a failure.
			if ! hcloud "$resource" describe "$id" >/dev/null 2>&1; then
				echo "      ${resource} ${id} already gone"
				ok=1
				break
			fi
			echo "      retry ${attempt}/${DELETE_RETRIES}: ${resource} ${id} not deletable yet (waiting ${delay}s)" >&2
			sleep "$delay"
			attempt=$((attempt + 1))
			delay=$((delay * 2))
		done
		if [ "$ok" -ne 1 ]; then
			echo "      WARN: could not delete ${resource} ${id} after ${DELETE_RETRIES} attempts" >&2
		fi
	done <<EOF
$ids
EOF
}

# wait_for_volumes_detached — block until no labelled volume reports an attached server.
# `hcloud server delete` detaches its volumes asynchronously, so deleting a volume immediately
# after the server races that detach and gets rejected. Poll (selector-scoped, like everything
# else) until the volumes are free, or give up and let purge's retries + verify_swept handle it.
wait_for_volumes_detached() {
	assert_selector
	[ "$DRY_RUN" = "1" ] && return 0
	local waited=0 attached
	while [ "$waited" -lt "$DETACH_TIMEOUT" ]; do
		# column `server` is empty for a detached volume; count the non-empty ones.
		attached="$(hcloud volume list --selector "$SELECTOR" -o noheader -o columns=server 2>/dev/null | grep -c '[^[:space:]-]' || true)"
		if [ "${attached:-0}" -eq 0 ]; then
			[ "$waited" -gt 0 ] && echo "  · volumes detached after ${waited}s"
			return 0
		fi
		echo "  · waiting for ${attached} volume(s) to detach… (${waited}s/${DETACH_TIMEOUT}s)"
		sleep 5
		waited=$((waited + 5))
	done
	echo "  WARN: volumes still attached after ${DETACH_TIMEOUT}s — attempting delete anyway" >&2
}

# ── The ingress load balancer, which carries NO cluster label and never will ────────────────────
#
# ingress-nginx ships `controller.service.type: LoadBalancer` (apps/console/lib/addons/catalog.ts),
# so the hcloud cloud-controller-manager creates a REAL, billable Load Balancer for it at runtime.
# `purge load-balancer --selector cluster=<name>` cannot see it and verify_swept confirmed nothing:
# a standing LB bill after every hard kill, reported as a clean teardown.
#
# THE OBVIOUS FIX DOES NOT EXIST. csi.tf solves the same problem for pvc-* volumes by handing the
# CSI driver HCLOUD_VOLUME_EXTRA_LABELS and hard-failing the plan if the label is missing, and the
# instinct is to copy that onto the CCM in cilium.tf. The CCM has no equivalent. Checked against
# the source at hetznercloud/hcloud-cloud-controller-manager@main: there is no labels annotation in
# internal/annotation/load_balancer.go (the only naming/identity knob is
# `load-balancer.hetzner.cloud/name`), and internal/hcops/load_balancer.go sets exactly ONE label on
# create — `hcloud-ccm/service-uid`, the Service UID, which the sweeper cannot know. There is no
# default-labels env var either. So the label simply cannot be stamped at the source.
#
# What CAN bind the LB to this run is the run's PRIVATE NETWORK. talos.tf writes the `hcloud`
# Secret with `network = local.network_id` and cilium.tf sets `networking.enabled=true`, so the CCM
# attaches every LB it creates to THIS cluster's network. The network itself carries
# cluster=<name> (main.tf `base_labels`), so it is discovered by the same selector as everything
# else — the binding stays scope-locked, exactly as the AWS sweeper binds out-of-band ELBs through
# a secondary `elbv2.k8s.aws/cluster` filter and the GCP sweeper binds LB residue through the VPC.
#
# The account-wide part of this is a LIST, never a delete: every id that reaches a delete has been
# confirmed attached to a network id that carries our label.
cluster_network_id() {
	assert_selector
	# Captured BEFORE it is filtered: `hcloud … | head -n1` reports head's status, never the CLI's.
	local out
	out="$(probe_run network hcloud network list --selector "$SELECTOR" -o noheader -o columns=id)" || return 0
	printf '%s' "$out" | head -n1 | tr -d '[:space:]' || true
}

# unlabelled_lb_ids — Load Balancers attached to THIS run's private network but carrying no
# cluster label. Empty (never account-wide) unless the network id is a confirmed number.
unlabelled_lb_ids() {
	local net labelled
	net="$(cluster_network_id)"
	# A non-numeric or empty id would make the jq match degenerate; refuse rather than widen.
	printf '%s' "$net" | grep -Eq '^[0-9]+$' || return 0
	labelled="$(list_ids load-balancer | tr '\n' ' ')"
	local raw
	raw="$(probe_run ccm-load-balancers hcloud load-balancer list -o json)" || return 0
	printf '%s' "$raw" |
		jq -r --argjson net "$net" '.[] | select(((.private_net // []) | map(.network) | index($net)) != null) | .id' 2>/dev/null |
		while IFS= read -r id; do
			[ -n "$id" ] || continue
			# Skip ones the labelled purge already covers, so they are not reported twice.
			case " $labelled " in *" $id "*) continue ;; esac
			printf '%s\n' "$id"
		done || true
}

# capture_is_ours — does the capture file describe the cluster we are sweeping?
#
# A file written for another cluster is worse than no file: it answers this run's question with
# someone else's binding, and the answer looks authoritative. A file with no `# cluster=` header
# predates this check and is accepted, so an in-flight run is not stranded mid-upgrade.
capture_is_ours() {
	local want stamped
	want="${SELECTOR#cluster=}"
	stamped="$(sed -n 's/^# cluster=//p' "$LB_CAPTURE_FILE" | head -n1)"
	[ -z "$stamped" ] && return 0
	[ "$stamped" = "$want" ] && return 0
	echo "::warning::the load-balancer capture at ${LB_CAPTURE_FILE} was written for cluster '${stamped}', not '${want}' — ignoring it and falling back to the project-wide question." >&2
	return 1
}

sweep_unlabelled_lbs() {
	assert_selector
	local ids id
	if ! command -v jq >/dev/null 2>&1; then
		echo "::warning::jq is not installed — the CCM-created ingress load balancer for ${SELECTOR} could NOT be discovered (it carries no hcloud label; the only binding is its private-network attachment, which needs jq to read). NOT swept and NOT verified — check load balancers by hand."
		probe_note_unverifiable ccm-load-balancers "no jq"
		return 0
	fi
	# "none" must mean NONE, not "could not look" (#2549).
	#
	# unlabelled_lb_ids binds an LB to this run through its private-network attachment, and that is
	# the only binding a CCM-created LB has — it carries no label and cannot be made to. But on the
	# graceful path `tofu destroy` deletes hcloud_network.this FIRST, so by the time the sweep runs
	# the network is gone, cluster_network_id() is empty, and the lookup returns nothing. Printing
	# "none" there reports a clean account while an ingress Load Balancer bills on, which is the same
	# shape as the aws sweeper's own warning: a sweeper that reports clean without looking is more
	# expensive than no sweeper, because it stops anyone else looking.
	#
	# So when the binding cannot be resolved, ask the cheaper question that CAN be answered — does
	# this project hold any Load Balancer at all? A read, never a delete: widening to an account-wide
	# purge is precisely what scope-locking forbids. Zero means "none" honestly; anything else is
	# reported UNVERIFIABLE so verify_swept gates and a human looks.
	local net_for_lbs
	net_for_lbs="$(cluster_network_id)"
	if ! printf '%s' "$net_for_lbs" | grep -Eq '^[0-9]+$'; then
		# ── THE CAPTURED BINDING (#3481). The network is gone, which on the GRACEFUL path is the
		# NORMAL state: `tofu destroy` deletes it first. If the harness captured this run's load
		# balancers before the destroy, that file IS the run-scoped binding, and it outlives the
		# network the live lookup needs.
		#
		# Without it the branch below asks "does this project hold ANY load balancer?" and lets that
		# answer stand for a run-scoped one — so a concurrent run's ingress LB reds this leg, and a
		# FAILED teardown (network still up, binding resolvable) verifies cleanly while a SUCCESSFUL
		# one does not.
		if [ -n "$LB_CAPTURE_FILE" ] && [ -f "$LB_CAPTURE_FILE" ] && capture_is_ours; then
			local captured live_ids still
			if [ ! -r "$LB_CAPTURE_FILE" ]; then
				echo "::warning::the load-balancer capture at ${LB_CAPTURE_FILE} is unreadable — NOT verified; check by hand (#3481)." >&2
				probe_note_unverifiable ccm-load-balancers "capture-unreadable"
				return 0
			fi
			local crc=0
			captured="$(grep -E '^[0-9]+$' "$LB_CAPTURE_FILE")" || crc=$?
			if [ "$crc" -gt 1 ]; then
				echo "::warning::could not read the load-balancer capture at ${LB_CAPTURE_FILE} (grep exit ${crc}) — NOT verified; check by hand (#3481)." >&2
				probe_note_unverifiable ccm-load-balancers "capture-read-failed"
				return 0
			fi
			if [ -z "$captured" ]; then
				# Captured successfully and found none. This is the one place "none" is honest
				# without a live read: it was measured while the binding still existed.
				#
				# ⚠️ KNOWN BOUND, and it is deliberately NOT closed here. The capture is a
				# point-in-time read taken before RunDestroy, so a CCM that finishes creating the
				# ingress LB DURING the destroy window (up to 45 min) lands outside it. Re-asking
				# the project-wide question would catch that — and would also re-red every run
				# standing next to a concurrent one, which is exactly the #3481 false red this
				# branch exists to remove. With the network gone and the CCM LB carrying no label
				# there is no run-scoped binding left to tell the two apart, so the choice is
				# between a wrong red on every parallel run and a wrong green on a narrow race.
				# Widening the window is the real fix (capture later, or label the LB), not
				# re-asking a question that cannot distinguish them.
				echo "  · unlabelled (CCM) load balancers: none (captured before the destroy: this run held none)"
				return 0
			fi
			local lrc=0
			live_ids="$(hcloud load-balancer list -o noheader -o columns=id 2>/dev/null)" || lrc=$?
			if [ "$lrc" -ne 0 ]; then
				echo "::warning::'hcloud load-balancer list' failed (exit ${lrc}) while re-checking the $(printf '%s' "$captured" | grep -cE '^[0-9]+$') load balancer(s) captured for ${SELECTOR}. NOT verified — check by hand (#3481)." >&2
				probe_note_unverifiable ccm-load-balancers "list-failed-after-capture"
				return 0
			fi
			still=""
			while IFS= read -r cid; do
				[ -n "$cid" ] || continue
				case " $(printf '%s' "$live_ids" | tr '\n' ' ') " in *" $cid "*) still="${still}${cid}
" ;; esac
			done <<<"$captured"
			if [ -z "$still" ]; then
				echo "  · unlabelled (CCM) load balancers: none (all $(printf '%s' "$captured" | grep -cE '^[0-9]+$') captured for this run are gone)"
				return 0
			fi
			# THIS RUN's, by a binding taken before the network went away — so these are ours to
			# delete, not merely someone's to worry about.
			echo "  · unlabelled (CCM) load balancers captured for this run: $(printf '%s' "$still" | grep -c .) to delete"
			# ⚠️ THIS BRANCH GATES ITSELF. The obvious comment to write here — "a failed delete is
			# left for verify_swept to gate authoritatively" — is true of the network-bound branch
			# below and FALSE here. verify_swept re-checks unlabelled load balancers through
			# unlabelled_lb_ids, which resolves cluster_network_id and `return 0`s silently when the
			# id is not numeric; this branch only runs BECAUSE the network is already gone. So a
			# 409/423/429 from hcloud (delete protection, a transient rate limit — and there is no
			# retry_delete in this file) printed a WARN nobody gates on, and the run exited 0 with
			# the ingress LB still billing. One transient API failure was enough.
			while IFS= read -r id; do
				[ -n "$id" ] || continue
				if [ "$DRY_RUN" = "1" ]; then
					echo "      would delete load-balancer ${id} (captured before the destroy)"
					continue
				fi
				hcloud load-balancer delete "$id" >/dev/null 2>&1 &&
					echo "      deleted load-balancer ${id}" ||
					echo "      WARN: could not delete load-balancer ${id}" >&2
			done <<<"$still"
			[ "$DRY_RUN" = "1" ] && return 0
			# RE-READ, and treat an unreadable re-read as unverified rather than as success. The
			# question is narrow and run-scoped ("are the ids we just deleted gone?"), so it can be
			# answered without the network the live lookup lost.
			local vrc=0 after survivors=""
			after="$(hcloud load-balancer list -o noheader -o columns=id 2>/dev/null)" || vrc=$?
			if [ "$vrc" -ne 0 ]; then
				echo "::warning::could not re-check the load balancer(s) deleted for ${SELECTOR} (exit ${vrc}). NOT verified — check by hand (#3481)." >&2
				probe_note_unverifiable ccm-load-balancers "list-failed-after-delete"
				return 0
			fi
			while IFS= read -r id; do
				[ -n "$id" ] || continue
				case " $(printf '%s' "$after" | tr '\n' ' ') " in *" $id "*) survivors="${survivors}${id} " ;; esac
			done <<<"$still"
			if [ -n "$survivors" ]; then
				echo "::warning::load balancer(s) captured for ${SELECTOR} survived the delete and are STILL BILLING: ${survivors}(#3481)" >&2
				probe_note_unverifiable ccm-load-balancers "delete-failed: ${survivors}"
			fi
			return 0
		fi
		# The exit status is captured SEPARATELY, and that is the whole point (#2549).
		#
		# This was `hcloud ... | grep -c . || true`, which launders the status twice over: the pipe
		# reports grep's, and `|| true` swallows what remains. An expired token, an absent context,
		# an API 5xx or a rate limit all print nothing to stdout and exit non-zero — so lb_total was
		# 0 and the sweep announced "project holds no load balancer at all" on the strength of a
		# command that never ran. That is the failure this function was rewritten to fix, one level
		# down: `hcloud network list` with no ACTIVE context returns a clean empty table and exit 0,
		# and nothing distinguishes it from a genuinely empty project.
		#
		# Reported the way the `hcloud zone list` probe above reports its own unavailability: both
		# mean this script could not look, which is never silently folded into "none".
		local lb_list lb_total lb_rc=0
		lb_list="$(hcloud load-balancer list -o noheader -o columns=id 2>/dev/null)" || lb_rc=$?
		if [ "$lb_rc" -ne 0 ]; then
			echo "::warning::'hcloud load-balancer list' failed (exit ${lb_rc}) while checking for a CCM-created ingress load balancer for ${SELECTOR}. NOT swept and NOT verified — check load balancers by hand in the Hetzner Console (#2549)." >&2
			probe_note_unverifiable ccm-load-balancers "list-failed"
			return 0
		fi
		lb_total="$(printf '%s' "$lb_list" | grep -c . || true)"
		if [ "${lb_total:-0}" -eq 0 ]; then
			echo "  · unlabelled (CCM) load balancers: none (project holds no load balancer at all)"
			return 0
		fi
		echo "::warning::the run's private network is already gone, so a CCM-created ingress load balancer for ${SELECTOR} cannot be bound to this run — and this project holds ${lb_total}. NOT swept and NOT verified; check load balancers by hand (#2549)." >&2
		probe_note_unverifiable ccm-load-balancers "network-already-destroyed"
		return 0
	fi

	ids="$(unlabelled_lb_ids)"
	if [ -z "$ids" ]; then
		echo "  · unlabelled (CCM) load balancers on this run's network: none"
		return 0
	fi
	echo "  · unlabelled (CCM) load balancers on this run's network: $(printf '%s\n' "$ids" | grep -c .) to delete"
	while IFS= read -r id; do
		[ -n "$id" ] || continue
		if [ "$DRY_RUN" = "1" ]; then
			echo "      would delete load-balancer ${id} (bound via private network)"
			continue
		fi
		hcloud load-balancer delete "$id" >/dev/null 2>&1 &&
			echo "      deleted load-balancer ${id}" ||
			echo "      WARN: could not delete load-balancer ${id} (verify_swept will gate)" >&2
	done <<EOF
$ids
EOF
}

# ── Hetzner Object Storage ──────────────────────────────────────────────────────────────────────
#
# buckets.tf builds `minio_s3_bucket.bucket` named `<cluster_name>-<bucket>`. `force_destroy = true`
# means the GRACEFUL path reclaims it, so this only matters after a hard kill — and after a hard
# kill it is a standing monthly charge that nothing in this script could see, because Object Storage
# is not on the Cloud API at all. It was neither purged nor verified: silently absent.
#
# It is swept over S3 when the same credentials the apply used are present, scoped to the
# `<cluster_name>-` prefix — cluster_name is the run-unique, guard-validated handle this whole file
# is locked to, so the prefix is exactly as narrow as the label selector, not a broad name match.
# Without those credentials it is IMPOSSIBLE to look, and the honest report is to say so rather than
# let the final banner imply it was checked.
s3() { aws --endpoint-url "https://${S3_ENDPOINT}" --region "${S3_REGION}" "$@"; }

s3_list_buckets() {
	AWS_ACCESS_KEY_ID="$S3_ACCESS_KEY" AWS_SECRET_ACCESS_KEY="$S3_SECRET_KEY" AWS_SESSION_TOKEN="" \
		s3 s3api list-buckets --query 'Buckets[].Name' --output text
}
s3_bucket_names() {
	assert_selector
	# Credentials that are PRESENT but wrong (rotated, or the wrong region's endpoint) fail the call
	# and used to render as "no buckets" — the same shape as having no credentials at all, which
	# this file already knew to report. Now both do.
	probe_run object-storage-buckets s3_list_buckets 2>/dev/null |
		tr '\t' '\n' | grep -E "^${CLUSTER_NAME}-" || true
}

# s3_available — 0 when Object Storage can actually be inspected. Sets UNVERIFIABLE and warns
# otherwise, so "no buckets" is never printed for "could not look".
s3_available() {
	if [ -z "$S3_ACCESS_KEY" ] || [ -z "$S3_SECRET_KEY" ]; then
		echo "::warning::HETZNER_S3_ACCESS_KEY/HETZNER_S3_SECRET_KEY are unset — Hetzner Object Storage buckets named ${CLUSTER_NAME}-* were NOT swept and NOT verified. Object Storage is a separate product with no hcloud label and no Cloud-API listing, so this script cannot see it without them. If this run provisioned buckets, check them by hand at https://${S3_ENDPOINT}."
		probe_note_unverifiable object-storage-buckets "no S3 credentials"
		return 1
	fi
	if ! command -v aws >/dev/null 2>&1; then
		echo "::warning::the 'aws' CLI is not installed — Hetzner Object Storage buckets named ${CLUSTER_NAME}-* were NOT swept and NOT verified. Check them by hand at https://${S3_ENDPOINT}."
		probe_note_unverifiable object-storage-buckets "no aws CLI"
		return 1
	fi
	return 0
}

# report_imager_helpers — the hcloud-talos/imager provider's UPLOAD HELPERS, which no selector reaches.
#
# `imager_image` stamps cluster=<name> on the SNAPSHOT it produces, so the snapshot is reclaimed by
# the labelled `image` purge above. Its scaffolding is a different matter: the provider boots a
# rescue server and registers an ssh key, both named `hcloud-upload-image-<hex>`, and neither
# carries a label of any kind. Nothing ties them to a cluster, so there is no scope-locked way to
# delete them from here.
#
# They escape the teardown too. When the build fails mid-resource — the common case, #2458 — the
# image never lands in state, so the destroy pass has nothing to remove. A failed hetzner build
# therefore leaves a STOPPED SERVER BILLING, and until now it left it in silence: measured
# 2026-08-24 on an account that was empty beforehand, so attribution was certain for once.
#
# So: REPORT, never delete. The hcloud account is SHARED WITH PROD, `hcloud-upload-image-*` is the
# provider's fixed prefix rather than one of ours, and a CONCURRENT run's live upload server matches
# the same pattern — deleting one mid-build breaks that run. A human who knows this run's timing can
# tell them apart; this script cannot, and must not guess. #2463 tracks making them labelable
# upstream, which would let the ordinary selector reach them and retire this function.
#
# The two listings are account-wide, which is safe precisely because they are READS. Nothing here
# deletes, and that is the whole design.
#
# ── WHY THIS IS UNATTRIBUTABLE AND NOT UNVERIFIABLE (#3138's one wrong call) ─────────────────────
#
# #3138 recorded this through probe_note_unverifiable, which gates. Both listings SUCCEED; the
# answer is simply that an unlabelled resource exists. So the hetzner leg exited 4 on every run —
# 33172643012's only ledger entry was `imager-upload-helpers(unlabelled, cannot attribute)` — and
# a step that is red every night is a step nobody reads, which is the same defect class #3138 was
# written to remove.
#
# The discriminator is not "how noisy is it". It is: did the probe get an answer, and does this
# sweeper still owe an action? Here reporting IS the whole contract — the design forbids deleting —
# so nothing is left undone and there is nothing an exit code could usefully demand.
#
# The FAILURE path is untouched and still gates. `probe_run` writes the UNVERIFIABLE ledger itself
# when `hcloud server list` cannot answer, and that entry is a file write, so the `| grep` below
# cannot launder it. A dead token here still exits 4; only a successful listing that found something
# is downgraded.
#
# ── WHO ELSE WOULD SEE ONE OF THESE (measured 2026-08-28: nobody) ───────────────────────────────
#
# e2e-orphan-reaper.yml (`17 7 * * *`) is the only standing watcher of this account, and its hetzner
# leg runs this script's PREFLIGHT. PREFLIGHT discovery is `list_orphan_clusters`, which selects on
# `labels["alethia_project-id"]` starting with `e2e-` — and an imager helper carries NO LABELS AT
# ALL, so it is invisible to that query by construction. Worse, on the common day the preflight
# finds no orphan it `exit 0`s before the purge sequence this function is part of ever runs, so it
# never looked. Nothing else lists them: the label selector cannot reach them, `tofu destroy` has
# them in no state file (#2458), and no alarm keys on the name.
#
# That is why the preflight now calls this function on its no-orphans path (see the PREFLIGHT block
# below): it makes the daily reaper the standing observer, which is the only thing that watches this
# account when no nightly is running. #2463 is where the real fix lives — a label from the provider
# would let the ordinary selector reach them and retire this function entirely.
# report_image_cache — say what the Talos snapshot cache holds, and that it was NOT swept.
#
# Read-only, always. This is the one type whose survival is the DESIGN (see IMAGE_CACHE_SELECTOR
# above), so it is reported and never deleted, and it touches NEITHER ledger:
#
#   · not UNVERIFIABLE, because nothing is left undone — this script owes the cache no action, and
#     recording it there would red every hetzner teardown on a listing blip, which is exactly the
#     over-application #3138 made and sweep-probe.sh's header warns about;
#   · not UNATTRIBUTABLE, because the entries are perfectly attributable — they belong to the
#     PROJECT rather than to any run, on purpose.
#
# What it must not do is collapse its three answers into one. The listing is captured WITHOUT a
# pipe so its real exit status survives (a pipe would substitute the last stage's, which is how
# `2>/dev/null | grep` turned an expired token into "nothing found" throughout this file's
# history) — and "could not list", "none" and "n entries" print three different sentences.
report_image_cache() {
	local ids rc=0 count
	ids="$(hcloud image list --selector "$IMAGE_CACHE_SELECTOR" -o noheader -o columns=id 2>/dev/null)" || rc=$?
	if [ "$rc" -ne 0 ]; then
		echo "  · talos image cache: COULD NOT LIST (hcloud exit ${rc}). Not swept — it never is — and not counted."
		echo "    (This does not affect the verdict below: the cache is outside this script's selector by design.)"
		return 0
	fi
	count="$(printf '%s\n' "$ids" | grep -c . || true)"
	if [ "$count" -eq 0 ]; then
		echo "  · talos image cache (${IMAGE_CACHE_SELECTOR}): empty — the next hetzner apply will build a snapshot and stamp one."
		return 0
	fi
	echo "  · talos image cache (${IMAGE_CACHE_SELECTOR}): ${count} entr(y/ies) present and DELIBERATELY NOT SWEPT."
	echo "    They carry no \`cluster\` label, so this script's selector cannot reach them; that is what makes the"
	echo "    cache survive a run's teardown (#3027). Reclaim them explicitly with:"
	echo "      scripts/e2e/hcloud-image-cache.sh                                   # list"
	echo "      scripts/e2e/hcloud-image-cache.sh --prune-superseded --yes-delete   # duplicates only"
	return 0
}

report_imager_helpers() {
	local servers keys found
	servers="$(probe_run imager-upload-helpers hcloud server list -o noheader -o columns=id,name | grep -F 'hcloud-upload-image-' || true)"
	keys="$(probe_run imager-upload-helpers hcloud ssh-key list -o noheader -o columns=id,name | grep -F 'hcloud-upload-image-' || true)"
	found=0
	if [ -n "$servers" ]; then
		echo "  · imager upload servers present (NOT swept — unlabelled, may belong to another run):"
		printf '      %s\n' "$servers"
		found=1
	fi
	if [ -n "$keys" ]; then
		echo "  · imager upload ssh-keys present (NOT swept — unlabelled, may belong to another run):"
		printf '      %s\n' "$keys"
		found=1
	fi
	if [ "$found" = "0" ]; then
		echo "  · imager upload helpers: none present"
		return 0
	fi
	echo "::warning::hcloud-upload-image-* server(s)/ssh-key(s) exist and were NOT swept. The imager provider creates them unlabelled, so this label-scoped script cannot attribute them to a run. If no image build is in flight they are leaked (a stopped server still bills) — remove them by hand. Nothing else watches for them: the reaper's preflight discovery selects on the alethia_project-id label these do not carry. See #2463."
	probe_note_unattributable imager-upload-helpers "unlabelled by the imager provider — cannot be tied to this run"
}

sweep_object_storage() {
	assert_selector
	s3_available || return 0
	local names name
	names="$(s3_bucket_names)"
	if [ -z "$names" ]; then
		echo "  · object storage buckets: none"
		return 0
	fi
	echo "  · object storage buckets: $(printf '%s\n' "$names" | grep -c .) to delete"
	while IFS= read -r name; do
		[ -n "$name" ] || continue
		# Belt-and-braces: never issue a delete for a name outside this run's prefix.
		case "$name" in "${CLUSTER_NAME}-"*) ;; *) continue ;; esac
		if [ "$DRY_RUN" = "1" ]; then
			echo "      would delete bucket ${name}"
			continue
		fi
		AWS_ACCESS_KEY_ID="$S3_ACCESS_KEY" AWS_SECRET_ACCESS_KEY="$S3_SECRET_KEY" AWS_SESSION_TOKEN="" \
			s3 s3 rm "s3://${name}" --recursive >/dev/null 2>&1 || true
		if AWS_ACCESS_KEY_ID="$S3_ACCESS_KEY" AWS_SECRET_ACCESS_KEY="$S3_SECRET_KEY" AWS_SESSION_TOKEN="" \
			s3 s3api delete-bucket --bucket "$name" >/dev/null 2>&1; then
			echo "      deleted bucket ${name}"
		else
			echo "      WARN: could not delete bucket ${name} (verify_swept will gate)" >&2
		fi
	done <<EOF
$names
EOF
}

# ── PREFLIGHT: prior-run orphan discovery (#2330) ───────────────────────────────────────────────
#
# WHY THIS EXISTS. e2e-orphan-reaper.yml reclaims stacks that a cancelled nightly leaked, by
# running each cloud's PREFLIGHT discovery out-of-band. hetzner was ABSENT from that reaper, and
# stated as a real gap, for exactly one reason: this script had no discovery mode. It sweeps one
# named cluster and nothing else. So a cancelled hetzner leg leaked with nothing to reclaim it.
#
# WHAT IT DISCRIMINATES ON, AND WHY NOT THE CLUSTER NAME. The obvious enumerator — "every
# `cluster=` label that looks like a run handle" — would key on `alethia-nl-<run_id>-<attempt>`,
# and `alethia-nl` is a PREFIX OF PROD's naming, not a test-only marker. A regex that has to be
# exactly right to avoid deleting production is the wrong shape for a sweeper in a shared account.
#
# Instead this keys on the SAME handle the other four clouds use: `alethia_project-id=e2e-<env>`,
# which packages/core/cloud/tags.go stamps on every resource through classification_tags, and
# which infra/templates/project/hetzner/checks_classification.tf ASSERTS reaches every hcloud
# resource. A resource without that label is not a nightly resource and is invisible here — which
# is the failure direction we want.
#
# The cluster name to sweep is then read back off the same resources' `cluster` label rather than
# reconstructed from the env, so the value handed to the scope-locked sweep is one hcloud itself
# reported, never one this script assembled.
#
# Posture matches the other four: best-effort, loud, bounded, and `exit 0` on every path — a
# preflight that can fail its caller is not a preflight.

# list_orphan_clusters — every OTHER run's `cluster` label value that still has e2e-labelled
# resources. Same validation and prod/shared denylist as the top-of-file guard, re-applied per
# candidate so discovery can never widen past a genuine prior nightly.
list_orphan_clusters() {
	local kind rows
	{
		for kind in server volume network firewall primary-ip image; do
			hcloud "$kind" list -o json 2>/dev/null |
				jq -r '.[]? | select((.labels["alethia_project-id"] // "") | startswith("e2e-"))
				               | .labels.cluster // empty' 2>/dev/null || true
		done
	} | while IFS= read -r rows; do
		[ -n "$rows" ] || continue
		[ "$rows" = "$CLUSTER_NAME" ] && continue # never this run — its own teardown owns it
		printf '%s' "$rows" | grep -Eq '^[a-z0-9][a-z0-9._-]{4,62}$' || continue
		case "$rows" in
		prod | prod-* | production | production-* | staging | staging-* | main | alethia | alethia-data) continue ;;
		esac
		printf '%s\n' "$rows"
	done | sort -u
}

# capture_run_lbs — write every Load Balancer id bound to THIS run to a file, while the binding
# still exists. Both halves: the label-selected ones (belt) and the ones attached to this run's
# private network but carrying no label (braces — the CCM ingress LB, which is the whole point).
#
# A FAILURE TO LOOK MUST NOT WRITE AN EMPTY FILE. An empty capture is read downstream as "this run
# held no load balancer", which is exactly the silent green this change exists to remove — one step
# earlier than before. So the file is written only when both reads answered; otherwise nothing is
# written and the sweep falls through to the project-wide question, which at least reds.
capture_run_lbs() {
	assert_selector
	local net raw ids rc=0
	net="$(cluster_network_id)"
	if ! printf '%s' "$net" | grep -Eq '^[0-9]+$'; then
		echo "::warning::--capture-lbs: this run's private network could not be resolved, so no load-balancer binding was captured. The teardown sweep will fall back to the project-wide question." >&2
		return 0
	fi
	raw="$(hcloud load-balancer list -o json 2>/dev/null)" || rc=$?
	if [ "$rc" -ne 0 ] || [ -z "$raw" ]; then
		echo "::warning::--capture-lbs: 'hcloud load-balancer list' failed (exit ${rc}); nothing captured. NOT an empty run — the teardown sweep falls back." >&2
		return 0
	fi
	# jq's STATUS IS CAPTURED, not laundered. `|| true` under pipefail swallowed it, and the write
	# below is unconditional — so a jq that FAILED (a truncated or oversized payload, a CLI
	# deprecation line ahead of the JSON, --argjson rejecting the network id) produced an empty
	# `ids`, wrote an empty file, and the teardown read that as "captured before the destroy: this
	# run held none" and returned CLEAN with no live look at all. That is the silent green this
	# whole change exists to remove, moved one step earlier. The two guards above cover a non-zero
	# `hcloud` and an unresolvable network; neither covers jq itself.
	local jrc=0
	ids="$(printf '%s' "$raw" |
		jq -r --argjson net "$net" --arg sel "$CLUSTER_NAME" \
			'.[] | select((((.private_net // []) | map(.network) | index($net)) != null) or (.labels.cluster == $sel)) | .id' 2>/dev/null)" || jrc=$?
	if [ "$jrc" -ne 0 ]; then
		echo "::warning::--capture-lbs: jq could not read the load-balancer list (exit ${jrc}); nothing captured. NOT an empty run — the teardown sweep falls back." >&2
		return 0
	fi
	# THE FILE SAYS WHOSE IT IS. LB_CAPTURE_FILE is a fixed path and PREFLIGHT re-invokes this
	# script per orphan (`PREFLIGHT=0 … "$0" "$ocl"`) with the environment inherited, so an exported
	# ALETHIA_E2E_HCLOUD_LB_IDS would answer every orphan's CCM-load-balancer question with THIS
	# run's capture. Not reachable today — the nightly's preflight step is aws-only — but the
	# binding should describe itself rather than depend on that staying true. The reader refuses a
	# file whose cluster is not the one being swept; `grep -E '^[0-9]+$'` skips this line anyway.
	{
		echo "# cluster=${CLUSTER_NAME}"
		# An empty RESULT after a successful read is a real answer: this run holds none.
		printf '%s\n' "$ids" | grep -E '^[0-9]+$' || true
	} >"$CAPTURE_LBS"
		echo "  · captured $(grep -cE '^[0-9]+$' <"$CAPTURE_LBS" || true) load balancer(s) bound to ${CLUSTER_NAME} (network ${net}) → ${CAPTURE_LBS}"
}

if [ -n "$CAPTURE_LBS" ]; then
	capture_run_lbs
	exit 0
fi

if [ "$PREFLIGHT" = "1" ]; then
	# Discovery is entirely jq-driven. Without jq every list would yield nothing, the loop would
	# find no orphans, and this would exit 0 reporting a clean account it never looked at — the
	# precise failure aws-cleanup.sh's header calls "more expensive than no sweeper, because it
	# stops anyone else looking". Refuse instead. (Elsewhere in this file jq is optional because
	# its absence degrades a sweep that ALSO has a labelled path; here there is no other path.)
	if ! command -v jq >/dev/null 2>&1; then
		echo "::error::hetzner preflight requires jq — refusing to report a clean account it cannot inspect." >&2
		exit 2
	fi
	echo "→ hetzner STALE PREFLIGHT: sweeping prior-run e2e orphans (excludes this run ${CLUSTER_NAME})"
	[ "$DRY_RUN" = "1" ] && echo "  (DRY_RUN=1 — listing only, deleting nothing)"
	orphans="$(list_orphan_clusters || true)"
	if [ -z "$orphans" ]; then
		# THE ONE TYPE THIS EARLY EXIT WOULD OTHERWISE STEP OVER. list_orphan_clusters selects on
		# `labels["alethia_project-id"]` — the imager upload helpers carry NO labels at all, so they
		# are invisible to it by construction, and on the quiet day this branch runs the daily reaper
		# would exit 0 having never looked at the one resource type nothing else watches for. Read
		# only; the function never deletes. On the branch below, the per-orphan child sweep reports
		# them already, so this is not duplicated there.
		report_imager_helpers
		# Same argument, for the type that survives ON PURPOSE: on the quiet day this branch runs,
		# the daily reaper would otherwise never mention the one hcloud type nothing ever deletes.
		report_image_cache
		# Reports BOTH states: the unattributable finding, and — if the listing itself failed —
		# the fact that it could not answer. Preflight never blocks its caller, so both warn.
		#
		# It also emits the POSITIVE marker, which is what makes this early return readable from
		# outside: "discovery answered nothing" and "discovery never answered" print the same ✓ line
		# below, and only a line that must be PRESENT can separate them. See
		# scripts/e2e/lib/sweep-probe.sh's probe_report_discovery header.
		probe_report_discovery hcloud "the preflight scan"
		echo "✓ preflight: no prior-run e2e orphans — nothing to sweep$(probe_clean_suffix)"
		exit 0
	fi
	# shellcheck disable=SC2086
	echo "  orphan clusters found: $(printf '%s ' $orphans)"
	echo "  budget: ${PREFLIGHT_BUDGET_SECONDS}s wall-clock, at most ${PREFLIGHT_MAX_ENVS} orphan(s) this run"
	residual=0
	attempted=0
	deadline=$(($(date +%s) + PREFLIGHT_BUDGET_SECONDS))
	skipped=""
	while IFS= read -r ocl; do
		[ -n "$ocl" ] || continue
		if [ "$attempted" -ge "$PREFLIGHT_MAX_ENVS" ]; then
			skipped="${skipped}${ocl} (cap) "
			continue
		fi
		now=$(date +%s)
		if [ "$now" -ge "$deadline" ]; then
			skipped="${skipped}${ocl} (budget) "
			continue
		fi
		attempted=$((attempted + 1))
		echo "── preflight sweep: prior run ${ocl} (${attempted}/${PREFLIGHT_MAX_ENVS}, $((deadline - now))s budget left) ──"
		# Re-invoke THIS script scope-locked to the orphan rather than re-entering the sweep in
		# place: the whole file is written around one CLUSTER_NAME and one SELECTOR, computed at
		# the top. Recomputing them mid-run is how a selector goes stale and a delete goes wide.
		# A subshell with a fresh CLUSTER_NAME re-runs every guard from scratch for each orphan.
		if ! PREFLIGHT=0 DRY_RUN="$DRY_RUN" "$0" "$ocl"; then
			echo "::warning::preflight could not fully sweep prior-run orphan ${ocl} (still billing) — the always() teardown / next preflight will retry. NOT failing this run."
			residual=1
		fi
	done <<<"$orphans"
	if [ -n "$skipped" ]; then
		echo "::error::preflight left orphan(s) UNSWEPT and BILLING — bounds reached before they were reached: ${skipped}"
		echo "::error::sweep by hand, scope-locked: HCLOUD_TOKEN=… ./scripts/e2e/hcloud-cleanup.sh <cluster>"
		residual=1
	fi
	if [ "$residual" = "1" ]; then
		echo "⚠ preflight finished with residual orphans (see above) — continuing (best-effort, non-fatal)"
	else
		# ⚠️ Not "the account is clean" — "every orphan this preflight could SEE is swept". The
		# discovery listing itself can fail, and preflight is explicitly non-blocking, so the honest
		# report here is a warning; the always() teardown is what gates.
		probe_report_discovery hcloud "the preflight orphan scan"
		echo "✓ preflight complete — all prior-run e2e orphans swept"
	fi
	exit 0 # preflight never blocks its caller
fi

# Deletion order respects dependencies:
#   1. servers          — free the network attachments, firewall bindings, primary IPs;
#                         also triggers the ASYNC detach of any attached volume
#   2. load-balancers   — CCM-created (none for the bare test, but sweep the label)
#   3. (wait)           — volumes cannot be deleted while attached; wait out the async detach
#   4. volumes          — CSI-created dynamic PVs, labelled via HCLOUD_VOLUME_EXTRA_LABELS
#   5. firewalls        — now unreferenced by any server
#   6. networks         — now unreferenced by any server
#   7. primary-ips      — template sets auto_delete=false, so delete explicitly
#   8. images           — the per-cluster Talos snapshots the template built (labelled cluster=…).
#                         NOT the cached snapshots: those carry alethia.io/cache=talos-image and no
#                         `cluster` label, so this selector cannot reach them. They are REPORTED
#                         instead, by report_image_cache — see IMAGE_CACHE_SELECTOR (#3027)
#   9. zones            — hcloud_zone (dns.tf, #1816); already labelled cluster=<name>, just never
#                         swept. A standing zone is a small forever-charge nothing else would notice
#  10. object storage   — a separate product; see sweep_object_storage
#  11. imager helpers   — REPORTED, never deleted; see report_imager_helpers
#  12. image cache      — REPORTED, never deleted, ON PURPOSE; see report_image_cache
#
# The CCM load balancer and the network it is discovered through must both go BEFORE `purge
# network`, or the network delete fails with the LB still attached and the id we bind to is gone.
# ── Final verification: a leak must NEVER exit green. ──
# The whole point of this script is that nothing bills after the run. Previously a delete that
# failed (e.g. a still-attached volume) logged a WARN and the script still printed "✓ complete"
# and exited 0 — so a leaked, billable volume looked exactly like a clean teardown. Re-list every
# resource type under the SAME selector and fail loudly if anything survived.
verify_swept() {
	assert_selector
	local leaked=0 res ids count types

	# `zone` only when the CLI can actually list them — the probe at the top already warned and
	# recorded it as unverifiable otherwise, and silently dropping it here would undo that.
	types="server load-balancer volume firewall network primary-ip image"
	[ "$ZONE_SUPPORTED" = "1" ] && types="${types} zone"
	for res in $types; do
		ids="$(list_ids "$res")"
		[ -z "$ids" ] && continue
		count="$(printf '%s\n' "$ids" | grep -c . || true)"
		echo "  ✗ ${res}: ${count} STILL PRESENT: $(printf '%s' "$ids" | tr '\n' ' ')" >&2
		leaked=$((leaked + count))
	done

	# The CCM's ingress LB carries no label, so the labelled loop above cannot see it — re-check it
	# through the same private-network binding the sweep used.
	if command -v jq >/dev/null 2>&1; then
		ids="$(unlabelled_lb_ids)"
		if [ -n "$ids" ]; then
			count="$(printf '%s\n' "$ids" | grep -c . || true)"
			echo "  ✗ load-balancer (unlabelled, on this run's network): ${count} STILL PRESENT: $(printf '%s' "$ids" | tr '\n' ' ')" >&2
			leaked=$((leaked + count))
		fi
	fi

	# Object storage, when it can be looked at at all.
	if s3_available; then
		ids="$(s3_bucket_names)"
		if [ -n "$ids" ]; then
			count="$(printf '%s\n' "$ids" | grep -c . || true)"
			echo "  ✗ object-storage bucket: ${count} STILL PRESENT: $(printf '%s' "$ids" | tr '\n' ' ')" >&2
			leaked=$((leaked + count))
		fi
	fi

	if [ "$leaked" -gt 0 ]; then
		# ::error:: surfaces it in the GitHub Actions UI rather than burying it in the log.
		echo "::error::hcloud cleanup INCOMPLETE — ${leaked} resource(s) for ${SELECTOR} still exist and are BILLING. Investigate and remove them (stay label-scoped; never delete account-wide)." >&2
		return 1
	fi
	return 0
}


# ── finalize_verification — THE EXIT-CODE CONTRACT.
#
#   0  every probe answered, and nothing labelled ${SELECTOR} survived.
#   1  a LEAK: something the API listed is still standing and billing.
#   4  UNVERIFIABLE: at least one probe could not answer, so nothing here proves the account is
#      empty. Warning-only was the second half of the #2549 defect — this file's own header says
#      "a leak must NEVER exit green", and a leak nobody could look for is still a leak.
#
# A real leak outranks "could not check", so verify_swept runs first.
finalize_verification() {
	if ! verify_swept; then
		return 1
	fi
	probe_gate hcloud "${SELECTOR}" || return 4
	# probe_clean_suffix is EMPTY on a genuinely clean run and carries the unattributable finding
	# otherwise, so this sentence can never read as "the account is empty" when it is not.
	echo "✓ hcloud cleanup verified complete for ${SELECTOR} — no labelled resources remain$(probe_clean_suffix)"
	return 0
}


# ── Self-test. `hcloud` is stubbed, so this touches no account and needs no token. The decision
# under test is not the printing — it is whether UNVERIFIABLE gets set, because that is what turns
# the final line from "verified complete" into a warning a human has to read. Asserted in both
# directions: an empty account must NOT raise it, or every clean sweep would cry wolf and the
# warning would stop meaning anything. ──
if [ "$SELF_TEST" = "1" ]; then
	st_fails=0
	hcloud() {
		case "$1 ${2:-}" in
		# ST_SERVERS_RC / ST_KEYS_RC exist for the same reason ST_LBS_RC does, and they carry the
		# whole imager distinction: a listing that ANSWERED "here is an unlabelled server" and one
		# that COULD NOT ANSWER produce the same empty-or-not stdout and must resolve to different
		# states. Without an independent exit code this pair cannot be told apart in a test.
		"server list") printf '%s\n' "$ST_SERVERS"; return "${ST_SERVERS_RC:-0}" ;;
		"ssh-key list") printf '%s\n' "$ST_KEYS"; return "${ST_KEYS_RC:-0}" ;;
		"network list") printf '%s\n' "$ST_NETWORK" ;;
		# ST_LBS_RC lets a case make the CLI FAIL rather than merely return nothing. Without it the
		# stub can only ever produce the two OUTPUTS, and "empty because it worked" and "empty
		# because it could not run" are exactly the pair this function must not confuse.
		# ST_LBS_AFTER lets the post-delete re-read answer DIFFERENTLY from the opening list, which
		# is the only way to tell "the delete worked" from "the delete failed and nobody checked".
		"load-balancer list")
			if [ -n "${ST_LBS_AFTER_ACTIVE:-}" ]; then printf '%s\n' "${ST_LBS_AFTER:-}"; return "${ST_LBS_AFTER_RC:-0}"; fi
			printf '%s\n' "$ST_LBS"
			return "${ST_LBS_RC:-0}"
			;;
		# A delete that FAILS. There is no retry_delete in this file, so one 409/423/429 is the
		# whole story — and before #3500's review it was a WARN nobody gated on.
		"load-balancer delete") ST_LBS_AFTER_ACTIVE=1; return "${ST_LB_DELETE_RC:-0}" ;;
		# The generic `hcloud <type> list` every list_ids call lands on. Output and exit code are
		# separately controlled, because "empty because it worked" and "empty because it could not
		# run" is precisely the pair list_ids used to conflate.
		*" list") [ -n "${ST_LIST:-}" ] && printf '%s\n' "$ST_LIST"; return "${ST_LIST_RC:-0}" ;;
		*) : ;;
		esac
	}
	# ── THE IMAGER HELPERS, and the boundary #3138 put in the wrong place. ───────────────────────
	#
	# BOTH ledgers are asserted on every case, never just one. "It is unattributable" passes if
	# everything is unattributable, which is how a dead token would stop gating; "it is not
	# unverifiable" passes if nothing is recorded at all, which is how the finding would vanish. The
	# pair is the assertion. The exit-code half is st_imager_finalize below.
	st_imager_case() { # <name> <servers> <keys> <expect UNATTRIBUTABLE: yes|no> <expect UNVERIFIABLE: yes|no> [servers rc]
		probe_reset
		ST_SERVERS="$2"
		ST_KEYS="$3"
		ST_SERVERS_RC="${6:-0}"
		ST_KEYS_RC=0
		report_imager_helpers >/dev/null 2>&1 || true
		local una=no unv=no
		case "$(probe_unattributable_types)" in *imager-upload-helpers*) una=yes ;; esac
		case "$(probe_unverifiable_types)" in *imager-upload-helpers*) unv=yes ;; esac
		if [ "$una" = "$4" ] && [ "$unv" = "$5" ]; then
			echo "  ✓ $1"
		else
			echo "  ✗ $1 — expected unattributable=$4/unverifiable=$5, got unattributable=${una}/unverifiable=${unv}" >&2
			st_fails=$((st_fails + 1))
		fi
		ST_SERVERS_RC=0
	}

	echo "→ hcloud-cleanup.sh self-test"
	st_imager_case "a leaked upload server is UNATTRIBUTABLE, not unverifiable" "163477937 hcloud-upload-image-77b49987" "" yes no
	st_imager_case "a leaked upload ssh-key alone is enough" "" "117831479 hcloud-upload-image-77b49987" yes no
	st_imager_case "an empty account raises nothing at all" "" "" no no
	st_imager_case "an unrelated server is not mistaken for one" "163000000 alethia-prod-web" "" no no
	# THE HALF THAT MUST NOT MOVE. Downgrading the FINDING does not downgrade the FAILURE: a
	# `hcloud server list` that cannot answer is still UNVERIFIABLE and still gates, and the `| grep`
	# in report_imager_helpers cannot launder that because probe_run writes a FILE, not a status.
	st_imager_case "a listing that COULD NOT ANSWER is still UNVERIFIABLE" "" "" no yes 1

	# #2549: "none" must mean NONE, not "could not look". A CCM load balancer is bound to a run ONLY
	# through its private-network attachment, and `tofu destroy` deletes that network FIRST — so the
	# lookup that finds it is already impossible by the time the sweep runs, and it used to print
	# "none" over a load balancer that was still billing.
	st_lb_case() { # <name> <network list> <load-balancer list> <expect ccm-load-balancers in UNVERIFIABLE: yes|no> [lb-list exit code]
		probe_reset
		ST_NETWORK="$2"
		ST_LBS="$3"
		ST_LBS_RC="${5:-0}"
		sweep_unlabelled_lbs >/dev/null 2>&1
		local got=no
		case "$(probe_unverifiable_types)" in *ccm-load-balancers*) got=yes ;; esac
		if [ "$got" = "$4" ]; then
			echo "  ✓ $1"
		else
			echo "  ✗ $1 — expected ccm-load-balancers-in-UNVERIFIABLE=$4, got $got" >&2
			st_fails=$((st_fails + 1))
		fi
	}

	st_lb_case "network gone + a load balancer present is UNVERIFIABLE, not 'none'" "" "4711" yes
	st_lb_case "network gone + no load balancer at all is honestly none" "" "" no
	st_lb_case "network still present resolves normally, raising nothing" "12345" "" no
	# THE REGRESSION. The fallback asked `hcloud ... | grep -c . || true`, which launders the exit
	# status twice — the pipe reports grep's, `|| true` swallows the rest. An expired token or an API
	# error printed nothing, counted 0, and the sweep announced "project holds no load balancer at
	# all" having never looked. Empty-and-failed must not read as empty-and-clean.
	st_lb_case "network gone + the CLI FAILING is UNVERIFIABLE, not 'none'" "" "" yes 1

	# The REASON, not merely the fact. A case with output AND a non-zero exit passes the yes/no
	# assertion above either way — the network-gone branch already flags it — so asserting only
	# "something was unverifiable" proves nothing about this fix. What must be true is that a failed
	# list is reported AS a failed list: `list-failed`, not `network-already-destroyed`. Confusing
	# the two sends whoever reads the warning to look for a teardown-ordering problem that isn't
	# there, while the token that actually broke goes unmentioned.
	st_lb_reason() { # <name> <load-balancer list> <lb-list exit code> <expected reason substring>
		probe_reset
		ST_NETWORK=""
		ST_LBS="$2"
		ST_LBS_RC="$3"
		sweep_unlabelled_lbs >/dev/null 2>&1
		case "$(probe_unverifiable_detail)" in
		*"$4"*) echo "  ✓ $1" ;;
		*)
			echo "  ✗ $1 — expected UNVERIFIABLE to name '$4', got '$(probe_unverifiable_detail)'" >&2
			st_fails=$((st_fails + 1))
			;;
		esac
	}
	st_lb_reason "a failed list is reported as list-failed, not network-already-destroyed" "4711" 1 "ccm-load-balancers(list-failed)"
	st_lb_reason "a network that is genuinely gone still reports network-already-destroyed" "4711" 0 "ccm-load-balancers(network-already-destroyed)"

	# ── THE CAPTURED BINDING (#3481). ────────────────────────────────────────────────────────────
	#
	# #2549 made "none" mean NONE. It did so by asking a question that is not this run's: when the
	# network is gone, does the PROJECT hold any load balancer? That is the safe direction — it
	# over-reports — but it is not free, and today it is the reason a hetzner leg reds. The nightly
	# on 2026-08-30 tore down cleanly and the sweep still returned 4, because another run's ingress
	# LB was standing. The perverse consequence is that a FAILED teardown (network still up, binding
	# resolvable) VERIFIES CLEANLY while a SUCCESSFUL one cannot.
	#
	# The capture written before `tofu destroy` is the run-scoped binding that outlives the network.
	# BOTH directions are asserted, because either alone is satisfiable by the wrong change: a
	# capture must let someone else's load balancer go unremarked, AND must still red on one of ours.
	# The LEDGER and the SENTENCE are asserted together. Either alone is satisfiable by a wrong
	# change: two branches can agree that nothing is unverifiable while disagreeing about whether
	# anything was swept, and the sentence is the only thing that says which happened.
	st_capture_case() { # <name> <captured ids> <live lb list> <expect UNVERIFIABLE: yes|no> [lb rc] [expected stdout substring]
		probe_reset
		ST_NETWORK=""
		ST_LBS="$3"
		ST_LBS_RC="${5:-0}"
		LB_CAPTURE_FILE="${TMPDIR:-/tmp}/alethia-st-capture.$$"
		printf '%s\n' "$2" | grep -E '^[0-9]+$' >"$LB_CAPTURE_FILE" || : >"$LB_CAPTURE_FILE"
		local prev_dry="$DRY_RUN" out
		DRY_RUN=1
		out="$(sweep_unlabelled_lbs 2>/dev/null || true)"
		DRY_RUN="$prev_dry"
		rm -f "$LB_CAPTURE_FILE"
		LB_CAPTURE_FILE=""
		local got=no
		case "$(probe_unverifiable_types)" in *ccm-load-balancers*) got=yes ;; esac
		if [ "$got" != "$4" ]; then
			echo "  ✗ $1 — expected ccm-load-balancers-in-UNVERIFIABLE=$4, got $got" >&2
			st_fails=$((st_fails + 1))
			return
		fi
		if [ -n "${6:-}" ] && ! printf '%s' "$out" | grep -qF -- "$6"; then
			echo "  ✗ $1 — the sweep did not say '$6'; it said:" >&2
			printf '%s\n' "$out" >&2
			st_fails=$((st_fails + 1))
			return
		fi
		echo "  ✓ $1"
	}

	# ⚠️ THE FAILING NIGHTLY, exactly. Captured before the destroy and this run held none; another
	# run's load balancer is standing. Today this reds. It must not.
	st_capture_case "a captured-empty run is CLEAN even though the project holds another run's LB" \
		"" "4711" no 0 "this run held none"
	# ⚠️ AND IT MUST NOT GO ON TO ASK ANYWAY. A capture that succeeded and found none has already
	# answered the question; re-asking the live API means an unrelated list failure can still red a
	# run we KNOW held nothing. That is the whole value of having captured.
	st_capture_case "a captured-empty run stays clean even if the live list then FAILS" \
		"" "" no 1 "this run held none"
	# ── A FAILED DELETE MUST NOT EXIT GREEN (#3500 review, finding 1). ───────────────────────────
	#
	# This branch cannot delegate to verify_swept the way the network-bound one does:
	# unlabelled_lb_ids resolves cluster_network_id and returns early when it is not numeric, and
	# this branch runs only BECAUSE the network is gone. So a 409/423/429 from hcloud printed a WARN
	# that nothing gated on and the run exited 0 with the ingress LB still billing.
	st_delete_case() { # <name> <captured+live id> <delete rc> <list after> <expect UNVERIFIABLE>
		probe_reset
		ST_NETWORK=""
		ST_LBS="$2"
		ST_LBS_RC=0
		ST_LB_DELETE_RC="$3"
		ST_LBS_AFTER="$4"
		ST_LBS_AFTER_RC=0
		ST_LBS_AFTER_ACTIVE=""
		LB_CAPTURE_FILE="${TMPDIR:-/tmp}/alethia-st-del.$$"
		printf '%s\n' "$2" >"$LB_CAPTURE_FILE"
		local prev_dry="$DRY_RUN"
		DRY_RUN=0
		sweep_unlabelled_lbs >/dev/null 2>&1 || true
		DRY_RUN="$prev_dry"
		rm -f "$LB_CAPTURE_FILE"
		LB_CAPTURE_FILE=""
		ST_LB_DELETE_RC=0
		ST_LBS_AFTER=""
		ST_LBS_AFTER_ACTIVE=""
		local got=no
		case "$(probe_unverifiable_types)" in *ccm-load-balancers*) got=yes ;; esac
		if [ "$got" = "$5" ]; then
			echo "  ✓ $1"
		else
			echo "  ✗ $1 — expected ccm-load-balancers-in-UNVERIFIABLE=$5, got $got" >&2
			st_fails=$((st_fails + 1))
		fi
	}
	st_delete_case "a captured LB that SURVIVES the delete gates the run — verify_swept cannot see it" \
		"4711" 1 "4711" yes
	# The negative control, without which the assertion above is satisfied by gating on everything.
	st_delete_case "a captured LB that is really deleted does NOT gate" \
		"4711" 0 "" no
	# And an unreadable re-read is not proof of success either.
	st_delete_case "a re-read that cannot answer is UNVERIFIABLE, not a successful delete" \
		"4711" 0 "4711" yes

	# ...and the direction that must not be lost with it: one of OURS still standing.
	st_capture_case "a captured LB that is STILL ALIVE is swept, not shrugged at" \
		"4711" "4711" no 0 "to delete"
	# Liveness is CHECKED, not assumed: a captured id that is already gone must report none rather
	# than attempt a delete against an id the API no longer knows.
	st_capture_case "captured LBs that are all gone report none, and are not re-deleted" \
		"4711" "" no 0 "are gone"
	# A read that FAILED after a capture is not "they are all gone". Same #2549 lesson, new branch.
	st_capture_case "a failed list AFTER a capture is UNVERIFIABLE, not 'all gone'" "4711" "" yes 1
	# ⚠️ NEGATIVE CONTROL, and the reason the four above mean anything: with NO capture the
	# project-wide fallback must still gate. A change that simply stopped reporting would pass every
	# case above.
	st_lb_case "with NO capture, another run's LB still reds — the fallback is unchanged" "" "4711" yes

	# ── THE CAPTURE SIDE, and the one mistake here that is fatal. ────────────────────────────────
	#
	# An EMPTY capture file is read back above as "this run held none" and resolves the sweep CLEAN
	# without a live look. So a capture that FAILED must write nothing at all — writing an empty
	# file would convert the loud fallback into exactly the silent green this whole change removes,
	# one step earlier than the bug it fixes. Asserted in both directions, because "never writes"
	# and "always writes empty" both satisfy a one-sided test.
	st_capture_write() { # <name> <network> <lb json> <lb rc> <expect file: absent|empty|ids>
		ST_NETWORK="$2"
		ST_LBS="$3"
		ST_LBS_RC="$4"
		CAPTURE_LBS="${TMPDIR:-/tmp}/alethia-st-write.$$"
		rm -f "$CAPTURE_LBS"
		capture_run_lbs >/dev/null 2>&1 || true
		local got=absent
		if [ -f "$CAPTURE_LBS" ]; then
			# "empty" means NO IDS, not a zero-length file: the capture carries a `# cluster=`
			# header so it can say whose binding it is, and that header is not an id.
			if grep -qE '^[0-9]+$' "$CAPTURE_LBS"; then got=ids; else got=empty; fi
		fi
		rm -f "$CAPTURE_LBS"
		CAPTURE_LBS=""
		if [ "$got" = "$5" ]; then
			echo "  ✓ $1"
		else
			echo "  ✗ $1 — expected the capture file to be $5, got $got" >&2
			st_fails=$((st_fails + 1))
		fi
	}
	# Finding 7: the capture names its cluster, and one written for a DIFFERENT cluster answers this
	# run's question with someone else's binding — while looking authoritative.
	st_foreign_capture() {
		probe_reset
		ST_NETWORK=""
		ST_LBS="4711"
		ST_LBS_RC=0
		LB_CAPTURE_FILE="${TMPDIR:-/tmp}/alethia-st-foreign.$$"
		printf '# cluster=%s\n' "some-other-run" >"$LB_CAPTURE_FILE"
		local prev_dry="$DRY_RUN" out
		DRY_RUN=1
		out="$(sweep_unlabelled_lbs 2>/dev/null || true)"
		DRY_RUN="$prev_dry"
		rm -f "$LB_CAPTURE_FILE"
		LB_CAPTURE_FILE=""
		# It must NOT have taken the captured-empty shortcut ("this run held none") on a file that
		# describes another cluster.
		if printf '%s' "$out" | grep -qF "this run held none"; then
			echo "  ✗ a capture written for ANOTHER cluster was trusted as this run's binding" >&2
			st_fails=$((st_fails + 1))
		else
			echo "  ✓ a capture written for ANOTHER cluster is ignored, not trusted as this run's"
		fi
	}
	st_foreign_capture

	# ⚠️ The fatal one: a failed list must leave NO file, never an empty one.
	st_capture_write "a FAILED load-balancer list writes no file, not an empty one" "12345" "" 1 absent
	st_capture_write "an unresolvable network writes no file" "" '[]' 0 absent
	# ⚠️ AND THE THIRD WAY THE READ CAN FAIL, which the two above do not cover: jq itself. Its status
	# was laundered by `|| true` under pipefail and the write below was unconditional, so a
	# truncated payload, a CLI deprecation line ahead of the JSON, or --argjson rejecting the
	# network id produced an empty `ids`, wrote an EMPTY FILE, and the teardown read that as
	# "captured before the destroy: this run held none" — CLEAN, with no live look at all.
	st_capture_write "malformed JSON writes no file — jq FAILING is not an empty run" "12345" '{not json' 0 absent
	# ...and the positive controls, or "writes nothing" would pass by never writing at all.
	st_capture_write "a successful read that finds none writes an EMPTY file — that is a real answer" "12345" '[]' 0 empty
	st_capture_write "a load balancer on this run's network is captured" "12345" '[{"id":4711,"private_net":[{"network":12345}],"labels":{}}]' 0 ids

	# And the REASON, so a reader of the warning is sent to the right place.
	st_capture_reason() { # <name> <captured> <live> <rc> <expected substring>
		probe_reset
		ST_NETWORK=""
		ST_LBS="$3"
		ST_LBS_RC="$4"
		LB_CAPTURE_FILE="${TMPDIR:-/tmp}/alethia-st-capture.$$"
		printf '%s\n' "$2" | grep -E '^[0-9]+$' >"$LB_CAPTURE_FILE" || : >"$LB_CAPTURE_FILE"
		sweep_unlabelled_lbs >/dev/null 2>&1
		rm -f "$LB_CAPTURE_FILE"
		LB_CAPTURE_FILE=""
		case "$(probe_unverifiable_detail)" in
		*"$5"*) echo "  ✓ $1" ;;
		*)
			echo "  ✗ $1 — expected UNVERIFIABLE to name '$5', got '$(probe_unverifiable_detail)'" >&2
			st_fails=$((st_fails + 1))
			;;
		esac
	}
	st_capture_reason "a post-capture list failure is named as such, not as a destroyed network" "4711" "" 1 "list-failed-after-capture"

	# ── list_ids — THE GAP #2549 LEFT OPEN, and the exit-code contract that now sits on top of it.
	#
	# Every purge and every row of verify_swept reads this one function. It laundered its status the
	# same way the load-balancer fallback above did, so a broken token made all eight resource types
	# report "none" at once and the script printed "verified complete". These three cases are the
	# three states this function can reach, end to end: the stub's OUTPUT and its EXIT CODE are varied
	# independently, because varying only the output is exactly the test that would pass with the fix
	# removed. (The fourth, UNATTRIBUTABLE, has no list_ids path — see st_imager_finalize.)
	#
	# $ST_LIST / $ST_LIST_RC drive the generic `hcloud <type> list` stub. The S3 and zone paths are
	# short-circuited so they cannot contribute an unverifiable of their own and mask the result.
	st_verify_case() { # <name> <list output> <list exit code> <expected rc> <expect unverifiable: yes|no>
		probe_reset
		ST_LIST="$2"
		ST_LIST_RC="$3"
		# A stub of its own, not the one above: these cases have to drive the exit code of EVERY
		# `hcloud <type> list` at once, which is the shape a broken credential actually has.
		hcloud() {
			case "$1 ${2:-}" in
			*" list")
				if [ -n "$ST_LIST" ]; then printf '%s\n' "$ST_LIST"; fi
				return "$ST_LIST_RC"
				;;
			*) : ;;
			esac
		}
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
	# s3_available is asked before any bucket is listed; the self-test has no credentials, and
	# answering "not available" here keeps object storage from contributing an unverifiable of its
	# own and masking the result. Its own path is covered by st_lb_case/st_imager_case, which
	# exercise the same ledger from other producers.
	s3_available() { return 1; }
	ZONE_SUPPORTED=0
	st_verify_case "an empty account, honestly listed, is CLEAN and exits 0" "" 0 0 no
	st_verify_case "a surviving resource is a LEAK and exits 1" "4711" 0 1 no
	st_verify_case "a list that FAILED is UNVERIFIABLE and exits 4, not 0" "" 1 4 yes
	# THE DIRECTION THAT MATTERS. Case 1 and case 3 produced byte-identical output and the same
	# exit 0 before this change — an empty account and a dead credential were the same answer.
	# Case 4 pins the precedence: a confirmed leak still outranks "could not check" (rc 1, not 4),
	# but the ledger must ALSO record that the list failed, or the leak count is understated.
	st_verify_case "a FAILED list that also listed a row is a LEAK *and* unverifiable" "4711" 1 1 yes

	# ── RUN 33172643012, REPLAYED END TO END. ────────────────────────────────────────────────────
	#
	# That run swept everything it owned, listed nothing labelled cluster=<name>, and still died on
	# `##[error]hcloud cleanup UNVERIFIED … Process completed with exit code 4` — with exactly one
	# ledger entry, `imager-upload-helpers(unlabelled, cannot attribute)`, from two listings that had
	# both SUCCEEDED. Every hetzner leg red, every night, for a resource this script is designed not
	# to touch.
	#
	# The exit code is the assertion that matters, and the ✓ line is asserted alongside it: exit 0
	# is only correct if the finding is still impossible to miss. If the two states are ever
	# collapsed again this case goes red on the FIRST field.
	st_imager_finalize() { # <name> <servers> <expected finalize rc> <expect the ✓ line to name it: yes|no>
		probe_reset
		ST_SERVERS="$2"
		ST_KEYS=""
		# `hcloud server list` is issued by BOTH report_imager_helpers (account-wide, unfiltered)
		# and list_ids (scope-locked). They are told apart on `--selector`, which is the only thing
		# that distinguishes them in the real script either.
		hcloud() {
			case "$*" in
			*--selector*) return 0 ;; # scope-locked: nothing labelled survived — the sweep worked
			"server list"*) printf '%s\n' "$ST_SERVERS" ;;
			"ssh-key list"*) printf '%s\n' "$ST_KEYS" ;;
			*) : ;;
			esac
		}
		report_imager_helpers >/dev/null 2>&1 || true
		local rc=0 out named=no
		# STDOUT ONLY. The ::warning:: goes to stderr and would match either way, so 2>&1 here would
		# let the ✓ line silently lose its qualifier and still pass — and the ✓ line is the sentence
		# a reader converts into "the account is empty".
		out="$(finalize_verification 2>/dev/null)" || rc=$?
		case "$out" in *UNATTRIBUTABLE*) named=yes ;; esac
		if [ "$rc" = "$3" ] && [ "$named" = "$4" ]; then
			echo "  ✓ $1"
		else
			echo "  ✗ $1 — expected rc=$3/named=$4, got rc=${rc}/named=${named}" >&2
			echo "      output was: ${out}" >&2
			st_fails=$((st_fails + 1))
		fi
	}
	st_imager_finalize "a swept run whose ONLY finding is an imager helper exits 0, not 4" \
		"163477937 hcloud-upload-image-77b49987" 0 yes
	# The other direction, on the same path: with nothing present the ✓ line stays exactly as it was,
	# so a clean run cannot start crying wolf and teaching people to ignore the qualifier.
	st_imager_finalize "a clean run's ✓ line is unchanged and mentions nothing" "" 0 no

	unset -f s3_available

	# ── THE IMAGE CACHE REPORT (#3027). Three answers that share one stdout shape, plus the
	#    property that makes it safe to add to a gating script at all: it touches NEITHER ledger.
	#
	# The failure this pins is the one this whole file exists to refuse, arriving from a new
	# direction: a cache listing that FAILED must not print the sentence a cache that is genuinely
	# EMPTY prints. And it must not gate — the cache is nothing this sweeper owes an action on, so
	# routing it into the unverifiable ledger would red every hetzner teardown on an unrelated blip.
	#
	# ⚠️ It carries its OWN stub. A `hcloud()` defined inside a function is defined GLOBALLY in
	# bash, so `st_imager_finalize` above has already replaced the file-level stub with one whose
	# first pattern is `*--selector*) return 0`. Reusing it here would answer every case with
	# "exit 0, no output" — every assertion below would read the same "empty" sentence and three of
	# the four would fail for a reason that has nothing to do with the code under test. (Worse, had
	# the expectations happened to match, they would have passed while testing the stub.)
	st_image_cache_case() { # <name> <ST_LIST> <ST_LIST_RC> <substring that MUST appear> <substring that must NOT>
		probe_reset
		ST_LIST="$2"
		ST_LIST_RC="$3"
		hcloud() {
			case "$1 ${2:-}" in
			"image list")
				[ -n "${ST_LIST:-}" ] && printf '%s\n' "$ST_LIST"
				return "${ST_LIST_RC:-0}"
				;;
			*) : ;;
			esac
		}
		local out
		out="$(report_image_cache 2>&1 || true)"
		local why=""
		case "$out" in *"$4"*) ;; *) why="missing '$4'" ;; esac
		if [ -z "$why" ]; then
			case "$out" in *"$5"*) why="unexpectedly contains '$5'" ;; *) ;; esac
		fi
		# Both ledgers, both directions — the same pairing st_imager_case uses, for the same reason.
		[ -z "$why" ] && probe_has_unverifiable && why="recorded UNVERIFIABLE (it must not gate)"
		[ -z "$why" ] && probe_has_unattributable && why="recorded UNATTRIBUTABLE (it is attributable)"
		if [ -z "$why" ]; then
			echo "  ✓ $1"
		else
			echo "  ✗ $1 — ${why}" >&2
			echo "      output was: ${out}" >&2
			st_fails=$((st_fails + 1))
		fi
	}
	st_image_cache_case "a populated cache is reported as DELIBERATELY NOT SWEPT" \
		"163001" 0 "DELIBERATELY NOT SWEPT" "COULD NOT LIST"
	st_image_cache_case "...and it counts what it saw" "163001" 0 "1 entr" "COULD NOT LIST"
	st_image_cache_case "an EMPTY cache says empty" "" 0 "empty" "COULD NOT LIST"
	# THE PAIR. Identical (empty) stdout from the CLI; the exit code is the only thing that differs,
	# and it must produce a different sentence — otherwise a dead token reads as an empty cache.
	st_image_cache_case "a FAILED listing says COULD NOT LIST, never 'empty'" "" 1 "COULD NOT LIST" "empty"
	ST_LIST=""
	ST_LIST_RC=0
	probe_reset

	unset -f hcloud

	if [ "$st_fails" -ne 0 ]; then
		echo "✗ hcloud-cleanup.sh self-test: ${st_fails} failure(s)" >&2
		exit 1
	fi
	echo "✓ hcloud-cleanup.sh self-test passed"
	exit 0
fi

purge server "servers"
purge load-balancer "load balancers"
sweep_unlabelled_lbs
wait_for_volumes_detached
purge volume "volumes"
purge firewall "firewalls"
purge network "networks"
purge primary-ip "primary IPs"
purge image "images (talos snapshots)"
report_image_cache
[ "$ZONE_SUPPORTED" = "1" ] && purge zone "dns zones"
sweep_object_storage
report_imager_helpers


if [ "$DRY_RUN" = "1" ]; then
	echo "✓ hcloud DRY RUN complete for ${SELECTOR} (nothing deleted, nothing verified)"
	exit 0
fi

echo "→ verifying nothing labelled ${SELECTOR} survived…"
# The success line is what a human reads, and "verified complete" over a type nobody checked is the
# exact claim this script exists to stop making. Since #2549's fix was generalised it is also the
# exit code that says so: 1 for a leak, 4 for a type that could not be looked at.
st_rc=0
finalize_verification || st_rc=$?
[ "$st_rc" -eq 0 ] || exit "$st_rc"
echo "  CSI volumes: dynamically-provisioned pvc-* volumes are created by the CSI controller"
echo "  at runtime (not by our template), so 'tofu destroy' cannot reclaim them. They are"
echo "  stamped with cluster=<name> at the source — the hetzner template sets the driver's"
echo "  HCLOUD_VOLUME_EXTRA_LABELS (infra/templates/project/hetzner/csi.tf, chart 2.15.0–2.20.2) —"
echo "  so the label-scoped 'volumes' purge above (after waiting out the async detach) reclaims"
echo "  them WITHOUT widening this script's blast radius. A pvc-* volume can only leak if it"
echo "  predates that change or came from an older template; sweep those by hand (never account-wide)."
