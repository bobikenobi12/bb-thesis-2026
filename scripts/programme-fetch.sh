#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# programme-fetch.sh — capture the LIVE board state that PROGRAMME.md's status half cannot derive
# from the tree, as one committed JSON file.
#
# WHY A SNAPSHOT AND NOT A DIRECT QUERY. `scripts/programme-rollup.mjs` is diff-gated on every PR.
# A diff gate whose input is a live GitHub query is flaky by construction — the same PR would be
# "stale" or "in sync" depending on whether somebody relabelled an issue in the meantime, and every
# PR's status would depend on the board. So the live read happens ONCE, in a cron, and is COMMITTED;
# the rollup then stays a deterministic function of files in the tree.
#
# WHY THIS FILE HAS NO VERDICT LOGIC, AND NO --self-test. It is a `gh` transport: query, validate
# the reaper artifact's narrow schema, shape, write. Every judgement — what counts as blocked or
# clean, whether a cited issue is closed, how staleness is reported — lives in the rollup, which IS
# self-tested against fixtures. The untestable network half stays mechanical; derivation stays pure.
#
# SECRETS: this writes variable and secret NAMES, never values. `gh variable list` returns values
# for variables (they are not secret) but we deliberately drop them anyway — the rollup only ever
# asks "is this gate wired?", and a committed file in a PUBLIC repo is the wrong place for even a
# non-secret role ARN. `gh secret list` cannot return values at all.
#
# Usage:  scripts/programme-fetch.sh [output-path]
#         GH_REPO=owner/repo scripts/programme-fetch.sh   # override the target repo
set -euo pipefail

OUT="${1:-docs/testing/programme-snapshot.json}"
REPO="${GH_REPO:-alethialabs-io/alethialabs}"

command -v gh >/dev/null || {
	echo "programme-fetch: gh is required" >&2
	exit 3
}
command -v jq >/dev/null || {
	echo "programme-fetch: jq is required" >&2
	exit 3
}
# The reaper-evidence block below unzips each artifact and hands it to the schema validator, so
# `unzip` and `node` are hard dependencies of this script now — not optional extras. Preflighted
# with gh and jq rather than discovered mid-walk, because their absence there is INDISTINGUISHABLE
# from a malformed artifact: the two `if !` branches print "did not contain exactly …" or "failed
# schema validation" and `continue`, so a machine missing unzip refuses all five clouds' evidence
# while blaming the evidence, and the snapshot silently carries stale observations forward.
for tool in unzip node; do
	command -v "$tool" >/dev/null || {
		echo "programme-fetch: $tool is required (the orphan-reaper artifacts are zipped and schema-validated)" >&2
		exit 3
	}
done

# `derived_at` is the ONLY timestamp in the whole mechanism, and it lives here rather than in
# PROGRAMME.md's rendered text on purpose: a timestamp inside a diff-gated region would make every
# PR stale the moment it was opened. The rollup reads it to report staleness.
derived_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# ── A COUNT CANNOT DISTINGUISH "EXACTLY N" FROM "CAPPED AT N". ──
#
# This is the defect #3652 names, and the comment that used to sit here was the whole of it: "if it
# is ever hit the count below makes the truncation visible". It does not. `--limit 500` returned
# exactly 500 closed issues for weeks and the trailing printf said `500 closed issues` — byte
# identical to a repo that happens to have 500. 228 closed issues were being dropped every night.
#
# The consequence is not cosmetic. `issueState()` answers `unknown` for an issue that is in neither
# list, and `staleCitations` fires only on `closed` — so a red cell citing a DROPPED issue stays
# `failing` forever, which is the #1714/#1722/#2058 defect reintroduced by truncation rather than by
# logic.
#
# So the limit is raised well clear of the corpus (728 closed at the time of writing) AND the cap is
# CHECKED: a returned count at the limit is reported as capped, recorded in the snapshot as a fact
# the rollup can render, and annotated `::error::` in the run.
#
# WHY THIS DOES NOT `exit 1`. programme.yml runs this under `set -e` and opens its PR in a LATER
# step, so a non-zero exit here means no snapshot lands at all — and PROGRAMME.md's live half then
# FAILS `pnpm check:programme` for everybody a week later, which that workflow's own header calls
# the dangerous failure. Loud beats fatal: the snapshot still refreshes, carrying the flag that says
# what it is missing.
OPEN_LIMIT="${PROGRAMME_OPEN_LIMIT:-1000}"
CLOSED_LIMIT="${PROGRAMME_CLOSED_LIMIT:-3000}"

