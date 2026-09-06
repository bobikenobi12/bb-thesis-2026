// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// E2E (negatives / empty states / validation) for Billing + Usage.
//   • Empty state: a fresh Hobby org has no plan history → "No plan history yet."
//   • Validation: the usage over-time quick-range accepts free-text; a garbage entry shows the
//     inline "Try …" error and does NOT change the window.
//   • Entitlement gating: a community (Hobby) org has no spend-control hard-cap toggle and no
//     Stripe manage-billing / transactions surfaces (canManage is false without a customer).
//
// `member` (reduced-perms) billing negatives are still unwritten. The persona itself EXISTS as of
// #3633 (e2e/global-setup.ts builds it via the real invite → accept flow); what is missing here is
// the spec, not the fixture — so this is a coverage gap to fill, not a blocked one.

import { expect, test } from "../fixtures/qa";

const billingPath = (slug: string) => `/${slug}/~/settings/billing`;
const usagePath = (slug: string) => `/${slug}/~/usage`;

// Shared QA console under parallel load — allow generous per-test time (see billing.spec.ts).
test.beforeEach(() => {
	test.setTimeout(120_000);
});

test.describe("Billing — empty & entitlement-gated (Hobby)", () => {
	test("a Hobby org with no plan changes shows the empty plan-history state", async ({
		owner,
	}) => {
		await owner.page.goto(billingPath(owner.orgSlug));
		await expect(owner.page.getByText("Plan history")).toBeVisible({ timeout: 30_000 });
		// The empty copy only appears after the (best-effort) plan-history fetch resolves.
		await expect(owner.page.getByText("No plan history yet.")).toBeVisible({
			timeout: 30_000,
		});
	});
});

test.describe("Usage — entitlement gating & range validation", () => {
	test("community org has no hard-cap toggle (spend control is a paid control)", async ({
		owner,
	}) => {
		await owner.page.goto(usagePath(owner.orgSlug));
		await expect(owner.page.getByText("Plan & limits")).toBeVisible({ timeout: 30_000 });
		// The hard-cap checkbox only renders for a non-community usage plan.
		await expect(owner.page.getByRole("checkbox")).toHaveCount(0);
	});

	test("community usage header offers upgrade, not Manage billing", async ({ owner }) => {
		await owner.page.goto(usagePath(owner.orgSlug));
		await expect(owner.page.getByText("Hobby plan")).toBeVisible({ timeout: 30_000 });
		await expect(owner.page.getByRole("link", { name: /manage billing/i })).toHaveCount(0);
	});

	test("an unparseable quick-range entry surfaces the inline error", async ({ team }) => {
		await team.page.goto(usagePath(team.orgSlug));
		await team.page.getByRole("button", { name: /last 7 days/i }).click();
		const input = team.page.getByPlaceholder("e.g. 10d, 2 weeks");
		await input.fill("not-a-real-range");
		await input.press("Enter");
		await expect(team.page.getByText(/Try "10d"/)).toBeVisible();
		// The popover stays open (rejected) — the trigger window is unchanged.
		await expect(input).toBeVisible();
	});
});
