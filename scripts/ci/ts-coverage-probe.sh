#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# The TypeScript coverage DETERMINISM PROBE — the body of the `ts-coverage-determinism` job.
#
# It answers one question: are the per-directory covered/total pairs CI produces stable
# run-to-run? Floors are only worth committing if they are. It then records the floors those
# numbers produce, which is the only sanctioned way to arm a project's ratchet — floors recorded
# on a laptop are not comparable to CI, which is the whole reason this job exists.
#
# WHY IT IS A SCRIPT AND NOT A `run:` BLOCK (#3265). Two reasons.
#
# 1. A `run:` step is `bash -e`, not the `bash` a laptop reaches for, and a step body cannot be
#    executed anywhere but inside a real CI run. That has already shipped an inert guard once: a
#    retry proved under plain `bash` was 100% dead in Actions. Here the hazard is sharper, because
#    this job is `workflow_dispatch`-only — nothing exercises it on a PR at all, so a defect in it
#    survives indefinitely. As a script it has `--self-test`, which the `guards` job runs.
#
# 2. The project list. `scripts/ts-coverage-sweep.json` is the committed record of which vitest
#    projects declare a coverage block, and `ts-coverage.mjs --self-test` already fails when a
#    recorded project has no ratchet step in ci.yml. That mirror stopped at the ratchet: the probe
#    hand-typed the same list FOUR more times — the clean-up, the print loop, the update loop and
#    the artefact `path:` — all three long against a record of six, and nothing asserted any of
#    them. `apps/marketing` and `ee`, the two the gate itself says are "awaiting numbers from CI",
#    could never get them; `packages/format` was floored outside the probe entirely. Here the list
#    is read once, from the record.
#
# WHY THE COVERAGE ASSERTION IS NOT DECORATION. `ts-coverage.mjs --print` FAILS OPEN: a project
# with no `coverage/coverage-final.json` takes F2 ("nothing measured, not a regression"), prints a
# notice and exits 0 with no rows. So a project dropping out of the measurement is, to the
# determinism comparison, indistinguishable from a project that is perfectly deterministic —
# `sort -u` over five identical empty outputs collapses exactly as it should. `assert_measured` is
# what makes an absence a RED rather than a shorter file, for the same reason
# `ts-coverage-sweep.json` records a set and not a count (#2724).
#
# Usage:
#   scripts/ci/ts-coverage-probe.sh              # the probe: N runs, compare, then record floors
#   scripts/ci/ts-coverage-probe.sh --self-test
#
# Env (all defaulted; --self-test drives them, nothing in CI sets them):
#   ALETHIA_TS_PROBE_RUNS   how many runs to compare        (default 5)
#   ALETHIA_TS_PROBE_SWEEP  the project record              (default scripts/ts-coverage-sweep.json)
#   ALETHIA_TS_PROBE_SUITE  produces every project's coverage/  (default pnpm exec turbo run test --force)
#   ALETHIA_TS_PROBE_TSCOV  the ratchet CLI                 (default node scripts/ts-coverage.mjs)
#   ALETHIA_TS_PROBE_OUT    where the floors artefact is staged  (default ts-coverage-floors)

set -euo pipefail

RUNS_RAW="${ALETHIA_TS_PROBE_RUNS:-5}"
SWEEP="${ALETHIA_TS_PROBE_SWEEP:-scripts/ts-coverage-sweep.json}"
SUITE="${ALETHIA_TS_PROBE_SUITE:-pnpm exec turbo run test --force}"
TSCOV="${ALETHIA_TS_PROBE_TSCOV:-node scripts/ts-coverage.mjs}"
OUT="${ALETHIA_TS_PROBE_OUT:-ts-coverage-floors}"

die() { echo "::error::ts-coverage-probe: $*" >&2; exit 1; }

