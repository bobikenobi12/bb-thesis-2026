// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The console half of the preview-lane hardening.
//
// `previewConfigSchema` is the ONLY validation between a user and `project_preview_config`, and it
// carried its own `apps_path` rule — a third one, looser than the shared `appsPathSchema` the
// placed-env lane uses. Its character class contained `/` and it let a segment start with `.`, so
// `../../etc` passed every clause and was stored. Its `namespace_prefix` rule was
// `/^[a-z0-9-]+$/` with a message calling it "a DNS-1123 label prefix", which accepted `-`, `--`
// and `a-`; a lone `-` rendered `namespace: -` in the vcluster arm of the ApplicationSet, which is
// not a well-formed YAML scalar.
//
// The authoritative guards are Go's (packages/core/argocd/preview_validate.go) — the API is
// reachable without the console, so this side exists to fail the user EARLY and legibly. These
// tests assert both directions: that the shapes are refused, and that the shapes the product needs
// still parse.

import { describe, expect, it } from "vitest";

import { previewConfigSchema } from "@/lib/validations/preview";

/** A minimal valid config; each case overrides one field. */
function base(): Record<string, unknown> {
	return {
		enabled: true,
		git_provider: "github",
		repo_owner: "acme",
		repo_name: "shop",
		apps_path: "deploy",
		placement_mode: "namespace",
		namespace_prefix: "preview",
	};
}

function parse(overrides: Record<string, unknown>) {
	return previewConfigSchema.safeParse({ ...base(), ...overrides });
}

/**
 * Parse and return the data, throwing with the issues when it fails.
 *
 * A plain throw rather than `expect(ok, message)`: this repo's vitest/valid-expect forbids the
 * message argument, and asserting inside an `if (r.success)` would make a parse failure pass the
 * assertion by never reaching it — the conditional-expect trap.
 */
function mustParse(overrides: Record<string, unknown>) {
	const r = parse(overrides);
	if (!r.success) throw new Error(`expected acceptance, got ${JSON.stringify(r.error.issues)}`);
	return r.data;
}

describe("previewConfigSchema — apps_path", () => {
	const refused = {
		"escapes the repo root": "../../etc",
		"is bare traversal": "..",
		"traverses mid-string": "a/../../b",
		"is absolute": "/etc/passwd",
		"has a trailing slash": "overlays/",
		"has a leading slash": "/overlays",
		"has a doubled slash": "a//b",
		"starts a segment with a dot": ".git/config",
		"is a URL": "https://github.com/x",
		"contains a backslash": "overlays\\dev",
		"contains a NUL": "overlays\u0000dev",
	};
	for (const [why, value] of Object.entries(refused)) {
		it(`refuses a path that ${why}`, () => {
			expect(parse({ apps_path: value }).success).toBe(false);
		});
	}

	const accepted = {
		"a simple directory": "deploy",
		"a nested overlay": "examples/online-boutique/overlays/dev-1",
		"dots inside a segment": "charts/my.app/v1",
		"underscores and hyphens": "over_lays/dev-1",
	};
	for (const [why, value] of Object.entries(accepted)) {
		it(`accepts ${why}`, () => {
			expect(mustParse({ apps_path: value }).apps_path).toBe(value);
		});
	}

	// The old rule mapped "" to "." and the column defaults to ".", so the behaviour is preserved
	// deliberately rather than by accident — and it matches what the three Go renderers default to.
	it("maps an empty path to the repository root", () => {
		expect(mustParse({ apps_path: "" }).apps_path).toBe(".");
	});

	it("maps an omitted path to the repository root", () => {
		expect(mustParse({ apps_path: undefined }).apps_path).toBe(".");
	});

	it("accepts an explicit dot", () => {
		expect(mustParse({ apps_path: "." }).apps_path).toBe(".");
	});
});

describe("previewConfigSchema — namespace_prefix", () => {
	const refused = {
		"is a lone dash": "-",
		"is only dashes": "---",
		"ends with a dash": "preview-",
		"starts with a dash": "-preview",
		"is uppercase": "Preview",
		"contains a slash": "a/b",
		"contains an underscore": "a_b",
		"leaves no room for the PR number": "a".repeat(56),
	};
	for (const [why, value] of Object.entries(refused)) {
		it(`refuses a prefix that ${why}`, () => {
			expect(parse({ namespace_prefix: value }).success).toBe(false);
		});
	}

	const accepted = {
		"a plain word": "preview",
		"a leading digit": "1preview",
		"an internal hyphen": "pr-preview",
		"a single character": "p",
		"the maximum length": "a".repeat(55),
	};
	for (const [why, value] of Object.entries(accepted)) {
		it(`accepts ${why}`, () => {
			expect(mustParse({ namespace_prefix: value }).namespace_prefix).toBe(value);
		});
	}

	it("allows the prefix to be omitted, so the renderer's default applies", () => {
		expect(parse({ namespace_prefix: undefined }).success).toBe(true);
	});
});

// Vacuity: if the schema ever stopped being reachable from this import, every `safeParse` above
// would throw rather than return, and a suite of refusals would still look like refusals.
describe("previewConfigSchema — the suite is not vacuous", () => {
	it("accepts the base config it derives every case from", () => {
		expect(mustParse({}).apps_path).toBe("deploy");
	});

	it("still refuses a placement of dedicated", () => {
		expect(parse({ placement_mode: "dedicated" }).success).toBe(false);
	});
});
