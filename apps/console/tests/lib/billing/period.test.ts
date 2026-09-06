// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { effectiveBillingPeriodStart } from "@/lib/billing/period";

describe("effectiveBillingPeriodStart", () => {
	it("resets an open-ended grant monthly on its grant-day anchor", () => {
		const start = new Date("2026-01-12T09:30:00.000Z");
		const now = new Date("2026-08-31T12:00:00.000Z");
		expect(effectiveBillingPeriodStart(start, null, now).toISOString()).toBe(
			"2026-08-12T09:30:00.000Z",
		);
	});

	it("uses the previous month before this month's anchor", () => {
		const start = new Date("2026-01-20T09:30:00.000Z");
		const now = new Date("2026-08-10T12:00:00.000Z");
		expect(effectiveBillingPeriodStart(start, null, now).toISOString()).toBe(
			"2026-07-20T09:30:00.000Z",
		);
	});

	it("clamps a month-end anchor to the target month's final day", () => {
		const start = new Date("2026-01-31T09:30:00.000Z");
		const now = new Date("2026-02-28T12:00:00.000Z");
		expect(effectiveBillingPeriodStart(start, null, now).toISOString()).toBe(
			"2026-02-28T09:30:00.000Z",
		);
	});

	it("preserves Stripe's bounded billing period", () => {
		const start = new Date("2026-01-12T09:30:00.000Z");
		const end = new Date("2027-01-12T09:30:00.000Z");
		expect(effectiveBillingPeriodStart(start, end, new Date("2026-08-31T12:00:00Z"))).toBe(
			start,
		);
	});
});
