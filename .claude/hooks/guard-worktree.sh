#!/usr/bin/env bash
# PreToolUse guard: keep parallel Claude instances out of each other's trees.
#
# Three rules, in order:
#   R-LEASE  don't write inside a worktree another LIVE instance is working in.
#   R-STASH  don't mutate the repository-wide stash while another worktree is live.
#   R-MAIN   don't `git commit` / `git add -A` / `git rebase` in the shared main checkout.
#
# R-LEASE exists because R-MAIN wasn't enough. On 2026-07-26 a second instance ran
# `pnpm wt <name>`, was handed the first's live worktree ("already exists … Reusing it"), edited
# files in it, and committed the first instance's UNCOMMITTED work under its own message. Every
# step passed this hook, because the only question it asked was "is this A worktree?" — never "is
# it MINE?" — and because the hook was wired for Bash alone, so the Write/Edit calls that did most
# of the damage were never seen at all.
#
# Wired for Bash AND Write|Edit|MultiEdit|NotebookEdit|EnterWorktree (see .claude/settings.json).
# Exit 2 = block the tool call and surface stderr to the model. Exit 0 = allow.
# Mirrors .claude/hooks/guard-compose.sh.
# ── --self-test ───────────────────────────────────────────────────────────────────────────────
#
# This guard had NONE, alone among the four in .claude/hooks/, and it is the one with the most
# moving parts: two rules, a quote-stripped scan, a target resolver, and a fail-closed fall-through.
# Every defect fixed here (#3192) was found by tripping over it in ordinary work rather than by
# anything checking, and two of them had been shipped for weeks.
#
# Builds a REAL main checkout and a REAL linked worktree in a tmpdir, then feeds the hook the same
# JSON the harness does. Hermetic: no network, no shared box, no repo state.
if [ "${1:-}" = "--self-test" ]; then
	# Two shellcheck notes are deliberate here, not oversights:
	#   SC1007 — `ALETHIA_ALLOW_MAIN_COMMIT='' bash "$self"` CLEARS the override for the child,
	#            the same idiom guard-merge.sh's self-test uses.
	#   SC2016 — the single-quoted `$W` in the fixtures is the WHOLE POINT: these cases exist
	#            to prove the hook handles an UNEXPANDED variable. Expanding it would delete
	#            the test.
	# shellcheck disable=SC1007,SC2016
	self="${BASH_SOURCE[0]}"
	case "$self" in /*) ;; *) self="$PWD/$self" ;; esac
	tmp="$(mktemp -d)"
	trap 'rm -rf "$tmp"' EXIT
	main="$tmp/main"
	mkdir -p "$main"
	(
		cd "$main" || exit 1
		git init -q .
		git config user.email t@t.test
		git config user.name t
		echo x >f
		git add f
		git -c commit.gpgsign=false commit -qm init
		git worktree add -q "$tmp/wt-mine" -b feat/mine
		git worktree add -q "$tmp/wt-other" -b feat/other
	) >/dev/null 2>&1 || {
		echo "self-test: could not build the git fixture" >&2
		exit 1
	}

	pass=0
	fail=0
	t() { # <block|allow> <label> <command>
		local got rc out
		out="$(printf '{"tool_name":"Bash","tool_input":{"command":%s}}' \
			"$(printf '%s' "$3" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')" |
			CLAUDE_PROJECT_DIR="$main" ALETHIA_ALLOW_MAIN_COMMIT='' bash "$self" 2>&1)"
		rc=$?
		[ "$rc" = 2 ] && got=block || got=allow
		if [ "$got" = "$1" ]; then
			pass=$((pass + 1))
			printf '  ok   - %s\n' "$2"
		else
			fail=$((fail + 1))
			printf '  FAIL - %s (want=%s got=%s)\n    %s\n' "$2" "$1" "$got" "$out" >&2
		fi
	}
	# Like t(), but runs the hook under EXTRA environment (trailing VAR=VAL arguments). The fixture
	# lease is stamped with the self-test shell's `$$`, which is never the hook child's CLAUDE_PID,
	# so every lease it writes is FOREIGN by construction — the identity and escape-hatch branches
	# are unreachable without this, which is exactly how they shipped broken.
	t_as() { # <block|allow> <label> <command> [VAR=VAL …]
		local want="$1" label="$2" c="$3" got rc out
		shift 3
		out="$(printf '{"tool_name":"Bash","tool_input":{"command":%s}}' \
			"$(printf '%s' "$c" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')" |
			env CLAUDE_PROJECT_DIR="$main" ALETHIA_ALLOW_MAIN_COMMIT= "$@" bash "$self" 2>&1)"
		rc=$?
		[ "$rc" = 2 ] && got=block || got=allow
		if [ "$got" = "$want" ]; then
			pass=$((pass + 1))
			printf '  ok   - %s\n' "$label"
		else
			fail=$((fail + 1))
			printf '  FAIL - %s (want=%s got=%s)\n    %s\n' "$label" "$want" "$got" "$out" >&2
		fi
	}
	# Asserts on the MESSAGE, not just the verdict — a refusal that names the wrong cause is the
	# defect this round is about, and a verdict-only test cannot see it.
	says() { # <substring> <label> <command>
		local out
		out="$(printf '{"tool_name":"Bash","tool_input":{"command":%s}}' \
			"$(printf '%s' "$3" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')" |
			CLAUDE_PROJECT_DIR="$main" ALETHIA_ALLOW_MAIN_COMMIT='' bash "$self" 2>&1)"
		case "$out" in
		*"$1"*)
			pass=$((pass + 1))
			printf '  ok   - %s\n' "$2"
			;;
		*)
			fail=$((fail + 1))
			printf '  FAIL - %s (message did not mention "%s")\n    %s\n' "$2" "$1" "$out" >&2
			;;
		esac
	}

	echo "guard-worktree --self-test"

	# ── R-MAIN: the rule this hook exists for. Regressing any of these is the whole cost. ──
	t block  'a bare commit in the main checkout'            'git commit -m x'
	t block  'git add -A in the main checkout'               'git add -A'
	t block  'a rebase in the main checkout'                 'git rebase origin/dev'
	t block  'global options do not hide it'                 'git --no-pager commit -m x'
	t block  '-c does not hide it either'                    'git -c user.name=x commit -m x'
	t block  'a SUBDIRECTORY of the main checkout is still the main checkout' \
		"git -C $main/sub commit -m x"
	# Quote-stripping exists for exactly this, and it must survive the command-position fix.
	t block  'sh -c smuggling is still caught'               'sh -c "git commit -m x"'
	t block  'bash -lc smuggling too'                        'bash -lc "git commit -m x"'

	# ── allowed: a worktree is not the main checkout ──
	t allow  'a commit in a linked worktree'                 "git -C $tmp/wt-mine commit -m x"
	t allow  'add -A in a linked worktree'                   "git -C $tmp/wt-mine add -A"
	# THE REGRESSION (#3192): the subcommand need not sit straight after the path.
	t allow  'global options between -C and the subcommand'  "git -C $tmp/wt-mine -c core.editor=true rebase --continue"
	t allow  'cd into a worktree, then commit'               "cd $tmp/wt-mine && git commit -m x"
	# Unwinding a rebase is never blocked, or you could get stuck mid-rebase.
	t allow  'rebase --continue'                             'git rebase --continue'
	t allow  'rebase --abort'                                'git rebase --abort'

	# ── R-STASH: the stack is repository-wide, not worktree-local ──
	t allow  'stash is allowed with no other live lease'     "git -C $tmp/wt-mine stash push"
	other_admin="$(git -C "$tmp/wt-other" rev-parse --absolute-git-dir)/alethia-lease"
	mkdir -p "$other_admin"
	{
		echo "pid: $$"
		echo "procStart: $(ps -o lstart= -p $$ | tr -s '[:space:]' ' ' | sed 's/^ //; s/ *$//')"
		echo "host: $(hostname -s 2>/dev/null || hostname)"
		echo "session: self-test-other"
		echo "branch: feat/other"
		echo "acquiredAt: $(date +%s)"
	} >"$other_admin/owner"
	t block  'stash push is refused with another live lease' "git -C $tmp/wt-mine stash push"
	t block  'stash pop is refused with another live lease'  "git -C $tmp/wt-mine stash pop"
	t block  'cd into a worktree resolves the stash target'  "cd $tmp/wt-mine && git stash push"
	t allow  'stash list remains read-only'                  "git -C $tmp/wt-mine stash list"
	t allow  'stash show remains read-only'                  "git -C $tmp/wt-mine stash show -p"
	t allow  'stash create remains ref-free'                 "git -C $tmp/wt-mine stash create"
	says 'shared repository stack' 'the refusal names the shared-stack race' \
		"git -C $tmp/wt-mine stash push"

	# ── #3739: the five ways this rule was wrong on the day it landed ──
	# `grep -o` is NON-OVERLAPPING, so an allowed invocation swallowed the separator that put the
	# next one in command position. "check the stack, then pop it" is the shape it let through.
	t block  'a chained pop is judged on its own segment'    "git -C $tmp/wt-mine stash list;git -C $tmp/wt-mine stash pop"
	t block  '…and with a space before the separator too'    "git -C $tmp/wt-mine stash list ; git -C $tmp/wt-mine stash drop"
	t block  'sh -c smuggling reaches R-STASH as well'       "sh -c \"git -C $tmp/wt-mine stash pop\""
	# …but a backslash-escaped separator is a grep pattern, not a pipeline.
	t allow  'a grep pattern naming stash is not a pipeline' 'grep -n "git stash pop\|git stash drop" f.sh'

	# Unresolvable must fail CLOSED, the direction R-MAIN already takes.
	t block  'an unexpanded stash target refuses'            'git -C "$W" stash pop'
	says 'unexpanded shell variable' 'the refusal names WHY the tree is unknown' 'git -C "$W" stash pop'

	# A segment does not have to START with the command it runs. The sweep that eats another lane's
	# entry — `for w in ../wt-*; do git -C "$w" stash pop; done` — splits on `;` into ` do git …`,
	# and an anchored match stopped dead at the leading `do`. Both forms below must block: this is a
	# COMMAND-POSITION bug, not a variable-resolution one, so the literal-path loop (which resolves
	# perfectly well) escaped exactly the same way. See `stash_kw`, and read its scope note — the
	# prefixes it steps over are a token list, not a shell parser.
	t block  'the for-loop sweep over sibling worktrees'     'for w in ../wt-*; do git -C "$w" stash pop; done'
	t block  '…and its literal, fully resolvable form'       "for w in $tmp/wt-*; do git -C $tmp/wt-mine stash pop; done"
	t block  'a then-branch is command position too'         "if true; then git -C $tmp/wt-mine stash pop; fi"
	t block  '…so is a brace group'                          "{ git -C $tmp/wt-mine stash drop; }"
	t block  '…and a VAR=val prefix'                         "GIT_TRACE=1 git -C $tmp/wt-mine stash pop"
	# The read-only carve-out has to survive that widening, or the guard starts eating `stash list`.
	t allow  'a read-only stash in a loop stays allowed'     "for w in $tmp/wt-*; do git -C \$w stash list; done"

	# The MAIN CHECKOUT is not a separate stack; it is the same one, and it is the shared tree.
	t block  'stash drop in the main checkout is refused'    "git -C $main stash drop"

	# R-LEASE hands you leases you never asked for (it acquires one for every target root it
	# resolves), so a lease carrying MY identity must not refuse MY stash. The fixture owner above
	# is stamped with this shell's pid, so naming it as CLAUDE_PID makes that lease mine.
	# wt-mine's own lease is cleared first: when the self-test runs INSIDE a Claude session the
	# preceding cases took one under the ambient CLAUDE_PID, and R-LEASE would then block this
	# case before R-STASH is ever consulted — the wrong rule answering, and a silent false FAIL.
	wt_mine_ld="$(git -C "$tmp/wt-mine" rev-parse --absolute-git-dir)/alethia-lease"
	rm -rf "$wt_mine_ld"
	t_as allow 'a lease carrying my OWN identity does not block me' \
		"git -C $tmp/wt-mine stash push" "CLAUDE_PID=$$"
	rm -rf "$wt_mine_ld"

	# R-LEASE's documented hatch must open R-STASH too: `wt_lease_live` treats another HOST's lease
	# as permanently live, so without it one stale cross-host lease wedges stash in the whole repo.
	t_as allow 'ALETHIA_ALLOW_FOREIGN_WT=1 opens R-STASH' \
		"git -C $tmp/wt-mine stash pop" ALETHIA_ALLOW_FOREIGN_WT=1
	says 'ALETHIA_ALLOW_FOREIGN_WT' 'the refusal advertises the escape hatch' \
		"git -C $tmp/wt-mine stash pop"
	# The hatch case acquired a real lease on wt-mine too; drop it so later cases see a clean tree.
	rm -rf "$wt_mine_ld"

	# ── #3192: prose is not a command ──
	# Each of these blocked before, and none of them was going to write anything.
	t allow  'an issue title describing a commit'            'gh issue create --title "guard refuses a `git -C \"$W\"` commit and blames the main checkout"'
	t allow  'a grep pattern containing the shape'           'grep -n "git commit\|git add -A\|git rebase" file.sh'
	t allow  'a heredoc mentioning it in prose'              'echo "then run git commit -m x" >> notes.md'
	t allow  'a path that merely contains the word'          'ls apps/console/lib/git-commit-helper.ts'

	# ── #3192: unresolvable ≠ the main checkout ──
	t block  'an unexpanded variable still refuses'          'git -C "$W" commit -F msg.txt'
	says 'unexpanded shell variable' 'the refusal NAMES the unexpanded variable' 'git -C "$W" commit -F msg.txt'
	says 'NOT a claim that you were writing into the main checkout' \
		'...and explicitly disclaims the main checkout'      'git -C "$W" commit -F msg.txt'
	says 'shared main checkout' 'a REAL main-checkout write still says so' 'git commit -m x'

	echo
	if [ "$fail" -ne 0 ]; then
		echo "guard-worktree --self-test: $fail failed, $pass passed" >&2
		exit 1
	fi
	echo "guard-worktree --self-test: all $pass passed"
	exit 0
fi

input="$(cat)"

# Resolve the helper relative to THIS FILE, not to CLAUDE_PROJECT_DIR: the project dir may point at
# a worktree, or at a different repo entirely, and silently falling through to the fail-open stub
# would disable the guard with no signal (it did exactly that the first time this was tested).
lib="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." 2>/dev/null && pwd)/scripts/lib/wt-lease.sh"
[ -f "$lib" ] || lib="${CLAUDE_PROJECT_DIR:-$PWD}/scripts/lib/wt-lease.sh"
# Fail OPEN if the helper is missing (a branch cut before this landed, a partial checkout). A guard
# that breaks every tool call when a file is absent is worse than the hole it closes.
if [ -f "$lib" ]; then
	# shellcheck source=/dev/null
	. "$lib"
else
	wt_lease_acquire() { return 2; }
	wt_root_of() { printf ''; }
	wt_abs() { printf '%s' "$1"; }
fi

# ── payload fields, without a jq dependency ─────────────────────────────────────────────────────
# Probe for KEYS rather than dispatching on tool_name: a Bash payload has no file_path, an Edit
# payload has no command. That removes a whole class of "did the harness rename the tool" bug.
#
# jq when available (exact). Otherwise a grep that emits EVERY match and the caller unions them:
# block if ANY candidate is foreign. The asymmetry is deliberate — a decoy `"file_path": "…"`
# inside an Edit's new_string can cause a spurious BLOCK (recoverable, and there's an escape
# hatch), but can never cause a spurious ALLOW.
payload_field() { # <key>
	if command -v jq >/dev/null 2>&1; then
		printf '%s' "$input" | jq -r --arg k "$1" '.tool_input[$k] // empty' 2>/dev/null && return 0
	fi
	printf '%s' "$input" |
		grep -oE "\"$1\"[[:space:]]*:[[:space:]]*\"([^\"\\\\]|\\\\.)*\"" |
		sed -E "s/^\"$1\"[[:space:]]*:[[:space:]]*\"//; s/\"\$//" |
		sed -e 's/\\"/"/g' -e 's/\\\\/\\/g'
}

payload_cwd() {
	if command -v jq >/dev/null 2>&1; then
		printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null && return 0
	fi
	printf '%s' "$input" | grep -oE '"cwd"[[:space:]]*:[[:space:]]*"[^"]*"' | tail -1 |
		sed -E 's/^"cwd"[[:space:]]*:[[:space:]]*"//; s/"$//'
}

# ── the deny message ────────────────────────────────────────────────────────────────────────────
deny() { # <worktree-root> <what>
	local ld idle
	ld="$(wt_lease_dir "$1" 2>/dev/null)"
	idle="$(wt_lease_idle "$ld" 2>/dev/null || echo unknown)"
	{
		echo "BLOCKED: $1 is checked out by ANOTHER LIVE Claude instance — $2 there is not allowed."
		echo "  holder   pid ${WT_L_PID:-?} (started ${WT_L_PS:-?}) on ${WT_L_HOST:-?}"
		echo "  session  ${WT_L_SESSION:-?} · branch ${WT_L_BRANCH:-?}"
		echo "  leased   $(wt_lease_age 2>/dev/null || echo '?') ago · last active $idle"
		echo ""
		echo "Writing here commits their uncommitted work under your message — that is exactly what"
		echo "happened on issue #1247. Work in your OWN worktree:  pnpm wt <name>  →  ../wt-<name>."
		echo "  who holds what:       pnpm wt:who"
		echo "  they are really gone: pnpm wt:steal <name>"
		echo "  deliberate override:  ALETHIA_ALLOW_FOREIGN_WT=1 (maintainer only — instances must not)"
	} >&2
	exit 2
}

# ── R-LEASE, path-based tools (Write / Edit / MultiEdit / NotebookEdit / EnterWorktree) ─────────
# No parsing risk here: the path is a structured field. This branch is also what makes the retrofit
# work — every existing worktree is currently unleased, so ownership is taken on first write.
for key in file_path notebook_path path; do
	while IFS= read -r p; do
		[ -n "$p" ] || continue
		root="$(wt_root_of "$(wt_abs "$p")")"
		[ -n "$root" ] || continue
		wt_lease_acquire "$root"
		[ "$?" = 1 ] && deny "$root" "editing files"
	done <<EOF
$(payload_field "$key")
EOF
done

# ── R-LEASE, Bash ───────────────────────────────────────────────────────────────────────────────
cmd="$(payload_field command)"

# Git's global options sit between `git` and its subcommand. These fragments are shared by
# R-STASH and R-MAIN so both rules recognise the same command shapes.
git_pre='([[:space:]]+(-C[[:space:]]+[^[:space:];&|]+|-c[[:space:]]+[^[:space:];&|]+|--git-dir=[^[:space:];&|]+|--work-tree=[^[:space:];&|]+|--no-pager|--no-replace-objects|--literal-pathspecs))*'
tok='([[:space:]]|"|\\|$)'
cmd_pos='(^|^[;&|][[:space:]]*|[^\\][;&|][[:space:]]*|(^|[[:space:]])(sh|bash|zsh|dash)[[:space:]]+-[a-z]*c[[:space:]]*["'"'"']?)'

# Does this ONE segment reference <root>? Re-runs the same path extraction the target loop uses, so
# a segment can never be judged by a different notion of "which paths does this touch".
seg_touches_root() { # <segment> <base> <root>
	local seg="$1" base="$2" root="$3" tok
	while IFS= read -r tok; do
		[ -n "$tok" ] || continue
		[ "$(wt_root_of "$(wt_abs "$tok" "$base")")" = "$root" ] && return 0
	done <<EOF
$(
		printf '%s' "$seg" | grep -oE '(^|[^[:alnum:]_-])git[[:space:]]+-[Cc][[:space:]]+[^[:space:];&|]+' | sed -E 's/.*-[Cc][[:space:]]+//'
		printf '%s' "$seg" | tr '[:space:]=' '\n' | grep -E '/' | grep -vE '^-'
	)
EOF
	return 1
}

# Read-only ⇔ every segment that TOUCHES the foreign worktree is a git READ. Deliberately git-only:
# the set of git read subcommands is small, well-known and stable, whereas a general read allowlist
# (cat/grep/find/…) drifts with tooling and every gap in it is a false block anyway. So any NON-git
# command aimed at a foreign live worktree is treated as write-ish.
#
# SCOPE (<root>): when the foreign tree was reached by an explicit path, a segment that never
# mentions it cannot harm it — so `git -C ../wt-x log | head -3` is a read, and only `head` being
# absent from a git allowlist used to block it. Piping a git read to a pager is routine, and a guard
# that cries wolf is one people learn to override. Pass an EMPTY root for residency (payload cwd or
# a `cd` into the tree): there the whole command runs INSIDE the worktree, so every segment counts,
# and `cd ../wt-x && rm -rf .` must still be refused even though it names no path.
#
# Consulted ONLY after a target is known to be a foreign live worktree, where a non-read command
# has no legitimate purpose — so it is deny-by-default and every misclassification is a recoverable
# false block, never a false allow.
cmd_is_git_read() { # <command> <base> <scope-root|"">
	local seg had=0
	while IFS= read -r seg; do
		seg="$(printf '%s' "$seg" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')"
		[ -z "$seg" ] && continue
		# Scoped: a segment that doesn't touch the foreign tree is a neutral formatting sink.
		if [ -n "$3" ] && ! seg_touches_root "$seg" "$2" "$3"; then continue; fi
		had=1
		printf '%s' "$seg" | grep -qE '(\$\(|`|(^|[^0-9<>&])>|<\()' && return 1 # subst / redirect
		printf '%s' "$seg" | grep -qE '^git([[:space:]]+-[Cc][[:space:]]+[^[:space:]]+)*[[:space:]]+(status|log|show|diff|difftool|blame|annotate|shortlog|describe|rev-parse|rev-list|cat-file|ls-files|ls-tree|ls-remote|for-each-ref|show-ref|symbolic-ref|name-rev|merge-base|grep|count-objects|whatchanged|version)([[:space:]]|$)' && continue
		printf '%s' "$seg" | grep -qE '^git([[:space:]]+-[Cc][[:space:]]+[^[:space:]]+)*[[:space:]]+(worktree[[:space:]]+list|stash[[:space:]]+(list|show)|reflog([[:space:]]+show)?|remote([[:space:]]+(-v|show))?|config[[:space:]]+--get|branch[[:space:]]+(-v|-vv|-a|-r|--list|--contains)|tag[[:space:]]+(-l|--list))([[:space:]]|$)' && continue
		return 1
	done <<EOF
$(printf '%s' "$1" | tr ';|&' '\n\n\n')
EOF
	[ "$had" = 1 ]
}

if [ -n "$cmd" ]; then
	base="$(payload_cwd)"
	[ -n "$base" ] || base="${CLAUDE_PROJECT_DIR:-$PWD}"

	# Candidate target dirs: the session cwd (residency) ∪ every `git -C <p>` ∪ every `cd <p>` ∪
	# every bare token containing `/`. That last one is what the old hook lacked entirely, and it
	# is what catches `sed -i ../wt-x/f`, `cp a ../wt-x/b`, `rm -rf ../wt-x`.
	scan="$(printf '%s' "$cmd" | tr -d '\42\47\134')" # drop  "  '  \  — repo paths have none

	# Targets are tagged by PROVENANCE, because it changes how strictly the command is judged:
	#   R = residency — the session cwd, or a `cd` into the tree. The whole command runs INSIDE it.
	#   P = an explicit path — `git -C <p>`, or a bare token. Only the segments naming it can touch it.
	targets="$(
		printf 'R\t%s\n' "$base"
		printf '%s' "$scan" | grep -oE '(^|[^[:alnum:]_])cd[[:space:]]+[^[:space:];&|]+' | sed -E 's/.*cd[[:space:]]+/R\t/'
		printf '%s' "$scan" | grep -oE '(^|[^[:alnum:]_-])git[[:space:]]+-[Cc][[:space:]]+[^[:space:];&|]+' | sed -E 's/.*-[Cc][[:space:]]+/P\t/'
		printf '%s' "$scan" | tr '[:space:];&|=' '\n' | grep -E '/' | grep -vE '^-' | sed -E 's/^/P\t/'
	)"

	while IFS= read -r line; do
		[ -n "$line" ] || continue
		kind="${line%%	*}"
		t="${line#*	}"
		[ -n "$t" ] || continue
		root="$(wt_root_of "$(wt_abs "$t" "$base")")"
		[ -n "$root" ] || continue
		wt_lease_acquire "$root"
		if [ "$?" = 1 ]; then
			# Residency judges the whole command; an explicit path judges only the segments naming it.
			if [ "$kind" = "R" ]; then
				cmd_is_git_read "$cmd" "$base" "" && continue
			else
				cmd_is_git_read "$cmd" "$base" "$root" && continue
			fi
			deny "$root" "running commands"
		fi
	done <<EOF
$targets
EOF
fi

# ── R-STASH, repository-wide ref ───────────────────────────────────────────────────────────────
# A linked worktree has its own index and HEAD, but EVERY tree in the repository — the main
# checkout included — shares one refs/stash. Therefore a top-of-stack `pop`, `drop`, or even a
# plain `push` can consume/reorder another live lane's stash. Read-only `list`/`show` and ref-free
# `create` remain safe. Refuse mutations only when ANOTHER worktree carries a live FOREIGN lease;
# a blanket stash ban would train operators to bypass the guard.
deny_shared_stash() { # <current-root> <other-root>
	{
		echo "BLOCKED: git stash uses a shared repository stack, and another live worktree is active."
		echo "  current  $1"
		echo "  other    $2 · pid ${WT_L_PID:-?} on ${WT_L_HOST:-?} · branch ${WT_L_BRANCH:-?}"
		echo ""
		echo "A push/pop/drop here can race with that lane through the repository-wide refs/stash."
		echo "For a baseline, use a detached throwaway worktree; for a ref-free snapshot, use"
		echo "\`git stash create\`. The same shared-state caution applies to tags, notes, and bisect."
		echo "  who holds what:       pnpm wt:who"
		echo "  they are really gone: pnpm wt:steal <name>"
		echo "  deliberate override:  ALETHIA_ALLOW_FOREIGN_WT=1 (maintainer only — instances must not)"
	} >&2
	exit 2
}

# The target could not be resolved AND another lane is live. R-MAIN fails closed on exactly this
# shape and so does this rule. The sweep that eats another lane's entry —
# `for w in ../wt-*; do git -C "$w" stash pop; done` — arrives here when it is written with a
# variable; written with a literal path it resolves and takes deny_shared_stash instead. Either way
# the segment matcher has to see past the loop's leading `do` first, which is `stash_kw` below —
# this branch alone never covered that shape.
deny_stash_unresolved() { # <raw-target> <other-root>
	{
		echo "BLOCKED: this \`git stash\` mutates a shared repository stack, another live worktree is"
		echo "active, and the tree the command would run in could not be resolved."
		echo "  target   $1 — an unexpanded shell variable; this hook runs BEFORE the shell expands it"
		echo "  other    $2 · pid ${WT_L_PID:-?} on ${WT_L_HOST:-?} · branch ${WT_L_BRANCH:-?}"
		echo ""
		echo "Refusing is deliberate — guessing at unexpanded shell would be worse — and this is NOT"
		echo "a claim about which tree you meant. Write the path literally:"
		echo "  git -C /abs/path/to/wt-<name> stash …"
		echo "  who holds what:       pnpm wt:who"
		echo "  deliberate override:  ALETHIA_ALLOW_FOREIGN_WT=1 (maintainer only — instances must not)"
	} >&2
	exit 2
}

# The first OTHER tree carrying a live, FOREIGN lease. Sets STASH_OTHER and leaves WT_L_* describing
# the holder, so it must NOT be called in a command substitution.
#
# `! wt_lease_is_mine` is load-bearing, and its absence wedged every stash in the repo: R-LEASE
# ACQUIRES a lease on every target root it resolves, so merely READING a sibling worktree
# (`git -C ../wt-x log`) stamps that tree with MY OWN identity — and a liveness-only test then
# refuses my next `git stash` in my own worktree, naming my own pid as the foreign holder. Every
# other rule in this file goes through `wt_lease_acquire`, which returns 0 for a lease that is mine.
stash_live_other() { # <exclude-root|"">
	local r ld
	STASH_OTHER=""
	while IFS= read -r r; do
		[ -n "$r" ] || continue
		[ -n "$1" ] && [ "$r" = "$1" ] && continue
		ld="$(wt_lease_dir "$r" 2>/dev/null || true)"
		[ -n "$ld" ] || continue
		if wt_lease_read "$ld" 2>/dev/null && ! wt_lease_is_mine && wt_lease_live; then
			STASH_OTHER="$r"
			return 0
		fi
	done <<EOF
$(wt_roots)
EOF
	return 1
}

# The same deliberate override R-LEASE honours. Without it this rule has NO escape hatch at all,
# and `wt_lease_live` treats a lease stamped by another HOST as permanently live — so one lease left
# behind by a session on the sandbox box, or by a rename of this laptop, would refuse `git stash` in
# every tree of the repository forever, with no way past it.
if [ -n "$cmd" ] && [ "${ALETHIA_ALLOW_FOREIGN_WT:-}" != "1" ]; then
	base="$(payload_cwd)"
	[ -n "$base" ] || base="${CLAUDE_PROJECT_DIR:-$PWD}"

	# Command position is decided SEGMENT-WISE, not by one `grep -oE` over the whole command.
	# `grep -o` yields DISJOINT matches and cmd_pos's separator alternative consumes the character
	# BEFORE the `;`, so an allowed invocation swallowed the separator that would have put the next
	# one in command position: `git stash list;git stash drop` — no space — was allowed outright,
	# and "check the stack, then pop it" is the single most natural shape of the command this rule
	# exists to stop. Splitting first and anchoring each segment at its own start judges every
	# invocation on its own.
	#
	# A BACKSLASH-ESCAPED separator is not a separator: `grep -n "git stash pop\|git stash drop" f`
	# is one grep pattern, exactly as cmd_pos's `[^\\]` means elsewhere in this file. Protect those
	# before splitting, restore them after, so a search for this rule is not blocked by it.
	stash_split="${cmd//\\;/$'\001'}"
	stash_split="${stash_split//\\&/$'\002'}"
	stash_split="${stash_split//\\|/$'\003'}"
	# A segment does not have to START with the command it runs, and the shape this whole rule
	# exists for is the one that proves it: `for w in ../wt-*; do git -C "$w" stash pop; done`
	# splits on `;` into ` do git -C "$w" stash pop`, where an anchored match stopped dead at the
	# leading `do` — so the sweep that eats another lane's entry was allowed outright. It is a
	# COMMAND-POSITION hole, not an unexpanded-variable one: the same loop written with a literal
	# path escaped identically. So step over the words that can precede a command in a compound
	# statement, and over a `VAR=val` prefix.
	#
	# SCOPE — this is a TOKEN LIST, not a shell parser, and the difference is worth stating because
	# a reader grepping for their own shape has to be able to tell whether it is covered. Only the
	# prefixes below are stepped over. A wrapper that is not one of them — `env`, `command`, `exec`,
	# `nohup`, `xargs git …` — and a command substitution (`x=$(git … stash pop)`, whose `$(` the
	# `VAR=` alternative deliberately will not swallow) still walk straight past R-STASH. Widening
	# the list costs only false BLOCKS, which are recoverable and have a documented hatch; a real
	# parser here would not be, so the trade runs this way on purpose.
	#
	# A shell's `-c` opens a command context inside the quotes, which is what keeps
	# `sh -c "git stash pop"` caught — the same carve-out cmd_pos makes for R-MAIN.
	stash_kw="(((do|then|else|elif|if|while|until|time|!)|[{])[[:space:]]+|[(][[:space:]]*"
	stash_kw="${stash_kw}|[A-Za-z_][A-Za-z0-9_]*=[^[:space:];&|\"'\$\`]*[[:space:]]+)*"
	stash_re="^[[:space:]]*${stash_kw}((sh|bash|zsh|dash)[[:space:]]+-[a-z]*c[[:space:]]*[\"']?[[:space:]]*)?"
	stash_re="${stash_re}git${git_pre}[[:space:]]+stash([[:space:]]+[^[:space:];&|\"']+)?"

	stash_cd=""
	while IFS= read -r seg; do
		seg="${seg//$'\001'/\\;}"
		seg="${seg//$'\002'/\\&}"
		seg="${seg//$'\003'/\\|}"
		[ -n "$seg" ] || continue
		seg_scan="$(printf '%s' "$seg" | tr -d '\42\47\134')" # drop  "  '  \

		# A `cd` sets git's cwd for every LATER segment of the chain, so walk them in order.
		stash_cd_hit="$(printf '%s' "$seg_scan" |
			grep -oE '(^|[^a-zA-Z0-9_])cd[[:space:]]+[^[:space:];&|]+' |
			tail -1 | sed -E 's/.*cd[[:space:]]+//' || true)"
		[ -n "$stash_cd_hit" ] && stash_cd="$stash_cd_hit"

		# The first token after `stash` is enough to distinguish the three safe forms; every
		# option/default/other verb is conservatively mutating.
		hit="$(printf '%s' "$seg" | grep -oE "$stash_re" | head -1 || true)"
		[ -n "$hit" ] || continue
		stash_arg="$(printf '%s' "$hit" | sed -E "s/.*[[:space:]]stash([[:space:]]+([^[:space:];&|\"']+))?\$/\\2/")"
		case "$stash_arg" in list | show | create | -h | --help) continue ;; esac

		target="$(printf '%s' "$seg_scan" |
			grep -oE "git[[:space:]]+-C[[:space:]]+[^[:space:];&|]+${git_pre}[[:space:]]+stash" |
			tail -1 | sed -E 's/^git[[:space:]]+-C[[:space:]]+//' | sed -E 's/[[:space:]].*$//' || true)"
		[ -n "$target" ] || target="$stash_cd"
		[ -n "$target" ] || target="$base"
		case "$target" in
		*'$'* | *'`'*)
			stash_live_other "" && deny_stash_unresolved "$target" "$STASH_OTHER"
			continue
			;;
		esac

		current_root="$(wt_root_of "$(wt_abs "$target" "$base")")"
		# Empty ⇒ outside every tree of THIS repository — a different repo has its own refs/stash and
		# is not this rule's business. The MAIN CHECKOUT is deliberately NOT excluded: it is not a
		# separate stack, it is the SAME one, it is the tree every session and the maintainer share,
		# and it is where an operator most often reaches for `git stash` to get a clean base. It
		# simply has no lease of its own to skip, which `stash_live_other` handles by lease dir.
		[ -n "$current_root" ] || continue
		stash_live_other "$current_root" && deny_shared_stash "$current_root" "$STASH_OTHER"
	done <<EOF
$(printf '%s' "$stash_split" | tr ';&|' '\n\n\n')
EOF
fi

# ── R-MAIN: the original main-checkout rule ─────────────────────────────────────────────────────
# Only care about a commit / stage-everything / rebase invocation — bail fast on anything else.
#
# Scan the COMMAND FIELD, not the raw payload. Scanning the whole JSON meant any
# Write/Edit whose CONTENT merely mentioned the blocked phrases was rejected as if it
# were a commit — this guard blocked an edit to its own message text, and it blocks
# documenting the rule anywhere in the repo. A Bash payload is the only one with a
# `command` key, so this also scopes R-MAIN to Bash without dispatching on tool_name
# (the same key-probing rationale as payload_field above).
cmd_text="$(payload_field command)"
[ -n "$cmd_text" ] || exit 0

# `git rebase` belongs to this rule for a reason the commit case does not cover: the main checkout
# is PINNED TO dev and shared by every live session, so a rebase run there rewrites `dev` itself
# underneath instances that are reading it. That is worse than a tangled commit — a commit adds a
# bad object, a rebase moves the branch every other session resolves against. It was allowed until
# now only because `Bash(git rebase:*)` was not in the permission allow-list, so the prompt was
# doing the guarding; the moment the allow-list pre-approves rebases, that accident stops holding.
#
# The CONTROL forms are carved out first. --abort / --continue / --skip / --quit / --edit-todo do
# not START a rewrite; they finish or unwind one already in progress. Blocking those would strand
# a session mid-rebase with no way out, which is strictly worse than the thing this rule prevents.
#
# They are STRIPPED rather than early-exited, so a compound command is judged on what it actually
# does: `git rebase --abort` alone passes, while `git rebase --abort && git rebase origin/dev`
# still trips the rule on its second half.
cmd_scan="$(printf '%s' "$cmd_text" |
	sed -E 's/git[[:space:]]+rebase[[:space:]]+--(abort|continue|skip|quit|edit-todo)/git_rebase_control/g')"

# git's GLOBAL options sit BETWEEN `git` and the subcommand: `git -C <path> commit`,
# `git --no-pager rebase`, `git -c user.name=x commit`. This trigger used to require `git`
# IMMEDIATELY followed by the subcommand, so every one of those forms was invisible to R-MAIN —
# `git -C <main checkout> commit -m x` ran completely unguarded, which is CLAUDE.md's
# non-negotiable #1 defeated by four characters.
#
# It also made the `git -C …` branch of the target resolution below DEAD CODE: the only way to
# reach it was a form the trigger had already rejected. So this guard's own block message
# promised that `git -C ../wt-<name> …` is "parsed by this guard and allowed" while it was in
# fact UNPARSED and allowed — the right answer for a worktree, by accident, and the wrong one for
# the main checkout. Anything that now matches but cannot be resolved falls through to the block,
# which is the fail-closed direction.
# COMMAND POSITION, and it is what stops this guard firing on prose (#3192).
#
# Quote-stripping above is deliberate and must stay: `sh -c "git commit"` has to be caught, and it
# only is because the quotes are gone before matching. The cost was that ANY text containing the
# shape matched too — and it fired four times in one session on things that were not commands:
#
#   gh issue create --title "... a `git -C \"$VAR\"` commit ..."   ← an issue title
#   grep -n "git commit\|git add\|git rebase" file                 ← a search pattern
#
# Both are exactly the trigger shape after stripping. Blocking them is not conservative, it is
# wrong: nothing was going to be written, and the message then names a checkout the command never
# touched, which sends the reader to check something that was never at risk.
#
# So `git` must sit where a command starts: beginning of input, after a separator (; & | newline),
# or immediately after a shell's `-c` — that last one is what keeps `sh -c "git commit"` caught.
# A `git` preceded by anything else is being TALKED ABOUT, not run.
# Note this runs on the RAW command text, quotes intact — the stripping further down is for
# target resolution only. A quote can therefore sit between the shell and the word, and the
# FIRST version of this fix missed that and let `sh -c "git commit"` straight through. Its own
# self-test caught it on the first run, which is the argument for the self-test as much as for
# the rule.
#
# A quote counts as a command position ONLY after a shell's -c. That is what separates
#     sh -c "git commit …"        ← opens a COMMAND context. Still caught.
#     grep -n "git commit" f.sh   ← opens a STRING. Not a command, and never was.
# Keying on the quote alone would have kept every grep pattern blocked; keying on the shell too
# is what makes the difference legible to a regex.
# The separator must not be BACKSLASH-ESCAPED, or a grep pattern reads as a pipeline:
#     grep -n "git commit\|git rebase" f.sh
# `\|` is one literal alternation character to grep and looks exactly like a shell pipe here.
# That single case was the last false positive left, and it is the one that blocked me from
# searching this very file while fixing it.
trigger="${cmd_pos}git${git_pre}[[:space:]]+commit${tok}"
trigger="${trigger}|${cmd_pos}git${git_pre}[[:space:]]+add[[:space:]]+(-A|--all|\.)${tok}"
trigger="${trigger}|${cmd_pos}git${git_pre}[[:space:]]+rebase${tok}"

if ! printf '%s' "$cmd_scan" | grep -Eq "$trigger"; then
	exit 0
fi

# Which verb tripped it — used only to make the block message name the right thing.
if printf '%s' "$cmd_scan" | grep -Eq "${cmd_pos}git${git_pre}[[:space:]]+rebase${tok}"; then
	verb="rebase in"
else
	verb="commit into"
fi

# Deliberate override. It must be EXPORTED BEFORE `claude` starts. This is a PreToolUse
# hook, spawned before the Bash tool runs, so an inline `VAR=1 …` prefix inside the
# command text is never in THIS process's environment. The same prefix DOES work for
# .githooks/pre-commit, which git spawns as its own child — the two layers genuinely
# need different advice, which is why the block message below spells both out.
[ "${ALETHIA_ALLOW_MAIN_COMMIT:-}" = "1" ] && exit 0

# --- Where will this commit / rebase ACTUALLY run? ------------------------------------------------
# This PreToolUse hook runs BEFORE the command, in the session's launch dir, so $CLAUDE_PROJECT_DIR
# and $PWD both point at the MAIN checkout even when the session (via EnterWorktree) or an explicit
# `cd` targets a worktree — which is why a legitimate worktree commit used to be blocked here.
# git's behaviour is fully determined by the command text, so read the effective dir from it:
#   * `git -C <path> (commit|add|rebase)` wins — it's authoritative for that invocation, else
#   * the LAST `cd <path>` before the keyword (git's cwd in a normal && / ; chain).
# Then let git ITSELF confirm the dir is a linked worktree. We allow ONLY on that positive
# confirmation; anything unparsed / unresolved / main-checkout falls through to the block below.
# Repo paths never contain spaces or quotes, so stripping quotes and taking a bare token is safe.
#
# `rebase` is in these patterns for the same reason `commit` is: without it, a perfectly legitimate
# `cd ../wt-mine && git rebase origin/dev` resolves no target, falls through, and is blocked — the
# guard would then be unusable and the first thing anyone did would be to disable it.
scan="$(printf '%s' "$input" | tr -d '\42\47\134')" # drop  "  '  \  (incl. JSON escaping)

# The subcommand does not have to come straight after the path: `git -C <path> -c core.editor=true
# rebase --continue` is an ordinary thing to type, and requiring adjacency here meant it resolved
# NO target and fell through to the block — telling the operator to work in a worktree while they
# were already doing exactly that. `git_pre` is reused so this stays in step with the trigger.
target="$(printf '%s' "$scan" |
	grep -oE "git[[:space:]]+-C[[:space:]]+[^[:space:];&|]+${git_pre}[[:space:]]+(commit|add|rebase)" |
	tail -1 | sed -E 's/^git[[:space:]]+-C[[:space:]]+//' | sed -E 's/[[:space:]].*$//')"

if [ -z "$target" ]; then
	# The part of the command up to the commit/add/rebase keyword — the effective cwd lives here.
	prefix="${scan%%git commit*}"
	[ "$prefix" = "$scan" ] && prefix="${scan%%git add*}"
	[ "$prefix" = "$scan" ] && prefix="${scan%%git rebase*}"
	# `cd` as its own word: preceded by start-of-string or any non-word char (a shell delimiter
	# like ; & <space>, or the surrounding JSON punctuation `:`/`{`/`,` left after quote-stripping) —
	# NOT the "cd" inside a word like "abcd". tail -1 = the last cd before the commit (git's cwd).
	target="$(printf '%s' "$prefix" |
		grep -oE '(^|[^a-zA-Z0-9_])cd[[:space:]]+[^[:space:];&|]+' |
		tail -1 | sed -E 's/.*cd[[:space:]]+//')"
fi

if [ -n "$target" ]; then
	# --path-format=absolute IS LOAD-BEARING, and its absence was a live bypass.
	#
	# Run from a repo SUBDIRECTORY, git reports `--git-dir` as an ABSOLUTE path and
	# `--git-common-dir` as a RELATIVE one:
	#
	#     git -C <main>/sub rev-parse --git-dir          → /abs/path/main/.git
	#     git -C <main>/sub rev-parse --git-common-dir    → ../.git
	#
	# Those differ as STRINGS, so the "linked worktree" test below fired and ALLOWED the write.
	# `git -C app/apps/console <verb>` therefore wrote straight into the shared main checkout, past
	# the one rule this hook exists to enforce. Absolute form makes both sides the same path, so the
	# subdirectory correctly reads as the main checkout while a real linked worktree still differs
	# (its git-dir is .git/worktrees/<name>). Verified in all three positions.
	tgd="$(git -C "$target" rev-parse --path-format=absolute --git-dir 2>/dev/null || true)"
	tgcd="$(git -C "$target" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
	# Linked worktree ⇔ git-dir != git-common-dir. Confirmed by git → allow. (R-LEASE above has
	# already established the worktree isn't someone else's.)
	if [ -n "$tgd" ] && [ "$tgd" != "$tgcd" ]; then
		exit 0
	fi
	# A DIFFERENT REPOSITORY ENTIRELY — its own .git, its own remote, its own default branch.
	#
	# This rule is "don't commit into the shared MAIN CHECKOUT". A sibling repo is neither the main
	# checkout nor a linked worktree, so it used to read as "unresolved" and got refused: the
	# fail-closed default catching something the rule was never about.
	#
	# That is not hypothetical. The e2e fixtures live in THREE separate repositories —
	# enterprise-demo (the BYO-IaC modules), alethia-e2e-apps (the A0.6 apps repo) and
	# alethia-e2e-chart (the BYO Helm chart) — and all three are inputs to proof cells in
	# PROGRAMME.md. Working on them is ordinary programme work. On 2026-08-26 committing fixtures
	# into enterprise-demo was blocked here with a message naming a checkout the command never
	# touched, and the commit had to be built through the GitHub API instead (#2795).
	#
	# Compared by TOPLEVEL, not by path prefix: a subdirectory of the main checkout resolves to the
	# main checkout's toplevel and stays blocked, which is the case a prefix test would get wrong.
	# An unresolvable path yields an empty toplevel and falls through to the block, so the
	# fail-closed direction is preserved.
	tgtop="$(git -C "$target" rev-parse --show-toplevel 2>/dev/null || true)"
	maintop="$(git -C "${CLAUDE_PROJECT_DIR:-$PWD}" rev-parse --show-toplevel 2>/dev/null || true)"
	if [ -n "$tgtop" ] && [ -n "$maintop" ] && [ "$tgtop" != "$maintop" ]; then
		exit 0
	fi
fi

# --- UNRESOLVABLE ≠ THE MAIN CHECKOUT (#3192) -----------------------------------------------------
#
# A `git -C "$W" commit` names a directory this hook cannot know: it is a PreToolUse gate, so it
# runs BEFORE any shell expands `$W`, and it sees the four characters `"$W"`. `git -C '$W' rev-parse`
# fails, no worktree is confirmed, and the fall-through below then declares that the command "would
# commit into the shared main checkout" — which is not something this hook established, and in the
# usual case is false.
#
# Refusing is still right. A hook that guessed at unexpanded shell would be worse than one that
# stops. What was wrong was the DIAGNOSIS: it asserted a cause, and then prescribed the very remedy
# the operator was already applying ("work in your own worktree… `git -C ../wt-<name> …` is allowed"),
# which reads as though they had done nothing of the sort. Hit five times in one session; twice the
# reader re-checked a correctly-set variable before suspecting the message.
#
# So say what could not be determined, and how to get past it. The refusal is unchanged.
case "$target" in
*'$'* | *'`'*)
	echo "BLOCKED: the target of \`git -C\` could not be resolved — it contains an unexpanded shell variable (\`$target\`), and this hook runs BEFORE the shell expands it, so it cannot tell which repository you mean. Write the path literally: \`git -C /abs/path/to/wt-<name> …\`. Refusing here is deliberate — guessing at unexpanded shell would be worse — and this is NOT a claim that you were writing into the main checkout." >&2
	exit 2
	;;
esac

# --- Fall-through: no confirmed worktree ⇒ the original main-checkout guard, unchanged -------------
dir="${CLAUDE_PROJECT_DIR:-$PWD}"
gd="$(git -C "$dir" rev-parse --path-format=absolute --git-dir 2>/dev/null || echo _gd)"
gcd="$(git -C "$dir" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || echo _gcd)"

# Main checkout ⇔ git-dir == git-common-dir. Linked worktrees differ, so they pass.
if [ "$gd" = "$gcd" ]; then
	echo "BLOCKED: this would $verb the shared main checkout ($dir). Parallel sessions share this tree and it tangles their WIP (this is how the ba0c664 mega-commit happened); a rebase is worse still, because this checkout is pinned to \`dev\` and rewriting it moves the branch every other live session resolves against. Work in your own worktree: \`pnpm wt <name>\` → ../wt-<name>, then run it from there — a \`git -C ../wt-<name> …\` invocation is parsed by this guard and allowed. \`git rebase --abort|--continue|--skip|--quit|--edit-todo\` is never blocked, so you can always finish or unwind a rebase already in progress. Deliberate main-checkout override: export ALETHIA_ALLOW_MAIN_COMMIT=1 BEFORE launching claude — an inline VAR=1 prefix cannot work here, because this hook is spawned before the command runs; and --no-verify skips only the git hook, not this one." >&2
	exit 2
fi
exit 0
