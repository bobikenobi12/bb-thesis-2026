// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Mutation testing (the "non-biased check"): Stryker injects faults into the source and requires
// the unit suite to FAIL. A vacuous test scores ~0; a real test kills its mutants. Scope mirrors
// the coverage scope (logic), runs against the fast unit vitest config. Mutation runs are slow —
// use `pnpm -C apps/console run mutate:since` for incremental PR runs, or `--mutate <glob>` to scope.

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
	packageManager: "pnpm",
	testRunner: "vitest",
	// Explicit (pnpm's strict node_modules hides it from Stryker's auto-discovery glob).
	plugins: ["@stryker-mutator/vitest-runner"],
	// Mutation-only vitest config: excludes the cross-package cli-contract test the sandbox can't run.
	vitest: { configFile: "vitest.mutation.config.ts" },
	reporters: ["html", "clear-text", "progress"],
	// Logic scope only (no components / generated / tests).
	mutate: [
		"lib/**/*.ts",
		"app/server/actions/**/*.ts",
		"!lib/**/*.d.ts",
		"!lib/db/migrations/**",
		"!lib/db/seed/**",
		// Verified by tests/validations/cli-contract.test.ts, which the sandbox can't run (reads
		// sibling packages/core fixtures) — so it'd otherwise report as 0% under mutation.
		"!lib/validations/cli-contract.ts",
	],
	coverageAnalysis: "perTest",
	// Skip "static" mutants — mutations in module-level data tables (cloud-provider/price maps)
	// that can't use per-test coverage and force a full-suite re-run each (39% of mutants, ~100%
	// of the time). They test "is this constant pinned", not logic correctness — low value, huge
	// cost. Mutation here targets LOGIC (conditionals, arithmetic, returns, boundaries).
	ignoreStatic: true,
	concurrency: 4,
	timeoutMS: 30000,
	// Report-only for now; ratchet `break` up as suites land.
	thresholds: { high: 80, low: 60, break: null },
	incremental: true,
	incrementalFile: ".stryker-tmp/incremental.json",
	tempDirName: ".stryker-tmp",
	ignorePatterns: ["coverage", "dist", ".next", "node_modules"],
};
