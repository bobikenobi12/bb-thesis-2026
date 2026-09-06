// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the formatter conformance generator (#4174).
 *
 * The generator had no test file at all, and both defects this suite exists for were in branches
 * that only run when something is WRONG — the half of a guard nobody exercises:
 *
 *   1. `zeroDecimalProblems` accepted a lowercase code. That code is INERT in TypeScript
 *      (`stripeChargeDivisor` uppercases the query, never the entries), and `conformance_test.go`
 *      used to normalise the artifact on read — so it became a code Go believed TypeScript had
 *      declared, and the guard told the reader to add it to `stripeZeroDecimalCharge`. Following
 *      that is the 100x-overstated invoice #4101 exists to prevent.
 *   2. `changedIds` walks `cases` and nothing else, so a regenerate whose only diff was
 *      `zeroDecimalCharge` printed `0 changed` with an EMPTY differ list, while ci.yml's
 *      `::error::` told the reader to go and read it.
 *
 * Two things are deliberately NOT done here:
 *
 *   - the expected messages are asserted on SUBSTRINGS a human wrote in this file, never on the
 *     generator's own output captured and pasted back. A test built out of the code it checks
 *     agrees with any bug they share;
 *   - the change summary is driven with hand-written before/after documents rather than by running
 *     the generator against the real artifact. The real artifact is what the CI diff-gate already
 *     compares; what is unproven is whether the SUMMARY can name a key outside `cases`, and a
 *     hand-written pair is the only way to ask that without a currency mutation in the tree.
 */

import { describe, expect, it } from "vitest";

import { changedIds, changedKeys, describeKeyChange, stringMembers, zeroDecimalProblems } from "../../scripts/gen-format-conformance";

/** The real set's shape, upper-case and sorted — the baseline every mutation below departs from. */
const OK = ["BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA", "PYG", "RWF", "VND", "VUV", "XAF", "XOF", "XPF"];

describe("the zero-decimal set refusals", () => {
	it("passes the set as it is actually written", () => {
		expect(zeroDecimalProblems(OK)).toEqual([]);
	});

	// ── #4174. The refusal that did not exist, and the reason it has to.
	it("refuses a lowercase code, naming it as published", () => {
		const problems = zeroDecimalProblems([...OK, "ugx"]);
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain("ugx");
		expect(problems[0]).toContain("not upper case");
	});

	// The message is the whole point of the issue, so it is asserted on rather than assumed. A
	// refusal that fired but still said "add it to the Go map" would be the same defect one layer up.
	it("does not tell the reader to add the inert code to Go's map", () => {
		const problems = zeroDecimalProblems([...OK, "ugx"]);
		expect(problems[0]).not.toContain("Add them there");
		expect(problems[0]).not.toContain("TypeScript treats");
		// And it says the true thing instead: the entry is inert on this side.
		expect(problems[0]).toContain("INERT");
	});

	// A lowercase spelling of a code the set ALREADY holds. This is the case that separates a real
	// case refusal from one satisfied by "the code is unknown to Go": both sides hold JPY.
	it("refuses a lowercased member for its CASE, not for its membership", () => {
		const problems = zeroDecimalProblems(OK.map((c) => (c === "JPY" ? "jpy" : c)));
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain("jpy");
		expect(problems[0]).toContain("not upper case");
	});

	// The case refusal must win over the sort refusal, which a lowercase code ALSO trips once it is
	// anywhere but the end of the array. Reordering the array does not fix an inert entry, so a
	// `got/want` line is the wrong instruction to hand somebody.
	it("reports the case, not the sort order, for a lowercase code in the middle", () => {
		const problems = zeroDecimalProblems(["BIF", "jpy", "XPF"]);
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain("not upper case");
		expect(problems[0]).not.toContain("is not sorted");
	});

	it("still refuses an empty set", () => {
		expect(zeroDecimalProblems([])).toHaveLength(1);
		expect(zeroDecimalProblems([])[0]).toContain("EMPTY");
	});

	it("still refuses an unsorted set of upper-case codes", () => {
		const problems = zeroDecimalProblems(["JPY", "BIF"]);
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain("not sorted");
	});
});

