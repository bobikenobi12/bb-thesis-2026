// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// E2E — Projects domain: validation errors, delete guards, duplicate-name behavior, not-found and
// auth checks. Happy paths live in projects.spec.ts.
//
// Run (self-check):
//   REUSE_AUTH=1 E2E_BASE_URL=http://localhost:3100 DEV_CONSOLE_LOG=/tmp/alethia-qa-console.log \
//     E2E_WORKERS=1 E2E_RETRIES=1 npx playwright test e2e/flows/projects.negative.spec.ts \
//     --output=test-results/wf-projects-neg
//
// Isolation: uniquely-named seeds scoped to the persona org; no cleanupOrg (shared org during the
// parallel QA run).

import { test, expect } from "../fixtures/qa";
import { db } from "../helpers/db";
import { seedProject, type Owner } from "../helpers/seed";

/** The persona's Owner id tuple for seeding. */
function ownerId(s: { userId?: string; orgId?: string }): Owner {
	return { userId: s.userId!, orgId: s.orgId! };
}

test.describe("Projects — create validation", () => {
	test("empty name blocks 'Create empty project' with a required error", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}/~/new`);
		await owner.page.getByRole("button", { name: /create empty project/i }).click();
		await expect(owner.page.getByText(/project name is required/i)).toBeVisible({
			timeout: 15_000,
		});
		await expect(owner.page).toHaveURL(/\/~\/new(\?|$)/);
	});

	test("a symbols-only name is rejected (needs a letter or number)", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}/~/new`);
		await owner.page.getByLabel(/project name/i).fill("!!! @@@ ###");
		await owner.page.getByRole("button", { name: /create empty project/i }).click();
		await expect(
			owner.page.getByText(/enter at least one letter or number/i),
		).toBeVisible({ timeout: 15_000 });
	});

	test("'Create project' without a selected cloud surfaces a toast and stays on the form", async ({
		owner,
	}) => {
		await owner.page.goto(`/${owner.orgSlug}/~/new`);
		await owner.page.getByLabel(/project name/i).fill(`e2e-nocloud-${Date.now()}`);
		// No cloud selected → the manual create path errors rather than provisioning.
		await owner.page.getByRole("button", { name: /^create project$/i }).click();
		await expect(owner.page.getByText(/connected cloud|isn't connected|provisioning/i)).toBeVisible(
			{ timeout: 15_000 },
		);
		await expect(owner.page).toHaveURL(/\/~\/new(\?|$)/);
	});
});

test.describe("Projects — duplicate name behavior", () => {
	// INVERTED by #3145, and the old comment here is worth keeping as history: it read "the app
	// does NOT refuse a duplicate project name ... the orientation hint's 'should be refused' does
	// not match the implementation". The hint was right and the implementation has changed.
	// `projects_org_id_project_name_key` is UNIQUE on (org_id, lower(project_name)), and
	// insertProjectWithDefaultFabric refuses a taken name rather than deriving `api-2` behind the
	// user's back — the slug is derived and may be suffixed, the display name is theirs and is the
	// token `alethia project get <name>` addresses.
	//
	// Asserted on BEHAVIOUR (no navigation, no second project) rather than on the toast text.
	// configure-project.tsx surfaces the failure as `toast.error(err.message)`, but a Next server
	// action can redact a thrown Error's message in a production build, so the wording is not a
	// safe thing for an e2e run to key on. Staying put is the refusal, however it is worded.
	test("a duplicate display name is refused, and no second project is created", async ({
		owner,
	}) => {
		const name = `e2e-dupe-${Date.now()}`;
		const first = await seedProject(ownerId(owner), { name, status: "DRAFT" });
		await owner.page.goto(`/${owner.orgSlug}/~/new`);
		await owner.page.getByLabel(/project name/i).fill(name);
		await owner.page.getByRole("button", { name: /create empty project/i }).click();

		// It must NOT navigate to a project. Given a generous window: passing this by being slow
		// would be indistinguishable from passing by being correct, so the wait is long enough
		// that a successful create would certainly have landed.
		await owner.page.waitForTimeout(5_000);
		await expect(owner.page).toHaveURL(/\/~\/new/);
		await expect(owner.page).not.toHaveURL(
			new RegExp(`/${owner.orgSlug}/${first.slug}(/|$)`),
		);
		// "AND NO SECOND PROJECT IS CREATED" — the half of this test's own name that nothing was
		// checking. Staying on the form is consistent with a refusal AND with a create that
		// succeeded while the redirect failed, and the two differ by exactly one row.
		const [{ count }] = await db()`
			select count(*)::int as count from projects
			where org_id = ${owner.orgId!} and lower(project_name) = lower(${name})
		`;
		expect(count).toBe(1);
	});

	test("a name differing only in CASE is refused too", async ({ owner }) => {
		// The index is on lower(project_name). A plain unique on the bare column would pass the
		// test above and fail this one, which is the difference the migration chose deliberately.
		const name = `e2e-case-${Date.now()}`;
		await seedProject(ownerId(owner), { name, status: "DRAFT" });
		await owner.page.goto(`/${owner.orgSlug}/~/new`);
		await owner.page.getByLabel(/project name/i).fill(name.toUpperCase());
		await owner.page.getByRole("button", { name: /create empty project/i }).click();
		await owner.page.waitForTimeout(5_000);
		await expect(owner.page).toHaveURL(/\/~\/new/);
	});
});

