#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# `pnpm env:*` — run this branch's environment on the sandbox box instead of on your
# Mac. The Mac keeps the editor, git and the cheap checks; everything that RUNS the
# product lives on the box (see .claude/skills/dev/SKILL.md and CLAUDE.md).
#
#   env:up      ensure this branch has an environment, and that it is running
#               a NEW env comes up seeded with demo data   [--empty | --seed | --fresh]
#   env:push    rsync the working tree (the fast inner loop)   [--watch]
#   env:down    release this branch's environment
#   env:status  the box, every environment, capacity, cost
#   env:logs    tail this env's console  (sign-in codes are printed here)
#   env:open    open this env in a browser
#   env:ssh     shell on the box
#   env:check   tsc + lint + vitest ON THE BOX (worktrees are de-hydrated)
#   env:test    Playwright browser tests ON THE BOX; report + traces rsync'd back
#   env:runner  a provisioning runner pointed at this env
#   env:reap    snapshot + DELETE the box (stops the meter)
#               [--now] [--include-mine] [--dry-run = decide and print, destroy nothing]
#   env:timer   reap the box automatically once idle   [off|status]
#   env:box     create or restore the box   [--fresh = ignore snapshots]
set -euo pipefail

# ── $ROOT was doing three jobs at once, and only the first was right ──────────────
#
#   1. "this branch's working tree"      — correct: cd, slug(), push_tree's source
#   2. "where the box's IaC state lives" — WRONG: state is gitignored, so it exists ONLY
#                                          in the main checkout
#   3. "the box-global control scripts"  — WRONG: they belong to the shared box, not to
#                                          whichever branch last ran env:up
#
# Conflating 1 and 2 made every worktree report `box: down (reaped or never created)`
# while the box was up — `tofu output` does not error without state, it prints a warning
# and nothing, which box_ip's shape-check correctly swallows. That silence gated env:up,
# push, down, logs, ssh, check and runner: a session could not even RELEASE its own env.
#
# So they get separate names. MAIN_CHECKOUT is the same git-common-dir resolution
# .claude/hooks/session-runtime.sh uses.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

MAIN_CHECKOUT="$ROOT"
_git_common="$(git -C "$ROOT" rev-parse --git-common-dir 2>/dev/null || true)"
case "$_git_common" in
*/.git)
  # In a linked worktree the common dir is the MAIN checkout's .git; its parent is the
  # main checkout, which is the only tree holding terraform.tfstate / terraform.tfvars.
  MAIN_CHECKOUT="$(cd "$(dirname "$_git_common")" 2>/dev/null && pwd || echo "$ROOT")"
  ;;
esac

# The env registry's identity and the reap decision. Sourced from THIS tree (not the main
# checkout): it is a tracked file that ships with the script that uses it.
# shellcheck source=scripts/lib/env-owner.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/env-owner.sh"

TF_DIR="$MAIN_CHECKOUT/infra/sandbox"
SERVER_NAME="alethia-sandbox"
# The hcloud CLI's "active context" is ONE global value in ~/.config/hcloud/cli.toml,
# shared by every instance on this machine — and other sessions change it. It drifted to
# `tovr-sandbox` and then to `alethia-infra-tests` during a single task here, which made
# `hc server describe` fail and the live box read as DOWN.
#
# A wrong status is the mild failure. The severe one is env:reap: `server create-image`
# followed by `tofu destroy`, aimed at whatever project someone else last selected. So
# every call is pinned, and the active context is never consulted or mutated.
HCLOUD_CONTEXT_NAME="${ALETHIA_HCLOUD_CONTEXT:-alethia-sandbox}"
hc() { hcloud --context "$HCLOUD_CONTEXT_NAME" "$@"; }
SNAPSHOT_LABEL="role=sandbox"
REMOTE=/opt/alethia
# Idle minutes before env:reap will snapshot-and-delete. The restore path costs 1-2
# minutes and a box reaped out from under a long test run is far more expensive than a
# few idle euros, so this stays well clear of any real run (the longest measured browser
# run is 36 SECONDS).
#
# Was 180, sized for several people whose runs must not vanish mid-flight. With one user
# that is three idle hours after every session, and idle hours are the entire cost
# problem: Hetzner bills a server for as long as it EXISTS, so the difference between a
# box reaped promptly and one left up is the difference between EUR 0.72/mo and EUR 69.49.
REAP_AFTER_MIN="${ALETHIA_REAP_AFTER_MIN:-90}"

# The launchd timer that makes the reap automatic. env:reap was complete and proven for
# days while nothing ever CALLED it, and a cost control you have to remember is not a
# cost control — the box ran 24/7 on that gap.
LAUNCH_LABEL="io.alethialabs.sandbox-reap"
LAUNCH_PLIST="$HOME/Library/LaunchAgents/$LAUNCH_LABEL.plist"
REAP_TIMER_LOG="${ALETHIA_REAP_LOG:-/tmp/alethia-reap.log}"
REAP_EVERY_SEC="${ALETHIA_REAP_EVERY_SEC:-1800}"

die() {
  echo "✗ $*" >&2
  exit 1
}

need() { command -v "$1" >/dev/null 2>&1 || die "$1 is required but not installed."; }

# ── Identity ──────────────────────────────────────────────────────────────────────
# The slug is the branch name with the feat/ prefix stripped and anything that is not
# a DNS label flattened — it becomes a hostname, a database name and a tmux session.
#
# ALETHIA_ENV_SLUG overrides the branch, for ONE reason: Cloudflare Universal SSL covers
# `alethialabs.io` and `*.alethialabs.io` — one label deep. A branch env is
# `<slug>.dev.alethialabs.io`, which is TWO labels and therefore has no publicly valid
# certificate. Anything that needs a cloud to fetch this console over VERIFIED TLS only
# works on the primary `dev.alethialabs.io`: the workload-identity issuer above all (AWS
# builds its IAM OIDC provider from the discovery doc, GCP STS and Entra re-fetch the
# JWKS on every exchange), plus OAuth redirects and the Stripe webhook, none of which can
# be wildcarded. Slug "dev" claims that hostname — and without this override only a
# checkout literally on branch `dev` could take it, i.e. the main checkout, the one
# CLAUDE.md §1 forbids working in. Set ALETHIA_ENV_SLUG=dev to claim it from a worktree.
slug() {
  local b
  b="${ALETHIA_ENV_SLUG:-$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo dev)}"
  b="${b#feat/}"
  b="${b#fix/}"
  b="$(printf '%s' "$b" | tr '[:upper:]/_' '[:lower:]--' | tr -cd 'a-z0-9-' | cut -c1-40)"
  b="${b%-}"
  printf '%s' "${b:-dev}"
}

# WHO holds an environment — `env_owner`, from scripts/lib/env-owner.sh, sourced above.
#
# It used to be `printf '%s@%s' "$(id -un)" "$(hostname -s)"` right here, and that string is
# IDENTICAL for every agent, worktree and shell on one machine. The reap guard below tests
# `.value.owner != $me`, so it could never fire between two local instances — which is how a
# finished lane deleted the box out from under another lane's live environment (#3841). The
# identity is now the worktree lease's, so the two isolation primitives on this box agree
# about what "who" means.

# The env's public hostname. ONE label deep, always.
#
# Branch envs used to be <slug>.dev.<domain>, which resolved fine and then failed TLS on
# every request: Cloudflare's Universal SSL covers the apex and ONE level of subdomain, so
# a two-level name is outside the certificate and the handshake is refused. Only `dev`
# itself worked. An Advanced Certificate would fix it for about the price of the box.
#
# So a hostname belongs to the SLOT, not the branch: the registry hands out a fixed console
# port per slot, and slot N is envN-<sub>.<domain>. `dev` keeps the bare name because OAuth
# redirect URIs and the Stripe webhook are registered against exactly that.
env_fqdn() { # <slug> <consolePort>
  local slug_="$1" port="$2" domain slot
  domain="$(env_domain)"
  [ "$slug_" = "dev" ] && {
    printf '%s' "$domain"
    return 0
  }
  # 3100 -> 1, 3200 -> 2, ... — the same pool env-registry.sh allocates from.
  slot=$(((port - 3000) / 100))
  printf 'env%s-%s' "$slot" "$domain"
}

# base64 of a RAW 64-byte ed25519 private key (seed||public). Go's ed25519.PrivateKey —
# and therefore verify.SigningKeyFromEnv — wants those 64 bytes, not a PEM, and openssl
# cannot emit them directly. For ed25519 both DER encodings are fixed-length, so the seed
# is the last 32 bytes of the PKCS8 DER and the public key the last 32 of the SPKI DER.
ed25519_raw_b64() {
  local der
  der="$(mktemp)"
  openssl genpkey -algorithm ED25519 -outform DER -out "$der" 2>/dev/null
  { tail -c 32 "$der"; openssl pkey -inform DER -in "$der" -pubout -outform DER 2>/dev/null | tail -c 32; } \
    | openssl base64 -A
  rm -f "$der"
}

# ── The box ───────────────────────────────────────────────────────────────────────
box_ip() {
  # Filter to a real IPv4 rather than trusting non-emptiness: with no state, `tofu
  # output -raw` prints "Warning: No outputs found" to STDOUT, which would sail past
  # a `[ -n "$ip" ]` test and make require_box believe the box is up — then every
  # rsync/ssh fails with a confusing hostname error instead of "run pnpm env:box".
  tofu -chdir="$TF_DIR" output -raw server_ipv4 2>/dev/null |
    grep -Eo '^[0-9]{1,3}(\.[0-9]{1,3}){3}$' || true
}

box_exists() {
  [ -n "$(box_ip)" ] && hc server describe "$SERVER_NAME" >/dev/null 2>&1
}

# Is an agent driving? Same signal scripts/lib/wt-lease.sh uses. Outside Claude this is
# unset, so a human is never gated by it.
agent_driving() { [ -n "${CLAUDE_PID:-}" ] && [ "${ALETHIA_ALLOW_IAC:-}" != "1" ]; }