# Open issues.
issues="$(gh issue list --repo "$REPO" --state open --limit "$OPEN_LIMIT" \
	--json number,title,labels,createdAt,updatedAt \
	--jq '[.[] | {number, title, labels: [.labels[].name], createdAt, updatedAt}]')"

# Issues the tree CITES must be resolvable even when closed — that is the whole point of the
# stale-citation check — so closed issues are captured too, most-recently-updated first.
#
# `createdAt` and `closedAt` are captured because a red is EVIDENCE whether or not its issue is
# still open. A nightly RED filed at 09:46Z and closed at 11:25Z, with the snapshot derived at
# 11:32Z, entered neither `open_issues` (it was already closed) nor the stale-citation check (no
# cell cites it), so PROGRAMME.md published `0 failing` on a day that leg failed. Without these two
# fields the rollup cannot tell that red apart from one closed six months ago.
closed="$(gh issue list --repo "$REPO" --state closed --limit "$CLOSED_LIMIT" \
	--json number,title,labels,createdAt,closedAt \
	--jq '[.[] | {number, title, labels: [.labels[].name], createdAt, closedAt}]')"

open_count="$(printf '%s' "$issues" | jq 'length')"
closed_count="$(printf '%s' "$closed" | jq 'length')"
open_truncated=false
closed_truncated=false
if [ "$open_count" -ge "$OPEN_LIMIT" ]; then
	open_truncated=true
	echo "::error::programme-fetch: the OPEN issue query came back at its limit ($OPEN_LIMIT), so it is TRUNCATED and the tail was dropped. Raise PROGRAMME_OPEN_LIMIT / the default in scripts/programme-fetch.sh; until then every dropped issue reads as \`unknown\`." >&2
fi
if [ "$closed_count" -ge "$CLOSED_LIMIT" ]; then
	closed_truncated=true
	echo "::error::programme-fetch: the CLOSED issue query came back at its limit ($CLOSED_LIMIT), so it is TRUNCATED and the tail was dropped. Raise PROGRAMME_CLOSED_LIMIT / the default in scripts/programme-fetch.sh; until then a red cell citing a dropped issue can never be reclassified \`stale\`." >&2
fi

# Gate reality: NAMES ONLY (see the header).
#
# ⚠️ DO NOT restore a `2>/dev/null || echo '[]'` fallback here. That is what this used to do, and
# it turned "the token cannot read repo variables" into "this repo has no variables" — silently.
# programme.yml grants the default GITHUB_TOKEN only contents+pull-requests, which cannot list
# variables or secrets at all, so every refresh committed `variables: [], secrets: []` next to 42
# correctly-fetched issues, and PROGRAMME.md rendered EVERY gate `⛔ unwired` — including ones a
# green run had already proven wired. An empty list and a failed read must not look the same.
#
# The rollup now treats an empty inventory as `unknown` rather than `unwired`, so a failure here is
# no longer load-bearing for correctness — but it should still be LOUD rather than mistaken for a
# measurement.
#
# ── AND DO NOT DISCARD AN INVENTORY WE ALREADY HAVE. ──
#
# Writing `[]` on a failed read does not invent "unwired" — the rollup reads empty as `unknown` —
# but it does THROW AWAY a reading that was already made, which manufactures unknown out of
# knowledge. §4's rule is "`unknown` never collapses"; erasing an observed inventory collapses the
# other way, and it is not hypothetical: this workflow runs NIGHTLY and its token can never read
# these, so every night it reverted a hand-refreshed inventory and PROGRAMME.md went back to
# reporting ten gates as unknown while all ten were wired.
#
# So a failed read CARRIES FORWARD what the previous snapshot held, and records WHEN that was
# actually observed. A variable name does not rot quickly, and `inventory_observed_at` is what
# bounds how long a carried reading may stand.
#
# ⚠️ THAT BOUND WAS A CLAIM, NOT A RULE, UNTIL #3652. This comment used to point at "the snapshot's
# own 7-day staleness rule", meaning `programme-rollup.mjs`'s check on `derived_at` — which the same
# run re-stamps every night, so it could never age out a carried inventory. `inventory_observed_at`
# was written here and read by NOTHING: `derived_at` reached 2026-09-01 while this field sat at
# 2026-08-27, and deleting a gate variable would have left its row rendering `✅ wired` forever. The
# rollup now measures this field against `derived_at` — two persisted timestamps, so the rendered
# output stays a pure function of the snapshot — and degrades every declared gate to `unknown` once
# the gap exceeds a week.
prev_vars='[]'
prev_secrets='[]'
prev_observed=''
prev_reaper='[]'
# THE START OF THE DERIVATION WINDOW, recorded rather than guessed.
#
# The rollup needs to know which issues closed since the LAST snapshot, because a red that is filed
# and closed between two refreshes is seen by neither one's `open_issues`. The previous snapshot's
# own `derived_at` is the exact boundary, and it is already on disk here — so it is carried into the
# new snapshot rather than reconstructed downstream from a cadence constant.
#
# It is the last COMMITTED refresh, not the last RUN one: programme.yml checks out `dev` and opens a
# PR, so if that PR sits unmerged for three days this reads three days old. That widens the window,
# which over-reports a red rather than missing one — the safe direction, and the reason this is
# preferred to `derived_at - 24h`.
prev_derived=''
if [ -f "$OUT" ]; then
	prev_vars="$(jq -c '.variables // []' "$OUT" 2>/dev/null || echo '[]')"
	prev_secrets="$(jq -c '.secrets // []' "$OUT" 2>/dev/null || echo '[]')"
	prev_observed="$(jq -r '.inventory_observed_at // ""' "$OUT" 2>/dev/null || echo '')"
	prev_reaper="$(jq -c '.orphan_reaper_observations // []' "$OUT" 2>/dev/null || echo '[]')"
	prev_derived="$(jq -r '.derived_at // ""' "$OUT" 2>/dev/null || echo '')"
