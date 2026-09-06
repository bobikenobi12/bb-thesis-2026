"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Billing server actions (hosted): start a Stripe Checkout to upgrade the active org's
// plan, or open the Customer Portal to manage an existing subscription. Both are
// owner-gated (the manage_billing permission via the PDP) and operate on the actor's
// active org — never a client-supplied org id. Stripe then drives the
// organization_billing record through the webhook; entitlements follow.

import { and, count, eq } from "drizzle-orm";
import type Stripe from "stripe";
import { RESERVED_SLUGS } from "@/lib/routing";
import {
	aiPaidTiersEnabled,
	aiPriceIdForTier,
	deploymentMode,
	getStripeConfig,
	isStripeConfigured,
	isStripeTaxEnabled,
	meterPriceIdForPlan,
	type PaidAiTier,
	type PaidPlan,
	priceIdForPlan,
} from "@/lib/billing/config";
import { creditPack } from "@/lib/billing/ai-credits";
import {
	AI_SESSION_WINDOW_MS,
	type AiTier,
	type AiPlanContext,
	aiTierSpec,
	effectiveAiTierSpec,
	resolveAiPlan,
	resolveAiTier,
} from "@/lib/billing/ai-plan";
import { canOrgInvite } from "@/lib/billing/collaboration";
import { effectiveBillingPeriodStart } from "@/lib/billing/period";
import {
	type PaidConversionContext,
	assertOrgPaidConversionAllowed,
	assertPaidConversionAllowed,
	hasAcceptedCurrentDocuments,
} from "@/lib/billing/eligibility";
import type { PayerCapacity } from "@repo/legal/commerce";
import { countBillableSeats } from "@/lib/billing/seats";
import type { TaxIdType } from "@/lib/billing/tax-ids";
import { type SupportedCurrency, planMeta } from "@repo/plan-catalog";
import { currencyFromRequest } from "@/lib/billing/currency";
import { resolvePlanEntitlements } from "@/lib/billing/plan";
import { getOrgBilling, upsertOrgBilling } from "@/lib/billing/queries";
import { getOrgInvoice, listOrgInvoices } from "@/lib/billing/invoices";
import { backupRankOf, setBackupOrder } from "@/lib/billing/payment-methods";
import {
	getAllAiPrices,
	getAllPlanPrices,
	getPlanPrice,
	type LiveAiPriceMap,
	type LivePlanPriceMap,
} from "@/lib/billing/pricing";
import { getStripe } from "@/lib/billing/stripe";
import { mapStatus, syncSubscriptionToBilling } from "@/lib/billing/sync";
import { computeUsage, type UsageSummary } from "@/lib/billing/usage";
import {
	queryJobMinutesByOrg,
	queryJobMinutesSeries,
} from "@/lib/queries/runner-usage";
import {
	aiCreditsSeries,
	oldestUsageSince,
	purchasedBalance,
	sumCredits,
} from "@/lib/billing/ai-quota";
import {
	queryResourceCounts,
	queryRunningJobs,
	type ResourceCounts,
} from "@/lib/queries/usage-counts";
import { authorize, authorizeInOrg, authorizeQuiet, currentActor } from "@/lib/authz/guard";
import { getServiceDb } from "@/lib/db";
import type {
	BillingPlan,
	BillingStatus,
	InvoiceStatus,
} from "@/lib/db/schema/enums";
import {
	type Invoice,
	member,
	organization,
	organizationBilling,
	user,
} from "@/lib/db/schema";

/**
 * The single, coherent plan lifecycle state the billing card renders off — derived from the
 * live subscription so the badge, period wording, "next charge" line, and CTA can never
 * disagree. `canceling` = live but set to cancel at period end (show "Cancels …" + "Resume");
 * the rest map straight from `BillingStatus`.
 */
export type PlanState =
	| "none"
	| "trialing"
	| "active"
	| "canceling"
	| "past_due"
	| "canceled";

/** Collapses status + the cancel-at-period-end flag into one coherent lifecycle state. */
function derivePlanState(
	status: BillingStatus,
	cancelAtPeriodEnd: boolean,
): PlanState {
	if (cancelAtPeriodEnd && (status === "active" || status === "trialing")) {
		return "canceling";
	}
	return status;
}

/** Read-only billing state for the active org, for the /settings/billing page. */
export interface BillingSummary {
	/** Stripe is wired on this deployment (hosted). Self-managed → no upgrade UI. */
	hosted: boolean;
	/** The actor has a real workspace (org), not just their personal scope. */
	hasOrg: boolean;
	plan: BillingPlan;
	status: BillingStatus;
	/** The one coherent lifecycle state that drives every label + CTA on the plan card. */
	state: PlanState;
	/** ISO timestamp the current paid period ends, if subscribed. */
	currentPeriodEnd: string | null;
	/** A Stripe customer exists → cards/invoices are available. */
	canManage: boolean;
	/** The subscription is set to cancel at period end (show "resume"). */
	cancelAtPeriodEnd: boolean;
	/** Subscribed seat count (Team's per-seat quantity), or null for flat plans. */
	seats: number | null;
	/** Current members in the org — the "used" side of the seats meter. */
	memberCount: number;
	/**
	 * The actual per-seat (or flat) monthly USD the org is billed — read live from the
	 * subscription's Stripe price (so a grandfathered sub shows its real amount), or the
	 * live plan price when there's no sub. null = custom/unknown. Stripe is authoritative;
	 * never compute the displayed amount from the catalog.
	 */
	unitAmountUsd: number | null;
}

/** Resolves the active org's billing state for display (read-only; any member). */
export async function getBillingSummary(): Promise<BillingSummary> {
	const actor = await currentActor();
	const hasOrg = actor.orgId !== actor.userId;
	const billing = hasOrg ? await getOrgBilling(actor.orgId) : null;

	// Member count seeds the seats meter; only meaningful in a real org.
	let memberCount = 0;
	if (hasOrg) {
		const [c] = await getServiceDb()
			.select({ n: count() })
			.from(member)
			.where(eq(member.organizationId, actor.orgId));
		memberCount = c?.n ?? 0;
	}

	const plan = billing?.plan ?? "community";
	// Default to the DB row, then let a readable live subscription override the fields the
	// card renders (status / period / cancel flag) — so a stale or half-synced DB row can
	// never produce a self-contradictory card (e.g. "Canceled" next to "Renews …").
	let status: BillingStatus = billing?.status ?? "none";
	let cancelAtPeriodEnd = false;
	let currentPeriodEnd: string | null =
		billing?.currentPeriodEnd?.toISOString() ?? null;
	// Authoritative price: the subscription's OWN flat (non-metered) Stripe price — this
	// reflects what the org is actually charged, including grandfathered amounts.
	let unitAmountUsd: number | null = null;
	if (billing?.stripeSubscriptionId && isStripeConfigured()) {
		try {
			const sub = await getStripe().subscriptions.retrieve(
				billing.stripeSubscriptionId,
			);
			status = mapStatus(sub.status);
			cancelAtPeriodEnd = sub.cancel_at_period_end;
			const flat = sub.items.data.find(
				(i) => i.price.recurring?.usage_type !== "metered",
			);
			// Only a LIVE (active/trialing) sub reflects what the org is actually billed. A
			// canceled/past_due sub has reverted to Hobby, so its old price must NOT leak
			// through (otherwise a canceled org shows "Hobby · $20/mo"). Same gate applies to
			// the period end — a lapsed sub shows no renewal/cancellation date.
			const live = status === "active" || status === "trialing";
			if (live && typeof flat?.price.unit_amount === "number") {
				unitAmountUsd = flat.price.unit_amount / 100;
			}
			currentPeriodEnd =
				live && flat?.current_period_end
					? new Date(flat.current_period_end * 1000).toISOString()
					: null;
		} catch {
			// Subscription unreadable (deleted upstream) — fall back to the DB row.
		}
	}
	// No live sub price (or no sub yet) → fall back to the plan's live Stripe price.
	if (unitAmountUsd === null && plan !== "community") {
		unitAmountUsd = (await getPlanPrice(plan)).unitAmountUsd;
	}

	return {
		hosted: isStripeConfigured(),
		hasOrg,
		plan,
		status,
		state: derivePlanState(status, cancelAtPeriodEnd),
		currentPeriodEnd,
		canManage: Boolean(billing?.stripeCustomerId),
		cancelAtPeriodEnd,
		seats: billing?.seats ?? null,
		memberCount,
		unitAmountUsd,
	};
}

/** Live prices for every plan (Stripe-authoritative, catalog fallback) — the buy-flow's
 *  single fetch, consumed client-side via useLivePlanPrice. Any caller. */
export async function getLivePlanPrices(): Promise<LivePlanPriceMap> {
	return getAllPlanPrices();
}

/** Live prices for every standalone AI tier (Stripe-authoritative, catalog fallback) —
 *  consumed client-side via useLiveAiPrice. Degrades to the placeholder catalog prices when
 *  the AI Stripe prices aren't configured (pre-cutover). Any caller. */
export async function getLiveAiPrices(): Promise<LiveAiPriceMap> {
	return getAllAiPrices();
}