require_box() {
  local ip

  # "I cannot read the state" and "the box is gone" used to produce the SAME message, and
  # the remedy it named (`pnpm env:box`) is catastrophic for the first case: applying
  # against empty state creates a SECOND server plus duplicate tunnel and DNS records,
  # breaking dev.alethialabs.io. Distinguish them, loudly.
  if [ ! -s "$TF_DIR/terraform.tfstate" ]; then
    cat >&2 <<MSG
✗ Cannot read the sandbox box's OpenTofu state.

  Looked in: $TF_DIR

  The state and terraform.tfvars are gitignored, so they exist ONLY in the main checkout
  — never in a worktree. This is NOT "the box is down", and running \`pnpm env:box\` here
  would apply against empty state and build a SECOND box, breaking dev.alethialabs.io.

  If you are in a worktree and see this, the resolution of MAIN_CHECKOUT above is wrong;
  that is a bug in this script, not something to work around.
MSG
    exit 1
  fi

  ip="$(box_ip)"
  if [ -z "$ip" ] || ! hc server describe "$SERVER_NAME" >/dev/null 2>&1; then
    cat >&2 <<MSG
✗ The sandbox box is not up.

  It was either never created, or env:reap snapshotted and deleted it (which is the
  normal idle state — a stopped Hetzner server still bills, a deleted one does not).
MSG
    if agent_driving; then
      cat >&2 <<'MSG'

  ASK THE MAINTAINER to bring it back. Restoring runs `tofu apply`, which is a human
  action in this repo (infra/README.md) and is refused for agents by
  .claude/hooks/guard-iac.sh. Do not try to route around that.
MSG
    else
      cat >&2 <<'MSG'

  Bring it back with:   pnpm env:box
MSG
    fi
    exit 1
  fi
  printf '%s' "$ip"
}

# Hetzner RECYCLES IP addresses. The first real apply landed on 178.104.237.182 — the
# address a previously-deleted box had held — so known_hosts still carried the old key and
# every ssh/rsync failed with "Host key verification failed". `accept-new` does NOT cover
# this: it accepts keys for UNKNOWN hosts, never a CHANGED one.
#
# That is fatal for a box designed to be reaped and recreated: each restore can land on a
# recycled address, and the whole env:* surface is SSH. So drop the stale entry when the
# box's key changes. This is not weakening host verification in any meaningful sense — the
# box is ours, we just created it, and its identity is the Hetzner API's answer, not a key
# we have ever pinned.
forget_stale_host_key() { # <ip>
  local ip="$1"
  ssh-keygen -R "$ip" >/dev/null 2>&1 || true
}

ssh_box() {
  local ip rc
  ip="$(require_box)"
  # shellcheck disable=SC2029  # remote expansion is intended
  ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 "root@$ip" "$@" && return 0
  rc=$?
  # NOT `if ! ssh …; then rc=$?`: inside that branch $? is the status of the NEGATION,
  # which is always 0, so the retry below would never fire. Verified in a shell before
  # relying on it.
  #
  # 255 is ssh's own transport failure — what a changed host key produces.
  [ "$rc" = 255 ] || return "$rc"
  forget_stale_host_key "$ip"
  ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 "root@$ip" "$@"
}

# The domain comes from state, or not at all. Both call sites used to fall back to the
# literal "dev.alethialabs.io", which turned a state-read failure into a confident wrong
# answer — and is why `env:open` appeared to work from a worktree while every other
# command was failing.
env_domain() {
  local d
  d="$(tofu -chdir="$TF_DIR" output -raw env_domain 2>/dev/null |
    grep -Eo '^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$' || true)"
  [ -n "$d" ] || die "cannot read env_domain from $TF_DIR — is the box's state readable?"
  printf '%s' "$d"
}

# ── Capacity preflight ────────────────────────────────────────────────────────────
# Hetzner answers an unavailable type with a bare `resource_unavailable`, which reads
# like a bug in this repo. ARM (cax*) has been out EU-wide for a while — see the long
# comment in infra/sandbox/variables.tf — so name the problem and the alternatives.
preflight_capacity() {
  local want loc avail
  want="$(grep -E '^\s*server_type' "$TF_DIR/terraform.tfvars" 2>/dev/null | sed -E 's/.*"([^"]+)".*/\1/' || true)"
  want="${want:-cpx42}"
  loc="$(grep -E '^\s*location' "$TF_DIR/terraform.tfvars" 2>/dev/null | sed -E 's/.*"([^"]+)".*/\1/' || true)"
  loc="${loc:-nbg1}"

  command -v hcloud >/dev/null 2>&1 || return 0
  avail="$(hc server-type list -o json 2>/dev/null |
    jq -r --arg w "$want" '.[] | select(.name == $w) | .name' || true)"
  [ -n "$avail" ] || return 0

  # `hc datacenter describe` carries the authoritative per-DC availability list.
  local dc ok
  dc="$(hc datacenter list -o json 2>/dev/null | jq -r --arg l "$loc" '.[] | select(.name | startswith($l)) | .name' | head -1)"
  [ -n "$dc" ] || return 0
  ok="$(hc datacenter describe "$dc" -o json 2>/dev/null |
    jq -r --arg w "$want" --slurpfile st <(hc server-type list -o json) \
      '[.server_types.available[]] as $a | ($st[0][] | select(.name==$w) | .id) as $id | if ($a | index($id)) then "yes" else "no" end' 2>/dev/null || echo yes)"

  if [ "$ok" = "no" ]; then
    echo "⚠ $want is OUT OF STOCK in $loc right now." >&2
    echo "  Available there with >=16 GB:" >&2
    hc datacenter describe "$dc" -o json 2>/dev/null |
      jq -r --slurpfile st <(hc server-type list -o json) \
        '[.server_types.available[]] as $a | $st[0][] | select(.id as $i | $a | index($i)) | select(.memory >= 16) | "    \(.name)  \(.cores)c \(.memory)GB \(.disk)GB \(.architecture)"' 2>/dev/null >&2 || true
    echo "  Set server_type in $TF_DIR/terraform.tfvars and retry." >&2
    echo >&2
  fi
}

# The two commands that MUTATE infrastructure. Both are gated twice on purpose.
#
# `.claude/hooks/guard-iac.sh` blocks the tofu command text — but `pnpm env:box` contains
# no "tofu" at all, and the real apply is spawned inside this script where no PreToolUse
# hook can see it. THE WRAPPER WAS THE BYPASS, and require_box used to point agents
# straight at it. A hook list of wrapper names can never be proven exhaustive, so the
# wrapped script refuses too — that check cannot be dodged by finding another wrapper.
#
# They also have to run where the state file is: a worktree writing the main checkout's
# state through a TF_DIR pointer is state mutation across trees.
# The lifecycle wrappers are agent-runnable by decision: the cost model needs the box
# reaped and restored without waiting for a human. Raw tofu apply/destroy is still refused
# by .claude/hooks/guard-iac.sh, so "an agent can apply arbitrary infrastructure" stays
# false — this only opens the two commands that manage THIS box.
#
# They still have to run where the state file is: a worktree writing the main checkout's
# state through a TF_DIR pointer is state mutation across trees.
require_main_checkout() { # <command>
  if [ "$ROOT" != "$MAIN_CHECKOUT" ]; then
    die "\`$1\` must run in the main checkout ($MAIN_CHECKOUT) — it writes OpenTofu state."
  fi
}

# An env touched inside this window counts as IN USE. It must stay BELOW REAP_AFTER_MIN or the
# unattended timer could never reap anything — cmd_timer asserts that, rather than trusting it.
REAP_LIVE_WINDOW_MIN=60

reap_cutoff() {
  date -u -v-${REAP_LIVE_WINDOW_MIN}M +%Y-%m-%dT%H:%M:%SZ 2>/dev/null ||
    date -u -d "$REAP_LIVE_WINDOW_MIN minutes ago" +%Y-%m-%dT%H:%M:%SZ
}

# The registry, or nothing. Fails CLOSED at every call site: an empty answer means "assume
# someone is there", never "nobody is here".
read_registry() {
  ssh_box "$REMOTE/bin/env-registry.sh list" 2>/dev/null || true
}

# THE COMPENSATING CONTROL for letting agents reap.
#
# A hook cannot judge this — it does not know who holds which environment. This does: the
# registry records `owner` and `lastSeen` per env. Reaping deletes the box for EVERYONE, so
# an instance tidying up after itself must not end someone else's run, and `--now` must not
# be a way around that.
#
# The DECISION lives in scripts/lib/env-owner.sh (`env_reap_verdict`) and is self-tested there
# against fixture registries. This function is only the box round-trip and the message: the whole
# reason the defect survived is that the deciding was welded to an ssh call and could not be run.
#
# Fails CLOSED: if the registry cannot be read, assume someone is there.
reap_guard() { # <registry-json> <include-mine 0|1>
  local reg="$1" include_mine="${2:-0}" me cut rows verdict rc=0
  [ -n "$reg" ] || die "cannot read the env registry — refusing to reap a box that might be in use."
  me="$(env_owner)"
  cut="$(reap_cutoff)"

  # WHAT IS ABOUT TO BE DESTROYED, before it is destroyed. Every row, not just the blocking
  # ones: reaping takes the box, so an idle env dies with it. The reaping lane in #3841 reported
  # "confirmed box: down" and was, from its own point of view, entirely correct and careful.
  rows="$(env_reap_rows "$reg" "$me" "$cut" 2>/dev/null || true)"
  if [ -n "$rows" ]; then
    echo "→ reaping deletes the box, and with it every environment on it:"
    printf '%s\n' "$rows" | env_reap_render
  else
    echo "→ no environments are registered on the box."
  fi

  verdict="$(env_reap_verdict "$reg" "$me" "$cut" "$include_mine")" || rc=$?
  case "$verdict" in
  allow) return 0 ;;
  refuse-unreadable)
    die "the env registry did not parse — refusing to reap a box that might be in use."
    ;;
  refuse-others)
    {
      echo ""
      echo "✗ Not reaping — someone else is working on this box."
      echo ""
      printf '%s\n' "$rows" | awk -F'\t' '$5 == "live" && $1 != "mine"' | env_reap_render
      echo ""
      echo "  Reaping deletes the box for everyone, so this is refused even with --now."
      echo "  Ask them to run  pnpm env:down,  or wait for their env to go idle."
      # `… && { … }` here would make the whole group's status non-zero when there is no legacy
      # row, and `set -e` would kill the script BEFORE the `exit "$rc"` below — turning a
      # refusal that means "someone else is live" (3) into a bare 1.
      if printf '%s\n' "$rows" | grep -q '^legacy'; then
        echo ""
        echo "  A 'legacy user@host' owner predates #3841 and cannot be attributed to an"
        echo "  instance. It is counted as someone else's on purpose — that is the safe"
        echo "  reading. If it is yours, pnpm env:up rewrites it, or pnpm env:down releases it."
      fi
    } >&2
    exit "$rc"
    ;;
  refuse-mine)
    {
      echo ""
      echo "✗ Not reaping — your own environment is still live."
      echo ""
      printf '%s\n' "$rows" | awk -F'\t' '$5 == "live" && $1 == "mine"' | env_reap_render
      echo ""
      echo "  Reaping deletes the box, so this env goes too: the slot, its database, its"
      echo "  OpenFGA store and its tunnel. env:box restores the BOX, not the env."
      echo ""
      echo "  Finished with it?   pnpm env:down   (then reap)"
      echo "  Meant both?         pnpm env:reap --now --include-mine"
    } >&2
    exit "$rc"
    ;;
  *)
    die "unrecognised reap verdict '$verdict' — refusing to reap."
    ;;
  esac
}

# ── Commands ──────────────────────────────────────────────────────────────────────

# A Primary IP can only be attached to a STOPPED server, and the provider does not report
# `public_net` when it reads an existing one — so a server that did not get its IP at
# creation shows a permanent `+ public_net {...}` diff that no apply can settle while it
# runs. Applying it anyway is not a no-op: it DETACHES the address and then refuses to
# reattach ("server_not_stopped"), leaving the box running with no public IPv4.
#
# That is not theory. On 2026-07-29 it took the live box down — ssh dead, site 502 —
# because the plan said "update in-place, nothing destroyed" and that read as safe. It is
# not: in-place on a server's NETWORK CONFIG is a different thing from in-place on a label.
#
# The repair is to recreate the server, which gets public_net at creation and clears the
# drift for good. So the check names that, rather than leaving someone to discover it.
refuse_public_net_change_on_running_box() {
  local plan js pending status
  plan="$(mktemp)"
  # NO `trap ... RETURN` here. A RETURN trap set inside a function stays armed for LATER
  # function returns, where $plan is out of scope — and with `set -u` that is fatal. It
  # made env:box exit 1 AFTER a completely successful restore ("plan: unbound variable"),
  # which any caller checking the exit code would read as a failed restore.
  # Clean up explicitly instead; the paths are few and all of them are here.
  tofu -chdir="$TF_DIR" plan -input=false -out="$plan" >/dev/null 2>&1 || {
    rm -f "$plan"
    return 0
  }

  js="$(tofu -chdir="$TF_DIR" show -json "$plan" 2>/dev/null || true)"
  rm -f "$plan"
  [ -n "$js" ] || return 0
  pending="$(printf '%s' "$js" | jq -r '
    [ .resource_changes[]?
      | select(.address == "hcloud_server.sandbox")
      | select(.change.actions | index("update"))
      | select((.change.before.public_net // []) != (.change.after.public_net // []))
    ] | length' 2>/dev/null || echo 0)"
  [ "${pending:-0}" -gt 0 ] || return 0

  status="$(hc server describe "$SERVER_NAME" -o json 2>/dev/null | jq -r '.status // empty' || true)"
  [ "$status" = "running" ] || return 0

  cat >&2 <<'MSG'
✗ Refusing to apply: this would change the server's public_net while it is RUNNING.

  Hetzner can only attach a Primary IP to a STOPPED server. Applying anyway DETACHES the
  address and then fails to reattach it, leaving the box up with no public IPv4 — ssh dead,
  the site 502. That happened on 2026-07-29; the plan said "update in-place, nothing
  destroyed", which is not the same as safe for a network change.

  The drift is permanent for a server that did not receive its IP at creation, because the
  provider does not report public_net when it reads one.

  → Fix it by RECREATING the box, which attaches the address at creation:
        pnpm env:reap --now     # the Primary IP is protected and survives
        pnpm env:box            # comes back on the same address, drift gone

  → Or, if you must do it in place, stop the server first and accept the downtime.
MSG
  exit 4
}

# NON-INTERACTIVE ON PURPOSE. tofu apply/destroy prompt for approval, and anything that
# is not a terminal — an agent, a scheduled reap, CI — reads EOF and dies:
#   Enter a value: Error: error asking for approval: EOF
# env:reap hit exactly that after taking its snapshot. The prompt is not what makes these
# safe: guard-iac.sh (raw tofu still blocked), require_main_checkout and
# reap_guard all run before here. A prompt that only fires for humans
# adds nothing and breaks every other caller — including the nightly reap the cost model
# depends on.
cmd_box() {
  require_main_checkout "env:box"
  need tofu
  need jq
  refuse_public_net_change_on_running_box
  [ -f "$TF_DIR/terraform.tfvars" ] ||
    die "no $TF_DIR/terraform.tfvars — copy terraform.tfvars.example and fill it in."

  preflight_capacity

  # Restore from the newest snapshot if one exists, so a reaped box comes back with
  # its seeded databases and warm node_modules rather than empty.
  #
  # --fresh builds from the base image instead. Without it there was NO WAY to ignore a
  # snapshot, which made the documented cpx32 downsize impossible: Hetzner refuses to
  # restore a 320 GB (cpx42) snapshot onto a 160 GB (cpx32) disk, and cmd_box always
  # reached for the newest snapshot.
  local snap="" fresh=""
  [ "${1:-}" = "--fresh" ] && fresh=1
  if [ -z "$fresh" ] && command -v hcloud >/dev/null 2>&1; then
    snap="$(hc image list -t snapshot -l "$SNAPSHOT_LABEL" -o json 2>/dev/null |
      jq -r 'sort_by(.created) | last | (.id | tostring) + " " + (.disk_size | tostring)' || true)"
  fi

  local snap_id="${snap%% *}" snap_disk="${snap##* }"
  if [ -n "$snap_id" ] && [ "$snap_id" != "null" ]; then
    # Catch the disk mismatch HERE, with a message that names disks — Hetzner's own
    # failure arrives mid-apply and does not mention them at all.
    local want_disk
    want_disk="$(hc server-type describe "$(grep -E '^\s*server_type' "$TF_DIR/terraform.tfvars" 2>/dev/null |
      sed -E 's/.*"([^"]+)".*/\1/' || echo cpx32)" -o json 2>/dev/null | jq -r '.disk // empty' || true)"
    if [ -n "$want_disk" ] && [ -n "$snap_disk" ] && [ "$snap_disk" != "null" ] &&
      [ "${snap_disk%.*}" -gt "$want_disk" ] 2>/dev/null; then
      die "snapshot $snap_id is ${snap_disk}GB but the target server type has only ${want_disk}GB.
  Hetzner cannot restore onto a smaller disk. Either keep the larger type, or build fresh
  and accept losing the box's state:   pnpm env:box --fresh"
    fi
    echo "→ RESTORING from snapshot $snap_id (databases and warm node_modules preserved)"
    tofu -chdir="$TF_DIR" apply -input=false -auto-approve -var "image=$snap_id"
  else
    if [ -n "$fresh" ]; then
      echo "→ BUILDING FRESH (--fresh): no snapshot restored, so envs start empty"
    else
      echo "→ BUILDING FRESH: no snapshot found, so envs start empty"
    fi
    tofu -chdir="$TF_DIR" apply -input=false -auto-approve
  fi

  provision_box
  restore_live_envs
  echo "✓ box up at $(box_ip)"
}

# A power cycle or a restore kills every environment's `next dev`: the containers come back
# on their own (restart: unless-stopped) but tmux does not survive a reboot. After the
# 2026-07-29 power cycle the shared tier was healthy and every console was gone, which
# reads as "the box is broken" rather than "the sessions need restarting".
#
# The registry already knows which environments exist, so bring back exactly those.
restore_live_envs() {
  local reg slugs
  reg="$(ssh_box "$REMOTE/bin/env-registry.sh list" 2>/dev/null || true)"
  [ -n "$reg" ] || return 0
  slugs="$(printf '%s' "$reg" | jq -r 'keys[]' 2>/dev/null || true)"
  [ -n "$slugs" ] || return 0

  echo "→ restarting environments the box was running: $(printf '%s' "$slugs" | tr '\n' ' ')"
  printf '%s\n' "$slugs" | while read -r sl; do
    [ -n "$sl" ] || continue
    # Already up? tmux session present means the console survived; leave it alone.
    if ssh_box "tmux has-session -t 'alethia-$sl' 2>/dev/null"; then
      echo "    $sl — already running"
      continue
    fi
    echo "    $sl — restarting (run 'pnpm env:up' from its worktree if it needs a fresh push)"
    local row cport sport db
    row="$(printf '%s' "$reg" | jq -c --arg s "$sl" '.[$s]')"
    cport="$(printf '%s' "$row" | jq -r .consolePort)"
    sport="$(printf '%s' "$row" | jq -r .storagePort)"
    db="$(printf '%s' "$row" | jq -r .database)"
    # `keep` (the 6th argument), NOT the empty default. This loop restarts environments
    # THIS SESSION DOES NOT OWN — the shared `dev` integration env and whatever branch env
    # another instance holds — and env-mode.sh's empty default means "resolve against the
    # recorded mode", which for any env predating the marker resolves to a full seed:demo.
    # That would inject the demo org into other people's environments, and where their
    # demo owner's org already holds non-demo projects the seeder throws by design, the
    # boot exits 1, and the restore degrades into "✗ did not come back" for an env that
    # was fine. A restore restarts; it never writes data.
    # Exit 3 is env-mode.sh's "it is UP, and it is serving COMMUNITY entitlements" (boot_rc
    # there). It is not a failure to come back, and calling it one would name the wrong fault
    # on an env this restore does not own; it is also not a success, and folding it into the
    # `||` success path would leave the diagnostic that just printed above with nothing
    # saying it was a verdict.
    local restore_rc=0
    ssh_box "test -d $REMOTE/envs/$sl && $REMOTE/bin/env-mode.sh '$sl' '$cport' '$sport' '$db' '' 'keep'" || restore_rc=$?
    case "$restore_rc" in
    0) ;;
    3) echo "      ⚠ $sl is back but serving COMMUNITY entitlements (see above) — its owner must pnpm env:up" ;;
    *) echo "      ✗ $sl did not come back — pnpm env:up from its worktree" ;;
    esac
  done
}

# Push the box-side scripts, the pinned shared compose file and the tunnel
# credentials. Runs on every env:up so changing a box script never means rebuilding.
#
# FROM THE MAIN CHECKOUT, not from this branch. These files are the shared box's
# control plane — env-registry.sh arbitrates every env's ports and the cap — and this
# runs on EVERY env:up. Sourcing them from the branch meant whichever branch ran
# env:up last silently redefined the allocator for everyone else's env, including a
# branch that happened to be mid-edit on those very files.
provision_box() {
  local ip
  ip="$(require_box)"

  # A freshly created or restored box may hold a RECYCLED address whose old key is still
  # in known_hosts; clear it before the first connection rather than failing 60 times.
  forget_stale_host_key "$ip"

  # Wait for cloud-init on a freshly created box.
  for _ in $(seq 1 60); do
    ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=5 -o BatchMode=yes \
      "root@$ip" 'test -f /opt/alethia/READY' 2>/dev/null && break
    sleep 5
  done

  # …with ONE opt-in exception, for the branch that is CHANGING those files. Shipping the
  # main checkout's copy on every env:up means a scripts/box/** edit is otherwise
  # UNTESTABLE: env:up overwrites it with dev's copy before running it, so the change can
  # only ever be reviewed by reading it — and this repo has repeatedly shipped shell
  # changes that were green locally and inert in reality. Opt in explicitly and say so
  # loudly; the reason for the default is real, and this is not it being relaxed.
  local box_src="$MAIN_CHECKOUT"
  if [ "${ALETHIA_BOX_SCRIPTS_FROM_TREE:-}" = "1" ]; then
    box_src="$ROOT"
    echo "⚠ ALETHIA_BOX_SCRIPTS_FROM_TREE=1 — shipping THIS tree's scripts/box/ to the box."
    echo "  $box_src/scripts/box/"
    echo "  EVERY env on the box runs them, not just yours, until the next env:up from a"
    echo "  checkout without this set. Use it to test a scripts/box/** change, nothing else."
  fi
  rsync -az -e "ssh -o StrictHostKeyChecking=accept-new" \
    "$box_src/scripts/box/" "root@$ip:$REMOTE/bin/"

  # /opt/alethia/box.env carries the env cap and the domain. cloud-init wrote it once at
  # creation, but user_data is now ignored on the server (changing it FORCES REPLACEMENT
  # — bumping the cap once planned "1 to add, 1 to destroy" against the live box). So the
  # cap is delivered here instead, and takes effect on the next env:up.
  local cap dom
  cap="$(grep -oE 'env_cap[^0-9]+[0-9]+' "$TF_DIR/terraform.tfvars" 2>/dev/null | grep -oE '[0-9]+' | head -1)"
  dom="$(env_domain)"
  ssh_box "printf 'ALETHIA_ENV_DOMAIN=%s\nALETHIA_ENV_CAP=%s\n' '$dom' '${cap:-4}' > $REMOTE/box.env"
  ssh_box "mkdir -p $REMOTE/shared && mv $REMOTE/bin/shared-compose.yml $REMOTE/shared/docker-compose.yml && chmod +x $REMOTE/bin/*.sh"

  # Tunnel credentials, minted from tofu state — no `cloudflared tunnel login`, no
  # hand-scp'd file. Written only if absent: rewriting them is harmless but noisy.
  local creds id
  creds="$(tofu -chdir="$TF_DIR" output -raw tunnel_credentials 2>/dev/null || true)"
  id="$(tofu -chdir="$TF_DIR" output -raw tunnel_id 2>/dev/null || true)"
  if [ -n "$creds" ] && [ -n "$id" ]; then
    printf '%s' "$creds" | ssh_box "mkdir -p $REMOTE/cloudflared && cat > $REMOTE/cloudflared/credentials.json"
    printf '%s' "$id" | ssh_box "cat > $REMOTE/cloudflared/tunnel-id"
  fi
}

# rsync the WORKING TREE, uncommitted work included — the box exists to run what you
# have in front of you, not what you have pushed. node_modules/.next/.git are excluded:
# they are platform-specific or huge, and the box builds its own.
push_tree() {
  local ip slug_
  ip="$(require_box)"
  slug_="$(slug)"
  # --delete keeps the box honest about renames and deletions, which makes these two
  # excludes MANDATORY rather than tidy:
  #   .env                      is minted ON the box and exists nowhere else, so
  #                             --delete would remove it on every push; the next env:up
  #                             would then re-mint it with fresh secrets and invalidate
  #                             every live session on that env.
  #   apps/console/.env.local   holds the env's OpenFGA store id, likewise box-side.
  # Excluding .env also enforces the other half of the rule: even if a laptop worktree
  # does have one, its live keys can never be pushed to a snapshotted box.
  #   ee/dist                   is BUILT ON THE BOX and gitignored, so it is never in the
  #                             source tree and --delete removed it on every push (#3732).
  #                             The console then resolved COMMUNITY entitlements: a
  #                             team/active subscription row still got 403 upgrade_required,
  #                             because the paid `organizations` entitlement was not there to
  #                             grant. Nothing printed — a `next dev` server re-evaluates
  #                             lib/enterprise.ts on its next recompile, so the flip happened
  #                             with no restart and no message, and every enterprise-scoped
  #                             check against that env was silently vacuous.
  #                             Excluding it is not the whole fix and is not a licence for a
  #                             stale dist: build_ee below REBUILDS it after every push, on
  #                             the box, from the ee/src that was just pushed. The exclusion
  #                             closes the window in between, during which a recompile would
  #                             otherwise catch the console with no dist at all. It also means
  #                             a laptop that happens to have built one can never SEND it.
  rsync -az --delete \
    --exclude=node_modules --exclude=.next --exclude=.git --exclude=.turbo \
    --exclude=test-results --exclude=playwright-report --exclude='*.tfstate*' \
    --exclude=.terraform --exclude=/ee/dist \
    --exclude=/.env --exclude='.env.local' --exclude='.env.*.local' \
    --exclude='apps/*/.env.local' \
    -e "ssh -o StrictHostKeyChecking=accept-new" \
    "$ROOT/" "root@$ip:$REMOTE/envs/$slug_/"
}

# Rebuild @alethia/ee ON THE BOX, from the ee/src that was just pushed (#3732).
#
# Why this exists at all: ee/dist is gitignored, so it is only ever a build artefact of the
# machine the console runs on — and it is the difference between an env that resolves
# ENTERPRISE entitlements and one that resolves community. Without it loadEnterprise()'s
# require throws, getAuthPlugins() returns [], /api/auth/organization/* 404s, and
# lib/auth/scope.ts falls back to `{ orgId: userId }` with COMMUNITY_ENTITLEMENTS.
#
# Why after every push and not once: ee/src changes like any other source, and a dist built
# from an older one is the same silent lie in a different disguise. esbuild bundles a single
# entry point in about a second.
#
# Why on the BOX rather than rsyncing a local build: every other build already happens there,
# the box's own node_modules are what it links against, and a dist built on a laptop and
# shipped is exactly the stale artefact this is meant to stop existing.
#
# NOT best-effort. A failure here leaves the env resolving community entitlements, which is
# indistinguishable from a healthy env until something asks for a paid entitlement and reads
# the refusal carefully — the whole reason #3732 survived as long as it did.
build_ee() {
  local slug_
  slug_="$(slug)"
  # The install guard is for the callers that push into a slot without bringing it up —
  # env:check and env:test both push before they install, and `pnpm -F` needs the workspace
  # linked and esbuild present before it can build anything. A warm env skips it.
  ssh_box "set -e
    cd $REMOTE/envs/$slug_
    [ -f ee/package.json ] || exit 0
    [ -d node_modules ] || pnpm install --frozen-lockfile >/dev/null
    pnpm -F @alethia/ee build >/dev/null
    test -f ee/dist/index.js" || die "could not build @alethia/ee on the box.
  Until it exists, '$slug_' resolves COMMUNITY entitlements: a team/active subscription row
  is read correctly and the API still refuses invite-member with 403, because the paid
  'organizations' entitlement is not there to grant. Every enterprise-scoped check against
  that env would be vacuous, so this is refused rather than warned about.
  Look at:  pnpm env:ssh   then   cd $REMOTE/envs/$slug_ && pnpm -F @alethia/ee build"
}

cmd_push() {
  local slug_
  slug_="$(slug)"
  if [ "${1:-}" = "--watch" ]; then
    need fswatch
    echo "→ watching $ROOT — pushing to $slug_ on change (ctrl-c to stop)"
    push_tree
    build_ee
    # Debounced: --latency batches a burst of saves into one rsync, so a formatter
    # rewriting twenty files does not trigger twenty pushes.
    #
    # build_ee runs on every iteration, not just the first: a --watch session is exactly
    # where an ee/src edit is most likely, and a dist left behind by the first push would
    # then be stale for the rest of the session.
    fswatch -o -l 1 -e '\.git' -e 'node_modules' -e '\.next' -e '\.turbo' "$ROOT" |
      while read -r _; do
        push_tree && build_ee && echo "  pushed $(date +%H:%M:%S)"
      done
  else
    push_tree
    build_ee
    echo "✓ pushed to $slug_"
  fi
}

# A NEW env comes up SEEDED with demo data (apps/console/scripts/seed-demo.ts). It came
# up empty until 2026-09-01, so every list page rendered its empty state — a UI audit
# measured an empty product and nobody manually checking a branch env had ever seen a
# populated page.
#
#   --empty   bring it up with NO demo data, and REMEMBER that. On an env this already
#             seeded it TEARS THE DEMO ORG DOWN — skipping the seeder would leave every
#             demo row in place while the boot banner announced an empty env.
#   --seed    (re-)seed an env that is already up, refreshing the demo org
#   --fresh   drop the database first — which implies a re-seed, unless --empty
#
# --empty is not optional polish: the empty state is itself something the console has to
# render correctly, and it can only be checked against an org that has nothing in it. An
# env that can only be seeded proves half the contract. scripts/box/env-mode.sh resolves
# the flag against the mode it recorded last time; seed_decision() there is the matrix,
# and `bash scripts/box/env-mode.sh --self-test` exercises it.
cmd_up() {
  need jq
  need rsync
  local slug_ row cport sport db fresh="" seed="" a
  for a in "$@"; do
    case "$a" in
    --fresh) fresh="fresh" ;;
    # Refused rather than last-one-wins: "--empty --seed" has no defensible reading, and
    # quietly picking one of them decides the audit's answer for it.
    --empty | --seed)
      [ -z "$seed" ] || [ "$seed" = "${a#--}" ] ||
        die "--empty and --seed contradict each other."
      seed="${a#--}"
      ;;
    # An unrecognised flag is REFUSED rather than ignored. A silently dropped --empty
    # would hand back a seeded env that the caller believes is empty, and every
    # conclusion drawn from it would be wrong in a way nothing prints.
    *) die "unknown flag '$a' — env:up takes [--fresh] and one of [--empty|--seed]" ;;
    esac
  done
  slug_="$(slug)"

  provision_box

  echo "→ shared tier"
  ssh_box "$REMOTE/bin/env-shared.sh"

  echo "→ allocating environment '$slug_'"
  row="$(ssh_box "$REMOTE/bin/env-registry.sh alloc '$slug_' '$(env_owner)'")" || exit $?
  cport="$(printf '%s' "$row" | jq -r .consolePort)"
  sport="$(printf '%s' "$row" | jq -r .storagePort)"
  db="$(printf '%s' "$row" | jq -r .database)"

  echo "→ pushing working tree"
  push_tree
  mint_env "$slug_" "$cport" "$sport" "$db"

  # The flag refusal above stops at the LAPTOP, and a POSITIONAL argument has no handshake.
  # scripts/box/ ships from $MAIN_CHECKOUT (see provision_box), which CLAUDE.md §7 pins to
  # `dev` but does NOT auto-pull, so it drifts: an older env-mode.sh reads $1..$5, ignores
  # the 6th, seeds nothing and prints no seed: line — `env:up --seed` then hands back an
  # empty env with nothing anywhere saying the flag was dropped. Ask the SHIPPED script
  # whether it understands the argument before promising it.
  local mode_rc=0
  ssh_box "grep -q SEED_REQUEST $REMOTE/bin/env-mode.sh" >/dev/null 2>&1 || mode_rc=$?
  # ONLY rc 1 — grep's own "not found" — means the shipped script is stale. Anything else
  # (2 = no such file, 255 = ssh transport) is a broken box, and reading a failure as an
  # ABSENCE is how a guard names the wrong cause: it would send you to pull a checkout
  # that is already current. Those cases fall through, and the env-mode.sh call below
  # reports the real fault.
  if [ "$mode_rc" = 1 ]; then
    local stale="the box is running an env-mode.sh that predates demo seeding.
  It ships from $MAIN_CHECKOUT/scripts/box/, which drifts — refresh it and re-run:
      git -C $MAIN_CHECKOUT pull --ff-only"
    # A mode you asked for explicitly and silently did not get is a WRONG answer, so
    # refuse. With no flag the env still comes up, only unseeded: warn and continue.
    [ -z "$seed" ] || die "--$seed cannot be honoured — $stale"
    echo "⚠ this env will come up EMPTY — $stale" >&2
  fi

  # The touch happens WHATEVER the boot decided, and the boot's exit code is carried past it.
  # env-mode.sh's scope refusal fires AFTER tmux, the tunnel and the registry allocation — the
  # slot is claimed and a console is running by then — so letting `set -e` skip the touch would
  # leave the env holding a slot with a stale lastSeen, i.e. first in line for `env:reap` while
  # its owner is still working on it. lastSeen means "someone is using this", not "this is
  # healthy".
  local up_rc=0
  ssh_box "$REMOTE/bin/env-mode.sh '$slug_' '$cport' '$sport' '$db' '$fresh' '$seed'" || up_rc=$?
  ssh_box "$REMOTE/bin/env-registry.sh touch '$slug_'"
  [ "$up_rc" = 0 ] || exit "$up_rc"
}

# Write the env's .env — MINTED ON THE BOX, never copied from yours.
#
# Your .env carries live Stripe / SES / OAuth / Anthropic keys. Copying it onto a box
# that gets snapshotted, deleted and recreated would quietly turn a dev sandbox into
# an exfiltration surface. This writes the minimal set that boots the console far
# enough to authenticate, with freshly generated secrets, so nothing on the box can
# reach a real environment.
#
# Note what is DELIBERATELY ABSENT: ALETHIA_SES_REGION. With no SES region,
# getEmailConfig() returns ses:null and sendEmail LOGS the message instead of sending
# it (packages/email/src/{config,send}.ts) — so the sign-in code appears in
# `pnpm env:logs`. That is how a branch env signs in with zero copied credentials.
#
# Note what is DELIBERATELY PRESENT, and why each is GENERATED here rather than copied:
#
#   ALETHIA_OIDC_SIGNING_KEY  — the workload-identity issuer key. oidcIssuerConfigured()
#     (lib/oidc/issuer.ts) is a bare presence check on this one variable, and it gates
#     the ENTIRE managed-cloud connector surface: without it computePlatformConfigured()
#     reports aws/gcp/azure/alibaba as "not enabled on this instance", /api/oidc/jwks and
#     the discovery doc 404, and every /api/runners/<cloud>-token route returns 501. A
#     sandbox that cannot connect a cloud cannot exercise the product. Generated, never
#     copied: the hosted issuer's key must not exist on a box that gets snapshotted, and
#     each env being its own issuer is correct — a cloud trust is pinned to an issuer URL.
#   ALETHIA_RECEIPT_SIGNING_KEY — without it packages/core/verify emits receipts with
#     algorithm:"none" (verify/signing.go), so a deploy "succeeds" while producing
#     evidence that proves nothing. Unsigned evidence is the failure mode this key exists
#     to prevent, so a dev env should not be quietly exempt from it.
#   ALETHIA_SNAPSHOT_HMAC_KEY — config_snapshot integrity (lib/runners/snapshot-sig.ts).
#   ALETHIA_RUNNER_BOOTSTRAP_TOKEN — minting it here removes a two-pass dance: without
#     it the first `pnpm env:runner` generates one, appends it to this file, tells you to
#     restart the console and exits WITHOUT starting a runner (scripts/dev-runner.sh).
#
# Written once per env: re-minting BETTER_AUTH_SECRET would invalidate every live
# session on that env, including one you are in the middle of using. The same
# write-once rule is what makes the OIDC key safe across `env:up` — re-minting it would
# break every cloud trust already pinned to this issuer, and Entra caches the JWKS for
# ~24h so the breakage would outlive the fix. A reap-and-recreate DOES re-mint: reconnect
# the connectors, or stash this file before `pnpm env:reap`.
mint_env() {
  local slug_="$1" cport="$2" sport="$3" db="$4" fqdn url
  fqdn="$(env_fqdn "$slug_" "$cport")"
  url="https://$fqdn"

  local secret1 secret2 secret3 secret4 oidc_key receipt_key snapshot_key bootstrap_token
  secret1="$(openssl rand -hex 32)"
  secret2="$(openssl rand -hex 32)"
  # BASE64, not hex, and the difference is not cosmetic: this becomes
  # ALETHIA_CRED_ENCRYPTION_KEY, and apps/console/lib/crypto/secrets.ts does
  # `Buffer.from(raw, "base64")` and refuses anything that does not decode to exactly 32 bytes.
  #
  # `openssl rand -hex 32` is 64 characters; base64-decoding 64 characters yields 48 bytes, so
  # every env built before this line was fixed rejected its own key:
  #
  #   ALETHIA_CRED_ENCRYPTION_KEY must decode to 32 bytes (got 48) (status 400)
  #
  # i.e. NO connector could be created in ANY branch env. It went unnoticed because branch envs
  # cannot sign in (#2953), so nothing reached the connector flow — the sign-in gap was masking
  # whether the env worked. `-base64 32` is 44 characters and decodes to exactly 32 (#3372).
  secret3="$(openssl rand -base64 32)"
  secret4="$(openssl rand -hex 16)"
  # base64(PKCS8 RSA-2048 PEM) on ONE line — mirrors rsa_b64() in scripts/bootstrap-secrets.sh.
  oidc_key="$(openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 2>/dev/null | openssl base64 -A)"
  # base64 of the RAW 64-byte ed25519 private key (seed||public) — the shape Go's
  # ed25519.PrivateKey and verify.SigningKeyFromEnv expect, NOT a PEM. openssl has no
  # raw-ed25519 export, but the trailing 32 bytes of the PKCS8 DER are the seed and the
  # trailing 32 of the SPKI DER are the public key, both fixed-length for ed25519.
  # Mirrors ed25519_raw_b64() in scripts/bootstrap-secrets.sh.
  receipt_key="$(ed25519_raw_b64)"
  snapshot_key="$(openssl rand -base64 32)"
  bootstrap_token="$(openssl rand -hex 32)"

  # shellcheck disable=SC2029
  ssh_box "test -f $REMOTE/envs/$slug_/.env || cat > $REMOTE/envs/$slug_/.env" <<ENV
# Minted by scripts/env.sh for the '$slug_' environment. Not copied from any laptop.
ALETHIA_DATABASE_URL=postgres://alethia:alethia-dev-secret@localhost:5433/$db
ALETHIA_APP_DATABASE_URL=postgres://alethia_app:$secret4@localhost:5433/$db
ALETHIA_APP_DB_PASSWORD=$secret4
ALETHIA_DB_USER=alethia
ALETHIA_DB_NAME=$db
ALETHIA_DB_PORT=5433

ALETHIA_STORAGE_ENDPOINT=http://localhost:$sport
ALETHIA_STORAGE_REGION=us-east-1
ALETHIA_STORAGE_ACCESS_KEY_ID=alethia
ALETHIA_STORAGE_SECRET_ACCESS_KEY=alethia-dev-secret
ALETHIA_STORAGE_AUTO_CREATE_BUCKETS=true

NEXT_PUBLIC_APP_URL=$url
BETTER_AUTH_URL=$url
ALETHIA_WEB_ORIGIN=$url
BETTER_AUTH_SECRET=$secret1
CLI_JWT_SECRET=$secret2
ALETHIA_CRED_ENCRYPTION_KEY=$secret3

ALETHIA_OIDC_SIGNING_KEY=$oidc_key
ALETHIA_RECEIPT_SIGNING_KEY=$receipt_key
ALETHIA_SNAPSHOT_HMAC_KEY=$snapshot_key
ALETHIA_RUNNER_BOOTSTRAP_TOKEN=$bootstrap_token

OPENFGA_API_URL=http://localhost:8082
ALETHIA_DEPLOYMENT_MODE=hosted
# This box is a sandbox, and saying so is what makes the line above survivable. `hosted` is
# deliberate — it is how the sandbox rehearses Stripe-driven billing — but no mail credential
# is ever copied here, and packages/email correctly refuses to degrade a HOSTED deployment to
# the development log fallback. Without this flag those two truths cancelled out and sign-in
# was impossible on every branch env: the send returned 200, the throw was swallowed as a
# background task, and no code appeared anywhere (#2953). The carve-out needs this AND a
# non-production build, so a real deployment cannot open it.
ALETHIA_SANDBOX=1
ALETHIA_LICENSE_ACTIVE=false
ALETHIA_RUNNER_OPERATOR=self
PORT=$cport
ENV
}

cmd_down() {
  local slug_
  slug_="$(slug)"
  ssh_box "tmux kill-session -t 'alethia-$slug_' 2>/dev/null || true
           docker rm -f 'alethia-seaweed-$slug_' >/dev/null 2>&1 || true
           $REMOTE/bin/env-registry.sh release '$slug_'
           $REMOTE/bin/env-tunnel.sh >/dev/null 2>&1 || true"
  echo "✓ released '$slug_' (its database is kept — env:up --fresh drops it)"
}

# The same hash scripts/box/env-mode.sh computes, for YOUR working tree (#2812).
#
# BSD stat here, GNU find -printf there, and both must agree exactly: paths relative to the repo
# root, size, and mtime in WHOLE SECONDS. rsync -a preserves size and mtime, so an unchanged file
# hashes identically on both machines. Sub-second precision or an absolute path would differ for
# reasons unrelated to the code, and the check would cry wolf on every run.
tree_stamp() {
  (cd "$ROOT" && find apps packages -type f \
    \( -name '*.ts' -o -name '*.tsx' -o -name '*.css' -o -name '*.json' -o -name '*.mjs' \) \
    -not -path '*/node_modules/*' -not -path '*/.next/*' -print0 2>/dev/null |
    xargs -0 stat -f '%N %z %m' 2>/dev/null |
    LC_ALL=C sort | shasum -a 256 | cut -d' ' -f1)
}

# ── Is the page in my browser the code on my disk? ──
#
# The box is the only place anything visual can be checked, and the compile cache there can serve
# the PREVIOUS module while env:push and env:up both report success (#2812). env-mode.sh drops
# that cache whenever the pushed tree changed, so this should always agree — this is how you
# CONFIRM it rather than assume it, before trusting a visual pass.
cmd_verify() {
  need jq
  local slug_ url served local_
  slug_="$(slug)"
  local cport
  cport="$(ssh_box "$REMOTE/bin/env-registry.sh list" | jq -r --arg s "$slug_" '.[$s].consolePort // empty')"
  [ -n "$cport" ] || die "no environment for '$slug_' — run: pnpm env:up"
  url="https://$(env_fqdn "$slug_" "$cport")"
  local_="$(tree_stamp)"
  served="$(curl -fsS --max-time 20 "$url/api/health?shallow=1" 2>/dev/null | jq -r '.build // empty')"
  if [ -z "$served" ]; then
    echo "$slug_ did not report a build — it may still be starting, or predate this check." >&2
    echo "    Bring it up again (pnpm env:up) and retry." >&2
    exit 1
  fi
  if [ "$served" = "$local_" ]; then
    echo "OK  $url is serving YOUR tree"
    echo "    tree: $local_"
    return 0
  fi
  echo "MISMATCH  $url is serving a different tree than the one on your disk." >&2
  echo "    yours:  $local_" >&2
  echo "    served: $served" >&2
  echo "" >&2
  echo "    Do not trust a visual check against that page — it is not your code." >&2
  echo "    Most often you simply edited after the last push. Fix it with:" >&2
  echo "        pnpm env:push && pnpm env:up" >&2
  exit 1
}

# ── WHICH EDITION IS EACH ENV SERVING? ───────────────────────────────────────────
#
# `env:status` printed a URL, ports, an owner and a timestamp — everything about whether the
# process is up, and nothing about whether the product it is serving is the one you think.
# An env resolving COMMUNITY entitlements boots, serves and looks identical to a good one:
# a `team`/`active` subscription row is read correctly and the API still refuses
# invite-member with 403, because the paid `organizations` entitlement is not there to
# grant. That difference is invisible until something asks for a paid entitlement and reads
# the refusal carefully, which is how it survived until a Playwright spec did (#3732).
#
# So it is printed, for every env, on the command people already run. Measured against the
# RUNNING console on loopback — not inferred from ee/dist being on disk, because those two
# came apart: dist was present and correct while the console served community anyway
# (ALETHIA_EDITION had leaked in from another env through the tmux server's environment).
#
# THE SAME PROBE, not a second copy of it: `env-mode.sh --scope` is the one discriminator,
# and it is the one env:up boots against and env:test gates on. A reimplementation here is
# how a fix lands in one of three places — which is exactly what happened to the
# `|| echo 000` capture bug this call site used to carry.
#
# WHAT IT COSTS, because this is the cheap "who holds what" command and it now POSTs into
# every running console: the route writes nothing (better-auth refuses the empty body before
# any row exists), and the only expensive part — `next dev` compiling /api/auth/* on its
# first request — is paid ONCE PER CONSOLE, by the boot probe in env-mode.sh, before
# env:status ever asks. So the budget here is deliberately smaller than the boot's: the route
# is warm, and a console that is DOWN answers instantly with connection-refused rather than
# spending the timeout. Two tries at 10s only ever elapse against a console that is alive
# and busy.
#
# ONE ssh for all envs, and every branch prints something: a `?` from an env that did not
# answer must not read the same as an env that answered "enterprise" — a probe whose failure
# branch is indistinguishable from its success branch is not a check.
env_scopes() { # → lines of "<slug> <verdict>"
  local pairs script s p
  pairs="$(ssh_box "$REMOTE/bin/env-registry.sh list" 2>/dev/null |
    jq -r 'to_entries[] | "\(.key) \(.value.consolePort)"' 2>/dev/null)" || return 0
  [ -n "$pairs" ] || return 0

  # The probe body is built here and the slug/port pairs are appended as CALLS, rather than
  # piped to it: `bash -s` already owns ssh's stdin, so a loop reading pairs from stdin on the
  # far side would read the script itself.
  #
  # `?-stale-script` is its own answer and not folded into `?-no-answer`: scripts/box/ ships from
  # the main checkout and drifts (see the SEED_REQUEST handshake in cmd_up), so a box running
  # an env-mode.sh that predates --scope must say THAT rather than accuse a healthy console of
  # not answering.
  #
  # It is ASKED, not inferred from the failure. A catch-all `*) ?-stale-script` labelled every
  # unparsable answer a drifted checkout — an absent or non-executable bin/env-mode.sh, a
  # permission error, a future bug in scope_probe itself — and sent the operator to
  # `git pull --ff-only` on a checkout that is already current, which is the mistake cmd_up's
  # own handshake is written against ("reading a failure as an ABSENCE is how a guard names the
  # wrong cause"). So the shipped script is asked ONCE, in the same round trip, whether it
  # carries the probe, and the three causes get three labels: `?-stale-script` only when the
  # file was read and the probe is not in it, `?-no-probe` when it could not be read at all,
  # and `?-probe-failed-rcN` when the probe IS there and still did not produce a verdict —
  # the one case that is a defect in this code rather than in the box.
  script='
mode="'"$REMOTE"'/bin/env-mode.sh"
sup=0
grep -q scope_probe "$mode" >/dev/null 2>&1 || sup=$?
probe() {
  s="$1"; p="$2"
  case "$sup" in
    0) ;;
    1) echo "$s ?-stale-script"; return ;;
    *) echo "$s ?-no-probe"; return ;;
  esac
  rc=0
  v=$("$mode" --scope "$p" "'"$REMOTE"'/envs/$s/.env" 2 10 2>/dev/null) || rc=$?
  set -- $v
  case "${1:-}" in
    enterprise) echo "$s enterprise" ;;
    community)  echo "$s community-pinned" ;;
    DEFECT)     echo "$s COMMUNITY" ;;
    unknown)
      case "${2:-000}" in
        000|"") echo "$s ?-no-answer" ;;
        *)      echo "$s ?-http-${2}" ;;
      esac ;;
    *)          echo "$s ?-probe-failed-rc$rc" ;;
  esac
}'
  while read -r s p; do
    [ -n "$s" ] || continue
    script="$script
probe '$s' '$p'"
  done <<<"$pairs"
  ssh_box "$script" 2>/dev/null || true
}

cmd_status() {
  need jq
  local ip domain
  ip="$(box_ip)"
  if [ -z "$ip" ] || ! hc server describe "$SERVER_NAME" >/dev/null 2>&1; then
    echo "box:  down (reaped or never created) — pnpm env:box"
    return 0
  fi
  domain="$(env_domain)"

  local type created
  type="$(hc server describe "$SERVER_NAME" -o json 2>/dev/null | jq -r '.server_type.name // "?"')"
  created="$(hc server describe "$SERVER_NAME" -o json 2>/dev/null | jq -r '.created // empty')"
  echo "box:  up   $ip   $type   since ${created:-?}"
  echo "envs: (cap from infra/sandbox env_cap)"
  # The scope is asked of every env in one round trip, before the listing renders, and joined
  # in by slug. An env missing from `scopes` prints `?` rather than nothing: a blank line
  # there would read as "fine", which is the exact failure this is here to stop.
  local scopes
  scopes="$(env_scopes)"
  # `owner` is now an INSTANCE, not a machine — so this can finally say which one is you.
  # It is the same string env:reap compares, printed verbatim: a status line that renders a
  # prettier form of the value the guard tests is a second source of truth waiting to drift.
  ssh_box "$REMOTE/bin/env-registry.sh list" |
    jq -r --arg d "$domain" --arg scopes "$scopes" --arg me "$(env_owner)" '
      ($scopes | split("\n") | map(select(length > 0) | split(" ") | {key: .[0], value: .[1]}) | from_entries) as $sc |
      to_entries[] |
      "  \(.key)\n    url    https://\(if .key == "dev" then $d else "env" + (((.value.consolePort - 3000) / 100) | tostring) + "-" + $d end)\n    ports  console :\(.value.consolePort)  storage :\(.value.storagePort)\n    scope  \($sc[.key] // "?-not-probed")\n    owner  \(.value.owner)\(if .value.owner == $me then "   ← you" else "" end)   last seen \(.value.lastSeen)"'
  cat <<'NOTE'

  Scope: which EDITION that env's console is serving, measured against the running process
  — not inferred from ee/dist being on disk, because those two have come apart. `enterprise`
  is what production and CI run and what any org-scoped check must be read against.
  `COMMUNITY` (capitalised because it is almost never what you wanted) means the console
  resolved the community entitlement baseline: a team/active subscription row on that env is
  still refused with 403 upgrade_required, so EVERY enterprise-scoped verification on it is
  vacuous. Fix it with `pnpm env:up`; `community-pinned` means that env's .env asked for it.
  A leading `?` is the absence of an answer, never a verdict, and each one names the cause it
  actually measured: `?-no-answer` (the console did not respond), `?-http-NNN` (it answered,
  but not usefully), `?-stale-script` (the box's env-mode.sh was read and predates the probe —
  `git -C <main checkout> pull --ff-only`, then any `pnpm env:up` re-ships it), `?-no-probe`
  (that script could not be read at all — the box is broken, not the checkout stale) and
  `?-probe-failed-rcN` (the probe is on the box and exited N without producing a verdict; N is
  the lead — 126/127 mean the file is not runnable and any `pnpm env:up` re-ships it, anything
  else is a defect in the probe rather than in the box).

  Sign-in: OAuth redirect URIs cannot be wildcarded, so social sign-in and the Stripe
  test webhook only work on the PRIMARY env. Branch envs are email-OTP only — the code
  is printed in `pnpm env:logs`, because no SES credential is copied to the box.
NOTE
}

cmd_logs() { ssh_box "tail -n 200 -f /var/log/alethia-$(slug).log"; }

cmd_open() {
  local domain slug_ url
  slug_="$(slug)"
  cport="$(ssh_box "$REMOTE/bin/env-registry.sh list" | jq -r --arg s "$slug_" '.[$s].consolePort // empty')"
  [ -n "$cport" ] || die "no environment for '$slug_' — run: pnpm env:up"
  url="https://$(env_fqdn "$slug_" "$cport")"
  echo "$url"
  command -v open >/dev/null 2>&1 && open "$url"
}

cmd_ssh() {
  local ip
  ip="$(require_box)"
  echo "→ $SERVER_NAME  ($ip).  Attach to an env:  tmux attach -t alethia-<slug>"
  ssh -o StrictHostKeyChecking=accept-new -t "root@$ip" "cd $REMOTE/envs/$(slug) 2>/dev/null; exec bash -l"
}

# vitest_workers derives a worker cap for the console suite FROM AVAILABLE MEMORY, on the box, at
# the moment the suite is about to run.
#
# WHY THIS IS NOT A CONSTANT, AND NOT DERIVED FROM vCPU. Vitest defaults to one worker per vCPU —
# eight on this cpx42 — and each console worker measured ~2.7 GB resident. That is ~21 GB of demand
# on a 15 GB box which is ALSO holding an environment (next-server, seaweed, the shared postgres and
# openfga) and sometimes a kind cluster. On 2026-08-29 that combination took the box to load 380
# with 0 MB available for the better part of two hours: ssh timed out during banner exchange, docker
# and kind stopped answering entirely, and `env1-dev` — the integration environment every other
# session resolves against — served HTTP 000 for 30 s at a time.
#
# `next-server` NEVER DIED. Same pid throughout, answering 127.0.0.1:3100 in 12.4 s instead of 0.2 s.
# So nothing restarted it and no health check fired: the failure mode of an over-committed box is a
# environment that TIMES OUT, not one that exits, which is why sizing this correctly matters more
# than any recovery would.
#
# AVAILABLE, not total. Sizing against 15 GB total is exactly what makes eight workers look
# survivable — right up until an env is resident. `free -m`'s `available` column already accounts
# for reclaimable page cache, so it is the number that answers "how much can this run actually
# have". 2 GB is left aside for everything the suite itself is not.
#
# Clamped to at least 1 (a run that cannot fit still has to happen — slowly beats not at all) and at
# most nproc (more workers than cores buys nothing).
vitest_workers() {
  ssh_box 'avail=$(free -m | awk "/^Mem:/ {print \$7}"); cpus=$(nproc 2>/dev/null || echo 2); \
           w=$(( (avail - 2048) / 2700 )); \
           [ "$w" -lt 1 ] && w=1; [ "$w" -gt "$cpus" ] && w=$cpus; \
           echo "$w avail=${avail}MiB cpus=$cpus"'
}

# Worktrees are de-hydrated (no node_modules), so the checks that used to run locally
# run here. The box already has the install warm from env:up.
cmd_check() {
  local slug_ sizing workers
  slug_="$(slug)"
  push_tree
  # push_tree's --delete does not remove ee/dist any more, but it is still only ever a build
  # artefact of this box, and the console suite MEASURES the scope it resolves: without it
  # lib/auth/scope.ts falls back to `{ orgId: userId }` and org-scoped assertions go vacuous
  # rather than red. ci.yml builds it before its suites for exactly this reason (#3732).
  #
  # NO LIVE SCOPE PROBE HERE, unlike cmd_test, and the asymmetry is the point rather than an
  # omission: this suite does not drive the running console. vitest resolves @alethia/ee in
  # its own process, over ssh, out of the tree that was just pushed — so ee/dist on disk IS
  # the question, and the running console's answer would be about a process no assertion in
  # this run touches. The tmux server's environment cannot reach it either: ssh_box runs the
  # suite directly, not through a tmux session.
  build_ee
  # Measured on the box, not assumed here: another session's env may have landed since this one
  # started, and the right cap then is a different number.
  sizing="$(vitest_workers)"
  workers="${sizing%% *}"
  echo "→ console suite with --maxWorkers=$workers  (${sizing#* })  — the box is SHARED; vitest's"
  echo "  default of one worker per vCPU is ~2.7GiB each and has OOM'd this box before."
  # BOTH BOUNDS, and this is not belt-and-braces. Passing --maxWorkers alone dies with
  #   RangeError: options.minThreads and options.maxThreads must not conflict
  # because the pool's minimum comes from the default (vCPU-derived) while the maximum comes from
  # the flag, and a max below that minimum is rejected. Measured, not reasoned: `--maxWorkers=1`
  # alone fails on this repo's console config; with `--minWorkers=1` the same run passes.
  ssh_box "cd $REMOTE/envs/$slug_ && pnpm install --frozen-lockfile >/dev/null && \
           pnpm -C apps/console run check-types && pnpm -C apps/console run lint && \
           pnpm -C apps/console run test -- --maxWorkers=$workers --minWorkers=$workers"
}

# Browser tests, on the box. This is what the box is FOR — the Mac cannot run them.
#
# WHY ON THE BOX AND NOT FROM HERE, pointed at the tunnel: sign-in scrapes the one-time
# code out of the console's stdout (apps/console/e2e/helpers/otp.ts reads DEV_CONSOLE_LOG
# as a LOCAL file). That log only exists on the box, at /var/log/alethia-<slug>.log. No
# amount of pointing E2E_BASE_URL at the public URL fixes that — the Playwright process
# has to be able to read the file, so it has to be the same machine.
#
# The recipe mirrors the one CI already proves (.github/workflows/ci.yml, e2e-browser):
# install -> migrate -> browsers -> non-vacuity guard -> run -> collect artifacts. The box
# already has the first two warm from env:up.
cmd_test() {
  need jq
  local slug_ cport domain fqdn proj=""
  slug_="$(slug)"

  cport="$(ssh_box "$REMOTE/bin/env-registry.sh list" | jq -r --arg s "$slug_" '.[$s].consolePort // empty')"
  [ -n "$cport" ] || die "no environment for '$slug_' — run: pnpm env:up"
  fqdn="$(env_fqdn "$slug_" "$cport")"

  # Default to the project CI gates on. Anything else is opt-in and named.
  proj="${1:---project=hero}"

  push_tree
  # THE ONE THIS WAS FOUND ON (#3732). A browser suite is driven against the RUNNING console,
  # and this push used to delete ee/dist out from under it moments before the run started —
  # so the audit that asked for a paid entitlement got 403 upgrade_required from an env whose
  # billing row was correct, and read as a product defect. Build it back before anything is
  # driven, exactly as ci.yml's e2e jobs do.
  build_ee

  # …AND THEN ASK THE CONSOLE, because those are two different questions and this is the
  # command #3632 hit the difference on. `build_ee` proves ee/dist/index.js is on the box;
  # it does not prove the RUNNING console loaded it, and the whole finding behind this change
  # is that dist was present and correct while the console served community anyway. env:up
  # and env:status both measure the process; until now env:test still inferred from the file.
  #
  # AFTER build_ee, deliberately: push_tree runs before it and the push is what triggers the
  # recompile, so the window in which a recompile can land before the new dist is written
  # closes here — the probe is what observes which side of it this console ended up on.
  #
  # REFUSED, not warned. A browser suite against a community console does not fail, it goes
  # VACUOUS: every paid-entitlement assertion gets a correct 403 upgrade_required and the
  # report reads as a product defect. `unknown` stays a warning for the same reason the boot
  # does not refuse on it — an unanswered probe is not a verdict either way.
  local scope_ verdict_
  scope_="$(ssh_box "$REMOTE/bin/env-mode.sh --scope '$cport' '$REMOTE/envs/$slug_/.env' 3 30" 2>/dev/null || true)"
  verdict_="${scope_%% *}"
  case "$verdict_" in
  enterprise) ;;
  community)
    echo "⚠ '$slug_' is PINNED to the community build (ALETHIA_EDITION=community): every" >&2
    echo "  enterprise-scoped spec in this run will be vacuous, not passing." >&2
    ;;
  DEFECT)
    die "'$slug_' is serving COMMUNITY entitlements — ${scope_#* * }
  A team/active subscription row on it is still refused with 403 upgrade_required, so every
  enterprise-scoped spec would pass vacuously or fail for the wrong reason. Fix the env
  first:  pnpm env:up"
    ;;
  *)
    echo "⚠ could not measure which edition '$slug_' is serving: ${scope_:-no answer from the box}" >&2
    echo "  The run continues — read an entitlement failure with that in mind." >&2
    ;;
  esac

  # `playwright install --with-deps` needs root apt for ~16 shared libs (libnss3, libgbm1,
  # libasound2t64 ...) that cloud-init does not carry. We ssh as root, so this just works;
  # browsers cache in ~/.cache/ms-playwright, which the snapshot preserves, so it is a
  # first-run cost only.
  #
  # CI is deliberately UNSET: playwright.config.ts sets `reuseExistingServer: !isCI`, so
  # CI=1 would make Playwright boot its OWN server and fight the running env for the port.
  #
  # E2E_BASE_URL is the HTTPS tunnel URL, not localhost: the minted .env sets
  # BETTER_AUTH_URL to that hostname and Better Auth trusts only that origin, so a plain
  # http://localhost origin is rejected before any test can sign in.
  #
  # The --list guard is CI's: a testMatch drift that matches zero tests otherwise "passes".
  echo "→ browser tests for '$slug_' on the box  ($proj → https://$fqdn)"
  ssh_box "set -e
    cd $REMOTE/envs/$slug_
    pnpm install --frozen-lockfile >/dev/null
    pnpm -F console exec playwright install --with-deps chromium >/dev/null
    export DEV_CONSOLE_LOG=/var/log/alethia-$slug_.log
    export E2E_BASE_URL=https://$fqdn
    unset CI
    list=\$(pnpm -F console exec playwright test $proj --list 2>&1) || { echo \"\$list\"; exit 1; }
    echo \"\$list\" | grep -qE 'Total: [1-9][0-9]* test' || {
      echo '✗ that project matched 0 tests — testMatch drift, not a pass.' >&2; exit 1; }
    pnpm -F console exec playwright test $proj" || {
    echo "" >&2
    echo "✗ tests failed — pulling the report and traces back anyway." >&2
    fetch_artifacts "$slug_"
    restart_env_console "$slug_"
    exit 1
  }

  fetch_artifacts "$slug_"
  restart_env_console "$slug_"
}

# A dev-mode Next server that has served a Playwright run does not give the memory back.
# Measured on the box: an env sat at ~3 GB RSS before its first browser run and ~9 GB
# afterwards, and stayed there — while NODE_OPTIONS=--max-old-space-size=3072 was applied
# the whole time. The heap cap bounds V8's old space, not Turbopack's native memory or its
# workers, so it does not bound RSS at all.
#
# On a shared box that difference is three usable slots versus one, and it is the reason a
# smaller box could not host the very tests it exists to run. Restarting the console after
# a run costs one Next cold start and returns ~6 GB.
# RSS of everything running out of this env's tree. Resolved via /proc/<pid>/cwd, NOT by
# matching process args: a Next server's argv is literally "next-server (v16.2.12)" with no
# path in it, so an args grep silently matches nothing and reports 0.
env_rss_mb() { # <slug>
  ssh_box "tot=0
    for p in \$(pgrep -f next-server 2>/dev/null); do
      cwd=\$(readlink /proc/\$p/cwd 2>/dev/null)
      case \"\$cwd\" in */envs/$1/*|*/envs/$1) ;; *) continue ;; esac
      r=\$(awk '/VmRSS/{print \$2}' /proc/\$p/status 2>/dev/null)
      tot=\$((tot + \${r:-0}))
    done
    echo \$((tot / 1024))" 2>/dev/null || echo ""
}

restart_env_console() { # <slug>
  local slug_="$1" before after row cport sport db
  before="$(env_rss_mb "$slug_")"
  row="$(ssh_box "$REMOTE/bin/env-registry.sh list" 2>/dev/null | jq -c --arg s "$slug_" '.[$s] // empty')"
  [ -n "$row" ] || return 0
  cport="$(printf '%s' "$row" | jq -r .consolePort)"
  sport="$(printf '%s' "$row" | jq -r .storagePort)"
  db="$(printf '%s' "$row" | jq -r .database)"

  # `keep` (the 6th argument) for the same reason as restore_live_envs: this bounces a
  # console, it does not bring an env up. The empty default would resolve to a full
  # seed:demo on any env with no recorded mode — and here the boot's output is only surfaced
  # when it fails, so the only visible symptom would be a long pause.
  # CAPTURED, not discarded. The boot prints a diagnostic that names the fault — a missing
  # ee/dist, an ALETHIA_EDITION leaked into the tmux server, a seeder that threw — and
  # `>/dev/null 2>&1` threw all of it away and told the operator only that the console "did
  # not come back". The bounce itself is still non-fatal (the run it follows has already
  # happened), but the reason it failed has to survive.
  #
  # THE EXIT CODE IS READ, not just tested against 0. env-mode.sh exits 3 for "the console is
  # up, and it is serving COMMUNITY entitlements" (boot_rc there); making that case non-fatal
  # is what stops a restart from claiming a running console "did not come back", and reading
  # the 3 here is what stops the same case from printing a clean `console restarted` line and
  # discarding the diagnostic the boot just wrote. Those two halves were added together and
  # cancelled each other out until this branch.
  local out rc=0
  out="$(ssh_box "tmux kill-session -t 'alethia-$slug_' 2>/dev/null || true
           $REMOTE/bin/env-mode.sh '$slug_' '$cport' '$sport' '$db' '' 'keep'" 2>&1)" || rc=$?
  # 20, and it must stay LARGER than the scope diagnostic env-mode.sh prints: that block is
  # 16 lines and is followed by the `logs:` line, so a tail shorter than it decapitates the
  # `✗ … came up in COMMUNITY scope` headline and leaves the operator the supporting detail
  # with nothing saying what it supports.
  if [ "$rc" != 0 ]; then
    printf '%s\n' "$out" | tail -n 20 | sed 's/^/  │ /' >&2
  fi
  case "$rc" in
  0) ;;
  3)
    echo "  ⚠ the console is back, but it came up serving COMMUNITY entitlements — every" >&2
    echo "    enterprise-scoped check against '$slug_' is vacuous until its OWNER runs" >&2
    echo "    pnpm env:up from that branch's worktree." >&2
    ;;
  *)
    echo "  ⚠ console did not come back — pnpm env:up to restore it" >&2
    return 0
    ;;
  esac
  after="$(env_rss_mb "$slug_")"
  if [ -n "$before" ] && [ -n "$after" ]; then
    echo "  console restarted — ${before}MB → ${after}MB"
  else
    echo "  console restarted"
  fi
}

# Bring the report, screenshots and traces back. env.sh had no reverse path at all, so the
# only way to see a failure was to ssh in and read files by hand — which is exactly when
# you least want to. push_tree excludes both directories, so --delete never wipes them.
fetch_artifacts() { # <slug>
  local ip slug_="$1"
  ip="$(require_box)"
  mkdir -p "$ROOT/apps/console"
  rsync -az -e "ssh -o StrictHostKeyChecking=accept-new" \
    "root@$ip:$REMOTE/envs/$slug_/apps/console/playwright-report/" \
    "$ROOT/apps/console/playwright-report/" 2>/dev/null || true
  rsync -az -e "ssh -o StrictHostKeyChecking=accept-new" \
    "root@$ip:$REMOTE/envs/$slug_/apps/console/test-results/" \
    "$ROOT/apps/console/test-results/" 2>/dev/null || true
  echo "  report:  apps/console/playwright-report/index.html"
  echo "  traces:  apps/console/test-results/"

  # Snapshot storage is billed per GB and the box is snapshotted on every reap, so old
  # traces and 4K stills would quietly inflate the bill. Nothing else prunes them.
  ssh_box "find $REMOTE/envs/$slug_/apps/console/test-results -maxdepth 1 -mtime +3 -exec rm -rf {} + 2>/dev/null || true"
}

cmd_runner() {
  local slug_ cport
  slug_="$(slug)"
  cport="$(ssh_box "$REMOTE/bin/env-registry.sh list" | jq -r --arg s "$slug_" '.[$s].consolePort // empty')"
  [ -n "$cport" ] || die "no environment for '$slug_' — run: pnpm env:up"
  # MODE defaults to native. The box builds for its own architecture, and a runner IMAGE
  # BUILT here must never be mistaken for a fleet image — an arch mismatch is what churned
  # ~100 VMs in 8 hours once already. That argument is about building, not about running,
  # so MODE/CRED/RUNNERS/SLOTS/PROVIDERS are forwarded rather than pinned: MODE=docker with
  # a PULLED, already-published image is a legitimate way to run the shipped artifact
  # against this console. Never `REBUILD=1` here.
  #
  # CRED is load-bearing beyond credentials: dev-runner.sh derives the runner's OPERATOR
  # from it (bootstrap → managed, self → self), and the keyless AWS and GCP federation
  # branches only run when operator=managed. Leave it at bootstrap to exercise keyless.
  # go lives at /usr/local/go/bin, exposed by /etc/profile.d/go.sh — which only a LOGIN
  # shell sources. ssh_box runs a non-login, non-interactive shell, so native MODE's
  # `go build` died with "go: command not found" every time and no runner could ever be
  # built on the box. The path is the constant cloud-init installs to, not a guess:
  # infra/sandbox/templates/cloud-init.yaml.tftpl untars the toolchain into /usr/local.
  ssh_box "cd $REMOTE/envs/$slug_ && \
    PATH=\"/usr/local/go/bin:\$PATH\" \
    MODE='${MODE:-native}' CRED='${CRED:-bootstrap}' RUNNERS='${RUNNERS:-1}' \
    ${SLOTS:+SLOTS='$SLOTS'} ${PROVIDERS:+PROVIDERS='$PROVIDERS'} ${RUNNER_IMAGE:+RUNNER_IMAGE='$RUNNER_IMAGE'} \
    ALETHIA_WEB_ORIGIN=http://localhost:$cport bash scripts/dev-runner.sh"
}

# `env:reap --dry-run` — the decision, and nothing else. Writes nothing, needs no state file, and
# is the seam this guard was missing: before #3841 the only way to find out what the refusal would
# do was to reap something. ALETHIA_ENV_REGISTRY_FILE substitutes a fixture registry for the box's,
# and is honoured ONLY here — it can never influence a real reap (scripts/lib/env-reap-test.sh).
cmd_reap_dry_run() { # <include-mine 0|1>
  local reg rc=0
  if [ -n "${ALETHIA_ENV_REGISTRY_FILE:-}" ]; then
    echo "→ dry run against fixture registry ${ALETHIA_ENV_REGISTRY_FILE}"
    reg="$(cat "$ALETHIA_ENV_REGISTRY_FILE")"
  else
    box_exists || {
      echo "box already down — env:reap would do nothing."
      return 0
    }
    reg="$(read_registry)"
  fi
  echo "→ I am $(env_owner)"
  # reap_guard EXITS on a refusal, so the verdict reaches the caller as this script's exit
  # code (3 = someone else, 4 = my own env, 1 = unreadable). The rc dance is kept anyway: if
  # it is ever changed to return instead, the success line below must not print regardless.
  reap_guard "$reg" "$1" || rc=$?
  [ "$rc" = 0 ] || return "$rc"
  echo ""
  echo "✓ dry run: nobody is blocking. A real reap would snapshot and DELETE the box."
  echo "  (This answers the OWNERSHIP gate only — without --now a real reap also waits for"
  echo "   the box to be idle ${REAP_AFTER_MIN}m.)"
}

# Fold an idle report this tree can no longer produce into the one it can.
#
# #3922 fixed the PRODUCER: cmd_idle_minutes reports 0 for a registry with no rows instead of
# 999999, so an empty box is no longer maximally idle by construction. But `scripts/box/` ships
# to the box at PROVISION time, so a box created before that fix keeps running the old
# env-registry.sh and keeps answering 999999 until something re-ships it. The boxes the fix
# misses are therefore exactly the ones it was written for: a long-lived host nobody has run
# `env:up` against — which is the same thing as "a box that looks idle" (#4009).
#
# Normalising on ARRIVAL is what makes it retroactive, because the caller is always current
# even when the box is not.
#
# The answer stays a NUMBER, deliberately, and that is #3922's decision rather than a new one:
# the comparison below is `-lt`, and a word where a number is expected does not fail the
# comparison — it makes `[` exit 2, which reads as FALSE and falls through to the DESTROY path.
# Which is also why the catch-all is here: an ssh that returned nothing, or a truncated answer,
# used to reach `-lt` as a non-integer and reap the box. Absence is not idleness, so both fold
# to 0 — the same fail-safe answer, for the same reason, as the two branches in cmd_idle_minutes.
idle_normalise() { # <idle-report> → a non-negative integer; 0 means "cannot tell"
  case "$1" in
  999999) printf '0' ;;
  '' | *[!0-9]*) printf '0' ;;
  *) printf '%s' "$1" ;;
  esac
}

# What the reaper actually measured, in words. "Idle" is derived SOLELY from env lastSeen
# times, so on a box with no env rows there is nothing for it to have been idle FOR: the
# registry reports 0 minutes (fail-safe, scripts/box/env-registry.sh) and printing "most
# recent activity was 0m ago" about it is a claim nothing took a measurement for. That
# ambiguity is what turned #3922 into a traceback instead of a glance.
#
# <env-count> is best-effort and may be empty; an empty count falls back to the plain
# phrasing. Nothing may branch on it except a message.
idle_phrase() { # <idle-minutes> <env-count-or-empty>
  if [ "${2:-}" = "0" ]; then
    echo "no env activity is recorded — the registry holds no environments at all"
  else
    echo "most recent env activity was ${1}m ago"
  fi
}

cmd_reap() {
  need jq
  local idle envs="" now="" include_mine=0 dry="" a
  for a in "$@"; do
    case "$a" in
    --now) now=1 ;;
    # "My own other env is running" is also a reason to stop and ask: reaping deletes the box
    # for everyone, this lane included. A lane that legitimately owns both says so here.
    --include-mine) include_mine=1 ;;
    --dry-run) dry=1 ;;
    # Refused, never ignored — an unrecognised flag that is silently dropped is how
    # `--include-mine` would look exactly like a reap that was never gated.
    *) die "unknown flag '$a' — env:reap takes [--now] [--include-mine] [--dry-run]" ;;
    esac
  done

  # The dry run mutates nothing, so it does not need the state file and must work from a
  # worktree — which is where an agent asking "would this be safe?" actually is.
  if [ -n "$dry" ]; then
    cmd_reap_dry_run "$include_mine"
    return $?
  fi

  require_main_checkout "env:reap"
  box_exists || {
    echo "box already down — nothing billing but the IP (EUR 0.50/mo) and the snapshot."
    return 0
  }
  idle="$(idle_normalise "$(ssh_box "$REMOTE/bin/env-registry.sh idle-minutes")")"
  # Row count, for the MESSAGES only — it is what lets them say "no activity recorded"
  # rather than "activity was 0m ago". Deliberately fail-soft: a failure leaves it empty
  # and the wording falls back. It must never reach a decision, only an echo.
  envs="$(read_registry | jq -r 'length' 2>/dev/null || true)"

  # --now is "I am finished for the day". The idle threshold assumes several people whose
  # runs must not be reaped out from under them; with one user it mostly means the box is
  # NEVER reaped — and an unreaped box is the entire cost problem, because Hetzner bills a
  # server for as long as it EXISTS, running or not.
  #
  # This runs BEFORE the ownership guard on purpose. The unattended timer calls reap without
  # --now every 30 minutes, and its common case is "too early": that has to stay a cheap
  # message and exit 0, not a refusal. Nothing is destroyed either way — the guard still runs
  # before any snapshot or destroy below.
  if [ -z "$now" ] && [ "$idle" -lt "$REAP_AFTER_MIN" ]; then
    echo "not reaping: $(idle_phrase "$idle" "$envs") (threshold ${REAP_AFTER_MIN}m)."
    echo "  Finished for the day?  pnpm env:reap --now"
    return 0
  fi

  reap_guard "$(read_registry)" "$include_mine"

  if [ -n "$now" ] && [ "$idle" -lt 30 ]; then
    if [ "$envs" = "0" ]; then
      # NOT "something was active 0m ago" — nothing was, because nothing was registered.
      # The warning still fires: an empty registry is exactly the case where whatever is
      # using the box is invisible to this command (#3922).
      echo "⚠ --now on a box with no registered environments. The registry cannot see what else"
      echo "  may be using it — reaping anyway; anything in flight dies with the box."
    else
      echo "⚠ --now, but something was active ${idle}m ago. Reaping anyway; a run in flight will die."
    fi
  fi

  # Snapshot storage is billed per GB, so what is on disk when you reap is what you pay
  # to keep. env:test prunes old traces for this reason.
  echo "→ snapshotting before delete ($(idle_phrase "$idle" "$envs"))"
  hc server create-image --type snapshot \
    --description "alethia-sandbox $(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --label "$SNAPSHOT_LABEL" "$SERVER_NAME" ||
    die "snapshot failed — NOT deleting the box."

  # Prune AFTER the new snapshot succeeded, never before: old snapshots deleted ahead of
  # a snapshot that then fails is how you lose the box's state entirely.
  #
  # Nothing pruned these before, and cmd_reap makes one every time. At ~20GB and
  # EUR 0.0143/GB, 30 reaps is EUR 8.58/mo — more than the cpx32 box the reaping exists to
  # save money on. The saving leaked straight back out.
  local keep="${ALETHIA_SNAPSHOT_KEEP:-2}" stale
  stale="$(hc image list -t snapshot -l "$SNAPSHOT_LABEL" -o json 2>/dev/null |
    jq -r --argjson k "$keep" 'sort_by(.created) | reverse | .[$k:] | .[].id' || true)"
  if [ -n "$stale" ]; then
    echo "→ pruning $(printf '%s\n' "$stale" | grep -c .) old snapshot(s), keeping $keep"
    printf '%s\n' "$stale" | while read -r id; do
      [ -n "$id" ] && hc image delete "$id" >/dev/null 2>&1 || true
    done
  fi

  # Only the server is destroyed. The tunnel, the DNS records and the Primary IP stay, so
  # env:box brings the same hostnames back ON THE SAME ADDRESS.
  # -auto-approve: see the note above cmd_box. The gates that matter ran already.
  tofu -chdir="$TF_DIR" destroy -input=false -auto-approve -target=hcloud_server.sandbox
  echo "✓ reaped — the server meter has stopped. Still billing: the Primary IP"
  echo "  (EUR 0.50/mo, which is what keeps the address stable) and the snapshot."
  echo "  Restore with: pnpm env:box   (~1-2 min, SAME address; hostnames error until then)"
}

# `pnpm env:timer` — run env:reap on a schedule, so an idle box cannot survive the night.
#
# Deliberately runs reap WITHOUT --now: the script already does all the deciding, and it
# is safe unattended for a reason worth stating. reap_guard only counts envs touched in the
# last REAP_LIVE_WINDOW_MIN (60) minutes, and REAP_AFTER_MIN is 90 — so by the time a box is
# reapable, nothing can still be blocking it, MINE INCLUDED: the timer never passes
# --include-mine and never needs to. The two thresholds cannot deadlock as long as
# REAP_AFTER_MIN stays above the window, which cmd_timer asserts below rather than trusting.
#
# A run that fires too early prints "not reaping" and exits 0. That is the common case and
# it must stay cheap and silent.
cmd_timer() {
  case "${1:-on}" in
  status)
    if [ -f "$LAUNCH_PLIST" ]; then
      echo "installed: $LAUNCH_PLIST"
      # Capture, then match — do NOT pipe into `grep -q`. grep exits on the first match
      # and closes the pipe, launchctl takes SIGPIPE, and `set -o pipefail` reports the
      # pipeline as FAILED even though the match succeeded. It is timing-dependent, so
      # it passes in a quick test and then lies in the field: this reported "loaded: NO"
      # about a timer that was demonstrably loaded and had already run.
      local loaded=""
      loaded="$(launchctl list 2>/dev/null || true)"
      case "$loaded" in
      *"$LAUNCH_LABEL"*) echo "loaded:    yes (every $((REAP_EVERY_SEC / 60))m)" ;;
      *) echo "loaded:    NO — pnpm env:timer to reload" ;;
      esac
      echo "log:       $REAP_TIMER_LOG"
      [ -s "$REAP_TIMER_LOG" ] && {
        echo "last runs:"
        tail -5 "$REAP_TIMER_LOG" | sed 's/^/  /'
      }
    else
      echo "not installed — an idle box will bill until someone remembers."
      echo "  pnpm env:timer"
    fi
    return 0
    ;;
  off)
    launchctl unload "$LAUNCH_PLIST" 2>/dev/null || true
    rm -f "$LAUNCH_PLIST"
    echo "✓ timer removed. Nothing reaps the box now — pnpm env:reap --now by hand."
    return 0
    ;;
  on | "") ;;
  *) die "usage: pnpm env:timer [on|off|status]" ;;
  esac

  # A deadlock here is silent and expensive: the box would simply never be reaped.
  [ "$REAP_AFTER_MIN" -gt "$REAP_LIVE_WINDOW_MIN" ] ||
    die "REAP_AFTER_MIN is ${REAP_AFTER_MIN}m but reap_guard blocks on activity in the last
  ${REAP_LIVE_WINDOW_MIN}m — the timer could never reap. Raise it above ${REAP_LIVE_WINDOW_MIN}."

  # launchd does NOT give a job your shell's PATH; it gets /usr/bin:/bin:/usr/sbin:/sbin,
  # where none of these live. Resolve them now and embed the real directories, so the
  # failure is at install time and visible rather than at 3am in a log nobody reads.
  local paths="" p d
  for p in hcloud tofu jq ssh rsync; do
    d="$(command -v "$p" 2>/dev/null)" || die "$p is required by env:reap but not on PATH."
    d="$(dirname "$d")"
    case ":$paths:" in *":$d:"*) ;; *) paths="${paths:+$paths:}$d" ;; esac
  done
  paths="$paths:/usr/bin:/bin:/usr/sbin:/sbin"

  case "$MAIN_CHECKOUT$paths" in
  *'<'* | *'&'*) die "path contains XML metacharacters; refusing to write a broken plist." ;;
  esac

  mkdir -p "$(dirname "$LAUNCH_PLIST")"
  cat >"$LAUNCH_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LAUNCH_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$MAIN_CHECKOUT/scripts/env.sh</string>
    <string>reap</string>
  </array>
  <!-- require_main_checkout refuses to write OpenTofu state from anywhere else. -->
  <key>WorkingDirectory</key><string>$MAIN_CHECKOUT</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$paths</string></dict>
  <key>StartInterval</key><integer>$REAP_EVERY_SEC</integer>
  <!-- Also on login: a laptop shut mid-session is exactly when a box gets forgotten. -->
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$REAP_TIMER_LOG</string>
  <key>StandardErrorPath</key><string>$REAP_TIMER_LOG</string>
</dict>
</plist>
PLIST

  launchctl unload "$LAUNCH_PLIST" 2>/dev/null || true
  launchctl load "$LAUNCH_PLIST" || die "launchctl load failed — see $LAUNCH_PLIST"

  echo "✓ timer installed — env:reap runs every $((REAP_EVERY_SEC / 60))m and reaps the box"
  echo "  once it has been idle ${REAP_AFTER_MIN}m. An early run prints 'not reaping' and exits."
  echo "  log:     $REAP_TIMER_LOG          status:  pnpm env:timer status"
  echo "  remove:  pnpm env:timer off"
  echo ""
  echo "  This does NOT replace pnpm env:reap --now when you finish for the day — it only"
  echo "  guarantees a forgotten box dies within ${REAP_AFTER_MIN}m rather than billing all month."
}

case "${1:-}" in
box)
  shift || true
  cmd_box "$@"
  ;;
up)
  shift || true
  cmd_up "$@"
  ;;
push)
  shift || true
  cmd_push "$@"
  ;;
down) cmd_down ;;
status) cmd_status ;;
verify) cmd_verify ;;
logs) cmd_logs ;;
open) cmd_open ;;
ssh) cmd_ssh ;;
check) cmd_check ;;
test)
  shift || true
  cmd_test "$@"
  ;;
runner) cmd_runner ;;
reap)
  shift || true
  cmd_reap "$@"
  ;;
timer)
  shift || true
  cmd_timer "$@"
  ;;
*)
  # 5,23 is exactly the header block above (it grew a line when env:reap gained its
  # flags). It read 5,25 once and so printed `set -euo pipefail` and the first line of
  # the next comment section as if they were usage.
  sed -n '5,23p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 1
  ;;
esac
