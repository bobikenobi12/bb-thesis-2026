<!-- SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io> -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Enabling a cloud in the T2 real-cloud nightly

`.github/workflows/e2e-nightly.yml` matrixes **all five clouds** — `hetzner`, `aws`, `gcp`, `azure`,
`alibaba` — but each leg **green-skips** until a maintainer wires that cloud's gate. A skipped leg is a
deliberate no-op that reports success, so a nightly can show five green checks while proving one cloud.
The rollup states the ratio explicitly (`Coverage: N/5 clouds enabled`) and keeps one standing issue
listing what each inert cloud needs.

This is the procedure to take a cloud from inert to proven. It applies real cloud infrastructure and
commits real money, and its last step — setting the gate value — is the maintainer's alone.

> **An agent may dispatch a dimension on a cloud whose gate is already on, and may apply a named
> stack under a plan the maintainer has reviewed. An agent must never turn a gate on.** Dispatching
> an enabled cloud spends a known, budgeted amount. Setting a gate value commits new spend on a
> cloud that was inert, and that decision is the maintainer's — surface it and stop. See the IaC
> rules in `CLAUDE.md`.

## The gate, in one paragraph

The `Gate on the provider secret` step reads **one** value per cloud. Non-empty ⇒ `run=true` and the
leg provisions for real. Empty ⇒ `run=false`, a warning, and a green skip. **Setting that value is
what enables the cron** — so do it last, after the cloud has passed a manual dispatch and a
kill-drill. Everything else the leg needs must already be in place, because the gate does not check it.

## Order of operations

1. **Apply the cloud's e2e stack** (in the directory below) — an agent may run this one under a
   reviewed plan for the named stack, but never on its own initiative. Each stack
   keeps its state remotely, in the same account/project/subscription as the identity it creates, so
   the first apply on a cloud is really two: its `bootstrap/` (the state container), then the stack
   itself. See [`e2e-state-migration.md`](./e2e-state-migration.md) — which is also the procedure for
   moving a stack that is still on local state.
2. **Set every non-gate variable first** — the gate only checks one value, so a cloud enabled with its
   companions missing turns green-skip into a confusing failure.
3. **Dispatch that cloud alone.** `workflow_dispatch` derives the matrix from the `provider` input, so
   dispatching `gcp` runs *only* gcp — it cannot spin up the others. Use the cheap green-floor
   dimension (leave `full_bar` unchecked).
