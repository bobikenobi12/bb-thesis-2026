// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// RUBRIC.md's F7 — the ONE predicate of the console filter standard that a matcher cannot answer.
//
//   "the server builder issues a rows pass AND a separate unfiltered facet pass"
//
// RUBRIC.md's "Family F" section says why this is a unit test and not a grep (by SECTION and not
// by line: #3796 was filed citing `RUBRIC.md:165` and that note now sits at 271, because this
// unit's own edit moved it). A facet's counts must come from the
// UNFILTERED universe, because filtering them in memory makes the option you just picked vanish
// from the list and the filter bar un-un-selectable. "A facet pass sees only the scope
// predicates" is a behaviour. The only honest way to assert it is to RUN the builder and look at
// what the second query was handed.
//
// ── THE ASSERTION, AND WHY IT IS A NEEDLE RATHER THAN A CHAIN INDEX ──────────────────────────
//
// Every builder is driven TWICE against `mockChainDb`, whose `db.select()` hands each pass its own
// recording chain:
//
//   * once with a query carrying NEEDLE values no fixture row and no schema identifier contains;
//   * once with `{}`.
//
// Then, over the recorded `where`/`having` arguments of each chain — walked to their leaves,
// because a drizzle predicate is an object tree and the client's string ends up as a `Param`
// several levels down:
//
//   1. at least one chain CARRIES the needle. Without this the whole test is vacuous: a builder
//      that ignored its query entirely would satisfy every "the facet pass never saw the filter"
//      assertion perfectly, and this is the control that says the filter was applied at all;
//   2. at least one OTHER chain carries no needle and still has a `where` — the facet pass, given
//      the scope predicates and nothing else;
//   3. that same chain's predicates are IDENTICAL between the filtered and the unfiltered run.
//      This is the clause that catches the interesting regression: a facet pass narrowed by
//      something the query supplied but that is not one of our needles — a date bound, a status
//      list, a `narrowTo()` result that renders as raw SQL with no string parameter at all.
//
// Deliberately NOT an index into the chain array. `_list-query-db.ts` records CREATION order,
// which counts `exists(…)` subqueries that are never awaited, so "chain 1 is the facet pass" is
// true of some builders and not others and stops being true when one gains a subquery. A property
// that is true of the whole recording cannot rot that way.
//
// ── THE SUBJECT SET IS DERIVED, AND CHECKED IN BOTH DIRECTIONS ──────────────────────────────
//
// `DRIVEN` below is a table, and a hand-written table of what a guard watches stops covering
// silently — this repo has paid for that more than once. So it is checked against the tree:
// `deriveBuilders()` from `scripts/check-filter-standard.mjs` finds every exported async function
// under `lib/queries/` or `app/server/actions/` that RETURNS facets, and the union of `DRIVEN` and
// that script's `F7_UNDRIVEN` must be exactly that set. A new list page's builder therefore fails
// this file until somebody drives it or declares why not.
//
// The same derivation runs in `pnpm check:filter-standard`, which reads THIS file's `DRIVEN` table
// back. The two checks are the same fact asked from both ends, which is the only arrangement in
// which "the guard says it is driven" and "the test drives it" cannot come apart.

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { deriveBuilders, F7_UNDRIVEN, fsIo } from "../../../../../scripts/check-filter-standard.mjs";
import { mockChainDb, type RecordedChain } from "./_list-query-db";

// `vi.mock` is hoisted above every `const`, so the stub it closes over has to come from
// `vi.hoisted` — the same obstacle `teams-list.test.ts` records.
const { getServiceDb } = vi.hoisted(() => ({ getServiceDb: vi.fn() }));
vi.mock("@/lib/db", () => ({ getServiceDb }));

import { queryAccessGrantsPage } from "@/lib/queries/access-grants";
import {
	queryAlertChannelsPage,
	queryAlertDeliveriesPage,
	queryAlertPoliciesPage,
} from "@/lib/queries/alerts-lists";
import { queryMembersPage } from "@/lib/queries/members";
import { queryTeamsPage } from "@/lib/queries/teams";

/** The org every builder is scoped to. Not a needle: the scope predicate is what a facet pass IS. */
const ORG = "org-under-test";

/**
 * Values no schema identifier, no fixture row and no SQL keyword contains, so finding one inside a
 * recorded predicate means the CLIENT'S QUERY reached it.
 *
 * Written as a prefix plus a per-field suffix so a failure names which filter leaked.
 */
const NEEDLE = "f7needle";

/** One builder under test: how to call it, and the narrowing query to call it with. */
interface Driver {
	/** The module the builder is exported from, for the failure message. */
	module: string;
	/** Invoke the builder with a filtering query. */
	filtered: () => Promise<unknown>;
	/** Invoke the same builder with no query at all. */
	unfiltered: () => Promise<unknown>;
}

