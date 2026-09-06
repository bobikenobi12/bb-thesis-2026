#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# nightly-rollup.sh — derive the 5-cloud verdict for one E2E-nightly run. PURE: no network, no gh,
# no token. Proofs directory + the run's job list in; step-summary table, per-leg verdicts, issue
# titles and issue bodies out. Every `gh issue create|edit|close` stays in e2e-nightly.yml, driven
# by what this writes. That seam is the point: all the CONTENT is testable offline, and only the
# API calls — which have no logic left in them — stay untested.
#
# WHY THIS EXISTS (#1613). Run 30341785056 provisioned aws for real and failed at `tofu plan`. The
# rollup reported it as `SKIP — gate off, no secret/var wired`, filed the red under the cloudless
# title "e2e nightly: job RED", refreshed the coverage issue to claim aws needed a var it already
# has, and appended NO ledger row. One cause under all four: every leg's state was derived from a
# hardcoded artifact DIRECTORY PATH (`proofs/e2e-proof-<p>-<run_id>/…`), and that path did not
# exist — actions/download-artifact had extracted to the root of `proofs`. Absence of a file was
# read as "this cloud was never enabled", which is the one conclusion it cannot support.
#
# So discovery here never looks at a path. It reads every provision-summary.json under the proofs
# tree and keys on the bundle's OWN `.provider`, accepting it only when `.run_tag` names THIS run
# (the tree also carries checked-in history — the aws artifact held a bundle from six days earlier).
# Gate-off legs write an explicit `outcome: skipped` summary using that same contract — but so does
# a leg that DIED before the harness, so `outcome` alone can never grant SKIP: see gate_off_bundle()
# below, which classifies on which emitter wrote the bundle and defaults to FAIL (#1922). Existence gets
# a SECOND, INDEPENDENT source from the run's jobs API only as a fail-closed fallback: a matrix job
# with no current-run success/failure/skip summary is FAIL, never an inferred SKIP.
#
# Usage:
#   nightly-rollup.sh                 # derive (reads the env below, writes OUT_DIR)
#   nightly-rollup.sh --self-test     # run the offline fixtures; no network, no token
#
# Env:
#   RUN_ID        (required) the workflow run id — scopes which bundles count as this run's.
#   PROOFS_DIR    (default `proofs`) root of the downloaded artifacts. Layout-agnostic.
#   JOBS_JSON     path to the run's `actions/runs/<id>/jobs` payload. Absent/unreadable ⇒ the
#                 existence cross-check degrades to summary-presence, LOUDLY (::warning::).
#   OUT_DIR       (default `$RUNNER_TEMP` or a temp dir) where the rendered artifacts land.
#   MATRIX_RESULT the `needs.provision.result` aggregate.
#   RUN_URL       link used in the issue bodies.
#   E2E_DIMENSION one of `floor` `maxconfig` `addons` `gitops` `byo-iac` `day2` `full` (plus the
#                 legacy `byo`, an alias of `gitops`) — which dimension this run
#                 proved, from resolve-dimension.sh (all six are dispatchable; only `floor` is
#                 scheduled). Absent ⇒ `floor`, matching that script's fail-safe default.
#
# Writes into OUT_DIR:
#   summary.md              the step-summary block (table + coverage)
#   state.env               REDS / SKIPS / JOB_NO_SUMMARY / DIED_EARLY / POST_CAPTURE / UNSWEPT /
#                           ENABLED_N / SKIP_N / TOTAL / COV_TITLE / COV_LABEL / DIMENSION /
#                           DIMENSION_LABEL
#   failed-steps-<p>.txt    the failing step names for a POST_CAPTURE leg — written only for those
#   issue-red-<id>.md       one body per red leg, with its title on the first `title:` line
#   issue-body-coverage.md  the standing coverage-issue body
#   ledger.tsv              provider<TAB>verdict<TAB>detail<TAB>bundle — one row per PASS/FAIL leg;
#                           only PROVABLY gate-off SKIPs are omitted. The ledger step reuses this
#                           discovery instead of repeating the join that just lost a whole run.
set -uo pipefail

# dimension_label lives in resolve-dimension.sh — ONE mapping, so the title this renders (the dedup
# key) and the row the ledger step appends can never drift apart. Sourced, not executed (#1755).
# shellcheck source=scripts/e2e/resolve-dimension.sh
. "$(dirname "${BASH_SOURCE[0]}")/resolve-dimension.sh"

PROVIDERS="hetzner aws gcp azure alibaba"
TOTAL=5

# The provision matrix's display name. Cross-checking existence means depending on it, and a rename
# would silently return us to "absence means never enabled" — so a jobs payload that contains jobs
# but NONE matching this prefix is reported as a wiring break rather than quietly believed.
PROVISION_JOB_PREFIX="${PROVISION_JOB_PREFIX:-Provision + verify + teardown}"
# The step whose conclusion answers "was the account swept?" (#2330). Overridable for the same
# reason PROVISION_JOB_PREFIX is: it is a DISPLAY NAME, and a rename here silently kills the
# cross-check. teardown_outcome reports `unknown`, never `done`, when it cannot find the step.
TEARDOWN_STEP_PREFIX="${TEARDOWN_STEP_PREFIX:-Guaranteed teardown}"

# ── discovery ──────────────────────────────────────────────────────────────────────────────────
# scan_summaries: every provision-summary.json under $PROOFS_DIR as
# path<TAB>provider<TAB>run_tag<TAB>outcome<TAB>verdict. Sorted so a tree with two candidate
# bundles resolves the same way twice.
scan_summaries() {
	local dir="$1" f
	[ -d "$dir" ] || return 0
	find "$dir" -type f -name provision-summary.json 2>/dev/null | LC_ALL=C sort | while IFS= read -r f; do
		jq -r --arg path "$f" \
			'[$path, (.provider // ""), (.run_tag // ""), (.outcome // "unknown"), (.verdict // "")] | @tsv' \
			"$f" 2>/dev/null || true
	done
}

# summary_for <provider> <run_id> — the first bundle claiming this provider AND this run.
# `.run_tag` is written as nightly-<run_id>-<attempt> by demos/proofs/capture-proof.sh, so the
# prefix match is exact and a bundle from any other run is invisible here.
summary_for() {
	local want="$1" run_id="$2" path prov tag rest
	while IFS="$(printf '\t')" read -r path prov tag rest; do
		[ "$prov" = "$want" ] || continue
		case "$tag" in
		"nightly-${run_id}-"*) printf '%s\t%s\n' "$path" "$rest"; return 0 ;;
		esac
	done <<-EOF
		$(scan_summaries "$PROOFS_DIR")
	EOF
	return 1
}

# jobs_payload — normalize the GitHub API's two valid shapes into one object. Plain `gh api`
# returns `{jobs:[...]}`; `gh api --paginate --slurp` returns `[{jobs:[...]}, ...]`. Keeping the
# normalization here means every reader below consumes the same complete job list and a future
# pagination change cannot make one reader disagree with another.
jobs_payload() {
	[ -n "${JOBS_JSON:-}" ] && [ -r "${JOBS_JSON:-}" ] || return 1
	jq -c 'if type == "array" then {jobs: [.[].jobs[]?]} else . end' "$JOBS_JSON"
}

# gate_off_bundle <summary-path> <run_id> — is this `outcome:skipped` bundle PROVABLY the
# workflow's gate-off proof, or is it a leg that DIED before the harness ever started? (#1922)
#
# `outcome` alone cannot tell them apart, and reading it as "inert" is the whole bug. On run
# 30882660761 alibaba's gate was ON — both E2E_ALIBABA_ROLE_ARN and E2E_ALIBABA_OIDC_PROVIDER_ARN
# have been set since 2026-08-03 — and its `Configure Alibaba credentials (RAM OIDC)` step failed
# with `400 MissingTimestamp`. The `always()` capture then ran with the step outcome it was handed
# and wrote `outcome:"skipped"` — carrying a verdict that literally reads `❌ FAILED at stage
# 'queued'` — which this rollup rendered as a SKIP row. No red was filed, the coverage issue (#1720)
# was refreshed with a body claiming a variable that IS set is unset, and SKIP_N said 2 where the
# truth was 1. #1850 (hetzner, `Install hcloud CLI` 404) is the same mechanism; #1723 the same family.
#
# So classify on the bundle's PROVENANCE — which emitter wrote it — and DEFAULT TO FAIL: only a
# bundle that is provably the gate-off one is inert. The two emitters are already distinguishable
# without any workflow change, and this mirrors EVERY condition the gate-off emitter checks (#1831 —
# a gate that reports on an emitter must mirror all of its conditions, not one of three):
#
#   .github/workflows/e2e-nightly.yml `Record gate-off proof`, `if: steps.gate.outputs.run == 'false'`
#     dir     demos/proofs/<provider>/gate-<run_id>-<run_attempt>/     ← the run-scoped literal
#     payload exactly {provider, run_tag, outcome:"skipped", verdict}  ← no deploy_stage, ever
#   demos/proofs/capture-proof.sh (the normal, gate-ON path)
#     dir     demos/proofs/<provider>/<UTC-stamp>/                     ← never starts with `gate-`
#     payload always carries deploy_stage (queued|planning|…)          ← written unconditionally
#
# The DIRECTORY NAME is the primary discriminator, preferred over sniffing field combinations: it is
# a literal only the gate-off step can write, it embeds the same run id + attempt the `run_tag`
# already anchors on, and it survives both artifact layouts (upload-artifact publishes
# `demos/proofs/<provider>/`, so the stamp/gate dir is the top level of the artifact and download
# preserves it whether or not the per-artifact wrapper dir is flattened — the #1613 hazard).
# The absent `deploy_stage` is a second, independent condition from the same emitter contract, so a
# real capture that somehow landed in a `gate-*` dir still cannot pass as inert.
#
# Every failure mode of this function — unreadable JSON, a run_tag that does not name this run, a
# directory name that does not match — returns non-zero, i.e. FAIL. A reporting layer whose failure
# mode is silence is worse than one that is occasionally noisy.
#
# RESIDUAL GAP, deliberately left to a separate change on the workflow side. Both conditions above
# are the emitter's contract MIRRORED here as literals; nothing compiles them together. Edit that
# step's `OUT=` path and every inert leg starts filing a red — loud and immediately obvious, which is
# the direction we want it to fail, but still a silent coupling. The airtight fix is for the gate-off
# step to STAMP its own provenance (e.g. `emitted_by: "gate-off"`), which this rollup would then read
# directly; that is a workflow edit and is sequenced separately. write_gate_off() in the self-test
# reconstructs the contract from the same two literals, so a drift shows up as a red test here.
gate_off_bundle() {
	local path="$1" run_id="$2" dir tag attempt
	dir="$(basename "$(dirname "$path")")"
	tag="$(jq -r '.run_tag // ""' "$path" 2>/dev/null || echo "")"
	# The attempt suffix, taken from the run_tag the bundle itself carries.
	# Quoted separately (SC2295): unquoted, $run_id would be read as a GLOB, not a literal.
	attempt="${tag#nightly-"${run_id}"-}"
	[ -n "$attempt" ] && [ "$attempt" != "$tag" ] || return 1
	[ "$dir" = "gate-${run_id}-${attempt}" ] || return 1
	jq -e 'has("deploy_stage") | not' "$path" >/dev/null 2>&1 || return 1
	return 0
}

