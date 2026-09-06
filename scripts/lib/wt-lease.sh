#!/usr/bin/env bash
# shellcheck shell=bash
#
# Worktree-ownership lease — "who is working in this worktree right now".
#
# WHY THIS EXISTS. On 2026-07-26 two Claude instances worked one worktree at once: the second ran
# `pnpm wt <name>`, was handed the first's live tree ("already exists … Reusing it"), edited files
# in it, then `git add` + `git commit` swept the first instance's UNCOMMITTED work into a commit
# under the second's message, and force-pushed. Nothing blocked any step — CLAUDE.md said "never
# touch another instance's worktree", but nothing enforced it. This is the enforcement.
#
# WHY ONE SHARED FILE, against the repo's copy-paste-the-lock convention. compose-up.sh,
# db-generate.sh, dev-up.sh, dev-runner.sh and claim-work.sh each inline their own mkdir-lock, and
# that is FINE: they are five independent locks over five different subjects, so drift between them
# is harmless. This is the opposite — ONE protocol with four call sites (the PreToolUse hook,
# worktree.sh, pre-commit, pre-push). A staleness rule that drifts between those call sites is a
# silent false-allow, which is to say: the incident again. So it lives here, once.
#
# THE MODEL
#   identity  = (host, agent PID, procStart)   — the Claude/Codex agent process, not the session.
#   lease     = <worktree>/.git-admin-dir/alethia-lease/owner
#   liveness  = `ps -o lstart=` on the holder pid matches the recorded procStart.
#
# Outside Claude/Codex, both agent markers are unset → no lease is taken and nothing is blocked.
# Humans and CI are not gated by this file, by design.
#
# Usage (source it):
#   . scripts/lib/wt-lease.sh
#   wt_lease_acquire "$dir"   # 0 = mine · 1 = held by a LIVE foreign instance · 2 = not a worktree
#   # on rc=1 the WT_L_* vars describe the holder, for the message.
#
# Self-test: bash scripts/lib/wt-lease.sh --self-test

# ── identity ────────────────────────────────────────────────────────────────────────────────────

# The agent process id. Claude supplies CLAUDE_PID; Codex supplies a session marker and the hook
# adapter supplies CODEX_PID or its parent process id. This lets hooks and worktree.sh agree on
# ownership without making humans or CI acquire leases.
#
# NOT the session id. A Task subagent gets its own CLAUDE_CODE_SESSION_ID but shares its parent's
# CLAUDE_PID — key the lease on the session and every subagent looks foreign inside its own
# parent's worktree. Ownership is per INSTANCE.
wt_self_pid() {
	if [ -n "${CLAUDE_PID:-}" ]; then
		printf '%s' "$CLAUDE_PID"
	elif [ -n "${CODEX_SESSION_ID:-${CODEX_THREAD_ID:-}}" ]; then
		if [ -n "${CODEX_PID:-}" ]; then
			printf '%s' "$CODEX_PID"
		else
			local agent_pid
			agent_pid="$(wt_find_agent_pid)"
			printf '%s' "${agent_pid:-${PPID:-}}"
		fi
	fi
}

wt_host() { hostname -s 2>/dev/null || hostname 2>/dev/null || echo unknown; }

# Find the owning Claude/Codex process when a Git hook has stripped the adapter's explicit PID.
# Git launches hooks below an intermediate git process, so using PPID directly identifies git (or
# the shell that launched it) and makes the current instance look like a foreign lease.
wt_find_agent_pid() {
	local pid="${PPID:-}" command
	local depth=0
	while [ -n "$pid" ] && [ "$depth" -lt 16 ]; do
		command="$(ps -o comm= -p "$pid" 2>/dev/null | tr -d '[:space:]')"
		case "$command" in
			codex | claude | claude-code)
				printf '%s' "$pid"
				return 0
				;;
		esac
		pid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d '[:space:]')"
		depth=$((depth + 1))
	done
}

