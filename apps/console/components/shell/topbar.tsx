"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Menu } from "lucide-react";
import { DownloadCliButton } from "@/components/download-cli-button";
import { EnvSwitcher } from "@/components/env-switcher";
import { HeaderBreadcrumbs } from "@/components/header-breadcrumbs";
import { SetupGuideButton } from "@/components/onboarding/setup-guide";
import { ProjectSwitcher } from "@/components/project-switcher";
import { Button } from "@repo/ui/button";
import { AskAiButton } from "./ask-ai-button";

/**
 * The main-column topbar: project / env quick-switchers on the left, the route breadcrumb
 * centered as plain text (hidden when empty, e.g. on the org overview), and the CLI
 * download on the right.
 *
 * ── WHY THIS IS A GRID AND NOT A FLEX ROW ────────────────────────────────────────────────────
 *
 * The breadcrumb used to be centered OUT OF FLOW — `absolute left-1/2 -translate-x-1/2` over an
 * `ml-auto` action cluster, with nothing between them reserving space. At 768 (the narrowest
 * width `md:` shows the breadcrumb at, and the last one before the sidebar appears and gives the
 * header back its room) the two collide, and the collision is real rather than cosmetic: the
 * outer box was `pointer-events-none` but the inner one turned pointer events back on, so the
 * hit areas genuinely overlapped. The audit measured it on NINE routes as one shell defect:
 * the env switcher over the breadcrumb by 43x20 on the settings routes, and the breadcrumb over
 * `Ask AI` by 55x20 on `/[org]/~/support/cases/[id]` (#3805, R4).
 *
 * Three tracks fix it by construction — the clusters and the breadcrumb cannot reach each other
 * because they are in different columns.
 *
 * `minmax(max-content,1fr)` on the two side tracks rather than a bare `auto` is what keeps the
 * breadcrumb OPTICALLY CENTERED. The two are equal `1fr`, so wherever there is room to spare
 * they grow by the same amount and the middle track lands on the header's centre line, exactly
 * where the old absolute box put it; the `max-content` floor is what stops either cluster from
 * being squeezed. Only when there is no spare room does the floor win and the breadcrumb sit
 * where the space actually is. Measured, before → after, at the rubric's four widths: the
 * crumb's offset from the header centre is 0 at 1280/1440/1920 in both layouts, and at 768 it
 * moves by +45 / +18 / −58 px depending on the route — which is the whole trade, and it is paid
 * only at the width that was broken.
 *
 * The breadcrumb keeps `empty:hidden`, so the bare org overview still reserves no space: an
 * empty middle track is zero wide.
 */
export function Topbar({ onOpenSidebar }: { onOpenSidebar: () => void }) {
	return (
		<header className="grid h-[53px] shrink-0 grid-cols-[minmax(max-content,1fr)_auto_minmax(max-content,1fr)] items-center gap-1 border-b bg-background px-2 sm:px-4">
			<div className="flex items-center gap-1">
				<Button
					variant="ghost"
					size="icon"
					className="h-9 w-9 shrink-0 lg:hidden"
					onClick={onOpenSidebar}
					aria-label="Open navigation"
				>
					<Menu className="h-5 w-5" />
				</Button>

				<ProjectSwitcher />
				<EnvSwitcher />
			</div>

			{/* Centered breadcrumb — plain text, collapses to nothing on the bare overview. It
			    truncates inside its own track instead of growing across the clusters. */}
			<div className="flex min-w-0 justify-center">
				<div className="hidden min-w-0 items-center empty:hidden md:flex">
					<HeaderBreadcrumbs />
				</div>
			</div>

			<div className="flex items-center justify-end gap-1.5">
				<AskAiButton />
				<SetupGuideButton />
				<DownloadCliButton />
			</div>
		</header>
	);
}
