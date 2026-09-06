"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Post-signup onboarding (/onboarding): a deliberately minimal, Vercel-style surface —
// pick a plan + name the organization, everything else optional. No stepper, no boxed
// card, no invites, no Enterprise. Pro starts a card-less 30-day trial. Operates on the
// auto-provisioned primary organization, configuring it in place; on submit it drops the
// user into the in-product "Get started" first-run at /{slug}.

import { ArrowRight, Building2, Check, User } from "lucide-react";
import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import {
	createSubscriptionIntent,
	type ProOffer,
	saveTaxId,
	startProTrial,
	updateBillingAddress,
} from "@/app/server/actions/billing";
import {
	configureOnboardingOrg,
	markOnboardingComplete,
} from "@/app/server/actions/onboarding";
import { updateOrgPrimaryAddress } from "@/app/server/actions/org-settings";
import { setActiveOrganization } from "@/app/server/actions/workspace";
import { track } from "@/lib/analytics/track";
import {
	billingAddressFrom,
	BillingCheckoutForm,
	type CollectedBilling,
} from "@/components/billing/billing-checkout-form";
import { OrgLogoUpload } from "@/components/org/org-logo-upload";
import { StripeElementsProvider } from "@/components/billing/stripe-elements";
import { CurrencyToggle } from "@/components/billing/currency-toggle";
import { safeNext } from "@/lib/auth/safe-next";
import type { PrimaryOrg } from "@/lib/auth/onboarding";
import { orgHost } from "@/lib/org-url";
import { slugifyOrEmpty } from "@/lib/utils/slugify";
import { type SupportedCurrency, planMeta } from "@repo/plan-catalog";
import { useLivePlanPrice } from "@/lib/billing/use-live-plan-price";
import { Button } from "@repo/ui/button";
import { Input } from "@repo/ui/input";
import { cn } from "@repo/ui/utils";

/** The two self-serve plans offered at creation (Enterprise is contact-sales, elsewhere). */
type PlanChoice = "community" | "team";

interface OnboardingFormProps {
	org: PrimaryOrg;
	/** The account's Pro offer (one-time trial vs none) — gates the trial CTA. */
	offer: ProOffer;
	/** Whether hosted billing (Stripe) is configured — gates the Pro tile / paid path. */
	proAvailable: boolean;
}

/**
 * The /onboarding form. Renders inside AuthShell (grid + topbar + footer) but without
 * the boxed card — an open, hairline-sectioned composition.
 */
