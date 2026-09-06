#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Runs ON the box. Owns /opt/alethia/envs.json — the per-branch environment registry.
#
#   env-registry.sh alloc   <slug> <owner>   # existing env, or a new port set + database
#   env-registry.sh touch   <slug>           # bump lastSeen (what keeps env:reap away)
#   env-registry.sh store   <slug> <id>      # record this env's OpenFGA store id
#   env-registry.sh release <slug>           # give the ports and the row back
#   env-registry.sh list                     # the raw JSON
#   env-registry.sh idle-minutes             # minutes since the most recent lastSeen
#
# WHY THIS LIVES ON THE BOX rather than in scripts/env.sh: the registry is state
# SHARED between laptops and between concurrent Claude sessions, so the
# read-modify-write has to be serialised where the file is. `flock` on a sibling
# lockfile does that. Doing the same arithmetic client-side would let two `env:up`s a
# second apart read the same JSON and both pick :3100 — which is exactly the class of
# bug the repo's /tmp dir-locks exist to prevent locally.
#
# Writes are tmp+rename so a reader never sees a half-written file, which is why
# `list` can skip the lock.
set -euo pipefail

# ALETHIA_BOX_ROOT is overridable ONLY so the allocation logic can be exercised off
# the box (`env-registry.sh --self-test`). Port arithmetic under a lock is the part
# most likely to be subtly wrong and the most painful to debug over SSH, so it gets
# a test that runs anywhere. In production this is always /opt/alethia.
BOX_ROOT="${ALETHIA_BOX_ROOT:-/opt/alethia}"
REG="$BOX_ROOT/envs.json"
LOCK="$BOX_ROOT/envs.lock"

# shellcheck disable=SC1091
[ -f "$BOX_ROOT/box.env" ] && . "$BOX_ROOT/box.env"

# The cap is a memory budget, not a policy: each `next dev` holds ~2 GB, so on a 16 GB
# box the fourth environment is the one that starts swapping and turns every timing
# assertion into a coin flip. Set from tofu's env_cap via cloud-init.
CAP="${ALETHIA_ENV_CAP:-3}"

# Console ports and storage (SeaweedFS S3) ports are allocated in lockstep, one pair
# per env. Six slots so `env_cap` can be raised on a bigger box without touching this.
CONSOLE_POOL=(3100 3200 3300 3400 3500 3600)
STORAGE_POOL=(8341 8342 8343 8344 8345 8346)

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

lock() {
  if ! command -v flock >/dev/null 2>&1; then
    # flock is Linux-only and this script's whole purpose is serialising a
    # read-modify-write, so a missing flock must NEVER degrade to "carry on
    # unlocked" — that would reintroduce the exact double-allocation this file
    # exists to prevent. The single-threaded self-test is the one allowed
    # exception, and it is identified by having relocated the registry.
    if [ -n "${ALETHIA_BOX_ROOT:-}" ]; then return 0; fi
    echo "✗ flock is required to serialise registry writes and is not installed." >&2
    exit 5
  fi
  exec 9>"$LOCK"
  flock 9
}

ensure() { [ -s "$REG" ] || echo '{}' >"$REG"; }

# stdin -> registry, atomically.
save() {
  cat >"$REG.tmp"
  mv "$REG.tmp" "$REG"
}