# validate_runs <value>: echo the run count, or fail. A determinism probe that compares fewer than
# two runs has compared nothing.
#
# MEASURED, not assumed. `RUNS` is now settable from a workflow_dispatch input (#3342 needed more
# than five to hunt a flap that did not reproduce in five), and two values get through the
# `${VAR:-5}` default that look harmless:
#
#   RUNS=0    `:-` only substitutes for UNSET or EMPTY, so 0 survives. On GNU coreutils `seq 1 0`
#             prints nothing, so the loop body never executes, `assert_deterministic 0` compares an
#             empty set — and the probe reports success having measured NOTHING. That is the exact
#             "found nothing / nothing is wrong" collapse this script's own header is about.
#   RUNS=abc  `seq: invalid floating point argument`, which is a diagnostic about seq rather than
#             about the input somebody typed.
#
# (An empty value is genuinely safe — `:-` substitutes 5 — which is why this checks the value and
# not merely whether it was set.)
#
# BSD `seq 1 0` counts DOWN and prints "1 0", so the same input is a no-op on Linux and a two-run
# probe on a laptop. Rejecting it removes the divergence rather than picking a side.
validate_runs() {
  case "$1" in
    ''|*[!0-9]*) echo "::error::ts-coverage-probe: run count must be a positive integer, got '$1'" >&2; return 1 ;;
  esac
  if [ "$1" -lt 2 ]; then
    echo "::error::ts-coverage-probe: run count must be at least 2, got '$1' — a determinism probe that compares fewer than two runs compares nothing and would report success having measured it" >&2
    return 1
  fi
  echo "$1"
}

# ── the list, read once ───────────────────────────────────────────────────────────────────────────
#
# read_projects <sweep-file>
#
# Empty is an ERROR, not an empty loop — `readSweepRecord()` in ts-coverage.mjs throws for the same
# reason. A probe that measured nothing must not read like a probe that found nothing wrong.
read_projects() {
  local sweep="$1" list
  [ -f "$sweep" ] || { echo "::error::ts-coverage-probe: no $sweep — the probe cannot know which projects to measure" >&2; return 1; }
  list="$(jq -er '.coverage_emitting_projects[]' "$sweep" 2>/dev/null)" || {
    echo "::error::ts-coverage-probe: $sweep records ZERO coverage-emitting projects, or .coverage_emitting_projects is not a list of strings — refusing to 'probe' nothing" >&2
    return 1
  }
  printf '%s\n' "$list"
}

# ── one run ───────────────────────────────────────────────────────────────────────────────────────
#
# probe_run <out-file> <project...>
#
# The clean-up is per-project and derived from the same list. It used to name three projects while
# the suite produced six, so three `coverage/` directories survived every `--force` iteration.
# Measuring a directory it did not clean is the one thing a determinism probe must not do.
# It captures the SAME run twice, at two resolutions: `<out>` holds the per-DIRECTORY rows the
# determinism comparison is made on, and `<out>.files` the per-FILE rows that say WHERE a
# disagreement lives. Both come from one suite invocation, so the two views describe the same run
# and cannot be compared across a boundary that moved.
#
# The per-file half exists because the directory half cannot finish the sentence. #3342 is
# `apps/console/lib/billing` measuring 957 or 958 of 1753 — one statement, thirty-one files, no
# culprit — and `ts-coverage.mjs --print --per-file` has been able to name the file since #3444
# while the only job that runs the suite five times in a comparable environment never called it.
# The documented recipe was "run it twice on a laptop and diff", which produces numbers CI cannot
# reproduce; that is the whole reason this job exists.
probe_run() {
  local out="$1"; shift
  local p
  for p in "$@"; do rm -rf "${p:?}/coverage"; done
  # shellcheck disable=SC2086  # SUITE and TSCOV are command lines, deliberately word-split
  $SUITE
  : >"$out"
  : >"$out.files"
  for p in "$@"; do
    # shellcheck disable=SC2086
    $TSCOV --project "$p" --print | sed "s|^|$p |" >>"$out"
    # NOT asserted by assert_measured and NOT part of the verdict: this is diagnostic only, so a
    # project that cannot produce it must not turn a determinism PASS into a failure. `|| true`
    # says that deliberately rather than leaving it to `set -e`.
    # shellcheck disable=SC2086
    { $TSCOV --project "$p" --print --per-file | sed "s|^|$p |" >>"$out.files"; } || true
  done
}

