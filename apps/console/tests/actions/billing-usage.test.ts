// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Mocked-boundary tests for the Usage server actions: we stub the data layer (DB queries, the
// AI-credit ledger, billing record, actor) and assert the action's ORCHESTRATION + BRANCHING —
// the plan/entitlement math (resolvePlanEntitlements) and the usage math (computeUsage) run for
// real. The real SQL is covered separately by the integration suite. `ai-quota` and
// `usage-counts` import `server-only` (throws under Vitest); mocking them cuts that import.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrganizationBilling } from "@/lib/db/schema";

vi.mock("@/lib/authz/guard", () => ({
	currentActor: vi.fn(),
	authorize: vi.fn(),
	// getAiUsageSummary probes this for the "can manage spend limits" flag; default deny.
	authorizeQuiet: vi.fn(async () => {
		throw new Error("forbidden");
	}),
}));
vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn(() => ({})) }));
vi.mock("@/lib/billing/queries", () => ({ getOrgBilling: vi.fn() }));
vi.mock("@/lib/queries/runner-usage", () => ({
	queryJobMinutesByOrg: vi.fn(),
	queryJobMinutesSeries: vi.fn(),
}));
vi.mock("@/lib/queries/usage-counts", () => ({
	queryResourceCounts: vi.fn(),
	queryRunningJobs: vi.fn(),
}));
vi.mock("@/lib/billing/ai-quota", () => ({
	sumCredits: vi.fn(),
	oldestUsageSince: vi.fn(),
	purchasedBalance: vi.fn(),
	aiCreditsSeries: vi.fn(),
}));

import {
	createCreditPackIntent,
	createSubscriptionIntent,
	getAiUsageSummary,
	getOrgUsage,
	getResourceCounts,
	getUsageOverTime,
	startProTrial,
} from "@/app/server/actions/billing";
import { authorize, currentActor } from "@/lib/authz/guard";
import {
	aiCreditsSeries,
	oldestUsageSince,
	sumCredits,
	purchasedBalance,
} from "@/lib/billing/ai-quota";
import { AI_SESSION_WINDOW_MS, AI_TIERS } from "@/lib/billing/ai-plan";
import { getOrgBilling } from "@/lib/billing/queries";
import {
	queryJobMinutesByOrg,
	queryJobMinutesSeries,
} from "@/lib/queries/runner-usage";
import {
	queryResourceCounts,
	queryRunningJobs,
} from "@/lib/queries/usage-counts";

const actor = vi.mocked(currentActor);
const orgBilling = vi.mocked(getOrgBilling);

/** A billing row with only the fields the usage actions read. */
function billing(partial: Partial<OrganizationBilling>): OrganizationBilling {
	return {
		plan: "team",
		status: "active",
		usageHardCap: false,
		currentPeriodStart: null,
		currentPeriodEnd: null,
		...partial,
	} as OrganizationBilling;
}

beforeEach(() => {
	vi.clearAllMocks();
	// Default: a real org (orgId ≠ userId).
	actor.mockResolvedValue({ orgId: "org-1", userId: "user-1" } as never);
});

describe("getOrgUsage", () => {
	it("uses community quotas when the org has no billing record", async () => {
		orgBilling.mockResolvedValue(null);
		vi.mocked(queryJobMinutesByOrg).mockResolvedValue([
			{ org_id: "org-1", job_minutes: 50, job_count: 2 },
		]);
		vi.mocked(queryRunningJobs).mockResolvedValue(1);

		const r = await getOrgUsage();
		expect(r.plan).toBe("community");
		expect(r.includedMinutes).toBe(200); // community allowance
		expect(r.maxConcurrentJobs).toBe(2);
		expect(r.usedMinutes).toBe(50);
		expect(r.runningJobs).toBe(1);
		expect(r.overLimit).toBe(false);
	});

	it("applies the team allowance + surfaces overage when live", async () => {
		orgBilling.mockResolvedValue(billing({ plan: "team", status: "active" }));
		vi.mocked(queryJobMinutesByOrg).mockResolvedValue([
			{ org_id: "org-1", job_minutes: 800, job_count: 9 },
		]);
		vi.mocked(queryRunningJobs).mockResolvedValue(3);

		const r = await getOrgUsage();
		expect(r.includedMinutes).toBe(500); // team allowance
		expect(r.overLimit).toBe(true);
		expect(r.overageMinutes).toBe(300);
		expect(r.maxConcurrentJobs).toBe(8);
	});

	it("reflects the hard-cap flag and defaults usage to zero", async () => {
		orgBilling.mockResolvedValue(billing({ usageHardCap: true }));
		vi.mocked(queryJobMinutesByOrg).mockResolvedValue([]);
		vi.mocked(queryRunningJobs).mockResolvedValue(0);

		const r = await getOrgUsage();
		expect(r.hardCap).toBe(true);
		expect(r.usedMinutes).toBe(0);
	});
});