/** Managed-runner usage for the active org's current period (read-only; any member). */
export interface UsageReport extends UsageSummary {
	periodStart: string;
	periodEnd: string;
	plan: BillingPlan;
	/** "Pause at the included allowance instead of billing overage" is enabled. */
	hardCap: boolean;
	/** Jobs currently in flight (CLAIMED/PROCESSING) — the concurrency gauge "used". */
	runningJobs: number;
	/** The plan's max concurrent jobs, or null when unlimited (Enterprise). */
	maxConcurrentJobs: number | null;
}

/**
 * Job-minutes consumed on managed runners this period vs the plan's included
 * allowance, with the overage estimate. The customer-facing usage meter
 * (lib/billing/usage). Self-hosted runners never count.
 */
export async function getOrgUsage(): Promise<UsageReport> {
	const actor = await currentActor();
	const billing = await getOrgBilling(actor.orgId).catch(() => null);
	const plan = billing?.plan ?? "community";
	const status = billing?.status ?? "none";
	const quotas = resolvePlanEntitlements(plan, status).quotas;
	const included = quotas.includedRunnerMinutes;

	const now = new Date();
	const from = effectiveBillingPeriodStart(
		billing?.currentPeriodStart,
		billing?.currentPeriodEnd,
		now,
	);

	const hasOrg = actor.orgId !== actor.userId;
	const [rows, runningJobs] = await Promise.all([
		queryJobMinutesByOrg(getServiceDb(), { from, to: now, orgId: actor.orgId }),
		hasOrg ? queryRunningJobs(actor.orgId) : Promise.resolve(0),
	]);
	const used = rows[0]?.job_minutes ?? 0;

	return {
		...computeUsage(used, included),
		periodStart: from.toISOString(),
		periodEnd: (billing?.currentPeriodEnd ?? now).toISOString(),
		plan,
		hardCap: billing?.usageHardCap ?? false,
		runningJobs,
		maxConcurrentJobs: quotas.maxConcurrentJobs,
	};
}

// ── Usage page: resource counts, over-time series, AI summary ───────────────

/** Point-in-time resource counts for the active org's Usage page (read-only; any member). */
export type ResourceCountsReport = ResourceCounts;

/** Projects / clusters counts + estimated spend under management for the active org. */
export async function getResourceCounts(): Promise<ResourceCountsReport> {
	const actor = await currentActor();
	if (actor.orgId === actor.userId) {
		return { projects: 0, clusters: 0, spendUnderManagement: 0 };
	}
	return queryResourceCounts(actor.orgId);
}

/** One day of cumulative usage for the over-time chart. */
export interface UsagePoint {
	/** ISO date (YYYY-MM-DD), the bucket's UTC day. */
	date: string;
	runnerMinutes: number;
	jobs: number;
	aiCredits: number;
}

/** Range-windowed cumulative usage (the picker-driven section of the Usage page). */
export interface UsageOverTime {
	series: UsagePoint[];
	totals: { runnerMinutes: number; jobs: number; aiCredits: number };
}

/** Inclusive list of UTC day keys (YYYY-MM-DD) spanning [from, to], to fill chart gaps. */
function utcDayKeys(from: Date, to: Date): string[] {
	const keys: string[] = [];
	const cursor = new Date(
		Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()),
	);
	const end = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
	// Guard against an inverted range; cap at ~13 months so a 12-month preset is safe.
	for (let i = 0; cursor.getTime() <= end && i < 400; i++) {
		keys.push(cursor.toISOString().slice(0, 10));
		cursor.setUTCDate(cursor.getUTCDate() + 1);
	}
	return keys;
}

/**
 * Cumulative usage over an arbitrary window for the active org — runner-minutes, jobs,
 * and AI credits, day-bucketed onto a continuous axis (empty days are zero-filled).
 * Read-only (any member); managed-runner basis only, matching getOrgUsage. The window
 * is supplied by the client's time-range picker as ISO timestamps.
 */
export async function getUsageOverTime(input: {
	from: string;
	to: string;
}): Promise<UsageOverTime> {
	const actor = await currentActor();
	const from = new Date(input.from);
	const to = new Date(input.to);
	if (
		Number.isNaN(from.getTime()) ||
		Number.isNaN(to.getTime()) ||
		from >= to ||
		actor.orgId === actor.userId
	) {
		return { series: [], totals: { runnerMinutes: 0, jobs: 0, aiCredits: 0 } };
	}

	const [minuteRows, aiRows] = await Promise.all([
		queryJobMinutesSeries(getServiceDb(), { from, to, orgId: actor.orgId }),
		aiCreditsSeries(actor.orgId, from, to),
	]);
	const minuteByDay = new Map(minuteRows.map((r) => [r.day, r]));
	const aiByDay = new Map(aiRows.map((r) => [r.day, r.credits]));

	const series: UsagePoint[] = utcDayKeys(from, to).map((date) => {
		const m = minuteByDay.get(date);
		return {
			date,
			runnerMinutes: Math.round(m?.job_minutes ?? 0),
			jobs: m?.job_count ?? 0,
			aiCredits: aiByDay.get(date) ?? 0,
		};
	});
	const totals = series.reduce(
		(acc, p) => ({
			runnerMinutes: acc.runnerMinutes + p.runnerMinutes,
			jobs: acc.jobs + p.jobs,
			aiCredits: acc.aiCredits + p.aiCredits,
		}),
		{ runnerMinutes: 0, jobs: 0, aiCredits: 0 },
	);
	return { series, totals };
}

/**
 * The active org's STANDALONE AI standing — rolling 5-hour session + fixed weekly included
 * spend vs the AI tier's caps (the % denominators), on the SAME windows the guard
 * (ai-guard.ts) enforces, plus the remaining purchased top-up balance and the tier.
 * Read-only; any member. The single canonical AI-usage action (drives the overview card,
 * the Usage panel, and the billing AI section).
 */
export interface AiUsageSummary {
	/** AI enabled for this org's tier (always true today; future-proofs a disabled tier). */
	enabled: boolean;
	/** The org's standalone AI tier (independent of the org plan). */
	tier: AiTier;
	/** Included credits used inside the rolling 5-hour session window. */
	sessionUsed: number;
	/** The tier's session included-credit cap (the session-% denominator). */
	sessionBudget: number;
	/**
	 * When the current session fully clears: oldest in-window usage + 5h (ISO). `null`
	 * when there is no usage in the window — no active session (the UI shows an idle
	 * state instead of a countdown).
	 */
	sessionResetAt: string | null;
	/** Included credits used in the current fixed week. */
	weeklyUsed: number;
	/** The tier's weekly included-credit cap (the weekly-% denominator). */
	weeklyBudget: number;
	/** When the weekly bucket resets (ISO). */
	weeklyResetAt: string;
	/** Remaining purchased top-up credits (Σ grants − Σ purchased usage). */
	purchasedBalance: number;
	/**
	 * Whether the paid AI tiers + credit packs are self-serve on this deployment (both
	 * Stripe AI prices configured). Drives the upgrade UI's "Coming soon" gate — the only
	 * config signal that crosses to the client (a plain boolean, never the price ids).
	 */
	paidTiersEnabled: boolean;
	/** Admin org-wide weekly spend limit in credits (null = tier default). Reflected in weeklyBudget. */
	orgWeeklyCapCredits: number | null;
	/** Admin per-seat weekly spend limit in credits (null = tier default). */
	perUserWeeklyCapCredits: number | null;
	/** Whether the current actor may edit these spend limits (manage_billing). */
	canManageCaps: boolean;
}

const AI_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export async function getAiUsageSummary(): Promise<AiUsageSummary> {
	const actor = await currentActor();
	const plan = await resolveAiPlan(actor.orgId).catch((): AiPlanContext => ({
		tier: "ai_free",
		hardCap: false,
		orgWeeklyCapCredits: null,
		perUserWeeklyCapCredits: null,
	}));
	// Budgets shown reflect any admin spend limits (min(tier, cap)).
	const spec = effectiveAiTierSpec(aiTierSpec(plan.tier), plan);
	const paidTiersEnabled = aiPaidTiersEnabled();

	// Spend limits are an org-admin control — never offered in personal scope.
	let canManageCaps = false;
	if (actor.orgId !== actor.userId) {
		canManageCaps = await authorizeQuiet("manage_billing", { type: "billing" })
			.then(() => true)
			.catch(() => false);
	}
	const capFields = {
		orgWeeklyCapCredits: plan.orgWeeklyCapCredits,
		perUserWeeklyCapCredits: plan.perUserWeeklyCapCredits,
		canManageCaps,
	};

	const now = Date.now();
	const sessionSince = new Date(now - AI_SESSION_WINDOW_MS);
	const weekStart = new Date(Math.floor(now / AI_WEEK_MS) * AI_WEEK_MS);
	const weeklyResetAt = new Date(weekStart.getTime() + AI_WEEK_MS).toISOString();

	if (actor.orgId === actor.userId) {
		return {
			enabled: spec.enabled,
			tier: plan.tier,
			sessionUsed: 0,
			sessionBudget: spec.sessionCredits,
			sessionResetAt: null,
			weeklyUsed: 0,
			weeklyBudget: spec.weeklyCredits,
			weeklyResetAt,
			purchasedBalance: 0,
			paidTiersEnabled,
			...capFields,
		};
	}

	const [sessionUsed, weeklyUsed, purchased, oldestInWindow] =
		await Promise.all([
			sumCredits(actor.orgId, "included", sessionSince),
			sumCredits(actor.orgId, "included", weekStart),
			purchasedBalance(actor.orgId),
			oldestUsageSince(actor.orgId, "included", sessionSince),
		]);
	return {
		enabled: spec.enabled,
		tier: plan.tier,
		sessionUsed,
		sessionBudget: spec.sessionCredits,
		sessionResetAt: oldestInWindow
			? new Date(oldestInWindow.getTime() + AI_SESSION_WINDOW_MS).toISOString()
			: null,
		weeklyUsed,
		weeklyBudget: spec.weeklyCredits,
		weeklyResetAt,
		purchasedBalance: purchased,
		paidTiersEnabled,
		...capFields,
	};
}

