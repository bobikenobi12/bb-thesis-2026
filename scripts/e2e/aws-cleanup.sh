#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# aws-cleanup.sh — belt-and-suspenders teardown for the T2 real-cloud nightly (AWS/EKS).
#
# Cloned guard-for-guard from scripts/e2e/hcloud-cleanup.sh (BYOC A1.3). The T2 harness tears
# the cluster down GRACEFULLY in-process via `tofu destroy` (provisioner.RunDestroy) on the
# normal path. But if the test PROCESS is hard-killed (a `go test -timeout` panic, a CI step
# SIGKILL, a runner crash), t.Cleanup never runs and REAL, billable AWS resources leak — most
# dangerously the OUT-OF-BAND ones tofu never tracked: Karpenter-launched EC2/EBS, the AWS Load
# Balancer Controller's ELBs, and CSI pvc-* volumes. This script is the guarantee: the nightly
# runs it in an `always()` step so the run's resources are gone no matter how the test ended.
#
# ── WHAT IS COVERED, AND WHY THE LIST IS EXPLICIT ───────────────────────────────────────────────
# Compute/network was covered from the start; the STATEFUL half of a max-config project was not.
# Aurora (db.r6g.large), ElastiCache, DynamoDB, S3, ECR, Secrets Manager, SQS, SNS and four KMS keys
# were swept by nothing and — worse — verified by nothing, so a hard-killed run could leave an
# Aurora cluster running while this script printed "no billable resources remain" and exited 0. A
# sweeper that reports clean without looking is more expensive than no sweeper, because it stops
# anyone else looking. Everything now sweeps and verifies:
#
#   instances · ELBv2 + target groups · EKS · NAT + EIPs · EBS · RDS clusters + instances ·
#   ElastiCache replication groups · DynamoDB · S3 · ECR · Secrets Manager · SQS · SNS · KMS ·
#   network (ENI/SG/subnet/RT/IGW/VPC) · Route 53
#
# Adding a component to infra/templates/project/aws means adding it here too; that is not automated.
#
# ─────────────────────────────  S A F E T Y  ─────────────────────────────
# The AWS account (270587882865) is the SHARED platform account. An unfiltered delete would be
# catastrophic (cf. the shared-hcloud near-wipe; scope-destructive-cloud-ops memory). So:
#
#   * DISCOVERY is tag-driven. `resourcegroupstaggingapi get-resources` matches EXACTLY the ARNs
#     carrying our unique per-run handle `alethia:project-id=e2e-<ENV>` (Values= is an EXACT
#     match, no wildcards). Every tofu-tagged resource inherits it via provider default_tags /
#     eks_tags / EBS-CSI extraVolumeTags (B1.3). ENV = <run_id>-<attempt>, unique per run.
#   * OUT-OF-BAND resources that do NOT inherit default_tags (LB-controller ELBs tagged
#     `elbv2.k8s.aws/cluster=<eks_name>`; Karpenter EC2 tagged `kubernetes.io/cluster/<eks_name>`)
#     are swept by a SECONDARY filter bound to THIS run's cluster name — discovered from the
#     tagged EKS ARN, and (if the cluster is already gone) from any cluster tag whose value embeds
#     `-<ENV>-` (so a mid-destroy kill still finds + sweeps + VERIFIES the orphans). Still never
#     account-wide: the secondary equality match on `<eks_name>` (which itself embeds <ENV>)
#     excludes every other run's / prod's resources.
#   * Refuses to run without a specific, plausibly-unique ENV + an explicit region; rejects
#     shared/prod values; asserts a non-empty scope before every mutating call; and — the last
#     line of defence — a leak NEVER exits green: verify_swept re-lists BOTH scopes and
#     AUTHORITATIVELY confirms (direct describe) each billable survivor before failing the step,
#     so tag-API lag can't false-RED and a real leak can't false-GREEN.
#
# Usage:
#   ALETHIA_E2E_ENV=<run_id>-<attempt> ALETHIA_E2E_REGION=us-east-1 ./scripts/e2e/aws-cleanup.sh
#   (positional $1 accepted for call-site symmetry with hcloud-cleanup.sh but IGNORED.)
#   DRY_RUN=1 ...     # list what WOULD be deleted, delete + verify nothing
#
# Exit codes (the verification contract — see finalize_verification):
#   0  every probe answered, and nothing billable for this run survived
#   1  a LEAK: the API listed something still standing and billing
#   2  refused to run (missing/implausible scope, missing CLI)
#   3  INTERNAL: empty scope reached a scoped call
#   4  UNVERIFIABLE: a probe could not answer, so nothing here proves the account is empty
#   PREFLIGHT=1 ...   # BEFORE provisioning: sweep PRIOR-run e2e orphans (any other e2e-<env>),
#                     #   NOT this run. Best-effort + loud (warns on residual, never exit 1).
#
# ── PREFLIGHT (stale-cluster preflight, BYOC A1.4) ──────────────────────────────────────────
# A prior nightly that was hard-killed before BOTH its graceful destroy AND its always() sweep
# leaks billable resources that keep costing until the NEXT run notices. PREFLIGHT=1 runs before
# provisioning and sweeps those orphans. It discovers every OTHER e2e run's handle via
# `resourcegroupstaggingapi get-tag-values` (all values of the `alethia:project-id` key), keeps
# only `e2e-`-prefixed values, EXCLUDES this run, re-validates each against the same specificity +
# prod/shared denylist guards, and runs the identical scope-locked sweep+verify per orphan. It is
# safe to sweep another e2e-* handle because same-cloud nightly runs are SERIALIZED (the
# `e2e-nightly-aws` concurrency group) — so any other e2e-* value is a prior-run orphan, never a
# concurrent sibling. Posture is best-effort: a residual orphan emits `::warning::` but does NOT
# fail (a flaky tag/API call must not red an otherwise-healthy provisioning night; the per-run
# always() teardown stays the fail-closed guarantee for THIS run, and the next preflight retries).
#
# Requires: awscli v2 (digest-pinned in the workflow), configured creds (OIDC in CI), jq.
set -euo pipefail

# ── The probe contract (CLEAN / LEAKED / UNVERIFIABLE / UNATTRIBUTABLE), shared by all five cloud
#    sweepers. Read scripts/e2e/lib/sweep-probe.sh before touching any probe below: every
#    `aws … 2>/dev/null | … || true` in this file laundered the API's exit status THREE times over,
#    so a broken credential made all eighteen resource types report clean at once and this script
#    announced "no billable resources remain" over a live Aurora cluster.
#
#    A FOURTH state was added after #3138 gated the third one over a case that was not a probe
#    failure: UNATTRIBUTABLE — the probe DID get an answer, and the answer is that something
#    exists which by design cannot be tied to this run. Reported loudly, never gates. Only
#    hetzner produces one today (#2463); the taxonomy is shared so the next cloud does not have
#    to re-derive it, and every sweeper's --self-test asserts both halves. ──
E2E_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib"
# shellcheck source-path=SCRIPTDIR source=lib/sweep-probe.sh
. "${E2E_LIB_DIR}/sweep-probe.sh"
probe_reset

ENV="${ALETHIA_E2E_ENV:-}"
# Region is AUTHORITATIVE from ALETHIA_E2E_REGION only. A silent fallback to an ambient
# AWS_REGION that differs from where the run provisioned would make every (regional) tag query
# empty → delete nothing, verify nothing, exit green while the real region bills (grill F3).
REGION="${ALETHIA_E2E_REGION:-}"
DRY_RUN="${DRY_RUN:-0}"
PREFLIGHT="${PREFLIGHT:-0}"
DELETE_RETRIES="${DELETE_RETRIES:-5}"
DETACH_TIMEOUT="${DETACH_TIMEOUT:-180}"
# ── PREFLIGHT budget (#2257). The preflight's "never blocks the provisioning run" promise is
# carried by `exit 0` at the end of its loop — which is only reached if the loop ENDS. It had no
# bound of any kind, and each sweep_env can legitimately burn minutes (DETACH_TIMEOUT waits for
# NAT gateways and for data services, plus EKS deletion). On run 31356854945 two orphans that
# cannot be swept — 29558347776-1 and 30518134684-1 — consumed the whole 90-minute job cap and the
# job was CANCELLED at 06:22, so `exit 0` never ran and the aws leg provisioned nothing at all.
# A best-effort step that can consume the job is not best-effort. Two bounds, both reported:
PREFLIGHT_BUDGET_SECONDS="${PREFLIGHT_BUDGET_SECONDS:-900}" # wall-clock for the whole sweep loop
PREFLIGHT_MAX_ENVS="${PREFLIGHT_MAX_ENVS:-3}"               # orphans attempted per run

# ── `--self-test` exercises discover_cluster against a stubbed `aws` and exits. It sets its own
# ENV/REGION so the guards below are left exactly as they protect the real path. ──
SELF_TEST=0
if [ "${1:-}" = "--self-test" ]; then
	SELF_TEST=1
	ENV="selftest-4177-1"
	REGION="us-east-1"
	# The probe retries are a real-cloud kindness (a transient 5xx must not red a healthy teardown)
	# and pure dead time against a stub. The self-test still exercises the retry LOOP; it just does
	# not wait between attempts.
	PROBE_RETRY_DELAY=0
fi

# ── Guard 1: a specific ENV is REQUIRED. No ENV ⇒ no filter ⇒ hard refuse. ──
if [ -z "$ENV" ]; then
	echo "✗ REFUSING TO RUN: ALETHIA_E2E_ENV is unset." >&2
	echo "  This script only ever deletes resources tagged alethia:project-id=e2e-<ENV> — never" >&2
	echo "  account-wide. Set ALETHIA_E2E_ENV to the unique per-run value (<run_id>-<attempt>)." >&2
	exit 2
fi

# ── Guard 2: ENV must be specific enough to be a single run, not a broad/shared prefix. ──
if ! printf '%s' "$ENV" | grep -Eq '^[a-z0-9][a-z0-9._-]{4,62}$'; then
	echo "✗ REFUSING TO RUN: ENV '$ENV' is not a valid, specific handle ([a-z0-9][a-z0-9._-]{4,62})." >&2
	echo "  Refusing so a typo can't widen the tag filter." >&2
	exit 2
fi
case "$ENV" in
prod | prod-* | production | production-* | staging | staging-* | main | alethia | alethia-* | data)
	echo "✗ REFUSING TO RUN: ENV '$ENV' looks like shared/prod infra, not a nightly run." >&2
	exit 2
	;;
esac

# ── Guard 3: an explicit region is REQUIRED (no silent ambient fallback — grill F3). ──
if [ -z "$REGION" ]; then
	echo "✗ REFUSING TO RUN: ALETHIA_E2E_REGION is unset." >&2
	echo "  Tag discovery is regional; a wrong/empty region deletes+verifies nothing and false-greens." >&2
	exit 2
fi

for bin in aws jq; do
	if ! command -v "$bin" >/dev/null 2>&1; then
		echo "✗ the '$bin' CLI is not installed." >&2
		exit 2
	fi
done

PROJECT_ID_TAG="e2e-${ENV}"
CLUSTER="" # discovered below (eks-<regionShort>-<env>-<project>); may be found via ENV-embed fallback

export AWS_REGION="$REGION" AWS_DEFAULT_REGION="$REGION" AWS_PAGER=""

# The per-run banner is for the normal (belt-and-suspenders) path; PREFLIGHT prints its own below.
if [ "$PREFLIGHT" != "1" ] && [ "$SELF_TEST" != "1" ]; then
	echo "→ aws belt-and-suspenders cleanup in ${REGION}, scope alethia:project-id=${PROJECT_ID_TAG}"
	[ "$DRY_RUN" = "1" ] && echo "  (DRY_RUN=1 — listing only, deleting nothing)"
fi

# assert_scope — a STRING check on the tag handle, and nothing more. It makes no cloud call, so it
# cannot tell a working credential from a dead one; it exists only so an empty scope can never
# reach a mutating call. What catches a credential that cannot see the account is probe_run: every
# list and describe below records UNVERIFIABLE when the API does not answer, and the exit code
# gates on it (see finalize_verification).
assert_scope() {
	if [ -z "${PROJECT_ID_TAG#e2e-}" ]; then
		echo "✗ INTERNAL: empty scope — aborting before an unfiltered operation." >&2
		exit 3
	fi
}

# tagged_arns [service] — every ARN carrying our project-id handle (optionally one service). The
# tag filter is mandatory; never returns an unscoped list.
tagged_arns() {
	assert_scope
	local svc="${1:-}"
	local args=(resourcegroupstaggingapi get-resources
		--tag-filters "Key=alethia:project-id,Values=${PROJECT_ID_TAG}"
		--query 'ResourceTagMappingList[].ResourceARN' --output text)
	[ -n "$svc" ] && args+=(--resource-type-filters "$svc")
	# THE SINGLE MOST LOAD-BEARING PROBE IN THIS FILE. Twelve of the alive_* checks below start
	# here, so one failed tagging-API call used to empty all twelve at once — and `2>/dev/null |
	# tr | grep || true` reported that as exit 0 with no rows, which verify_swept reads as "gone".
	probe_run "tagging-api${svc:+(${svc})}" aws "${args[@]}" | tr '\t' '\n' | grep -v '^$' || true
}

arn_id() { printf '%s\n' "$1" | sed -E 's#^.*[:/]##'; }

# looks_gone <stderr-text> — true if an AWS delete error means the resource is already absent
# (idempotency: eventual consistency can list an already-deleted ARN; a NotFound on delete is
# success, not failure — grill F4). Covers ec2 InvalidX.NotFound, eks/elbv2 NotFound, EIP, etc.
# It is now ALSO what probe_confirm uses to tell "confirmed absent" (CLEAN) from "the API did not
# answer" (UNVERIFIABLE), so the strings matter more than they did: a shape missing from here turns
# a genuinely-deleted resource into a false UNVERIFIABLE, and — far worse in the other direction —
# a shape wrongly ADDED here turns a throttle into "gone". `Not Found` (spaced) and `(404)` are
# s3api head-bucket; `NonExistent` is sqs get-queue-url; `NoSuch*` is the S3 error family.
looks_gone() {
	printf '%s' "$1" | grep -Eqi 'NotFound|Not Found|\(404\)|NoSuch|NonExistent|does not exist|InvalidAllocationID|no such|could not be found|ResourceNotFoundException|LoadBalancerNotFound'
}

# retry_delete <human> <cmd...> — delete with backoff. "Already gone" = success. NEVER returns
# non-zero (so `set -e` can't abort the sweep BEFORE verify_swept, the real gate — grill F4);
# an unresolved failure logs a WARN and lets verify catch it authoritatively.
retry_delete() {
	local human="$1"
	shift
	if [ "$DRY_RUN" = "1" ]; then
		echo "      would delete ${human}"
		return 0
	fi
	local attempt=1 delay=3 err
	while [ "$attempt" -le "$DELETE_RETRIES" ]; do
		if err="$("$@" 2>&1)"; then
			echo "      deleted ${human}"
			return 0
		fi
		if looks_gone "$err"; then
			echo "      ${human} already gone"
			return 0
		fi
		echo "      retry ${attempt}/${DELETE_RETRIES}: ${human} not deletable yet (waiting ${delay}s)" >&2
		sleep "$delay"
		attempt=$((attempt + 1))
		delay=$((delay * 2))
	done
	echo "      WARN: could not delete ${human} after ${DELETE_RETRIES} attempts (verify_swept will gate)" >&2
	return 0
}

