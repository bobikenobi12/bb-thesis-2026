#!/usr/bin/env bash
# shellcheck shell=bash
#
# Replays incident #3841 against the REAL `scripts/env.sh` code path.
#
# scripts/lib/env-owner.sh --self-test proves the decision function. This proves the thing that
# actually failed: that `pnpm env:reap --now`, run the way a finished lane runs it, is refused when
# another instance's environment is live. The guard existed and was correct-looking for weeks while
# being unreachable, so "the function returns refuse-others" is not the claim that matters — "the
# command refuses" is.
#
# Section 7 replays a SECOND incident, #3922: `cmd_idle_minutes` reported 999999 for a registry
# with no rows, which made a box with nothing registered on it maximally idle by construction and
# handed it to the unattended timer on its first tick. The threshold itself sits behind
# require_main_checkout and an ssh, so that section drives its two real halves — the box script's
# `idle-minutes`, and the gate condition lifted verbatim out of env.sh — rather than a copy.
#
# Section 7 also covers #4009, the half #3922 could not reach: a box PROVISIONED before that
# fix runs the old box script and still answers 999999, so the consuming side folds it on
# arrival. That is driven through the real idle_normalise, and its WIRING is asserted too --
# a fold nothing calls is inert and every property of it still passes.
#
# Hermetic: no box, no ssh, no hcloud, no network. `env:reap --dry-run` reads the fixture registry
# named by ALETHIA_ENV_REGISTRY_FILE and destroys nothing. Section 6 asserts that the override
# is confined to the dry run, so this seam can never weaken a real reap.
#
#   bash scripts/lib/env-reap-test.sh

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
ENV_SH="$ROOT/scripts/env.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fails=0
ok() { echo "ok   - $1"; }
bad() {
	echo "FAIL - $1" >&2
	fails=$((fails + 1))
}

# A second live process on this host, so "another instance" is a real one and not a string.
sleep 120 &
OTHER_PID=$!
trap 'kill "$OTHER_PID" 2>/dev/null; rm -rf "$TMP"' EXIT

# shellcheck source=scripts/lib/env-owner.sh
. "$HERE/env-owner.sh"
ME="$(CLAUDE_PID="$$" env_owner)"
THEM="$(CLAUDE_PID="$OTHER_PID" env_owner)"
LEGACY="$(id -un)@$(wt_host)" # what every instance wrote before this fix

[ "$ME" != "$THEM" ] ||
	bad "two live instances on this host still share one owner string — the fix is inert"

now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }
old_iso() { date -u -v-6H +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '6 hours ago' +%Y-%m-%dT%H:%M:%SZ; }

fixture() { # <name> <json> → path
	printf '%s' "$2" >"$TMP/$1.json"
	printf '%s' "$TMP/$1.json"
}

row() { # <owner> <lastSeen>
	printf '{"consolePort":3200,"storagePort":8342,"database":"alethia_x","owner":"%s","lastSeen":"%s"}' "$1" "$2"
}

# Runs env:reap the way a lane does, against a fixture registry. Leaves the exit code in $RC and
# the combined output in $OUT — combined, and in order, because "what am I about to destroy" being
# printed BEFORE the verdict is half of what was asked for.
#
# NOT `rc="$(reap …)"`: a command substitution is a SUBSHELL, so every variable this sets would be
# discarded and every text assertion below would silently match an empty string. The first draft of
# this file did exactly that and reported ten failures with no output to show.
OUT=""
RC=0
reap() { # <fixture-path> <claude-pid|""> <flags…>
	local f="$1" pid="$2"
	shift 2
	RC=0
	OUT="$(cd "$ROOT" && ALETHIA_ENV_REGISTRY_FILE="$f" CLAUDE_PID="$pid" \
		bash "$ENV_SH" reap --dry-run "$@" 2>&1)" || RC=$?
}

has() { printf '%s' "$OUT" | grep -q "$1"; }

