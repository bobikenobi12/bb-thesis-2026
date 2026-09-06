// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { redirect } from "next/navigation";
import { AuthCard, AuthShell } from "@/components/auth/auth-shell";
import { OnboardingForm } from "@/components/auth/onboarding-form";
import { getOwner } from "@/lib/auth/owner";
import { safeNext } from "@/lib/auth/safe-next";
import { ensurePrimaryOrg, isOnboardingComplete } from "@/lib/auth/onboarding";
import { getProOffer } from "@/app/server/actions/billing";
import { isStripeConfigured } from "@/lib/billing/config";

interface OnboardingPageProps {
	searchParams: Promise<{ next?: string }>;
}

/**
 * Post-signup onboarding: pick a plan + name the organization (everything else
 * optional). Gated — only brand-new accounts (onboarding not yet complete) see it;
 * everyone else is sent straight to the console. Operates on the user's
 * auto-provisioned primary organization, then drops into the in-product first-run.
 */
export default async function OnboardingPage({ searchParams }: OnboardingPageProps) {
	const userId = await getOwner();
	if (!userId) redirect("/login");

	const { next } = await searchParams;
	// `safeNext` rejects an off-origin target, but a same-origin one can still point at
	// THIS page — `/onboarding?next=/onboarding` would redirect to itself forever. A
	// self-target is not a destination, so fall back to the console.
	const requested = safeNext(next);
	const requestedPath = requested?.split("?")[0] ?? "";
	const isSelf =
		requestedPath === "/onboarding" || requestedPath.startsWith("/onboarding/");
	const destination = requested && !isSelf ? requested : "/dashboard";

	// Already onboarded → nothing to set up.
	if (await isOnboardingComplete(userId)) redirect(destination);

	// The primary org is provisioned at signup, but that provisioning is best-effort —
	// so repair it here instead of redirecting. Falling through to `destination` used to
	// look like the safe move; it was the bug. /dashboard sends a user with incomplete
	// onboarding straight back to this page, so "no org" bounced between the two forever
	// and the user never reached the app. If the repair cannot succeed, stop here with
	// something readable: a dead end the user can act on beats a loop they cannot leave.
	const org = await ensurePrimaryOrg(userId);
	if (!org) {
		return (
			<AuthShell>
				<AuthCard>
					<div className="flex flex-col gap-2.5">
						<p className="vx-eyebrow">Setup incomplete</p>
						<h1 className="font-grotesk text-display-sm font-semibold leading-[1.05] tracking-display text-text-primary">
							We couldn&apos;t finish setting up your account
						</h1>
					<p className="text-ui-lg leading-[1.55] text-text-secondary">
							Your sign-in worked, but we couldn&apos;t create your organization.
							This is on us, not you. Reload to try again — if it keeps happening,
							contact support and we&apos;ll fix it from our side.
						</p>
					</div>
				</AuthCard>
			</AuthShell>
		);
	}

	// The account's Pro offer (one-time trial vs none) gates the trial CTA; Stripe being
	// configured gates the paid Pro path.
	const offer = await getProOffer();

	return (
		<AuthShell cardWidth="fluid">
			<OnboardingForm org={org} offer={offer} proAvailable={isStripeConfigured()} />
		</AuthShell>
	);
}