# ── Discover THIS run's EKS cluster name for the out-of-band secondary sweeps. First the tagged
#    EKS ARN; if the cluster is already gone (the likeliest hard-kill point — mid tofu-destroy),
#    fall back to any EC2/LB cluster tag whose value embeds `-<ENV>-` (the eks name is
#    eks-<short>-<ENV>-<project>). Never guessed, never broadened past this run's ENV. ──
discover_cluster() {
	local eks_arn cand lb_arn lb_val
	eks_arn="$(tagged_arns eks:cluster | head -n1)"
	if [ -n "$eks_arn" ]; then
		CLUSTER="$(arn_id "$eks_arn")"
	else
		# Fallback: scan instance `kubernetes.io/cluster/<name>` tag KEYS and LB
		# `elbv2.k8s.aws/cluster` tag VALUES for a name containing our unique ENV.
		# shellcheck disable=SC2016 # backticks are JMESPath, not command substitution
		cand="$(probe_run cluster-discovery aws ec2 describe-instances \
			--filters "Name=instance-state-name,Values=pending,running,stopping,stopped" \
			--query 'Reservations[].Instances[].Tags[?starts_with(Key, `kubernetes.io/cluster/`)].Key' \
			--output text | tr '\t' '\n' | sed -E 's#^kubernetes.io/cluster/##' \
			| grep -E -- "-${ENV}-" | sort -u | head -n1 || true)"
		[ -n "$cand" ] && CLUSTER="$cand"
	fi
	# Instances are the FIRST fallback, never the only one. A teardown that got far enough to delete
	# the nodegroup AND the cluster leaves no EKS ARN and not one tagged instance — which is exactly
	# the state a hard-killed run ends in. The k8s-created NLB outlives both, and it BILLS. Run
	# 31929564177 left one standing for eight days because discovery stopped at the line above: the
	# comment already promised this LB scan, only the code was missing. The leak was invisible rather
	# than merely unswept, because `alive_lbs` in verify_swept is CLUSTER-scoped too — so the sweep
	# exited green while the load balancer billed. Matching on `-<ENV>-` keeps it this run's, exactly
	# as the instance branch does.
	if [ -z "$CLUSTER" ]; then
		while IFS= read -r lb_arn; do
			[ -n "$lb_arn" ] || continue
			# probe_confirm_re, NOT probe_run: this is a PER-RESOURCE describe over a SHARED
			# account, prod included, and it does not break until it finds a match. A foreign
			# balancer deleted between the list below and this describe answers
			# LoadBalancerNotFound — under probe_run that burns every retry and records
			# UNVERIFIABLE, so finalize_verification returns 4 on an otherwise clean teardown.
			# Ordinary throttling on a fan-out across a shared account does the same. Narrowed to
			# the one shape this call can mean by "gone" rather than the whole looks_gone union,
			# because CLUSTER is the SCOPE here: a throttle silently read as "gone" leaves
			# CLUSTER="" and that is the silent green the ⚠️ note below is about.
			lb_val="$(probe_confirm_re cluster-discovery 'LoadBalancerNotFound' \
				aws elbv2 describe-tags --resource-arns "$lb_arn" \
				--query "TagDescriptions[].Tags[?Key=='elbv2.k8s.aws/cluster'].Value" \
				--output text | tr '\t' '\n' | grep -E -- "-${ENV}-" | head -n1 || true)"
			if [ -n "$lb_val" ]; then
				CLUSTER="$lb_val"
				break
			fi
		done <<<"$(probe_run cluster-discovery aws elbv2 describe-load-balancers \
			--query 'LoadBalancers[].LoadBalancerArn' --output text | tr '\t' '\n' | grep -v '^$' || true)"
	fi
	# ⚠️ EVERY read in this function goes through probe_run (or probe_confirm_re for a per-resource
	# existence check — never bare probe_confirm, whose looks_gone union is wider than any single
	# call here can answer with; see the note on the classic describe-tags below). It used to use
	# `aws … 2>/dev/null || true`, which resolves a denied or throttled call to CLUSTER="" — and
	# CLUSTER is the SCOPE: empty makes cluster_classic_lb_names
	# and cluster_lb_arns return nothing, which makes alive_lbs empty, which lets
	# finalize_verification exit 0 printing "no billable resources remain" over a live load
	# balancer. That is the same silent green the classic-ELB fix was written to remove, one API
	# call further up, and the ledger would record nothing because nothing asked.
	#
	# THIRD fallback: classic ELB `kubernetes.io/cluster/<name>` tag KEYS. A run hard-killed before
	# its cluster and instances went away leaves an ingress-nginx classic ELB and nothing else that
	# names the cluster — the elbv2 scan above cannot see it, because it is a different service.
	if [ -z "$CLUSTER" ]; then
		local c_name c_key
		while IFS= read -r c_name; do
			[ -n "$c_name" ] || continue
			# shellcheck disable=SC2016 # backticks are JMESPath, not command substitution
			# probe_confirm_re, NOT probe_confirm — the SAME argument as the elbv2 describe above
			# and cluster_classic_lb_names below, and this call is the one that motivated it. A
			# `describe-tags` reaching a proxy or a misrouted endpoint answers "An error occurred
			# (404) … Not Found", which matches THREE alternatives of looks_gone, so plain
			# probe_confirm resolves it CLEAN, c_key stays empty, CLUSTER stays "" — and CLUSTER is
			# the SCOPE. Empty scope makes cluster_classic_lb_names and cluster_lb_arns return
			# nothing, alive_lbs empty, and finalize_verification prints "no billable resources
			# remain" and exits 0 over a live classic ELB, with the ledger recording nothing
			# because nothing asked. LoadBalancerNotFound is the one shape this call can mean by
			# "gone"; everything else stays UNVERIFIABLE so the gate still fires.
			c_key="$(probe_confirm_re cluster-discovery 'LoadBalancerNotFound' \
				aws elb describe-tags --load-balancer-names "$c_name" \
				--query 'TagDescriptions[].Tags[?starts_with(Key, `kubernetes.io/cluster/`)].Key' \
				--output text | tr '\t' '\n' | sed -E 's#^kubernetes.io/cluster/##' \
				| grep -E -- "-${ENV}-" | head -n1 || true)"
			if [ -n "$c_key" ]; then
				CLUSTER="$c_key"
				break
			fi
		done <<<"$(probe_run cluster-discovery aws elb describe-load-balancers \
			--query 'LoadBalancerDescriptions[].LoadBalancerName' --output text | tr '\t' '\n' | grep -v '^$' || true)"
	fi
	if [ -n "$CLUSTER" ]; then
		echo "  · cluster (secondary scope): ${CLUSTER}"
	else
		echo "  · no cluster found for ENV ${ENV} (nothing out-of-band to sweep, or already gone)"
	fi
}

# cluster_instance_ids — running/stopped EC2 tagged for THIS cluster (Karpenter + nodegroup),
# incl. those lacking project-id default_tags. Empty when CLUSTER unknown.
cluster_instance_ids() {
	[ -z "$CLUSTER" ] && return 0
	probe_run ec2-instance aws ec2 describe-instances \
		--filters "Name=tag:kubernetes.io/cluster/${CLUSTER},Values=owned,shared" \
		"Name=instance-state-name,Values=pending,running,stopping,stopped" \
		--query 'Reservations[].Instances[].InstanceId' --output text | tr '\t' '\n' | grep -v '^$' || true
}

# cluster_lb_arns — ELBv2 ARNs tagged elbv2.k8s.aws/cluster=<CLUSTER>. Empty when CLUSTER unknown.
cluster_lb_arns() {
	[ -z "$CLUSTER" ] && return 0
	local arns arn tags
	arns="$(probe_run load-balancer aws elbv2 describe-load-balancers --query 'LoadBalancers[].LoadBalancerArn' --output text | tr '\t' '\n' | grep -v '^$' || true)"
	while IFS= read -r arn; do
		[ -n "$arn" ] || continue
		# Captured, THEN matched. `probe_run … | grep -q .` would be wrong twice over: grep -q exits
		# on the first line, which can SIGPIPE the capture, and under `set -o pipefail` that turns
		# the pipeline's status into 141 — so a load balancer that DOES carry the tag would read as
		# untagged. Capture first, filter second, exactly as the rest of this change does.
		if tags="$(probe_confirm_re load-balancer 'LoadBalancerNotFound' aws elbv2 describe-tags --resource-arns "$arn" \
			--query "TagDescriptions[].Tags[?Key=='elbv2.k8s.aws/cluster' && Value=='${CLUSTER}']" --output text)"; then
			if printf '%s' "$tags" | grep -q .; then
				printf '%s\n' "$arn"
			fi
		else
			printf '  ⚠ could not verify tags for load balancer %s\n' "$arn" >&2
		fi
	done <<<"$arns"
}

# vpc_security_group_ids — every NON-DEFAULT security group inside this run's tagged VPC(s).
#
# The tag filter cannot reach these: the AWS Load Balancer Controller and the CCM create groups
# (`k8s-ingressn-*`, `k8s-traffic-<cluster>-*`) from inside the cluster, and nothing stamps
# `alethia:project-id` on them. They are not billable themselves — they are worse. AWS refuses to
# delete a VPC while any non-default group remains, so the VPC survives every retry, verify_swept
# fails forever, and the nightly preflight spends its whole budget re-walking the same orphan. That
# is why 29558347776-1 and aws07232004 were never reached: the queue in front of them never drained.
#
# The scope is TIGHTER than a tag match, not looser: the VPC itself carries
# `alethia:project-id=e2e-<ENV>`, so anything inside it is this run's by construction. `default` is
# skipped for the usual reason — it cannot be deleted and is removed with the VPC.
vpc_security_group_ids() {
	assert_scope
	local vpc out
	out=""
	while IFS= read -r vpc; do
		[ -n "$vpc" ] || continue
		out="${out}$(aws ec2 describe-security-groups \
			--filters "Name=vpc-id,Values=${vpc}" \
			--query 'SecurityGroups[?GroupName!=`default`].GroupId' \
			--output text 2>/dev/null | tr '\t' '\n' | grep -v '^$' || true)"$'\n'
	done <<<"$(tagged_arns ec2:vpc | while read -r a; do arn_id "$a"; done)"
	printf '%s' "$out" | grep -v '^$' | sort -u || true
}

# cluster_volume_ids — EBS tagged kubernetes.io/cluster/<CLUSTER> (CSI fallback if extraVolumeTags
# didn't stamp project-id — grill F5). Empty when CLUSTER unknown.
cluster_volume_ids() {
	[ -z "$CLUSTER" ] && return 0
	aws ec2 describe-volumes \
		--filters "Name=tag:kubernetes.io/cluster/${CLUSTER},Values=owned,shared" "Name=status,Values=available,in-use" \
		--query 'Volumes[].VolumeId' --output text 2>/dev/null | tr '\t' '\n' | grep -v '^$' || true
}

# ── 1. EC2 instances (tagged + cluster-tagged Karpenter/nodegroup). Terminate first: they hold
#       ENIs + reference SGs, blocking VPC teardown. ──
sweep_instances() {
	assert_scope
	local ids
	ids="$(
		{
			tagged_arns ec2:instance | while read -r a; do arn_id "$a"; done
			cluster_instance_ids
		} | grep -v '^$' | sort -u || true
	)"
	[ -z "$ids" ] && {
		echo "  · EC2 instances: none"
		return 0
	}
	echo "  · EC2 instances: $(printf '%s' "$ids" | grep -c .) to terminate"
	if [ "$DRY_RUN" != "1" ]; then
		# shellcheck disable=SC2086
		aws ec2 modify-instance-attribute --no-disable-api-termination --instance-ids $ids >/dev/null 2>&1 || true
		# shellcheck disable=SC2086
		aws ec2 terminate-instances --instance-ids $ids >/dev/null 2>&1 || true
		# shellcheck disable=SC2086
		aws ec2 wait instance-terminated --instance-ids $ids 2>/dev/null || true
	else
		# shellcheck disable=SC2086
		printf '      would terminate %s\n' $ids
	fi
}

# cluster_classic_lb_names — CLASSIC ELB names tagged kubernetes.io/cluster/<CLUSTER>=owned|shared.
#
# ⚠️ A DIFFERENT API AND A DIFFERENT TAG, and the reason this exists is that neither was covered.
# `cluster_lb_arns` above reads `elbv2` only, and matches `elbv2.k8s.aws/cluster` — the AWS Load
# Balancer Controller's tag on an ALB/NLB. A `Service: LoadBalancer` handled by the IN-TREE cloud
# provider — which is what ingress-nginx gets by default — creates a CLASSIC ELB through
# `aws elb`, tagged `kubernetes.io/cluster/<name>: owned` and `kubernetes.io/service-name`. This
# script never called `aws elb` at all, so that whole class was invisible to the sweep AND to
# verify_swept.
#
# MEASURED, 2026-08-30. Two classic ELBs were found alive in us-east-1 by hand:
#
#   a19d04c70d3934e4996ce17cb9ae9ea6  kubernetes.io/cluster/eks-ue1-33243599078-1-alethia-nl  23h
#   a8a8791a7a6b249319f24b2e2b727584  kubernetes.io/cluster/eks-ue1-33271997812-1-alethia-nl  12h
#
# both `ingress-nginx/addon-ingress-nginx-controller`, both billing, and the first had survived FOUR
# preflight sweeps. Run 33271997812's own sweep deleted its elbv2 ("deleted elb ff6be6b…") and left
# its classic ELB standing.
#
# This is the same leak the discover_cluster comment above already records for run 31929564177 —
# "the sweep exited green while the load balancer billed" — one AWS API over. The fix there taught
# discovery to read elbv2 tags; it did not teach it that `elb` and `elbv2` are two services.
cluster_classic_lb_names() {
	[ -z "$CLUSTER" ] && return 0
	local names name tags
	names="$(probe_run classic-load-balancer aws elb describe-load-balancers \
		--query 'LoadBalancerDescriptions[].LoadBalancerName' --output text | tr '\t' '\n' | grep -v '^$' || true)"
	while IFS= read -r name; do
		[ -n "$name" ] || continue
		# Captured, THEN matched — same reason as cluster_lb_arns: a `| grep -q .` can SIGPIPE the
		# capture and, under pipefail, turn a TAGGED balancer into an untagged-looking one.
		# probe_confirm_re, NOT probe_run: this reads ONE balancer in a SHARED account, prod
		# included, and a foreign ELB deleted between the list above and this describe answers
		# LoadBalancerNotFound. Under probe_run that exhausts the retries and forces exit 4 on an
		# otherwise clean teardown — up to eight scans per job across verify and three preflight
		# envs. A NotFound here is an ANSWER ("it is gone, so it is not ours to delete").
		#
		# ⚠️ ...but the "gone" shape is pinned to that ONE string rather than delegated to
		# looks_gone, because this function has TWO callers and they want different things. The
		# sweep can afford a generous "already gone". The other caller is
		# alive_lbs → verify_swept → finalize_verification, where "the describe did not answer"
		# reclassified as "not ours" drops a live, BILLING classic ELB out of the leak list and the
		# run exits 0 — the silent green this file exists to remove. looks_gone is an
		# 11-alternative union covering s3api, sqs and the NoSuch* family; an `elb describe-tags`
		# failing through a misrouted endpoint or a proxy answers "An error occurred (404) …: Not
		# Found", which matches three of them. Everything but LoadBalancerNotFound stays
		# UNVERIFIABLE, so the gate still fires.
		tags="$(probe_confirm_re classic-load-balancer 'LoadBalancerNotFound' \
			aws elb describe-tags --load-balancer-names "$name" \
			--query "TagDescriptions[].Tags[?Key=='kubernetes.io/cluster/${CLUSTER}'].Value" --output text || true)"
		if printf '%s' "$tags" | grep -Eq 'owned|shared'; then
			printf '%s\n' "$name"
		fi
	done <<<"$names"
}

# ── 2. Load balancers (LB-controller out-of-band) + target groups. Delete before subnets. ──
sweep_load_balancers() {
	local arns arn tgs tg
	arns="$(cluster_lb_arns)"
	if [ -n "$arns" ]; then
		echo "  · load balancers: $(printf '%s' "$arns" | grep -c .) to delete"
		while IFS= read -r arn; do
			[ -n "$arn" ] || continue
			retry_delete "elb $(arn_id "$arn")" aws elbv2 delete-load-balancer --load-balancer-arn "$arn"
		done <<<"$arns"
	else
		echo "  · load balancers: none"
	fi
	# Classic ELBs are a SEPARATE service and a separate call. Deleted here, before subnets, for the
	# same reason the elbv2 ones are: their ENIs hold the subnets the network sweep needs to delete.
	local cnames cname
	cnames="$(cluster_classic_lb_names)"
	if [ -n "$cnames" ]; then
		echo "  · classic load balancers: $(printf '%s' "$cnames" | grep -c .) to delete"
		while IFS= read -r cname; do
			[ -n "$cname" ] || continue
			retry_delete "classic-elb ${cname}" aws elb delete-load-balancer --load-balancer-name "$cname"
		done <<<"$cnames"
	else
		echo "  · classic load balancers: none"
	fi
	[ -z "$CLUSTER" ] && return 0
	tgs="$(aws elbv2 describe-target-groups --query 'TargetGroups[].TargetGroupArn' --output text 2>/dev/null | tr '\t' '\n' | grep -v '^$' || true)"
	while IFS= read -r tg; do
		[ -n "$tg" ] || continue
		if aws elbv2 describe-tags --resource-arns "$tg" \
			--query "TagDescriptions[].Tags[?Key=='elbv2.k8s.aws/cluster' && Value=='${CLUSTER}']" --output text 2>/dev/null | grep -q .; then
			retry_delete "target-group $(arn_id "$tg")" aws elbv2 delete-target-group --target-group-arn "$tg"
		fi
	done <<<"$tgs"
}