# ── 1. THE INCIDENT. Another instance's env, touched seconds ago; I am finished and reap. ───────
f="$(fixture others-live "{\"other-lane\":$(row "$THEM" "$(now_iso)")}")"
reap "$f" "$$" --now
rc="$RC"
if [ "$rc" = 3 ] && has "Not reaping — someone else is working on this box" && has "other-lane"; then
	ok "another instance's LIVE env refuses env:reap --now, and names it"
else
	bad "another instance's LIVE env must refuse env:reap --now (rc=$rc)"
	printf '%s\n' "$OUT" | sed 's/^/       /'
fi

# The manifest comes FIRST — before the refusal, and before anything is destroyed.
if [ "$(printf '%s\n' "$OUT" | grep -n 'reaping deletes the box' | cut -d: -f1)" -lt \
	"$(printf '%s\n' "$OUT" | grep -n 'Not reaping' | cut -d: -f1)" ]; then
	ok "what will be destroyed is printed BEFORE the verdict"
else
	bad "the destroy manifest must precede the verdict"
fi
if has "last seen"; then ok "the manifest carries each env's last-seen time"; else bad "manifest has no last-seen"; fi

# ── 2. …and it ALLOWS when nothing else is live. A guard never seen to pass is not a guard. ─────
f="$(fixture others-idle "{\"other-lane\":$(row "$THEM" "$(old_iso)")}")"
reap "$f" "$$" --now
rc="$RC"
if [ "$rc" = 0 ] && has "nobody is blocking"; then
	ok "an idle foreign env does not block — the reap proceeds"
else
	bad "an idle foreign env must not block (rc=$rc)"
	printf '%s\n' "$OUT" | sed 's/^/       /'
fi

f="$(fixture empty '{}')"
reap "$f" "$$" --now
rc="$RC"
if [ "$rc" = 0 ] && has "no environments are registered"; then
	ok "an empty registry reaps, and says the box is empty"
else bad "empty registry must reap (rc=$rc)"; fi

# ── 3. THE LEGACY PATH. A pre-#3841 `user@host` row is not silently mine. ───────────────────────
f="$(fixture legacy "{\"old-lane\":$(row "$LEGACY" "$(now_iso)")}")"
reap "$f" "$$" --now
rc="$RC"
if [ "$rc" = 3 ] && has "legacy user@host owner" && has "counted as someone else's"; then
	ok "a legacy user@host owner is refused as someone else's, and says why"
else
	bad "a legacy owner must not be treated as mine (rc=$rc)"
	printf '%s\n' "$OUT" | sed 's/^/       /'
fi

# The contrast that shows the OLD behaviour: with no agent pid the identity IS `user@host`, the
# row reads as mine, and only the new my-own-envs gate stops it. That is precisely how every
# instance saw every environment before this change.
reap "$f" "" --now
rc="$RC"
if [ "$rc" = 4 ] && has "your own environment is still live"; then
	ok "the same row IS mine to a bare user@host caller (the old scheme, now gated)"
else bad "a bare-identity caller should classify a bare-owner row as mine (rc=$rc)"; fi

# ── 4. MY OWN live env stops --now until I say otherwise. ───────────────────────────────────────
f="$(fixture mine "{\"my-lane\":$(row "$ME" "$(now_iso)")}")"
reap "$f" "$$" --now
rc="$RC"
if [ "$rc" = 4 ] && has "your own environment is still live" && has "pnpm env:down"; then
	ok "my own live env refuses --now and points at env:down"
else
	bad "my own live env must refuse --now (rc=$rc)"
	printf '%s\n' "$OUT" | sed 's/^/       /'
fi

reap "$f" "$$" --now --include-mine
rc="$RC"
if [ "$rc" = 0 ]; then ok "--include-mine is the explicit way to say I meant both"
else bad "--include-mine must allow my own live env (rc=$rc)"; fi

# …but it is not a general override.
f="$(fixture mine-and-theirs "{\"my-lane\":$(row "$ME" "$(now_iso)"),\"other-lane\":$(row "$THEM" "$(now_iso)")}")"
reap "$f" "$$" --now --include-mine
rc="$RC"
if [ "$rc" = 3 ]; then ok "--include-mine still refuses when someone ELSE is live"
else bad "--include-mine must not unlock a foreign live env (rc=$rc)"; fi

