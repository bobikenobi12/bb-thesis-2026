// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { LucideIcon } from "lucide-react";
import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { Card } from "@repo/ui/card";
import { SectionHeading } from "@repo/ui/section-heading";

interface SupportCardProps {
	/** Leading lucide icon for the card. */
	icon: LucideIcon;
	/** Card heading. */
	title: string;
	/** One-line blurb under the heading. */
	description: string;
	/**
	 * Navigation target. REQUIRED, and it is the type that says so: this used to be optional so
	 * that omitting it (with `disabled`) rendered a muted "coming soon" panel. That card is gone
	 * and is not coming back — the support hub's rule is that every entry point is a surface that
	 * exists. An optional `href` would let the next caller forget one and get a silently
	 * non-interactive card instead of a compile error, which is the failure this shape prevents.
	 */
	href: string;
}

/**
 * The card's inner content — icon top-left, a trailing arrow that slides on hover, then the
 * title + blurb.
 */
function SupportCardBody({
	icon: Icon,
	title,
	description,
}: Pick<SupportCardProps, "icon" | "title" | "description">) {
	return (
		<div className="flex h-full flex-col px-6">
			<div className="flex items-start justify-between">
				<Icon className="size-[22px] text-muted-foreground" />
				<ArrowRight className="size-[18px] text-muted-foreground/50 transition-[transform,color] duration-150 group-hover:translate-x-[3px] group-hover:text-foreground" />
			</div>
			<SectionHeading
				level={3}
				title={title}
				description={description}
				className="mt-6"
			/>
		</div>
	);
}

/**
 * A single entry-point card on the support landing grid. The whole card is an internal link.
 * Grayscale hover treatment (border + surface lift + arrow slide) matches the rest of the console.
 *
 * The external/new-tab variant went with the community card in the same commit that removed it:
 * every remaining entry point is a route inside this console, so `next/link` is the only case
 * left. A branch kept alive for a caller that does not exist is a branch nothing renders and
 * nothing tests.
 */
export function SupportCard({
	icon,
	title,
	description,
	href,
}: SupportCardProps) {
	return (
		<Link
			href={href}
			className="group block h-full rounded-xl focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
		>
			<Card className="h-full gap-0 py-6 transition-colors duration-150 group-hover:border-foreground/20 group-hover:bg-muted/40">
				<SupportCardBody icon={icon} title={title} description={description} />
			</Card>
		</Link>
	);
}
