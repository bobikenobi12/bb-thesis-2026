"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { useState } from "react";
import type {
	CloudAccountStatus,
	ConnectorWithConnection,
} from "@/app/server/actions/connectors";
import { ClassificationControl } from "@/components/classification/classification-control";
import { useAssignmentsForKind } from "@/lib/query/use-classification-query";
import { GitProviderIcon } from "@/components/connectors/git-provider-icon";
import { ConnectorIcon } from "@/components/connectors/connector-icon";
import {
	connectorState,
	type ConnectorHealth,
} from "@/components/connectors/connectors-query";
import { Badge } from "@repo/ui/badge";
import { Button } from "@repo/ui/button";
import { DetailSheet } from "@repo/ui/detail-sheet";
import { Input } from "@repo/ui/input";
import { SectionHeading } from "@repo/ui/section-heading";
import { Separator } from "@repo/ui/separator";
import { StatusBadge, type StatusTier } from "@repo/ui/status-badge";
import {
	BookOpen,
	Check,
	ExternalLink,
	Loader2,
	Pencil,
	Plus,
	RefreshCw,
	Unlink,
	X,
} from "lucide-react";

/**
 * How each cloud-account health renders through the shared `StatusBadge`. This used to be a
 * file-local `AccountStatusBadge` component — one of the console's ad-hoc status pills — but
 * all it ever contributed was a tier override and a label, so it is data now rather than a
 * component wrapping the shared one.
 *
 * `degraded` deliberately reads as `pending`, not `failed`: the account authenticated fine and
 * is usable — it just cannot see everything we provision into, so there is something left to
 * do rather than something broken.
 */
const ACCOUNT_BADGE: Record<
	CloudAccountStatus,
	{ tier?: StatusTier; label: string }
> = {
	connected: { label: "Connected" },
	degraded: { tier: "pending", label: "Limited permissions" },
	testing: { tier: "pending", label: "Verifying…" },
	failed: { label: "Verification failed" },
};

/** Grayscale tier for the connector-level rollup shown in the sheet header. */
const HEALTH_TIER: Record<ConnectorHealth, StatusTier> = {
	connected: "active",
	attention: "pending",
	disconnected: "idle",
	unavailable: "disabled",
	coming_soon: "disabled",
};

interface ConnectorDetailSheetProps {
	integration: ConnectorWithConnection | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	canManage: boolean;
	/** False when this instance lacks the platform creds/OAuth app this connector's flow needs. */
	platformConfigured?: boolean;
	isConnecting?: boolean;
	/** Connect, or (for a connected cloud) add another account. */
	onConnect: () => void;
	/** Disconnect a non-cloud connector (git token / api_key credential). */
	onDisconnectConnector: () => void;
	/** Disconnect a specific cloud account by identity id. */
	onDisconnectAccount: (identityId: string) => void;
	/** Re-run verification for a specific cloud account against its stored credentials. */
	onReverifyAccount: (identityId: string) => Promise<void>;
	/** Rename a cloud account. */
	onRenameAccount: (identityId: string, name: string) => Promise<void>;
}

/**
 * The manage drawer for one connector, on the shared `DetailSheet` shell (header title +
 * description + status badge, an independently scrolling body, a pinned footer action).
 *
 * For clouds it lists every CONFIGURED account — including one that failed to verify, which is
 * the only place it can be re-verified or removed — each renamable / disconnectable, and offers
 * "Add another account"; for git / api_key connectors the footer offers connect or disconnect.
 * Mutating affordances are hidden unless `canManage`.
 */
