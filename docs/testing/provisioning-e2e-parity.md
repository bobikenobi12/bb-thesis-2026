<!-- SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io> -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Provisioning e2e — cloud parity & FULLY-TESTED board

Living status for **real runner provisioning** on each cloud, tracked to the maintainer's **FULLY-TESTED
bar** (not the "provisions + ArgoCD converges" floor). The bar, per cloud, on a **real apply**: every
supported resource kind × all 18 marketplace add-ons Healthy+Synced × BYO-IaC × BYO-IaC *with Alethia
services* × a real day-2 access path — provision → verify → **teardown as a closed loop** (never leave a
cluster/VM running). See [[fully-tested-bar]] / `byoc-proof-program`.

Harness: `.github/workflows/e2e-nightly.yml` (T2 tier) → `test/e2e` (`-tags=e2e_t2`,
`TestT2RealCloudProvisioning`). Run history: [`demos/proofs/provisioning-e2e-log.md`](../../demos/proofs/provisioning-e2e-log.md).
Tracking epic: **#1058**.

**How runs are recorded:** every run goes through `scripts/e2e/provisioning-e2e.sh` (appends the ledger +
writes a scrubbed proof bundle + files a deduped GitHub issue on failure); the nightly `rollup` job also
appends the ledger. **Failures are recorded, never hidden.**

There is no matrix here to flip, and the legend that named its glyphs went with it — both are derived in
`PROGRAMME.md` now. Two rules the ledger enforces are worth keeping in prose, because they are the reason
the derivation can be trusted: a dimension counts as proven **only with a real-apply proof artifact**, never
on `tofu validate` alone; and a green-SKIPPED nightly is neither a proof nor a ledger row. A later
`RETRACTED` ledger row corrects a historical claim without rewriting it.

## Parity matrix

> **Status is not here.** It rots, and this table proved it: every blocker it cited had been
> closed, and it contradicted `runner-xcloud-parity.md` in the same directory while both passed CI.
> `scripts/programme-rollup.mjs` names that pair as the reason it exists.
>
> The proof grid, the per-cell evidence and the open blockers are derived in **`PROGRAMME.md`**,
> below its generated marker. Read it there. What stays below is the reasoning the ledger cannot
> hold — decisions, post-mortems and measurements.

## What's left

