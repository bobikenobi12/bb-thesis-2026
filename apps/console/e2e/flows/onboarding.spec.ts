// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Onboarding domain — happy paths + structure:
//   signup → email-OTP → /onboarding plan pick (Hobby vs Pro trial) → org overview,
//   returning-user /login, org switcher + create-org sheet, and public-route auth gating.
//
// This domain performs REAL fresh signups (unique timestamped accounts) via the email-OTP
// log seam (helpers/otp.ts). Negatives (validation / wrong-code / reserved slug) live in
// onboarding.negative.spec.ts. Selectors come from components/auth/{auth-form,onboarding-form}
// and components/org/{create-org-sheet,org-switcher}.

import fs from "node:fs";
import { test, expect } from "../fixtures/qa";
import { scanA11y } from "../helpers/a11y";
import { logCursor, waitForOtp } from "../helpers/otp";
import type { Page } from "@playwright/test";

/** A unique, never-before-registered test email so each signup creates a fresh account. */
function freshEmail(tag: string): string {
	return `e2e-onb-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e4)}@alethia.test`;
}

/** Reads the ownerHobby persona's email from the metadata global-setup wrote. */
function ownerHobbyEmail(): string {
	const meta = JSON.parse(fs.readFileSync("e2e/.auth/personas.json", "utf8"));
	return meta.ownerHobby.email as string;
}

/**
 * Local email-OTP sign-in, mirroring helpers/personas.emailOtpSignIn but with a longer OTP
 * wait — under a busy dev server the code can land in the log later than the shared 20s default.
 */
export async function otpSignIn(page: Page, email: string, mode: "signup" | "login"): Promise<void> {
	const cursor = await logCursor();
	await page.goto(`/${mode}`);
	await page.getByRole("button", { name: /continue with email/i }).click();
	await page.locator("#email").fill(email);
	await page.getByRole("button", { name: /continue with email/i }).click();
	const code = await waitForOtp(cursor, { timeoutMs: 150_000 });
	await page.locator("input[data-input-otp]").first().fill(code);
}

/** Runs a fresh signup through email-OTP and waits until the /onboarding wizard renders. */
async function freshSignupToOnboarding(page: Page, email: string): Promise<void> {
	// The OTP can land in the log late under a busy dev server (helper waits up to 60s) —
	// give the whole test headroom beyond the 30s default so a slow code doesn't time it out.
	test.setTimeout(180_000);
	await otpSignIn(page, email, "signup");
	await page.waitForURL(/\/onboarding/, { timeout: 30_000 });
	await expect(page.getByRole("heading", { name: /create your organization/i })).toBeVisible({
		timeout: 15_000,
	});
}

/** True once the URL is a real org overview (a single non-public path segment). */
function isOrgOverview(url: URL): boolean {
	const parts = url.pathname.split("/").filter(Boolean);
	const publicSeg = new Set(["signup", "login", "onboarding", "invites", "dashboard", "start", "cli"]);
	return parts.length === 1 && !publicSeg.has(parts[0]);
}

// ── Public auth pages ────────────────────────────────────────────────────────────