# ── 3. EKS nodegroups + cluster (tofu-managed; sweep only if leaked past a killed destroy). ──
sweep_eks() {
	[ -z "$CLUSTER" ] && {
		echo "  · EKS: none"
		return 0
	}
	# describe-cluster is authoritative: skip cleanly if it is already gone.
	if ! aws eks describe-cluster --name "$CLUSTER" >/dev/null 2>&1; then
		echo "  · EKS cluster ${CLUSTER}: already gone"
		return 0
	fi
	local ngs ng
	ngs="$(aws eks list-nodegroups --cluster-name "$CLUSTER" --query 'nodegroups' --output text 2>/dev/null | tr '\t' '\n' | grep -v '^$' || true)"
	while IFS= read -r ng; do
		[ -n "$ng" ] || continue
		retry_delete "nodegroup ${ng}" aws eks delete-nodegroup --cluster-name "$CLUSTER" --nodegroup-name "$ng"
	done <<<"$ngs"
	if [ "$DRY_RUN" != "1" ] && [ -n "$ngs" ]; then
		for ng in $ngs; do aws eks wait nodegroup-deleted --cluster-name "$CLUSTER" --nodegroup-name "$ng" 2>/dev/null || true; done
	fi
	retry_delete "eks cluster ${CLUSTER}" aws eks delete-cluster --name "$CLUSTER"
	[ "$DRY_RUN" != "1" ] && aws eks wait cluster-deleted --name "$CLUSTER" 2>/dev/null || true
}

# ── 4. NAT gateways (tagged) → wait → release their EIPs. ──
sweep_nat_and_eips() {
	assert_scope
	local nats nat eips eip
	nats="$(tagged_arns ec2:natgateway | while read -r a; do arn_id "$a"; done)"
	while IFS= read -r nat; do
		[ -n "$nat" ] || continue
		retry_delete "nat-gateway ${nat}" aws ec2 delete-nat-gateway --nat-gateway-id "$nat"
	done <<<"$nats"
	if [ "$DRY_RUN" != "1" ] && [ -n "$nats" ]; then
		local waited=0 live
		while [ "$waited" -lt "$DETACH_TIMEOUT" ]; do
			# shellcheck disable=SC2086,SC2016 # $nats: id list as args; backtick is JMESPath
			live="$(aws ec2 describe-nat-gateways --nat-gateway-ids $nats --query 'NatGateways[?State!=`deleted`].NatGatewayId' --output text 2>/dev/null | grep -c . || true)"
			[ "${live:-0}" -eq 0 ] && break
			echo "  · waiting for ${live} NAT gateway(s) to delete… (${waited}s/${DETACH_TIMEOUT}s)"
			sleep 10
			waited=$((waited + 10))
		done
	fi
	eips="$(tagged_arns ec2:elastic-ip | while read -r a; do arn_id "$a"; done)"
	while IFS= read -r eip; do
		[ -n "$eip" ] || continue
		retry_delete "eip ${eip}" aws ec2 release-address --allocation-id "$eip"
	done <<<"$eips"
}

# ── 5. EBS volumes (tagged pvc-* + cluster-tagged CSI fallback). Detach-force then delete. ──
sweep_volumes() {
	assert_scope
	local vols vol
	[ "$DRY_RUN" != "1" ] && sleep 10
	vols="$(
		{
			tagged_arns ec2:volume | while read -r a; do arn_id "$a"; done
			cluster_volume_ids
		} | grep -v '^$' | sort -u || true
	)"
	[ -z "$vols" ] && {
		echo "  · EBS volumes: none"
		return 0
	}
	echo "  · EBS volumes: $(printf '%s' "$vols" | grep -c .) to delete"
	while IFS= read -r vol; do
		[ -n "$vol" ] || continue
		[ "$DRY_RUN" = "1" ] && {
			echo "      would delete volume ${vol}"
			continue
		}
		aws ec2 detach-volume --volume-id "$vol" --force >/dev/null 2>&1 || true
		retry_delete "volume ${vol}" aws ec2 delete-volume --volume-id "$vol"
	done <<<"$vols"
}

# ── 6. Network teardown (tagged): ENIs → SGs → subnets → route tables (skip MAIN) → IGW → VPC. ──
sweep_network() {
	assert_scope
	local vpcs vpc enis eni sgs sg subnets subnet rts rt igws igw main

	enis="$(tagged_arns ec2:network-interface | while read -r a; do arn_id "$a"; done)"
	while IFS= read -r eni; do
		[ -n "$eni" ] || continue
		retry_delete "eni ${eni}" aws ec2 delete-network-interface --network-interface-id "$eni"
	done <<<"$enis"

	# ── VPC ENDPOINTS, before anything tries to delete the VPC ────────────────────────────────
	# An attached endpoint blocks `delete-vpc` outright, and nothing here swept them, so the VPC
	# failed on every retry and the environment survived teardown forever. Measured on run
	# 29558347776-1, leaked since 2026-07-17: a Gateway endpoint (com.amazonaws.us-east-1.s3) held
	# the VPC open, and `delete-vpc-endpoints` was all it took.
	local vpces vpce
	vpces="$(tagged_arns ec2:vpc-endpoint | while read -r a; do arn_id "$a"; done)"
	while IFS= read -r vpce; do
		[ -n "$vpce" ] || continue
		retry_delete "vpc-endpoint ${vpce}" aws ec2 delete-vpc-endpoints --vpc-endpoint-ids "$vpce"
	done <<<"$vpces"

	# ── SECURITY GROUPS: revoke the rules FIRST, and never touch `default` ─────────────────────
	# The EKS module always creates a cluster SG and a node SG that reference EACH OTHER
	# (UserIdGroupPairs). AWS refuses to delete either while the other's rule names it, so a plain
	# delete loop deadlocks and both survive — the second half of why 29558347776-1 and
	# 30518134684-1 stood since July. Stripping every rule first breaks the cycle; the groups then
	# delete in any order.
	#
	# The VPC's `default` group is skipped for the same reason the main route table is: it cannot
	# be deleted directly and is removed with the VPC. Attempting it fails on every retry forever.
	# TWO PASSES, and the order is the whole point. AWS refuses to delete a group while ANY OTHER
	# group's rule still names it — so stripping one group and deleting it immediately still fails,
	# because its sibling's rule is what holds it. Measured: interleaving revoke+delete cleared the
	# second group of the pair and left the first, exactly as before the fix.
	# Pass 1 strips every rule from every group, which breaks the cycle. Pass 2 then deletes them,
	# and by then no group references any other.
	local sgs_deletable=""
	# The union, not the tagged set: see vpc_security_group_ids. Both passes below then cover the
	# cluster-created groups too, which is what finally lets `delete-vpc` succeed.
	sgs="$( (tagged_arns ec2:security-group | while read -r a; do arn_id "$a"; done
		vpc_security_group_ids) | grep -v '^$' | sort -u || true)"
	while IFS= read -r sg; do
		[ -n "$sg" ] || continue
		# The VPC's `default` group is skipped for the same reason the main route table is: it
		# cannot be deleted directly and is removed with the VPC. Attempting it fails forever.
		if [ "$(aws ec2 describe-security-groups --group-ids "$sg" --query 'SecurityGroups[0].GroupName' --output text 2>/dev/null)" = "default" ]; then
			echo "      skip default security-group ${sg} (auto-removed with the VPC)"
			continue
		fi
		sgs_deletable="${sgs_deletable}${sg}"$'\n'
		if [ "$DRY_RUN" = "1" ]; then
			echo "      would revoke all rules on security-group ${sg}"
			continue
		fi
		local ing egr
		ing="$(aws ec2 describe-security-groups --group-ids "$sg" --query 'SecurityGroups[0].IpPermissions' --output json 2>/dev/null || echo '[]')"
		egr="$(aws ec2 describe-security-groups --group-ids "$sg" --query 'SecurityGroups[0].IpPermissionsEgress' --output json 2>/dev/null || echo '[]')"
		# Best-effort: a group with no rules is already in the state we want, and a failed revoke
		# must not stop pass 2 from attempting the delete.
		[ "$ing" != "[]" ] && aws ec2 revoke-security-group-ingress --group-id "$sg" --ip-permissions "$ing" >/dev/null 2>&1 || true
		[ "$egr" != "[]" ] && aws ec2 revoke-security-group-egress --group-id "$sg" --ip-permissions "$egr" >/dev/null 2>&1 || true
	done <<<"$sgs"
	while IFS= read -r sg; do
		[ -n "$sg" ] || continue
		retry_delete "security-group ${sg}" aws ec2 delete-security-group --group-id "$sg"
	done <<<"$sgs_deletable"

	subnets="$(tagged_arns ec2:subnet | while read -r a; do arn_id "$a"; done)"
	while IFS= read -r subnet; do
		[ -n "$subnet" ] || continue
		retry_delete "subnet ${subnet}" aws ec2 delete-subnet --subnet-id "$subnet"
	done <<<"$subnets"

	# Route tables: the VPC's MAIN route table cannot be deleted (auto-removed with the VPC) —
	# attempting it fails forever, so skip it (grill F6).
	rts="$(tagged_arns ec2:route-table | while read -r a; do arn_id "$a"; done)"
	while IFS= read -r rt; do
		[ -n "$rt" ] || continue
		# shellcheck disable=SC2016 # backticks are JMESPath, not command substitution
		main="$(aws ec2 describe-route-tables --route-table-ids "$rt" --query 'RouteTables[].Associations[?Main==`true`]' --output text 2>/dev/null || true)"
		if [ -n "$main" ]; then
			echo "      skip main route-table ${rt} (auto-removed with the VPC)"
			continue
		fi
		retry_delete "route-table ${rt}" aws ec2 delete-route-table --route-table-id "$rt"
	done <<<"$rts"

	vpcs="$(tagged_arns ec2:vpc | while read -r a; do arn_id "$a"; done)"
	igws="$(tagged_arns ec2:internet-gateway | while read -r a; do arn_id "$a"; done)"
	while IFS= read -r igw; do
		[ -n "$igw" ] || continue
		if [ "$DRY_RUN" != "1" ]; then
			while IFS= read -r vpc; do
				[ -n "$vpc" ] || continue
				aws ec2 detach-internet-gateway --internet-gateway-id "$igw" --vpc-id "$vpc" >/dev/null 2>&1 || true
			done <<<"$vpcs"
		fi
		retry_delete "internet-gateway ${igw}" aws ec2 delete-internet-gateway --internet-gateway-id "$igw"
	done <<<"$igws"

	while IFS= read -r vpc; do
		[ -n "$vpc" ] || continue
		retry_delete "vpc ${vpc}" aws ec2 delete-vpc --vpc-id "$vpc"
	done <<<"$vpcs"
}

# ── 6.5 ACM certificates (tagged). NEW: until #2561 wired the ACM scenario into t2DeploySnapshot
#    the fixture requested no certificate, so there was nothing here to leak — and this file said so,
#    in a comment four hundred lines down that went stale the same morning. The first run with the
#    scenario live left
#
#      arn:aws:acm:us-east-1:…:certificate/5db9d00b-…   *.32853963536-1.e2e.alethialabs.io
#
#    standing after the step reported teardown success, and verify_swept reported clean over it
#    because it did not look. `aws acm list-certificates` had no coverage anywhere in this script.
#
#    AFTER the load-balancer sweep, deliberately: ACM refuses to delete a certificate that is still
#    associated with a listener (ResourceInUseException), so an ACM sweep placed before step 2 would
#    fail on exactly the runs that had got far enough to serve traffic — the ones most likely to
#    leak. By here every ELB is gone.
#
#    An ACM certificate carries no cost. That is not the reason to leave one: a per-run wildcard
#    certificate that nothing reclaims accumulates against the account's quota (a soft limit that is
#    raised by a support ticket, not a flag), and a sweeper that reports "clean" over a resource it
#    never queried is the failure mode this file exists to end.
sweep_acm() {
	assert_scope
	local arns arn
	arns="$(tagged_arns acm:certificate)"
	[ -z "$arns" ] && {
		echo "  · acm certificates: none"
		return 0
	}
	echo "  · acm certificates: $(printf '%s' "$arns" | grep -c .) to delete"
	while IFS= read -r arn; do
		[ -n "$arn" ] || continue
		retry_delete "acm certificate ${arn}" aws acm delete-certificate --certificate-arn "$arn"
	done <<<"$arns"
}

# ── 7. Route 53 hosted zones (tagged). NEW with #1754: until then the max-config `dns` fixture
#    used example.com, which AWS RESERVES, so the zone could never be created and there was
#    nothing here to leak. Now that the fixture uses a real name, a hard-killed run leaves a
#    billable zone ($0.50/month, forever) that `tofu destroy` never got to remove.
#
#    Route 53 is GLOBAL, so this is not region-scoped — which is exactly why the tag filter is
#    load-bearing rather than incidental: an unfiltered zone sweep in the shared platform account
#    would take out production DNS. tagged_arns() is the same mandatory per-run handle every
#    other sweep uses, and assert_scope refuses to proceed without it.
#
#    A zone only deletes once it holds nothing but its own NS + SOA. tofu owns any other record,
#    so on the graceful path this finds nothing. Anything else is removed first rather than letting
#    the delete fail — a leak that "failed loudly" is still a leak.
#
#    ⚠️ This comment used to assert "the fixture no longer requests an ACM validation record". That
#    stopped being true the morning #2561 wired the ACM scenario into t2DeploySnapshot, and nothing
#    connected the two: the sweeper's assumption was invalidated by the change that enabled the
#    scenario. See sweep_acm (step 6.5), which is what actually reclaims the certificate.
sweep_route53() {
	assert_scope
	local zones zone rrs
	zones="$(tagged_arns route53:hostedzone | while read -r a; do arn_id "$a"; done | grep -v '^$' || true)"
	[ -z "$zones" ] && {
		echo "  · route53 hosted zones: none"
		return 0
	}
	echo "  · route53 hosted zones: $(printf '%s' "$zones" | grep -c .) to delete"
	while IFS= read -r zone; do
		[ -n "$zone" ] || continue
		if [ "$DRY_RUN" != "1" ]; then
			# Everything except the zone's own NS/SOA, as a single ChangeBatch of DELETEs.
			# shellcheck disable=SC2016 # the backticks are JMESPath literals, not a subshell
			rrs="$(aws route53 list-resource-record-sets --hosted-zone-id "$zone" \
				--query 'ResourceRecordSets[?Type!=`NS` && Type!=`SOA`]' --output json 2>/dev/null || echo '[]')"
			if [ "$(printf '%s' "$rrs" | jq 'length' 2>/dev/null || echo 0)" -gt 0 ]; then
				printf '%s' "$rrs" |
					jq '{Changes: [.[] | {Action: "DELETE", ResourceRecordSet: .}]}' \
						>"${TMPDIR:-/tmp}/r53-${zone}.json" 2>/dev/null || true
				aws route53 change-resource-record-sets --hosted-zone-id "$zone" \
					--change-batch "file://${TMPDIR:-/tmp}/r53-${zone}.json" >/dev/null 2>&1 || true
			fi
		fi
		retry_delete "route53 hosted-zone ${zone}" aws route53 delete-hosted-zone --id "$zone"
	done <<<"$zones"
}