export function OnboardingForm({ org, offer, proAvailable }: OnboardingFormProps) {
	const router = useRouter();
	const searchParams = useSearchParams();
	const next = safeNext(searchParams.get("next") ?? undefined);

	// Pro starts a card-less trial while the account still holds its one account-wide
	// trial; once that's used, Pro is reached by paying (the shared checkout form).
	const trialAvailable = offer.kind === "trial";
	const trialDays = offer.trialDays ?? 30;
	const meta = planMeta("team");
	const [currency, setCurrency] = useState<SupportedCurrency>("usd");
	const [switchingCurrency, setSwitchingCurrency] = useState(false);
	const teamPrice = useLivePlanPrice("team", currency);

	const [plan, setPlan] = useState<PlanChoice>("community");
	const [name, setName] = useState(org.name);
	const [slug, setSlug] = useState(org.slug);
	const [slugTouched, setSlugTouched] = useState(false);
	const [showUrl, setShowUrl] = useState(false);
	const [logo, setLogo] = useState<string | null>(org.logo);
	const [slugError, setSlugError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	// Paid Pro at onboarding (trial already used): reveal the shared checkout form.
	const [clientSecret, setClientSecret] = useState<string | null>(null);

	// Scope the session to the primary org so the logo upload + trial/pay act on it.
	useEffect(() => {
		void setActiveOrganization(org.id);
	}, [org.id]);

	const nameValid = name.trim().length >= 2;

	async function submit() {
		if (!nameValid || busy) return;
		setBusy(true);
		setSlugError(null);
		try {
			const res = await configureOnboardingOrg({ name, slug });
			setSlug(res.slug);
			track("org_created", { plan });
			if (plan === "community") {
				await markOnboardingComplete();
				router.push(next ?? `/${res.slug}`);
				return;
			}
			// Pro with the trial still available → card-less trial.
			if (trialAvailable) {
				await startProTrial();
				track("trial_started", { plan: "team" });
				await markOnboardingComplete();
				router.push(next ?? `/${res.slug}`);
				return;
			}
			// Pro, trial used → reveal the shared checkout form (primary org already exists).
			track("upgrade_started", { plan: "team", context: "onboarding" });
			const intent = await createSubscriptionIntent("team");
			if ("error" in intent) {
				toast.error(intent.error);
				setBusy(false);
				return;
			}
			setClientSecret(intent.clientSecret);
			setCurrency(intent.currency);
			setBusy(false);
		} catch (e) {
			const msg = e instanceof Error ? e.message : "Couldn't create the organization";
			if (/slug|name|reserved|taken/i.test(msg)) setSlugError(msg);
			else toast.error(msg);
			setBusy(false);
		}
	}

	/** Pro paid at onboarding — persist billing on the org, finish, drop into the app. */
	async function onProPaid(billing: CollectedBilling) {
		try {
			await updateBillingAddress(billingAddressFrom(billing)).catch(() => {});
			if (billing.taxValue.trim()) {
				await saveTaxId(billing.taxType, billing.taxValue).catch(() => {});
			}
			if (billing.useAsPrimary) {
				await updateOrgPrimaryAddress(billingAddressFrom(billing)).catch(() => {});
			}
		} finally {
			await markOnboardingComplete();
			router.push(next ?? `/${slug}`);
		}
	}

	// Switch the checkout currency by re-creating the intent (Stripe locks a sub's currency).
	// Keep the current Elements mounted until the new secret arrives — no flash back to the
	// plan chooser.
	async function changeCurrency(next: SupportedCurrency) {
		if (next === currency || switchingCurrency) return;
		setSwitchingCurrency(true);
		try {
			const intent = await createSubscriptionIntent("team", { currency: next });
			if ("error" in intent) {
				toast.error(intent.error);
				return;
			}
			setClientSecret(intent.clientSecret);
			setCurrency(intent.currency);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Couldn't switch currency.");
		} finally {
			setSwitchingCurrency(false);
		}
	}

	// Paid Pro checkout (trial used) — the shared billing form, same as the sheet.
	if (clientSecret) {
		return (
			<div className="mx-auto w-full max-w-[460px]">
				<div className="mb-6 flex flex-col gap-1.5">
					<p className="vx-eyebrow">{meta.name}</p>
					<h1 className="font-grotesk text-display-xs font-semibold tracking-[-0.03em] text-text-primary">
						Subscribe to {meta.name}
					</h1>
					<p className="text-ui-md text-text-secondary">
						Unlock collaboration and improved performance.
					</p>
				</div>
				<div className="mb-4 flex items-center justify-between">
					<span className="text-ui-sm text-text-secondary">Billing currency</span>
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
						submitLabel="Subscribe"
						onPaid={onProPaid}
					/>
				</StripeElementsProvider>
				<button
					type="button"
					onClick={() => setClientSecret(null)}
					className="mt-4 w-full text-center font-mono text-ui-xs text-text-tertiary transition-colors hover:text-text-primary"
				>
					← Back
				</button>
			</div>
		);
	}

	return (
		<div className="mx-auto w-full max-w-[560px]">
			<div className="mb-8 flex flex-col gap-2.5">
				<p className="vx-eyebrow">Get started</p>
				<h1 className="font-grotesk text-display-sm font-semibold leading-[1.04] tracking-display text-text-primary">
					Create your organization
				</h1>
				<p className="text-ui-lg leading-[1.55] text-text-secondary">
					An organization holds your Projects and team. Pick how you’ll use
					Alethia — you can change this anytime.
				</p>
			</div>

			{/* Plan choice */}
			<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
				<PlanTile
					selected={plan === "community"}
					onSelect={() => {
						setPlan("community");
						track("onboarding_plan_selected", { plan: "community" });
					}}
					icon={<User className="size-4" />}
					useCase="Personal projects"
					planName="Hobby"
					price="Free"
					blurb="Your own Projects — just you."
				/>
				<PlanTile
					selected={plan === "team"}
					onSelect={() => {
						if (!proAvailable) return;
						setPlan("team");
						track("onboarding_plan_selected", { plan: "team" });
					}}
					disabled={!proAvailable}
					icon={<Building2 className="size-4" />}
					useCase="Commercial projects"
					planName="Pro"
					price={
						proAvailable
							? trialAvailable
								? `${trialDays}-day trial`
								: teamPrice.label
							: "Unavailable"
					}
					blurb={
						proAvailable
							? trialAvailable
								? "Organizations & teams. No card to start."
								: "Organizations & teams. Pay as you grow."
							: "Hosted billing isn’t configured on this deployment."
					}
				/>
			</div>

			<div className="my-7 h-px bg-border" />

			{/* Identity */}
			<div className="flex flex-col gap-2.5">
				<label
					htmlFor="org-name"
					className="font-mono text-ui-2xs uppercase tracking-[0.14em] text-text-tertiary"
				>
					Organization name
				</label>
				<Input
					id="org-name"
					value={name}
					autoComplete="off"
					placeholder="Acme Cloud"
					className="h-[46px] border-border-strong bg-surface-sunken text-ui-lg"
					onChange={(e) => {
						const v = e.target.value;
						setName(v);
						if (!slugTouched) setSlug(slugifyOrEmpty(v));
						setSlugError(null);
					}}
					onKeyDown={(e) => {
						if (e.key === "Enter") void submit();
					}}
				/>
				<div className="flex items-center justify-between">
					<span className="font-mono text-ui-sm text-text-tertiary">
						{orgHost()}/
						<span className="text-text-secondary">{slug || "org"}</span>
					</span>
					<button
						type="button"
						onClick={() => setShowUrl((v) => !v)}
						className="font-mono text-ui-xs text-text-tertiary transition-colors hover:text-text-primary"
					>
						{showUrl ? "Done" : "Customize URL"}
					</button>
				</div>
				{showUrl && (
					<div className="flex h-[40px] items-center overflow-hidden border border-border-strong bg-surface-sunken">
						<span className="whitespace-nowrap pl-3 pr-0.5 font-mono text-ui-sm text-text-tertiary">
							{orgHost()}/
						</span>
						<input
							className="h-full min-w-0 flex-1 border-0 bg-transparent pl-0.5 pr-3 font-mono text-ui-sm text-text-primary outline-none"
							value={slug}
							autoComplete="off"
							onChange={(e) => {
								setSlugTouched(true);
								setSlug(slugifyOrEmpty(e.target.value));
								setSlugError(null);
							}}
						/>
					</div>
				)}
				{slugError && <p className="text-ui-xs text-destructive">{slugError}</p>}
			</div>

			{/* Logo (optional) */}
			<div className="mt-6 flex flex-col gap-2.5">
				<span className="font-mono text-ui-2xs uppercase tracking-[0.14em] text-text-tertiary">
					Logo <span className="text-text-disabled">· optional</span>
				</span>
				<OrgLogoUpload name={name} logo={logo} onChange={setLogo} size={48} />
			</div>

			{/* CTA */}
			{/* `bg-ink text-ink-foreground hover:bg-ink-hover` IS Button's `default`
			    variant, restated by hand — so this control was overriding the variant
			    with a copy of itself and drifting from it for free. Only the size and
			    the group hook are local, the same shape auth-form's PrimaryButton uses. */}
			<Button
				type="button"
				disabled={!nameValid || busy}
				onClick={() => void submit()}
				className="group mt-8 h-[46px] w-full text-sm"
			>
				{busy
					? "Creating…"
					: plan === "team" && !trialAvailable
						? "Continue to payment"
						: "Create organization"}
				{!busy && (
					<ArrowRight className="size-4 transition-transform group-hover:translate-x-[3px]" />
				)}
			</Button>
			<p className="mt-3 text-center font-mono text-ui-2xs text-text-tertiary">
				{plan === "team"
					? trialAvailable
						? `${trialDays}-day Pro trial · no card required · cancel anytime`
						: `${teamPrice.label} · cancel anytime`
					: "Free forever · upgrade whenever you’re ready"}
			</p>
		</div>
	);
}

/** A selectable plan tile (use-case framed, Vercel-style). */
function PlanTile({
	selected,
	onSelect,
	disabled,
	icon,
	useCase,
	planName,
	price,
	blurb,
}: {
	selected: boolean;
	onSelect: () => void;
	disabled?: boolean;
	icon: React.ReactNode;
	useCase: string;
	planName: string;
	price: string;
	blurb: string;
}) {
	return (
		<button
			type="button"
			onClick={onSelect}
			disabled={disabled}
			aria-pressed={selected}
			className={cn(
				"relative flex flex-col gap-2 rounded-lg border p-4 text-left transition-colors",
				disabled
					? "cursor-not-allowed border-border opacity-55"
					: selected
						? "border-text-primary bg-surface-muted ring-1 ring-text-primary"
						: "border-border hover:border-border-strong hover:bg-surface-muted",
			)}
		>
			<div className="flex items-center justify-between">
				<span className="flex size-7 items-center justify-center rounded-md border border-border-strong text-text-secondary">
					{icon}
				</span>
				<span
					className={cn(
						"flex size-[18px] items-center justify-center rounded-full border",
						selected
							? "border-ink bg-ink text-ink-foreground"
							: "border-border-strong text-transparent",
					)}
				>
					<Check size={11} strokeWidth={3} />
				</span>
			</div>
			<div className="mt-1">
				<div className="text-ui-lg font-medium text-text-primary">{useCase}</div>
				<div className="mt-0.5 flex items-baseline gap-1.5">
					<span className="font-grotesk text-ui-md font-semibold text-text-secondary">
						{planName}
					</span>
					<span className="font-mono text-ui-2xs text-text-tertiary">· {price}</span>
				</div>
			</div>
			<p className="text-ui-xs leading-snug text-text-tertiary">{blurb}</p>
		</button>
	);
}
