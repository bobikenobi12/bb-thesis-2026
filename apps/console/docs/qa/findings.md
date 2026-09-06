# Console QA — findings

> **The run this file describes.** 2026-09-02, on the sandbox branch environment
> `env2-dev.alethialabs.io` (console `enterprise`, `ALETHIA_DEPLOYMENT_MODE=hosted`, **no Stripe,
> no `ANTHROPIC_API_KEY`, no live runner**), Next.js in development mode, 4 workers, no retries:
>
> ```
> ALETHIA_QA_E2E=1 pnpm -F console exec playwright test --project=qa --workers=4
> ```
>
> **136 passed - 192 failed - 1 skipped - 17 never ran, of 346, in 28.7 minutes.**
>
> That is the whole suite, executed once, and it is the first time it has ever been executed. It
> replaces the July log, which described a different console and asserted "11 domains, 340 tests"
> against a tree that holds neither number.

---

## Read the failures as three piles, not one

The headline is 39% and the headline is misleading in both directions. 192 failures come from a
small number of causes, and only some of them are about the console:

| pile | tests | what it means |
|---|--:|---|
| **The environment cannot answer the question** | 36 | Hosted billing and a live model are not configured on a branch env. The spec is not wrong and the console is not broken; the question cannot be asked here. |
| **One stale line in the harness** | 32 | `e2e/helpers/seed.ts` writes a column the schema dropped. Every project-scoped test dies in its fixture. |
| **The spec describes the July console** | ~120 | Real drift: surfaces renamed, restructured or deliberately deleted between 2026-07-05 and now. |
| Undecided | the rest | Named below, where they are. |

Nothing in this run reproduced a *new* product defect. That is a statement about what this run
measured, not an all-clear: 32 tests never reached the console at all, and 36 more met a
configuration wall before any assertion ran. The one failure that looked like a live defect - a
console route rendering no `main` landmark - turned out to be a route that no longer exists (P2-10).

---

## P0 - the harness, not the app

### 1. `helpers/seed.ts` writes a column that no longer exists - 32 tests die in their fixture

```
PostgresError: column "argocd_admin_password" of relation "project_cluster" does not exist
```

- **File:** `apps/console/e2e/helpers/seed.ts:138` (`seedFinishedDeploy`). The schema
  (`lib/db/schema/project-components.ts:171`) carries `argocd_url` and nothing else; the password
  column was dropped and the seed helper was never followed.
- **Blast radius, measured:** `deploy-jobs.spec.ts` **21 of 21** (4 failed, 17 never ran - a failing
  `beforeAll` takes the rest of the file with it), `cross-cutting.spec.ts` 10 of its 11 failures,
  and `_seed-smoke.spec.ts`. **9% of the suite cannot reach the console.**
- **This is the single highest-value repair in the backlog** and it is one line. It is not made
  here: `helpers/seed.ts` is outside #3633's `scope:`.
- Until it lands, **no number in this document is a verdict on the deploy-jobs domain.**

### 2. `_seed-smoke.spec.ts`'s cleanup can delete the org other specs are still using

Its `afterAll` calls `cleanupOrg(ownerHobby.orgId)`, which deletes that org's jobs, projects and
cloud identities. The suite is `fullyParallel`, so it fires while other files are still driving that
persona. `cross-cutting.spec.ts` and `navigation-shell.spec.ts` both state in their headers that
they deliberately do NOT clean up, for exactly this reason. One file disagrees with two.

---

## P1 - questions this environment cannot ask (36 tests)

### 3. Billing and Usage render "Self-managed deployment" - 35 tests

`getBillingSummary().hosted` is false without Stripe, and both panels short-circuit to a single card
(`components/settings/billing/billing-panel.tsx:103`,
`components/settings/usage/usage-panel.tsx:135`):

> Self-managed deployment - This instance isn't connected to hosted billing, so usage isn't metered here.

So every assertion for "Current plan", "Plan & limits", "Seats", "Pro plan", "Hobby plan",
"Trialing", "AI usage", "Plan history" or "Payment & billing details" fails against a page that is
behaving correctly. That is `billing.spec.ts` **22 of 22**, `billing.negative.spec.ts` **4 of 4**,
and the nine `Usage -` tests in `agent-usage-activity.spec.ts`.

