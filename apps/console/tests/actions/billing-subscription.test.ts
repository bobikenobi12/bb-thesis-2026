// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Mocked-boundary tests for the SUBSCRIPTION / CHECKOUT / SEAT / CREDIT-PACK / PAYMENT-METHOD /
// CANCEL / PORTAL / TAX-ID billing server actions. We stub the boundary (PDP guard, the Stripe
// client, the billing record/queries, the seat counter, collaboration gate, the sub→billing sync,
// and the Stripe config) and assert each action's ORCHESTRATION + BRANCHING and the EXACT Stripe
// call args. The catalog/credit-pack math (creditPack, AI_CREDIT_PACKS) and the plan catalog
// (planMeta) run for real. The Usage/resource/billing-summary actions are covered separately by
// billing-usage.test.ts — this file deliberately does NOT touch them.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/authz/guard", () => ({
	currentActor: vi.fn(),
	authorize: vi.fn(),
	authorizeInOrg: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn() }));
vi.mock("@/lib/billing/invoices", () => ({
	listOrgInvoices: vi.fn(),
	getOrgInvoice: vi.fn(),
}));
vi.mock("@/lib/billing/queries", () => ({
	getOrgBilling: vi.fn(),
	upsertOrgBilling: vi.fn(),
}));
vi.mock("@/lib/billing/stripe", () => ({ getStripe: vi.fn() }));
vi.mock("@/lib/billing/sync", () => ({ syncSubscriptionToBilling: vi.fn() }));
vi.mock("@/lib/billing/seats", () => ({ countBillableSeats: vi.fn() }));
vi.mock("@/lib/billing/collaboration", () => ({ canOrgInvite: vi.fn() }));
// The paid-conversion gate is MOCKED OPEN here, deliberately.
//
// Every conversion action now passes through it (#2372), and it refuses by default: PAID_MARKETS is
// empty, so a real call declines before Stripe is ever reached. This file is about the STRIPE
// ORCHESTRATION — line items, seat quantities, tax parameters — and leaving the gate live would make
// every test here assert the gate's refusal instead, over and over.
//
// Two other things keep that from becoming a hole. The gate's own rules are tested against the real
// implementation in packages/legal (commerce.test.ts) and lib/billing/eligibility; and
// tests/billing/eligibility-coverage.test.ts asserts STRUCTURALLY that each of these actions still
// calls it — so a mock that made the gate disappear entirely would red there, not pass quietly here.
// The refusal is also exercised end-to-end below ("refuses a conversion the eligibility gate declines").
vi.mock("@/lib/billing/eligibility", () => ({
	assertOrgPaidConversionAllowed: vi.fn(async () => undefined),
	assertPaidConversionAllowed: vi.fn(async () => undefined),
	hasAcceptedCurrentDocuments: vi.fn(async () => true),
	acceptanceRequiredDocuments: vi.fn(() => []),
	paidConversionStatus: vi.fn(async () => ({ allowed: true })),
	PaidConversionNotAllowedError: class extends Error {
		readonly reason: string;
		constructor(reason: string, message: string) {
			super(message);
			this.reason = reason;
		}
	},
}));
vi.mock("@/lib/billing/config", () => ({
	deploymentMode: vi.fn(() => "self-managed"),
	getStripeConfig: vi.fn(() => ({ appUrl: "https://app.test" })),
	isStripeConfigured: vi.fn(() => true),
	isStripeTaxEnabled: vi.fn(() => false),
	meterPriceIdForPlan: vi.fn(() => undefined),
	priceIdForPlan: vi.fn((plan: string) => `price_${plan}`),
	planForPriceId: vi.fn(() => null),
	getPublishableKey: vi.fn(() => ""),
	RUNNER_MINUTES_METER_EVENT: "alethia_runner_minutes",
}));

import { assertOrgPaidConversionAllowed } from "@/lib/billing/eligibility";
import {
	attachTaxIdToCustomer,
	cancelSubscription,
	changeSubscriptionPlan,
	createBillingPortalSession,
	createCheckoutSession,
	createCreditPackIntent,
	createNewOrgSubscriptionIntent,
	createSetupIntent,
	createSubscriptionIntent,
	detachPaymentMethod,
	getBillingDetails,
	getCollaborationAccess,
	getPlanHistory,
	getProOffer,
	isOrgSlugAvailable,
	linkSubscriptionToNewOrg,
	getInvoice,
	listInvoices,
	listPaymentMethods,
	listTransactions,
	resumeSubscription,
	saveTaxId,
	setCustomerBillingAddress,
	setDefaultPaymentMethod,
	startProTrial,
	updateBillingAddress,
} from "@/app/server/actions/billing";
import { authorize, authorizeInOrg, currentActor } from "@/lib/authz/guard";
import { getServiceDb } from "@/lib/db";
import { getOrgBilling, upsertOrgBilling } from "@/lib/billing/queries";
import { getOrgInvoice, listOrgInvoices } from "@/lib/billing/invoices";
import { getStripe } from "@/lib/billing/stripe";
import { syncSubscriptionToBilling } from "@/lib/billing/sync";
import { countBillableSeats } from "@/lib/billing/seats";
import { canOrgInvite } from "@/lib/billing/collaboration";
import {
	isStripeConfigured,
	isStripeTaxEnabled,
	meterPriceIdForPlan,
} from "@/lib/billing/config";

const authz = vi.mocked(authorize);
const authzInOrg = vi.mocked(authorizeInOrg);
const actor = vi.mocked(currentActor);
const orgBilling = vi.mocked(getOrgBilling);
const orgInvoicesList = vi.mocked(listOrgInvoices);
const orgInvoiceGet = vi.mocked(getOrgInvoice);

/** A thenable drizzle-ish chain whose terminal `await` pops the next queued result set. */
function makeDb() {
	const queue: unknown[][] = [];
	const chain: Record<string, unknown> = {};
	for (const m of [
		"from",
		"where",
		"limit",
		"innerJoin",
		"leftJoin",
		"set",
		"values",
		"returning",
		"onConflictDoUpdate",
	]) {
		chain[m] = () => chain;
	}
	(chain as { then: unknown }).then = (
		resolve: (v: unknown) => unknown,
		reject?: (e: unknown) => unknown,
	) => Promise.resolve(queue.shift() ?? []).then(resolve, reject);
	const select = vi.fn(() => chain);
	const update = vi.fn(() => chain);
	const insert = vi.fn(() => chain);
	const del = vi.fn(() => chain);
	const db = { select, update, insert, delete: del };
	return { db, queue, select, update, insert };
}

/** A fully-stubbed Stripe client with every method the billing actions touch. */
function makeStripe() {
	return {
		subscriptions: {
			create: vi.fn(),
			retrieve: vi.fn(),
			update: vi.fn(),
			cancel: vi.fn(),
			list: vi.fn(),
		},
		customers: {
			create: vi.fn(),
			retrieve: vi.fn(),
			update: vi.fn(),
			listTaxIds: vi.fn(),
			deleteTaxId: vi.fn(),
			createTaxId: vi.fn(),
		},
		checkout: { sessions: { create: vi.fn() } },
		billingPortal: { sessions: { create: vi.fn() } },
		paymentIntents: { create: vi.fn() },
		setupIntents: { create: vi.fn() },
		paymentMethods: { list: vi.fn(), retrieve: vi.fn(), detach: vi.fn() },
		invoices: { list: vi.fn(), create: vi.fn(), finalizeInvoice: vi.fn() },
		invoiceItems: { create: vi.fn() },
		charges: { list: vi.fn() },
	};
}