# ── WHERE did the runs disagree? ─────────────────────────────────────────────────────────────────
#
# explain_nondeterminism <expected-run-count> <projects-csv> <rows-file...>
#
# Called only after assert_deterministic has already failed, and it answers the question that
# failure raises and cannot: the directory rows say `apps/console/lib/billing 957 1753` in some runs
# and `958 1753` in others, which is a place-shaped answer to a statement-shaped question.
#
# It reports the per-FILE rows that did not appear in every run. One flapping statement lives in one
# file, so this is normally a single line.
#
# IT NEVER CHANGES THE VERDICT, and it has three ways of not being able to answer, each with its own
# sentence — because a diagnostic that renders identically to "nothing to report" is the defect
# class this script has already been bitten by twice:
#
#   1. a run produced no companion at all;
#   2. a companion could not be READ (`-s` tests existence and non-emptiness, not readability, so
#      a mode-000 file or an I/O error is a separate case);
#   3. a PROJECT is missing from some runs' companions while others still wrote rows.
#
# (3) is the subtle one and it is a false-FINDING rather than a silence. `--print --per-file` goes
# through `measureOrFailOpen`, which FAILS OPEN on F2/F4/F6 — exit 0, zero rows, an annotation on
# stderr — and `probe_run`'s `|| true` adds a second way to contribute nothing. The companion is
# still non-empty because the other projects wrote to it, so every check above passes and each of
# the vanished project's files is then reported as "flapping", sending the reader to hunt a clock
# that does not exist. `assert_measured` does not catch it either: it only inspects run 1.
explain_nondeterminism() {
  local n="$1" projects_csv="$2"; shift 2
  local f present=0
  local -a files=()
  for f in "$@"; do
    if [ -e "$f.files" ] && [ ! -r "$f.files" ]; then
      echo
      echo "  per-file breakdown UNREADABLE: $f.files exists but cannot be read. That is a problem"
      echo "  with this runner, NOT a finding about the coverage numbers."
      return 0
    fi
    if [ -s "$f.files" ]; then files+=("$f.files"); present=$((present + 1)); fi
  done
  echo
  if [ "$present" -ne "$n" ]; then
    echo "  per-file breakdown UNAVAILABLE: $present of $n run(s) produced one, so the flapping"
    echo "  file cannot be named here. That is a gap in this probe, NOT evidence that the"
    echo "  disagreement is confined to the directory totals above."
    return 0
  fi

  # PER PROJECT, before per file. A project that contributed rows to some runs and not others makes
  # every one of its files look like it flapped, and that reading is confidently wrong.
  local p missing_projects="" have
  local IFS_SAVE="$IFS"; IFS=','
  # shellcheck disable=SC2086  # deliberate word split on the comma-separated project list
  set -- $projects_csv
  IFS="$IFS_SAVE"
  for p in "$@"; do
    have=0
    for f in "${files[@]}"; do
      if awk -v p="$p" '$1 == p { found = 1 } END { exit !found }' "$f"; then have=$((have + 1)); fi
    done
    if [ "$have" -ne "$n" ]; then
      missing_projects="$missing_projects
    $p — per-file rows in $have of $n run(s)"
    fi
  done
  if [ -n "$missing_projects" ]; then
    echo "  ── a PROJECT dropped out of the per-file capture ────────────────────────────────────"
    echo "  These projects did not produce per-file rows in every run:$missing_projects"
    echo
    echo "  Every file in such a project would appear below as though it flapped, which is a"
    echo "  confidently wrong reading — the cause is that the project measured nothing in some"
    echo "  run(s) (\`--print --per-file\` FAILS OPEN: no coverage-final.json → exit 0, zero rows)."
    echo "  Fix that first; the per-file list below is not trustworthy for these projects."
    echo
  fi

  echo "  ── which FILE flapped (rows absent from at least one of the $n runs) ──"
  # The aggregate is materialised FIRST so a read failure in `cat`/`sort` gets its own verdict.
  # Branching on the pipeline's status directly would, under `set -o pipefail`, fold a failed `cat`
  # or a `sort` that ran out of TMPDIR into the else branch below — reporting an I/O error as a
  # defect in the coverage tooling, and (when awk had already printed rows) printing the rows AND
  # "none — every per-file row appeared" directly underneath them.
  local agg="${TMPDIR:-/tmp}/ts-probe-agg.$$"
  if ! cat "${files[@]}" 2>/dev/null | sort >"$agg"; then
    rm -f "$agg"
    echo "  could not aggregate the per-file rows (read or sort failed) — this is a problem with"
    echo "  this runner, NOT a finding about the coverage numbers."
    return 0
  fi
  if uniq -c <"$agg" | awk -v n="$n" '$1 != n { print "  " $0; found = 1 } END { exit !found }'; then
    echo
    echo "  Each line is '<count> <project> <file> <covered> <total>'. A file appearing with two"
    echo "  different covered counts is the one to open: its statements are executed on some runs"
    echo "  and not others — look for a real clock, a locale, or shared state between tests, since"
    echo "  the suite runs its projects in parallel."
  else
    echo "  none — every per-file row appeared in all $n runs, while a DIRECTORY row did not."
    echo "  That combination should be impossible (a directory is the sum of its files), so treat"
    echo "  it as a defect in the measurement rather than as a finding about the code."
  fi
  rm -f "$agg"
}