fi

inventory_observed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
carried=0
if ! vars="$(gh variable list --repo "$REPO" --json name --jq '[.[].name]')"; then
	echo "::warning::programme-fetch: could not list repo VARIABLES (the token likely lacks the scope). CARRYING FORWARD the previous inventory rather than erasing it." >&2
	vars="$prev_vars"
	carried=1
fi
if ! secrets="$(gh secret list --repo "$REPO" --json name --jq '[.[].name]')"; then
	echo "::warning::programme-fetch: could not list repo SECRETS (the token likely lacks the scope). CARRYING FORWARD the previous inventory rather than erasing it." >&2
	secrets="$prev_secrets"
	carried=1
fi
if [ "$carried" = "1" ]; then
	# Keep the ORIGINAL observation time: the point of the field is to say how old the reading is,
	# and stamping it now would make a carried inventory look freshly measured.
	inventory_observed_at="$prev_observed"
fi

# ── GATE REALITY, OBSERVED. ──
#
# The variable inventory above answers "is this gate DECLARED?". That is not the question the board
# is actually asking, and the difference has bitten: `E2E_GCP_WIF_PROVIDER` was set the whole time
# while every workflow_dispatch died at *Configure GCP credentials*, because a bare apply on
# infra/gcp-e2e narrowed the WIF trust to ref-only. A listing would have printed a confident ✅ for
# a cloud that had not federated in weeks.
#
# So ALSO record what the nightly OBSERVED. The workflow's `Record gate-off proof` step runs only
# when the gate is off, so its conclusion is a direct reading:
#
#   skipped  → the gate was ON and the leg proceeded   (reached)
#   success  → the gate was OFF and a gate-off proof was recorded  (not reached)
#
# This needs only `actions: read`, which a GITHUB_TOKEN *can* be granted — unlike variables and
# secrets, for which no workflow permission scope exists at all. The system is, in effect, telling us
# which question it is willing to answer honestly.
#
# Most recent observation per provider wins; runs are walked newest-first. A provider no recent run
# covers simply has no observation, and the rollup falls back to the declared inventory rather than
# inventing one.
gate_runs=20
if ! runs="$(gh api "repos/$REPO/actions/workflows/e2e-nightly.yml/runs?per_page=$gate_runs" --jq '[.workflow_runs[] | {id, created_at}]')"; then
	echo "::warning::programme-fetch: could not list e2e-nightly runs; gate reality falls back to the declared inventory." >&2
	runs='[]'
fi

