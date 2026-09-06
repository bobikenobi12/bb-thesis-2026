# Console QA — performance

> **Measured 2026-09-02.** A **serial** (`--workers=1`) pass over the page-loading sweep —
> `cross-cutting.spec.ts` + `navigation-shell.spec.ts`, 69 tests, 4.4 minutes — against
> `env2-dev.alethialabs.io`, the console running in Next.js development mode on a shared cpx42
> sandbox box. Wall-clock from Playwright resource timing. **A built console will be faster; these
> are not production numbers and must never be quoted as latency SLOs.**
>
> These figures come from `test-results/qa-report.json`, which
> `e2e/reporters/qa-reporter.ts` writes and **`playwright.config.ts` does not register**. Reproduce
> them with:
>
> ```
> ALETHIA_QA_E2E=1 REUSE_AUTH=1 pnpm -F console exec playwright test --project=qa --workers=1 \
>   --reporter=list,./e2e/reporters/qa-reporter.ts \
>   flows/cross-cutting.spec.ts flows/navigation-shell.spec.ts
> ```
>
> Without that `--reporter` flag the file these tables come from is never produced. The July
> edition of this document did not say so, and the roll-up it cited had not been written since.

## Navigation latency by route

| p95 ms | p50 ms | max ms | n | route |
|--:|--:|--:|--:|---|
| 3606 | 3606 | 3606 | 1 | `/:org/:project/jobs` |
| 3572 | 3572 | 3572 | 1 | `/:org/~/connectors` |
| 2378 | 2378 | 2378 | 2 | `/:org/~/runners` |
| 2143 | 2143 | 2143 | 2 | `/:org/~/alerts` |
| 2033 | 670 | 2033 | 3 | `/:org/~/settings/roles` |
| 1991 | 1991 | 1991 | 1 | `/:org/:project/architecture` |
| 1945 | 1945 | 1945 | 1 | `/:org/~/settings/sso` |
| 1942 | 1942 | 1942 | 1 | `/:org/~/settings/activity` |
| 1937 | 1937 | 1937 | 1 | `/:org/~/settings/access` |
| 1896 | 1896 | 1896 | 1 | `/:org/~/settings/teams` |
| 1847 | 1847 | 1847 | 2 | `/:org/~/settings/general` |
| 1429 | 1429 | 1429 | 2 | `/:org/~/clusters` |
| 1417 | 501 | 1417 | 3 | `/:org/~/jobs` |
| 692 | 453 | 1590 | 37 | `/:org` |
| 470 | 470 | 470 | 1 | `/:org/~/usage` |
| 415 | 415 | 415 | 1 | `/:org/~/settings/members` |
| 401 | 401 | 401 | 1 | `/:org/~/new` |
| 340 | 340 | 340 | 1 | `/:org/~/settings/billing` |
| 140 | 140 | 140 | 1 | `/:org/~/agent` |

## Server actions and API fetches

| p95 ms | p50 ms | n | endpoint |
|--:|--:|--:|---|
| 536 | 523 | 8 | `fetch POST /:org` |
| 491 | 131 | 14 | `server-action POST /:org/:project/jobs` |
| 431 | 431 | 1 | `fetch GET /:org/~/jobs` |
| 402 | 196 | 4 | `server-action POST /:org/~/clusters` |
| 284 | 222 | 4 | `server-action POST /:org/~/jobs` |
| 270 | 152 | 45 | `fetch GET /api/auth/list-accounts` |
| 221 | 130 | 76 | `server-action POST /:org` |
| 219 | 169 | 42 | `fetch GET /api/auth/get-session` |
| 190 | 109 | 19 | `server-action POST /~/~/settings/billing` |
| 188 | 188 | 2 | `server-action POST /:org/~/settings/general` |
| 179 | 179 | 2 | `server-action POST /:org/~/alerts` |
| 175 | 168 | 4 | `server-action POST /:org/~/settings/roles` |
| 164 | 106 | 11 | `server-action POST /:org/~/runners` |

## How to read these

- **A single-sample row is a first hit, and a first hit compiles.** Every 1.9–3.6s row above has
  `n = 1`. The org overview, at `n = 37`, sits at p50 453ms and p95 692ms — that is the same
  console warm. Do not read the settings tabs as slow pages; read them as pages this pass visited
  once each.
- **`/:org/~/agent` at 140ms is a 404**, not a fast page. The route no longer exists
  (findings.md P2-10). A latency table cannot tell those apart, which is the reason this note is
  here.
- **The connectors outlier is real and is the July finding, still open.**
  `lib/connectors/cloud-connect-setup.ts` INSERTs a pending `cloud_identity` row per unconnected
  managed cloud on every render, and the page auto-`router.refresh()`es every 30s. At 3572ms on one
  serial hit it is second-slowest here; under the July parallel swarm the same route was measured at
  40–90s. The table it writes still grows without bound.
- **No slow-query / N+1 database capture was taken.** Postgres statement logging is off on the
  shared box, and turning it on affects every other environment on it.

## What this pass is not

It is 69 of the suite's 346 tests, chosen because they are the ones that *navigate* rather than
mutate; 42 of those 69 failed (the same drift `findings.md` triages), so several routes carry
latency for a page that then failed an assertion. A route missing from the table above is a route
this pass never reached — most of the project-scoped ones, which die in the seed helper
(findings.md P0-1) — and not a route that is fast.
