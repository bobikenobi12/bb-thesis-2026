#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// CLAUDE.md §6's shared-surface table, made mechanical for every row where a token shape can carry
// the rule and the drift was measured — five of its seven, plus the section's closing "No stat-card
// strips". StatusBadge and the filter standard are the two that stay prose, and the list below says
// why each of them does.
//
// WHY THIS EXISTS. That table states its own reason — "if two pages disagree about how something
// looks or reads, the user is being told the product is two products" — and no row of it was
// guarded by anything. Measured on dev at af8d63dc: `projects.estimated_monthly_cost` is ONE
// `numeric` column and the console rendered it three ways, `$12.50/mo` in twelve places,
// `~$12/mo` in three and `€12.50` in one; in-app page titles rendered at FIVE sizes, from
// `text-base` to `text-4xl`. Neither `check:dead-code` (knip) nor `check:action-boundary` can see
// either, and packages/eslint-config carries no `no-restricted-syntax`.
//
// The rows added in #3615 were measured the same way, on an unmodified `dev`, and found 101 more
// occurrences: the SAME heading rung typeset at five sizes across 24 `<h2>`, with 17 `<h3>` and 5
// `<h4>` under them; 33 hand-rolled empty states at six different heights (four of them
// byte-identical across two sibling sheets); 12 stat-card cells and the 2 primitives they render,
// against a ban with no qualifier on it; three grids standing in for tables and one raw `<table>`;
// two raw stacking levels in the gap the layer scale leaves empty; and the two money sites whose
// currency symbol reaches the number by a route the `$${` matcher cannot see.
//
// SEVEN OF THOSE MATCHERS WERE TOO NARROW ON FIRST SUBMISSION, and every one of the seven was
// narrow in the same direction — it read a shape somebody had already written, not the shape the
// rule is about. That distinction is the review finding worth carrying forward, because three of
// the seven were not merely incomplete but ACTIVELY PERVERSE: a padding cap at the measured
// maximum meant a recorded debt row could be silenced by making the drift bigger; a heading rule
// stopping at `<h3>` meant a flagged heading could be silenced by demoting it and worsening the
// outline; a `:` in the z-index lookbehind meant a flagged `z-50` could be silenced by writing
// `md:z-50`. A guard whose cheapest escape route is to deepen the defect is worse than no guard.
// Where a bound is now wider than anything live, that is deliberate and the comment says so.
//
//   node scripts/check-shared-surface.mjs             # scan, and check the ledger counters
//   node scripts/check-shared-surface.mjs --write      # rewrite the ledger counters (pnpm gen:shared-surface)
//   node scripts/check-shared-surface.mjs --self-test
//   node scripts/check-shared-surface.mjs --help
//
// Do NOT pipe it. `node scripts/check-shared-surface.mjs | tail` reports TAIL's exit code, which
// is always 0, and every failure below becomes invisible.
//
// ── THE LEDGER COUNTERS ARE DERIVED, NOT TYPED (#3788) ───────────────────────────────────────
//
// `baseline:` and `debt:` are entry counts over the allowlist's own rows. They used to be typed by
// hand, and the file is shared by every conformance lane of #3613, which gave the counter two
// failure shapes. Different values conflict textually, and resolving that conflict was ARITHMETIC:
// recount the rows on the merged tree, then probe N±1 to prove the number is unique. The same
// value is worse — if one lane removes ten rows and another removes ten DIFFERENT rows, both write
// the same integer, git merges the line silently, and the file is wrong on `dev` with the failure
// blaming whichever PR landed second.
//
// So `--write` rewrites those two lines from the parsed row set and nothing else, and a bare
// invocation refuses a file whose counters disagree with its rows, naming the command that fixes
// it. Resolving the conflict becomes: take either side, run `pnpm gen:shared-surface`, and let CI
// prove the result. The same-value silent-wrong merge becomes structurally impossible, because the
// committed number is no longer something a human chose.
//
// WHAT THIS DOES NOT DO. It is not a way to ratify drift. `--write` reports the number the rows
// ALREADY say — it never adds, removes or reorders a row, and it cannot lower a count on its own.
// Adding an exception still moves the integer in the diff, and a `baseline:` or a `debt:` that goes
// UP is the thing REVIEW stops; that has always been where the shrink-only property lives (the
// allowlist's own header says so), and it is unchanged. What is gone is the arithmetic.
//
// ── WHAT IS GUARDED, AND WHAT IS NOT ─────────────────────────────────────────────────────────
//
// Guarded, with the exact token shape and the exact directories, because "the @repo/format row is
// enforced" is the sentence a reader turns into "nothing else can drift":
//
//   @repo/format   `.toFixed(`, `.toLocaleDateString(`, `.toLocaleTimeString(`, and a literal `$`
//                  written in front of an interpolation (`` `$${n}` ``), in
//                  apps/console/{components,app,lib,hooks} — every top-level console directory
//                  that holds code. It reaches `lib/` because that is where the FOURTH spelling of
//                  the monthly cost was hiding: `lib/promotions/gates.ts` built a user-visible
//                  `Cost +$12.50/mo` by hand while three components had already been converted.
//
//   @repo/format   DIVISION by 1024, in apps/console/{components,app} ONLY. `lib/` is excluded
//                  from this one matcher on purpose and with evidence: six sites under
//                  `lib/cloud-providers/capabilities/**` divide a provider's MB by 1024 to
//                  normalise it into GB for the capabilities catalog. That is arithmetic on a
//                  datum, not a rendering, and `formatBytes` returns a STRING — it cannot be the
//                  answer there. Widening the matcher would have bought six allowlist entries
//                  that are not decisions.
//
//   @repo/format   MONEY THAT NEVER WRITES ITS OWN `$`, in apps/console/{components,app,lib,hooks}.
//                  Two shapes the `$${` matcher above structurally CANNOT see, because in neither
//                  of them is the currency symbol a literal next to the number:
//                  an interpolation sitting directly behind another (`` `${symbol}${n.toLocale…}` ``
//                  — the symbol is a VARIABLE), and a bare currency symbol handed to a component as
//                  a prop (`prefix="$"`). The header used to record `.toLocaleString(` as
//                  unguardable because a bare call is how a COUNT gets separators; that is still
//                  true, and neither matcher here looks at a bare call. What they look at is the
//                  SYMBOL arriving by another route.
//
//   NO PAGE TITLE  a raw `<h1>`, in apps/console/app/(private)/** and components/**, as the
//                  `page_title` rule. THE DIRECTION OF THIS ROW IS INVERTED FROM WHAT IT WAS: it
//                  used to say "use `PageHeader` instead", and the fix is now DELETION. The
//                  maintainer's call, #3733: the page's name is said three times — the sidebar
//                  entry you clicked, the breadcrumb above the content, and the page's own heading
//                  — and the third one earns nothing. `@repo/ui/page-toolbar` is what is left of
//                  the old component: the count pill, one line of copy and the page's actions, all
//                  of which the breadcrumb duplicates none of. The eleven recorded decisions under
//                  this rule are the surfaces with NO breadcrumb above them — sign-in, the CLI
//                  hand-off, buying a plan — plus one `sr-only` outline landmark.
//
//   @repo/ui/section-heading   a raw `<h2>` through `<h6>`, same scope, as the SEPARATE
//                  `section_header` rule. This is a reversal of what this header said until #3615,
//                  and the reason it reversed is worth keeping: the old text argued that "a
//                  class-name match cannot tell a section heading from a bold label", and declined
//                  the row. That argument was about the CLASS NAME, and the matcher does not read
//                  one — a raw `<h2>` in the console is a heading whatever it is wearing, because
//                  the tag is the thing that lands in the accessibility tree. Measured when the
//                  rule was added: 24 `<h2>` across at least five type scales (`text-[19px]`,
//                  `[17px]`, `[15px]`, `[14.5px]`, `text-lg`/`2xl`), so the same rung of the same
//                  document outline is rendered five sizes, 17 `<h3>` under them, and 5 `<h4>`
//                  under those which already disagree between `text-sm` and `text-xs`. It runs to
//                  `<h6>` and not to `<h3>` because a rule that stops early is an instruction to
//                  demote: a flagged `<h3>` written as `<h4>` passes, and the outline it was
//                  protecting is worse than before.
//
//                  The ANSWER moved in #3733 too. It was `PageHeader` with `level={n}`, which
//                  rendered `text-lg font-medium` whatever the level — so every heading converted
//                  to it jumped to 18px from the 14.5–15px the console actually typesets that rung
//                  at, and that jump is what found the missing type scale below. It is now
//                  `SectionHeading` from `@repo/ui/section-heading`: one rung (`--text-ui-lg`),
//                  `level` sets the tag and nothing else.
//
//   a `--text-ui-*` rung   a HARDCODED font size — `text-[13px]`, `text-[12.5px]`, and the same in
//                  any length unit — in apps/console/{components,app,lib,hooks}, as the
//                  `type_scale` rule. It reaches `lib/` and `hooks/` for the reason the format rule
//                  does: a class list does not stop being one for living outside a component, and
//                  those two roots hold no Tailwind class string at all today, so the wider scope
//                  costs nothing and closes the hole a className constant would move into.
//                  The census is measured by this matcher on every run, never written down here:
//                  it spans 23 distinct values across 194 files, against a
//                  `packages/brand/src/tokens.css` that carried NO UI type scale at all — only
//                  `--text-display-lg/md/sm` for marketing headlines, starting at 30px. So every
//                  file picked its own number and the same rung of the same page is typeset at
//                  five sizes. The scale is seven rungs DERIVED from where those sites cluster,
//                  and the whole census is recorded as `lifts:` debt so it can only shrink. The
//                  unit alternation is wider than anything live — there is not one
//                  `rem`/`em`/`pt` font size in the console today — because px is not the rule: a
//                  flagged `text-[13px]` rewritten as `text-[0.8125rem]` would otherwise silence
//                  the guard while changing nothing, which is the shape a "fix" takes. A SECOND
//                  matcher reads Tailwind's arbitrary-PROPERTY spelling of the same declaration,
//                  `[font-size:13px]` — eleven characters, no new utility, every variant prefix,
//                  and it compiles to exactly what `text-[13px]` compiles to. There is not one live
//                  site, and that is why it costs nothing to close now.
//
//   @repo/ui/empty  a CENTRED BLOCK STANDING IN FOR CONTENT, in apps/console/{components,app}: one
//                  class string carrying both `text-center` and `py-6` OR MORE, with no upper
//                  bound. The vertical padding is the whole shape — it is what separates a block
//                  placed where rows would have been from a centred label, a table cell, or a
//                  caption, none of which buy themselves 24px of air. Measured: 33 of them across
//                  six different heights, the tallest `py-16`; the rule reads every rung above that
//                  too, because the measured maximum is not the boundary and capping there let a
//                  recorded row be silenced by making the block taller.
//
//   no stat-card strip  a `<Stat` CELL, and the `Stat` primitive itself, in
//                  apps/console/{components,app}. §6's ban is one line with no qualifier ("No
//                  stat-card strips"), and both halves have to be matched or fixing it looks like
//                  moving it: deleting a strip while leaving the primitive it was built from leaves
//                  the next strip one import away. It matches the CELL rather than the container
//                  that holds it because the container is the wrong half of the shape twice over —
//                  the formatter's own wrap of a long container is three lines, and the console's
//                  own `<Card>` is in no `div|section|dl` alternation.
//
//   a `--z-*` token  a RAW stacking level of 40 or more, VARIANT PREFIX OR NOT, in
//                  apps/console/{components,app}. Not
//                  every bare `z-*`: `packages/brand/src/tokens.css` puts its in-flow lifts at
//                  10/20/30 and starts the page chrome at 100, so a bare `z-10` is an unnamed rung
//                  that nevertheless IS a rung, while `z-40` and `z-50` name a level in the gap the
//                  scale deliberately leaves empty — below the header, below every overlay, above
//                  every in-flow lift. That is not a style preference: the hand-rolled combobox
//                  popover at `z-50` paints UNDER the site header. `z-[95]` and any other
//                  arbitrary numeric value are matched for the same reason; `z-[var(--z-overlay)]`
//                  is the fix and is not matched. `md:z-50`, `hover:z-40` and
//                  `data-[state=open]:z-50` ARE — the last is how a Radix/base-ui popover picks its
//                  level, and all three were invisible while the lookbehind excluded a colon.
//
//   DataTable       a grid used as a table, and a raw `<table>`, in apps/console/{components,app}.
//                  This too is a reversal, and the old text set the bar it had to clear: the a11y
//                  defect "needs a SHAPE test — a header row, repeated row children — not a
//                  class-name match", because "a guard that cannot separate a layout from a table
//                  is noise, and noise is how a guard gets disabled". So it is a shape test. A
//                  match needs THREE things in one class string: `grid`, a BRACKETED column
//                  template (`grid-cols-[2fr_1fr_auto]` — somebody spelling out column widths,
//                  which is what a table has and an N-up card grid does not), that template
//                  UNPREFIXED by a breakpoint, and a row marker (`uppercase`, the typesetting of a
//                  `<th>`, or `hover:bg-`, which only a row highlights on). The breakpoint test is
//                  the one that carries it: a table's columns are the same at every width, so
//                  `lg:grid-cols-[280px_1fr]` is a page layout stacking on a phone and is not a
//                  table. The class string may be double-quoted, single-quoted or a template
//                  literal — the delimiter is captured and closed with a backreference, so a
//                  conditional class list is read and no string may be closed by the other kind of
//                  quote. Measured: 22 bracketed-template sites in the console, 19 of them honest
//                  layouts, 3 matches in 2 files — plus the one raw `<table>`, which is the same
//                  defect arriving from the other direction (a real table element that is not
//                  `@repo/ui/table`, so it agrees with nothing).
//
// NOT guarded, and the omission is stated here rather than left for a reader to infer that the
// whole table is enforced:
//
//   StatusBadge      — 33 files, the best-adopted row, and the one with no negative form to match:
//                      the defect is "a `<Badge>` plus a LOCAL colour map", and a local colour map
//                      is an object literal, which is exactly the thing a token-shape scan cannot
//                      tell from any other object literal. #3622 and #3623 name the live ones.
//   EmptyState's negative form — "a page that should have shown an empty state and showed nothing"
//                      is not a grep either, and the matcher above cannot see it: it finds the
//                      empty states somebody wrote by hand, never the ones nobody wrote at all.
//   the filter standard's server half — `apps/console/lib/queries/facets.ts` and the `query*Page`
//                      builders. "A facet pass sees only the scope predicates" is a real check and
//                      a real unit test; it is not a text match.
//   `date-fns` direct — 11 console files still import `formatDistanceToNow` rather than
//                      `formatRelative`. A bare import name is a weak signal (the package has
//                      honest non-formatting uses), so this row is prose, not a matcher.
//   a bare `.toLocaleString(…)` — still not matched, and for the reason first recorded here: with
//                      no options it is the correct way to put separators in a COUNT and appears
//                      ~20 times, so no shape separates the money sites from the counts. The two
//                      money matchers above do not relax this — they match the SYMBOL's route in,
//                      never the call.
//   a NEGATIVE `-z-*`  — none exist, and a level below the flow is a different question from
//                      claiming one above it.
//   an inline `fontSize:` — the other route to a hardcoded size, and it is NOT matched. Measured
//                      inside the guarded roots: seven sites, and not one of them is a rung. Four
//                      COMPUTE the value from a geometry the caller passed (`Math.round(size *
//                      0.5)` for an avatar's initials, three more of that shape), which is a glyph
//                      sized to a box; one is an SVG `fontSize="9"` presentation attribute on a
//                      `<text>` node, which is drawing, not typesetting; and two are the
//                      `appearance` object handed to Stripe Elements, which renders inside a
//                      cross-origin iframe that no Tailwind class and no CSS variable can reach.
//                      `--text-ui-*` cannot be the answer to any of the seven, so a matcher here
//                      would buy seven allowlist entries that are not decisions. The literal
//                      `fontSize: "13px"` spelling that WOULD be a rung exists 18 times, and every
//                      one is under `apps/console/emails/**`, which no scope here reaches — an
//                      email client resolves no variable and no class either.
//   A CLASS LIST SPLIT ACROSS TWO `cn()` ARGUMENTS — `cn("px-4 py-16", "text-center")`, and the
//                      same for the grid matcher. The two class-string matchers read ONE string
//                      literal, in any of the three quote styles; a pair whose halves live in two
//                      arguments of one call is one honest expression and it is not matched.
//                      Reading it needs the lookaheads to run over the whole `className={…}`
//                      expression, which without a parser means guessing where that expression
//                      ends — and guessing long is how a matcher starts marrying tokens from two
//                      unrelated strings. Zero live sites today; stated here because an unstated
//                      exception is how the next reader concludes the row is fully enforced.
//
// ── HOW IT MATCHES ───────────────────────────────────────────────────────────────────────────
//
// Node ships no TypeScript parser and this repo's worktrees are de-hydrated (no node_modules), so
// a real parse is not available — the same constraint scripts/ts-coverage.mjs states for itself.
// What it does instead is match TOKEN SHAPES on comment-stripped source: a leading `.` and a
// trailing `(` for a member call, a following `[\s/>]` for a JSX tag, a leading `/` for a DIVISION
// (so `10 * 1024 * 1024` defining a size limit is not a byte rendering and is not flagged).
//
// Matching runs over a TWO-LINE WINDOW, and a match counts only when it STARTS on the first of the
// pair, so every match is found exactly once and attributed to the line it opens on. A line at a
// time was not enough: Prettier and Biome break a binary expression after the operator, so
// `bytes /\n\t1024` is one edit away from any flagged division and a per-line matcher reads it as
// clean — the direction that reports green. The same window is what lets `<h1` be found when the
// className sits on the next line.
//
// The comment stripper is deliberately line-oriented: whole-line `//`, and block comments that
// OPEN a line (`/*`, `/**`) plus JSX comments (`{/*`) anywhere quotes are balanced ahead of them.
// It does not try to find a trailing `//`, because telling one from `"https://…"` inside a JSX
// string needs the parser we do not have — and getting THAT wrong blanks live code, which makes
// the guard report green on what it never read. A trailing comment that happens to contain
// `.toFixed(` is a false positive instead: loud, and fixable. That asymmetry is the whole reason
// for the choice, and it is why an unterminated block comment REFUSES the file rather than
// blanking the rest of it.
//
// The same asymmetry has a second consequence worth stating, because it is a real cost and not a
// bug to be fixed later: a matcher fires inside an ordinary string literal too. A console file
// holding `const HTML = "<h1>Hi</h1>"` reds this check. That is the loud direction, and the remedy
// is to move the sample out of the console tree — not an allowlist entry, which this file reserves
// for decisions about real surfaces.
//
// HOW IT KNOWS IT LOOKED. Five controls, because each catches something the others cannot, and
// this guard was reviewed for reporting a clean tree over files it never opened:
//   - a per-ROOT and per-EXTENSION floor of one file, per scope. Catches a root that moved, an
//     extension list that was edited, a walker that broke.
//   - a per-scope CENSUS FLOOR checked into apps/console/shared-surface-allowlist.yaml. This is
//     the only one that sees a root DELETED from the scope declaration above, because the per-root
//     check is BUILT from that declaration: with `apps/console/app` removed, every remaining root
//     was healthy and the run printed `✓` over 299 unread route files.
//   - a directory the walker cannot read RAISES rather than counting as empty.
//   - an unterminated block comment REFUSES its file rather than being scanned blank.
//   - a permanent PROBE and ANTI-PROBE per matcher, fired on every run. The others prove the guard
//     read the tree; this one proves each matcher can still find and still discriminate, which is
//     the control that has to outlive the drift — the day the last entry is fixed there is nothing
//     else left to notice a matcher that has quietly stopped matching.
//
// ── WHY THERE ARE TWO LEDGERS, AND WHY THE SECOND ONE IS NOT AN ALLOWLIST ─────────────────────
//
// The exception list has always said an entry is a DECISION and never "we haven't got to it yet",
// which is the right rule and the reason the eleven `page_header` reasons are worth reading. It is
// also, on its own, a rule that stops a guard from ever being ADDED to a surface that has already
// drifted: the six rules above were measured on an unmodified `dev` and found 88 occurrences, and
// there is no honest sentence in the product's voice that calls any of them a different thing.
// Writing 88 fake decisions would empty the word "decision" of meaning; leaving the guard red would
// mean it never lands, which is how the drift got to 88.
//
// So an entry is one of two kinds, and the file says which:
//   `reason:` — a DECISION. This surface is genuinely different. Counts against `baseline`.
//   `lifts:`  — DEBT. Measured drift, kept per file and per occurrence so it can only shrink, and
//               naming the board issue that removes it. Counts against `debt`, never `baseline`.
// Both numbers are checked in BOTH directions, so neither can grow and neither can be under-spent.
// Everything else — the per-occurrence `hits`, the entry-matches-nothing failure, the printed
// text — is identical, because a debt row is a measurement and has to be as precise as a decision.
//
// The guard cannot match itself: its scopes are all under `apps/console/**` and it lives in
// `scripts/`, and its fixtures are strings held in this file, never files on disk. The self-test
// asserts both.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// The comment stripper described above lives in `scripts/lib/console-routes.mjs` and is imported,
// not copied. It was a copy for exactly one release: `console-routes.mjs` needs it too (a
// commented-out `export const metadata` would otherwise read as real), and it could not import
// THIS file because this file runs its whole check at import time and can `process.exit(1)`.
// The import goes checker → seams module and can only go that way until this file grows an
// entrypoint guard; `console-routes.mjs` already has one (`invokedDirectly`), so importing it
// here runs no check.
import { stripCommentLines as stripComments } from "./lib/console-routes.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const ALLOWLIST = "apps/console/shared-surface-allowlist.yaml";

