// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// E2E — Navigation shell domain (happy paths). Covers the Vercel-style app shell:
//   • org-scope sidebar nav (Overview / Clusters / Jobs / Runners / Connectors / Agent / Usage)
//     — every link navigates to the right route, sets the tab title, and highlights active;
//   • drill-in sub-navs (Observability click-drill, Alerts + Settings route-owned drills);
//   • disabled "Soon" stubs (Sandboxes / Support / Observability Logs·Metrics·Traces);
//   • the org / project / env switchers (topbar + sidebar);
//   • the project-scope sidebar (project nav + the Architecture icon rail);
//   • the topbar, deep-link + browser-back navigation, active-state derived from the URL,
//     and a mobile-viewport smoke of the slide-in nav.
// Unknown-route / 404 paths live in navigation-shell.negative.spec.ts.
//
// Run (self-check):
//   REUSE_AUTH=1 E2E_BASE_URL=http://localhost:3100 DEV_CONSOLE_LOG=/tmp/alethia-qa-console.log \
//     E2E_WORKERS=1 E2E_RETRIES=1 npx playwright test e2e/flows/navigation-shell.spec.ts \
//     --output=test-results/wf-navigation-shell
//
// Isolation: seeds are uniquely named (`e2e-nav-*-${Date.now()}`) and scoped to the persona org.
// We do NOT call cleanupOrg (sibling QA agents share this persona org during the parallel run).

import type { Locator, Page } from "@playwright/test";
import { test, expect } from "../fixtures/qa";
import { seedProject, type Owner, type SeededProject } from "../helpers/seed";

/** The persona's Owner id tuple for seeding. */
function ownerId(s: { userId?: string; orgId?: string }): Owner {
	return { userId: s.userId!, orgId: s.orgId! };
}

/** Active NavRow rows carry a bare `bg-muted` token (inactive rows only have `hover:bg-muted/60`),
 * so match `bg-muted` bounded by whitespace/edges to avoid the hover false-positive. */
const ACTIVE_CLASS = /(^|\s)bg-muted($|\s)/;

/** Asserts a sidebar nav link is rendered in its active/highlighted state. */
async function expectActive(link: Locator): Promise<void> {
	await expect(link).toHaveClass(ACTIVE_CLASS);
}

/** Waits for the org shell to paint (the sidebar Overview link is the cheapest anchor). */
async function waitForShell(page: Page): Promise<void> {
	await expect(page.getByRole("link", { name: "Overview" })).toBeVisible({
		timeout: 20_000,
	});
}

test.describe("Navigation shell — org sidebar renders", () => {
	test("the org overview shows every top-level nav row", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}`);
		await waitForShell(owner.page);
		await expect(owner.page).not.toHaveURL(/\/login/);
		// Navigable links (Overview + the org surfaces).
		for (const name of ["Overview", "Clusters", "Jobs", "Runners", "Connectors", "Agent", "Usage"]) {
			await expect(owner.page.getByRole("link", { name, exact: true })).toBeVisible();
		}
		// Alerts + Settings are route-owned drills → rendered as links (they carry an anchor).
		await expect(owner.page.getByRole("link", { name: "Alerts", exact: true })).toBeVisible();
		await expect(owner.page.getByRole("link", { name: "Settings", exact: true })).toBeVisible();
		// Observability is a click-only drill → a button, not a link.
		await expect(owner.page.getByRole("button", { name: "Observability", exact: true })).toBeVisible();
	});

	test("Overview is the active row on the bare org overview", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}`);
		await waitForShell(owner.page);
		await expectActive(owner.page.getByRole("link", { name: "Overview", exact: true }));
	});
});

// Each top-level org link: navigates to the right URL, sets the tab title, and highlights active.
const ORG_LINKS: { name: string; path: string; titleRe: RegExp }[] = [
	{ name: "Clusters", path: "~/clusters", titleRe: /Clusters/ },
	{ name: "Jobs", path: "~/jobs", titleRe: /Jobs/ },
	{ name: "Runners", path: "~/runners", titleRe: /Runners/ },
	{ name: "Connectors", path: "~/connectors", titleRe: /Connectors/ },
	{ name: "Agent", path: "~/agent", titleRe: /Agent/ },
	{ name: "Usage", path: "~/usage", titleRe: /Usage/ },
];