# A process's start time, whitespace-normalised. Identifies the INCARNATION, so a recycled pid can
# never inherit a dead instance's lease. Empty when the pid is gone. Works on BSD and GNU ps.
wt_procstart() {
	[ -n "${1:-}" ] || return 0
	ps -o lstart= -p "$1" 2>/dev/null | tr -s '[:space:]' ' ' | sed 's/^ //; s/ *$//'
}

# ── lease location ──────────────────────────────────────────────────────────────────────────────

# The lease lives in the worktree's GIT ADMIN DIR (…/app/.git/worktrees/<name>/alethia-lease), not
# in /tmp and not in the working tree:
#   · repo-scoped by construction — two repos with a same-named worktree cannot collide;
#   · outside the working tree — never staged, never in `git status`, needs no .gitignore;
#   · `git worktree remove` / `prune` delete it for free, so removal IS the release path.
# Returns non-zero for the MAIN checkout, which is deliberately shared and is governed instead by
# the pre-commit R2 / hook main-checkout rule.
wt_lease_dir() { # <worktree-path>
	local gd gcd
	gd="$(git -C "${1:-.}" rev-parse --absolute-git-dir 2>/dev/null)" || return 1
	gcd="$(git -C "${1:-.}" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || return 1
	[ -n "$gd" ] || return 1
	[ "$gd" = "$gcd" ] && return 1 # main checkout — not leasable
	printf '%s/alethia-lease' "$gd"
}

# ── read / write ────────────────────────────────────────────────────────────────────────────────

# Populates WT_L_* from a lease dir. Non-zero when there is no readable owner file (which includes
# the brief window where a racer has mkdir'd but not yet renamed its owner into place).
wt_lease_read() { # <lease-dir>
	WT_L_PID=""; WT_L_PS=""; WT_L_HOST=""; WT_L_SESSION=""; WT_L_BRANCH=""; WT_L_AT=""
	[ -f "$1/owner" ] || return 1
	local k v
	while IFS=: read -r k v; do
		v="${v# }"
		case "$k" in
			pid) WT_L_PID="$v" ;;
			procStart) WT_L_PS="$v" ;;
			host) WT_L_HOST="$v" ;;
			session) WT_L_SESSION="$v" ;;
			branch) WT_L_BRANCH="$v" ;;
			acquiredAt) WT_L_AT="$v" ;;
		esac
	done <"$1/owner"
	[ -n "$WT_L_PID" ]
}

# Flat `key: value` — mirrors claim-work.sh's lease_body(), and keeps the read path free of jq (the
# PreToolUse hook must run with no dependencies). Written to a temp name and renamed, so a reader
# never sees a half-written owner file.
wt_lease_write() { # <lease-dir> <worktree-path>
	local pid ps
	pid="$(wt_self_pid)"
	ps="$(wt_procstart "$pid")"
	{
		echo "pid: $pid"
		echo "procStart: $ps"
		echo "host: $(wt_host)"
		echo "session: ${CLAUDE_CODE_SESSION_ID:-${CODEX_SESSION_ID:-${CODEX_THREAD_ID:-}}}"
		echo "branch: $(git -C "$2" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
		echo "worktree: $2"
		echo "acquiredAt: $(date +%s)"
	} >"$1/.owner.$$" 2>/dev/null || return 1
	mv -f "$1/.owner.$$" "$1/owner" 2>/dev/null
}

# ── liveness ────────────────────────────────────────────────────────────────────────────────────

# Is the recorded holder still running? Exact, not heuristic — a worktree is a local directory, so
# the real oracle (ps) is available and there is no reason to guess with a TTL.
#
# NOT `kill -0`: that returns EPERM for a live process owned by another uid, which would read as
# "dead" and hand one user's worktree to another. `ps -o lstart=` answers existence AND incarnation
# in one call with no permission dependency.
#
# A lease stamped by another HOST is treated as permanently live: we cannot see that box's process
# table, and a false allow there is worse than a wedge (which `wt:steal` clears).
wt_lease_live() {
	[ -n "${WT_L_PID:-}" ] || return 1
	if [ -n "${WT_L_HOST:-}" ] && [ "$WT_L_HOST" != "$(wt_host)" ]; then return 0; fi
	if [ -n "${WT_L_PS:-}" ]; then
		[ "$(wt_procstart "$WT_L_PID")" = "$WT_L_PS" ]
	else
		# Legacy/partial lease with no procStart — fall back to existence alone.
		[ -n "$(wt_procstart "$WT_L_PID")" ]
	fi
}

