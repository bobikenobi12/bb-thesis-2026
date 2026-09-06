// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The billing-intent error message a customer actually reads.
//
// `createSubscriptionIntent` is a server action, and a production Next.js build replaces a thrown
// error's message with a framework digest. The old code was
// `e instanceof Error ? e.message : "Couldn't start the upgrade."` — and a rejected server action IS
// an Error, so the fallback could never fire. Observed on alethialabs.io, in the upgrade sheet, to
// somebody trying to give us money:
//
//   Minified React error #441; visit https://react.dev/errors/441 for the full message…
//
// The test is written around that string on purpose: the bug was not "no fallback exists", it was
// "the fallback was unreachable for the only failure that happens in production".

import { describe, expect, it } from "vitest";
import { billingIntentErrorMessage } from "@/lib/billing/intent-error";

const FALLBACK_HINT = "Billing may not be configured";

describe("billingIntentMessage", () => {
	it.each([
		[
			"the minified React error a production server action actually produced",
			"Minified React error #441; visit https://react.dev/errors/441 for the full message or use the non-minified dev environment for full errors and additional helpful warnings.",
		],
		["a bare react.dev error link", "See https://react.dev/errors/423 for more"],
		[
			"Next's generic server-render message",
			"An error occurred in the Server Components render. The specific message is omitted in production builds.",
		],
		["a missing server action", "Failed to find Server Action \"abc123\"."],
		["an empty message", ""],
		["a whitespace-only message", "   "],
	])("replaces %s with the product sentence", (_label, message) => {
		expect(billingIntentErrorMessage(new Error(message))).toContain(FALLBACK_HINT);
	});

	it.each([
		["a non-Error rejection", "just a string"],
		["null", null],
		["undefined", undefined],
	])("falls back on %s", (_label, thrown) => {
		expect(billingIntentErrorMessage(thrown)).toContain(FALLBACK_HINT);
	});
});
