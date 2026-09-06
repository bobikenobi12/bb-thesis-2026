<!-- SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io> -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# The console UI conformance scoreboard

Every **private** console route, scored against the static half of
[`RUBRIC.md`](./RUBRIC.md).

**Everything below the marker is generated. Do not edit it.**
Run `pnpm -C apps/console run audit:report --write` and commit the result; a bare
`pnpm -C apps/console run audit:report` checks the two generated artifacts against the tree and exits 2
naming the command, the same contract `PROGRAMME.md`'s derived half uses. The machine-readable
twin is [`apps/console/ui-conformance-baseline.json`](../../ui-conformance-baseline.json).

## What this is, and what it is not

**It is a report, not a baseline.** Two files are the source of truth for console conformance and
this is neither of them:

- `apps/console/route-states-baseline.yaml` — the S1–S4 / T1–T4 ratchet, checked in both
  directions as a set of named routes by `scripts/check-route-states.mjs`;
- `apps/console/shared-surface-allowlist.yaml` — the H-family ledgers, `baseline:` for recorded
  decisions and `debt:` for measured drift, checked in both directions by
  `scripts/check-shared-surface.mjs`.

This file joins them to a **route**, which neither of them does: both are per-file and
per-predicate, so "which pages are worst" was an impression rather than a number. If you find
yourself wanting to record a fact here that neither of those two files holds, that fact belongs in
one of them.

## How to read a cell

`score = PASS ÷ (PASS + FAIL)`. **N/A leaves the denominator**, which is why the N/A count is a
column of its own: a predicate whose N/A count grows is a predicate being escaped, and escaping one
makes a page's score go *up* with nothing red anywhere.

A `—` means **not instrumented**, never "passed" and never "nothing found". The generator refuses
to run unless every predicate the rubric defines lands in exactly one of *scored here*, *live*, or
*un-instrumented with an owning issue* — so a predicate cannot fall out of this report quietly, and
adding a row to the rubric makes this file refuse to regenerate until somebody says which it is.

## How a shared-surface occurrence becomes a route's verdict

The H family is measured per **file**; a route is a **page**. The join is the page's own module
closure — every `@/…` or relative import reachable from its `page.tsx`, transitively.

The **layout chain is deliberately not in it**. Adding the layouts pulls in `AppShell` → the
sidebar → the org switcher → very nearly the whole console: every route's closure lands between
477 and 563 files and the H column stops telling one page from another. Page-only closures run from
1 to 383. The S family already measures the shell, which is the half a layout owns.

The cost of that choice is stated rather than left to be discovered: a defect living **only** in
the shared chrome is in no route's H column. It is not invisible — the reconciliation section
counts it and `ui-conformance-baseline.json` names every file — but it is not scored, because
attributing the sidebar's drift to all 40 routes would say the console is 40 times worse than it is,
and would move all 40 numbers when one file is fixed.

An occurrence is a defect unless a **`reason:`** entry in the allowlist covers it. A **`lifts:`**
entry does *not* excuse it: `lifts:` is measured drift a named lane will remove, and RUBRIC.md says
so for H8 in as many words — "a page scores FAIL on H8 today and the number can only shrink."

## Why the baseline below was measured before anything was fixed

The numbers this file was committed with were measured on an **unmodified `dev`**, before any
conformance lane changed a component. A guard shipped in the same commit as its fix is
tautological, and this repo has paid for that more than once. Every conformance lane that follows
lowers a number here in the same commit as its code.

<!-- BEGIN GENERATED: audit-report · tree-derived · DO NOT EDIT BELOW -->

## What this scored

**40 private routes** · 4 redirect-only · 36 real pages.

RUBRIC.md defines **34 predicates**. This report scores **33** of them —
23 from the tree and 10 from the committed live audit records.
1 has no instrument anywhere today.

| source | what it contributes |
|---|---|
| `scripts/lib/console-routes.mjs` | the route set — the denominator of every number below |
| `scripts/check-route-states.mjs` | S1–S4, T1–T4, per route |
| `apps/console/route-states-baseline.yaml` | the ratchet those eight predicates are held to |
| `scripts/check-shared-surface.mjs` | every H-family occurrence, per file |
| `scripts/check-filter-standard.mjs` | F1–F6 per filter SURFACE, joined to the routes whose closure reaches it |
| `apps/console/tests/lib/queries/filter-standard-facets.test.ts` | F7 — the behaviour RUBRIC.md says a matcher cannot answer |
| `apps/console/shared-surface-allowlist.yaml` | which occurrences are a recorded decision (`baseline: 16`) and which are measured drift (`debt: 0`) |
| `apps/console/ui-conformance-live.json` | T5–T7 and R1–R7 as MEASURED, imported from a CI run of the Playwright `audit` project |
| `apps/console/docs/ui-conformance/RUBRIC.md` | the predicate set itself, read out of its own tables |

