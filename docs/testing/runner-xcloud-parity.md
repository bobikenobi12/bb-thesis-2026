<!-- SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io> -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Runner → cluster provisioning — cloud parity & e2e board

Living status for **per-cloud runner health + cluster provisioning**: does each cloud's runner image
(`runner-{aws,gcp,azure,alibaba,hetzner}`) boot + **register**, and can a runner **provision a real cluster**
(EKS / GKE / AKS / Talos) on that cloud from a connected keyless identity. Tracking epic: **#1050**.
Run history: [`demos/proofs/runner-xcloud-e2e-log.md`](../../demos/proofs/runner-xcloud-e2e-log.md).

**How runs are recorded:** every e2e run goes through `scripts/e2e/runner-e2e.sh <cloud> <register|cluster>`,
which appends the ledger, captures a scrubbed proof bundle and files a deduped issue on failure.
**Failures are recorded, never hidden.** There is no matrix here to flip — verdicts are derived in
`PROGRAMME.md`, and the legend that named their glyphs went with the table it described.

## Parity matrix

> **Status is not here.** It rots, and this table proved it: it called four of five clouds
> "wired, gate off" for cluster provision after epic #1050 closed with all five wired, and it
> contradicted `provisioning-e2e-parity.md` in the same directory while both passed CI.
> `scripts/programme-rollup.mjs` names that pair as the reason it exists.
>
> The proof grid, the per-cell evidence and the open blockers are derived in **`PROGRAMME.md`**,
> below its generated marker. Read it there. What stays below is the reasoning the ledger cannot
> hold — decisions, post-mortems and measurements.

## What's left

- [x] **Ship #1052** (runner-image cross-compile fix) → train → redeploy correct-arch images.
- [x] **Fleet circuit-breaker** (auto-pause a zero-registration reap loop) — #1056.
- [x] **Stage 1 — registration** (image-arch proof) on each published image — all five PASS
      (2026-07-22, `runner-e2e.sh <cloud> register`).
- [x] **CI regression guard** — `runner-image-arch` job in `ci.yml` builds `runner-base` for
      `linux/amd64` and fails the PR if `/usr/local/bin/runner` isn't x86-64 (the AI-caught improvement).
- [ ] **Stage 2 — cluster provision** per cloud: run the connector CloudShell script, set the gate
      secret/var, dispatch `e2e-nightly.yml provider=<cloud>` (or `runner-e2e.sh <cloud> cluster`).
      **All clouds**, each enabled **deliberately** + cost-guarded (cheapest node shape, single-NAT, AWS
      cost ceiling), one at a time. Confirmed accounts + gate vars:
  - **AWS** — `alethialabs` *or* tovr's AWS (either works) → `E2E_AWS_ROLE_ARN`
  - **GCP** — Alethia-owned E2E project → `E2E_GCP_WIF_PROVIDER` + `E2E_GCP_SA_EMAIL`
  - **Azure** — the Alethia E2E subscription → `E2E_AZURE_CLIENT_ID` (AKS quota TBD)
  - **Hetzner** — scoped API token → `HCLOUD_TOKEN`

## Flagged issues
- **INCIDENT 2026-07-22 — fleet runner-churn (root cause).** Multi-arch build shipped an arm64 binary in
  the amd64 image; after #726 flipped the fleet to x86 `cpx31` VMs, every VM crash-looped (`execve`
  ENOEXEC) → never registered → the scaler reaped+recreated every ~4 min for ~8h (~100 emails). Confirmed
  on `runner-azure` **and** `runner-aws` (`e_machine=0xb7`). Mitigated: prod `azure` pool disabled; fixed
  in #1052 + a circuit-breaker in #1056.

## Security findings
- (none yet — populate as the per-cloud e2e runs + reviews land.)

## AI-caught improvements
- ✅ **DONE** — the `register` ELF-arch check is now a pre-merge CI guard: `runner-image-arch` in
  `.github/workflows/ci.yml` builds `runner-base` for `linux/amd64` and asserts `/usr/local/bin/runner`
  is x86-64 (`e_machine=0x3e`), failing the PR on `0xb7` (aarch64) — the exact 2026-07-22 regression.
  It builds the real image (a plain `go build` can't reproduce a Dockerfile ARG regression) and covers
  every per-cloud image, which all inherit the binary `FROM runner-base`. Gated on the runner surface
  (`apps/runner/`, `apps/cli/`, `packages/core/`, `go.work`).
