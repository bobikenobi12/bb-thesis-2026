# QA e2e authoring guide (read this before writing specs)

This suite exhaustively tests `apps/console` customer flows against a **live** console on
`http://localhost:3100` (a dedicated QA console: same-origin auth, SES off so OTP logs). Backends
(Postgres :5433, OpenFGA :8082) are shared and running.

## How to run a spec (ALWAYS use these env vars)

```bash
cd apps/console
REUSE_AUTH=1 E2E_BASE_URL=http://localhost:3100 DEV_CONSOLE_LOG=/tmp/alethia-qa-console.log \
  E2E_WORKERS=1 E2E_RETRIES=0 npx playwright test e2e/flows/<your-file>.spec.ts
```

- **`REUSE_AUTH=1` is mandatory** — it reuses the already-created persona sessions and skips
  global-setup's OTP signups. Omitting it re-signs-up personas and races the shared OTP log across
  concurrent runs. Never omit it.
- Use `--grep` or a single file; keep `E2E_WORKERS=1` for self-checks.

## Import surface

```ts
import { test, expect } from "../fixtures/qa";
```

Fixtures (each is a fresh browser context on a persona storageState, with perf + console/network-error
collection auto-attached):

- `owner` — Hobby (free) org owner. `{ page, orgSlug, orgId, userId, guard, perf }`.
- `team` — Pro (card-less trial) org owner. Same shape. Use for billing/seats/paid-only surfaces.
- `member` — invited member (reduced perms), in the **`team` persona's org**. Same shape plus
  `role`. Built by `e2e/global-setup.ts` through the product's own `organization/invite-member` →
  `accept-invitation` endpoints (#3633), so it needs no gate: use it directly. The old
  `test.skip(!process.env.HAVE_MEMBER, …)` guard is **gone and must not come back** — an unset
  variable turned every permission denial it protected into a green skip. If the persona could not
  be built the fixture throws, which is the correct verdict.
  Before trusting a member-denial result, read `flows/_persona-integrity.spec.ts`: a member with no
  access renders the org 404 everywhere, so a denial only counts where the **owner of the same org**
  sees something different.

Route model: org-scope = `/${orgSlug}/~/<page>` (connectors, runners, jobs, alerts, agent, clusters,
usage, settings/{general,billing,members,teams,roles,access,sso,activity}); project-scope =
`/${orgSlug}/${projectSlug}/<page>` (architecture, environments, jobs, clusters, usage,
settings/activity). New project: `/${orgSlug}/~/new`.

## Preconditions via the seed helper (no real runner/cloud)

```ts
import { seedCloudIdentity, seedProject, seedFinishedDeploy, seedJob, seedDrift, cleanupOrg } from "../helpers/seed";
const id = { userId: owner.userId!, orgId: owner.orgId! };
const identity = await seedCloudIdentity(id, { provider: "aws" });         // connected cloud identity
const project = await seedProject(id, { cloudIdentityId: identity.id, status: "ACTIVE" });
await seedFinishedDeploy(project);   // clusters/DB ACTIVE + endpoints (mimics finalizeDeployment)
await seedJob(id, { jobType: "DEPLOY", status: "SUCCESS", projectId: project.projectId, envId: project.envId });
await seedDrift(project, { inSync: false, drifted: 2 });
```

Job status enum is `QUEUED|CLAIMED|PROCESSING|SUCCESS|FAILED|CANCELLED` (**SUCCESS**, not SUCCEEDED).
Clean up org-scoped seed rows in `afterAll` with `cleanupOrg(owner.orgId!)` when a spec seeds a lot.

## Conventions & rules

1. **Selectors**: `getByRole` (name via accessible text) → `getByLabel`/`getByPlaceholder` → `getByText`.
   Avoid brittle CSS. If a control has NO accessible handle, DON'T edit app code — record a
   "testid gap" finding (file + element) instead.
2. **Isolation**: prefer creating uniquely-named resources per test (`e2e-${Date.now()}`), or seed +
   `cleanupOrg` in `afterAll`. Don't assume an empty org (other specs share the persona org).
3. **Assertions**: 1–4 focused assertions per test; one concern per test. Use `await expect(...)`.
4. **Waits**: `await page.waitForURL(...)` for nav; `expect(locator).toBeVisible({ timeout })` for
   data. Don't use fixed sleeps.
5. **Coverage per domain**: happy path + negatives (validation errors, permission-denied for `member`),
   empty states, and at least one `expect(page).not.toHaveURL(/\/login/)` auth check. Where sensible add
   an a11y check: `import { scanA11y } from "../helpers/a11y"` (no-ops until axe is installed — fine).
6. **Console cleanliness**: for read-only page loads you may assert `owner.guard.expectClean()` — but
   many pages emit expected 401/analytics noise, so prefer recording (the reporter captures errors
   automatically) over failing on them, unless it's a clear 500 or uncaught error.
7. **Bugs**: when the APP misbehaves (500, broken flow, wrong copy, dead link), don't fight it — write
   the test to assert the CORRECT behavior (it will fail), mark it `test.fixme(true, "BUG: <desc>")`,
   and note it so triage can log it in `docs/qa/findings.md`.
8. **File layout**: `e2e/flows/<domain>.spec.ts` (+ `<domain>.negative.spec.ts` for permission/error
   paths). Use `test.describe("<Domain> — <journey>")`.
9. Never edit files outside `e2e/` and `docs/qa/`. Never commit. Never touch the user's WIP.

## What NOT to test end-to-end here
Real `tofu plan/apply/destroy` execution, live cloud credential verification, real Stripe charges,
real email delivery. Stop at "job QUEUED" or use the seed helper for post-deploy state.