# ── 8. Data services: Aurora/RDS + ElastiCache. THESE MUST GO BEFORE THE NETWORK SWEEP.
#
#    Neither was swept and neither was verified, so a hard-killed run left an Aurora cluster
#    (db.r6g.large, the most expensive thing the max-config fixture builds) and an ElastiCache
#    replication group running while the step exited 0. They are also the reason the network sweep
#    fails: both hold ENIs in the private subnets, so their subnets — and then the VPC — refuse to
#    delete for as long as they live. Deleting them here is what makes step 6 able to finish.
#
#    Both are tag-discovered like everything else. Final snapshots are explicitly skipped: a
#    snapshot of an e2e database is itself a billable artifact nothing would ever reclaim, and
#    RDS refuses the delete outright if neither a snapshot id nor the skip flag is given.
sweep_data_services() {
	assert_scope
	local ids id
	# Cluster INSTANCES first — a cluster with members refuses to delete.
	ids="$(tagged_arns rds:db | while read -r a; do arn_id "$a"; done)"
	while IFS= read -r id; do
		[ -n "$id" ] || continue
		retry_delete "rds instance ${id}" aws rds delete-db-instance --db-instance-identifier "$id" --skip-final-snapshot --delete-automated-backups
	done <<<"$ids"
	ids="$(tagged_arns rds:cluster | while read -r a; do arn_id "$a"; done)"
	while IFS= read -r id; do
		[ -n "$id" ] || continue
		retry_delete "rds cluster ${id}" aws rds delete-db-cluster --db-cluster-identifier "$id" --skip-final-snapshot
	done <<<"$ids"
	ids="$(tagged_arns elasticache:replicationgroup | while read -r a; do arn_id "$a"; done)"
	while IFS= read -r id; do
		[ -n "$id" ] || continue
		retry_delete "elasticache replication-group ${id}" aws elasticache delete-replication-group --replication-group-id "$id" --no-retain-primary-cluster
	done <<<"$ids"

	# Wait for the ENIs to actually be released. Without this the network sweep runs against
	# subnets that are still in use and every delete fails — which, before the classification fix
	# below, was reported as a NOTICE and exited green.
	[ "$DRY_RUN" = "1" ] && return 0
	local waited=0 live
	while [ "$waited" -lt "$DETACH_TIMEOUT" ]; do
		live="$({ alive_rds_clusters; alive_rds_instances; alive_elasticache; } | grep -c . || true)"
		[ "${live:-0}" -eq 0 ] && break
		echo "  · waiting for ${live} data service(s) to finish deleting… (${waited}s/${DETACH_TIMEOUT}s)"
		sleep 15
		waited=$((waited + 15))
	done
}

# ── 9. Everything else the max-config fixture builds that nothing swept and nothing verified:
#       DynamoDB, S3, ECR, Secrets Manager, SQS, SNS, KMS. None of them holds an ENI, so they run
#       after the network teardown; all of them bill, and all of them carry the project-id tag via
#       the provider `default_tags` block (aws/main.tf:26), which is what makes them tag-discoverable
#       at all. ──
sweep_managed_services() {
	assert_scope
	local arns arn name

	# DynamoDB. `update-table --no-deletion-protection-enabled` first: the root template defaulted
	# deletion protection ON until this change, so a table built by an EARLIER apply is still
	# protected and DeleteTable on it is refused forever. Harmless on an unprotected table.
	arns="$(tagged_arns dynamodb:table)"
	while IFS= read -r arn; do
		[ -n "$arn" ] || continue
		name="$(arn_id "$arn")"
		[ "$DRY_RUN" != "1" ] && aws dynamodb update-table --table-name "$name" --no-deletion-protection-enabled >/dev/null 2>&1 || true
		retry_delete "dynamodb table ${name}" aws dynamodb delete-table --table-name "$name"
	done <<<"$arns"

	# S3. A non-empty bucket cannot be deleted, and versioning leaves delete-markers that
	# `rm --recursive` does not remove — so purge object VERSIONS explicitly before the bucket.
	arns="$(tagged_arns s3)"
	while IFS= read -r arn; do
		[ -n "$arn" ] || continue
		name="${arn##*:}"
		[ -n "$name" ] || continue
		if [ "$DRY_RUN" != "1" ]; then
			aws s3 rm "s3://${name}" --recursive >/dev/null 2>&1 || true
			purge_bucket_versions "$name"
		fi
		retry_delete "s3 bucket ${name}" aws s3api delete-bucket --bucket "$name"
	done <<<"$arns"

	arns="$(tagged_arns ecr:repository)"
	while IFS= read -r arn; do
		[ -n "$arn" ] || continue
		retry_delete "ecr repository $(arn_id "$arn")" aws ecr delete-repository --repository-name "$(arn_id "$arn")" --force
	done <<<"$arns"

	# Secrets Manager. WITHOUT --force-delete-without-recovery a deleted secret sits in a 7-30 day
	# recovery window, still occupying its name, and describe-secret keeps returning it — so a
	# plain delete would leave verify_swept reporting a leak it could never clear.
	arns="$(tagged_arns secretsmanager:secret)"
	while IFS= read -r arn; do
		[ -n "$arn" ] || continue
		retry_delete "secret ${arn##*:}" aws secretsmanager delete-secret --secret-id "$arn" --force-delete-without-recovery
	done <<<"$arns"

	# SQS deletes by queue URL, not ARN; the queue name is the ARN's last segment.
	arns="$(tagged_arns sqs)"
	while IFS= read -r arn; do
		[ -n "$arn" ] || continue
		name="${arn##*:}"
		local url
		url="$(aws sqs get-queue-url --queue-name "$name" --query 'QueueUrl' --output text 2>/dev/null || true)"
		[ -n "$url" ] && [ "$url" != "None" ] || continue
		retry_delete "sqs queue ${name}" aws sqs delete-queue --queue-url "$url"
	done <<<"$arns"

	arns="$(tagged_arns sns)"
	while IFS= read -r arn; do
		[ -n "$arn" ] || continue
		retry_delete "sns topic ${arn##*:}" aws sns delete-topic --topic-arn "$arn"
	done <<<"$arns"

	# KMS. There is NO immediate delete — a customer-managed key can only be SCHEDULED for
	# deletion, minimum 7 days, and it bills $1/key/month until it actually goes. Four keys is
	# $4/month per leaked run, which is why they belong here. It also means a key sitting in
	# PendingDeletion is as swept as a key can be, and alive_kms_keys() below must not call that a
	# leak — otherwise every clean run would fail its own verification.
	arns="$(tagged_arns kms:key)"
	while IFS= read -r arn; do
		[ -n "$arn" ] || continue
		name="$(arn_id "$arn")"
		# Never touch an AWS-managed key. The tag filter already excludes them (they carry no
		# default_tags), but a scheduled deletion is irreversible and cheap to guard twice.
		local meta manager state
		meta="$(aws kms describe-key --key-id "$name" --query 'KeyMetadata.[KeyManager,KeyState]' --output text 2>/dev/null || printf 'UNKNOWN\tUNKNOWN')"
		manager="$(printf '%s' "$meta" | cut -f1)"
		state="$(printf '%s' "$meta" | cut -f2)"
		if [ "$manager" != "CUSTOMER" ]; then
			echo "      skip kms key ${name} (not customer-managed)"
			continue
		fi
		# A key already in PendingDeletion cannot be scheduled again — the call fails, and
		# retry_delete then burns all five attempts (~93s) on something that can never succeed.
		# The comment above already states the principle ("a key sitting in PendingDeletion is as
		# swept as a key can be") and alive_kms_keys() already honours it; only this loop did not.
		#
		# It is the single biggest time sink in a preflight sweep: 36 of the 37 tagged e2e keys in
		# us-east-1 are in this state, so a full pass across the leaked environments spends the
		# better part of an hour failing on keys that are already gone — which is a large part of
		# how the preflight reached the 90-minute job cap (#2257).
		if [ "$state" = "PendingDeletion" ]; then
			echo "      skip kms key ${name} (already PendingDeletion — as swept as a key can be)"
			continue
		fi
		retry_delete "kms key ${name} (schedule 7d)" aws kms schedule-key-deletion --key-id "$name" --pending-window-in-days 7
	done <<<"$arns"
}

# purge_bucket_versions <bucket> — delete every object VERSION and delete-marker, in batches of
# 1000 (the DeleteObjects cap). A versioned bucket is not empty just because `s3 rm` returned.
purge_bucket_versions() {
	local bucket="$1" raw payload
	while :; do
		raw="$(aws s3api list-object-versions --bucket "$bucket" --max-keys 1000 --output json 2>/dev/null || echo '{}')"
		# Versions AND DeleteMarkers — a bucket holding only delete-markers still refuses to delete.
		payload="$(printf '%s' "$raw" | jq -c '{Objects: (((.Versions // []) + (.DeleteMarkers // [])) | map({Key, VersionId}))}' 2>/dev/null || echo '{"Objects":[]}')"
		[ "$(printf '%s' "$payload" | jq '.Objects | length' 2>/dev/null || echo 0)" -gt 0 ] || break
		aws s3api delete-objects --bucket "$bucket" --delete "$payload" >/dev/null 2>&1 || break
	done
}

# ── Final verification: a leak must NEVER exit green (grill F1/F2/F3). Uses tag-FILTERED
#    describes (union of the project-id tag AND the cluster tag), which — unlike `--instance-ids`
#    — never fail the whole call on an already-deregistered id (which would false-GREEN a mix of
#    gone+live), return ONLY currently-live resources (authoritative — no resourcegroupstaggingapi
#    lag ⇒ no false-RED), and cover BOTH the tofu-tagged and the out-of-band (Karpenter/ELB/CSI)
#    scopes. ──
by_tag_instances() {
	probe_run ec2-instance aws ec2 describe-instances \
		--filters "Name=tag:$1,Values=$2" "Name=instance-state-name,Values=pending,running,stopping,stopped" \
		--query 'Reservations[].Instances[].InstanceId' --output text | tr '\t' '\n' | grep -v '^$' || true
}
alive_instances() {
	{
		by_tag_instances "alethia:project-id" "$PROJECT_ID_TAG"
		[ -n "$CLUSTER" ] && by_tag_instances "kubernetes.io/cluster/${CLUSTER}" "owned,shared"
	} | grep -v '^$' | sort -u || true
}
by_tag_volumes() {
	probe_run ebs-volume aws ec2 describe-volumes \
		--filters "Name=tag:$1,Values=$2" "Name=status,Values=creating,available,in-use" \
		--query 'Volumes[].VolumeId' --output text | tr '\t' '\n' | grep -v '^$' || true
}
alive_volumes() {
	{
		by_tag_volumes "alethia:project-id" "$PROJECT_ID_TAG"
		[ -n "$CLUSTER" ] && by_tag_volumes "kubernetes.io/cluster/${CLUSTER}" "owned,shared"
	} | grep -v '^$' | sort -u || true
}
alive_nats() {
	# shellcheck disable=SC2016 # backtick is JMESPath
	probe_run nat-gateway aws ec2 describe-nat-gateways \
		--filter "Name=tag:alethia:project-id,Values=${PROJECT_ID_TAG}" \
		--query 'NatGateways[?State!=`deleted`].NatGatewayId' --output text | tr '\t' '\n' | grep -v '^$' || true
}
# BOTH services. verify_swept's whole job is to refuse a green exit over something that bills, and
# it was blind to exactly the class that survived four sweeps. A classic ELB in us-east-1 is
# $0.025/hour whether or not this script could see it.
alive_lbs() {
	cluster_lb_arns
	cluster_classic_lb_names
}
# probe_confirm, not probe_run: a deleted cluster answers ResourceNotFoundException, and that IS
# the answer "gone". Any other error means the control plane's existence is unknown — and an EKS
# control plane is $0.10/hour whether or not this script could see it.
alive_eks() { [ -n "$CLUSTER" ] && probe_confirm_re eks-cluster 'ResourceNotFoundException' aws eks describe-cluster --name "$CLUSTER" --query 'cluster.name' --output text || true; }

# A surviving hosted zone bills at $0.50/month FOREVER — small per run, but it never ages out and
# nothing else would ever notice it. Unlike the describes above there is no tag-filtered Route 53
# list API, so this goes through the tagging API; its lag can only make this MISS a leak (a
# false-green already covered by the next run's sweep), never invent one.
alive_zones() { tagged_arns route53:hostedzone | while read -r a; do arn_id "$a"; done; }

# ACM has no terminal "deleting" state to filter — delete-certificate either succeeds or refuses —
# so a certificate that still DESCRIBES is alive, full stop. Confirmed with a per-service describe
# like every other probe here: the tagging API can lag a delete, and a lagging list on its own would
# false-RED a clean run.
alive_acm_certs() {
	local arn
	while IFS= read -r arn; do
		[ -n "$arn" ] || continue
		probe_confirm_re acm-certificate 'ResourceNotFoundException' aws acm describe-certificate --certificate-arn "$arn" \
			--query 'Certificate.DomainName' --output text | grep -v '^$' || true
	done <<<"$(tagged_arns acm:certificate)"
}

# ── The eight types that were swept by nothing and verified by nothing. Each takes the tagged ARN
#    list and then CONFIRMS the resource with an authoritative per-service describe, the same
#    posture the compute probes use: the tagging API can lag behind a delete, and a lagging list on
#    its own would false-RED a clean run. Confirming can only make these MISS a leak the tagging API
#    has not caught up to yet — which the next run's PREFLIGHT sweeps — never invent one.
#
#    Terminal states are NOT leaks. A resource in `deleting` has been swept; reporting it would fail
#    every well-behaved run. That distinction is load-bearing for KMS in particular, where
#    PendingDeletion is the ONLY end state a sweeper can reach. ──
alive_rds_clusters() {
	local id
	for id in $(tagged_arns rds:cluster | while read -r a; do arn_id "$a"; done); do
		# shellcheck disable=SC2016 # backtick is JMESPath
		probe_confirm_re rds-cluster 'DBClusterNotFound' aws rds describe-db-clusters --db-cluster-identifier "$id" \
			--query 'DBClusters[?Status!=`deleting`].DBClusterIdentifier' --output text || true
	done | tr '\t' '\n' | grep -v '^$' || true
}
alive_rds_instances() {
	local id
	for id in $(tagged_arns rds:db | while read -r a; do arn_id "$a"; done); do
		# shellcheck disable=SC2016
		probe_confirm_re rds-instance 'DBInstanceNotFound' aws rds describe-db-instances --db-instance-identifier "$id" \
			--query 'DBInstances[?DBInstanceStatus!=`deleting`].DBInstanceIdentifier' --output text || true
	done | tr '\t' '\n' | grep -v '^$' || true
}
alive_elasticache() {
	local id
	for id in $(tagged_arns elasticache:replicationgroup | while read -r a; do arn_id "$a"; done); do
		# shellcheck disable=SC2016
		probe_confirm_re elasticache-replication-group 'ReplicationGroupNotFoundFault' aws elasticache describe-replication-groups --replication-group-id "$id" \
			--query 'ReplicationGroups[?Status!=`deleting`].ReplicationGroupId' --output text || true
	done | tr '\t' '\n' | grep -v '^$' || true
}
alive_ddb_tables() {
	# describe-table returns `Table` as an OBJECT, not a list — a `[?…]` filter projection over it
	# silently evaluates to null, which would report every table as gone. Read the scalar status and
	# compare in shell instead.
	local id state
	for id in $(tagged_arns dynamodb:table | while read -r a; do arn_id "$a"; done); do
		state="$(probe_confirm_re dynamodb-table 'ResourceNotFoundException' aws dynamodb describe-table --table-name "$id" --query 'Table.TableStatus' --output text || true)"
		case "$state" in "" | None | DELETING) ;; *) printf '%s\n' "$id" ;; esac
	done
}
alive_s3_buckets() {
	local arn name
	while IFS= read -r arn; do
		[ -n "$arn" ] || continue
		name="${arn##*:}"
		[ -n "$name" ] || continue
		probe_confirm_re s3-bucket '\(404\)|Not Found|NoSuchBucket' aws s3api head-bucket --bucket "$name" >/dev/null && printf '%s\n' "$name"
	done <<<"$(tagged_arns s3)"
}
alive_ecr_repos() {
	local id
	for id in $(tagged_arns ecr:repository | while read -r a; do arn_id "$a"; done); do
		probe_confirm_re ecr-repository 'RepositoryNotFoundException' aws ecr describe-repositories --repository-names "$id" \
			--query 'repositories[].repositoryName' --output text || true
	done | tr '\t' '\n' | grep -v '^$' || true
}
alive_secrets() {
	local arn
	while IFS= read -r arn; do
		[ -n "$arn" ] || continue
		probe_confirm_re secretsmanager-secret 'ResourceNotFoundException' aws secretsmanager describe-secret --secret-id "$arn" >/dev/null && printf '%s\n' "${arn##*:}"
	done <<<"$(tagged_arns secretsmanager:secret)"
}
alive_sqs_queues() {
	local arn url
	while IFS= read -r arn; do
		[ -n "$arn" ] || continue
		url="$(probe_confirm_re sqs-queue 'NonExistentQueue' aws sqs get-queue-url --queue-name "${arn##*:}" --query 'QueueUrl' --output text || true)"
		[ -n "$url" ] && [ "$url" != "None" ] && printf '%s\n' "${arn##*:}"
	done <<<"$(tagged_arns sqs)"
}
alive_sns_topics() {
	local arn
	while IFS= read -r arn; do
		[ -n "$arn" ] || continue
		probe_confirm_re sns-topic 'NotFoundException' aws sns get-topic-attributes --topic-arn "$arn" >/dev/null && printf '%s\n' "${arn##*:}"
	done <<<"$(tagged_arns sns)"
}
alive_kms_keys() {
	# A key SCHEDULED for deletion is swept — 7 days is the shortest window AWS offers and nothing
	# can shorten it. Only a key still Enabled/Disabled means the sweep did not reach it.
	local id state
	for id in $(tagged_arns kms:key | while read -r a; do arn_id "$a"; done); do
		state="$(probe_confirm_re kms-key 'NotFoundException' aws kms describe-key --key-id "$id" --query 'KeyMetadata.KeyState' --output text || true)"
		case "$state" in Enabled | Disabled) printf '%s\n' "$id" ;; esac
	done
}