/**
 * THE SUBJECT SET. Its keys are read back by `scripts/check-filter-standard.mjs`, which fails if
 * a facet-bearing builder in the tree is in neither this table nor its own `F7_UNDRIVEN`.
 */
const DRIVEN: Record<string, Driver> = {
	queryTeamsPage: {
		module: "@/lib/queries/teams",
		filtered: () => queryTeamsPage(ORG, { search: `${NEEDLE}-team`, sizes: ["small"] }),
		unfiltered: () => queryTeamsPage(ORG),
	},
	queryMembersPage: {
		module: "@/lib/queries/members",
		filtered: () =>
			queryMembersPage(ORG, "viewer-1", { search: `${NEEDLE}-member`, roles: ["admin"] }),
		unfiltered: () => queryMembersPage(ORG, "viewer-1"),
	},
	queryAccessGrantsPage: {
		module: "@/lib/queries/access-grants",
		filtered: () => queryAccessGrantsPage(ORG, { search: `${NEEDLE}-grant` }),
		unfiltered: () => queryAccessGrantsPage(ORG),
	},
	queryAlertChannelsPage: {
		module: "@/lib/queries/alerts-lists",
		filtered: () => queryAlertChannelsPage(ORG, { search: `${NEEDLE}-channel` }),
		unfiltered: () => queryAlertChannelsPage(ORG),
	},
	queryAlertPoliciesPage: {
		module: "@/lib/queries/alerts-lists",
		filtered: () => queryAlertPoliciesPage(ORG, { search: `${NEEDLE}-policy` }),
		unfiltered: () => queryAlertPoliciesPage(ORG),
	},
	queryAlertDeliveriesPage: {
		module: "@/lib/queries/alerts-lists",
		filtered: () => queryAlertDeliveriesPage(ORG, { search: `${NEEDLE}-delivery` }),
		unfiltered: () => queryAlertDeliveriesPage(ORG),
	},
};

/**
 * Every string leaf of an arbitrary value, cycle-safe.
 *
 * A drizzle predicate is an object tree — `SQL` → `queryChunks` → `Param` → `value` — and the
 * depth varies by helper, so the walk is generic rather than shaped to any one of them. A matcher
 * written to today's internal shape would go quiet the day drizzle nests one level deeper, which
 * is the failure mode this whole file exists to prevent.
 */
function stringLeaves(value: unknown, seen = new Set<object>(), out: string[] = []): string[] {
	if (typeof value === "string") {
		out.push(value);
		return out;
	}
	if (value === null || typeof value !== "object") return out;
	if (seen.has(value)) return out;
	seen.add(value);
	for (const v of Object.values(value as Record<string, unknown>)) stringLeaves(v, seen, out);
	return out;
}

/** Every predicate argument a chain was handed, as one flat string list. */
function predicateLeaves(chain: RecordedChain): string[] {
	return chain.calls
		.filter((c) => c.method === "where" || c.method === "having")
		.flatMap((c) => stringLeaves(c.args));
}

/** Whether a chain was handed any predicate at all. */
function hasPredicate(chain: RecordedChain): boolean {
	return chain.called("where") || chain.called("having");
}

/**
 * A stable fingerprint of one chain's predicates: its table/column identifiers and literal values
 * in order, with the ORG scope kept in (a facet pass that stopped scoping to the org would be a
 * far worse defect than the one under test, and this is where it would show).
 */
function fingerprint(chain: RecordedChain): string {
	return predicateLeaves(chain).join("");
}

/** Drive one builder and hand back its recorded chains. */
async function record(run: () => Promise<unknown>): Promise<RecordedChain[]> {
	// Every pass resolves to an empty result set. The builders' follow-up hydration passes are
	// guarded on `rows.length`, so an empty seed exercises the two passes under test and nothing
	// else — and `mockChainDb` resolves past the end of the queue to `[]` rather than throwing,
	// which is what makes one seed serve six builders of different arity.
	const { db, chains } = mockChainDb([]);
	getServiceDb.mockReturnValue(db);
	await run();
	return chains;
}

beforeEach(() => {
	vi.clearAllMocks();
});

/**
 * The repo root, found by walking up to the workspace manifest.
 *
 * NOT a fixed count of `..` from `import.meta.url`: under vitest that URL is the TRANSFORMED
 * module's, and a hard-coded depth silently resolved to a directory with no `apps/console` in it —
 * `fsIo` then answered "no builders" for every lookup and the derivation floor below was the only
 * thing that noticed. Walking to a landmark cannot be wrong by an off-by-one, and it raises rather
 * than handing back a root that reads as an empty tree.
 */
