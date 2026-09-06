"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Alerts hub (dataroom/spec/mvp/25): a single page with the three surfaces stacked
// vertically — Policies, Channels, Activity. No KPIs or tabs; navigation is the secondary
// "Alerts" sidebar (components/shell/sidebar-drill.tsx), whose items anchor-scroll to these
// sections and highlight via the shared use-alerts-section store. Each section opens with
// the shared `SectionHeading` (icon + title + description + a Docs link), carrying the filtered
// result count in its count pill — where the console filter standard requires counts to be.
// The whole surface is gated behind the `alerting` entitlement (Pro+); below that we show
// the upsell.
//
// This page also OWNS the filter pipeline for all three panels (alerts-filters.ts): the
// hooks mount once here, so the URL-sync effects don't run per panel, and each panel is
// handed its resolved view.

import { coerceEnum } from "@/lib/coerce";
import {
	Activity,
	BookOpen,
	type LucideIcon,
	ShieldAlert,
	Webhook,
} from "lucide-react";
import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import type { AlertsBootstrap } from "@/app/server/actions/alerts";
import { ActivityPanel } from "@/components/alerts/activity-panel";
import {
	useActivityView,
	useChannelsView,
	usePoliciesView,
} from "@/components/alerts/alerts-filters";
import { ChannelsPanel } from "@/components/alerts/channels-panel";
import { PoliciesPanel } from "@/components/alerts/policies-panel";
import { FeatureUpsell } from "@/components/settings/upgrade/feature-upsell";
import {
	type AlertsSection,
	useAlertsSection,
} from "@/lib/stores/use-alerts-section";
import { SectionHeading } from "@repo/ui/section-heading";

const SECTIONS: AlertsSection[] = ["policies", "channels", "activity"];

export function AlertsPage({ bootstrap }: { bootstrap: AlertsBootstrap }) {
	const router = useRouter();
	const { alerting } = bootstrap;
	const setActive = useAlertsSection((s) => s.setActive);
	const setSelectedPolicyId = useAlertsSection((s) => s.setSelectedPolicyId);
	const setSelectedChannelId = useAlertsSection((s) => s.setSelectedChannelId);
	const visible = useRef<Map<string, boolean>>(new Map());

	// The console filter standard, resolved once for the whole hub (see alerts-filters.ts).
	const policiesView = usePoliciesView(bootstrap.policies, bootstrap.channels);
	const channelsView = useChannelsView(bootstrap.channels);
	const activityView = useActivityView(bootstrap.deliveries);

	// Scroll-spy: the top-most in-view section drives the sidebar highlight. Also honour a
	// deep-link hash (e.g. arriving at …/alerts#channels) once on mount.
	useEffect(() => {
		if (!alerting) return;
		const observer = new IntersectionObserver(
			(entries) => {
				for (const e of entries) visible.current.set(e.target.id, e.isIntersecting);
				const top = SECTIONS.find((id) => visible.current.get(id));
				if (top) setActive(top);
			},
			{ rootMargin: "-80px 0px -55% 0px", threshold: 0 },
		);
		for (const id of SECTIONS) {
			const el = document.getElementById(id);
			if (el) observer.observe(el);
		}
		const hash = coerceEnum(
			window.location.hash.slice(1),
			SECTIONS,
			"policies",
		);
		if (SECTIONS.includes(hash)) {
			document
				.getElementById(hash)
				?.scrollIntoView({ behavior: "smooth", block: "start" });
			setActive(hash);
		}
		return () => observer.disconnect();
	}, [alerting, setActive]);

	// The plan doesn't unlock alerting — show the upsell instead of the surface.
	if (!alerting) {
		return (
			<div className="mx-auto w-full max-w-[1200px]">
				<FeatureUpsell feature="alerting" />
			</div>
		);
	}

	const refresh = () => router.refresh();
	const scrollTo = (id: AlertsSection) => {
		document
			.getElementById(id)
			?.scrollIntoView({ behavior: "smooth", block: "start" });
		setActive(id);
	};
	// Cross-links: jump to the other section AND select the target so it opens in view.
	const openPolicy = (id?: string) => {
		if (id) setSelectedPolicyId(id);
		scrollTo("policies");
	};
	const openChannel = (id?: string) => {
		if (id) setSelectedChannelId(id);
		scrollTo("channels");
	};

	return (
		<div className="mx-auto w-full max-w-[1200px] space-y-12">
			{/*
			 * No console page paints a page title any more — the sidebar entry and the breadcrumb
			 * both say "Alerts". A route still needs exactly one `h1` for its outline, though, and
			 * three sections stacked on one page are `h2`s underneath it: without this they are
			 * three orphans. So the landmark exists for a screen reader and is never painted, which
			 * is why it stays a recorded decision in the shared-surface allowlist.
			 */}
			<h1 className="sr-only">Alerts</h1>

			<section id="policies" className="scroll-mt-4">
				<SectionHeading
					className="mb-4"
					title={sectionTitle(ShieldAlert, "Policies")}
					description="A policy watches a set of events and routes them to channels."
					count={policiesView.rows.length}
					actions={<DocsLink href="/docs/console/alerts#policies" />}
				/>
				<PoliciesPanel
					bootstrap={bootstrap}
					view={policiesView}
					onChanged={refresh}
					onOpenChannel={openChannel}
				/>
			</section>

			<section id="channels" className="scroll-mt-4">
				<SectionHeading
					className="mb-4"
					title={sectionTitle(Webhook, "Channels")}
					description="Channels are where alerts go — webhooks, Slack, Rocket.Chat or email."
					count={channelsView.rows.length}
					actions={<DocsLink href="/docs/console/alerts#channels" />}
				/>
				<ChannelsPanel
					bootstrap={bootstrap}
					view={channelsView}
					onChanged={refresh}
					onOpenPolicy={openPolicy}
				/>
			</section>

			<section id="activity" className="scroll-mt-4">
				<SectionHeading
					className="mb-4"
					title={sectionTitle(Activity, "Activity")}
					description="The delivery ledger — every notification routed, with retry status."
					count={activityView.rows.length}
					actions={<DocsLink href="/docs/console/alerts#activity" />}
				/>
				<ActivityPanel bootstrap={bootstrap} view={activityView} />
			</section>
		</div>
	);
}

/**
 * The section's icon tile, inline in the SectionHeading title. The hub identifies its three
 * surfaces by icon (the connectors-style group header), and `title` is the only slot that
 * sits on the heading line — so the tile rides there rather than reviving a local header.
 */
function sectionTitle(Icon: LucideIcon, text: string) {
	return (
		<span className="inline-flex items-center gap-2.5">
			<span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border/60 bg-muted/20 text-muted-foreground">
				<Icon className="size-4" />
			</span>
			{text}
		</span>
	);
}

/** The per-section "Docs" link, rendered in the SectionHeading's actions slot. */
function DocsLink({ href }: { href: string }) {
	return (
		<a
			href={href}
			target="_blank"
			rel="noreferrer"
			className="flex shrink-0 items-center gap-1.5 rounded-md border border-border/60 bg-muted/20 px-2.5 py-1.5 text-muted-foreground text-xs transition-colors hover:text-foreground"
		>
			<BookOpen className="size-3.5" />
			Docs
		</a>
	);
}