# ── did the probe actually measure every project it claims to? ────────────────────────────────────
#
# assert_measured <rows-file> <project...>
#
# Field-exact, not a prefix match: `packages/plan-catalog` must not be satisfied by a row for
# `packages/plan-catalog-extra`. A substring hit dismissing a whole finding is a defect this
# repository has already paid for once.
#
# And SHAPE-exact, not merely field-exact. `$1 == p` alone asked "is there a line here whose first
# field is the project?", which is not the question — `probe_run` prefixes EVERY line of the child's
# stdout with the project name, so any line at all satisfied it. `ts-coverage.mjs` used to write its
# `::warning::` annotations to stdout, and `packages/foo ::warning::…` passed this assertion: the
# probe reported "every recorded project produced measured rows" over a run that measured nothing.
#
# So mirror the EMITTER. `runPrint` writes `<dir> <covered> <total>`, prefixed here to
# `<project> <dir> <covered> <total>` — four fields, the last two integers. Annotations now go to
# stderr (the real fix), and this is the independent second lock: either one alone closes the hole,
# which is the point of having both.
assert_measured() {
  local out="$1"; shift
  local p missing=""
  for p in "$@"; do
    awk -v p="$p" '$1 == p && NF == 4 && $3 ~ /^[0-9]+$/ && $4 ~ /^[0-9]+$/ { found = 1 } END { exit !found }' "$out" || missing="$missing $p"
  done
  if [ -n "$missing" ]; then
    echo "::error::ts-coverage-probe: recorded project(s) produced NO measured rows:$missing"
    echo "  --print fails OPEN (F2: no coverage/coverage-final.json), so this is silence, not a zero."
    echo "  TWO causes reach this line, and they send you to different places:"
    echo "  1. The project measured nothing. Either it stopped emitting coverage — fix its vitest"
    echo "     config, or remove it from the sweep record in the same PR — or the suite command did"
    echo "     not build it."
    echo "  2. It measured, but every row was the wrong SHAPE. A row is '<project> <dir> <covered>"
    echo "     <total>' — four fields, the last two integers. Anything the child wrote to STDOUT"
    echo "     that is not a measurement lands here looking like a row and is rejected. Check the"
    echo "     raw rows before assuming the vitest config: 'ts-coverage.mjs --project P --print'."
    echo "  Naming only cause 1 sent an operator to the vitest config once when the real cause was"
    echo "  commentary in the data channel, which is expensive in a workflow_dispatch-only job."
    return 1
  fi
  echo "✓ every recorded project produced measured rows ($# project(s))"
}

# ── are the numbers the same in every run? ────────────────────────────────────────────────────────
#
# assert_deterministic <expected-run-count> <rows-file...>
assert_deterministic() {
  local n="$1"; shift
  local expected actual
  expected="$(wc -l <"$1")"
  actual="$(cat "$@" | sort -u | wc -l)"
  if [ "$actual" -eq "$expected" ]; then
    echo "✓ TypeScript coverage is run-to-run deterministic across $n run(s)"
    return 0
  fi
  echo "::error::NONDETERMINISTIC — do NOT floor this. Rows that did not appear $n times:"
  cat "$@" | sort | uniq -c | awk -v n="$n" '$1 != n'
  return 1
}