**These specs are not stale and must not be rewritten to match this env.** They need a
Stripe-configured deployment - today only the primary env, `dev.alethialabs.io`. Until the suite can
declare which surface it needs, a branch-env run will always report those 35 red.

### 4. A runner destroy queues no job without a runner - 1 test

`runners.negative.spec.ts` "destroying a deployed runner queues a DESTROY_RUNNER job" expects
`>= 1`. No runner is attached to a branch env; attaching one is a separate opt-in step.

---

## P2 - the console moved and the spec did not (~120 tests)

Each of these is one cause with a large blast radius. They are listed by what changed, because that
is the unit of repair.

### 5. The breadcrumb is a second `role="link"` named "Overview" - 29 tests in one file

`navigation-shell.spec.ts`'s `waitForShell()` helper is `getByRole("link", { name: "Overview" })`,
and the shell now paints two of them:

```
strict mode violation: getByRole('link', { name: 'Overview' }) resolved to 2 elements:
  1) <a href="/~" ...>                                   aka getByRole('complementary')...
  2) <span role="link" aria-current="page" data-slot="breadcrumb-page">Overview</span>
```

Every test in the file calls that helper first, so **29 of its 31 failures are this one line.**
`cross-cutting.spec.ts` already scopes the same locator to the complementary landmark and passes -
the two files disagree, and the one that knew wrote it down in its own catalog entry.

Re-run serially (`--workers=1`) the file scores 7 passed / 31 failed, **identical to the parallel
run**. This is drift, not load.

### 6. The sidebar's top level is not the July one

`components/shell/nav-config.ts` now lists Overview - Clusters - Jobs - **Evidence** - Connectors -
Alerts - Usage - **Support** - Settings. **Runners moved into a drill and Agent is gone** (the agent
is reached from the topbar "Ask AI" control). The spec asserts a row per name for
`["Overview", "Clusters", "Jobs", "Runners", "Connectors", "Agent", "Usage"]`.

### 7. The members page has no stat strip - and that is what the RBAC negatives gate on

`components/settings/members/members-table.tsx:536` records the removal: the Seats / Active /
Pending / Suspended figures became the Status facet's counts, under CLAUDE.md's "No stat-card
strips". So:

- `rbac.spec.ts`'s "stat strip + toolbar render (Seats / Active / Pending / Suspended)" asserts a
  surface the console deliberately deleted, and
- **all four `rbac.negative.spec.ts` member denials fail on `getByText("Seats")`, which is the
  *precondition*, not the denial.** Those four tests have still never measured a permission.

That distinction matters more than the count. The `member` persona is real -
`_persona-integrity.spec.ts` is 3/3, the persona renders in the org's own member list, and the
*server* refuses it: the integrity spec drives `organization/invite-member` from the member's
session and from the owner's session in the same org and asserts the two disagree. What is untested
is the *UI's* denial, because the spec cannot get past a heading.

One further observation from the members table: the built-in `member` role is displayed as
**"Viewer"** while the `member` row says `member`. Confirm which word is intended before a spec
asserts either.

### 8. The connectors board is on the console filter standard now

`components/connectors/connectors-filter-bar.tsx` replaced the July search box and group `combobox`.
Gone: an accessible "search connectors" field, the "Apps"/"Clouds" group headings, the
`N / M connected` counter, and the copy "No connectors match your search." Also, `Connect` is no
longer unique - `getByRole("button", { name: "Connect" })` **resolves to 29 elements**, so both
`connectors.spec.ts` and the member read-only negative fail on ambiguity rather than on behaviour.
`connectors.spec.ts` 14 of 23, `connectors.negative.spec.ts` 5 of 5.

### 9. `/{org}/~/new` was rebuilt

The create surface now opens on "Provision the future.", a prompt composer, **Import Git
Repository** with GitHub/GitLab/Bitbucket linking, and "Start from scratch / Start from a template".
The spec looks for a `^project$` heading, a "general purpose workloads" template tile and a "Create
empty project" button. `projects.spec.ts` 12 of 20, `projects.negative.spec.ts` 4 of 8.