type StripeMock = ReturnType<typeof makeStripe>;
let stripe: StripeMock;
let db: ReturnType<typeof makeDb>;

beforeEach(() => {
	vi.clearAllMocks();
	stripe = makeStripe();
	db = makeDb();
	vi.mocked(getStripe).mockReturnValue(stripe as never);
	vi.mocked(getServiceDb).mockReturnValue(db.db as never);
	// Default: no dangling incomplete subs to clean up (cancelIncompleteSubscriptions).
	stripe.subscriptions.list.mockResolvedValue({ data: [] } as never);
	// Default: a real org with the manage_billing permission.
	authz.mockResolvedValue({ orgId: "org-1", userId: "user-1" } as never);
	authzInOrg.mockResolvedValue({ orgId: "org-1", userId: "user-1" } as never);
	actor.mockResolvedValue({ orgId: "org-1", userId: "user-1" } as never);
	vi.mocked(isStripeConfigured).mockReturnValue(true);
	vi.mocked(isStripeTaxEnabled).mockReturnValue(false);
	vi.mocked(meterPriceIdForPlan).mockReturnValue(undefined);
});

// ── createCheckoutSession ────────────────────────────────────────────────────
describe("createCheckoutSession", () => {
	it("builds a subscription Checkout with a 30-day trial for team and returns the url", async () => {
		orgBilling.mockResolvedValue({ stripeCustomerId: "cus_1" } as never);
		stripe.checkout.sessions.create.mockResolvedValue({
			url: "https://checkout.test/sess",
		} as never);

		const r = await createCheckoutSession("team" as never);

		expect(r).toEqual({ url: "https://checkout.test/sess" });
		const args = stripe.checkout.sessions.create.mock.calls[0][0];
		expect(args).toMatchObject({
			mode: "subscription",
			customer: "cus_1",
			line_items: [{ price: "price_team", quantity: 1 }],
			allow_promotion_codes: true,
			success_url:
				"https://app.test/dashboard/settings/billing?checkout=success",
			cancel_url:
				"https://app.test/dashboard/settings/billing?checkout=cancelled",
		});
		expect(args.subscription_data).toEqual({
			metadata: { organization_id: "org-1" },
			trial_period_days: 30,
		});
		// Tax disabled by default → no automatic_tax block.
		expect(args.automatic_tax).toBeUndefined();
	});

	it("omits the trial for a flat (enterprise) plan", async () => {
		orgBilling.mockResolvedValue({ stripeCustomerId: "cus_1" } as never);
		stripe.checkout.sessions.create.mockResolvedValue({ url: "u" } as never);

		await createCheckoutSession("enterprise" as never);

		const args = stripe.checkout.sessions.create.mock.calls[0][0];
		expect(args.subscription_data).toEqual({
			metadata: { organization_id: "org-1" },
		});
		expect(args.subscription_data.trial_period_days).toBeUndefined();
	});

	it("adds the metered line item when a runner-minutes meter is configured", async () => {
		vi.mocked(meterPriceIdForPlan).mockReturnValue("price_meter_team");
		orgBilling.mockResolvedValue({ stripeCustomerId: "cus_1" } as never);
		stripe.checkout.sessions.create.mockResolvedValue({ url: "u" } as never);

		await createCheckoutSession("team" as never);

		expect(stripe.checkout.sessions.create.mock.calls[0][0].line_items).toEqual([
			{ price: "price_team", quantity: 1 },
			{ price: "price_meter_team" },
		]);
	});

	it("enables Stripe Tax collection when configured", async () => {
		vi.mocked(isStripeTaxEnabled).mockReturnValue(true);
		orgBilling.mockResolvedValue({ stripeCustomerId: "cus_1" } as never);
		stripe.checkout.sessions.create.mockResolvedValue({ url: "u" } as never);

		await createCheckoutSession("team" as never);

		const args = stripe.checkout.sessions.create.mock.calls[0][0];
		expect(args.automatic_tax).toEqual({ enabled: true });
		expect(args.tax_id_collection).toEqual({ enabled: true });
		expect(args.customer_update).toEqual({ name: "auto", address: "auto" });
	});

	it("mints + persists a Stripe customer on first use, then checks out", async () => {
		orgBilling.mockResolvedValue(null); // no existing customer
		db.queue.push([{ email: "owner@test.io", name: "Owner" }]); // user row
		db.queue.push([{ name: "Acme" }]); // org row
		stripe.customers.create.mockResolvedValue({ id: "cus_new" } as never);
		stripe.checkout.sessions.create.mockResolvedValue({ url: "u" } as never);

		await createCheckoutSession("team" as never);

		expect(stripe.customers.create).toHaveBeenCalledWith({
			email: "owner@test.io",
			name: "Acme",
			metadata: { organization_id: "org-1", created_by: "user-1" },
		});
		expect(upsertOrgBilling).toHaveBeenCalledWith(
			expect.objectContaining({
				organizationId: "org-1",
				stripeCustomerId: "cus_new",
			}),
		);
		expect(stripe.checkout.sessions.create.mock.calls[0][0].customer).toBe(
			"cus_new",
		);
	});

	it("refuses the personal scope before any Stripe call", async () => {
		authz.mockResolvedValue({ orgId: "user-1", userId: "user-1" } as never);
		await expect(createCheckoutSession("team" as never)).rejects.toThrow(
			/Create an organization/,
		);
		expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
	});

	it("refuses when hosted billing isn't configured", async () => {
		vi.mocked(isStripeConfigured).mockReturnValue(false);
		await expect(createCheckoutSession("team" as never)).rejects.toThrow(
			/not enabled on this deployment/,
		);
	});

	it("throws if Stripe returns no checkout url", async () => {
		orgBilling.mockResolvedValue({ stripeCustomerId: "cus_1" } as never);
		stripe.checkout.sessions.create.mockResolvedValue({ url: null } as never);
		await expect(createCheckoutSession("team" as never)).rejects.toThrow(
			/did not return a checkout URL/,
		);
	});
});