## Which predicates have an instrument

An un-instrumented predicate is rendered `—` everywhere below, never as a pass and never
omitted. The generator refuses to run unless every rubric predicate lands in exactly one row
of this table. A **live** predicate is instrumented: it is measured in a browser by the
Playwright `audit` project and joined in from the committed records, not inferred from the tree.

| family | predicates | static | live | no instrument |
|---|---:|---:|---:|---:|
| **S** — shell & width | 4 | 4 | 0 | 0 |
| **T** — states | 7 | 4 | 3 | 0 |
| **H** — shared surface | 9 | 8 | 0 | 1 |
| **F** — filter standard | 7 | 7 | 0 | 0 |
| **R** — rendered integrity | 7 | 0 | 7 | 0 |
| **total** | 34 | 23 | 10 | 1 |

The un-instrumented one, with the issue that owns it:

| id | owner | what is not being measured |
|---|---|---|
| **H3** | #3797 | StatusBadge. `check-shared-surface.mjs` records why this row stays prose: a page that should have shown a status pill and showed a `<Badge>` has no negative form to grep for. |

## The live half — two artifacts, two personas, two organisations

T5–T7 and R1–R7 are measured in a browser, not read off the tree. The records below were
imported from **https://github.com/alethialabs-io/alethialabs/actions/runs/33623272631** at commit `1a3bdeb73a36d488a238dfe2d2e4235b35105832` and committed to
`apps/console/ui-conformance-live.json`; refresh them with `--import-live`. They come from **two files, joined and never
pooled** — `e2e/audit/report.ts` records what pooling them cost, and the split is checked here:
each section declares the predicates it may carry, and a record in the wrong one refuses to parse.

| section | artifact | persona | organisation | predicates | records | routes |
|---|---|---|---|---|---:|---:|
| `routes` | `test-results/ui-audit.json` | the run's own owner | a fresh, empty organisation created for the run | T5, T6, R1, R2, R3, R4, R5, R6, R7 | 360 | 40 |
| `permissions` | `test-results/ui-audit-permissions.json` | the `member` persona, compared against the owner of the same org | a SECOND organisation, created by that spec and never touched by the primary run | T7 | 27 | 27 |

**A cell no artifact carries is `NOT MEASURED`, never N/A and never a pass.** An N/A is a claim
about the page — RUBRIC.md's rule 2 requires it to be derivable from the route record — and
"the instrument did not reach this route" is a claim about the instrument. It gets its own column
below and is never folded into N/A; `score` stays `PASS ÷ (PASS + FAIL)`, so a withheld verdict
leaves the denominator and a predicate withheld everywhere scores `—`, never `1.00`.

| withheld | routes | why the instrument did not answer |
|---|---:|---|
| **T7** | 13 | the `permissions` run did not reach this route — it covers only the org-only routes; the parameterised ones need a project the persona cannot be given |

**Nothing is suppressed.** R5, R6 and R7 declare no N/A reason at all, so an N/A on one of them
is a parse error rather than a verdict. What still fails is recorded debt with an owner, and the
generator checks that ledger in both directions — a row that stops being true fails the build as
loudly as a missing one:

| predicate | FAIL | owner | what is failing |
|---|---:|---|---|
| **R3** | 2 | #3885 | two nested scroll containers that are not the shell's — a chip `ScrollArea` on `~/support/ask` and a `@repo/ui/table` wrapper on `[project]/environments` — each overflowing by 3px at all four widths. Trustworthy for the first time now that #3804 has made R3's own positive control green. |
| **R4** | 7 | #3805 | ONE shell defect, not N page defects: `components/shell/topbar.tsx` centres the breadcrumb out of flow (`absolute left-1/2`) beside an `ml-auto` action cluster that nothing reserves space for, so the two collide from `md:` up. #3805 keeps it deliberately rather than folding it into #3619 — the fix is a layout decision, and only R4's geometry can prove either answer. |
| **R5** | 12 | #3805 | the axe residue. `color-contrast` fails EVERY failing route on its own, so R5 cannot move at all until that clears — `button-name` went 3 → 0 in #3756 and the score did not budge. The console is dark-first and grayscale by design, so each node is a judgement between a token fix in `packages/brand/src/tokens.css` and a recorded decision. |
| **R6** | 2 | #3805 | two routes. `~/connectors` fires 400s from `/_next/image` for connector icons that do not exist (#3802, fixed by #3876); `[project]/…/support/cases/[id]` 404s the parent list route's RSC prefetch ~70 times in one visit, which is a prefetch storm as well as a 404. |