# ── 5. Fail CLOSED, and refuse what it does not understand. ─────────────────────────────────────
f="$(fixture broken 'this is not json')"
reap "$f" "$$" --now
rc="$RC"
if [ "$rc" = 1 ] && has "did not parse"; then ok "an unparseable registry refuses (fails closed)"
else bad "an unparseable registry must refuse (rc=$rc)"; fi

reap "$(fixture empty2 '{}')" "$$" --now --harder
rc="$RC"
if [ "$rc" = 1 ] && has "unknown flag"; then ok "an unknown flag is refused, never ignored"
else bad "unknown flags must be refused (rc=$rc)"; fi

# ── 6. The test seam cannot weaken a real reap. ─────────────────────────────────────────────────
# Every mention of the override must sit ABOVE cmd_reap(), i.e. inside the dry-run path only.
real_start="$(grep -n '^cmd_reap() {' "$ENV_SH" | cut -d: -f1)"
stray="$(grep -n 'ALETHIA_ENV_REGISTRY_FILE' "$ENV_SH" | cut -d: -f1 | awk -v s="$real_start" '$1 > s')"
if [ -n "$real_start" ] && [ -z "$stray" ]; then
	ok "ALETHIA_ENV_REGISTRY_FILE is confined to the dry run — a real reap always reads the box"
else
	bad "ALETHIA_ENV_REGISTRY_FILE leaked into the real reap path (lines: ${stray:-none}, cmd_reap at ${real_start:-?})"
fi

# ── 7. THE IDLE THRESHOLD. A box with no env rows is not an idle box (#3922). ───────────────────
# The dry run above answers the OWNERSHIP question only; the threshold that the unattended timer
# actually trips on lives further down cmd_reap, behind require_main_checkout, box_exists and an
# ssh — unreachable from a worktree. So this drives its two real halves instead, neither of them
# re-implemented here: the box script's `idle-minutes` for the number, and the condition LIFTED
# VERBATIM out of env.sh for the comparison. Break either one and these go red.

REGISTRY_SH="$ROOT/scripts/box/env-registry.sh"

# The threshold's default is read from env.sh rather than typed here, so raising it cannot leave
# a fixture silently on the wrong side of it.
REAP_AFTER_MIN="$(grep -oE 'ALETHIA_REAP_AFTER_MIN:-[0-9]+' "$ENV_SH" | head -1 | sed 's/.*:-//')"
if [ -n "$REAP_AFTER_MIN" ] && [ "$REAP_AFTER_MIN" -gt 0 ] 2>/dev/null && [ "$REAP_AFTER_MIN" -lt 360 ]; then
	ok "the reap threshold (${REAP_AFTER_MIN}m) was read from env.sh, and the 6h fixture clears it"
else
	bad "could not read a usable REAP_AFTER_MIN default from env.sh (got '${REAP_AFTER_MIN:-}')"
	REAP_AFTER_MIN=90
fi

# The gate, lifted. Matched on the threshold rather than on the operator ON PURPOSE: a mutation
# that flips `-lt` must red an ASSERTION below, not vanish from the grep and be reported as a
# missing line. Exactly one match is required — zero or several means this stopped watching what
# it thinks it watches.
# shellcheck disable=SC2016  # a literal $ — this is a grep pattern matched against env.sh's source
GATE_LINE="$(grep -n '"\$REAP_AFTER_MIN" \]; then' "$ENV_SH" || true)"
if [ "$(printf '%s\n' "$GATE_LINE" | grep -c .)" = 1 ]; then
	ok "the reap gate is a single line in env.sh, and this test is reading it"
else
	bad "expected exactly one reap-gate line in env.sh, found: ${GATE_LINE:-none}"
fi
# `  if <cond>; then` → `<cond>`
GATE_COND="$(printf '%s' "$GATE_LINE" | cut -d: -f2- | sed -e 's/^[[:space:]]*if[[:space:]]*//' -e 's/;[[:space:]]*then[[:space:]]*$//')"