4. **Kill-drill.** Confirm teardown actually reclaimed everything: the run's teardown is `always()` and
   label-scoped (every resource carries `alethia:environment-id=<run_id>-<attempt>`, and each cloud's
   sweeper filters on it). Verify in the console that nothing survived, and that the budget alert
   plumbing (SNS / Pub-Sub / action group / — see each stack's budget output) is reachable.
5. **Set the gate variable.** The cloud now runs on the floor cron, `17 3 * * *` — **03:17 UTC**,
   not the 06:00 this step used to claim. That is the *only* schedule: the weekly full bar on
   `17 5 * * 0` was removed, because it fanned the 11-kind surface across all five clouds while the
   pre-apply cost ceiling is wired for aws alone (#2385). Run a full bar by dispatch instead, one
   cloud at a time. The floor cron fires only on the default branch, so it runs from `main`.

## Per-cloud configuration

Every name below is **verified against `e2e-nightly.yml`**, not against the stacks' output
descriptions. Check the workflow, not the prose — an output that named a variable nothing read
(`E2E_GCP_SERVICE_ACCOUNT`) is exactly how a leg came to fail obscurely.

| cloud | stack | gate (set LAST) | also required |
| --- | --- | --- | --- |
| **aws** | `infra/aws-oidc` | `E2E_AWS_ROLE_ARN` var | — *(already enabled; the worked example)* |
| **gcp** | `infra/gcp-e2e` | `E2E_GCP_WIF_PROVIDER` var | `E2E_GCP_SA_EMAIL` var |
| **azure** | `infra/azure-e2e` | `E2E_AZURE_CLIENT_ID` var | `E2E_AZURE_TENANT_ID`, `E2E_AZURE_SUBSCRIPTION_ID`, `ALETHIA_E2E_AZURE_ADMIN_GROUP_OBJECT_ID` vars |
| **alibaba** | `infra/alibaba-e2e` | `E2E_ALIBABA_ROLE_ARN` var | `E2E_ALIBABA_OIDC_PROVIDER_ARN` var |
| **hetzner** | *(none — token auth)* | `HCLOUD_TOKEN` **secret** | — |

All the managed-cloud handles are repo **variables**, not secrets: an OIDC/WIF provider name, a client
id, a role ARN. None is sensitive, and none is a long-lived credential — that is the point. Hetzner is
the exception and uses a **secret**, because token auth is its ceiling (no OIDC).

### aws — the reference

`infra/aws-oidc` outputs `e2e_nightly_role_arn` → `E2E_AWS_ROLE_ARN`. The role is capped by a
permissions boundary (`e2e_boundary_policy_arn`) and **region-locked to `us-east-1`** — the nightly
must run there; `eu-central-1` is a prod region the role forbids.

### gcp

`infra/gcp-e2e` outputs:
- `e2e_gcp_wif_provider` → **`E2E_GCP_WIF_PROVIDER`** (the gate; `auth`'s `workload_identity_provider`)
- `e2e_gcp_sa_email` → **`E2E_GCP_SA_EMAIL`** (`auth`'s `service_account`)

**Set both.** The gate checks only the provider var, so setting it alone enables the leg and then fails
it with an empty `service_account`.

### azure

`infra/azure-e2e` outputs:
- `e2e_azure_client_id` → **`E2E_AZURE_CLIENT_ID`** (the gate; `ARM_CLIENT_ID`)
- `e2e_azure_tenant_id` → **`E2E_AZURE_TENANT_ID`**
- `e2e_azure_subscription_id` → **`E2E_AZURE_SUBSCRIPTION_ID`**
- `aks_admin_group_object_id` → **`ALETHIA_E2E_AZURE_ADMIN_GROUP_OBJECT_ID`**

The last one is **not optional**, and its failure mode is nasty. `t2_providers.go` maps that env var
into the cluster snapshot's `aks_admin_group_object_ids` tfvar, which authorizes the runner's AAD token
as AKS cluster-admin **at create time**. AKS AAD-integrated RBAC has no post-hoc escalation path, so
omitting it does not degrade gracefully: the cluster comes up and the runner simply is not authorized
on it. The leg then fails as *"cluster provisioned but not reachable — AUTH REJECTED"* — the same
shape as the EKS #1040 outage, and easy to misread as a credential problem.

### alibaba

`infra/alibaba-e2e` outputs:
- `E2E_ALIBABA_ROLE_ARN` → **`E2E_ALIBABA_ROLE_ARN`** (the gate)
- `E2E_ALIBABA_OIDC_PROVIDER_ARN` → **`E2E_ALIBABA_OIDC_PROVIDER_ARN`**

Both are needed: the RAM-OIDC trio they produce is read by **both** the `aliyun` CLI sweeper and the
`alicloud` OpenTofu provider, so a missing provider ARN breaks teardown as well as provisioning.

### hetzner

No stack — set the **`HCLOUD_TOKEN` repo secret**.

> **The Hetzner account is shared with production.** Teardown is guaranteed and label-scoped, but this
> is the one cloud where a sweeper bug can touch prod resources. Treat the kill-drill as mandatory, not
> a formality.

## Cross-cutting configuration

These are not per-cloud gates, but legs depend on them:

| name | kind | purpose |
| --- | --- | --- |
| `E2E_GIT_TOKEN` | secret | the git token the provisioned ArgoCD uses to read the apps repo |
| `INFRACOST_API_KEY` | secret | cost estimation during the run |
| `E2E_AWS_COST_CEILING_USD` / `_FULL_USD` | vars | abort thresholds — floor vs full-bar dimension |
| `E2E_ARGO_APPS_REPO`, `E2E_ARGO_BYO_CHART_*` | vars | the A0.6 BYO-IaC + services proof |
| `E2E_ARGO_APPS_REPO_GCP` / `_AZURE`, `E2E_ARGO_BYO_CHART_REPO` and `_REVISION` with those suffixes | vars | per-cloud repo overrides so that proof runs on gcp + azure too (#1136). Only these three bases take a suffix — `_PATH` and `_NAMESPACE` describe the chart repo's own layout, which does not vary by cloud |
| `E2E_KEYLESS_DB_ENGINE` / `_ENGINE_VERSION` / `_INSTANCE_CLASS` / `_IMAGE` / `_CLIENT_IMAGE` with `_GCP` / `_AZURE` | vars | per-cloud keyless-DB overrides — see below |
| `E2E_NAMESPACE_TENANT`, `E2E_SOAK` | vars | opt-in namespace-placement and soak scenarios |
| `E2E_VCLUSTER`, `E2E_DAY2_ACCESS` | vars | opt-in vcluster-placement and day-2-access scenarios (their harnesses existed but were never referenced by the workflow, so they could not run at all until #1268 wired them) |
| `E2E_SECRETS_XACCT*` | vars | opt-in cross-account keyless secret-manager read — see below |

## Dimensions and cost

- **Green floor** (default): the cheap smoke — one small cluster, teardown immediately.
- **Full bar** (`full_bar: true` on dispatch — **no cron fires it**, #2385): max-config — 11 kinds
  and all 18 add-ons. Heavy and expensive. The raised cost ceiling applies on **aws only**; gcp,
  azure, alibaba and hetzner are unpriced, so dispatch them one at a time and watch them.

Region defaults per cloud when the `region` input is blank: hetzner `nbg1`, aws `us-east-1`,
gcp `europe-west3-a`, azure `westeurope`, alibaba `eu-central-1`.

**gcp takes a ZONE, not a region.** A bare `europe-west3` makes the GKE cluster *regional*, and that
changes two things at once: the capacity preflight is skipped (it asks a zonal question), and a node
pool's `initial_node_count` and autoscaling min/max are applied **per zone** — so a floor configured
for 1 node silently provisions one per zone and is billed accordingly. Overriding `region` with a
bare region re-creates both.

The matrix runs at most **3 real provisions concurrently** (`max-parallel: 3`), and a per-provider
concurrency group serializes same-cloud runs.

## Adding a sixth cloud

Per the workflow's own note, extend all five places or the leg will half-work: the dispatch
`options:`, the matrix `provider:` array, the gate `case`, the credential step, and the sweeper `case`
in teardown. Then add a row to the coverage-issue table in the rollup step and to this document.

## Cross-account keyless secret managers (#1268)

Proves a workload in the e2e cluster (account A) reads a secret from a **different** account (B) with
no credential anywhere. **AWS only** — the other three clouds record BLOCKED with a reason
([parity board](./xacct-secrets-parity.md)).

### 1. Apply the account-B stack, once

With an admin identity in the **target** account:

```bash
cd infra/aws-secrets-e2e
cp backend.hcl.example backend.hcl && cp terraform.tfvars.example terraform.tfvars
$EDITOR terraform.tfvars              # cluster_account_id = the account the e2e provisions in
tofu init -backend-config=backend.hcl
TF_VAR_canary_value="$(openssl rand -hex 24)" tofu apply
```

`canary_value` is generated inline and never written to a file. Only its SHA-256 becomes a variable —
which is why the canary never reaches CI config, job logs or the proof bundle.

### 2. Set the repo variables

All **variables**, not secrets (a role ARN, an account id, a region, a secret name and a digest):

| Variable | From |
|---|---|
| `E2E_SECRETS_XACCT` | `1` to enable |
| `E2E_SECRETS_XACCT_ACCOUNT` | `tofu output target_account_id` |
| `E2E_SECRETS_XACCT_REGION` | `tofu output region` |
| `E2E_SECRETS_XACCT_ROLE_ARN` | `tofu output target_role_arn` |
| `E2E_SECRETS_XACCT_REMOTE_KEY` | `tofu output secret_name` |
| `E2E_SECRETS_XACCT_EXPECT_SHA256` | `tofu output canary_sha256` |

Optional: `E2E_SECRETS_XACCT_EXTERNAL_ID` (only if you set `external_id` on the stack),
`E2E_SECRETS_XACCT_SERVICE` / `_SECRET_NAME` / `_PROBE_NAMESPACE` (defaults are fine).

The region is **account B's**, where the canary lives — it need not match the cluster's, and is
required explicitly rather than defaulted so a mismatch cannot surface as a puzzling
`ResourceNotFound` at sync time.

### 3. Dispatch from `main`

Real applies are main-gated (the AWS OIDC subject is pinned to `refs/heads/main` with
`StringEquals`), so a dispatch from `dev` provisions nothing. Run the workflow with
`provider: aws` from `main`, then record the run:

```bash
scripts/e2e/secrets-e2e.sh aws cluster
```

### 4. Close the trust-shape divergence

The nightly's account-B trust is pattern-bound because the cluster is ephemeral, while the shipped
customer module is exact-ARN. Once, by hand, apply `infra/connector/aws/secrets-xacct` against a live
run's real IRSA ARN and record it:

```bash
scripts/e2e/secrets-e2e.sh aws strict
```

Adding the timing to your budget: this layer adds roughly 5–8 minutes of polling on top of
soak + namespace + vcluster. The step timeout is 75 min, `go test` 80 min, job cap 90 min — do not
raise them pre-emptively; watch the first three runs.

## Keyless database auth (#1511)

The ship gate for epic #1500. Until this runs, keyless database auth is proven only by renderers
that emit the right YAML — and that is not a small gap. The original AWS/Azure wiring put a stock
`bitnami/pgbouncer` behind a token-file refresher and configured it through `PGB_*` variables that
image has never read. It rendered perfectly. It could not possibly have authenticated. Nothing
caught it for months, because no test ever opened a connection.

So this scenario asserts something physical: a workload the product rendered, holding no password
anywhere in its pod spec, runs a query against a managed cloud database — and keeps working after
the credential it never had would have expired.

### What it needs first

It requires the **A0.6 apps repo** (`E2E_ARGO_APPS_REPO` plus the `E2E_GIT_TOKEN` secret). Both the
workload and its bootstrap Job reach the cluster only through GitOps, so without a repo there is
nothing to assert against. The scenario refuses at configuration time rather than polling for objects
nobody pushed.

### Set the repo variables

All **variables**, not secrets — an engine name, a version and an instance class.

| Variable | Value |
|---|---|
| `E2E_KEYLESS_DB` | `1` to enable |
| `E2E_KEYLESS_DB_ENGINE` | `postgres` (default) or `mysql` |
| `E2E_KEYLESS_DB_ENGINE_VERSION` | **required** — per cloud × engine |
| `E2E_KEYLESS_DB_INSTANCE_CLASS` | **required** — per cloud × engine |

Optional: `E2E_KEYLESS_DB_NAME` / `_SERVICE` / `_IMAGE` / `_CLIENT_IMAGE` / `_NAMESPACE`. The
defaults are fine.

The version and class have **no defaults on purpose**. A value valid on RDS is rejected by Cloud SQL
and by Flexible Server, and again by the same cloud's other engine, so a default would be a per-cloud
table that fails at `tofu apply` — minutes and money into a run — instead of in the first seconds.
Use the per-cloud siblings (`E2E_KEYLESS_DB_ENGINE_VERSION_GCP`, and so on) for a leg that differs.
The suffixed forms exist for `_ENGINE`, `_ENGINE_VERSION`, `_INSTANCE_CLASS`, `_IMAGE` and
`_CLIENT_IMAGE`, on `_GCP` and `_AZURE`. Set one that the workflow does not forward and it silently
has no effect, because the harness composes the name at run time — `TestPerCloudSiblingsReachTheNightly`
is what keeps this list and the workflow in agreement.

Starting points, matching what max-config already provisions for Postgres:

| cloud | postgres |
|---|---|
| **aws** | `16.6` · `db.r6g.large` |
| **gcp** | `16` · `db-f1-micro` |
| **azure** | `16` · `B_Standard_B1ms` |

For MySQL, read the current values off the offer-parity matrix rather than copying a Postgres row —
that matrix is the authority on what a given account can actually build, and these move.

`alibaba` and `hetzner` skip carrying the product's own exclusion prose: RAM governs ApsaraDB's
control plane only, and Hetzner Postgres is in-cluster CloudNativePG with no identity plane to mint
tokens against. Documented boundaries, not gaps.

### The dwell is the proof

The run holds one database session open for **16 minutes** — past the 15-minute RDS-IAM token
lifetime — queries it again on that same session, then opens a fresh connection. Both halves matter:
the first shows a spliced connection does not expire with the token that opened it, the second shows
the proxy mints per connection rather than caching the one it got at startup. A proxy that cached
forever would pass the first check and fail only the second.

There is deliberately **no repo variable for the dwell**. Below the token lifetime both checks pass
against a proxy that rotates nothing, and the run would claim a proof it did not perform. The
override exists for local debugging, and whatever dwell actually ran is recorded in the proof bundle
beside the verdict.

Budget accordingly: roughly **20–25 minutes** on top of soak + namespace + vcluster + xacct, per
enabled cell. The step timeout is 75 min, `go test` 80 min, job cap 90 min — watch the first run
before enabling a second cell on the same leg.

### Dispatch from `main`

Real applies are main-gated, so a dispatch from `dev` provisions nothing. Run the workflow with the
target `provider` from `main`, then record the bundle. The proof grid derived in `PROGRAMME.md` moves
**only** on a real-apply artifact in `demos/proofs/provisioning-e2e-log.md` — never on a green harness.

## Related

- `docs/testing/e2e-state-migration.md` — putting the four federation stacks on remote state
- `docs/testing/runner-xcloud-parity.md` — per-cloud runner → cluster parity
- `demos/proofs/` — committed proof bundles and the parity ledger
