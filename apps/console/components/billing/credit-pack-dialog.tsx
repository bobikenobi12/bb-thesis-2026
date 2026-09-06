"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The AI credit-pack top-up dialog. Credit packs are ONE-TIME top-ups that stack on a PAID
// AI plan and never expire (independent of the subscription); a free org sees an
// upgrade-first panel instead — packs are priced above the plans' included rate, so the
// plan is always the better first dollar (mirrors the server guard on
// createCreditPackIntent). Pick a pack → raise a one-time invoice (createCreditPackIntent
// → the ad-hoc-invoice path) → confirm inline through the SHARED embedded <PaymentForm>
// (mode="payment") → refresh the purchased balance. Owner-gated server-side. Gated behind
// the same `paidTiersEnabled` switch as the tier chooser: until the deployment mints its
// Stripe AI prices the packs render disabled ("Coming soon").

import { formatMoney } from "@repo/format";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
	type AiUsageSummary,
	createCreditPackIntent,
	getAiUsageSummary,
} from "@/app/server/actions/billing";
import { PaymentForm } from "@/components/billing/payment-form";
import { StripeElementsProvider } from "@/components/billing/stripe-elements";
import { track } from "@/lib/analytics/track";
import { AI_CREDIT_PACKS, type CreditPack } from "@/lib/billing/ai-credits";
import { billingIntentErrorMessage } from "@/lib/billing/intent-error";
import { Badge } from "@repo/ui/badge";
import { Button } from "@repo/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@repo/ui/dialog";
import { Skeleton } from "@repo/ui/skeleton";
import { cn } from "@repo/ui/utils";

interface CreditPackDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** Called after a confirmed purchase so the caller can refetch its AI summary. */
	onPurchased?: () => void;
	/**
	 * Called when a free-tier org picks "Upgrade AI plan" from the upgrade-first panel
	 * (after this dialog closes) — callers wire it to their mounted UpgradeAiSheet.
	 */
	onUpgradeInstead?: () => void;
}

/**
 * Format a USD-cent amount as a plain dollar figure (packs are billed in USD).
 *
 * `formatMoney` rather than a local `$${cents / 100}`: the hand-rolled form dropped a trailing
 * zero, so a $12.50 pack read `$12.5` here and `$12.50` on the invoice for the same purchase.
 */
function usd(cents: number): string {
	return formatMoney(cents);
}

/** The pack with the lowest $/credit (the "Best value" badge). */
const BEST_VALUE_PACK_ID = AI_CREDIT_PACKS.reduce((best, p) =>
	p.amountCents / p.credits < best.amountCents / best.credits ? p : best,
).id;

/**
 * The credit-pack top-up dialog. Self-fetches the AI summary on open for the current purchased
 * balance + the `paidTiersEnabled` gate, lists the packs, and runs the chosen pack through the
 * shared embedded PaymentForm. No subscription — a single invoice per purchase.
 */
export function CreditPackDialog({
	open,
	onOpenChange,
	onPurchased,
	onUpgradeInstead,
}: CreditPackDialogProps) {
	const router = useRouter();
	const [summary, setSummary] = useState<AiUsageSummary | null>(null);
	const [pack, setPack] = useState<CreditPack | null>(null);
	const [clientSecret, setClientSecret] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!open) return;
		let alive = true;
		getAiUsageSummary()
			.then((s) => alive && setSummary(s))
			.catch(() => {
				/* best-effort — the list just shows skeletons */
			});
		return () => {
			alive = false;
		};
	}, [open]);

	/** Reset transient state (called on close). */
	function reset() {
		setPack(null);
		setClientSecret(null);
		setError(null);
	}

	function handleOpenChange(next: boolean) {
		if (!next) reset();
		onOpenChange(next);
	}

	/** Raise the one-time invoice for the chosen pack and reveal the embedded payment form. */
	async function choose(next: CreditPack) {
		setPack(next);
		setClientSecret(null);
		setError(null);
		track("upgrade_started", { plan: `credits_${next.id}`, context: "credit_pack_dialog" });
		try {
			const intent = await createCreditPackIntent(next.id);
			setClientSecret(intent.clientSecret);
		} catch (e) {
			setError(billingIntentErrorMessage(e));
		}
	}

	/** Invoice paid — the webhook grants the credits; refresh the balance and close. */
	function handleSuccess() {
		onPurchased?.();
		router.refresh();
		toast.success(
			pack ? `Added ${pack.credits.toLocaleString("en-US")} AI credits.` : "Credits added.",
		);
		handleOpenChange(false);
	}

	const paidTiersEnabled = summary?.paidTiersEnabled ?? false;
	// Packs top up a PAID plan — a free org gets pointed at the upgrade instead.
	const freeTier = summary !== null && summary.tier === "ai_free";

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>{pack ? "Confirm your purchase" : "Buy AI credits"}</DialogTitle>
					<DialogDescription>
						{pack
							? `${pack.credits.toLocaleString("en-US")} credits for ${usd(pack.amountCents)}. One-time — they stack on your plan and never expire.`
							: freeTier
								? "Credit packs top up a paid AI plan."
								: "A one-time purchase. Credits never expire and stack on top of your plan's included usage."}
					</DialogDescription>
				</DialogHeader>

				{pack ? (
					<PurchaseStep
						clientSecret={clientSecret}
						error={error}
						onSuccess={handleSuccess}
						onError={setError}
						onBack={() => {
							setPack(null);
							setClientSecret(null);
							setError(null);
						}}
					/>
				) : freeTier ? (
					<UpgradeFirst
						onUpgrade={() => {
							handleOpenChange(false);
							onUpgradeInstead?.();
						}}
					/>
				) : (
					<PackList
						summary={summary}
						paidTiersEnabled={paidTiersEnabled}
						onChoose={choose}
					/>
				)}
			</DialogContent>
		</Dialog>
	);
}