## Per predicate

`score = PASS ÷ (PASS + FAIL)`. N/A leaves the denominator, so the N/A column is first-class:
a predicate whose N/A count grows is a predicate being escaped. `NOT MEASURED` leaves it too, and
has a column of its own for the same reason — it is a fact about the instrument, not about a page.

| id | family | instrument | PASS | FAIL | N/A | NOT MEASURED | score | N/A reasons |
|---|---|---|---:|---:|---:|---:|---:|---|
| **S1** | S | `check-route-states` | 36 | 0 | 4 | 0 | 1.00 | `redirect-only` 4 |
| **S2** | S | `check-route-states` | 32 | 4 | 4 | 0 | 0.89 | `redirect-only` 4 |
| **S3** | S | `check-route-states` | 36 | 0 | 4 | 0 | 1.00 | `redirect-only` 4 |
| **S4** | S | `check-route-states` | 35 | 1 | 4 | 0 | 0.97 | `redirect-only` 4 |
| **T1** | T | `check-route-states` | 36 | 0 | 4 | 0 | 1.00 | `redirect-only` 4 |
| **T2** | T | `check-route-states` | 40 | 0 | 0 | 0 | 1.00 | — |
| **T3** | T | `check-route-states` | 10 | 0 | 30 | 0 | 1.00 | `does-not-call-not-found` 30 |
| **T4** | T | `check-route-states` | 36 | 4 | 0 | 0 | 0.90 | — |
| **T5** | T | live — `routes` | 14 | 0 | 26 | 0 | 1.00 | `no-empty-state` 26 |
| **T6** | T | live — `routes` | 36 | 0 | 4 | 0 | 1.00 | `redirect-only` 4 |
| **T7** | T | live — `permissions` | 0 | 0 | 27 | 13 | — | `no-restricted-surface` 27 |
| **H1** | H | `check-shared-surface` | 40 | 0 | 0 | 0 | 1.00 | — |
| **H2** | H | `check-shared-surface` | 40 | 0 | 0 | 0 | 1.00 | — |
| **H3** | H | **none** — #3797 | — | — | — | — | — | — |
| **H4** | H | `check-shared-surface` | 40 | 0 | 0 | 0 | 1.00 | — |
| **H5** | H | `check-shared-surface` | 40 | 0 | 0 | 0 | 1.00 | — |
| **H6** | H | `check-shared-surface` | 40 | 0 | 0 | 0 | 1.00 | — |
| **H7** | H | `check-shared-surface` | 40 | 0 | 0 | 0 | 1.00 | — |
| **H8** | H | `check-shared-surface` | 40 | 0 | 0 | 0 | 1.00 | — |
| **H9** | H | `check-shared-surface` | 40 | 0 | 0 | 0 | 1.00 | — |
| **F1** | F | `check-filter-standard` | 16 | 0 | 24 | 0 | 1.00 | `not-a-list-page` 24 |
| **F2** | F | `check-filter-standard` | 16 | 0 | 24 | 0 | 1.00 | `not-a-list-page` 24 |
| **F3** | F | `check-filter-standard` | 11 | 5 | 24 | 0 | 0.69 | `not-a-list-page` 24 |
| **F4** | F | `check-filter-standard` | 16 | 0 | 24 | 0 | 1.00 | `not-a-list-page` 24 |
| **F5** | F | `check-filter-standard` | 12 | 4 | 24 | 0 | 0.75 | `not-a-list-page` 24 |
| **F6** | F | `check-filter-standard` | 5 | 11 | 24 | 0 | 0.31 | `not-a-list-page` 24 |
| **F7** | F | `check-filter-standard` | 12 | 3 | 24 | 1 | 0.80 | `not-a-list-page` 24 |
| **R1** | R | live — `routes` | 36 | 0 | 4 | 0 | 1.00 | `redirect-only` 4 |
| **R2** | R | live — `routes` | 39 | 0 | 1 | 0 | 1.00 | `opens-no-overlay` 1 |
| **R3** | R | live — `routes` | 34 | 2 | 4 | 0 | 0.94 | `redirect-only` 4 |
| **R4** | R | live — `routes` | 29 | 7 | 4 | 0 | 0.81 | `redirect-only` 4 |
| **R5** | R | live — `routes` | 28 | 12 | 0 | 0 | 0.70 | — |
| **R6** | R | live — `routes` | 38 | 2 | 0 | 0 | 0.95 | — |
| **R7** | R | live — `routes` | 40 | 0 | 0 | 0 | 1.00 | — |

