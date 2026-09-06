<!-- SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io> -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# The console UI conformance rubric

**34 predicates** over every **private** console route — S1–S4 (4), T1–T7 (7), H1–H9 (9), F1–F7
(7), R1–R7 (7). This file is the contract: the static checks, the live Playwright `audit` project
and the scoreboard generator all implement predicates defined *here*, and none of them may invent
one.

> That count was wrong three different ways at once until #3618: this line said twenty-six, the
> commit that seeded the file said 25, and the tables below have defined 33 the whole time. It is
> now **derived and checked**, not typed — `apps/console/scripts/audit-report.mjs` reads the
> predicate rows out of the tables and refuses to run when this sentence disagrees with them. A
> scoreboard must name what it scores.

The route set is not in this file. It is **derived** by `scripts/lib/console-routes.mjs`, which
raises rather than returning an empty list — a route the audit never visited and a route that scored
zero are indistinguishable in a report whose denominator came from somewhere else.

> Run `node scripts/lib/console-routes.mjs --summary` to see the current route set. Today: **40
> private routes, 4 of them redirect-only, 36 real pages.**

## Why a rubric rather than a list of fixes

CLAUDE.md §6 already decides how a heading, an empty list, a status pill, a table, a layer and a
number should look. What did not exist was a way to ask *whether a given page obeys it* — so the
answer was always somebody's reading, and the readings disagreed. Measured on `dev`: 24 raw `<h2>`
across five type scales, ~30 hand-rolled empty states at six different heights, three grid-as-tables,
two money formatters the existing guard structurally cannot see.

A score makes the disagreement a number, and a number can ratchet.

## How a predicate is scored

Every predicate returns exactly one of:

| verdict | meaning |
|---|---|
| **PASS** | the page does the thing |
| **FAIL** | the page does not do the thing, and it should |
| **N/A** | the predicate does not apply to this page, **with the reason recorded in the record** |

`score = PASS ÷ (PASS + FAIL)`. N/A leaves the denominator, which is why the next section is the
most important one in this file.

### N/A is where a rubric goes wrong

A caveat rendered as a `case` that *replaces* the verdict is a defect class this repo has already
shipped. The failure looks like this: a predicate is hard on some page, somebody adds a condition
that returns N/A, and the page's score goes **up** because its denominator went down. Nothing red
appears anywhere.

Three rules close it:

1. **Every N/A carries a machine-readable reason string**, from the fixed set each predicate
   declares below. A reason that is not in the predicate's declared set is an error, not an N/A.
2. **The N/A condition must be derivable from the route record**, never from the page's own
   content. "This page has no empty state" is not an N/A reason — it is the thing being measured.
   "This page is redirect-only" is, because `isRedirectOnly` is structural.
3. **The scoreboard reports N/A counts per predicate as a first-class column.** A predicate whose
   N/A count grows is a predicate being escaped, and it is visible without anyone auditing for it.

The one N/A that applies broadly: **the 4 redirect-only pages** (no JSX, a `redirect()` call —
`/[org]/[project]`, `/[org]/[project]/settings`, `/[org]/~/settings`, `/dashboard/[[...rest]]`)
render nothing a person looks at. They are N/A for every predicate except T2 and T4.

---

## Family S — shell and width  ·  static

| id | predicate | PASS when | N/A when |
|---|---|---|---|
| **S1** | the page renders inside a known shell | `record.shell` is non-null — a `*Shell` discovered under `components/**` is mounted somewhere in the layout chain | `redirect-only` |
| **S2** | exactly one max-width governs the content | the innermost shell declares a `max-w-*` and the page declares none of its own | `redirect-only` |
| **S3** | the loading skeleton is the same width as the page | the nearest `loading.tsx` resolves to the same max-width as S2 | `redirect-only`; `no-loading-boundary` — there is no skeleton to measure, and T1 already reports that, so do **not** double-count one defect. A skeleton that EXISTS and is the wrong one is still measured here: its width either matches the page's or it does not, and that is a second fact, not the same one twice |
| **S4** | no page-local duplicate of a shell constraint | the page file and its direct children declare no `max-w-*` that a shell above them already sets | `redirect-only` |

**Why S2 says "and it comes from the shell".** Eleven pages set no max-width at all and fill a 4K
monitor; three others hand-roll `max-w-[1200px]`, which is the number `SettingsShell` already owns.
Both are the same defect — the width is not decided in one place — and a predicate that only caught
the first would let the second spread as the fix.