# ── Tag-FILTERED network describes. Authoritative and lag-free (they return only live resources),
#    unlike the resourcegroupstaggingapi list this used to grep. The default security group and a
#    VPC's main route table are excluded because neither can be deleted on its own — they go with
#    the VPC, and the VPC is reported in its own right, so listing them would be noise that trains
#    people to ignore the output. ──
net_by_tag() {
	probe_run "network(${1#describe-})" aws ec2 "$1" --filters "Name=tag:alethia:project-id,Values=${PROJECT_ID_TAG}" \
		--query "$2" --output text | tr '\t' '\n' | grep -v '^$' || true
}
alive_network() {
	{
		net_by_tag describe-vpcs 'Vpcs[].VpcId'
		net_by_tag describe-subnets 'Subnets[].SubnetId'
		net_by_tag describe-internet-gateways 'InternetGateways[].InternetGatewayId'
		net_by_tag describe-network-interfaces 'NetworkInterfaces[].NetworkInterfaceId'
		# shellcheck disable=SC2016 # backticks are JMESPath
		net_by_tag describe-security-groups 'SecurityGroups[?GroupName!=`default`].GroupId'
		# shellcheck disable=SC2016
		net_by_tag describe-route-tables 'RouteTables[?!not_null(Associations[?Main==`true`] | [0])].RouteTableId'
	} | sort -u || true
}

# ── sweep_litter — the FREE leftovers. They cost nothing, which is exactly why nothing ever
#    removed them, and exactly why they became a problem: every one of them keeps its run's
#    `alethia:project-id` value alive in the region, so the preflight kept rediscovering finished
#    environments forever and the backlog could only grow (#2485). classify_arn calls these FREE;
#    this is what makes that classification self-draining instead of permanent.
#
#    Cheap, but still scope-locked through tagged_arns/assert_scope like every other sweep — an
#    IAM policy delete is not reversible either. IAM is global, so these ARNs surface in whichever
#    region the sweep runs; that is harmless because the scope is the tag, not the region. ──
sweep_litter() {
	assert_scope
	local arns arn name vers ver

	# An IAM policy cannot be deleted while a role still references it, and it keeps every
	# non-default VERSION until they are removed — a plain delete-policy fails on both counts.
	arns="$(tagged_arns iam:policy)"
	while IFS= read -r arn; do
		[ -n "$arn" ] || continue
		if [ "$DRY_RUN" != "1" ]; then
			for name in $(aws iam list-entities-for-policy --policy-arn "$arn" --query 'PolicyRoles[].RoleName' --output text 2>/dev/null | tr '\t' '\n'); do
				[ -n "$name" ] || continue
				aws iam detach-role-policy --role-name "$name" --policy-arn "$arn" >/dev/null 2>&1 || true
			done
			vers="$(aws iam list-policy-versions --policy-arn "$arn" --query 'Versions[?!IsDefaultVersion].VersionId' --output text 2>/dev/null | tr '\t' '\n')"
			while IFS= read -r ver; do
				[ -n "$ver" ] || continue
				aws iam delete-policy-version --policy-arn "$arn" --version-id "$ver" >/dev/null 2>&1 || true
			done <<<"$vers"
		fi
		retry_delete "iam policy $(arn_id "$arn")" aws iam delete-policy --policy-arn "$arn"
	done <<<"$arns"

	arns="$(tagged_arns iam:oidc-provider)"
	while IFS= read -r arn; do
		[ -n "$arn" ] || continue
		retry_delete "iam oidc provider $(arn_id "$arn")" aws iam delete-open-id-connect-provider --open-id-connect-provider-arn "$arn"
	done <<<"$arns"

	arns="$(tagged_arns ec2:launch-template)"
	while IFS= read -r arn; do
		[ -n "$arn" ] || continue
		retry_delete "launch template $(arn_id "$arn")" aws ec2 delete-launch-template --launch-template-id "$(arn_id "$arn")"
	done <<<"$arns"

	arns="$(tagged_arns rds:subgrp)"
	while IFS= read -r arn; do
		[ -n "$arn" ] || continue
		retry_delete "rds subnet group ${arn##*:}" aws rds delete-db-subnet-group --db-subnet-group-name "${arn##*:}"
	done <<<"$arns"

	arns="$(tagged_arns events:rule)"
	while IFS= read -r arn; do
		[ -n "$arn" ] || continue
		name="$(arn_id "$arn")"
		# A rule with targets refuses to delete; remove them first.
		if [ "$DRY_RUN" != "1" ]; then
			vers="$(aws events list-targets-by-rule --rule "$name" --query 'Targets[].Id' --output text 2>/dev/null | tr '\t' '\n' | grep -v '^$' | tr '\n' ' ')"
			# shellcheck disable=SC2086
			[ -n "$vers" ] && aws events remove-targets --rule "$name" --ids $vers >/dev/null 2>&1 || true
		fi
		retry_delete "eventbridge rule ${name}" aws events delete-rule --name "$name"
	done <<<"$arns"

	# Log groups, INCLUDING the ones still holding bytes. A first draft swept only the empty ones
	# and left the rest to "the operator" — which would have rebuilt the very bug this change
	# removes. The nightly runs daily and EKS log groups keep 14 days, so up to fourteen
	# environments can hold a non-empty group at once; classify_arn calls those BILLING (correctly
	# — stored bytes are charged), they would have exceeded PREFLIGHT_MAX_ENVS=3, and the
	# ::error:: would have come straight back, just more slowly.
	#
	# Deleting them is also simply right: the run these logs describe is over, its diagnostics are
	# already in the run's artifacts, and nothing else reads them. BILLING has to mean "costs money
	# AND we sweep it", never "costs money and we mention it forever".
	arns="$(tagged_arns logs:log-group)"
	while IFS= read -r arn; do
		[ -n "$arn" ] || continue
		name="$(printf '%s' "$arn" | cut -d: -f7)"
		[ -n "$name" ] || continue
		retry_delete "log group ${name}" aws logs delete-log-group --log-group-name "$name"
	done <<<"$arns"
}

verify_swept() {
	assert_scope
	local leaks="" x
	join() { printf '%s' "$1" | tr '\n' ' '; }
	x="$(alive_instances)"; [ -n "$x" ] && leaks="${leaks}ec2-instance: $(join "$x")\n"
	x="$(alive_volumes)"; [ -n "$x" ] && leaks="${leaks}ebs-volume: $(join "$x")\n"
	x="$(alive_nats)"; [ -n "$x" ] && leaks="${leaks}nat-gateway: $(join "$x")\n"
	x="$(alive_lbs)"; [ -n "$x" ] && leaks="${leaks}load-balancer: $(join "$x")\n"
	x="$(alive_eks)"; [ -n "$x" ] && leaks="${leaks}eks-cluster: ${x}\n"
	x="$(alive_zones)"; [ -n "$x" ] && leaks="${leaks}route53-hosted-zone: $(join "$x")\n"
	x="$(alive_acm_certs)"; [ -n "$x" ] && leaks="${leaks}acm-certificate: $(join "$x")\n"
	# The data + managed services. Aurora is the single most expensive survivor a killed run can
	# leave, and until this change nothing here was looked at even once.
	x="$(alive_rds_clusters)"; [ -n "$x" ] && leaks="${leaks}rds-cluster: $(join "$x")\n"
	x="$(alive_rds_instances)"; [ -n "$x" ] && leaks="${leaks}rds-instance: $(join "$x")\n"
	x="$(alive_elasticache)"; [ -n "$x" ] && leaks="${leaks}elasticache-replication-group: $(join "$x")\n"
	x="$(alive_ddb_tables)"; [ -n "$x" ] && leaks="${leaks}dynamodb-table: $(join "$x")\n"
	x="$(alive_s3_buckets)"; [ -n "$x" ] && leaks="${leaks}s3-bucket: $(join "$x")\n"
	x="$(alive_ecr_repos)"; [ -n "$x" ] && leaks="${leaks}ecr-repository: $(join "$x")\n"
	x="$(alive_secrets)"; [ -n "$x" ] && leaks="${leaks}secretsmanager-secret: $(join "$x")\n"
	x="$(alive_sqs_queues)"; [ -n "$x" ] && leaks="${leaks}sqs-queue: $(join "$x")\n"
	x="$(alive_sns_topics)"; [ -n "$x" ] && leaks="${leaks}sns-topic: $(join "$x")\n"
	x="$(alive_kms_keys)"; [ -n "$x" ] && leaks="${leaks}kms-key: $(join "$x")\n"

	# ── Surviving network is a LEAK, not a notice. ──
	# It used to be a `::notice::` on the reasoning that subnets and VPCs are free. They are, but
	# that is not what a surviving subnet MEANS: these deletes only fail while something still holds
	# an ENI in them, and the things that hold ENIs — RDS, ElastiCache, a load balancer, a lingering
	# ENI of any kind — are exactly the billable survivors. So the one signal that something
	# expensive is still alive was being printed as an FYI and the step exited 0. It is also the
	# only signal left when the billable holder is a type this script does not model at all.
	#
	# ⚠️ It does NOT say an ENI is the cause. It used to — "SOMETHING STILL HOLDS AN ENI" — and that
	# sent the investigation of the July leak to a dead end: `describe-network-interfaces` on the
	# surviving VPC returned NOTHING, because the real holders were a VPC endpoint and a pair of
	# mutually-referencing security groups, neither of which is an ENI. A diagnosis the script never
	# measured, printed as fact, is worse than no diagnosis. Name what survived; let the operator
	# find out why.
	x="$(alive_network)"; [ -n "$x" ] && leaks="${leaks}network(vpc/subnet/eni/sg/rt/igw — still present; check ENIs, VPC endpoints and cross-referencing SG rules): $(join "$x")\n"

	if [ -n "$leaks" ]; then
		echo "  ✗ resources still alive:" >&2
		printf '%b' "  $leaks" >&2
		echo "::error::aws cleanup INCOMPLETE — resources for run ${ENV} still exist (billable, or network still held by something billable). Investigate + remove (stay scope-locked; never account-wide)." >&2
		return 1
	fi
	return 0
}

# ── finalize_verification — THE EXIT-CODE CONTRACT.
#
#   0  every probe answered, and nothing billable for this run survived.
#   1  a LEAK: the API listed something that is still standing and billing.
#   4  UNVERIFIABLE: at least one probe could not answer. Nothing here proves the account is empty,
#      and this step is the `always()` guarantee test/e2e/t2_provision_test.go defers to — so
#      "could not look" has to be a red step, not a line in a log nobody reads.
#
# A confirmed leak outranks "could not check", so verify_swept runs first.
finalize_verification() {
	if ! verify_swept; then
		return 1
	fi
	probe_gate aws "run ${ENV}" || return 4
	# probe_clean_suffix is EMPTY on a genuinely clean run and carries any UNATTRIBUTABLE finding
	# otherwise, so this sentence can never read as "the account is empty" when it is not. Shared
	# by all five sweepers — the taxonomy is one contract, not five that drift.
	echo "✓ aws cleanup verified complete for run ${ENV} — no billable resources remain$(probe_clean_suffix)"
	return 0
}

# ── sweep_env <env> — the full scope-locked sweep + verify for ONE run's ENV. Sets the
#    ENV/PROJECT_ID_TAG/CLUSTER globals the sweep functions read, then runs them in the same strict
#    dependency order as the normal path. Returns verify_swept's status (0 clean / 1 leak); DRY_RUN
#    lists only and returns 0. Used by PREFLIGHT to sweep each discovered prior-run orphan. ──
sweep_env() {
	ENV="$1"
	PROJECT_ID_TAG="e2e-${ENV}"
	CLUSTER=""
	assert_scope
	discover_cluster
	sweep_instances
	sweep_load_balancers
	sweep_eks
	sweep_data_services
	sweep_nat_and_eips
	sweep_volumes
	sweep_network
	sweep_managed_services
	sweep_acm
	sweep_route53
	sweep_litter
	[ "$DRY_RUN" = "1" ] && return 0
	verify_swept
}

# ── classify_arn — is this leftover resource actually COSTING anything? Echoes exactly one of
#    TERMINATING | FREE | BILLING.
#
#    #2485 aftermath: the preflight used to call every project-id-tagged resource a billing orphan.
#    It is not. Two whole classes are not leaks at all —
#
#      * TERMINATING — a KMS key in PendingDeletion is a teardown that WORKED. AWS enforces a 7-30
#        day waiting period, does not bill the key during it, and REFUSES to delete it sooner. There
#        is no action to take and no faster path; reporting it as an unswept leak is just wrong.
#      * FREE — IAM policies/roles/OIDC providers, EC2 launch templates, RDS subnet groups,
#        EventBridge rules and an empty log group cost nothing. They are litter (see the sweep
#        below, which now removes them), not spend.
#
#    Everything else is BILLING. That default direction is the point: the FREE set is an ALLOWLIST,
#    so a resource type we have never seen before still alarms the first time it leaks, instead of
#    being silently absolved. Getting this backwards is how a sweep reported "load balancers: none"
#    while one billed (#2460). ──
classify_arn() {
	local arn="$1" svc restype keyid state bytes
	svc="$(printf '%s' "$arn" | cut -d: -f3)"
	restype="$(printf '%s' "$arn" | cut -d: -f6 | cut -d/ -f1)"

	case "${svc}:${restype}" in
	kms:key)
		keyid="${arn##*/}"
		state="$(aws kms describe-key --key-id "$keyid" --region "$REGION" \
			--query 'KeyMetadata.KeyState' --output text 2>/dev/null || true)"
		case "$state" in
		PendingDeletion | PendingReplicaDeletion) printf 'TERMINATING\n' ;;
		# An ENABLED customer-managed key is ~$1/month and IS a real leak. Unknown state (the
		# describe failed) is billing too — never absolve what we could not read.
		*) printf 'BILLING\n' ;;
		esac
		;;
	iam:policy | iam:role | iam:oidc-provider | iam:instance-profile) printf 'FREE\n' ;;
	ec2:launch-template | rds:subgrp | events:rule) printf 'FREE\n' ;;
	# A PUBLIC ACM certificate is $0 — AWS charges nothing to issue, validate or renew one; only
	# ACM Private CA costs money, and this template requests no private CA. Priced before it was
	# classified, because the failure this list exists to prevent is the opposite one: #2485 spent
	# ten weeks calling 28 free resources "UNSWEPT and BILLING".
	#
	# FREE does NOT mean "leave it". sweep_acm reclaims it and verify_swept confirms it is gone —
	# a per-run wildcard certificate that nothing reclaims still accumulates against the account
	# quota. This entry decides only whether the PREFLIGHT raises a cost alarm about another run's
	# leftovers, and raising one over $0 is how a real alarm stops being read.
	acm:certificate) printf 'FREE\n' ;;
	logs:log-group)
		# Storage is the only charge; an empty group is free. Bytes unreadable ⇒ assume billing.
		bytes="$(aws logs describe-log-groups --region "$REGION" \
			--log-group-name-prefix "$(printf '%s' "$arn" | cut -d: -f7)" \
			--query 'logGroups[0].storedBytes' --output text 2>/dev/null || true)"
		if [ "$bytes" = "0" ]; then printf 'FREE\n'; else printf 'BILLING\n'; fi
		;;
	*) printf 'BILLING\n' ;;
	esac
}