// ── createSubscriptionIntent (embedded) ──────────────────────────────────────
describe("createSubscriptionIntent", () => {
	it("seeds the seat quantity from billable members and returns the client secret", async () => {
		orgBilling.mockResolvedValue({ stripeCustomerId: "cus_1" } as never);
		vi.mocked(countBillableSeats).mockResolvedValue(4);
		stripe.subscriptions.create.mockResolvedValue({
			id: "sub_1",
			latest_invoice: { confirmation_secret: { client_secret: "cs_1" } },
		} as never);

		const r = await createSubscriptionIntent("team" as never);

		expect(r).toEqual({ clientSecret: "cs_1", subscriptionId: "sub_1", currency: "usd" });
		const args = stripe.subscriptions.create.mock.calls[0][0];
		expect(args).toMatchObject({
			customer: "cus_1",
			items: [{ price: "price_team", quantity: 4 }],
			payment_behavior: "default_incomplete",
			payment_settings: { save_default_payment_method: "on_subscription" },
			expand: ["latest_invoice.confirmation_secret"],
			metadata: { organization_id: "org-1" },
		});
	});

	it("floors the seat quantity at 1 when there are no billable members", async () => {
		orgBilling.mockResolvedValue({ stripeCustomerId: "cus_1" } as never);
		vi.mocked(countBillableSeats).mockResolvedValue(0);
		stripe.subscriptions.create.mockResolvedValue({
			id: "sub_1",
			latest_invoice: { confirmation_secret: { client_secret: "cs_1" } },
		} as never);

		await createSubscriptionIntent("team" as never);
		expect(stripe.subscriptions.create.mock.calls[0][0].items[0].quantity).toBe(
			1,
		);
	});

	it("uses quantity 1 (flat) for enterprise and never counts seats", async () => {
		orgBilling.mockResolvedValue({ stripeCustomerId: "cus_1" } as never);
		stripe.subscriptions.create.mockResolvedValue({
			id: "sub_1",
			latest_invoice: { confirmation_secret: { client_secret: "cs_1" } },
		} as never);

		await createSubscriptionIntent("enterprise" as never);
		expect(stripe.subscriptions.create.mock.calls[0][0].items[0].quantity).toBe(
			1,
		);
		expect(countBillableSeats).not.toHaveBeenCalled();
	});

	it("threads the billing email into ensureCustomer", async () => {
		orgBilling.mockResolvedValue({ stripeCustomerId: "cus_1" } as never);
		vi.mocked(countBillableSeats).mockResolvedValue(1);
		stripe.subscriptions.create.mockResolvedValue({
			id: "sub_1",
			latest_invoice: { confirmation_secret: { client_secret: "cs_1" } },
		} as never);

		await createSubscriptionIntent("team" as never, {
			billingEmail: "ap@test.io",
		});
		expect(stripe.customers.update).toHaveBeenCalledWith("cus_1", {
			email: "ap@test.io",
		});
	});

	it("throws when Stripe returns no invoice", async () => {
		orgBilling.mockResolvedValue({ stripeCustomerId: "cus_1" } as never);
		vi.mocked(countBillableSeats).mockResolvedValue(1);
		stripe.subscriptions.create.mockResolvedValue({
			id: "sub_1",
			latest_invoice: null,
		} as never);
		await expect(createSubscriptionIntent("team" as never)).rejects.toThrow(
			/did not return an invoice/,
		);
	});

	it("throws when the invoice has no payment client secret", async () => {
		orgBilling.mockResolvedValue({ stripeCustomerId: "cus_1" } as never);
		vi.mocked(countBillableSeats).mockResolvedValue(1);
		stripe.subscriptions.create.mockResolvedValue({
			id: "sub_1",
			latest_invoice: { confirmation_secret: { client_secret: null } },
		} as never);
		await expect(createSubscriptionIntent("team" as never)).rejects.toThrow(
			/did not return a payment client secret/,
		);
	});
});

// ── startProTrial ────────────────────────────────────────────────────────────
describe("startProTrial", () => {
	it("creates a card-less 30-day trial, syncs it, and burns the account's trial flag", async () => {
		db.queue.push([{ proTrialConsumedAt: null }]); // user trial flag
		db.queue.push([]); // accountHasLiveSubscription → none
		orgBilling.mockResolvedValue({
			stripeCustomerId: "cus_1",
			status: "none",
		} as never);
		stripe.subscriptions.create.mockResolvedValue({ id: "sub_trial" } as never);
		db.queue.push([]); // final user UPDATE (proTrialConsumedAt stamp)

		await startProTrial();

		const args = stripe.subscriptions.create.mock.calls[0][0];
		expect(args).toMatchObject({
			customer: "cus_1",
			items: [{ price: "price_team", quantity: 1 }],
			trial_period_days: 30,
			trial_settings: { end_behavior: { missing_payment_method: "cancel" } },
			metadata: { organization_id: "org-1" },
		});
		// No card collected → must NOT use the incomplete-payment behavior.
		expect(args.payment_behavior).toBeUndefined();
		expect(syncSubscriptionToBilling).toHaveBeenCalledWith({ id: "sub_trial" });
		// The trial flag is stamped only AFTER Stripe accepts the sub.
		expect(db.update).toHaveBeenCalledTimes(1);
	});

	it("refuses when the account already consumed its trial (flag set)", async () => {
		db.queue.push([{ proTrialConsumedAt: new Date("2026-01-01") }]);
		await expect(startProTrial()).rejects.toThrow(/already used its free Pro trial/);
		expect(stripe.subscriptions.create).not.toHaveBeenCalled();
	});

	it("refuses when the account already owns a live org (flag never stamped)", async () => {
		db.queue.push([{ proTrialConsumedAt: null }]); // flag unset
		db.queue.push([{ status: "active" }]); // but owns a live sub
		await expect(startProTrial()).rejects.toThrow(/already used its free Pro trial/);
		expect(stripe.subscriptions.create).not.toHaveBeenCalled();
	});

	it("refuses when the active org already has a live subscription", async () => {
		db.queue.push([{ proTrialConsumedAt: null }]);
		db.queue.push([]); // no other live org
		orgBilling.mockResolvedValue({
			stripeSubscriptionId: "sub_live",
			status: "trialing",
		} as never);
		await expect(startProTrial()).rejects.toThrow(/already has an active subscription/);
		expect(stripe.subscriptions.create).not.toHaveBeenCalled();
	});
});

// ── getProOffer ──────────────────────────────────────────────────────────────
describe("getProOffer", () => {
	it("offers a 30-day trial to an eligible account", async () => {
		db.queue.push([{ proTrialConsumedAt: null }]); // user flag
		db.queue.push([]); // no live org
		expect(await getProOffer()).toEqual({ kind: "trial", trialDays: 30 });
	});

	it("returns none when billing isn't configured (self-host)", async () => {
		vi.mocked(isStripeConfigured).mockReturnValue(false);
		expect(await getProOffer()).toEqual({ kind: "none" });
		expect(currentActor).not.toHaveBeenCalled();
	});

	it("returns none once the trial flag is stamped", async () => {
		db.queue.push([{ proTrialConsumedAt: new Date() }]);
		expect(await getProOffer()).toEqual({ kind: "none" });
	});

	it("returns none when the account already owns a live org", async () => {
		db.queue.push([{ proTrialConsumedAt: null }]);
		db.queue.push([{ status: "trialing" }]);
		expect(await getProOffer()).toEqual({ kind: "none" });
	});
});

// ── getCollaborationAccess ───────────────────────────────────────────────────
describe("getCollaborationAccess", () => {
	it("is false for the personal scope without consulting the gate", async () => {
		actor.mockResolvedValue({ orgId: "user-1", userId: "user-1" } as never);
		expect(await getCollaborationAccess()).toEqual({ canInvite: false });
		expect(canOrgInvite).not.toHaveBeenCalled();
	});

	it("delegates to canOrgInvite for a real org", async () => {
		vi.mocked(canOrgInvite).mockResolvedValue(true);
		expect(await getCollaborationAccess()).toEqual({ canInvite: true });
		expect(canOrgInvite).toHaveBeenCalledWith("org-1");
	});
});

// ── isOrgSlugAvailable ───────────────────────────────────────────────────────
describe("isOrgSlugAvailable", () => {
	it("rejects an empty slug", async () => {
		expect(await isOrgSlugAvailable("   ")).toBe(false);
		expect(db.select).not.toHaveBeenCalled();
	});

	it("rejects a reserved console slug without hitting the DB", async () => {
		expect(await isOrgSlugAvailable("dashboard")).toBe(false);
		expect(db.select).not.toHaveBeenCalled();
	});

	it("is available when no org owns the normalized slug", async () => {
		db.queue.push([]); // no row
		expect(await isOrgSlugAvailable("Acme-Co")).toBe(true);
	});

	it("is unavailable when an org already owns the slug", async () => {
		db.queue.push([{ id: "org-x" }]);
		expect(await isOrgSlugAvailable("taken")).toBe(false);
	});
});