## Family T — states  ·  T1–T4 static, T5–T7 live

| id | predicate | PASS when | N/A when |
|---|---|---|---|
| **T1** | the page's loading skeleton is *its own or a correct ancestor's* | `boundaries.loading.own`, **or** an inherited one whose page shape genuinely matches (see below) | `redirect-only` |
| **T2** | an error boundary covers the segment | `boundaries.error.file` is non-null | never — every route can throw |
| **T3** | `notFound()` has a `not-found.tsx` in its own chain | the page calls `notFound()`, the nearest `not-found.tsx` is scoped to the same resource, **and it can fire** — no layout at that resource's own segment throws past it | `does-not-call-not-found` |
| **T4** | the page declares metadata | `hasMetadata` — on the page, or on its own layout for a client page | never — a redirect still owns a title |
| **T5** | the empty state renders through `EmptyState` | driven against an empty org, the rendered empty region resolves to `@repo/ui/empty` | `no-empty-state` (the page has no list, tab or panel that can be empty) |
| **T6** | the error state renders through the shared error component | fault-injected, the page renders `components/errors/error-state` | `redirect-only` |
| **T7** | permission-denied renders a real state | as the `operator` persona — which is the restricted one, and the `member`/`viewer` persona is not; see below — a forbidden page renders a deliberate state, not a blank | `no-restricted-surface` |

**T1 is "the nearest one", not "one exists".** Next.js gives a page the closest ancestor-or-self
`loading.tsx`, so the question is which skeleton actually renders. Measured today:

| route | renders | distance | verdict |
|---|---|---|---|
| `/[org]/~/settings/classification` | `[org]/loading.tsx` — the org-overview card grid | 3 | FAIL |
| `/[org]/~/jobs/[id]` | `~/jobs/loading.tsx` — the jobs **list** skeleton | 1 | FAIL |
| `/[org]/~/settings/billing/invoices` | `~/settings/billing/loading.tsx` — the billing **panel** skeleton | 1 | FAIL |
| `/cli/login` | nothing, anywhere in its chain | — | FAIL |
| `/[org]/[project]/settings/{access,activity,general}` | `[project]/settings/loading.tsx` | 1 | **PASS** |

The last row is the reason T1 is not simply `boundaries.loading.own`. A settings sub-page inheriting
the settings skeleton is *correct*, and a gate that failed it would be a gate people learn to ignore.
An inherited skeleton passes when the segment that owns it has **no page of its own to have been
written for** — a redirect-only page, or no page at all; otherwise it fails. `[project]/settings`
only redirects, so `[project]/settings/loading.tsx` exists for the sub-pages beneath it and they
PASS. `~/jobs` and `~/settings/billing` are real pages, so those skeletons are theirs and the routes
below inherit somebody else's — which is what the two middle rows record.

That rule is structural — it reads `isRedirectOnly` off the route record — and it is deliberately
not "the two pages share a shell and a width". Sharing a width is a property of how the pages look
today: `~/settings/billing/invoices` shares both with `~/settings/billing` and still renders the
billing **panel** skeleton over an invoice table, which is the defect this row is measuring.

**T3 is about the resource, not the file.** Before #3880, 38 of 40 private routes resolved to
`[org]/not-found.tsx` — including every project-scoped route, so a bad *project* slug answered
"Organization not found… or you don't have access". The nearest boundary existing is not the
predicate; the nearest boundary naming the right thing is.

**And it is about the boundary being able to fire.** A segment's `not-found.tsx` is handed to the
`LayoutRouter` for that segment's **children** slot, so it mounts *inside* that segment's own
layout: a `notFound()` thrown in a **page** is caught by its segment's boundary, and one thrown in
that segment's own **layout** is not — it unwinds to the next boundary above. #3880 is that
distinction. Nine `[project]/**` routes failed T3 because their layout threw, and dropping a
`not-found.tsx` beside that layout would have flipped all nine to a PASS the boundary could never
deliver, which is why the predicate reads the layout chain and not only the page. The rule:

- the throw is in the **page** → the segment's own `not-found.tsx` catches it;
- the throw is in a **layout** at segment X → the catching boundary must be **strictly above** X,
  and when X *is* the innermost dynamic segment that is unsatisfiable together with the scope half.
  The fix is to move the throw, not to move the file.