### 10. `/{org}/~/agent` is not a route any more - 7 tests

Not a rename. There is **no `app/(private)/[org]/~/agent` directory**; the console's agent is
reached from the topbar "Ask AI" control, and the sidebar row is gone with it. The console's own
error collector caught what the assertions could not say:

```
404 GET https://env2-dev.alethialabs.io/<org>/~/agent
```

So `cross-cutting.spec.ts`'s "agent loads without a 500" finds no `main` landmark because there is
no page, and the six `Agent -` tests in `agent-usage-activity.spec.ts` ("New chat", the `ask`/`act`
segment, "search chats") are driving a deleted surface. **This was the run's strongest-looking
candidate for a live defect and it is not one** - which is exactly why a failure gets read before
it gets counted.

### 11. The 404 page's "Go home" is not a link

`navigation-shell.negative.spec.ts` (3 of 5) looks for `getByRole("link", { name: /go home/i })`.
The page renders the words - "404 - Organization not found - This organization doesn't exist, or you
don't have access to it. - Go home" - under a different role.

The July P3 finding still reproduces exactly: an unknown **project** slug under a valid org renders
"Organization not found". The comment on `app/(private)/[org]/not-found.tsx` calls that a deliberate
non-leak; a project-scoped wording would still read better.

### 12. Alerts - drift and the suite's own bugs (16 of 28)

Empty-state headings ("No channels yet", "No policies yet") moved into `EmptyState`; the channel
detail's "Transport" label is gone. Two tests hit the strict-mode collision the July log already
recorded: a policy name matches both the rail row and the "Used by" pill. `alerts.negative` is
**5 of 5 passed, including the member permission denial** - the only member negative in the suite
that currently measures anything.

### 13. Onboarding - the OTP budget is the constraint (8 of 29 across both files)

Better Auth caps OTP issuance at 5 sends / 60s (`lib/config/auth.ts`), and with no trusted IP header
in front of a branch env (#3789) that bucket is shared by the whole install. `onboarding.spec.ts`
drives full signups; four of its failures are 180s timeouts consistent with a refused send rather
than a changed page. The create-org sheet's trial CTA ("start ... free trial") is real drift.

---

## What passed, and is therefore current

`_smoke` 2/2 - `_persona-integrity` 3/3 - `alerts.negative` 5/5 - `cross-cutting.negative` 4/4 -
`onboarding.spec` 15/22 - `cross-cutting.spec` 20/31 - `rbac.spec` 14/40 - `runners.spec` 10/16 -
`connectors.spec` 9/23 - `projects.spec` 8/20 - `agent-usage-activity.negative` 6/8.

The anonymous auth boundary (`cross-cutting.negative.spec.ts`) is fully green: every protected
surface still redirects a no-session context to `/login`, with no 5xx and no leaked shell.

---

## Testability gaps (re-confirmed against today's console)

The suite leans on roles and visible copy, which is why so much of the drift above is *invisible*
rather than *behavioural*. A `data-testid` or an `aria-label` would harden both.

| Area | Control lacking a stable accessible handle |
|---|---|
| shell | The breadcrumb's current page carries `role="link"`, colliding with the sidebar row of the same name |
| connectors | Every card's "Connect" button - 29 identical accessible names on one page |
| members | Role cells; the invite dialog's role picker |
| projects | Create-form cloud tiles; the design-canvas nodes |
| alerts | Policy rail row vs its "Used by" pill; the channel detail name input |
| agent/usage | Mode segment and metric tabs expose active state only via a CSS class |
| 404 | "Go home" - a control whose role the spec and the page disagree about |

---

## The order to repair these in

1. `helpers/seed.ts:138` - one line, unblocks 32 tests including a whole domain.
2. `navigation-shell.spec.ts`'s `waitForShell` - one line, unblocks up to 29.
3. Teach the suite which specs need hosted billing, so those 36 report as *not applicable here*
   rather than as failures.
4. `rbac.negative.spec.ts`'s precondition - until it stops waiting for a deleted stat strip, the
   four RBAC denials remain the only member-permission tests in the console that have never run.
5. The per-surface rewrites: connectors, `/~/new`, agent, alerts.

None of them are made in #3633, which built the persona and took the baseline.
