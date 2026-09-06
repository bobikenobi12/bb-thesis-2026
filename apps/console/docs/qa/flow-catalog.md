# Console QA — flow catalog

> **This file describes what the specs ATTEMPT, not what they do.** It was written on 2026-07-05
> alongside the specs, and the console has moved under both since. `findings.md` carries the
> 2026-09-02 run and the per-domain verdict; where the two disagree, the run is right.
>
> Domain sections known to describe a console that no longer exists: **navigation-shell** (the
> sidebar's top level, and `~/agent` — a route that has been deleted), **connectors** (rebuilt on
> the console filter standard), **projects** (`/~/new` rebuilt), **rbac** (the members stat strip
> was removed), **alerts** (empty states moved to `EmptyState`). Read those against `findings.md`
> before believing a case list.
>
> **No status claim lives in this file.** One used to — a hand-typed per-spec tally, in a directory
> `pnpm check:one-board` does not scan — and it was wrong with nothing able to say so. Measured
> numbers belong in `findings.md`, beside the date and the command that produced them.

Every customer journey mapped per domain (persona → journey → routes → cases incl. negatives/empty/error). Authored into `apps/console/e2e/flows/<domain>.spec.ts` (+ `.negative.spec.ts`). Assembled from the per-domain catalogs.

## Domains

