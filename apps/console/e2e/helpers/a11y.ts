// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Accessibility scan helper wrapping @axe-core/playwright. Specs call scanA11y(page) and either
// assert no serious/critical violations or record them for the QA report. Kept resilient: if the
// axe package isn't installed the helper no-ops (returns []) so the suite still runs.
//
// WHAT THIS FILE KEEPS, AND WHY IT IS MORE THAN IT LOOKS (#4099).
//
// It used to reduce every violation to `{id, impact, help, nodes, target}` — a count and the FIRST
// node's locator. Two things died in that reduction, and each was on its own sufficient to make R5
// unfixable:
//
//   1. `nodes[*].any[]/all[]/none[]` `data` went entirely. That is exactly where axe puts
//      `fgColor`, `bgColor`, `contrastRatio` and `expectedContrastRatio` for `color-contrast`. So a
//      contrast FAIL recorded that SOMETHING on the page failed and nothing about WHAT — and every
//      change to packages/brand/src/tokens.css aimed at R5 was a guess, because no artifact in the
//      repo named a failing colour pair.
//   2. Only `nodes[0].target` survived, against violations carrying up to 39 nodes. `nodes: 39` was
//      a number with no referents.
//
// So each node's checks are retained. Retaining all 39 nodes verbatim would be a large artifact
// across ~40 routes, so nodes are GROUPED BY THEIR CHECK DATA first: a colour pair repeated across
// thirty nodes is one row carrying one example locator and `count: 30`. That is what makes a cap
// affordable — it drops repetition, not information — and in the ordinary case the cap is never
// reached at all. When it IS reached, `omittedNodes` says how many nodes stand behind no kept row.
//
// THE CAP IS IN THE RECORD, NOT IN A COMMENT. `omittedNodes: 0` and `omittedNodes: 12` are
// different artifacts, so "we kept everything" can never be confused with "we kept the first few" —
// the repo has paid for that distinction before: an emptiness check cannot see a withheld
// measurement, and a full array whose every element says NOT MEASURED passes every guard.

import { type Page } from "@playwright/test";

/**
 * How many distinct check-data groups are kept per violation.
 *
 * Groups, not nodes — see the header. Eight is chosen so that the pathological live case (39 nodes,
 * `color-contrast`) is kept in full, since those 39 nodes carry a handful of distinct colour pairs
 * between them. A violation that genuinely has more than eight distinct payloads records the excess
 * in `omittedNodes` rather than dropping it silently.
 */
export const A11Y_GROUP_CAP = 8;

/** One failing axe check, with the payload axe attached to it. */
export interface A11yCheck {
	/** axe's check id — `color-contrast`, `aria-valid-attr-value`, … */
	id: string;
	/**
	 * axe's per-check payload, verbatim. `unknown` rather than `any` (the upstream type) because
	 * its shape is per-check: `color-contrast` gives `{fgColor, bgColor, contrastRatio,
	 * expectedContrastRatio, fontSize, fontWeight}`, other checks give other things or nothing.
	 * Readers narrow it; nobody casts it.
	 */
	data: unknown;
}

/** The nodes of one violation that share identical check data, collapsed to a single row. */
export interface A11yNodeGroup {
	/** One example locator for the nodes in this group. */
	target: string;
	/** How many of the violation's nodes carry exactly this check data. */
	count: number;
	/**
	 * The failing checks axe attached, from `any`, `all` AND `none`.
	 *
	 * `none` is included even though `color-contrast` lives in `any`: a `none` check that PASSED is
	 * a real failure mode, and a helper that drops it would reproduce this issue for a different
	 * rule. An empty array here means axe attached no checks to these nodes — which is a different
	 * fact from a node this helper never looked at, and the two must not serialise alike.
	 */
	checks: A11yCheck[];
}

export interface A11yViolation {
	id: string;
	impact: string | null;
	help: string;
	/** The TRUE node count axe reported — never the number kept. */
	nodes: number;
	/** The first node's target. Unchanged, because existing readers key on it. */
	target: string;
	/** Distinct check-data groups, capped at {@link A11Y_GROUP_CAP}. */
	groups: A11yNodeGroup[];
	/**
	 * Nodes represented by NO kept group, because the cap dropped theirs.
	 *
	 * `0` means every node is accounted for. Any other number is the size of what was withheld, and
	 * it is recorded rather than remembered.
	 */
	omittedNodes: number;
}

