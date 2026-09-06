#!/usr/bin/env bash
# shellcheck shell=bash
#
# "Who holds this environment", and the reap decision built on it.
#
# WHY THIS EXISTS. `scripts/env.sh` refuses to reap the sandbox box when someone else is working on
# it — "Reaping deletes the box for everyone, so this is refused even with --now." The test was
# `.value.owner != $me` against
#
#     owner() { printf '%s@%s' "$(id -un)" "$(hostname -s)"; }
#
# and EVERY agent, worktree and shell on one machine produces that same string. So `others` was
# always empty and the guard was unreachable between two local instances: it only ever protected
# against a different MACHINE. On 2026-09-02 one lane finished, ran `pnpm env:reap --now`, and
# deleted the box out from under another lane's seconds-old environment that was serving an
# authenticated browser session. The reaping lane did nothing wrong (#3841).
#
# THE FIX IS NOT A NEW SCHEME. `scripts/lib/wt-lease.sh` already answers "which instance is this"
# precisely enough for `pnpm wt:who` to print "LIVE pid 16513 on MacBook-Air-2 ← you". Two isolation
# primitives on the same box disagreeing about what "who" means IS the defect, so this file reuses
# that identity rather than inventing a second one.
#
# THE IDENTITY
#   under an agent  user@host#<agent-pid>.<procStart-digest>   — one instance, one incarnation
#   otherwise       user@host                                  — a human shell, CI, the launchd timer
#
# The bare form is deliberate for humans: a terminal invocation is a fresh, short-lived process, so
# a pid-keyed identity would never match itself twice and the maintainer could not reap their own
# box. It is also, byte for byte, what the OLD scheme wrote — which settles backward compatibility
# in the safe direction and is the whole reason the classifier is plain string equality:
#
#   · an AGENT (`me` carries '#') never equals a pre-#3841 `user@host` row, so a legacy entry reads
#     as SOMEONE ELSE and is refused. An unrecognised owner is never silently "mine".
#   · a HUMAN on the same box equals it, which is exactly what the old behaviour was for them, and
#     was never the incident.
#   · a `user@host` from a DIFFERENT host still differs, so the original cross-machine protection is
#     unchanged.
#
# Usage (source it):
#   . scripts/lib/env-owner.sh
#   env_owner                                            # this instance's registry owner string
#   env_reap_verdict "$registry_json" "$me" "$cut" 0|1   # allow | refuse-others | refuse-mine | refuse-unreadable
#
# Self-test (hermetic — no box, no ssh, no network):
#   bash scripts/lib/env-owner.sh --self-test

# shellcheck source=scripts/lib/wt-lease.sh
. "$(dirname "${BASH_SOURCE[0]}")/wt-lease.sh"

# ── identity ────────────────────────────────────────────────────────────────────────────────────

# The registry `owner` value for whoever is running right now.
#
# The digest is of `ps -o lstart=`, i.e. the INCARNATION, for the same reason wt-lease.sh records
# procStart: a recycled pid must not inherit a dead instance's environment. `cksum` because it is
# POSIX and present on both the Mac and the box, and because this only has to separate identities,
# not resist an adversary. No spaces, no quotes: the value is passed through `ssh <box> "…'$owner'"`.
env_owner() {
	local base pid ps
	base="$(id -un)@$(wt_host)"
	pid="$(wt_self_pid)"
	[ -n "$pid" ] || {
		printf '%s' "$base"
		return 0
	}
	ps="$(wt_procstart "$pid")"
	printf '%s#%s.%s' "$base" "$pid" "$(printf '%s' "$ps" | cksum | cut -d' ' -f1)"
}

# ── the reap decision ───────────────────────────────────────────────────────────────────────────

