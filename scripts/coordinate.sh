#!/usr/bin/env bash
#
# The coordinator pass — the light shared brain of the instance fleet. Stateless over the
# board, so any instance (or the maintainer) can run it; wrap in /loop for an always-on
# backend engine. See .claude/COORDINATION.md.
#
#   reclaim  stale leases (a dead instance's claim → freed, like #534 orphan-reclaim)
#   unblock  recompute the `blocked` label from each issue's `blocked-by:` line
#   report   per-wave board status + collisions to eyeball + UI units awaiting the human +
#            possibly-shipped units (open, but a merged PR references them — de-stale the board)
#
#            Collisions are BOTH halves COORDINATION.md promises: >1 claimed `mutex:migration`, and
#            overlapping `scope:` globs among the units workable at once. Each prints a verdict
#            either way, in THREE states — found · compared and clean · could not compare — because
#            until #4115 the scope half did not exist and its silence read as an all-clear.
#
# Usage:
#   scripts/coordinate.sh                 # reclaim + unblock + report
#   scripts/coordinate.sh --report        # report only (no mutations)
#   scripts/coordinate.sh --close-shipped # close open board units a MERGED PR CLOSES (kw + #n)
#   scripts/coordinate.sh --init-labels   # create/refresh the board's label set (once)
#   scripts/coordinate.sh --self-test     # offline: board-body parser + scope-report wiring
#
# --close-shipped is the manual BACKSTOP for the close-on-dev-merge Action: it reclaims/unblocks
# NOTHING, but for each open, still-claimable board unit that a MERGED PR CLOSES — a closing
# keyword (close|fix|resolve + tenses) directly before `#<n>`, in the PR TITLE or BODY — it closes
# the issue with a comment. Mirrors the Action's parser, so it retroactively catches the body-only
# `Closes #n` cases. A bare mention without a closing keyword is not a delivery and is left open.
#
# Env: ALETHIA_LEASE_TTL (seconds, default 3600) — a lease older than this with no heartbeat
#      is reclaimable.
set -euo pipefail
cd "$(dirname "$0")/.."

LEASE_TTL="${ALETHIA_LEASE_TTL:-3600}"
MODE="full"
case "${1:-}" in
  --report) MODE="report" ;;
  --close-shipped) MODE="close-shipped" ;;
  --init-labels) MODE="init" ;;
  --self-test) MODE="self-test" ;;
  "" ) MODE="full" ;;
  -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
  *) echo "unknown arg: $1" >&2; exit 2 ;;
esac

command -v jq >/dev/null || { echo "jq required" >&2; exit 1; }

