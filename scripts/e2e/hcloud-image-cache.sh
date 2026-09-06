#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# hcloud-image-cache.sh — inspect and (deliberately) reclaim the persistent Talos snapshot cache
# that infra/templates/project/hetzner/image.tf maintains (#3027).
#
# ─────────────────────────────  W H Y  T H I S  E X I S T S  ─────────────────────────────
#
# The Talos snapshot `imager_image` builds is a pure function of
# (talos_version × architecture × location × extension set). It used to be rebuilt from scratch on
# every apply — 5–15 minutes on the critical path, before any cluster exists, and the dominant flake
# of the Hetzner floor (it blew its tofu deadline twice: #2458, and the scheduled run 33080748841).
#
# image.tf now CACHES it. A cache entry is deliberately un-sweepable: it carries the label
# `alethia.io/cache=talos-image` and, crucially, NO `cluster` label — which is what makes it
# invisible to scripts/e2e/hcloud-cleanup.sh, whose entire safety model is "delete exactly what is
# labelled cluster=<this run>". Nothing there was weakened; the cache is simply outside its selector
# by construction.
#
# An un-swept resource nobody can see is how a small forever-charge becomes a surprise, so this
# script is the other half of that bargain: the cache has a name, a listing, and an explicit,
# human-invoked way to reclaim it.
#
# ─────────────────────────  R E T E N T I O N   I S   A   C H O I C E  ─────────────────────────
#
# Cache entries are RETAINED INDEFINITELY. There is no cron, no TTL, and no "older than N days"
# rule anywhere — not here and not in the reaper. A Talos version bump leaves the old image
# standing on purpose:
#
#   · an image costs about EUR 0.02/month (~1 GB at EUR 0.0119/GB/month) against 5–15 minutes of
#     critical-path wall clock on every Hetzner apply. Retention is not a cost problem;
#   · rolling `talos_version` BACK is an ordinary debugging move, and an automatic sweep would make
#     every rollback pay the rebuild — the rebuild being the flake this all exists to remove;
#   · the hcloud account is SHARED WITH PROD. An automatic, time-based delete there is the exact
#     blast-radius shape this repo has been burned by.
#
# So reclaiming is manual, and the destructive modes are behind a flag that says what it does.
#
# ────────────────────────────────  S A F E T Y   M O D E L  ────────────────────────────────
#
# Two independent properties make this script's scope impossible to confuse with a live run's:
#
#   1. IT ONLY EVER LOOKS AT `alethia.io/cache==talos-image`. A live run's resources — servers,
#      volumes, networks, and the per-cluster image built under `talos_image_cache = "disabled"` —
#      carry `cluster=<name>` and never carry the cache label. The two sets are disjoint by
#      construction, not by a regex that has to be right.
#   2. EVERY DELETE RE-DESCRIBES THE IMAGE FIRST and refuses it unless, at that moment, it still
#      carries the cache label AND carries no `cluster` label. That closes the window between the
#      listing and the delete — the window in which a concurrent apply could have stamped a cluster
#      onto something — and it is a REFUSAL that fails the script, never a skip that passes it.
#
# And the destructive modes are named for what they do rather than for a mood:
#
#   (default)                       LIST. Read-only. Touches nothing.
#   --prune-superseded              the duplicates only: for each cache key, every entry EXCEPT the
#                                   newest. An entry that is the newest of its key is never a
#                                   candidate, so this can never remove an image the current
#                                   configuration would hit.
#   --prune-version <talos-version> a deliberate retirement of one named Talos version.
#   --yes-delete                    actually delete. WITHOUT IT BOTH PRUNE MODES ONLY PRINT.
#   --self-test                     hermetic self-test; `hcloud` is stubbed, no account is touched.
#
# ⚠️ THE FLAG IS THE CONTRACT, and an invented one is silently ignored. A guessed env var
# (`ALETHIA_E2E_SELF_TEST=1` instead of the real `--self-test`) once let a REAL sweeper run against
# a live run's scope and delete its EKS cluster mid-apply. Unknown arguments here are a hard
# refusal, precisely so that a mistyped `--dry-run` can never be read as "delete everything".
#
# ────────────────────────────────  E X I T   C O D E S  ────────────────────────────────
#
#   0  the API answered and the requested action completed
#   1  a delete failed, or was REFUSED because the image no longer looked like a cache entry
#   2  usage error / refusal to run (no token, no jq, unknown flag)
#   4  UNVERIFIABLE — a listing did not answer, so nothing here proves anything about the account
#
# 4 and 0 are different on purpose. "The API said the cache is empty" and "the API did not answer"
# produce the same empty stdout, and treating them alike is the defect class this repo names
# "guards that report green" (see scripts/e2e/lib/sweep-probe.sh's header).