# ── classify_orphan_envs — every OTHER e2e run's ENV that still has project-id-tagged resources in
#    this region, each with the worst class among its resources. Emits `<env>\t<class>` lines.
#
#    Discovery reads LIVE RESOURCES (get-resources), not the tag-value index. `get-tag-values`
#    returns every value the key has EVER carried in a region and keeps returning it after the last
#    resource is gone — it reported 30 "orphans" here including one, e2e-local946c3d09, with zero
#    resources attached, and the list could only ever grow (#2485). This is the shape gcp-cleanup.sh
#    has always used: enumerate the inventory, not a history of names.
#
#    Every existing safety guard is unchanged — `e2e-` prefix only (never a real prod project-id),
#    EXCLUDES this run (SELF_ENV), and the same specificity + prod/shared denylist as the
#    top-of-file ENV guards. This narrows what is REPORTED; it never widens what is SWEPT. ──
classify_orphan_envs() {
	local arn v oenv cls rows
	# ⚠️ THROUGH probe_run, NOT a raw call with `2>/dev/null` — this is the ONLY discovery the
	# preflight has, and it is the exact laundering this file's header names: the redirect ate the
	# reason and the pipe replaced the tagging API's status with `read`'s, so an expired session or
	# a throttled `get-resources` produced empty output and exit 0. That is byte-identical to "this
	# region holds no orphans", and it is what let the reaper publish a clean BILLING account it had
	# never looked at. probe_run retries, keeps the call's REAL status, and records UNVERIFIABLE
	# when it never answered — which probe_report_discovery then reports at the preflight's exits.
	rows="$(probe_run orphan-scan aws resourcegroupstaggingapi get-resources --region "$REGION" \
		--tag-filters "Key=alethia:project-id" \
		--query 'ResourceTagMappingList[].[ResourceARN,Tags[?Key==`alethia:project-id`].Value|[0]]' \
		--output text || true)"
	printf '%s\n' "$rows" | while IFS=$'\t' read -r arn v; do
		[ -n "$arn" ] && [ -n "$v" ] || continue
		case "$v" in e2e-*) ;; *) continue ;; esac # e2e-prefixed values only — never prod project-ids
		oenv="${v#e2e-}"
		[ "$oenv" = "$SELF_ENV" ] && continue # skip THIS run (its own teardown handles it)
		printf '%s' "$oenv" | grep -Eq '^[a-z0-9][a-z0-9._-]{4,62}$' || continue
		case "$oenv" in
		prod | prod-* | production | production-* | staging | staging-* | main | alethia | alethia-* | data) continue ;;
		esac
		cls="$(classify_arn "$arn")"
		printf '%s\t%s\n' "$oenv" "$cls"
	done | sort -u | awk -F'\t' '
		# Worst class wins per env: BILLING > TERMINATING > FREE.
		{ rank = ($2 == "BILLING") ? 3 : ($2 == "TERMINATING") ? 2 : 1
		  if (rank > best[$1]) { best[$1] = rank; cls[$1] = $2 } }
		END { for (e in cls) printf "%s\t%s\n", e, cls[e] }
	' | sort
}

# ── list_orphan_envs — the envs the preflight must actually SWEEP: those holding at least one
#    BILLING resource. Empty output ⇒ nothing is costing money. ──
list_orphan_envs() {
	classify_orphan_envs | awk -F'\t' '$2 == "BILLING" { print $1 }'
}

# ── PREFLIGHT: sweep prior-run e2e orphans (NOT this run), best-effort + loud. ──
SELF_ENV="$ENV"
if [ "$PREFLIGHT" = "1" ]; then
	echo "→ aws STALE PREFLIGHT in ${REGION}: sweeping prior-run e2e orphans (excludes this run ${SELF_ENV})"
	[ "$DRY_RUN" = "1" ] && echo "  (DRY_RUN=1 — listing only, deleting nothing)"
	classified="$(classify_orphan_envs || true)"
	orphans="$(printf '%s\n' "$classified" | awk -F'\t' '$2 == "BILLING" { print $1 }')"

	# Named, and explicitly NOT a leak. Silence here would be its own defect: these envs DO have
	# leftovers, and a reader who sees nothing cannot tell "checked, benign" from "never looked".
	benign="$(printf '%s\n' "$classified" | awk -F'\t' 'NF && $2 != "BILLING" { printf "%s (%s) ", $1, $2 }')"
	if [ -n "$benign" ]; then
		echo "::notice::preflight: prior-run leftovers that cost nothing — ${benign}"
		echo "  TERMINATING = a KMS key already scheduled for deletion. AWS enforces a 7-30 day"
		echo "  waiting period, does not bill during it, and refuses to delete sooner — there is no"
		echo "  action to take. FREE = IAM policy/role/OIDC provider, launch template, RDS subnet"
		echo "  group, EventBridge rule, empty log group. The sweep clears the FREE litter below."
	fi

	if [ -z "$orphans" ]; then
		# ── REPORT BEFORE THE EARLY RETURN. ────────────────────────────────────────────────────
		#
		# This branch is reached BOTH when discovery answered "nothing" and when discovery never
		# answered at all — an expired session or a throttled API yields an empty orphan list, and
		# the ✓ line below then prints over an account nobody looked at, exit 0, with the
		# `probe_warn_unverifiable` call at the bottom of this block never reached. That log is
		# byte-identical to a genuinely empty account, and scripts/e2e/reaper-result.mjs recorded it
		# as `clean` — evidence about resources that BILL.
		#
		# hcloud-cleanup.sh has always reported here; the other four did not. See
		# scripts/e2e/lib/sweep-probe.sh's probe_report_discovery header for why the marker is
		# positive rather than another warning.
		probe_report_discovery aws "the preflight orphan scan in ${REGION}"
		echo "✓ preflight: no BILLING prior-run e2e orphans in ${REGION} — nothing to sweep"
		exit 0
	fi
	# shellcheck disable=SC2086
	echo "  orphan run ENVs found: $(printf '%s ' $orphans)"
	echo "  budget: ${PREFLIGHT_BUDGET_SECONDS}s wall-clock, at most ${PREFLIGHT_MAX_ENVS} orphan(s) this run"
	residual=0
	attempted=0
	deadline=$(($(date +%s) + PREFLIGHT_BUDGET_SECONDS))
	# Anything the bounds stop us from reaching is named, not silently dropped. Everything in
	# $orphans is BILLING by construction now (classify_orphan_envs), so "we ran out of budget"
	# genuinely does mean money is still being spent — which is what makes the ::error:: below
	# honest. It used to fire for KMS keys mid-deletion and free IAM litter, 28 of them, on every
	# single nightly (#2485).
	skipped=""
	while IFS= read -r oenv; do
		[ -n "$oenv" ] || continue
		if [ "$attempted" -ge "$PREFLIGHT_MAX_ENVS" ]; then
			skipped="${skipped}${oenv} (cap) "
			continue
		fi
		now=$(date +%s)
		if [ "$now" -ge "$deadline" ]; then
			skipped="${skipped}${oenv} (budget) "
			continue
		fi
		attempted=$((attempted + 1))
		echo "── preflight sweep: prior run ${oenv} (${attempted}/${PREFLIGHT_MAX_ENVS}, $((deadline - now))s budget left) ──"
		if ! sweep_env "$oenv"; then
			echo "::warning::preflight could not fully sweep prior-run orphan ${oenv} (still billing) — the always() teardown / next preflight will retry. NOT failing this provisioning run."
			residual=1
		fi
	done <<<"$orphans"
	if [ -n "$skipped" ]; then
		# ::error:: (not ::warning::) because a bounded preflight that keeps deferring the SAME
		# orphan every night is how 29558347776-1 survived long enough to eat a job cap. This is
		# the signal that a human has to sweep it by hand; it still does not fail the step.
		echo "::error::preflight left orphan(s) UNSWEPT and BILLING — bounds reached before they were reached: ${skipped}"
		echo "::error::sweep by hand, scope-locked: ALETHIA_E2E_ENV=<env> ALETHIA_E2E_REGION=${REGION} ./scripts/e2e/aws-cleanup.sh"
		residual=1
	fi
	if [ "$residual" = "1" ]; then
		echo "⚠ preflight finished with residual orphans (see above) — continuing (best-effort, non-fatal)"
	else
		# ⚠️ Not "the account is clean" — "every orphan this preflight could SEE is swept".
		# The discovery listings can fail too, and preflight is explicitly non-blocking, so
		# the honest report here is a warning; the always() teardown is what gates.
		probe_report_discovery aws "the preflight orphan scan in ${REGION}"
		echo "✓ preflight complete — all prior-run e2e orphans in ${REGION} swept"
	fi
	exit 0 # preflight never blocks the provisioning run
fi

