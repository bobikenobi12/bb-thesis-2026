// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The org switcher navigates to the CHOSEN org (#4133).
//
// It used to write the session and then `router.refresh()`, which re-renders the CURRENT url — and
// that url still names the org being switched away from. Already odd (the address bar disagreed
// with the switcher chip until the next click); once the tenant is read from the address rather
// than the session it is the whole gesture failing, because a refresh resolves straight back to the
// org you just left. The chip would read the new org while every server read stayed on the old one,
// which is the confusion #4133 exists to remove, arrived at from the other side.
//
// Only the DECISION is asserted here. The switcher's menu renders through a portal that needs
// layout, and jsdom has none — a component test clicks the trigger and never sees the item — so the
// `push` vs `refresh` wiring is two readable lines covered by the e2e path, and the part that
// carries the property is a pure function.

import { describe, expect, it } from "vitest";
import { switchTargetHref } from "@/components/org-switcher";

const ORGS = [
	{ id: "org-a", slug: "acme" },
	{ id: "org-b", slug: "beta" },
	{ id: "org-personal", slug: "~" },
];

describe("switchTargetHref", () => {
	it("is the chosen org's url, not the current one", () => {
		expect(switchTargetHref(ORGS, "org-b")).toBe("/beta");
	});

	it("...and the personal scope has a url too — the reserved `~` segment", () => {
		expect(switchTargetHref(ORGS, "org-personal")).toBe("/~");
	});

	// Null is what makes the caller fall back to a refresh. It must mean "there is nowhere to go",
	// never "the org you picked" — a wrong href here sends the user to another tenant's address.
	it("...and an org the workspace context does not carry has nowhere to go", () => {
		expect(switchTargetHref(ORGS, "org-unknown")).toBeNull();
	});
});
