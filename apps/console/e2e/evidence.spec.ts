// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// E2E smoke for the org Evidence surface. A fresh OTP org has no environments, so
// `evidence-client.tsx` swaps the ENTIRE body for `EvidenceOnboarding`
// (components/evidence/evidence-empty.tsx) whenever `summary.environments === 0` — the filter
// toolbar, the posture table and the recorded-waivers panel are siblings of that branch and are
// not on the page at all in this state. Requires `pnpm dev:up` (console on :3000).
//
// WHY THIS FILE HAD TO BE REWRITTEN (#4059). Every one of its four assertions was wrong, and
// nothing was running to say so: this spec belongs to the `console` Playwright project, whose
// RUN_POSTURE in playwright.config.ts is `null` — no workflow job invokes it. It waited for
//   • an "Org evidence" eyebrow, a string that exists nowhere in apps/console any more;
//   • the filter toolbar's placeholder and the "Recorded waivers" panel, both real components
//     but both in the branch a zero-environment org never reaches;
//   • "No environments match these filters", which is `EvidenceNoMatch` — the OVER-FILTERED
//     empty state, not the zero-data one. A fresh org gets "No environments yet".
// The last two are the instructive pair: the copy of a state you are not in is still real copy,
// so grepping the repo for the string says "present" while the page says "absent".

import { test, expect } from "./fixtures/auth";

test.describe("Evidence surface", () => {
	test("renders the honest zero-environment onboarding state", async ({
		authedPage: page,
		orgSlug,
	}) => {
		await page.goto(`/${orgSlug}/~/evidence`);

		// The route rendered. Chrome, so it is present in BOTH branches — needed before any
		// `toHaveCount(0)` below, which a not-yet-rendered page would satisfy trivially.
		await expect(
			page.getByRole("navigation", { name: "breadcrumb" }),
		).toContainText("Evidence");

		// The zero-environment branch, by its own copy and its own call to action. (The CTA is a
		// `Button` rendering a `Link`, which keeps role=button — see evidence-empty.tsx.)
		await expect(page.getByText("No environments yet")).toBeVisible();
		await expect(
			page.getByRole("button", { name: /create a project/i }),
		).toBeVisible();

		// The posture surfaces belong to the other branch. Asserting they are ABSENT is what makes
		// this a test of the onboarding state rather than of "some evidence page rendered".
		await expect(
			page.getByPlaceholder(/Filter by project or environment/i),
		).toHaveCount(0);
		await expect(page.getByText("Recorded waivers")).toHaveCount(0);
		await expect(
			page.getByText(/No environments match these filters/i),
		).toHaveCount(0);
	});
});
