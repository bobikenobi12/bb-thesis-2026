// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Regression cover for #4089 — a Next prefetch of a sidebar link moved the session's tenant.
//
// The chain: `useActiveOrgSlug` read the workspace store alone, and `activeOrgId` is null until
// `fetchWorkspace()` resolves, so the lookup missed and it returned the reserved personal `~` for
// "still loading" as well as for "actually personal". During hydration the sidebar therefore
// painted `/~/~/…` hrefs while the address bar said `/acme/…`. Next prefetches every link in the
// viewport; each prefetch renders `app/(private)/[org]/layout.tsx`; that layout calls
// `resolveOrgScope("~")`, which WRITES `session.active_organization_id`. A speculative GET the
// user never made moved their tenant, and their next write landed in the personal org — invisible
// to the org and every teammate, with no error. Run 33710964528's trace caught 36 `/~/~/`
// requests, every one carrying `next-router-prefetch: 1`, none of them a navigation.
//
// ## What these tests prove, and what they do NOT
//
// They do NOT drive a prefetch. A prefetch is an HTTP request shape, and there is no tier
// available here that issues one: the console cannot run on this machine, and even in a running
// console the distinguishing header is invisible to application code — Next 16.3.3 puts
// `next-router-prefetch` in `FLIGHT_HEADERS`, which `request-store.js` seals out of the view
// `headers()` returns (`.get()` → null) and `web/adapter.js` deletes before `proxy.ts` sees the
// request. So "a prefetch did not write" is not directly assertable at any layer, in a test or in
// production code. That is precisely why the fix is not a guard on the write.
//
// What IS assertable is the invariant that makes a speculative resolve harmless: every
// prefetchable href names the org the address bar already names, so the resolve can only
// re-assert the org the user is already in — the same value a real navigation would write. These
// tests pin that invariant at the one place the two could disagree, which is the hook that builds
// the hrefs. `tests/actions/resolve.test.ts` pins the other half: that the resolve writes at all,
// on both branches, so the invariant is load-bearing rather than decorative.
//
// The rest of the file guards the fix against being quietly undone. The hook now REFUSES when
// there is no org segment rather than falling back to the session, because the fallback answered
// `~` — the defect itself, preserved in the branch the fix moved away from. That refusal is only
// safe because every consumer renders under `[org]`, so the file also pins that structural premise
// (one `AppShell` importer) and the `staleTimes` config assumption the re-scoping depends on.

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The org segment of the current URL. `useParams()` returns null outside a router context, which
// is a state the hook must survive — `null` here models that.
let params: Record<string, string | string[]> | null = null;

vi.mock("next/navigation", () => ({
	useParams: () => params,
}));

// The store imports the workspace server actions purely to call them; the hook under test never
// does. Stub the module so importing the store does not drag the DB/auth closure into jsdom.
vi.mock("@/app/server/actions/workspace", () => ({
	getWorkspaceContext: vi.fn(),
	setActiveOrganization: vi.fn(),
}));

import {
	useActiveOrgSlug,
	useWorkspaceStore,
} from "@/lib/stores/use-workspace-store";

/** The store as it is on first paint: fetchWorkspace() has not resolved yet. */
function storeIsLoading() {
	useWorkspaceStore.setState({
		activeOrgId: null,
		organizations: [],
		isLoading: true,
	});
}

/** The store after fetchWorkspace() resolved, scoped to `activeOrgId`. */
function storeLoaded(activeOrgId: string) {
	useWorkspaceStore.setState({
		activeOrgId,
		organizations: [
			{
				id: "org-acme",
				name: "Acme",
				slug: "acme",
				logo: null,
				role: "owner",
				plan: "community",
				status: "none",
			},
			{
				id: "org-other",
				name: "Other",
				slug: "other",
				logo: null,
				role: "member",
				plan: "community",
				status: "none",
			},
		],
		isLoading: false,
	});
}

beforeEach(() => {
	params = null;
	storeIsLoading();
});