observations='[]'
seen_providers=""
for run_id in $(printf '%s' "$runs" | jq -r '.[].id'); do
	jobs="$(gh api "repos/$REPO/actions/runs/$run_id/jobs?per_page=100" 2>/dev/null || echo '{"jobs":[]}')"
	# The provider is the parenthesised matrix value in the job name; the gate reading is the
	# `Record gate-off proof` step's conclusion. A job missing that step tells us nothing and is
	# skipped rather than guessed at.
	# RAW FACTS ONLY. Whether those facts amount to "the gate was reached" is a JUDGEMENT, and this
	# file deliberately holds none — see the header. The rollup decides, and its self-test can drive
	# every combination offline, which a shell pipeline against a live API never could.
	#
	# `earlier_failure` is the fact that makes the judgement possible. `Record gate-off proof` carries
	# a bare `if:`, which implies success(), so `skipped` means EITHER "the gate was on and the leg
	# proceeded" OR "an earlier step failed and we never got here". Those are opposite readings, and
	# the second would print a confident ✅ for a leg that never started — the exact false-green this
	# whole change exists to avoid, pointing the other way. The step numbers are already in the
	# payload, so distinguishing them costs no extra call.
	obs="$(printf '%s' "$jobs" | jq -c --arg run "$run_id" '
    [ .jobs[]
      | select(.name | test("^Provision .*\\(([a-z]+)\\)$"))
      | { provider: (.name | capture("\\((?<p>[a-z]+)\\)$").p),
          steps: (.steps // []),
          run: $run,
          at: .started_at }
      | . as $j
      | ($j.steps | map(select(.name == "Record gate-off proof")) | first) as $gate
      | select($gate != null)
      | { provider: $j.provider,
          gate_off: $gate.conclusion,
          earlier_failure: ([ $j.steps[] | select(.number < $gate.number) | select(.conclusion == "failure") ] | length > 0),
          run: $j.run,
          at: $j.at } ]' 2>/dev/null || echo '[]')"
	for provider in $(printf '%s' "$obs" | jq -r '.[].provider'); do
		case " $seen_providers " in *" $provider "*) continue ;; esac
		seen_providers="$seen_providers $provider"
		one="$(printf '%s' "$obs" | jq -c --arg p "$provider" '[.[] | select(.provider == $p)][0]')"
		observations="$(printf '%s' "$observations" | jq -c --argjson o "$one" '. + [$o]')"
	done
done