set -euo pipefail

E2E_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib"
# shellcheck source-path=SCRIPTDIR source=lib/sweep-probe.sh
. "${E2E_LIB_DIR}/sweep-probe.sh"
probe_reset

# ── THE MIRROR. These three constants are the same strings infra/templates/project/hetzner/image.tf
#    stamps, and scripts/check-hetzner-image-cache.mjs fails CI when they stop agreeing. Neither
#    file may inline them elsewhere; the guard matches THESE assignments.
IMAGE_CACHE_LABEL_KEY="alethia.io/cache"
IMAGE_CACHE_LABEL_VALUE="talos-image"
IMAGE_CACHE_SELECTOR="${IMAGE_CACHE_LABEL_KEY}==${IMAGE_CACHE_LABEL_VALUE}"

# The four dimensions of the cache key, in the order the listing prints them. A row missing any of
# them is UNKEYED and can never be pruned as superseded — "I cannot tell which entry supersedes it"
# is not "it is superseded".
LABEL_VERSION="alethia.io/talos-version"
LABEL_ARCH="alethia.io/talos-arch"
LABEL_LOCATION="alethia.io/talos-location"
LABEL_SCHEMATIC="alethia.io/talos-schematic"

MODE="list"
PRUNE_VERSION=""
CONFIRM_DELETE=0
SELF_TEST=0

usage() {
	cat >&2 <<'USAGE'
usage: hcloud-image-cache.sh [--prune-superseded | --prune-version <talos-version>] [--yes-delete]
       hcloud-image-cache.sh --self-test

  (no flags)                     list the cached Talos snapshots. Read-only.
  --prune-superseded             delete every cache entry EXCEPT the newest of each cache key.
  --prune-version <v>            delete every cache entry for exactly Talos version <v>.
  --yes-delete                   required by both prune modes to delete anything at all.
  --self-test                    hermetic self-test (hcloud is stubbed; no account is touched).

HCLOUD_TOKEN must be set (except under --self-test). jq is required.
USAGE
}

while [ $# -gt 0 ]; do
	case "$1" in
	--prune-superseded)
		MODE="prune-superseded"
		;;
	--prune-version)
		MODE="prune-version"
		PRUNE_VERSION="${2:-}"
		shift || true
		;;
	--yes-delete)
		CONFIRM_DELETE=1
		;;
	--self-test)
		SELF_TEST=1
		;;
	-h | --help)
		usage
		exit 0
		;;
	*)
		# A refusal, never a shrug. An unknown flag is how a destructive intent gets silently
		# dropped and a read-only one silently widened.
		echo "✗ REFUSING TO RUN: unknown argument '$1'." >&2
		usage
		exit 2
		;;
	esac
	# `|| break`, not a bare `shift`: `--prune-version` with its value missing consumes the last
	# argument in its own branch, and a bare `shift` on an empty argument list FAILS — which under
	# `set -e` kills the script with exit 1, before the refusal below can say what was wrong. The
	# flag would then have refused for a reason nobody could read.
	shift || break
done

if [ "$SELF_TEST" = "1" ]; then
	HCLOUD_TOKEN="self-test-no-hcloud-call-is-made"
	export HCLOUD_TOKEN
	PROBE_RETRY_DELAY=0
fi

if [ "$MODE" = "prune-version" ]; then
	# The version is the ENTIRE scope of this mode. An empty one would select every entry whose
	# version label is missing, which is the widest possible delete from the narrowest-looking flag.
	if [ -z "$PRUNE_VERSION" ]; then
		echo "✗ REFUSING TO RUN: --prune-version needs a Talos version (e.g. --prune-version v1.12.4)." >&2
		exit 2
	fi
	if ! printf '%s' "$PRUNE_VERSION" | grep -Eq '^[a-zA-Z0-9][a-zA-Z0-9._-]{1,61}[a-zA-Z0-9]$'; then
		echo "✗ REFUSING TO RUN: '$PRUNE_VERSION' is not a plausible Talos version label value." >&2
		exit 2
	fi
fi