# job_exists <provider> — did Actions create this cloud's matrix job?
# Echoes yes | no | unknown. `unknown` is deliberate and distinct from `no`: it means we could not
# ask, and the caller must NOT infer whether the gate was enabled.
job_exists() {
	local want="$1"
	jobs_payload | jq -e '(.jobs // []) | length > 0' >/dev/null 2>&1 || { echo unknown; return; }
	if ! jobs_payload | jq -e --arg pre "$PROVISION_JOB_PREFIX" \
		'[(.jobs // [])[] | select(.name | startswith($pre))] | length > 0' >/dev/null 2>&1; then
		echo unknown
		return
	fi
	if jobs_payload | jq -e --arg pre "$PROVISION_JOB_PREFIX" --arg p "$want" \
		'[(.jobs // [])[] | select((.name | startswith($pre)) and (.name | endswith("(" + $p + ")")))] | length > 0' \
		 >/dev/null 2>&1; then
		echo yes
	else
		echo no
	fi
}

# teardown_outcome <provider> — did this leg's cloud sweep reach a conclusion? (#2330)
#
# Echoes one of: done | UNSWEPT | unknown.
#
# WHY THIS IS A SEPARATE QUESTION FROM PASS/FAIL. The rollup already reports a cancelled leg as
# FAIL — a job conclusion with no readable bundle is fixture #4's "RAN, NO SUMMARY … FAIL, never
# SKIP". What it could not say is whether resources are STILL STANDING. On run 31459117502 the
# board correctly read "aws RED (floor)", which a reader interprets as a provisioning failure and
# not as "an EKS control plane and a NAT gateway are billing right now". Nobody reading that
# would know to go and sweep. A red leg has to distinguish:
#
#   * it never provisioned            → nothing to sweep, the red is the whole story
#   * it provisioned and MAY BE STANDING → somebody has to look, today
#
# The fingerprint is exact and needs no new data: when the worker is killed mid-step the step
# record carries NO conclusion at all (the runner does not finish uploading it). So an empty — or
# explicitly `cancelled` — conclusion on the teardown step is this leak, and any other value means
# the sweep at least ran to a verdict.
#
# `unknown` is deliberate and distinct from `done`: no jobs payload, no matching job, or no
# matching step means we could not ask. Absence of evidence is not a swept account, and the caller
# must not report it as one.
teardown_outcome() {
	local want="$1" concl
	concl="$(jobs_payload | jq -r --arg pre "$PROVISION_JOB_PREFIX" --arg p "$want" --arg step "$TEARDOWN_STEP_PREFIX" '
		[ (.jobs // [])[]
		  | select((.name | startswith($pre)) and (.name | endswith("(" + $p + ")")))
		  | (.steps // [])[]
		  | select(.name | startswith($step))
		] | first | if . == null then "missing" else (.conclusion // "") end
	' 2>/dev/null || echo missing)"
	case "$concl" in
	missing) echo unknown ;;
	"" | null | cancelled) echo UNSWEPT ;;
	# Quoted: bare `done` is a shell keyword and shellcheck reads it as a stray loop terminator.
	*) echo "done" ;;
	esac
}

# jobs_payload_is_broken: jobs exist but none is a provision leg ⇒ the display name moved and the
# cross-check is dead. Loud, because a silent degrade here is the whole bug.
jobs_payload_is_broken() {
	jobs_payload | jq -e '(.jobs // []) | length > 0' >/dev/null 2>&1 || return 1
	jobs_payload | jq -e --arg pre "$PROVISION_JOB_PREFIX" \
		'[(.jobs // [])[] | select(.name | startswith($pre))] | length == 0' >/dev/null 2>&1
}

# in_list <space-separated list> <item> — membership, the one shape this file's accumulators use.
# Written once because the ad-hoc `case " $list " in *" $item "*)` it replaces is easy to get
# subtly wrong (drop either padding space and `aws` starts matching inside `awsx`).
in_list() {
	case " ${1} " in
	*" ${2} "*) return 0 ;;
	*) return 1 ;;
	esac
}

# job_conclusion <provider> — the Actions conclusion of this cloud's matrix JOB (#2512).
# Echoes success | failure | cancelled | skipped | … | unknown.
#
# WHY A PASSING BUNDLE IS NOT A PASSING LEG. `Capture proof` is NOT the last step of the provision
# job. `Guaranteed teardown` and `CLI-only demo bar` both run after it, deliberately — the bar was
# MOVED below the capture (see e2e-nightly.yml, "Only the ORDER moves, so the provisioning proof
# gets to run and record a real verdict before the bar reports on itself") while keeping its verdict
# fail-closed. That reordering created a leg state this rollup had no vocabulary for: bundle says
# `outcome: success`, job says `failure`.
#
# Nothing classified such a leg as red, so `reds` came back EMPTY on a `failure` matrix and the
# matrix fallback below fired — filing "matrix RED (<dim> · no per-leg proof)", a body asserting
# that no cloud produced a bundle, in the very same job that had just read that cloud's bundle and
# appended its PASS row to the parity ledger. It happened four nights running: #2512 (floor, run
# 32816061207, azure), #2631 (byo, 32878485034), #2640 (addons, 32883521925) and #2657 (day2,
# 32886071207) — all four with `recorded: PASS → e2e-proof-<cloud>-<run>` in the same step log.
#
# e2e-nightly.yml's own header already promised this cross-check — "derived from each leg's
# provision-summary.json, cross-checked against that leg's JOB CONCLUSION" — but only EXISTENCE was
# ever read (job_exists). This reads the conclusion the comment names.
#
# `unknown` is deliberate and distinct from every real conclusion: it means we could not ask (no
# payload, unreadable payload, no matching job, or a job still running with a null conclusion), and
# the caller must NOT infer a verdict from it. The matrix fallback below states that degraded case
# rather than reusing the "no bundle" wording for it.
job_conclusion() {
	local want="$1" c
	c="$(jobs_payload | jq -r --arg pre "$PROVISION_JOB_PREFIX" --arg p "$want" '
		[ (.jobs // [])[]
		  | select((.name | startswith($pre)) and (.name | endswith("(" + $p + ")")))
		] | first | if . == null then "" else (.conclusion // "") end
	' 2>/dev/null || echo "")"
	case "$c" in
	"" | null) echo unknown ;;
	*) echo "$c" ;;
	esac
}