cmd_alloc() {
  local slug="$1" owner="$2" cport sport count db i
  lock
  ensure

  cport="$(jq -r --arg s "$slug" '.[$s].consolePort // empty' "$REG")"
  if [ -n "$cport" ]; then
    # Idempotent: an env:up on a branch that already has one is a refresh, never a
    # second allocation. This is what makes env:up safe to run repeatedly.
    jq --arg s "$slug" --arg o "$owner" --arg n "$(now)" \
      '.[$s].owner = $o | .[$s].lastSeen = $n' "$REG" | save
    jq -c --arg s "$slug" '.[$s] + {slug: $s, created: false}' "$REG"
    return 0
  fi

  count="$(jq 'length' "$REG")"
  if [ "$count" -ge "$CAP" ]; then
    # Nothing is evicted automatically. A silent swap on a shared box means someone
    # else's 40-minute run dies with no message — the cap refuses instead, and names
    # who to ask.
    {
      echo "The box is full: $count/$CAP environments, and none of them are yours."
      echo
      jq -r 'to_entries[] | "  \(.key)\tconsole :\(.value.consolePort)\t\(.value.owner)\tlast seen \(.value.lastSeen)"' "$REG"
      echo
      echo "Nothing is evicted automatically. Ask a holder to run  pnpm env:down,"
      echo "or raise env_cap in infra/sandbox if the box has the memory for it."
    } >&2
    exit 3
  fi

  for i in "${!CONSOLE_POOL[@]}"; do
    local c="${CONSOLE_POOL[$i]}"
    if [ "$(jq --argjson p "$c" 'any(.[]; .consolePort == $p)' "$REG")" = "false" ]; then
      cport="$c"
      sport="${STORAGE_POOL[$i]}"
      break
    fi
  done
  [ -n "$cport" ] || {
    echo "no free port pair despite $count/$CAP rows — registry is inconsistent" >&2
    exit 4
  }

  # Postgres identifiers take underscores, DNS labels take hyphens; the slug is the
  # hyphen form and this is its one translation point.
  db="alethia_${slug//-/_}"
  jq --arg s "$slug" --argjson c "$cport" --argjson p "$sport" --arg d "$db" \
    --arg o "$owner" --arg n "$(now)" \
    '.[$s] = {consolePort: $c, storagePort: $p, database: $d, storeId: "", owner: $o, createdAt: $n, lastSeen: $n}' \
    "$REG" | save
  jq -c --arg s "$slug" '.[$s] + {slug: $s, created: true}' "$REG"
}

cmd_touch() {
  local slug="$1"
  lock
  ensure
  jq --arg s "$slug" --arg n "$(now)" \
    'if has($s) then .[$s].lastSeen = $n else . end' "$REG" | save
}

cmd_store() {
  local slug="$1" id="$2"
  lock
  ensure
  jq --arg s "$slug" --arg i "$id" \
    'if has($s) then .[$s].storeId = $i else . end' "$REG" | save
}

cmd_release() {
  local slug="$1"
  lock
  ensure
  jq --arg s "$slug" 'del(.[$s])' "$REG" | save
}

# Minutes since the most recently touched env — what env:reap thresholds on.
#
# There are exactly two ways this cannot answer: no rows at all, and a lastSeen it cannot
# parse. They are the SAME question — "I cannot tell how long this box has been idle" —
# and both fail safe by reporting zero. That is one rule with two branches, not two
# branches with two policies.
#
# The zero-rows branch used to report 999999, which made a box with no environment on it
# MAXIMALLY idle by construction: "idle" here is derived solely from env lastSeen times,
# so an empty registry is not evidence that nobody is using the box — it is evidence that
# the registry knows nothing about what is. The unattended timer deleted a box on its
# first tick that way, twice in one session, with a Go toolchain and a live build on it
# (#3922). A box genuinely abandoned still reaps: `pnpm env:reap --now` skips the
# threshold entirely, which is what "I am finished for the day" already means.
#
# The output is a bare integer and must STAY one. scripts/env.sh compares it with `-lt`,
# and the copy answering is the one DEPLOYED on the box, which can lag the caller — a
# word where a number is expected would make that comparison error out and fall through
# to the destroy path.
cmd_idle_minutes() {
  ensure
  local latest then_s now_s
  latest="$(jq -r '[.[].lastSeen] | max // empty' "$REG")"
  if [ -z "$latest" ]; then
    # Nothing recorded means nothing measured. Fail safe: report zero idle time — the
    # same answer, for the same reason, as the unparseable-timestamp branch below.
    echo 0
    return 0
  fi
  # GNU date — this only ever runs on the Linux box, never on the mac.
  then_s="$(date -u -d "$latest" +%s 2>/dev/null || echo 0)"
  now_s="$(date -u +%s)"
  if [ "$then_s" -eq 0 ]; then
    # An unparseable timestamp must NOT read as "idle forever" — that would reap a
    # box someone is using. Fail safe: report zero idle time.
    echo 0
    return 0
  fi
  echo $(((now_s - then_s) / 60))
}

