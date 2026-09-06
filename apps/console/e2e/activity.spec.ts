// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// E2E: the Settings → Activity feed. Asserts the page-level wiring on a fresh authed org: the
// reusable filter bar renders, CSV export is gated on a fresh (Hobby) plan, and selecting a
// server-side filter drives a refetch (narrowing to denials — which a fresh org has none of —
// lands on the empty state). Run locally with `pnpm dev:up` + `pnpm -C apps/console run test:e2e`.
//
// Note: the bold actor/target rendering and the "Load more" trigger need seeded rows, so they
// are covered by the unit tests (tests/components/activity-feed.test.tsx) rather than here.

import { expect, test } from "./fixtures/auth";

test.describe("Activity page", () => {
	test("renders the filter bar and gates export on a fresh plan", async ({
		authedPage: page,
		orgSlug,
	}) => {
		await page.goto(`/${orgSlug}/~/settings/activity`);

		// The reusable filter bar the user liked.
		await expect(page.getByPlaceholder(/search actor, action or resource/i)).toBeVisible();
		await expect(page.getByRole("button", { name: /events/i })).toBeVisible();

		// CSV export is Enterprise-only; a fresh Hobby org sees it disabled.
		await expect(page.getByRole("button", { name: /export csv/i })).toBeDisabled();
	});

	test("narrowing to denials drives a server refetch to the empty state", async ({
		authedPage: page,
		orgSlug,
	}) => {
		await page.goto(`/${orgSlug}/~/settings/activity`);
		await expect(page.getByPlaceholder(/search actor, action or resource/i)).toBeVisible();

		// Open the event-type sheet and keep only denials — a fresh org has none.
		await page.getByRole("button", { name: /events/i }).click();
		const dialog = page.getByRole("dialog");
		await dialog.getByText("Denied", { exact: true }).click();
		await page.keyboard.press("Escape");

		await expect(page.getByText(/no activity matches these filters/i)).toBeVisible();
	});
});
