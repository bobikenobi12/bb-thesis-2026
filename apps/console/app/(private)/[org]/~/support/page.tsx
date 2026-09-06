// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { LucideIcon } from "lucide-react";
import { ClipboardCheck, Flag, Inbox, Sparkles } from "lucide-react";
import { SupportBrowseTopics } from "@/components/support/support-topics";
import { SupportCard } from "@/components/support/support-card";
import { SupportWhatsNew } from "@/components/support/support-whats-new";
import { globalHref } from "@/lib/routing";
import { pageMetadata } from "@/lib/seo/page-metadata";

export const metadata = pageMetadata({
	title: "Support",
	description:
		"Get help with Alethia — track your cases, open a new case, ask AI, or report abuse.",
});

/**
 * The four ways into support, in the order a person needs them: the cases they already have,
 * a new one, the assistant, and the abuse channel. Every one of them is a surface that exists
 * — there is no fifth card standing in for something unbuilt.
 */
const ENTRY_POINTS: {
	icon: LucideIcon;
	title: string;
	description: string;
	/** Appended to the support base path for this org. */
	segment: string;
}[] = [
	{
		icon: Inbox,
		title: "My cases",
		description: "View and manage your open and resolved support cases.",
		segment: "my-cases",
	},
	{
		icon: ClipboardCheck,
		title: "Submit a case",
		description: "Create a new support case for your issue.",
		segment: "submit",
	},
	{
		icon: Sparkles,
		title: "Ask AI",
		description: "Get instant answers from the Alethia platform assistant.",
		segment: "ask",
	},
	{
		icon: Flag,
		title: "Report abuse",
		description: "Create and submit an abuse or security report.",
		segment: "abuse",
	},
];

/**
 * The support landing hub. It opens with the question — "What can we help you with?" — over the
 * four entry-point cards, then the "See what's new" band and the knowledge-base topic grid. The
 * width is the shell's ({@link SupportShell}, 1200px) and the page adds none of its own.
 */
export default async function SupportPage({
	params,
}: {
	params: Promise<{ org: string }>;
}) {
	const { org } = await params;
	const base = globalHref(org, "support");

	return (
		<div className="pb-4">
			<div className="pt-12 pb-14">
				{/* Not a page title: the breadcrumb above already says "Support". This asks the
				    reader something instead of repeating it — a recorded decision in
				    apps/console/shared-surface-allowlist.yaml. */}
				<h1 className="mb-10 text-center text-3xl font-semibold tracking-tight">
					What can we help you with?
				</h1>

				<div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
					{ENTRY_POINTS.map((entry) => (
						<SupportCard
							key={entry.segment}
							icon={entry.icon}
							title={entry.title}
							description={entry.description}
							href={`${base}/${entry.segment}`}
						/>
					))}
				</div>
			</div>

			<SupportWhatsNew />
			<SupportBrowseTopics />
		</div>
	);
}
