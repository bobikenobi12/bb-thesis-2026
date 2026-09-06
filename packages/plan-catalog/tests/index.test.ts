// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The plan catalog lives in @repo/plan-catalog (no test runner of its own); exercise it
// from the console suite, the same way @repo/ui/range is tested here.

import { describe, expect, it } from "vitest";
import {
	AI_PLAN_CATALOG,
	aiPlanMeta,
	aiPlanUnitAmountCents,
	asSupportedCurrency,
	formatSeatPrice,
	PAID_AI_PLANS,
	PAID_PLANS,
	PLAN_CATALOG,
	planMeta,
	planUnitAmountCents,
} from "../src/index";

describe("planMeta", () => {
	it("resolves each known plan to its display entry", () => {
		expect(planMeta("community").name).toBe("Hobby");
		expect(planMeta("team").name).toBe("Pro");
		expect(planMeta("enterprise").name).toBe("Enterprise");
	});

	it("falls back to community for an unknown id", () => {
		// @ts-expect-error — exercising the runtime fallback path
		expect(planMeta("mystery").id).toBe("community");
	});
});

describe("supported currency boundary", () => {
	it("accepts sale currencies and refuses unsupported Stripe quotes", () => {
		expect(asSupportedCurrency("usd")).toBe("usd");
		expect(asSupportedCurrency("eur")).toBe("eur");
		expect(asSupportedCurrency("jpy")).toBeNull();
		expect(formatSeatPrice(2000, "usd", "month")).toBe("$20 / seat / mo");
	});
});

describe("PLAN_CATALOG invariants", () => {
	it("has unique plan ids", () => {
		const ids = PLAN_CATALOG.map((p) => p.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("marks Pro as per-seat with an included usage credit", () => {
		const team = planMeta("team");
		expect(team.perSeat).toBe(true);
		expect(team.priceMonthlyUsd).toBeGreaterThan(0);
		expect(team.includedCreditUsd).toBeGreaterThan(0);
	});

	it("prices Pro in both USD and EUR", () => {
		const team = planMeta("team");
		expect(team.priceMonthlyEur).toBeGreaterThan(0);
		// EUR is FX-adjusted, not parity.
		expect(team.priceMonthlyEur).not.toBe(team.priceMonthlyUsd);
	});
});

describe("planUnitAmountCents", () => {
	it("returns the per-currency amount in cents (default USD)", () => {
		expect(planUnitAmountCents("team")).toBe((planMeta("team").priceMonthlyUsd ?? 0) * 100);
		expect(planUnitAmountCents("team", "usd")).toBe(planUnitAmountCents("team"));
		expect(planUnitAmountCents("team", "eur")).toBe((planMeta("team").priceMonthlyEur ?? 0) * 100);
	});

	it("throws for a plan without a numeric price (Enterprise)", () => {
		expect(() => planUnitAmountCents("enterprise")).toThrow();
		expect(() => planUnitAmountCents("enterprise", "eur")).toThrow();
	});

	it("treats community as the only free tier", () => {
		expect(planMeta("community").paid).toBe(false);
		expect(PLAN_CATALOG.filter((p) => !p.paid)).toHaveLength(1);
	});
});

describe("PAID_PLANS", () => {
	it("is exactly the paid tiers (excludes community)", () => {
		expect(PAID_PLANS.every((p) => p.paid)).toBe(true);
		expect(PAID_PLANS.map((p) => p.id)).not.toContain("community");
	});
});

describe("AI plan catalog (final pricing)", () => {
	it("prices AI Plus at $20 / mo (€18)", () => {
		const plus = aiPlanMeta("ai_plus");
		expect(plus.priceLabel).toBe("$20 / mo");
		expect(plus.priceMonthlyUsd).toBe(20);
		expect(plus.priceMonthlyEur).toBe(18);
	});

	it("prices AI Max at $100 / mo (€90)", () => {
		const max = aiPlanMeta("ai_max");
		expect(max.priceLabel).toBe("$100 / mo");
		expect(max.priceMonthlyUsd).toBe(100);
		expect(max.priceMonthlyEur).toBe(90);
	});

	it("keeps AI Free free", () => {
		const free = aiPlanMeta("ai_free");
		expect(free.paid).toBe(false);
		expect(free.priceMonthlyUsd).toBe(0);
	});

	it("never leaks model names into user-facing copy", () => {
		// Tiers are described by what Elench does, not by which model serves it.
		for (const entry of AI_PLAN_CATALOG) {
			const strings = [entry.name, entry.tagline, entry.advisor, ...entry.highlights];
			for (const s of strings) {
				expect(s).not.toMatch(/sonnet|opus|haiku|executor/i);
			}
		}
	});

	it("recommends exactly one paid tier (AI Plus) to the upgrade UI", () => {
		const recommended = AI_PLAN_CATALOG.filter((p) => p.recommended);
		expect(recommended.map((p) => p.id)).toEqual(["ai_plus"]);
	});

	it("PAID_AI_PLANS excludes the free tier (the upgrade chooser never shows it)", () => {
		expect(PAID_AI_PLANS.every((p) => p.paid)).toBe(true);
		expect(PAID_AI_PLANS.map((p) => p.id)).toEqual(["ai_plus", "ai_max"]);
	});
});

describe("aiPlanUnitAmountCents (Stripe-provisioning SSOT)", () => {
	it("returns the final per-currency AI amounts in cents", () => {
		expect(aiPlanUnitAmountCents("ai_plus")).toBe(2000);
		expect(aiPlanUnitAmountCents("ai_plus", "eur")).toBe(1800);
		expect(aiPlanUnitAmountCents("ai_max")).toBe(10000);
		expect(aiPlanUnitAmountCents("ai_max", "eur")).toBe(9000);
	});

	it("is free (0 cents) for AI Free rather than throwing", () => {
		expect(aiPlanUnitAmountCents("ai_free")).toBe(0);
	});
});
