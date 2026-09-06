// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Ops tool: set an organization's billing plan directly (no Stripe self-serve). This is
// how Enterprise works — Sales agrees a contract and invoices via Stripe Invoicing or
// external accounting, then we mark the org Enterprise here and its entitlements (SSO,
// custom roles, audit, 20k runner-min) follow immediately. Also handy to comp an org Pro
// or reset to community.
//
// Usage:
//   pnpm -C apps/console run org:set-plan <org-slug> <community|team|enterprise> [--status active] [--months 12]
//   pnpm -C apps/console run org:set-plan <org-slug> enterprise --perpetual
//
// `active`/`trialing` grant the plan's entitlements; `community` (or --status none) resets.
//
// `--perpetual` writes a NULL `current_period_end` — the open-ended grant that
// lib/billing/plan.ts isManualGrantExpired() already documents as never lapsing ("An
// open-ended grant (currentPeriodEnd null) never lapses"). Without it this tool could only
// ever write now()+months, so a permanent grant — an internal testing org, a partner, a
// perpetual contract — had to be renewed on a calendar nobody keeps, and would silently
// drop to community the day it lapsed. The state was reachable in the schema and by the
// resolver, and unreachable by the only tool that writes it.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT_ENV = join(here, "../../../.env");

const PLANS = new Set(["community", "team", "enterprise"]);
const STATUSES = new Set(["none", "trialing", "active", "past_due", "canceled"]);

/** Loads root .env without overriding already-set values (for ALETHIA_DATABASE_URL). */
function loadRootEnv() {
	if (!existsSync(ROOT_ENV)) return;
	for (const raw of readFileSync(ROOT_ENV, "utf8").split("\n")) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq === -1) continue;
		const key = line.slice(0, eq).trim();
		if (process.env[key] !== undefined) continue;
		let val = line.slice(eq + 1).trim();
		if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
			val = val.slice(1, -1);
		}
		process.env[key] = val;
	}
}

function arg(name, fallback) {
	const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
	if (hit) return hit.split("=")[1];
	const idx = process.argv.indexOf(`--${name}`);
	return idx !== -1 ? process.argv[idx + 1] : fallback;
}

/** Reads a boolean flag in either --name or --name=true/false form. */
function booleanArg(name) {
	const value = arg(name, undefined);
	if (value === undefined) return process.argv.includes(`--${name}`);
	if (value === "true") return true;
	if (value === "false") return false;
	console.error(`✗ --${name} must be true or false (got "${value}").`);
	process.exit(1);
}

async function main() {
	loadRootEnv();
	const [slug, plan] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
	const status = arg("status", plan === "community" ? "none" : "active");
	const perpetual = booleanArg("perpetual");
	const months = Number(arg("months", "12"));

	if (!slug || !PLANS.has(plan)) {
		console.error("Usage: org:set-plan <org-slug> <community|team|enterprise> [--status active] [--months 12]");
		process.exit(1);
	}
	if (perpetual && plan === "community") {
		console.error("✗ --perpetual is meaningless with `community` — that resets the grant.");
		process.exit(1);
	}
	if (!perpetual && (!Number.isFinite(months) || months <= 0)) {
		console.error(`✗ --months must be a positive number (got "${arg("months", "12")}").`);
		process.exit(1);
	}
	if (!STATUSES.has(status)) {
		console.error(`✗ Invalid --status "${status}". One of: ${[...STATUSES].join(", ")}`);
		process.exit(1);
	}
	const url = process.env.ALETHIA_DATABASE_URL;
	if (!url) {
		console.error("✗ ALETHIA_DATABASE_URL is not set (root .env or the environment).");
		process.exit(1);
	}

	const sql = postgres(url, { max: 1, onnotice: () => {} });
	try {
		const [org] = await sql`select id, name from organization where slug = ${slug} limit 1`;
		if (!org) {
			console.error(`✗ No organization with slug "${slug}".`);
			process.exit(1);
		}
		const live = status === "active" || status === "trialing";
		const periodStart = live ? sql`now()` : sql`null`;
		// NULL end = open-ended. isManualGrantExpired() only lapses a grant that HAS an end date,
		// so this is the difference between "paid until a date" and "paid, full stop".
		const periodEnd =
			live && !perpetual ? sql`now() + (${months} || ' months')::interval` : sql`null`;

		await sql`
			insert into organization_billing
				(organization_id, plan, status, current_period_start, current_period_end, updated_at)
			values (${org.id}, ${plan}, ${status}, ${periodStart}, ${periodEnd}, now())
			on conflict (organization_id) do update set
				plan = excluded.plan,
				status = excluded.status,
				current_period_start = excluded.current_period_start,
				current_period_end = excluded.current_period_end,
				updated_at = now()
		`;
		console.log(
			`✓ ${org.name} (${slug}) → plan=${plan} status=${status}` +
				(live ? (perpetual ? " — PERPETUAL (no term end; never lapses)" : ` for ${months} months`) : ""),
		);
		await sql.end();
		process.exit(0);
	} catch (err) {
		console.error("\n✗ set-org-plan failed:\n");
		console.error(err);
		await sql.end({ timeout: 1 }).catch(() => {});
		process.exit(1);
	}
}

main();