/**
 * Toggle the active org's "pause at included instead of overage" policy
 * (owner-gated). A pure usage-policy flag — independent of Stripe.
 */
export async function setUsageHardCap(enabled: boolean): Promise<void> {
	const actor = await authorize("manage_billing", { type: "billing" });
	await getServiceDb()
		.update(organizationBilling)
		.set({ usageHardCap: enabled, updatedAt: new Date() })
		.where(eq(organizationBilling.organizationId, actor.orgId));
}

/**
 * Set the org's admin AI-spend limits (credits/week) — Claude-Enterprise-style ceilings that
 * only ever TIGHTEN the tier's caps (min(tier, limit)): an org-wide weekly cap and a per-seat
 * weekly cap. Pass `null` to clear a limit (back to the tier default). Owner-gated. A no-op
 * for an org with no billing row (implicitly free — its caps are already the floor).
 */
export async function setAiSpendCaps(
	orgWeeklyCapCredits: number | null,
	perUserWeeklyCapCredits: number | null,
): Promise<void> {
	const actor = await authorize("manage_billing", { type: "billing" });
	const norm = (v: number | null): number | null =>
		v == null || !Number.isFinite(v) || v < 0 ? null : Math.floor(v);
	await getServiceDb()
		.update(organizationBilling)
		.set({
			aiOrgWeeklyCapCredits: norm(orgWeeklyCapCredits),
			aiPerUserWeeklyCapCredits: norm(perUserWeeklyCapCredits),
			updatedAt: new Date(),
		})
		.where(eq(organizationBilling.organizationId, actor.orgId));
}

/** Guards that billing is actually wired (hosted control plane) before any Stripe call. */
function requireHostedBilling(): void {
	if (!isStripeConfigured()) {
		throw new Error(
			`Billing is not enabled on this deployment (${deploymentMode()} mode).`,
		);
	}
}

/** New-subscription items: the flat plan item + (if configured) the graduated metered
 *  runner-minutes item. Metered items carry no quantity. */
function planCreateItems(
	plan: PaidPlan,
	quantity: number,
): Stripe.SubscriptionCreateParams.Item[] {
	const items: Stripe.SubscriptionCreateParams.Item[] = [
		{ price: priceIdForPlan(plan), quantity },
	];
	const meter = meterPriceIdForPlan(plan);
	if (meter) items.push({ price: meter });
	return items;
}

/** Checkout line items: flat plan + (if configured) metered runner-minutes. */
function planCheckoutLineItems(
	plan: PaidPlan,
): Stripe.Checkout.SessionCreateParams.LineItem[] {
	const items: Stripe.Checkout.SessionCreateParams.LineItem[] = [
		{ price: priceIdForPlan(plan), quantity: 1 },
	];
	const meter = meterPriceIdForPlan(plan);
	if (meter) items.push({ price: meter });
	return items;
}

/** All configured metered price IDs — to recognize an existing metered sub item. */
function configuredMeterPriceIds(): Set<string> {
	const ids = new Set<string>();
	for (const p of ["team", "enterprise"] as const) {
		const id = meterPriceIdForPlan(p);
		if (id) ids.add(id);
	}
	return ids;
}

/**
 * Returns the org's Stripe customer id, creating + persisting one on first use. The
 * customer carries organization_id metadata so webhook events resolve back to the org.
 */
async function ensureCustomer(
	orgId: string,
	userId: string,
	billingEmail?: string,
): Promise<string> {
	const billing = await getOrgBilling(orgId);
	if (billing?.stripeCustomerId) {
		if (billingEmail) {
			await getStripe().customers.update(billing.stripeCustomerId, {
				email: billingEmail,
			});
		}
		return billing.stripeCustomerId;
	}

	const db = getServiceDb();
	const [u] = await db
		.select({ email: user.email, name: user.name })
		.from(user)
		.where(eq(user.id, userId))
		.limit(1);
	const [org] = await db
		.select({ name: organization.name })
		.from(organization)
		.where(eq(organization.id, orgId))
		.limit(1);

	const customer = await getStripe().customers.create({
		email: billingEmail || u?.email,
		name: org?.name,
		metadata: { organization_id: orgId, created_by: userId },
	});

	// Persist the customer id without disturbing any existing plan/status.
	await upsertOrgBilling({
		organizationId: orgId,
		plan: billing?.plan ?? "community",
		status: billing?.status ?? "none",
		stripeCustomerId: customer.id,
		stripeSubscriptionId: billing?.stripeSubscriptionId ?? null,
		seats: billing?.seats ?? null,
		currentPeriodEnd: billing?.currentPeriodEnd ?? null,
	});
	return customer.id;
}

/**
 * Cancels a customer's dangling `incomplete` subscriptions — the never-paid first-invoice
 * subs that a re-opened checkout / upgrade sheet would otherwise pile up (each one Stripe
 * auto-generates a draft invoice for). Stateless: it lists Stripe directly rather than the
 * DB, so it cleans up even the subs that were never persisted to organization_billing — the
 * exact leak the old DB-only guard missed. Best-effort per subscription.
 */
async function cancelIncompleteSubscriptions(customerId: string): Promise<void> {
	const stripe = getStripe();
	const subs = await stripe.subscriptions.list({
		customer: customerId,
		status: "incomplete",
		limit: 100,
	});
	for (const s of subs.data) {
		try {
			await stripe.subscriptions.cancel(s.id);
		} catch {
			// Already gone / expired on Stripe's side — ignore.
		}
	}
}

/**
 * Starts a Stripe Checkout to subscribe the active org to a paid plan. Requires a real
 * org (not the personal scope — create a workspace first). Returns the redirect URL.
 */
/**
 * THE gate. Every action below that can take money calls this before it touches Stripe.
 *
 * It is a thin wrapper on purpose: the RULE lives in lib/billing/eligibility.ts, and this only
 * supplies the org's declared payer facts. Six conversion entry points each carrying their own
 * version of the rule is how a compliance requirement becomes decorative — the seventh will not
 * have one — so `tests/billing/eligibility-coverage.test.ts` reds when an exported action in this
 * file reaches Stripe's subscription/payment APIs without passing through here.
 */
async function gatePaidConversion(actor: {
	userId: string;
	orgId: string;
}): Promise<void> {
	await assertOrgPaidConversionAllowed(actor.userId, actor.orgId);
}

export async function createCheckoutSession(
	plan: PaidPlan,
): Promise<{ url: string }> {
	const actor = await authorize("manage_billing", { type: "billing" });
	requireHostedBilling();
	if (actor.orgId === actor.userId) {
		throw new Error("Create an organization before subscribing to a plan.");
	}
	await gatePaidConversion(actor);

	const cfg = getStripeConfig();
	const customerId = await ensureCustomer(actor.orgId, actor.userId);
	// Stripe Tax: compute VAT/sales tax + collect the customer's Tax/VAT id (EU B2B
	// reverse-charge). Gated until the account's Tax settings are configured.
	const tax: Partial<Stripe.Checkout.SessionCreateParams> = isStripeTaxEnabled()
		? {
				automatic_tax: { enabled: true },
				tax_id_collection: { enabled: true },
				customer_update: { name: "auto", address: "auto" },
			}
		: {};
	const session = await getStripe().checkout.sessions.create({
		mode: "subscription",
		customer: customerId,
		line_items: planCheckoutLineItems(plan),
		subscription_data: {
			metadata: { organization_id: actor.orgId },
			// Team gets a one-month free trial (the public "Start free trial" CTA).
			// Flat tiers subscribe immediately.
			...(plan === "team" ? { trial_period_days: 30 } : {}),
		},
		allow_promotion_codes: true,
		...tax,
		success_url: `${cfg.appUrl}/dashboard/settings/billing?checkout=success`,
		cancel_url: `${cfg.appUrl}/dashboard/settings/billing?checkout=cancelled`,
	});
	if (!session.url) throw new Error("Stripe did not return a checkout URL.");
	return { url: session.url };
}

/** A subscription awaiting its first payment, for the embedded Payment Element. */
export interface SubscriptionIntent {
	clientSecret: string;
	subscriptionId: string;
	/** The currency the subscription was created in (Stripe locks it) — drives the UI toggle. */
	currency: SupportedCurrency;
}

/**
 * Creates an incomplete subscription for the active org and returns the client secret
 * of its first invoice's payment — the embedded (in-app) alternative to hosted
 * Checkout. The <PaymentForm> confirms it (card + 3-D Secure inline); the webhook then
 * activates the org. Owner-gated; org-scoped; refuses if a live subscription already
 * exists (use changeSubscriptionPlan instead).
 */
