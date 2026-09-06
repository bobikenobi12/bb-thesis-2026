"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The standalone AI-plan upgrade sheet. AI is a SEPARATE metered product from the org plan
// (tiers ai_free → ai_plus → ai_max), so this is a lean chooser (no invite/seat step, unlike
// the org sheet): pick a paid tier → open its subscription intent (createAiSubscriptionIntent)
// → pay through the SHARED checkout stack (StripeElementsProvider + BillingCheckoutForm +
// CurrencyToggle) → refresh the AI tier. Only the PAID tiers render — the free tier is where
// you already are, not an option to pick. Owner-gated server-side; a non-owner (or a personal
// workspace) surfaces a friendly inline error. When the deployment hasn't minted the Stripe AI
// prices yet (`paidTiersEnabled` false) the paid tiers render disabled with a "Coming soon"
// badge — the UI ships now and lights up automatically at go-live.

import { Check } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
	type AiUsageSummary,
	createAiSubscriptionIntent,
	getAiUsageSummary,
	saveTaxId,
	updateBillingAddress,
} from "@/app/server/actions/billing";
import {
	billingAddressFrom,
	BillingCheckoutForm,
	type CollectedBilling,
} from "@/components/billing/billing-checkout-form";
import { CurrencyToggle } from "@/components/billing/currency-toggle";
import { StripeElementsProvider } from "@/components/billing/stripe-elements";
import { authClient } from "@/lib/auth/client";
import { track } from "@/lib/analytics/track";
import type { PaidAiTier } from "@/lib/billing/config";
import { billingIntentErrorMessage } from "@/lib/billing/intent-error";
import {
	type AiPlanCatalogEntry,
	aiPlanMeta,
	PAID_AI_PLANS,
	type SupportedCurrency,
} from "@repo/plan-catalog";
import { Badge } from "@repo/ui/badge";
import { Button } from "@repo/ui/button";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@repo/ui/sheet";
import { Skeleton } from "@repo/ui/skeleton";
import { cn } from "@repo/ui/utils";

type View = "choose" | "pay";

interface UpgradeAiSheetProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** Called after a confirmed upgrade so the caller can refetch its AI summary. */
	onUpgraded?: () => void;
}

/** Narrow a catalog id to a paid AI tier (`ai_plus`/`ai_max`), or null for the free tier. */
function paidTierOf(entry: AiPlanCatalogEntry): PaidAiTier | null {
	if (entry.id === "ai_plus") return "ai_plus";
	if (entry.id === "ai_max") return "ai_max";
	return null;
}

/**
 * The AI upgrade sheet. Self-fetches the AI summary on open (current tier + the
 * `paidTiersEnabled` gate), lets the owner pick a paid tier, then drops into the shared
 * checkout for that tier's subscription. No seat/invite step — AI is a flat product.
 */
