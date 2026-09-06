"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// A compact USD/EUR segmented control for the billing currency. EU/EEA customers default to
// EUR (resolved server-side from the request geo); this lets the customer switch — which
// re-creates the subscription intent, since Stripe locks a subscription's currency.

import type { SupportedCurrency } from "@repo/plan-catalog";
import { cn } from "@repo/ui/utils";

const OPTIONS: ReadonlyArray<{ value: SupportedCurrency; label: string }> = [
	{ value: "usd", label: "USD" },
	{ value: "eur", label: "EUR" },
];

interface CurrencyToggleProps {
	value: SupportedCurrency;
	onChange: (currency: SupportedCurrency) => void;
	/** Disable while the intent/price re-loads. */
	disabled?: boolean;
	className?: string;
}

/** USD/EUR segmented toggle for the billing currency. */
export function CurrencyToggle({ value, onChange, disabled, className }: CurrencyToggleProps) {
	return (
		<div
			role="group"
			aria-label="Billing currency"
			className={cn(
				"inline-flex items-center rounded-md border border-border bg-surface-sunken p-0.5",
				className,
			)}
		>
			{OPTIONS.map((opt) => (
				<button
					key={opt.value}
					type="button"
					disabled={disabled}
					aria-pressed={value === opt.value}
					onClick={() => onChange(opt.value)}
					className={cn(
						"rounded px-2.5 py-1 text-ui-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
						value === opt.value
							? "bg-surface text-text-primary shadow-sm"
							: "text-text-secondary hover:text-text-primary",
					)}
				>
					{opt.label}
				</button>
			))}
		</div>
	);
}
