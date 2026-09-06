// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// fumadocs codegen guard — `.source/` must be REAL before tsc reads it, and the codegen
// chain must stay in the order that keeps it real.
//
// Why this exists (#1612): `check-types` used to be
//     fumadocs-mdx && next typegen && tsc --noEmit
// and it intermittently failed with
//     lib/source.ts(4,22): error TS2306: File '.source/server.ts' is not a module
// while the codegen line right above it said it had succeeded.
//
// The mechanism, confirmed in fumadocs-mdx 14.3.2 and reproduced at ~2/20 locally:
//   1. `fumadocs-mdx` (the bin) generates correctly — it awaits every write. The file is good.
//   2. `next typegen` loads next.config.mjs, which calls `createMDX()` at module scope.
//      `createMDX` fires `init()` UNAWAITED and uncaught (dist/next/index.js:20), which reaches
//      `fs.writeFile('.source/server.ts', …)` — a plain O_TRUNC write with no temp-and-rename
//      (dist/core-*.js:140). The good file is truncated to 0 bytes.
//   3. `next typegen` then calls `process.exit(0)` the moment ITS OWN work finishes
//      (next/dist/bin/next). That does not drain the libuv threadpool, so the in-flight content
//      write is discarded — and typegen still exits 0, because nobody was awaiting it.
//   4. tsc reads a 0-byte server.ts. TS2306.
// The tell in a failing log is a MISSING second "[MDX] generated files in …" line: typegen's
// codegen was killed before it could log.
//
// Two things keep it fixed, and this script guards both:
//   - `next typegen` runs FIRST, so the fully-awaited `fumadocs-mdx` is the last writer. That is
//     version-independent: whatever typegen's fire-and-forget does, it dies with that process.
//     (`_FUMADOCS_MDX=1` on typegen also suppresses the second writer outright, but it is
//     undocumented package internals — the ordering is the load-bearing half.)
//   - the emitted files are asserted here, so a residual failure is loud and LOCAL instead of
//     surfacing as a type error in a file nobody edited.
//
// Usage:  node scripts/check-source-emitted.mjs [--self-test]
// Runs in-chain in `check-types`; also `pnpm -C apps/docs run check:source-emitted`.

import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Files `fumadocs-mdx` emits into `.source/`. All four must exist and be non-empty. */
const EMITTED = ["server.ts", "browser.ts", "dynamic.ts", "source.config.mjs"];

/**
 * The runtime import every healthy `server.ts` carries. Size alone is not enough: TS2306 means
 * "not a module", which a file holding only `// @ts-nocheck` would also trigger.
 */
const SERVER_MARKER = "fumadocs-mdx/runtime/server";

/**
 * Assert the `.source/` directory holds a complete, non-truncated codegen result.
 * @param {string} pkgDir package root containing `.source/`
 * @returns {string[]} human-readable failures; empty when the emit is healthy
 */
function checkEmitted(pkgDir) {
	const problems = [];
	for (const name of EMITTED) {
		const file = join(pkgDir, ".source", name);
		let size;
		try {
			size = statSync(file).size;
		} catch {
			problems.push(`.source/${name} is MISSING — codegen did not run, or its write was discarded`);
			continue;
		}
		if (size === 0) {
			problems.push(`.source/${name} is 0 bytes — a truncating writer was killed mid-write`);
		}
	}

	const server = join(pkgDir, ".source", "server.ts");
	let body = "";
	try {
		body = readFileSync(server, "utf8");
	} catch {
		return problems; // already reported as missing above
	}
	if (body.length > 0 && !body.includes(SERVER_MARKER)) {
		problems.push(
			`.source/server.ts does not import '${SERVER_MARKER}' — it is not a module, which is exactly what tsc reports as TS2306`,
		);
	}
	return problems;
}

/**
 * Assert no npm script runs `fumadocs-mdx` BEFORE `next typegen`. That order lets typegen's
 * unawaited codegen truncate the freshly generated files; reversed, the awaited generator wins.
 * @param {Record<string, string>} scripts the package's `scripts` block
 * @returns {string[]} human-readable failures; empty when every chain is ordered correctly
 */
function checkChainOrder(scripts) {
	const problems = [];
	for (const [name, cmd] of Object.entries(scripts)) {
		const typegen = cmd.indexOf("next typegen");
		const codegen = cmd.indexOf("fumadocs-mdx");
		// Only chains that run BOTH can lose the race; `postinstall` and friends are unaffected.
		if (typegen === -1 || codegen === -1) continue;
		if (codegen < typegen) {
			problems.push(
				`script "${name}" runs fumadocs-mdx BEFORE next typegen — typegen's unawaited codegen ` +
					`(createMDX in next.config.mjs) will truncate .source/. Put "next typegen" first. See #1612.`,
			);
		}
	}
	return problems;
}

/** Run both checks against the real package and exit non-zero on any failure. */
function main() {
	const scripts = JSON.parse(readFileSync(join(PKG_DIR, "package.json"), "utf8")).scripts ?? {};
	const problems = [...checkChainOrder(scripts), ...checkEmitted(PKG_DIR)];
	if (problems.length === 0) return;

	console.error("✗ fumadocs codegen guard failed:\n");
	for (const p of problems) console.error(`  · ${p}`);
	console.error(
		"\n  This is the #1612 race, not a type error in your change. Re-run `pnpm -C apps/docs run check-types`;\n" +
			"  if it persists, confirm `next typegen` still runs before `fumadocs-mdx`.",
	);
	process.exit(1);
}

/** Exercise both detectors against fixtures, so the guard cannot silently stop guarding. */
function selfTest() {
	const cases = [
		{
			name: "correct order passes",
			run: () => checkChainOrder({ "check-types": "next typegen && fumadocs-mdx && tsc --noEmit" }),
			expect: 0,
		},
		{
			name: "reversed order is caught",
			run: () => checkChainOrder({ "check-types": "fumadocs-mdx && next typegen && tsc --noEmit" }),
			expect: 1,
		},
		{
			name: "env-guarded typegen first passes",
			run: () =>
				checkChainOrder({
					"check-types": "_FUMADOCS_MDX=1 next typegen && fumadocs-mdx && tsc --noEmit",
				}),
			expect: 0,
		},
		{
			name: "scripts running only one of the two are ignored",
			run: () => checkChainOrder({ postinstall: "fumadocs-mdx", build: "next build" }),
			expect: 0,
		},
		{
			name: "missing .source is caught",
			run: () => checkEmitted(join(PKG_DIR, "scripts", "__no_such_package__")),
			expect: EMITTED.length,
		},
		{
			name: "the real emitted tree is healthy",
			run: () => checkEmitted(PKG_DIR),
			expect: 0,
		},
	];

	let bad = 0;
	for (const c of cases) {
		const got = c.run().length;
		if (got !== c.expect) {
			bad++;
			console.error(`  ✗ ${c.name}: expected ${c.expect} problem(s), got ${got}`);
		}
	}
	console.log(`  ${cases.length - bad}/${cases.length} self-test cases passed`);
	if (bad > 0) process.exit(1);
}

if (process.argv.includes("--self-test")) selfTest();
else main();
