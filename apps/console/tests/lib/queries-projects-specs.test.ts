// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// `POST /api/cli/projects` parses `environments` with `environmentMatrixSchema` and hands the
// parsed matrix straight to `insertProjectWithDefaultFabric`, which validates it AGAIN. Two
// validators on one path is fine; two validators that DISAGREE is a 500 — the schema accepts the
// name, the fan-out throws, and the route's catch renders a server error for what is a bad request.
//
// That is what `alethia project create --env 1dev:namespace` did before #3665: the schema had
// dropped its leading-letter rule (Kubernetes accepts `1dev`) and the fan-out had not.

import { describe, expect, it } from "vitest";

import { environmentSpecProblem } from "@/lib/queries/projects";
import { environmentMatrixSchema } from "@/lib/validations/project-form.schema";

/** Every name/namespace pair worth asking both validators about, including the ones the two
 *  used to answer differently. */
const CORPUS: { name: string; namespace?: string | null }[] = [
	{ name: "prod" },
	{ name: "dev-1" },
	{ name: "1dev" }, // legal in Kubernetes; the fan-out's old rule refused it
	{ name: "12345" },
	{ name: "a" },
	{ name: "settings" }, // reserved by a console route
	{ name: "" },
	{ name: "!!!" },
	{ name: "a".repeat(41) }, // past the environment-name slug budget
	{ name: "dev", namespace: "boutique-dev" },
	{ name: "dev", namespace: "1dev" }, // same story on the namespace field
	{ name: "dev", namespace: "dev-" }, // Kubernetes refuses this one
	{ name: "dev", namespace: "Dev" },
	{ name: "dev", namespace: "a".repeat(64) },
	{ name: "dev", namespace: null },
];

/** What `environmentMatrixSchema` does with one spec: the stored name, or null when it refuses. */
function throughSchema(spec: { name: string; namespace?: string | null }): string | null {
	const parsed = environmentMatrixSchema.safeParse([
		{
			name: spec.name,
			stage: "development" as const,
			placement_mode: "namespace" as const,
			...(spec.namespace === undefined ? {} : { namespace: spec.namespace }),
		},
	]);
	return parsed.success ? parsed.data[0].name : null;
}

describe("the fan-out and the matrix schema answer alike", () => {
	it("has a corpus", () => {
		// The comparison below is a loop; an empty corpus would make every assertion in this file
		// vacuous while the file still reported green.
		expect(CORPUS.length).toBeGreaterThan(10);
	});

	it("never accepts in the schema what the fan-out then throws on", () => {
		// The asymmetry that matters: a spec the schema ACCEPTS reaches the fan-out, so the fan-out
		// refusing it is a 500. (The reverse — the fan-out being more permissive — is harmless: the
		// schema already rejected it with a 400.)
		const wouldBe500 = CORPUS.filter((spec) => {
			const stored = throughSchema(spec);
			if (stored === null) return false; // the schema refused it; the fan-out is never reached
			return environmentSpecProblem({ ...spec, name: stored }) !== null;
		});
		expect(wouldBe500).toEqual([]);
	});

	it("both accept `1dev`, the name the fan-out's own rule used to refuse", () => {
		expect(throughSchema({ name: "1dev" })).toBe("1dev");
		expect(environmentSpecProblem({ name: "1dev" })).toBeNull();
		expect(throughSchema({ name: "dev", namespace: "1dev" })).toBe("dev");
		expect(environmentSpecProblem({ name: "dev", namespace: "1dev" })).toBeNull();
	});

	it("both refuse a namespace Kubernetes refuses", () => {
		expect(throughSchema({ name: "dev", namespace: "dev-" })).toBeNull();
		expect(environmentSpecProblem({ name: "dev", namespace: "dev-" })).toMatch(
			/start and end with a letter or digit/,
		);
	});

	it("the fan-out still refuses a name that never went through the schema", () => {
		// It is the choke point for callers that did not parse the client input, so an un-normalized
		// name must not slip past it just because the schema would have fixed it.
		expect(environmentSpecProblem({ name: "Prod" })).toMatch(/already be normalized/);
		expect(environmentSpecProblem({ name: "settings" })).toMatch(/reserved by the console/);
		expect(environmentSpecProblem({ name: "!!!" })).toMatch(/at least one letter or number/);
	});
});
