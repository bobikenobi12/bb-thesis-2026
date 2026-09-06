"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Admin AI-spend limits (Claude-Enterprise style): an org-wide and a per-member weekly
// ceiling that only ever TIGHTEN the plan's included caps. Shown on the AI usage card to
// admins (manage_billing) only. Entered in USD/week; stored as credits ($0.001/credit).

import { useState } from "react";
import { setAiSpendCaps } from "@/app/server/actions/billing";
import { Button } from "@repo/ui/button";
import { Input } from "@repo/ui/input";

const CREDITS_PER_DOLLAR = 1_000; // 1 credit = $0.001 (see lib/billing/ai-credits.ts)

/** Credits → the dollars string shown in the field (empty = no limit). */
function toDollars(credits: number | null): string {
	return credits == null ? "" : String(credits / CREDITS_PER_DOLLAR);
}

/** A dollars field → credits to store (blank/invalid = null = no limit). */
function toCredits(dollars: string): number | null {
	const t = dollars.trim();
	if (!t) return null;
	const n = Number(t);
	return Number.isFinite(n) && n >= 0 ? Math.round(n * CREDITS_PER_DOLLAR) : null;
}

/**
 * The two spend-limit fields + a Save. Seeds from the current caps; a blank field clears the
 * limit (back to the plan default). Save persists both via `setAiSpendCaps` and refetches.
 */
export function AiSpendLimits({
	orgWeeklyCapCredits,
	perUserWeeklyCapCredits,
	onSaved,
}: {
	orgWeeklyCapCredits: number | null;
	perUserWeeklyCapCredits: number | null;
	onSaved: () => void;
}) {
	const [org, setOrg] = useState(toDollars(orgWeeklyCapCredits));
	const [perUser, setPerUser] = useState(toDollars(perUserWeeklyCapCredits));
	const [saving, setSaving] = useState(false);

	const dirty =
		org !== toDollars(orgWeeklyCapCredits) ||
		perUser !== toDollars(perUserWeeklyCapCredits);

	const save = async () => {
		setSaving(true);
		try {
			await setAiSpendCaps(toCredits(org), toCredits(perUser));
			onSaved();
		} finally {
			setSaving(false);
		}
	};

	return (
		<div className="border-t border-border px-6 py-4">
			<div className="mb-2.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
				<span className="font-mono text-ui-2xs uppercase tracking-[0.1em] text-text-tertiary">
					Spend limits
				</span>
				<span className="text-ui-xs text-text-tertiary">
					Weekly ceilings on top of your plan — AI pauses here. Leave blank for none.
				</span>
			</div>
			<div className="flex flex-wrap items-end gap-3">
				<CapField label="Whole org / week" value={org} onChange={setOrg} />
				<CapField label="Per member / week" value={perUser} onChange={setPerUser} />
				<Button
					size="sm"
					variant="outline"
					className="rounded-none"
					disabled={!dirty || saving}
					onClick={() => void save()}
				>
					{saving ? "Saving…" : "Save limits"}
				</Button>
			</div>
		</div>
	);
}

/** A single dollars/week input with a `$` adornment. */
function CapField({
	label,
	value,
	onChange,
}: {
	label: string;
	value: string;
	onChange: (v: string) => void;
}) {
	return (
		<label className="flex flex-col gap-1">
			<span className="font-mono text-ui-3xs uppercase tracking-wide text-text-tertiary">
				{label}
			</span>
			<span className="flex items-center gap-1 border border-border bg-background px-2">
				<span className="text-ui-sm text-text-tertiary">$</span>
				<Input
					type="number"
					min={0}
					inputMode="decimal"
					placeholder="No limit"
					value={value}
					onChange={(e) => onChange(e.target.value)}
					className="h-8 w-28 rounded-none border-0 bg-transparent px-0 text-ui-md shadow-none focus-visible:ring-0"
				/>
			</span>
		</label>
	);
}
