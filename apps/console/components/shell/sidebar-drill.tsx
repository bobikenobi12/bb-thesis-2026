"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { ChevronLeft } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { SettingsNav } from "@/components/settings/settings-nav";
import { ALERTS_SECTIONS, useAlertsSection } from "@/lib/stores/use-alerts-section";
import { isEnumMember } from "@/lib/coerce";
import { orgHref, projectHref } from "@/lib/routing";
import {
	type DrillDef,
	globalSub,
	isNavItemActive,
	type NavItem,
	settingsScope,
} from "./nav-config";
import { NavRow } from "./nav-row";

/**
 * A drill-in sub-view: a back header (left chevron + section title) above the section's
 * nav. The Settings drill reuses `<SettingsNav/>` (with its entitlement gating); the
 * others render their config items (real anchors + "Soon" stubs). Route-owned drills back
 * out by navigating to the org overview; the click-only drill backs out via `onBack`.
 */
export function SidebarDrill({
	drill,
	orgSlug,
	onBack,
}: {
	drill: DrillDef;
	orgSlug: string;
	onBack: () => void;
}) {
	const pathname = usePathname();
	const activeSection = useAlertsSection((s) => s.active);
	const setActiveSection = useAlertsSection((s) => s.setActive);
	const onAlertsRoute = globalSub(pathname) === "alerts";

	// Alerts items anchor-scroll within the single-page hub. On the alerts route we
	// intercept the click and smooth-scroll; from elsewhere the <Link> navigates to
	// `…/alerts#<id>` and the page scrolls itself on mount.
	const alertsItemProps = (item: NavItem) => {
		if (!item.scrollId) return {};
		const id = item.scrollId;
		return {
			active: activeSection === id,
			onClick: (e: React.MouseEvent) => {
				if (!onAlertsRoute) return;
				e.preventDefault();
				document
					.getElementById(id)
					?.scrollIntoView({ behavior: "smooth", block: "start" });
				if (isEnumMember(id, ALERTS_SECTIONS)) setActiveSection(id);
				history.replaceState(null, "", `#${id}`);
			},
		};
	};

	const headClassName =
		"flex flex-1 items-center gap-2 rounded-md px-2 py-2 text-left text-ui-md font-semibold text-foreground transition-colors hover:bg-muted/60";

	// The Settings drill backs out to its scope's home: the project overview when inside a
	// project's settings, otherwise the org overview. Other route-owned drills back to the org.
	const scope = settingsScope(pathname);
	const backHref =
		drill.id === "settings" && scope?.kind === "project"
			? projectHref(orgSlug, scope.projectSlug)
			: orgHref(orgSlug);

	return (
		<div className="flex h-full flex-col">
			<div className="flex h-[53px] shrink-0 items-center border-b px-2.5">
				{drill.routeOwned ? (
					<Link href={backHref} className={headClassName}>
						<ChevronLeft className="h-4 w-4 text-muted-foreground" />
						{drill.title}
					</Link>
				) : (
					<button type="button" onClick={onBack} className={headClassName}>
						<ChevronLeft className="h-4 w-4 text-muted-foreground" />
						{drill.title}
					</button>
				)}
			</div>

			<nav className="flex-1 overflow-y-auto p-3">
				{drill.id === "settings" ? (
					<SettingsNav />
				) : (
					<div className="space-y-0.5">
						{drill.items?.map((item) => (
							<NavRow
								key={item.label}
								item={item}
								active={isNavItemActive(item, pathname)}
								{...alertsItemProps(item)}
							/>
						))}
					</div>
				)}
			</nav>
		</div>
	);
}
