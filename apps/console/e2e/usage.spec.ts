// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// E2E: the Usage page — that an authed user reaches it and the time-range filters drive the
// over-time section. Run locally with `pnpm dev:up` + `pnpm -C apps/console run test:e2e`.

import { expect, test } from "./fixtures/auth";

test.describe("Usage page", () => {
	test("renders the usage sections and the range filters", async ({ authedPage: page, orgSlug }) => {
		await page.goto(`/${orgSlug}/~/usage`);

		// The taxonomy sections render.
		await expect(page.getByText("Plan & limits")).toBeVisible();
		await expect(page.getByText("Usage over time")).toBeVisible();
		await expect(page.getByText("AI usage")).toBeVisible();

		// Both time-range filters are present (quick-range + precise).
		await expect(page.getByRole("button", { name: /last 7 days/i })).toBeVisible();
	});

	test("switching the quick range updates the trigger label", async ({ authedPage: page, orgSlug }) => {
		await page.goto(`/${orgSlug}/~/usage`);
		await page.getByRole("button", { name: /last 7 days/i }).click();
		await page.getByText("Last 30 days").click();
		await expect(page.getByRole("button", { name: /last 30 days/i })).toBeVisible();
	});
});
