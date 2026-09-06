"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { formatMonthlyRate } from "@repo/format";
import { useEnvironmentStatus } from "@/lib/canvas/environment-status-context";

/**
 * What this environment costs — the headline number the product could never answer.
 *
 * The runner has always run Infracost on every PLAN and posted the breakdown; nobody ever wrote it
 * down, so "what does production cost?" had nowhere to look. Now it does.
 *
 * The honest states matter here. Never planned = we genuinely don't know, and the chip says so
 * rather than showing $0.00 — a fabricated zero is worse than an admitted unknown, because you'd
 * believe it.
 */
export function CostChip() {
	const env = useEnvironmentStatus();

	if (env.monthlyCost == null) {
		return (
			<span
				className="flex h-8 items-center gap-1.5 border border-dashed border-border px-2.5 font-mono text-ui-2xs uppercase tracking-wide text-muted-foreground"
				title="Run a plan to price this environment."
			>
				Not priced
			</span>
		);
	}

	return (
		<span
			className="flex h-8 items-center gap-2 border border-border bg-card px-2.5"
			title={
				env.costCapturedAt
					? `From the plan on ${new Date(env.costCapturedAt).toLocaleString()}`
					: undefined
			}
		>
			{/* No "Monthly" eyebrow: `formatMonthlyRate` carries its own `/mo`, and "Monthly
			    $12.50/mo" labels the period twice in a chip whose constraint is horizontal
			    space. `exact` because the node cards on the same canvas are the parts of this
			    number, and a total that rounds differently from its parts cannot be checked. */}
			<span className="font-mono text-xs text-foreground">
				{formatMonthlyRate(env.monthlyCost, "exact")}
			</span>
		</span>
	);
}