# ── ORPHAN REAPER REALITY, OBSERVED. ──
#
# The reaper's step summary expires and cannot satisfy PROGRAMME.md's "nothing is standing"
# predicate. Each matrix leg now uploads one versioned, secret-free JSON result. Walk completed
# runs newest-first and retain the newest REAL RECLAIM per provider: a one-cloud dispatch must not
# erase the other four, while a diagnostic dry-run must not replace authoritative clean evidence.
#
# ARTIFACTS ARE UNTRUSTED INPUT. Accept one exact filename, no directories or extra entries, then
# pass it through the strict schema validator before jq ever sees it. The raw sweep log is never an
# artifact and no resource name reaches this snapshot.
reaper_observations="$prev_reaper"
reaper_tmp="$(mktemp -d)"
trap 'rm -rf "$reaper_tmp"' EXIT
if reaper_runs="$(gh api "repos/$REPO/actions/workflows/e2e-orphan-reaper.yml/runs?status=completed&per_page=100" \
	--jq '[.workflow_runs[] | {id, completed_at: .updated_at}]')"; then
	fresh_reaper='[]'
	seen_reaper=''
	# STOP WALKING ONCE EVERY CLOUD IS RESOLVED. `seen_reaper` skips a resolved PROVIDER but not the
	# RUN, so the loop kept issuing one `gh api …/artifacts` call for every one of up to 100
	# completed runs. The newest run normally carries all five legs, which made ~99 of those calls
	# guaranteed to find nothing — pure latency on a nightly refresh and pure rate-limit exposure
	# against the same token that still has issues, variables and secrets to read.
	#
	# The counter is a plain shell variable and stays correct BECAUSE the loop is fed by a process
	# substitution rather than a pipe: `while … done < <(…)` runs in THIS shell, which is also why
	# `seen_reaper` and `fresh_reaper` survive each iteration.
	#
	# The target is derived from the provider list rather than written as `5`, so adding a sixth
	# cloud cannot leave the walk stopping one cloud early — which would look exactly like that
	# cloud never having run.
	reaper_providers="aws gcp azure alibaba hetzner"
	# shellcheck disable=SC2086  # deliberate word splitting: the list is a fixed set of literals.
	reaper_provider_count="$(printf '%s\n' $reaper_providers | grep -c .)"
	reaper_resolved=0
	while IFS=$'\t' read -r reaper_run_id reaper_completed_at; do
		if [ "$reaper_resolved" -ge "$reaper_provider_count" ]; then break; fi
		[ -n "$reaper_run_id" ] || continue
		if ! artifacts="$(gh api "repos/$REPO/actions/runs/$reaper_run_id/artifacts?per_page=100" 2>/dev/null)"; then
			echo "::warning::programme-fetch: could not list artifacts for reaper run $reaper_run_id; retaining earlier evidence." >&2
			continue
		fi
		# shellcheck disable=SC2086  # deliberate word splitting over the fixed provider list.
		for provider in $reaper_providers; do
			case " $seen_reaper " in *" $provider "*) continue ;; esac
			artifact_id="$(printf '%s' "$artifacts" | jq -r --arg n "orphan-reaper-result-${provider}-${reaper_run_id}" '.artifacts[]? | select(.name == $n and .expired == false) | .id' | head -1)"
			[ -n "$artifact_id" ] || continue
			zip="$reaper_tmp/${reaper_run_id}-${provider}.zip"
			raw="$reaper_tmp/${reaper_run_id}-${provider}.json"
			if ! gh api "repos/$REPO/actions/artifacts/$artifact_id/zip" >"$zip"; then
				echo "::warning::programme-fetch: could not download reaper artifact $artifact_id; retaining earlier evidence." >&2
				continue
			fi
			entries="$(unzip -Z1 "$zip" 2>/dev/null || true)"
			if [ "$entries" != "orphan-reaper-result.json" ]; then
				echo "::warning::programme-fetch: reaper artifact $artifact_id did not contain exactly orphan-reaper-result.json; refusing it." >&2
				continue
			fi
			if ! unzip -p "$zip" orphan-reaper-result.json >"$raw"; then
				echo "::warning::programme-fetch: could not read reaper artifact $artifact_id; refusing it." >&2
				continue
			fi
			# KEEP THE VALIDATOR'S STDERR. It is the only thing that names the offending field, and
			# `2>/dev/null` threw it away — leaving a warning that says an artifact was refused and
			# nothing at all about why, on the one path where the answer is already computed and
			# free. The validator's message is derived from the artifact's SHAPE (field names and
			# type complaints), never its values, so it is safe to echo.
			validation_error="$reaper_tmp/${reaper_run_id}-${provider}.err"
			if ! normalized="$(node scripts/e2e/reaper-result.mjs validate --file "$raw" 2>"$validation_error")"; then
				echo "::warning::programme-fetch: reaper artifact $artifact_id failed schema validation; refusing it. $(tr '\n' ' ' <"$validation_error")" >&2
				continue
			fi
			if ! printf '%s' "$normalized" | jq -e --arg p "$provider" --arg r "$reaper_run_id" '.provider == $p and .run_id == $r' >/dev/null; then
				echo "::warning::programme-fetch: reaper artifact $artifact_id disagrees with its provider/run identity; refusing it." >&2
				continue
			fi
			# A dry-run is useful diagnostics, but it inspected without reclaiming and cannot replace
			# the newest authoritative reclaim result for this cloud.
			if [ "$(printf '%s' "$normalized" | jq -r .mode)" != "reclaim" ]; then continue; fi
			# `completed_at` IS THE ONE FIELD THE VALIDATOR NEVER SAW. Everything above is checked by
			# `reaper-result.mjs validate`, and then this line adds a field after that check has
			# already passed. A null or empty `.updated_at` from the runs API — a transport hiccup,
			# not a corrupted artifact — wrote `"completed_at": ""`, which the rollup then read as an
			# unparseable timestamp. Refusing it here keeps a bad field out of the snapshot, where it
			# would otherwise be carried forward unchanged every night.
			if [ -z "$reaper_completed_at" ] || [ "$reaper_completed_at" = "null" ]; then
				echo "::warning::programme-fetch: reaper artifact $artifact_id has no usable completion time (updated_at was empty); refusing it." >&2
				continue
			fi
			observation="$(printf '%s' "$normalized" | jq -c --arg at "$reaper_completed_at" '. + {completed_at: $at}')"
			# Re-validate WITH the injected field rather than trusting the addition. The composed
			# object is the only shape anything downstream reads, so it is the shape that has to be
			# checked. `validate` reads a path, so this goes through a temp file rather than a pipe.
			composed="$reaper_tmp/${reaper_run_id}-${provider}-composed.json"
			printf '%s' "$observation" >"$composed"
			if ! node scripts/e2e/reaper-result.mjs validate --file "$composed" --allow-completed-at >/dev/null 2>&1; then
				echo "::warning::programme-fetch: reaper artifact $artifact_id failed validation after completed_at was added; refusing it." >&2
				continue
			fi
			fresh_reaper="$(printf '%s' "$fresh_reaper" | jq -c --argjson o "$observation" '. + [$o]')"
			seen_reaper="$seen_reaper $provider"
			reaper_resolved=$((reaper_resolved + 1))
		done
	done < <(printf '%s' "$reaper_runs" | jq -r '.[] | [.id, .completed_at] | @tsv')

	# New observations overwrite the same provider only. Missing providers carry forward and age
	# naturally against this snapshot's persisted derived_at; after 48h the rollup marks them stale.
	reaper_observations="$(jq -cn --argjson previous "$prev_reaper" --argjson fresh "$fresh_reaper" '
    (reduce ($previous[]?) as $o ({}; if (($o | type) == "object" and ($o.provider | type) == "string") then .[$o.provider] = $o else . end)) as $by_provider
    | reduce ($fresh[]?) as $o ($by_provider; .[$o.provider] = $o)
    | [to_entries[] | .value]')"