/** Read one property off a value that may not be an object at all. No casts, no `any`. */
function prop(value: unknown, name: string): unknown {
	if (typeof value !== "object" || value === null) return undefined;
	return Object.prototype.hasOwnProperty.call(value, name)
		? Object.getOwnPropertyDescriptor(value, name)?.value
		: undefined;
}

/** Narrow one axe check result without casting. */
function toCheck(raw: unknown): A11yCheck | null {
	const id = prop(raw, "id");
	if (typeof id !== "string") return null;
	return { id, data: prop(raw, "data") };
}

/**
 * Group a violation's nodes by their check data, keep at most {@link A11Y_GROUP_CAP} groups, and
 * report how many nodes the dropped groups held.
 *
 * The fingerprint is the serialised check list, so two nodes failing on the same colour pair
 * collapse — which is the whole reason a cap is affordable here.
 *
 * Exported for `tests/e2e-helpers/a11y-node-groups.test.ts`. The grouping is the PRODUCER half of
 * #4099, and a fix proven only against fixtures hand-written alongside it is proven against itself:
 * that test drives this function with a verbatim axe payload and feeds its output to the real
 * `summariseLiveEvidence`, so nothing in the middle is authored by the fix.
 */
export function groupNodes(nodes: readonly unknown[]): { groups: A11yNodeGroup[]; omittedNodes: number } {
	const byPrint = new Map<string, A11yNodeGroup>();
	for (const node of nodes) {
		// SKIPPED, not grouped. Two unreadable nodes both fingerprint as "no checks" and would
		// otherwise merge into a row with an empty target that asserts axe attached no checks — a
		// fabricated finding. They are counted as withheld instead, below.
		if (typeof node !== "object" || node === null) continue;
		const checks: A11yCheck[] = [];
		for (const key of ["any", "all", "none"]) {
			const list = prop(node, key);
			if (!Array.isArray(list)) continue;
			for (const raw of list) {
				const check = toCheck(raw);
				if (check) checks.push(check);
			}
		}
		const rawTarget = prop(node, "target");
		const target = Array.isArray(rawTarget) ? rawTarget.join(" ") : "";
		const print = JSON.stringify(checks);
		const seen = byPrint.get(print);
		if (seen) seen.count += 1;
		else byPrint.set(print, { target, count: 1, checks });
	}
	const all = [...byPrint.values()].sort((a, b) => b.count - a.count);
	const groups = all.slice(0, A11Y_GROUP_CAP);
	const kept = groups.reduce((n, g) => n + g.count, 0);
	// AGAINST THE INPUT LENGTH, not against the nodes this function managed to read. A node whose
	// shape it could not parse is skipped, and subtracting only what the cap dropped would report
	// `omittedNodes: 0` while nodes went unaccounted for — this issue's own defect, one scale down.
	return { groups, omittedNodes: nodes.length - kept };
}

/**
 * Runs axe-core against the current page (optionally scoped to a selector). Returns serious/critical
 * violations. No-ops to [] if @axe-core/playwright is unavailable.
 *
 * ⚠ THAT NO-OP IS INDISTINGUISHABLE FROM A CLEAN PAGE, deliberately, so the QA suite still runs
 * without the package — and it is why the conformance audit refuses to start until the import
 * resolves (`e2e/audit/signals.ts` → `requireAxe()`). Any NEW gate built on this helper owes itself
 * the same precondition; the empty array will not tell it.
 */
export async function scanA11y(page: Page, opts?: { include?: string }): Promise<A11yViolation[]> {
	let AxeBuilder: typeof import("@axe-core/playwright").default | undefined;
	try {
		AxeBuilder = (await import("@axe-core/playwright")).default;
	} catch {
		return [];
	}
	let builder = new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]);
	if (opts?.include) builder = builder.include(opts.include);
	const results = await builder.analyze();
	return results.violations
		.filter((v) => v.impact === "serious" || v.impact === "critical")
		.map((v) => {
			const { groups, omittedNodes } = groupNodes(v.nodes);
			return {
				id: v.id,
				impact: v.impact ?? null,
				help: v.help,
				nodes: v.nodes.length,
				target: v.nodes[0]?.target?.join(" ") ?? "",
				groups,
				omittedNodes,
			};
		});
}

/** Asserts the page has no serious/critical a11y violations. */
export async function expectNoSeriousA11yViolations(page: Page, opts?: { include?: string }): Promise<void> {
	const violations = await scanA11y(page, opts);
	if (violations.length) {
		throw new Error(
			`Serious a11y violations (${violations.length}):\n` +
				violations.map((v) => ` · ${v.id} [${v.impact}] ${v.help} — ${v.target}`).join("\n"),
		);
	}
}