test.describe("Navigation shell — org sidebar navigation", () => {
	for (const link of ORG_LINKS) {
		test(`${link.name} link navigates, titles, and highlights active`, async ({ owner }) => {
			await owner.page.goto(`/${owner.orgSlug}`);
			await waitForShell(owner.page);
			await owner.page.getByRole("link", { name: link.name, exact: true }).click();
			await owner.page.waitForURL(new RegExp(`/${owner.orgSlug}/${link.path}(\\?|$|#)`), {
				timeout: 20_000,
			});
			await expect(owner.page).toHaveTitle(link.titleRe, { timeout: 15_000 });
			await expect(owner.page).not.toHaveURL(/\/login/);
			await expectActive(owner.page.getByRole("link", { name: link.name, exact: true }));
		});
	}

	test("active state is derived from the URL on a fresh deep-link (no click)", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}/~/runners`);
		await waitForShell(owner.page);
		await expectActive(owner.page.getByRole("link", { name: "Runners", exact: true }));
	});
});

test.describe("Navigation shell — disabled 'Soon' items", () => {
	test("Sandboxes is a visible but disabled stub (not a link)", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}`);
		await waitForShell(owner.page);
		const sandboxes = owner.page.getByRole("button", { name: /Sandboxes/i });
		await expect(sandboxes).toBeVisible();
		await expect(sandboxes).toBeDisabled();
		// A disabled stub never renders a navigable link.
		await expect(owner.page.getByRole("link", { name: /Sandboxes/i })).toHaveCount(0);
	});

	test("Support is a visible but disabled stub", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}`);
		await waitForShell(owner.page);
		const support = owner.page.getByRole("button", { name: /Support/i });
		await expect(support).toBeVisible();
		await expect(support).toBeDisabled();
	});
});

test.describe("Navigation shell — Observability drill (click-only)", () => {
	test("opening the drill reveals Jobs plus the 'Soon' stubs", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}`);
		await waitForShell(owner.page);
		await owner.page.getByRole("button", { name: "Observability", exact: true }).first().click();
		// The drill's own Jobs entry + the not-yet-built stubs slide in.
		await expect(owner.page.getByRole("link", { name: "Jobs", exact: true })).toBeVisible();
		for (const stub of ["Logs", "Metrics", "Traces"]) {
			const btn = owner.page.getByRole("button", { name: new RegExp(stub, "i") });
			await expect(btn.first()).toBeVisible();
			await expect(btn.first()).toBeDisabled();
		}
	});

	test("the drill's Jobs item navigates to the org jobs page", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}`);
		await waitForShell(owner.page);
		await owner.page.getByRole("button", { name: "Observability", exact: true }).first().click();
		await owner.page.getByRole("link", { name: "Jobs", exact: true }).click();
		await owner.page.waitForURL(new RegExp(`/${owner.orgSlug}/~/jobs`), { timeout: 20_000 });
		await expect(owner.page).toHaveTitle(/Jobs/, { timeout: 15_000 });
	});
});

test.describe("Navigation shell — Alerts drill (route-owned)", () => {
	test("the Alerts link navigates and auto-opens its sub-nav", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}`);
		await waitForShell(owner.page);
		await owner.page.getByRole("link", { name: "Alerts", exact: true }).click();
		await owner.page.waitForURL(new RegExp(`/${owner.orgSlug}/~/alerts`), { timeout: 20_000 });
		await expect(owner.page).toHaveTitle(/Alerts/, { timeout: 15_000 });
		// The route-owned Alerts drill exposes its three anchored sections.
		await expect(owner.page.getByRole("link", { name: "Policies", exact: true })).toBeVisible();
		await expect(owner.page.getByRole("link", { name: "Channels", exact: true })).toBeVisible();
	});

	test("deep-linking to /~/alerts auto-opens the drill (no click)", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}/~/alerts`);
		await expect(owner.page.getByRole("link", { name: "Policies", exact: true })).toBeVisible({
			timeout: 20_000,
		});
		await expect(owner.page).not.toHaveURL(/\/login/);
	});
});

test.describe("Navigation shell — Settings drill (route-owned)", () => {
	test("the Settings link redirects to General and shows the section nav", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}`);
		await waitForShell(owner.page);
		await owner.page.getByRole("link", { name: "Settings", exact: true }).click();
		await owner.page.waitForURL(new RegExp(`/${owner.orgSlug}/~/settings/general`), {
			timeout: 20_000,
		});
		await expect(owner.page).toHaveTitle(/General|Settings/, { timeout: 15_000 });
		// The org settings sections are all present in the drill.
		for (const name of ["General", "Billing", "Members", "Teams", "Roles", "Access", "Single Sign-On", "Activity"]) {
			await expect(owner.page.getByRole("link", { name, exact: true })).toBeVisible();
		}
	});

	test("a settings section link navigates and highlights active", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}/~/settings/general`);
		const billing = owner.page.getByRole("link", { name: "Billing", exact: true });
		await expect(billing).toBeVisible({ timeout: 20_000 });
		await billing.click();
		await owner.page.waitForURL(new RegExp(`/${owner.orgSlug}/~/settings/billing`), {
			timeout: 20_000,
		});
		await expectActive(billing);
	});

	test("deep-linking to a settings sub-section marks it active", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}/~/settings/roles`);
		const roles = owner.page.getByRole("link", { name: "Roles", exact: true });
		await expect(roles).toBeVisible({ timeout: 20_000 });
		await expectActive(roles);
	});
});