describe("getResourceCounts", () => {
	it("returns zeros for the personal scope (no org)", async () => {
		actor.mockResolvedValue({ orgId: "user-1", userId: "user-1" } as never);
		const r = await getResourceCounts();
		expect(r).toEqual({ projects: 0, clusters: 0, spendUnderManagement: 0 });
		expect(queryResourceCounts).not.toHaveBeenCalled();
	});

	it("delegates to the counts query for a real org", async () => {
		const counts = { projects: 9, clusters: 2, spendUnderManagement: 1234 };
		vi.mocked(queryResourceCounts).mockResolvedValue(counts);
		expect(await getResourceCounts()).toEqual(counts);
		expect(queryResourceCounts).toHaveBeenCalledWith("org-1");
	});
});

describe("getUsageOverTime", () => {
	it("zero-fills the day axis and sums totals", async () => {
		vi.mocked(queryJobMinutesSeries).mockResolvedValue([
			{ day: "2026-06-02", job_minutes: 120.4, job_count: 3 },
		]);
		vi.mocked(aiCreditsSeries).mockResolvedValue([
			{ day: "2026-06-01", credits: 50 },
		]);

		const r = await getUsageOverTime({
			from: "2026-06-01T00:00:00.000Z",
			to: "2026-06-03T00:00:00.000Z",
		});
		expect(r.series).toHaveLength(3); // 06-01, 06-02, 06-03 inclusive
		expect(r.series.find((p) => p.date === "2026-06-02")?.runnerMinutes).toBe(120); // rounded
		expect(r.series.find((p) => p.date === "2026-06-01")?.aiCredits).toBe(50);
		expect(r.totals).toEqual({ runnerMinutes: 120, jobs: 3, aiCredits: 50 });
	});

	it("returns an empty series for the personal scope", async () => {
		actor.mockResolvedValue({ orgId: "user-1", userId: "user-1" } as never);
		const r = await getUsageOverTime({
			from: "2026-06-01T00:00:00.000Z",
			to: "2026-06-03T00:00:00.000Z",
		});
		expect(r.series).toEqual([]);
		expect(r.totals).toEqual({ runnerMinutes: 0, jobs: 0, aiCredits: 0 });
	});

	it("returns empty for an inverted/invalid range", async () => {
		const r = await getUsageOverTime({
			from: "2026-06-03T00:00:00.000Z",
			to: "2026-06-01T00:00:00.000Z",
		});
		expect(r.series).toEqual([]);
	});
});

