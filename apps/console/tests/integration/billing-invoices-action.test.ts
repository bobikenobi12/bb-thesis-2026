// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: `listInvoices` / `getInvoice` read the MIRRORED invoice table, so they must work
// on a deployment where Stripe is not configured — through the real authorization stack, against
// real Postgres.
//
// THE DEFECT (#3731). Both actions called `requireHostedBilling()`, which throws whenever
// STRIPE_SECRET_KEY is unset. The UI conformance audit drove `~/settings/billing/invoices` on a
// sandbox env with no Stripe key and recorded `500 POST …/~/settings/billing/invoices` — a server
// action rejecting, twice per visit. BOTH of those were `listInvoices`: the panel's filtered rows
// query and its unfiltered facet-count query. `getInvoice` has no production caller and is here
// only as the sibling read that carried the same guard. The main billing panel hid the fault
// behind a "Self-managed deployment" card that returns before anything calls these; the dedicated
// invoices page has no such gate.
//
// Why an INTEGRATION test rather than a unit one: with `authorize` and the query layer mocked, the
// only thing left to assert is that a line was deleted. Here the action runs its real PDP gate and
// its real SQL, so "returns the org's invoices with no Stripe key" is measured end to end — and
// the same test proves the read is still ORG-SCOPED, which is what one might break while removing
// a guard from it.

import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { getInvoice, listInvoices } from "@/app/server/actions/billing";
import { runWithActor } from "@/lib/authz/actor-context";
import { BUILTIN_ROLE_IDS } from "@/lib/authz/registry";
import { seedAuthz } from "@/lib/authz/seed";
import type { Actor, Entitlements } from "@/lib/authz/types";
import { getServiceDb } from "@/lib/db";
import { authzActivityLog, grants, invoice, organization, user } from "@/lib/db/schema";
import { describeIfDb, purgeAuthzActivityLog } from "./db";

const ORG = randomUUID();
const OTHER_ORG = randomUUID();
const OWNER = randomUUID(); // holds manage_billing (built-in owner role)
const INVOICE_MINE = randomUUID();
const INVOICE_THEIRS = randomUUID();

const ENTITLEMENTS: Entitlements = {
	organizations: true,
	teams: true,
	sso: true,
	customRoles: true,
	activityExport: true,
	alerting: true,
	advancedAlerting: true,
	byoRunners: true,
	managedPools: true,
	quotas: {
		maxConcurrentJobs: null,
		priorityLevel: 30,
		includedRunnerMinutes: 0,
		activityRetentionDays: 365,
	},
};

const owner: Actor = { userId: OWNER, orgId: ORG, entitlements: ENTITLEMENTS };

describeIfDb("listInvoices without Stripe configured (#3731)", () => {
	let savedStripeKey: string | undefined;

	beforeAll(async () => {
		// The condition under test IS the absent key — a machine that happens to export one would
		// otherwise pass this suite for the wrong reason.
		savedStripeKey = process.env.STRIPE_SECRET_KEY;
		delete process.env.STRIPE_SECRET_KEY;

		const db = getServiceDb();
		await seedAuthz();
		await db.insert(user).values({ id: OWNER, email: `it-inv-${OWNER}@example.test` });
		await db.insert(organization).values([
			{ id: ORG, name: `inv-${ORG.slice(0, 8)}` },
			{ id: OTHER_ORG, name: `inv-other-${OTHER_ORG.slice(0, 8)}` },
		]);
		await db.insert(grants).values({
			org_id: ORG,
			principal_type: "user",
			principal_id: OWNER,
			effect: "allow",
			role_id: BUILTIN_ROLE_IDS.owner,
			resource_type: "org",
			resource_id: null,
		});
		await db.insert(invoice).values([
			{
				id: INVOICE_MINE,
				organizationId: ORG,
				stripeInvoiceId: `in_test_${INVOICE_MINE.slice(0, 12)}`,
				number: "IT-0001",
				status: "paid",
				amountTotal: 2000,
				currency: "usd",
				paidAt: new Date("2026-05-01T00:00:00Z"),
			},
			{
				id: INVOICE_THEIRS,
				organizationId: OTHER_ORG,
				stripeInvoiceId: `in_test_${INVOICE_THEIRS.slice(0, 12)}`,
				number: "IT-9999",
				status: "paid",
				amountTotal: 9900,
				currency: "usd",
				paidAt: new Date("2026-05-02T00:00:00Z"),
			},
		]);
	});

	afterAll(async () => {
		if (savedStripeKey === undefined) delete process.env.STRIPE_SECRET_KEY;
		else process.env.STRIPE_SECRET_KEY = savedStripeKey;

		const db = getServiceDb();
		// `authorize()` writes one activity row per call, `authz_activity_log.org_id` carries no FK
		// (so deleting the org does not cascade), and the append-only WORM trigger refuses a direct
		// DELETE — hence the GC-flagged helper. Skipping it leaves undeletable residue in the
		// long-lived dev database, in the very table authz-activity-gc.test.ts counts rows in.
		await purgeAuthzActivityLog(eq(authzActivityLog.org_id, ORG));
		await db.delete(invoice).where(inArray(invoice.id, [INVOICE_MINE, INVOICE_THEIRS]));
		await db.delete(grants).where(eq(grants.org_id, ORG));
		await db.delete(organization).where(inArray(organization.id, [ORG, OTHER_ORG]));
		await db.delete(user).where(eq(user.id, OWNER));
	});

	// THE DEFECT. Pre-fix this rejects with "Billing is not enabled on this deployment
	// (self-managed mode)" — which reaches the browser as the 500 the audit recorded.
	it("lists the org's mirrored invoices instead of throwing", async () => {
		const rows = await runWithActor(owner, () => listInvoices({}));
		expect(rows.map((r) => r.number)).toContain("IT-0001");
	});

	// The invoices page issues a SECOND, unfiltered query for the status-facet counts. It failed
	// separately (two 500s per visit), so it is asserted separately.
	it("serves the unfiltered facet-count query too", async () => {
		const rows = await runWithActor(owner, () => listInvoices());
		expect(rows.some((r) => r.number === "IT-0001")).toBe(true);
	});

	// Removing a guard must not have removed the tenancy boundary with it: the other org's
	// invoice exists in the same table and must not be visible or fetchable.
	it("stays scoped to the actor's org", async () => {
		const rows = await runWithActor(owner, () => listInvoices({}));
		expect(rows.map((r) => r.number)).not.toContain("IT-9999");
		expect(await runWithActor(owner, () => getInvoice(INVOICE_THEIRS))).toBeNull();
	});

	// `getInvoice` is the single-invoice sibling of the same read. It has NO production caller
	// today, so it contributed none of the two 500s — it is covered here because it carried the
	// identical guard over the identical table, not because the page called it.
	it("loads one of the org's own invoices", async () => {
		const row = await runWithActor(owner, () => getInvoice(INVOICE_MINE));
		expect(row?.number).toBe("IT-0001");
		expect(row?.total).toBe(2000);
	});
});