export async function createSubscriptionIntent(
	plan: PaidPlan,
	opts?: { billingEmail?: string; currency?: SupportedCurrency },
): Promise<SubscriptionIntent | { error: string }> {
	const actor = await authorize("manage_billing", { type: "billing" });
	requireHostedBilling();
	if (actor.orgId === actor.userId) {
		return { error: "Create an organization before subscribing to a plan." };
	}
	const existing = await getOrgBilling(actor.orgId);
	if (
		existing?.stripeSubscriptionId &&
		(existing.status === "active" || existing.status === "trialing")
	) {
		return {
			error: "This organization already has an active subscription — change the plan instead.",
		};
	}
	await gatePaidConversion(actor);
	const customerId = await ensureCustomer(
		actor.orgId,
		actor.userId,
		opts?.billingEmail,
	);
	// Void every dangling incomplete sub for this customer before minting a fresh intent, so
	// re-opening the upgrade sheet can never pile up never-paid subs (and their draft
	// invoices). Stateless — works even though an incomplete sub is never persisted to the DB,
	// which is why the old organization_billing-only guard leaked.
	await cancelIncompleteSubscriptions(customerId);
	const taxParam: Partial<Stripe.SubscriptionCreateParams> = isStripeTaxEnabled()
		? { automatic_tax: { enabled: true } }
		: {};
	// Pro is per-seat: seed the quantity from the org's current billable members so an
	// org that already has a team is billed for them at subscribe time. Enterprise is flat.
	const quantity =
		plan === "team" ? Math.max(1, await countBillableSeats(actor.orgId)) : 1;
	// Resolve the billing currency BEFORE creating the subscription (Stripe locks it): an
	// explicit checkout selection wins, else the request's geo (Cloudflare CF-IPCountry).
	// The Price must carry this currency's option (scripts/stripe-setup.ts).
	const currency = opts?.currency ?? (await currencyFromRequest());
	const sub = await getStripe().subscriptions.create({
		customer: customerId,
		items: planCreateItems(plan, quantity),
		currency,
		payment_behavior: "default_incomplete",
		payment_settings: { save_default_payment_method: "on_subscription" },
		expand: ["latest_invoice.confirmation_secret"],
		metadata: { organization_id: actor.orgId },
		...taxParam,
	});

	const invoice = sub.latest_invoice;
	if (!invoice || typeof invoice === "string") {
		throw new Error("Stripe did not return an invoice for the subscription.");
	}
	const clientSecret = invoice.confirmation_secret?.client_secret;
	if (!clientSecret) {
		throw new Error("Stripe did not return a payment client secret.");
	}
	return { clientSecret, subscriptionId: sub.id, currency };
}

/**
 * Creates an incomplete STANDALONE AI subscription (ai_plus/ai_max) for the active org and
 * returns the client secret for its first payment — the embedded Payment Element flow. This
 * is a SEPARATE Stripe subscription from the org plan (its own price IDs), so an org can be
 * e.g. community plan + AI Plus. The webhook (sync.ts → aiTierForPriceId) routes its events
 * to the org's AI columns only. Owner-gated; org-scoped; refuses if a live AI subscription
 * already exists. Mirrors createSubscriptionIntent.
 */
export async function createAiSubscriptionIntent(
	tier: PaidAiTier,
	opts?: { billingEmail?: string; currency?: SupportedCurrency },
): Promise<SubscriptionIntent> {
	const actor = await authorize("manage_billing", { type: "billing" });
	requireHostedBilling();
	if (actor.orgId === actor.userId) {
		throw new Error("Create an organization before subscribing to an AI plan.");
	}
	const existing = await getOrgBilling(actor.orgId);
	if (
		existing?.aiStripeSubscriptionId &&
		(existing.aiSubscriptionStatus === "active" ||
			existing.aiSubscriptionStatus === "trialing")
	) {
		throw new Error(
			"This organization already has an active AI subscription — change it instead.",
		);
	}
	await gatePaidConversion(actor);
	const customerId = await ensureCustomer(
		actor.orgId,
		actor.userId,
		opts?.billingEmail,
	);
	const taxParam: Partial<Stripe.SubscriptionCreateParams> = isStripeTaxEnabled()
		? { automatic_tax: { enabled: true } }
		: {};
	// Resolve the billing currency before creating the sub (Stripe locks it): an explicit
	// selection wins, else the request's geo. The AI Price must carry this currency's option
	// (scripts/stripe-setup.ts provisions USD + EUR).
	const currency = opts?.currency ?? (await currencyFromRequest());
	const sub = await getStripe().subscriptions.create({
		customer: customerId,
		items: [{ price: aiPriceIdForTier(tier), quantity: 1 }],
		currency,
		payment_behavior: "default_incomplete",
		payment_settings: { save_default_payment_method: "on_subscription" },
		expand: ["latest_invoice.confirmation_secret"],
		// product_type lets the webhook recognise an AI sub even before it inspects the
		// price; organization_id resolves the tenant (same as the org-plan sub).
		metadata: { organization_id: actor.orgId, product_type: "ai_subscription" },
		...taxParam,
	});

	const invoice = sub.latest_invoice;
	if (!invoice || typeof invoice === "string") {
		throw new Error("Stripe did not return an invoice for the AI subscription.");
	}
	const clientSecret = invoice.confirmation_secret?.client_secret;
	if (!clientSecret) {
		throw new Error("Stripe did not return a payment client secret.");
	}
	return { clientSecret, subscriptionId: sub.id, currency };
}

/**
 * Starts a 30-day Pro trial for the active org WITHOUT collecting a payment method —
 * zero-friction onboarding. The subscription begins in `trialing` immediately (no
 * invoice, no card); at trial end Stripe CANCELS it if no card was added by then
 * (`missing_payment_method: "cancel"` → the org reverts to community/free; the user can
 * add a card from billing before then to continue). "cancel" is also the only end
 * behavior Stripe allows on a card-less trial that includes a metered item (the
 * runner-minutes meter). Syncs the billing row synchronously so the `organizations`
 * entitlement is live for the whole trial. Owner-gated; hosted-only; refuses if a
 * live/trialing subscription already exists. No automatic_tax here — there's no
 * address/invoice yet; tax is computed when the customer later adds payment.
 */
export async function startProTrial(opts?: {
	currency?: SupportedCurrency;
	/**
	 * The org to start the trial ON, when it is not the ambient one.
	 *
	 * NAMED, not ambient, for the same reason `linkSubscriptionToNewOrg` takes one (#4133). The
	 * create-org sheet runs from a page inside the CURRENT org, creates a new org, and then starts
	 * the trial on it — so under URL-wins the ambient org is the page the sheet is open on, i.e.
	 * the OLD one. Left ambient, the Stripe trial and the `organization_billing` row landed on the
	 * old org, the account's ONE trial was burned, and the new org stayed on `community`. Worse, if
	 * the old org already had a live subscription this threw, and the sheet's rollback then DELETED
	 * the org it had just created.
	 *
	 * Optional because the other caller is `onboarding-form`, which runs on a `(public)` route with
	 * no `[org]` segment — nothing for the URL to name, so the session is the only answer and the
	 * ambient path is correct there.
	 */
	orgId?: string;
}): Promise<void> {
	const actor = opts?.orgId
		? await authorizeInOrg("manage_billing", { type: "billing" }, opts.orgId)
		: await authorize("manage_billing", { type: "billing" });
	requireHostedBilling();
	if (actor.orgId === actor.userId) {
		throw new Error("Create an organization before starting a trial.");
	}
	// One trial per ACCOUNT (not per org) — so spinning up extra orgs grants no extra
	// trials. The ledger lives on the user row; getProOffer reads the same flag.
	const [u] = await getServiceDb()
		.select({ proTrialConsumedAt: user.proTrialConsumedAt })
		.from(user)
		.where(eq(user.id, actor.userId))
		.limit(1);
	if (u?.proTrialConsumedAt) {
		throw new Error("Your account has already used its free Pro trial.");
	}
	// Robust to a never-stamped flag: refuse if the account already owns a live org.
	if (await accountHasLiveSubscription(actor.userId)) {
		throw new Error("Your account has already used its free Pro trial.");
	}
	const existing = await getOrgBilling(actor.orgId);
	if (
		existing?.stripeSubscriptionId &&
		(existing.status === "active" || existing.status === "trialing")
	) {
		throw new Error("This organization already has an active subscription.");
	}

	const customerId = await ensureCustomer(actor.orgId, actor.userId);
	// Pin the currency now so the trial's eventual paid invoice bills correctly (Stripe
	// locks it at creation); explicit selection wins, else the request geo.
	const currency = opts?.currency ?? (await currencyFromRequest());
	const sub = await getStripe().subscriptions.create({
		customer: customerId,
		items: planCreateItems("team", 1),
		currency,
		trial_period_days: 30,
		trial_settings: { end_behavior: { missing_payment_method: "cancel" } },
		metadata: { organization_id: actor.orgId },
	});

	// Activate the entitlement deterministically (don't wait for the webhook).
	await syncSubscriptionToBilling(sub);

	// Burn the account's one trial only after Stripe accepted it.
	await getServiceDb()
		.update(user)
		.set({ proTrialConsumedAt: new Date(), updatedAt: new Date() })
		.where(eq(user.id, actor.userId));
}

/**
 * Whether the account already owns an org on a live (active/trialing) subscription. The
 * Pro trial is one-per-account, so this is the authoritative "already used a trial/seat"
 * signal — robust to a `pro_trial_consumed_at` that was never stamped (legacy data).
 */