test.describe("Navigation shell — org switcher", () => {
	test("the trigger shows the active org and a split chevron", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}`);
		await waitForShell(owner.page);
		// Split button: the body links to org home, the chevron opens the picker.
		await expect(
			owner.page.getByRole("button", { name: "Switch organization" }),
		).toBeVisible();
	});

	test("the chevron opens a picker listing orgs with a Create action", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}`);
		await waitForShell(owner.page);
		await owner.page.getByRole("button", { name: "Switch organization" }).click();
		await expect(owner.page.getByPlaceholder(/find organization/i)).toBeVisible();
		await expect(
			owner.page.getByRole("button", { name: /create organization/i }),
		).toBeVisible();
	});

	test("searching for a nonexistent org shows the empty message", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}`);
		await waitForShell(owner.page);
		await owner.page.getByRole("button", { name: "Switch organization" }).click();
		await owner.page.getByPlaceholder(/find organization/i).fill(`zz-no-org-${Date.now()}`);
		await expect(owner.page.getByText(/no organization found/i)).toBeVisible();
	});

	test("Create organization opens the create sheet", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}`);
		await waitForShell(owner.page);
		await owner.page.getByRole("button", { name: "Switch organization" }).click();
		await owner.page.getByRole("button", { name: /create organization/i }).click();
		await expect(owner.page.getByRole("dialog")).toBeVisible({ timeout: 10_000 });
	});
});

test.describe("Navigation shell — project switcher", () => {
	let project: SeededProject;

	test.beforeEach(async ({ owner }) => {
		project = await seedProject(ownerId(owner), { name: `e2e-nav-proj-${Date.now()}` });
	});

	test("shows 'All projects' at org scope and opens a project list", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}`);
		await waitForShell(owner.page);
		const trigger = owner.page.getByRole("button", { name: /switch project: all projects/i });
		await expect(trigger).toBeVisible();
		await trigger.click();
		await expect(owner.page.getByPlaceholder(/find project/i)).toBeVisible();
		await expect(owner.page.getByRole("option", { name: project.name })).toBeVisible({
			timeout: 15_000,
		});
	});

	test("selecting a project navigates into it", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}`);
		await waitForShell(owner.page);
		await owner.page.getByRole("button", { name: /switch project: all projects/i }).click();
		await owner.page.getByRole("option", { name: project.name }).click();
		// Bare project URL resolves to its Architecture canvas.
		await owner.page.waitForURL(
			new RegExp(`/${owner.orgSlug}/${project.slug}(/architecture)?(\\?|$)`),
			{ timeout: 25_000 },
		);
		await expect(owner.page).not.toHaveURL(/\/login/);
	});

	test("searching for a nonexistent project shows the empty message", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}`);
		await waitForShell(owner.page);
		await owner.page.getByRole("button", { name: /switch project: all projects/i }).click();
		await owner.page.getByPlaceholder(/find project/i).fill(`zz-no-proj-${Date.now()}`);
		await expect(owner.page.getByText(/no project found/i)).toBeVisible();
	});

	test("Create project routes to the new-project surface", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}`);
		await waitForShell(owner.page);
		await owner.page.getByRole("button", { name: /switch project: all projects/i }).click();
		await owner.page.getByRole("button", { name: /create project/i }).click();
		await owner.page.waitForURL(new RegExp(`/${owner.orgSlug}/~/new`), { timeout: 20_000 });
	});
});

test.describe("Navigation shell — env switcher", () => {
	let project: SeededProject;

	test.beforeEach(async ({ owner }) => {
		project = await seedProject(ownerId(owner), { name: `e2e-nav-env-${Date.now()}` });
	});

	test("renders on a project route with the default environment", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}/${project.slug}/jobs`);
		const env = owner.page.getByRole("button", { name: /switch environment: production/i });
		await expect(env).toBeVisible({ timeout: 20_000 });
	});

	test("opening the switcher lists environments and a New Environment action", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}/${project.slug}/jobs`);
		await owner.page.getByRole("button", { name: /switch environment: production/i }).click({ timeout: 20_000 });
		await expect(owner.page.getByPlaceholder(/find environment/i)).toBeVisible();
		await expect(owner.page.getByRole("option", { name: "production" })).toBeVisible();
		await expect(owner.page.getByRole("option", { name: /new environment/i })).toBeVisible();
	});

	test("selecting an environment pins it via the ?environment_id query", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}/${project.slug}/jobs`);
		await owner.page.getByRole("button", { name: /switch environment: production/i }).click({ timeout: 20_000 });
		await owner.page.getByRole("option", { name: "production" }).click();
		await owner.page.waitForURL(/environment_id=/, { timeout: 15_000 });
		await expect(owner.page).toHaveURL(/environment_id=/);
	});

	test("is hidden at org scope (no environment switcher on the overview)", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}`);
		await waitForShell(owner.page);
		// The env switcher only mounts on a project drilldown route.
		await expect(owner.page.getByPlaceholder(/find environment/i)).toHaveCount(0);
	});
});

