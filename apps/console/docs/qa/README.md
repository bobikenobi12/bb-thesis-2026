# Console QA — end-to-end engagement

> **Re-baselined 2026-09-02 (#3633).** The suite was authored on 2026-07-05 and merged on 2026-08-23
> having never been executed against the console it ships beside. It has now been run, in full,
> against a real console: the numbers, the persona set and the per-domain triage in this directory
> describe **that run**, not the July one.
>
> Read `findings.md` first — it carries the date, the environment, the exact command, and the
> per-spec verdict. Every number in this directory is traceable to it. Nothing here is generated,
> so **anything you find with no run date beside it should be treated as unverified prose.**

This directory holds the deliverables of the exhaustive e2e QA pass over `apps/console`:

- **`flow-catalog.md`** — every customer journey mapped (persona → journey → routes → cases,
  including negatives/empty/error paths). Assembled from the per-domain catalogs. Describes what the
  specs *attempt*; `findings.md` says what they *do*.
- **`findings.md`** — the run ledger and the triage: what passed, what failed, and whether each
  failure is a product defect, spec drift, or a harness problem.
- **`performance.md`** — per-route + per-server-action latency (p50/p95) from a serial perf pass.
- **`coverage-matrix.md`** — spec file × tests × personas × measured result.

## The suite

25 spec files under `apps/console/e2e/flows/**` — 22 domain files plus three harness ones
(`_smoke`, `_seed-smoke`, `_persona-integrity`) — and **346 tests**.
`playwright test --project=qa --list` is the only authority on that count: three earlier documents
in this directory each asserted a different one (320, 340, 307) and the tree held none of them.
A test count is not a file count, either — several files build their cases in a loop.

It is its own Playwright project, `qa`, and it is **not** wired into any required check. See
*Gate posture* below.

### Personas

All three are real accounts, created once per run by `e2e/global-setup.ts` and reused through
storageState. They are created **serially**: Better Auth caps OTP issuance at 5 sends / 60s
(`lib/config/auth.ts`), and with no trusted IP header in front of a sandbox env (#3789) that bucket
is shared by the whole install, not per client.

- **ownerHobby** — free-tier org owner (default surface for read/nav specs).
- **ownerTeam** — Pro org owner (billing/seats/paid surfaces). Onboarding takes the card-less trial
  where Stripe is configured and falls back to Hobby where it is not, so the org is granted a
  `team`/`active` billing record explicitly (see below).
- **member** — invited into ownerTeam's org with the built-in `member` role, through the product's
  own `organization/invite-member` → `accept-invitation` endpoints. **Built as of #3633.**

**Two things the member persona ran into, both measured, both still true:**

1. **Inviting is a paid feature enforced at the endpoint.** `app/api/auth/[...all]/route.ts` gates
   `invite-member` on the `organizations` entitlement, so an org resolving community entitlements
   gets `403 upgrade_required` — from the API, not from the dialog. `global-setup` therefore writes
   ownerTeam's org a `team`/`active` `organization_billing` row before inviting. That is a fixture,
   not a bypass: ownerHobby's org is untouched, so `rbac.spec.ts`'s community-vs-Pro ladder still
   measures the real refusal.
2. **A member with no access renders the org's 404 on every route** — and every negative asserting
   "the member cannot see X" then passes while measuring the 404.
   `flows/_persona-integrity.spec.ts` exists for exactly that: it proves the persona is a *distinct*
   live session, that it can load the org *normally*, and that it is refused something the **owner
   of the same org is not**. Restriction is a difference, never an absolute — an unentitled org
   refuses everybody. **Run it before believing any negative result in this directory.**

There is no `HAVE_MEMBER` environment gate any more. It used to guard the RBAC/permission negatives
with `test.skip(!process.env.HAVE_MEMBER)`, and an unset variable turned each of them into a green
skip. A missing persona now fails, loudly, in the fixture.

### Test taxonomy

Smoke (page loads) · Journey (multi-step happy path with real mutations) · Negative
(validation/permission/empty/error) · Resilience (console/network-error + a11y) · Performance
(latency capture).

## How to run

**Not on your Mac.** Sign-in scrapes the one-time code out of the console's stdout, and that log
only exists on the machine running the console (`.claude/skills/dev/SKILL.md`). So the suite runs on
the sandbox box, against that box's own console.

```bash
pnpm env:up          # this branch gets a console, a database, a URL
pnpm env:push        # after editing — there is no hot reload
pnpm env:status      # confirm `scope: enterprise` (see below)
```

`pnpm env:test` does **not** export `ALETHIA_QA_E2E`, so it cannot start this suite: `global-setup`
returns immediately without it and every spec dies on a missing `personas.json`. Run it over ssh
with the variable set:

```bash
ssh root@<box> "
  cd /opt/alethia/envs/<slug>
  export DEV_CONSOLE_LOG=/var/log/alethia-<slug>.log
  export E2E_BASE_URL=https://<slot>-dev.alethialabs.io
  export ALETHIA_QA_E2E=1
  unset CI
  pnpm -F console exec playwright test --project=qa --workers=4
"
```

- `REUSE_AUTH=1` skips persona creation and reuses `e2e/.auth/` — use it for a second pass in the
  same environment, and only then. The personas are per-run accounts.
- A single domain: append `flows/<domain>.spec.ts`.
- The perf roll-up (`test-results/qa-report.json`) is written by `e2e/reporters/qa-reporter.ts`,
  which **`playwright.config.ts` does not register**. Ask for it explicitly:
  `--reporter=list,./e2e/reporters/qa-reporter.ts`. Without that flag the file this directory's
  performance numbers come from is never produced.

**The console must be serving `enterprise`.** A community-scoped console refuses a `team`/`active`
billing row with `403 upgrade_required`, so the member persona cannot be built and every
paid-entitlement assertion goes vacuous rather than failing. `pnpm env:status` measures the running
process, not `ee/dist` on disk — those two have come apart before (#3632).

Spec authoring contract: `apps/console/e2e/AUTHORING.md`.

## Gate posture

`qa` joins **no required check**, and this pass did not change that. `playwright.config.ts`'s
`RUN_POSTURE.qa` is `null` with a reason in `LOCAL_ONLY_REASON.qa`, and `assertNoDeadZone()` checks
that map against `.github/workflows/**` in both directions on every Playwright invocation — so the
`null` is verified, not asserted.

#2417 is what happens when a 320-test suite becomes a merge gate unvalidated. The bar for promotion
is not "the suite exists": it is a triaged run where every red is either fixed or recorded with a
reason, which is what `findings.md` now starts. Promotion also needs a workflow job that does not
exist yet — and the posture map, its reason string and that job have to move in one change, or
`assertNoDeadZone()` fails the two merge-gating Playwright runs.
