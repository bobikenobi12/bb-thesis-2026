"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Create a paid Pro organization — a two-column purchase modal:
//   • LEFT (persistent): the "What's included" checklist (PlanChecklist).
//   • RIGHT (progressive): State 1 = team name → State 2 = the shared BillingCheckoutForm
//     (split-card payment). Then a third "invite" view after the org exists.
// The org is created ONLY after the card is confirmed (deferred create:
// createNewOrgSubscriptionIntent → confirmCardPayment → linkSubscriptionToNewOrg), so a
// Stripe failure can never orphan an org. If the account still holds its one trial, a
// card-less "Start trial" path creates a solo trial org instead (trials can't invite).
// The two-column shell, invite view, and small form primitives are shared with the
// upgrade-org sheet via ./org-purchase-ui.

import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowRight } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { type UseFormReturn, useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import {
	attachTaxIdToCustomer,
	createNewOrgSubscriptionIntent,
	getProOffer,
	isOrgSlugAvailable,
	linkSubscriptionToNewOrg,
	type ProOffer,
	setCustomerBillingAddress,
	startProTrial,
} from "@/app/server/actions/billing";
import { updateOrgPrimaryAddress } from "@/app/server/actions/org-settings";
import { setActiveOrganization } from "@/app/server/actions/workspace";
import {
	billingAddressFrom,
	BillingCheckoutForm,
	type CollectedBilling,
} from "@/components/billing/billing-checkout-form";
import {
	Field,
	InviteView,
	isValidInviteEmail,
	PurchaseLayout,
	type Role,
	type SentInvite,
} from "@/components/org/org-purchase-ui";
import { StripeElementsProvider } from "@/components/billing/stripe-elements";
import { CurrencyToggle } from "@/components/billing/currency-toggle";
import { authClient } from "@/lib/auth/client";
import { track } from "@/lib/analytics/track";
import { useLivePlanPrice } from "@/lib/billing/use-live-plan-price";
import { orgHost } from "@/lib/org-url";
import { slugifyOrEmpty } from "@/lib/utils/slugify";
import { useWorkspaceStore } from "@/lib/stores/use-workspace-store";
import { type SupportedCurrency, planMeta } from "@repo/plan-catalog";
import { Button } from "@repo/ui/button";
import { Input } from "@repo/ui/input";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetTitle,
} from "@repo/ui/sheet";

const schema = z.object({
	name: z.string().trim().min(2, "Give your team a name."),
	slug: z
		.string()
		.trim()
		.min(1, "Pick a slug.")
		.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Lowercase letters, numbers and hyphens."),
});
type FormData = z.infer<typeof schema>;

type View = "name" | "pay" | "invite";

interface CreateOrgSheetProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

