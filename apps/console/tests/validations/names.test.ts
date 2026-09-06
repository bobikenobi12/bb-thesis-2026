// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Hand-written expectations for the two name grammars. Independent of the generated conformance
// table for the same reason tests/lib/slugify.test.ts is: that table is produced BY this code.

import { describe, expect, it } from "vitest";

import { RESERVED_PROJECT_CHILD_SLUGS } from "@/lib/routing";
import {
	ADDON_APP_NAME_PREFIX,
	ADDON_ID_MAX_LENGTH,
	DNS1123_LABEL_MAX_LENGTH,
	ENVIRONMENT_NAME_INPUT_MAX_LENGTH,
	ENVIRONMENT_NAME_MAX_LENGTH,
	RESERVED_ENVIRONMENT_NAMES,
	chartSlug,
	environmentNameProblem,
	environmentNameSchema,
	isDns1123Label,
	namespaceProblem,
	namespaceSchema,
	normalizeEnvironmentName,
} from "@/lib/validations/names";

/** The subset of `inputs` for which `holds` is false. Asserting this is `[]` names the offending
 *  input in the failure output, which `expect(...).toBe(true)` inside a loop does not — and
 *  eslint's valid-expect rule (rightly) refuses the second "message" argument that would. */
const failing = (inputs: readonly string[], holds: (v: string) => boolean): string[] =>
	inputs.filter((v) => !holds(v));

/** The namespace refusal message, matched by shape rather than restated in full at each site. */
const NOT_A_LABEL = /start and end with a letter or digit/;

describe("the namespace grammar", () => {
	it("accepts exactly what Kubernetes accepts", () => {
		const accepted = ["a", "1", "1dev", "12345", "a-b-c", "boutique-dev", "a".repeat(63)];
		expect(failing(accepted, (v) => namespaceProblem(v) === null)).toEqual([]);
		expect(failing(accepted, isDns1123Label)).toEqual([]);
	});

	it("refuses `dev-`, which the CLI route used to accept and Kubernetes does not", () => {
		expect(namespaceProblem("dev-")).toMatch(NOT_A_LABEL);
		expect(isDns1123Label("dev-")).toBe(false);
	});

	it("accepts `1dev`, which the console form used to refuse and Kubernetes does not", () => {
		expect(namespaceProblem("1dev")).toBeNull();
	});

	it("refuses the rest of what Kubernetes refuses", () => {
		const refused = ["-dev", "-", "Dev", "dev_1", "dev.1", "dev/1"];
		expect(failing(refused, (v) => NOT_A_LABEL.test(namespaceProblem(v) ?? ""))).toEqual([]);
		expect(namespaceProblem("")).toBe("Namespace is required");
		expect(namespaceProblem("a".repeat(64))).toMatch(/at most 63/);
		expect(DNS1123_LABEL_MAX_LENGTH).toBe(63);
	});

	it("refuses rather than repairs — the schema never rewrites the operator's namespace", () => {
		const ok = namespaceSchema.safeParse("boutique-dev");
		expect(ok.success && ok.data).toBe("boutique-dev");
		expect(namespaceSchema.safeParse("Boutique-Dev").success).toBe(false);
	});
});