export function UpgradeAiSheet({ open, onOpenChange, onUpgraded }: UpgradeAiSheetProps) {
	const router = useRouter();
	const { data: session } = authClient.useSession();
	const ownerEmail = session?.user?.email ?? "";

	const [summary, setSummary] = useState<AiUsageSummary | null>(null);
	const [view, setView] = useState<View>("choose");
	const [tier, setTier] = useState<PaidAiTier | null>(null);
	const [clientSecret, setClientSecret] = useState<string | null>(null);
	// `selected` is the explicit currency override (undefined = let the server geo-decide);
	// `currency` is what the created intent actually used (Stripe locks it) — drives display.
	const [selected, setSelected] = useState<SupportedCurrency | undefined>(undefined);
	const [currency, setCurrency] = useState<SupportedCurrency>("usd");
	const [error, setError] = useState<string | null>(null);

	// Load the canonical AI summary when the sheet opens — the current tier drives the
	// "Current"/"Upgrade" affordances and `paidTiersEnabled` drives the "Coming soon" gate.
	useEffect(() => {
		if (!open) return;
		let alive = true;
		getAiUsageSummary()
			.then((s) => alive && setSummary(s))
			.catch(() => {
				/* best-effort — the chooser just shows skeletons */
			});
		return () => {
			alive = false;
		};
	}, [open]);

	// Open (or re-open, on a currency switch) the subscription intent once a paid tier is
	// picked. Stripe locks a subscription's currency at creation, so the toggle re-creates it.
	useEffect(() => {
		if (!open || !tier) return;
		let alive = true;
		setClientSecret(null);
		setError(null);
		createAiSubscriptionIntent(tier, selected ? { currency: selected } : undefined)
			.then((intent) => {
				if (!alive) return;
				setClientSecret(intent.clientSecret);
				setCurrency(intent.currency);
			})
			.catch((error) => alive && setError(billingIntentErrorMessage(error)));
		return () => {
			alive = false;
		};
	}, [open, tier, selected]);

	/** Reset all transient state (called on close). */
	function reset() {
		setView("choose");
		setTier(null);
		setClientSecret(null);
		setSelected(undefined);
		setCurrency("usd");
		setError(null);
	}

	function handleOpenChange(next: boolean) {
		if (!next) reset();
		onOpenChange(next);
	}

	/** Begin checkout for a paid tier — records the intent and swaps to the pay view. */
	function choose(next: PaidAiTier) {
		track("upgrade_started", { plan: next, context: "ai_upgrade_sheet" });
		setTier(next);
		setView("pay");
	}

	/**
	 * Card confirmed — the webhook flips the org's AI tier; persist billing details
	 * (best-effort), refetch/refresh so the new tier reflects everywhere, then close.
	 */
	async function handlePaid(billing: CollectedBilling) {
		try {
			await updateBillingAddress(billingAddressFrom(billing));
		} catch {
			// Non-fatal — Stripe already has the address from the payment method.
		}
		if (billing.taxValue.trim()) {
			try {
				await saveTaxId(billing.taxType, billing.taxValue);
			} catch {
				toast.warning("Couldn't save the tax id — add it later in billing.");
			}
		}
		onUpgraded?.();
		router.refresh();
		toast.success(`You're on ${aiPlanMeta(tier ?? "ai_plus").name}.`);
		handleOpenChange(false);
	}

	const currentTier = summary?.tier ?? "ai_free";
	const paidTiersEnabled = summary?.paidTiersEnabled ?? false;
	const meta = tier ? aiPlanMeta(tier) : null;

	return (
		<Sheet open={open} onOpenChange={handleOpenChange}>
			<SheetContent side="right" className="w-[92vw] gap-0 sm:max-w-md">
				<SheetHeader>
					<SheetTitle>
						{view === "pay" && meta ? `Upgrade to ${meta.name}` : "Upgrade your AI plan"}
					</SheetTitle>
					<SheetDescription>
						{view === "pay"
							? "Add a payment method to raise your session and weekly limits."
							: "AI is billed separately from your workspace plan. A paid plan raises your session and weekly limits and deepens what Elench can do."}
					</SheetDescription>
				</SheetHeader>

				<div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pb-6">
					{view === "choose" ? (
						<ChooserView
							summary={summary}
							currentTier={currentTier}
							paidTiersEnabled={paidTiersEnabled}
							onChoose={choose}
						/>
					) : (
						<PayView
							meta={meta}
							currency={currency}
							clientSecret={clientSecret}
							error={error}
							ownerEmail={ownerEmail}
							onCurrencyChange={setSelected}
							onBack={() => {
								setView("choose");
								setTier(null);
								setClientSecret(null);
								setError(null);
							}}
							onClose={() => handleOpenChange(false)}
							onPaid={handlePaid}
						/>
					)}
				</div>
			</SheetContent>
		</Sheet>
	);
}

/** The plan chooser — one card per PAID tier (the free tier is where you already are, so
 *  it never renders), gated behind `paidTiersEnabled` ("Coming soon" until the Stripe
 *  prices are minted). Exactly one primary button: the recommended selectable tier. */
function ChooserView({
	summary,
	currentTier,
	paidTiersEnabled,
	onChoose,
}: {
	summary: AiUsageSummary | null;
	currentTier: string;
	paidTiersEnabled: boolean;
	onChoose: (tier: PaidAiTier) => void;
}) {
	if (!summary) {
		return (
			<div className="space-y-3">
				{[0, 1].map((i) => (
					<Skeleton key={i} className="h-40 w-full" />
				))}
			</div>
		);
	}
	const selectableIds = PAID_AI_PLANS.filter(
		(entry) => entry.id !== currentTier && paidTiersEnabled,
	).map((entry) => entry.id);
	// One primary CTA per view: the recommended selectable tier (else the first selectable).
	const primaryId =
		selectableIds.find(
			(id) => PAID_AI_PLANS.find((entry) => entry.id === id)?.recommended,
		) ?? selectableIds[0];
	return (
		<div className="space-y-3">
			{PAID_AI_PLANS.map((entry) => {
				const paid = paidTierOf(entry);
				const isCurrent = entry.id === currentTier;
				const comingSoon = !paidTiersEnabled;
				const selectable = paid !== null && !isCurrent && paidTiersEnabled;
				return (
					<TierCard
						key={entry.id}
						entry={entry}
						isCurrent={isCurrent}
						comingSoon={comingSoon}
						selectable={selectable}
						primary={entry.id === primaryId}
						onChoose={() => paid && onChoose(paid)}
					/>
				);
			})}
			<p className="px-1 text-ui-xs text-text-tertiary">
				Billed monthly, cancel any time. Included usage refills on a rolling 5-hour
				session and a weekly cycle; top-up credit packs never expire.
			</p>
		</div>
	);
}