else
	echo "::warning::programme-fetch: could not list orphan-reaper runs; CARRYING FORWARD prior observations rather than erasing them." >&2
fi

jq -n \
	--arg derived_at "$derived_at" \
	--arg previous_derived_at "$prev_derived" \
	--arg repo "$REPO" \
	--argjson open_issues "$issues" \
	--argjson closed_issues "$closed" \
	--argjson open_issues_truncated "$open_truncated" \
	--argjson closed_issues_truncated "$closed_truncated" \
	--argjson variables "$vars" \
	--argjson secrets "$secrets" \
	--argjson gate_observations "$observations" \
	--argjson orphan_reaper_observations "$reaper_observations" \
	--arg inventory_observed_at "$inventory_observed_at" \
	'{
    "_doc": "GENERATED by scripts/programme-fetch.sh. Do not edit. The LIVE board and orphan-reaper state PROGRAMME.md cannot derive from the tree. Variable and secret NAMES only — never values.",
    derived_at: $derived_at,
    previous_derived_at: $previous_derived_at,
    repo: $repo,
    open_issues: $open_issues,
    closed_issues: $closed_issues,
    open_issues_truncated: $open_issues_truncated,
    closed_issues_truncated: $closed_issues_truncated,
    variables: $variables,
    secrets: $secrets,
    inventory_observed_at: $inventory_observed_at,
    gate_observations: $gate_observations,
    orphan_reaper_observations: $orphan_reaper_observations
  }' >"$OUT"

# The counts say CAPPED or not. A bare number is the thing that read identically at "500 total" and
# "500 dropped 228", which is how this went unnoticed for weeks.
open_note=''
closed_note=''
if [ "$open_truncated" = true ]; then open_note=" (CAPPED at $OPEN_LIMIT — TRUNCATED)"; fi
if [ "$closed_truncated" = true ]; then closed_note=" (CAPPED at $CLOSED_LIMIT — TRUNCATED)"; fi
printf 'programme-fetch: wrote %s — %s open%s / %s closed%s issues, %s variables, %s secrets, %s gate observations, %s reaper observations\n' \
	"$OUT" \
	"$(jq '.open_issues | length' "$OUT")" \
	"$open_note" \
	"$(jq '.closed_issues | length' "$OUT")" \
	"$closed_note" \
	"$(jq '.variables | length' "$OUT")" \
	"$(jq '.secrets | length' "$OUT")" \
	"$(jq '.gate_observations | length' "$OUT")" \
	"$(jq '.orphan_reaper_observations | length' "$OUT")"