// ── createNewOrgSubscriptionIntent (deferred create-org flow) ─────────────────
describe("createNewOrgSubscriptionIntent", () => {
	it("mints a bare customer (created_by only) and returns the intent + customer", async () => {
		db.queue.push([{ email: "owner@test.io", name: "Owner" }]);
		stripe.customers.create.mockResolvedValue({ id: "cus_new" } as never);
		stripe.subscriptions.create.mockResolvedValue({
			id: "sub_2",
			latest_invoice: { confirmation_secret: { client_secret: "cs_2" } },
		} as never);

		const r = await createNewOrgSubscriptionIntent("team" as never, {
			orgName: "NewCo",
		});

		expect(r).toEqual({
			clientSecret: "cs_2",
			subscriptionId: "sub_2",
			customerId: "cus_new",
			currency: "usd",
		});
		expect(stripe.customers.create).toHaveBeenCalledWith({
			email: "owner@test.io",
			name: "NewCo",
			metadata: { created_by: "user-1" },
		});
		const subArgs = stripe.subscriptions.create.mock.calls[0][0];
		expect(subArgs.items).toEqual([{ price: "price_team", quantity: 1 }]);
		expect(subArgs.metadata).toEqual({ created_by: "user-1" });
	});

	it("reuses a prior customer this actor owns instead of minting a new one", async () => {
		stripe.customers.retrieve.mockResolvedValue({
			id: "cus_prior",
			deleted: false,
			metadata: { created_by: "user-1" },
		} as never);
		stripe.subscriptions.create.mockResolvedValue({
			id: "sub_3",
			latest_invoice: { confirmation_secret: { client_secret: "cs_3" } },
		} as never);

		const r = await createNewOrgSubscriptionIntent("team" as never, {
			orgName: "NewCo",
			customerId: "cus_prior",
		});

		expect(r.customerId).toBe("cus_prior");
		expect(stripe.customers.create).not.toHaveBeenCalled();
	});

	it("mints a fresh customer when the provided one belongs to someone else", async () => {
		stripe.customers.retrieve.mockResolvedValue({
			id: "cus_other",
			deleted: false,
			metadata: { created_by: "intruder" },
		} as never);
		db.queue.push([{ email: "owner@test.io", name: "Owner" }]);
		stripe.customers.create.mockResolvedValue({ id: "cus_mine" } as never);
		stripe.subscriptions.create.mockResolvedValue({
			id: "sub_4",
			latest_invoice: { confirmation_secret: { client_secret: "cs_4" } },
		} as never);

		const r = await createNewOrgSubscriptionIntent("team" as never, {
			orgName: "NewCo",
			customerId: "cus_other",
		});

		expect(r.customerId).toBe("cus_mine");
		expect(stripe.customers.create).toHaveBeenCalled();
	});

	it("cancels a prior incomplete subscription, swallowing a cleanup failure", async () => {
		db.queue.push([{ email: "owner@test.io", name: "Owner" }]);
		stripe.customers.create.mockResolvedValue({ id: "cus_new" } as never);
		stripe.subscriptions.cancel.mockRejectedValue(new Error("already gone"));
		stripe.subscriptions.create.mockResolvedValue({
			id: "sub_5",
			latest_invoice: { confirmation_secret: { client_secret: "cs_5" } },
		} as never);

		await expect(
			createNewOrgSubscriptionIntent("team" as never, {
				orgName: "NewCo",
				priorSubscriptionId: "sub_old",
			}),
		).resolves.toMatchObject({ subscriptionId: "sub_5" });
		expect(stripe.subscriptions.cancel).toHaveBeenCalledWith("sub_old");
	});

	it("throws when Stripe returns no invoice secret", async () => {
		db.queue.push([{ email: "owner@test.io", name: "Owner" }]);
		stripe.customers.create.mockResolvedValue({ id: "cus_new" } as never);
		stripe.subscriptions.create.mockResolvedValue({
			id: "sub_6",
			latest_invoice: "in_str",
		} as never);
		await expect(
			createNewOrgSubscriptionIntent("team" as never, { orgName: "NewCo" }),
		).rejects.toThrow(/did not return an invoice/);
	});
});

// ── linkSubscriptionToNewOrg ─────────────────────────────────────────────────
describe("linkSubscriptionToNewOrg", () => {
	const input = {
		orgId: "org-1",
		subscriptionId: "sub_1",
		customerId: "cus_1",
	};

	it("stamps the org id on the customer + sub and syncs the billing row", async () => {
		stripe.subscriptions.retrieve.mockResolvedValue({
			id: "sub_1",
			customer: "cus_1",
			metadata: {},
		} as never);
		stripe.customers.retrieve.mockResolvedValue({
			deleted: false,
			metadata: { created_by: "user-1" },
		} as never);
		db.queue.push([{ name: "LinkedCo" }]);
		const linked = { id: "sub_1", metadata: { organization_id: "org-1" } };
		stripe.subscriptions.update.mockResolvedValue(linked as never);

		await linkSubscriptionToNewOrg(input);

		expect(stripe.customers.update).toHaveBeenCalledWith("cus_1", {
			name: "LinkedCo",
			metadata: { created_by: "user-1", organization_id: "org-1" },
		});
		expect(stripe.subscriptions.update).toHaveBeenCalledWith("sub_1", {
			metadata: { created_by: "user-1", organization_id: "org-1" },
		});
		expect(syncSubscriptionToBilling).toHaveBeenCalledWith(linked);
		// #4133: the permission is asked about the org this call NAMED, never about whichever one
		// the session happens to be on. The sheet runs on the current org's page, so those differ by
		// construction for the whole life of this flow.
		expect(authzInOrg).toHaveBeenCalledWith(
			"manage_billing",
			{ type: "billing" },
			input.orgId,
		);
	});

	// #4133 CHANGED WHAT THIS ASKS, and the change is the point. It used to be "the new org must be
	// the ACTIVE one" — a check against the session, which passed only because
	// `setActiveOrganization` had already run. The sheet that calls this is open on the CURRENT
	// org's page, so under a URL-derived tenant that equality is now FALSE for a correct flow. The
	// question is asked of the named org instead: may this caller manage billing in THAT org.
	it("refuses when the caller is not scoped to the org it named", async () => {
		authzInOrg.mockRejectedValue(new Error("not scoped to organization org-1"));
		await expect(linkSubscriptionToNewOrg(input)).rejects.toThrow(
			/not scoped to organization/,
		);
	});

	it("refuses when the sub's customer doesn't match", async () => {
		stripe.subscriptions.retrieve.mockResolvedValue({
			customer: "cus_OTHER",
			metadata: {},
		} as never);
		await expect(linkSubscriptionToNewOrg(input)).rejects.toThrow(
			/does not match the expected customer/,
		);
	});

	it("refuses a sub already linked to an org", async () => {
		stripe.subscriptions.retrieve.mockResolvedValue({
			customer: "cus_1",
			metadata: { organization_id: "org-existing" },
		} as never);
		await expect(linkSubscriptionToNewOrg(input)).rejects.toThrow(
			/already linked/,
		);
	});

	it("refuses when the customer wasn't minted by this actor", async () => {
		stripe.subscriptions.retrieve.mockResolvedValue({
			customer: "cus_1",
			metadata: {},
		} as never);
		stripe.customers.retrieve.mockResolvedValue({
			deleted: false,
			metadata: { created_by: "intruder" },
		} as never);
		await expect(linkSubscriptionToNewOrg(input)).rejects.toThrow(
			/Not allowed to link/,
		);
	});
});

