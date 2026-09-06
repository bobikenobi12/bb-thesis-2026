// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { formatDuration } from "@repo/format";
import { JOB_TYPES } from "@/lib/jobs/format";
import { provisionJobType } from "@/lib/db/schema/enums";

describe("formatDuration", () => {
	it("renders sub-minute spans in seconds", () => {
		expect(formatDuration(42_000)).toBe("42s");
		expect(formatDuration(0)).toBe("0s");
		expect(formatDuration(500)).toBe("0s"); // floors sub-second
	});

	it("renders minute+second spans", () => {
		expect(formatDuration(60_000)).toBe("1m 0s");
		expect(formatDuration(72_000)).toBe("1m 12s");
		expect(formatDuration(125_000)).toBe("2m 5s");
		expect(formatDuration(3_599_999)).toBe("59m 59s");
	});

	it("rolls into hours at sixty minutes, and drops the seconds", () => {
		// The console used to render 7_200_000 as "120m 0s" and make the reader divide. A provision
		// over an hour is ordinary, so the shape that read worst covered the common case.
		expect(formatDuration(3_600_000)).toBe("1h 0m");
		expect(formatDuration(7_200_000)).toBe("2h 0m");
		expect(formatDuration(7_505_000)).toBe("2h 5m");
	});
});

describe("JOB_TYPES catalog", () => {
	it("has an entry for every provision job type", () => {
		for (const t of provisionJobType.enumValues) {
			expect(JOB_TYPES[t]).toBeDefined();
			expect(JOB_TYPES[t].label).toBeTruthy();
			expect(JOB_TYPES[t].description).toBeTruthy();
			expect(JOB_TYPES[t].icon).toBeTypeOf("object"); // a lucide component
		}
	});
});