# Every environment in the registry, classified against `me`. TSV: class, slug, owner, lastSeen,
# live|idle.
#
#   mine          this instance's own environment
#   other         another instance, attributable (its owner carries the '#' marker)
#   legacy        a pre-#3841 `user@host` owner that is not mine — NOT attributable, treated as
#                 someone else's on purpose
#   unattributed  no owner recorded at all — also someone else's
#
# `live` is lastSeen inside the caller's cutoff. String comparison on the ISO-8601 stamps the
# registry writes, which sort lexicographically because they are always Zulu and zero-padded.
env_reap_rows() { # <registry-json> <me> <cutoff-iso>
	printf '%s' "$1" | jq -r --arg me "$2" --arg cut "$3" '
		to_entries[]
		| (.value.owner // "") as $o
		| [ (if   $o == ""          then "unattributed"
		     elif $o == $me         then "mine"
		     elif ($o | test("#"))  then "other"
		     else                        "legacy" end),
		    .key,
		    (if $o == "" then "(no owner recorded)" else $o end),
		    (.value.lastSeen // ""),
		    (if (.value.lastSeen // "") > $cut then "live" else "idle" end) ]
		| @tsv'
}

# TSV rows on stdin → one indented human line each.
env_reap_render() {
	awk -F'\t' '{
		mark = ""
		if ($1 == "mine")              mark = "   ← you"
		else if ($1 == "legacy")       mark = "   ← legacy user@host owner, not attributable to an instance"
		else if ($1 == "unattributed") mark = "   ← no owner recorded"
		printf "  %-22s %-46s last seen %s  (%s)%s\n", $2, $3, ($4 == "" ? "never" : $4), $5, mark
	}'
}

# The whole decision, as one testable function. Prints a verdict word; the exit code carries it too
# so a caller can branch on either.
#
#   allow             0   nothing live — reaping destroys only idle environments
#   refuse-others     3   someone else is live. Refused, and `--now` is not a way around it.
#   refuse-mine       4   only MY environments are live. Reaping deletes the box for everyone,
#                         including them, so a lane that owns both has to say so explicitly.
#   refuse-unreadable 3   the registry did not parse. Fails CLOSED: assume someone is there.
env_reap_verdict() { # <registry-json> <me> <cutoff-iso> <include-mine 0|1>
	local rows others mine
	# Assigned on its own line, never `local rows="$(…)"`: `local` is a command and would swallow
	# jq's exit status, turning an unparseable registry into a silent "allow".
	rows="$(env_reap_rows "$1" "$2" "$3" 2>/dev/null)" || {
		echo "refuse-unreadable"
		return 3
	}
	others="$(printf '%s\n' "$rows" | awk -F'\t' '$5 == "live" && $1 != "mine"')"
	mine="$(printf '%s\n' "$rows" | awk -F'\t' '$5 == "live" && $1 == "mine"')"
	if [ -n "$others" ]; then
		echo "refuse-others"
		return 3
	fi
	if [ -n "$mine" ] && [ "${4:-0}" != "1" ]; then
		echo "refuse-mine"
		return 4
	fi
	echo "allow"
	return 0
}

# ── self-test ───────────────────────────────────────────────────────────────────────────────────

env_owner_self_test() {
	local fails=0
	_a() { if [ "$1" = "$2" ]; then echo "ok   - $3"; else
		echo "FAIL - $3: want '$1' got '$2'" >&2
		fails=$((fails + 1))
	fi; }
	# Verdict + exit code in one string, so a test can never assert the word while the caller
	# branches on a different code.
	_v() { # <json> <me> <cut> <include-mine> → "<verdict>/<rc>"
		local out rc=0
		out="$(env_reap_verdict "$1" "$2" "$3" "${4:-0}")" || rc=$?
		printf '%s/%s' "$out" "$rc"
	}

	local host cut old new_a new_b
	host="$(id -un)@$(wt_host)"
	cut="2026-09-02T12:00:00Z"

	# ── identity ────────────────────────────────────────────────────────────────────────────
	# THE DEFECT ITSELF: two instances on ONE host must not produce one string. $$ and the pid of
	# a `sleep` we own are two live, different processes on this machine.
	old="$(CLAUDE_PID="" CODEX_PID="" CODEX_SESSION_ID="" CODEX_THREAD_ID="" env_owner)"
	_a "$host" "$old" "outside an agent the owner is bare user@host (humans, CI, the timer)"

	new_a="$(CLAUDE_PID="$$" env_owner)"
	sleep 30 &
	local other_pid=$!
	new_b="$(CLAUDE_PID="$other_pid" env_owner)"
	kill "$other_pid" 2>/dev/null || true
	wait "$other_pid" 2>/dev/null || true

	_a "1" "$(printf '%s' "$new_a" | grep -c '#')" "under an agent the owner carries an instance marker"
	if [ "$new_a" != "$new_b" ]; then
		_a "differ" "differ" "two instances on ONE host get DIFFERENT owners (#3841)"
	else
		_a "differ" "identical: $new_a" "two instances on ONE host get DIFFERENT owners (#3841)"
	fi
	_a "$new_a" "$(CLAUDE_PID="$$" env_owner)" "an instance's owner is stable across calls"
	if [ "$new_a" != "$old" ]; then
		_a "differ" "differ" "an agent owner is never the legacy user@host string"
	else
		_a "differ" "identical" "an agent owner is never the legacy user@host string"
	fi

	# ── the reap decision ───────────────────────────────────────────────────────────────────
	local me="u@h#100.111" them="u@h#200.222"
	local live="2026-09-02T13:00:00Z" idle="2026-09-02T09:00:00Z"

	_a "allow/0" "$(_v '{}' "$me" "$cut")" "an empty registry reaps"
	_a "allow/0" "$(_v "{\"a\":{\"owner\":\"$them\",\"lastSeen\":\"$idle\"}}" "$me" "$cut")" \
		"another instance's IDLE env does not block"

	# The refusal that could not fire before this change.
	_a "refuse-others/3" "$(_v "{\"a\":{\"owner\":\"$them\",\"lastSeen\":\"$live\"}}" "$me" "$cut")" \
		"another instance's LIVE env refuses the reap"
	_a "refuse-others/3" "$(_v "{\"a\":{\"owner\":\"$them\",\"lastSeen\":\"$live\"}}" "$me" "$cut" 1)" \
		"--include-mine does NOT unlock someone else's live env"

	# Backward compatibility: a pre-#3841 row is unattributable, so it is someone else's.
	_a "refuse-others/3" "$(_v "{\"a\":{\"owner\":\"$host\",\"lastSeen\":\"$live\"}}" "$new_a" "$cut")" \
		"a LEGACY user@host owner is not silently mine (agent)"
	_a "legacy" "$(env_reap_rows "{\"a\":{\"owner\":\"$host\",\"lastSeen\":\"$live\"}}" "$new_a" "$cut" | cut -f1)" \
		"a legacy row is classified legacy, so the message can say why"
	_a "refuse-others/3" "$(_v '{"a":{"lastSeen":"'"$live"'"}}' "$me" "$cut")" \
		"a row with NO owner at all is someone else's"

	# A human shell keeps the old semantics: their own bare-owner env is theirs.
	_a "refuse-mine/4" "$(_v "{\"a\":{\"owner\":\"$host\",\"lastSeen\":\"$live\"}}" "$host" "$cut")" \
		"a human's own bare-owner env is mine, and still stops --now"
	_a "allow/0" "$(_v "{\"a\":{\"owner\":\"$host\",\"lastSeen\":\"$live\"}}" "$host" "$cut" 1)" \
		"…and --include-mine lets the human through"

	# My own live env is a reason to stop and ask: reaping deletes it too.
	_a "refuse-mine/4" "$(_v "{\"a\":{\"owner\":\"$me\",\"lastSeen\":\"$live\"}}" "$me" "$cut")" \
		"my OWN live env blocks --now until I say so"
	_a "allow/0" "$(_v "{\"a\":{\"owner\":\"$me\",\"lastSeen\":\"$live\"}}" "$me" "$cut" 1)" \
		"--include-mine reaps my own live env"
	_a "allow/0" "$(_v "{\"a\":{\"owner\":\"$me\",\"lastSeen\":\"$idle\"}}" "$me" "$cut")" \
		"my own IDLE env does not need the flag"

	# Someone else wins over me: the flag must not become a general override.
	_a "refuse-others/3" \
		"$(_v "{\"a\":{\"owner\":\"$me\",\"lastSeen\":\"$live\"},\"b\":{\"owner\":\"$them\",\"lastSeen\":\"$live\"}}" "$me" "$cut" 1)" \
		"mine + theirs live, --include-mine: still refused for THEM"

	# Fails closed. A registry that does not parse must never read as "nobody is here".
	_a "refuse-unreadable/3" "$(_v 'not json at all' "$me" "$cut" 1)" \
		"an unparseable registry fails CLOSED, even with --include-mine"

	# The manifest names every env the reap would destroy — including idle ones, which die too.
	local manifest
	manifest="$(env_reap_rows \
		"{\"a\":{\"owner\":\"$me\",\"lastSeen\":\"$live\"},\"b\":{\"owner\":\"$them\",\"lastSeen\":\"$idle\"}}" \
		"$me" "$cut" | env_reap_render)"
	_a "2" "$(printf '%s\n' "$manifest" | grep -c .)" "the manifest lists idle envs too — the box takes them with it"
	_a "1" "$(printf '%s\n' "$manifest" | grep -c '← you')" "the manifest marks which env is yours"

	[ "$fails" = 0 ] && echo "env-owner self-test: all passed" || echo "env-owner self-test: $fails failed" >&2
	return "$fails"
}

# Only when executed directly, never when sourced.
case "${BASH_SOURCE[0]}" in
"$0") [ "${1:-}" = "--self-test" ] && env_owner_self_test ;;
esac
