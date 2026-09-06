// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import {
	envHref,
	globalHref,
	orgHref,
	PERSONAL_ORG_SLUG,
	pickFreeSlug,
	projectGlobalHref,
	projectHref,
	projectSettingsHref,
	RESERVED_PROJECT_CHILD_SLUGS,
	RESERVED_SLUGS,
} from "@/lib/routing";

// `slugify` no longer lives here (it never did — this module re-exported it). Its tests are in
// tests/lib/slugify.test.ts, against @/lib/utils/slugify.

describe("pickFreeSlug", () => {
	it("returns the base when it's free", () => {
		expect(pickFreeSlug("acme", ["other"])).toBe("acme");
	});

	it("appends -2, -3 … to avoid collisions", () => {
		expect(pickFreeSlug("acme", ["acme"])).toBe("acme-2");
		expect(pickFreeSlug("acme", ["acme", "acme-2"])).toBe("acme-3");
	});

	it("ignores null entries in the taken list", () => {
		expect(pickFreeSlug("acme", [null, null])).toBe("acme");
	});
});

describe("href builders", () => {
	it("build the C2 drilldown paths", () => {
		expect(orgHref("acme")).toBe("/acme");
		expect(globalHref("acme", "settings/billing")).toBe("/acme/~/settings/billing");
		expect(envHref("acme", "api", "env-123")).toBe(
			"/acme/api/architecture?environment_id=env-123",
		);
		expect(projectSettingsHref("acme", "api", "activity")).toBe(
			"/acme/api/settings/activity",
		);
		// The project analogue of globalHref. Its `sub` is a RESERVED project-child segment, which
		// is what keeps it from colliding with an environment name.
		expect(projectGlobalHref("acme", "api", "jobs")).toBe("/acme/api/jobs");
		for (const sub of RESERVED_PROJECT_CHILD_SLUGS) {
			expect(projectGlobalHref("acme", "api", sub)).toBe(`/acme/api/${sub}`);
		}
	});

	it("targets a project's Architecture directly (not the bare /{org}/{project})", () => {
		// In-app project links point at the final destination so a client navigation never makes
		// Next's Router process the bare-URL server redirect mid-nav — that mid-nav redirect threw
		// "Rendered more hooks than during the previous render" on soft clicks (fine on hard reload).
		expect(projectHref("acme", "api")).toBe("/acme/api/architecture");
	});
});

describe("RESERVED_PROJECT_CHILD_SLUGS", () => {
	it("reserves 'settings' so it can't shadow the project settings route", () => {
		expect(RESERVED_PROJECT_CHILD_SLUGS).toContain("settings");
	});

	it("keeps a generated project slug off the reserved segments", () => {
		// createProject passes existing slugs + the reserved set to pickFreeSlug.
		expect(pickFreeSlug("settings", [...RESERVED_PROJECT_CHILD_SLUGS])).toBe("settings-2");
	});
});

describe("RESERVED_SLUGS", () => {
	it("reserves the personal scope and console route shadows", () => {
		expect(PERSONAL_ORG_SLUG).toBe("~");
		for (const s of ["~", "dashboard", "api", "auth", "docs", "blog", "home"]) {
			expect(RESERVED_SLUGS.has(s)).toBe(true);
		}
	});

	it("does not reserve an ordinary org slug", () => {
		expect(RESERVED_SLUGS.has("acme")).toBe(false);
	});
});
