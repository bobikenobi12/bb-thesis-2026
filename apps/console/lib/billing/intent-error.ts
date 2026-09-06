// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

const BILLING_INTENT_FALLBACK =
	"Couldn't start the purchase. Billing may not be configured on this deployment — try again, or contact support if it persists.";

/** Returns a stable customer-facing sentence for an unexpected billing-intent rejection. */
export function billingIntentErrorMessage(error: unknown): string {
	console.error("[billing] intent creation failed", error);
	return BILLING_INTENT_FALLBACK;
}