export function CreateOrgSheet({ open, onOpenChange }: CreateOrgSheetProps) {
	const router = useRouter();
	const fetchWorkspace = useWorkspaceStore((s) => s.fetchWorkspace);
	const { data: session } = authClient.useSession();
	const ownerEmail = session?.user?.email ?? "";

	const form = useForm<FormData>({
		resolver: zodResolver(schema),
		defaultValues: { name: "", slug: "" },
		mode: "onChange",
	});
	const name = form.watch("name");
	const slug = form.watch("slug");

	const [slugTouched, setSlugTouched] = useState(false);
	const [showUrl, setShowUrl] = useState(false);
	const [view, setView] = useState<View>("name");
	const [offer, setOffer] = useState<ProOffer | null>(null);
	const [busy, setBusy] = useState(false);

	// Deferred-create payment refs (carried across a Back→retry so neither the customer
	// nor the incomplete subscription duplicates in Stripe).
	const [clientSecret, setClientSecret] = useState<string | null>(null);
	const [customerId, setCustomerId] = useState<string | null>(null);
	const [subscriptionId, setSubscriptionId] = useState<string | null>(null);
	// Billing currency of the open intent (Stripe locks it) + the validated org name, so the
	// currency toggle can re-create the intent for the same org.
	const [currency, setCurrency] = useState<SupportedCurrency>("usd");
	const [switchingCurrency, setSwitchingCurrency] = useState(false);
	const [checkoutOrgName, setCheckoutOrgName] = useState("");
	const [createdOrgId, setCreatedOrgId] = useState<string | null>(null);
	const [createdSlug, setCreatedSlug] = useState("");
	// Payment succeeded but the org create / link then failed — offer a retry (no second
	// charge) rather than the payment form. `lastBilling` lets the retry re-run setup.
	const [needsSetupRetry, setNeedsSetupRetry] = useState(false);
	const [lastBilling, setLastBilling] = useState<CollectedBilling | null>(null);

	// Invite step.
	const [isTrialOrg, setIsTrialOrg] = useState(false);
	const [inviteEmail, setInviteEmail] = useState("");
	const [inviteRole, setInviteRole] = useState<Role>("operator");
	const [sent, setSent] = useState<SentInvite[]>([]);

	const meta = planMeta("team");
	const teamPrice = useLivePlanPrice("team", currency);
	const trialAvailable = offer?.kind === "trial";

	// Resolve the account's Pro offer (trial vs pay) when the sheet opens.
	useEffect(() => {
		if (!open) return;
		let active = true;
		getProOffer()
			.then((o) => active && setOffer(o))
			.catch(() => active && setOffer({ kind: "none" }));
		return () => {
			active = false;
		};
	}, [open]);

	function reset() {
		form.reset({ name: "", slug: "" });
		setSlugTouched(false);
		setShowUrl(false);
		setView("name");
		setBusy(false);
		setClientSecret(null);
		setCustomerId(null);
		setSubscriptionId(null);
		setCreatedOrgId(null);
		setCreatedSlug("");
		setNeedsSetupRetry(false);
		setLastBilling(null);
		setIsTrialOrg(false);
		setInviteEmail("");
		setInviteRole("operator");
		setSent([]);
	}

	function handleOpenChange(next: boolean) {
		if (!next) reset();
		onOpenChange(next);
	}

	/** Close the sheet and drop the user into their new organization. */
	function goToOrg() {
		fetchWorkspace();
		handleOpenChange(false);
		if (createdSlug) router.push(`/${createdSlug}`);
		else router.refresh();
	}

	/** Validate the form + slug availability before any Stripe / org work. */
	async function validate(): Promise<FormData | null> {
		if (!(await form.trigger())) return null;
		const data = form.getValues();
		if (!(await isOrgSlugAvailable(data.slug))) {
			form.setError("slug", { message: "That slug is taken — try another." });
			return null;
		}
		return data;
	}

	/**
	 * Creates the org (with the chosen slug) and scopes the session to it. Returns the
	 * id + persisted slug, or null when the slug collided (error surfaced inline).
	 */
	async function createOrg(
		data: FormData,
	): Promise<{ id: string; slug: string } | null> {
		const { data: org, error } = await authClient.organization.create({
			name: data.name,
			slug: data.slug,
		});
		if (error || !org) {
			if (/slug|unique|exist|taken/i.test(error?.message ?? "")) {
				form.setError("slug", { message: "That slug is taken — try another." });
				return null;
			}
			throw new Error(error?.message ?? "Couldn't create the organization");
		}
		setCreatedOrgId(org.id);
		const persisted = org.slug ?? data.slug;
		setCreatedSlug(persisted);
		await setActiveOrganization(org.id);
		return { id: org.id, slug: persisted };
	}

	/**
	 * Step 1 → step 2. Trial-eligible accounts go straight to the card-less trial panel
	 * (no Stripe intent); everyone else opens a subscription intent and gets the payment
	 * form. Validation (name + slug availability) runs before either branch.
	 */
	async function continueToCheckout() {
		if (busy) return;
		setBusy(true);
		try {
			const data = await validate();
			if (!data) return;
			if (trialAvailable) {
				// Card-less trial — the trial panel confirms; no payment intent needed.
				setView("pay");
				return;
			}
			const intent = await createNewOrgSubscriptionIntent("team", {
				orgName: data.name,
				priorSubscriptionId: subscriptionId ?? undefined,
				customerId: customerId ?? undefined,
			});
			setSubscriptionId(intent.subscriptionId);
			setCustomerId(intent.customerId);
			setClientSecret(intent.clientSecret);
			setCurrency(intent.currency);
			setCheckoutOrgName(data.name);
			setView("pay");
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Something went wrong");
		} finally {
			setBusy(false);
		}
	}

	/** Switch the checkout currency by re-creating the intent for the same org (Stripe locks
	 *  a sub's currency). Reuses the customer + cancels the prior incomplete sub. */
	async function changeCurrency(next: SupportedCurrency) {
		if (next === currency || switchingCurrency || !checkoutOrgName) return;
		setSwitchingCurrency(true);
		try {
			const intent = await createNewOrgSubscriptionIntent("team", {
				orgName: checkoutOrgName,
				priorSubscriptionId: subscriptionId ?? undefined,
				customerId: customerId ?? undefined,
				currency: next,
			});
			setSubscriptionId(intent.subscriptionId);
			setCustomerId(intent.customerId);
			setClientSecret(intent.clientSecret);
			setCurrency(intent.currency);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Couldn't switch currency.");
		} finally {
			setSwitchingCurrency(false);
		}
	}

	/** Trial path: create the org now (card-less) and burn the account's one trial. If the
	 *  trial fails AFTER the org was created, roll the org back so we never leave an orphan
	 *  (no billing) behind. */
	async function startTrial() {
		if (busy) return;
		setBusy(true);
		try {
			const data = await validate();
			if (!data) return;
			const org = await createOrg(data);
			if (!org) return;
			try {
				// The org just created, NOT the ambient one — this sheet is open on a page inside the
				// CURRENT org, so ambient would burn the account's one trial on the wrong org and then
				// delete the new org in the catch below.
				await startProTrial({ orgId: org.id });
				track("trial_started", { plan: "team", context: "create_org" });
			} catch (trialErr) {
				// Roll back the just-created org — a failed trial must not orphan it.
				await authClient.organization
					.delete({ organizationId: org.id })
					.catch(() => {});
				setCreatedOrgId(null);
				setCreatedSlug("");
				throw trialErr;
			}
			await fetchWorkspace();
			setIsTrialOrg(true);
			toast.success("Trial started — your organization is ready.");
			setView("invite");
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Couldn't start the trial");
		} finally {
			setBusy(false);
		}
	}

	/**
	 * Card confirmed — persist billing details on the standalone customer, create + link
	 * the org so its entitlement is live immediately, then move to invite. Idempotent on
	 * retry via createdOrgId: if a step fails after the charge we keep the refs + offer a
	 * retry instead of re-charging. Address / tax / primary-address saves are best-effort.
	 */
	async function handlePaid(billing: CollectedBilling) {
		setBusy(true);
		setNeedsSetupRetry(false);
		setLastBilling(billing);
		try {
			if (!subscriptionId || !customerId) {
				throw new Error("Missing payment reference — please retry.");
			}
			try {
				await setCustomerBillingAddress({
					customerId,
					address: billingAddressFrom(billing),
				});
			} catch {
				// Non-fatal — Stripe still has the address from the payment method.
			}
			if (billing.taxValue.trim()) {
				try {
					await attachTaxIdToCustomer({
						customerId,
						type: billing.taxType,
						value: billing.taxValue,
					});
				} catch {
					toast.warning("Couldn't save the tax id — add it later in billing.");
				}
			}

			let orgId = createdOrgId;
			if (!orgId) {
				const org = await createOrg(form.getValues());
				if (!org) return;
				orgId = org.id;
			}
			await linkSubscriptionToNewOrg({ orgId, subscriptionId, customerId });
			await fetchWorkspace();
			if (billing.useAsPrimary) {
				try {
					// The org just created — ambient here is the page's org, and this `catch` is why
					// overwriting it was silent.
					await updateOrgPrimaryAddress(billingAddressFrom(billing), orgId);
				} catch {
					// Non-fatal — billing address is still set on the customer.
				}
			}
			setIsTrialOrg(false);
			toast.success("Subscription active — your organization is ready.");
			setView("invite");
		} catch (e) {
			setNeedsSetupRetry(true);
			toast.error(
				e instanceof Error
					? e.message
					: "Payment succeeded but setup failed — retry, you won't be charged again.",
			);
		} finally {
			setBusy(false);
		}
	}

	/** Send one invite into the created (paid) org. Trials are solo (see beforeCreate). */
	async function addInvite() {
		const email = inviteEmail.trim();
		if (!isValidInviteEmail(email)) {
			toast.error("Enter a valid email to invite.");
			return;
		}
		try {
			await authClient.organization.inviteMember({ email, role: inviteRole });
			setSent((p) => [...p, { email, role: inviteRole }]);
			setInviteEmail("");
			toast.success(`Invitation sent to ${email}`);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Couldn't send the invite");
		}
	}

	const heading = view === "pay" ? `Create ${name || "team"}` : "Create a team";

	return (
		<Sheet open={open} onOpenChange={handleOpenChange}>
			<SheetContent
				side="right"
				showCloseButton={false}
				className="w-[92vw] gap-0 overflow-hidden p-0 sm:max-w-3xl"
			>
				<SheetTitle className="sr-only">Create a team</SheetTitle>
				<SheetDescription className="sr-only">
					Create a Pro team, pay, and invite your teammates.
				</SheetDescription>

				{(view === "name" || view === "pay") && (
					<PurchaseLayout
						meta={meta}
						heading={heading}
						onClose={() => handleOpenChange(false)}
					>
						{view === "name" ? (
							<NamePanel
								form={form}
								slug={slug}
								showUrl={showUrl}
								setShowUrl={setShowUrl}
								slugTouched={slugTouched}
								setSlugTouched={setSlugTouched}
								busy={busy}
								ready={offer !== null}
								onContinue={() => void continueToCheckout()}
							/>
						) : needsSetupRetry ? (
							<RetrySetup
								busy={busy}
								onRetry={() => lastBilling && void handlePaid(lastBilling)}
							/>
						) : trialAvailable ? (
							<TrialPanel
								busy={busy}
								priceLabel={teamPrice.label}
								trialDays={offer?.trialDays ?? 30}
								onBack={() => setView("name")}
								onStart={() => void startTrial()}
							/>
						) : (
							clientSecret && (
								<div className="flex min-h-0 flex-1 flex-col gap-4">
									<div className="flex shrink-0 items-center justify-between">
										<button
											type="button"
											onClick={() => {
												setView("name");
												setClientSecret(null);
											}}
											className="text-left text-ui-sm text-text-tertiary transition-colors hover:text-text-primary"
										>
											← Back
										</button>
										<CurrencyToggle
											value={currency}
											onChange={changeCurrency}
											disabled={switchingCurrency}
										/>
									</div>
									<StripeElementsProvider clientSecret={clientSecret}>
										<BillingCheckoutForm
											clientSecret={clientSecret}
											meta={meta}
											unitAmount={teamPrice.unitAmount}
											currency={currency}
											ownerEmail={ownerEmail}
											submitLabel="Create"
											scrollable
											onPaid={(b) => handlePaid(b)}
										/>
									</StripeElementsProvider>
								</div>
							)
						)}
					</PurchaseLayout>
				)}

				{view === "invite" && (
					<InviteView
						isTrialOrg={isTrialOrg}
						ownerEmail={ownerEmail}
						inviteEmail={inviteEmail}
						setInviteEmail={setInviteEmail}
						inviteRole={inviteRole}
						setInviteRole={setInviteRole}
						sent={sent}
						onAdd={() => void addInvite()}
						onFinish={goToOrg}
						onAddPayment={() => {
							handleOpenChange(false);
							router.push(
								createdSlug ? `/${createdSlug}/settings/billing` : "/dashboard",
							);
						}}
					/>
				)}
			</SheetContent>
		</Sheet>
	);
}