/** One paid AI plan as a selectable card — price-forward, grayscale, hairline borders. */
function TierCard({
	entry,
	isCurrent,
	comingSoon,
	selectable,
	primary,
	onChoose,
}: {
	entry: AiPlanCatalogEntry;
	isCurrent: boolean;
	comingSoon: boolean;
	selectable: boolean;
	/** Whether this card carries the view's single primary CTA (the recommended tier). */
	primary: boolean;
	onChoose: () => void;
}) {
	// "$20 / mo" → a prominent amount + a quiet cadence ("$20" + "/ mo").
	const [amount, cadence] = entry.priceLabel.split(" / ");
	return (
		<div
			className={cn(
				"rounded-lg border bg-surface p-5 transition-colors",
				entry.recommended ? "border-border-strong" : "border-border",
				selectable && "hover:border-border-strong",
			)}
		>
			<div className="flex items-start justify-between gap-3">
				<div className="flex min-w-0 flex-col gap-1">
					<div className="flex flex-wrap items-center gap-2">
						<span className="font-display text-ui-lg font-semibold text-text-primary">
							{entry.name}
						</span>
						{isCurrent && (
							<Badge variant="secondary" className="font-mono text-ui-3xs uppercase">
								Current
							</Badge>
						)}
						{!isCurrent && entry.recommended && !comingSoon && (
							<Badge variant="secondary" className="font-mono text-ui-3xs uppercase">
								Recommended
							</Badge>
						)}
						{comingSoon && (
							<Badge variant="outline" className="font-mono text-ui-3xs uppercase">
								Coming soon
							</Badge>
						)}
					</div>
					<span className="text-ui-sm leading-snug text-text-secondary">
						{entry.tagline}
					</span>
				</div>
				<div className="flex shrink-0 items-baseline gap-1">
					<span className="font-display text-ui-xl font-semibold tracking-tight text-text-primary">
						{amount}
					</span>
					{cadence && (
						<span className="font-mono text-ui-xs text-text-tertiary">/ {cadence}</span>
					)}
				</div>
			</div>

			<ul className="mt-4 space-y-2 border-t border-border pt-4">
				{entry.highlights.map((h) => (
					<li key={h} className="flex gap-2 text-ui-sm text-text-secondary">
						<Check size={13} className="mt-0.5 shrink-0 text-text-tertiary" />
						{h}
					</li>
				))}
			</ul>

			<Button
				type="button"
				size="sm"
				variant={selectable && primary ? "default" : "outline"}
				className="mt-4 w-full"
				disabled={!selectable}
				onClick={onChoose}
			>
				{isCurrent
					? "Your current plan"
					: comingSoon
						? "Coming soon"
						: `Upgrade to ${entry.name}`}
			</Button>
		</div>
	);
}

/** The pay step — the shared checkout for the chosen AI tier (no seat/invite step). */
function PayView({
	meta,
	currency,
	clientSecret,
	error,
	ownerEmail,
	onCurrencyChange,
	onBack,
	onClose,
	onPaid,
}: {
	meta: AiPlanCatalogEntry | null;
	currency: SupportedCurrency;
	clientSecret: string | null;
	error: string | null;
	ownerEmail: string;
	onCurrencyChange: (currency: SupportedCurrency) => void;
	onBack: () => void;
	onClose: () => void;
	onPaid: (billing: CollectedBilling) => void | Promise<void>;
}) {
	if (!meta) return null;
	if (error) {
		return (
			<div className="space-y-3">
				<p className="rounded-lg border border-border bg-surface-sunken px-4 py-3 text-ui-sm text-text-secondary">
					{error}
				</p>
				<Button variant="outline" className="w-full" onClick={onClose}>
					Close
				</Button>
			</div>
		);
	}
	return (
		<div className="flex min-h-0 flex-1 flex-col gap-3">
			<div className="flex items-center justify-between">
				<button
					type="button"
					onClick={onBack}
					className="text-ui-sm text-text-secondary transition-colors hover:text-text-primary"
				>
					← Change plan
				</button>
				<CurrencyToggle
					value={currency}
					onChange={onCurrencyChange}
					disabled={!clientSecret}
				/>
			</div>
			{clientSecret ? (
				<StripeElementsProvider clientSecret={clientSecret}>
					<BillingCheckoutForm
						clientSecret={clientSecret}
						meta={meta}
						currency={currency}
						ownerEmail={ownerEmail}
						showMembers={false}
						submitLabel={`Subscribe to ${meta.name}`}
						scrollable
						onPaid={onPaid}
					/>
				</StripeElementsProvider>
			) : (
				<div className="space-y-3">
					<Skeleton className="h-10 w-full" />
					<Skeleton className="h-24 w-full" />
				</div>
			)}
		</div>
	);
}
