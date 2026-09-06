// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Playwright global setup: creates the QA personas ONCE, serially (so the shared OTP log is never
// raced), and saves each one's Better Auth session as a storageState the fixtures reuse. Also resolves
// each persona's user_id + org_id from the DB for the seed helper. Writes e2e/.auth/{persona}.json +
// e2e/.auth/personas.json. Resilient to transient recompile 500s (the dev tree may be edited live).
//
// Skip re-creation on a fast iteration with REUSE_AUTH=1 (reuses existing e2e/.auth if present).
//
// THE `member` PERSONA IS BUILT HERE, THROUGH THE PRODUCT'S OWN INVITE → ACCEPT ENDPOINTS
// (helpers/personas.ts:buildMemberPersona). It is the third persona and the only one that is not a
// signup: it needs ownerTeam's org to already exist, so it is created last, from a context restored
// out of ownerTeam's storageState. Everything it asserts about itself is read back from the
// database — a persona that "exists" but has no membership row would make every RBAC negative in
// e2e/flows report green while measuring the org 404.

import { chromium, type FullConfig } from "@playwright/test";
import fs from "node:fs";
import { loadRootEnv } from "./helpers/env";
import { closeDb, orgIdBySlug, userIdByEmail } from "./helpers/db";
import {
	AUTH_DIR,
	buildMemberPersona,
	personaEmail,
	personaMetaPath,
	type PersonaName,
	type PersonaRecord,
	signUpHobby,
	signUpTeamTrial,
	storageStatePath,
} from "./helpers/personas";

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3000";

/**
 * Retries an async persona-creation step through transient failures (recompile 500s, slow OTP),
 * handing the body the ATTEMPT NUMBER so it can mint a fresh email each time — see
 * `personaEmail`'s note on why retrying an address turns the walk into a sign-in.
 *
 * The gap between attempts is 35s, not the old 2s. Better Auth caps OTP issuance at 5 sends / 60s
 * per IP (lib/config/auth.ts), and — with no trusted IP header in front of a sandbox env (#3789) —
 * that bucket is shared by the whole install. A retry inside the window gets "Too many requests"
 * and burns an attempt without ever asking for a code.
 */
async function withRetry<T>(label: string, fn: (attempt: number) => Promise<T>, attempts = 3): Promise<T> {
	let lastErr: unknown;
	for (let i = 1; i <= attempts; i++) {
		try {
			return await fn(i);
		} catch (err) {
			lastErr = err;
			console.warn(`[global-setup] ${label} attempt ${i}/${attempts} failed: ${(err as Error).message}`);
			if (i < attempts) await new Promise((r) => setTimeout(r, 35_000));
		}
	}
	throw lastErr;
}