// ── Create-specific views ──────────────────────────────────────────────────────

/** State 1 — team name (auto-slug) + a single Continue. Trial-vs-pay is decided in step 2. */
function NamePanel({
	form,
	slug,
	showUrl,
	setShowUrl,
	slugTouched,
	setSlugTouched,
	busy,
	ready,
	onContinue,
}: {
	form: UseFormReturn<FormData>;
	slug: string;
	showUrl: boolean;
	setShowUrl: (v: boolean) => void;
	slugTouched: boolean;
	setSlugTouched: (v: boolean) => void;
	busy: boolean;
	/** False until the Pro offer (trial vs pay) has resolved, so step 2 routes correctly. */
	ready: boolean;
	onContinue: () => void;
}) {
	return (
		<form
			onSubmit={(e) => {
				e.preventDefault();
				onContinue();
			}}
			className="flex flex-col gap-4"
		>
			<Field label="Team name" required error={form.formState.errors.name?.message}>
				<Input
					placeholder="Acme Cloud"
					autoComplete="off"
					autoFocus
					{...form.register("name")}
					onChange={(e) => {
						const v = e.target.value;
						form.setValue("name", v, { shouldValidate: true });
						if (!slugTouched)
							form.setValue("slug", slugifyOrEmpty(v), { shouldValidate: true });
					}}
				/>
				<div className="flex items-center justify-between pt-1">
					<span className="font-mono text-ui-xs text-text-tertiary">
						{orgHost()}/<span className="text-text-secondary">{slug || "org"}</span>
					</span>
					<button
						type="button"
						onClick={() => setShowUrl(!showUrl)}
						className="font-mono text-ui-xs text-text-tertiary transition-colors hover:text-text-primary"
					>
						{showUrl ? "Done" : "Customize URL"}
					</button>
				</div>
				{showUrl && (
					<div className="flex h-9 items-center overflow-hidden rounded-sm border border-input bg-transparent focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50">
						<span className="whitespace-nowrap pl-3 pr-0.5 font-mono text-ui-sm text-text-tertiary">
							{orgHost()}/
						</span>
						<input
							className="h-full min-w-0 flex-1 border-0 bg-transparent pl-0.5 pr-3 font-mono text-ui-sm text-text-primary outline-none"
							placeholder="acme-cloud"
							autoComplete="off"
							value={slug}
							onChange={(e) => {
								setSlugTouched(true);
								form.setValue("slug", slugifyOrEmpty(e.target.value), {
									shouldValidate: true,
								});
							}}
						/>
					</div>
				)}
				{form.formState.errors.slug?.message && (
					<p className="text-ui-xs text-destructive">
						{form.formState.errors.slug.message}
					</p>
				)}
			</Field>

			<Button type="submit" disabled={busy || !ready} className="w-full">
				{busy ? "Setting up…" : "Continue"}
				<ArrowRight size={15} />
			</Button>
		</form>
	);
}

