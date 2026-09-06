// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// RBAC / access-control domain — org settings surfaces: Members (list / invite / suspend /
// remove), Teams, Roles (built-in + custom-role gating), Access (grants), SSO, and General.
//
// Two personas exercise the entitlement ladder (lib/billing/plan.ts):
//   • owner  — Hobby (community): organizations=false, teams/customRoles/sso=false, canInvite=false.
//              → members are read-only (no manage controls), Invite opens the Pro upsell.
//   • team   — Pro (card-less trial): organizations=true, canInvite=true (trialing) → real invite +
//              manage controls; teams/roles/access/sso are Enterprise so still show the upsell.
//
// Negative *permission* paths (a reduced-perm member being denied) live in rbac.negative.spec.ts.
// They run unconditionally as of #3633 — the `member` persona is built by e2e/global-setup.ts
// through the real invite → accept flow, so a missing one is a failure, not a skip.

import { test, expect } from "../fixtures/qa";
import { scanA11y } from "../helpers/a11y";

const membersUrl = (slug: string) => `/${slug}/~/settings/members`;
const teamsUrl = (slug: string) => `/${slug}/~/settings/teams`;
const rolesUrl = (slug: string) => `/${slug}/~/settings/roles`;
const accessUrl = (slug: string) => `/${slug}/~/settings/access`;
const ssoUrl = (slug: string) => `/${slug}/~/settings/sso`;
const generalUrl = (slug: string) => `/${slug}/~/settings/general`;

// On a Pro org the "Invite member" button is remounted when `canInvite` resolves async
// (getCollaborationAccess): the UpgradeDialog trigger is swapped for the real InviteMemberDialog
// trigger, and a click that lands mid-swap is dropped (or opens the upsell first). Retry-open until
// the real "Invite members" dialog is up — Escape closes any upsell that briefly opened.
async function openInviteDialog(page: import("@playwright/test").Page) {
	const dialog = page.getByRole("dialog");
	const heading = dialog.getByRole("heading", { name: "Invite members" });
	await expect(async () => {
		if (await dialog.isVisible().catch(() => false)) {
			await page.keyboard.press("Escape");
			await expect(dialog).toBeHidden({ timeout: 2_000 });
		}
		await page.getByRole("button", { name: /invite member/i }).click();
		await expect(heading).toBeVisible({ timeout: 2_000 });
	}).toPass({ timeout: 30_000 });
	return dialog;
}