- [ ] **AWS floor (#1714)** — the EKS access-entry defect in closed #1040 is resolved and its real-run
      teardown was clean; the shared `addon-reloader` convergence defect now blocks the floor. A fresh signed
      real-cloud run is required after that fix before this becomes a floor PASS.
- [ ] **GCP floor (#1716, #1714, #1722)** — the node-pool name can overflow, and the add-on gate has two
      independent convergence defects. The observed failed run tore down cleanly, but it is not a floor PASS.
- [ ] **Azure floor (#1722)** — AKS's platform metrics-server collided with ours; the render gate now skips
      it there. The observed failed run tore down cleanly; a real run is still required for floor proof.
- [ ] **Hetzner `addons` dimension — first real run, FAIL at the ArgoCD gate**
      ([`20260805T064043Z`](../../demos/proofs/hetzner/20260805T064043Z), 2026-08-05). This is the first
      time `ALETHIA_E2E_ALL_ADDONS` has been driven against a real cluster on **any** cloud, and it
      settled three open questions at once.

      **Proven.** The cluster provisions and is reachable — 7 nodes `Ready` (1 control plane + 6 workers),
      Kubernetes 1.35.6 on Talos, the signed receipt verified against the plan hash, 220 log lines shipped
      to `job_logs`. That is further than any leg has reached before: the only prior genuine attempt (aws,
      2026-07-22) died with a 401 from the API server. **`addon-reloader` reached Healthy+Synced**, so
      **#1714 is verified against a real apply** rather than merely closed; the same run verifies **#1722**,
      since `metrics-server` also converged on one of the two clouds where it still installs.

      **Failed.** 12 of 20 Applications were not Healthy+Synced within the 8-minute budget. Two distinct
      causes, and only one of them is a timeout:
      - **`addon-loki` can never install** (#2058) — its catalog values set `deploymentMode: SingleBinary`
        *and* non-zero `read`/`write`/`backend` replicas, which the chart's own `validate.yaml` rejects. The
        manifest never renders (`sync=Unknown`, not `OutOfSync` — there is no target state to compare).
      - **The rest were still converging.** `velero` was `Missing`, and `falco`, `ingress-nginx`,
        `kube-prometheus-stack` and `vault` were all `Progressing`. Eight minutes is not a realistic budget
        for 18 charts of this weight; the number needs deriving from the surface rather than guessing.

      **Teardown swept to zero** — servers, volumes, network, load balancer, firewall and primary IPs all
      back to the pre-run baseline, verified by hand against the account.

      ⚠️ The run produced **no ledger row of its own**: the proof-scrub tripwire fired on already-redacted
      values and its fail-closed exit discarded the record (#2062). The row was appended by hand with
      `RECORD_ONLY`. The bundle was independently checked for the live token, certificate material and a
      kubeconfig body — none present.
- [ ] **Alibaba floor** — pending enablement and its first real run; no floor or teardown verdict exists.
- [ ] **Raise the nightly (or a dispatch/weekly full-bar job) to the FULLY-TESTED dimensions** —
      `MAX_CONFIG` (11 kinds) + `ALL_ADDONS` (19) + A0.6 BYO/services + a real day-2 access assertion — per
      cloud. Because the full surface is heavy + costly, drive it as an **opt-in full-bar dimension**
      (dispatch input / weekly cron) so the cheap nightly stays the green-floor smoke.
- [x] **Heavy fixtures** — all five now ship (`cluster_json.heavy.{aws,gcp,azure,hetzner,alibaba}.json`),
      so a full-bar run no longer hard-errors in the workflow's "Compute cluster shape" step. Each is
      checked on every PR: it must clear its cloud's floor, pin an instance type
      `packages/core/catalog/catalog.json` actually offers, and declare a `node_size` matching that
      instance's catalogued vCPU/memory (the pair used to be self-attested, and `aws` pinned the
      non-catalog `m5.xlarge`).
- [x] **Hetzner's three in-cluster kinds are seeded by the harness** — `database`/`cache`/`queue` are
      `CarriedInCluster` and asserted against the converged ArgoCD Application set, and the DEPLOY
      snapshot now carries the charts that produce those Applications. Previously it did not: the Go
      harness seeded add-ons from `seedAddOns`/`AllCatalogAddOns` alone, which can never hold the
      Hetzner data services (they are synthesized per component, not chosen from a marketplace), so
      those three cells asserted Applications that could not exist and a Hetzner full-bar run was
      **red by construction**. That was recorded as an inherent blocker on the grounds that
      hand-mirroring `hetznerDataServicesToAddOns` into Go is the drift this repo forbids — true, but
      not the only option: the specs are **generated** on the same rail `addon_catalog.<cloud>.json` already
      uses.

      | | |
      |---|---|
      | SSOT | `apps/console/lib/cloud-providers/hetzner-services.ts` |
      | generator | `pnpm -F console export:hetzner-data-services` |
      | fixture | `test/e2e/fixtures/hetzner_data_services.json` |
      | drift guard (TS) | `tests/lib/cloud-providers/hetzner-data-services-export.test.ts` |
      | read-back (Go) | `TestHetznerDataServiceFixtureMatchesTheMaxConfigSurface`, `TestHetznerInClusterCellsAreCoveredBySeededSpecs` |

      The fixture carries the **components** it was generated from as well as the specs, so the Go
      read-back compares them with the real `MaxConfigProjectConfig("hetzner")` instead of trusting
      that two lists were kept in step by hand. The seed is per-cloud: the other four clouds' add-on
      set is untouched (asserted).
- [x] **Azure full-bar feasibility — MEASURED, and it is feasible.** The e2e subscription
      (`32f3d6ca…`) has a **10 vCPU** Total Regional quota and AKS renders
      a single pool, so the old `Standard_D4s_v5` ×3 fixture (12 vCPU) could never create. The open
      question was whether the separate per-family quota also blocked the replacement. It did:

      | family | limit | verdict |
      |---|:---:|---|
      | Total Regional vCPUs | 10 | the binding cap — 3 × 2 vCPU = 6 fits |
      | **`Standard ESv5 Family vCPUs`** | **0** | ⛔ `Standard_E2s_v5` ×3 **could never create** |
      | `Standard ESv3 Family vCPUs` | 10 | ✅ `Standard_E2s_v3` — 2 vCPU / 16 GiB, unrestricted |
      | `Standard EBDSv5 / EBSv5` | 10 | also viable (E2bds_v5 / E2bs_v5, same shape) |
      | `Standard DSv3` | 10 | why the **floor** works — it pins `Standard_D2s_v3` |

      Measured with `az vm list-usage --location germanywestcentral`: **100 of 228 families are at 0**,
      and the v5 "s" families (`DSv5`, `ESv5`, `Dv5`, `Ev5`) are among them while v3/v4/v6/v7 and the
      `EB*v5` families are at 10. So this was never "Azure has no capacity" — it was one family.

      The fixture is now **`Standard_E2s_v3` ×3** (6 vCPU / 48 GiB). `heavyMinMemGB` is 48 and is
      **not** lowered for Azure, so the SKU must be exactly 2 vCPU / 16 GiB — which is why the
      catalogued 4 vCPU alternatives (`D4s_v5`, `D4as_v5`) do not help: ×3 exceeds the 10 vCPU cap.
      **No support ticket is required, and Azure does not become a documented exclusion.**
- [ ] **Day-2 access surface** — the maintainer flagged the missing kubeconfig / ArgoCD-URL surface as the
      gap that motivated the bar (opening `:6443` returned a client-cert 401 — by design, but no access
      path is surfaced). Build + assert it.
- [ ] **Per-cloud `alethia-security-review`** before each dimension flips ✅.

## Flagged issues

| Issue | Cloud | Dimension | Status |
|-------|-------|-----------|--------|
| **#1714** | GCP · Hetzner | Provision + cluster_ready | OPEN — add-on Deployment default drift prevents ArgoCD convergence |
| **#1716** | GCP | Provision + cluster_ready | OPEN — GKE node-pool name can exceed the provider limit |
| **#1722** | GCP · Azure · Alibaba | Provision + cluster_ready | FIXED — the platform metrics-server collided with ours on all three (ACK was the unlogged third); `metrics-server.yaml` now renders on AWS/Hetzner only. Needs a real run per cloud to become a floor PASS |

## Security findings

_(none yet — `alethia-security-review` findings land here as dimensions are driven)_

## AI-caught improvements

- **CLI `--no-input` destroy is a no-op** (`apps/cli/cmd/helpers.go:30` `confirm()` ignores `noInputMode`;
  on a non-TTY it prints "Cancelled" and never queues DESTROY). Hands-on teardown must go via the cloud
  sweepers or the API/server action, not the CLI destroy — otherwise a "torn-down" run silently leaks.
- **AWS EKS pathed-role 401 is a real product gap, not e2e-only** — any customer whose provisioning role
  carries an IAM path hits the same post-apply `Unauthorized`. The fix belongs in the template, benefiting
  all pathed roles ([[cloud-parity-rule]]: EKS-specific by nature — GCP/Azure authorize via IAM roles / AAD
  groups and don't path-strip; documented specificity, not a silent gap).