// ── attachTaxIdToCustomer / setCustomerBillingAddress (pre-org, created_by-gated)
describe("attachTaxIdToCustomer", () => {
	it("replaces existing tax ids with the new one", async () => {
		stripe.customers.retrieve.mockResolvedValue({
			deleted: false,
			metadata: { created_by: "user-1" },
		} as never);
		stripe.customers.listTaxIds.mockResolvedValue({
			data: [{ id: "txi_old" }],
		} as never);

		const r = await attachTaxIdToCustomer({
			customerId: "cus_1",
			type: "eu_vat" as never,
			value: "  DE123456789  ",
		});

		expect(r).toEqual({ ok: true });
		expect(stripe.customers.deleteTaxId).toHaveBeenCalledWith("cus_1", "txi_old");
		expect(stripe.customers.createTaxId).toHaveBeenCalledWith("cus_1", {
			type: "eu_vat",
			value: "DE123456789", // trimmed
		});
	});

	it("clears tax ids when given a blank value (no create)", async () => {
		stripe.customers.retrieve.mockResolvedValue({
			deleted: false,
			metadata: { created_by: "user-1" },
		} as never);
		stripe.customers.listTaxIds.mockResolvedValue({
			data: [{ id: "txi_old" }],
		} as never);

		await attachTaxIdToCustomer({
			customerId: "cus_1",
			type: "eu_vat" as never,
			value: "   ",
		});
		expect(stripe.customers.deleteTaxId).toHaveBeenCalledWith("cus_1", "txi_old");
		expect(stripe.customers.createTaxId).not.toHaveBeenCalled();
	});

	it("refuses a customer owned by another actor", async () => {
		stripe.customers.retrieve.mockResolvedValue({
			deleted: false,
			metadata: { created_by: "intruder" },
		} as never);
		await expect(
			attachTaxIdToCustomer({
				customerId: "cus_1",
				type: "eu_vat" as never,
				value: "DE1",
			}),
		).rejects.toThrow(/Not allowed to set a tax id/);
	});
});

describe("setCustomerBillingAddress", () => {
	it("maps the address onto the Stripe customer", async () => {
		stripe.customers.retrieve.mockResolvedValue({
			deleted: false,
			metadata: { created_by: "user-1" },
		} as never);

		const r = await setCustomerBillingAddress({
			customerId: "cus_1",
			address: {
				name: "Jane Co",
				line1: "1 St",
				line2: "Apt 2",
				city: "Berlin",
				state: "BE",
				postalCode: "10115",
				country: "DE",
			},
		});

		expect(r).toEqual({ ok: true });
		expect(stripe.customers.update).toHaveBeenCalledWith("cus_1", {
			name: "Jane Co",
			address: {
				line1: "1 St",
				line2: "Apt 2",
				city: "Berlin",
				state: "BE",
				postal_code: "10115", // mapped from postalCode
				country: "DE",
			},
		});
	});

	it("refuses a customer owned by another actor", async () => {
		stripe.customers.retrieve.mockResolvedValue({
			deleted: false,
			metadata: { created_by: "intruder" },
		} as never);
		await expect(
			setCustomerBillingAddress({
				customerId: "cus_1",
				address: {
					name: "X",
					line1: "1",
					city: "B",
					postalCode: "1",
					country: "DE",
				},
			}),
		).rejects.toThrow(/Not allowed to set an address/);
	});
});

// ── createCreditPackIntent ───────────────────────────────────────────────────
describe("createCreditPackIntent", () => {
	it("creates an invoiced credit pack for the pack's real price + credits", async () => {
		// Packs are paid-tier-only, so the org carries a live AI subscription.
		orgBilling.mockResolvedValue({
			stripeCustomerId: "cus_1",
			aiTier: "ai_plus",
			aiSubscriptionStatus: "active",
		} as never);
		stripe.invoices.create.mockResolvedValue({ id: "in_1" } as never);
		stripe.invoiceItems.create.mockResolvedValue({} as never);
		stripe.invoices.finalizeInvoice.mockResolvedValue({
			id: "in_1",
			confirmation_secret: { client_secret: "ics_1" },
		} as never);

		const r = await createCreditPackIntent("m"); // 20,000 credits / 5900 cents (real catalog)

		expect(r).toEqual({ clientSecret: "ics_1", invoiceId: "in_1" });
		expect(stripe.invoices.create).toHaveBeenCalledWith({
			customer: "cus_1",
			currency: "usd",
			collection_method: "charge_automatically",
			auto_advance: false,
			description: "20,000 AI credits",
			metadata: {
				organization_id: "org-1",
				user_id: "user-1",
				product_type: "ai_credits",
				credits: "20000",
			},
		});
		expect(stripe.invoiceItems.create).toHaveBeenCalledWith({
			customer: "cus_1",
			invoice: "in_1",
			amount: 5900,
			currency: "usd",
			description: "20,000 AI credits",
			metadata: {
				organization_id: "org-1",
				user_id: "user-1",
				product_type: "ai_credits",
				credits: "20000",
			},
		});
		expect(stripe.invoices.finalizeInvoice).toHaveBeenCalledWith("in_1", {
			expand: ["confirmation_secret"],
		});
	});

	it("rejects an unknown pack id", async () => {
		orgBilling.mockResolvedValue({
			aiTier: "ai_plus",
			aiSubscriptionStatus: "active",
		} as never);
		await expect(createCreditPackIntent("xxl")).rejects.toThrow(
			/Unknown credit pack/,
		);
		expect(stripe.invoices.create).not.toHaveBeenCalled();
	});

	it("refuses the personal scope", async () => {
		authz.mockResolvedValue({ orgId: "user-1", userId: "user-1" } as never);
		await expect(createCreditPackIntent("m")).rejects.toThrow(
			/Create an organization/,
		);
	});

	it("refuses the free AI tier (packs top up a paid plan)", async () => {
		orgBilling.mockResolvedValue({ stripeCustomerId: "cus_1" } as never); // no AI sub → ai_free
		await expect(createCreditPackIntent("m")).rejects.toThrow(/paid AI plans/);
		expect(stripe.invoices.create).not.toHaveBeenCalled();
	});

	it("throws when Stripe returns no client secret", async () => {
		orgBilling.mockResolvedValue({
			stripeCustomerId: "cus_1",
			aiTier: "ai_max",
			aiSubscriptionStatus: "active",
		} as never);
		stripe.invoices.create.mockResolvedValue({ id: "in_1" } as never);
		stripe.invoiceItems.create.mockResolvedValue({} as never);
		stripe.invoices.finalizeInvoice.mockResolvedValue({
			id: "in_1",
			confirmation_secret: { client_secret: null },
		} as never);
		await expect(createCreditPackIntent("s")).rejects.toThrow(
			/did not return a payment client secret/,
		);
	});
});

// ── createSetupIntent ────────────────────────────────────────────────────────
describe("createSetupIntent", () => {
	it("creates an off-session card SetupIntent", async () => {
		orgBilling.mockResolvedValue({ stripeCustomerId: "cus_1" } as never);
		stripe.setupIntents.create.mockResolvedValue({
			client_secret: "seti_cs",
		} as never);

		expect(await createSetupIntent()).toEqual({ clientSecret: "seti_cs" });
		expect(stripe.setupIntents.create).toHaveBeenCalledWith({
			customer: "cus_1",
			usage: "off_session",
			payment_method_types: ["card"],
			// The saved card is what every future OFF-SESSION renewal charges, so authentication is
			// requested at setup — the one moment the cardholder is present to complete it (#2372).
			payment_method_options: {
				card: { request_three_d_secure: "automatic" },
			},
		});
	});

	it("refuses the personal scope", async () => {
		authz.mockResolvedValue({ orgId: "user-1", userId: "user-1" } as never);
		await expect(createSetupIntent()).rejects.toThrow(/Create an organization/);
	});
});

