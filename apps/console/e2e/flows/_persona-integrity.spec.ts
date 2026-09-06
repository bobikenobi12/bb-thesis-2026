// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// THE INSTRUMENT CHECK. Run this before believing a single result out of the RBAC / permission
// negatives in this directory.
//
// Every one of those specs answers "was the member refused?", and there are three ways to score a
// green on that question while measuring nothing:
//
//   1. THE PERSONA IS THE OWNER. If the invitee's signup silently became a sign-in (the same
//      address retried, a leaked storageState), `member` and `ownerTeam` are one account. The
//      denials then never fire and the negatives that assert an absence — "no Connect button",
//      "no Add channel" — go green for the wrong reason.
//   2. THE PERSONA HAS NO ACCESS AT ALL. A user with no membership row renders the org's 404 on
//      EVERY route of that org. Every negative asserting "the member cannot see X" passes, and the
//      suite reports a permission model it never touched. This is the failure the audit's T7
//      predicate documents at e2e/audit/permissions.spec.ts:23-27.
//   3. THE PERSONA WAS NEVER BUILT. The old guard was `test.skip(!process.env.HAVE_MEMBER)`; an
//      unset variable is a green skip. That guard is gone — this file is what replaced it.
//
// So the persona is proved three ways, and the last one is a DIFFERENCE rather than an absolute:
// the same endpoint is called from the member's session and from the owner's session in the same
// org, and reduced permission means the two disagree. An absolute refusal proves nothing — an
// unentitled org refuses everybody.

import fs from "node:fs";
import { expect, test } from "../fixtures/qa";
import { organizationApi, personaMetaPath, type PersonaName, type PersonaRecord } from "../helpers/personas";

/** The metadata global-setup wrote, or a failure that names what to do about it. */
function personas(): Partial<Record<PersonaName, PersonaRecord>> {
	const p = personaMetaPath();
	expect(fs.existsSync(p), `no persona metadata at ${p} — global-setup did not run (ALETHIA_QA_E2E=1?)`).toBe(true);
	return JSON.parse(fs.readFileSync(p, "utf8")) as Partial<Record<PersonaName, PersonaRecord>>;
}

test.describe("QA persona integrity", () => {
	test("the member persona exists, in ownerTeam's org, with a non-owner role", () => {
		const meta = personas();
		const member = meta.member;
		const team = meta.ownerTeam;
		expect(
			team,
			"no ownerTeam persona — the member has nowhere to be invited into, so every RBAC negative " +
				"in this directory is measuring nothing. Check global-setup's ownerTeam step.",
		).toBeTruthy();
		expect(
			member,
			"no member persona in personas.json. global-setup's invite → accept walk failed; its " +
				"warning line names the endpoint and status. Do NOT read the RBAC negatives as green.",
		).toBeTruthy();
		if (!member || !team) return;

		// The org it is a member OF, not its own Hobby org — the specs drive `/{member.orgSlug}/…`.
		expect(member.orgSlug, "the member persona must be scoped to ownerTeam's org").toBe(team.orgSlug);
		expect(member.orgId).toBe(team.orgId);

		// A DISTINCT account, and a DISTINCT session file.
		expect(member.userId, "the member persona has no resolved user id").toBeTruthy();
		expect(member.userId, "the member persona IS ownerTeam — the invitee signup signed in as the owner").not.toBe(
			team.userId,
		);
		expect(member.email).not.toBe(team.email);
		expect(member.storageState).not.toBe(team.storageState);
		expect(fs.existsSync(member.storageState), `no storageState file at ${member.storageState}`).toBe(true);

		// The role the DATABASE returned, not the one the invitation asked for.
		expect(member.role, "the member persona's membership row carries no role").toBeTruthy();
		expect(["owner", "admin"], `the member persona holds "${member.role}" — it cannot measure a denial`).not.toContain(
			member.role,
		);
	});

	test("the member's live session is the member, and it can load the org normally", async ({ member, team }) => {
		// (2) above: a member with no access renders the org 404 everywhere, and every negative in
		// this directory would then pass while measuring the 404.
		await member.page.goto(`/${member.orgSlug}`, { waitUntil: "domcontentloaded" });
		await expect(member.page).not.toHaveURL(/\/login/);
		expect(
			new URL(member.page.url()).pathname.startsWith(`/${member.orgSlug}`),
			`the member was bounced off /${member.orgSlug} to ${new URL(member.page.url()).pathname} — it has no ` +
				`access to the org at all, so every negative below would be about the org 404, not permissions.`,
		).toBe(true);
		const body = await member.page.evaluate(() => document.body.innerText.trim());
		expect(body.length, "the org overview rendered blank for the member").toBeGreaterThan(20);
		expect(body, "the org overview rendered a not-found/denial for the member").not.toMatch(
			/not found|don'?t have access|do not have access|not authori[sz]ed/i,
		);

		// (1) above: two live sessions, two different accounts.
		const who = async (page: import("@playwright/test").Page) =>
			page.evaluate(async () => {
				const res = await fetch("/api/auth/get-session");
				const json: unknown = await res.json().catch(() => null);
				const user = (json as { user?: { id?: string; email?: string } } | null)?.user;
				return { id: user?.id ?? null, email: user?.email ?? null };
			});
		await team.page.goto(`/${team.orgSlug}`, { waitUntil: "domcontentloaded" });
		const asMember = await who(member.page);
		const asOwner = await who(team.page);
		expect(asMember.email, "the member's live session has no user — the storageState is not signed in").toBeTruthy();
		expect(asMember.email).toBe(member.email);
		expect(asMember.id, "the member and the owner are the SAME live session").not.toBe(asOwner.id);
	});

	test("the member is refused something the owner of the same org is not", async ({ member, team }) => {
		// (3) above, and the reason it is comparative: `invite-member` is refused with 403
		// upgrade_required for an UNENTITLED org too, so a bare "the member got a 4xx" would score
		// green on an org where nobody can invite. Reduced permission is the two sides DISAGREEING.
		await member.page.goto(`/${member.orgSlug}`, { waitUntil: "domcontentloaded" });
		await team.page.goto(`/${team.orgSlug}`, { waitUntil: "domcontentloaded" });
		const target = `e2e-pdp-probe-${Date.now()}@alethia.test`;
		const byMember = await organizationApi(member.page, "invite-member", {
			email: target,
			role: "member",
			organizationId: member.orgId,
		});
		const byOwner = await organizationApi(team.page, "invite-member", {
			email: `owner-${target}`,
			role: "member",
			organizationId: member.orgId,
		});
		expect(
			byOwner.status,
			`the OWNER could not invite either (${byOwner.status}: ${byOwner.text}) — the instrument is ` +
				`broken, not the member's permissions. A 403 upgrade_required here means the console is ` +
				`serving COMMUNITY entitlements; check \`pnpm env:status\` scope.`,
		).toBeLessThan(400);
		expect(
			byMember.status,
			`the member was ALLOWED to invite (${byMember.status}) where the owner also was — it holds ` +
				`role "${member.role}" but is not actually reduced-permission.`,
		).toBeGreaterThanOrEqual(400);
	});
});