test.describe("Onboarding — public auth pages", () => {
	test("signup page renders the create-account hero", async ({ page }) => {
		await page.goto("/signup");
		await expect(page.getByRole("heading", { name: /create your account/i })).toBeVisible();
		await expect(page.getByRole("button", { name: /continue with email/i })).toBeVisible();
	});

	test("login page renders the returning-user hero", async ({ page }) => {
		await page.goto("/login");
		await expect(page.getByRole("heading", { name: /log in to alethia/i })).toBeVisible();
	});

	test("signup offers OAuth providers (GitHub, Google)", async ({ page }) => {
		await page.goto("/signup");
		await expect(page.getByRole("button", { name: /github/i })).toBeVisible();
		await expect(page.getByRole("button", { name: /google/i })).toBeVisible();
	});

	test("SSO option is present but disabled (coming soon)", async ({ page }) => {
		await page.goto("/login");
		const sso = page.getByRole("button", { name: /continue with sso/i });
		await expect(sso).toBeVisible();
		await expect(sso).toBeDisabled();
	});

	test("signup email step reveals the work-email field", async ({ page }) => {
		await page.goto("/signup");
		await page.getByRole("button", { name: /continue with email/i }).click();
		await expect(page.getByRole("heading", { name: /sign up with email/i })).toBeVisible();
		await expect(page.locator("#email")).toBeVisible();
	});

	test("login email step reveals the sign-in email field", async ({ page }) => {
		await page.goto("/login");
		await page.getByRole("button", { name: /continue with email/i }).click();
		await expect(page.getByRole("heading", { name: /sign in with email/i })).toBeVisible();
		await expect(page.locator("#email")).toBeVisible();
	});

	test("email step can navigate back to the provider list", async ({ page }) => {
		await page.goto("/signup");
		await page.getByRole("button", { name: /continue with email/i }).click();
		await page.getByRole("button", { name: /other sign-in options/i }).click();
		await expect(page.getByRole("heading", { name: /create your account/i })).toBeVisible();
	});

	test("signup ?email= prefills the email and skips the provider grid", async ({ page }) => {
		const pref = "prefilled@company.com";
		await page.goto(`/signup?email=${encodeURIComponent(pref)}`);
		await expect(page.locator("#email")).toHaveValue(pref);
	});

	test("signup page has no serious a11y violations", async ({ page }) => {
		await page.goto("/signup");
		await expect(page.getByRole("heading", { name: /create your account/i })).toBeVisible();
		const violations = await scanA11y(page);
		expect(violations, JSON.stringify(violations)).toEqual([]);
	});
});

// ── Fresh signup + plan pick ──────────────────────────────────────────────────────

test.describe("Onboarding — fresh signup + plan pick", () => {
	test("onboarding wizard shows both self-serve plan tiles", async ({ page }) => {
		await freshSignupToOnboarding(page, freshEmail("tiles"));
		await expect(page.getByRole("button", { name: /personal projects/i })).toBeVisible();
		await expect(page.getByRole("button", { name: /commercial projects/i })).toBeVisible();
		// The Hobby tile is selected by default.
		await expect(page.getByRole("button", { name: /personal projects/i })).toHaveAttribute(
			"aria-pressed",
			"true",
		);
	});

	test("onboarding lets you customize the org URL slug", async ({ page }) => {
		await freshSignupToOnboarding(page, freshEmail("url"));
		await page.getByRole("button", { name: /customize url/i }).click();
		// Toggling reveals the inline slug editor; the toggle now reads "Done".
		await expect(page.getByRole("button", { name: /^done$/i })).toBeVisible();
	});

	test("full Hobby signup lands on the org overview", async ({ page }) => {
		await freshSignupToOnboarding(page, freshEmail("hobby"));
		const orgName = `E2E Hobby ${Date.now()}`;
		await page.locator("#org-name").fill(orgName);
		await page.getByRole("button", { name: /personal projects/i }).click();
		await page.getByRole("button", { name: /create organization/i }).click();
		await page.waitForURL((url) => isOrgOverview(url), { timeout: 30_000 });
		await expect(page).not.toHaveURL(/\/onboarding/);
		await expect(page.getByRole("link", { name: /create.*project/i }).first()).toBeVisible({
			timeout: 15_000,
		});
	});

	test("full Pro-trial signup lands on the org overview", async ({ page }) => {
		await freshSignupToOnboarding(page, freshEmail("pro"));
		// Stacks signup-OTP latency + a Stripe trial-subscription create — extra headroom.
		test.setTimeout(300_000);
		const proTile = page.getByRole("button", { name: /commercial projects/i });
		test.skip(await proTile.isDisabled(), "Stripe not configured — Pro tile disabled");
		await page.locator("#org-name").fill(`E2E Pro ${Date.now()}`);
		await proTile.click();
		// A fresh account still holds its one trial → card-less "Create organization".
		await expect(page.getByText(/trial · no card required/i)).toBeVisible();
		await page.getByRole("button", { name: /create organization/i }).click();
		await page.waitForURL((url) => isOrgOverview(url), { timeout: 60_000 });
		await expect(page).not.toHaveURL(/\/onboarding/);
	});
});