wt_lease_is_mine() {
	local me
	me="$(wt_self_pid)"
	[ -n "$me" ] && [ "${WT_L_PID:-}" = "$me" ] && [ "${WT_L_HOST:-}" = "$(wt_host)" ]
}

# ADVISORY ONLY. `seen` feeds the "last active 4m ago" line in the deny message so a human can judge
# a live-but-abandoned holder. It MUST NOT influence allow/deny — the moment it does, this becomes a
# TTL and inherits every failure mode (a 40-minute build with no tool calls gets its tree stolen)
# that pid+procStart exists to avoid.
wt_lease_touch() { # <lease-dir>
	local now last
	now="$(date +%s)"
	last="$(cat "$1/seen" 2>/dev/null || echo 0)"
	[ $((now - ${last:-0})) -ge 60 ] && echo "$now" >"$1/seen" 2>/dev/null
	return 0
}

# ── acquire ─────────────────────────────────────────────────────────────────────────────────────

# 0 = the worktree is mine now (fresh, already mine, or reclaimed from a dead holder)
# 1 = held by a LIVE foreign instance; WT_L_* describe the holder
# 2 = not a linked worktree (the main checkout, or not a repo) — nothing to lease
wt_lease_acquire() { # <worktree-path>
	local wt="$1" ld me tries=0
	ld="$(wt_lease_dir "$wt")" || return 2
	me="$(wt_self_pid)"
	# Not running under Claude → take no lease and never block. Humans and CI are not gated.
	[ -n "$me" ] || return 0
	[ "${ALETHIA_ALLOW_FOREIGN_WT:-}" = "1" ] && return 0

	while :; do
		if mkdir "$ld" 2>/dev/null; then
			wt_lease_write "$ld" "$wt"
			return 0
		fi
		if wt_lease_read "$ld"; then
			if wt_lease_is_mine; then
				wt_lease_touch "$ld"
				return 0
			fi
			wt_lease_live && return 1
			# Holder is gone. Drop the lease and re-loop; the mkdir above arbitrates the race, so
			# two reclaimers can't both believe they won.
			rm -rf "$ld" 2>/dev/null || true
		else
			# Dir exists but owner isn't readable yet — a racer mid-acquire. Give it a moment.
			tries=$((tries + 1))
			if [ "$tries" -lt 3 ]; then
				sleep 1
				continue
			fi
			rm -rf "$ld" 2>/dev/null || true
		fi
		tries=$((tries + 1))
		[ "$tries" -gt 6 ] && return 1
	done
}

# Hand a worktree back deliberately (nothing depends on this — process death already frees it).
wt_lease_release() { # <worktree-path>
	local ld
	ld="$(wt_lease_dir "$1")" || return 0
	wt_lease_read "$ld" || { rm -rf "$ld" 2>/dev/null; return 0; }
	if wt_lease_is_mine || ! wt_lease_live; then
		rm -rf "$ld" 2>/dev/null
		return 0
	fi
	return 1 # someone else's live lease — not ours to drop
}

# ── reporting helpers (message text only) ───────────────────────────────────────────────────────

wt_ago() { # <epoch> -> "3h12m" / "4m" / "12s"
	local now d
	now="$(date +%s)"
	d=$((now - ${1:-$now}))
	[ "$d" -lt 0 ] && d=0
	if [ "$d" -ge 3600 ]; then
		printf '%dh%dm' $((d / 3600)) $(((d % 3600) / 60))
	elif [ "$d" -ge 60 ]; then
		printf '%dm' $((d / 60))
	else
		printf '%ds' "$d"
	fi
}

wt_lease_age() { [ -n "${WT_L_AT:-}" ] && wt_ago "$WT_L_AT" || printf '?'; }