describe("useActiveOrgSlug — the href agrees with the address bar (#4089)", () => {
	it("returns the URL's org while the workspace is still loading, never `~`", () => {
		// The exact defect window. Before the fix this returned `~`, the sidebar painted
		// `/~/~/…`, and Next prefetched a URL that re-scoped the session to personal.
		params = { org: "acme" };
		storeIsLoading();

		const { result } = renderHook(() => useActiveOrgSlug());

		expect(result.current).toBe("acme");
		expect(result.current).not.toBe("~");
	});

	it("returns the URL's org when the loaded session names a DIFFERENT one", () => {
		// The other disagreement window: mid-switch, or a session whose stored active org is
		// stale. The URL is what the user is looking at, so the URL wins — an href built from
		// the session would point at a tenant the address bar does not name, and prefetching
		// it would move them there.
		params = { org: "acme" };
		storeLoaded("org-other");

		const { result } = renderHook(() => useActiveOrgSlug());

		expect(result.current).toBe("acme");
	});

	it("returns `~` for the personal scope because the URL says `~`, not because it is loading", () => {
		// Same value as the defect produced, reached honestly: the address bar really does say
		// `~`, so a prefetch re-asserts personal scope, which is where the user already is.
		params = { org: "~" };
		storeIsLoading();

		const { result } = renderHook(() => useActiveOrgSlug());

		expect(result.current).toBe("~");
	});

	it("keeps the URL's org for a project drilldown, where params carry more than `org`", () => {
		params = { org: "acme", project: "checkout", env: "prod" };
		storeLoaded("org-acme");

		const { result } = renderHook(() => useActiveOrgSlug());

		expect(result.current).toBe("acme");
	});
});