function repoRoot(): string {
	let dir = path.dirname(fileURLToPath(import.meta.url));
	for (let up = 0; up < 12; up += 1) {
		if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
		dir = path.dirname(dir);
	}
	throw new Error("could not find the repo root above this test — the derivation below would read an empty tree.");
}

describe("F7 — the subject set is derived from the tree, not typed here", () => {
	const REPO_ROOT = repoRoot();

	it("drives or declares EVERY facet-bearing server builder", () => {
		const builders = deriveBuilders(fsIo(REPO_ROOT));
		// Vacuity floor. An empty derivation would make every assertion below trivially true, and
		// six is the count on the tree this landed against — a floor, not the number itself, so a
		// new builder does not fail this line for existing.
		expect(builders.length).toBeGreaterThanOrEqual(6);

		const accounted = new Set([...Object.keys(DRIVEN), ...Object.keys(F7_UNDRIVEN)]);
		const orphans = builders.filter((b) => !accounted.has(b.name)).map((b) => `${b.file}:${b.name}`);
		// The failure message is the VALUE, not a second argument to `expect`: `vitest/valid-expect`
		// forbids the message form, and a bare `[] !== [x]` diff names the builder but not what is
		// wrong with it. Keying the object says both.
		expect({ serverBuildersF7DoesNotReach: orphans }).toEqual({ serverBuildersF7DoesNotReach: [] });

		// The other direction: this table may not name a builder the tree no longer has, or the
		// test would be asserting about something that has been renamed out from under it.
		const known = new Set(builders.map((b) => b.name));
		expect(Object.keys(DRIVEN).filter((name) => !known.has(name))).toEqual([]);
	});

	it("declares no builder as both driven and undriven", () => {
		expect(Object.keys(DRIVEN).filter((name) => name in F7_UNDRIVEN)).toEqual([]);
	});
});

describe.each(Object.entries(DRIVEN))(
	"F7 — %s issues a rows pass and a separate UNFILTERED facet pass",
	(name, driver) => {
		it(`applies the caller's filters to at least one pass (${driver.module})`, async () => {
			const chains = await record(driver.filtered);
			const carrying = chains.filter((c) => predicateLeaves(c).some((s) => s.includes(NEEDLE)));
			// THE VACUITY CONTROL, and it comes first on purpose. A builder that dropped its query
			// on the floor would pass every facet assertion below by having no filtered pass to
			// distinguish — "nothing found" and "nothing filtered" must not share a verdict.
			expect({
				builder: name,
				// A builder that dropped its query on the floor would satisfy every facet assertion
				// below by having no filtered pass to distinguish. This says which.
				passesCarryingTheCallersQuery: carrying.length > 0,
			}).toEqual({ builder: name, passesCarryingTheCallersQuery: true });
		});

		it("hands the facet pass the scope predicates and NOTHING from the query", async () => {
			const chains = await record(driver.filtered);
			const clean = chains.filter(
				(c) => hasPredicate(c) && !predicateLeaves(c).some((s) => s.includes(NEEDLE)),
			);
			// A zero here means every predicated pass carries the caller's search term: there is no
			// unfiltered facet pass, and a facet option disappears the moment it is selected.
			expect({ builder: name, unfilteredFacetPasses: clean.length > 0 }).toEqual({
				builder: name,
				unfilteredFacetPasses: true,
			});
		});

		it("gives the facet pass the same predicates filtered and unfiltered", async () => {
			const filtered = await record(driver.filtered);
			const unfiltered = await record(driver.unfiltered);

			// Compared as SETS of fingerprints rather than pairwise by index: two builders here
			// issue three facet passes, and `Promise.all` gives no guarantee about creation order
			// across a conditional pass.
			const facetPrints = (chains: RecordedChain[]) =>
				chains
					.filter((c) => hasPredicate(c) && !predicateLeaves(c).some((s) => s.includes(NEEDLE)))
					.map(fingerprint)
					.sort();

			const withQuery = facetPrints(filtered);
			const without = facetPrints(unfiltered);
			expect(withQuery.length).toBeGreaterThan(0);
			// Every pass that looked unfiltered must ALSO exist, byte for byte, in the run that had
			// no query at all. This is what catches a facet pass narrowed by something the query
			// supplied that carries no string of ours — a date bound, a `narrowTo()` result
			// rendered as raw SQL.
			// A non-empty list here means the facet pass CHANGED when the caller filtered — its counts
			// describe the query's rows rather than the unfiltered universe.
			expect({ builder: name, facetPassesThatMovedWhenFiltered: withQuery.filter((p) => !without.includes(p)) }).toEqual({
				builder: name,
				facetPassesThatMovedWhenFiltered: [],
			});
		});
	},
);