if [ -z "${HCLOUD_TOKEN:-}" ]; then
	echo "✗ HCLOUD_TOKEN is unset — nothing to authenticate with." >&2
	exit 2
fi

# jq is not optional here: every field this script reads comes out of `-o json`. Without it the
# listing would yield nothing, the loops would find nothing, and the script would report an empty
# cache it never looked at — the report-clean-without-looking failure the sweepers exist to refuse.
if ! command -v jq >/dev/null 2>&1; then
	echo "::error::hcloud-image-cache.sh requires jq — refusing to report on a cache it cannot read." >&2
	exit 2
fi

if [ "$SELF_TEST" != "1" ] && ! command -v hcloud >/dev/null 2>&1; then
	echo "✗ the 'hcloud' CLI is not installed (https://github.com/hetznercloud/cli)." >&2
	exit 2
fi

# ── cache_rows — every cached snapshot as a TSV row:
#      id \t created \t version \t arch \t location \t schematic \t cluster-label \t description
#
# Selector-scoped, so it can only ever see cache entries. The listing goes through probe_run, so a
# 401 / 429 / 5xx resolves to UNVERIFIABLE rather than to an empty cache — capture FIRST, filter
# second, because a pipe would replace the cloud call's status with jq's.
cache_rows() {
	local raw rc=0
	raw="$(probe_run image-cache hcloud image list --selector "$IMAGE_CACHE_SELECTOR" -o json)" || rc=$?
	[ "$rc" -eq 0 ] || return "$rc"
	printf '%s' "$raw" | jq -r --arg v "$LABEL_VERSION" --arg a "$LABEL_ARCH" \
		--arg l "$LABEL_LOCATION" --arg s "$LABEL_SCHEMATIC" '
		.[]? | [
			(.id | tostring),
			(.created // "-"),
			(.labels[$v] // "-"),
			(.labels[$a] // "-"),
			(.labels[$l] // "-"),
			(.labels[$s] // "-"),
			(if (.labels | has("cluster")) then .labels.cluster else "-" end),
			(.description // "-")
		] | @tsv'
}

# ── delete_one <id> — the pre-delete re-describe, then the delete.
#
# The listing that produced <id> is a moment in the past. Between then and now a concurrent apply
# could, in principle, have stamped a cluster onto this image; and an id is just a number, so a bug
# upstream in this script could hand this function anything. So the identity is re-checked HERE,
# against the API, immediately before the irreversible call:
#
#   · it must still carry the cache label, and
#   · it must carry NO `cluster` label — a `cluster` label means a live run owns it, and
#     hcloud-cleanup.sh, not this script, is what reclaims those.
#
# A failed re-describe is UNVERIFIABLE and refuses the delete: "I could not confirm what this is"
# must never resolve to "delete it".
delete_one() {
	local id="$1" json rc=0
	json="$(probe_run image-cache-describe hcloud image describe "$id" -o json)" || rc=$?
	if [ "$rc" -ne 0 ]; then
		echo "      REFUSED ${id}: could not re-describe it before deleting (see the unverifiable ledger)" >&2
		return 1
	fi
	local has_cache has_cluster
	has_cache="$(printf '%s' "$json" | jq -r --arg k "$IMAGE_CACHE_LABEL_KEY" --arg v "$IMAGE_CACHE_LABEL_VALUE" \
		'if (.labels[$k] // "") == $v then "yes" else "no" end')"
	has_cluster="$(printf '%s' "$json" | jq -r 'if (.labels | has("cluster")) then "yes" else "no" end')"
	if [ "$has_cache" != "yes" ]; then
		echo "      REFUSED ${id}: no ${IMAGE_CACHE_LABEL_KEY}=${IMAGE_CACHE_LABEL_VALUE} label — this is not a cache entry." >&2
		return 1
	fi
	if [ "$has_cluster" = "yes" ]; then
		echo "      REFUSED ${id}: it carries a \`cluster\` label, so a live run owns it. hcloud-cleanup.sh reclaims those." >&2
		return 1
	fi
	if hcloud image delete "$id" >/dev/null 2>&1; then
		echo "      deleted image ${id}"
		return 0
	fi
	echo "      WARN: could not delete image ${id}" >&2
	return 1
}

# ── candidates_superseded — the ids that are NOT the newest of their cache key.
#
# Hetzner resource ids increase monotonically, so the highest id of a key is its newest entry.
# Grouping is on the FULL four-dimension key, and a row missing any dimension is dropped: an entry
# this script cannot key is an entry it cannot prove is superseded, and the safe answer to that is
# to leave it alone and say so (reported separately by `report_unkeyed`).
candidates_superseded() {
	local rows="$1"
	printf '%s\n' "$rows" | awk -F'\t' '
		NF >= 6 && $3 != "-" && $4 != "-" && $5 != "-" && $6 != "-" {
			key = $3 "\x1f" $4 "\x1f" $5 "\x1f" $6
			ids[key] = ids[key] " " $1
			if (!(key in best) || $1 + 0 > best[key] + 0) best[key] = $1
		}
		END {
			for (k in ids) {
				n = split(ids[k], a, " ")
				for (i = 1; i <= n; i++) if (a[i] != "" && a[i] != best[k]) print a[i]
			}
		}' | sort -n
}

# Rows this script deliberately will not prune, because it cannot key them. Reported every run: an
# entry nobody mentions is how an unreclaimable image becomes a permanent, invisible charge.
report_unkeyed() {
	local rows="$1" unkeyed
	unkeyed="$(printf '%s\n' "$rows" | awk -F'\t' 'NF >= 6 && ($3 == "-" || $4 == "-" || $5 == "-" || $6 == "-") { print $1 }')"
	[ -n "$unkeyed" ] || return 0
	echo "  ⚠ UNKEYED cache entries (missing a version/arch/location/schematic label) — never pruned as superseded:" >&2
	# shellcheck disable=SC2086 # unquoted on purpose: one id per line / per word.
	printf '      %s\n' $unkeyed >&2
	# shellcheck disable=SC2086
	echo "::warning::hcloud image cache holds entry/entries with an incomplete cache key: $(printf '%s ' $unkeyed). They can still be hit by nothing and swept by nothing; remove them with --prune-version once you know what they are." >&2
}

print_table() {
	local rows="$1"
	printf '  %-12s %-24s %-10s %-5s %-8s %s\n' ID CREATED VERSION ARCH LOCATION SCHEMATIC
	printf '%s\n' "$rows" | awk -F'\t' 'NF >= 6 { printf "  %-12s %-24s %-10s %-5s %-8s %s\n", $1, $2, $3, $4, $5, $6 }'
}

# ── apply_prune <targets> <label> — the ONE place a prune decides to delete or not.
#
# A function, and not inline in the main flow, so the self-test can drive THE REAL CODE rather than
# a re-enactment of it. A test that loops over the same ids printing "would delete" asserts only
# that the test itself did nothing; the decision under test is `$CONFIRM_DELETE`, and it has to be
# this function's copy of it. Echoes nothing to stdout that a caller must parse; returns 0 when the
# prune completed (including "nothing to do" and "not confirmed"), 1 when a delete failed or was
# refused.
apply_prune() {
	local targets="$1" label="$2" target_count failed=0 id

	echo
	if [ -z "$targets" ]; then
		echo "  · nothing matches ${label} — nothing to prune."
		return 0
	fi

	target_count="$(printf '%s\n' "$targets" | grep -c .)"
	echo "  ${target_count} entr(y/ies) match ${label}:"
	# shellcheck disable=SC2086 # word splitting is the intent: one id per line
	printf '      %s\n' $targets

	if [ "$CONFIRM_DELETE" != "1" ]; then
		echo
		echo "  NOTHING WAS DELETED. --yes-delete is required to delete anything."
		return 0
	fi

	while IFS= read -r id; do
		[ -n "$id" ] || continue
		delete_one "$id" || failed=$((failed + 1))
	done <<EOF
$targets
EOF

	if [ "$failed" -gt 0 ]; then
		echo "::error::hcloud image cache prune INCOMPLETE — ${failed} of ${target_count} entr(y/ies) were not deleted (refused or failed). They are still billing; see the lines above." >&2
		return 1
	fi
	echo "✓ pruned ${target_count} cache entr(y/ies) matching ${label}$(probe_clean_suffix)"
	return 0
}

# ── finalize <action-rc> — the exit-code contract, in one place.
#
# A real delete failure (1) outranks "could not look" (4), for the same reason hcloud-cleanup.sh
# runs verify_swept before probe_gate: a known problem beats an unknown one. And the success line
# carries probe_clean_suffix so it can never read as "the cache is exactly this" when a probe did
# not answer.
finalize() {
	local action_rc="$1"
	[ "$action_rc" -eq 0 ] || return "$action_rc"
	probe_gate hcloud "the Talos image cache (${IMAGE_CACHE_SELECTOR})" || return 4
	return 0
}

# ═════════════════════════════════════  S E L F - T E S T  ═════════════════════════════════════
#
# `hcloud` is shadowed by a shell function, so nothing authenticates and no account is touched. The
# decisions under test are the ones whose two answers look identical in stdout:
#
#   · an EMPTY cache vs a listing that COULD NOT ANSWER (0 vs 4)
#   · --prune-superseded WITHOUT --yes-delete vs with it (0 deletes vs n deletes)
#   · a candidate that has acquired a `cluster` label (refused, non-zero) vs one that has not
#
# The delete counter is a FILE, not a shell variable: every stub call happens inside `$( )`, which
# is a SUBSHELL, and a variable incremented there rewinds the moment the substitution closes — a
# counter built on one would report 0 forever and the "--yes-delete is required" assertion would
# pass while asserting nothing.
if [ "$SELF_TEST" = "1" ]; then
	st_fails=0
	ST_TMP="$(mktemp -d)"
	trap 'rm -rf "$ST_TMP"' EXIT
	ST_DELETES="${ST_TMP}/deletes"
	: >"$ST_DELETES"

	ok() { echo "  ✓ $1"; }
	bad() {
		echo "  ✗ $1 — $2" >&2
		st_fails=$((st_fails + 1))
	}
	assert_eq() {
		if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected '$3', got '$2'"; fi
	}

	# Three images: two share a cache key (163002 supersedes 163001), one is a different version.
	ST_LIST_JSON='[
	  {"id":163001,"created":"2026-08-01T10:00:00+00:00","description":"alethia-talos-v1.13.6-amd64-aa","labels":{"alethia.io/cache":"talos-image","alethia.io/talos-version":"v1.13.6","alethia.io/talos-arch":"x86","alethia.io/talos-location":"nbg1","alethia.io/talos-schematic":"aa","os":"talos"}},
	  {"id":163002,"created":"2026-08-20T10:00:00+00:00","description":"alethia-talos-v1.13.6-amd64-aa","labels":{"alethia.io/cache":"talos-image","alethia.io/talos-version":"v1.13.6","alethia.io/talos-arch":"x86","alethia.io/talos-location":"nbg1","alethia.io/talos-schematic":"aa","os":"talos"}},
	  {"id":163003,"created":"2026-07-01T10:00:00+00:00","description":"alethia-talos-v1.12.4-amd64-aa","labels":{"alethia.io/cache":"talos-image","alethia.io/talos-version":"v1.12.4","alethia.io/talos-arch":"x86","alethia.io/talos-location":"nbg1","alethia.io/talos-schematic":"aa","os":"talos"}}
	]'
	# A cache entry that has somehow also acquired a `cluster` label. It must never be deleted here.
	ST_DESCRIBE_CLUSTERED='{"id":163001,"labels":{"alethia.io/cache":"talos-image","cluster":"alethia-nl-123-1"}}'
	ST_DESCRIBE_OK='{"id":163001,"labels":{"alethia.io/cache":"talos-image","alethia.io/talos-version":"v1.13.6"}}'
	ST_DESCRIBE_NOT_CACHE='{"id":999999,"labels":{"cluster":"alethia-nl-123-1"}}'

	ST_LIST="$ST_LIST_JSON"
	ST_LIST_RC=0
	ST_DESCRIBE="$ST_DESCRIBE_OK"
	ST_DESCRIBE_RC=0
	ST_DELETE_RC=0

	hcloud() {
		case "$1 ${2:-}" in
		"image list")
			printf '%s\n' "$ST_LIST"
			return "$ST_LIST_RC"
			;;
		"image describe")
			printf '%s\n' "$ST_DESCRIBE"
			return "$ST_DESCRIBE_RC"
			;;
		"image delete")
			# A FILE, because this runs in a subshell. See the note above.
			echo "$3" >>"$ST_DELETES"
			return "$ST_DELETE_RC"
			;;
		*)
			echo "unexpected stub call: $*" >&2
			return 99
			;;
		esac
	}

	echo "→ hcloud-image-cache.sh self-test"

	# ── 1. The listing's four states. ──
	rows="$(cache_rows || true)"
	assert_eq "a populated cache lists every entry" "$(printf '%s\n' "$rows" | grep -c .)" "3"
	assert_eq "...and the newest of the shared key is the highest id" \
		"$(candidates_superseded "$rows" | tr '\n' ' ' | tr -s ' ' | sed 's/ $//')" "163001"

	probe_reset
	ST_LIST='[]'
	rows_empty="$(cache_rows || true)"
	assert_eq "an EMPTY cache lists nothing" "$(printf '%s' "$rows_empty" | grep -c . || true)" "0"
	if probe_has_unverifiable; then bad "an empty cache must NOT be unverifiable" "ledger is non-empty"; else ok "an empty cache is CLEAN, not unverifiable"; fi

	probe_reset
	ST_LIST=''
	ST_LIST_RC=1
	rows_failed="$(cache_rows || true)"
	assert_eq "a FAILED listing also prints nothing" "$(printf '%s' "$rows_failed" | grep -c . || true)" "0"
	# THE WHOLE POINT: identical stdout, different verdict. Without this the script would announce a
	# clean, empty cache over an account it could not read.
	if probe_has_unverifiable; then ok "...but it is UNVERIFIABLE, not clean (the two stdouts are identical)"; else bad "a failed listing must be unverifiable" "ledger empty"; fi
	rc=0
	finalize 0 || rc=$?
	assert_eq "...and finalize turns that into exit 4" "$rc" "4"

	probe_reset
	ST_LIST="$ST_LIST_JSON"
	ST_LIST_RC=0
	rc=0
	finalize 0 || rc=$?
	assert_eq "a readable cache finalizes 0" "$rc" "0"

	# ── 2. Superseded selection never touches the newest of a key. ──
	rows="$(cache_rows || true)"
	sup="$(candidates_superseded "$rows")"
	# shellcheck disable=SC2086 # unquoted on purpose: the ids must split into words.
	case " $(printf '%s ' $sup)" in
	*" 163002 "*) bad "the NEWEST of a key must never be a candidate" "163002 was selected" ;;
	*) ok "the newest of a key is never a superseded candidate" ;;
	esac
	# shellcheck disable=SC2086
	case " $(printf '%s ' $sup)" in
	*" 163003 "*) bad "a key with a single entry must yield no candidate" "163003 was selected" ;;
	*) ok "a cache key with one entry yields no candidate" ;;
	esac

	# An entry missing a key dimension is UNKEYED and must never be pruned as superseded — even when
	# another entry shares the dimensions it does have.
	unkeyed_rows="$(printf '163010\t2026-08-01\tv1.13.6\tx86\tnbg1\t-\t-\tdesc\n163011\t2026-08-02\tv1.13.6\tx86\tnbg1\taa\t-\tdesc')"
	assert_eq "an UNKEYED entry is never a superseded candidate" \
		"$(candidates_superseded "$unkeyed_rows" | tr '\n' ' ' | tr -d ' ')" ""

	# ── 3. --yes-delete is what deletes, driven through THE REAL apply_prune. ──
	#
	# Asserting on the DELETE-CALL COUNT, not on the exit code: both runs exit 0, and a version of
	# this that only checked the status would pass just as happily over a prune that deleted
	# everything without being asked.
	: >"$ST_DELETES"
	ST_DESCRIBE="$ST_DESCRIBE_OK"
	CONFIRM_DELETE=0
	rc=0
	apply_prune "$sup" "superseded" >/dev/null 2>&1 || rc=$?
	assert_eq "a prune WITHOUT --yes-delete issues no delete call" "$(grep -c . "$ST_DELETES" || true)" "0"
	assert_eq "...and still reports success" "$rc" "0"

	: >"$ST_DELETES"
	CONFIRM_DELETE=1
	rc=0
	apply_prune "$sup" "superseded" >/dev/null 2>&1 || rc=$?
	assert_eq "a prune WITH --yes-delete deletes exactly the candidates" "$(grep -c . "$ST_DELETES" || true)" "1"
	assert_eq "...and the id deleted is the SUPERSEDED one, not the newest" "$(tr -d '\n' <"$ST_DELETES")" "163001"
	assert_eq "...and it reports success" "$rc" "0"

	# A refused candidate must FAIL the prune, not be quietly skipped past a green line.
	: >"$ST_DELETES"
	ST_DESCRIBE="$ST_DESCRIBE_CLUSTERED"
	rc=0
	apply_prune "$sup" "superseded" >/dev/null 2>&1 || rc=$?
	assert_eq "a REFUSED candidate makes the whole prune fail" "$rc" "1"
	assert_eq "...and nothing was deleted" "$(grep -c . "$ST_DELETES" || true)" "0"

	CONFIRM_DELETE=0
	ST_DESCRIBE="$ST_DESCRIBE_OK"
	: >"$ST_DELETES"
	delete_one 163001 >/dev/null 2>&1 || true
	assert_eq "a confirmed delete issues exactly one delete call" "$(grep -c . "$ST_DELETES" || true)" "1"

	# ── 4. The pre-delete re-describe is a REFUSAL, not a skip. ──
	: >"$ST_DELETES"
	ST_DESCRIBE="$ST_DESCRIBE_CLUSTERED"
	rc=0
	delete_one 163001 >/dev/null 2>&1 || rc=$?
	assert_eq "an image that acquired a \`cluster\` label is REFUSED" "$rc" "1"
	assert_eq "...and no delete call was issued for it" "$(grep -c . "$ST_DELETES" || true)" "0"

	: >"$ST_DELETES"
	ST_DESCRIBE="$ST_DESCRIBE_NOT_CACHE"
	rc=0
	delete_one 999999 >/dev/null 2>&1 || rc=$?
	assert_eq "an image with no cache label is REFUSED" "$rc" "1"
	assert_eq "...and no delete call was issued for it either" "$(grep -c . "$ST_DELETES" || true)" "0"

	# A re-describe that could not answer must refuse too — "I cannot confirm what this is" is not
	# "delete it".
	probe_reset
	: >"$ST_DELETES"
	ST_DESCRIBE=''
	ST_DESCRIBE_RC=1
	rc=0
	delete_one 163001 >/dev/null 2>&1 || rc=$?
	assert_eq "an UNANSWERED re-describe REFUSES the delete" "$rc" "1"
	assert_eq "...and issued no delete call" "$(grep -c . "$ST_DELETES" || true)" "0"
	if probe_has_unverifiable; then ok "...and recorded it as unverifiable"; else bad "a failed describe must be unverifiable" "ledger empty"; fi

	unset -f hcloud
	if [ "$st_fails" -ne 0 ]; then
		echo "✗ hcloud-image-cache.sh self-test: ${st_fails} failure(s)" >&2
		exit 1
	fi
	echo "✓ hcloud-image-cache.sh self-test passed"
	exit 0
