// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Go-side anti-"bullshit-test" guard — the parity partner of scripts/check-test-imports.mjs
// (which only scans TypeScript). The elench verify engine (packages/core/verify) and the runner
// (apps/runner) are the fail-closed security path; a vacuous Go test there (a `_test.go` that only
// `t.Skip`s, or asserts nothing, or lives with no package to exercise) is exactly the golden-theater
// this corpus work exists to prevent. So, for every `*_test.go` under the scanned roots:
//
//   1. If it declares a test entry point (Test*/Benchmark*/Fuzz*), it MUST contain a real assertion
//      — a `t.Error*`/`t.Fatal*`/`t.Fail*`, a testify `require.`/`assert.`, or a `b.Fatal`/`f.Fatal`.
//      A test that can never fail (only t.Skip/t.Log/empty body) is flagged.
//   2. It MUST sit beside real source: its directory contains at least one non-`_test.go` `.go` file
//      (the package under test). A test with no package to exercise cannot be testing real code.
//
// Mutation testing + the labeled corpus + the mutation gate are the deep checks; this is the cheap,
// instant tripwire that runs in the CI `guards` job. Usage: node scripts/check-go-test-imports.mjs

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

// packages/core/format joins the list because the whole package exists to BE a conformance
// mirror: a test file there that asserts nothing would leave Go free to disagree with the
// table while reporting green, which is the one failure the mirror is built to make impossible.
const ROOTS = ["packages/core/verify", "packages/core/format", "apps/runner"];

/** Recursively collect *_test.go files under a dir. */
function goTestFiles(dir) {
	let out = [];
	let entries;
	try {
		entries = readdirSync(dir);
	} catch {
		return out;
	}
	for (const name of entries) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) out = out.concat(goTestFiles(p));
		else if (/_test\.go$/.test(name)) out.push(p);
	}
	return out;
}

/** True if the directory holds at least one non-test .go source file (the package under test). */
function hasSourceSibling(dir) {
	let entries;
	try {
		entries = readdirSync(dir);
	} catch {
		return false;
	}
	return entries.some((n) => /\.go$/.test(n) && !/_test\.go$/.test(n));
}

// A file declares a fail-by-assertion test entry point. Example* is deliberately
// EXCLUDED — Go example tests are validated by their `// Output:` comment, not by
// t.Error*, so requiring an assertion in them is a false positive.
const TEST_FUNC_RE = /func\s+(Test|Benchmark|Fuzz)[A-Z_0-9]/;
// A file contains a real, failing assertion (the thing that makes a test able to fail).
const ASSERT_RE =
	/\b[tbf]\.(Error|Errorf|Fatal|Fatalf|Fail|FailNow)\b|\b(require|assert)\.[A-Z]/;
// A shared assertion helper: `func check(t *testing.T, …)` style entrypoints delegate
// their assertions to a helper elsewhere in the package, so a Test that calls one is not
// vacuous even without an inline t.Error. Scan the package's other _test.go files too.
const HELPER_ASSERT_RE = ASSERT_RE;

const offenders = [];
for (const root of ROOTS) {
	for (const file of goTestFiles(root)) {
		const src = readFileSync(file, "utf8");
		if (!hasSourceSibling(dirname(file))) {
			offenders.push([file, "no non-test .go source in its package (nothing real to exercise)"]);
			continue;
		}
		if (TEST_FUNC_RE.test(src) && !ASSERT_RE.test(src)) {
			// Before flagging, check whether a SAME-DIRECTORY (same Go package) _test.go holds
			// a shared assertion helper (table tests commonly factor assertions out). Same-dir
			// only — a helper in a subpackage is a different package and wouldn't apply.
			const dir = dirname(file);
			const pkgHasHelper = readdirSync(dir).some(
				(name) =>
					/_test\.go$/.test(name) &&
					join(dir, name) !== file &&
					HELPER_ASSERT_RE.test(readFileSync(join(dir, name), "utf8")),
			);
			if (!pkgHasHelper) {
				offenders.push([file, "declares a test but contains no assertion (t.Error*/t.Fatal*/require/assert) and no sibling assertion helper — it can never fail"]);
			}
		}
	}
}

if (offenders.length > 0) {
	console.error(`✗ ${offenders.length} Go test file(s) look vacuous:`);
	for (const [f, why] of offenders) console.error(`   ${f} — ${why}`);
	console.error(
		"\nA real Go test must live beside the package it tests and contain at least one assertion that can fail.",
	);
	process.exit(1);
}

console.log("✓ check-go-test-imports: every Go test file exercises a real package and can fail.");
