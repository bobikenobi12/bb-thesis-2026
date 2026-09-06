// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The one branch in #4133's tenant resolution that is decided by a STRING from another package.
//
// `lib/authz/org-scope.ts` reads the request path from a header, and swallows exactly one failure:
// `headers()` called with no request context — a script, a unit test, a module evaluated at build
// time. Everything else rethrows, because `return null` there means "the address names no org",
// which sends every reader back to `session.active_organization_id` — silently restoring the defect
// the module exists to remove.
//
// That distinction rests on matching Next's message. If a Next upgrade reworded it, the match would
// stop firing and a legitimate out-of-request call would start THROWING instead of falling back —
// the failure lands in the opposite direction from the usual one and would surface as a build-time
// or script crash far from here. So the string is pinned against the real Next source, the way
// `expected-request-error.test.ts` pins its own.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { isOutsideRequestScope } from "@/lib/authz/org-scope";

const require_ = createRequire(import.meta.url);

/** Next's own text for `headers()` outside a request, read from the installed package. */
function nextOutsideRequestMessage(): string {
	const entry = require_.resolve("next/package.json");
	const root = entry.slice(0, entry.lastIndexOf("/"));
	const src = readFileSync(
		`${root}/dist/server/app-render/work-unit-async-storage.external.js`,
		"utf8",
	);
	const m = /was called outside a request scope[^`"']*/.exec(src);
	if (!m) {
		throw new Error(
			"Next no longer emits `… was called outside a request scope` from " +
				"work-unit-async-storage.external.js. lib/authz/org-scope.ts matches that text to decide " +
				"whether a headers() failure is benign; re-read the new message and update it there.",
		);
	}
	return m[0];
}

describe("the headers() fallback is decided by Next's real message", () => {
	it("Next still says `was called outside a request scope`", () => {
		expect(nextOutsideRequestMessage()).toContain("was called outside a request scope");
	});

	// The real predicate, called with Next's own words rather than with words this repo chose.
	it("...and the real `isOutsideRequestScope` recognises it", () => {
		expect(isOutsideRequestScope(new Error(`\`headers\` ${nextOutsideRequestMessage()}`))).toBe(true);
	});

	// The direction that matters more. A matcher wide enough to swallow a REAL failure puts every
	// reader back on session-derived tenancy without a word.
	it("...and does NOT swallow an unrelated failure", () => {
		for (const other of [
			"connect ECONNREFUSED 127.0.0.1:5432",
			"Invariant: static generation store missing",
			"Route used `headers` inside a cached function",
		]) {
			expect(isOutsideRequestScope(new Error(other)), `swallowed: ${other}`).toBe(false);
		}
	});

	// It is handed whatever was thrown, which is not always an Error.
	it("...and survives a non-Error throw", () => {
		expect(isOutsideRequestScope("some string")).toBe(false);
		expect(isOutsideRequestScope(undefined)).toBe(false);
	});
});