describe("the environment-name rule", () => {
	it("normalizes rather than refusing what slugifying can fix", () => {
		expect(environmentNameProblem("Prod")).toBeNull();
		expect(normalizeEnvironmentName("Prod")).toBe("prod");
		expect(normalizeEnvironmentName("My Preview Env")).toBe("my-preview-env");
		// `dev-` is a namespace Kubernetes refuses, but as a NAME it slugs cleanly.
		expect(normalizeEnvironmentName("dev-")).toBe("dev");
		expect(normalizeEnvironmentName("Préprod")).toBe("preprod");
	});

	it("refuses a name that slugs away entirely", () => {
		const refused = ["", "!!!", "   "];
		expect(
			failing(refused, (v) => /at least one letter or number/.test(environmentNameProblem(v) ?? "")),
		).toEqual([]);
	});

	it("refuses every name a console route would permanently shadow", () => {
		// Asserted over the WHOLE reserved list, not a sample: a segment added to the console's
		// project drilldown must be refused the day it is added, and naming three of them here
		// would pass while the fourth silently became creatable.
		expect(RESERVED_ENVIRONMENT_NAMES.length).toBeGreaterThan(0);
		expect([...RESERVED_ENVIRONMENT_NAMES]).toEqual([...RESERVED_PROJECT_CHILD_SLUGS]);
		const isRefusedAsReserved = (v: string) =>
			/reserved by the console/.test(environmentNameProblem(v) ?? "");
		expect(failing(RESERVED_ENVIRONMENT_NAMES, isRefusedAsReserved)).toEqual([]);
		// And through the un-normalized spelling, which is how `project env add Settings` arrives.
		expect(
			failing(RESERVED_ENVIRONMENT_NAMES.map((v) => v.toUpperCase()), isRefusedAsReserved),
		).toEqual([]);
	});

	it("bounds the raw input instead of silently slugging a megabyte down to 40", () => {
		expect(environmentNameProblem("a".repeat(ENVIRONMENT_NAME_INPUT_MAX_LENGTH))).toBeNull();
		expect(environmentNameProblem("a".repeat(ENVIRONMENT_NAME_INPUT_MAX_LENGTH + 1))).toMatch(
			/at most 200 are read/,
		);
	});

	it("caps the stored slug at the environment budget", () => {
		const long = "staging environment for the european region";
		expect(normalizeEnvironmentName(long).length).toBeLessThanOrEqual(
			ENVIRONMENT_NAME_MAX_LENGTH,
		);
		expect(normalizeEnvironmentName(long)).toBe("staging-environment-for-the-european-reg");
	});

	it("parses to the STORED value, so a caller cannot forget to normalize", () => {
		const parsed = environmentNameSchema.safeParse("Prod");
		expect(parsed.success && parsed.data).toBe("prod");
		const refused = environmentNameSchema.safeParse("settings");
		expect(refused.success).toBe(false);
		if (!refused.success) {
			expect(refused.error.issues[0]?.message).toMatch(/reserved by the console/);
		}
	});
});

describe("chartSlug", () => {
	// Every id the PRE-#3665 implementation could store. It kept `-` inside its charset, trimmed
	// only the ends, and had no cap — so these are in `project_addons.addon_id` right now, and
	// `attachByoChart` / `detachByoChart` / `scanByoChart` all put the STORED id back through this
	// function to build their lookup key.
	const STORED_IDS = [
		"my-chart",
		"my---chart", // "My - Chart" under the old rule
		"bob-s-chart", // "Bob's chart" under the old rule
		"foo--bar",
		"a",
		"1",
		"a".repeat(70), // a 70-character display name under the old rule: no cap existed
	];

	it("is the IDENTITY on every id the old implementation could have stored", () => {
		// Not a nicety. `detachByoChart` deletes WHERE addon_id = chartSlug(input.id) and returns
		// { ok: true } regardless of the row count, so a key that no longer matches is a detach that
		// reports success and leaves the chart deploying; `scanByoChart` throws "Chart not found";
		// and a re-attach writes a SECOND row, and a second ArgoCD Application, for one chart.
		expect(failing(STORED_IDS, (id) => chartSlug(id) === id)).toEqual([]);
	});

	it("is idempotent, so re-deriving a key any number of times is safe", () => {
		const derived = ["My Chart", "Café Chart", "My - Chart", "Bob's chart", "A".repeat(200)].map(
			chartSlug,
		);
		expect(failing(derived, (id) => chartSlug(id) === id)).toEqual([]);
	});

	it("slugifies a DISPLAY name, which is where the fold and the collapse belong", () => {
		expect(chartSlug("My Chart")).toBe("my-chart");
		expect(chartSlug("Café Chart")).toBe("cafe-chart");
		expect(chartSlug("My - Chart")).toBe("my-chart");
	});

	it("caps a derived id so `addon-<id>` keeps a valid instance label", () => {
		// An uppercase name is NOT already an id, so it goes down the slugifying branch — which is
		// the only branch the cap applies to.
		const id = chartSlug("A".repeat(200));
		expect(id.length).toBe(ADDON_ID_MAX_LENGTH);
		expect(`${ADDON_APP_NAME_PREFIX}${id}`.length).toBeLessThanOrEqual(DNS1123_LABEL_MAX_LENGTH);
		expect(isDns1123Label(`${ADDON_APP_NAME_PREFIX}${id}`)).toBe(true);
	});

	it("does NOT cap an id that already exists, because that id is a key", () => {
		const stored = "a".repeat(70);
		expect(chartSlug(stored)).toBe(stored);
		expect(stored.length).toBeGreaterThan(ADDON_ID_MAX_LENGTH);
	});

	it("falls back to `chart` rather than an empty add-on id", () => {
		expect(chartSlug("")).toBe("chart");
		expect(chartSlug("***")).toBe("chart");
	});
});