/** The free-tier panel: packs need a paid plan first (plans include far more usage per
 *  dollar than packs, so the upgrade is always the better first step). */
function UpgradeFirst({ onUpgrade }: { onUpgrade: () => void }) {
	return (
		<div className="space-y-3">
			<p className="rounded-lg border border-border bg-surface-sunken px-4 py-3 text-ui-sm leading-relaxed text-text-secondary">
				Top-up credits are available on AI Plus and AI Max. A paid plan includes far
				more usage per dollar than a pack — upgrade first, then top up if you still
				run out.
			</p>
			<Button type="button" className="w-full" onClick={onUpgrade}>
				Upgrade AI plan
			</Button>
		</div>
	);
}

/** The pack picker — a row per pack, gated behind `paidTiersEnabled` ("Coming soon"). */
function PackList({
	summary,
	paidTiersEnabled,
	onChoose,
}: {
	summary: AiUsageSummary | null;
	paidTiersEnabled: boolean;
	onChoose: (pack: CreditPack) => void;
}) {
	if (!summary) {
		return (
			<div className="space-y-2">
				{AI_CREDIT_PACKS.map((p) => (
					<Skeleton key={p.id} className="h-14 w-full" />
				))}
			</div>
		);
	}
	return (
		<div className="space-y-3">
			<div className="space-y-2">
				{AI_CREDIT_PACKS.map((p) => (
					<button
						key={p.id}
						type="button"
						disabled={!paidTiersEnabled}
						onClick={() => onChoose(p)}
						className={cn(
							"flex w-full items-center justify-between rounded-lg border border-border bg-surface px-4 py-3 text-left transition-colors",
							paidTiersEnabled
								? "hover:border-border-strong"
								: "cursor-not-allowed opacity-60",
						)}
					>
						<span className="flex items-center gap-2">
							<span className="flex flex-col">
								<span className="text-ui-md font-medium text-text-primary">
									{p.credits.toLocaleString("en-US")} credits
								</span>
								<span className="font-mono text-ui-2xs text-text-tertiary">
									One-time top-up
								</span>
							</span>
							{p.id === BEST_VALUE_PACK_ID && paidTiersEnabled && (
								<Badge variant="secondary" className="font-mono text-ui-3xs uppercase">
									Best value
								</Badge>
							)}
						</span>
						<span className="flex items-center gap-2">
							{!paidTiersEnabled && (
								<Badge variant="outline" className="font-mono text-ui-3xs uppercase">
									Coming soon
								</Badge>
							)}
							<span className="font-mono text-ui-md text-text-secondary">
								{usd(p.amountCents)}
							</span>
						</span>
					</button>
				))}
			</div>
			<div className="flex items-center justify-between border-t border-border pt-3 text-ui-sm text-text-tertiary">
				<span>Current balance</span>
				<span className="font-mono text-text-secondary">
					{summary.purchasedBalance.toLocaleString("en-US")} credits
				</span>
			</div>
			<p className="text-ui-xs leading-relaxed text-text-tertiary">
				Packs are priced above your plan&apos;s included rate — if you hit limits
				often, upgrading your AI plan is the better deal.
			</p>
		</div>
	);
}

/** The confirm step — the shared embedded PaymentForm for the raised invoice. */
function PurchaseStep({
	clientSecret,
	error,
	onSuccess,
	onError,
	onBack,
}: {
	clientSecret: string | null;
	error: string | null;
	onSuccess: () => void;
	onError: (message: string) => void;
	onBack: () => void;
}) {
	if (error) {
		return (
			<div className="space-y-3">
				<p className="rounded-lg border border-border bg-surface-sunken px-4 py-3 text-ui-sm text-text-secondary">
					{error}
				</p>
				<Button variant="outline" className="w-full" onClick={onBack}>
					Back
				</Button>
			</div>
		);
	}
	if (!clientSecret) {
		return (
			<div className="space-y-3">
				<Skeleton className="h-10 w-full" />
				<Skeleton className="h-24 w-full" />
			</div>
		);
	}
	return (
		<div className="space-y-3">
			<StripeElementsProvider clientSecret={clientSecret}>
				<PaymentForm mode="payment" submitLabel="Pay" onSuccess={onSuccess} onError={onError} />
			</StripeElementsProvider>
			<button
				type="button"
				onClick={onBack}
				className="w-full text-center text-ui-sm text-text-tertiary transition-colors hover:text-text-primary"
			>
				← Choose a different pack
			</button>
		</div>
	);
}