export function ConnectorDetailSheet({
	integration,
	open,
	onOpenChange,
	canManage,
	platformConfigured = true,
	isConnecting,
	onConnect,
	onDisconnectConnector,
	onDisconnectAccount,
	onReverifyAccount,
	onRenameAccount,
}: ConnectorDetailSheetProps) {
	const [reverifyingId, setReverifyingId] = useState<string | null>(null);
	const [editingId, setEditingId] = useState<string | null>(null);
	const [draft, setDraft] = useState("");
	const [savingId, setSavingId] = useState<string | null>(null);

	// One batched query hydrates every connected account's classification chips.
	const accountIds = (integration?.accounts ?? []).map((a) => a.identityId);
	const { data: classMap = {} } = useAssignmentsForKind(
		"cloud_identity",
		accountIds,
	);

	if (!integration) return null;

	const isConnected = integration.connected;
	const state = connectorState(integration, platformConfigured);
	// "Coming soon" only when NOT already connected, so a connected account still shows its
	// accounts + disconnect UI rather than a dead "Coming Soon" badge. See connector-card.tsx.
	const isComingSoon = state.health === "coming_soon";
	const isGit = integration.category === "git";
	const isCloud = integration.category === "cloud";
	const accounts = integration.accounts ?? [];

	const startRename = (id: string, current: string) => {
		setEditingId(id);
		setDraft(current);
	};

	const commitRename = async (id: string) => {
		const name = draft.trim();
		if (!name) return;
		setSavingId(id);
		try {
			await onRenameAccount(id, name);
			setEditingId(null);
		} finally {
			setSavingId(null);
		}
	};

	const logo = isGit ? (
		<GitProviderIcon provider={integration.slug} size={20} mono={!isConnected} />
	) : (
		<ConnectorIcon
			src={integration.icon_url}
			name={integration.name}
			size={22}
			mono={!isConnected}
		/>
	);

	// The pinned action. A cloud with accounts adds another (per-account disconnect lives on the
	// row); everything else connects or disconnects wholesale.
	let footer: React.ReactNode = null;
	if (canManage && !isComingSoon) {
		if (isCloud && accounts.length > 0) {
			footer = (
				<Button
					variant="outline"
					className="w-full border-border/50 text-xs"
					disabled={isConnecting}
					onClick={onConnect}
				>
					{isConnecting ? (
						<Loader2 className="mr-1.5 size-3.5 animate-spin" />
					) : (
						<Plus className="mr-1.5 size-3.5" />
					)}
					Add another account
				</Button>
			);
		} else if (!isConnected) {
			footer = (
				<Button className="w-full" disabled={isConnecting} onClick={onConnect}>
					{isConnecting && <Loader2 className="mr-2 size-4 animate-spin" />}
					Connect {integration.name}
				</Button>
			);
		} else if (!isCloud) {
			footer = (
				<Button
					variant="outline"
					className="w-full border-border/50 text-destructive hover:bg-destructive/10 hover:text-destructive"
					onClick={onDisconnectConnector}
				>
					<Unlink className="mr-2 size-4" />
					Disconnect {integration.name}
				</Button>
			);
		}
	}

	return (
		<DetailSheet
			open={open}
			onOpenChange={onOpenChange}
			className="w-full sm:max-w-md"
			title={
				<span className="flex min-w-0 items-center gap-2.5">
					<span className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border/50 bg-background p-1.5">
						{logo}
					</span>
					<span className="truncate">{integration.name}</span>
				</span>
			}
			description={integration.organization}
			badge={
				<StatusBadge
					status={state.health}
					tier={HEALTH_TIER[state.health]}
					label={state.label}
				/>
			}
			footer={footer}
		>
			<div className="space-y-6">
				{isConnected && integration.scope === "org" && (
					<Badge
						variant="outline"
						className="border-border/50 text-ui-2xs text-muted-foreground"
					>
						Org-wide
					</Badge>
				)}

				<p className="text-sm leading-relaxed text-foreground/80">
					{integration.description}
				</p>

				{/* Cloud accounts (multi-account). Gated on the account list, NOT on `isConnected`: an
				    account whose verification failed is still listed here — it is the only place it can
				    be re-verified or removed, and while it was hidden a broken connection was stuck. */}
				{isCloud && accounts.length > 0 && (
					<div className="space-y-3">
						<SectionHeading level={3} title="Accounts" />
						<div className="space-y-2">
							{accounts.map((acc) => (
								<div
									key={acc.identityId}
									className="flex items-center gap-2 rounded-lg border border-border/50 px-3 py-2"
								>
									{editingId === acc.identityId ? (
										<>
											<Input
												value={draft}
												onChange={(e) => setDraft(e.target.value)}
												className="h-7 text-xs"
												autoFocus
												onKeyDown={(e) => {
													if (e.key === "Enter") commitRename(acc.identityId);
													if (e.key === "Escape") setEditingId(null);
												}}
											/>
											<Button
												size="sm"
												variant="ghost"
												className="size-7 p-0"
												disabled={savingId === acc.identityId}
												onClick={() => commitRename(acc.identityId)}
											>
												{savingId === acc.identityId ? (
													<Loader2 className="size-3.5 animate-spin" />
												) : (
													<Check className="size-3.5" />
												)}
											</Button>
											<Button
												size="sm"
												variant="ghost"
												className="size-7 p-0"
												onClick={() => setEditingId(null)}
											>
												<X className="size-3.5" />
											</Button>
										</>
									) : (
										<>
											<div className="min-w-0 flex-1">
												<div className="flex flex-wrap items-center gap-1.5">
													<span className="truncate text-xs font-medium text-foreground">
														{acc.name}
													</span>
													<StatusBadge
														status={acc.status}
														{...ACCOUNT_BADGE[acc.status]}
													/>
												</div>
												{acc.label && (
													<div className="truncate font-mono text-ui-2xs text-muted-foreground">
														{acc.label}
													</div>
												)}
												{/* Why it failed / what it can't see. Without this the only signal was a
												    generic red badge, and the fix was a guess. */}
												{acc.status === "failed" && acc.lastError && (
													<p className="mt-1 text-ui-2xs leading-relaxed text-destructive">
														{acc.lastError}
													</p>
												)}
												{acc.status === "degraded" &&
													(acc.missingPermissions?.length ?? 0) > 0 && (
														<p className="mt-1 text-ui-2xs leading-relaxed text-muted-foreground">
															Missing:{" "}
															<span className="font-mono">
																{acc.missingPermissions?.join(", ")}
															</span>
														</p>
													)}
												{/* Classification (Workstream B) — chips + a picker for managers. */}
												<ClassificationControl
													kind="cloud_identity"
													id={acc.identityId}
													canEdit={canManage}
													initialAssignments={classMap[acc.identityId]}
													className="mt-1.5"
													compact
												/>
											</div>
											{canManage && (
												<>
													{(acc.status === "failed" ||
														acc.status === "degraded") && (
														<Button
															size="sm"
															variant="ghost"
															className="size-7 p-0 text-muted-foreground"
															title="Re-verify with the stored credentials"
															disabled={reverifyingId === acc.identityId}
															onClick={async () => {
																setReverifyingId(acc.identityId);
																try {
																	await onReverifyAccount(acc.identityId);
																} finally {
																	setReverifyingId(null);
																}
															}}
														>
															{reverifyingId === acc.identityId ? (
																<Loader2 className="size-3.5 animate-spin" />
															) : (
																<RefreshCw className="size-3.5" />
															)}
														</Button>
													)}
													<Button
														size="sm"
														variant="ghost"
														className="size-7 p-0 text-muted-foreground"
														title="Rename"
														onClick={() =>
															startRename(acc.identityId, acc.name)
														}
													>
														<Pencil className="size-3.5" />
													</Button>
													<Button
														size="sm"
														variant="ghost"
														className="size-7 p-0 text-destructive hover:text-destructive"
														title="Remove this connection"
														onClick={() => onDisconnectAccount(acc.identityId)}
													>
														<Unlink className="size-3.5" />
													</Button>
												</>
											)}
										</>
									)}
								</div>
							))}
						</div>
					</div>
				)}

				<Separator />

				{integration.docs_url && (
					<a
						href={integration.docs_url}
						target="_blank"
						rel="noopener noreferrer"
						className="flex items-center gap-2.5 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
					>
						<BookOpen className="size-4" />
						Documentation
						<ExternalLink className="ml-auto size-3" />
					</a>
				)}

				{/* Classification (Workstream B) — for a connected non-cloud credential. */}
				{isConnected && !isCloud && integration.credential_id && (
					<div className="space-y-2">
						<SectionHeading level={3} title="Classification" />
						<ClassificationControl
							kind="connector_credential"
							id={integration.credential_id}
							canEdit={canManage}
						/>
					</div>
				)}
			</div>
		</DetailSheet>
	);
}