wt_lease_idle() { # <lease-dir>
	local s
	s="$(cat "$1/seen" 2>/dev/null || echo '')"
	[ -n "$s" ] && wt_ago "$s" || printf 'unknown'
}

# ── worktree-root resolution ────────────────────────────────────────────────────────────────────

# All worktree roots, one per line. Cached per process — the hook calls this on every tool use.
# git reports these as PHYSICAL paths (symlinks resolved), which is why wt_abs must use `pwd -P`
# for the other side of the comparison.
wt_roots() {
	[ -n "${WT_ROOTS_CACHE:-}" ] || WT_ROOTS_CACHE="$(git -C "${CLAUDE_PROJECT_DIR:-.}" worktree list --porcelain 2>/dev/null | sed -n 's/^worktree //p')"
	printf '%s' "$WT_ROOTS_CACHE"
}

# The worktree root containing <abs-path>, or empty.
#
# LONGEST prefix, not first match: the harness creates its own worktrees under
# app/.claude/worktrees/<name>, i.e. NESTED INSIDE the main checkout. A first-match scan maps every
# such path to `app` and the guard silently does nothing for exactly the agents most likely to
# collide.
wt_root_of() { # <abs-path>
	local p="$1" best="" r
	[ -n "$p" ] || return 0
	while IFS= read -r r; do
		[ -n "$r" ] || continue
		case "$p/" in
			"$r"/*) [ "${#r}" -gt "${#best}" ] && best="$r" ;;
		esac
	done <<EOF
$(wt_roots)
EOF
	printf '%s' "$best"
}

# Absolute path for a possibly-relative, possibly-not-yet-existing path: resolve the nearest
# existing ancestor (a Write to a new file still has to map to its worktree).
wt_abs() { # <path> [base]
	local p="$1" base="${2:-$PWD}" head tail=""
	case "$p" in /*) ;; *) p="$base/$p" ;; esac
	head="$p"
	while [ -n "$head" ] && [ "$head" != "/" ] && [ ! -e "$head" ]; do
		tail="/$(basename "$head")$tail"
		head="$(dirname "$head")"
	done
	if [ -d "$head" ]; then
		# `pwd -P`, not `pwd`: git worktree list reports PHYSICAL paths, and on macOS /var and /tmp
		# are symlinks (/var/… vs /private/var/…). Comparing a logical path against a physical root
		# never prefix-matches, which silently disables the whole guard.
		printf '%s%s' "$(cd "$head" 2>/dev/null && pwd -P)" "$tail"
	else
		printf '%s' "$p"
	fi
}

# ── self-test ───────────────────────────────────────────────────────────────────────────────────

wt_self_test() {
	local fails=0 tmp me
	_a() { if [ "$1" = "$2" ]; then echo "ok   - $3"; else
		echo "FAIL - $3: want '$1' got '$2'" >&2
		fails=$((fails + 1))
	fi; }

	tmp="$(mktemp -d)"
	trap 'rm -rf "$tmp"' RETURN
	git init -q "$tmp/main" 2>/dev/null
	(cd "$tmp/main" && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init)
	git -C "$tmp/main" worktree add -q -b wtlease "$tmp/wt" 2>/dev/null

	# The main checkout is never leasable.
	wt_lease_acquire "$tmp/main" >/dev/null 2>&1
	_a "2" "$?" "main checkout is not leasable"

	# No agent marker → no lease, no block (humans / CI). Clear Codex markers too when the
	# self-test itself is launched from a Codex session.
	(CLAUDE_PID="" CODEX_PID="" CODEX_SESSION_ID="" CODEX_THREAD_ID="" wt_lease_acquire "$tmp/wt" >/dev/null 2>&1)
	_a "0" "$?" "outside Claude: no lease taken, never blocks"

	# Git hooks lose CODEX_PID but retain the session marker; recover the Codex ancestor rather than
	# treating the hook's immediate parent as a different instance.
	if [ -n "${CODEX_SESSION_ID:-${CODEX_THREAD_ID:-}}" ] && [ -z "${CODEX_PID:-}" ]; then
		_a "$(wt_find_agent_pid)" "$(wt_self_pid)" "Codex ancestry supplies the lease identity"
	fi

	# Fresh acquire, then re-acquire is idempotent.
	me="$$"
	CLAUDE_PID="$me" wt_lease_acquire "$tmp/wt" >/dev/null 2>&1
	_a "0" "$?" "fresh worktree acquires"
	CLAUDE_PID="$me" wt_lease_acquire "$tmp/wt" >/dev/null 2>&1
	_a "0" "$?" "re-acquire by the same instance is mine"

	local ld
	ld="$(wt_lease_dir "$tmp/wt")"

	# A LIVE foreign holder blocks. pid 1 is always alive and is never us.
	{
		echo "pid: 1"
		echo "procStart: $(wt_procstart 1)"
		echo "host: $(wt_host)"
	} >"$ld/owner"
	CLAUDE_PID="$me" wt_lease_acquire "$tmp/wt" >/dev/null 2>&1
	_a "1" "$?" "live foreign holder blocks"

	# Pid reuse: same pid, different incarnation → stale, reclaimed.
	{
		echo "pid: 1"
		echo "procStart: Thu Jan  1 00:00:00 1970"
		echo "host: $(wt_host)"
	} >"$ld/owner"
	CLAUDE_PID="$me" wt_lease_acquire "$tmp/wt" >/dev/null 2>&1
	_a "0" "$?" "pid reuse caught by procStart → reclaimed"

	# A dead holder is reclaimed.
	{
		echo "pid: 999999"
		echo "procStart: Thu Jan  1 00:00:00 1970"
		echo "host: $(wt_host)"
	} >"$ld/owner"
	CLAUDE_PID="$me" wt_lease_acquire "$tmp/wt" >/dev/null 2>&1
	_a "0" "$?" "dead holder reclaimed"

	# Half-written lease (dir, no owner) is recovered rather than wedging.
	rm -rf "$ld" && mkdir -p "$ld"
	CLAUDE_PID="$me" wt_lease_acquire "$tmp/wt" >/dev/null 2>&1
	_a "0" "$?" "half-written lease recovered"

	# Another host is treated as live — never steal what we can't see.
	{
		echo "pid: 1"
		echo "procStart: x"
		echo "host: some-other-box"
	} >"$ld/owner"
	CLAUDE_PID="$me" wt_lease_acquire "$tmp/wt" >/dev/null 2>&1
	_a "1" "$?" "foreign host is never stolen"

	# Escape hatch.
	{
		echo "pid: 1"
		echo "procStart: $(wt_procstart 1)"
		echo "host: $(wt_host)"
	} >"$ld/owner"
	(CLAUDE_PID="$me" ALETHIA_ALLOW_FOREIGN_WT=1 wt_lease_acquire "$tmp/wt" >/dev/null 2>&1)
	_a "0" "$?" "ALETHIA_ALLOW_FOREIGN_WT=1 overrides"

	# Longest-prefix root matching (the nested-worktree trap).
	WT_ROOTS_CACHE="$(printf '%s\n%s' "/a/app" "/a/app/.claude/worktrees/x")"
	_a "/a/app/.claude/worktrees/x" "$(wt_root_of /a/app/.claude/worktrees/x/lib/f.ts)" "nested worktree wins on longest prefix"
	_a "/a/app" "$(wt_root_of /a/app/lib/f.ts)" "main checkout path maps to main"
	_a "" "$(wt_root_of /somewhere/else/f.ts)" "path outside every worktree maps to nothing"
	WT_ROOTS_CACHE=""

	git -C "$tmp/main" worktree remove --force "$tmp/wt" 2>/dev/null || true
	[ "$fails" = 0 ] && echo "wt-lease self-test: all passed" || echo "wt-lease self-test: $fails failed" >&2
	return "$fails"
}

# Only when executed directly, never when sourced.
case "${BASH_SOURCE[0]}" in
	"$0") [ "${1:-}" = "--self-test" ] && wt_self_test ;;
esac