async function accountHasLiveSubscription(userId: string): Promise<boolean> {
	const rows = await getServiceDb()
		.select({ status: organizationBilling.status })
		.from(member)
		.innerJoin(
			organizationBilling,
			eq(organizationBilling.organizationId, member.organizationId),
		)
		.where(and(eq(member.userId, userId), eq(member.role, "owner")));
	return rows.some((r) => r.status === "active" || r.status === "trialing");
}

/** What the account is eligible for on Pro: a one-time trial, or nothing (already
 *  used / billing not wired). A single seam for future targeted offers (discount, …). */
export interface ProOffer {
	kind: "trial" | "none";
	/** Length of the trial in days, when `kind === "trial"`. */
	trialDays?: number;
}

/**
 * The Pro offer for the current account — the basis for showing a "Start trial" CTA
 * vs requiring payment. `trial` only while the account hasn't consumed its single
 * account-wide trial and hosted billing is configured; otherwise `none`. Read by both
 * /onboarding and the create-org sheet so the trial is offered wherever the user first
 * reaches for Pro, but only ever once.
 */
export async function getProOffer(): Promise<ProOffer> {
	if (!isStripeConfigured()) return { kind: "none" };
	const actor = await currentActor();
	const [u] = await getServiceDb()
		.select({ proTrialConsumedAt: user.proTrialConsumedAt })
		.from(user)
		.where(eq(user.id, actor.userId))
		.limit(1);
	if (u?.proTrialConsumedAt) return { kind: "none" };
	// Belt-and-suspenders over the flag: if the account already owns a live (active/
	// trialing) org, the one-per-account trial is effectively spent — don't re-offer it
	// (guards against a flag that was never stamped on a legacy trial).
	if (await accountHasLiveSubscription(actor.userId)) return { kind: "none" };
	return { kind: "trial", trialDays: 30 };
}

/**
 * Whether the active org may invite teammates (the pay-to-collaborate gate): true on a
 * paid subscription or a card-backed trial, false for a card-less trial / personal
 * scope. The UI signal behind the "Add payment to invite your team" upsell; the actual
 * invite is also enforced server-side in the org plugin (canOrgInvite). Any member.
 */
export async function getCollaborationAccess(): Promise<{ canInvite: boolean }> {
	const actor = await currentActor();
	if (actor.orgId === actor.userId) return { canInvite: false };
	return { canInvite: await canOrgInvite(actor.orgId) };
}

/**
 * Whether an org slug is still free. Used by the create-org sheet to validate the slug
 * BEFORE taking payment (the org itself isn't created until the charge succeeds), so a
 * collision surfaces inline instead of after the customer has paid. Authenticated only.
 */
export async function isOrgSlugAvailable(slug: string): Promise<boolean> {
	await currentActor();
	const normalized = slug.trim().toLowerCase();
	if (!normalized) return false;
	// Reserved slugs shadow console routes or are owned by the marketing zone /
	// sibling apps (see RESERVED_SLUGS) — never available even if unused in the DB.
	if (RESERVED_SLUGS.has(normalized)) return false;
	const [row] = await getServiceDb()
		.select({ id: organization.id })
		.from(organization)
		.where(eq(organization.slug, normalized))
		.limit(1);
	return !row;
}

/** A new-org subscription intent: the awaiting-payment sub plus the bare customer it
 *  hangs off, both carried back to the client so the org can be linked post-payment. */
export interface NewOrgSubscriptionIntent extends SubscriptionIntent {
	customerId: string;
}

/**
 * Creates an incomplete subscription for an org that doesn't exist yet — the deferred
 * create-org flow: take payment first, then create + link the org (linkSubscriptionToNewOrg).
 * The customer/sub carry `created_by` (not `organization_id`) so they can't be claimed by
 * another user, and the webhook ignores them until the link step stamps the org id.
 *
 * Idempotent across retries: pass the prior `customerId` to reuse it and `priorSubscriptionId`
 * to cancel the previous incomplete sub (e.g. after "← Back" or a seat change), so a Stripe
 * customer is never duplicated and incomplete subscriptions don't pile up.
 */
export async function createNewOrgSubscriptionIntent(
	plan: PaidPlan,
	opts: {
		orgName: string;
		priorSubscriptionId?: string;
		customerId?: string;
		currency?: SupportedCurrency;
		/**
		 * The payer facts, PASSED IN rather than read from the database — this is the one conversion
		 * path where no organization exists yet, so there is no organization_billing row to declare
		 * them on. Omitting them refuses the sale exactly as an undeclared org would: the gate's
		 * inputs are optional here, its verdict is not.
		 */
		payer?: { capacity: PayerCapacity | null; billingCountry: string | null };
	},
): Promise<NewOrgSubscriptionIntent> {
	const actor = await currentActor();
	requireHostedBilling();
	// The org does not exist yet, so the context is assembled from what the caller declared. Note
	// `organizationId: actor.userId` — the personal scope — because there is genuinely no org to
	// name, and inventing an id would put a false one in a record that is meant to be evidence.
	const newOrgContext: PaidConversionContext = {
		userId: actor.userId,
		organizationId: actor.userId,
		capacity: opts.payer?.capacity ?? null,
		billingCountry: opts.payer?.billingCountry ?? null,
	};
	await assertPaidConversionAllowed(newOrgContext);

	// Reuse the customer from a prior attempt only if this user owns it; otherwise mint
	// a fresh bare customer (no organization_id until the org exists and is linked).
	let customerId: string | null = null;
	if (opts.customerId) {
		const existing = await getStripe().customers.retrieve(opts.customerId);
		if (
			!existing.deleted &&
			existing.metadata?.created_by === actor.userId
		) {
			customerId = existing.id;
		}
	}
	if (!customerId) {
		const [u] = await getServiceDb()
			.select({ email: user.email, name: user.name })
			.from(user)
			.where(eq(user.id, actor.userId))
			.limit(1);
		const customer = await getStripe().customers.create({
			email: u?.email,
			name: opts.orgName,
			metadata: { created_by: actor.userId },
		});
		customerId = customer.id;
	}

	// Cancel the previous incomplete sub from this attempt so it doesn't leak.
	if (opts.priorSubscriptionId) {
		try {
			await getStripe().subscriptions.cancel(opts.priorSubscriptionId);
		} catch {
			// Already gone / expired — nothing to clean up.
		}
	}
	// Belt-and-suspenders: void any other dangling incomplete subs on this customer (e.g. a
	// prior attempt whose id wasn't threaded back), so they can't accumulate as FAILED draft
	// invoices.
	await cancelIncompleteSubscriptions(customerId);

	const taxParam: Partial<Stripe.SubscriptionCreateParams> = isStripeTaxEnabled()
		? { automatic_tax: { enabled: true } }
		: {};
	// Resolve the billing currency before creating the sub (Stripe locks it): explicit
	// selection wins, else the request geo.
	const currency = opts.currency ?? (await currencyFromRequest());
	// The org doesn't exist yet (owner only) — start at 1 seat; per-seat sync grows the
	// quantity as invited members accept (lib/billing/seats syncOrgSeats via org hooks).
	const sub = await getStripe().subscriptions.create({
		customer: customerId,
		items: planCreateItems(plan, 1),
		currency,
		payment_behavior: "default_incomplete",
		payment_settings: { save_default_payment_method: "on_subscription" },
		expand: ["latest_invoice.confirmation_secret"],
		metadata: { created_by: actor.userId },
		...taxParam,
	});

	const invoice = sub.latest_invoice;
	if (!invoice || typeof invoice === "string") {
		throw new Error("Stripe did not return an invoice for the subscription.");
	}
	const clientSecret = invoice.confirmation_secret?.client_secret;
	if (!clientSecret) {
		throw new Error("Stripe did not return a payment client secret.");
	}
	return { clientSecret, subscriptionId: sub.id, customerId, currency };
}

/**
 * Links a just-paid subscription (from createNewOrgSubscriptionIntent) to the org the
 * client created after payment, then writes the billing record synchronously so the
 * org's entitlements are live immediately (no webhook race). Owner-gated on the new org;
 * verifies the sub/customer were minted by this actor and aren't already linked.
 */