# ── Self-test. Stubs `aws` so discovery runs with no cloud and no credentials. Asserts BOTH
# directions: an LB carrying THIS run's cluster tag resolves it, and one carrying another run's
# does not — a one-directional test here would pass just as happily with the fallback deleted. ──
if [ "$SELF_TEST" = "1" ]; then
	st_fails=0
	st_lb="arn:aws:elasticloadbalancing:us-east-1:0:loadbalancer/net/k8s-ingressn/abc"

	# $ST_LB_CLUSTER is the `elbv2.k8s.aws/cluster` tag value the stub reports. Everything else
	# answers empty — i.e. the cluster and every instance are already gone, the leak's real shape.
	# ⚠️ QUERY-AWARE, and that is the point. Keying only on "$1 $2" made the stub answer the same
	# thing whatever the --query said, so NEITHER new JMESPath was exercised: replacing the tag key
	# with one that does not exist, or the discovery projection with a nonsense one, left all thirty
	# cases green — including the one named "alive_lbs reports a classic ELB". Since the defect
	# being fixed was READING THE WRONG AWS SERVICE, "the query selects on the right thing" is the
	# property most worth pinning.
	#
	# It is not a JMESPath evaluator and does not pretend to be. It checks the two load-bearing
	# parts a mutation would break — which tag key the expression filters on, and which field it
	# projects — and answers empty otherwise, which is what AWS returns for a query that matches
	# nothing.
	st_query() { # echo the --query argument out of an argv
		while [ "$#" -gt 0 ]; do
			[ "$1" = "--query" ] && { printf '%s' "${2:-}"; return 0; }
			shift
		done
	}
	# Named, and `aws` is a one-line shim onto it. A case that needs its own stub (a failing
	# describe, say) restores this one with `st_aws_restore` — `unset -f aws` would leave every
	# LATER case running against the real CLI, which silently answers nothing and turns their
	# assertions into vacuous passes.
	st_aws_main() {
		local q
		q="$(st_query "$@")"
		case "$1 ${2:-}" in
		"elbv2 describe-load-balancers") printf '%s\n' "$st_lb" ;;
		# The elbv2 arm asks the SAME two questions the classic arm below does, and for the same
		# reason: answering $ST_LB_CLUSTER whatever the --query said left this service exactly as
		# blind as the defect being fixed. Measured: with an unconditional answer, replacing the
		# discovery tag key with THIS-TAG-DOES-NOT-EXIST, or cluster_lb_arns' scope predicate
		# `Value=='${CLUSTER}'` with a nonsense literal, left ALL cases green — including the one
		# named "LB tag for THIS run resolves the cluster". The scope predicate is what decides
		# which balancers get deleted, so it is the last expression that should be unpinned.
		"elbv2 describe-tags")
			case "$q" in
			*"elbv2.k8s.aws/cluster"*)
				case "$q" in
				# cluster_lb_arns' SCOPE PREDICATE — `… && Value=='<cluster>'`. It decides which
				# balancers get DELETED, so the stub compares the literal it was given against the
				# tag this balancer actually carries: a predicate naming another run's cluster
				# matches nothing, which is the whole safety property. Answering unconditionally
				# let that literal be replaced with a nonsense string unnoticed.
				*"&& Value=='"*)
					# `if`, NOT `[ -n … ] && case`. That form is the LAST command in this arm, so
					# an unset ST_LB_CLUSTER made the test fail and st_aws_main return 1 — a FAKE
					# API FAILURE. Real AWS answers exit 0 with empty output when a JMESPath
					# predicate matches nothing. Three cases set ST_LB_CLUSTER="" with CLUSTER
					# non-empty, so cluster_lb_arns burned its retries and wrote a spurious
					# UNVERIFIABLE: the elbv2 half of sweep_load_balancers reached its verdict
					# through a stubbed outage rather than through the predicate under test, which
					# is the "green for the wrong reason" these positive controls exist to catch.
					if [ -n "$ST_LB_CLUSTER" ]; then
						case "$q" in
						*"&& Value=='${ST_LB_CLUSTER}'"*) printf '%s\n' "cluster=${ST_LB_CLUSTER}" ;;
						esac
					fi
					;;
				# Discovery projects `.Value` to learn the cluster NAME. A separate answer from the
				# predicate above, so neither can stand in for the other under mutation.
				*.Value*) printf '%s\n' "$ST_LB_CLUSTER" ;;
				esac
				;;
			esac
			;;
		# The CLASSIC service answers separately, because it IS a separate service — the whole
		# defect this stub now covers was `elb` and `elbv2` being treated as one.
		"elb describe-load-balancers")
			# `LoadBalancers[]` is the ELBv2 shape; against the classic API it selects nothing.
			case "$q" in
			*LoadBalancerDescriptions*) printf '%s\n' "$ST_CLASSIC_LB" ;;
			esac
			;;
		"elb describe-tags")
			# A query that does not filter on the cluster tag key matches no tag at all.
			case "$q" in
			*"kubernetes.io/cluster/"*)
				# Discovery projects the KEY (to learn the cluster name); the sweep projects the
				# VALUE (owned/shared). Answering both with one fixture let `.Value` be mutated to
				# `.Key` unnoticed.
				case "$q" in
				*.Key) printf '%s\n' "$ST_CLASSIC_TAG_KEY" ;;
				*.Value) printf '%s\n' "$ST_CLASSIC_TAG_VALUE" ;;
				esac
				;;
			esac
			;;
		*) : ;;
		esac
	}
	st_aws_restore() { aws() { st_aws_main "$@"; }; }
	st_aws_restore

	st_case() { # <name> <lb cluster tag> <expected CLUSTER>
		CLUSTER=""
		ST_LB_CLUSTER="$2"
		ST_CLASSIC_LB=""
		ST_CLASSIC_TAG_KEY=""
		ST_CLASSIC_TAG_VALUE=""
		discover_cluster >/dev/null 2>&1
		if [ "$CLUSTER" = "$3" ]; then
			echo "  ✓ $1"
		else
			echo "  ✗ $1 — expected CLUSTER='$3', got '$CLUSTER'" >&2
			st_fails=$((st_fails + 1))
		fi
	}

	echo "→ aws-cleanup.sh self-test (ENV=${ENV})"
	st_case "LB tag for THIS run resolves the cluster" "eks-ue1-${ENV}-alethia-nl" "eks-ue1-${ENV}-alethia-nl"
	st_case "LB tag for ANOTHER run is ignored" "eks-ue1-99999999-9-alethia-nl" ""
	st_case "no LB tag at all leaves CLUSTER unset" "" ""

	# ── CLASSIC ELBs. `elb` and `elbv2` are two AWS services, and this script called only the
	# second — so an ingress-nginx `Service: LoadBalancer`, which the in-tree provider creates as a
	# CLASSIC ELB, was invisible to discovery, to the sweep and to verify_swept. Two of them were
	# found alive by hand on 2026-08-30, one after surviving four preflight sweeps.
	st_classic_case() { # <name> <classic lb name> <its cluster tag KEY suffix> <expected CLUSTER>
		CLUSTER=""
		ST_LB_CLUSTER=""
		ST_CLASSIC_LB="$2"
		ST_CLASSIC_TAG_KEY="kubernetes.io/cluster/$3"
		ST_CLASSIC_TAG_VALUE="owned"
		discover_cluster >/dev/null 2>&1
		if [ "$CLUSTER" = "$4" ]; then
			echo "  ✓ $1"
		else
			echo "  ✗ $1 — expected CLUSTER='$4', got '$CLUSTER'" >&2
			st_fails=$((st_fails + 1))
		fi
	}
	st_classic_case "classic ELB tag for THIS run resolves the cluster" \
		"a19d04c70d3934e4996ce17cb9ae9ea6" "eks-ue1-${ENV}-alethia-nl" "eks-ue1-${ENV}-alethia-nl"
	# BOTH DIRECTIONS: another run's classic ELB must not widen this run's scope, or a sweep would
	# delete a live cluster's load balancer. Same-cloud runs are serialized, but that is a schedule,
	# not a guarantee this script may lean on.
	st_classic_case "classic ELB tag for ANOTHER run is ignored" \
		"a8a8791a7a6b249319f24b2e2b727584" "eks-ue1-99999999-9-alethia-nl" ""

	# And the sweep + verification must SEE one once the cluster is known — discovery alone was
	# never the gap. alive_lbs is what makes verify_swept refuse a green exit, and it read one
	# service.
	CLUSTER="eks-ue1-${ENV}-alethia-nl"
	ST_LB_CLUSTER=""
	ST_CLASSIC_LB="a19d04c70d3934e4996ce17cb9ae9ea6"
	ST_CLASSIC_TAG_KEY="kubernetes.io/cluster/eks-ue1-${ENV}-alethia-nl"
	ST_CLASSIC_TAG_VALUE="owned"
	if alive_lbs 2>/dev/null | grep -q "a19d04c70d3934e4996ce17cb9ae9ea6"; then
		echo "  ✓ alive_lbs reports a classic ELB, so verify_swept cannot exit green over one"
	else
		echo "  ✗ alive_lbs is blind to classic ELBs — a billing load balancer would read as swept" >&2
		st_fails=$((st_fails + 1))
	fi

	# ── THE DELETE HALF. Discovery and alive_lbs are both covered above; nothing asserted that the
	# sweep actually deletes THIS run's classic ELB, or — far more dangerous — that it leaves
	# ANOTHER run's alone. The discovery cases observe that both-directions discipline already, and
	# for the strongest possible reason: on 2026-08-30 this sweeper, pointed at a live run's scope,
	# deleted that run's EKS cluster mid-apply. A sweeper's "does NOT delete" case is not symmetry
	# for its own sake.
	#
	# DRY_RUN, so `retry_delete` announces instead of calling. The stub answers no `aws` at all for
	# a delete, so a regression that got past DRY_RUN would still touch nothing.
	st_classic_sweep_case() { # <name> <lb name> <tag value for OUR cluster> <expect: deleted|kept>
		local out st_prev_dry="$DRY_RUN"
		CLUSTER="eks-ue1-${ENV}-alethia-nl"
		ST_LB_CLUSTER=""
		ST_CLASSIC_LB="$2"
		ST_CLASSIC_TAG_KEY="kubernetes.io/cluster/eks-ue1-${ENV}-alethia-nl"
		# Empty = this balancer carries no `kubernetes.io/cluster/<ours>` tag, which is exactly what
		# the query returns for a balancer belonging to a different run.
		ST_CLASSIC_TAG_VALUE="$3"
		DRY_RUN=1
		out="$(sweep_load_balancers 2>/dev/null || true)"
		DRY_RUN="$st_prev_dry"
		local saw="kept"
		printf '%s' "$out" | grep -q "classic-elb $2" && saw="deleted"
		# ⚠️ POSITIVE CONTROL, and the `kept` case is why it is not optional. That case passes on
		# the ABSENCE of a line, and the capture above discards both stderr and the exit status —
		# so "the sweep correctly skipped this balancer" and "sweep_load_balancers aborted before
		# it ever got there" rendered identically as ✓. Requiring the summary line the classic
		# branch always prints separates them: the sweep must have RUN and REACHED its verdict, and
		# the verdict must be the counted one, not merely a missing delete line.
		local want_summary="· classic load balancers: none"
		[ "$4" = "deleted" ] && want_summary="· classic load balancers: 1 to delete"
		if ! printf '%s' "$out" | grep -qF "$want_summary"; then
			echo "  ✗ $1 — the sweep never reached its classic-ELB verdict (wanted \"${want_summary}\"); " \
				"an absent delete line proves nothing here" >&2
			st_fails=$((st_fails + 1))
			return
		fi
		if [ "$saw" = "$4" ]; then
			echo "  ✓ $1"
		else
			echo "  ✗ $1 — expected the sweep to have $4 it, but it $saw it" >&2
			st_fails=$((st_fails + 1))
		fi
	}
	# ── THE ELBv2 SWEEP'S SCOPE PREDICATE. The classic cases below cover `elb`; nothing covered
	# `elbv2`, so cluster_lb_arns' `&& Value=='${CLUSTER}'` — the predicate that decides which
	# balancers get DELETED in a shared account holding prod — was unpinned. Measured: replacing
	# that literal with a nonsense string left every case green. This is the one expression in the
	# file where a false positive deletes someone else's load balancer.
	st_v2_sweep_case() { # <name> <the tag THIS balancer carries> <expect: deleted|kept>
		local out st_prev_dry="$DRY_RUN"
		CLUSTER="eks-ue1-${ENV}-alethia-nl"
		ST_LB_CLUSTER="$2"
		ST_CLASSIC_LB=""
		ST_CLASSIC_TAG_KEY=""
		ST_CLASSIC_TAG_VALUE=""
		DRY_RUN=1
		out="$(sweep_load_balancers 2>/dev/null || true)"
		DRY_RUN="$st_prev_dry"
		local saw="kept"
		printf '%s' "$out" | grep -q "would delete elb " && saw="deleted"
		# Same positive control as the classic pair, for the same reason: the `kept` verdict is an
		# ABSENCE, and an aborted sweep is absent too.
		local want_summary="· load balancers: none"
		[ "$3" = "deleted" ] && want_summary="· load balancers: 1 to delete"
		if ! printf '%s' "$out" | grep -qF "$want_summary"; then
			echo "  ✗ $1 — the sweep never reached its elbv2 verdict (wanted \"${want_summary}\")" >&2
			st_fails=$((st_fails + 1))
			return
		fi
		if [ "$saw" = "$3" ]; then
			echo "  ✓ $1"
		else
			echo "  ✗ $1 — expected the sweep to have $3 it, but it $saw it" >&2
			st_fails=$((st_fails + 1))
		fi
	}
	st_v2_sweep_case "this run's ELBv2 is deleted" "eks-ue1-${ENV}-alethia-nl" "deleted"
	st_v2_sweep_case "ANOTHER run's ELBv2 is NOT deleted" "eks-ue1-99999999-9-alethia-nl" "kept"

	# ── AND THE CLASSIC DESCRIBE THAT DOES NOT ANSWER. cluster_classic_lb_names feeds BOTH the
	# sweep and alive_lbs → verify_swept, so its error handling decides whether a live balancer can
	# vanish from the leak list. Nothing exercised a failing `elb describe-tags`, which is why
	# reverting it to probe_run left the suite green — the same untested-fix shape as the discovery
	# cases below.
	st_classic_probe_case() { # <name> <rc> <stderr> <expect unverifiable: yes|no> <expect in leaks: yes|no>
		probe_reset
		CLUSTER="eks-ue1-${ENV}-alethia-nl"
		ST_CLASSIC_LB="a19d04c70d3934e4996ce17cb9ae9ea6"
		ST_LB_CLUSTER=""
		local unv=no seen=no names
		aws() {
			case "$1 ${2:-}" in
			"elb describe-load-balancers") printf '%s\n' "$ST_CLASSIC_LB" ;;
			"elb describe-tags") printf '%s\n' "$ST_CLASSIC_ERR" >&2; return "$ST_CLASSIC_RC" ;;
			*) : ;;
			esac
		}
		ST_CLASSIC_RC="$2" ST_CLASSIC_ERR="$3"
		names="$(cluster_classic_lb_names 2>/dev/null || true)"
		st_aws_restore
		probe_has_unverifiable && unv=yes
		printf '%s' "$names" | grep -q "$ST_CLASSIC_LB" && seen=yes
		if [ "$unv" = "$4" ] && [ "$seen" = "$5" ]; then
			echo "  ✓ $1"
		else
			echo "  ✗ $1 — expected unverifiable=$4/in-leaks=$5, got unverifiable=${unv}/in-leaks=${seen}" >&2
			st_fails=$((st_fails + 1))
		fi
	}
	st_classic_probe_case "a LoadBalancerNotFound on the classic describe is an ANSWER — no false red" \
		255 "An error occurred (LoadBalancerNotFound) when calling the DescribeTags operation" no no
	st_classic_probe_case "a THROTTLE on the classic describe is UNVERIFIABLE, not 'not ours'" \
		254 "An error occurred (Throttling) when calling the DescribeTags operation: Rate exceeded" yes no
	# ⚠️ The finding that made probe_confirm_re necessary: this 404 matches THREE alternatives of
	# looks_gone, so plain probe_confirm resolves it CLEAN and a live, billing classic ELB drops out
	# of alive_lbs on a run that exits 0.
	st_classic_probe_case "a 404 through a proxy is UNVERIFIABLE — it must not read as 'not ours'" \
		254 "An error occurred (404) when calling the DescribeTags operation: Not Found" yes no

	st_classic_sweep_case "this run's classic ELB is deleted" \
		"a19d04c70d3934e4996ce17cb9ae9ea6" "owned" "deleted"
	st_classic_sweep_case "ANOTHER run's classic ELB is NOT deleted" \
		"a8a8791a7a6b249319f24b2e2b727584" "" "kept"

	CLUSTER=""
	# ── DISCOVERY THAT DOES NOT ANSWER (#3492). ──────────────────────────────────────────────────
	#
	# Every case above varies what the API SAYS. None varies whether it answers at all — and the
	# whole claim of the probe wiring in discover_cluster is about what happens when it does not.
	# Measured before this block existed: reverting every probe_run / probe_confirm_re in
	# discover_cluster to a bare `aws … 2>/dev/null` left the self-test entirely green, so CI could
	# not stop this regressing to the state #3437 shipped.
	#
	# The distinction being pinned costs money in BOTH directions:
	#   · a THROTTLE leaves CLUSTER="" — and CLUSTER is the SCOPE, so an unrecorded one makes
	#     alive_lbs empty and finalize_verification exits 0 over a live load balancer;
	#   · a LoadBalancerNotFound on a PER-RESOURCE describe is an ANSWER, and recording it as
	#     UNVERIFIABLE reds an otherwise clean teardown over another run's already-deleted balancer.
	# A test asserting only the first is satisfied by reverting to probe_run; only the second one
	# distinguishes probe_confirm_re from it.
	#
	# $ST_DISC_ON selects WHICH call fails, because "the list fails" and "one per-resource describe
	# fails" are different states and the second cannot be reached by failing everything.
	st_disc_aws() {
		case "$ST_DISC_ON" in
		all) ;;
		describe-tags)
			# BOTH lists answer; only the per-resource describes fail. The classic list used to
			# fall through to `*) return 0` — exit 0 with no output — so discover_cluster's while
			# loop over it had nothing to iterate and the THIRD fallback's `elb describe-tags`
			# (the classic one) executed in NO case at all. That is precisely how a bare
			# probe_confirm survived there through four green discovery cases.
			case "$1 ${2:-}" in
			*"describe-tags") ;;
			"elbv2 describe-load-balancers") printf '%s\n' "$st_lb"; return 0 ;;
			"elb describe-load-balancers") printf '%s\n' "$ST_CLASSIC_LB"; return 0 ;;
			*) return 0 ;;
			esac
			;;
		classic-describe-tags)
			# The elbv2 half answers COMPLETELY and resolves no cluster, so discovery falls all the
			# way through to the classic describe-tags — the one call the mode above still reaches
			# only incidentally. Failing exactly this call is what makes the two classic outcomes
			# (an ANSWER vs a failure to look) separable, which is the whole point of the split.
			case "$1 ${2:-}" in
			"elb describe-tags") ;;
			"elbv2 describe-load-balancers") printf '%s\n' "$st_lb"; return 0 ;;
			"elbv2 describe-tags") return 0 ;;
			"elb describe-load-balancers") printf '%s\n' "$ST_CLASSIC_LB"; return 0 ;;
			*) return 0 ;;
			esac
			;;
		*)
			# No silent default. An unrecognised mode used to mean "every call fails", which passes
			# vacuously in any case expecting unverifiable=yes while testing a different state
			# entirely — a typo'd mode argument would never be noticed.
			echo "st_disc_aws: unknown ST_DISC_ON='${ST_DISC_ON}'" >&2
			exit 1
			;;
		esac
		printf '%s\n' "${ST_DISC_ERR}" >&2
		return "${ST_DISC_RC}"
	}
	st_discovery_probe_case() { # <name> <which call fails> <rc> <stderr> <expect unverifiable>
		probe_reset
		CLUSTER=""
		ST_DISC_ON="$2" ST_DISC_RC="$3" ST_DISC_ERR="$4"
		# Set HERE, not inherited from whichever block ran last: the classic fallback is only
		# reachable when the classic LIST answers, so leaving this to a previous block's leftover
		# makes a case's reachability depend on test ORDER.
		ST_CLASSIC_LB="a19d04c70d3934e4996ce17cb9ae9ea6"
		local unv=no
		aws() { st_disc_aws "$@"; }
		discover_cluster >/dev/null 2>&1 || true
		st_aws_restore
		probe_has_unverifiable && unv=yes
		# CLUSTER must be empty either way. That is not the property under test — it is the
		# precondition that makes the LEDGER ENTRY the only difference between the two outcomes.
		if [ "$unv" = "$5" ] && [ -z "$CLUSTER" ]; then
			echo "  ✓ $1"
		else
			echo "  ✗ $1 — expected unverifiable=$5 with CLUSTER empty, got unverifiable=${unv} CLUSTER='${CLUSTER}'" >&2
			st_fails=$((st_fails + 1))
		fi
	}
	st_discovery_probe_case "a THROTTLED discovery is UNVERIFIABLE, not an empty account" \
		all 254 "An error occurred (Throttling) when calling the DescribeLoadBalancers operation: Rate exceeded" yes
	st_discovery_probe_case "a DENIED discovery is UNVERIFIABLE — 'not allowed to look' is not 'nothing there'" \
		all 254 "An error occurred (UnauthorizedOperation) when calling the DescribeLoadBalancers operation" yes
	# The negative control, and the case a future reader is most likely to "simplify" back to
	# probe_run: this is the entire reason the per-resource describes use probe_confirm_re.
	st_discovery_probe_case "a LoadBalancerNotFound on a per-resource describe is an ANSWER, not a failure to look" \
		describe-tags 255 "An error occurred (LoadBalancerNotFound) when calling the DescribeTags operation" no
	# ── The CLASSIC per-resource describe, which no case above reaches (#3493 review, finding 1).
	# discover_cluster's THIRD fallback is the branch a hard-killed run depends on: the cluster and
	# its instances are gone, an ingress-nginx classic ELB is all that still names the cluster, and
	# the elbv2 scan cannot see it because it is a different service. Its describe-tags used bare
	# probe_confirm, so a 404 through a proxy — three alternatives of the looks_gone union — read
	# as "gone", left CLUSTER="" and took the SCOPE with it: alive_lbs empty, exit 0, live balancer.
	st_discovery_probe_case "a 404 on the CLASSIC discovery describe is UNVERIFIABLE — it must not empty the SCOPE" \
		classic-describe-tags 254 "An error occurred (404) when calling the DescribeTags operation: Not Found" yes
	# The negative control for the same call: LoadBalancerNotFound really is an answer, and reading
	# it as UNVERIFIABLE would red an otherwise clean teardown over another run's deleted balancer.
	st_discovery_probe_case "a LoadBalancerNotFound on the CLASSIC discovery describe is an ANSWER" \
		classic-describe-tags 255 "An error occurred (LoadBalancerNotFound) when calling the DescribeTags operation" no
	# ⚠️ And the shape that motivated probe_confirm_re over plain probe_confirm: looks_gone is a
	# union over every resource kind this sweeper touches, so a 404 through a misrouted endpoint or
	# a proxy hits three of its eleven alternatives. Under probe_confirm that reads as "gone" and
	# the ledger records nothing. It must stay UNVERIFIABLE.
	st_discovery_probe_case "a 404 through a proxy stays UNVERIFIABLE — looks_gone is wider than this call can mean" \
		describe-tags 254 "An error occurred (404) when calling the DescribeTags operation: Not Found" yes
	ST_DISC_ON="" ST_DISC_RC=0 ST_DISC_ERR=""


	# The VPC-scoped security-group discovery. $ST_SGS is what the stub reports for the run's VPC;
	# `default` must never appear in the result, or the sweep would retry an undeletable group forever.
	aws() {
		case "$1 ${2:-}" in
		"resourcegroupstaggingapi get-resources") printf '%s\n' "arn:aws:ec2:us-east-1:0:vpc/vpc-0abc" ;;
		"ec2 describe-security-groups") printf '%s\n' "$ST_SGS" ;;
		*) : ;;
		esac
	}
	st_sg_case() { # <name> <stubbed group ids> <expected, newline-joined>
		ST_SGS="$2"
		local got
		got="$(vpc_security_group_ids 2>/dev/null | tr '\n' ' ')"
		got="${got% }"
		if [ "$got" = "$3" ]; then
			echo "  ✓ $1"
		else
			echo "  ✗ $1 — expected '$3', got '$got'" >&2
			st_fails=$((st_fails + 1))
		fi
	}
	st_sg_case "cluster-created groups in the run's VPC are swept" "sg-k8sing sg-k8straffic" "sg-k8sing sg-k8straffic"
	st_sg_case "a VPC with no extra groups yields nothing" "" ""
	st_aws_restore

	# ── classify_arn. The preflight spent ten weeks calling 28 non-leaks "UNSWEPT and BILLING"
	# (#2485), so the rule now has a test. $ST_KEY_STATE / $ST_LOG_BYTES are what the stub reports.
	aws() {
		case "$1 ${2:-}" in
		"kms describe-key") printf '%s\n' "$ST_KEY_STATE" ;;
		"logs describe-log-groups") printf '%s\n' "$ST_LOG_BYTES" ;;
		*) : ;;
		esac
	}
	st_cls_case() { # <name> <arn> <expected class>
		local got
		got="$(classify_arn "$2" 2>/dev/null)"
		if [ "$got" = "$3" ]; then
			echo "  ✓ $1"
		else
			echo "  ✗ $1 — expected '$3', got '$got'" >&2
			st_fails=$((st_fails + 1))
		fi
	}

	ST_KEY_STATE="PendingDeletion"
	st_cls_case "a KMS key mid-deletion is not a leak" \
		"arn:aws:kms:us-east-1:0:key/eeb6fe0f-036e-41d5-841b-13e9d41a0da9" "TERMINATING"
	ST_KEY_STATE="Enabled"
	st_cls_case "an ENABLED KMS key IS a leak (~\$1/mo)" \
		"arn:aws:kms:us-east-1:0:key/eeb6fe0f-036e-41d5-841b-13e9d41a0da9" "BILLING"
	ST_KEY_STATE=""
	st_cls_case "a KMS key whose state we could not read is billing" \
		"arn:aws:kms:us-east-1:0:key/eeb6fe0f-036e-41d5-841b-13e9d41a0da9" "BILLING"

	st_cls_case "an IAM policy is free" "arn:aws:iam::0:policy/irsa_karpenter2026" "FREE"
	st_cls_case "an IAM OIDC provider is free" "arn:aws:iam::0:oidc-provider/oidc.eks.us-east-1.amazonaws.com/id/AB" "FREE"
	st_cls_case "a launch template is free" "arn:aws:ec2:us-east-1:0:launch-template/lt-071e8f31193797f9e" "FREE"
	st_cls_case "an RDS subnet group is free" "arn:aws:rds:us-east-1:0:subgrp:vpc-ue1-x-alethia-common" "FREE"
	st_cls_case "an EventBridge rule is free" "arn:aws:events:us-east-1:0:rule/alethia-x" "FREE"
	st_cls_case "a public ACM certificate is free (priced, not assumed)" \
		"arn:aws:acm:us-east-1:0:certificate/5db9d00b-0000-0000-0000-000000000000" "FREE"

	ST_LOG_BYTES="0"
	st_cls_case "an empty log group is free" "arn:aws:logs:us-east-1:0:log-group:/aws/eks/x/cluster" "FREE"
	ST_LOG_BYTES="5713053"
	st_cls_case "a log group holding data bills" "arn:aws:logs:us-east-1:0:log-group:/aws/eks/x/cluster" "BILLING"

	# THE case that keeps this honest. The FREE set is an allowlist, so anything we have never
	# classified must come back BILLING — if this ever flips to FREE, a brand-new billable resource
	# type leaks silently, which is #2460's failure re-run.
	st_cls_case "an EKS cluster bills" "arn:aws:eks:us-east-1:0:cluster/eks-ue1-x-alethia" "BILLING"
	st_cls_case "a load balancer bills" "arn:aws:elasticloadbalancing:us-east-1:0:loadbalancer/net/k8s/abc" "BILLING"
	st_cls_case "a NAT gateway bills" "arn:aws:ec2:us-east-1:0:natgateway/nat-0abc" "BILLING"
	st_cls_case "an UNKNOWN resource type bills (fail-closed)" "arn:aws:quantumledger:us-east-1:0:ledger/whatever" "BILLING"
	st_aws_restore

	# ── THE THREE STATES, end to end through verify_swept and the exit code (#3xxx).
	#
	# Every probe in this file used to read `aws … 2>/dev/null | tr | grep -v '^$' || true`. Three
	# launderings: the redirect drops the reason, the pipe substitutes grep's status for the CLI's,
	# and `|| true` normalises what is left. An API that FAILED therefore produced empty stdout and
	# exit 0 — byte-identical to "confirmed gone" — and verify_swept's `[ -n "$x" ]` test read all
	# eighteen resource types as clean at once. A leaked Aurora cluster, NAT gateway or EKS control
	# plane billed while the step printed "verified complete".
	#
	# $ST_OUT and $ST_RC are varied INDEPENDENTLY on purpose. A test that only varies the output
	# passes just as happily with the fix removed, because output is the half that already worked.
	aws() {
		if [ -n "$ST_OUT" ]; then printf '%s\n' "$ST_OUT"; fi
		if [ "$ST_RC" -ne 0 ]; then printf '%s\n' "${ST_ERR:-An error occurred}" >&2; fi
		return "$ST_RC"
	}
	st_verify_case() { # <name> <output> <rc> <expected finalize rc> <expect unverifiable: yes|no>
		probe_reset
		ST_OUT="$2" ST_RC="$3" ST_ERR="An error occurred (ExpiredToken) when calling the operation"
		CLUSTER=""
		local rc=0 unv=no
		finalize_verification >/dev/null 2>&1 || rc=$?
		probe_has_unverifiable && unv=yes
		if [ "$rc" = "$4" ] && [ "$unv" = "$5" ]; then
			echo "  ✓ $1"
		else
			echo "  ✗ $1 — expected rc=$4/unverifiable=$5, got rc=${rc}/unverifiable=${unv}" >&2
			st_fails=$((st_fails + 1))
		fi
	}
	st_verify_case "an empty account, honestly listed, is CLEAN and exits 0" "" 0 0 no
	st_verify_case "a surviving resource is a LEAK and exits 1" "i-0abc123" 0 1 no
	st_verify_case "an API that FAILED is UNVERIFIABLE and exits 4, NOT 0" "" 254 4 yes

	# ── CLOUD PARITY FOR THE FOURTH STATE (#3138 follow-up). ─────────────────────────────────────
	#
	# The four-state taxonomy is ONE contract, in scripts/e2e/lib/sweep-probe.sh. Every sweeper
	# asserts it here rather than trusting that sourcing the library is enough, because the thing
	# that actually breaks is a CALLER — a "✓ verified complete" line that forgot the qualifier, or a
	# finalize_verification reading the wrong ledger. hetzner is the only cloud with an
	# unattributable resource today (the imager upload helpers, #2463); the next one must not have to
	# re-derive the answer, and must not be able to ship the loud half without the non-gating half.
	#
	# BOTH halves, because either alone is satisfiable by the wrong change: an UNATTRIBUTABLE finding
	# must not move the exit code, AND an API failure must still move it to 4.
	st_parity() { # <name> <rc> <the ✓ line (STDOUT) names it: yes|no> <unverifiable: yes|no> <the annotation (STDERR) names it: yes|no>
		local rc=0 out named=no ann=no unv=no errf
		# STDOUT AND STDERR ARE READ SEPARATELY, and that is the point of this helper. The ::warning::
		# goes to stderr and would match either way, so folding them together with 2>&1 would let the
		# ✓ line silently lose its qualifier — "verified complete — no billable resources remain",
		# full stop, over an account that still holds something — and this test would not notice.
		errf="$(mktemp "${TMPDIR:-/tmp}/alethia-st-parity.XXXXXX")"
		out="$(finalize_verification 2>"$errf")" || rc=$?
		case "$out" in *UNATTRIBUTABLE*) named=yes ;; esac
		if grep -q 'UNATTRIBUTABLE' "$errf"; then ann=yes; fi
		rm -f "$errf"
		probe_has_unverifiable && unv=yes
		if [ "$rc" = "$2" ] && [ "$named" = "$3" ] && [ "$unv" = "$4" ] && [ "$ann" = "$5" ]; then
			echo "  ✓ $1"
		else
			echo "  ✗ $1 — expected rc=$2/✓-line=$3/unverifiable=$4/annotation=$5, got rc=${rc}/✓-line=${named}/unverifiable=${unv}/annotation=${ann}" >&2
			st_fails=$((st_fails + 1))
		fi
	}
	probe_reset
	ST_OUT="" ST_RC=0 ST_ERR="" CLUSTER=""
	probe_note_unattributable imager-upload-helpers "unlabelled — cannot be tied to this run"
	st_parity "an UNATTRIBUTABLE finding is reported loudly and does NOT gate" 0 yes no yes
	probe_reset
	ST_OUT="" ST_RC=254 ST_ERR="An error occurred (ExpiredToken) when calling the operation" CLUSTER=""
	probe_note_unattributable imager-upload-helpers "unlabelled — cannot be tied to this run"
	st_parity "…and it never masks an API failure, which still exits 4" 4 no yes yes

	# probe_confirm's split, wired into a real probe rather than only unit-tested in the library.
	# A deleted cluster answers ResourceNotFoundException and that IS the answer "gone"; a throttle
	# is not an answer at all. Conflating them is how an EKS control plane bills unnoticed.
	st_eks_case() { # <name> <stderr> <expect unverifiable: yes|no>
		probe_reset
		ST_OUT="" ST_RC=254 ST_ERR="$2"
		CLUSTER="eks-ue1-${ENV}-alethia-nl"
		local got=no
		alive_eks >/dev/null 2>&1 || true
		probe_has_unverifiable && got=yes
		if [ "$got" = "$3" ]; then
			echo "  ✓ $1"
		else
			echo "  ✗ $1 — expected unverifiable=$3, got ${got}" >&2
			st_fails=$((st_fails + 1))
		fi
	}
	st_eks_case "a NotFound on describe-cluster confirms GONE" \
		"An error occurred (ResourceNotFoundException): No cluster found" no
	st_eks_case "a THROTTLE on describe-cluster is UNVERIFIABLE, not gone" \
		"An error occurred (ThrottlingException): Rate exceeded" yes
	st_aws_restore

	# ── THE OTHER ELEVEN alive_* PROBES (#3493 review, finding 2). ────────────────────────────────
	#
	# alive_eks above is one of TWELVE per-resource confirms, and every one of the others is
	# reachable ONLY through alive_* → verify_swept → finalize_verification — the verify-only path,
	# where a wrong CLEAN is not a cosmetic mislabel but an exit 0 over a billing resource. They all
	# used the wide looks_gone union, whose `Not Found`/`(404)` alternatives exist for s3api
	# head-bucket, so `An error occurred (404) … Not Found` through a proxy resolved a live Aurora
	# cluster to "gone" — strictly more expensive than the classic ELB that motivated the fix.
	#
	# RDS is the case asserted here because it is the dearest, and because the same narrowing was
	# applied to all eleven in one pass. s3api is DELIBERATELY excluded from that narrowing: 404 /
	# Not Found genuinely IS how head-bucket says "gone", which is exactly why the union was too
	# wide for everyone else.
	st_alive_case() { # <name> <tagged arn> <describe stderr> <expect unverifiable: yes|no>
		probe_reset
		ST_ALIVE_ARN="$2" ST_ALIVE_ERR="$3"
		aws() {
			case "$1 ${2:-}" in
			"resourcegroupstaggingapi get-resources") printf '%s\n' "$ST_ALIVE_ARN"; return 0 ;;
			esac
			printf '%s\n' "$ST_ALIVE_ERR" >&2
			return 254
		}
		local got=no
		alive_rds_clusters >/dev/null 2>&1 || true
		st_aws_restore
		probe_has_unverifiable && got=yes
		if [ "$got" = "$4" ]; then
			echo "  ✓ $1"
		else
			echo "  ✗ $1 — expected unverifiable=$4, got ${got}" >&2
			st_fails=$((st_fails + 1))
		fi
	}
	st_alive_case "a DBClusterNotFound on the RDS confirm is an ANSWER — no false red" \
		"arn:aws:rds:us-east-1:0:cluster:alethia-e2e" \
		"An error occurred (DBClusterNotFoundFault) when calling the DescribeDBClusters operation" no
	# The finding: this 404 hits `Not Found` AND `(404)` in looks_gone, so under plain probe_confirm
	# a LIVE Aurora cluster dropped out of the leak list and the run exited 0.
	st_alive_case "a 404 through a proxy on the RDS confirm is UNVERIFIABLE, not 'gone'" \
		"arn:aws:rds:us-east-1:0:cluster:alethia-e2e" \
		"An error occurred (404) when calling the DescribeDBClusters operation: Not Found" yes
	# And a throttle, the shape that has nothing to do with 404 at all.
	st_alive_case "a THROTTLE on the RDS confirm is UNVERIFIABLE, not 'gone'" \
		"arn:aws:rds:us-east-1:0:cluster:alethia-e2e" \
		"An error occurred (ThrottlingException): Rate exceeded" yes
	st_aws_restore

	if [ "$st_fails" -ne 0 ]; then
		echo "✗ aws-cleanup.sh self-test: ${st_fails} failure(s)" >&2
		exit 1
	fi
	echo "✓ aws-cleanup.sh self-test passed"
	exit 0
fi

# ── Orchestrate, in strict dependency order. sweep_data_services sits BEFORE the network teardown
#    because RDS and ElastiCache hold ENIs in the private subnets; sweep_managed_services sits after
#    it because nothing it touches does. ──
discover_cluster
sweep_instances
sweep_load_balancers
sweep_eks
sweep_data_services
sweep_nat_and_eips
sweep_volumes
sweep_network
sweep_managed_services
sweep_acm
sweep_route53
# Last: the free leftovers. Nothing depends on them, and removing them is what stops a finished
# run being rediscovered as an orphan for the rest of the account's life.
sweep_litter

if [ "$DRY_RUN" = "1" ]; then
	echo "✓ aws DRY RUN complete for alethia:project-id=${PROJECT_ID_TAG} (nothing deleted, nothing verified)"
	exit 0
fi

echo "→ verifying nothing billable for run ${ENV} survived…"
st_rc=0
finalize_verification || st_rc=$?
exit "$st_rc"
