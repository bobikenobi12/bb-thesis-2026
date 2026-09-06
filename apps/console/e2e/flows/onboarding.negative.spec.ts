// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Onboarding domain — negatives: login of an unknown email, invalid email format, a wrong
// OTP code, a reserved / blank org slug, and blank-name validation in both the onboarding
// wizard and the create-org sheet. Real fresh signups where a code/onboarding is needed.

import { test, expect } from "../fixtures/qa";
import { logCursor, waitForOtp } from "../helpers/otp";
import type { Page } from "@playwright/test";

/** Email-OTP sign-in with a longer OTP wait (busy dev server logs the code late). */
async function otpSignIn(page: Page, email: string, mode: "signup" | "login"): Promise<void> {
	const cursor = await logCursor();
	await page.goto(`/${mode}`);
	await page.getByRole("button", { name: /continue with email/i }).click();
	await page.locator("#email").fill(email);
	await page.getByRole("button", { name: /continue with email/i }).click();
	const code = await waitForOtp(cursor, { timeoutMs: 150_000 });
	await page.locator("input[data-input-otp]").first().fill(code);
}

/** A unique, never-registered email so a login attempt genuinely hits the no-account branch. */
function unknownEmail(): string {
	return `e2e-noacct-${Date.now()}-${Math.floor(Math.random() * 1e4)}@alethia.test`;
}

/** A unique, valid signup email for onboarding-reaching negatives. */
function freshEmail(tag: string): string {
	return `e2e-neg-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e4)}@alethia.test`;
}

/** Drives /signup through the email step only, returning at the 6-digit code entry. */
async function signupToCodeStep(page: Page, email: string): Promise<void> {
	await page.goto("/signup");
	await page.getByRole("button", { name: /continue with email/i }).click();
	await page.locator("#email").fill(email);
	await page.getByRole("button", { name: /continue with email/i }).click();
	await expect(page.getByRole("heading", { name: /enter your code/i })).toBeVisible({
		timeout: 15_000,
	});
}

// ── /login gating ────────────────────────────────────────────────────────────────

test.describe("Onboarding negatives — login gating", () => {
	test("login with an unknown email shows the no-account screen (no silent signup)", async ({
		page,
	}) => {
		await page.goto("/login");
		await page.getByRole("button", { name: /continue with email/i }).click();
		await page.locator("#email").fill(unknownEmail());
		await page.getByRole("button", { name: /continue with email/i }).click();
		await expect(page.getByRole("heading", { name: /no account for this email/i })).toBeVisible({
			timeout: 15_000,
		});
		await expect(page.getByRole("button", { name: /create an account/i })).toBeVisible();
	});

	test("an invalid email format does not advance past the email step", async ({ page }) => {
		await page.goto("/signup");
		await page.getByRole("button", { name: /continue with email/i }).click();
		await page.locator("#email").fill("not-an-email");
		await page.getByRole("button", { name: /continue with email/i }).click();
		// HTML5 email validation blocks submit → still on the email step, never a code screen.
		await expect(page.getByRole("heading", { name: /sign up with email/i })).toBeVisible();
		await expect(page.getByRole("heading", { name: /enter your code/i })).toBeHidden();
	});
});

// ── OTP code errors ──────────────────────────────────────────────────────────────

test.describe("Onboarding negatives — OTP code", () => {
	test("a wrong 6-digit code is rejected with an inline error", async ({ page }) => {
		await signupToCodeStep(page, freshEmail("wrongotp"));
		await page.locator("input[data-input-otp]").first().fill("000000");
		await expect(page.getByText(/that code didn.t work/i)).toBeVisible({ timeout: 15_000 });
		// Still on the code step (not signed in / not onboarded).
		await expect(page).not.toHaveURL(/\/onboarding/);
	});

	test("the code step lets you go back to change the email", async ({ page }) => {
		await signupToCodeStep(page, freshEmail("changeemail"));
		await page.getByRole("button", { name: /use a different email/i }).click();
		await expect(page.getByRole("heading", { name: /sign up with email/i })).toBeVisible();
	});
});

// ── Onboarding wizard validation ───────────────────────────────────────────────────

test.describe("Onboarding negatives — wizard validation", () => {
	/** Fresh signup landed on /onboarding, ready for wizard-level assertions. */
	async function toOnboarding(page: Page, tag: string): Promise<void> {
		// A slow OTP (helper waits up to 60s) can exceed the 30s default — give headroom.
		test.setTimeout(180_000);
		await otpSignIn(page, freshEmail(tag), "signup");
		await page.waitForURL(/\/onboarding/, { timeout: 30_000 });
		await expect(page.getByRole("heading", { name: /create your organization/i })).toBeVisible({
			timeout: 15_000,
		});
	}

	test("a reserved slug is rejected", async ({ page }) => {
		await toOnboarding(page, "reserved");
		await page.locator("#org-name").fill(`E2E Reserved ${Date.now()}`);
		await page.getByRole("button", { name: /customize url/i }).click();
		// "docs" is a reserved console/sibling segment (lib/routing RESERVED_SLUGS).
		const slugBox = page.locator('input[autocomplete="off"]').last();
		await slugBox.fill("docs");
		await page.getByRole("button", { name: /create organization/i }).click();
		await expect(page.getByText(/reserved/i)).toBeVisible({ timeout: 15_000 });
		await expect(page).toHaveURL(/\/onboarding/);
	});

	test("a blank org name keeps the create button disabled", async ({ page }) => {
		await toOnboarding(page, "blankname");
		await page.locator("#org-name").fill("");
		await expect(page.getByRole("button", { name: /create organization/i })).toBeDisabled();
	});
});

// ── Create-org sheet validation ────────────────────────────────────────────────────

test.describe("Onboarding negatives — create-org sheet", () => {
	test("continuing with a blank team name surfaces a validation error", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}`);
		await owner.page.getByRole("button", { name: /switch organization/i }).click();
		await owner.page.getByRole("button", { name: /create organization/i }).click();
		await expect(
			owner.page.getByRole("heading", { level: 1, name: /create a team/i }),
		).toBeVisible();
		// Leave the name blank and submit the name step.
		await owner.page.getByRole("button", { name: /^continue$/i }).click();
		await expect(owner.page.getByText(/give your team a name/i)).toBeVisible({ timeout: 15_000 });
	});
});
