# Console QA — coverage matrix

> **Measured 2026-09-02** on `env2-dev.alethialabs.io` — the run described in `findings.md`. The
> `tests` column is what `playwright test --project=qa --list` reports; the result columns are what
> that one run produced. Nothing here is hand-counted, and nothing here is generated either: it is
> transcribed from the run's JSON report and it goes stale the moment the tree moves.
>
> Three earlier documents in this directory each asserted a different total — 320, 340 and 307 —
> and the tree held none of them. **`--list` is the only authority on the count.**

| spec file | tests | passed | failed | skipped / not run | personas |
|---|--:|--:|--:|--:|---|
| `_persona-integrity.spec.ts` | 3 | 3 | 0 | 0 | team, member |
| `_seed-smoke.spec.ts` | 1 | 0 | 1 | 0 | owner |
| `_smoke.spec.ts` | 2 | 2 | 0 | 0 | owner |
| `agent-usage-activity.negative.spec.ts` | 8 | 6 | 2 | 0 | owner, team |
| `agent-usage-activity.spec.ts` | 21 | 5 | 16 | 0 | owner, team |
| `alerts.negative.spec.ts` | 5 | 5 | 0 | 0 | owner, team, **member** |
| `alerts.spec.ts` | 28 | 12 | 16 | 0 | team |
| `billing.negative.spec.ts` | 4 | 0 | 4 | 0 | owner, team |
| `billing.spec.ts` | 22 | 0 | 22 | 0 | owner, team |
| `connectors.negative.spec.ts` | 5 | 0 | 5 | 0 | owner, **member** |
| `connectors.spec.ts` | 23 | 9 | 14 | 0 | owner |
| `cross-cutting.negative.spec.ts` | 4 | 4 | 0 | 0 | owner |
| `cross-cutting.spec.ts` | 31 | 20 | 11 | 0 | owner |
| `deploy-jobs.negative.spec.ts` | 5 | 3 | 2 | 0 | owner |
| `deploy-jobs.spec.ts` | 21 | 0 | 4 | 17 | owner |
| `navigation-shell.negative.spec.ts` | 5 | 2 | 3 | 0 | owner |
| `navigation-shell.spec.ts` | 38 | 7 | 31 | 0 | owner |
| `onboarding.negative.spec.ts` | 7 | 5 | 2 | 0 | owner, page |
| `onboarding.spec.ts` | 22 | 15 | 6 | 1 | owner, page |
| `projects.negative.spec.ts` | 8 | 4 | 4 | 0 | owner |
| `projects.spec.ts` | 20 | 8 | 12 | 0 | owner |
| `rbac.negative.spec.ts` | 4 | 0 | 4 | 0 | **member** |
| `rbac.spec.ts` | 40 | 14 | 26 | 0 | owner, team |
| `runners.negative.spec.ts` | 3 | 2 | 1 | 0 | owner, team |
| `runners.spec.ts` | 16 | 10 | 6 | 0 | team |
| **total** | **346** | **136** | **192** | **18** | |

`deploy-jobs.spec.ts`'s 17 "not run" are not skips anyone chose: a failing `beforeAll` takes the
rest of the file with it (findings.md P0-1). The one real skip is `onboarding.spec.ts`'s Pro-trial
signup, which needs Stripe.

## What the personas column means now

- **`owner`** (Hobby) and **`team`** (Pro org) are unchanged.
- **`member`** is real as of #3633 and appears in three files. Two of those three cannot yet report
  anything about permissions:
  - `alerts.negative.spec.ts` — **green**, and the only member denial in the suite that currently
    measures a denial.
  - `connectors.negative.spec.ts` — red on an ambiguous `Connect` locator, not on permissions.
  - `rbac.negative.spec.ts` — red on a members-page stat strip the console deliberately deleted, so
    all four denials still sit behind their precondition.
- `page` is the raw unauthenticated fixture (public routes and signup walks).

The old `fixme (bugs)` and `skip` columns are gone. Both P1s they tracked were fixed in July and
their tests un-`fixme`'d; carrying empty columns implied a live triage that no longer existed.

## Coverage notes

- **Deploy depth** stops at job QUEUED and uses `helpers/seed.ts` for post-deploy UI. No real
  tofu/cloud/runner execution. *Today it stops earlier than that* — see findings.md P0-1.
- **Not covered, by design:** real Stripe payment, real cloud credential verification, real email
  delivery, real provisioning.
- **Not covered, by omission:** a `member` billing negative (`billing.negative.spec.ts` says so in
  its header — the persona exists, the spec does not), and member permission paths for deploy-jobs,
  projects and runners.
- **Environment-dependent:** 36 tests need hosted billing or a live runner and can only be measured
  on a Stripe-configured deployment. The suite does not currently declare which those are, so on a
  branch env they read as failures rather than as out of scope.