export async function linkSubscriptionToNewOrg(input: {
	orgId: string;
	subscriptionId: string;
	customerId: string;
	/**
	 * The payer facts declared at the intent step, PERSISTED here.
	 *
	 * This is the moment the organization first exists, and therefore the first moment there is a
	 * row to record them on. Without it a brand-new org would carry a live subscription and NO
	 * declared payer — so the next conversion it attempted (a plan change, an AI subscription) would
	 * be refused by a gate that has no way to know the facts were already given. The eligibility
	 * coverage test found exactly that gap.
	 */
	payer?: { capacity: PayerCapacity | null; billingCountry: string | null };
}): Promise<void> {
	// NAMED, not ambient (#4133). This runs from a sheet on the CURRENT org's page, against the org
	// just created — so the address and the target genuinely differ, and always did. It used to work
	// by asking for the verb in the ambient scope and then asserting that scope WAS the new org,
	// which held only because `setActiveOrganization` had already landed. Asking in the named org
	// says the same thing without depending on that write, or on the order it happened in.
	const actor = await authorizeInOrg("manage_billing", { type: "billing" }, input.orgId);
	requireHostedBilling();

	const sub = await getStripe().subscriptions.retrieve(input.subscriptionId);
	const subCustomerId =
		typeof sub.customer === "string" ? sub.customer : sub.customer.id;
	if (subCustomerId !== input.customerId) {
		throw new Error("Subscription does not match the expected customer.");
	}
	if (sub.metadata?.organization_id) {
		throw new Error("Subscription is already linked to an organization.");
	}
	const customer = await getStripe().customers.retrieve(input.customerId);
	if (customer.deleted || customer.metadata?.created_by !== actor.userId) {
		throw new Error("Not allowed to link this subscription.");
	}

	const [org] = await getServiceDb()
		.select({ name: organization.name })
		.from(organization)
		.where(eq(organization.id, input.orgId))
		.limit(1);

	await getStripe().customers.update(input.customerId, {
		name: org?.name,
		metadata: { created_by: actor.userId, organization_id: input.orgId },
	});
	const linked = await getStripe().subscriptions.update(input.subscriptionId, {
		metadata: { created_by: actor.userId, organization_id: input.orgId },
	});

	// Deterministic activation — don't wait for the (already-fired) webhook.
	await syncSubscriptionToBilling(linked);

	// Then carry the declared payer facts onto the row syncSubscriptionToBilling just created. After
	// it, never before: the row does not exist until then, and writing them first would either race
	// or need a second insert path for the same record.
	if (input.payer?.capacity && input.payer.billingCountry) {
		await getServiceDb()
			.update(organizationBilling)
			.set({
				payerCapacity: input.payer.capacity,
				billingCountry: input.payer.billingCountry.trim().toUpperCase(),
				updatedAt: new Date(),
			})
			.where(eq(organizationBilling.organizationId, input.orgId));
	}
}

/**
 * Sets (or clears) a tax id on a standalone new-org customer — the create-org sheet's
 * inline "Tax ID (optional)" field, collected at the payment step before the org exists.
 * Verifies the customer was minted by this actor (created_by metadata, the same guard as
 * linkSubscriptionToNewOrg) so one user can't write tax ids onto another's customer.
 * Replaces any prior tax ids (one per customer in our UI).
 */
export async function attachTaxIdToCustomer(input: {
	customerId: string;
	type: TaxIdType;
	value: string;
}): Promise<{ ok: true }> {
	const actor = await currentActor();
	requireHostedBilling();

	const stripe = getStripe();
	const customer = await stripe.customers.retrieve(input.customerId);
	if (customer.deleted || customer.metadata?.created_by !== actor.userId) {
		throw new Error("Not allowed to set a tax id on this customer.");
	}

	const existing = await stripe.customers.listTaxIds(input.customerId, {
		limit: 5,
	});
	for (const t of existing.data) {
		await stripe.customers.deleteTaxId(input.customerId, t.id);
	}
	const trimmed = input.value.trim();
	if (trimmed) {
		await stripe.customers.createTaxId(input.customerId, {
			type: input.type,
			value: trimmed,
		});
	}
	return { ok: true };
}

/**
 * Billing name + address on a standalone new-org customer (mirrors attachTaxIdToCustomer)
 * — the create-org sheet's Full Name / Country / Address line, collected before the org
 * exists. Guarded by the customer's `created_by` so it can't write onto another's
 * customer. Once the org is linked, updateBillingAddress is the org-scoped equivalent.
 */
export async function setCustomerBillingAddress(input: {
	customerId: string;
	address: BillingAddressInput;
}): Promise<{ ok: true }> {
	const actor = await currentActor();
	requireHostedBilling();

	const stripe = getStripe();
	const customer = await stripe.customers.retrieve(input.customerId);
	if (customer.deleted || customer.metadata?.created_by !== actor.userId) {
		throw new Error("Not allowed to set an address on this customer.");
	}
	await stripe.customers.update(input.customerId, {
		name: input.address.name,
		address: {
			line1: input.address.line1,
			line2: input.address.line2,
			city: input.address.city,
			state: input.address.state,
			postal_code: input.address.postalCode,
			country: input.address.country,
		},
	});
	return { ok: true };
}

/** A one-time credit-pack payment awaiting confirmation, for the embedded Payment Element. */
export interface CreditPackIntent {
	clientSecret: string;
	/** The Stripe invoice raised for this purchase (yields a compliant PDF). */
	invoiceId: string;
}

/**
 * Raises a one-time **invoice** for an AI credit pack (a top-up beyond the plan's
 * included usage) so every purchase yields a compliant, numbered PDF. Flow: add an
 * invoice item → create + finalize a `charge_automatically` invoice → return its
 * PaymentIntent client secret. The embedded <PaymentForm mode="payment"> confirms it
 * inline (unchanged — confirmPayment works the same for an invoice's PI); the webhook's
 * `invoice.payment_succeeded` branch grants the credits (idempotent on the invoice id)
 * and emails the receipt with the PDF attached. Owner-gated; org-scoped; hosted only;
 * PAID-tier only — packs top up a plan, they don't replace one (the free tier upgrades
 * instead; mirrors the client's upgrade-first panel).
 */
export async function createCreditPackIntent(
	packId: string,
): Promise<CreditPackIntent> {
	const actor = await authorize("manage_billing", { type: "billing" });
	requireHostedBilling();
	if (actor.orgId === actor.userId) {
		throw new Error("Create an organization before buying AI credits.");
	}
	const tier = await resolveAiTier(actor.orgId);
	if (tier === "ai_free") {
		throw new Error(
			"Credit packs are available on paid AI plans — upgrade to AI Plus or AI Max first.",
		);
	}
	const pack = creditPack(packId);
	if (!pack) throw new Error("Unknown credit pack.");
	await gatePaidConversion(actor);

	const customerId = await ensureCustomer(actor.orgId, actor.userId);
	const stripe = getStripe();
	// Metadata identifies the purchase on the invoice.payment_succeeded event.
	const metadata = {
		organization_id: actor.orgId,
		user_id: actor.userId,
		product_type: "ai_credits",
		credits: String(pack.credits),
	};

	const description = `${pack.credits.toLocaleString("en-US")} AI credits`;
	// Create the draft first (pin USD — the account's default currency is EUR), then
	// attach the line item directly to it. In the current API version a manual invoice
	// no longer auto-pulls pending items, so `invoice: draft.id` is required.
	// auto_advance:false keeps the invoice `open` (no auto-charge even with a default
	// card) so the customer always confirms via the embedded form.
	const draft = await stripe.invoices.create({
		customer: customerId,
		currency: "usd",
		collection_method: "charge_automatically",
		auto_advance: false,
		description,
		metadata,
	});
	if (!draft.id) throw new Error("Stripe did not return an invoice id.");
	await stripe.invoiceItems.create({
		customer: customerId,
		invoice: draft.id,
		amount: pack.amountCents,
		currency: "usd",
		description,
		metadata,
	});
	const invoice = await stripe.invoices.finalizeInvoice(draft.id, {
		expand: ["confirmation_secret"],
	});
	const clientSecret = invoice.confirmation_secret?.client_secret;
	if (!clientSecret) {
		throw new Error("Stripe did not return a payment client secret for the invoice.");
	}
	return { clientSecret, invoiceId: invoice.id ?? draft.id };
}

// ── Payment methods (embedded card management) ──────────────────────────────

/** A saved card for the active org's billing UI. */
export interface PaymentMethodInfo {
	id: string;
	brand: string;
	last4: string;
	expMonth: number;
	expYear: number;
	isDefault: boolean;
	/** Backup order (0-based) for dunning failover; null when this card isn't a backup. */
	backupRank: number | null;
}

/** Creates a SetupIntent to add/save a card via the embedded Payment Element. */
export async function createSetupIntent(): Promise<{ clientSecret: string }> {
	const actor = await authorize("manage_billing", { type: "billing" });
	requireHostedBilling();
	if (actor.orgId === actor.userId) {
		throw new Error("Create an organization before adding a card.");
	}
	const customerId = await ensureCustomer(actor.orgId, actor.userId);
	const si = await getStripe().setupIntents.create({
		customer: customerId,
		usage: "off_session",
		payment_method_types: ["card"],
		// Require the billing address WITH the card, rather than hoping one is set elsewhere.
		//
		// A card saved with no address is not a usable default: Stripe Tax cannot determine the place
		// of supply, so the first invoice it backs either fails or is raised with the wrong tax — and
		// the customer discovers that at renewal, off-session, with nobody watching. Collecting it at
		// the moment the card is entered is also the only point where the user is present to type it.
		payment_method_options: {
			card: { request_three_d_secure: "automatic" },
		},
	});
	if (!si.client_secret) {
		throw new Error("Stripe did not return a setup client secret.");
	}
	return { clientSecret: si.client_secret };
}