# Read dependency issue numbers only from the machine-readable declaration line.
#
# THE ANCHOR IS RIGHT; DROPPING MARKDOWN DECORATION IS NOT. Anchoring to the start of a line is what
# stops a `blocked-by: #42` quoted mid-sentence in prose from being read as a declaration, and that
# is the bug this file exists to fix. But the anchor as first written also dropped `- blocked-by:
# #12` and `**blocked-by:** #12`, which the previous parser accepted and which are what a human
# hand-filing an issue actually types.
#
# That direction is the dangerous one. The unblock pass below treats an empty `deps` as "this issue
# has no dependencies" and REMOVES the `blocked` label — so a dropped declaration does not fail
# closed and leave a lane blocked, it fails OPEN and marks the lane READY while its seams issue is
# still open. Someone then claims work that is not ready to start. The old parser's failure was
# noisy; this one is silent.
#
# So the decoration is stripped and the anchor is kept: a leading list marker and any `**` come off
# first, then the same start-of-line match runs. A mid-sentence mention still does not match,
# because stripping decoration does not move it to the start of its line.
#
# A FENCED BLOCK IS NOT A DECLARATION, and the anchor alone cannot tell the difference — inside a
# fence the quoted line genuinely starts at column 0. That is the #3639 symptom exactly: the
# seeding snippet in .claude/skills/decompose/SKILL.md prints `blocked-by: #$SEAMS` at column 0
# inside a ```bash fence, so an issue body pasting that snippet with a real number acquires a
# phantom dependency and a permanent `blocked` label with nothing in its prose to explain it. So
# closed fenced blocks (``` or ~~~, delimiters included) are dropped before the match runs.
#
# CLOSED, deliberately. An UNTERMINATED fence leaves the rest of the body in play rather than
# swallowing it, because dropping it would fail OPEN — the unblock pass reads an empty `deps` as
# "no dependencies" and removes the `blocked` label — and one unclosed backtick run in a hand-typed
# body would silently mark a lane READY. Keeping those lines can only over-report, which fails
# closed and is visible.
blocked_by_from_body() {
  awk '
    { line[NR] = $0; drop[NR] = 0 }
    /^[[:space:]]*(```|~~~)/ {
      if (open) { for (i = start; i <= NR; i++) drop[i] = 1; open = 0 }
      else { open = 1; start = NR }
    }
    END { for (i = 1; i <= NR; i++) if (!drop[i]) print line[i] }
  ' \
    | sed -e 's/^[[:space:]]*[-*+][[:space:]]\{1,\}/ /' -e 's/\*\*//g' \
    | sed -n 's/^[[:space:]]*[Bb]locked-by:[[:space:]]*\(.*\)$/\1/p' \
    | grep -oE '#[0-9]+' | tr -d '#' | sort -nu || true
}

# ── scope collisions: the anti-tangle invariant, asked CONTINUOUSLY ──────────
#
# COORDINATION.md has always said this report flags "any collisions to eyeball (two claimed issues
# sharing `mutex:migration` OR AN OVERLAPPING `scope:`)". The second half was never written: until
# #4115 the whole collision check was the `mutex:migration` count below, and there was no `scope:`
# parsing anywhere in this file. So the ABSENCE of a warning line meant "at most one claimed
# migration unit" while reading as "no two claimed units share a scope" — a guard whose
# "nothing found" branch is indistinguishable from its "nothing wrong" branch.
#
# The predicate is NOT reimplemented here. scripts/lib/scope-overlap.mjs holds the one matcher (lifted
# out of decompose-validate.mjs, where it was module-private), so the seed-time check, this report
# and the dashboard cannot drift into three different answers — the hazard scripts/lib/board-pr.sh
# was created for. This function's only job is to CALL it and to make sure the reader can tell the
# three outcomes apart: overlap found · compared and clean · could not compare.
#
# Every branch prints. A `node` that is missing, a matcher that is absent from the checkout, a
# matcher that dies — each says so in the report rather than passing for silence.
SCOPE_MATCHER="${ALETHIA_SCOPE_MATCHER:-scripts/lib/scope-overlap.mjs}"
scope_collision_report() {
  local rc=0 out
  if ! command -v node >/dev/null 2>&1; then
    echo "  ── scope collisions (the anti-tangle invariant) ──"
    echo "  ⚠ scope collisions NOT CHECKED: node is not on PATH, so $SCOPE_MATCHER could not run."
    return 0
  fi
  if [ ! -f "$SCOPE_MATCHER" ]; then
    echo "  ── scope collisions (the anti-tangle invariant) ──"
    echo "  ⚠ scope collisions NOT CHECKED: $SCOPE_MATCHER is missing from this checkout."
    return 0
  fi
  # 0 clean · 3 collisions · 4 nothing comparable · 5 clean but some units unreadable. Anything
  # else is the matcher itself failing, and that is the third outcome too — not an all-clear.
  out="$(node "$SCOPE_MATCHER" --report 2>&1)" || rc=$?
  case "$rc" in
    0|3|4|5) printf '%s\n' "$out" ;;
    *)
      echo "  ── scope collisions (the anti-tangle invariant) ──"
      echo "  ⚠ scope collisions NOT CHECKED: $SCOPE_MATCHER exited $rc."
      [ -n "$out" ] && printf '%s\n' "$out" | sed 's/^/      /'
      ;;
  esac
  return 0
}

# Exercise the shell parser against the contract shared with the dashboard parser.
run_board_body_self_test() {
  local fixtures="scripts/lib/board-body-fixtures.json" fails=0 checks=0 cases fixture name body expected actual
  [ -f "$fixtures" ] || { echo "missing $fixtures" >&2; exit 1; }

  # READ THE CASES BEFORE THE LOOP. This was `done < <(jq -c '.cases[]' "$fixtures")`, and a jq
  # failure inside a PROCESS SUBSTITUTION is invisible to both `set -e` and `pipefail` — the shell
  # never sees its exit status. A fixtures file missing the `cases` key made jq write to stderr and
  # exit non-zero, the loop ran zero times, and the function printed "self-test: all passed" and
  # exited 0. Assigning to a variable puts the exit status back where the shell can act on it.
  cases="$(jq -c '.cases[]' "$fixtures")" || {
    echo "self-test: could not read .cases[] from $fixtures — the fixtures are unreadable, which is" >&2
    echo "  a failure, not an empty suite." >&2
    exit 1
  }

  while IFS= read -r fixture; do
    [ -n "$fixture" ] || continue
    name="$(jq -r '.name' <<<"$fixture")"
    body="$(jq -r '.body' <<<"$fixture")"
    expected="$(jq -r '.blockedBy | join(" ")' <<<"$fixture")"
    actual="$(printf '%s\n' "$body" | blocked_by_from_body | paste -sd' ' -)"
    checks=$((checks + 1))
    if [ "$actual" = "$expected" ]; then
      echo "ok   - $name"
    else
      echo "FAIL - $name: want '$expected' got '$actual'" >&2
      fails=$((fails + 1))
    fi
  done <<<"$cases"

  # AN EMPTY SUITE IS A FAILURE. `{"cases":[]}` ran zero checks and reported "all passed" — the
  # exact shape this guard is written to catch one level down, in its own reporting. A self-test
  # whose "nothing found" branch is indistinguishable from "nothing wrong" is not a self-test.
  [ "$checks" -gt 0 ] || {
    echo "self-test: $fixtures contains NO cases — asserting nothing is not passing." >&2
    exit 1
  }

  [ "$fails" -eq 0 ] || { echo "self-test: $fails of $checks check(s) FAILED" >&2; exit 1; }
  echo "self-test: all $checks passed"
}

# Exercise the SHELL half of the scope-collision check: that this file actually calls the matcher,
# renders whatever it says, and still prints a verdict when it cannot call it at all.
#
# The matcher's own semantics are proved by `node scripts/lib/scope-overlap.mjs --self-test` against
# the same fixture file. What THAT cannot see is the wiring — a guard that exists but is never
# invoked, or one whose failure branch prints nothing, looks exactly like a guard that is holding.
run_scope_wiring_self_test() {
  local fixtures="scripts/lib/board-body-fixtures.json" fails=0 checks=0 cases fixture name verdict board out want stub

  command -v node >/dev/null 2>&1 || {
    echo "self-test: node is required to exercise the scope-collision wiring" >&2
    exit 1
  }
  cases="$(jq -c '.boardCases[]' "$fixtures")" || {
    echo "self-test: could not read .boardCases[] from $fixtures — unreadable fixtures are a" >&2
    echo "  FAILURE, not an empty suite." >&2
    exit 1
  }

  while IFS= read -r fixture; do
    [ -n "$fixture" ] || continue
    name="$(jq -r '.name' <<<"$fixture")"
    verdict="$(jq -r '.verdict' <<<"$fixture")"
    board="$(jq -c '.board' <<<"$fixture")"
    out="$(printf '%s' "$board" | scope_collision_report)"

    case "$verdict" in
      COLLISIONS) want="⚠ SCOPE COLLISION" ;;
      NOT-CHECKED) want="NOT CHECKED" ;;
      CLEAN|CLEAN-WITH-GAPS) want="✓ compared, no overlap" ;;
      *) echo "self-test: fixture '$name' declares unknown verdict '$verdict'" >&2; exit 1 ;;
    esac

    checks=$((checks + 1))
    if printf '%s\n' "$out" | grep -qF "$want"; then
      echo "ok   - report renders $verdict: $name"
    else
      echo "FAIL - report renders $verdict: $name — no '$want' in:" >&2
      printf '%s\n' "$out" | sed 's/^/    /' >&2
      fails=$((fails + 1))
    fi

    # THE FAILING CASE THIS SUITE EXISTS FOR: a board nothing could be compared on must never
    # render the clean marker, and must never render as an empty block either. Both of those are
    # the silence #4115 was filed for, one level down.
    checks=$((checks + 1))
    if [ "$verdict" = "NOT-CHECKED" ] && printf '%s\n' "$out" | grep -qF "✓ compared, no overlap"; then
      echo "FAIL - a NOT-CHECKED board claimed a clean comparison: $name" >&2
      fails=$((fails + 1))
    elif [ -z "$(printf '%s' "$out" | tr -d '[:space:]')" ]; then
      echo "FAIL - the report block was EMPTY for $verdict: $name" >&2
      fails=$((fails + 1))
    else
      echo "ok   - $verdict is distinguishable from a clean pass: $name"
    fi
  done <<<"$cases"

  # The two ways the shell half itself can fail to check anything. Both must still SAY so.
  # Both run inside `$( … )`, a SUBSHELL, so overriding SCOPE_MATCHER for the call cannot leak
  # back into this function — a bash variable assignment prefixed to a FUNCTION persists, unlike
  # one prefixed to an external command, and a leaked override would silently disarm every check
  # that ran after it.
  # `-t` template needs X's: GNU mktemp REFUSES a template with fewer than three ("too few X's
  # in template"), while BSD/macOS accepts it — so the bare name passed locally and failed only
  # in CI, at the last two checks of this very suite.
  stub="$(mktemp -t alethia-scope-stub.XXXXXX)"
  checks=$((checks + 1))
  out="$(printf '[]' | SCOPE_MATCHER="$stub-does-not-exist.mjs" scope_collision_report)" || true
  if printf '%s\n' "$out" | grep -qF "NOT CHECKED"; then
    echo "ok   - an absent matcher reports NOT CHECKED, not silence"
  else
    echo "FAIL - an absent matcher printed no verdict" >&2; fails=$((fails + 1))
  fi

  # A matcher that dies with an unexpected status is also "could not check".
  printf '%s\n' '#!/usr/bin/env node' 'process.exit(9);' >"$stub.mjs"
  checks=$((checks + 1))
  out="$(printf '[]' | SCOPE_MATCHER="$stub.mjs" scope_collision_report)" || true
  if printf '%s\n' "$out" | grep -qF "NOT CHECKED"; then
    echo "ok   - a matcher that dies reports NOT CHECKED, not silence"
  else
    echo "FAIL - a dying matcher printed no verdict" >&2; fails=$((fails + 1))
  fi
  rm -f "$stub" "$stub.mjs"

  [ "$checks" -gt 0 ] || {
    echo "self-test: $fixtures contains NO boardCases — asserting nothing is not passing." >&2
    exit 1
  }
  [ "$fails" -eq 0 ] || { echo "self-test: $fails of $checks scope-wiring check(s) FAILED" >&2; exit 1; }
  echo "self-test: all $checks scope-wiring checks passed"
}

if [ "$MODE" = "self-test" ]; then
  run_board_body_self_test
  run_scope_wiring_self_test
  exit 0
fi

command -v gh >/dev/null || { echo "gh (GitHub CLI) required" >&2; exit 1; }

# Portable ISO-8601(Z) → epoch seconds (macOS BSD date vs GNU date).
# Prints NOTHING on a parse failure — deliberately not `echo 0`, which made `now - 0` ≈ now, so an
# unparseable stamp looked infinitely old and its lease was reclaimed INSTANTLY. A timestamp we
# can't read is a reason to leave the claim alone, not to take it.
to_epoch() {
  local ts="$1"
  date -u -d "$ts" +%s 2>/dev/null || date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$ts" +%s 2>/dev/null || true
}
now="$(date -u +%s)"

# ── init-labels ──────────────────────────────────────────────────────────────
if [ "$MODE" = "init" ]; then
  # The label set is DATA — scripts/lib/board-labels.json — and decompose-validate.mjs derives the
  # proposal-authorable names from that same file. This used to be a hard-coded list here plus a
  # hand-written mirror in the validator, and the two drifted: seven program waves were live on the
  # board while the validator rejected every one of them as `unknown label`.
  labels_json="$(dirname "${BASH_SOURCE[0]}")/lib/board-labels.json"
  [ -f "$labels_json" ] || { echo "missing $labels_json" >&2; exit 1; }
  mklabel() { gh label create "$1" --color "$2" --description "$3" --force >/dev/null && echo "  label: $1"; }
  while IFS=$'\t' read -r name color description; do
    [ -n "$name" ] || continue
    mklabel "$name" "$color" "$description"
  done < <(jq -r '.labels[] | [.name, .color, .description] | @tsv' "$labels_json")
  echo "✓ label set ready"
  exit 0
fi

# Pull the whole open board once.
board="$(gh issue list --state open --limit 300 --json number,title,labels,body,assignees)"
have() { echo "$board" | jq -e --arg n "$1" --arg l "$2" '.[]|select(.number==($n|tonumber))|.labels|map(.name)|index($l)' >/dev/null 2>&1; }

# has_closing_pr / has_active_pr — evidence that a holder is alive despite a stale lease. Both fail
# CLOSED (a gh failure reads as "yes, taken"): here a false "no" STRIPS a live instance's claim.
# Shared with claim-work.sh, which needs the identical predicates — this file used to carry a
# verbatim copy of has_closing_pr, and one protocol duplicated across call sites is how the xacct
# gate diverged three ways. See scripts/lib/board-pr.sh.
# shellcheck source=scripts/lib/board-pr.sh
. scripts/lib/board-pr.sh

# ── the merged-PR corpus, passed on DISK and never through argv ───────────────
# Both consumers below (the close-shipped closer and the possibly-shipped advisory) need the
# recent merged PRs. Both used to receive it as `jq --argjson merged "$merged"` — roughly 1 MB of
# JSON as a single command-line ARGUMENT.
#
# That quietly crossed ARG_MAX as the merged history grew (measured 2026-07-28: 1,059,524 bytes
# against a 1,048,576 limit — over by ~11 KB). The kernel then refuses the exec: jq never runs,
# the shell reports "Argument list too long" (exit 126), and BOTH call sites discarded it with
# `2>/dev/null || true`. An unset result then read as "found nothing" — so the closer reported
# "Nothing to close" and the advisory printed no section, on every run, for as long as the corpus
# has been over the line. Neither had a failure mode that said anything.
#
# A file has no size ceiling, and `--slurpfile` reads it directly. Keep it that way.
MERGED_PRS=""
fetch_merged_prs() {
  MERGED_PRS="$(mktemp -t alethia-merged-prs)"
  trap 'rm -f "$MERGED_PRS"' EXIT
  gh pr list --state merged --limit 300 --json number,title,body >"$MERGED_PRS" 2>/dev/null \
    || echo '[]' >"$MERGED_PRS"
}

# ── close-shipped: the manual backstop for the close-on-dev-merge Action ──────
# Mutates NOTHING on leases/blocks. For each open, still-claimable board unit that a MERGED PR
# CLOSES — a closing keyword (`close|fix|resolve` + tenses) directly before `#<n>`, in the PR
# TITLE or BODY — close the issue. This mirrors the `close-on-dev-merge` Action's parser exactly,
# so it's the retroactive backstop for units the Action didn't fire on (PRs merged before it
# existed, incl. the body-only `Closes #n` a title-only heuristic used to miss). A bare mention
# without a closing keyword is NOT a delivery and is never auto-closed. Idempotent (only OPEN
# units are in `board`). See .claude/COORDINATION.md.
if [ "$MODE" = "close-shipped" ]; then
  fetch_merged_prs
  # Emit "<issue> <pr-list>" pairs for every claimable unit a merged PR CLOSES (keyword + #n in
  # title or body — the same signal GitHub honours and the Action parses).
  #
  # NO `2>/dev/null || true` on this one: this path MUTATES the board. A tool failure must abort
  # loudly, never degrade into "nothing to close" — that silent-empty is precisely what let the
  # ARG_MAX break above run undetected.
  if ! strong="$(jq -r --slurpfile _m "$MERGED_PRS" '
    ($_m[0] // []) as $merged
    | .[]
    | select(.labels|map(.name)|any(startswith("class:")))                                 # board units only
    | select(.labels|map(.name)|any(. == "claimed" or . == "blocked" or . == "needs:human" or . == "needs:design")|not)
    | .number as $n
    | ($merged | map(select(                                                                # CLOSING keyword + #n, title OR body
        (((.title // "") + " " + (.body // ""))
         | test("(?i)\\b(close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)\\s+#\($n)\\b"))))) as $refs
    | select($refs|length > 0)
    | "\($n) \($refs|map("#\(.number)")|join(","))"
  ' <<<"$board")"; then
    echo "✗ close-shipped: could not evaluate the board (jq failed). Closing NOTHING." >&2
    exit 1
  fi
  if [ -z "$strong" ]; then
    echo "close-shipped: no open board unit is closed by a merged PR (keyword + #n in title/body). Nothing to close."
    exit 0
  fi
  closed=0
  while read -r n prs; do
    [ -z "$n" ] && continue
    gh issue close "$n" --comment "Closed by merged PR(s) ${prs} (coordinate --close-shipped backstop)." >/dev/null \
      && { echo "✓ closed #$n (shipped in ${prs})"; closed=$((closed+1)); } \
      || echo "  (could not close #$n — skipped)"
  done <<< "$strong"
  echo "close-shipped: closed $closed shipped board unit(s)."
  exit 0
fi

# ── reclaim stale leases ─────────────────────────────────────────────────────
# STALLED units: the lease is long dead AND the only reason we are not reclaiming is a PR that is
# itself stuck (conflicting, or untouched for PR_IDLE_TTL). Found via #1426/#1461: the lease was 8h
# past TTL, the worktree lease was free, the branch was 17 commits behind — and nothing surfaced it,
# because an open "Closes #1426" PR is, correctly, treated as evidence someone is on it.
#
# We deliberately do NOT reclaim these. Two reasons, and the second is the load-bearing one:
#   1. The guards in scripts/lib/board-pr.sh are FAIL-CLOSED by contract; weakening them to unstick a
#      board is how two instances end up building one unit (#1247).
#   2. It would not even work. claim-work.sh Guard 1 skips any unit with an open closing PR, so
#      stripping the label would only make the unit LOOK ready while the loop kept skipping it —
#      strictly worse than the honest "claimed" it shows today.
# So: name it loudly and let a human decide. `claim-work.sh --issue <n>` is the documented override.
PR_IDLE_TTL="${ALETHIA_PR_IDLE_TTL:-$(( LEASE_TTL * 4 ))}"
stalled_units=""
note_if_stalled() { # <n> <lease-age-seconds>
  local n="$1" age="$2" ref
  ref="$(stalled_pr_ref "$n" "$PR_IDLE_TTL")"
  [ -z "$ref" ] && return 0
  stalled_units="$stalled_units  #$n — lease dead ${age}s, blocked behind stalled PR $ref"$'\n'
}
reclaimed=0
# Runs in `full` AND `report`: the scan itself is read-only (lease comments + PR queries), and the
# stalled diagnostic below is worthless if you can only get it by running the mutating mode. The
# three writes are gated separately, further down.
if [ "$MODE" = "full" ] || [ "$MODE" = "report" ]; then
  for n in $(echo "$board" | jq -r '.[]|select(.labels|map(.name)|index("claimed"))|.number'); do
    stamp="$(gh issue view "$n" --json comments \
      --jq '[.comments[].body|select(startswith("```lease"))]|last // ""' \
      | sed -n 's/^stamped_at: //p' | tail -1)"
    [ -z "$stamp" ] && stamp="$(gh issue view "$n" --json comments \
      --jq '[.comments[].body|select(startswith("```lease"))]|last // ""' | sed -n 's/^claimed_at: //p' | tail -1)"
    if [ -z "$stamp" ]; then continue; fi
    stamp_epoch="$(to_epoch "$stamp")"
    # Unparseable stamp → leave it alone (see to_epoch).
    if [ -z "$stamp_epoch" ]; then
      echo "· #$n has an unreadable lease timestamp ('$stamp') — leaving the claim in place." >&2
      continue
    fi
    age=$(( now - stamp_epoch ))
    if [ "$age" -gt "$LEASE_TTL" ]; then
      # The docs promised this checked "PR/branch activity" and it never did — it reclaimed purely
      # on elapsed time, so a unit being actively built for over an hour without a heartbeat was
      # handed to a second instance. An open PR closing the issue is proof of a live holder.
      if has_closing_pr "$n"; then
        echo "· #$n lease is stale (${age}s) but a PR already closes it — not reclaiming." >&2
        note_if_stalled "$n" "$age"
        continue
      fi
      # Same evidence, the other phrasing: a PR delivering one tier of a multi-tier unit says
      # "Part of #n", never "Closes #n". Reclaiming on a stale lease alone would hand a unit that
      # someone is demonstrably still building to a second instance.
      if has_active_pr "$n"; then
        echo "· #$n lease is stale (${age}s) but open PR $(active_pr_ref "$n") is building it — not reclaiming." >&2
        note_if_stalled "$n" "$age"
        continue
      fi
      # `--report` reaches here too, so that the read-only mode can SEE what full mode would do.
      # Everything above this line is read-only; only the three writes below are gated on `full`.
      if [ "$MODE" != "full" ]; then
        echo "· #$n lease is stale (${age}s) and nothing is building it — reclaimable (report mode: not touching)." >&2
        continue
      fi
      who="$(echo "$board" | jq -r --arg n "$n" '.[]|select(.number==($n|tonumber))|.assignees[0].login // ""')"
      [ -n "$who" ] && gh issue edit "$n" --remove-assignee "$who" >/dev/null 2>&1 || true
      gh issue edit "$n" --remove-label claimed >/dev/null 2>&1 || true
      gh issue comment "$n" --body "reclaimed: lease stale (${age}s > ${LEASE_TTL}s, no heartbeat)" >/dev/null
      echo "↻ reclaimed #$n (stale ${age}s)"; reclaimed=$((reclaimed+1))
    fi
  done
fi

# ── unblock: recompute the `blocked` label from `blocked-by:` ───────────────
if [ "$MODE" = "full" ]; then
  for n in $(echo "$board" | jq -r '.[].number'); do
    body="$(echo "$board" | jq -r --arg n "$n" '.[]|select(.number==($n|tonumber))|.body // ""')"
    # `|| true`: grep exits 1 when an issue has no blocked-by; under `set -e` + pipefail that
    # non-zero command substitution would abort the whole pass on the first unblocked issue.
    deps="$(printf '%s\n' "$body" | blocked_by_from_body)"
    [ -z "$deps" ] && { have "$n" blocked && gh issue edit "$n" --remove-label blocked >/dev/null 2>&1 || true; continue; }
    open_dep=0
    for d in $deps; do
      st="$(gh issue view "$d" --json state --jq .state 2>/dev/null || echo OPEN)"
      [ "$st" = "OPEN" ] && open_dep=1
    done
    if [ "$open_dep" = "1" ]; then
      have "$n" blocked || gh issue edit "$n" --add-label blocked >/dev/null 2>&1 || true
    else
      have "$n" blocked && gh issue edit "$n" --remove-label blocked >/dev/null 2>&1 || true
    fi
  done
fi

# Refresh the board after mutations for an accurate report.
[ "$MODE" = "full" ] && board="$(gh issue list --state open --limit 300 --json number,title,labels,body,assignees)"

# ── report ───────────────────────────────────────────────────────────────────
echo
echo "──────── BOARD ($(date -u +%H:%MZ)) ────────"
echo "$board" | jq -r '
  def waveof: (.labels|map(.name)|map(select(startswith("wave:")))|(.[0]//"wave:—"));
  def st:
    (if (.labels|map(.name)|index("epic")) then "EPIC"
     elif (.labels|map(.name)|index("claimed")) then "CLAIMED"
     elif (.labels|map(.name)|index("blocked")) then "blocked"
     else "READY" end);
  sort_by(waveof, .number)[]
  | "  \(waveof|ltrimstr("wave:")|(.+"      ")[0:8]) #\(.number|tostring|(.+"    ")[0:5]) \(st|(.+"       ")[0:8]) \(.title[0:56]) \(if .assignees|length>0 then "→ "+.assignees[0].login else "" end)"
'
echo "  ─────"
# READY excludes epics: an umbrella/tracking issue is never claimable (it decomposes into sub-issues).
echo "$board" | jq -r '
  "  ready:   \(map(select((.labels|map(.name)|index("claimed")|not) and (.labels|map(.name)|index("blocked")|not) and (.labels|map(.name)|index("epic")|not)))|length)"
  + "   claimed: \(map(select(.labels|map(.name)|index("claimed")))|length)"
  + "   blocked: \(map(select(.labels|map(.name)|index("blocked")))|length)"
  + "   epics: \(map(select(.labels|map(.name)|index("epic")))|length)"
'

# Collisions to eyeball, BOTH halves of what COORDINATION.md promises: >1 claimed
# mutex:migration, and overlapping `scope:` globs among the units that can be worked at once.
# Each prints its verdict either way — "no line" was the whole defect (#4115).
migc="$(echo "$board" | jq '[.[]|select((.labels|map(.name)|index("claimed")) and (.labels|map(.name)|index("mutex:migration")))]|length')"
if [ "$migc" -gt 1 ]; then
  echo "  ⚠ COLLISION: $migc claimed migration units at once — only one may generate migrations."
else
  echo "  ✓ mutex:migration: $migc claimed (a collision needs 2 or more)."
fi
printf '%s' "$board" | scope_collision_report

# UI awaiting the human.
uis="$(echo "$board" | jq -r '[.[]|select(.labels|map(.name)|index("class:ui"))|select(.labels|map(.name)|index("needs:design") or (.labels|map(.name)|index("needs:human")))|"#\(.number) \(.title)"][]' 2>/dev/null || true)"
if [ -n "$uis" ]; then echo "  ── UI awaiting you ──"; echo "$uis" | sed 's/^/  /'; fi

# ── possibly-shipped: open board units a MERGED PR references but that never closed ──
# The stale-open failure mode: a multi-issue PR closes several units in one merge but omits
# the per-issue `Closes #n`, so GitHub creates no closing linkage and the issue never
# auto-closes — a future instance then re-claims finished work. Surface them to eyeball
# (heuristic — a reference is not a delivery; verify vs origin/dev before closing). Advisory
# only, never mutates, like the COLLISION flag above. See .claude/COORDINATION.md.
fetch_merged_prs

# ── DEBT REGISTERS: where a mention means the debt was NOT paid ──────────────
#
# possibly-shipped below asks "does a merged PR mention this number?" and reads a hit as evidence
# the unit shipped. For one whole class of PR that inference is exactly BACKWARDS.
#
# A ratchet/guard PR records the debt it chose NOT to pay by naming the issue in an exclusion file.
# Fourteen of these were verified by hand against origin/dev and NOT ONE had shipped: #3290/#3291
# were baselined into infra/tfvars-safety-baseline.json by the very PR the advisory credited
# (#3298, under a heading literally titled "Filed rather than folded in"); #3299/#3304 were declared
# in the add-on ratchets by #3305/#3316, which say in as many words "the two real ones are declared,
# not fixed". The mention IS the deferral.
#
# So ask the cheaper, sounder question first. An entry in a register is a committed, reviewed
# statement that the debt still stands — strictly better evidence than text proximity in a merge,
# and it costs one grep.
DEBT_REGISTERS="
infra/tfvars-safety-baseline.json
infra/offer-exclusions.yaml
infra/config-carriage-exclusions.yaml
infra/template-parity-exclusions.yaml
scripts/addons/render-nondeterministic.txt
scripts/addons/published-defaults-allowed.txt
"
DEBT_MAP="$(mktemp -t alethia-debt-map)"
trap 'rm -f "$DEBT_MAP"' EXIT
debt_registers_read=0
: >"$DEBT_MAP"
for _reg in $DEBT_REGISTERS; do
  [ -f "$_reg" ] || continue
  debt_registers_read=$((debt_registers_read + 1))
  # `#1234` anywhere in the register. Registers are prose-with-citations by design — every entry
  # carries its reason and the issue that owns it — so a line match is the right granularity.
  grep -oE '#[0-9]{2,6}' "$_reg" 2>/dev/null | tr -d '#' | sort -u | while read -r _n; do
    [ -n "$_n" ] && printf '%s\t%s\n' "$_n" "$_reg"
  done >>"$DEBT_MAP"
done

# GUARD THE GUARD. If not one register resolved, this inverted nothing — and silently letting every
# unit fall through to possibly-shipped would look identical to a clean sweep. Say which it is.
if [ "$debt_registers_read" -eq 0 ]; then
  echo "  ⚠ debt-registers: none of the $(echo "$DEBT_REGISTERS" | grep -c .) declared register files exist here — debt inversion SKIPPED, so possibly-shipped below is un-filtered." >&2
fi

# Advisory, so a failure warns and continues rather than aborting the report — but it must SAY so.
# The previous `2>/dev/null || true` turned a jq that could not even be exec'd into a silent
# "no hits", which is why this section never printed once (see fetch_merged_prs).
if ! ship="$(jq -r --slurpfile _m "$MERGED_PRS" '
  ($_m[0] // []) as $merged
  | [ .[]
    # EXACTLY the READY predicate used by the counts below — not a stricter one. The hazard is a
    # unit that still LOOKS claimable, so the set to police is by definition the set READY
    # publishes. This additionally required a `class:` label and excluded needs:human/needs:design,
    # neither of which READY does — so a unit with no class label (#1207, #1046, #1050, #1058) or a
    # needs:human one (#1268, #1065) was counted claimable on the dashboard and invisible here.
    # Worst case was #1207: two merged PRs named it in their TITLES — the strongest signal this
    # heuristic has — suppressed because the issue happened to carry only `wave:connectors-v2`.
    | select(.labels|map(.name)|any(. == "claimed" or . == "blocked" or . == "epic")|not)
    | .number as $n
    | ($merged | map(select((.title|test("#\($n)\\b")) or (.body|test("#\($n)\\b"))))) as $refs
    | select($refs|length > 0)
    | { n: $n, title: .title[0:46],
        strong: ($refs|map(select(.title|test("#\($n)\\b")))|length > 0),          # named in a PR title = likely closed
        prs: ($refs|map("#\(.number)")|join(",")) } ]
  | sort_by(.n)[]
  | "  #\(.n)  \(if .strong then "LIKELY" else "verify" end)  (merged \(.prs))  \(.title)"
' <<<"$board")"; then
  echo "  ⚠ possibly-shipped: could not evaluate (jq failed) — advisory SKIPPED, the board may be stale." >&2
  ship=""
fi
# Partition the rendered rows: a unit a register names is DEBT-RECORDED, and belongs under its own
# heading saying so, not under a heading inviting somebody to close it.
debt_rows=""; ship_rows=""
if [ -n "$ship" ]; then
  while IFS= read -r _row; do
    [ -n "$_row" ] || continue
    _n="$(printf '%s' "$_row" | sed -n 's/^  #\([0-9][0-9]*\) .*/\1/p')"
    _reg=""
    [ -n "$_n" ] && _reg="$(awk -F'\t' -v n="$_n" '$1 == n { print $2; exit }' "$DEBT_MAP")"
    if [ -n "$_reg" ]; then
      debt_rows="$debt_rows  #$_n  debt-recorded  ($_reg)$(printf '%s' "$_row" | sed 's/^  #[0-9]*  [A-Za-z]*  ([^)]*)//')
"
    else
      ship_rows="$ship_rows$_row
"
    fi
  done <<EOF
$ship
EOF
fi
if [ -n "$debt_rows" ]; then
  echo "  ── debt-recorded (a merged PR named it — to RECORD the debt, not to pay it; do NOT close) ──"
  printf '%s' "$debt_rows"
  echo "     An exclusion file naming an issue is a reviewed statement that the debt STANDS."
fi
if [ -n "$ship_rows" ]; then
  echo "  ── ⚠ possibly-shipped (open, but a MERGED PR references it — verify vs origin/dev, close if delivered) ──"
  printf '%s' "$ship_rows"
fi

# ── superseded nightly REDs: the board carrying an ANSWERED cell as open work ────
#
# A DIFFERENT AND STRONGER QUESTION than possibly-shipped above. That one asks "does a merged PR
# mention this number?", which is text proximity — it cannot tell a PR that FIXED an issue from one
# that merely named it as still-red or deliberately deferred it. This asks the proof ledger whether
# a run that PROVED the cell has landed since the red was filed, and answers with the committed
# bundle path. An `e2e nightly:` issue does not close on a merge at all; it closes on a green run,
# so a merge-based verifier is structurally wrong for the whole `from:e2e-nightly` class.
#
# Read-only, and it mutates nothing: only a human can confirm the later run really answered the red
# rather than merely postdating it. `--superseded-reds` exits non-zero only if the rollup's own
# inputs are missing, which is worth surfacing rather than swallowing.
if superseded="$(node "$(dirname "$0")/programme-rollup.mjs" --superseded-reds 2>/dev/null)"; then
  if [ -n "$superseded" ]; then
    echo "  ── superseded nightly REDs (the proof ledger has already answered these) ──"
    printf '%s\n' "$superseded" | sed 's/^/  /'
    echo "     close one with:  gh issue close <n> --comment \"superseded by <bundle>\""
  fi
else
  echo "  ⚠ superseded-reds: could not evaluate (programme-rollup failed) — advisory SKIPPED." >&2
fi

# ── stalled: claimed, lease long dead, and the PR holding it is stuck too ────
# Not reclaimed on purpose (see the reclaim block). These are the units that would otherwise sit
# invisible forever: the board says someone owns them, and nothing says the owner left.
if [ -n "$stalled_units" ]; then
  echo "  ── ⚠ stalled (claimed, lease dead, and the PR holding it is stuck — needs a human) ──"
  printf '%s' "$stalled_units"
  echo "     take one over with:  scripts/claim-work.sh --issue <n>   (then rebase or close its PR)"
fi

# `if`, not `[ … ] && echo` — as the script's LAST command, a short-circuited `&&` becomes the exit
# status, so every read-only `--report` (and therefore `engine.sh status`, which execs it) exited 1
# on success. A reporter that reports failure when it worked is the same class of lie as the
# swallowed jq error above.
if [ "$MODE" = "full" ]; then
  echo "  (reclaimed $reclaimed stale lease(s))"
fi