// ── the paid-conversion gate, un-mocked at the boundary ─────────────────────
describe("the eligibility gate is really in the path", () => {
	// The gate is mocked OPEN for every test above so they can assert Stripe orchestration. That is
	// only safe while something proves the actions still consult it. The coverage test does that
	// structurally; this does it behaviourally — when the gate refuses, the action must refuse too,
	// and must refuse BEFORE Stripe is touched.
	it("refuses a conversion the eligibility gate declines, without calling Stripe", async () => {
		vi.mocked(assertOrgPaidConversionAllowed).mockRejectedValueOnce(
			new Error("Alethia is not yet able to sell to customers in this country"),
		);
		orgBilling.mockResolvedValue({ stripeCustomerId: "cus_1" } as never);

		await expect(createCheckoutSession("team")).rejects.toThrow(
			/not yet able to sell/,
		);
		expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
	});

	it("throws when Stripe returns no setup secret", async () => {
		orgBilling.mockResolvedValue({ stripeCustomerId: "cus_1" } as never);
		stripe.setupIntents.create.mockResolvedValue({
			client_secret: null,
		} as never);
		await expect(createSetupIntent()).rejects.toThrow(
			/did not return a setup client secret/,
		);
	});
});

// ── listPaymentMethods ───────────────────────────────────────────────────────
describe("listPaymentMethods", () => {
	it("returns [] when there's no Stripe customer", async () => {
		orgBilling.mockResolvedValue({ stripeCustomerId: null } as never);
		expect(await listPaymentMethods()).toEqual([]);
		expect(stripe.paymentMethods.list).not.toHaveBeenCalled();
	});

	it("maps cards and flags the default (string default ref)", async () => {
		orgBilling.mockResolvedValue({ stripeCustomerId: "cus_1" } as never);
		stripe.customers.retrieve.mockResolvedValue({
			invoice_settings: { default_payment_method: "pm_def" },
		} as never);
		stripe.paymentMethods.list.mockResolvedValue({
			data: [
				{
					id: "pm_def",
					card: { brand: "visa", last4: "4242", exp_month: 5, exp_year: 2030 },
				},
				{ id: "pm_2", card: { brand: "amex", last4: "0005", exp_month: 1, exp_year: 2029 } },
			],
		} as never);

		const r = await listPaymentMethods();
		expect(r).toEqual([
			{ id: "pm_def", brand: "visa", last4: "4242", expMonth: 5, expYear: 2030, isDefault: true, backupRank: null },
			{ id: "pm_2", brand: "amex", last4: "0005", expMonth: 1, expYear: 2029, isDefault: false, backupRank: null },
		]);
	});

	it("resolves the default when the ref is an expanded object", async () => {
		orgBilling.mockResolvedValue({ stripeCustomerId: "cus_1" } as never);
		stripe.customers.retrieve.mockResolvedValue({
			invoice_settings: { default_payment_method: { id: "pm_obj" } },
		} as never);
		stripe.paymentMethods.list.mockResolvedValue({
			data: [{ id: "pm_obj", card: { brand: "visa", last4: "1111", exp_month: 2, exp_year: 2031 } }],
		} as never);

		expect((await listPaymentMethods())[0].isDefault).toBe(true);
	});
});

// ── setDefaultPaymentMethod ──────────────────────────────────────────────────
describe("setDefaultPaymentMethod", () => {
	it("throws when there's no billing account", async () => {
		orgBilling.mockResolvedValue({ stripeCustomerId: null } as never);
		await expect(setDefaultPaymentMethod("pm_1")).rejects.toThrow(
			/No billing account/,
		);
	});

	it("updates the customer + active subscription default", async () => {
		orgBilling.mockResolvedValue({
			stripeCustomerId: "cus_1",
			stripeSubscriptionId: "sub_1",
			billingCountry: "BG",
		} as never);
		// The card must belong to this org's customer — otherwise one org could promote another's
		// card by id (#2372).
		stripe.paymentMethods.retrieve.mockResolvedValue({
			customer: "cus_1",
			billing_details: { address: { country: "BG" } },
		} as never);

		expect(await setDefaultPaymentMethod("pm_1")).toEqual({ ok: true });
		expect(stripe.customers.update).toHaveBeenCalledWith("cus_1", {
			invoice_settings: { default_payment_method: "pm_1" },
		});
		expect(stripe.subscriptions.update).toHaveBeenCalledWith("sub_1", {
			default_payment_method: "pm_1",
		});
	});

	it("skips the subscription update when there's no sub", async () => {
		orgBilling.mockResolvedValue({
			stripeCustomerId: "cus_1",
			stripeSubscriptionId: null,
			billingCountry: "BG",
		} as never);
		stripe.paymentMethods.retrieve.mockResolvedValue({
			customer: "cus_1",
			billing_details: { address: { country: "BG" } },
		} as never);
		await setDefaultPaymentMethod("pm_1");
		expect(stripe.subscriptions.update).not.toHaveBeenCalled();
	});
});

// ── detachPaymentMethod ──────────────────────────────────────────────────────
describe("detachPaymentMethod", () => {
	it("throws when there's no billing account", async () => {
		orgBilling.mockResolvedValue({ stripeCustomerId: null } as never);
		await expect(detachPaymentMethod("pm_1")).rejects.toThrow(/No billing account/);
	});

	it("refuses a card belonging to a different customer", async () => {
		orgBilling.mockResolvedValue({ stripeCustomerId: "cus_1" } as never);
		stripe.paymentMethods.retrieve.mockResolvedValue({
			customer: "cus_OTHER",
		} as never);
		await expect(detachPaymentMethod("pm_1")).rejects.toThrow(
			/Payment method not found/,
		);
		expect(stripe.paymentMethods.detach).not.toHaveBeenCalled();
	});

	it("detaches a card owned by the active org's customer", async () => {
		orgBilling.mockResolvedValue({ stripeCustomerId: "cus_1" } as never);
		stripe.paymentMethods.retrieve.mockResolvedValue({
			customer: "cus_1",
		} as never);
		expect(await detachPaymentMethod("pm_1")).toEqual({ ok: true });
		expect(stripe.paymentMethods.detach).toHaveBeenCalledWith("pm_1");
	});
});

// ── cancel / resume subscription ─────────────────────────────────────────────
describe("cancelSubscription / resumeSubscription", () => {
	it("cancelSubscription throws when there's no active subscription", async () => {
		orgBilling.mockResolvedValue({ stripeSubscriptionId: null } as never);
		await expect(cancelSubscription()).rejects.toThrow(/No active subscription/);
	});

	it("cancelSubscription schedules cancel at period end", async () => {
		orgBilling.mockResolvedValue({ stripeSubscriptionId: "sub_1" } as never);
		expect(await cancelSubscription()).toEqual({ ok: true });
		expect(stripe.subscriptions.update).toHaveBeenCalledWith("sub_1", {
			cancel_at_period_end: true,
		});
	});

	it("resumeSubscription clears the pending cancel", async () => {
		orgBilling.mockResolvedValue({ stripeSubscriptionId: "sub_1" } as never);
		expect(await resumeSubscription()).toEqual({ ok: true });
		expect(stripe.subscriptions.update).toHaveBeenCalledWith("sub_1", {
			cancel_at_period_end: false,
		});
	});
});