test.describe("Projects — delete guard on a live environment", () => {
	test("delete is refused while an environment is ACTIVE", async ({ owner }) => {
		const project = await seedProject(ownerId(owner), {
			name: `e2e-live-${Date.now()}`,
			status: "ACTIVE", // default env ACTIVE → in LIVE_ENV_STATUSES
		});
		await owner.page.goto(`/${owner.orgSlug}/${project.slug}/settings/general`);
		await owner.page.getByRole("button", { name: /^delete$/i }).click({ timeout: 15_000 });
		const dialog = owner.page.getByRole("alertdialog");
		await dialog.getByRole("button", { name: /delete project/i }).click();
		// Server refuses; an error toast surfaces and we stay on the settings page.
		await expect(owner.page.getByText(/live or in-flight/i)).toBeVisible({ timeout: 15_000 });
		await expect(owner.page).toHaveURL(/\/settings\/general/);
	});
});

test.describe("Projects — environment guards", () => {
	test("New Environment requires a name", async ({ owner }) => {
		const project = await seedProject(ownerId(owner), {
			name: `e2e-envguard-${Date.now()}`,
			status: "DRAFT",
		});
		await owner.page.goto(`/${owner.orgSlug}/${project.slug}/environments`);
		await owner.page.getByRole("button", { name: /new environment/i }).click();
		const dialog = owner.page.getByRole("dialog");
		// Submit with a blank name → a validation toast, and the dialog stays open.
		await dialog.getByRole("button", { name: /create environment/i }).click();
		await expect(owner.page.getByText(/environment name is required/i)).toBeVisible({
			timeout: 15_000,
		});
		await expect(dialog).toBeVisible();
	});
});

test.describe("Projects — not-found + auth", () => {
	test("an unknown project slug renders a not-found page", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}/no-such-project-${Date.now()}/architecture`);
		// notFound() → no design canvas; a 404 surface instead.
		await expect(owner.page.getByRole("button", { name: /^add$/i })).toHaveCount(0);
		// Assert the PROJECT copy, not any 404. The old `/not found|could not be found|404/i`
		// also matched `[org]/not-found.tsx`'s "Organization not found", which is exactly the
		// wrong answer #3880 fixed — so this spec passed both before and after and could not
		// tell a regression from a fix. `[project]/not-found.tsx` renders "Project not found".
		await expect(
			owner.page.getByText(/project not found/i).first(),
		).toBeVisible({ timeout: 15_000 });
	});

	test("project surfaces do not bounce an authenticated persona to /login", async ({ owner }) => {
		const project = await seedProject(ownerId(owner), {
			name: `e2e-auth-${Date.now()}`,
			status: "DRAFT",
		});
		for (const sub of ["architecture", "environments", "jobs", "clusters", "settings/general"]) {
			await owner.page.goto(`/${owner.orgSlug}/${project.slug}/${sub}`);
			await expect(owner.page, `sub=${sub}`).not.toHaveURL(/\/login/);
		}
	});
});