# failed_steps <provider> — comma-joined names of this job's steps whose conclusion is `failure`.
#
# This is what turns "the job went red after the capture" into an ACTIONABLE issue: the step name is
# the whole diagnosis, and it is already sitting in the jobs payload. Called ONLY after
# job_conclusion has returned `failure`, which already establishes that the payload is readable and
# that this cloud's job is in it — so an empty result here means "the job list names no failed
# step", never "could not ask". The caller renders that distinction rather than printing an empty
# list, because a blank where a cause belongs reads as "no cause" (#2512 is that mistake once
# already).
failed_steps() {
	local want="$1"
	jobs_payload | jq -r --arg pre "$PROVISION_JOB_PREFIX" --arg p "$want" '
		[ (.jobs // [])[]
		  | select((.name | startswith($pre)) and (.name | endswith("(" + $p + ")")))
		  | (.steps // [])[]
		  | select((.conclusion // "") == "failure")
		  | .name
		] | join(", ")
	' 2>/dev/null || true
}

# ── derivation ─────────────────────────────────────────────────────────────────────────────────
derive() {
	local run_id="${RUN_ID:?RUN_ID is required — it is what scopes a bundle to this run}"
	local out="${OUT_DIR:-${RUNNER_TEMP:-}}"
	[ -n "$out" ] || out="$(mktemp -d)"
	mkdir -p "$out"
	: >"$out/ledger.tsv"

	local reds="" skips="" job_no_summary="" died_early="" p hit path outcome verdict detail status exists stage
	# Legs whose cloud sweep never reached a conclusion — resources may still be BILLING (#2330).
	local unswept=""
	# Legs whose bundle says PASS. Kept because the matrix fallback below MUST be able to tell
	# "nothing produced a bundle" from "everything did and they all passed" — those two states had
	# one issue body between them, and it asserted the first (#2512).
	local passes=""
	# Legs whose provisioning PASSED and whose JOB then went red — a red outside the proof window
	# (#2512). A subset of `reds`, exported separately so the ledger/notification steps can name the
	# failure mode, exactly as DIED_EARLY does for #1922.
	local post_capture="" concl steps

	if jobs_payload_is_broken; then
		echo "::warning::the jobs payload has no job starting with '${PROVISION_JOB_PREFIX}' — the existence cross-check is DEAD (was the matrix job renamed?). Falling back to proof-presence, which cannot tell a red leg from an unwired one."
	fi

	{
		echo "## E2E nightly — 5-cloud verdict rollup"
		echo
		echo "matrix result: \`${MATRIX_RESULT:-unknown}\` · [run](${RUN_URL:-})"
		echo
		echo "| cloud | status | detail |"
		echo "|---|---|---|"
	} >"$out/summary.md"

	for p in $PROVIDERS; do
		hit="$(summary_for "$p" "$run_id" || true)"
		exists="$(job_exists "$p")"
		if [ -n "$hit" ]; then
			path="${hit%%	*}"
			outcome="$(jq -r '.outcome // "unknown"' "$path" 2>/dev/null || echo unknown)"
			verdict="$(jq -r '.verdict // ""' "$path" 2>/dev/null || echo "")"
			detail="${verdict:-$outcome}"
			if [ "$outcome" = "success" ]; then
				# The PARITY LEDGER row stays PASS on the bundle's evidence, whatever the job did
				# afterwards. That ledger measures one thing — did provisioning work on this cloud —
				# and it did: the harness ran, ArgoCD went Healthy+Synced, the capture recorded it.
				# Downgrading the row because a LATER step failed would erase a real proof.
				printf '%s\t%s\t%s\t%s\n' "$p" "PASS" "$detail" "e2e-proof-${p}-${run_id}" >>"$out/ledger.tsv"
				# The LEG verdict is a different question, and it is the job that answers it. A red
				# job is a red leg even on a green bundle (#2512) — see job_conclusion() for the four
				# nights this cost. Only `failure` counts: a `cancelled` job is a human or a timeout,
				# it does not aggregate to MATRIX_RESULT=failure, and filing a red for it would train
				# the signal into noise.
				concl="$(job_conclusion "$p")"
				if [ "$concl" = "failure" ]; then
					status="FAIL"
					steps="$(failed_steps "$p")"
					# Distinguish "no step is marked failed" from "we could not ask". We CAN ask —
					# job_conclusion already proved the payload readable — so an empty list is a real
					# and reportable answer (a job can go red in `Set up job` or a post step, neither
					# of which lands in `steps[]` with a failure conclusion).
					[ -n "$steps" ] || steps="none — the job list marks no step \`failure\` (set-up or post step?)"
					detail="provisioned OK (bundle PASS) but the JOB went red AFTER the capture — failing step(s): ${steps}"
					reds="$reds $p"
					post_capture="$post_capture $p"
					printf '%s\n' "$steps" >"$out/failed-steps-${p}.txt"
				else
					status="PASS"
					passes="$passes $p"
				fi
			elif [ "$outcome" = "skipped" ] && gate_off_bundle "$path" "$run_id"; then
				# Provably the gate-off emitter's own bundle: correct, inert, nothing to report.
				status="SKIP"
				skips="$skips $p"
			elif [ "$outcome" = "skipped" ]; then
				# `outcome:skipped` from the CAPTURE path — the leg's gate was on and it died before
				# the harness started (a credentials/CLI-install step failed, so every later step
				# green-skipped). That is a red, not an unwired cloud (#1922).
				status="FAIL"
				stage="$(jq -r '.deploy_stage // "unknown"' "$path" 2>/dev/null || echo unknown)"
				detail="died before the harness (stage \`${stage}\`) — skipped by a failed setup step, NOT a gate-off"
				reds="$reds $p"
				died_early="$died_early $p"
				printf '%s\t%s\t%s\t%s\n' "$p" "$status" "$detail" "e2e-proof-${p}-${run_id}" >>"$out/ledger.tsv"
			else
				status="FAIL"
				reds="$reds $p"
				printf '%s\t%s\t%s\t%s\n' "$p" "$status" "$detail" "e2e-proof-${p}-${run_id}" >>"$out/ledger.tsv"
			fi
		elif [ "$exists" = "yes" ]; then
			# The matrix job exists but emitted no explicit success/failure/skip summary. That is a
			# failure to report, not evidence that the cloud's gate was off.
			status="FAIL"
			detail="matrix job produced no readable explicit summary"
			reds="$reds $p"
			job_no_summary="$job_no_summary $p"
			printf '%s\t%s\t%s\t%s\n' "$p" "FAIL" "$detail" "e2e-proof-${p}-${run_id}" >>"$out/ledger.tsv"
		else
			status="SKIP"
			detail="gate off — no secret/var wired"
			skips="$skips $p"
		fi
		# ── Teardown outcome (#2330). Asked for every leg that RAN, independent of pass/fail:
		#    a green leg whose sweep was killed is still billing, and a red leg that never
		#    provisioned has nothing to sweep. The distinction is the signal, not the verdict.
		if [ "$exists" = "yes" ]; then
			case "$(teardown_outcome "$p")" in
			UNSWEPT)
				unswept="$unswept $p"
				detail="${detail} — ⚠️ TEARDOWN DID NOT COMPLETE, resources may still be billing"
				;;
			esac
		fi
		detail="${detail//|/\\|}"
		echo "| ${p} | ${status} | ${detail} |" >>"$out/summary.md"
	done

	# A wholesale matrix failure that produced no per-leg verdict at all is still red. It is labelled
	# `(matrix)` and NOT `job`: the label lands in an issue title, the title IS the dedup key, and
	# `job` was indistinguishable from a cloud name — so every cloud's red collapsed onto one
	# nameless issue (#1601).
	#
	# It is TWO states, not one, and they need different words (#2512). The condition tests "no cloud
	# was classified red" — it never tested what the issue body went on to assert, that no cloud
	# produced a bundle. A run whose leg passed provisioning, wrote a bundle, and then went red on a
	# step below the capture landed here and was told the opposite of the truth, with an instruction
	# ("A leg that ran and left no bundle usually died before the always() proof capture") that sent
	# four readers looking for a missing artifact that was sitting in the run.
	#
	# The per-leg cross-check above now attributes that case to its cloud, so reaching this branch
	# WITH passes means the jobs payload could not answer — degraded, and it says so.
	local matrix_red=""
	if [ "${MATRIX_RESULT:-}" = "failure" ] && [ -z "${reds// /}" ]; then
		if [ -n "${passes// /}" ]; then
			matrix_red="unattributed"
			echo "| (matrix) | FAIL | matrix red, but every leg that ran left a PASS bundle:${passes} — and no leg's job conclusion reads \`failure\`, so the red cannot be attributed |" >>"$out/summary.md"
		else
			matrix_red="no-proof"
			echo "| (matrix) | FAIL | provision matrix failed with no per-leg proof bundle |" >>"$out/summary.md"
		fi
		reds="$reds matrix"
	fi

	local skip_n enabled_n
	skip_n="$(printf '%s' "$skips" | wc -w | tr -d ' ')"
	enabled_n=$((TOTAL - skip_n))
	{
		echo
		if [ "$skip_n" -eq 0 ]; then
			echo "**Coverage: ${enabled_n}/${TOTAL} clouds enabled** — every leg is wired."
		else
			echo "**Coverage: ${enabled_n}/${TOTAL} clouds enabled** · inert (gate off):${skips}"
			echo
			echo "> An inert leg proves nothing. See \`docs/testing/e2e-nightly-enablement.md\` to wire one."
		fi
		if [ -n "${job_no_summary// /}" ]; then
			echo
			echo "> ⚠️ Matrix job left no readable explicit summary:${job_no_summary} — counted as FAIL, not as an unwired leg."
		fi
		if [ -n "${died_early// /}" ]; then
			echo
			echo "> ⚠️ Gate ON but the leg never reached the harness:${died_early} — \`outcome: skipped\` from the capture path, not the gate-off proof. Counted as FAIL, and NOT as an unwired leg (#1922)."
		fi
		if [ -n "${post_capture// /}" ]; then
			echo
			echo "> ⚠️ Red BELOW the proof window:${post_capture} — provisioning passed and the bundle proves it, then a"
			echo "> step after \`Capture proof\` failed. The leg is FAIL here because its job is red, while the"
			echo "> provisioning-parity ledger keeps its PASS row: those are two different questions and this is the"
			echo "> one run shape where they disagree. Read the named step, not the deploy spine (#2512)."
		fi
		# The money line (#2330). Deliberately separate from the PASS/FAIL table: the verdict says
		# whether the product worked, this says whether the account is clean. Run 31459117502 was
		# correctly red AND left ~$105/mo standing, and nothing on the board said the second part.
		if [ -n "${unswept// /}" ]; then
			echo
			echo "> 💸 **TEARDOWN DID NOT COMPLETE:${unswept}** — the cloud sweep step reached no conclusion, so"
			echo "> resources from this run MAY STILL BE BILLING. This is not the same as a red leg: a leg that"
			echo "> never provisioned has nothing to sweep, and this one may have."
			echo ">"
			echo "> \`e2e-orphan-reaper.yml\` reclaims these out-of-band on its next scheduled run — but it only"
			echo "> fires from the DEFAULT BRANCH, so confirm it is live before assuming it has been handled."
			echo "> To sweep now: \`ALETHIA_E2E_ENV=<run_id>-<attempt> ALETHIA_E2E_REGION=<region> ./scripts/e2e/<cloud>-cleanup.sh\`"
		fi
	} >>"$out/summary.md"

	# ── issue bodies. Rendered here so their CONTENT is under test; the workflow only posts them. ──
	#
	# The DIMENSION belongs in the red title because the title IS the dedup key (#1755). Keyed on the
	# cloud alone, the floor and full-bar runs collapse onto one issue that silently re-points at
	# whichever ran last: on 2026-08-02 the full bar's five apply-stage defects were deduped away
	# against the floor's ArgoCD failure and had to be filed by hand. Dedup stays PER-DIMENSION, not
	# per-run — three consecutive floor reds still land on one issue, which is the behaviour that
	# makes this a tracker rather than a firehose.
	local dim dim_label
	dim="${E2E_DIMENSION:-floor}"
	# `|| return $?` because this script runs under `set -uo pipefail` and NOT `-e`: without it, a
	# refusal from dimension_label leaves `dim_label` empty and the filer renders
	# `e2e nightly: aws RED ()` — a title that dedups every unknown dimension onto ONE issue, which
	# is the collision the refusal exists to prevent, wearing a different name (#4084).
	dim_label="$(dimension_label "$dim")" || return $?

	# The coverage issue deliberately gets NO dimension suffix. It reports which clouds are unwired,
	# which is a property of the repo's gate variables and identical on both crons; suffixing it would
	# orphan the open issue and file a second one every Sunday.
	#
	# The title is NOT the dedup key — `cov_label` below is (#1958). The title carries the counts, so
	# it changes whenever coverage changes and could only ever be matched by a pattern; a pattern over
	# a mutable, human-editable field is not an identity. It was matched by an anchored regex until
	# #1720 was hand-edited from "clouds are not enabled" to "clouds is not enabled", at which point
	# the filer stopped finding it and would have filed a duplicate every night.
	local cov_title="e2e nightly: ${skip_n} of ${TOTAL} clouds are not enabled" s
	# The dedup IDENTITY. This filer is the only thing that applies it, and `gh issue list --label` is
	# served live rather than from the (lagging) search index — the two properties #1755 established
	# for the red filer. Declared here so the workflow reads ONE answer instead of retyping it.
	local cov_label="from:e2e-coverage"
	{
		printf '%s\n\n' "Only **${enabled_n} of ${TOTAL}** nightly legs provision anything. The rest green-skip at the gate, so the run reports success while proving nothing for them."
		printf '%s\n\n' "Run: ${RUN_URL:-}"
		printf '%s\n' "| cloud | needs |"
		printf '%s\n' "|---|---|"
		for s in $skips; do
			case "$s" in
			hetzner) printf '%s\n' "| hetzner | \`HCLOUD_TOKEN\` (repo **secret**) |" ;;
			aws) printf '%s\n' "| aws | \`E2E_AWS_ROLE_ARN\` (repo variable) — from \`infra/aws-oidc\` |" ;;
			gcp) printf '%s\n' "| gcp | \`E2E_GCP_WIF_PROVIDER\` **and** \`E2E_GCP_SA_EMAIL\` — from \`infra/gcp-e2e\` |" ;;
			azure) printf '%s\n' "| azure | \`E2E_AZURE_CLIENT_ID\`, \`E2E_AZURE_TENANT_ID\`, \`E2E_AZURE_SUBSCRIPTION_ID\`, \`ALETHIA_E2E_AZURE_ADMIN_GROUP_OBJECT_ID\` — from \`infra/azure-e2e\` |" ;;
			alibaba) printf '%s\n' "| alibaba | \`E2E_ALIBABA_ROLE_ARN\` **and** \`E2E_ALIBABA_OIDC_PROVIDER_ARN\` — from \`infra/alibaba-e2e\` |" ;;
			esac
		done
		printf '\n%s\n' "Procedure (apply the stack → dispatch that cloud alone → kill-drill → set the gate var): \`docs/testing/e2e-nightly-enablement.md\`."
		printf '%s\n' "_Auto-maintained by the e2e-nightly rollup: refreshed while legs are inert, closed automatically at ${TOTAL}/${TOTAL}._"
	} >"$out/issue-body-coverage.md"

	local cloud title
	for cloud in $reds; do
		if [ "$cloud" = "matrix" ] && [ "$matrix_red" = "unattributed" ]; then
			# Distinct TITLE, because it is a distinct claim and the title is the dedup key. Filing
			# this one under the "no per-leg proof" title would re-open #2512's lie under a new number.
			title="e2e nightly: matrix RED (${dim_label} · every leg PASSED)"
			printf '%s\n' "$title" >"$out/issue-red-${cloud}.title"
			{
				printf '%s\n\n' "The T2 real-cloud **${dim_label}** nightly matrix went **RED**, but every leg that ran left a proof bundle and every one of them says **PASS** (\`outcome: success\`):${passes}."
				printf '%s\n\n' "Run: ${RUN_URL:-}"
				printf '%s\n\n' "**This is the degraded path, and that is the finding.** A red job on a passing bundle is normally attributed to its cloud by reading that leg's JOB CONCLUSION from the run's jobs API — \`Capture proof\` is not the last step, so a leg can pass provisioning and still go red below it. Reaching this issue means that cross-check could not answer — one of exactly four things: no jobs payload was fetched, the payload is unreadable, it holds no job whose name ends \`(<cloud>)\`, or that job carries a null conclusion (still running). Nothing else reaches this issue."
				printf '%s\n' "So start with the rollup job's own log: if it warns that the existence cross-check is DEAD, the provision job was RENAMED and \`PROVISION_JOB_PREFIX\` in \`scripts/e2e/nightly-rollup.sh\` must follow it. Otherwise open the red matrix job and read its first failed step directly."
				printf '%s\n' "_Auto-created by the e2e-nightly rollup and deduped by title._"
			} >"$out/issue-red-${cloud}.md"
			continue
		fi
		if [ "$cloud" = "matrix" ] && [ -n "$matrix_red" ]; then
			title="e2e nightly: matrix RED (${dim_label} · no per-leg proof)"
			printf '%s\n' "$title" >"$out/issue-red-${cloud}.title"
			{
				printf '%s\n\n' "The T2 real-cloud **${dim_label}** nightly matrix went **RED** without producing a per-leg proof bundle for any cloud, so no single cloud can be named."
				printf '%s\n\n' "Run: ${RUN_URL:-}"
				printf '%s\n\n' "Start from the run's job list: the leg that died is the one whose job is red. A leg that ran and left no bundle usually died before the \`always()\` proof capture."
				printf '%s\n' "This title is now reserved for legs that left NO bundle. A leg that left a PASSING bundle and then went red below the capture is filed against its own cloud as \`… RED (<dimension> · after proof capture)\` (#2512)."
				printf '%s\n' "_Auto-created by the e2e-nightly rollup and deduped by title._"
			} >"$out/issue-red-${cloud}.md"
			continue
		fi
		# A red BELOW the proof window is its own title, for two reasons that pull the same way.
		# It is a different failure with a different first move — the named step, not the deploy
		# spine — so collapsing it onto the provisioning red would dedup two unrelated causes onto
		# one issue, which is #1755's mistake in a new place. And it keeps the `(<dim> · …)` shape
		# that scripts/programme-rollup.mjs's openRedIssues regex parses, so the red still CONTESTS
		# this cloud's cell in the programme grid: the maintainer's ruling is that a ceiling is
		# still a FAIL, so a red job must not leave a cell reading "proven" (#2512).
		if in_list "$post_capture" "$cloud"; then
			title="e2e nightly: ${cloud} RED (${dim_label} · after proof capture)"
			printf '%s\n' "$title" >"$out/issue-red-${cloud}.title"
			{
				printf '%s\n\n' "The T2 real-cloud nightly went **RED** for \`${cloud}\` on the **${dim_label}** dimension **after** the proof capture."
				printf '%s\n\n' "Run: ${RUN_URL:-}"
				printf '%s\n\n' "**Provisioning PASSED and the bundle proves it.** \`e2e-proof-${cloud}-${run_id}\` carries \`outcome: \"success\"\`, and the provisioning-parity ledger keeps its PASS row for this leg. \`Capture proof\` is not the last step of the job — \`Guaranteed teardown\` and the \`CLI-only demo bar\` run below it — so this red is real but it is NOT a provisioning failure. Do not start at the deploy spine."
				printf '%s\n\n' "Failing step(s), from the run's jobs API: **$(cat "$out/failed-steps-${cloud}.txt")**"
				printf '%s\n' "Until #2512 this state had no name: the leg was not in \`reds\`, so the matrix fallback fired and filed \`matrix RED (${dim_label} · no per-leg proof)\` — asserting no cloud had produced a bundle, in the same rollup job that read this bundle and ledgered its PASS."
				printf '%s\n' "_Auto-created by the e2e-nightly rollup and deduped by title — close it once \`${cloud}\` is green again._"
			} >"$out/issue-red-${cloud}.md"
			continue
		fi
		title="e2e nightly: ${cloud} RED (${dim_label})"
		printf '%s\n' "$title" >"$out/issue-red-${cloud}.title"
		{
			printf '%s\n\n' "The T2 real-cloud nightly went **RED** for \`${cloud}\` on the **${dim_label}** dimension."
			printf '%s\n\n' "Run: ${RUN_URL:-}"
			case "$dim" in
			full) printf '%s\n\n' "The full bar runs on a \`workflow_dispatch\` with \`full_bar: true\` (no cron schedules it — the weekly one was removed as unpriced on four of five clouds, #2385) with \`ALETHIA_E2E_MAX_CONFIG=1\` + \`ALETHIA_E2E_ALL_ADDONS=1\` — it provisions the whole 11-kind surface, so it fails at stages the floor never reaches. Do NOT read it as the floor re-running." ;;
			*) printf '%s\n\n' "The floor is the nightly \`17 3 * * *\` smoke — base provision + ArgoCD Healthy+Synced. It never provisions the max-config surface, so a full-bar failure is a separate issue with a separate title." ;;
			esac
			case " $job_no_summary " in
			*" $cloud "*)
				printf '%s\n\n' "This cloud's matrix job existed but produced no readable \`provision-summary.json\`, so there is no explicit PASS, FAIL, or SKIP verdict to quote. It is reported as FAIL rather than inferred to be unwired."
				;;
			esac
			case " $died_early " in
			*" $cloud "*)
				printf '%s\n\n' "**This leg died before the harness started.** Its gate was ON, but a setup step (credentials, CLI install) failed, so every later step green-skipped and the \`always()\` capture wrote \`outcome: \"skipped\"\` from the normal capture path — NOT the \`gate-<run>-<attempt>\` proof the gate-off branch writes. Start from the run's job log at the FIRST red step, not at the deploy spine: nothing was provisioned. Until #1922 this was rendered as \`SKIP — gate off\` and no red was filed at all."
				;;
			esac
			printf '%s\n' "See the run's step-summary rollup + the \`e2e-proof-${cloud}-${run_id}\` artifact for the failing stage (deploy stage / cost / leak / stale sweep)."
			printf '%s\n' "_Auto-created by the e2e-nightly rollup and deduped by title — close it once \`${cloud}\` is green again._"
		} >"$out/issue-red-${cloud}.md"
	done

	# Shell-quoted so the workflow can `.` this file: every value here is a space-separated list or
	# a sentence, and an unquoted `SKIPS=hetzner aws gcp …` sources as a COMMAND (it ran the real
	# aws CLI the first time this was written).
	{
		echo "REDS='${reds# }'"
		echo "SKIPS='${skips# }'"
		echo "JOB_NO_SUMMARY='${job_no_summary# }'"
		# Legs whose gate was ON but which died before the harness (#1922). A subset of REDS —
		# exported separately so the ledger/notification steps can name the failure mode.
		echo "DIED_EARLY='${died_early# }'"
		# Legs that PROVISIONED fine and then went red below `Capture proof` (#2512). A subset of
		# REDS, and the one red category whose parity-ledger row is PASS — exported so a downstream
		# consumer can tell the two apart instead of re-deriving it from a job list it does not hold.
		echo "POST_CAPTURE='${post_capture# }'"
		# Legs whose cloud sweep reached NO conclusion — resources may still be billing (#2330).
		# Orthogonal to REDS on purpose: a green leg can be UNSWEPT (its teardown was killed) and a
		# red one can be clean (it never provisioned). Exported so the notification step can say
		# "go and look" without re-deriving it.
		echo "UNSWEPT='${unswept# }'"
		echo "ENABLED_N='${enabled_n}'"
		echo "SKIP_N='${skip_n}'"
		echo "TOTAL='${TOTAL}'"
		echo "COV_TITLE='${cov_title}'"
		echo "COV_LABEL='${cov_label}'"
		# Exported so the ledger step downstream consumes THIS answer instead of re-deriving the
		# dimension from the trigger a third time (#1755).
		echo "DIMENSION='${dim}'"
		echo "DIMENSION_LABEL='${dim_label}'"
	} >"$out/state.env"

	echo "coverage:${enabled_n}/${TOTAL} dimension:${dim} reds:${reds:-<none>} skips:${skips:-<none>}"
}