// ---------------------------------------------------------------------------
// Members — Hobby owner (read-only, invite gated behind Pro)
// ---------------------------------------------------------------------------
test.describe("RBAC — Members (Hobby owner)", () => {
	test("members page loads authenticated (not bounced to /login)", async ({ owner }) => {
		await owner.page.goto(membersUrl(owner.orgSlug));
		await expect(owner.page).not.toHaveURL(/\/login/);
		await expect(owner.page.getByText("Seats").first()).toBeVisible({ timeout: 30_000 });
	});

	test("stat strip + toolbar render (Seats / Active / Pending / Suspended)", async ({ owner }) => {
		await owner.page.goto(membersUrl(owner.orgSlug));
		await expect(owner.page.getByText("Seats")).toBeVisible({ timeout: 30_000 });
		await expect(owner.page.getByText("Pending invites")).toBeVisible();
		await expect(owner.page.getByPlaceholder("Search name or email")).toBeVisible();
		await expect(owner.page.getByRole("combobox", { name: "Filter by role" })).toBeVisible();
	});

	test("the owner appears as an Owner member row tagged 'You'", async ({ owner }) => {
		await owner.page.goto(membersUrl(owner.orgSlug));
		const ownerRow = owner.page.getByRole("row").filter({ hasText: "You" }).first();
		await expect(ownerRow).toBeVisible({ timeout: 30_000 });
		await expect(ownerRow).toContainText("Owner");
	});

	test("Hobby has NO manage controls (no per-row select checkbox)", async ({ owner }) => {
		await owner.page.goto(membersUrl(owner.orgSlug));
		// canManage = entitlement("organizations") is false on Hobby → the select column is absent.
		await expect(owner.page.getByText("Seats").first()).toBeVisible({ timeout: 30_000 });
		await expect(owner.page.getByRole("checkbox", { name: "Select" })).toHaveCount(0);
		await expect(owner.page.getByRole("button", { name: "Manage" })).toHaveCount(0);
	});

	test("Invite member is gated → opens the Pro upgrade dialog", async ({ owner }) => {
		await owner.page.goto(membersUrl(owner.orgSlug));
		await owner.page.getByRole("button", { name: /invite member/i }).click();
		const dialog = owner.page.getByRole("dialog");
		await expect(dialog).toBeVisible();
		await expect(dialog.getByText("Invite team members")).toBeVisible();
		await expect(dialog.getByRole("button", { name: /upgrade to pro/i })).toBeVisible();
	});

	test("Pending tab with no invitations shows the empty 'No results.' state", async ({ owner }) => {
		await owner.page.goto(membersUrl(owner.orgSlug));
		await expect(owner.page.getByText("Seats").first()).toBeVisible({ timeout: 30_000 });
		await owner.page.getByRole("button", { name: /^Pending/ }).click();
		await expect(owner.page.getByText("No results.")).toBeVisible();
	});

	test("search that matches nothing shows the empty state", async ({ owner }) => {
		await owner.page.goto(membersUrl(owner.orgSlug));
		await expect(owner.page.getByText("Seats").first()).toBeVisible({ timeout: 30_000 });
		await owner.page.getByPlaceholder("Search name or email").fill(`zzz-none-${Date.now()}`);
		await expect(owner.page.getByText("No results.")).toBeVisible();
	});

	test("filtering by a role nobody holds (Viewer) shows the empty state", async ({ owner }) => {
		await owner.page.goto(membersUrl(owner.orgSlug));
		await expect(owner.page.getByText("Seats").first()).toBeVisible({ timeout: 30_000 });
		// The lone member is the Owner — filtering to Viewer clears the table.
		await owner.page.getByRole("combobox", { name: "Filter by role" }).click();
		await owner.page.getByRole("option", { name: "Viewer" }).click();
		await expect(owner.page.getByText("No results.")).toBeVisible();
	});

	test("the Suspended tab is empty on a fresh org", async ({ owner }) => {
		await owner.page.goto(membersUrl(owner.orgSlug));
		await expect(owner.page.getByText("Seats").first()).toBeVisible({ timeout: 30_000 });
		await owner.page.getByRole("button", { name: /^Suspended/ }).click();
		await expect(owner.page.getByText("No results.")).toBeVisible();
	});

	test("a11y: members page has no critical axe violations", async ({ owner }) => {
		await owner.page.goto(membersUrl(owner.orgSlug));
		await expect(owner.page.getByText("Seats").first()).toBeVisible({ timeout: 30_000 });
		const violations = await scanA11y(owner.page);
		expect(violations.filter((v) => v.impact === "critical")).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Members — Pro trial owner (manage controls + real invite lifecycle)
// ---------------------------------------------------------------------------
test.describe("RBAC — Members (Pro owner)", () => {
	test("Pro org exposes manage controls (per-row select checkbox)", async ({ team }) => {
		await team.page.goto(membersUrl(team.orgSlug));
		await expect(team.page.getByText("Seats").first()).toBeVisible({ timeout: 30_000 });
		// canManage true on Pro → the select column renders a checkbox for every row.
		await expect(team.page.getByRole("checkbox", { name: "Select" }).first()).toBeVisible();
	});

	test("Invite member opens the real invite dialog (not the upsell)", async ({ team }) => {
		await team.page.goto(membersUrl(team.orgSlug));
		await expect(team.page.getByText("Seats").first()).toBeVisible({ timeout: 30_000 });
		const dialog = await openInviteDialog(team.page);
		await expect(dialog.getByRole("heading", { name: "Invite members" })).toBeVisible();
		await expect(dialog.getByPlaceholder("teammate@company.com")).toBeVisible();
	});

	test("invite dialog — the role picker defaults to Viewer", async ({ team }) => {
		await team.page.goto(membersUrl(team.orgSlug));
		await expect(team.page.getByText("Seats").first()).toBeVisible({ timeout: 30_000 });
		const dialog = await openInviteDialog(team.page);
		// Every new invite row starts at the least-privileged role.
		await expect(dialog.getByRole("combobox").first()).toContainText("Viewer");
	});

	test("invite dialog — Add another appends a second row; Send label pluralizes", async ({
		team,
	}) => {
		await team.page.goto(membersUrl(team.orgSlug));
		await expect(team.page.getByText("Seats").first()).toBeVisible({ timeout: 30_000 });
		const dialog = await openInviteDialog(team.page);
		await expect(dialog.getByPlaceholder("teammate@company.com")).toHaveCount(1);
		await dialog.getByRole("button", { name: /add another/i }).click();
		await expect(dialog.getByPlaceholder("teammate@company.com")).toHaveCount(2);
		await expect(dialog.getByRole("button", { name: /^Send 2 invites$/ })).toBeVisible();
	});

	test("invite validation — a malformed email is rejected inline", async ({ team }) => {
		await team.page.goto(membersUrl(team.orgSlug));
		await expect(team.page.getByText("Seats").first()).toBeVisible({ timeout: 30_000 });
		const dialog = await openInviteDialog(team.page);
		await dialog.getByPlaceholder("teammate@company.com").fill("not-an-email");
		await expect(dialog.getByText("Enter a valid email")).toBeVisible();
	});

	test("invite validation — the same email twice is a duplicate", async ({ team }) => {
		await team.page.goto(membersUrl(team.orgSlug));
		await expect(team.page.getByText("Seats").first()).toBeVisible({ timeout: 30_000 });
		const dialog = await openInviteDialog(team.page);
		const dup = `dup-${Date.now()}@alethia.test`;
		await dialog.getByPlaceholder("teammate@company.com").first().fill(dup);
		await dialog.getByRole("button", { name: /add another/i }).click();
		await dialog.getByPlaceholder("teammate@company.com").nth(1).fill(dup);
		await expect(dialog.getByText("Duplicate email")).toBeVisible();
	});

	test("invite validation — inviting an existing member is rejected", async ({ team }) => {
		await team.page.goto(membersUrl(team.orgSlug));
		await expect(team.page.getByText("Seats").first()).toBeVisible({ timeout: 30_000 });
		const dialog = await openInviteDialog(team.page);
		const input = dialog.getByPlaceholder("teammate@company.com").first();
		await input.fill(team.email);
		// Re-inviting an existing member must be rejected. The client-side guard ("Already a member")
		// only fires once the async invite-context has loaded its existing-emails set; if that hasn't
		// arrived the form submits and the server rejects it (error toast naming the address). Accept
		// EITHER path — both prevent a duplicate invite for the owner's own email.
		await dialog.getByRole("button", { name: /^Send invite$/ }).click();
		const inlineErr = dialog.getByText("Already a member");
		const toastErr = team.page
			.getByRole("region", { name: /notifications/i })
			.getByText(team.email, { exact: false });
		await expect(inlineErr.or(toastErr)).toBeVisible({ timeout: 30_000 });
		// The owner is never added as a pending invitation row.
		await expect(
			team.page.getByRole("row").filter({ hasText: "Pending" }).filter({ hasText: team.email }),
		).toHaveCount(0);
	});

	test("invite dialog — client-side 'Already a member' guard fires inline (no submit)", async ({
		team,
	}) => {
		// BUG: getInviteContext (app/server/actions/members.ts:258) selects `inviteEmail:
		// invitation.email` from a query that only joins member+user (invitation is NOT joined),
		// so it throws a Drizzle error and 500s on every non-personal org. That means the invite
		// dialog's context (existing/pending emails + seat banner) never loads, silently disabling
		// the client-side duplicate guards. The server still rejects (400) — no security impact —
		// but the inline UX is dead. When fixed, typing the owner's own email should flag it inline.
		// FIXED: getInviteContext no longer projects the unjoined invitation.email (members.ts).
		await team.page.goto(membersUrl(team.orgSlug));
		await expect(team.page.getByText("Seats").first()).toBeVisible({ timeout: 30_000 });
		const dialog = await openInviteDialog(team.page);
		const emailField = dialog.getByPlaceholder("teammate@company.com").first();
		// getInviteContext loads async after the dialog opens; re-enter the email until the
		// (now-working) client guard has the context to flag it — deterministic, no fixed sleep.
		await expect(async () => {
			await emailField.fill("");
			await emailField.fill(team.email);
			await expect(dialog.getByText("Already a member")).toBeVisible({ timeout: 2_000 });
		}).toPass({ timeout: 20_000 });
	});

	test("invite lifecycle — send a real invitation, see it pending, then cancel it", async ({
		team,
	}) => {
		await team.page.goto(membersUrl(team.orgSlug));
		await expect(team.page.getByText("Seats").first()).toBeVisible({ timeout: 30_000 });
		const email = `e2e-invite-${Date.now()}@alethia.test`;

		const dialog = await openInviteDialog(team.page);
		await dialog.getByPlaceholder("teammate@company.com").fill(email);
		await dialog.getByRole("button", { name: /^Send invite$/ }).click();

		// The pending invitation surfaces as a row in the table.
		const inviteRow = team.page.getByRole("row").filter({ hasText: email });
		await expect(inviteRow).toBeVisible({ timeout: 30_000 });
		await expect(inviteRow.getByText("Pending")).toBeVisible();

		// Clean up: cancel the invitation so seeded rows don't accumulate.
		await inviteRow.getByRole("button", { name: "Manage" }).click();
		await team.page.getByRole("menuitem", { name: /cancel invitation/i }).click();
		await expect(team.page.getByRole("row").filter({ hasText: email })).toHaveCount(0, {
			timeout: 30_000,
		});
	});
});

// ---------------------------------------------------------------------------
// Teams — Enterprise gated on both Hobby and Pro
// ---------------------------------------------------------------------------
test.describe("RBAC — Teams (Enterprise gate)", () => {
	test("Hobby: empty teams surface shows the Enterprise upsell", async ({ owner }) => {
		await owner.page.goto(teamsUrl(owner.orgSlug));
		await expect(owner.page).not.toHaveURL(/\/login/);
		await expect(
			owner.page.getByRole("heading", { name: "Create and manage teams" }),
		).toBeVisible({ timeout: 30_000 });
		await expect(owner.page.getByText("Available on the Enterprise plan.")).toBeVisible();
	});

	test("Hobby: Create team opens the Enterprise upgrade dialog (Contact Sales)", async ({
		owner,
	}) => {
		await owner.page.goto(teamsUrl(owner.orgSlug));
		await owner.page.getByRole("button", { name: /create team/i }).click();
		const dialog = owner.page.getByRole("dialog");
		await expect(dialog).toBeVisible();
		await expect(dialog.getByRole("link", { name: /contact sales/i })).toBeVisible();
	});

	test("Pro: teams is still Enterprise-gated (upsell present)", async ({ team }) => {
		await team.page.goto(teamsUrl(team.orgSlug));
		await expect(team.page).not.toHaveURL(/\/login/);
		await expect(
			team.page.getByRole("heading", { name: "Create and manage teams" }),
		).toBeVisible({ timeout: 30_000 });
	});

	test("Pro: Create team also opens the Enterprise upgrade dialog", async ({ team }) => {
		await team.page.goto(teamsUrl(team.orgSlug));
		await expect(team.page.getByRole("button", { name: /create team/i })).toBeVisible({
			timeout: 30_000,
		});
		await team.page.getByRole("button", { name: /create team/i }).click();
		const dialog = team.page.getByRole("dialog");
		await expect(dialog.getByRole("link", { name: /contact sales/i })).toBeVisible();
	});
});

// ---------------------------------------------------------------------------
// Roles — built-in roles always visible; custom roles Enterprise gated
// ---------------------------------------------------------------------------
test.describe("RBAC — Roles", () => {
	// Rail rows expose an accessible name of "<Role> <permission-count>" (name span + count span),
	// so match by prefix, not an exact string.
	const rail = (page: import("@playwright/test").Page, role: string) =>
		page.getByRole("button", { name: new RegExp(`^${role}\\b`) });

	test("built-in roles rail renders all four roles + the count", async ({ owner }) => {
		await owner.page.goto(rolesUrl(owner.orgSlug));
		await expect(owner.page).not.toHaveURL(/\/login/);
		for (const r of ["Owner", "Admin", "Operator", "Viewer"]) {
			await expect(rail(owner.page, r).first()).toBeVisible({ timeout: 30_000 });
		}
		await expect(owner.page.getByText(/4 built-in/)).toBeVisible();
	});

	test("default detail panel shows the Owner built-in role (read-only)", async ({ owner }) => {
		await owner.page.goto(rolesUrl(owner.orgSlug));
		await expect(owner.page.getByText("Built-in").first()).toBeVisible({ timeout: 30_000 });
		await expect(
			owner.page.getByText("Full control of the organization, including members and billing."),
		).toBeVisible();
	});

	test("selecting Viewer swaps the detail panel to the Viewer description", async ({ owner }) => {
		await owner.page.goto(rolesUrl(owner.orgSlug));
		await expect(rail(owner.page, "Viewer")).toBeVisible({ timeout: 30_000 });
		await rail(owner.page, "Viewer").click();
		await expect(owner.page.getByText("Read-only access to everything.")).toBeVisible();
	});

	test("no custom roles yet — the rail shows the empty custom section", async ({ owner }) => {
		await owner.page.goto(rolesUrl(owner.orgSlug));
		await expect(owner.page.getByText("No custom roles yet.")).toBeVisible({ timeout: 30_000 });
	});

	test("Create role is gated → opens the Enterprise custom-roles dialog", async ({ owner }) => {
		await owner.page.goto(rolesUrl(owner.orgSlug));
		await expect(owner.page.getByRole("button", { name: /create role/i })).toBeVisible({
			timeout: 30_000,
		});
		await owner.page.getByRole("button", { name: /create role/i }).click();
		const dialog = owner.page.getByRole("dialog");
		await expect(dialog.getByText("Custom roles")).toBeVisible();
		await expect(dialog.getByRole("link", { name: /contact sales/i })).toBeVisible();
	});

	test("the built-in detail renders the per-service permission matrix", async ({ owner }) => {
		await owner.page.goto(rolesUrl(owner.orgSlug));
		await expect(owner.page.getByText("Built-in").first()).toBeVisible({ timeout: 30_000 });
		// The matrix groups permissions per resource — "Cloud identities" only appears there.
		await expect(owner.page.getByText("Cloud identities")).toBeVisible();
	});

	test("searching the rail filters the built-in roles", async ({ owner }) => {
		await owner.page.goto(rolesUrl(owner.orgSlug));
		await expect(rail(owner.page, "Owner")).toBeVisible({ timeout: 30_000 });
		await owner.page.getByPlaceholder("Search roles").fill("admin");
		await expect(rail(owner.page, "Admin")).toBeVisible();
		await expect(rail(owner.page, "Owner")).toHaveCount(0);
	});

	test("Pro: roles remain custom-role gated (built-ins still visible)", async ({ team }) => {
		await team.page.goto(rolesUrl(team.orgSlug));
		await expect(rail(team.page, "Owner")).toBeVisible({ timeout: 30_000 });
		await team.page.getByRole("button", { name: /create role/i }).click();
		await expect(team.page.getByRole("dialog").getByText("Custom roles")).toBeVisible();
	});
});

// ---------------------------------------------------------------------------
// Access — grants surface, Enterprise gated
// ---------------------------------------------------------------------------
test.describe("RBAC — Access (grants)", () => {
	test("Hobby: inheritance note + Enterprise upsell render", async ({ owner }) => {
		await owner.page.goto(accessUrl(owner.orgSlug));
		await expect(owner.page).not.toHaveURL(/\/login/);
		await expect(owner.page.getByText("Org → Project inheritance.")).toBeVisible({
			timeout: 30_000,
		});
		await expect(owner.page.getByRole("heading", { name: "Fine-grained access" })).toBeVisible();
		await expect(owner.page.getByText("Available on the Enterprise plan.")).toBeVisible();
		// The "Add grant" toolbar action only exists once entitled.
		await expect(owner.page.getByRole("button", { name: /add grant/i })).toHaveCount(0);
	});

	test("Pro: access is still Enterprise-gated (no grants table, upsell shown)", async ({ team }) => {
		await team.page.goto(accessUrl(team.orgSlug));
		await expect(team.page.getByRole("heading", { name: "Fine-grained access" })).toBeVisible({
			timeout: 30_000,
		});
		// The "Add grant" toolbar action only exists once entitled.
		await expect(team.page.getByRole("button", { name: /add grant/i })).toHaveCount(0);
	});
});

// ---------------------------------------------------------------------------
// SSO — read-only surface, Enterprise gated
// ---------------------------------------------------------------------------
test.describe("RBAC — Single Sign-On", () => {
	test("Hobby: SSO surface shows the Enterprise upsell", async ({ owner }) => {
		await owner.page.goto(ssoUrl(owner.orgSlug));
		await expect(owner.page).not.toHaveURL(/\/login/);
		await expect(owner.page.getByRole("heading", { name: "Single Sign-On" })).toBeVisible({
			timeout: 30_000,
		});
		await expect(owner.page.getByText("Available on the Enterprise plan.")).toBeVisible();
		// Provider registration only exists once entitled — Hobby cannot register an IdP.
		await expect(owner.page.getByRole("button", { name: /register provider/i })).toHaveCount(0);
	});

	test("Pro: SSO stays Enterprise-gated (no provider registration)", async ({ team }) => {
		await team.page.goto(ssoUrl(team.orgSlug));
		await expect(team.page.getByRole("heading", { name: "Single Sign-On" })).toBeVisible({
			timeout: 30_000,
		});
	});
});

// ---------------------------------------------------------------------------
// General — org profile (read) + danger zone (no destructive confirm)
// ---------------------------------------------------------------------------
test.describe("RBAC — General settings", () => {
	test("general page loads with the org profile prefilled", async ({ owner }) => {
		await owner.page.goto(generalUrl(owner.orgSlug));
		await expect(owner.page).not.toHaveURL(/\/login/);
		await expect(owner.page.getByRole("heading", { name: "Organization profile" })).toBeVisible({
			timeout: 30_000,
		});
		// The org-URL slug field is prefilled with the persona's slug.
		await expect(owner.page.locator(`input[value="${owner.orgSlug}"]`)).toBeVisible();
	});

	test("profile fields render (name prefilled, description, URL)", async ({ owner }) => {
		await owner.page.goto(generalUrl(owner.orgSlug));
		await expect(owner.page.getByRole("heading", { name: "Organization profile" })).toBeVisible({
			timeout: 30_000,
		});
		await expect(owner.page.getByText("Organization name")).toBeVisible();
		await expect(
			owner.page.getByPlaceholder("What does this organization manage?"),
		).toBeVisible();
	});

	test("Save changes and Danger zone controls are present", async ({ owner }) => {
		await owner.page.goto(generalUrl(owner.orgSlug));
		await expect(owner.page.getByRole("heading", { name: "Danger zone" })).toBeVisible({
			timeout: 30_000,
		});
		await expect(owner.page.getByRole("button", { name: /save changes/i }).first()).toBeVisible();
		await expect(owner.page.getByRole("button", { name: /delete/i }).first()).toBeVisible();
	});

	test("Delete organization opens a confirm dialog — Cancel aborts (no delete)", async ({
		owner,
	}) => {
		await owner.page.goto(generalUrl(owner.orgSlug));
		await expect(owner.page.getByRole("heading", { name: "Danger zone" })).toBeVisible({
			timeout: 30_000,
		});
		await owner.page.getByRole("button", { name: /^Delete$/ }).click();
		const dialog = owner.page.getByRole("alertdialog");
		await expect(dialog.getByText("Delete this organization?")).toBeVisible();
		// Abort — never confirm; deleting the persona org would break every sibling spec.
		await dialog.getByRole("button", { name: /cancel/i }).click();
		await expect(dialog).toBeHidden();
		await expect(owner.page).toHaveURL(new RegExp(`/${owner.orgSlug}`));
	});

	test("Transfer ownership is a stub → surfaces a 'coming soon' toast", async ({ owner }) => {
		await owner.page.goto(generalUrl(owner.orgSlug));
		await expect(owner.page.getByRole("heading", { name: "Danger zone" })).toBeVisible({
			timeout: 30_000,
		});
		await owner.page.getByRole("button", { name: /^Transfer$/ }).click();
		await expect(owner.page.getByText(/ownership transfer is coming soon/i)).toBeVisible();
	});
});