export default async function globalSetup(_config: FullConfig): Promise<void> {
	// Playwright resolves globalSetup per CONFIG, not per project, so this function is invoked even
	// by `--project=hero`. Those runs are merge-gating and must not pay for — or be broken by — a
	// persona factory that signs several users up and talks to the database. Opt in explicitly.
	if (process.env.ALETHIA_QA_E2E !== "1") return;

	loadRootEnv();
	fs.mkdirSync(AUTH_DIR, { recursive: true });

	if (process.env.REUSE_AUTH === "1" && fs.existsSync(personaMetaPath())) {
		console.log("[global-setup] REUSE_AUTH=1 and personas.json present — reusing existing sessions.");
		return;
	}

	const stamp = Date.now();
	const browser = await chromium.launch();
	const records: Partial<Record<PersonaName, PersonaRecord>> = {};

	/** Signs up one persona in its own context, saves storageState, resolves ids, records it. */
	async function create(
		name: PersonaName,
		flow: (page: import("@playwright/test").Page, email: string) => Promise<{ orgSlug: string }>,
	): Promise<void> {
		await withRetry(`create ${name}`, async (attempt) => {
			const email = personaEmail(name, stamp, attempt);
			const context = await browser.newContext({ baseURL: BASE_URL });
			const page = await context.newPage();
			try {
				const { orgSlug } = await flow(page, email);
				const ssPath = storageStatePath(name);
				await context.storageState({ path: ssPath });
				const userId = (await userIdByEmail(email)) ?? undefined;
				const orgId = (await orgIdBySlug(orgSlug)) ?? undefined;
				records[name] = { name, email, orgSlug, orgId, userId, storageState: ssPath };
				console.log(`[global-setup] ${name} → org=${orgSlug} user=${userId ?? "?"} org_id=${orgId ?? "?"}`);
			} finally {
				await context.close();
			}
		});
	}

	/**
	 * Builds `member` inside ownerTeam's org and records what the DATABASE says about it.
	 *
	 * Two contexts, both real: the owner's is restored from its storageState (so the invite carries
	 * the owner's cookie, exactly as the console's invite dialog does), the invitee's is fresh.
	 * `orgSlug` on the record is the TEAM org, not the member's own — the specs drive
	 * `/{member.orgSlug}/~/settings/...` and must land where the member is a member.
	 */
	async function createMember(team: PersonaRecord): Promise<void> {
		if (!team.orgId) throw new Error(`ownerTeam has no resolved org_id (slug ${team.orgSlug})`);
		const orgId = team.orgId;
		await withRetry("create member", async (attempt) => {
			const email = personaEmail("member", stamp, attempt);
			const ownerContext = await browser.newContext({ baseURL: BASE_URL, storageState: team.storageState });
			const memberContext = await browser.newContext({ baseURL: BASE_URL });
			try {
				const ownerPage = await ownerContext.newPage();
				// The invite endpoint reads the caller's ACTIVE organization for scope resolution, and
				// a restored context starts with whatever the session last had. Landing on the org
				// first is what `[org]/layout.tsx` re-syncs it from.
				await ownerPage.goto(`/${team.orgSlug}`, { waitUntil: "domcontentloaded" });
				const memberPage = await memberContext.newPage();

				const built = await buildMemberPersona({
					ownerPage,
					memberPage,
					memberEmail: email,
					orgId,
					orgSlug: team.orgSlug,
				});

				// A DISTINCT account, asserted here rather than assumed. If the invitee's signup had
				// silently become a sign-in as the owner, the "member" would be the owner and every
				// RBAC negative below would pass by measuring the owner's own permissions.
				if (built.userId === team.userId) {
					throw new Error(
						`the member persona resolved to ownerTeam's own user id (${built.userId}) — ` +
							`the invitee signup signed in as the owner instead of creating an account.`,
					);
				}
				if (built.role === "owner") {
					throw new Error(`the member persona holds role "owner" in ${team.orgSlug} — it cannot measure a denial.`);
				}

				const ssPath = storageStatePath("member");
				await memberContext.storageState({ path: ssPath });
				records.member = {
					name: "member",
					email,
					orgSlug: built.orgSlug,
					orgId: built.orgId,
					userId: built.userId,
					role: built.role,
					storageState: ssPath,
				};
				console.log(
					`[global-setup] member → org=${built.orgSlug} user=${built.userId} role=${built.role} ` +
						`(own org ${built.ownOrgSlug}, invitation ${built.invitationId})`,
				);
			} finally {
				await memberContext.close();
				await ownerContext.close();
			}
		});
	}

	try {
		// ownerHobby is required; ownerTeam is best-effort (Stripe may be unconfigured on this box).
		await create("ownerHobby", (page, email) => signUpHobby(page, email));
		try {
			await create("ownerTeam", (page, email) => signUpTeamTrial(page, email));
		} catch (err) {
			console.warn(`[global-setup] ownerTeam persona unavailable: ${(err as Error).message}`);
		}
		// `member` lives inside ownerTeam's org, so it can only exist if ownerTeam did.
		if (records.ownerTeam) {
			try {
				await createMember(records.ownerTeam);
			} catch (err) {
				console.warn(`[global-setup] member persona unavailable: ${(err as Error).message}`);
			}
		} else {
			console.warn("[global-setup] no ownerTeam org — the member persona has nowhere to be invited into.");
		}
	} finally {
		fs.writeFileSync(personaMetaPath(), JSON.stringify(records, null, 2));
		await browser.close();
		await closeDb();
	}

	if (!records.ownerHobby) {
		throw new Error("[global-setup] Failed to create the ownerHobby persona — cannot run the suite.");
	}
}