# ── self-test ──────────────────────────────────────────────────────────────────────────────────
# Every case below is a bug that HAPPENED or is one layout change away from happening. They run
# offline against synthetic trees: no network, no gh, no token.

# write_summary — a bundle from the NORMAL capture path (demos/proofs/capture-proof.sh). It always
# carries `deploy_stage`, whatever the outcome; that is what makes it distinguishable from the
# gate-off bundle below. Callers pass a timestamp-shaped dir, as the real capture does.
write_summary() { # <dir> <provider> <run_tag> <outcome> [deploy_stage]
	mkdir -p "$1"
	cat >"$1/provision-summary.json" <<EOF
{ "provider": "$2", "run_tag": "$3", "outcome": "$4", "deploy_stage": "${5:-applied}",
  "region": "eu-x", "cluster": "c", "git_sha": "deadbeef", "captured_at": "2026-08-04T00:00:00Z",
  "verdict": "$2: verdict for $3" }
EOF
}

# write_gate_off — byte-for-byte the contract of e2e-nightly.yml's `Record gate-off proof` step:
# the run-scoped `gate-<run_id>-<attempt>` directory and the four-field payload with NO
# deploy_stage. The fixture constructs the directory itself so a drift in that literal shows up
# here, in the tests, rather than as a silently-swallowed red on a real night.
write_gate_off() { # <proofs-root> <provider> <run_id> <attempt>
	local d="$1/$2/gate-$3-$4"
	mkdir -p "$d"
	cat >"$d/provision-summary.json" <<EOF
{ "provider": "$2", "run_tag": "nightly-$3-$4", "outcome": "skipped",
  "verdict": "$2: SKIPPED — gate off, no secret/var wired" }
EOF
}

# write_jobs <file> <spec...> — each spec is `<provider>` or `<provider>=<conclusion>`; a bare
# provider keeps the historical `failure`.
#
# The conclusion is a PARAMETER now because the derivation READS it (#2512): a leg whose bundle says
# PASS is red iff its job conclusion is `failure`. While nothing consumed it, every fixture here
# stamped `failure` on every job — including the all-green one — and that was invisible. It is not
# invisible any more, and a fixture whose job conclusion contradicts its own bundle is not a fixture
# of anything real.
write_jobs() { # <file> <provider[=conclusion]...>
	local f="$1" spec p concl names=""
	shift
	for spec in "$@"; do
		p="${spec%%=*}"
		concl="failure"
		[ "$spec" = "$p" ] || concl="${spec#*=}"
		names="${names}{\"name\":\"Provision + verify + teardown (real cloud) (${p})\",\"conclusion\":\"${concl}\"},"
	done
	printf '{"jobs":[%s{"name":"Nightly verdict rollup (5-cloud table + dedup issue)","conclusion":"success"}]}\n' "$names" >"$f"
}

# write_jobs_post_capture — a jobs payload for ONE leg, carrying the REAL step spine of a provision
# job: the harness, then `Capture proof`, then `Guaranteed teardown`, then whatever runs below the
# capture. Any step names passed after the job conclusion are appended with `conclusion: failure`.
#
# This reproduces run 32816061207 exactly (verified against the API): steps 31 `T2 — real runner
# provisions a real cloud cluster` success, 33 `Capture proof` success, 38 `Guaranteed teardown`
# success, 39 `CLI-only demo bar` FAILURE — job conclusion `failure`, bundle `outcome: success`.
# Runs 32878485034 / 32883521925 / 32886071207 produced the same shape on hetzner.
#
# The JOB CONCLUSION is a parameter so the two directions can be pinned by fixtures that differ in
# NOTHING ELSE: pass `failure` and the leg must be red, pass `success` and it must stay green. The
# teardown step is `success` on purpose — it keeps #2330's UNSWEPT axis quiet so these cases assert
# the #2512 behaviour and not a second signal riding along.
write_jobs_post_capture() { # <file> <provider> <job-conclusion> [failed-step-name...]
	local f="$1" p="$2" job_concl="$3" s extra=""
	shift 3
	for s in "$@"; do
		extra="${extra},{\"name\":\"${s}\",\"conclusion\":\"failure\"}"
	done
	printf '{"jobs":[{"name":"Provision + verify + teardown (real cloud) (%s)","conclusion":"%s","steps":[{"name":"T2 — real runner provisions a real cloud cluster","conclusion":"success"},{"name":"Capture proof (scrubbed bundle + step-summary verdict)","conclusion":"success"},{"name":"Guaranteed teardown (scope-locked cloud sweep)","conclusion":"success"}%s]},{"name":"Nightly verdict rollup (5-cloud table + dedup issue)","conclusion":"success"}]}\n' \
		"$p" "$job_concl" "$extra" >"$f"
}