gate() { # <idle-minutes> <now-flag: "" or 1> → blocked | proceeds
	# shellcheck disable=SC2034  # read by the condition lifted out of env.sh
	local idle="$1" now="$2"
	if eval "$GATE_COND"; then echo blocked; else echo proceeds; fi
}

# `date -u -d` is GNU-only and cmd_idle_minutes returns 0 for a timestamp it cannot parse — so on
# a BSD date EVERY case below would read 0 and "an empty registry must not reap" would pass for
# the wrong reason while "genuinely old must still reap" failed. Shim it rather than skip: the
# direction that keeps reaping ALIVE is the one a skip would silently stop running.
SHIM_DIR=""
if ! date -u -d "2020-01-01T00:00:00Z" +%s >/dev/null 2>&1; then
	SHIM_DIR="$TMP/shim"
	mkdir -p "$SHIM_DIR"
	cat >"$SHIM_DIR/date" <<'SHIM'
#!/usr/bin/env bash
# GNU `date -u -d <iso8601> +%s`, the one form cmd_idle_minutes uses, on a BSD date.
# Everything else passes straight through. Unparseable input must still FAIL here, because
# that is the branch env-registry.sh treats as "cannot tell".
if command -v gdate >/dev/null 2>&1; then exec gdate "$@"; fi
if [ "${1:-}" = "-u" ] && [ "${2:-}" = "-d" ]; then
	exec /bin/date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$3" "$4"
fi
exec /bin/date "$@"
SHIM
	chmod +x "$SHIM_DIR/date"
fi

BOX_ROOT="$TMP/box"
mkdir -p "$BOX_ROOT"
idle_for() { # <registry-json> → what the REAL box script reports
	printf '%s' "$1" >"$BOX_ROOT/envs.json"
	PATH="${SHIM_DIR:+$SHIM_DIR:}$PATH" ALETHIA_BOX_ROOT="$BOX_ROOT" \
		bash "$REGISTRY_SH" idle-minutes 2>/dev/null
}

# The control, and the proof that the date path works at all. If a 6h-old row does not read as
# roughly 6h, nothing else in this section means anything.
old_idle="$(idle_for "{\"other-lane\":$(row "$THEM" "$(old_iso)")}")"
if [ "${old_idle:-x}" -ge 300 ] 2>/dev/null && [ "$old_idle" -le 420 ] 2>/dev/null; then
	ok "a 6h-old lastSeen reads as ${old_idle}m — the idle arithmetic is being exercised"
else
	bad "a 6h-old lastSeen should read as ~360m, got '${old_idle:-}' (date path broken — the cases below prove nothing)"
fi

# ── the direction that stops the fix from disabling reaping ──
if [ "$(gate "$old_idle" "")" = proceeds ]; then
	ok "a genuinely idle box STILL reaps — failing safe on absence did not switch reaping off"
else
	bad "a registry ${old_idle}m stale must clear the ${REAP_AFTER_MIN}m threshold and reap"
fi

# ── the incident ──
empty_idle="$(idle_for '{}')"
if [ "$empty_idle" = "0" ]; then
	ok "an empty registry reports 0 idle minutes, not 999999"
else
	bad "an empty registry must report 0 idle minutes, got '${empty_idle:-}'"
fi
if [ "$(gate "$empty_idle" "")" = blocked ]; then
	ok "a box with NO env rows does not reap — the unattended timer leaves it alone (#3922)"
else
	bad "a box with no env rows must not reap: idle-minutes said '${empty_idle:-}', the gate proceeds"
fi

# The sibling absence case, asserted here too so the two read as one rule rather than two
# accidents: an unparseable timestamp has always failed safe, and now so does no timestamp.
bad_idle="$(idle_for '{"x":{"consolePort":3100,"lastSeen":"not-a-date"}}')"
if [ "$bad_idle" = "0" ] && [ "$(gate "$bad_idle" "")" = blocked ]; then
	ok "an unparseable lastSeen also fails safe — same question, same answer as no rows"