# ── --self-test ───────────────────────────────────────────────────────────────────────────────────
#
# WHAT IT HAS TO PROVE, and why each case is here rather than obvious:
#
#   (a) A recorded project that produces no rows FAILS, and the failure NAMES it. That is the case
#       this whole change exists for, and the one that fails open upstream.
#   (b) Every project is driven through (a) — not just the one the assertion was written around.
#       The last guard shipped from this repo derived its inputs correctly and still missed an
#       entire emission shape, because it was only ever mutated in the one place it was designed
#       for. So: mutate each, and tabulate.
#   (c) A row that differs between runs still FAILS. The determinism half must keep biting.
#   (d) The clean pass passes. A guard whose only exercised branch is its failure branch has never
#       been shown to pass for the right reason.
#   (e) A missing or EMPTY record is an error, not a silent success.
#   (f) The run loop drives the real commands, counted in a FILE — `n=$((n+1))` inside `$( )` is a
#       subshell and rewinds, which has already made one of my self-tests pass for the wrong reason.
if [ "${1:-}" = "--self-test" ]; then
  pass=0; fail=0
  ok()  { pass=$((pass + 1)); echo "  ✓ $1"; }
  bad() { fail=$((fail + 1)); echo "  ✗ $1"; }

  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  echo "ts-coverage-probe --self-test"
  echo
  echo " the record"

  if read_projects "$tmp/missing.json" >/dev/null 2>&1; then
    bad "a missing record should fail"
  else ok "a missing record fails"; fi

  echo '{"coverage_emitting_projects":[]}' >"$tmp/empty.json"
  if read_projects "$tmp/empty.json" >/dev/null 2>&1; then
    bad "an EMPTY record should fail — probing nothing is not a pass"
  else ok "an empty record fails"; fi

  echo '{"coverage_emitting_projects":["a","b","c"]}' >"$tmp/three.json"
  got="$(read_projects "$tmp/three.json" | tr '\n' ' ')"
  if [ "$got" = "a b c " ]; then ok "a good record reads back verbatim"
  else bad "read_projects returned '$got'"; fi

  echo
  echo " coverage of the measurement"
  set -- apps/console apps/marketing ee packages/format packages/plan-catalog packages/ui
  full="$tmp/full.txt"; : >"$full"
  for p in "$@"; do echo "$p src 10 20" >>"$full"; done
  if assert_measured "$full" "$@" >/dev/null 2>&1; then ok "all six present passes"
  else bad "all six present should pass"; fi

  for drop in "$@"; do
    part="$tmp/drop.txt"; : >"$part"
    for p in "$@"; do [ "$p" = "$drop" ] || echo "$p src 10 20" >>"$part"; done
    if msg="$(assert_measured "$part" "$@" 2>&1)"; then
      bad "dropping $drop should FAIL"
    elif ! printf '%s' "$msg" | grep -qF -- "$drop"; then
      bad "dropping $drop failed but did not NAME it"
    else
      ok "dropping $drop fails, and names it"
    fi
  done

  pre="$tmp/prefix.txt"
  echo "packages/plan-catalog-extra src 10 20" >"$pre"
  if assert_measured "$pre" packages/plan-catalog >/dev/null 2>&1; then
    bad "a row for a LONGER project name should not satisfy a shorter one"
  else ok "a row for a different project sharing its prefix does not satisfy it"; fi

  # THE #3342 REGRESSION. `probe_run` prefixes every line of the child's stdout, so anything the
  # child says on stdout arrives looking like a row for that project. ts-coverage.mjs wrote its
  # annotations there, and F2 (`no coverage-final.json — nothing measured`) is exactly the case
  # where there are no real rows to drown it out: the probe passed on a project it had not measured.
  ann="$tmp/annotation.txt"
  echo "packages/plan-catalog ::warning::ts-coverage F2: packages/plan-catalog: no coverage/coverage-final.json" >"$ann"
  if assert_measured "$ann" packages/plan-catalog >/dev/null 2>&1; then
    bad "an ANNOTATION line must not count as a measured row — that is #3342's silent pass"
  else ok "an annotation line does not satisfy the measurement assertion"; fi

  # ...and the non-vacuous half: the fixture differs from a real row ONLY in shape, so this proves
  # the check reads the shape rather than rejecting the fixture for some incidental reason.
  real="$tmp/real.txt"
  echo "packages/plan-catalog lib 10 20" >"$real"
  if assert_measured "$real" packages/plan-catalog >/dev/null 2>&1; then
    ok "...while a well-shaped row for the same project still does"
  else bad "a valid 4-field row must still satisfy the assertion"; fi

  for junk in "packages/plan-catalog lib 10" "packages/plan-catalog lib ten 20" "packages/plan-catalog lib 10 20 30"; do
    j="$tmp/junk.txt"; echo "$junk" >"$j"
    if assert_measured "$j" packages/plan-catalog >/dev/null 2>&1; then
      bad "a malformed row should not satisfy the assertion: '$junk'"
    else ok "malformed row rejected: '$junk'"; fi
  done

  echo
  echo " determinism"
  r1="$tmp/r1.txt"; r2="$tmp/r2.txt"; r3="$tmp/r3.txt"
  printf 'a src 1 2\nb src 3 4\n' >"$r1"; cp "$r1" "$r2"; cp "$r1" "$r3"
  if assert_deterministic 3 "$r1" "$r2" "$r3" >/dev/null 2>&1; then ok "identical runs pass"
  else bad "identical runs should pass"; fi
  printf 'a src 1 2\nb src 3 5\n' >"$r3"
  if assert_deterministic 3 "$r1" "$r2" "$r3" >/dev/null 2>&1; then
    bad "a row that differs between runs should FAIL"
  else ok "a row that differs between runs fails"; fi

  echo
  echo " the run count"
  # (l) The values that get through `${VAR:-5}` and would otherwise make the probe measure nothing.
  for good in 2 5 20 100; do
    if [ "$(validate_runs "$good" 2>/dev/null)" = "$good" ]; then ok "runs=$good is accepted"
    else bad "runs=$good should be accepted"; fi
  done
  for evil in 0 1 "" "abc" "-3" "2.5" "5 5"; do
    if validate_runs "$evil" >/dev/null 2>&1; then
      bad "runs='$evil' should be REJECTED — it would compare fewer than two runs, or none"
    else ok "runs='$evil' is rejected"; fi
  done

  echo
  echo " naming the flapping FILE"
  # (g) The half assert_deterministic cannot do. Its failure names a DIRECTORY, and the reader's
  #     next question is which of that directory's files moved. Every branch here is a branch that
  #     renders as prose in a job nothing else exercises, so each is driven rather than assumed.
  printf 'a lib/billing 957 1753\n' >"$r1"; cp "$r1" "$r2"
  printf 'a lib/billing 958 1753\n' >"$r3"
  printf 'a lib/billing/period.ts 10 20\na lib/billing/plan.ts 5 9\n' >"$r1.files"
  cp "$r1.files" "$r2.files"
  printf 'a lib/billing/period.ts 11 20\na lib/billing/plan.ts 5 9\n' >"$r3.files"

  got="$(explain_nondeterminism 3 a "$r1" "$r2" "$r3" 2>&1)"
  if printf '%s' "$got" | grep -qF "lib/billing/period.ts"; then
    ok "the flapping file is NAMED"
  else bad "the flapping file was not named; got: $got"; fi
  if printf '%s' "$got" | grep -qF "lib/billing/plan.ts"; then
    bad "a file that agreed in every run must NOT be listed — that is noise, not a finding"
  else ok "a file that agreed in every run is not listed"; fi

  # (h) The companion is MISSING. This is the branch that must not render like "nothing found":
  #     a probe that silently prints an empty section over an unavailable breakdown is the exact
  #     failure `assert_measured` exists to prevent one level up.
  rm -f "$r3.files"
  got="$(explain_nondeterminism 3 a "$r1" "$r2" "$r3" 2>&1)"
  if printf '%s' "$got" | grep -qF "UNAVAILABLE"; then ok "a missing per-file companion SAYS so"
  else bad "a missing companion must say so; got: $got"; fi
  if printf '%s' "$got" | grep -qF "period.ts"; then
    bad "with a run missing, it must not name a file from the runs it did read"
  else ok "with a run missing, it names no file"; fi

  # (i) An EMPTY companion counts as missing, not as agreement. `-s` rather than `-f` is what makes
  #     that true, and a `-f` here would pass every other case in this section.
  : >"$r3.files"
  if explain_nondeterminism 3 a "$r1" "$r2" "$r3" 2>&1 | grep -qF "UNAVAILABLE"; then
    ok "an EMPTY per-file companion counts as unavailable"
  else bad "an empty companion must not be read as agreement"; fi

  # (j) The impossible combination — directories disagreed, every file agreed — is reported as a
  #     measurement defect rather than as a clean bill of health.
  cp "$r1.files" "$r3.files"
  got="$(explain_nondeterminism 3 a "$r1" "$r2" "$r3" 2>&1)"
  if printf '%s' "$got" | grep -qF "should be impossible"; then
    ok "files agreeing while a directory disagreed is flagged, not passed over"
  else bad "the impossible combination must be flagged; got: $got"; fi

  # (g2) A PROJECT that dropped out of the capture must be named as ITSELF, not as N flapping
  #      files. `--print --per-file` fails open, so this is the shape the reader is most likely to
  #      be handed — and the confidently-wrong reading it produces sends them hunting a clock.
  printf 'a lib/billing 957 1753\nb lib 1 2\n' >"$r1"; cp "$r1" "$r2"
  printf 'a lib/billing 958 1753\nb lib 1 2\n' >"$r3"
  printf 'a x.ts 1 2\nb y.ts 3 4\nb z.ts 5 6\n' >"$r1.files"; cp "$r1.files" "$r2.files"
  printf 'a x.ts 1 2\n' >"$r3.files"          # project b vanished from run 3
  got="$(explain_nondeterminism 3 a,b "$r1" "$r2" "$r3" 2>&1)"
  if printf '%s' "$got" | grep -qF "a PROJECT dropped out"; then
    ok "a project missing from some runs is named as a PROJECT"
  else bad "a vanished project must be named; got: $got"; fi
  if printf '%s' "$got" | grep -qF "b — per-file rows in 2 of 3 run(s)"; then
    ok "…with which runs carried it"
  else bad "must say how many runs carried it; got: $got"; fi
  if printf '%s' "$got" | grep -qF "not trustworthy"; then
    ok "…and that the file list below cannot be trusted for it"
  else bad "must warn that the file list is unreliable; got: $got"; fi
  # A project present in EVERY run must not be accused.
  printf 'a x.ts 1 2\nb y.ts 3 4\nb z.ts 5 6\n' >"$r3.files"
  if explain_nondeterminism 3 a,b "$r1" "$r2" "$r3" 2>&1 | grep -qF "a PROJECT dropped out"; then
    bad "a project present in every run must NOT be reported as dropped"
  else ok "a project present in every run is not accused"; fi

  # (g3) An UNREADABLE companion is its own sentence. `-s` tests existence and non-emptiness, not
  #      readability, so this branch is not covered by the UNAVAILABLE case above.
  chmod 000 "$r3.files" 2>/dev/null || true
  if [ -r "$r3.files" ]; then
    ok "skipped: unreadable-companion case (running as root, chmod has no effect)"
  else
    got="$(explain_nondeterminism 3 a,b "$r1" "$r2" "$r3" 2>&1)"
    if printf '%s' "$got" | grep -qF "UNREADABLE"; then
      ok "an unreadable companion gets its OWN sentence, not the impossible-combination verdict"
    else bad "an unreadable companion must say so; got: $got"; fi
    if printf '%s' "$got" | grep -qF "should be impossible"; then
      bad "a read failure must NOT be reported as a defect in the coverage tooling"
    else ok "…and is not reported as a measurement defect"; fi
  fi
  chmod 644 "$r3.files" 2>/dev/null || true


  echo
  echo " the run loop"
  mkdir -p "$tmp/bin"
  cat >"$tmp/bin/suite" <<'STUB'