/** Lists the active org's saved cards (with which one is the default). */
export async function listPaymentMethods(): Promise<PaymentMethodInfo[]> {
	const actor = await authorize("manage_billing", { type: "billing" });
	requireHostedBilling();
	const billing = await getOrgBilling(actor.orgId);
	if (!billing?.stripeCustomerId) return [];

	const stripe = getStripe();
	const customer = await stripe.customers.retrieve(billing.stripeCustomerId);
	const defaultRef =
		"deleted" in customer
			? null
			: customer.invoice_settings.default_payment_method;
	const defaultId =
		typeof defaultRef === "string" ? defaultRef : (defaultRef?.id ?? null);

	const pms = await stripe.paymentMethods.list({
		customer: billing.stripeCustomerId,
		type: "card",
	});
	return pms.data
		.map((pm) => ({
			id: pm.id,
			brand: pm.card?.brand ?? "card",
			last4: pm.card?.last4 ?? "••••",
			expMonth: pm.card?.exp_month ?? 0,
			expYear: pm.card?.exp_year ?? 0,
			isDefault: pm.id === defaultId,
			backupRank: backupRankOf(pm),
		}))
		// Default (primary) first, then ranked backups ascending, then any unranked cards.
		.sort((a, b) => {
			if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
			const ar = a.backupRank ?? Number.MAX_SAFE_INTEGER;
			const br = b.backupRank ?? Number.MAX_SAFE_INTEGER;
			return ar - br;
		});
}

/**
 * Sets the org's backup-card order (for dunning failover) — the given ids become the
 * ordered backups; every other card is cleared. Owner-gated; org-scoped.
 */
export async function setBackupCards(
	orderedPmIds: string[],
): Promise<{ ok: true }> {
	const actor = await authorize("manage_billing", { type: "billing" });
	requireHostedBilling();
	const billing = await getOrgBilling(actor.orgId);
	if (!billing?.stripeCustomerId) throw new Error("No billing account yet.");
	await setBackupOrder(billing.stripeCustomerId, orderedPmIds);
	return { ok: true };
}

/** Makes a saved card the default for invoices + the active subscription. */
export async function setDefaultPaymentMethod(
	pmId: string,
): Promise<{ ok: true }> {
	const actor = await authorize("manage_billing", { type: "billing" });
	requireHostedBilling();
	const billing = await getOrgBilling(actor.orgId);
	if (!billing?.stripeCustomerId) throw new Error("No billing account yet.");

	const stripe = getStripe();
	// A default payment method is what future off-session charges run on, so promoting one is the
	// point at which the account's OWN preconditions must hold — not the moment a charge is later
	// attempted with nobody present to fix anything.
	//
	// Two, and both are about the same thing: a renewal that cannot be justified. Without current
	// acceptance there is no agreement covering the charge; without a billing address Stripe Tax has
	// no place of supply, so the invoice is raised with the wrong tax or not at all. Verified against
	// the card ITSELF, not only the customer record — a card carrying its own billing address is a
	// perfectly good source, and requiring the customer-level one as well would refuse a setup that
	// is actually complete.
	if (!(await hasAcceptedCurrentDocuments(actor.userId))) {
		throw new Error(
			"Accept the current Terms of Service before setting a default payment method — " +
				"renewals charged against it need an agreement that covers them.",
		);
	}
	const pmForDefault = await stripe.paymentMethods.retrieve(pmId);
	const pmOwner =
		typeof pmForDefault.customer === "string"
			? pmForDefault.customer
			: (pmForDefault.customer?.id ?? null);
	if (pmOwner !== billing.stripeCustomerId) {
		// Same check detachPaymentMethod makes, and for the same reason: without it one org could
		// promote another org's card by id.
		throw new Error("Payment method not found.");
	}
	const cardCountry = pmForDefault.billing_details?.address?.country ?? null;
	if (!cardCountry && !billing.billingCountry) {
		throw new Error(
			"Add a billing address before setting a default payment method — without one we cannot " +
				"determine the tax due on a renewal.",
		);
	}
	await stripe.customers.update(billing.stripeCustomerId, {
		invoice_settings: { default_payment_method: pmId },
	});
	if (billing.stripeSubscriptionId) {
		await stripe.subscriptions.update(billing.stripeSubscriptionId, {
			default_payment_method: pmId,
		});
	}
	return { ok: true };
}

/** Removes a saved card (after verifying it belongs to the active org's customer). */
export async function detachPaymentMethod(pmId: string): Promise<{ ok: true }> {
	const actor = await authorize("manage_billing", { type: "billing" });
	requireHostedBilling();
	const billing = await getOrgBilling(actor.orgId);
	if (!billing?.stripeCustomerId) throw new Error("No billing account yet.");

	const stripe = getStripe();
	const pm = await stripe.paymentMethods.retrieve(pmId);
	const ownerId =
		typeof pm.customer === "string" ? pm.customer : (pm.customer?.id ?? null);
	if (ownerId !== billing.stripeCustomerId) {
		throw new Error("Payment method not found.");
	}
	await stripe.paymentMethods.detach(pmId);
	return { ok: true };
}

// ── Subscription management (embedded — replaces the Customer Portal) ────────

/** Loads the active org's subscription, or throws if there isn't one. */
async function requireSubscriptionId(orgId: string): Promise<string> {
	const billing = await getOrgBilling(orgId);
	if (!billing?.stripeSubscriptionId) {
		throw new Error("No active subscription.");
	}
	return billing.stripeSubscriptionId;
}

/** Schedules cancellation at the end of the current paid period. */
export async function cancelSubscription(): Promise<{ ok: true }> {
	const actor = await authorize("manage_billing", { type: "billing" });
	requireHostedBilling();
	const subId = await requireSubscriptionId(actor.orgId);
	await getStripe().subscriptions.update(subId, { cancel_at_period_end: true });
	return { ok: true };
}

/** Un-schedules a pending cancellation. */
export async function resumeSubscription(): Promise<{ ok: true }> {
	const actor = await authorize("manage_billing", { type: "billing" });
	requireHostedBilling();
	const subId = await requireSubscriptionId(actor.orgId);
	await getStripe().subscriptions.update(subId, { cancel_at_period_end: false });
	return { ok: true };
}

/** Switches the active subscription to a different paid plan, prorated. */
export async function changeSubscriptionPlan(
	plan: PaidPlan,
): Promise<{ ok: true }> {
	const actor = await authorize("manage_billing", { type: "billing" });
	requireHostedBilling();
	// A plan change is a paid conversion: it raises a prorated charge, and it is the path a user
	// takes OUT of a trial. Exempting it because "they already pay" is how the gate would come to
	// cover only the first purchase.
	await gatePaidConversion(actor);
	const subId = await requireSubscriptionId(actor.orgId);
	const stripe = getStripe();
	const sub = await stripe.subscriptions.retrieve(subId);

	// Distinguish the flat plan item from the metered runner-minutes item so a plan
	// change swaps both (their graduated included tiers differ per plan).
	const meterIds = configuredMeterPriceIds();
	let flatItemId: string | undefined;
	let meterItemId: string | undefined;
	for (const it of sub.items.data) {
		if (meterIds.has(it.price.id)) meterItemId = it.id;
		else flatItemId = it.id;
	}
	if (!flatItemId) throw new Error("Subscription has no plan line item.");

	const items: Stripe.SubscriptionUpdateParams.Item[] = [
		{ id: flatItemId, price: priceIdForPlan(plan) },
	];
	const meter = meterPriceIdForPlan(plan);
	if (meter && meterItemId) items.push({ id: meterItemId, price: meter });
	else if (meter) items.push({ price: meter });
	else if (meterItemId) items.push({ id: meterItemId, deleted: true });

	await stripe.subscriptions.update(subId, {
		items,
		proration_behavior: "create_prorations",
	});
	return { ok: true };
}

// ── Invoices + billing details / VAT ────────────────────────────────────────

/** An invoice row for the billing UI — sourced from our locally-mirrored `invoice` table
 *  (only invoices for which money moved), never a live Stripe API call. */
export interface InvoiceInfo {
	/** Our invoice id (used for the preview + PDF-download route). */
	id: string;
	number: string | null;
	/** Total in the smallest currency unit (e.g. cents). */
	total: number;
	currency: string;
	status: InvoiceStatus;
	/** ISO instant the invoice was paid — the primary display/sort date. */
	paidAt: string;
	/** Billing period the invoice covers (ISO), if known. */
	periodStart: string | null;
	periodEnd: string | null;
	description: string | null;
	/** A self-hosted PDF is available at the download route. */
	hasPdf: boolean;
	/** Stripe's hosted invoice URL — a fallback link only. */
	hostedInvoiceUrl: string | null;
}

/** Maps a mirrored invoice row to the UI shape. */
function toInvoiceInfo(row: Invoice): InvoiceInfo {
	return {
		id: row.id,
		number: row.number,
		total: row.amountTotal,
		currency: row.currency,
		status: row.status,
		paidAt: (row.paidAt ?? row.createdAt).toISOString(),
		periodStart: row.periodStart?.toISOString() ?? null,
		periodEnd: row.periodEnd?.toISOString() ?? null,
		description: row.description,
		hasPdf: Boolean(row.pdfKey) || Boolean(row.hostedInvoiceUrl),
		hostedInvoiceUrl: row.hostedInvoiceUrl,
	};
}

/** Optional filters for the invoices list (period range + status). */
export interface InvoiceListParams {
	status?: InvoiceStatus[];
	paidFrom?: string;
	paidTo?: string;
	limit?: number;
}

// NO `requireHostedBilling()` on either read below, and its absence is the fix for the HTTP 500
// the UI conformance audit recorded on `~/settings/billing/invoices` (#3731).
//
// That guard's own contract is "before any Stripe call" — and these two make none: they read the
// MIRRORED `invoice` table this deployment already owns. It threw whenever STRIPE_SECRET_KEY is
// unset, which is every self-managed install and every sandbox env, turning a plain table read
// into an unhandled server-action rejection → 500. Both of the audit's two 500s per visit were
// `listInvoices` — the panel's filtered rows query and its unfiltered facet-count query.
//
// The main billing panel never showed it because it returns a "Self-managed deployment" card
// before it mounts anything that calls these; the dedicated invoices page has no such gate, so it
// called straight through. Refusing to READ mirrored history because Stripe is not wired is also
// wrong on its own terms — an org that once paid keeps its invoices, and an org that never did
// simply has none, which is an empty list, not an error.