fi

# ═════════════════════════════════════════  M A I N  ═════════════════════════════════════════

echo "→ hcloud Talos image cache — selector ${IMAGE_CACHE_SELECTOR}"

rows="$(cache_rows || true)"
row_count="$(printf '%s' "$rows" | grep -c . || true)"

if [ "$row_count" -eq 0 ]; then
	# These two sentences are DIFFERENT sentences on purpose. "Nothing found" and "nothing wrong"
	# are the same stdout and must never be the same report.
	if probe_has_unverifiable; then
		echo "  ✗ the cache listing did not answer — this says NOTHING about what the account holds." >&2
	else
		echo "  · no cached Talos snapshots in this project (every apply will build one, and stamp it)."
	fi
	finalize 0
	exit $?
fi

echo "  ${row_count} cached snapshot(s):"
print_table "$rows"
report_unkeyed "$rows"

case "$MODE" in
list)
	echo
	echo "  Retention is INDEFINITE and nothing deletes these on a timer — see this file's header."
	echo "  To reclaim duplicates:  $0 --prune-superseded --yes-delete"
	echo "  To retire a version:    $0 --prune-version <talos-version> --yes-delete"
	finalize 0
	exit $?
	;;
prune-superseded)
	targets="$(candidates_superseded "$rows")"
	label="superseded (not the newest of its cache key)"
	;;
prune-version)
	targets="$(printf '%s\n' "$rows" | awk -F'\t' -v v="$PRUNE_VERSION" 'NF >= 6 && $3 == v { print $1 }' | sort -n)"
	label="Talos version ${PRUNE_VERSION}"
	;;
*)
	echo "✗ INTERNAL: unreachable mode '$MODE'" >&2
	exit 2
	;;
esac

prune_rc=0
apply_prune "$targets" "$label" || prune_rc=$?
# A real delete failure outranks "a probe could not answer" — a known problem beats an unknown one,
# and finalize is where that ordering lives.
finalize "$prune_rc"
exit $?