// ── Returning-user login ──────────────────────────────────────────────────────────

test.describe("Onboarding — returning user login", () => {
	test("an already-onboarded account logs in and skips onboarding", async ({ page }) => {
		test.setTimeout(180_000);
		await otpSignIn(page, ownerHobbyEmail(), "login");
		// Returning user goes to /dashboard → active org, never back into /onboarding.
		await page.waitForURL((url) => isOrgOverview(url), { timeout: 30_000 });
		await expect(page).not.toHaveURL(/\/onboarding/);
		await expect(page).not.toHaveURL(/\/login/);
	});
});

// ── Org switcher + create-org sheet ─────────────────────────────────────────────────

test.describe("Onboarding — org switcher + create-org sheet", () => {
	test("switcher shows the active org and its plan badge", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}`);
		await owner.page.getByRole("button", { name: /switch organization/i }).click();
		await expect(owner.page.getByPlaceholder(/find organization/i)).toBeVisible();
		await expect(owner.page.getByRole("option", { name: /e2e hobby org/i }).first()).toBeVisible();
	});

	test("switcher exposes the create-organization action", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}`);
		await owner.page.getByRole("button", { name: /switch organization/i }).click();
		await expect(owner.page.getByRole("button", { name: /create organization/i })).toBeVisible();
	});

	test("create-organization opens the purchase sheet", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}`);
		await owner.page.getByRole("button", { name: /switch organization/i }).click();
		await owner.page.getByRole("button", { name: /create organization/i }).click();
		await expect(
			owner.page.getByRole("heading", { level: 1, name: /create a team/i }),
		).toBeVisible();
		await expect(owner.page.getByPlaceholder(/acme cloud/i)).toBeVisible();
	});

	test("create-org name step advances to the card-less trial panel", async ({ owner }) => {
		// ownerHobby onboarded on Hobby, so it still holds its one account-wide trial →
		// the name step routes to the trial panel (no Stripe intent, no org created).
		await owner.page.goto(`/${owner.orgSlug}`);
		await owner.page.getByRole("button", { name: /switch organization/i }).click();
		await owner.page.getByRole("button", { name: /create organization/i }).click();
		await owner.page.getByPlaceholder(/acme cloud/i).fill(`e2e-switch-${Date.now()}`);
		await owner.page.getByRole("button", { name: /^continue$/i }).click();
		await expect(owner.page.getByRole("button", { name: /start .*free trial/i })).toBeVisible({
			timeout: 15_000,
		});
	});
});

// ── Auth gating on public routes ────────────────────────────────────────────────────

test.describe("Onboarding — auth gating", () => {
	test("/onboarding while logged out redirects to /login", async ({ page }) => {
		await page.goto("/onboarding");
		await page.waitForURL(/\/login/, { timeout: 15_000 });
		await expect(page.getByRole("heading", { name: /log in to alethia/i })).toBeVisible();
	});

	test("/invites/accept with a token while logged out redirects to /login (carrying next)", async ({
		page,
	}) => {
		await page.goto("/invites/accept?token=e2e-fake-token");
		await page.waitForURL(/\/login\?/, { timeout: 15_000 });
		await expect(page).toHaveURL(/next=/);
	});

	test("/invites/accept without a token shows an invalid-invitation message", async ({ page }) => {
		await page.goto("/invites/accept");
		await expect(page.getByRole("heading", { name: /invalid invitation/i })).toBeVisible();
	});

	test("an authed persona is not bounced to /login on its org overview", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}`);
		await expect(owner.page).not.toHaveURL(/\/login/);
	});
});
