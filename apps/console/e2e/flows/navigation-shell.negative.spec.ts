// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// E2E — Navigation shell, negative / not-found paths. Covers unknown routes under a *valid*
// org (an unknown project slug, an unknown project sub-page, an unknown org-global sub) and an
// unknown org slug entirely. All resolve to the branded ErrorState — never a redirect to /login
// for an authenticated user, and never a leaked 500.
//
// TWO DIFFERENT 404s, and the difference is the point of the last test here. An unknown org slug
// is thrown by `[org]/layout.tsx`, which is OUTSIDE the boundary `[org]/not-found.tsx` provides,
// so it is answered full-page by `(private)/not-found.tsx` ("Organization not found"). An unknown
// project or org-global sub-page is thrown BELOW that layout and is answered in-shell by
// `[org]/not-found.tsx` ("Not found"). The header here used to assert the opposite — "the org
// layout calls notFound() before the shell renders, so these resolve to the branded full-page
// 404" — and both halves of that were how #3891 stayed invisible.
//
// THIS FILE IS NOT THE GATE. The `qa` Playwright project (`flows/*.spec.ts`) does not run in CI —
// only `--project=hero` does — so the assertion below sat green-by-absence while a bad org slug
// rendered the root "Page not found" for months. The instrument that actually watches this is the
// layout boundary-escape invariant in `scripts/check-route-states.mjs`, which is a required check.
//
// Run (self-check):
//   REUSE_AUTH=1 E2E_BASE_URL=http://localhost:3100 DEV_CONSOLE_LOG=/tmp/alethia-qa-console.log \
//     E2E_WORKERS=1 E2E_RETRIES=1 npx playwright test e2e/flows/navigation-shell.negative.spec.ts \
//     --output=test-results/wf-navigation-shell-neg

import { test, expect } from "../fixtures/qa";

test.describe("Navigation shell — unknown routes (404)", () => {
	test("an unknown project slug renders the branded 404, not /login", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}/does-not-exist-${Date.now()}`);
		// The shared ErrorState: a 404 code line + a "Go home" action.
		await expect(owner.page.getByText("404", { exact: true })).toBeVisible({ timeout: 20_000 });
		await expect(owner.page.getByRole("link", { name: /go home/i })).toBeVisible();
		await expect(owner.page).not.toHaveURL(/\/login/);
	});

	test("an unknown project sub-page also 404s", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}/does-not-exist-${Date.now()}/jobs`);
		await expect(owner.page.getByText("404", { exact: true })).toBeVisible({ timeout: 20_000 });
		await expect(owner.page).not.toHaveURL(/\/login/);
	});

	test("an unknown org-global (~) sub-page 404s", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}/~/no-such-page-${Date.now()}`);
		await expect(owner.page.getByText("404", { exact: true })).toBeVisible({ timeout: 20_000 });
		await expect(owner.page).not.toHaveURL(/\/login/);
	});

	test("an unknown org slug renders the non-leaky org 404, not the root one", async ({ owner }) => {
		await owner.page.goto(`/e2e-no-such-org-${Date.now()}`);
		await expect(
			owner.page.getByRole("heading", { name: /organization not found/i }),
		).toBeVisible({ timeout: 20_000 });
		await expect(owner.page.getByRole("link", { name: /go home/i })).toBeVisible();
		// AND NOT the root app/not-found.tsx, which is what actually rendered before #3891. Its
		// heading is "Page not found" and it is the only 404 in the console carrying a "Sign in"
		// action — so a positive assertion on the org copy alone passes on the wrong page the
		// moment somebody renames a heading. Both halves are asserted for that reason.
		await expect(owner.page.getByRole("heading", { name: /^page not found$/i })).toHaveCount(0);
		await expect(owner.page.getByRole("link", { name: /sign in/i })).toHaveCount(0);
		await expect(owner.page).not.toHaveURL(/\/login/);
	});

	test("the 'Go home' action on a 404 returns to the app root", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}/does-not-exist-${Date.now()}`);
		const home = owner.page.getByRole("link", { name: /go home/i });
		await expect(home).toBeVisible({ timeout: 20_000 });
		await home.click();
		// Lands somewhere authenticated (org overview / root), not the 404 or /login.
		await expect(owner.page).not.toHaveURL(/does-not-exist/, { timeout: 20_000 });
		await expect(owner.page).not.toHaveURL(/\/login/);
	});
});
