// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The reserved `alethia_*` tfvar namespace, on the console side (#3670).
//
// The RULE's answers are already pinned end-to-end: the generator computes them by running
// `isNotReservedTfvarKey` and packages/core/validate is held to the result, so changing the
// predicate reds the codegen diff-gate and the Go conformance test. What none of that can see is
// the WIRING — whether the schemas a user's input actually flows through still apply the rule.
// Unwire it and every one of those checks stays green.
//
// Both entry points are covered because they are genuinely different doors: the dialog builds rows
// and the server action takes a `var_values` record straight off the wire (the CLI and the API post
// to it without ever rendering the form).

import { describe, expect, it } from "vitest";
import {
	iacSourceAttachSchema,
	iacVarKeySchema,
	iacVarRowSchema,
	isNotReservedTfvarKey,
	RESERVED_TFVAR_PREFIX,
} from "@/lib/validations/byo-iac";

const row = (key: string) => ({ key, kind: "string" as const, value: "x" });

describe("the reserved platform namespace", () => {
	it("is the prefix the runner drops", () => {
		expect(RESERVED_TFVAR_PREFIX).toBe("alethia_");
	});

	// CASE-SENSITIVE, matching `strings.HasPrefix(k, "alethia_")` in
	// provisioner.coerceByoVarValues. A case-insensitive mirror would refuse a key the runner
	// passes through as an ordinary customer variable — the console refusing input the server
	// accepts, which is the one direction of drift this lane exists to prevent.
	it.each([
		["a reserved key", "alethia_project_id", false],
		["the bare prefix", "alethia_", false],
		["a capitalised key, which the runner does NOT drop", "Alethia_project_id", true],
		["the prefix without its underscore", "alethiaproject", true],
		["an ordinary key", "region", true],
	])("%s", (_name, key, allowed) => {
		expect(isNotReservedTfvarKey(key)).toBe(allowed);
	});
});

describe("iacVarKeySchema", () => {
	it("refuses a reserved key", () => {
		expect(iacVarKeySchema.safeParse("alethia_project_id").success).toBe(false);
	});

	it("still accepts an ordinary key, so the refusal above is not blanket", () => {
		expect(iacVarKeySchema.safeParse("region").success).toBe(true);
	});

	it("keeps the tfvar grammar it already had", () => {
		expect(iacVarKeySchema.safeParse("9lives").success).toBe(false);
		expect(iacVarKeySchema.safeParse("").success).toBe(false);
	});
});

describe("the two doors a reserved key can arrive through", () => {
	it("the dialog's variable row refuses it", () => {
		expect(iacVarRowSchema.safeParse(row("alethia_project_id")).success).toBe(false);
		expect(iacVarRowSchema.safeParse(row("region")).success).toBe(true);
	});

	it("the server action's var_values record refuses it", () => {
		const attach = {
			repo_url: "https://github.com/acme/infra",
			var_values: { alethia_project_id: "spoofed" },
		};
		expect(iacSourceAttachSchema.safeParse(attach).success).toBe(false);

		// The same payload with an ordinary key parses, so the failure above is the KEY and not the
		// rest of the shape.
		expect(
			iacSourceAttachSchema.safeParse({ ...attach, var_values: { region: "eu-central-1" } }).success,
		).toBe(true);
	});

	it("accepts an attach with no var_values at all — the key rule must not make the field required", () => {
		expect(
			iacSourceAttachSchema.safeParse({ repo_url: "https://github.com/acme/infra" }).success,
		).toBe(true);
	});
});
