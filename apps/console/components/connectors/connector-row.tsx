"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { ConnectorWithConnection } from "@/app/server/actions/connectors";
import { ConnectorIcon } from "@/components/connectors/connector-icon";
import { GitProviderIcon } from "@/components/connectors/git-provider-icon";
import { connectorState } from "@/components/connectors/connectors-query";
import { Button } from "@repo/ui/button";
import { TableCell, TableRow } from "@repo/ui/table";
import { cn } from "@repo/ui/utils";
import { Loader2, RefreshCw } from "lucide-react";

interface ConnectorRowProps {
	integration: ConnectorWithConnection;
	/** Whether the current member may add/edit connections. */
	canManage: boolean;
	/** Connect (or, for a connected cloud, "add another account"). */
	onConnect: () => void;
	/** Open the manage sheet (connected connectors). */
	onManage: () => void;
	/** Re-run the verification for a failed cloud connector (no credential re-entry). */
	onReverify?: () => void;
	/**
	 * False when this instance isn't configured to support this provider's connect flow — a managed
	 * cloud missing platform creds, or a git provider with no registered OAuth app.
	 */
	platformConfigured?: boolean;
	isConnecting?: boolean;
}

/**
 * The table-view counterpart of `ConnectorCard` — one connector as a row (logo +
 * name/description, status, account/scope meta, and a Manage/Connect/Reconnect
 * action), sharing the same affordances so the two views stay in lock-step.
 */
export function ConnectorRow({
	integration,
	canManage,
	onConnect,
	onManage,
	onReverify,
	platformConfigured = true,
	isConnecting,
}: ConnectorRowProps) {
	const isConnected = integration.connected;
	// One ladder for the wording, shared with the card and the Status facet. See connectors-query.ts.
	const state = connectorState(integration, platformConfigured);
	// "Coming soon" only when NOT already connected — a connected account keeps its Manage → disconnect
	// path even if the connector is later marked coming_soon. See connector-card.tsx.
	const isComingSoon = state.health === "coming_soon";
	const isGit = integration.category === "git";
	const isCloud = integration.category === "cloud";
	// A managed cloud missing platform creds, or a git provider with no registered OAuth app: a
	// connect can only fail, so the row is honest about it instead of offering a doomed connect.
	const platformUnavailable = state.health === "unavailable";
	const needsReconnection =
		integration.token_health === "expired" ||
		integration.token_health === "refresh_failed";
	const cloudFailed = integration.cloud_health === "failed";
	const cloudTesting = integration.cloud_health === "testing";
	const accountCount = integration.accounts?.length ?? 0;

	return (
		<TableRow className={cn(isComingSoon && "opacity-50")}>
			<TableCell className="py-3">
				<div className="flex items-center gap-3">
					<div className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border/60 bg-muted/40 p-1.5">
						{isGit ? (
							<GitProviderIcon
								provider={integration.slug}
								size={20}
								mono={!isConnected}
							/>
						) : (
							<ConnectorIcon
								src={integration.icon_url}
								name={integration.name}
								size={22}
								mono={!isConnected}
							/>
						)}
					</div>
					{/* Cap the text column so `truncate` has a width to clamp against — the table is
					    `table-layout: auto` and TableCell is `whitespace-nowrap`, so without a max-width
					    the cell grows to the full un-wrapped description (the 150+ char Hetzner blurb was
					    the worst offender) and tips the whole table into horizontal scroll. */}
					<div className="min-w-0 max-w-[16rem] sm:max-w-[24rem] lg:max-w-[32rem]">
						{/* `title` carries the full string for the names the clamp eats — the card
						    solves this with a two-line title, but a table row has one line to give. */}
						<div
							className="truncate text-sm font-medium text-foreground"
							title={integration.name}
						>
							{integration.name}
						</div>
						<div
							className="truncate text-xs text-muted-foreground"
							title={integration.description}
						>
							{integration.description}
						</div>
					</div>
				</div>
			</TableCell>

			<TableCell>
				<div className="flex items-center gap-2">
					<span
						className={cn(
							"size-2 shrink-0 rounded-full",
							isConnected
								? "bg-foreground ring-4 ring-muted/60"
								: state.destructive
									? "bg-destructive/70"
									: "border-[1.5px] border-border",
						)}
						aria-hidden
					/>
					<span
						className={cn(
							"text-xs text-muted-foreground",
							state.destructive && "text-destructive",
						)}
					>
						{state.label}
					</span>
				</div>
			</TableCell>

			<TableCell className="font-mono text-ui-2xs text-muted-foreground">
				{isCloud && isConnected ? (
					<span className="rounded-full border border-border/60 px-1.5 py-0.5">
						{accountCount} {accountCount === 1 ? "account" : "accounts"}
					</span>
				) : integration.scope === "org" && !isCloud && isConnected ? (
					<span className="rounded-full border border-border/60 px-1.5 py-0.5">
						Org
					</span>
				) : (
					<span className="text-muted-foreground/50">—</span>
				)}
			</TableCell>

			<TableCell className="text-right">
				{isComingSoon ? null : platformUnavailable ? (
					<span
						title={
							isGit
								? "This git provider has no OAuth app configured on this instance. See the docs to enable it."
								: "This cloud needs Alethia platform credentials, which aren't configured on this instance. See the docs to enable managed cloud connections."
						}
						className="rounded-full border border-border/60 px-2 py-0.5 font-mono text-ui-2xs uppercase tracking-wide text-muted-foreground"
					>
						Unavailable
					</span>
				) : isConnected && needsReconnection && canManage ? (
					<Button
						size="sm"
						className="h-7 px-2.5 text-xs"
						disabled={isConnecting}
						onClick={onConnect}
					>
						{isConnecting ? (
							<Loader2 className="mr-1 size-3.5 animate-spin" />
						) : (
							<RefreshCw className="mr-1 size-3.5" />
						)}
						Reconnect
					</Button>
				) : isConnected ? (
					<Button
						variant="ghost"
						size="sm"
						className="h-7 px-2.5 text-xs"
						onClick={onManage}
					>
						Manage
					</Button>
				) : cloudTesting ? (
					<Loader2 className="ml-auto size-3.5 animate-spin text-muted-foreground" />
				) : cloudFailed && canManage ? (
					// Manage alongside Re-verify — re-verifying wrong stored credentials fails forever, so
					// the sheet (correct / remove the account) must be reachable. See connector-card.tsx.
					<div className="flex items-center justify-end gap-1">
						<Button
							variant="ghost"
							size="sm"
							className="h-7 px-2.5 text-xs"
							onClick={onManage}
						>
							Manage
						</Button>
						<Button
							size="sm"
							className="h-7 px-2.5 text-xs"
							disabled={isConnecting}
							onClick={onReverify}
						>
							{isConnecting ? (
								<Loader2 className="mr-1 size-3.5 animate-spin" />
							) : (
								<RefreshCw className="mr-1 size-3.5" />
							)}
							Re-verify
						</Button>
					</div>
				) : canManage ? (
					<Button
						size="sm"
						className="h-7 px-2.5 text-xs"
						disabled={isConnecting}
						onClick={onConnect}
					>
						{isConnecting && <Loader2 className="mr-1 size-3.5 animate-spin" />}
						Connect
					</Button>
				) : null}
			</TableCell>
		</TableRow>
	);
}
