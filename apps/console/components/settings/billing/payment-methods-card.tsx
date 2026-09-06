"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Native, in-app payment-methods management (replaces the Stripe Customer Portal deep-link).
// Card data never touches our code — adding a card confirms a Stripe SetupIntent inside the
// embedded Payment Element (PCI SAQ-A). A card can be made default, promoted to / demoted
// from ordered dunning backups (and reordered), and removed — all via inline row actions.
// Data loads with useEffect/useState (this area does not use TanStack Query — matches
// billing-panel.tsx).

import { ChevronDown, ChevronUp, Plus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
	createSetupIntent,
	detachPaymentMethod,
	listPaymentMethods,
	type PaymentMethodInfo,
	setBackupCards,
	setDefaultPaymentMethod,
} from "@/app/server/actions/billing";
import { PaymentForm } from "@/components/billing/payment-form";
import { StripeElementsProvider } from "@/components/billing/stripe-elements";
import {
	SettingsPanel,
	SettingsSection,
} from "@/components/settings/settings-ui";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@repo/ui/alert-dialog";
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

// `formatBrand` and `formatExpiry` deliberately stay local rather than moving to
// @repo/format: neither renders a QUANTITY. A card brand is a label to title-case, and a
// card expiry is the `MM/YYYY` convention printed on the card itself — not one of the
// package's date styles, which would turn "07/2027" into "July 2027".

/** Title-case a Stripe card brand (e.g. "visa" → "Visa", "amex" → "Amex"). */
function formatBrand(brand: string): string {
	if (!brand) return "Card";
	return brand.charAt(0).toUpperCase() + brand.slice(1);
}

/** Zero-padded `MM/YYYY` expiry label for a saved card. */
function formatExpiry(month: number, year: number): string {
	return `${String(month).padStart(2, "0")}/${year}`;
}

/** The ordered list of backup payment-method ids (ranked backups, in rank order). */
function backupIds(cards: PaymentMethodInfo[]): string[] {
	return cards.filter((c) => c.backupRank !== null).map((c) => c.id);
}

/** A compact, always-visible inline row action (replaces the old ⋯ dropdown). */
function RowAction({
	onClick,
	disabled,
	destructive,
	children,
}: {
	onClick: () => void;
	disabled?: boolean;
	destructive?: boolean;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			className={cn(
				"rounded-sm px-2 py-1 text-ui-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-40",
				destructive
					? "text-destructive hover:bg-destructive/10"
					: "text-text-secondary hover:bg-surface-sunken hover:text-text-primary",
			)}
		>
			{children}
		</button>
	);
}