# write_jobs_steps — a jobs payload carrying the teardown STEP, which is what #2330 reads. The
# third argument is the step's conclusion; pass `null` for the fingerprint of a worker killed
# mid-step (the runner never finishes uploading a conclusion), or omit the step entirely with
# `none` to prove teardown_outcome reports `unknown` rather than inventing `done`.
#
# The fourth argument is the JOB's conclusion (default `failure`), a parameter for the same reason
# write_jobs's is (#2512): T5 pairs a `success` bundle with this payload, and while the job
# conclusion was an unread constant that fixture could stamp `failure` on a green leg and nobody
# noticed. It is read now, so the fixture has to mean it.
write_jobs_steps() { # <file> <provider> <teardown-conclusion|null|none> [job-conclusion]
	local f="$1" p="$2" concl="$3" job_concl="${4:-failure}" steps=""
	case "$concl" in
	none) steps="" ;;
	null) steps='{"name":"Guaranteed teardown (scope-locked cloud sweep)","conclusion":null},' ;;
	*) steps="{\"name\":\"Guaranteed teardown (scope-locked cloud sweep)\",\"conclusion\":\"${concl}\"}," ;;
	esac
	printf '{"jobs":[{"name":"Provision + verify + teardown (real cloud) (%s)","conclusion":"%s","steps":[%s{"name":"Checkout","conclusion":"success"}]},{"name":"Nightly verdict rollup (5-cloud table + dedup issue)","conclusion":"success"}]}\n' \
		"$p" "$job_concl" "$steps" >"$f"
}

