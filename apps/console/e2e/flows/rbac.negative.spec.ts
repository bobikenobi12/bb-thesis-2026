// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// RBAC — negative permission paths for a reduced-perm invited member.
//
// The `member` persona is REAL as of #3633: e2e/global-setup.ts invites it into ownerTeam's org
// through the product's own `organization/invite-member` → `accept-invitation` endpoints and reads
// its role back out of the `member` table. These assert the server-side PDP (requireAccessAdmin /
// owner-only) denials the UI otherwise renders optimistically.
//
// THERE IS NO `HAVE_MEMBER` GUARD ANY MORE, deliberately. It used to be `test.skip(!HAVE_MEMBER)`,
// and an unset variable turned every denial below into a green skip — the suite reported nothing
// and read as coverage. If the persona failed to be built, the `member` fixture now throws with the
// reason, and this file goes RED, which is the correct verdict for "the RBAC negatives did not
// run". `flows/_persona-integrity.spec.ts` is what proves the persona is genuinely distinct and
// genuinely reduced-permission before any denial here is believed.

import { test, expect } from "../fixtures/qa";

test.describe("RBAC — member permission denials", () => {
	test("a member can view the members list but cannot invite", async ({ member }) => {
		await member.page.goto(`/${member.orgSlug}/~/settings/members`);
		await expect(member.page).not.toHaveURL(/\/login/);
		await expect(member.page.getByText("Seats").first()).toBeVisible({ timeout: 15_000 });
		// A member either has no Invite affordance or the server rejects the invitation.
		await member.page.getByRole("button", { name: /invite member/i }).click();
		// Expect an authorization error toast rather than a sent invitation.
		await expect(member.page.getByText(/not authorized|permission|forbidden/i)).toBeVisible();
	});

	test("a member cannot change another member's role", async ({ member }) => {
		await member.page.goto(`/${member.orgSlug}/~/settings/members`);
		await expect(member.page.getByText("Seats").first()).toBeVisible({ timeout: 15_000 });
		const roleSelect = member.page.getByRole("combobox", { name: "Role" }).first();
		await roleSelect.click();
		await member.page.getByRole("option", { name: /viewer/i }).click();
		await expect(member.page.getByText(/not authorized|permission|forbidden/i)).toBeVisible();
	});

	test("a member cannot remove another member", async ({ member }) => {
		await member.page.goto(`/${member.orgSlug}/~/settings/members`);
		await expect(member.page.getByText("Seats").first()).toBeVisible({ timeout: 15_000 });
		await member.page.getByRole("button", { name: "Manage" }).first().click();
		await member.page.getByRole("menuitem", { name: /remove from organization/i }).click();
		await expect(member.page.getByText(/not authorized|permission|forbidden/i)).toBeVisible();
	});

	test("a member cannot delete the organization", async ({ member }) => {
		await member.page.goto(`/${member.orgSlug}/~/settings/general`);
		await expect(member.page.getByRole("heading", { name: "Danger zone" })).toBeVisible({
			timeout: 15_000,
		});
		await member.page.getByRole("button", { name: /^Delete$/ }).click();
		const dialog = member.page.getByRole("alertdialog");
		await dialog.getByRole("button", { name: /delete organization/i }).click();
		// Deletion must fail — the org stays and an error surfaces.
		await expect(member.page.getByText(/not authorized|permission|forbidden/i)).toBeVisible();
		await expect(member.page).not.toHaveURL(/\/dashboard$/);
	});
});