The static H half emits **no N/A at all**, which is why those rows are empty rather than
carrying the rubric's `renders-no-table` / `renders-no-formatted-value` / `declares-no-z-index`.
A matcher cannot tell "this page has no table" from "this page's table is correct" — both are
zero findings — so claiming the N/A would shrink the denominator on evidence that does not bear
on it. Every page is asked, and a page with no table passes H4 by not hand-rolling one.

## Per route

Each cell is `PASS/scored · score` over that family's instrumented predicates —
S 4/4, T 7/7, H 8/9, F 7/7, R 7/7. `surface` is the number of console modules the
page's own import graph reaches, which is the denominator the H column was measured over.
A `· n withheld` suffix means n of that family's predicates were NOT MEASURED on this route: the
score is over the rest, and the cell says so rather than letting a narrower measurement read wider.

| route | surface | S | T | H | F | R | overall |
|---|---:|---|---|---|---|---|---|
| `/[org]/[project]/environments` | 237 | 3/4 · 0.75 | 5/5 · 1.00 · 1 withheld | 8/8 · 1.00 | all N/A | 4/7 · 0.57 | **0.83** |
| `/[org]/~/alerts` | 291 | 2/4 · 0.50 | 5/5 · 1.00 | 8/8 · 1.00 | 4/7 · 0.57 | 7/7 · 1.00 | **0.84** |
| `/[org]/[project]/settings` · | 1 | all N/A | 1/2 · 0.50 · 1 withheld | 8/8 · 1.00 | all N/A | 3/4 · 0.75 | **0.86** |
| `/[org]/~/settings` · | 1 | all N/A | 1/2 · 0.50 | 8/8 · 1.00 | all N/A | 3/4 · 0.75 | **0.86** |
| `/[org]/~/connectors` | 211 | 4/4 · 1.00 | 4/4 · 1.00 | 8/8 · 1.00 | 6/7 · 0.86 | 5/7 · 0.71 | **0.90** |
| `/[org]/~/runners` | 272 | 4/4 · 1.00 | 5/5 · 1.00 | 8/8 · 1.00 | 3/6 · 0.50 · 1 withheld | 7/7 · 1.00 | **0.90** |
| `/[org]/~/settings/members` | 221 | 4/4 · 1.00 | 4/4 · 1.00 | 8/8 · 1.00 | 5/7 · 0.71 | 6/7 · 0.86 | **0.90** |
| `/[org]/[project]/settings/general` | 216 | 4/4 · 1.00 | 5/5 · 1.00 · 1 withheld | 8/8 · 1.00 | all N/A | 5/7 · 0.71 | **0.92** |
| `/[org]/[project]/settings/preview` | 143 | 4/4 · 1.00 | 5/5 · 1.00 · 1 withheld | 8/8 · 1.00 | all N/A | 5/7 · 0.71 | **0.92** |
| `/[org]/~/support/cases/[id]` | 157 | 4/4 · 1.00 | 5/5 · 1.00 · 1 withheld | 8/8 · 1.00 | all N/A | 5/7 · 0.71 | **0.92** |
| `/[org]/[project]` · | 1 | all N/A | 1/2 · 0.50 · 1 withheld | 8/8 · 1.00 | all N/A | 4/4 · 1.00 | **0.93** |
| `/[org]/~/settings/activity` | 278 | 4/4 · 1.00 | 4/4 · 1.00 | 8/8 · 1.00 | 6/7 · 0.86 | 6/7 · 0.86 | **0.93** |
| `/[org]/~/settings/roles` | 224 | 4/4 · 1.00 | 4/4 · 1.00 | 8/8 · 1.00 | 6/7 · 0.86 | 6/7 · 0.86 | **0.93** |
| `/dashboard/[[...rest]]` · | 127 | all N/A | 2/3 · 0.67 | 8/8 · 1.00 | all N/A | 4/4 · 1.00 | **0.93** |
| `/[org]/~/settings/teams` | 214 | 4/4 · 1.00 | 5/5 · 1.00 | 8/8 · 1.00 | 5/7 · 0.71 | 7/7 · 1.00 | **0.94** |
| `/[org]/~/support/my-cases` | 149 | 4/4 · 1.00 | 5/5 · 1.00 | 8/8 · 1.00 | 5/7 · 0.71 | 7/7 · 1.00 | **0.94** |
| `/[org]/[project]/settings/access` | 214 | 4/4 · 1.00 | 6/6 · 1.00 · 1 withheld | 8/8 · 1.00 | 6/7 · 0.86 | 6/7 · 0.86 | **0.94** |
| `/[org]/[project]/settings/activity` | 279 | 4/4 · 1.00 | 6/6 · 1.00 · 1 withheld | 8/8 · 1.00 | 6/7 · 0.86 | 6/7 · 0.86 | **0.94** |
| `/[org]/~/jobs/[id]` | 223 | 3/4 · 0.75 | 4/4 · 1.00 · 1 withheld | 8/8 · 1.00 | all N/A | 7/7 · 1.00 | **0.96** |
| `/[org]/~/new` | 360 | 3/4 · 0.75 | 4/4 · 1.00 | 8/8 · 1.00 | all N/A | 7/7 · 1.00 | **0.96** |
| `/[org]/~/settings/classification` | 147 | 4/4 · 1.00 | 4/4 · 1.00 | 8/8 · 1.00 | all N/A | 6/7 · 0.86 | **0.96** |
| `/[org]/~/settings/general` | 135 | 4/4 · 1.00 | 4/4 · 1.00 | 8/8 · 1.00 | all N/A | 6/7 · 0.86 | **0.96** |
| `/[org]/~/support/ask` | 199 | 4/4 · 1.00 | 4/4 · 1.00 | 8/8 · 1.00 | all N/A | 6/7 · 0.86 | **0.96** |
| `/[org]/[project]/architecture` | 384 | 4/4 · 1.00 | 5/5 · 1.00 · 1 withheld | 8/8 · 1.00 | all N/A | 6/7 · 0.86 | **0.96** |
| `/[org]/[project]/usage` | 148 | 4/4 · 1.00 | 5/5 · 1.00 · 1 withheld | 8/8 · 1.00 | all N/A | 6/7 · 0.86 | **0.96** |
| `/[org]/~/settings/billing/invoices` | 194 | 4/4 · 1.00 | 4/4 · 1.00 | 8/8 · 1.00 | 6/7 · 0.86 | 7/7 · 1.00 | **0.97** |
| `/[org]/[project]/jobs` | 221 | 4/4 · 1.00 | 5/5 · 1.00 · 1 withheld | 8/8 · 1.00 | 6/7 · 0.86 | 7/7 · 1.00 | **0.97** |
| `/[org]/~/evidence` | 151 | 4/4 · 1.00 | 5/5 · 1.00 | 8/8 · 1.00 | 6/7 · 0.86 | 7/7 · 1.00 | **0.97** |
| `/[org]/~/jobs` | 220 | 4/4 · 1.00 | 5/5 · 1.00 | 8/8 · 1.00 | 6/7 · 0.86 | 7/7 · 1.00 | **0.97** |
| `/[org]/~/settings/access` | 213 | 4/4 · 1.00 | 5/5 · 1.00 | 8/8 · 1.00 | 6/7 · 0.86 | 7/7 · 1.00 | **0.97** |
| `/[org]/~/settings/sso` | 213 | 4/4 · 1.00 | 5/5 · 1.00 | 8/8 · 1.00 | 6/7 · 0.86 | 7/7 · 1.00 | **0.97** |
| `/[org]` | 284 | 4/4 · 1.00 | 5/5 · 1.00 | 8/8 · 1.00 | all N/A | 7/7 · 1.00 | **1.00** |
| `/[org]/[project]/clusters` | 165 | 4/4 · 1.00 | 6/6 · 1.00 · 1 withheld | 8/8 · 1.00 | all N/A | 7/7 · 1.00 | **1.00** |
| `/[org]/~/clusters` | 164 | 4/4 · 1.00 | 5/5 · 1.00 | 8/8 · 1.00 | all N/A | 7/7 · 1.00 | **1.00** |
| `/[org]/~/settings/billing` | 194 | 4/4 · 1.00 | 4/4 · 1.00 | 8/8 · 1.00 | all N/A | 7/7 · 1.00 | **1.00** |
| `/[org]/~/support` | 7 | 4/4 · 1.00 | 4/4 · 1.00 | 8/8 · 1.00 | all N/A | 7/7 · 1.00 | **1.00** |
| `/[org]/~/support/abuse` | 136 | 4/4 · 1.00 | 4/4 · 1.00 | 8/8 · 1.00 | all N/A | 7/7 · 1.00 | **1.00** |
| `/[org]/~/support/submit` | 146 | 4/4 · 1.00 | 4/4 · 1.00 | 8/8 · 1.00 | all N/A | 7/7 · 1.00 | **1.00** |
| `/[org]/~/usage` | 185 | 4/4 · 1.00 | 4/4 · 1.00 | 8/8 · 1.00 | all N/A | 7/7 · 1.00 | **1.00** |
| `/cli/login` | 5 | 4/4 · 1.00 | 4/4 · 1.00 | 8/8 · 1.00 | all N/A | 6/6 · 1.00 | **1.00** |