export function PaymentMethodsCard() {
	const [cards, setCards] = useState<PaymentMethodInfo[] | null>(null);
	const [addOpen, setAddOpen] = useState(false);
	const [clientSecret, setClientSecret] = useState<string | null>(null);
	const [addingIntent, setAddingIntent] = useState(false);
	const [pendingId, setPendingId] = useState<string | null>(null);
	const [confirmRemove, setConfirmRemove] = useState<PaymentMethodInfo | null>(
		null,
	);

	/** Reload the saved cards from Stripe. */
	const refresh = useCallback(() => {
		listPaymentMethods()
			.then(setCards)
			.catch(() => {
				setCards([]);
				toast.error("Couldn't load saved cards.");
			});
	}, []);
	useEffect(() => {
		refresh();
	}, [refresh]);

	/** Open the add-card dialog after creating a SetupIntent for the embedded form. */
	async function openAddCard() {
		if (addingIntent) return;
		setAddingIntent(true);
		try {
			const { clientSecret: cs } = await createSetupIntent();
			setClientSecret(cs);
			setAddOpen(true);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Couldn't start adding a card.");
		} finally {
			setAddingIntent(false);
		}
	}

	/** Card saved in Stripe — close the dialog and refetch the list. */
	function handleCardAdded() {
		setAddOpen(false);
		setClientSecret(null);
		toast.success("Card saved.");
		refresh();
	}

	/** Run a per-card mutation with a busy marker + refetch, surfacing errors as toasts. */
	async function runCardAction(id: string, fn: () => Promise<unknown>) {
		setPendingId(id);
		try {
			await fn();
			refresh();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Something went wrong.");
		} finally {
			setPendingId(null);
		}
	}

	/** Make a card the default (primary) payment method. */
	function makeDefault(card: PaymentMethodInfo) {
		void runCardAction(card.id, () => setDefaultPaymentMethod(card.id));
	}

	/** Append a card to the end of the ordered backup list. */
	function makeBackup(card: PaymentMethodInfo) {
		if (!cards) return;
		const next = [...backupIds(cards).filter((id) => id !== card.id), card.id];
		void runCardAction(card.id, () => setBackupCards(next));
	}

	/** Drop a card from the ordered backup list. */
	function removeBackup(card: PaymentMethodInfo) {
		if (!cards) return;
		const next = backupIds(cards).filter((id) => id !== card.id);
		void runCardAction(card.id, () => setBackupCards(next));
	}

	/** Swap a backup card with its neighbour (dir −1 = up, +1 = down) and persist. */
	function moveBackup(card: PaymentMethodInfo, dir: -1 | 1) {
		if (!cards) return;
		const ids = backupIds(cards);
		const i = ids.indexOf(card.id);
		const j = i + dir;
		if (i < 0 || j < 0 || j >= ids.length) return;
		[ids[i], ids[j]] = [ids[j], ids[i]];
		void runCardAction(card.id, () => setBackupCards(ids));
	}

	/** Detach the confirmed card from the customer. */
	function removeCard(card: PaymentMethodInfo) {
		setConfirmRemove(null);
		void runCardAction(card.id, () => detachPaymentMethod(card.id));
	}

	const backupCount = cards ? backupIds(cards).length : 0;

	return (
		<>
			<SettingsSection
				title="Payment methods"
				action={
					<Button size="sm" onClick={() => void openAddCard()} disabled={addingIntent}>
						<Plus size={14} />
						{addingIntent ? "Loading…" : "Add payment method"}
					</Button>
				}
			>
				<SettingsPanel>
					{cards === null ? (
						<div className="space-y-3 p-5">
							<Skeleton className="h-10 w-full" />
							<Skeleton className="h-10 w-full" />
						</div>
					) : cards.length === 0 ? (
						<p className="px-[22px] py-6 text-ui-sm text-text-tertiary">
							No saved cards — add one to keep your subscription active.
						</p>
					) : (
						cards.map((card) => {
							const rank = card.backupRank;
							const isBackup = rank !== null;
							const busy = pendingId === card.id;
							return (
								<div
									key={card.id}
									className={cn(
										"flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border px-[22px] py-[14px] last:border-b-0",
										// The default card is visually distinct (subtle tint).
										card.isDefault && "bg-surface-sunken",
									)}
								>
									<div className="flex min-w-0 items-center gap-3">
										<span className="text-ui-md font-medium text-text-primary">
											{formatBrand(card.brand)}
										</span>
										<span className="font-mono text-ui-sm text-text-secondary">
											•••• {card.last4}
										</span>
										<span className="font-mono text-ui-xs text-text-tertiary">
											exp {formatExpiry(card.expMonth, card.expYear)}
										</span>
										{card.isDefault && (
											<Badge className="px-2 py-[2px] font-mono text-ui-3xs uppercase tracking-[0.1em]">
												Default
											</Badge>
										)}
										{isBackup && (
											<Badge
												variant="outline"
												className="border-border-strong px-2 py-[2px] font-mono text-ui-3xs uppercase tracking-[0.1em] text-text-secondary"
											>
												Backup {rank + 1}
											</Badge>
										)}
									</div>
									<div className="flex shrink-0 items-center gap-0.5">
										{isBackup && backupCount > 1 && (
											<>
												<Button
													variant="ghost"
													size="icon"
													className="size-7"
													aria-label="Move backup up"
													disabled={rank === 0 || busy}
													onClick={() => moveBackup(card, -1)}
												>
													<ChevronUp size={14} />
												</Button>
												<Button
													variant="ghost"
													size="icon"
													className="size-7"
													aria-label="Move backup down"
													disabled={rank === backupCount - 1 || busy}
													onClick={() => moveBackup(card, 1)}
												>
													<ChevronDown size={14} />
												</Button>
											</>
										)}
										{!card.isDefault && (
											<RowAction disabled={busy} onClick={() => makeDefault(card)}>
												Set default
											</RowAction>
										)}
										{!card.isDefault &&
											(isBackup ? (
												<RowAction disabled={busy} onClick={() => removeBackup(card)}>
													Remove backup
												</RowAction>
											) : (
												<RowAction disabled={busy} onClick={() => makeBackup(card)}>
													Make backup
												</RowAction>
											))}
										<RowAction
											destructive
											disabled={busy}
											onClick={() => setConfirmRemove(card)}
										>
											Remove
										</RowAction>
									</div>
								</div>
							);
						})
					)}
				</SettingsPanel>
			</SettingsSection>

			{/* Add-card dialog — confirms a SetupIntent (card data stays in Stripe's iframe). */}
			<Dialog
				open={addOpen}
				onOpenChange={(o) => {
					setAddOpen(o);
					if (!o) setClientSecret(null);
				}}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Add payment method</DialogTitle>
						<DialogDescription>
							Your card is stored securely by Stripe — we never see the number.
						</DialogDescription>
					</DialogHeader>
					{clientSecret && (
						<StripeElementsProvider clientSecret={clientSecret}>
							<PaymentForm
								mode="setup"
								submitLabel="Save card"
								onSuccess={handleCardAdded}
								onError={(m) => toast.error(m)}
							/>
						</StripeElementsProvider>
					)}
				</DialogContent>
			</Dialog>

			<AlertDialog
				open={confirmRemove !== null}
				onOpenChange={(o) => !o && setConfirmRemove(null)}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Remove this card?</AlertDialogTitle>
						<AlertDialogDescription>
							{confirmRemove
								? `${formatBrand(confirmRemove.brand)} •••• ${confirmRemove.last4} will be detached from your billing account. This can't be undone.`
								: ""}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							onClick={() => confirmRemove && removeCard(confirmRemove)}
						>
							Remove card
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}