# ── Self-test ─────────────────────────────────────────────────────────────────────
# Runs entirely in a tempdir; touches no real registry. `date -u -d` is GNU-only, so
# the idle-minutes case is skipped on macOS rather than reported as a failure.
self_test() {
  local tmp pass=0 fail=0
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN
  export ALETHIA_BOX_ROOT="$tmp"
  export ALETHIA_ENV_CAP=3
  local me="${BASH_SOURCE[0]}"

  check() {
    if [ "$2" = "$3" ]; then
      pass=$((pass + 1))
    else
      fail=$((fail + 1))
      echo "  ✗ $1: expected '$3', got '$2'"
    fi
  }

  # First alloc takes the first slot of BOTH pools, in lockstep.
  local a
  a="$(bash "$me" alloc alpha me@host)"
  check "alpha console port" "$(jq -r .consolePort <<<"$a")" "3100"
  check "alpha storage port" "$(jq -r .storagePort <<<"$a")" "8341"
  check "alpha database" "$(jq -r .database <<<"$a")" "alethia_alpha"
  check "alpha is new" "$(jq -r .created <<<"$a")" "true"

  # A hyphenated slug must translate to underscores for Postgres but stay hyphenated
  # for DNS — this is the one translation point and it has been wrong before.
  local b
  b="$(bash "$me" alloc cache-engine-aws me@host)"
  check "second console port" "$(jq -r .consolePort <<<"$b")" "3200"
  check "hyphen -> underscore" "$(jq -r .database <<<"$b")" "alethia_cache_engine_aws"

  # Re-alloc is a refresh, NOT a second allocation — this is what makes env:up safe
  # to run repeatedly.
  local again
  again="$(bash "$me" alloc alpha someone@else)"
  check "realloc same port" "$(jq -r .consolePort <<<"$again")" "3100"
  check "realloc not created" "$(jq -r .created <<<"$again")" "false"
  check "realloc rebinds owner" "$(jq -r .owner <<<"$again")" "someone@else"
  check "still 2 rows" "$(bash "$me" list | jq 'length')" "2"

  # The cap refuses rather than evicting.
  bash "$me" alloc gamma me@host >/dev/null
  local rc=0
  bash "$me" alloc delta me@host >/dev/null 2>&1 || rc=$?
  check "4th alloc refused at cap 3" "$rc" "3"

  # Release frees the port for reuse, and the freed slot is the one handed out next.
  bash "$me" release alpha
  local reused
  reused="$(bash "$me" alloc delta me@host)"
  check "freed port reused" "$(jq -r .consolePort <<<"$reused")" "3100"
  check "freed storage reused" "$(jq -r .storagePort <<<"$reused")" "8341"

  bash "$me" store delta 01ABC
  check "store id recorded" "$(bash "$me" list | jq -r '.delta.storeId')" "01ABC"

  # An empty registry must fail SAFE (0 = busy), exactly like an unparseable timestamp:
  # both mean "I cannot tell", and neither is evidence the box is unused (#3922).
  bash "$me" release cache-engine-aws
  bash "$me" release gamma
  bash "$me" release delta
  check "empty registry fails safe" "$(bash "$me" idle-minutes)" "0"

  # An unparseable lastSeen must fail SAFE (0 = busy), never reap a box in use.
  if date -u -d "2020-01-01T00:00:00Z" +%s >/dev/null 2>&1; then
    echo '{"x":{"consolePort":3100,"lastSeen":"not-a-date"}}' >"$tmp/envs.json"
    check "bad timestamp fails safe" "$(bash "$me" idle-minutes)" "0"
  else
    echo "  · skipped idle-minutes date cases (GNU date not available)"
  fi

  echo "  ${pass} passed, ${fail} failed"
  [ "$fail" -eq 0 ]
}

case "${1:-}" in
--self-test) self_test ;;
alloc) cmd_alloc "${2:?slug}" "${3:?owner}" ;;
touch) cmd_touch "${2:?slug}" ;;
store) cmd_store "${2:?slug}" "${3:?store id}" ;;
release) cmd_release "${2:?slug}" ;;
list)
  ensure
  cat "$REG"
  ;;
idle-minutes) cmd_idle_minutes ;;
*)
  echo "usage: env-registry.sh {alloc <slug> <owner>|touch <slug>|store <slug> <id>|release <slug>|list|idle-minutes}" >&2
  exit 1
  ;;
esac