describe("the change summary outside `cases`", () => {
	const doc = (zero: string[], version = 2) => ({
		_doc: "GENERATED",
		version,
		excluded: { formatRelative: "a reason long enough to satisfy the Go side's forty-character floor" },
		zeroDecimalCharge: zero,
		cases: { money: [{ id: "m/1", want: "$1.00" }] },
	});

	// ── #4174. The exact reproduction from the issue: a set-only regenerate.
	it("names a code added to the set, where it used to report nothing at all", () => {
		const lines = changedKeys(doc(OK), doc([...OK.slice(0, 7), "KWD", ...OK.slice(7)]));
		expect(lines).toEqual(["~ zeroDecimalCharge: +KWD"]);
	});

	it("names a code removed from the set", () => {
		const lines = changedKeys(doc(OK), doc(OK.filter((c) => c !== "XPF")));
		expect(lines).toEqual(["~ zeroDecimalCharge: -XPF"]);
	});

	it("reports a reorder, which is a real change to a file whose value is its diff", () => {
		const lines = changedKeys(doc(OK), doc([...OK].reverse()));
		expect(lines).toEqual(["~ zeroDecimalCharge: same members, ORDER moved"]);
	});

	// Derived from the document's keys rather than from a hand-written list of them, so a key added
	// later is covered the day it is added. `version` is the proof, because nothing in `changedKeys`
	// mentions it.
	it("covers a non-`cases` key nobody enumerated, such as `version`", () => {
		const lines = changedKeys(doc(OK, 2), doc(OK, 3));
		expect(lines).toEqual(["~ version: 2 -> 3"]);
	});

	it("reports a top-level key appearing and disappearing", () => {
		const withKey: Record<string, unknown> = { ...doc(OK), extra: 1 };
		expect(changedKeys(doc(OK), withKey)[0]).toContain("+ extra");
		expect(changedKeys(withKey, doc(OK))[0]).toContain("- extra");
	});

	// `cases` stays out of this list — it is reported per row by changedIds, and reporting it twice
	// would make a one-row change look like two.
	it("leaves `cases` to changedIds", () => {
		const before = doc(OK);
		const after = { ...doc(OK), cases: { money: [{ id: "m/1", want: "$2.00" }] } };
		expect(changedKeys(before, after)).toEqual([]);
		expect(changedIds(before, after.cases)).toEqual(["~ m/1: $1.00 -> $2.00"]);
	});

	it("says nothing when nothing outside `cases` moved", () => {
		expect(changedKeys(doc(OK), doc(OK))).toEqual([]);
	});

	// A malformed or absent previous file indexes as empty, so every key reads as new rather than
	// as unchanged — the honest answer when there is nothing to compare against.
	//
	// ASSERTED BY VALUE, not with `.every()`. `[].every(...)` is TRUE, so the previous version of
	// this test passed on the exact regression it guards: `changedKeys` returning nothing at all,
	// which is #4174's whole subject. A predicate over a list is not a test that the list exists.
	it("treats an unreadable previous document as having no keys", () => {
		const lines = changedKeys(null, doc(OK));
		expect(lines.map((l) => l.split(":")[0])).toEqual([
			"+ _doc",
			"+ excluded",
			"+ version",
			"+ zeroDecimalCharge",
		]);
	});
});

describe("the value describers", () => {
	it("recognises an array of strings and rejects a mixed one", () => {
		expect(stringMembers(["A", "B"])).toEqual(["A", "B"]);
		expect(stringMembers(["A", 1])).toBeNull();
		expect(stringMembers("A")).toBeNull();
	});

	// ASSERTED EXACTLY. The three `toContain`/`not.toContain` checks this replaces were all
	// satisfied by the implementation they were written to reject: a dump reading
	// `~ excluded: {"a":"1","b":"2"} -> {"a":"1","b":"3"}` contains "excluded", contains "b", and
	// does NOT contain "a," — it contains `"a":`. A near-miss substring is not a contract.
	it("names the entries that moved inside an object rather than dumping it", () => {
		expect(describeKeyChange("excluded", { a: "1", b: "2" }, { a: "1", b: "3" })).toBe(
			"~ excluded: 1 entry moved — b",
		);
	});

	// The object branch had no ORDER case: `moved` came out empty and it printed
	// "0 entries moved — " with nothing after the dash, contradicting the count above it.
	it("names a KEY REORDER inside an object, which used to print a line naming nothing", () => {
		const line = describeKeyChange("excluded", { a: "1", b: "2" }, { b: "2", a: "1" });
		expect(line).toContain("KEY ORDER moved");
		expect(line).not.toContain("0 entr");
	});

	// `includes` cannot see a duplicate, so this reported "same members, ORDER moved" — false in
	// both halves, and every other layer (sortedness, case, TS equality, Go's map) is blind to it.
	it("names a DUPLICATED member rather than calling it a reorder", () => {
		const line = describeKeyChange("zeroDecimalCharge", ["JPY"], ["JPY", "JPY"]);
		expect(line).toBe("~ zeroDecimalCharge: ~JPY ×1→×2");
	});
});