#!/usr/bin/env bash
echo run >>"$PROBE_SELFTEST_COUNTER"
STUB
  cat >"$tmp/bin/tscov" <<'STUB'
#!/usr/bin/env bash
# Mirrors the real CLI's two shapes so the self-test can tell the per-directory invocation from the
# per-file one. A stub that answered both identically would let probe_run drop the --per-file call
# entirely with every case still green.
for a in "$@"; do [ "$a" = "--per-file" ] && { echo "src/f.ts 1 2"; exit 0; }; done
echo "src 1 2"
STUB
  chmod +x "$tmp/bin/suite" "$tmp/bin/tscov"
  (
    cd "$tmp"
    mkdir -p wt/x/coverage wt/y/coverage
    cd wt
    export PROBE_SELFTEST_COUNTER="$tmp/count.txt"; : >"$PROBE_SELFTEST_COUNTER"
    # Overriding these INSIDE the subshell is the point — the stubs must not leak into the cases
    # after this one. shellcheck flags the scoping it is relying on.
    # shellcheck disable=SC2030
    SUITE="$tmp/bin/suite"
    # shellcheck disable=SC2030
    TSCOV="$tmp/bin/tscov"
    probe_run "$tmp/out.txt" x y
  )
  if [ "$(wc -l <"$tmp/count.txt")" -eq 1 ]; then ok "the suite is invoked once per run"
  else bad "the suite ran $(wc -l <"$tmp/count.txt") time(s), expected 1"; fi
  if [ "$(cat "$tmp/out.txt")" = "x src 1 2
y src 1 2" ]; then ok "each project's rows are prefixed with its own path"
  else bad "rows were: $(cat "$tmp/out.txt")"; fi
  if [ -d "$tmp/wt/x/coverage" ] || [ -d "$tmp/wt/y/coverage" ]; then
    bad "every project's coverage/ should be removed before the suite runs"
  else ok "every project's coverage/ is removed before the suite runs"; fi
  if [ "$(cat "$tmp/out.txt.files" 2>/dev/null)" = "x src/f.ts 1 2
y src/f.ts 1 2" ]; then ok "the per-FILE companion is written alongside, from the same run"
  else bad "per-file companion was: $(cat "$tmp/out.txt.files" 2>/dev/null)"; fi

  echo
  if [ "$fail" -eq 0 ]; then echo "ts-coverage-probe self-test: all $pass passed"; exit 0; fi
  echo "ts-coverage-probe self-test: $fail of $((pass + fail)) FAILED"; exit 1
fi

# ── the probe ─────────────────────────────────────────────────────────────────────────────────────

command -v jq >/dev/null || die "jq is required to read $SWEEP"

RUNS="$(validate_runs "$RUNS_RAW")" || exit 1

PROJECTS=()
while IFS= read -r line; do PROJECTS+=("$line"); done < <(read_projects "$SWEEP")
[ "${#PROJECTS[@]}" -gt 0 ] || die "no projects to probe"

echo "── probing ${#PROJECTS[@]} project(s) from $SWEEP, $RUNS run(s) ──"
printf '   %s\n' "${PROJECTS[@]}"

RUN_FILES=()
for i in $(seq 1 "$RUNS"); do
  echo "── run $i of $RUNS ──"
  probe_run "run.$i.txt" "${PROJECTS[@]}"
  RUN_FILES+=("run.$i.txt")
done

echo "── per-directory covered/total, run 1 ──"
cat run.1.txt

assert_measured "run.1.txt" "${PROJECTS[@]}"
# `if !` rather than a bare call: the per-file explanation must run BEFORE the script exits, and
# `set -e` would take the failure straight to the exit without it. The non-zero status is preserved
# and re-raised, so the job still fails.
if ! assert_deterministic "$RUNS" "${RUN_FILES[@]}"; then
  # The project list is passed as CSV so it stays ONE argument and cannot be confused with the run
  # files that follow it.
  explain_nondeterminism "$RUNS" "$(IFS=,; echo "${PROJECTS[*]}")" "${RUN_FILES[@]}"
  exit 1
fi

# ee/dist is RECORDED, not asserted. What makes probe-recorded floors reachable is that this job
# and the required `typescript` job run the IDENTICAL suite command — a property of the commands,
# not something a filesystem probe can assert here. The assertion that does bite is F7 inside the
# ratchet, which demotes when the recorded environment and the measuring one disagree.
if [ -f ee/dist/index.js ]; then
  echo "ee/dist PRESENT — floors will record ee_dist: true (enterprise scope)"
else
  echo "ee/dist ABSENT — floors will record ee_dist: false (community scope)"
fi

echo "── the floors these numbers produce (commit these VERBATIM) ──"
rm -rf "$OUT"
for p in "${PROJECTS[@]}"; do
  # shellcheck disable=SC2086,SC2031
  $TSCOV --project "$p" --update
  echo "── $p/coverage-floors.json ──"
  cat "$p/coverage-floors.json"
  # Staged into ONE directory because `upload-artifact`'s `path:` is static YAML and cannot take a
  # shell variable. That list was the fourth hand-typed copy, and the one that would have kept
  # marketing's and ee's floors on the runner even after the loops were fixed.
  mkdir -p "$OUT/$p"
  cp "$p/coverage-floors.json" "$OUT/$p/coverage-floors.json"
done
echo "✓ staged ${#PROJECTS[@]} floors file(s) under $OUT/"