`·` marks a redirect-only route: no JSX, a `redirect()` call. It is N/A for six of the eight
route-state predicates and passes the H rows on a closure of one file that renders nothing. It is
**not** N/A for R5, R6 and R7: hitting one of those URLs is a navigation a person really makes, so
the console errors it produces and the time it takes to land are real and are measured.

## Where every shared-surface occurrence landed

`check-shared-surface` found **24 occurrences across 15 files**. This section
accounts for all of them twice — once by ledger, once by reach — so a rule or a file falling out
of the scoreboard cannot be quiet.

| rule | predicate | total | recorded decision | measured drift | unlisted | in a page's surface | shared chrome only | outside the private tree |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| `data_table` | H4 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `empty_state` | H9 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `format` | H5 | 6 | 6 | 0 | 0 | 3 | 3 | 0 |
| `layer_token` | H7 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `page_title` | H1 | 17 | 17 | 0 | 0 | 7 | 1 | 9 |
| `section_header` | H2 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `stat_strip` | H6 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `type_scale` | H8 | 1 | 1 | 0 | 0 | 0 | 0 | 1 |
| **total** | | 24 | 24 | 0 | 0 | 10 | 4 | 10 |

**`unlisted` is the column to read first.** A non-zero value means the guard is red — an
occurrence neither a `reason:` nor a `lifts:` entry accounts for. It is not a defect of this
report; run `pnpm check:shared-surface`.