Two bounds are stated in `scripts/check-route-states.mjs` rather than left implicit: the N/A gate is
still the **page's** `notFound()` (a layout-only throw, such as `[org]/layout.tsx`'s, is not
reported), and only layouts **at or below** the route's innermost dynamic segment are read (one
above it throws about an outer resource and is measured on that resource's own routes).

**T7's persona is a measurement, and the first one measured nothing.** #3894 ran T7 as a Better Auth
`member` — which `MEMBERSHIP_ROLE_ALIASES` resolves to Alethia's `viewer` — and all 27 org-only
routes came back `no-restricted-surface` (#3898). T7 rendered `—`, honestly, and could not fail.
Neither the predicate nor the fixture was the gap. The **privilege ladder the predicate assumed**
was, and there isn't one.

The console refuses a route at *render* time in exactly three places — a server component that awaits
a bootstrap, catches `ForbiddenError`, and renders a deliberate no-access `Alert`:

| page | needs | refused to |
|---|---|---|
| `app/(private)/[org]/~/alerts/page.tsx` | `alert:view_alerts` | **no built-in role** |
| `app/(private)/[org]/~/settings/roles/page.tsx` | `member:view` | `operator` |
| `app/(private)/[org]/~/settings/sso/page.tsx` | `member:view` | `operator` |

Everywhere else the console authorizes at the **action** level: the page renders for anybody in the
org, and a capability flag (`canManage`, `canManageCaps`, `seeAll`, `canInvite`) takes affordances
away rather than refusing the route. `~/settings/billing` and `~/settings/activity` are client panels
whose read actions resolve `currentActor()` and enforce nothing at all.

So a `viewer`, which holds both `member:view` and `alert:view_alerts`, is refused none of the three;
an `operator` is refused two. The two roles are **incomparable** — `lib/authz/org-access-control.ts`
says so in `toPdpRole`'s own doc: a viewer may read members, an operator may deploy. "Least
privileged" is not a total order here, and the least-privileged actor for the console's *route-level*
gates is the operator. T7's persona is therefore an `operator`, invited through the same endpoint the
console's own invite dialog calls with a role that dialog offers — and **nothing is seeded for it**:
both surfaces exist in every org, on every plan, with no rows written. That is what makes the answer
"the persona was wrong" rather than "the fixture was thin". There was no thin fixture to thicken.

Two consequences this file owns rather than leaves implicit:

- **T7's subject is small, and named.** Two routes of 27. The other 25 record `no-restricted-surface`
  and mean it. A predicate over two routes can fail; a predicate over none cannot, and that is the
  only distinction that matters here.
- **The subject is asserted, not assumed, in both directions.** `e2e/audit/permissions.spec.ts`
  derives the persona's permission bundle from `lib/authz/registry.ts` and **fails** if the persona
  turns out to be refused nothing. And the two gated routes are T7's **positive control**: a route
  the registry says the persona cannot load, which nevertheless reads as unrestricted, fails rather
  than recording a quiet `no-restricted-surface`. So the day the last route-level gate goes, T7 says
  so — instead of returning to a column of dashes that nobody can tell from "not run yet", which is
  the failure this wave exists to prevent.

`~/alerts`'s no-access branch is reachable by **no built-in role at all** — only a custom (Enterprise)
role, or a member left with zero grants (#3754). Recorded here, deliberately not measured: inventing a
custom role to reach it would be fabricating the subject rather than finding it.

## Family H — the shared surface  ·  static

Each row is a row of CLAUDE.md §6's table. H1 was guarded before this family existed; H2–H7 are what
unit #3615 added; H8 is what #3733 added with the type scale itself; H9 is what #3798 added when
building the scoreboard found that CLAUDE.md §6's `EmptyState` row was scored by nothing.

| id | predicate | PASS when | N/A when |
|---|---|---|---|
| **H1** | the page has **no** title | no `<h1>` outside the allowlist — see below, this predicate is inverted | `redirect-only` |
| **H2** | every section heading comes from `SectionHeading` | no raw `<h2>`–`<h6>` outside the allowlist | `redirect-only` |
| **H8** | every font size is a `--text-ui-*` rung | no `text-[Npx]` (any length unit, any variant prefix) outside the allowlist | `redirect-only` |
| **H3** | status renders through `StatusBadge` | no local status→variant map, and no raw `.vx-status` re-implementation | `renders-no-status` |
| **H4** | tabular data renders through `DataTable` or `@repo/ui/table` | no header row over repeated `grid-cols-[…]` row children | `renders-no-table` |
| **H5** | every number, date, size and amount goes through `@repo/format` | no `toFixed`, `toLocale{Date,Time}String`, `/1024`, hand-written currency symbol, or local `format*` duplicating a `@repo/format` export | `renders-no-formatted-value` |
| **H6** | no stat-card strip | no row of bordered label-over-number cells | `redirect-only` |
| **H7** | no bare numeric z-index | every `z-*` is a `--z-*` token from `packages/brand/src/tokens.css` | `declares-no-z-index` |
| **H9** | the empty state renders through `EmptyState` | the page's own module closure hand-rolls no centred empty region (`text-center` with `py-6` or more) outside the allowlist | `redirect-only` |

**H1 IS INVERTED, and the inversion is the predicate.** It used to read "the page title comes from
`PageHeader`". #3733: the page's name is said by the sidebar entry you clicked and by the breadcrumb
above the content, so the page's own heading is the third saying and earns nothing — the console has
no page titles. A page therefore PASSES H1 by having no `<h1>` at all. The test for the eleven
allowlisted exceptions is **does anything else on screen already name this?** — six are outside the
console shell, where there is neither breadcrumb nor sidebar (sign-in, the CLI hand-off, buying a
plan, accepting terms, OAuth consent, onboarding), and five are in-shell headings that say something
other than the route's name (a question, two invitations above an empty composer, an error message,
an `sr-only` outline root). "Is there a breadcrumb" is NOT the test, and applying it would delete
five headings this rubric deliberately keeps. `PageHeader` no longer exists: what survives
is `@repo/ui/page-toolbar` — the count pill, the description and the page's actions, none of which
the breadcrumb duplicates. **A page that loses its title must not lose its actions**, and H1 does not
measure that; T-family and R-family predicates do.

**H2's answer moved with it.** It was `PageHeader level={n}`, which rendered `text-lg font-medium`
whatever the level — so a section heading converted to it jumped to 18px from the
`text-[14.5px]`/`text-[15px]` the console actually typesets that rung at. That jump is what found the
missing type scale, and H8. The answer is now `SectionHeading` from `@repo/ui/section-heading`: one
rung (`--text-ui-lg`, 15px), with `level` setting the tag and nothing else.

**H8 is a ratchet, not a pass/fail on day one.** All measured live occurrences are recorded as `lifts:`
debt in `apps/console/shared-surface-allowlist.yaml` against #3742, so a page scores FAIL on H8 today
and the number can only shrink. A page with no arbitrary size left scores PASS. Nothing about H8 is
N/A for a page that renders text.

**H9 and T5 are two questions, not one instrument reported twice (#3798).** H9 is STATIC and asks
"does this file hand-roll a centred empty region?"; T5 is LIVE and asks "driven against an empty org,
what did the empty region actually resolve to?". Both are worth asking, and a page can fail either
while passing the other: it can import `EmptyState` and still render a blank region when the list is
empty, and it can hand-roll a centred div that the audit's empty org never reaches — 26 of the 40
routes are `no-empty-state` for T5 today, so the static matcher is the only instrument that sees
them at all. `check-shared-surface.mjs`'s `empty_state` rule had no row here until this one existed:
its occurrences were counted in the scoreboard's reconciliation and scored nowhere, which is what
#3798 was opened to end. Folding it into T5 was the alternative, and it was refused for the reason
this rubric states everywhere else — one predicate per question. The count moved 33 → 34.

**H5's hardest case is the one a grep cannot reach.** `billing/billing-checkout-form.tsx:118` builds
`${symbol}${n.toLocaleString("en-US")}` where `symbol` is a **variable**, and
`agent/approval-card.tsx:154` takes `prefix="$"` as a **prop**. The existing `$${` matcher can never
fire on either. A predicate that only tests the shapes the current guard can see would score both
pages PASS, which is worse than not asking.

## Family F — the filter standard  ·  static, plus one unit test

N/A for every page that is not a list page — declared reason `not-a-list-page`, derivable from the
absence of a `lib/stores/use-*-filters.ts` store, not from how the page looks.

| id | predicate | PASS when |
|---|---|---|
| **F1** | a `createFilterStore` store exists for the page |
| **F2** | `useFilterUrlSync` is wired, so a filtered view is linkable |
| **F3** | search is debounced and the **normalized** query object is the TanStack key |
| **F4** | the bar is built from `FilterBar` / `FilterSearch` / `FacetFilter` / `FilterChipGroup` / `FilterBarReset` |
| **F5** | the result count is a `CountPill` beside the heading — never "N of M" prose in the bar |
| **F6** | `keepPreviousData` plus the `opacity-60` dim on `isPlaceholderData` |
| **F7** | the server builder issues a rows pass **and a separate unfiltered facet pass** |

The subject is a **surface**, not a page: one `createFilterStore` call site.
`lib/stores/use-settings-filters.ts` holds seven of them and `use-alerts-filters.ts` three, so a
per-module verdict would pool ten surfaces into two. A route owns a surface when its page closure
reaches both the store module and a module that names the store's symbol, and F1–F6 are the
conjunction over the surfaces a route owns — a bar that is not linkable is not excused by a sibling
on the same page that is.

**F7 is a unit test, not a matcher.** A facet's counts must come from the unfiltered universe: filter
in memory and the option you just picked disappears from the list, which makes the filter bar
un-un-selectable. "A facet pass sees only the scope predicates" is a behaviour, and the only honest
way to assert it is to run the builder against a fixture and check the second query's predicates.

The reference implementation is the evidence page —
`components/evidence/{evidence-client,evidence-filter-bar}.tsx` and `evidence-query.ts`, plus
`lib/stores/use-evidence-filters.ts` and `lib/query/use-evidence-query.ts`. Note it currently fails
H2: it hand-writes its own `<h2>`.

## Family R — rendered integrity  ·  live only

| id | predicate | PASS when | N/A when |
|---|---|---|---|
| **R1** | no horizontal page overflow | `scrollWidth <= clientWidth` on the body at 768 / 1280 / 1440 / 1920 | `redirect-only` |
| **R2** | every overlay computes above the chrome | see below | `opens-no-overlay` |
| **R3** | exactly one scroll container, and it is the shell's | one element in the page has `scrollHeight > clientHeight` with a scrolling `overflow` | `redirect-only` |
| **R4** | no two interactive elements overlap | no pair of focusable elements with intersecting layout boxes | `redirect-only` |
| **R5** | axe reports zero serious or critical violations | `scanA11y()` returns none at `wcag2a`/`wcag2aa` | never |
| **R6** | zero console errors, zero failed requests | nothing on `console.error`, no response ≥ 400 | never |
| **R7** | interactive within budget | p95 under the route's recorded budget | never |

**R2 is measured by hit-testing, and this is the whole reason the live half exists.** Open each
dialog, sheet, popover, dropdown, tooltip and hover-card, then call
`document.elementFromPoint()` at the overlay's centre **and at its four inset corners**, and assert
the returned node is inside the overlay.

Grepping for `z-[var(--z-overlay)]` matches a *rendering of the intent*, not the stacking that
happened, and the two have already come apart in this codebase. `packages/ui/src/popover.tsx` carries
the incident in a comment: base-ui positions the popup via an absolute Positioner and leaves the
Popup itself `position: static`, on which **`z-index` is a no-op** — so a popover opened from inside
another positioned layer (the fullscreen Elench dialog) rendered *behind* it, while the class name
said `z-[var(--z-overlay)]` the whole time. The fix was a `relative`, which no z-index matcher looks
at. A page can name every token correctly and still put its popover behind the chrome; only a
hit-test knows.

**R3's first two honest FAILs were both DECORATION, and the predicate was right to report them**
(#3885). The support chip strip (`components/ai-elements/suggestion.tsx`) and the environments
consistency matrix each scrolled vertically by 3–4px, identically at all four widths, inside a
container that only ever wanted a *horizontal* affordance. One cause, in both: `.vx-clamp`
(`packages/brand/src/tokens.css`) draws its corner marks as a `::before` at
`inset: calc(-1 * var(--cl-gap))` — 2px or 4px **outside** the element — precisely so that a control
never reflows when it clamps. A scroll container measures that decoration as content, so any
`.vx-clamp` element flush against a scroll container's block end adds `--cl-gap` of phantom scroll.
The general shape, for the next reader: an unexplained few-pixel R3 finding is decoration reaching
past a box, not a layout that is genuinely too tall.

**The predicate was not made axis-aware, and no N/A was declared.** R3 already reads only
`overflowY` and `scrollHeight`, so it is vertical-only in the sense that matters — a horizontal strip
whose content fits vertically has never been a finding, and admitting `data-slot=scroll-area-viewport`
would have exempted every inner scroller on every route to excuse two. An "only if it overflows by
more than *N* pixels" arm would have been worse: a threshold picked to clear the two pages in front
of it is the guard weakened until the defect fits through, and the pages would have re-failed the
day a chip grew a pixel. The two containers reserve `--cl-gap` on the block axis instead.

**R5 needs one thing fixing before it can be believed.** `e2e/helpers/a11y.ts` currently returns `[]`
when `@axe-core/playwright` cannot be imported. A silent empty result is indistinguishable from a
clean page — it must raise.

---

## The scoreboard and the ratchet

**Both halves are built** — the static one in #3618, the live one in #3634.
`apps/console/scripts/audit-report.mjs` generates [`scoreboard.md`](./scoreboard.md) and
`apps/console/ui-conformance-baseline.json`: `pnpm -F console audit:report --write` regenerates
them, a bare `pnpm -F console audit:report` checks them against the tree and exits 2 naming the
command — the contract `PROGRAMME.md`'s derived half uses. Never hand-edit either file.

**The live half is measured in CI and committed, not inferred.** The Playwright `audit` project
writes two files — `test-results/ui-audit.json` (T5, T6, R1–R7, as the run's own owner in a fresh
empty org) and `test-results/ui-audit-permissions.json` (T7, as the `member` persona in a *second*
organisation) — and
`node apps/console/scripts/audit-report.mjs --import-live=<dir> --run=<url> --commit=<sha>` reduces
them to `apps/console/ui-conformance-live.json`. **They are joined, never pooled**: each artifact
declares the predicates it may carry, and a record in the wrong one refuses to parse.
`e2e/audit/report.ts`'s header records what pooling them cost the first time.

A (route, predicate) cell no artifact carries is **`NOT MEASURED`** — its own column, never folded
into N/A and never a pass. `permissions.spec.ts` drives only the org-only routes, so T7 has no
record for the 13 parameterised ones; an N/A there would be a claim about the page, and rule 2 above
forbids one that is not derivable from the route record. `NOT MEASURED` is a claim about the
instrument, which is what #3854 built it for. It leaves the denominator exactly as an N/A does, so a
predicate withheld everywhere scores `null`, never `1`.

- One row per route, one column per family, plus a per-predicate **N/A count**.
- A route's score **may never fall**. A new route starts at the current floor, not at zero — landing
  a page that scores 0 must not be easier than improving one that scores 0.6.
- The baseline is captured on an **unmodified `dev`** before any conformance lane changes a
  component (#3618 for the static families, #3634 for the live ones). A guard shipped in the same
  commit as its fix is tautological, and this repo has paid for that more than once.
- A lane's PR must move a number **in the same commit** as its code. A lowered baseline with no code
  change, or a code change that moves no number, is wrong in one direction or the other.

**The scoreboard is a report; it is not a third baseline.** The two files that ratchet are
`apps/console/route-states-baseline.yaml` and `apps/console/shared-surface-allowlist.yaml`. The
scoreboard joins them to a route, which neither of them does — both are per file and per predicate,
so "which pages are worst" was an impression until it existed.

### What the generator found that this file did not say

Three gaps, each now owned. They are recorded here because a rubric that does not name its own
blind spots reads as a rubric that has none.

- **H3 has no instrument** (#3797). `StatusBadge` is the one H row with no matcher, and
  `check-shared-surface.mjs` says why: the rule has no negative form to grep for.
- **F1–F7 had no instrument at all** (#3796) — **closed**. `scripts/check-filter-standard.mjs`
  now scores F1–F6 over the console's fifteen filter SURFACES, and
  `apps/console/tests/lib/queries/filter-standard-facets.test.ts` measures F7 by running every
  facet-bearing server builder. What that unit found first was that this sentence had the shape of
  the defect wrong: the standard was implemented across fifteen surfaces and UNMEASURED, not
  absent — and an un-instrumented cell and an empty one render the same dash.
- **The empty-state matcher mapped to no predicate** (#3798) — **now H9**.
  `check-shared-surface.mjs`'s `empty_state` rule guards CLAUDE.md §6's `@repo/ui/empty` row and
  found 18 occurrences on an unmodified `dev`, and the H table above had no row for it because this
  file assigns the *rendered* empty state to **T5**, which it declares live. The scoreboard counted
  those 18 in its reconciliation and scored them nowhere. #3634 closed it by giving the static
  question its own row rather than by folding two instruments into one verdict.

Nothing runs the generator in CI yet (#3799) — the same hand-off #3616 left to #3759 for the
route-state gate, and named for the same reason: a check nothing invokes reports green by never
running.