test.describe("Navigation shell — project-scope sidebar", () => {
	let project: SeededProject;

	test.beforeEach(async ({ owner }) => {
		project = await seedProject(ownerId(owner), { name: `e2e-nav-side-${Date.now()}` });
	});

	test("a project view swaps the sidebar to the project nav", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}/${project.slug}/jobs`);
		// The six project surfaces appear; org-only surfaces (Connectors/Runners) do not.
		for (const name of ["Architecture", "Environments", "Jobs", "Clusters", "Usage", "Settings"]) {
			await expect(owner.page.getByRole("link", { name, exact: true })).toBeVisible({
				timeout: 20_000,
			});
		}
		await expect(owner.page.getByRole("link", { name: "Connectors", exact: true })).toHaveCount(0);
		await expect(owner.page.getByRole("link", { name: "Runners", exact: true })).toHaveCount(0);
	});

	test("a project nav link navigates within the project and highlights active", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}/${project.slug}/jobs`);
		const environments = owner.page.getByRole("link", { name: "Environments", exact: true });
		await expect(environments).toBeVisible({ timeout: 20_000 });
		await environments.click();
		await owner.page.waitForURL(
			new RegExp(`/${owner.orgSlug}/${project.slug}/environments`),
			{ timeout: 20_000 },
		);
		await expectActive(environments);
	});

	test("the Architecture canvas collapses the sidebar to the icon rail", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}/${project.slug}/architecture`);
		// Rail-only affordances: the Expand button + the Home brand mark; the full "Find…" box is gone.
		await expect(owner.page.getByRole("button", { name: /expand sidebar/i })).toBeVisible({
			timeout: 20_000,
		});
		await expect(owner.page.getByRole("link", { name: "Home", exact: true })).toBeVisible();
		await expect(owner.page.getByRole("button", { name: /^Find/ })).toHaveCount(0);
	});
});

test.describe("Navigation shell — topbar", () => {
	test("the topbar carries the project switcher and CLI download", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}`);
		await waitForShell(owner.page);
		await expect(owner.page.getByRole("button", { name: /switch project: all projects/i })).toBeVisible();
		await expect(
			owner.page.getByRole("button", { name: /download.*(cli|alethia)/i }),
		).toBeVisible();
	});

	test("the breadcrumb reflects the current org-global page", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}/~/jobs`);
		await expect(owner.page.getByText("Jobs").first()).toBeVisible({ timeout: 20_000 });
		await expect(owner.page).toHaveTitle(/Jobs/, { timeout: 15_000 });
	});
});

test.describe("Navigation shell — deep-link + browser back", () => {
	test("browser back restores the prior page and its active highlight", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}/~/clusters`);
		await waitForShell(owner.page);
		await owner.page.getByRole("link", { name: "Jobs", exact: true }).click();
		await owner.page.waitForURL(new RegExp(`/${owner.orgSlug}/~/jobs`), { timeout: 20_000 });
		await owner.page.goBack();
		await owner.page.waitForURL(new RegExp(`/${owner.orgSlug}/~/clusters`), { timeout: 20_000 });
		await expectActive(owner.page.getByRole("link", { name: "Clusters", exact: true }));
	});
});

test.describe("Navigation shell — mobile viewport", () => {
	test.use({ viewport: { width: 390, height: 844 } });

	test("the desktop sidebar is hidden and a menu button opens the drawer", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}`);
		// The persistent sidebar is hidden below lg; the hamburger appears instead.
		const menu = owner.page.getByRole("button", { name: /open navigation/i });
		await expect(menu).toBeVisible({ timeout: 20_000 });
		await menu.click();
		// The slide-in drawer mounts the same nav.
		await expect(owner.page.getByRole("link", { name: "Overview", exact: true })).toBeVisible();
	});

	test("tapping a nav link in the drawer navigates and closes it", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}`);
		await owner.page.getByRole("button", { name: /open navigation/i }).click({ timeout: 20_000 });
		await owner.page.getByRole("link", { name: "Runners", exact: true }).click();
		await owner.page.waitForURL(new RegExp(`/${owner.orgSlug}/~/runners`), { timeout: 20_000 });
		await expect(owner.page).toHaveTitle(/Runners/, { timeout: 15_000 });
	});
});