// ── changeSubscriptionPlan ───────────────────────────────────────────────────
describe("changeSubscriptionPlan", () => {
	it("swaps only the flat item (prorated) when no meter is configured", async () => {
		orgBilling.mockResolvedValue({ stripeSubscriptionId: "sub_1" } as never);
		stripe.subscriptions.retrieve.mockResolvedValue({
			items: { data: [{ id: "si_flat", price: { id: "price_team" } }] },
		} as never);

		expect(await changeSubscriptionPlan("enterprise" as never)).toEqual({
			ok: true,
		});
		expect(stripe.subscriptions.update).toHaveBeenCalledWith("sub_1", {
			items: [{ id: "si_flat", price: "price_enterprise" }],
			proration_behavior: "create_prorations",
		});
	});

	it("swaps both the flat AND the existing metered item when meters are configured", async () => {
		vi.mocked(meterPriceIdForPlan).mockImplementation((p: string) =>
			p === "team" ? "meter_team" : "meter_ent",
		);
		orgBilling.mockResolvedValue({ stripeSubscriptionId: "sub_1" } as never);
		stripe.subscriptions.retrieve.mockResolvedValue({
			items: {
				data: [
					{ id: "si_flat", price: { id: "price_team" } },
					{ id: "si_meter", price: { id: "meter_team" } },
				],
			},
		} as never);

		await changeSubscriptionPlan("enterprise" as never);
		expect(stripe.subscriptions.update).toHaveBeenCalledWith("sub_1", {
			items: [
				{ id: "si_flat", price: "price_enterprise" },
				{ id: "si_meter", price: "meter_ent" },
			],
			proration_behavior: "create_prorations",
		});
	});

	it("throws when the subscription has no plan line item", async () => {
		vi.mocked(meterPriceIdForPlan).mockImplementation((p: string) =>
			p === "team" ? "meter_team" : undefined,
		);
		orgBilling.mockResolvedValue({ stripeSubscriptionId: "sub_1" } as never);
		// Every item is a recognised meter → no flat item found.
		stripe.subscriptions.retrieve.mockResolvedValue({
			items: { data: [{ id: "si_meter", price: { id: "meter_team" } }] },
		} as never);

		await expect(changeSubscriptionPlan("enterprise" as never)).rejects.toThrow(
			/no plan line item/,
		);
		expect(stripe.subscriptions.update).not.toHaveBeenCalled();
	});
});

// ── listInvoices ─────────────────────────────────────────────────────────────
describe("listInvoices", () => {
	it("returns [] when the org has no mirrored invoices", async () => {
		orgInvoicesList.mockResolvedValue([]);
		expect(await listInvoices()).toEqual([]);
		// Reads the local table for the active org — no Stripe call.
		expect(orgInvoicesList).toHaveBeenCalledWith("org-1", {});
		expect(stripe.invoices.list).not.toHaveBeenCalled();
	});

	it("maps locally-mirrored invoice rows to the UI shape and forwards filters", async () => {
		const paidAt = new Date("2026-07-01T00:00:00.000Z");
		const periodStart = new Date("2026-06-01T00:00:00.000Z");
		const periodEnd = new Date("2026-07-01T00:00:00.000Z");
		orgInvoicesList.mockResolvedValue([
			{
				id: "uuid-1",
				organizationId: "org-1",
				stripeInvoiceId: "in_1",
				stripeCustomerId: "cus_1",
				number: "ALE-001",
				status: "paid",
				amountTotal: 2000,
				currency: "usd",
				periodStart,
				periodEnd,
				description: "Team plan",
				pdfKey: "org-1/in_1.pdf",
				hostedInvoiceUrl: "https://hosted",
				paidAt,
				createdAt: paidAt,
				updatedAt: paidAt,
			},
		] as never);

		const r = await listInvoices({ status: ["paid"] });
		expect(orgInvoicesList).toHaveBeenCalledWith("org-1", { status: ["paid"] });
		expect(r).toEqual([
			{
				id: "uuid-1",
				number: "ALE-001",
				total: 2000,
				currency: "usd",
				status: "paid",
				paidAt: paidAt.toISOString(),
				periodStart: periodStart.toISOString(),
				periodEnd: periodEnd.toISOString(),
				description: "Team plan",
				hasPdf: true,
				hostedInvoiceUrl: "https://hosted",
			},
		]);
	});

	it("marks hasPdf false when there is neither a stored PDF nor a hosted URL", async () => {
		const paidAt = new Date("2026-07-01T00:00:00.000Z");
		orgInvoicesList.mockResolvedValue([
			{
				id: "uuid-2",
				organizationId: "org-1",
				stripeInvoiceId: "in_2",
				stripeCustomerId: "cus_1",
				number: null,
				status: "void",
				amountTotal: 0,
				currency: "usd",
				periodStart: null,
				periodEnd: null,
				description: null,
				pdfKey: null,
				hostedInvoiceUrl: null,
				paidAt,
				createdAt: paidAt,
				updatedAt: paidAt,
			},
		] as never);
		const [row] = await listInvoices();
		expect(row.hasPdf).toBe(false);
		expect(row.periodStart).toBeNull();
	});

	// #3731. Every assertion above ran with `isStripeConfigured` mocked TRUE, so none of them could
	// see the defect: both invoice reads also called `requireHostedBilling()`, which throws when
	// STRIPE_SECRET_KEY is unset — every self-managed install and every sandbox env. The UI
	// conformance audit hit it as `500 POST …/~/settings/billing/invoices`. Nothing here touches
	// Stripe: the rows come from the mirrored `invoice` table this deployment already owns.
	it("still reads the mirrored table when Stripe is NOT configured", async () => {
		vi.mocked(isStripeConfigured).mockReturnValue(false);
		orgInvoicesList.mockResolvedValue([]);

		await expect(listInvoices({})).resolves.toEqual([]);
		expect(orgInvoicesList).toHaveBeenCalledWith("org-1", {});
		expect(stripe.invoices.list).not.toHaveBeenCalled();
	});
});

describe("getInvoice", () => {
	it("maps a single mirrored invoice, or null when it isn't the org's", async () => {
		orgInvoiceGet.mockResolvedValue(null);
		expect(await getInvoice("nope")).toBeNull();
		expect(orgInvoiceGet).toHaveBeenCalledWith("org-1", "nope");
	});

	// The single-invoice sibling read, same defect (#3731). It has no production caller, so it was
	// not one of the two 500s — but it carried the same guard over the same table.
	it("still reads the mirrored table when Stripe is NOT configured", async () => {
		vi.mocked(isStripeConfigured).mockReturnValue(false);
		orgInvoiceGet.mockResolvedValue(null);
		await expect(getInvoice("uuid-1")).resolves.toBeNull();
		expect(orgInvoiceGet).toHaveBeenCalledWith("org-1", "uuid-1");
	});
});

