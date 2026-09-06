// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from "vitest";
import { orgHost, orgUrl } from "@/lib/org-url";

const ORIGINAL = process.env.NEXT_PUBLIC_APP_URL;
afterEach(() => {
	if (ORIGINAL === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
	else process.env.NEXT_PUBLIC_APP_URL = ORIGINAL;
});

describe("orgHost", () => {
	it("derives the bare host from NEXT_PUBLIC_APP_URL", () => {
		process.env.NEXT_PUBLIC_APP_URL = "https://app.alethialabs.io";
		expect(orgHost()).toBe("app.alethialabs.io");
	});

	it("keeps the port for a localhost origin", () => {
		process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
		expect(orgHost()).toBe("localhost:3000");
	});

	it("falls back to the canonical brand host when unset", () => {
		delete process.env.NEXT_PUBLIC_APP_URL;
		expect(orgHost()).toBe("alethialabs.io");
	});

	it("strips a bare host out of a value `new URL` cannot parse", () => {
		// Not hypothetical: a self-host deployment that sets NEXT_PUBLIC_APP_URL to a bare host
		// (no scheme) throws in `new URL`, and the answer must still be a host rather than a crash
		// in every page that shows the org's URL.
		process.env.NEXT_PUBLIC_APP_URL = "console.internal.example/";
		expect(orgHost()).toBe("console.internal.example");
	});

	it("falls back to the brand host when the value carries no host at all", () => {
		process.env.NEXT_PUBLIC_APP_URL = "https://";
		expect(orgHost()).toBe("alethialabs.io");
	});
});

describe("orgUrl", () => {
	it("joins the host and slug", () => {
		process.env.NEXT_PUBLIC_APP_URL = "https://alethialabs.io";
		expect(orgUrl("acme")).toBe("alethialabs.io/acme");
	});
});
