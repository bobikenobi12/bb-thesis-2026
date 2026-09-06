<!--
SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
SPDX-License-Identifier: AGPL-3.0-only
-->

# Architecture

Per-component reference. `CLAUDE.md` holds the operating contract — the rules you need
*before* acting; this holds the map you need *while* working. Verified by
`pnpm check:docs-contract`, so every path here exists.

**Monorepo:** pnpm 9 workspaces (`apps/*`, `packages/*`, `ee`), Turborepo for `build` / `lint`
/ `check-types` / `test`. `go.work` links `apps/cli`, `apps/runner`, `packages/core`.
release-please for versioning; GoReleaser (`apps/cli/.goreleaser.yml`) for the CLI binaries and
Homebrew tap.

---

## apps/console — the web control plane

```
apps/console/
  app/
    (private)/dashboard/   authenticated routes
    (public)/auth/         sign-in, email confirmation
    api/                   auth, jobs, runners, CLI
    server/actions/        server actions, grouped by domain
  components/              feature components (ALL shadcn primitives live in @repo/ui;
                           ai-elements/ is the one chat-message family)
  lib/
    db/                    Drizzle schema, migrations, client (getServiceDb/withActorScope)
    auth/                  Better Auth config, client, session helpers
    queries/               reusable typed query builders
    validations/           zod schemas (drizzle-zod)
    storage/               S3-compatible object storage
    cloud-providers/       AWS, GCP, Azure helpers
    fleet/                 the in-app managed-runner scaler
    stores/                Zustand UI state
  types/jsonb.types.ts     JSONB field interfaces
```

Data fetching is TanStack Query; Zustand is for UI state only. List-page filters follow the
standard in `apps/console/lib/query/README.md`.

**Key patterns**

- Cloud integrations repeat the same shape across AWS/GCP/Azure: server actions under
  `app/(private)/dashboard/providers/`, connection components in `components/connector/`.
- Every `cloud_identities` query must filter by `provider` — otherwise it leaks across clouds.
- The runner switches on `cloud_identity.provider` for auth: AWS `AssumeRole`, GCP workload
  identity federation, Azure federated identity.

DB pipeline, JSONB typing and validators: `.claude/skills/db-pipeline/SKILL.md`.

## apps/cli — the `alethia` CLI

Entry point `apps/cli/main.go` → `cmd.Execute()`. Cobra, with ~60 command files under
`apps/cli/cmd/` covering auth, projects, jobs, provisioning, runners, clusters, plus the day-2
verticals (activity, alerts, billing, cost, drift, fleet, grants, probes, promotion, roles,
sso, teams, usage …).

Conventions: interactive selection via Charmbracelet `huh`; tables via Bubble Tea with
`j/k` navigation; Lipgloss colours — purple headers, cyan accents, green success, red errors.
Version is injected at build time (`apps/cli/internal/version/version.go`).

Ships via GoReleaser (`apps/cli/.goreleaser.yml`) cross-platform, plus a multi-stage alpine
image (`apps/cli/Dockerfile`).

**Environment:** `ALETHIA_WEB_ORIGIN` (optional; defaults to `https://alethialabs.io`) ·
`ALETHIA_NO_UPDATE_CHECK` (disables the daily interactive release notice) · `ALETHIA_RUNNER_OPERATOR`
(`managed` | `self`; legacy `ALETHIA_RUNNER_MODE` still maps) · `ALETHIA_RUNNER_ID` /
`ALETHIA_RUNNER_TOKEN` · `ALETHIA_STORAGE_*`.

## apps/runner — the provisioning agent

Long-running daemon: polls for queued jobs, claims them, executes OpenTofu, streams logs back.
`cmd/` is the entry point, `internal/agent/` the execution engine.

`operator=managed` runs in the platform account and assumes into customer accounts, billed by
provisioned hours; `operator=self` runs in the customer's cloud with native permissions, split
further by `provisioning` into `deployed` and `registered`.

**The verification gate:** between `tofu plan` and `tofu apply`, `provisioner.RunDeployV2` runs
`packages/core/verify` over the plan JSON and attaches a report. A real apply is **fail-closed**
— a hard control failure blocks before apply unless an authorized override waives it. See
`packages/core/verify/README.md` and `ELENCH.md`.

## packages/core — shared Go library

Shared types, the cloud-provider abstraction (`CloudProvider` → `ProviderTfvars`), embedded
OpenTofu templates, ArgoCD application rendering, and two policy packages:

- **`verify`** — the deterministic, fail-closed gate over plan JSON (keyless / least-privilege /
  OIDC-sub controls, honest `not_evaluable`, ed25519-signed evidence receipt).
- **`drift`** — turns `plan -refresh-only -json` into a per-environment drift posture.

Templates: the seed bootstrap is in `packages/core/assets/tofu/seed/`; full per-cloud project
templates live in `infra/templates/project/`. They are copied verbatim and parameterised by a
tfvars map, never rendered.

## packages/* — shared web packages

Code used by more than one app is **promoted here, never duplicated**. The npm scope is
`@repo/*`; the directory is `packages/<name>`.

| Package | What |
|---|---|
| `packages/ui` | the shared shadcn/ui design system — import `@repo/ui/button` |
| `packages/brand` | logo, `tokens.css`, and the metadata/icon/OG generators |
| `packages/legal` | versioned company identity, legal-document metadata, and processing registry |
| `packages/plan-catalog` | plan display catalog, shared by console billing and marketing pricing |
| `packages/assets` | static files only, synced into each app's `public/` at dev/build |
| `packages/email` | Resend, SMTP, and SES transports plus react-email building blocks (templates stay per-app) |
| `packages/platform` | schema/enums/types **owned by `apps/admin`**, re-exported into console |
| `packages/support` | support-case schema, storage, validations, emails |
| `packages/eslint-config`, `packages/typescript-config` | shared presets |

**Consuming one:** add it to the app's `transpilePackages` and add a `@source` line in the app's
`globals.css` so Tailwind scans it. New packages need `lint` + `check-types` scripts so the
turbo fan-out picks them up.

## apps/marketing · apps/docs · apps/blog · apps/admin

- **marketing** — the hosted alethialabs.io site (landing, pricing, enterprise, contact, legal).
  The OSS console ships no marketing. Path routing is stitched by
  `apps/console/marketing-zones.json` and mirrored for the self-hosted Caddy router in
  `deploy/caddy/marketing.caddy.example`. `apps/console/lib/marketing-zone.ts` **derives** the
  reserved root segments from that file, so no org can claim `/pricing`;
  `apps/console/scripts/check-marketing-routes.mjs` fails CI if the two encodings drift.
- **docs** — Next.js + Fumadocs, content in `apps/docs/content/docs/`. The prose bar (Diátaxis,
  plain language, Vale) is a required check — see `apps/docs/README.md`.
- **blog** — Next.js + Velite.
- **admin** — the internal staff support dashboard (cases, orgs, spend). Owns the schema in
  `packages/platform`. Fronted by Cloudflare Access; the app trusts the
  `Cf-Access-Authenticated-User-Email` header.

## ee/ — the enterprise tier

Open-core boundary. Enterprise plugins (organization, SSO) load at console boot from `@alethia/ee`'s
built `dist` through the `getAuthPlugins()` seam; the community build has no `ee/` and correctly
returns `[]`. CI enforces the boundary (`pnpm -F console check:ee-boundary`). See `ee/README.md`
and `LICENSING.md`.

## infra/ — infrastructure

Per-cloud project templates (`infra/templates/project/`), runner templates, ArgoCD config, cloud
account bootstrap (`infra/connector/`), the control plane (`infra/cp-hetzner` and friends), and
the developer sandbox box (`infra/sandbox/`).

The managed runner fleet is driven by the **in-app scaler** (`apps/console/lib/fleet/`): a 60s
loop sizes per-provider warm pools by queue depth. The Hetzner provider creates cheap VMs whose
cloud-init runs a per-cloud runner image that self-registers.

**IaC rules** (fmt/validate, `check` blocks, one file per component, version pinning, and the
prohibition on agent-run applies) are in `infra/README.md`.

## CI/CD

`.github/workflows/ci.yml` is the PR gate: `check-types` / `lint` / `test` fan out via turbo
across every workspace project that defines them, plus build smokes, the Go matrix, the
authz/open-core guards, and gitleaks.

Mergify (`.mergify.yml`) queues dev PRs on **9 required checks**: TypeScript, the three Go
modules, Integration (real Postgres + RLS), Secret scan, Docs prose, Authz / open-core
guards, and capabilities-security — the fail-closed capabilities/connector/keyless gate that
replaced the dropped CODEOWNERS review (`.github/workflows/capabilities-security.yml`).

Deploys: `deploy-console.yml` builds the self-host images to GHCR and rolls the Hetzner
Compose deployment behind Cloudflare Tunnel; release-please drives the CLI (GoReleaser +
Homebrew tap) and the runner image. Marketing is part of the same Compose deployment.
