// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Alerts hub — negative / gated paths: entitlement upsell for a Hobby org, endpoint
// verification failure on channel create (a channel never persists unverified), and the
// member permission surface (skipped until the member persona lands). Kept apart from the
// happy-path CRUD in alerts.spec.ts.

import { test, expect } from "../fixtures/qa";

const ALERTS = (org: string) => `/${org}/~/alerts`;

test.describe("Alerts — entitlement gating (Hobby)", () => {
	test("Hobby org sees the alerting upsell instead of the surface", async ({
		owner,
	}) => {
		await owner.page.goto(ALERTS(owner.orgSlug!));
		await expect(owner.page).not.toHaveURL(/\/login/);
		await expect(
			owner.page.getByRole("heading", { name: "Alerts & notifications" }),
		).toBeVisible({ timeout: 15_000 });
		await expect(owner.page.getByText("Available on the Pro plan.")).toBeVisible();
	});

	test("Hobby upsell exposes no channel/policy management controls", async ({
		owner,
	}) => {
		await owner.page.goto(ALERTS(owner.orgSlug!));
		await expect(
			owner.page.getByRole("heading", { name: "Alerts & notifications" }),
		).toBeVisible({ timeout: 15_000 });
		// The gated surface (and its Add channel / New policy actions) is not rendered.
		await expect(
			owner.page.getByRole("button", { name: "Add channel" }),
		).toHaveCount(0);
		await expect(
			owner.page.getByRole("button", { name: "New policy" }),
		).toHaveCount(0);
	});

	test("Hobby org never reaches the channels section heading", async ({ owner }) => {
		await owner.page.goto(ALERTS(owner.orgSlug!));
		await expect(
			owner.page.getByRole("heading", { name: "Alerts & notifications" }),
		).toBeVisible({ timeout: 15_000 });
		await expect(
			owner.page.getByRole("heading", { name: "Channels", exact: true }),
		).toHaveCount(0);
	});
});

test.describe("Alerts — channel verification failure", () => {
	test("webhook to an unreachable host fails verification and is not created", async ({
		team,
	}) => {
		await team.page.goto(ALERTS(team.orgSlug!));
		await expect(team.page).not.toHaveURL(/\/login/);
		await expect(
			team.page.getByRole("heading", { name: "Channels", exact: true }),
		).toBeVisible({ timeout: 15_000 });

		await team.page.getByRole("button", { name: "Add channel" }).first().click();
		const sheet = team.page.getByRole("dialog");
		await sheet.getByRole("button", { name: /^Webhook/ }).click();

		const name = `e2e-badhook-${Date.now()}`;
		await sheet.getByLabel("Name", { exact: true }).fill(name);
		// A syntactically valid but non-resolvable host → verify throws → friendly error.
		await sheet
			.getByLabel("Payload URL", { exact: true })
			.fill(`https://nonexistent-${Date.now()}.alethia-e2e.invalid/hook`);
		await sheet.getByRole("button", { name: "Add channel" }).click();

		// An inline error callout appears; the sheet stays open (nothing persisted).
		await expect(
			sheet.getByText(/Couldn't reach the endpoint|verification/i),
		).toBeVisible({ timeout: 20_000 });
		await expect(sheet.getByText("Add a channel")).toBeVisible();
	});
});

test.describe("Alerts — member permissions", () => {
	test("a reduced-permission member cannot manage channels", async ({ member }) => {
		await member.page.goto(ALERTS(member.orgSlug!));
		await expect(member.page).not.toHaveURL(/\/login/);
		await expect(
			member.page.getByRole("button", { name: "Add channel" }),
		).toHaveCount(0);
	});
});