run_self_test() {
	local fails=0 tmp
	tmp="$(mktemp -d)"
	trap 'rm -rf "$tmp"' EXIT
	_a() { if [ "$1" = "$2" ]; then echo "ok   - $3"; else
		echo "FAIL - $3: want '$1' got '$2'" >&2
		fails=$((fails + 1))
	fi; }

	# Runs one derivation in an isolated dir and echoes "<reds>|<skips>|<enabled_n>".
	_derive() { # <case-dir>
		local d="$1" out="$1/out"
		rm -rf "$out"
		(
			PROOFS_DIR="$d/proofs" OUT_DIR="$out" JOBS_JSON="$d/jobs.json" \
				RUN_ID="${CASE_RUN_ID:-777}" MATRIX_RESULT="${CASE_MATRIX:-failure}" RUN_URL="http://x" \
				E2E_DIMENSION="${CASE_DIMENSION:-floor}" \
				derive >/dev/null 2>&1
		)
		# shellcheck disable=SC1091
		. "$out/state.env"
		# Generated by derive() immediately above and loaded from state.env.
		# shellcheck disable=SC2153
		printf '%s|%s|%s' "$REDS" "$SKIPS" "$ENABLED_N"
	}

	# 1. FLAT layout — the shape run 30341785056 actually produced: the bundle sits at the root of
	#    `proofs`, with no per-artifact directory. This is the case that fails on the old code.
	local c="$tmp/flat"
	write_summary "$c/proofs/2026-07-28T084732Z" aws "nightly-777-1" failure
	write_jobs "$c/jobs.json" aws
	_a "aws|hetzner gcp azure alibaba|1" "$(_derive "$c")" "flat layout: a red aws leg is FAIL, not SKIP (#1613)"
	# …and the detail must come from the BUNDLE, not from the ran-but-no-proof fallback. Without this
	# the job cross-check alone would satisfy the assertion above and discovery could rot unnoticed.
	_a "aws: verdict for nightly-777-1" \
		"$(sed -n 's/^| aws | FAIL | \(.*\) |$/\1/p' "$c/out/summary.md")" "flat layout: the verdict is READ FROM the bundle, not inferred"

	# 2. PER-ARTIFACT SUBDIRECTORY — the layout the old code assumed. Both must yield one answer,
	#    which is the point of not keying on the path at all.
	c="$tmp/nested"
	write_summary "$c/proofs/e2e-proof-aws-777/2026-07-28T084732Z" aws "nightly-777-1" failure
	write_jobs "$c/jobs.json" aws
	_a "aws|hetzner gcp azure alibaba|1" "$(_derive "$c")" "nested layout: same verdict as flat"

	# 3. STALE HISTORY — `demos/proofs/<provider>/` is checked in, so an artifact carries older
	#    bundles (the real aws artifact held one from six days earlier). A bundle from another run
	#    must be invisible, or we would publish a stale verdict as this run's proof.
	c="$tmp/stale"
	write_summary "$c/proofs/20260722T164107Z" aws "nightly-111-1" success
	write_jobs "$c/jobs.json" aws
	_a "aws|hetzner gcp azure alibaba|1" "$(_derive "$c")" "stale bundle from another run is ignored (its PASS must not leak in)"

	# 4. RAN, NO SUMMARY — a job conclusion exists, no readable bundle. FAIL, never SKIP.
	c="$tmp/noproof"
	mkdir -p "$c/proofs"
	write_jobs "$c/jobs.json" gcp
	_a "gcp|hetzner aws azure alibaba|1" "$(_derive "$c")" "ran but left no proof ⇒ FAIL, never 'not enabled'"

	# 5. EXPLICIT GATE-OFF — the matrix jobs exist, but every leg emitted the structured SKIP
	# summary written by the workflow. Job existence must not turn those inert legs red (#1683).
	c="$tmp/gateoff"
	for p in hetzner aws gcp azure alibaba; do
		write_gate_off "$c/proofs" "$p" 777 1
	done
	# A gate-off leg's job really does exit 0 — it records the skip proof and stops — so the fixture
	# says `success`. It would pass either way (a gate-off leg never reaches the conclusion read),
	# and that is precisely why it is worth writing down: the reason this case is green must be the
	# gate-off discriminator, not a job conclusion that happens not to be consulted.
	write_jobs "$c/jobs.json" hetzner=success aws=success gcp=success azure=success alibaba=success
	_a "|hetzner aws gcp azure alibaba|0" "$(CASE_MATRIX=success _derive "$c")" \
		"explicit gate-off summaries stay SKIP even though all matrix jobs exist (#1683)"
	_a "0" "$(wc -l <"$c/out/ledger.tsv" | tr -d ' ')" "gate-off legs do not enter the execution ledger"

	# 6. SINGLE-PROVIDER DISPATCH — the shape EVERY `workflow_dispatch` produces, and the reason the
	#    standing coverage issue is refreshed from `schedule` only (see e2e-nightly.yml's filer).
	#
	#    A dispatch derives its matrix from the `provider` input, which is a single choice with no
	#    "all" option. So four clouds have no matrix job, `job_exists` correctly says `no`, and with
	#    no bundle either they fall to the final `else` → SKIP. That is CORRECT of this function —
	#    it is reporting what this run observed — and it is exactly why the aggregate must not be
	#    published: SKIP_N is 4 on every dispatch no matter what the gates say.
	#
	#    Pinned here rather than left as prose because the count is derived, not written down: if a
	#    future change ever made an undispatched cloud read as something other than SKIP, the
	#    workflow-side guard would be defending against a shape that no longer occurs, and nobody
	#    would find out from reading either file alone.
	c="$tmp/dispatch"
	write_summary "$c/proofs/20260811T090000Z" aws "nightly-777-1" success
	write_jobs "$c/jobs.json" aws=success
	_a "|hetzner gcp azure alibaba|1" "$(CASE_MATRIX=success _derive "$c")" \
		"a single-provider dispatch counts the four UNDISPATCHED clouds as SKIP — so the 5-cloud coverage aggregate is unknowable from it"
	_a "1" "$(wc -l <"$c/out/ledger.tsv" | tr -d ' ')" "a dispatch ledgers ONLY the cloud it ran (the other four leave no row to mislead)"

	# ── #1922 — `outcome: skipped` is TWO states and only one of them is inert. ────────────────────
	# All five states a leg can be in, each as its own fixture. Before the provenance check every
	# `skipped` bundle became a SKIP row, so state (2) filed NO red: on run 30882660761 alibaba's
	# gate was ON — E2E_ALIBABA_ROLE_ARN *and* E2E_ALIBABA_OIDC_PROVIDER_ARN have been set since
	# 2026-08-03 — and `Configure Alibaba credentials (RAM OIDC)` died with `400 MissingTimestamp`.
	# Only (2) changes behaviour; (1)(3)(4)(5) are pins that must hold in BOTH directions, because a
	# fix that reds a genuinely inert leg files a false red every single night.
	_state() { sed -n "s/^$2='\(.*\)'\$/\1/p" "$1/state.env"; } # read state.env without clobbering $REDS

	# (1) GATE OFF ⇒ SKIP. Byte-for-byte the bundle `Record gate-off proof` writes.
	c="$tmp/s1-gate-off"
	write_gate_off "$c/proofs" alibaba 777 1
	write_jobs "$c/jobs.json" alibaba
	_a "|hetzner aws gcp azure alibaba|0" "$(CASE_MATRIX=success _derive "$c")" \
		"(1) gate off ⇒ SKIP — the fix must NOT red an inert leg"

	# (2) DIED BEFORE THE HARNESS ⇒ FAIL. The alibaba shape exactly: the capture path's bundle
	#     (timestamp dir, `deploy_stage` present) carrying the failed setup step's `skipped`.
	c="$tmp/s2-died-early"
	write_summary "$c/proofs/e2e-proof-alibaba-777/2026-08-03T031545Z" alibaba "nightly-777-1" skipped queued
	write_jobs "$c/jobs.json" alibaba
	_a "alibaba|hetzner aws gcp azure|1" "$(CASE_MATRIX=success _derive "$c")" \
		"(2) gate ON, died before the harness ⇒ FAIL, not a gate-off SKIP (#1922)"
	_a "e2e nightly: alibaba RED (floor)" "$(cat "$tmp/s2-died-early/out/issue-red-alibaba.title")" \
		"(2) a red issue is filed for it at all — on 30882660761 none was, it was found by hand"
	_a "1" "$(grep -c 'died before the harness started' "$tmp/s2-died-early/out/issue-red-alibaba.md")" \
		"(2) the red body names the failure mode instead of pointing at the deploy spine"
	_a "1" "$(wc -l <"$tmp/s2-died-early/out/ledger.tsv" | tr -d ' ')" \
		"(2) the died-early leg enters the execution ledger like any other red"
	_a "alibaba" "$(_state "$tmp/s2-died-early/out" DIED_EARLY)" \
		"(2) state.env names the died-early legs for the downstream steps"
	# The coverage issue is the second casualty: #1720 was auto-refreshed with a body claiming
	# E2E_ALIBABA_ROLE_ARN is unset, and the run's own coverage line said 3/5 where the truth was 4/5.
	_a "e2e nightly: 4 of 5 clouds are not enabled" "$(_state "$tmp/s2-died-early/out" COV_TITLE)" \
		"(2) the coverage issue no longer counts a WIRED cloud as unwired (#1720's false body)"

	# (3) SUCCESS ⇒ PASS.
	c="$tmp/s3-success"
	write_summary "$c/proofs/e2e-proof-aws-777/2026-08-03T031545Z" aws "nightly-777-1" success argocd-ready
	write_jobs "$c/jobs.json" aws=success
	_a "|hetzner gcp azure alibaba|1" "$(CASE_MATRIX=success _derive "$c")" "(3) success ⇒ PASS"

	# (4) EXPLICIT FAILURE ⇒ FAIL.
	c="$tmp/s4-failure"
	write_summary "$c/proofs/e2e-proof-aws-777/2026-08-03T031545Z" aws "nightly-777-1" failure applying
	write_jobs "$c/jobs.json" aws
	_a "aws|hetzner gcp azure alibaba|1" "$(CASE_MATRIX=success _derive "$c")" "(4) explicit failure ⇒ FAIL"

	# (5) JOB EXISTS, NO READABLE SUMMARY ⇒ FAIL. Already true today; pinned so it stays.
	c="$tmp/s5-no-summary"
	mkdir -p "$c/proofs"
	write_jobs "$c/jobs.json" aws
	_a "aws|hetzner gcp azure alibaba|1" "$(CASE_MATRIX=success _derive "$c")" \
		"(5) job exists but no readable summary ⇒ FAIL"

	# ── The discriminator MIRRORS EVERY CONDITION of the gate-off emitter (#1831), and anything it
	#    cannot prove inert is FAIL. Each fixture below breaks exactly ONE of those conditions. ──
	# 5d-i. The directory names a DIFFERENT run. The bundle claims this run in its run_tag, so
	#       run-scoping alone would accept it; only the dir literal catches the mismatch.
	c="$tmp/gate-dir-wrong-run"
	mkdir -p "$c/proofs/alibaba/gate-999-1"
	cat >"$c/proofs/alibaba/gate-999-1/provision-summary.json" <<-'EOF'
		{ "provider": "alibaba", "run_tag": "nightly-777-1", "outcome": "skipped",
		  "verdict": "alibaba: SKIPPED — gate off, no secret/var wired" }
	EOF
	write_jobs "$c/jobs.json" alibaba
	_a "alibaba|hetzner aws gcp azure|1" "$(CASE_MATRIX=success _derive "$c")" \
		"a gate-shaped dir naming ANOTHER run is not provably inert ⇒ FAIL"

	# 5d-ii. Right directory, but the payload is a real capture (`deploy_stage` present). The
	#        gate-off step never writes that field, so this cannot be its output.
	c="$tmp/gate-dir-real-payload"
	write_summary "$c/proofs/alibaba/gate-777-1" alibaba "nightly-777-1" skipped queued
	write_jobs "$c/jobs.json" alibaba
	_a "alibaba|hetzner aws gcp azure|1" "$(CASE_MATRIX=success _derive "$c")" \
		"a capture-path payload in a gate-* dir is not provably inert ⇒ FAIL"

	# 5d-iii. The ATTEMPT is read from the bundle's own run_tag, not assumed to be 1 — a re-run
	#         writes gate-<run>-2 and must still be inert.
	c="$tmp/gate-attempt-2"
	write_gate_off "$c/proofs" alibaba 777 2
	write_jobs "$c/jobs.json" alibaba
	_a "|hetzner aws gcp azure alibaba|0" "$(CASE_MATRIX=success _derive "$c")" \
		"a gate-off proof from run attempt 2 is still SKIP"

	# 6. ALL LEGS OFF — nothing ran, nothing found, no red. The genuinely-inert night.
	c="$tmp/alloff"
	mkdir -p "$c/proofs"
	printf '{"jobs":[{"name":"Nightly verdict rollup (5-cloud table + dedup issue)","conclusion":"success"}]}\n' >"$c/jobs.json"
	_a "|hetzner aws gcp azure alibaba|0" "$(CASE_MATRIX=success _derive "$c")" "no legs enabled ⇒ 0/5, no red"

	# 7. MATRIX FALLBACK — red aggregate, nothing attributable. Labelled `(matrix)`, never `job`.
	c="$tmp/matrix"
	mkdir -p "$c/proofs"
	printf '{"jobs":[{"name":"Nightly verdict rollup (5-cloud table + dedup issue)","conclusion":"success"}]}\n' >"$c/jobs.json"
	_a "matrix|hetzner aws gcp azure alibaba|0" "$(_derive "$c")" "matrix-wide red is labelled 'matrix', not the cloud-lookalike 'job'"
	_a "e2e nightly: matrix RED (floor · no per-leg proof)" \
		"$(cat "$c/out/issue-red-matrix.title")" "matrix red title cannot be mistaken for a cloud"

	# 7b. THE SAME MATRIX RED ON THE OTHER DIMENSION IS A DIFFERENT ISSUE. Both fixtures below are
	# byte-identical apart from the dimension, so a title collision here is a real collision.
	c="$tmp/matrix-full"
	mkdir -p "$c/proofs"
	printf '{"jobs":[{"name":"Nightly verdict rollup (5-cloud table + dedup issue)","conclusion":"success"}]}\n' >"$c/jobs.json"
	CASE_DIMENSION=full _derive "$c" >/dev/null
	_a "e2e nightly: matrix RED (full-bar · no per-leg proof)" \
		"$(cat "$c/out/issue-red-matrix.title")" "a full-bar matrix red does not collide with the floor's"

	# 8. NON-VACUITY — an all-green fixture must produce NO reds. Without this the guard could pass
	#    by finding nothing at all, which is exactly the failure it exists to catch.
	c="$tmp/green"
	local p
	for p in hetzner aws gcp azure alibaba; do write_summary "$c/proofs/$p/stamp" "$p" "nightly-777-1" success; done
	write_jobs "$c/jobs.json" hetzner=success aws=success gcp=success azure=success alibaba=success
	_a "||5" "$(CASE_MATRIX=success _derive "$c")" "all-green: 5/5 enabled and no red filed"

	# 9. A MIXED night, which is what a real 5-cloud run looks like once more legs are wired.
	c="$tmp/mixed"
	write_gate_off "$c/proofs" hetzner 777 1
	write_summary "$c/proofs/e2e-proof-aws-777/s" aws "nightly-777-1" failure
	write_summary "$c/proofs/e2e-proof-gcp-777/s" gcp "nightly-777-1" success
	write_gate_off "$c/proofs" alibaba 777 1
	write_jobs "$c/jobs.json" hetzner=success aws=failure gcp=success azure=failure alibaba=success
	_a "aws azure|hetzner alibaba|3" "$(_derive "$c")" "mixed: aws FAIL + gcp PASS + azure ran-without-proof"

	# 10. The existence cross-check DEGRADING must be loud. A renamed matrix job would otherwise put
	#    us straight back into "absence means never enabled" with nothing on screen to say so.
	c="$tmp/renamed"
	mkdir -p "$c/proofs" "$c/out"
	printf '{"jobs":[{"name":"Totally Renamed Job (aws)","conclusion":"failure"}]}\n' >"$c/jobs.json"
	local warn
	warn="$(PROOFS_DIR="$c/proofs" OUT_DIR="$c/out" JOBS_JSON="$c/jobs.json" RUN_ID=777 \
		MATRIX_RESULT=success RUN_URL=http://x derive 2>&1 | grep -c 'existence cross-check is DEAD' || true)"
	_a "1" "$warn" "a renamed provision job warns loudly instead of silently degrading"

	# 11. `gh api --paginate --slurp` returns an ARRAY of page objects. The three readers must see
	#     the same complete list, not just the first page or an unreadable multi-document stream.
	c="$tmp/paginated"
	write_summary "$c/proofs/e2e-proof-aws-777/2026-08-25T060000Z" aws "nightly-777-1" success applied
	printf '%s\n' '[{"jobs":[{"name":"Provision + verify + teardown (real cloud) (aws)","conclusion":"success","steps":[{"name":"Guaranteed teardown (scope-locked cloud sweep)","conclusion":"success"}]}]},{"jobs":[{"name":"Nightly verdict rollup (5-cloud table + dedup issue)","conclusion":"success"}]}]' >"$c/jobs.json"
	_a "|hetzner gcp azure alibaba|1" "$(CASE_MATRIX=success _derive "$c")" \
		"a slurped two-page jobs payload is normalized for every reader"
	_a "success" "$(JOBS_JSON="$c/jobs.json" job_conclusion aws)" \
		"the normalized payload still drives the job-conclusion reader"
	_a "done" "$(JOBS_JSON="$c/jobs.json" teardown_outcome aws)" \
		"the normalized payload still drives the teardown reader"

	# 12. LEDGER rows come from the same discovery, so the parity ledger cannot lose a run the table
	#     reported. Run 30341785056 appended nothing while showing a real aws failure.
	_a "aws	FAIL	aws: verdict for nightly-777-1	e2e-proof-aws-777" \
		"$(head -1 "$tmp/flat/out/ledger.tsv")" "ledger row is emitted for the leg the table reports"

	# 13. #1755 — THE DEDUP KEY MUST SEPARATE THE TWO DIMENSIONS. The same cloud red on the floor and
	#     on the full bar has to produce two DIFFERENT titles, because the filer dedups on an exact
	#     title match. Both fixtures are identical apart from the dimension: on 2026-08-02 the floor
	#     (ArgoCD install) and the full bar (five apply-stage defects) collapsed into one issue and
	#     the full bar's had to be filed by hand.
	c="$tmp/dim-floor"
	write_summary "$c/proofs/e2e-proof-aws-777/s" aws "nightly-777-1" failure
	write_jobs "$c/jobs.json" aws
	CASE_DIMENSION=floor _derive "$c" >/dev/null
	local t_floor t_full
	t_floor="$(cat "$c/out/issue-red-aws.title")"

	c="$tmp/dim-full"
	write_summary "$c/proofs/e2e-proof-aws-777/s" aws "nightly-777-1" failure
	write_jobs "$c/jobs.json" aws
	CASE_DIMENSION=full _derive "$c" >/dev/null
	t_full="$(cat "$c/out/issue-red-aws.title")"

	_a "e2e nightly: aws RED (floor)" "$t_floor" "a floor red is titled (floor)"
	_a "e2e nightly: aws RED (full-bar)" "$t_full" "a full-bar red is titled (full-bar)"
	_a "differ" "$([ "$t_floor" != "$t_full" ] && echo differ || echo COLLIDE)" \
		"the two dimensions cannot dedup onto one issue"

	# …and the same separation for `cli-demo`, which is where #1755's fix silently stopped holding.
	# `cli-demo` reached DIMENSIONS, FULL_EXCLUDES and its own fidelity arm but never dimension_label's
	# enumerated case, so it fell through to `floor` — and since the title IS the dedup key, a cli-demo
	# red and a genuine floor red on one cloud landed on ONE issue. #4086 was filed as
	# "hetzner RED (floor)" for a cli-demo console build failure that never touched a cloud, sending
	# every reader to the provisioning spine. A fixture per dimension is what makes that visible.
	local t_cli
	c="$tmp/dim-cli-demo"
	write_summary "$c/proofs/e2e-proof-aws-777/s" aws "nightly-777-1" failure
	write_jobs "$c/jobs.json" aws
	CASE_DIMENSION=cli-demo _derive "$c" >/dev/null
	t_cli="$(cat "$c/out/issue-red-aws.title")"
	_a "e2e nightly: aws RED (cli-demo)" "$t_cli" "a cli-demo red is titled (cli-demo), not (floor) (#4086)"
	_a "differ" "$([ "$t_cli" != "$t_floor" ] && echo differ || echo COLLIDE)" \
		"a cli-demo red cannot dedup onto the floor's issue"

	# …and a dimension nobody has heard of must STOP the filer, not render `RED ()`. That title is a
	# dedup key too, so every unknown dimension would collide onto one issue — the same failure in a
	# different costume. This script is `set -uo pipefail` without `-e`, so the refusal only
	# propagates because the caller asks for it.
	c="$tmp/dim-unknown"
	write_summary "$c/proofs/e2e-proof-aws-777/s" aws "nightly-777-1" failure
	write_jobs "$c/jobs.json" aws
	# `derive` is driven DIRECTLY here, not through `_derive`: that harness discards the exit code
	# (it runs derive in a subshell and then unconditionally sources state.env), so asserting through
	# it would measure the harness and pass for the wrong reason.
	_a "no" "$( (PROOFS_DIR="$c/proofs" OUT_DIR="$c/out" JOBS_JSON="$c/jobs.json" RUN_ID=777 \
		MATRIX_RESULT=failure RUN_URL="http://x" E2E_DIMENSION=no-such-dimension \
		derive >/dev/null 2>&1) && echo yes || echo no)" \
		"an unknown dimension stops the filer instead of titling a red '()'"
	_a "absent" "$([ -f "$c/out/issue-red-aws.title" ] && echo PRESENT || echo absent)" \
		"...and no red title is written at all"

	# Back to the full-bar case — the state.env assertions below read `$c`.
	c="$tmp/dim-full"

	# The dimension reaches state.env so the ledger step reuses it instead of re-deriving (#1755).
	# shellcheck disable=SC1091
	. "$c/out/state.env"
	# shellcheck disable=SC2153
	_a "full" "${DIMENSION}" "state.env carries the dimension for the ledger step"

	# The COVERAGE title stays dimension-free — it reports unwired gate vars, which are identical on
	# both crons. A suffix here would orphan the open coverage issue and file a duplicate every Sunday.
	# shellcheck disable=SC2153
	_a "e2e nightly: 4 of 5 clouds are not enabled" "${COV_TITLE}" \
		"the coverage issue title is NOT dimension-suffixed"

	# The coverage dedup KEY (#1958). e2e-nightly.yml reads this and nothing else to find the standing
	# issue, so it must be emitted, and it must be an identity: constant across dimensions AND across
	# coverage counts. The title is neither — it moved from "4 of 5" to "1 of 5" as clouds came online,
	# and a hand-edit of `are`→`is` on #1720 defeated the anchored regex that used to match it.
	# shellcheck disable=SC2153
	_a "from:e2e-coverage" "${COV_LABEL}" \
		"the coverage dedup label is emitted for e2e-nightly.yml"
	_a "from:e2e-coverage" "$(_state "$tmp/s2-died-early/out" COV_LABEL)" \
		"the dedup label is CONSTANT — same value on a run whose coverage count differs"

	# ── Teardown outcome (#2330) ────────────────────────────────────────────────────────────────
	# Run 31459117502 was correctly reported RED and simultaneously left ~$105/mo of EKS + NAT
	# standing. The board said the first thing and had no way to say the second, so nobody knew to
	# sweep. These cases pin the distinction in both directions — a signal that only ever fires is
	# as useless as one that never does.

	# (T1) The leak fingerprint: the worker is killed mid-step, so the teardown step record carries
	#      NO conclusion at all. That empty conclusion is the whole tell.
	c="$tmp/t1-teardown-killed"
	write_summary "$c/proofs/e2e-proof-aws-777/2026-08-11T060000Z" aws "nightly-777-1" failure applied
	write_jobs_steps "$c/jobs.json" aws null
	_a "aws|hetzner gcp azure alibaba|1" "$(CASE_MATRIX=failure _derive "$c")" \
		"(T1) a killed teardown does not change the PASS/FAIL verdict — it is a separate axis"
	_a "aws" "$(_state "$c/out" UNSWEPT)" \
		"(T1) an EMPTY teardown conclusion is reported as UNSWEPT — the run 31459117502 fingerprint"
	# Both placements are deliberate and both are asserted: the table cell so the leg's own row
	# carries it, and the standalone block so it survives someone scanning only the prose.
	_a "1" "$(grep -c '^| aws |.*TEARDOWN DID NOT COMPLETE' "$c/out/summary.md")" \
		"(T1) the leg's OWN table row says its teardown did not complete"
	_a "1" "$(grep -c 'reclaims these out-of-band' "$c/out/summary.md")" \
		"(T1) and a standalone block tells the reader what to do about it"

	# (T2) A teardown that RAN is silent. Without this the warning fires every night and stops
	#      being read — the same way the capped-orphan ::error:: did.
	c="$tmp/t2-teardown-ran"
	write_summary "$c/proofs/e2e-proof-aws-777/2026-08-11T060000Z" aws "nightly-777-1" failure applied
	write_jobs_steps "$c/jobs.json" aws success
	_a "" "$(CASE_MATRIX=failure _derive "$c" >/dev/null; _state "$c/out" UNSWEPT)" \
		"(T2) a teardown that reached a conclusion is NOT reported as unswept"
	_a "0" "$(grep -c 'TEARDOWN DID NOT COMPLETE' "$c/out/summary.md")" \
		"(T2) and the summary stays quiet — a warning that always fires is not a warning"

	# (T3) An explicitly `cancelled` teardown is the same leak wearing a different label.
	c="$tmp/t3-teardown-cancelled"
	write_summary "$c/proofs/e2e-proof-aws-777/2026-08-11T060000Z" aws "nightly-777-1" failure applied
	write_jobs_steps "$c/jobs.json" aws cancelled
	_a "aws" "$(CASE_MATRIX=failure _derive "$c" >/dev/null; _state "$c/out" UNSWEPT)" \
		"(T3) an explicitly cancelled teardown is UNSWEPT too, not just an empty one"

	# (T4) The step is missing entirely — a rename, or a payload without steps. `unknown` must NOT
	#      become `done`: absence of evidence is not a swept account. It reports nothing rather
	#      than claiming the account is clean.
	c="$tmp/t4-teardown-step-missing"
	write_summary "$c/proofs/e2e-proof-aws-777/2026-08-11T060000Z" aws "nightly-777-1" failure applied
	write_jobs_steps "$c/jobs.json" aws none
	_a "" "$(CASE_MATRIX=failure _derive "$c" >/dev/null; _state "$c/out" UNSWEPT)" \
		"(T4) a missing teardown step is unknown, never a false UNSWEPT alarm"

	# (T5) A GREEN leg can be unswept. This is the case the PASS/FAIL table structurally cannot
	#      express, and the reason the signal is a separate axis rather than a detail on a red.
	c="$tmp/t5-green-but-unswept"
	write_summary "$c/proofs/e2e-proof-aws-777/2026-08-11T060000Z" aws "nightly-777-1" success applied
	write_jobs_steps "$c/jobs.json" aws null success
	_a "|hetzner gcp azure alibaba|1" "$(CASE_MATRIX=success _derive "$c")" \
		"(T5) the leg still PASSES — teardown outcome does not rewrite the verdict"
	_a "aws" "$(_state "$c/out" UNSWEPT)" \
		"(T5) a PASSING leg whose teardown was killed is still reported as possibly billing"

	# ── A PASS bundle is not a PASS leg (#2512 · #2631 · #2640 · #2657) ─────────────────────────────
	# `Capture proof` is step 33 of the provision job; `Guaranteed teardown` is 38 and the `CLI-only
	# demo bar` is 39. So a leg can write `outcome: success`, have that bundle read and ledgered, and
	# STILL end on a red job. Four nights ran exactly that shape — 32816061207 (azure, floor),
	# 32878485034 / 32883521925 / 32886071207 (hetzner; byo, addons, day2) — each with the demo bar as
	# the ONLY failed step, and each producing a `matrix RED (<dim> · no per-leg proof)` issue in the
	# same rollup job whose log says `recorded: PASS → e2e-proof-<cloud>-<run>`.
	#
	# The cases below pin BOTH directions, because a fix that reds every green leg is worse than the
	# bug: P1 and P2b are the same fixture with ONE byte of difference, the job conclusion.
	local step_bar="CLI-only demo bar (reachability — no cloud, no spend)"

	# (P1) PASS bundle + `failure` job ⇒ RED, attributed to its cloud, with the step named.
	c="$tmp/p1-post-capture-red"
	write_summary "$c/proofs/e2e-proof-aws-777/2026-08-25T060000Z" aws "nightly-777-1" success applied
	write_jobs_post_capture "$c/jobs.json" aws failure "$step_bar"
	_a "aws|hetzner gcp azure alibaba|1" "$(CASE_MATRIX=failure _derive "$c")" \
		"(P1) a PASS bundle whose JOB conclusion is 'failure' is RED — the state that had no name (#2512)"
	_a "aws" "$(_state "$c/out" POST_CAPTURE)" \
		"(P1) state.env names it as a red BELOW the proof window, not as a provisioning failure"
	# The whole point of attributing it: the matrix fallback must NOT fire, because the red now has
	# a cloud's name on it. On all four real nights it did fire, and said the opposite of the truth.
	_a "absent" "$([ -e "$c/out/issue-red-matrix.title" ] && echo present || echo absent)" \
		"(P1) no 'matrix RED (… · no per-leg proof)' is filed once the red is attributed to its cloud"
	_a "e2e nightly: aws RED (floor · after proof capture)" "$(cat "$c/out/issue-red-aws.title")" \
		"(P1) its own title, so it cannot dedup onto the provisioning red or onto the matrix fallback"
	_a "1" "$(grep -cF "$step_bar" "$c/out/issue-red-aws.md")" \
		"(P1) the FAILING STEP NAME is in the body — that step is the entire diagnosis"
	_a "1" "$(grep -c 'Do not start at the deploy spine' "$c/out/issue-red-aws.md")" \
		"(P1) and the body says where NOT to start, because provisioning is provably fine"
	_a "$step_bar" "$(cat "$c/out/failed-steps-aws.txt")" \
		"(P1) failed-steps-aws.txt carries the step for the downstream notification step"
	# The ledger measures provisioning parity and provisioning PASSED. Downgrading this row because a
	# step below the capture failed would erase a real, captured proof.
	_a "aws	PASS	aws: verdict for nightly-777-1	e2e-proof-aws-777" \
		"$(cat "$c/out/ledger.tsv")" \
		"(P1) the parity ledger keeps its PASS row — and exactly one row, not a PASS plus a FAIL"
	_a "1" "$(grep -c '^| aws | FAIL | provisioned OK (bundle PASS) but the JOB went red AFTER the capture' "$c/out/summary.md")" \
		"(P1) the leg's own table row is FAIL and says why the two verdicts disagree"
	_a "1" "$(grep -c 'Red BELOW the proof window' "$c/out/summary.md")" \
		"(P1) and a standalone block survives someone scanning only the prose"

	# (P2) PASS bundle + `success` job ⇒ PASS. Same payload shape, same steps, green conclusion.
	c="$tmp/p2-green-job"
	write_summary "$c/proofs/e2e-proof-aws-777/2026-08-25T060000Z" aws "nightly-777-1" success applied
	write_jobs_post_capture "$c/jobs.json" aws success
	_a "|hetzner gcp azure alibaba|1" "$(CASE_MATRIX=success _derive "$c")" \
		"(P2) a PASS bundle whose job also PASSED stays green — the fix must not red every leg"
	_a "" "$(_state "$c/out" POST_CAPTURE)" "(P2) and is not listed as a red below the proof window"
	_a "absent" "$([ -e "$c/out/issue-red-aws.title" ] && echo present || echo absent)" \
		"(P2) no red issue is filed for a green leg"

	# (P2b) The SAME fixture as P1 with only the job conclusion flipped, matrix result held at
	#       `failure`. This is the one-variable pin: nothing else about the leg changed, so any
	#       difference in the aws verdict is attributable to the conclusion and to nothing else.
	c="$tmp/p2b-one-variable"
	write_summary "$c/proofs/e2e-proof-aws-777/2026-08-25T060000Z" aws "nightly-777-1" success applied
	write_jobs_post_capture "$c/jobs.json" aws success "$step_bar"
	_a "matrix|hetzner gcp azure alibaba|1" "$(CASE_MATRIX=failure _derive "$c")" \
		"(P2b) flipping ONLY the job conclusion moves the red off aws — the leg is no longer red"
	_a "" "$(_state "$c/out" POST_CAPTURE)" "(P2b) POST_CAPTURE is driven by the conclusion, not by the presence of a failed step"
	_a "1" "$(grep -c '^| aws | PASS |' "$c/out/summary.md")" "(P2b) the aws row reads PASS"

	# ── `unknown` is a THIRD answer and must render as itself ──────────────────────────────────────
	# job_conclusion returns `unknown` when it could not ask: no payload, an unreadable one, no job
	# named `(<cloud>)`, or a job still running with a null conclusion. It must not collapse into
	# either verdict — and when it leaves the matrix red unattributable, the fallback must say THAT,
	# not reuse "no cloud produced a bundle". That sentence is #2512's lie; reusing it here would
	# reintroduce the bug under a new branch: a guard's "nothing found" has to differ from "nothing
	# wrong".
	local t_unattributed=""

	# (P3a) The payload is readable and has provision jobs — just not one for this cloud. hetzner is
	#       gate-off (so the payload is not "broken" and hetzner itself stays inert).
	c="$tmp/p3a-no-job-for-cloud"
	write_gate_off "$c/proofs" hetzner 777 1
	write_summary "$c/proofs/e2e-proof-aws-777/2026-08-25T060000Z" aws "nightly-777-1" success applied
	write_jobs "$c/jobs.json" hetzner=success
	_a "matrix|hetzner gcp azure alibaba|1" "$(CASE_MATRIX=failure _derive "$c")" \
		"(P3a) no job named '(aws)' ⇒ unknown ⇒ the leg is NOT invented red, and the matrix red is unattributed"
	t_unattributed="$(cat "$c/out/issue-red-matrix.title")"
	_a "e2e nightly: matrix RED (floor · every leg PASSED)" "$t_unattributed" \
		"(P3a) the degraded case gets its OWN title — it is a different claim from 'no per-leg proof'"
	_a "1" "$(grep -c 'that cross-check could not answer' "$c/out/issue-red-matrix.md")" \
		"(P3a) the body says the cross-check could not answer, not that no bundle exists"
	_a "0" "$(grep -c 'without producing a per-leg proof bundle' "$c/out/issue-red-matrix.md")" \
		"(P3a) and it does NOT repeat the assertion that four real issues got wrong"
	_a "1" "$(grep -c '^| (matrix) | FAIL | matrix red, but every leg that ran left a PASS bundle: aws' "$c/out/summary.md")" \
		"(P3a) the summary row names the legs that passed instead of claiming none did"

	# (P3b) The job EXISTS and is still running — Actions reports `conclusion: null`. Absence of a
	#       conclusion is not a conclusion of success.
	c="$tmp/p3b-null-conclusion"
	write_summary "$c/proofs/e2e-proof-aws-777/2026-08-25T060000Z" aws "nightly-777-1" success applied
	printf '{"jobs":[{"name":"Provision + verify + teardown (real cloud) (aws)","conclusion":null},{"name":"Nightly verdict rollup (5-cloud table + dedup issue)","conclusion":"success"}]}\n' >"$c/jobs.json"
	_a "matrix|hetzner gcp azure alibaba|1" "$(CASE_MATRIX=failure _derive "$c")" \
		"(P3b) a null conclusion is unknown, never a silent PASS and never an invented red"
	_a "$t_unattributed" "$(cat "$c/out/issue-red-matrix.title")" \
		"(P3b) it renders the same degraded case as P3a"
	# The body enumerates the causes, and P3a/P3b/P3c are three of the four. A reader who is told
	# "the cross-check could not answer" and NOT told what could cause that has to go and read the
	# script; the list is what makes the degraded issue actionable instead of merely honest.
	_a "1" "$(grep -c 'null conclusion (still running)' "$c/out/issue-red-matrix.md")" \
		"(P3b) the body names the null-conclusion cause this fixture actually exercises"

	# (P3c) NO jobs payload at all — the file was never fetched. job_conclusion's readability guard.
	c="$tmp/p3c-no-payload"
	write_summary "$c/proofs/e2e-proof-aws-777/2026-08-25T060000Z" aws "nightly-777-1" success applied
	mkdir -p "$c"
	_a "matrix|hetzner gcp azure alibaba|1" "$(CASE_MATRIX=failure _derive "$c")" \
		"(P3c) an absent jobs payload is unknown too — the guard reads the file, it does not assume one"
	_a "$t_unattributed" "$(cat "$c/out/issue-red-matrix.title")" "(P3c) same degraded rendering"

	# (P3d) THE TWO FALLBACK TITLES MUST DIFFER, and the surviving "no per-leg proof" body must now
	#       say what it is reserved for. The title IS the dedup key: if these two collided, the
	#       degraded case would re-open #2512's wrong body under #2512's own title.
	_a "differ" "$([ "$t_unattributed" != "$(cat "$tmp/matrix/out/issue-red-matrix.title")" ] && echo differ || echo COLLIDE)" \
		"(P3d) 'every leg PASSED' and 'no per-leg proof' cannot dedup onto one issue"
	_a "1" "$(grep -c 'This title is now reserved for legs that left NO bundle' "$tmp/matrix/out/issue-red-matrix.md")" \
		"(P3d) the genuine no-bundle body states what it is NOT, so the next reader is not sent hunting"

	# (P4) `cancelled` is not `failure`. A cancelled job is a human or a timeout; it does not
	#      aggregate to MATRIX_RESULT=failure, and filing a red for it every time somebody cancels a
	#      run trains the signal into noise.
	c="$tmp/p4-cancelled"
	write_summary "$c/proofs/e2e-proof-aws-777/2026-08-25T060000Z" aws "nightly-777-1" success applied
	write_jobs_post_capture "$c/jobs.json" aws cancelled
	_a "|hetzner gcp azure alibaba|1" "$(CASE_MATRIX=success _derive "$c")" \
		"(P4) a CANCELLED job on a passing bundle is not red — only 'failure' is"
	_a "" "$(_state "$c/out" POST_CAPTURE)" "(P4) and it is not a red below the proof window either"

	# (P5) The job is red and the payload names NO failed step — a `Set up job` or post-step failure,
	#      neither of which lands in `steps[]` with a `failure` conclusion. We CAN ask here (P3 covers
	#      "could not ask"), so this is a real answer and must be rendered as one. A blank where a
	#      cause belongs reads as "no cause" — which is the mistake this whole PR exists to undo.
	c="$tmp/p5-no-failed-step"
	write_summary "$c/proofs/e2e-proof-aws-777/2026-08-25T060000Z" aws "nightly-777-1" success applied
	write_jobs_post_capture "$c/jobs.json" aws failure
	_a "aws|hetzner gcp azure alibaba|1" "$(CASE_MATRIX=failure _derive "$c")" \
		"(P5) a red job with no failed step listed is still a red leg"
	# shellcheck disable=SC2016  # single-quoted ON PURPOSE: the backticks are literal characters in
	# the sentence the script writes, and the assertion is that it writes exactly that sentence.
	_a 'none — the job list marks no step `failure` (set-up or post step?)' \
		"$(cat "$c/out/failed-steps-aws.txt")" \
		"(P5) 'no step is marked failed' is stated in words, not left blank"
	# Paired ON PURPOSE, and the positive half comes first. A lone `grep -c … = 0` passes just as
	# happily when the line it is policing has been renamed out of existence — a "nothing found"
	# branch that cannot tell itself from "nothing wrong", which is the very defect this PR removes.
	# The positive assertion is what makes the negative one mean something.
	_a "1" "$(grep -c 'jobs API: \*\*none — the job list marks no step' "$c/out/issue-red-aws.md")" \
		"(P5) the body renders the sentence INSIDE the bold where the cause belongs"
	_a "0" "$(grep -c 'jobs API: \*\*\*\*' "$c/out/issue-red-aws.md")" \
		"(P5) …and never an EMPTY bold there"

	# (P6) Several steps below the capture failed. All of them are named, joined — reading one and
	#      guessing at the rest is how a two-cause red gets closed on one fix.
	c="$tmp/p6-two-failed-steps"
	write_summary "$c/proofs/e2e-proof-aws-777/2026-08-25T060000Z" aws "nightly-777-1" success applied
	write_jobs_post_capture "$c/jobs.json" aws failure "Scrub the runner log before upload" "$step_bar"
	_a "aws|hetzner gcp azure alibaba|1" "$(CASE_MATRIX=failure _derive "$c")" "(P6) two steps below the capture failed ⇒ still one red leg"
	_a "Scrub the runner log before upload, $step_bar" \
		"$(cat "$c/out/failed-steps-aws.txt")" "(P6) every failed step below the capture is named, not just the first"

	# (P7) A post-capture red and an ORDINARY provisioning red on the same night. POST_CAPTURE must be
	#      a strict subset of REDS, and the two must get different titles — collapsing them would
	#      dedup two unrelated causes onto one issue, which is #1755's mistake in a new place.
	c="$tmp/p7-mixed-reds"
	write_summary "$c/proofs/e2e-proof-aws-777/s" aws "nightly-777-1" success applied
	write_summary "$c/proofs/e2e-proof-gcp-777/s" gcp "nightly-777-1" failure applying
	printf '{"jobs":[{"name":"Provision + verify + teardown (real cloud) (aws)","conclusion":"failure","steps":[{"name":"%s","conclusion":"failure"}]},{"name":"Provision + verify + teardown (real cloud) (gcp)","conclusion":"failure"},{"name":"Nightly verdict rollup (5-cloud table + dedup issue)","conclusion":"success"}]}\n' \
		"$step_bar" >"$c/jobs.json"
	_a "aws gcp|hetzner azure alibaba|2" "$(CASE_MATRIX=failure _derive "$c")" \
		"(P7) both reds are reported — the post-capture one does not swallow or hide the other"
	_a "aws" "$(_state "$c/out" POST_CAPTURE)" \
		"(P7) POST_CAPTURE is a STRICT subset: only the leg whose bundle passed is in it"
	_a "e2e nightly: gcp RED (floor)" "$(cat "$c/out/issue-red-gcp.title")" \
		"(P7) the ordinary provisioning red keeps the plain title"
	_a "differ" \
		"$([ "$(cat "$c/out/issue-red-gcp.title")" != "$(cat "$c/out/issue-red-aws.title")" ] && echo differ || echo COLLIDE)" \
		"(P7) and the two causes cannot dedup onto one issue"
	# The ledger disagrees with the table for aws and agrees for gcp — deliberately, and this is the
	# only run shape where that happens. Pinned so a later 'simplification' cannot quietly align them.
	_a "aws	PASS
gcp	FAIL" "$(cut -f1,2 "$c/out/ledger.tsv")" \
		"(P7) the parity ledger keeps aws PASS while the table calls it FAIL — two different questions"

	if [ "$fails" -eq 0 ]; then
		echo "self-test: all passed"
		exit 0
	fi
	echo "self-test: $fails check(s) FAILED" >&2
	exit 1
}

case "${1:-}" in
--self-test) run_self_test ;;
"") derive ;;
*)
	echo "usage: nightly-rollup.sh [--self-test]" >&2
	exit 2
	;;
esac
