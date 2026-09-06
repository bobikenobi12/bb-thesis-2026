<!--
SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
SPDX-License-Identifier: AGPL-3.0-only
-->

# Provisioning proofs (`demos/proofs/`)

Committable evidence that the provisioning spine works against **real** infrastructure
— the honest "SUCCESS = a working cluster" artifact, not a screenshot. Each proof is a
timestamped directory (`<provider>/<UTC-stamp>/`) capturing what the nightly `DEPLOY`
run did: a structured `provision-summary.json` (resources added, nodes Ready, ArgoCD
Healthy+Synced count, the signed-receipt plan hash, teardown confirmation, timings), a
one-line `VERDICT.txt`, the scrubbed runner-log highlights (`summary.txt`), the verify
receipt + control report pulled from the control plane (`receipt.json` /
`verify-result.json`), and — on the success path — the cluster's state at the moment the
job reached `SUCCESS` (node readiness, pod status, ArgoCD app health, the
CNI/cloud-integration bootstrap).

## Proof capture v2 — scrubbed, fail-closed, captured on pass **and** fail (BYOC A0.4)

The bundle is produced by **`demos/proofs/capture-proof.sh <provider>`**, which runs on
**any** T2 outcome (`if: always()`) — a red night is captured too, with its failure
**stage** (e.g. `applying` / `argocd-ready`) recorded, so it is debuggable rather than an
opaque failure. Every captured file is routed through **`demos/proofs/scrub.sh`**, a
text-level port of the runner's A0.0 metadata denylist
(`apps/runner/internal/agent/output_scrub.go`): it redacts exact secret **values** (the
Hetzner/AWS/git tokens), PEM private-key blocks, and any denylisted `key: value` line
(kubeconfig / talosconfig / `*client_key` / `password` / `*_token` / `*secret_value` …).
The script then **fails closed** — an `assert_grep_clean` tripwire re-greps the finished
bundle and, if any secret survived, **deletes the bundle** and exits non-zero (program
**invariant 2**: nothing uploads unscrubbed), leaving a `CAPTURE-ABORTED.txt` marker so an
empty slot cannot be misread as "this cloud never ran".

Three properties hold that up, and each of them failed once:

- **The workflow's upload step is gated on the capture step's `outcome`.** It was not, so a
  refused bundle was published anyway while the log said `Not uploading` (#1923). Deleting the
  bundle covers the tripwire path; the gate additionally covers an *earlier* abort, where
  `set -euo pipefail` kills the capture with a partially-written, never-checked bundle on disk.
- **The tripwire classifies on the value's shape, not the key's name.** A `tofu show -json`
  plan mentions denylisted keys constantly while holding only structural values —
  `"kube_config":true`, `"admin_password":{"sensitive":true,…}`, `"client_key":{"references":[…]}`
  — and treating those as leaks refused a clean azure bundle on every run.
- **Every shape the tripwire flags is one `scrub_stream` can redact.** When the two drift, the
  affected leg is red forever and produces no proof at all — the same outage as a false
  positive. `constant_value`, string arrays and logfmt `key=value` were flagged but
  unredactable; the fix is to cover the shape, never to stop flagging it.

`scrub.sh --self-test` seeds a fake secret of every shape and proves the scrub + tripwire are
non-vacuous **and** not over-broad, including that round-trip. `ci.yml` runs it on every PR (it
needs no cloud and no secret) and the nightly runs it again before any cloud work starts.

Because the T2 test tears the cluster down **in-process** (`t.Cleanup` → `RunDestroy`) when
the go-test step ends — before the capture step — the cluster is usually already gone by
capture time. So live `kubectl` state (nodes/pods/ArgoCD apps) is **best-effort**: the script
probes reachability first and only dumps it if the cluster still answers. On the nightly the
proof therefore rests on the authoritative signals that survive teardown: the **T2 outcome**
(the test exits `success` *only* if it asserted the whole apply → Ready node → every ArgoCD
Application Healthy+Synced chain), the runner-log markers (resources added, signed-receipt
plan hash, destroy confirmation), and the signed receipt pulled from the control-plane DB.

The legacy hand-run `capture-e1.sh` (success-only, unscrubbed, `e1-<provider>/` layout) is
replaced by this.

## The two tiers

| Tier   | Cluster                | Cost | Where it runs |
| ------ | ---------------------- | ---- | ------------- |
| **T1** | hermetic local `kind`  | $0   | `ci.yml` → `provision-e2e`; currently no live trigger (#4173) |
| **T2** | a **real cloud** cluster | ~cents/run | `e2e-nightly.yml`, nightly + manual, **maintainer-gated** |

Both drive the identical spine — the real runner binary claims a real `DEPLOY` job from
a real Postgres-backed control plane and runs `RunDeployV2` (plan → verify gate → signed
receipt → apply → reachability gate → ArgoCD) — asserting the same outcomes
(`cluster_ready` + a signed receipt sealed to the plan hash + shipped logs + a Ready
node). T1 proves the spine for free on kind; **T2 proves it against a genuine cloud**
(`infra/templates/project/<provider>`, Hetzner/Talos first).

## How the nightly captures land

`.github/workflows/e2e-nightly.yml`:

1. runs `test/e2e/t2_provision_test.go` (`-tags=e2e_t2`) — on success the real cluster comes
   up and the runner writes a host-usable kubeconfig to `$HOME/.alethia/kubeconfig`;
2. **on any outcome** (`if: always()`) runs **`./demos/proofs/capture-proof.sh <provider>`**,
   writing the scrubbed bundle to `demos/proofs/<provider>/<UTC-stamp>/` and the per-provider
   PASS/FAIL verdict to the job **step summary**;
3. uploads that directory as the workflow artifact `e2e-proof-<provider>-<run_id>`
   (30-day retention), **also `if: always()`** — a failed night's partial evidence + failure
   stage is uploaded too. The run does **not** push to the repo (the nightly has read-only
   `contents` and `dev` is protected).

To keep a proof: download the artifact and commit it under `demos/proofs/<provider>/…`
yourself (the receipt + control report are already in the bundle when the DB was reachable).

## Enabling the T2 nightly (maintainer)

It provisions **real, billable** infrastructure, so it is **off until you opt in**:

1. Add the repo secret **`HCLOUD_TOKEN`** — a scoped Hetzner Cloud API token (Project →
   Security → API Tokens, read/write). That is the only wiring required.
2. That's it. The nightly (03:17 UTC) and manual `workflow_dispatch` will then run for
   real. Until the secret exists, the job **skips cleanly (green) with a loud warning** —
   never a false red, and never a false green (nothing is claimed to be proven).

**Cost:** one tiny Talos cluster — 1 control-plane + 1 worker on `cpx22` (2 vCPU / 4 GB,
amd64) servers — up for ~15–25 min, then destroyed. On the order of a few euro-cents per
run. **Not `cax11`/ARM:** `infra/templates/project/hetzner/variables.tf` defaults both node
types to `cpx22` because cax11 is capacity-unreliable and cpx11 is retired, so `amd64` in a
build log is the configured path and not a bug. Nightly region defaults to `nbg1`
(overridable via the `region` dispatch input).

**Adding a provider (aws/azure):** extend the `matrix.provider` list and the `case` in
the workflow's *Gate on the provider secret* step with that provider's secret. The Go
harness already keys off `ALETHIA_E2E_PROVIDER`; only the credential env + template wiring
differ.

### Optional: the ArgoCD-with-repos + BYO Helm proof (BYOC A0.6)

On top of the base T2 proof (which asserts the always-rendered platform Applications + a
seeded marketplace add-on converge), the nightly can also prove the **customer-repo** half:
a real apps-destination repo and a bring-your-own Helm chart repo, wired as **credentialed**
ArgoCD Applications (`repo-apps` → the `apps` app-of-apps, `repo-byo-*` → the chart's
`addon-<id>` Application), converging **Healthy+Synced** — asserted over CRs only, never an
ArgoCD URL. This half is **opt-in and additive**: leave it unset and the base proof runs
unchanged; set it partially and a required run **hard-fails** (a half-wired secret can never
silently disable the assertion).

To enable it, add these repo **variables** (Settings → Secrets and variables → Actions →
*Variables*) and one **secret**:

| Name | Kind | Purpose |
|------|------|---------|
| `E2E_ARGO_APPS_REPO` | var | HTTPS URL of the apps-destination repo. Its **root** manifests are synced by the `apps` app; it must contain **at least one** valid manifest (e.g. a `Namespace` or `ConfigMap`) — the proof asserts the app manages ≥1 resource, so an empty repo (which would trivially report Healthy+Synced) fails. Presence of this var flips the proof to **required**. |
| `E2E_ARGO_BYO_CHART_REPO` | var | HTTPS URL of a git repo containing a Helm chart. |
| `E2E_ARGO_BYO_CHART_PATH` | var | Chart directory within that repo (default `chart`). |
| `E2E_ARGO_BYO_CHART_REVISION` | var | Git ref for the chart (default `HEAD`). |
| `E2E_ARGO_BYO_CHART_NAMESPACE` | var | Namespace the chart installs into (default `byo-e2e`). |
| `E2E_GIT_TOKEN` | **secret** | A git token (PAT / installation token) with **read** access to both repos. Served only via the control plane's git-token API — it is **never** written into the persisted `config_snapshot`, never logged (go-git uses BasicAuth, credential Secrets are read `-o name` only), and never uploaded (A0.0 metadata denylist). |

**BYO chart constraints (important):** bring-your-own charts sync into a **hardened,
default-deny** ArgoCD AppProject — `clusterResourceWhitelist: []` (no CRDs, ClusterRoles,
Namespaces, webhooks) and an RBAC/ServiceAccount blacklist. The chart at
`E2E_ARGO_BYO_CHART_PATH` must therefore create **only namespaced resources** in its target
namespace (e.g. a ConfigMap + Deployment + Service) with **no ServiceAccount/Role/RoleBinding**
(set `serviceAccount.create=false` for charts like podinfo). The chart must render **at least one**
resource (the proof asserts the app manages ≥1 — an empty chart would trivially green). A chart
that needs cluster-scoped or RBAC objects will (correctly) fail to sync and red the nightly. A BYO
chart Application is
**manual-sync** by design (an operator reviews an untrusted chart first); the harness issues
the sync over the Application CR, mirroring that operator action, then asserts convergence.

**Tip:** the apps repo may also contain an empty `addons/` directory — the deploy renders a
same-repo `addons` app-of-apps at that path; it is not asserted, but an existing (even empty)
directory keeps it Healthy in the captured proof instead of erroring on a missing path.

## Teardown is guaranteed — and never account-wide

The Hetzner account is **shared with production**; an unfiltered delete once nearly wiped
prod. Teardown is therefore layered and always **label-scoped to this run's unique
cluster** (`<project>-<env>`, derived from the GitHub run id/attempt):

- **Graceful (in-process):** the T2 test's `t.Cleanup` runs the real `tofu destroy`
  (`provisioner.RunDestroy`), registered **before** the deploy so it runs even on a
  mid-apply failure. The control plane's state backend is in-memory, so it dies with the
  process — there is no persisted state to purge.
- **Guaranteed (belt-and-suspenders):** the workflow's `always()` step runs
  **`scripts/e2e/hcloud-cleanup.sh <cluster>`**, which deletes **only** resources
  carrying the label `cluster=<cluster>` (the exact label the template stamps on every
  server/network/firewall/primary-IP/image). It refuses to run without a specific,
  plausibly-unique cluster name and asserts the selector on every call — so a hard-killed
  test process can never leak, and the cleanup can never touch prod or another run.

CSI volumes: a `pvc-*` volume is created by the CSI **controller** at runtime, not by the
template, so `tofu destroy` (which only knows template-managed resources) cannot reclaim it —
destroying a cluster with live PVCs used to leak real, billable volumes that the teardown
sweep could not see either (it is cluster-label-scoped, and must stay that way: the hcloud
account is shared with prod). This is now closed **at the source**: the Hetzner template sets
the CSI driver's `HCLOUD_VOLUME_EXTRA_LABELS` to `cluster=<cluster_name>`
(`infra/templates/project/hetzner/csi.tf`, hcloud-csi chart pinned to **2.20.2** — the value
needs ≥ 2.15.0 and is silently ignored below it, and 2.20.2 is the newest release still
supporting the k8s 1.32.3 that Talos v1.9.5 ships; a `lifecycle` precondition **hard-fails**
the plan if the label ever stops rendering). So every dynamically-provisioned volume carries
the cluster label and the label-scoped teardown sweep reclaims it **without widening its blast
radius** — after waiting out the async volume detach that `hcloud server delete` triggers, and
the sweep now **fails loudly** (non-zero exit) rather than exiting green if any labelled resource
survives. Only volumes from clusters built before this change can still be stray — sweep those by
hand, never account-wide.

## Running T2 locally (optional)

```bash
export HCLOUD_TOKEN=...                       # a Hetzner API token
export ALETHIA_DATABASE_URL=postgres://...    # a migrated control-plane DB (pnpm db:up)
export ALETHIA_E2E_PROJECT=alethia-nl ALETHIA_E2E_ENV="local-$(date +%s)"
export ALETHIA_E2E_HCLOUD_REGION=nbg1
cd test/e2e && GOWORK=off go test -tags=e2e_t2 ./... -run TestT2RealCloudProvisioning -v
# then tear down the belt-and-suspenders way if the test was killed:
scripts/e2e/hcloud-cleanup.sh "$ALETHIA_E2E_PROJECT-$ALETHIA_E2E_ENV"
```

Without `HCLOUD_TOKEN`/tools it **skips** (a dev laptop is never forced to hold a token);
set `ALETHIA_E2E_T2_REQUIRE=1` to make a missing prerequisite a hard fail, as the nightly
does.

### Four things that cost a run each, 2026-08-24

These are not hypotheses. Each one produced a wasted run or a wrong ledger row on the night the
local path was first driven end to end for all of hetzner and aws.

**1. Pin `tofu` to 1.9.0.** CI (`e2e-nightly.yml`) and the runner image
(`apps/runner/Dockerfile.base`) both pin it. A laptop is likely on something newer — 1.12.3 at the
time of writing — and a bundle produced on a different major does not prove what CI runs. Put the
pinned binary first on `PATH` for the run.

**2. Managed-cloud credentials must be in the ENVIRONMENT, not just a profile.** `credsPresent()`
in `t2_providers.go` checks for `AWS_ACCESS_KEY_ID` or `AWS_ROLE_ARN` as environment variables. A
working `~/.aws/credentials` is invisible to it, and the run stops at the prerequisite gate in
0.00s having touched nothing:

```
T2 prerequisite missing (ALETHIA_E2E_T2_REQUIRE set): AWS credentials are not configured
```

Under `ALETHIA_E2E_T2_REQUIRE=1` that is recorded as a **FAIL**, and a FAIL that describes the
operator rather than the cloud has to be superseded with a `RETRACTED` row. Export them first:

```bash
eval "$(aws configure export-credentials --format env-no-export | sed 's/^/export /')"
export ALETHIA_E2E_AWS_READY=1
export AWS_ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
```

**3. Heavy dimensions need their heavy profile passed explicitly.** The workflow swaps in
`test/e2e/fixtures/cluster_json.heavy.<cloud>.json` **only for full-bar**. Driving `addons` (or
`maxconfig`) by hand at the default shape gives a cluster too small to converge, and you find out
~35 minutes later:

```bash
export ALETHIA_E2E_CLUSTER_JSON="$(tr -d '\n ' < test/e2e/fixtures/cluster_json.heavy.hetzner.json)"
```

**4. A killed run leaks what the destroy never owned.** `t.Cleanup`'s destroy does not run on
SIGKILL, and even a *clean* destroy cannot reclaim CSI-provisioned `pvc-*` volumes — they are
created by the controller at runtime and were never in tofu state. A `hetzner addons` run left nine
of them (140 GB) behind a destroy that reported success.

`provisioning-e2e.sh` now runs the scope-locked sweeper itself, so the recipe at the top of this
section is safe by default. If you drive `go test` directly, sweep by hand afterwards. On hetzner a
killed run also leaves the imager provider's `hcloud-upload-image-*` server and SSH key, which no
selector can reach — remove those manually.