/**
 * Step 2 (trial-eligible) — a card-less 30-day trial. Shows $0 due now / price after, and
 * a single "Start free trial" CTA. No payment form: a free trial has no reason to decline.
 */
function TrialPanel({
	busy,
	priceLabel,
	trialDays,
	onBack,
	onStart,
}: {
	busy: boolean;
	/** Live Stripe price label shown for "after the trial". */
	priceLabel: string;
	trialDays: number;
	onBack: () => void;
	onStart: () => void;
}) {
	return (
		<div className="space-y-4">
			<button
				type="button"
				onClick={onBack}
				className="text-ui-sm text-text-tertiary transition-colors hover:text-text-primary"
			>
				← Back
			</button>

			<div className="rounded-lg border border-border">
				<div className="flex items-center justify-between border-b border-border px-4 py-3">
					<span className="text-ui-md font-medium text-text-primary">Due today</span>
					<span className="font-display text-ui-xl font-semibold text-text-primary">
						$0
					</span>
				</div>
				<div className="flex items-center justify-between px-4 py-3 text-ui-sm text-text-secondary">
					<span>After your {trialDays}-day free trial</span>
					<span className="font-mono text-ui-sm text-text-primary">
						{priceLabel}
					</span>
				</div>
			</div>

			<Button type="button" className="w-full" disabled={busy} onClick={onStart}>
				{busy ? "Setting up…" : `Start ${trialDays}-day free trial`}
				<ArrowRight size={15} />
			</Button>
			<p className="text-center font-mono text-ui-2xs text-text-tertiary">
				No charge during the trial · cancel anytime
			</p>
		</div>
	);
}

/** Paid, but org create/link failed after the charge — finish setup, no re-charge. */
function RetrySetup({ busy, onRetry }: { busy: boolean; onRetry: () => void }) {
	return (
		<div className="space-y-3">
			<p className="rounded-lg border border-border bg-surface-sunken px-4 py-3 text-ui-sm text-text-secondary">
				Your payment went through, but we couldn&apos;t finish setting up the team. You
				won&apos;t be charged again — retry to complete setup.
			</p>
			<Button className="w-full" disabled={busy} onClick={onRetry}>
				{busy ? "Finishing…" : "Complete setup"}
				<ArrowRight size={15} />
			</Button>
		</div>
	);
}
