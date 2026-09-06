// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Demo-data seeder. Populates ONE demo-marked org with rich, self-consistent
// data (keyless connectors, designed projects/canvas, PLAN/DEPLOY jobs carrying
// real verify reports + signed receipts, evidence, day-2 posture, and a runner
// fleet) so the team can give enterprise demos quickly AND so the marketing
// video / section screenshots capture a populated real console.
//
// It writes DB rows the real UI renders — no demo-mode branch in the app. Data
// is fictional and clearly demo-marked; nothing here provisions real infra.
//
// Usage (run from repo root or apps/console):
//   pnpm -C apps/console run seed:demo                     # stable "demo-acme" org (idempotent refresh)
//   pnpm -C apps/console run seed:demo --slug demo-globex   # a differently-named demo org
//   pnpm -C apps/console run seed:demo --email you@dev.test # seed into an existing user's personal org
//   pnpm -C apps/console run seed:demo --fresh              # a new demo-<rand> org
//   pnpm -C apps/console run seed:demo --reset              # tear the demo org down, then reseed
//
// Safety: refuses to run against a production DB unless ALETHIA_ALLOW_DEMO_SEED=1,
// and never touches an org that isn't demo-marked (unless --force).

import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT_ENV = join(here, "../../../.env");

/** Loads root .env into process.env without overriding already-set values. */
function loadRootEnv(): void {
	if (!existsSync(ROOT_ENV)) return;
	for (const raw of readFileSync(ROOT_ENV, "utf8").split("\n")) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq === -1) continue;
		const key = line.slice(0, eq).trim();
		if (process.env[key] !== undefined) continue;
		let val = line.slice(eq + 1).trim();
		if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
		process.env[key] = val;
	}
}

function flag(name: string): boolean {
	return process.argv.includes(`--${name}`);
}
function opt(name: string, fallback: string): string {
	const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
	if (hit) return hit.slice(name.length + 3);
	const idx = process.argv.indexOf(`--${name}`);
	if (idx !== -1 && process.argv[idx + 1] && !process.argv[idx + 1].startsWith("--")) return process.argv[idx + 1];
	return fallback;
}

async function main(): Promise<void> {
	loadRootEnv();

	// --- Safety layer 1: env gate ---
	if (!process.env.ALETHIA_DATABASE_URL) {
		throw new Error("ALETHIA_DATABASE_URL is not set (source root .env or export it).");
	}
	const isProd = process.env.NODE_ENV === "production" || process.env.VERCEL_ENV === "production";
	if (isProd && process.env.ALETHIA_ALLOW_DEMO_SEED !== "1") {
		throw new Error("Refusing to seed in a production environment. Set ALETHIA_ALLOW_DEMO_SEED=1 to override.");
	}

	// Imports AFTER env is loaded (getServiceDb reads config lazily on first use).
	const { getServiceDb } = await import("@/lib/db");
	const { organization, projects } = await import("@/lib/db/schema");
	const { seedAuthz } = await import("@/lib/authz/seed");
	const { eq } = await import("drizzle-orm");
	const b = await import("@/lib/seed/builders");
	const { DEMO } = await import("@/lib/seed/catalog");

	const slug = flag("fresh") ? `demo-${randomUUID().slice(0, 8)}` : opt("slug", "demo-acme");
	const ownerEmail = opt("email", DEMO.ownerEmail);
	const force = flag("force");
	const reset = flag("reset");

	const db = getServiceDb();
	const id = b.makeIds(slug);
	const now = new Date();

	const ownerId = await b.resolveOwner(db, ownerEmail, id);
	const orgId = ownerId; // community tenancy

	// --- Safety layer 2 + 3: demo marker + real-data guard ---
	const orgRows = await db.select({ metadata: organization.metadata }).from(organization).where(eq(organization.id, orgId)).limit(1);
	const existingProjects = await db.select({ id: projects.id }).from(projects).where(eq(projects.org_id, orgId));
	let isDemo = false;
	if (orgRows[0]?.metadata) {
		try {
			isDemo = JSON.parse(orgRows[0].metadata)?.demo === true;
		} catch {
			isDemo = false;
		}
	}
	if (existingProjects.length > 0 && !isDemo && !force) {
		throw new Error(`Refusing: org ${orgId} already has ${existingProjects.length} project(s) and is not demo-marked. Use a throwaway account, --fresh, or --force.`);
	}

	if ((isDemo && existingProjects.length > 0) || reset) {
		console.log(`↺ Refreshing demo org (${slug}) — tearing down prior demo data…`);
		await b.teardownOrg(db, orgId, id);
		if (reset && flag("reset-only")) {
			console.log("✓ Reset complete (--reset-only).");
			process.exit(0);
		}
	}

	const ctx = { db, ownerId, orgId, ownerEmail, slug, id, now };

	console.log(`▸ Seeding demo org "${DEMO.orgName}" (slug ${slug}, owner ${ownerEmail})`);
	await b.seedOrgAndPeople(ctx);
	await seedAuthz();
	const connectors = await b.seedConnectors(ctx);
	const seeded = await b.seedProjects(ctx, connectors);
	await b.seedFleet(ctx); // runners must exist before jobs reference them
	await b.seedJobsAndEvidence(ctx, seeded, connectors);

	const envCount = seeded.reduce((s, p) => s + p.envs.length, 0);
	console.log("✓ Demo seed complete.");
	console.log(`  org id         ${orgId}`);
	console.log(`  projects       ${seeded.length}  ·  environments ${envCount}`);
	console.log(`  connectors     ${Object.keys(connectors).join(", ")}`);
	console.log(`  login          sign in with ${ownerEmail} (dev: OTP prints to the console log)`);
	console.log(`  refresh        pnpm -C apps/console run seed:demo --slug ${slug}`);
	console.log(`  teardown       pnpm -C apps/console run seed:demo --slug ${slug} --reset --reset-only`);
	process.exit(0);
}

main().catch((err) => {
	console.error("✗ seed-demo failed:", err instanceof Error ? err.message : err);
	process.exit(1);
});