describe("getAiUsageSummary", () => {
	it("short-circuits to budget-only for the personal scope (free AI tier)", async () => {
		actor.mockResolvedValue({ orgId: "user-1", userId: "user-1" } as never);
		orgBilling.mockResolvedValue(null);
		const r = await getAiUsageSummary();
		expect(r.tier).toBe("ai_free");
		expect(r.sessionUsed).toBe(0);
		expect(r.weeklyUsed).toBe(0);
		expect(r.purchasedBalance).toBe(0);
		expect(r.sessionBudget).toBe(AI_TIERS.ai_free.sessionCredits);
		expect(r.weeklyBudget).toBe(AI_TIERS.ai_free.weeklyCredits);
		// No usage → no active session; the weekly reset is a valid future ISO.
		expect(r.sessionResetAt).toBeNull();
		expect(new Date(r.weeklyResetAt).getTime()).toBeGreaterThan(Date.now());
		expect(sumCredits).not.toHaveBeenCalled();
	});

	it("reports session + weekly included spend against the AI tier's caps", async () => {
		// The AI budget is the STANDALONE tier's session/weekly grant, independent of the org plan.
		orgBilling.mockResolvedValue(
			billing({ aiTier: "ai_plus", aiSubscriptionStatus: "active" }),
		);
		// getAiUsageSummary sums the rolling session first, then the fixed week.
		vi.mocked(sumCredits).mockResolvedValueOnce(40).mockResolvedValueOnce(1240);
		vi.mocked(purchasedBalance).mockResolvedValue(800);
		const oldest = new Date(Date.now() - 3_600_000); // oldest in-window usage: 1h ago
		vi.mocked(oldestUsageSince).mockResolvedValue(oldest);

		const r = await getAiUsageSummary();
		expect(r.tier).toBe("ai_plus");
		expect(r.sessionBudget).toBe(AI_TIERS.ai_plus.sessionCredits);
		expect(r.weeklyBudget).toBe(AI_TIERS.ai_plus.weeklyCredits);
		expect(r.sessionUsed).toBe(40);
		expect(r.weeklyUsed).toBe(1240);
		expect(r.purchasedBalance).toBe(800);
		// Session reset = oldest in-window usage + the 5-hour window.
		expect(r.sessionResetAt).toBe(
			new Date(oldest.getTime() + AI_SESSION_WINDOW_MS).toISOString(),
		);
		expect(sumCredits).toHaveBeenCalledWith("org-1", "included", expect.any(Date));
	});

	it("reports no active session when the rolling window is empty", async () => {
		orgBilling.mockResolvedValue(null); // free tier
		vi.mocked(sumCredits).mockResolvedValue(0);
		vi.mocked(purchasedBalance).mockResolvedValue(0);
		vi.mocked(oldestUsageSince).mockResolvedValue(null);

		const r = await getAiUsageSummary();
		expect(r.sessionUsed).toBe(0);
		expect(r.sessionResetAt).toBeNull();
	});
});

// Owner-gated subscription actions: assert the early refusal guards (which run before any
// Stripe call) so a personal scope or an already-subscribed org can't double-subscribe.
describe("subscription guards", () => {
	const authz = vi.mocked(authorize);
	const ORIGINAL_KEY = process.env.STRIPE_SECRET_KEY;
	beforeEach(() => {
		process.env.STRIPE_SECRET_KEY = "sk_test_123"; // hosted billing wired
	});
	afterEach(() => {
		if (ORIGINAL_KEY === undefined) delete process.env.STRIPE_SECRET_KEY;
		else process.env.STRIPE_SECRET_KEY = ORIGINAL_KEY;
	});

	it("createSubscriptionIntent refuses the personal scope", async () => {
		authz.mockResolvedValue({ orgId: "user-1", userId: "user-1" } as never);
		await expect(createSubscriptionIntent("team")).resolves.toEqual({
			error: "Create an organization before subscribing to a plan.",
		});
	});

	it("createSubscriptionIntent refuses an org with a live subscription", async () => {
		authz.mockResolvedValue({ orgId: "org-1", userId: "user-1" } as never);
		orgBilling.mockResolvedValue(
			billing({ status: "active", stripeSubscriptionId: "sub_live" }),
		);
		await expect(createSubscriptionIntent("team")).resolves.toEqual({
			error: "This organization already has an active subscription — change the plan instead.",
		});
	});

	it("startProTrial refuses the personal scope", async () => {
		authz.mockResolvedValue({ orgId: "user-1", userId: "user-1" } as never);
		await expect(startProTrial()).rejects.toThrow(/Create an organization/);
	});

	it("createCreditPackIntent refuses the free AI tier (packs top up a paid plan)", async () => {
		authz.mockResolvedValue({ orgId: "org-1", userId: "user-1" } as never);
		orgBilling.mockResolvedValue(null); // no billing row → ai_free
		await expect(createCreditPackIntent("s")).rejects.toThrow(
			/paid AI plans/,
		);
	});
});