describe("useActiveOrgSlug — no org segment is a refusal, not a guess", () => {
	// There is no session fallback, on purpose. Keeping one made the fix POSITIONAL: the old
	// store read still answered `~` while `activeOrgId` was null, so the defect survived intact
	// inside the fallback and merely sat where it did not currently fire — and its doc invited
	// the next reader to paint a store-derived `<Link>` on a non-`[org]` route, which is #4089
	// verbatim. `~` is a REAL tenant, not a null, so a hook with no org segment has no correct
	// value to return; refusing is the only honest branch. These assert that it refuses, and
	// that a loaded session cannot talk it out of refusing.
	it("throws where the route has no `[org]` segment, instead of answering from the session", () => {
		params = {};
		storeLoaded("org-acme");

		expect(() => renderHook(() => useActiveOrgSlug())).toThrow(/no org\s+segment/);
	});

	it("throws rather than aliasing the personal tenant when the session is still loading", () => {
		params = {};
		storeIsLoading();

		expect(() => renderHook(() => useActiveOrgSlug())).toThrow(/#4089/);
	});

	it("throws on a null useParams() (no router context)", () => {
		params = null;
		storeLoaded("org-acme");

		expect(() => renderHook(() => useActiveOrgSlug())).toThrow(/outside the \/\[org\] route tree/);
	});

	it("throws on a catch-all segment's string[] rather than stringifying it into an href", () => {
		params = { org: ["a", "b"] };
		storeLoaded("org-acme");

		expect(() => renderHook(() => useActiveOrgSlug())).toThrow();
	});

	it("throws on an empty org segment", () => {
		params = { org: "" };
		storeLoaded("org-acme");

		expect(() => renderHook(() => useActiveOrgSlug())).toThrow();
	});
});

/**
 * The `apps/console` directory, found by walking up from the working directory.
 *
 * NOT derived from `import.meta.url`: under Vitest the module URL is not a `file:` URL, so
 * `new URL("…", import.meta.url)` throws "The URL must be of scheme file" — which is exactly how
 * the first version of this file failed in CI. `turbo run test` runs the suite with the package as
 * cwd, and the walk also finds it from the repo root.
 *
 * It THROWS when it finds nothing rather than returning a default. Every check below asks whether
 * something is ABSENT, so a silent lookup failure would report an all-clear it never measured.
 */
async function consoleRoot(): Promise<string> {
	let dir = process.cwd();
	for (let up = 0; up < 6; up += 1) {
		for (const rel of [".", "apps/console"]) {
			const candidate = path.join(dir, rel);
			try {
				await stat(path.join(candidate, "next.config.ts"));
				return candidate;
			} catch {
				// Not at this level — try the next candidate, then the parent directory.
			}
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	throw new Error(`apps/console not found walking up from ${process.cwd()}`);
}

/** Every `.ts`/`.tsx` file under `dir`, recursively, as paths relative to `root`. */
async function sourceFilesUnder(root: string, dir: string): Promise<string[]> {
	const out: string[] = [];
	for (const entry of await readdir(path.join(root, dir), {
		withFileTypes: true,
	})) {
		const rel = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...(await sourceFilesUnder(root, rel)));
		} else if (/\.tsx?$/.test(entry.name)) {
			out.push(rel);
		}
	}
	return out;
}

describe("the premise the refusal rests on: one AppShell importer", () => {
	// The throw is unreachable in production ONLY because every consumer of the hook renders
	// inside `AppShell`, and `AppShell` is rendered by exactly one module — the `[org]` layout —
	// where the segment always exists. That is a structural fact, not a guarantee, and nothing
	// else in the repo checks it: render `AppShell` anywhere outside `/[org]/…` and the console
	// starts throwing at a place no test covers.
	//
	// So pin the fact rather than the reasoning. A red here does not mean "the test is stale" —
	// it means the contract on `useActiveOrgSlug` now needs a decision.
	it("AppShell is imported only by app/(private)/[org]/layout.tsx", async () => {
		const root = await consoleRoot();
		const files = [
			...(await sourceFilesUnder(root, "app")),
			...(await sourceFilesUnder(root, "components")),
		];
		// Control: prove the walk actually reached the tree. Without it, a walk that returned
		// nothing would satisfy the assertion below by finding no importers at all.
		expect(files.length).toBeGreaterThan(100);

		const importers: string[] = [];
		for (const rel of files) {
			const text = await readFile(path.join(root, rel), "utf8");
			if (text.includes("@/components/shell/app-shell")) importers.push(rel);
		}

		expect(importers.sort()).toEqual(["app/(private)/[org]/layout.tsx"]);
	});
});

/**
 * True when `source` assigns a property named `key` in live code — i.e. the name occurs on a line
 * that is not wholly a comment.
 *
 * ## Why line-oriented, and why this is sound
 *
 * The first version of this check stripped comments with two regexes and then searched the
 * remainder. That could fail to an ALL-CLEAR, which is the same shape of failure #4089 is about:
 * line comments were stripped BEFORE block comments, so a `//` inside a one-line-closing
 * `/* … *\/` destroyed its terminator, and the lazy block matcher then deleted everything to the
 * next `*\/` anywhere in the file. A live `staleTimes:` inside that swallowed span passed. Its
 * controls (`length > 500`, `serverActions:` present) survive a partial deletion, so they proved
 * the file was read — not that the region under assertion was preserved.
 *
 * This deletes nothing, so no region can go missing, and it is order-independent. It asks the
 * cheapest question that is still sound: **can this occurrence be live code?** A live assignment
 * cannot sit on a line whose trimmed text begins with `//`, `*` or `/*`, because such a line is
 * inside a comment. So there is no way for a live key to be missed.
 *
 * It can OVER-report — a block comment whose continuation lines are not prefixed with `*` reads as
 * live code — and that direction is deliberate. A false red is loud and someone reformats a
 * comment; a false green is the defect this replaced.
 */
function assignsKeyInLiveCode(source: string, key: string): boolean {
	return source
		.split("\n")
		.filter((line) => line.includes(key))
		.some((line) => {
			const t = line.trim();
			return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
		});
}

describe("the client Router Cache must not serve `/{org}/…` (#4089)", () => {
	// The invisible assumption the whole fix rides on. Re-scoping the session happens ONLY
	// because Next 16's default `staleTimes.dynamic = 0` re-runs the dynamic segment on every
	// navigation. Setting `staleTimes.dynamic > 0` serves `/{org}/…` from the client Router
	// Cache, `[org]/layout.tsx` does not re-run, and the session is then never re-scoped on a
	// soft navigation between two orgs — the user keeps writing into whichever org they were
	// last hard-loaded under. Nothing errors and no check goes red, so this is the check.
	//
	// It reads the config as SOURCE rather than importing it: `next.config.ts` runs
	// `withPostHogConfig` and env-dependent origin resolution at module scope, and neither is
	// worth booting to answer a one-key question.

	it("detects a live key, and ignores a commented one", () => {
		// The detector is exercised against known inputs BEFORE it is trusted on the real file —
		// otherwise a green below cannot be told apart from a matcher that finds nothing at all.
		expect(
			assignsKeyInLiveCode(
				"const c = {\n\texperimental: { staleTimes: { dynamic: 30 } },\n};",
				"staleTimes",
			),
		).toBe(true);
		// A trailing comment does not launder it.
		expect(
			assignsKeyInLiveCode("\tstaleTimes: { dynamic: 30 }, // shipped\n", "staleTimes"),
		).toBe(true);
		// Prose about the key — including the warning block in next.config.ts — must not trip it.
		expect(
			assignsKeyInLiveCode(
				"// Do NOT add `staleTimes` here.\n/*\n * staleTimes.dynamic = 0 is the default.\n */\n",
				"staleTimes",
			),
		).toBe(false);
	});

	it("next.config.ts sets no experimental.staleTimes", async () => {
		const source = await readFile(
			path.join(await consoleRoot(), "next.config.ts"),
			"utf8",
		);

		// Controls, both of which fail if the wrong file was read or the read came back empty.
		// The second is the sharper one: it proves this file still carries the warning comment
		// that tells the next reader WHY the key must stay absent. If someone deletes the
		// warning, this test says so rather than quietly guarding an unexplained rule.
		expect(assignsKeyInLiveCode(source, "serverActions")).toBe(true);
		expect(source).toContain("staleTimes");

		expect(assignsKeyInLiveCode(source, "staleTimes")).toBe(false);
	});
});