/**
 * Lists the active org's mirrored invoices (newest paid first), from the local table — no
 * Stripe call, so it's fast and only ever shows real paid invoices. Filterable by period
 * range + status.
 */
export async function listInvoices(
	params: InvoiceListParams = {},
): Promise<InvoiceInfo[]> {
	const actor = await authorize("manage_billing", { type: "billing" });
	const rows = await listOrgInvoices(actor.orgId, params);
	return rows.map(toInvoiceInfo);
}

/**
 * Loads one invoice for the active org, or null if it isn't theirs.
 *
 * NO PRODUCTION CALLER TODAY — `git grep getInvoice` finds this definition and its tests, nothing
 * else. It used to say "(preview dialog)", which is wrong and was worth correcting rather than
 * inheriting: `InvoicePreviewDialog` is presentational and takes an `InvoiceInfo` PROP that both
 * its parents already hold from `listInvoices`, and the PDF route calls `getOrgInvoice` directly.
 * So this action contributed NONE of the 500s in #3731 — both were `listInvoices`. It is kept and
 * fixed alongside its sibling because it is the same read over the same table and an inconsistent
 * guard between the two is the next reader's trap; if it still has no caller when someone next
 * touches this file, delete it rather than re-explaining it.
 */
export async function getInvoice(id: string): Promise<InvoiceInfo | null> {
	const actor = await authorize("manage_billing", { type: "billing" });
	const row = await getOrgInvoice(actor.orgId, id);
	return row ? toInvoiceInfo(row) : null;
}

// ── Transactions (Stripe charges) ───────────────────────────────────────────

/** A charge row for the transaction-history table. */
export interface TransactionInfo {
	id: string;
	/** What the charge was for (Stripe description, or a sensible fallback). */
	description: string;
	/** Normalized outcome driving the status badge. */
	status: "paid" | "pending" | "failed" | "refunded";
	/** Smallest-unit amount; negative for refunds. */
	amount: number;
	currency: string;
	created: string;
	/** "Visa ···· 4242", or null when the method isn't a card. */
	method: string | null;
}

/** Maps a Stripe charge to our normalized transaction shape. */
function toTransaction(charge: Stripe.Charge): TransactionInfo {
	const card = charge.payment_method_details?.card;
	const method = card
		? `${card.brand ?? "card"} ···· ${card.last4 ?? "••••"}`
		: null;
	const refunded = charge.refunded || charge.amount_refunded > 0;
	const status: TransactionInfo["status"] = refunded
		? "refunded"
		: charge.status === "succeeded"
			? "paid"
			: charge.status === "failed"
				? "failed"
				: "pending";
	return {
		id: charge.id,
		description: charge.description ?? "Subscription payment",
		status,
		amount: refunded ? -charge.amount_refunded : charge.amount,
		currency: charge.currency,
		created: new Date(charge.created * 1000).toISOString(),
		method,
	};
}

/** Lists the active org's recent charges (paid / failed / refunded) for the ledger. */
export async function listTransactions(): Promise<TransactionInfo[]> {
	const actor = await authorize("manage_billing", { type: "billing" });
	requireHostedBilling();
	const billing = await getOrgBilling(actor.orgId);
	if (!billing?.stripeCustomerId) return [];

	const charges = await getStripe().charges.list({
		customer: billing.stripeCustomerId,
		limit: 24,
	});
	return charges.data.map(toTransaction);
}

// ── Plan history (minimal — derived, no event log yet) ──────────────────────

/** A plan-history timeline entry. */
export interface PlanHistoryEntry {
	when: string;
	title: string;
	detail: string;
	/** The current (most recent) entry — rendered as the active node. */
	current: boolean;
}

/**
 * A best-effort plan-history timeline for the active org. We don't keep a billing
 * event log yet, so this is derived honestly from what we know: when the org was
 * created, and the plan it's on now. (A real ledger is future work.)
 */
export async function getPlanHistory(): Promise<PlanHistoryEntry[]> {
	const actor = await authorize("manage_billing", { type: "billing" });
	requireHostedBilling();
	if (actor.orgId === actor.userId) return [];

	const [org] = await getServiceDb()
		.select({ name: organization.name, createdAt: organization.createdAt })
		.from(organization)
		.where(eq(organization.id, actor.orgId))
		.limit(1);
	if (!org) return [];

	const billing = await getOrgBilling(actor.orgId);
	const entries: PlanHistoryEntry[] = [
		{
			when: org.createdAt.toISOString(),
			title: "Organization created",
			detail: `${org.name} started on the Free plan.`,
			current: false,
		},
	];
	const isLive =
		billing && (billing.status === "active" || billing.status === "trialing");
	if (isLive && billing.plan !== "community") {
		const meta = planMeta(billing.plan);
		const since =
			billing.currentPeriodEnd?.toISOString() ?? new Date().toISOString();
		entries.push({
			when: since,
			title: `On the ${meta.name} plan`,
			detail: meta.tagline,
			current: true,
		});
	} else {
		// No live paid plan → the "created" entry is the current state.
		entries[0].current = true;
	}
	return entries.reverse(); // newest first
}

/** The active org's billing contact + address + VAT id (for Stripe Tax). */
export interface BillingDetails {
	name: string;
	email: string;
	line1: string;
	line2: string;
	city: string;
	state: string;
	postalCode: string;
	country: string;
	taxId: string | null;
}

/** Reads the active org's billing details, or null if there's no customer yet. */
export async function getBillingDetails(): Promise<BillingDetails | null> {
	const actor = await authorize("manage_billing", { type: "billing" });
	requireHostedBilling();
	const billing = await getOrgBilling(actor.orgId);
	if (!billing?.stripeCustomerId) return null;

	const stripe = getStripe();
	const customer = await stripe.customers.retrieve(billing.stripeCustomerId);
	if ("deleted" in customer) return null;
	const addr = customer.address;
	const taxIds = await stripe.customers.listTaxIds(billing.stripeCustomerId, {
		limit: 1,
	});
	return {
		name: customer.name ?? "",
		email: customer.email ?? "",
		line1: addr?.line1 ?? "",
		line2: addr?.line2 ?? "",
		city: addr?.city ?? "",
		state: addr?.state ?? "",
		postalCode: addr?.postal_code ?? "",
		country: addr?.country ?? "",
		taxId: taxIds.data[0]?.value ?? null,
	};
}

/** Billing contact + address (required for Stripe Tax to compute VAT). */
export interface BillingAddressInput {
	name: string;
	line1: string;
	line2?: string;
	city: string;
	state?: string;
	postalCode: string;
	/** ISO 3166-1 alpha-2 (e.g. "DE", "EE"). */
	country: string;
}

/** Saves the active org's billing name + address on its Stripe customer. */
export async function updateBillingAddress(
	input: BillingAddressInput,
): Promise<{ ok: true }> {
	const actor = await authorize("manage_billing", { type: "billing" });
	requireHostedBilling();
	const billing = await getOrgBilling(actor.orgId);
	if (!billing?.stripeCustomerId) throw new Error("No billing account yet.");

	await getStripe().customers.update(billing.stripeCustomerId, {
		name: input.name,
		address: {
			line1: input.line1,
			line2: input.line2,
			city: input.city,
			state: input.state,
			postal_code: input.postalCode,
			country: input.country,
		},
	});
	return { ok: true };
}

/** Sets (or clears) the active org's tax id — one per customer for our UI. */
export async function saveTaxId(
	type: TaxIdType,
	value: string,
): Promise<{ ok: true }> {
	const actor = await authorize("manage_billing", { type: "billing" });
	requireHostedBilling();
	const billing = await getOrgBilling(actor.orgId);
	if (!billing?.stripeCustomerId) throw new Error("No billing account yet.");

	const stripe = getStripe();
	const existing = await stripe.customers.listTaxIds(billing.stripeCustomerId, {
		limit: 5,
	});
	for (const t of existing.data) {
		await stripe.customers.deleteTaxId(billing.stripeCustomerId, t.id);
	}
	const trimmed = value.trim();
	if (trimmed) {
		await stripe.customers.createTaxId(billing.stripeCustomerId, {
			type,
			value: trimmed,
		});
	}
	return { ok: true };
}

/**
 * Opens the Stripe Customer Portal for the active org (manage/cancel the subscription,
 * update payment method). Requires an existing Stripe customer. Returns the URL.
 * Retained as a fallback alongside the embedded flow.
 */
export async function createBillingPortalSession(): Promise<{ url: string }> {
	const actor = await authorize("manage_billing", { type: "billing" });
	requireHostedBilling();

	const billing = await getOrgBilling(actor.orgId);
	if (!billing?.stripeCustomerId) {
		throw new Error("No billing account yet — subscribe to a plan first.");
	}
	const session = await getStripe().billingPortal.sessions.create({
		customer: billing.stripeCustomerId,
		return_url: `${getStripeConfig().appUrl}/dashboard/settings/billing`,
	});
	return { url: session.url };
}