else
	bad "an unparseable lastSeen must fail safe, got '${bad_idle:-}'"
fi

# A live env is the ordinary "too early" case, and it must still be distinguishable from the two
# absences above: it blocks for a reason that WAS measured.
fresh_idle="$(idle_for "{\"other-lane\":$(row "$THEM" "$(now_iso)")}")"
if [ "${fresh_idle:-x}" -lt 5 ] 2>/dev/null && [ "$(gate "$fresh_idle" "")" = blocked ]; then
	ok "a freshly touched env blocks the timer, as it always did"
else
	bad "a freshly touched env must block (idle '${fresh_idle:-}')"
fi

# `--now` skips the threshold entirely — which is why failing safe does not strand a box forever.
if [ "$(gate "$empty_idle" 1)" = proceeds ] && [ "$(gate "$fresh_idle" 1)" = proceeds ]; then
	ok "--now bypasses the threshold, so a genuinely abandoned empty box is still reapable by hand"
else
	bad "--now must bypass the idle threshold"
fi

# ── #4009: the box that still answers 999999 ──────────────────────────────────────────────
# Everything above drives THIS tree's env-registry.sh, which can no longer emit 999999. A box
# provisioned before #3922 runs the old copy and still can, so the consuming side has to fold
# it. idle_normalise is lifted and RUN, not grepped for — the same reason idle_phrase is.
NORM_FN="$(sed -n '/^idle_normalise() {/,/^}/p' "$ENV_SH")"
if [ -n "$NORM_FN" ]; then
	eval "$NORM_FN"

	# The incident. A stale box's sentinel must reach the gate as "cannot tell", and be BLOCKED.
	stale="$(idle_normalise 999999)"
	if [ "$stale" = "0" ] && [ "$(gate "$stale" "")" = blocked ]; then
		ok "a pre-#3922 box still answering 999999 is folded to 0 and does NOT reap (#4009)"
	else
		bad "999999 from a stale box must fold to 0 and block, got '${stale:-}' / $(gate "${stale:-x}" "")"
	fi

	# The direction that stops the fold from disabling reaping. A real measurement must survive
	# it unchanged, or the fix has quietly switched reaping off for everyone.
	if [ "$(idle_normalise "$old_idle")" = "$old_idle" ] &&
		[ "$(gate "$(idle_normalise "$old_idle")" "")" = proceeds ]; then
		ok "a real ${old_idle}m measurement passes through the fold untouched and still reaps"
	else
		bad "idle_normalise must not alter a genuine measurement (${old_idle}m)"
	fi

	# The catch-all, and it is not decoration: a non-integer does not fail `-lt`, it makes `[`
	# exit 2, which reads as FALSE and falls through to the DESTROY path. An ssh that returned
	# nothing used to reap the box.
	for junk in "" "none" "12 34" "-5"; do
		if [ "$(idle_normalise "$junk")" = "0" ] && [ "$(gate "$(idle_normalise "$junk")" "")" = blocked ]; then
			ok "an unusable idle report ('${junk}') folds to 0 and blocks, rather than reaping"
		else
			bad "an unusable idle report ('${junk}') must fold to 0 and block"
		fi
	done

	# …and it has to be WIRED. Found by mutation, exactly as the idle_phrase count fetch was:
	# deleting the wrapper leaves every assertion above green, because they all call
	# idle_normalise directly. What they cannot see is whether cmd_reap does. The ssh answer is
	# the ONLY arrival point for an idle report, so it must be the one place this is applied.
	# shellcheck disable=SC2016  # literal $ — grep patterns over env.sh's source
	arrivals="$(grep -cE 'env-registry\.sh idle-minutes' "$ENV_SH" || true)"
	# shellcheck disable=SC2016
	wrapped="$(grep -cE 'idle_normalise "\$\(ssh_box .*idle-minutes' "$ENV_SH" || true)"
	if [ "$arrivals" = 1 ] && [ "$wrapped" = 1 ]; then
		ok "the box's idle report is folded at its single arrival point in env.sh"
	else
		bad "idle_normalise is not wired: ${arrivals} arrival(s), ${wrapped} folded"
	fi
else
	bad "env.sh has no idle_normalise() — a pre-#3922 box's 999999 reaches the threshold raw"
fi

# ── the messages. "0m ago" about a registry with no rows in it is a claim nothing measured. ──
# idle_phrase is lifted and RUN, not grepped for: what matters is what it says, and both the
# "not reaping" and the "reaping" (snapshot) lines are built from it.
PHRASE_FN="$(sed -n '/^idle_phrase() {/,/^}/p' "$ENV_SH")"
if [ -n "$PHRASE_FN" ]; then
	eval "$PHRASE_FN"
	empty_msg="$(idle_phrase 0 0)"
	old_msg="$(idle_phrase 360 1)"
	unknown_msg="$(idle_phrase 360 "")"
	if [ "$empty_msg" != "$old_msg" ] && ! grep -q '0m ago' <<<"$empty_msg" && grep -q '360m ago' <<<"$old_msg"; then
		ok "'no activity recorded' and 'activity was long ago' read as different things"
	else
		bad "the reaper says the same thing for an empty registry as for a stale one: '$empty_msg'"
	fi
	# The count is best-effort. When it could not be read the wording must fall back to the
	# plain form, never to the empty-box claim.
	if [ "$unknown_msg" = "$old_msg" ]; then
		ok "an unreadable env count falls back to the plain phrasing"
	else
		bad "an unreadable env count must not change what the reaper claims (got '$unknown_msg')"
	fi
	# …and it has to be WIRED. Found by mutation: deleting the count fetch takes the messages
	# straight back to "activity was 0m ago" about an empty registry, with every assertion
	# above still green — idle_phrase passing its own test proves nothing if cmd_reap never
	# hands it a count.
	fetch_n="$(grep -cE '^[[:space:]]*envs="\$\(read_registry \| jq' "$ENV_SH" || true)"
	# shellcheck disable=SC2016  # literal $ again: grep patterns, not expansions
	calls="$(grep -oE 'idle_phrase "\$idle" "[^"]*"' "$ENV_SH" || true)"
	call_n="$(printf '%s\n' "$calls" | grep -c . || true)"
	# shellcheck disable=SC2016
	bare_n="$(printf '%s\n' "$calls" | grep -vc 'idle_phrase "\$idle" "\$envs"' || true)"
	if [ "$fetch_n" = 1 ] && [ "$call_n" -ge 2 ] && [ "$bare_n" = 0 ]; then
		ok "the env count is fetched once and reaches every message that reports idleness"
	else
		bad "idle_phrase is not wired: ${fetch_n} count fetch(es), ${call_n} call(s), ${bare_n} not passing \$envs"
	fi
	# The `--now` warning on the REAPING side is the one message that is not built from
	# idle_phrase — it says a different thing in each case, not a different phrasing of one
	# thing. It has no hermetic seam (it sits after require_main_checkout and an ssh), so this
	# is deliberately a SOURCE-SHAPE check and is stated as one: the warning block must branch
	# on the count before it claims "something was active Nm ago". Found by mutation — without
	# it, deleting that branch left every assertion above green.
	# shellcheck disable=SC2016  # literal $ — a grep pattern over env.sh's source
	warn_block="$(sed -n '/\[ -n "\$now" \] && \[ "\$idle" -lt 30 \]/,/^  fi$/p' "$ENV_SH")"
	# shellcheck disable=SC2016
	if grep -q '\[ "\$envs" = "0" \]' <<<"$warn_block" && grep -q 'no registered environments' <<<"$warn_block"; then
		ok "the --now warning branches on the count before claiming something was active"
	else
		bad "the --now warning claims 'something was active Nm ago' on a box with no env rows"
	fi
else
	bad "env.sh has no idle_phrase() — the reaper's messages cannot distinguish the two cases"
fi

kill "$OTHER_PID" 2>/dev/null
if [ "$fails" = 0 ]; then
	echo "env-reap guard: all passed"
else
	echo "env-reap guard: $fails failed" >&2
fi
exit "$fails"