- [onboarding](#onboarding)
- [connectors](#connectors)
- [projects](#projects)
- [deploy-jobs](#deploy-jobs)
- [runners](#runners)
- [rbac](#rbac)
- [alerts](#alerts)
- [agent-usage-activity](#agent-usage-activity)
- [navigation-shell](#navigation-shell)
- [cross-cutting](#cross-cutting)

---

## onboarding

## Onboarding

**Persona / journey.** A brand-new visitor signs up (email-OTP, no password), picks a plan in the `/onboarding` wizard (Hobby free vs Pro card-less trial), names their org, and lands on the org overview `/{slug}`. A returning user logs in via `/login` and skips onboarding. An existing owner creates a second (paid/trial) org from the header org-switcher's create-org sheet. An invitee opens `/invites/accept` and is gated to `/login` when logged out.

**Routes.** Public: `/signup`, `/login`, `/onboarding`, `/invites/accept`. Authed: `/{orgSlug}` (overview) with the sidebar `OrgSwitcher` (combobox chevron, aria-label "Switch organization") + `CreateOrgSheet`.

**Components exercised.** `components/auth/auth-form.tsx` (providers -> email -> code steps), `components/auth/onboarding-form.tsx` (plan tiles "Personal projects"/"Commercial projects", org name/slug, Customize URL), `components/org/create-org-sheet.tsx` (name -> trial/pay -> invite), `components/org-switcher.tsx`, `app/(public)/invites/accept/page.tsx`.

### Cases authored (29)

**Public auth pages (9)** — signup create-account hero + email CTA; login returning hero; OAuth provider buttons (GitHub/Google); SSO present-but-disabled (coming soon); signup email step reveals Work email field; login email step reveals field; email step back-to-providers; `?email=` prefill skips provider grid; signup-page a11y scan (no serious violations).

**Fresh signup + plan pick (4)** — wizard shows both plan tiles with Hobby default (`aria-pressed=true`); Customize URL toggle reveals slug editor; full Hobby signup lands on org overview (create-project affordance visible, off `/onboarding`); full Pro-trial signup ("30-day trial · no card required") lands on org overview.

**Returning user login (1)** — an already-onboarded account logs in via OTP and is routed to the app, never back into `/onboarding` and never `/login`.

**Org switcher + create-org sheet (4)** — switcher lists the active org + its plan badge; exposes "Create organization"; opens the purchase sheet ("Create a team" + Acme Cloud field); name step advances to the card-less trial panel (owner still holds its one trial; no Stripe intent, no org created).

**Auth gating (4)** — `/onboarding` logged out -> `/login`; `/invites/accept?token=…` logged out -> `/login?next=…`; `/invites/accept` with no token -> "Invalid invitation"; authed persona not bounced to `/login` on its overview.

**Negatives (7)** — login with an unknown email -> "No account for this email" (no silent signup, offers Create-account); invalid email format does not advance past the email step (HTML5, no code screen); wrong 6-digit OTP -> inline "That code didn't work" and stays off `/onboarding`; code step "Use a different email" returns to email; reserved org slug ("docs") -> "…reserved…" error, stays on `/onboarding`; blank org name keeps the wizard Create button disabled; create-org sheet blank team name -> "Give your team a name." validation.

### Coverage notes / gaps
- **member persona** not needed for this domain (no reduced-perm surface here).
- **Not covered end-to-end** (intentional, per contract): real Stripe charge on the paid (trial-consumed) create-org path, real invite acceptance/delivery, OAuth provider round-trips (redirect off-origin).
- **Environmental caveat:** the 7 real-signup tests depend on the OTP log seam, and that seam has a budget — Better Auth caps issuance at 5 sends / 60s, one shared bucket for the whole install on an env with no trusted IP header (#3789). Several of them time out on a refused send rather than on a changed page. An infra condition, not a flow defect. See `findings.md`.

---

## connectors

## Connectors (`/{org}/~/connectors`)

**Persona/journey:** An org owner (canManage) opens the Connectors board to connect cloud accounts (AWS/GCP/Azure/token clouds), api-key services (Datadog/Vault/Docker Hub/Cloudflare), and git providers; browse/filter the catalog; and manage a connected account (rename, add another, disconnect).

**Route:** org-scope `/{org}/~/connectors` (page.tsx → getCloudConnectSetup → ConnectorsPage). Cloud verification is server-side (no runner). `?type=cloud` deep-links to the Clouds filter.

**Catalog groups (derived from category):** Clouds (aws/gcp/azure/alibaba/digitalocean/hetzner/civo), Secrets (vault), Registries (dockerhub), Apps (git: github/gitlab/bitbucket; dns: cloudflare; observability: datadog/grafana/prometheus).

**Cases covered:**
- Browse/filter (13): loads authenticated (no /login bounce); renders all four group headings; shows AWS/GitHub/Datadog from catalog; per-group 'N / M connected' counter; group filter → Clouds only (non-cloud + Apps heading drop out); group filter → Apps only; search by name; search by organization ('HashiCorp' → Vault); no-match empty state ('No connectors match your search.'); clearing search restores; card↔table toggle; table column headers; soft a11y scan.
- Connect sheets, opened + validated, never submitting real creds (3): api-key sheet opens ('Connect Datadog' + API Key field); api-key required-field validation ('API Key is required.'); **token-cloud sheet is test.fixme** documenting the empty-sheet bug.
- Connected cloud + manage sheet, seeded via seedCloudIdentity provider:'aws' (6): connected card shows 'Connected' + Manage; Manage opens detail sheet (heading, Accounts section, seeded account name); org-wide scope badge; 'Add another account' present; inline rename persists new name; disconnect → cloud-specific AlertDialog ('Disconnect Amazon Web Services?' + 'won't be able to provision…') → Cancel.
- Git (1): unconnected GitHub offers Connect (not clicked — OAuth redirect).

**Negatives / empty / permission (connectors.negative.spec.ts):**
- Not-enabled managed cloud without platform creds: Azure shows 'Not enabled on this instance' + 'Unavailable' pill + no Connect (self-skips if Azure is seeded-connected in the shared org).
- Connect-sheet validation: token-cloud too-short token (**test.fixme**, blocked by the empty-sheet bug); api-key second-required-field ('Application Key is required.').
- Member read-only: RUNS. The `member` persona is built by `e2e/global-setup.ts` (#3633); the HAVE_MEMBER gate is gone.

**Not covered end-to-end (by design):** real cloud credential verification, actual OAuth link, actual token-cloud/api-key submit (network verify) — validation stops before server verification per the QA contract.

---

## projects

## Projects domain — e2e catalog

**Persona / journey.** `owner` (Hobby free org) creates and manages projects. Journey: land on org
overview → create a project (agent hero OR manual name+template+cloud, OR empty) → design its
infrastructure on the Architecture canvas → manage isolated Environments (add/duplicate/delete +
consistency) → rename in General settings → delete (guarded while an environment is live). `team`
(Pro) and `member` personas not needed here (no seat/permission surface in this domain).

**Routes.** `/{org}` (overview grid + Add-new toolbar), `/{org}/~/new` (create form),
`/{org}/{project}` → redirects to `/architecture`, `/{org}/{project}/{architecture,environments,
jobs,clusters,usage}`, `/{org}/{project}/settings/general`.

**Cases authored.**
- Create surface (`/~/new`): hero heading + 01/02/03 manual blocks render; project-name field
  derives a live slug preview; template selector (Standard/AI Workloads/Custom) present + switchable;
  both create actions present; seeded verified cloud identity flips a provider tile to Connected;
  a11y scan (no serious violations; axe optional/no-ops locally).
- Create mutations: **Create empty project** provisions + opens the project (→ /architecture);
  **full manual create** with a seeded connected GCP tile provisions + opens the project.
- Overview grid: seeded project card appears; no-match search shows "No projects match your filters";
  **Add new** popover → Project reaches `/~/new`.
- Architecture canvas: loads with Add + Project-settings affordances; **Add** opens the service
  palette which accepts a search query; bare `/{org}/{project}` redirects to Architecture.
- Environments: default env listed with Default tag + no delete control; **New Environment (empty)**
  creates + lists; **Duplicate Environment** (default base) creates + lists; a non-default env is
  deleted via the row trash → confirm dialog.
- General settings: rename form + stable slug render; **rename** persists (Save enables → success).
- Delete (non-live): deleting a DRAFT project returns to the org overview.

**Negatives / empty / guards.**
- Create validation: empty name → "Project name is required" (stays on form); symbols-only name →
  "Enter at least one letter or number"; **Create project** without a selected cloud → "Select a
  connected cloud" (stays on form).
- Duplicate display name → succeeds with a DISTINCT slug (documents real dedupe behavior; hint
  expected a refusal — it does not happen).
- Delete guard: refused while an environment is ACTIVE ("live or in-flight", stays on settings).
- Env guard: New Environment requires a name (validation toast, dialog stays open).
- Not-found: unknown project slug → notFound page (no canvas). Auth: architecture/environments/
  jobs/clusters/settings never bounce an authenticated persona to /login.

**Not covered / deferred.** Full staged-change cycle (add node → Pending-changes bar → Discard
confirm) — canvas nodes lack testids; captured as a nice-to-have in the plan. `member`
permission-denied paths are unwritten for this domain — the persona exists, the specs do not. Real tofu/deploy execution stops at UI per AUTHORING.

---

## deploy-jobs

## Deploy-jobs domain

**Persona journey.** An org owner (Hobby persona `owner`, org `e2e-hobby-org`) designs a project, deploys it (provisioning jobs run up to QUEUED — real apply is out of scope), watches job logs, cancels/re-runs jobs, inspects provisioned clusters, and manages environments (drift, promotions, protection rules). All rows are seeded direct-to-DB (uniquely-named per run; no cleanupOrg — org is shared across parallel agents).

### Routes covered
- `/{org}/~/jobs` — org-wide jobs list (filter bar + table, or empty state)
- `/{org}/{project}/jobs` — project-scoped jobs (Project facet hidden)
- `/{org}/~/jobs/{id}` — job detail: header (type label + StatusBadge + duration), live SSE log pane, SUCCESS/FAILED/CANCELLED footers, Job Details / Config Snapshot / Execution Metadata collapsibles, Cancel (active) / Re-run (terminal) / Apply (PLAN success) actions
- `/{org}/~/clusters` and `/{org}/{project}/clusters` — cluster grid; card shows name, endpoint, kubeconfig cmd, ArgoCD link, DB/cache endpoints
- `/{org}/{project}/environments` — env list with Drift / Deploy-pending badges + auto-heal toggle, New Environment dialog, Promote dialog (diff preview), per-env Protection Rules dialog, consistency matrix, recent promotions with approve/reject

### Cases authored
**Happy paths (deploy-jobs.spec.ts, 21):** org jobs list loads (not /login) + filter bar; seeded Deploy row renders; status/type/project facets present; project-scoped list hides Project facet; row-click → detail; SUCCESS detail (label+footer); Job Details collapsible reveals full id; FAILED banner + error msg; Re-run affordance on terminal job; logs empty-state; in-flight (PROCESSING) job shows Cancel + waiting-for-runner; cancel → 'Job cancelled'; re-run queues a NEW provision job (UI-triggered QUEUED); org clusters heading; seeded finished-deploy cluster name+endpoint; ArgoCD link; environments heading+default env; Drift badge on drifted env; Default tag + auto-heal switch; New Environment dialog opens; Protection-rules dialog with predecessor/verify/approval gates.

**Negatives / empty states (deploy-jobs.negative.spec.ts, 5 — authored, not yet run live):** non-existent job id → 'Job not found.' (no crash, not /login); undeployed project → 'No clusters provisioned' empty state; single-environment project hides Promote (keeps New Environment); toggling 'Require approval' reveals the approvals-required input; New Environment dialog stays open on empty-name submit (validation).

**Auth:** every describe includes an `expect(page).not.toHaveURL(/login/)` check on a private route.

**Deliberately NOT covered (per AUTHORING):** real tofu plan/apply/destroy, live credential verify, real Stripe, plan-artifact 'Plan tab' (lives in the agent artifact panel, a separate domain — the job-detail page itself only has Config Snapshot / Execution Metadata collapsibles). `member` persona permission-denied paths are unwritten for this domain — the persona exists (#3633), the specs do not.

---

## runners

## Runners (`/${org}/~/runners`)

**Persona journey.** The runner surface is **entitlement-gated in hosted mode** (this QA console runs `ALETHIA_DEPLOYMENT_MODE=hosted`): the `byoRunners` flag (Pro+) unlocks it. So the **`team`** persona (Pro card-less trial → `byoRunners=true`) drives every interactive flow, while the Hobby **`owner`** persona is deliberately gated and drives the upsell path. In hosted mode managed fleet runners are hidden from tenants and the left-column **Pools** section isn't rendered, so the team org's baseline is 0 runners → deterministic empty states. `member` persona not exercised here (no reduced-perm surface on this domain).

### Routes / components exercised
- Page: `app/(private)/[org]/~/runners/{page,runners-client}.tsx`
- `components/runners/*`: `add-runner-button`, `add-runner-dialog` (Deploy/Register sheet + token reveal), `runner-card`, `runner-actions` (star / Remove / Destroy), `versions-panel`, `runners-toolbar`, `runner-select-popover`, `settings/upgrade/feature-upsell`.

### Cases covered (19)
**Happy paths (flows spec, `team`)**
- Pro org loads the runner surface (not upsell), no `/login` bounce.
- Versions panel renders with the empty-releases state ("No runner releases yet." — 0 releases seeded).
- First-run **empty-runners** state ("No runners yet" + copy).
- Grid renders one card per runner (2 seeded → 2 cards).
- Add-runner sheet path chooser (Deploy + Register cards + managed-pools hint).
- Register sub-view: name field + Back-to-chooser.
- **Register → one-time token reveal** (Runner ID + Runner Token + `alethia runner start` snippet + Done) — the core register flow returning a token.
- Registered runner appears in the grid after the sheet closes.
- Deploy sub-view renders its deploy description (form or connect-a-cloud state).
- **Set default**: star toggle → `is_default` flips (asserted via DB).
- **Remove** a registered runner: confirm dialog → card leaves grid + row deleted (DB).
- Remove **cancel** leaves the runner in place.
- Search narrows the grid to the matching runner.
- Filters popover exposes Status + Operator chip groups.

**Negatives / gates / empty (negative spec)**
- Non-matching search → "No runners match your filters." (empty-filter state).
- **Entitlement gate**: Hobby org → "Bring your own runners" upsell + "Available on the Pro plan." (no runner surface).
- Gated Hobby surface offers **no** "Add runner" action.
- **Destroy queues a job**: seeded deployed runner (cloud identity + deploy_config) → Destroy popover → Confirm → a `DESTROY_RUNNER` job is enqueued (asserted via DB; stops at "queued" per contract — a live shared-DB runner then claims+fails it against the fake creds, which is expected).

### Not covered (rationale)
- Full **Deploy** (`DEPLOY_RUNNER`) submit — needs a connected cloud + cached region resources + valid form; covered structurally (sub-view + description).
- **Update runner** / release-notes popover / "Update all outdated" — require existing `runner_releases` rows (0 in the QA DB); the empty-release states are covered instead.
- Warm **Pools** column — hidden in hosted mode (self-managed only).
- Real `tofu` teardown execution — out of scope per authoring contract.

---

## rbac

## RBAC / Access-control (org settings)

**Persona → entitlement ladder** (lib/billing/plan.ts): `owner` = Hobby/community (organizations=false, teams/customRoles/sso=Enterprise, canInvite=false → members read-only, Invite = Pro upsell); `team` = Pro card-less trial (organizations=true, canInvite=true while trialing → real invite + manage controls; teams/roles/access/sso stay Enterprise-gated); `member` = reduced-perm invitee, built by `e2e/global-setup.ts` through the product's own invite → accept endpoints (#3633) and asserted distinct-and-reduced by `flows/_persona-integrity.spec.ts`.

**Journey:** owner opens `/${org}/~/settings/{members,teams,roles,access,sso,general}` → views the RBAC surface → attempts a gated action (invite / create team / create role / register IdP) → either the real flow (Pro invite) or the plan upsell (Pro/Enterprise) → destructive controls confirm-gated.

**Routes:** `/${org}/~/settings/members · teams · roles · access · sso · general`.

**Cases (rbac.spec.ts, 40 tests):**
- Members (Hobby owner, read-only): auth check (not /login); stat strip + toolbar (Seats/Active/Pending/Suspended, search, role filter); owner row tagged 'You' = Owner; NO manage controls (no select checkbox, no Manage); Invite → Pro upgrade dialog ('Invite team members' + Upgrade to Pro); empty states — Pending tab, search-miss, role-filter=Viewer, Suspended tab; a11y axe scan.
- Members (Pro owner, manage + invite): manage select checkboxes present; Invite opens the REAL dialog (via resilient retry-open helper working around the trigger-remount race); role picker defaults to Viewer; Add another appends a 2nd row + 'Send 2 invites' pluralization; validation — malformed email, in-batch duplicate; existing-member rejected (server-side 400 + error toast, no pending row); **[fixme]** client-side 'Already a member' inline guard (blocked by getInviteContext 500 bug); invite lifecycle — send real throwaway invite → pending row → cancel (cleanup).
- Teams (Enterprise gate): Hobby empty surface upsell ('Create and manage teams' + 'Available on the Enterprise plan.'); Hobby + Pro 'Create team' → Enterprise dialog (Contact Sales); Pro still gated.
- Roles: built-in rail (Owner/Admin/Operator/Viewer + '4 built-in' count); default Owner detail (read-only description); selecting Viewer swaps detail; per-service permission matrix renders (Cloud identities group); empty custom section ('No custom roles yet.'); Create role → Enterprise custom-roles dialog (Contact Sales) on Hobby + Pro; rail search filters built-ins.
- Access (grants): Hobby inheritance note + 'Fine-grained access' upsell + no 'Add grant'; Pro still Enterprise-gated (no grants table / Add grant).
- SSO: Hobby 'Single Sign-On' upsell + no 'Register provider'; Pro still gated.
- General: profile prefilled (slug field = org slug); name/description/URL fields render; Save changes + Danger zone present; Delete org → confirm alertdialog, Cancel aborts (never confirmed — would break sibling specs); Transfer ownership stub → 'coming soon' toast.

**Negatives (rbac.negative.spec.ts, 4 tests, no longer gated):** member can view members but cannot invite (authz denial); cannot change another's role; cannot remove a member; cannot delete the org. These assert the server-side PDP (requireAccessAdmin / owner-only) denials the UI otherwise renders optimistically. The `HAVE_MEMBER` env gate was deleted in #3633: an unset variable turned all four into green skips.

---

## alerts

## Alerts domain — e2e catalog

**Persona → journey.** Alerts is a single anchor-scrolled page at `/${org}/~/alerts` with three stacked sections (Policies · Channels · Activity), each a connectors-style header with a Docs link. The whole surface is gated behind the `alerting` entitlement (Pro+). The `team` (Pro trial) persona drives the live CRUD surface; the `owner` (Hobby) persona drives the entitlement upsell. `member` (reduced perms) drives the channel-management denial.

**Routes.** `/${org}/~/alerts` (+ `#policies`/`#channels`/`#activity` deep-link anchors). Sidebar drill anchor-scrolls; no tabs. Seeding via `helpers/seed-alerts.ts` (`cleanAlerts`, `seedChannel`, `seedRule`, `seedDelivery`) against the org-scoped alerting tables only (safe under the parallel-agent rule).

**Cases covered (alerts.spec.ts — Pro/team):**
- Surface: all three section headings render; 3 Docs links; authed Pro not bounced to /login.
- Empty states: "No channels yet" + Add channel; "No policies yet" + New policy.
- Add-channel sheet: opens ("Add a channel" + Transport gallery); email empty-recipients inline error ("Add at least one recipient."); blank-name inline error ("Name your channel"); recipients editor rejects invalid email; webhook syntactically-invalid URL rejected pre-verify ("Enter a valid URL."); email happy path creates a verified channel (SES-off logs the sample).
- Channel detail: transport/target/Verified meta; search filter no-match ("No channels match."); rename → dirty save bar → save; disable → confirm dialog ("Disable this channel?"); delete → confirm → row removed.
- Channel verification: re-verify email succeeds ("Verified — a sample event reached the endpoint.").
- Policies: New-policy sheet opens ("New alert policy"); required name + ≥1 event validation; security (PDP) events locked without advancedAlerting; happy path create watching one event routed to a channel.
- Policy detail: events/routes/throttle meta; enable-switch toggle off; edit name → save; delete → confirm → removed.
- Deliveries (Activity): lists seeded sent+failed rows with a count; failed filter narrows; delivered filter narrows.

**Negatives/empty (alerts.negative.spec.ts):**
- Entitlement gating (Hobby): shows "Alerts & notifications" upsell + "Available on the Pro plan."; no Add channel / New policy controls; never reaches the Channels heading.
- Verification failure: webhook to an unreachable host fails verification and is NOT persisted (sheet stays open, inline error).
- Member permissions: cannot manage channels — RUNS as of #3633.

**Auth checks:** every gotoAlerts asserts `not.toHaveURL(/\/login/)`.

**Where alerts stands** is not stated here any more, and that is the point. This line used to read
`**Status:** 18/28 …` — a hand-typed per-spec tally, dated July, sitting in a directory
`pnpm check:one-board` does not scan (its `docs/testing` scope stops short of `apps/console/docs/qa`).
It was wrong and nothing could tell anyone. Every measured number in this directory now lives in
`findings.md`, next to the date, the environment and the command that produced it.

---

## agent-usage-activity

## agent-usage-activity

Persona journey: an org owner (Hobby = `owner`, Pro trial = `team`) explores the console's "insights" surfaces — the AI Agent chat, the Usage meters/charts, the Activity audit feed, and their account profile — none of which require a real AI or runner round-trip.

### Routes
- `/${org}/~/agent` — AI Agent chat shell (thread rail + Ask/Act segment + model picker). `components/agent/*`.
- `/${org}/~/usage` — Usage panel: plan & limits meters, resources, over-time CSS bar chart + range picker + metric tabs, AI usage. `components/settings/usage/usage-panel.tsx`.
- `/${org}/~/settings/activity` — org audit feed + reusable filter bar. `components/settings/activity/*`.
- `/${org}/${project}/settings/activity` — same feed pinned to a project (Export + Project facet dropped).
- Account menu → Settings dialog. `components/shell/{sidebar-profile,account-settings-dialog}.tsx`.

### Cases — happy (agent-usage-activity.spec.ts, 21 tests)
- Agent: reaches shell (auth check), Ask/Act segment + default model (Claude Sonnet 4.6) present, Act toggles active, model picker switches Sonnet→Opus, fresh chat shows suggestion prompts + composer placeholder, thread-rail search box.
- Usage (owner Hobby): auth check, all four taxonomy sections render, three plan meters (Seats/Runner minutes/Concurrency), cloud-spend disclaimer, quick-range 7d→14d relabels trigger, metric tab (Jobs) becomes active, inline Upgrade-to-Pro CTA.
- Usage (team Pro): "Pro plan" name + Manage-billing link (no upgrade CTA), spend-control hard-cap toggle.
- Activity (owner): auth check, filter bar (search + User/Project/Events facets), Events sheet opens with the event taxonomy + Result group, quick-range filter present.
- Account dialog: opens from account menu and shows the user email + heading; exposes display-name field, read-only email, auth badge, delete-account danger zone.

### Cases — negatives / gating / empty (agent-usage-activity.negative.spec.ts, 8 tests)
- Activity CSV export is Enterprise-only → disabled on Hobby (+ "Enterprise plan" title hint) AND on Pro (non-Enterprise).
- Retention gating: Hobby picking "Last 30 days" (older than the 7-day retention) opens the upgrade sheet instead of applying — trigger label stays "Last 7 days".
- Empty state: an unmatched search token narrows the feed to "No activity matches these filters." (robust vs seeded rows from sibling agents).
- Project-scoped feed (seeded project): hides Export CSV and the Project facet, and labels the scope ("Activity in …").
- Account validation: clearing the display name surfaces "Enter a display name" (no persist — avoids mutating the shared persona name).

### Not covered / notes
- `member` persona unavailable in this run → no reduced-permission Activity/agent denial paths.
- Real AI send is intentionally out of scope (QA console has no AI_GATEWAY_API_KEY → /api/agent 503).
- CSV export click-through and multi-page "Load more" need seeded audit rows (covered by unit tests, not e2e here).
- 4 happy-path tests carry known test-side selector/timing defects (strict-mode collisions from the single-page layout). `findings.md` records what the 2026-09-02 run made of this domain.

---

## navigation-shell

## Navigation shell

**Persona:** `owner` (Hobby org). All routes are authenticated; every case asserts `not /login`.

**Journey:** land on the org overview -> read the shell (sidebar + topbar + switchers) -> navigate top-level surfaces -> drill into sub-navs (Observability / Alerts / Settings) -> switch org/project/env -> drop into a project (project sidebar + Architecture icon rail) -> hit unknown routes (404) -> mobile drawer.

### Routes exercised
- Org scope: `/{org}` (overview), `/{org}/~/{clusters,jobs,runners,connectors,agent,usage,alerts}`, `/{org}/~/settings/{general,billing,members,teams,roles,access,sso,activity}`, `/{org}/~/new`.
- Project scope: `/{org}/{project}` (-> `/architecture`), `/{org}/{project}/{jobs,environments,clusters,usage,settings}`, `?environment_id=` pinning.
- Not-found: `/{org}/<unknown-project>`, `/{org}/<unknown-project>/jobs`, `/{org}/~/<unknown>`, `/<unknown-org>`.

### Cases
**Sidebar (org):** all top-level rows render (Overview/Clusters/Jobs/Runners/Connectors/Agent/Usage links + Alerts/Settings drill-links + Observability drill-button); Overview active on overview; each of the 6 org links navigates + sets tab title + highlights active (`bg-muted`); active state derived from a fresh deep-link with no click.

**Drills:** Observability click-drill opens (Jobs item + disabled Logs/Metrics/Traces stubs) and its Jobs item navigates; Alerts link + deep-link auto-open the route-owned drill (Policies/Channels); Settings link redirects to `/settings/general` and shows all 8 sections; a section link navigates + highlights active; deep-link to a sub-section marks it active.

**Disabled "Soon":** Sandboxes + Support render as visible-but-disabled buttons (never links).

**Switchers:** org switcher split-button (chevron `Switch organization`) opens picker (Find/Create/list), search-miss empty state, Create opens the sheet; project switcher shows `All projects`, lists a seeded project, selecting navigates in, search-miss `No project found`, Create -> `~/new`; env switcher renders on a project route with the default env, lists envs + New Environment, selecting pins `?environment_id=`, hidden at org scope.

**Project sidebar:** a project view swaps to the project nav (Architecture/Environments/Jobs/Clusters/Usage/Settings; Connectors/Runners absent); a project link navigates + active; Architecture collapses to the icon rail (Expand + Home, no Find box).

**Topbar / back:** topbar carries the project switcher + CLI download; breadcrumb reflects the page; browser-back restores the prior page + its active highlight.

**Negatives (404):** unknown project slug / project sub-page / `~` sub-page all render the branded 404 (`404` + Go home) without 500 or /login bounce; unknown org shows `Organization not found`; Go home leaves the 404.

**Mobile:** desktop sidebar hidden < lg; hamburger (`Open navigation`) opens the drawer with the same nav; tapping a link navigates + closes.

### Empty states / gaps
- Project-switcher empty-org state (`No projects yet.`) NOT covered — the shared persona org accumulates seeded projects from sibling specs, so an empty org can't be guaranteed without cleanupOrg (forbidden during the parallel run).
- `member` persona (permission-denied nav) not available; no reduced-perms nav cases authored.
- Env-switcher Shift+Tab cycling and cross-env switching (needs 2+ envs) not covered — only single-env select + `?environment_id=` pinning.

---

## cross-cutting

## Cross-cutting — resilience sweep

**Persona / journey.** The `owner` (Hobby) persona is the lens: an authenticated operator navigating directly (deep-link `goto`) to every major page. The journey is deliberately shallow-but-wide — "does each page even load without crashing?" — the broad safety net beneath the deep per-domain specs.

**What each swept route asserts** (helper `loadAndAssertShell` + `fatalErrors(guard)`):
- (a) document response `status < 500`;
- (b) URL did NOT bounce to `/login` (authed session resolves the route);
- (c) the shell `<main>` landmark (`components/shell/app-shell.tsx:81`) is visible — proof the page painted, not a blank/crash;
- (d) no fatal captured error: `pageerror` OR any `>=500` response (per AUTHORING rule 6, 4xx/console.error are recorded, not failed).

**Routes covered.**
- Org-scope (17): overview, `~/connectors`, `~/runners`, `~/jobs`, `~/clusters`, `~/alerts`, `~/agent`, `~/usage`, `~/new`, and all 8 settings tabs (general, billing, members, teams, roles, access, sso, activity).
- Project-scope (9, against one lazily-seeded deployed project — cloud identity + finished deploy + a SUCCESS job + drift): root(→architecture), architecture, environments, jobs, clusters, usage, settings/{general,access,activity}.
- Detail: `~/jobs/{seededJobId}` job artifact page.

**Landmark & title sanity (3).** Sidebar `Overview` link renders (scoped to the complementary landmark to dodge the breadcrumb's duplicate role=link); a metadata-titled page sets `document.title` (`/Jobs/`); a settings section titles as `… · Settings` (`/Roles/`). Note: `~/agent` and `~/usage` set no metadata title, so the sweep relies on `<main>` for those.

**A11y (1).** Non-blocking `scanA11y` record on the overview (axe no-ops to `[]` if `@axe-core/playwright` is absent) — surfaced by the reporter, never fails the run.

**Negatives / auth boundary (`cross-cutting.negative.spec.ts`, 4).** A fresh no-storageState (anonymous) context hitting protected surfaces — org overview, `~/connectors`, `~/settings/billing`, and a project route — must `waitForURL(/\/login/)` with no 5xx and no leaked authed shell (`Overview` nav link count 0). 404/unknown-route negatives are intentionally NOT duplicated here (owned by `navigation-shell.negative.spec.ts`).

**Empty states.** Not the focus of this sweep (per-domain specs own empty-state copy); the sweep only proves each empty/loaded page renders `main` without erroring.

**Isolation.** One uniquely-named project (`e2e-xcut-${Date.now()}`) is seeded once (module-level lazy, `E2E_WORKERS=1` keeps state) and never cleaned up — sibling QA agents share the persona org during the parallel run, so `cleanupOrg` is deliberately avoided.

**Result.** 35/35 pass; no broken pages, no 500s, no pageerrors across the whole authenticated surface.

---