/**
 * A separator that cannot occur in a rule id or a repo path. Written as an ESCAPE, never as a
 * literal byte: three raw NULs in this file's source made `rg` and `grep -r` classify it as
 * binary and refuse to print any line of it, for a guard whose entire value is that the next
 * reader can find and read its stated scope.
 */
const SEP = "\u0000";

/**
 * Where a matcher is allowed to look. Named, because two matchers in the SAME rule need different
 * answers — see the byte-division note in the header — and because the vacuity check below reports
 * per root and per extension, which needs the pair to still be visible at check time.
 */
const SCOPES = {
	// Every top-level console directory that holds code. `lib/` and `hooks/` are in it because a
	// user-visible string does not stop being one for living outside a component.
	console_code: {
		roots: ["apps/console/components", "apps/console/app", "apps/console/lib", "apps/console/hooks"],
		exts: [".ts", ".tsx"],
	},
	// The rendering layer only. See the header for why the byte matcher stops here.
	console_view: {
		roots: ["apps/console/components", "apps/console/app"],
		exts: [".ts", ".tsx"],
	},
	// In-app pages. The root is `apps/console/app` with `(public)` EXCLUDED BY NAME, which is
	// what the exclusion has always been about: those routes are the signed-out, marketing-shaped
	// surfaces the allowlist's display-heading reason already covers, and they are not "in-app
	// page titles" at all.
	//
	// It used to be rooted at `app/(private)` instead, which said the same thing badly: five route
	// files sit in NEITHER group — `error.tsx`, `global-error.tsx`, `not-found.tsx`, `providers.tsx`
	// and `start/page.tsx` — and a signed-in user meets the first three constantly. None of them
	// holds a raw heading today, so this was a hole in the CENSUS rather than a missed finding, and
	// it is the kind no anti-vacuity control can see: `app/(private)` still resolved, its floor
	// still passed, and a raw `<h1>` added to `app/error.tsx` tomorrow was not a finding.
	console_pages: {
		roots: ["apps/console/app", "apps/console/components"],
		exts: [".tsx"],
		exclude: ["apps/console/app/(public)"],
	},
};

/**
 * The guarded rows. `id` is also the allowlist's section name, so a section this file does not
 * know about is a parse error rather than a silently ignored block of exceptions.
 */
