// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Hand-written expectations for THE slugifier.
//
// Deliberately not driven from packages/core/names/testdata/name-cases.json: that table is
// GENERATED from this implementation, so a test reading it would assert that the code equals
// itself and would go green through any change at all. The table is the contract Go is held to;
// this file is the contract TypeScript is held to, and the two have to be written independently
// or neither is a check.

import { describe, expect, it } from "vitest";

import {
	SLUG_MAX_LENGTH,
	canSlugify,
	slugify,
	slugifyOrEmpty,
} from "@/lib/utils/slugify";

describe("slugifyOrEmpty", () => {
	it("lowercases, trims, and collapses non-alphanumeric runs to one dash", () => {
		expect(slugifyOrEmpty("  Acme Cloud  ")).toBe("acme-cloud");
		expect(slugifyOrEmpty("Foo___Bar!!Baz")).toBe("foo-bar-baz");
		expect(slugifyOrEmpty("--Hello  World--")).toBe("hello-world");
	});

	it("leaves a name that is already a slug alone", () => {
		expect(slugifyOrEmpty("acme-cloud")).toBe("acme-cloud");
		expect(slugifyOrEmpty("1dev")).toBe("1dev");
	});

	it("drops apostrophes instead of turning them into dashes", () => {
		expect(slugifyOrEmpty("bobikenobi12's Org")).toBe("bobikenobi12s-org");
		expect(slugifyOrEmpty("Bob’s Team")).toBe("bobs-team");
		expect(slugifyOrEmpty("Bobʼs Team")).toBe("bobs-team");
		expect(slugifyOrEmpty("Bob`s Team")).toBe("bobs-team");
	});

	it("folds accents to their base letters", () => {
		// The divergence #3665 is named after: Go dropped the rune and produced `caf`.
		expect(slugifyOrEmpty("café")).toBe("cafe");
		expect(slugifyOrEmpty("José's API")).toBe("joses-api");
		expect(slugifyOrEmpty("Zürich")).toBe("zurich");
		expect(slugifyOrEmpty("naïve coördination")).toBe("naive-coordination");
	});

	it("folds compatibility forms too, because the normalization is NFKD and not NFD", () => {
		expect(slugifyOrEmpty("oﬁce")).toBe("ofice"); // fi ligature
		expect(slugifyOrEmpty("ＡＢＣ")).toBe("abc"); // fullwidth A B C
		expect(slugifyOrEmpty("Klvin")).toBe("klvin"); // KELVIN SIGN
		expect(slugifyOrEmpty("İstanbul")).toBe("istanbul"); // I + combining dot above
	});

	it("turns a script it cannot fold into a separator, not into mojibake", () => {
		expect(slugifyOrEmpty("team \u{1F680} rocket")).toBe("team-rocket");
		expect(slugifyOrEmpty("中文")).toBe("");
	});

	it("returns an empty string when nothing slugifiable remains", () => {
		expect(slugifyOrEmpty("")).toBe("");
		expect(slugifyOrEmpty("@#$%")).toBe("");
		expect(slugifyOrEmpty("''")).toBe("");
		expect(slugifyOrEmpty("---")).toBe("");
	});

	it("caps at 63 by default — the DNS-1123 label limit", () => {
		expect(slugifyOrEmpty("a".repeat(80))).toBe("a".repeat(SLUG_MAX_LENGTH));
		expect(SLUG_MAX_LENGTH).toBe(63);
	});

	it("re-trims a trailing dash the cut exposes", () => {
		expect(slugifyOrEmpty("ab cd ef gh ij", 6)).toBe("ab-cd");
		expect(slugifyOrEmpty("my-very-long-project-name-here", 10)).toBe("my-very-lo");
		expect(slugifyOrEmpty("repo", 25)).toBe("repo");
	});
});

describe("slugify", () => {
	it("uses the fallback when the name slugs away entirely", () => {
		for (const raw of ["", "@#$%", "''", "---", "\u{1F680}", "中文"]) {
			expect(slugify(raw, "fallback")).toBe("fallback");
		}
	});

	it("does not use the fallback when the name slugs to something", () => {
		expect(slugify("Acme Cloud", "fallback")).toBe("acme-cloud");
	});

	it("slugifies the fallback too, so the result is always a legal label", () => {
		expect(slugify("", "Env For Café")).toBe("env-for-cafe");
		expect(slugify("", "A".repeat(80))).toBe("a".repeat(SLUG_MAX_LENGTH));
	});

	it("throws when the fallback ALSO slugs to nothing, rather than returning ''", () => {
		expect(() => slugify("@#$", "!!!")).toThrow(/slugs to nothing/);
	});
});

describe("canSlugify", () => {
	it("answers the question a form refinement is asking", () => {
		expect(canSlugify("Acme")).toBe(true);
		expect(canSlugify("1")).toBe(true);
		expect(canSlugify("@#$%")).toBe(false);
		expect(canSlugify("")).toBe(false);
	});
});