// ── listTransactions (charge → transaction mapping) ──────────────────────────
describe("listTransactions", () => {
	it("returns [] without a customer", async () => {
		orgBilling.mockResolvedValue({ stripeCustomerId: null } as never);
		expect(await listTransactions()).toEqual([]);
	});

	it("normalizes a succeeded card charge to a paid transaction", async () => {
		orgBilling.mockResolvedValue({ stripeCustomerId: "cus_1" } as never);
		stripe.charges.list.mockResolvedValue({
			data: [
				{
					id: "ch_1",
					description: null,
					status: "succeeded",
					amount: 2000,
					amount_refunded: 0,
					refunded: false,
					currency: "usd",
					created: 1_700_000_000,
					payment_method_details: { card: { brand: "visa", last4: "4242" } },
				},
			],
		} as never);

		const [t] = await listTransactions();
		expect(t).toEqual({
			id: "ch_1",
			description: "Subscription payment", // fallback
			status: "paid",
			amount: 2000,
			currency: "usd",
			created: new Date(1_700_000_000 * 1000).toISOString(),
			method: "visa ···· 4242",
		});
	});

	it("normalizes a refund to a negative refunded transaction", async () => {
		orgBilling.mockResolvedValue({ stripeCustomerId: "cus_1" } as never);
		stripe.charges.list.mockResolvedValue({
			data: [
				{
					id: "ch_2",
					description: "Pack",
					status: "succeeded",
					amount: 2000,
					amount_refunded: 500,
					refunded: false,
					currency: "usd",
					created: 1_700_000_000,
					payment_method_details: null,
				},
			],
		} as never);

		const [t] = await listTransactions();
		expect(t.status).toBe("refunded");
		expect(t.amount).toBe(-500);
		expect(t.method).toBeNull();
	});

	it("maps a failed charge to a failed transaction", async () => {
		orgBilling.mockResolvedValue({ stripeCustomerId: "cus_1" } as never);
		stripe.charges.list.mockResolvedValue({
			data: [
				{
					id: "ch_3",
					description: "x",
					status: "failed",
					amount: 1000,
					amount_refunded: 0,
					refunded: false,
					currency: "usd",
					created: 1_700_000_000,
				},
			],
		} as never);
		expect((await listTransactions())[0].status).toBe("failed");
	});
});

// ── getPlanHistory ───────────────────────────────────────────────────────────
describe("getPlanHistory", () => {
	it("returns [] for the personal scope", async () => {
		authz.mockResolvedValue({ orgId: "user-1", userId: "user-1" } as never);
		expect(await getPlanHistory()).toEqual([]);
	});

	it("returns [] when the org row is missing", async () => {
		db.queue.push([]); // organization select
		expect(await getPlanHistory()).toEqual([]);
	});

	it("emits a current paid-plan entry (newest first) for a live sub", async () => {
		db.queue.push([
			{ name: "Acme", createdAt: new Date("2026-01-01T00:00:00.000Z") },
		]);
		orgBilling.mockResolvedValue({
			plan: "team",
			status: "active",
			currentPeriodEnd: new Date("2026-07-01T00:00:00.000Z"),
		} as never);

		const r = await getPlanHistory();
		expect(r).toHaveLength(2);
		expect(r[0].current).toBe(true); // newest first → the plan entry
		expect(r[0].title).toMatch(/plan/i);
		expect(r[1].title).toBe("Organization created");
		expect(r[1].current).toBe(false);
	});

	it("marks the 'created' entry current when there's no live paid plan", async () => {
		db.queue.push([
			{ name: "Acme", createdAt: new Date("2026-01-01T00:00:00.000Z") },
		]);
		orgBilling.mockResolvedValue({ plan: "community", status: "none" } as never);

		const r = await getPlanHistory();
		expect(r).toHaveLength(1);
		expect(r[0].title).toBe("Organization created");
		expect(r[0].current).toBe(true);
	});
});

// ── getBillingDetails ────────────────────────────────────────────────────────
describe("getBillingDetails", () => {
	it("returns null without a customer", async () => {
		orgBilling.mockResolvedValue({ stripeCustomerId: null } as never);
		expect(await getBillingDetails()).toBeNull();
	});

	it("returns null when the customer was deleted", async () => {
		orgBilling.mockResolvedValue({ stripeCustomerId: "cus_1" } as never);
		stripe.customers.retrieve.mockResolvedValue({ deleted: true } as never);
		expect(await getBillingDetails()).toBeNull();
	});

	it("maps the customer's contact + address + first tax id", async () => {
		orgBilling.mockResolvedValue({ stripeCustomerId: "cus_1" } as never);
		stripe.customers.retrieve.mockResolvedValue({
			name: "Acme",
			email: "ap@acme.io",
			address: {
				line1: "1 St",
				line2: null,
				city: "Berlin",
				state: null,
				postal_code: "10115",
				country: "DE",
			},
		} as never);
		stripe.customers.listTaxIds.mockResolvedValue({
			data: [{ value: "DE123" }],
		} as never);

		expect(await getBillingDetails()).toEqual({
			name: "Acme",
			email: "ap@acme.io",
			line1: "1 St",
			line2: "",
			city: "Berlin",
			state: "",
			postalCode: "10115",
			country: "DE",
			taxId: "DE123",
		});
	});
});

// ── updateBillingAddress / saveTaxId (org-scoped) ────────────────────────────
describe("updateBillingAddress", () => {
	it("throws without a billing account", async () => {
		orgBilling.mockResolvedValue({ stripeCustomerId: null } as never);
		await expect(
			updateBillingAddress({
				name: "X",
				line1: "1",
				city: "B",
				postalCode: "1",
				country: "DE",
			}),
		).rejects.toThrow(/No billing account/);
	});

	it("writes the mapped address to the org's customer", async () => {
		orgBilling.mockResolvedValue({ stripeCustomerId: "cus_1" } as never);
		await updateBillingAddress({
			name: "Acme",
			line1: "1 St",
			city: "Berlin",
			postalCode: "10115",
			country: "DE",
		});
		expect(stripe.customers.update).toHaveBeenCalledWith("cus_1", {
			name: "Acme",
			address: {
				line1: "1 St",
				line2: undefined,
				city: "Berlin",
				state: undefined,
				postal_code: "10115",
				country: "DE",
			},
		});
	});
});

describe("saveTaxId", () => {
	it("throws without a billing account", async () => {
		orgBilling.mockResolvedValue({ stripeCustomerId: null } as never);
		await expect(saveTaxId("eu_vat" as never, "DE1")).rejects.toThrow(
			/No billing account/,
		);
	});

	it("replaces existing tax ids with the trimmed value", async () => {
		orgBilling.mockResolvedValue({ stripeCustomerId: "cus_1" } as never);
		stripe.customers.listTaxIds.mockResolvedValue({
			data: [{ id: "txi_a" }, { id: "txi_b" }],
		} as never);

		await saveTaxId("eu_vat" as never, "  DE999  ");
		expect(stripe.customers.deleteTaxId).toHaveBeenCalledTimes(2);
		expect(stripe.customers.createTaxId).toHaveBeenCalledWith("cus_1", {
			type: "eu_vat",
			value: "DE999",
		});
	});

	it("clears tax ids when given a blank value", async () => {
		orgBilling.mockResolvedValue({ stripeCustomerId: "cus_1" } as never);
		stripe.customers.listTaxIds.mockResolvedValue({
			data: [{ id: "txi_a" }],
		} as never);

		await saveTaxId("eu_vat" as never, "   ");
		expect(stripe.customers.deleteTaxId).toHaveBeenCalledWith("cus_1", "txi_a");
		expect(stripe.customers.createTaxId).not.toHaveBeenCalled();
	});
});

// ── createBillingPortalSession ───────────────────────────────────────────────
describe("createBillingPortalSession", () => {
	it("throws when there's no customer yet", async () => {
		orgBilling.mockResolvedValue({ stripeCustomerId: null } as never);
		await expect(createBillingPortalSession()).rejects.toThrow(
			/No billing account yet/,
		);
	});

	it("opens the portal with the configured return url", async () => {
		orgBilling.mockResolvedValue({ stripeCustomerId: "cus_1" } as never);
		stripe.billingPortal.sessions.create.mockResolvedValue({
			url: "https://portal.test",
		} as never);

		expect(await createBillingPortalSession()).toEqual({
			url: "https://portal.test",
		});
		expect(stripe.billingPortal.sessions.create).toHaveBeenCalledWith({
			customer: "cus_1",
			return_url: "https://app.test/dashboard/settings/billing",
		});
	});
});
