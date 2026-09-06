"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { ToolUIPart } from "ai";
import Link from "next/link";
import { useParams } from "next/navigation";
import { z } from "zod";
import { useArtifactStore } from "@/lib/stores/use-artifact-store";
import { ToolResultFrame } from "./tool-result-frame";
import { widgetDefForPartType } from "./widgets/registry";

/** Tool result types this module renders specially (registry tables / one-liners). */
export const TOOL_VIEW_TYPES = new Set<string>([
	"tool-list_projects",
	"tool-list_jobs",
	"tool-list_clusters",
	"tool-list_connectors",
	"tool-list_runners",
	"tool-cidr_for_hosts",
	"tool-list_services",
	"tool-list_service_options",
	"tool-connect_cloud",
]);

const cidrOut = z.object({ cidr: z.string(), totalAddresses: z.number().nullish() });
const connectOut = z.object({
	provider: z.string(),
	alreadyConnected: z.boolean(),
	connectedAccounts: z.array(z.string()).nullish(),
});

const PROVIDER_LABEL: Record<string, string> = {
	aws: "AWS",
	gcp: "GCP",
	azure: "Azure",
	alibaba: "Alibaba",
};

/**
 * The generative "connect a cloud" action — renders an inline button that opens the Connectors page with
 * the connect sheet for the provider (?connect=<provider>), or a "manage" link when it's already connected.
 */
function ConnectAction({
	provider,
	alreadyConnected,
}: {
	provider: string;
	alreadyConnected: boolean;
}) {
	const params = useParams();
	const org = typeof params.org === "string" ? params.org : "";
	const label = PROVIDER_LABEL[provider] ?? provider;
	if (alreadyConnected) {
		return (
			<div className="flex w-fit items-center gap-2 border border-border px-3 py-1.5 text-ui-sm text-muted-foreground">
				<span className="h-1.5 w-1.5 flex-none rounded-full bg-foreground" />
				{label} is already connected.
				<Link href={`/${org}/~/connectors`} className="text-foreground underline underline-offset-2">
					Manage
				</Link>
			</div>
		);
	}
	return (
		<Link
			href={`/${org}/~/connectors?connect=${provider}`}
			className="flex w-fit items-center gap-2 border border-foreground bg-foreground px-3 py-1.5 text-ui-sm font-medium text-background transition-opacity hover:opacity-90"
		>
			Connect {label} →
		</Link>
	);
}

/**
 * Polished tool-result renderings for the agent transcript — every result inside the
 * shared `ToolResultFrame` (a labeled marker line). Tabular reads render through the
 * tool→widget registry (the same bodies the grid pins), catalog/CIDR one-liners fold
 * into the marker line, and anything else falls back to the generic collapsible frame.
 */
export function ToolView({ part }: { part: ToolUIPart }) {
	const open = useArtifactStore((s) => s.open);
	// Streaming/running states render the frame's live status marker.
	if (part.state !== "output-available") return <ToolResultFrame part={part} />;

	switch (part.type) {
		case "tool-cidr_for_hosts": {
			const p = cidrOut.safeParse(part.output);
			return p.success ? (
				<ToolResultFrame
					part={part}
					detail={`${p.data.cidr}${p.data.totalAddresses ? ` · ${p.data.totalAddresses} IPs` : ""}`}
				/>
			) : (
				<ToolResultFrame part={part} />
			);
		}
		case "tool-list_services":
			return <ToolResultFrame part={part} detail="catalog loaded" />;
		case "tool-list_service_options":
			return <ToolResultFrame part={part} detail="options loaded" />;

		case "tool-connect_cloud": {
			const p = connectOut.safeParse(part.output);
			return p.success ? (
				<ToolResultFrame part={part}>
					<ConnectAction provider={p.data.provider} alreadyConnected={p.data.alreadyConnected} />
				</ToolResultFrame>
			) : (
				<ToolResultFrame part={part} />
			);
		}

		default: {
			// Registry-backed tabular reads: the same body the grid renders, framed.
			const def = widgetDefForPartType(part.type);
			if (def?.parses(part.output)) {
				return (
					<ToolResultFrame part={part} detail={def.detail(part.output)}>
						<def.Body output={part.output} openArtifact={open} />
					</ToolResultFrame>
				);
			}
			return <ToolResultFrame part={part} />;
		}
	}
}
