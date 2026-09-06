// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// `lib/typed-object.ts` is where this codebase's only two acknowledged `@ts-expect-error`s live
// (CLAUDE.md §6 bans `as`, and these helpers are how every call site stays cast-free). Nothing
// exercised it, so the assertion those helpers make about Object.keys/entries was never checked
// against the runtime at all.

import { describe, expect, it } from "vitest";

import { lookup, typedEntries, typedKeys, typedValues } from "@/lib/typed-object";

const RECORD = { aws: 1, gcp: 2, azure: 3 } as const;

describe("typedKeys / typedValues / typedEntries", () => {
	it("return the record's own keys, values and entries in insertion order", () => {
		expect(typedKeys(RECORD)).toEqual(["aws", "gcp", "azure"]);
		expect(typedValues(RECORD)).toEqual([1, 2, 3]);
		expect(typedEntries(RECORD)).toEqual([
			["aws", 1],
			["gcp", 2],
			["azure", 3],
		]);
	});

	it("are empty for an empty record rather than throwing", () => {
		expect(typedKeys({})).toEqual([]);
		expect(typedValues({})).toEqual([]);
		expect(typedEntries({})).toEqual([]);
	});
});

describe("lookup", () => {
	it("finds a value by a key the type system does not narrow", () => {
		// The point of the helper: `key` arrives as a plain string (a cloud slug off the wire),
		// and the value still comes back at its declared type without indexing by a broad key.
		const key: string = "gcp";
		expect(lookup(RECORD, key)).toBe(2);
	});

	it("returns undefined for an absent key instead of the first value", () => {
		expect(lookup(RECORD, "hetzner")).toBeUndefined();
		expect(lookup({}, "aws")).toBeUndefined();
	});

	it("does not answer with an inherited property", () => {
		// `Object.entries` is own-enumerable-only, and that is load-bearing: answering with
		// something off the prototype would hand a call site a value the record never carried.
		expect(lookup(RECORD, "toString")).toBeUndefined();
		expect(lookup(RECORD, "constructor")).toBeUndefined();
	});
});