**Every matcher maps to a rubric predicate.** `empty_state` was the one that did not — it guarded
CLAUDE.md §6's `@repo/ui/empty` row and the rubric's H table had no row for it, so its occurrences
were counted here and scored nowhere. #3798 gave the rubric **H9**, and it is scored like any other
H row. The live T5 asks the other half of the question: what the empty region resolved to when a
browser actually rendered it against an empty org.

**Reachable only from the shared layout chain** — 3 files. These are real
occurrences in the sidebar, topbar, breadcrumbs and shells that every route renders. They are not
in any route's H column, because attributing the chrome's drift to all 40 routes would say the
console is 40 times worse than it is. The full list is in `ui-conformance-baseline.json`.

**Outside every private route's module graph** — 4 files. Public routes (sign-in,
onboarding, OAuth consent, accepting terms) and modules no private page imports. The route manifest
is scoped to `app/(private)`, so these are outside the rubric's stated subject and are listed here
rather than scored:

| file | occurrences |
|---|---:|
| `apps/console/components/auth/auth-form.tsx` | 5 |
| `apps/console/components/auth/onboarding-form.tsx` | 2 |
| `apps/console/components/forms/oauth-consent-form.tsx` | 2 |
| `apps/console/components/legal/accept-terms-form.tsx` | 1 |

_Generated by `apps/console/scripts/audit-report.mjs`. Do not edit below the marker — run `pnpm -C apps/console run audit:report --write`._

<!-- END GENERATED: audit-report -->