const RULES = [
	{
		id: "format",
		surface: "@repo/format",
		matchers: [
			{
				scope: "console_code",
				re: /\.\s*toFixed\s*\(/g,
				say: "hand-rolls decimals with `toFixed`. Use `formatMonthlyRate` for a monthly cost, `formatMoney` for a billed amount (it takes CENTS), or `formatMinutes`/`formatBytes`/`formatDuration`.",
				probe: "const s = `$${cost.toFixed(2)}/mo`;",
				antiProbe: "const toFixed = 1;",
			},
			{
				scope: "console_code",
				re: /\.\s*toLocaleDateString\s*\(/g,
				say: "builds its own date. Use `formatDate` — it fixes the locale and documents the server/client timezone hydration trap this call site is exposed to.",
				probe: "const d = new Date(v).toLocaleDateString();",
				antiProbe: "const d = v.toLocaleString();",
			},
			{
				scope: "console_code",
				re: /\.\s*toLocaleTimeString\s*\(/g,
				say: "builds its own time. Use `formatRelative` for a feed, or `formatDate(value, \"time\")` for a log gutter.",
				probe: "const t = new Date(v).toLocaleTimeString();",
				antiProbe: "const t = v.toLocaleString();",
			},
			{
				// A literal `$` in front of an interpolation. Measured before adding it: seven hits
				// in the whole console and all seven were money, including the two file-local
				// `currency()` helpers that rendered `estimated_monthly_cost` a second way and the
				// promotion-gate detail string that rendered it a third. It is the shape that
				// separates a hand-written currency symbol from a formatted quantity, which
				// `toLocaleString` alone cannot do.
				scope: "console_code",
				re: /\$\$\{/g,
				say: "writes its own currency symbol in front of a number. Use `formatMonthlyRate` for a recurring cost or `formatMoney` for a billed amount — they own the symbol, the separators and the decimals, so two screens cannot disagree about them.",
				probe: "const s = `$${n}`;",
				antiProbe: "const s = `${n}`;",
			},
			{
				// A DIVISION by 1024 is a byte rendering. A multiplication is a size limit
				// (`10 * 1024 * 1024`) and is not one, which is why the leading `/` is required.
				scope: "console_view",
				re: /\/\s*\(?\s*1024\b/g,
				say: "divides bytes by 1024 by hand. Use `formatBytes`, which steps the units and keeps one decimal only above kilobytes.",
				probe: "const mb = bytes / (1024 * 1024);",
				antiProbe: "const MAX = 10 * 1024 * 1024;",
			},
			{
				// MONEY BEHIND A VARIABLE. `$${` cannot see this one: the symbol is chosen at run
				// time (`const symbol = currency === "eur" ? "€" : "$"`), so nothing in the source
				// puts a `$` in front of the number. What IS in the source is an interpolation
				// sitting directly against another whose expression formats a number — no
				// separator, no space, no text between them, which is what glueing a symbol onto a
				// figure looks like and what a sentence built from two values never does.
				scope: "console_code",
				re: /\}\$\{[^`{}\n]*\.\s*toLocaleString\s*\(/g,
				say: "glues a run-time currency symbol onto a formatted number. Use `formatMoney` (it takes CENTS) or `formatMonthlyRate` — they own the symbol for every currency, so a checkout and an invoice cannot disagree about how €12.50 is written.",
				probe: "const s = `${symbol}${n.toLocaleString(\"en-US\")}`;",
				// The anti-probe varies the axis that MATTERS, which is not the one it first varied.
				// Two interpolations with a separator between them (`${a} / ${b.toLocaleString()}`)
				// tests the adjacency and leaves the CONTENT untested — and adjacency alone is 48
				// sites in this console, almost all of them an id glued to a suffix. Widening the
				// matcher to a bare `}${` was the one mutation the anti-probes did not kill.
				antiProbe: "const s = `${context.resource_type}${suffix}`;",
			},
			{
				// MONEY BEHIND A PROP. The symbol is not next to the number here either — it is
				// handed to a component that renders `{prefix}{n}` somewhere else entirely. A JSX
				// attribute whose whole value is a currency symbol is the one shape that survives
				// that hand-off, and it is worth matching precisely because the render site is
				// unreachable: `{prefix}` on one line and `{n}` on the next is not a money shape.
				//
				// `\w+=` with no space around it is a JSX attribute and not an assignment, because
				// the formatter puts spaces around `=` in `const symbol = "$"` — measured: one hit
				// in the whole console, the prop. If that ever stops being true the cost is a false
				// positive, which is the loud direction.
				scope: "console_code",
				re: /\w+=["'][$€£¥]["']/g,
				say: "passes a currency symbol to a component as a prop, which puts the symbol at one end of a prop and the number at the other. Use `formatMoney`/`formatMonthlyRate` at the call site and hand the component the finished string.",
				// `<Amount`, not the `<Stat` this was measured on: `<Stat` is itself a finding under
				// the stat-strip rule now, and a fixture that trips two matchers proves neither.
				probe: 'const a = <Amount value={12} prefix="$" />;',
				antiProbe: 'const a = <Amount value={12} prefix="~" />;',
			},
		],
	},
	{
		// THE DIRECTION OF THIS RULE IS INVERTED. It used to say "a page title must come from
		// `PageHeader`"; it now says a console page has no page title at all. The regex did not
		// change and neither did the eleven recorded decisions — what changed is the FIX the guard
		// prints, from "adopt the component" to "delete the heading", and that sentence is the
		// whole rule. #3733: the page's name is said by the sidebar entry you clicked and by the
		// breadcrumb above the content, and a third saying earns nothing.
		//
		// It is NOT renamed to something like `no_page_title` beyond this: the id is the
		// allowlist's section name, so it is a value in a checked-in file, and `page_title` says
		// what it matches without pretending the eleven entries beneath it are new.
		id: "page_title",
		surface: "no page title — the breadcrumb already says it",
		matchers: [
			{
				// `|$` for the last line of a file, where the two-line window has no next line to
				// supply the `\s` that error-state.tsx's `<h1`-then-className shape matches on.
				scope: "console_pages",
				re: /<h1(?=[\s/>]|$)/g,
				say: "gives the page a title. The sidebar entry you clicked and the breadcrumb above the content both already say this page's name — delete the heading. `PageToolbar` from `@repo/ui/page-toolbar` keeps the count pill, the description and the page's actions, which the breadcrumb duplicates none of; a heading INSIDE the page is `SectionHeading` from `@repo/ui/section-heading`.",
				probe: 'const a = <h1 className="text-2xl">Clusters</h1>;',
				antiProbe: "const a = <h10>x</h10>;",
			},
		],
	},
	{
		// A SEPARATE rule from `page_header`, not two more matchers inside it, because the allowlist
		// is keyed per file per SECTION: a file carrying an allowlisted `<h1>` and a new `<h2>` would
		// otherwise merge into one entry whose recorded reason describes only the `<h1>`, and the
		// per-occurrence ratchet would be spent on a heading nobody decided about.
		id: "section_header",
		surface: "@repo/ui/section-heading",
		matchers: [
			{
				scope: "console_pages",
				re: /<h2(?=[\s/>]|$)/g,
				say: "hand-writes a section heading. Use `SectionHeading` from `@repo/ui/section-heading` — it owns the one size, weight and spacing a section heading gets, which is why the console currently renders that same rung at five different sizes.",
				probe: 'const a = <h2 className="text-lg font-semibold">Usage</h2>;',
				antiProbe: "const a = <h20>x</h20>;",
			},
			{
				scope: "console_pages",
				re: /<h3(?=[\s/>]|$)/g,
				say: "hand-writes a third-level heading. Use `SectionHeading` with `level={3}`, so a heading nested under a section is a rung of one outline rather than whatever size its own file chose.",
				probe: 'const a = <h3 className="text-sm font-semibold">Members</h3>;',
				antiProbe: "const a = <h30>x</h30>;",
			},
			{
				// h4 THROUGH h6, and the reason it is not "h2 and h3 are where the drift was". A rule
				// that stops at h3 hands out an escape hatch that makes the defect WORSE: a flagged
				// `<h3>` is silenced by demoting it to `<h4>`, which passes this guard while breaking
				// the document outline it was supposed to protect. Measured when this was extended:
				// five live `<h4>` in three files, already disagreeing (`text-sm` in one,
				// `text-xs` in the other four, and two of those in different class order) — the same
				// defect the `<h2>` count was written about, one rung down.
				scope: "console_pages",
				re: /<h[4-6](?=[\s/>]|$)/g,
				say: "hand-writes a fourth-level or deeper heading. Use `SectionHeading` with `level={n}` — an outline is only an outline if every rung of it comes from one place, and demoting a heading to escape a guard is not a fix.",
				probe: 'const a = <h4 className="text-xs uppercase">Inputs</h4>;',
				antiProbe: "const a = <h40>x</h40>;",
			},
		],
	},
	{
		// THE TYPE SCALE, added in #3733 with the ladder it points at. Everything above this rule is
		// about a COMPONENT being reached for; this one is about a VALUE, and it is the largest
		// single census in this file: hardcoded sizes across 23 distinct values and 194 files, and
		// the total is whatever this matcher counts on the run, never a number typed here.
		// `packages/brand/src/tokens.css` had no UI type scale at all until the same commit, so
		// there was nothing to reach for — which is why every one of them is `lifts:` debt and not
		// one of them is a decision.
		//
		// WHY THE UNIT ALTERNATION IS WIDER THAN THE TREE. There is not one `rem`, `em`, `pt`, `ch`
		// or `%` font size in the console today, and the matcher reads all of them anyway. px is not
		// the rule — a hardcoded size is — and a flagged `text-[13px]` rewritten as
		// `text-[0.8125rem]` renders identically while dropping the file's `hits` to zero, which
		// reds as "matches nothing" and invites lowering `debt:` for a fix that never happened. That
		// is the same perverse escape the empty-state padding cap used to hand out, one rule over.
		// `length:` is in for the same reason: Tailwind's own disambiguating prefix is a spelling of
		// the identical class.
		//
		// It does NOT read a colour or a variable: the value has to START with a digit or a decimal
		// point, so `text-[#0a0a0a]`, `text-[color:var(--text-primary)]` and `text-[var(--text-ui-lg)]`
		// are all untouched. The last of those matters most — it is one of the two spellings of the
		// FIX, and a matcher that reported its own answer would be unfixable.
		//
		// `\b` and not a `(?<![-\w])` lookbehind: a Tailwind variant prefix ends in `:`
		// (`md:text-[13px]`, `group-hover:text-[11px]`), and excluding the colon is exactly how the
		// layer-token rule taught its own evasion for a year. A word boundary admits every prefix.
		id: "type_scale",
		surface: "a `--text-ui-*` rung from packages/brand/src/tokens.css",
		matchers: [
			{
				// `console_code`, not the rendering layer the byte matcher stops at: a class list does
				// not stop being one for living outside a component. Measured before choosing it —
				// `apps/console/{lib,hooks}` hold ZERO Tailwind class strings of any kind today, so
				// the wider scope changes the census by nothing and costs nothing, and it is the
				// half of the console a className constant would move INTO.
				scope: "console_code",
				re: /\btext-\[(?:length:)?\d*\.?\d+(?:px|rem|em|pt|ch|%)\]/g,
				say: "picks its own font size. Use a `--text-ui-*` rung — `text-ui-3xs` … `text-ui-xl` in packages/brand/src/tokens.css. The rungs are derived from where the measured sites cluster.",
				// A VARIANT PREFIX and a HALF-PIXEL value, because both are live shapes and either
				// one alone would leave a hole a plain `text-[13px]` probe cannot see.
				probe: 'const a = <p className="md:text-[12.5px] text-text-tertiary">x</p>;',
				// The FIX, in both of its spellings, plus an arbitrary colour — the three things a
				// widening to `text-\[[^\]]+\]` would swallow. Varying the SIZE here would test
				// nothing: any regex that matches the probe matches another number too.
				antiProbe: 'const a = <p className="text-ui-md text-[color:var(--text-primary)]">x</p>;',
			},
			{
				// THE ARBITRARY-PROPERTY SPELLING, and it is the widest escape of the lot — wider
				// than every unit rewrite the matcher above was widened for. Tailwind compiles
				// `[font-size:13px]` to the identical declaration as `text-[13px]`, takes every
				// variant prefix, and needs no new utility, so a flagged site is silenced by moving
				// eleven characters. It is a SECOND matcher rather than an alternation inside the
				// first because the two shapes share no anchor: one starts at `text-[`, the other
				// at `[`, and a single regex reaching both would have to match a bare `[`.
				//
				// Zero live sites — `grep -rn "\[font-size:" apps/console` finds none — so this
				// adds no allowlist entry and moves no ledger. That is the point: it closes the
				// route before anybody finds it, which is the only time closing one is free. The
				// probe is what holds it, and the file's permanent positive control fires it on
				// every run.
				scope: "console_code",
				re: /\[font-size:\s*(?:length:)?\d*\.?\d+(?:px|rem|em|pt|ch|%)\]/g,
				say: "picks its own font size through Tailwind's arbitrary-property syntax, which compiles to exactly what `text-[13px]` does. Use a `--text-ui-*` rung — `text-ui-3xs` … `text-ui-xl` in packages/brand/src/tokens.css.",
				probe: 'const a = <p className="md:[font-size:12.5px]">x</p>;',
				// A NON-SIZE arbitrary property, which is the shape a widening to `\[[a-z-]+:` would
				// swallow — and `[mask-image:…]`/`[grid-template-columns:…]` are how a real console
				// file reaches CSS Tailwind has no utility for.
				antiProbe: 'const a = <p className="[mask-image:linear-gradient(90deg,#000,transparent)] text-ui-md">x</p>;',
			},
		],
	},
	{
		id: "empty_state",
		surface: "@repo/ui/empty",
		matchers: [
			{
				// One class string carrying BOTH `text-center` and a vertical padding of 6 or more.
				// The padding is the discriminator and it is doing real work: `text-center` alone is
				// 73 sites, most of them a centred cell, a caption or a label. A block that also buys
				// itself 24px or more of air above and below is standing where rows would have been,
				// which is the definition of an empty state and nothing else's.
				//
				// TWO BOUNDS THIS USED TO GET WRONG, and both were the quiet direction:
				//
				// It anchored on a literal `"`, so a class list in a template literal or in single
				// quotes was invisible — and `className={`…`}` is 23 live sites in this console,
				// because a conditional class list is the normal reason to reach for one. The
				// delimiter is now captured and closed with a backreference, so all three spellings
				// are read and none of them may be closed by a different quote.
				//
				// It capped the padding at `py-16`, which was the measured MAXIMUM and not the
				// boundary the rule is about — `py-20`, `py-24`, `py-32` all escaped. That cap had a
				// perverse consequence worth stating: a recorded debt row could be silenced by making
				// the drift BIGGER. Bump a flagged `py-16` to `py-20` and the entry drops to zero
				// hits, which reds as "matches nothing" and invites lowering `debt:` for a fix that
				// never happened.
				//
				// `[^\n]` and never a bare `.`: a JS string cannot contain a raw newline, so a pair
				// of delimiters spanning one would be the CLOSING quote of this line married to an
				// OPENING quote of the next — a match assembled out of two unrelated strings.
				scope: "console_view",
				re: /(["'`])(?=(?:(?!\1)[^\n])*\btext-center\b)(?=(?:(?!\1)[^\n])*\bpy-(?:[6-9]|[1-9]\d)\b)(?:(?!\1)[^\n])*\1/g,
				say: "hand-rolls an empty state. Use `EmptyState` from `@repo/ui/empty` — six different heights of centred nothing is six answers to the same question, and the one thing a user meets when a list is empty should not change shape between two pages.",
				// The probe is a TEMPLATE LITERAL at a padding above the old cap, so it fails against
				// both of the bounds this matcher used to get wrong rather than only against a dead
				// regex.
				probe: "const a = <div className={`px-4 py-20 text-center ${x}`}>No runners yet</div>;",
				antiProbe: 'const a = <td className="px-3 py-2.5 text-center">{v}</td>;',
			},
		],
	},
	{
		// §6 ends on one unqualified line: "No stat-card strips." Both halves are matched — the
		// strip and the cell primitive it is built from — because fixing only the first looks
		// identical to moving it.
		id: "stat_strip",
		surface: "no stat-card strip",
		matchers: [
			{
				// THE CELL, not the container that holds it. This matched `<div>`-then-`<Stat>` over
				// the two-line window first, and the container turned out to be the wrong half of the
				// shape twice over. The formatter's own wrap of a long container is THREE lines —
				// `<div`, the className, then `>` alone — which one extra utility class on any live
				// strip produces, and the window closed one line too early to see it. And the
				// alternation was `div|section|dl`, so the console's own `<Card className="grid
				// grid-cols-4">` wrapper escaped, while §6's ban carries no qualifier at all.
				//
				// A `<Stat` cell IS the banned thing — the primitive it renders is banned outright by
				// the matcher below — so keying on the cell costs nothing and closes both holes. It
				// also makes the ratchet finer: `hits` now counts CELLS, so removing three of a
				// strip's four is recorded progress rather than an unchanged 1.
				scope: "console_view",
				re: /<Stat(?=[\s/>]|$)/g,
				say: "renders a stat-card cell. CLAUDE.md §6 bans the strips they make up, with no qualifier: a row of big numbers tells the reader what is countable rather than what to do, and it takes the space the thing they came for was going to occupy.",
				probe: '<Card className="grid grid-cols-4">\n\t<Stat\n\t\tlabel="Jobs"\n\t/>',
				antiProbe: '<div className="grid grid-cols-4">\n\t<StatusBadge tone="ok" />',
			},
			{
				// The primitive. Without this the fix is one import away from being undone, and the
				// two live copies of it already disagree — one renders a label above the figure, the
				// other a caption below. `function Stat` and not also `const Stat = (` because both
				// live copies are declarations and a second alternative would be a shape with no
				// occurrence to prove it still matches — the probe would be the only thing holding
				// it, which is exactly the arrangement this file spent its census floors avoiding.
				scope: "console_view",
				re: /\bfunction Stat\s*\(/g,
				say: "defines a stat-card cell. Delete it with the strip it feeds — a `Stat` primitive left behind is the next strip's first line, and the console already carries two copies of this one that disagree about where the label goes.",
				probe: "function Stat({ label, value }) { return null; }",
				antiProbe: "function StatusDot({ status }) { return null; }",
			},
		],
	},
	{
		id: "layer_token",
		surface: "a `--z-*` token from packages/brand/src/tokens.css",
		matchers: [
			{
				// 40 and above — the gap (40..99) and everything past the chrome (100+) — plus any
				// arbitrary NUMERIC value. See the header: the scale's in-flow lifts stop at 30 and
				// its chrome starts at 100, so 0/10/20/30 are rungs written without their names
				// while anything above is a level nobody agreed on. `(?<![-\w])` keeps the matcher
				// off `--z-overlay` itself, which is how the token is spelled everywhere it is used
				// correctly; a NEGATIVE `-z-*` is excluded by the same lookbehind, and the header
				// says why that is the right call rather than an accident.
				//
				// The lookbehind used to exclude `:` as well, which excluded every Tailwind VARIANT
				// prefix with it: `md:z-50`, `hover:z-40` and `data-[state=open]:z-50` all read as
				// clean, and the last of those is exactly how a Radix/base-ui popover picks its
				// level. Worse, it was the shape a "fix" takes — red on `z-50`, write `md:z-50`, go
				// quiet, still paint under the header — so the rule taught its own evasion.
				// Dropping the `:` was measured over the whole console before and after: the same
				// two findings, no new ones, because `--z-overlay` is excluded by the `-` anyway.
				scope: "console_view",
				re: /(?<![-\w])z-(?:[4-9]\d|\d{3,}|\[\d)/g,
				say: "picks its own stacking level. Use a `--z-*` token — `z-[var(--z-overlay)]` for anything that floats over the page. The scale's in-flow lifts stop at 30 and its chrome starts at 100, so a level in between paints UNDER the site header and under every real overlay, whatever it was reaching over.",
				// The probe carries a VARIANT prefix on purpose: the unprefixed form is what the
				// live findings are, so a probe written that way would not have noticed the hole.
				probe: 'const a = <div className="fixed data-[state=open]:z-50" />;',
				antiProbe: 'const a = <div className="absolute z-[var(--z-overlay)] bg-popover" />;',
			},
		],
	},
	{
		id: "data_table",
		surface: "DataTable, or @repo/ui/table",
		matchers: [
			{
				// THE SHAPE TEST this row waited for. Two things in one class string: a BRACKETED
				// column template that is NOT behind a breakpoint (which is a grid by construction —
				// nothing else spells its columns out), and a row marker, `uppercase` for a header
				// row or `hover:bg-` for a data row. See the header for why the breakpoint test is
				// the one that carries it.
				scope: "console_view",
				re: /(["'`])(?=(?:(?!\1)[^\n])*(?<![-:\w])grid-cols-\[)(?=(?:(?!\1)[^\n])*(?:\buppercase\b|\bhover:bg-))(?:(?!\1)[^\n])*\1/g,
				say: "builds a table out of a grid. Use `DataTable`, or `@repo/ui/table` for a shape it cannot express — a `<div className=\"grid\">` reads to a screen reader as a stack of buttons, so these columns reach a blind user unlabelled.",
				probe: "const a = <div className={`grid grid-cols-[2fr_1fr] uppercase ${x}`} />;",
				antiProbe: 'const a = <div className="grid grid-cols-1 gap-4 lg:grid-cols-[280px_1fr] hover:bg-muted/30" />;',
			},
			{
				// The same defect from the other side: a real `<table>` that is not `@repo/ui/table`,
				// so it agrees with nothing about padding, borders, header type or the empty row.
				scope: "console_view",
				re: /<table(?=[\s/>]|$)/g,
				say: "hand-writes a table element. Use `DataTable`, or `@repo/ui/table` — a raw `<table>` agrees with no other table in the console about its header type, its row rule or what it shows when there is nothing in it.",
				probe: 'const a = <table className="w-full">{rows}</table>;',
				antiProbe: "const a = <Table>{rows}</Table>;",
			},
		],
	},
];

// ── source scanning ───────────────────────────────────────────────────────────────────────────

/**
 * Every guarded file in a scope, repo-relative and posix-separated, plus the per-(root, extension)
 * census the vacuity check reads.
 *
 * @param {{roots: string[], exts: string[], exclude?: string[]}} scope
 * @param {(dir: string) => string[]} listDir directory lister, injected for the self-test
 * @returns {{files: string[], census: Map<string, number>, skipped: Map<string, number>}} census
 *   keys are `root SEP ext`; `skipped` counts what each `exclude` prefix actually kept out, so an
 *   exclusion that has stopped excluding anything can be reported rather than sitting there.
 */
export function filesFor(scope, listDir) {
	/** @type {string[]} */
	const found = [];
	/** @type {Map<string, number>} */
	const census = new Map();
	for (const root of scope.roots) for (const ext of scope.exts) census.set(`${root}${SEP}${ext}`, 0);
	/** @type {Map<string, number>} */
	const skipped = new Map();
	for (const e of scope.exclude ?? []) skipped.set(e, 0);

	/**
	 * The exclusion that made this path invisible, or null. A prefix match on a PATH SEGMENT
	 * boundary, not a substring: `apps/console/app/(public)` must not also swallow a sibling
	 * directory whose name merely starts with it.
	 *
	 * @param {string} p
	 */
	const excludedBy = (p) => {
		for (const e of scope.exclude ?? []) if (p === e || p.startsWith(`${e}/`)) return e;
		return null;
	};

	/** @param {string} dir @param {string} root */
	const walk = (dir, root) => {
		for (const entry of listDir(dir)) {
			if (entry === "node_modules" || entry === ".next" || entry === "dist") continue;
			const child = `${dir}/${entry}`;
			const kids = listDir(child);
			const skip = excludedBy(child);
			if (kids.length > 0) {
				// Counted, not merely skipped: an exclusion whose directory was renamed would
				// otherwise stay in the declaration excluding nothing, and read as a live rule.
				if (skip !== null) {
					skipped.set(skip, (skipped.get(skip) ?? 0) + 1);
					continue;
				}
				walk(child, root);
				continue;
			}
			const ext = scope.exts.find((e) => child.endsWith(e));
			if (ext === undefined) continue;
			if (skip !== null) {
				skipped.set(skip, (skipped.get(skip) ?? 0) + 1);
				continue;
			}
			found.push(child);
			const key = `${root}${SEP}${ext}`;
			census.set(key, (census.get(key) ?? 0) + 1);
		}
	};
	for (const root of scope.roots) walk(root, root);
	// A directory can appear under two roots (components/** is a root of several scopes); one file
	// must not be reported twice. The census counts before the de-duplication on purpose — it is
	// measuring whether each ROOT still resolves.
	return { files: [...new Set(found)].sort(), census, skipped };
}

/**
 * @typedef {{rule: string, file: string, line: number, say: string, text: string}} Finding
 */

/**
 * Every rule match in the tree, allowlisted or not.
 *
 * @param {(p: string) => string} readFile
 * @param {(dir: string) => string[]} listDir
 * @returns {{findings: Finding[], census: Map<string, number>, perRule: Map<string, number>, unterminated: Set<string>, skipped: Map<string, number>}}
 *   census keys are `scopeId SEP root SEP ext`; only scopes a matcher actually uses appear.
 *   `skipped` keys are `scopeId SEP excludePrefix`.
 */
export function scan(readFile, listDir) {
	/** @type {Finding[]} */
	const findings = [];
	/** @type {Map<string, {files: string[], census: Map<string, number>}>} */
	const scopeCache = new Map();
	/** @type {Map<string, string[]>} */
	const strippedCache = new Map();
	/** @type {Map<string, number>} */
	const census = new Map();
	/** @type {Map<string, number>} */
	const perRule = new Map();
	/** @type {Set<string>} */
	const unterminated = new Set();
	/** @type {Map<string, number>} */
	const skipped = new Map();

	/** @param {string} id */
	const scopeFiles = (id) => {
		let hit = scopeCache.get(id);
		if (hit === undefined) {
			hit = filesFor(SCOPES[id], listDir);
			scopeCache.set(id, hit);
			for (const [pair, n] of hit.census) census.set(`${id}${SEP}${pair}`, n);
			for (const [prefix, n] of hit.skipped) skipped.set(`${id}${SEP}${prefix}`, n);
		}
		return hit.files;
	};

	for (const rule of RULES) {
		/** @type {Set<string>} */
		const seen = new Set();
		for (const matcher of rule.matchers) {
			for (const file of scopeFiles(matcher.scope)) {
				seen.add(file);
				let lines = strippedCache.get(file);
				if (lines === undefined) {
					const stripped = stripComments(readFile(file));
					// NOT a Finding: an allowlist entry for this file would swallow it, and this is
					// a statement about what the check READ, which no exception can grant.
					if (stripped.unterminated) unterminated.add(file);
					lines = stripped.lines;
					strippedCache.set(file, lines);
				}
				for (let i = 0; i < lines.length; i++) {
					const head = lines[i];
					// The two-line window. A match counts only when it STARTS in `head`, so one
					// wholly inside the next line is attributed to that line on the next turn
					// instead of being reported twice.
					const window = i + 1 < lines.length ? `${head}\n${lines[i + 1]}` : head;
					matcher.re.lastIndex = 0;
					let m;
					while ((m = matcher.re.exec(window)) !== null) {
						if (m.index < head.length) {
							findings.push({ rule: rule.id, file, line: i + 1, say: matcher.say, text: m[0] });
						}
						// A zero-width lookahead match (`<h1`) would loop forever without this.
						if (m.index === matcher.re.lastIndex) matcher.re.lastIndex++;
					}
				}
			}
		}
		perRule.set(rule.id, seen.size);
	}
	return { findings, census, perRule, unterminated, skipped };
}

// ── the allowlist ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {{section: string, path: string, hits: number, kind: "decision" | "debt" | null, note: string, line: number}} Entry
 * @typedef {{scope: string, floor: number, line: number}} Floor
 */

/**
 * A deliberately small reader for the allowlist. There is no js-yaml here — a worktree is
 * de-hydrated and this must run with plain `node` — so the grammar is fixed and narrow, and
 * ANYTHING it does not recognise is an error naming the line. A permissive reader that skipped
 * what it could not parse would turn a typo into a silently dropped exception, which is the one
 * failure mode an allowlist must not have.
 *
 * @param {string} text
 * @returns {{baseline: number, debt: number, entries: Entry[], floors: Floor[]}}
 */
export function parseAllowlist(text) {
	const known = new Set(RULES.map((r) => r.id));
	/** @type {Entry[]} */
	const entries = [];
	/** @type {Floor[]} */
	const floors = [];
	/** @type {Floor | null} */
	let floor = null;
	/** Section+path already claimed, so two entries cannot both count against a ledger. */
	const claimed = new Map();
	let baseline = null;
	let debt = null;
	let section = null;
	/** @type {Entry | null} */
	let current = null;
	/** @param {number} n @param {string} why */
	const bad = (n, why) => {
		throw new Error(`${ALLOWLIST}:${n}: ${why}`);
	};
	/** @param {number} n */
	const closeFloor = (n) => {
		if (floor === null) return;
		if (floor.floor === -1) bad(n, `the \`scanned\` entry for \`${floor.scope}\` has no \`floor:\``);
		floors.push(floor);
		floor = null;
	};
	/** @param {number} n */
	const closeEntry = (n) => {
		closeFloor(n);
		if (current === null) return;
		if (current.hits === -1) bad(n, `entry for \`${current.path}\` has no \`hits:\``);
		// An entry is one kind or the other, never both and never neither. "Neither" is the shape
		// that matters: it used to be caught as "no `reason:`", and a debt row is not a decision, so
		// the check has to be about the PAIR rather than about one field being present.
		if (current.kind === null) {
			bad(
				n,
				`entry for \`${current.path}\` has neither \`reason:\` nor \`lifts:\` — it must be one or the ` +
					"other: a `reason:` says this surface is genuinely a different thing (a DECISION, counted " +
					"against `baseline`), a `lifts:` records measured drift and names the board issue that " +
					"removes it (DEBT, counted against `debt`).",
			);
		}
		const key = `${current.section}${SEP}${current.path}`;
		const first = claimed.get(key);
		if (first !== undefined) {
			// Both would match the same findings, so the second is a free entry against `baseline`
			// and only one of the two reasons is the recorded decision.
			bad(current.line, `a second \`${current.section}\` entry for ${current.path} — the first is on line ${first}. One entry per file per section.`);
		}
		claimed.set(key, current.line);
		entries.push(current);
		current = null;
	};

	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i];
		const n = i + 1;
		if (raw.trim() === "" || raw.trimStart().startsWith("#")) continue;

		let m = raw.match(/^baseline: (\d+)$/);
		if (m !== null) {
			closeEntry(n);
			if (baseline !== null) bad(n, "`baseline:` appears twice");
			baseline = Number(m[1]);
			continue;
		}
		m = raw.match(/^debt: (\d+)$/);
		if (m !== null) {
			closeEntry(n);
			if (debt !== null) bad(n, "`debt:` appears twice");
			debt = Number(m[1]);
			continue;
		}
		m = raw.match(/^([a-z_]+):$/);
		if (m !== null) {
			closeEntry(n);
			if (m[1] === "scanned") {
				section = "scanned";
				continue;
			}
			if (!known.has(m[1])) bad(n, `unknown section \`${m[1]}\` — the sections are scanned, ${[...known].join(", ")}`);
			section = m[1];
			continue;
		}
		m = raw.match(/^ {2}- scope: (\S+)$/);
		if (m !== null) {
			closeEntry(n);
			if (section !== "scanned") bad(n, "`- scope:` belongs to the `scanned:` section");
			floor = { scope: m[1], floor: -1, line: n };
			continue;
		}
		m = raw.match(/^ {4}floor: (\d+)$/);
		if (m !== null) {
			if (floor === null) bad(n, "`floor:` outside a `- scope:` entry");
			floor.floor = Number(m[1]);
			continue;
		}
		m = raw.match(/^ {2}- path: (\S+)$/);
		if (m !== null) {
			closeEntry(n);
			if (section === null) bad(n, "an entry before any section header");
			current = { section, path: m[1], hits: -1, kind: null, note: "", line: n };
			continue;
		}
		m = raw.match(/^ {4}hits: (\d+)$/);
		if (m !== null) {
			if (current === null) bad(n, "`hits:` outside an entry");
			current.hits = Number(m[1]);
			continue;
		}
		m = raw.match(/^ {4}reason: (.+)$/);
		if (m !== null) {
			if (current === null) bad(n, "`reason:` outside an entry");
			if (current.kind !== null) bad(n, `entry for \`${current.path}\` carries both \`reason:\` and \`lifts:\` — it is a decision or it is debt, and only one of them counts against a ledger.`);
			current.kind = "decision";
			current.note = m[1].trim();
			continue;
		}
		m = raw.match(/^ {4}lifts: (.+)$/);
		if (m !== null) {
			if (current === null) bad(n, "`lifts:` outside an entry");
			if (current.kind !== null) bad(n, `entry for \`${current.path}\` carries both \`reason:\` and \`lifts:\` — it is a decision or it is debt, and only one of them counts against a ledger.`);
			// DOUBLE-QUOTED, and the quotes are not decoration: the value has to start with `#`, and
			// a bare `#` opens a comment in every YAML reader that is not this one, so an unquoted
			// value would read as an empty `lifts:` to anything else that ever parses this file.
			const raw2 = m[1].trim();
			const note = /^".*"$/s.test(raw2) ? raw2.slice(1, -1) : null;
			// The issue number is the whole difference between debt and a mute button: it is what
			// keeps the work visible somewhere that is not this file. A `lifts:` that names no issue
			// is a decision wearing the other word.
			if (note === null || !/^#\d+\b/.test(note)) {
				bad(
					n,
					`the \`lifts:\` for \`${current.path}\` must be a quoted value naming the board issue that ` +
						'removes it — `lifts: "#1234 — what it is"`. Debt that names no issue is an exception with a ' +
						"nicer word on it, and an unquoted `#` reads as a comment to every other YAML reader.",
				);
			}
			current.kind = "debt";
			current.note = note;
			continue;
		}
		bad(n, `cannot parse \`${raw.trim().slice(0, 60)}\``);
	}
	closeEntry(lines.length);

	if (baseline === null) throw new Error(`${ALLOWLIST}: no \`baseline:\` — the list has no ratchet, so it is not shrink-only`);
	if (debt === null) throw new Error(`${ALLOWLIST}: no \`debt:\` — the measured drift has no ratchet, so it is not shrink-only`);
	return { baseline, debt, entries, floors };
}

// ── the ledger counters, derived ──────────────────────────────────────────────────────────────

/**
 * The two ledger counters as the ROWS say them. This is the only definition of either number, and
 * `check` compares the committed integers against it in both directions.
 *
 * @param {{entries: Entry[]}} list
 * @returns {{baseline: number, debt: number}}
 */
export function ledgerCounts(list) {
	return {
		baseline: list.entries.filter((e) => e.kind === "decision").length,
		debt: list.entries.filter((e) => e.kind === "debt").length,
	};
}

/** The two lines `--write` may touch, and the ONLY two. Anchored, so a `#`-commented copy in the
 * file's own header is not one of them — every header line starts with `#`. */
const LEDGER_LINE = /^(baseline|debt): (\d+)$/;

/**
 * Render the allowlist with its counters set to what its rows say — the whole of `--write`.
 *
 * It rewrites TWO LINES and nothing else. The rows are hand-authored: their order carries the
 * sections' reading order, their `reason:` and `lifts:` text is prose in the product's voice, and a
 * generator that reformatted them would make every conformance lane's diff unreadable for the sake
 * of two integers. So this does not re-emit the file from the parse; it substitutes in place over
 * `text.split("\n")` and then ASSERTS the result differs from the input at nothing but a
 * `baseline:`/`debt:` line — compared against the rendered text, not against the intent.
 *
 * Deliberately a pure function of the allowlist's own bytes: it does not scan the tree. A generator
 * that gated on the console being clean would refuse to run in the one situation that needs it —
 * a lane whose fix is half-landed — and the counters are a function of the ROWS, never of the tree.
 * The tree is what `check` reads.
 *
 * @param {string} text
 * @returns {{text: string, want: {baseline: number, debt: number}, have: {baseline: number, debt: number}, stale: boolean}}
 */
export function renderAllowlist(text) {
	const list = parseAllowlist(text);
	const want = ledgerCounts(list);
	const have = { baseline: list.baseline, debt: list.debt };
	const before = text.split("\n");
	const after = text.split("\n");
	const seen = { baseline: 0, debt: 0 };
	for (let i = 0; i < after.length; i++) {
		const m = after[i].match(LEDGER_LINE);
		if (m === null) continue;
		const key = m[1] === "baseline" ? "baseline" : "debt";
		seen[key] += 1;
		after[i] = `${key}: ${want[key]}`;
	}
	// `parseAllowlist` already refuses a second `baseline:` or `debt:`, so this cannot be reached by
	// a duplicate. What it catches is the other direction — a line the PARSER counted that this
	// matcher does not see, which would write a file whose counter never moved and report success.
	for (const key of /** @type {const} */ (["baseline", "debt"])) {
		if (seen[key] !== 1) {
			throw new Error(`${ALLOWLIST}: ${seen[key]} \`${key}:\` line(s) to rewrite, expected exactly 1 — the generator and the parser disagree about this file.`);
		}
	}
	for (let i = 0; i < after.length; i++) {
		if (after[i] === before[i]) continue;
		if (!LEDGER_LINE.test(before[i]) || !LEDGER_LINE.test(after[i])) {
			throw new Error(`${ALLOWLIST}:${i + 1}: \`--write\` changed a line that is not a ledger counter (\`${before[i]}\` → \`${after[i]}\`). It rewrites two lines and nothing else.`);
		}
	}
	const out = after.join("\n");
	return { text: out, want, have, stale: out !== text };
}

// ── the check ─────────────────────────────────────────────────────────────────────────────────

/**
 * @param {(p: string) => string} readFile
 * @param {(dir: string) => string[]} listDir
 * @returns {{problems: string[], census: Map<string, number>, perRule: Map<string, number>, allowed: number, entries: number, decisions: number, debt: number}}
 */
export function check(readFile, listDir) {
	/** @type {string[]} */
	const problems = [];
	/** @type {Map<string, number>} */
	const empty = new Map();

	/** @type {{baseline: number, debt: number, entries: Entry[], floors: Floor[]}} */
	let list;
	try {
		list = parseAllowlist(readFile(ALLOWLIST));
	} catch (err) {
		return { problems: [String(err instanceof Error ? err.message : err)], census: empty, perRule: empty, allowed: 0, entries: 0, decisions: 0, debt: 0 };
	}

	// Structure before scanning: a matcher naming a scope that is not in SCOPES would otherwise
	// die inside `filesFor` and surface as an unreadable-tree error, pointing the reader at the
	// filesystem instead of at the typo three lines above.
	for (const rule of RULES) {
		if (rule.matchers.length === 0) problems.push(`the \`${rule.id}\` rule has no matchers, so it can never find anything.`);
		for (const matcher of rule.matchers) {
			if (!(matcher.scope in SCOPES)) {
				problems.push(
					`the \`${rule.id}\` rule has a matcher scoped to \`${matcher.scope}\`, which is not one of ` +
						`${Object.keys(SCOPES).join(", ")}. It would look at nothing.`,
				);
			}
			// The positive control below is `re.test(probe)` and `!re.test(antiProbe)`. A MISSING
			// antiProbe passes that silently — `test(undefined)` matches almost nothing — so the
			// widening half of the control would be absent and read exactly like a control that
			// held. The probe half fails loudly if it is missing; this makes both halves loud.
			for (const half of ["probe", "antiProbe"]) {
				if (typeof matcher[half] !== "string" || matcher[half] === "") {
					problems.push(
						`the \`${rule.id}\` matcher ${matcher.re} declares no \`${half}\`. Every matcher carries ` +
							"both, because they are the only control that outlives the drift: once the ledgers " +
							"reach 0 there is nothing else left to notice a matcher that has stopped matching.",
					);
				}
			}
		}
	}
	if (problems.length > 0) return { problems, census: empty, perRule: empty, allowed: 0, entries: list.entries.length, decisions: 0, debt: 0 };

	/** @type {{findings: Finding[], census: Map<string, number>, perRule: Map<string, number>, unterminated: Set<string>, skipped: Map<string, number>}} */
	let scanned;
	try {
		scanned = scan(readFile, listDir);
	} catch (err) {
		// A directory this check could not read is not a directory with nothing in it. Letting the
		// lister throw and reporting it here is the whole point — swallowing it dropped the
		// subtree from the scan and still printed a pass.
		return {
			problems: [`could not read the console tree: ${String(err instanceof Error ? err.message : err)}. This check has not seen every file, so it cannot report a pass.`],
			census: empty,
			perRule: empty,
			allowed: 0,
			entries: list.entries.length,
		};
	}
	const { findings, census, perRule } = scanned;

	// A file whose block comment never closed had everything after it blanked, so this check did
	// NOT read it. Same class as a dead root, and no allowlist entry can grant an exception to it.
	for (const file of scanned.unterminated) {
		problems.push(
			`${file}:1: opens a block comment that is never closed. Everything after it was blanked ` +
				"before matching, so this check has NOT read the rest of the file — close the comment " +
				"rather than trusting the green.",
		);
	}

	// VACUITY. "Found nothing" and "looked at nothing" must never share an exit code, and the unit
	// that can die is a ROOT or an EXTENSION, not a rule: with `app` dropped from the format rule's
	// roots the earlier per-rule check still saw 364 files from `components` and exited 0, having
	// read none of the 299 route files the drift table was written about. So both axes are
	// asserted, per scope.
	//
	// Not every (root, extension) PAIR can carry a floor — `apps/console/hooks` holds no `.tsx`
	// today and a floor there would be a check that fails for being true. Asserting each axis
	// separately is what a moved root or a one-character edit to `exts` actually trips.
	/** @type {Map<string, Map<string, number>>} */
	const byScope = new Map();
	for (const [key, n] of census) {
		const [scopeId, root, ext] = key.split(SEP);
		if (!byScope.has(scopeId)) byScope.set(scopeId, new Map());
		const m = byScope.get(scopeId);
		m.set(`root ${root}`, (m.get(`root ${root}`) ?? 0) + n);
		m.set(`ext ${ext}`, (m.get(`ext ${ext}`) ?? 0) + n);
	}
	for (const [scopeId, axes] of byScope) {
		for (const [axis, n] of axes) {
			if (n > 0) continue;
			problems.push(
				`the \`${scopeId}\` scope examined ZERO files for \`${axis}\`. That is not a pass — the ` +
					"root moved, the extension list was edited, or the walker broke. Fix this check rather " +
					"than trusting the green.",
			);
		}
	}

	// AN EXCLUSION THAT EXCLUDES NOTHING. A scope's `exclude` is the one declaration that makes the
	// guard read LESS, so it is the one that must justify itself on every run: a renamed or deleted
	// directory leaves the prefix in place, still reading as a live rule, and the next person to
	// widen it has no way to tell a rule that is working from one that stopped. Reported rather
	// than repaired, because which of the two it is is a decision.
	for (const [key, n] of scanned.skipped) {
		if (n > 0) continue;
		const [scopeId, prefix] = key.split(SEP);
		problems.push(
			`the \`${scopeId}\` scope excludes \`${prefix}\`, which matched NOTHING. Either the path moved — ` +
				"fix the exclusion — or it is dead and should be deleted. An exclusion nobody can see the " +
				"effect of is indistinguishable from one that has quietly stopped working.",
		);
	}

	// THE CENSUS FLOOR, and the reason it exists on top of the two axes above. Those axes are
	// built FROM the roots list, so a root DELETED from the declaration has no census row to be
	// zero — verified: reducing `console_code` to three roots left the check printing `✓` over 299
	// unread files in `apps/console/app`, which is the defect this guard was reviewed for. A
	// checked-in floor is the only control that sees an edit to the declaration itself, because
	// the declaration is the thing being edited.
	//
	// It ratchets the opposite way to `baseline`: files only grow, so this number may be RAISED
	// freely and a DROP is what review stops. The floors sit a few percent under the real count so
	// an ordinary refactor does not have to touch them; deleting that much of the console should
	// be looked at.
	/** @type {Map<string, number>} */
	const perScope = new Map();
	for (const [key, n] of census) {
		const [scopeId] = key.split(SEP);
		perScope.set(scopeId, (perScope.get(scopeId) ?? 0) + n);
	}
	const declared = new Set(list.floors.map((f) => f.scope));
	for (const scopeId of Object.keys(SCOPES)) {
		if (!declared.has(scopeId)) {
			problems.push(`${ALLOWLIST}: the \`scanned:\` section has no floor for the \`${scopeId}\` scope, so nothing would notice its roots being narrowed.`);
		}
	}
	for (const f of list.floors) {
		if (!(f.scope in SCOPES)) {
			problems.push(`${ALLOWLIST}:${f.line}: a floor for \`${f.scope}\`, which is not a scope. The scopes are ${Object.keys(SCOPES).join(", ")}.`);
			continue;
		}
		const seen = perScope.get(f.scope) ?? 0;
		if (seen < f.floor) {
			problems.push(
				`${ALLOWLIST}:${f.line}: the \`${f.scope}\` scope examined ${seen} file(s) against a floor of ` +
					`${f.floor}. Either a root was narrowed or renamed — fix the scope — or the console really ` +
					"did lose that many files, in which case lower the floor in the same commit and say why.",
			);
		}
	}
	// THE PERMANENT POSITIVE CONTROL. Every matcher is fired at a line it MUST hit and a line it
	// must NOT, on every run. The alternative — "the allowlist proves the matchers still match" —
	// is a control that expires: the day the last exception is fixed and `baseline` reaches 0, a
	// matcher that has quietly stopped matching would report a clean console instead.
	for (const rule of RULES) {
		for (const matcher of rule.matchers) {
			matcher.re.lastIndex = 0;
			if (!matcher.re.test(matcher.probe)) {
				problems.push(`the \`${rule.id}\` matcher ${matcher.re} no longer matches its own probe \`${matcher.probe}\` — it is dead, and a green run means nothing.`);
			}
			matcher.re.lastIndex = 0;
			if (matcher.re.test(matcher.antiProbe)) {
				problems.push(`the \`${rule.id}\` matcher ${matcher.re} has widened onto \`${matcher.antiProbe}\`, which is correct code — it will report drift that is not there.`);
			}
			matcher.re.lastIndex = 0;
		}
	}
	if (problems.length > 0) return { problems, census, perRule, allowed: 0, entries: list.entries.length, decisions: 0, debt: 0 };

	// Both ledgers are shrink-only, and each is checked in BOTH directions: growing is the drift
	// coming back, and shrinking without lowering the number leaves headroom nobody decided to
	// grant — the same reason the coverage floors are a checked-in file rather than a high-water
	// mark computed at run time. They are counted SEPARATELY so that neither can be spent as the
	// other: converting a debt row into a "decision" would otherwise be free, and that conversion
	// is exactly how a drift census turns back into a mute button.
	//
	// Since #3788 the committed integers are DERIVED — `pnpm gen:shared-surface` writes them from
	// these same counts — so the two directions below are no longer arithmetic the reader has to
	// redo; they name the command. The shrink-only property is untouched by that and still lives
	// where it always did: in REVIEW, on a diff in which the number goes UP. A generator that can
	// only report what the rows say cannot grant headroom, and it never removes a row.
	const counts = ledgerCounts(list);
	const ledgers = [
		{
			key: "baseline",
			want: list.baseline,
			have: counts.baseline,
			noun: "recorded decision(s)",
			fix: "Fix the site to use the shared component instead of adding an exception.",
		},
		{
			key: "debt",
			want: list.debt,
			have: counts.debt,
			noun: "file(s) of measured drift",
			fix: "New drift is not debt — debt is what was measured when the rule landed. Fix the site.",
		},
	];
	for (const l of ledgers) {
		if (l.have > l.want) {
			problems.push(
				`${ALLOWLIST} has ${l.have} ${l.noun} against a \`${l.key}:\` of ${l.want}. This ledger only shrinks. ${l.fix} ` +
					`If the row really belongs there, \`pnpm gen:shared-surface\` writes the number — and a \`${l.key}:\` that goes UP is what review stops.`,
			);
		} else if (l.have < l.want) {
			problems.push(
				`${ALLOWLIST} is down to ${l.have} ${l.noun} from a \`${l.key}:\` of ${l.want} — a win. ` +
					`Run \`pnpm gen:shared-surface\`, which lowers \`${l.key}:\` to ${l.have}, and commit it so the win cannot be spent again.`,
			);
		}
	}

	// Every entry must still MATCH. This is the shrink-only half AND the positive control: the
	// allowlist guarantees a known number of live matches, so a matcher that quietly stops
	// matching reds here instead of reporting a clean tree.
	/** @type {Map<string, Finding[]>} */
	const byKey = new Map();
	for (const f of findings) {
		const key = `${f.rule}${SEP}${f.file}`;
		if (!byKey.has(key)) byKey.set(key, []);
		byKey.get(key).push(f);
	}
	let allowed = 0;
	/** @type {Set<string>} */
	const claimed = new Set();
	for (const entry of list.entries) {
		const key = `${entry.section}${SEP}${entry.path}`;
		claimed.add(key);
		const hits = byKey.get(key) ?? [];
		if (hits.length === entry.hits) {
			allowed += hits.length;
			continue;
		}
		// The recorded decision is printed with the failure, which is the only thing that makes
		// the allowlist's promise ("the guard prints it to anyone who trips over it") true — and
		// the reason is what tells the reader whether their new occurrence is the same case.
		const recorded =
			entry.kind === "debt"
				? `\n  The recorded DEBT for this file: ${entry.note}`
				: `\n  The recorded decision for this file: ${entry.note}`;
		if (hits.length === 0) {
			problems.push(
				`${ALLOWLIST}:${entry.line}: the \`${entry.section}\` entry for ${entry.path} matches nothing. ` +
					"Either the file was fixed or renamed — delete the entry and lower `baseline` — or this " +
					"rule has stopped matching, which is worse." +
					recorded,
			);
			continue;
		}
		problems.push(
			`${ALLOWLIST}:${entry.line}: the \`${entry.section}\` entry for ${entry.path} declares ${entry.hits} ` +
				`hit(s) and there are ${hits.length} (line${hits.length > 1 ? "s" : ""} ` +
				`${hits.map((h) => h.line).join(", ")}). An exception is granted per occurrence, not per file: ` +
				"a new one is new drift, and a removed one is a win to record by lowering `hits`." +
				recorded,
		);
		allowed += Math.min(hits.length, entry.hits);
	}

	for (const f of findings) {
		if (claimed.has(`${f.rule}${SEP}${f.file}`)) continue;
		const rule = RULES.find((r) => r.id === f.rule);
		problems.push(
			`${f.file}:${f.line}: \`${f.text.trim()}\` — this ${f.say}\n` +
				`  CLAUDE.md §6 requires ${rule.surface} here. If this site is genuinely different, add it to ` +
				`${ALLOWLIST} with a one-line reason in the product's voice — never to make the guard pass.`,
		);
	}

	return {
		problems,
		census,
		perRule,
		allowed,
		entries: list.entries.length,
		decisions: list.entries.filter((e) => e.kind === "decision").length,
		debt: list.entries.filter((e) => e.kind === "debt").length,
	};
}

// ── self-test ─────────────────────────────────────────────────────────────────────────────────

/**
 * A fake tree. Directories are keys ending in `/`; files map to their contents. `listDir` returns
 * [] for a file, which is how `filesFor` tells the two apart.
 *
 * @param {Record<string, string>} files
 * @returns {{readFile: (p: string) => string, listDir: (d: string) => string[]}}
 */
function fakeTree(files) {
	/** @param {string} dir */
	const listDir = (dir) => {
		/** @type {Set<string>} */
		const kids = new Set();
		for (const p of Object.keys(files)) {
			if (!p.startsWith(`${dir}/`)) continue;
			kids.add(p.slice(dir.length + 1).split("/")[0]);
		}
		return [...kids];
	};
	return { readFile: (p) => files[p] ?? "", listDir };
}

/**
 * The minimum well-formed allowlist, so a fixture can opt out of the vacuity failure. The floors
 * are GENERATED from `SCOPES` rather than typed: a hand-written list here would have to be edited
 * every time a scope is added, and the edit everyone forgets is the one that makes a fixture pass
 * for the wrong reason.
 */
const EMPTY_LIST = `baseline: 0\ndebt: 0\n\nscanned:\n${Object.keys(SCOPES)
	.map((id) => `  - scope: ${id}\n    floor: 0\n`)
	.join("")}`;

/** `EMPTY_LIST` with one scope's floor raised, for the fixtures that must trip it. */
function listWithFloor(scopeId, floor) {
	return `baseline: 0\ndebt: 0\n\nscanned:\n${Object.keys(SCOPES)
		.map((id) => `  - scope: ${id}\n    floor: ${id === scopeId ? floor : 0}\n`)
		.join("")}`;
}

/**
 * One file per (root, extension) pair every scope declares, plus one under every `exclude` prefix,
 * so a fixture is testing the CLASSIFIER and never accidentally tripping a vacuity check. Each is
 * inert — no matcher can fire on it.
 *
 * The excluded files are ballast in the same sense the others are, and for a sharper reason: the
 * stale-exclusion control fails when an `exclude` matches nothing, so without them EVERY fixture
 * would carry that failure and the self-test would be reading it as the result of whatever it was
 * actually testing.
 *
 * @returns {Record<string, string>}
 */
function ballast() {
	/** @type {Record<string, string>} */
	const files = {};
	let i = 0;
	for (const scope of Object.values(SCOPES)) {
		for (const root of scope.roots) {
			for (const ext of scope.exts) {
				files[`${root}/ballast${i++}${ext}`] = "export const inert = 1;";
			}
		}
		for (const skip of scope.exclude ?? []) {
			for (const ext of scope.exts) {
				files[`${skip}/ballast${i++}${ext}`] = "export const inert = 1;";
			}
		}
	}
	return files;
}

function selfTest() {
	let fails = 0;
	/** @param {string} name @param {boolean} cond @param {string} detail */
	const ok = (name, cond, detail = "") => {
		if (cond) console.log(`ok   - ${name}`);
		else {
			console.error(`FAIL - ${name} ${detail}`);
			fails++;
		}
	};
	/** Run `check` over a fake tree, with the allowlist supplied as one more file. */
	const run = (files, allowlist = EMPTY_LIST) => {
		const { readFile, listDir } = fakeTree({ ...files, [ALLOWLIST]: allowlist });
		return check(readFile, listDir);
	};
	/** @param {{problems: string[]}} r @param {RegExp} re */
	const says = (r, re) => r.problems.some((p) => re.test(p));

	// ── the classifier, proved by varying the CONTENT at ONE path ────────────────────────────
	// Same file name every time, so a green can never come from the path having escaped a scope,
	// and the ballast keeps every root and extension non-empty so vacuity never masquerades as a
	// classifier result.
	const AT = "apps/console/components/x/probe.tsx";
	const flags = (body, allowlist = EMPTY_LIST) => run({ ...ballast(), [AT]: body }, allowlist).problems.length > 0;

	ok("a live toFixed is flagged", flags("const s = `$${x.toFixed(2)}/mo`;"));
	ok("...and the SAME token in a line comment is not", !flags("// x.toFixed(2) — was the drift"));
	ok("...nor in a JSDoc block", !flags("/**\n * Renders `x.toFixed(2)` today.\n */\nexport const a = 1;"));
	ok("...nor in a JSX comment", !flags("const a = <p>{/* x.toFixed(2) */}ok</p>;"));
	ok("a block comment CLOSING mid-line does not blank the code after it", flags("/* note */ const s = x.toFixed(1);"));
	ok("a bare identifier called toFixed is not a member call", !flags("const toFixed = 1;"));

	ok("toLocaleDateString is flagged", flags("const d = new Date(v).toLocaleDateString();"));
	ok("toLocaleTimeString is flagged", flags("const t = new Date(v).toLocaleTimeString();"));
	// The one that separates the rows: a bare toLocaleString on a COUNT is correct and common.
	ok("a bare toLocaleString is NOT flagged (it is how a count gets separators)", !flags("const n = c.toLocaleString();"));

	// The fourth money spelling: a hand-written currency symbol in front of an interpolation.
	ok("a hand-written `$` before an interpolation is flagged", flags("const s = `$${n.toLocaleString()}`;"));
	ok("...and an interpolation with no symbol is not", !flags("const s = `${n} credits`;"));
	ok("...nor a dollar in prose", !flags("const s = `costs $12 a month`;"));

	// The byte rule's whole point is the OPERATOR, not the number.
	ok("dividing by 1024 is flagged", flags("const mb = bytes / 1024;"));
	ok("...including the parenthesised MiB form", flags("const mb = bytes / (1024 * 1024);"));
	// THE WRAPPED FORM. Prettier and Biome break a binary expression AFTER the operator, so this
	// is one `pnpm format` away from the line above; a per-line matcher read it as clean.
	ok("...and the form a formatter wraps onto the next line", flags("export const mb =\n\tbytes /\n\t1024;"));
	ok("MULTIPLYING by 1024 to declare a limit is not", !flags("const MAX = 10 * 1024 * 1024;"));
	ok("a plain 1024 is not", !flags("const opts = { max: 1024 };"));

	ok("a raw h1 is flagged", flags('const a = <h1 className="text-2xl">Clusters</h1>;'));
	ok("a self-closing h1 is flagged", flags("const a = <h1 />;"));
	ok("...and one whose attributes are on the NEXT line, which matching-per-line nearly missed", flags("const a = (\n\t<h1\n\t\tclassName={cn(x)}\n\t>t</h1>\n);"));
	ok("...including one that ends the file, where the window has no next line", flags("const a = <h1"));
	ok("...but h10 is a different tag", !flags("const a = <h10>x</h10>;"));
	ok("...and a component whose name merely contains h1 is not", !flags("const a = <Ch1ldTitle>x</Ch1ldTitle>;"));
	// THE DIRECTION OF THIS RULE INVERTED IN #3733. It used to close with "PageHeader is the fix, so
	// it is not itself a finding". There is no longer a component that puts a title on a console
	// page — the fix is deletion — and what survives, `PageToolbar`, has no `title` prop at all, so
	// the shape that used to be the answer cannot be written any more. What the guard still owes the
	// reader is that the SURVIVING primitives are not findings.
	ok("PageToolbar is not a finding — it carries the count and the actions, and no heading", !flags('const a = <PageToolbar count={3} actions={btn} />;'));
	ok("...and neither is SectionHeading, which is a heading INSIDE a page", !flags('const a = <SectionHeading title="Usage" level={2} />;'));

	// ── section headings: the tag, never the class name ──────────────────────────────────────
	// The old header declined this row because "a class-name match cannot tell a section heading
	// from a bold label". These fixtures are the answer: the matcher never reads the class, and the
	// same words in a <span> wearing the identical classes are NOT a finding.
	// `text-ui-lg`, not the `text-[15px]` these fixtures used to wear: an arbitrary pixel size is
	// now a finding under `type_scale`, so the span below would have "passed" on the wrong matcher
	// and the h2 above would have proved nothing about `<h2` at all.
	ok("a raw h2 is flagged", flags('const a = <h2 className="text-ui-lg font-semibold">Usage</h2>;'));
	ok("a raw h3 is flagged", flags('const a = <h3 className="text-sm font-semibold">Members</h3>;'));
	ok("...whatever type scale it is wearing", flags('const a = <h2 className="text-2xl">Browse by topic</h2>;'));
	ok("...and a self-closing one, and one whose attributes are on the next line", flags("const a = <h2 />;") && flags("const a = (\n\t<h3\n\t\tclassName={cn(x)}\n\t>t</h3>\n);"));
	ok("...but the same words in a span with the same classes are not", !flags('const a = <span className="text-ui-lg font-semibold">Usage</span>;'));
	ok("...and h20/h30 are different tags", !flags("const a = <h20>x</h20>;") && !flags("const a = <h30>x</h30>;"));
	// THE OUTLINE DOES NOT STOP AT h3. A rule that did would hand out an escape hatch that makes
	// the defect worse: demote the flagged <h3> to <h4> and the guard goes quiet while the document
	// outline gets strictly worse. h4, h5 and h6 are all findings for that reason.
	ok("h4, h5 and h6 are findings too", flags('const a = <h4 className="text-xs">Inputs</h4>;') && flags("const a = <h5 />;") && flags("const a = <h6 />;"));
	ok("...so a flagged h3 cannot be silenced by demoting it", flags("const a = <h4>Inputs</h4>;"));
	ok("...but h40 is still a different tag, and h7 is not a heading", !flags("const a = <h40>x</h40>;") && !flags("const a = <h7>x</h7>;"));

	// ── the type scale: a hardcoded SIZE, in any unit and behind any variant ─────────────────
	// The largest census in this file, and the only rule about a VALUE rather than a component.
	ok("a hardcoded pixel font size is flagged", flags('const a = <p className="text-[13px]">x</p>;'));
	ok("...including the half-pixel values, which the census counts alongside the whole-pixel ones", flags('const a = <p className="text-[12.5px]">x</p>;') && flags('const a = <p className="text-[11.5px]">x</p>;'));
	// THE VARIANT PREFIX. `layer_token` shipped for a year with a lookbehind that excluded `:`, so
	// `md:z-50` read as clean and the rule taught its own evasion. This one is written to admit
	// every prefix, and these three are how that is proved rather than asserted.
	ok("...behind a breakpoint, a state, and a data-attribute variant", flags('const a = <p className="md:text-[13px]" />;') && flags('const a = <p className="hover:text-[11px]" />;') && flags('const a = <p className="data-[state=open]:text-[13px]" />;'));
	// THE UNIT ALTERNATION, and why it is wider than the tree. There is not one rem/em/pt font size
	// in the console today. If the matcher stopped at px, a flagged `text-[13px]` rewritten as
	// `text-[0.8125rem]` would render identically and drop the file's `hits` to zero — which reds as
	// "matches nothing" and invites lowering `debt:` for a fix that never happened. That is the
	// same perverse escape the empty-state padding cap used to hand out.
	ok("...and a px size cannot be silenced by rewriting it in another unit", flags('const a = <p className="text-[0.8125rem]" />;') && flags('const a = <p className="text-[1em]" />;') && flags('const a = <p className="text-[11pt]" />;') && flags('const a = <p className="text-[80%]" />;'));
	// Tailwind's own disambiguating prefix is a spelling of the identical class.
	ok("...nor by writing Tailwind's `length:` prefix in front of it", flags('const a = <p className="text-[length:13px]" />;'));
	// THE ARBITRARY-PROPERTY SPELLING — the widest escape, and the one the unit alternation above
	// does not reach: `[font-size:13px]` compiles to the identical declaration, takes every variant
	// prefix, and is eleven characters from any flagged site. Zero live sites, so the probe and
	// these fixtures are the only things holding it.
	ok("...nor by writing it as an arbitrary PROPERTY, which compiles identically", flags('const a = <p className="[font-size:13px]" />;'));
	ok("...in any unit, and behind a variant, exactly like the utility spelling", flags('const a = <p className="[font-size:0.8125rem]" />;') && flags('const a = <p className="md:[font-size:12.5px]" />;') && flags('const a = <p className="[font-size:length:13px]" />;'));
	ok("...but an arbitrary property that is not a size is how a file reaches CSS Tailwind has no utility for", !flags('const a = <p className="[mask-image:linear-gradient(90deg,#000,transparent)]" />;') && !flags('const a = <p className="[grid-template-columns:repeat(3,minmax(0,1fr))]" />;'));
	ok("...and neither is a font-size read from the token", !flags('const a = <p className="[font-size:var(--text-ui-md)]" />;'));
	// THE FIX, in both of its spellings. A matcher that reported its own answer would be unfixable.
	ok("a rung utility is the fix and is not a finding", !flags('const a = <p className="text-ui-md text-text-tertiary">x</p>;'));
	ok("...and neither is the token read as a var", !flags('const a = <p className="text-[var(--text-ui-lg)]" />;'));
	// The `text-[…]` bracket is overloaded: a COLOUR is written the same way and is not a size.
	ok("an arbitrary text COLOUR is not a font size", !flags('const a = <p className="text-[#0a0a0a]" />;') && !flags('const a = <p className="text-[color:var(--text-primary)]" />;') && !flags('const a = <p className="text-[oklch(0.2_0_0)]" />;'));
	// The value has to be a SIZE on the TEXT utility. An arbitrary length on any other utility is a
	// geometry, and the type scale is not the answer to a geometry.
	ok("...and an arbitrary length on another utility is not one either", !flags('const a = <div className="max-w-[380px] leading-[13px] size-[11px]" />;'));
	// The scope reaches lib/ and hooks/, unlike the byte-division matcher one rule over. Same
	// content, different path — the only way to prove a scope.
	ok("a hardcoded size under lib/ IS in scope — a class list is one wherever it lives", run({ ...ballast(), "apps/console/lib/x/a.ts": 'export const C = "text-[13px]";' }).problems.length > 0);

	// ── the empty state: the PADDING is the discriminator ────────────────────────────────────
	ok("a centred block with generous vertical padding is flagged", flags('const a = <div className="px-4 py-16 text-center">No runners yet</div>;'));
	ok("...at any of the six heights it is written at", flags('const a = <p className="px-3 py-6 text-center">none</p>;') && flags('const a = <div className="py-12 text-center">none</div>;'));
	// EVERY DELIMITER, because a class list is written three ways in this console and anchoring on
	// `"` made the census mean "the double-quoted ones". A template literal is the normal way to
	// write a conditional class list — 17 files already do.
	ok("...in a template literal", flags("const a = <div className={`px-4 py-16 text-center ${x}`}>none</div>;"));
	ok("...and in single quotes", flags("const a = <div className={cn('px-4 py-16 text-center')}>none</div>;"));
	// NO UPPER BOUND. `py-16` was the measured maximum, not the boundary the rule is about — and a
	// cap there means a recorded debt row can be silenced by making the drift BIGGER.
	ok("...at py-20, py-24 and py-32, which the measured cap used to let through", flags('const a = <div className="py-20 text-center" />;') && flags('const a = <div className="py-24 text-center" />;') && flags('const a = <div className="py-32 text-center" />;'));
	ok("...but a centred TABLE CELL is not — py-2.5 is not standing in for content", !flags('const a = <td className="px-3 py-2.5 text-center">{v}</td>;'));
	ok("...and py-1.5 is not either, so the two-digit rung did not reach down into the fractions", !flags('const a = <div className="py-1.5 text-center" />;'));
	// THE LOOKAHEADS MAY NOT LEAVE THE STRING. `(?:(?!\1)[^\n])*` is what stops the scan at the
	// closing delimiter; without it, two ADJACENT attributes each holding one half of the pair get
	// married into one match. That is the load-bearing half of the delimiter work — the closing
	// backreference only decides how much text a finding prints — so it is what these assert.
	ok("...and one attribute's padding does not marry the NEXT attribute's centring", !flags('const a = <div className="px-4 py-16" title="text-center" />;'));
	ok("...nor across a template literal and the quoted attribute beside it", !flags("const a = <div className={`py-16 x`} title=\"text-center\" />;"));
	ok("...and the same for the grid matcher's two halves", !flags('const a = <div className="grid grid-cols-[2fr_1fr]" title="uppercase" />;'));
	ok("...nor a centred label with no vertical padding at all", !flags('const a = <div className="text-center text-xs">{label}</div>;'));
	ok("...nor generous padding without the centring", !flags('const a = <div className="px-4 py-16">{rows}</div>;'));
	// A JS string cannot hold a raw newline, so a `"` … `"` spanning one is two unrelated strings.
	ok(
		"...and the two halves may not be assembled out of two different strings on two lines",
		!flags('const a = <div className="text-center" data-x="py-16" />;\nconst b = "py-16";'),
	);

	// ── the stat strip: the container AND the primitive ──────────────────────────────────────
	ok("a <Stat cell is flagged", flags('const a = (\n<div className="grid grid-cols-4">\n<Stat label="Jobs" value={n} />\n</div>\n);'));
	ok("...including when the cell's props wrap onto the following lines", flags('const a = (\n<div className="grid grid-cols-2">\n<Stat\n\tlabel="Jobs"\n/>\n</div>\n);'));
	// THE TWO SHAPES THE CONTAINER MATCH MISSED. The formatter's own wrap of a long container is
	// three lines, and the console's Card primitive is not in any `div|section|dl` alternation.
	ok("...and when the CONTAINER is the thing the formatter wrapped, over three lines", flags('const a = (\n<div\n\tclassName="grid grid-cols-4 gap-4 border-b border-border px-5 py-3"\n>\n\t<Stat label="Jobs" value={n} />\n</div>\n);'));
	ok("...and inside a Card, which §6's unqualified ban covers just as well", flags('const a = (\n<Card className="grid grid-cols-4">\n<Stat label="Jobs" value={n} />\n</Card>\n);'));
	ok("...and the Stat primitive itself, so the fix cannot be one import away", flags("function Stat({ label, value }) {\n\treturn null;\n}"));
	ok("...but StatusBadge is a different component", !flags('const a = (\n<div className="grid grid-cols-4">\n<StatusBadge tone="ok" />\n</div>\n);'));
	ok("...and StatusDot is a different function", !flags("function StatusDot({ status }) {\n\treturn null;\n}"));

	// ── the layer scale: 40..99 is the gap, 10/20/30 are rungs ───────────────────────────────
	ok("a bare z-50 is flagged", flags('const a = <div className="absolute z-50 bg-popover" />;'));
	ok("...and a bare z-40, which is the same empty gap", flags('const a = <div className="fixed z-40" />;'));
	ok("...and an arbitrary numeric value", flags('const a = <div className="z-[95]" />;'));
	// EVERY VARIANT PREFIX. The lookbehind used to exclude `:`, which excluded these with it — and
	// `data-[state=open]:z-50` is how a Radix/base-ui popover picks its level, i.e. the common case
	// AND the shape a "fix" takes when someone reds on the bare form.
	ok("...behind a responsive prefix", flags('const a = <div className="fixed md:z-50" />;'));
	ok("...behind a state prefix", flags('const a = <div className="absolute hover:z-40" />;'));
	ok("...and behind a data-attribute prefix, which is how a popover picks its level", flags('const a = <div className="data-[state=open]:z-50" />;'));
	ok("...but z-10/z-20/z-30 are the scale's own in-flow rungs, unnamed rather than invented", !flags('const a = <div className="relative z-10" />;') && !flags('const a = <div className="z-30" />;'));
	ok("...and the token form is the FIX, so it is never a finding", !flags('const a = <div className="z-[var(--z-overlay)]" />;'));
	ok("...nor is the token's own name where it is declared", !flags("const css = `--z-overlay: 200;`;"));

	// ── grid-as-table: the SHAPE test the old header asked for ───────────────────────────────
	ok("an uppercase header row over a bracketed column template is flagged", flags('const a = <div className="grid grid-cols-[2fr_1fr_auto] uppercase tracking-[0.1em]" />;'));
	ok("...and a hoverable data row on the same template", flags('const a = <div className="grid grid-cols-[2fr_1fr_auto] hover:bg-muted/30" />;'));
	ok("...and the same row written as a template literal", flags("const a = <div className={`grid grid-cols-[2fr_1fr_auto] hover:bg-muted/30 ${x}`} />;"));
	// THE ONE THAT SEPARATES A LAYOUT FROM A TABLE. A table's columns are the same at every width.
	ok(
		"...but the identical class list behind a BREAKPOINT is a page layout, not a table",
		!flags('const a = <div className="grid grid-cols-1 gap-4 lg:grid-cols-[280px_1fr] hover:bg-muted/30" />;'),
	);
	ok("...and a bracketed template with no row marker is a label/value pair", !flags('const a = <div className="grid grid-cols-[8rem_1fr] gap-y-1.5" />;'));
	ok("...and an N-up card grid is not a table", !flags('const a = <div className="grid grid-cols-3 gap-4 hover:bg-muted/30" />;'));
	ok("a raw <table> is flagged", flags('const a = <table className="w-full">{rows}</table>;'));
	ok("...but @repo/ui/table's <Table> is the fix", !flags("const a = <Table>{rows}</Table>;"));

	// ── money that never writes its own `$` ──────────────────────────────────────────────────
	ok("an interpolation glued directly onto a formatted number is flagged", flags('const s = `${symbol}${n.toLocaleString("en-US")}`;'));
	// THE AXIS THAT MATTERS. Adjacency alone is ~48 sites in this console — an id glued to a
	// suffix, a prefix glued to a path — so the second half having to FORMAT A NUMBER is the whole
	// matcher, and it is what a widening has to be caught on.
	ok("...but two adjacent interpolations that format nothing are an identifier, not a price", !flags("const s = `${context.resource_type}${suffix}`;"));
	ok("...and two values with words between them are a sentence", !flags("const s = `${used} / ${limit.toLocaleString()}`;"));
	ok("...and a bare toLocaleString is still how a count gets separators", !flags("const s = `${n.toLocaleString()} jobs`;"));
	// `<Amount` throughout: `<Stat` is a finding under the stat-strip rule, so a fixture built on
	// it would flag whatever this matcher did, and the negative case would fail for the wrong
	// reason — which is exactly how it first failed when the strip rule moved onto the cell.
	ok("a currency symbol handed over as a prop is flagged", flags('const a = <Amount value={12} prefix="$" />;'));
	ok("...in any currency", flags('const a = <Amount value={12} prefix="€" />;'));
	ok("...but a prop that is not a currency symbol is not", !flags('const a = <Amount value={12} prefix="~" />;'));

	// One occurrence is reported once, not once per window it appears in.
	const twice = run({ ...ballast(), [AT]: "const a = 1;\nconst s = x.toFixed(2);\nconst b = 2;" });
	ok("a match on a middle line is reported exactly once", twice.problems.length === 1, JSON.stringify(twice.problems));

	// ── the comment stripper's two report-green shapes ───────────────────────────────────────
	// Both used to blank live code and print a pass.
	// The trailing line closes the latch, so this fixture cannot be rescued by the
	// unterminated-block refusal below — without the quote test the drift on line 2 is swallowed
	// and the run prints a pass, which is the shape that reports green on unread code.
	ok(
		"a `{/*` INSIDE a string does not latch the block state over the code after it",
		flags('export const g = "a{/*}b";\nexport const s = n.toFixed(2);\nexport const h = "c*/d";'),
	);
	const unterminated = run({ ...ballast(), [AT]: "/* oops\nexport const s = n.toFixed(2);" });
	ok(
		"an unterminated block comment REFUSES the file rather than blanking the rest of it",
		says(unterminated, /never closed/),
		JSON.stringify(unterminated.problems),
	);

	// ── scope, proved the same way: identical content, different path ────────────────────────
	const H1 = 'const a = <h1 className="x">t</h1>;';
	const at = (p) => ({ ...ballast(), [p]: H1 });
	ok("an h1 under app/(private) is in scope", run(at("apps/console/app/(private)/p/page.tsx")).problems.length > 0);
	const pub = run(at("apps/console/app/(public)/p/page.tsx"));
	ok("...and the identical file under app/(public) is not", pub.problems.length === 0, JSON.stringify(pub.problems));
	// THE FILES THAT SIT IN NEITHER ROUTE GROUP. Rooting at `app/(private)` left these unread by
	// every heading rule, and no vacuity control could see it: `app/(private)` still resolved and
	// its floor still passed.
	ok("an h1 in app/error.tsx — neither (private) nor (public) — is in scope", run(at("apps/console/app/error.tsx")).problems.length > 0);
	ok("...and so is one in app/not-found.tsx", run(at("apps/console/app/not-found.tsx")).problems.length > 0);
	// AN EXCLUSION THAT EXCLUDES NOTHING is the one declaration that makes this guard read LESS, so
	// it has to justify itself on every run. Removing the ballast under it is how a renamed
	// directory would look.
	const staleSkip = (() => {
		const tree = ballast();
		for (const k of Object.keys(tree)) if (k.startsWith("apps/console/app/(public)/")) delete tree[k];
		return run(tree);
	})();
	ok("an `exclude` that matches nothing FAILS rather than sitting there", says(staleSkip, /excludes `apps\/console\/app\/\(public\)`, which matched NOTHING/), JSON.stringify(staleSkip.problems));
	// A prefix match on a SEGMENT boundary: a sibling whose name merely starts with the excluded
	// one must still be read. The name matters and this fixture first got it wrong — `(publicity)`
	// is NOT a prefix extension of `(public)`, because the closing paren breaks it, so the test
	// passed with the segment check deliberately removed and proved nothing. `(public)-archive` is
	// a real one, and it reds the moment `p.startsWith(e)` replaces the boundary test.
	const sibling = run({ ...ballast(), "apps/console/app/(public)-archive/p/page.tsx": H1 });
	ok("...and a sibling directory whose name merely starts with it is still scanned", sibling.problems.length > 0, JSON.stringify(sibling.problems));
	// The scope split INSIDE one rule: money reaches lib/, the byte division does not.
	const money = run({ ...ballast(), "apps/console/lib/x/a.ts": "const s = `$${n}`;" });
	ok("a hand-written money symbol under lib/ is in scope", money.problems.length > 0, JSON.stringify(money.problems));
	const bytes = run({ ...ballast(), "apps/console/lib/x/a.ts": "const gb = mb / 1024;" });
	ok("...but a byte division under lib/ is NOT — that scope is the rendering layer", bytes.problems.length === 0, JSON.stringify(bytes.problems));
	const bytesView = run({ ...ballast(), "apps/console/components/x/a.tsx": "const gb = mb / 1024;" });
	ok("...and the identical division under components/ IS", bytesView.problems.length > 0);

	// ── vacuity: every way this guard can read nothing and look clean ────────────────────────
	const nothing = run({});
	ok("an empty tree FAILS rather than passing", says(nothing, /examined ZERO files/), JSON.stringify(nothing.problems));
	// THE ONE A PER-RULE COUNT MISSED. Every root but one still resolves, so the rule's total is
	// healthy and the old check exited 0 having never opened `apps/console/app`.
	const oneRootGone = { ...ballast() };
	for (const k of Object.keys(oneRootGone)) if (k.startsWith("apps/console/app/")) delete oneRootGone[k];
	const rootGone = run(oneRootGone);
	ok(
		"a single dead ROOT fails even when the rule's other roots are full",
		says(rootGone, /root apps\/console\/app/),
		JSON.stringify(rootGone.problems),
	);
	// The same for an extension: drop every .ts and the .tsx files keep the totals healthy.
	const noTs = { ...ballast() };
	for (const k of Object.keys(noTs)) if (k.endsWith(".ts")) delete noTs[k];
	const tsGone = run(noTs);
	ok("...and a dead EXTENSION does too", says(tsGone, /ext \.ts\b/), JSON.stringify(tsGone.problems));
	// An unreadable directory is not an empty one.
	const unreadable = (() => {
		const { readFile, listDir } = fakeTree({ ...ballast(), [ALLOWLIST]: EMPTY_LIST });
		return check(readFile, (d) => {
			if (d === "apps/console/components") throw new Error("EACCES: permission denied");
			return listDir(d);
		});
	})();
	ok("a directory the walker cannot read FAILS", says(unreadable, /could not read the console tree/), JSON.stringify(unreadable.problems));
	// A matcher pointed at a scope that does not exist looks at nothing. Mutating the live rule
	// is the only way to reach it, and it must NOT surface as an unreadable-tree error.
	const strayScope = (() => {
		const m = RULES[0].matchers[0];
		const real = m.scope;
		m.scope = "console_cod"; // one character short of the real name
		const r = run(ballast());
		m.scope = real;
		return r;
	})();
	ok("a matcher scoped to a name that does not exist FAILS, and says so", says(strayScope, /scoped to `console_cod`/), JSON.stringify(strayScope.problems));

	// THE ONE THE PER-ROOT AXIS CANNOT SEE. The axes are built from the roots list, so deleting a
	// root leaves no row to be zero; only a checked-in census floor notices the declaration itself
	// changing. Mutating SCOPES is the only way to reach it.
	const rootDeleted = (() => {
		const scope = SCOPES.console_code;
		const real = scope.roots;
		// ONE tree, measured before the mutation: a floor guessed from the roots list would be
		// satisfied by the ballast the other scopes leave under the surviving roots, and the
		// fixture would pass without proving anything.
		const tree = ballast();
		let census = 0;
		for (const [key, n] of run(tree, EMPTY_LIST).census) if (key.split(SEP)[0] === "console_code") census += n;
		const list = listWithFloor("console_code", census);
		const atFloor = run(tree, list);
		scope.roots = real.slice(1);
		const narrowed = run(tree, list);
		scope.roots = real;
		return { atFloor, narrowed };
	})();
	ok("a scope exactly at its census floor passes", rootDeleted.atFloor.problems.length === 0, JSON.stringify(rootDeleted.atFloor.problems));
	ok(
		"...and a root DELETED from the scope declaration fails, which no per-root count can see",
		says(rootDeleted.narrowed, /against a floor of/),
		JSON.stringify(rootDeleted.narrowed.problems),
	);
	const noFloor = run(ballast(), "baseline: 0\ndebt: 0\n");
	ok("an allowlist with no census floors fails", says(noFloor, /has no floor for the/), JSON.stringify(noFloor.problems));
	const strayFloor = run(ballast(), EMPTY_LIST + "  - scope: console_nope\n    floor: 0\n");
	ok("...and a floor for a scope that does not exist fails", says(strayFloor, /which is not a scope/), JSON.stringify(strayFloor.problems));

	const noList = run(ballast(), "");
	ok("an allowlist with no baseline fails", says(noList, /no `baseline:`/), JSON.stringify(noList.problems));

	// ── the allowlist reader fails LOUDLY, in both directions ────────────────────────────────
	const parses = (t) => {
		try {
			return parseAllowlist(t);
		} catch (err) {
			return String(err instanceof Error ? err.message : err);
		}
	};
	const good = "baseline: 1\ndebt: 0\n\nformat:\n  - path: apps/console/components/a.tsx\n    hits: 2\n    reason: because.\n";
	/** A rule-section allowlist plus the floors every run requires, so a fixture tests one thing. */
	const withFloors = (t) => t + EMPTY_LIST.slice(EMPTY_LIST.indexOf("scanned:"));
	ok("a well-formed entry parses", typeof parses(good) === "object" && parses(good).entries.length === 1);
	ok("...and carries its hits and its recorded note", parses(good).entries[0].hits === 2 && parses(good).entries[0].note === "because.");
	ok("an unknown section is rejected", /unknown section/.test(String(parses("baseline: 0\nnope:\n"))));
	// An entry with NEITHER field is the shape that used to be caught as "no `reason:`". It has to
	// stay caught now that there are two kinds, because an entry with no kind counts against
	// neither ledger — a free exception, which is the one failure an allowlist must not have.
	ok("an entry with neither reason nor lifts is rejected", /has neither `reason:` nor `lifts:`/.test(String(parses("baseline: 1\ndebt: 0\nformat:\n  - path: a.tsx\n    hits: 1\n"))));
	ok(
		"...and one carrying BOTH is too, because only one of them can count",
		/carries both `reason:` and `lifts:`/.test(String(parses("baseline: 1\ndebt: 0\nformat:\n  - path: a.tsx\n    hits: 1\n    reason: x\n    lifts: \"#1 y\"\n"))),
	);
	// The issue number is what keeps debt visible somewhere that is not this file.
	ok(
		"a `lifts:` that names no board issue is rejected",
		/must be a quoted value naming the board issue/.test(String(parses("baseline: 0\ndebt: 1\nformat:\n  - path: a.tsx\n    hits: 1\n    lifts: \"we will get to it\"\n"))),
	);
	// The quotes carry meaning of their own: unquoted, the `#` reads as a comment everywhere else.
	ok(
		"...and so is an UNQUOTED one, however well it names its issue",
		/must be a quoted value naming the board issue/.test(String(parses("baseline: 0\ndebt: 1\nformat:\n  - path: a.tsx\n    hits: 1\n    lifts: #3613 — the wave lifts this.\n"))),
	);
	ok(
		"...and one that does parses as DEBT, not as a decision",
		(() => {
			const r = parses("baseline: 0\ndebt: 1\nformat:\n  - path: a.tsx\n    hits: 1\n    lifts: \"#3613 — the console-UI conformance wave lifts this.\"\n");
			return typeof r === "object" && r.entries[0].kind === "debt" && r.debt === 1;
		})(),
	);
	ok("an allowlist with no debt ledger fails", /no `debt:`/.test(String(parses("baseline: 0\n"))));
	ok("a missing hits is rejected", /has no `hits:`/.test(String(parses("baseline: 1\nformat:\n  - path: a.tsx\n    reason: x\n"))));
	// A `- scope:` with no `floor:` would otherwise carry the sentinel -1, i.e. a floor nothing
	// can fall below — a census control that reads as configured and is not one.
	ok("a scope with no floor is rejected", /has no `floor:`/.test(String(parses("baseline: 0\nscanned:\n  - scope: console_code\n"))));
	ok("a `floor:` outside a scope entry is rejected", /outside a `- scope:` entry/.test(String(parses("baseline: 0\nscanned:\n    floor: 3\n"))));
	ok("a `- scope:` outside the scanned section is rejected", /belongs to the `scanned:` section/.test(String(parses("baseline: 0\nformat:\n  - scope: console_code\n"))));
	ok("a line it cannot parse is rejected, not skipped", /cannot parse/.test(String(parses("baseline: 0\nformat:\n  - patth: a.tsx\n"))));
	ok("an entry before any section is rejected", /before any section/.test(String(parses("baseline: 0\n  - path: a.tsx\n"))));
	ok("a comment and a blank line are fine", typeof parses("# note\n\nbaseline: 0\ndebt: 0\n") === "object");
	// A duplicate is a second free entry against `baseline`, and only one of its two reasons is
	// the decision anyone recorded.
	ok(
		"the same file twice in one section is rejected",
		/a second `format` entry/.test(String(parses("baseline: 2\ndebt: 0\nformat:\n  - path: a.tsx\n    hits: 1\n    reason: x\n  - path: a.tsx\n    hits: 1\n    reason: y\n"))),
	);

	// ── the ratchet and the positive control ─────────────────────────────────────────────────
	const tree = { ...ballast(), "apps/console/components/a.tsx": "const a = n.toFixed(2);" };
	const entry = (hits, p = "apps/console/components/a.tsx") =>
		withFloors(`baseline: 1\ndebt: 0\n\nformat:\n  - path: ${p}\n    hits: ${hits}\n    reason: THE RECORDED DECISION.\n`);
	ok("an allowlisted site passes", run(tree, entry(1)).problems.length === 0, JSON.stringify(run(tree, entry(1)).problems));
	ok("an unallowlisted site fails with file:line", says(run(tree, EMPTY_LIST), /components\/a\.tsx:1:/));
	ok("an entry that over-declares fails", says(run(tree, entry(2)), /declares 2 hit\(s\) and there are 1/));
	ok("an entry matching NOTHING fails — the positive control", says(run(tree, entry(1, "apps/console/components/gone.tsx")), /matches nothing/));
	// The allowlist's header promises the guard prints the reason to whoever trips over it.
	ok("...and both entry failures print the recorded reason", says(run(tree, entry(2)), /THE RECORDED DECISION/) && says(run(tree, entry(1, "apps/console/components/gone.tsx")), /THE RECORDED DECISION/));
	const grew = withFloors(`baseline: 0\ndebt: 0\n\nformat:\n  - path: apps/console/components/a.tsx\n    hits: 1\n    reason: because.\n`);
	ok("the list may never grow past its baseline", says(run(tree, grew), /only shrinks/));
	const shrank = withFloors(`baseline: 2\ndebt: 0\n\nformat:\n  - path: apps/console/components/a.tsx\n    hits: 1\n    reason: because.\n`);
	ok("...and a shrink must be recorded, not left as headroom", says(run(tree, shrank), /gen:shared-surface`, which lowers `baseline:` to 1/));

	// THE SECOND LEDGER, both directions, and the one that matters most: the two must not be
	// interchangeable. A debt row counted against `baseline` would let a fake decision be paid for
	// out of the drift census, which is the conversion the split exists to make visible.
	const debtEntry = (bl, db, kind) =>
		withFloors(`baseline: ${bl}\ndebt: ${db}\n\nformat:\n  - path: apps/console/components/a.tsx\n    hits: 1\n    ${kind}\n`);
	const LIFTS = 'lifts: "#3620 — THE RECORDED DEBT."';
	const asDebt = run(tree, debtEntry(0, 1, LIFTS));
	ok("a debt row passes, and pays out of `debt` rather than `baseline`", asDebt.problems.length === 0 && asDebt.debt === 1 && asDebt.decisions === 0, JSON.stringify(asDebt.problems));
	ok("...and its recorded note is printed when its hits stop agreeing", says(run({ ...tree, "apps/console/components/a.tsx": "const a = n.toFixed(2);\nconst b = n.toFixed(1);" }, debtEntry(0, 1, LIFTS)), /THE RECORDED DEBT/));
	ok("a debt ledger may never grow past its number", says(run(tree, debtEntry(0, 0, LIFTS)), /against a `debt:` of 0/));
	ok("...and a debt shrink must be recorded too", says(run(tree, debtEntry(0, 2, LIFTS)), /gen:shared-surface`, which lowers `debt:` to 1/));
	// The conversion, in both directions, proved by moving ONE row between the two kinds and
	// leaving both numbers alone. Each direction reds against a DIFFERENT ledger.
	ok("a decision row does not pay out of `debt`", says(run(tree, debtEntry(0, 1, "reason: because.")), /against a `baseline:` of 0/));
	ok("...and a debt row does not pay out of `baseline`", says(run(tree, debtEntry(1, 0, LIFTS)), /against a `debt:` of 0/));

	// ── the permanent positive control, exercised in both directions ────────────────────────
	// Both halves are exercised THROUGH `check`, not against `RULES` directly: the earlier version
	// asserted the matchers here and left the control inside `check` uncovered, so deleting the
	// anti-probe branch kept the whole self-test green.
	const dead = RULES[0].matchers[0];
	const realRe = dead.re;
	dead.re = /THIS_WILL_NEVER_APPEAR/g;
	const blind = run(tree, entry(1));
	dead.re = realRe;
	ok("a matcher that stopped matching FAILS rather than reporting a clean tree", says(blind, /no longer matches its own probe/), JSON.stringify(blind.problems));

	dead.re = /toFixed|toFixed/g; // matches the bare identifier its anti-probe is built from
	const widened = run(tree, entry(1));
	dead.re = realRe;
	ok("a matcher that WIDENED onto correct code fails too", says(widened, /has widened onto/), JSON.stringify(widened.problems));

	// A matcher with NO anti-probe passes the widening half silently, because `re.test(undefined)`
	// is false for every matcher here — a control that is absent and reads as a control that held.
	const noAnti = (() => {
		const m = RULES[0].matchers[0];
		const real = m.antiProbe;
		delete m.antiProbe;
		const r = run(tree, entry(1));
		m.antiProbe = real;
		return r;
	})();
	ok("a matcher that declares no anti-probe FAILS rather than skipping the widening control", says(noAnti, /declares no `antiProbe`/), JSON.stringify(noAnti.problems));
	// Every matcher in the live rules carries both halves — asserted here as well as in `check`,
	// because this is the assertion that survives someone deleting the structural check above.
	ok(
		"every live matcher carries a probe and an anti-probe",
		RULES.every((r) => r.matchers.every((m) => typeof m.probe === "string" && m.probe !== "" && typeof m.antiProbe === "string" && m.antiProbe !== "")),
	);

	// ── the guard must not be able to match itself or its own fixtures ───────────────────────
	const mixed = fakeTree({ "scripts/check-shared-surface.mjs": "const a = n.toFixed(2);", "apps/console/components/a.tsx": "" });
	const scannedPaths = Object.values(SCOPES).flatMap((s) => filesFor(s, mixed.listDir).files);
	ok("the console file IS reached", scannedPaths.includes("apps/console/components/a.tsx"));
	ok("...and this guard, sitting in scripts/, is never scanned", !scannedPaths.includes("scripts/check-shared-surface.mjs"));
	ok("the fixtures above live in this file, not on disk", !fs.existsSync(path.join(ROOT, "apps/console/components/x/probe.tsx")));
	// A raw NUL in this file's own source made `rg` and `grep -r` report "binary file matches" and
	// print nothing, for a guard whose value is that the next reader can read its stated scope.
	// `import.meta.filename`, not a hardcoded path: the assertion has to read the file that is
	// actually running, or a copy of this guard would check the pristine original and pass.
	ok("this file holds no NUL byte, so ripgrep will still print it", !fs.readFileSync(import.meta.filename, "utf8").includes("\u0000"));

	// ── the derived ledger counters (#3788) ──────────────────────────────────────────────────
	//
	// A fixture allowlist whose counters are WRONG BY CONSTRUCTION, so nothing below can be
	// comparing the generator against a value the generator produced. The rows are the input; the
	// integers are typed here to disagree with them, in both directions, on purpose.
	const SECTION = RULES[0].id;
	/** @param {number} decisions @param {number} debts @param {number} baselineSays @param {number} debtSays */
	const ledgerFixture = (decisions, debts, baselineSays, debtSays) => {
		const rows = [];
		for (let i = 0; i < decisions; i++) rows.push(`  - path: apps/console/components/d${i}.tsx\n    hits: 1\n    reason: this surface is a different thing`);
		for (let i = 0; i < debts; i++) rows.push(`  - path: apps/console/components/x${i}.tsx\n    hits: 2\n    lifts: "#3613 — measured drift"`);
		return (
			"# a header line that says baseline: 999 and debt: 999 and must never be rewritten\n" +
			`baseline: ${baselineSays}\ndebt: ${debtSays}\n\nscanned:\n` +
			`${Object.keys(SCOPES)
				.map((id) => `  - scope: ${id}\n    floor: 0\n`)
				.join("")}\n${SECTION}:\n${rows.join("\n")}\n`
		);
	};

	{
		// TOO HIGH in both ledgers, then TOO LOW in both, then RIGHT. `--write` must land on the same
		// rendered file from either side, and the number it lands on is read back OUT of the rendered
		// text — never taken from `want` — so this cannot pass by asserting the fix against itself.
		const rowsSay = { baseline: 3, debt: 4 };
		/** @param {string} rendered @param {"baseline"|"debt"} key */
		const readBack = (rendered, key) => {
			const line = rendered.split("\n").find((l) => l.startsWith(`${key}: `));
			return line === undefined ? null : Number(line.slice(key.length + 2));
		};
		for (const [label, says] of /** @type {[string, {baseline: number, debt: number}][]} */ ([
			["too high", { baseline: 9, debt: 9 }],
			["too low", { baseline: 0, debt: 1 }],
			["already right", rowsSay],
		])) {
			const text = ledgerFixture(rowsSay.baseline, rowsSay.debt, says.baseline, says.debt);
			const r = renderAllowlist(text);
			ok(
				`a \`${label}\` ledger renders to ${rowsSay.baseline}/${rowsSay.debt}`,
				readBack(r.text, "baseline") === rowsSay.baseline && readBack(r.text, "debt") === rowsSay.debt,
				`got ${readBack(r.text, "baseline")}/${readBack(r.text, "debt")}`,
			);
			const shouldBeStale = says.baseline !== rowsSay.baseline || says.debt !== rowsSay.debt;
			ok(`...and a \`${label}\` ledger is reported ${shouldBeStale ? "STALE" : "in sync"}`, r.stale === shouldBeStale);
			// The bare invocation's OTHER half must agree with it. The shrink-only check inside
			// `check` still fails in BOTH directions, so deleting the staleness gate could not make a
			// wrong counter pass. Asserted through `check`, over the same fixture rows.
			const viaCheck = run(ballast(), text);
			ok(
				`...and \`check\` ${shouldBeStale ? "still refuses" : "accepts"} it`,
				viaCheck.problems.some((p) => /only shrinks|— a win/.test(p)) === shouldBeStale,
				JSON.stringify(viaCheck.problems),
			);
		}

		const text = ledgerFixture(rowsSay.baseline, rowsSay.debt, 9, 9);
		const once = renderAllowlist(text).text;
		ok("`--write` is idempotent", renderAllowlist(once).text === once);
		// THE INVARIANT THAT MAKES A GENERATOR SAFE ON A HAND-AUTHORED FILE: two lines change, and
		// the count of changed lines is measured on the RENDERED text rather than asserted in prose.
		const afterLines = once.split("\n");
		const changed = text.split("\n").filter((l, i) => l !== afterLines[i]);
		ok("...and it touches exactly the two counter lines, no row and no comment", changed.length === 2 && changed.every((l) => /^(baseline|debt): \d+$/.test(l)), JSON.stringify(changed));
		ok("...leaving the line count untouched", text.split("\n").length === afterLines.length);
		ok("...and a `# … baseline: 999 …` header comment is not a counter", once.includes("baseline: 999 and debt: 999"));
	}

	// ── the argument parser ──────────────────────────────────────────────────────────────────
	ok("no argument is the check", parseCliArgs([]).mode === "check" && parseCliArgs([]).error === null);
	ok("`--write` is the generator", parseCliArgs(["--write"]).mode === "write");
	ok("`--self-test` still resolves", parseCliArgs(["--self-test"]).mode === "self-test");
	ok("`--help` and `-h` resolve", parseCliArgs(["--help"]).mode === "help" && parseCliArgs(["-h"]).mode === "help");
	// The whole reason the parser exists: `process.argv.includes("--self-test")` made a typo
	// indistinguishable from a successful run — `--wrte` scanned the tree and reported GREEN.
	ok("a typo'd flag is an ERROR, never a fall-through to the check", parseCliArgs(["--wrte"]).mode === null && /unrecognised argument/.test(parseCliArgs(["--wrte"]).error ?? ""));
	ok("...and so is an unknown flag beside a known one", parseCliArgs(["--write", "--wrte"]).error !== null);
	ok("two modes at once is an error", parseCliArgs(["--write", "--self-test"]).error !== null);
	ok("...but the same mode twice is not", parseCliArgs(["--write", "--write"]).mode === "write");

	// The parser is only half the claim: the DISPATCH has to be wired to it. Driven as a real
	// subprocess, because "the parser returned an error" and "the process exited non-zero" are two
	// different facts, and a guard that proves the first while the second is false is this repo's
	// most-paid-for defect.
	{
		const typo = spawnSync(process.execPath, [import.meta.filename, "--wrte"], { encoding: "utf8" });
		ok("an unknown flag exits NON-ZERO from the real entry point", typo.status !== 0 && typo.status !== null, `status ${typo.status}`);
		ok("...naming the flag it could not read", /--wrte/.test(typo.stderr ?? ""), typo.stderr);
		ok("...and it does not fall through and scan the tree", !/files per rule/.test(`${typo.stdout}${typo.stderr}`));
		const help = spawnSync(process.execPath, [import.meta.filename, "--help"], { encoding: "utf8" });
		ok("`--help` exits 0 and names `--write`", help.status === 0 && /--write/.test(help.stdout ?? ""), `status ${help.status}`);
	}

	if (fails > 0) {
		console.error(`\ncheck-shared-surface self-test: ${fails} failure(s)`);
		process.exit(1);
	}
	console.log("\nself-test: all passed");
}

// ── entry ─────────────────────────────────────────────────────────────────────────────────────

export const USAGE = [
	"Usage: node scripts/check-shared-surface.mjs [--write|--self-test|--help]",
	"",
	"  (no argument)  scan the console for hand-rolled shared surfaces, and refuse a",
	`                 ${ALLOWLIST} whose \`baseline:\`/\`debt:\` disagree with its rows`,
	"  --write        rewrite those two counter lines from the rows (pnpm gen:shared-surface)",
	"  --self-test    run the fixture suite; exit 1 on any failure",
	"  --help, -h     this text",
].join("\n");

/**
 * The whole argument parser. An unrecognised argument is an ERROR (exit 2), never a fall-through to
 * the default mode — the same rule, and the same reason, as `check-route-states.mjs`: a caller's
 * typo must not be indistinguishable from a successful run. Until #3788 the dispatch was
 * `process.argv.includes("--self-test")`, so `--wrte` scanned the tree and reported green.
 *
 * @param {string[]} argv
 * @returns {{mode: "check"|"write"|"self-test"|"help"|null, error: string|null}}
 */
export function parseCliArgs(argv) {
	const MODES = {
		"--write": "write",
		"--self-test": "self-test",
		"--help": "help",
		"-h": "help",
	};
	if (argv.length === 0) return { mode: "check", error: null };
	const unknown = argv.filter((a) => !(a in MODES));
	if (unknown.length > 0) {
		return { mode: null, error: `unrecognised argument${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}` };
	}
	if (argv.some((a) => MODES[a] === "help")) return { mode: "help", error: null };
	const distinct = [...new Set(argv.map((a) => MODES[a]))];
	if (distinct.length > 1) return { mode: null, error: `${distinct.join(" and ")} cannot both be asked for` };
	return { mode: distinct[0], error: null };
}

// Importing this module must not RUN it. Everything above runs at import time and can
// `process.exit(1)`, so without this line an `import` of this file is an INVOCATION of the guard.
//
// The premise this used to cite is gone and the follow-up it implied is a cycle. It read
// "`console-routes.mjs` carries a copy of `stripComments` rather than importing this one" — #3787
// (`59a67c08`, closing #3689) deleted that copy and inverted the direction: the import now goes
// checker → seams module, as the `stripCommentLines` import at the top of this file shows. A
// reader following the old wording would have moved the definition back here and had
// `console-routes.mjs` import it, which is the second import path #3689 existed to remove.
//
// The guard stays, and its reason does not depend on that history: this file is a PROGRAM and
// `console-routes.mjs` is a LIBRARY — importing a library runs no check and prints nothing;
// importing a program is running it. That asymmetry is stated in full beside `stripCommentLines`,
// which is where the definition lives for the same reason.
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

const parsed = invokedDirectly ? parseCliArgs(process.argv.slice(2)) : { mode: null, error: null };

if (invokedDirectly && parsed.error !== null) {
	console.error(`check-shared-surface: ${parsed.error}\n\n${USAGE}`);
	process.exit(2);
} else if (parsed.mode === "help") {
	console.log(USAGE);
} else if (parsed.mode === "self-test") {
	selfTest();
} else if (parsed.mode === "write") {
	// The generator. It reads the allowlist and writes the allowlist; it does not scan the tree, for
	// the reason `renderAllowlist` states — a generator that gated on a clean console would refuse
	// to run in the one situation that needs it.
	const file = path.join(ROOT, ALLOWLIST);
	const text = fs.readFileSync(file, "utf8");
	const { text: rendered, want, have, stale } = renderAllowlist(text);
	if (stale) fs.writeFileSync(file, rendered);
	console.log(
		`${stale ? "wrote" : "unchanged"} ${ALLOWLIST} — baseline: ${have.baseline} → ${want.baseline}, debt: ${have.debt} → ${want.debt}. ` +
			"The rows decide these numbers; a counter that goes UP in the diff is still what review stops.",
	);
} else if (parsed.mode === "check") {
	const readFile = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
	/** @param {string} dir */
	const listDir = (dir) => {
		let entries;
		try {
			entries = fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true });
		} catch (err) {
			// ENOTDIR is how `filesFor` asks "is this path a file?", and it is the expected answer
			// for every file in the tree. Everything else — EACCES on an unreadable directory, a
			// dangling symlink — is rethrown: swallowing it dropped that whole subtree from the
			// scan and still printed `✓ … examined N file(s)`.
			if (err instanceof Error && "code" in err && err.code === "ENOTDIR") return [];
			throw err;
		}
		return entries.filter((e) => e.isDirectory() || e.isFile()).map((e) => e.name);
	};
	const { problems, census, perRule, allowed, decisions, debt } = check(readFile, listDir);
	for (const p of problems) console.error(`::error::shared-surface: ${p}`);
	// The per-root breakdown is printed on EVERY run, pass or fail. A collapse that the floors
	// above cannot see — one root emptying while another grows — is then visible in the diff of
	// two CI logs rather than invisible behind a single total.
	// Keyed by SCOPE and root, not by root alone: `apps/console/components` is a root of three
	// scopes, and summing them prints 1040 for a directory holding 364 files, which is the kind of
	// number a reader stops trusting.
	const perRoot = new Map();
	for (const [key, n] of census) {
		const [scopeId, root] = key.split(SEP);
		const label = `${scopeId}:${root}`;
		perRoot.set(label, (perRoot.get(label) ?? 0) + n);
	}
	const breakdown = [...perRoot].map(([label, n]) => `${label} ${n}`).join(", ");
	const rules = [...perRule].map(([id, n]) => `${id} ${n}`).join(", ");

	// THE STALENESS GATE, and it is deliberately a comparison against the RENDERED FILE — the bytes
	// `--write` would produce — rather than a second reading of the same integers. It exits 2, its
	// own code, so a stale counter is distinguishable from console drift (1) and from a typo'd flag
	// (2 at the parser, before anything is scanned).
	//
	// It does NOT replace the shrink-only check inside `check`: that one still fails in both
	// directions and its message is what says which way the ledger moved. This one adds the command.
	const ledger = renderAllowlist(readFile(ALLOWLIST));
	if (ledger.stale) {
		console.error(
			`::error::shared-surface: ${ALLOWLIST}'s ledger counters are STALE — its rows say ` +
				`\`baseline: ${ledger.want.baseline}\` and \`debt: ${ledger.want.debt}\`, the file says ` +
				`${ledger.have.baseline} and ${ledger.have.debt}. Run \`pnpm gen:shared-surface\` and commit — ` +
				"do not recount by hand, and on a merge conflict at those two lines take either side and run it.",
		);
		console.error(`\n${problems.length} problem(s) (files per rule — ${rules}; per root — ${breakdown}).`);
		process.exit(2);
	}

	if (problems.length > 0) {
		console.error(`\n${problems.length} problem(s) (files per rule — ${rules}; per root — ${breakdown}).`);
		process.exit(1);
	}
	console.log(
		`✓ check-shared-surface: files per rule — ${rules}; per root — ${breakdown}. ` +
			`Every hand-rolled ${RULES.map((r) => r.surface).join(" / ")} site is one of the ${allowed} ` +
			`occurrence(s) that ${ALLOWLIST} accounts for — across ${decisions} recorded decision(s) and ` +
			`${debt} file(s) of measured drift still owed to the board, which is what its \`baseline:\` ` +
			"and `debt:` say, derived.",
	);
}
