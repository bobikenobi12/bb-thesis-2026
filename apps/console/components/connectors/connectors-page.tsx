"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import {
	disconnectAwsIdentity,
	renameCloudIdentity,
	reverifyCloudIdentity,
} from "@/app/(private)/dashboard/providers/actions";
import { isEnumMember } from "@/lib/coerce";
import { asGitProvider } from "@/lib/connectors/git-providers";
import { disconnectAzureIdentity } from "@/app/(private)/dashboard/providers/azure-actions";
import { disconnectGcpIdentity } from "@/app/(private)/dashboard/providers/gcp-actions";
import { disconnectExtraCloud } from "@/app/(private)/dashboard/providers/extra-cloud-actions";
import { deleteProviderToken } from "@/app/server/actions/identities";
import {
	deleteConnectorCredential,
	getConnectorsWithStatus,
	type ConnectorWithConnection,
} from "@/app/server/actions/connectors";
import { ConnectorCard } from "@/components/connectors/connector-card";
import { ConnectorRow } from "@/components/connectors/connector-row";
import { ConnectorDetailSheet } from "@/components/connectors/connector-detail-sheet";
import { ConnectorsFilterBar } from "@/components/connectors/connectors-filter-bar";
import {
	DEFAULT_CONNECTOR_FILTERS,
	GROUP_META,
	buildConnectorsView,
	isPristineQuery,
	normalizeConnectorQuery,
} from "@/components/connectors/connectors-query";
import { ApiKeyConnection } from "@/components/connectors/api-key-connection";
import {
	ConnectSheetHeader,
	EXTRA_CLOUDS,
	useCloudConnect,
} from "@/components/cloud-connect/use-cloud-connect";
import { getConnectorProviderBySlug } from "@/lib/connectors/registry.generated";
import { connectRoute } from "@/lib/connectors/helpers";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useFilterUrlSync } from "@/hooks/use-filter-url-sync";
import { qk } from "@/lib/query/keys";
import { useConnectorFilters } from "@/lib/stores/use-connector-filters";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@repo/ui/alert-dialog";
import { Button } from "@repo/ui/button";
import { SectionHeading } from "@repo/ui/section-heading";
import { EmptyState } from "@repo/ui/empty";
import { PageToolbar } from "@repo/ui/page-toolbar";
import { Sheet, SheetContent } from "@repo/ui/sheet";
import {
	Table,
	TableBody,
	TableHead,
	TableHeader,
	TableRow,
} from "@repo/ui/table";
import { ViewToggle, type ViewMode } from "@repo/ui/view-toggle";
import { cn } from "@repo/ui/utils";
import { authClient } from "@/lib/auth/client";
import { track, captureException } from "@/lib/analytics/track";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, Loader2, SearchX, Unplug } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

/**
 * Extracts a human-readable detail from an auth/link failure (a Better Auth `{status,code,message}`
 * object OR a thrown Error), so connect failures show the REAL cause instead of a generic toast.
 * Cast-free: reads known fields via `in`/typeof narrowing.
 */
function describeAuthError(e: unknown): string {
	const parts: (string | number)[] = [];
	if (e && typeof e === "object") {
		if ("status" in e && typeof e.status === "number") parts.push(e.status);
		if ("code" in e && typeof e.code === "string" && e.code) parts.push(e.code);
		if ("message" in e && typeof e.message === "string" && e.message) parts.push(e.message);
	} else if (typeof e === "string" && e) {
		parts.push(e);
	}
	return parts.length ? parts.join(" ") : "unknown error";
}

interface ConnectorsPageProps {
	orgSlug: string;
	canManage: boolean;
	integrations: ConnectorWithConnection[];
	awsSetup: { identityId: string } | null;
	gcpSetup: { identityId: string } | null;
	azureSetup: { identityId: string } | null;
	extraSetup?: Record<string, { identityId: string; externalId?: string }>;
	/** Per-slug: does this instance have the platform creds the cloud's probe needs. */
	platformConfigured?: Record<string, boolean>;
}

export function ConnectorsPage({
	orgSlug,
	canManage,
	integrations,
	awsSetup: awsSetupProp,
	gcpSetup: gcpSetupProp,
	azureSetup: azureSetupProp,
	extraSetup: extraSetupProp,
	platformConfigured,
}: ConnectorsPageProps) {
	const router = useRouter();
	const queryClient = useQueryClient();
	const searchParams = useSearchParams();

	const [viewMode, setViewMode] = useState<ViewMode>("card");
	const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
	const [detailOpen, setDetailOpen] = useState(false);

	// ── The console filter standard (lib/query/README.md → "Server-side filters") ──────────
	// store → URL sync → debounce → normalize → key. The bar used to be a Radix <Select>
	// plus a raw <Input>, both banned; neither survived a navigation or a shared link.
	const filters = useConnectorFilters((s) => s.filters);
	const patchFilters = useConnectorFilters((s) => s.patch);
	const resetFilters = useConnectorFilters((s) => s.reset);
	useFilterUrlSync(useConnectorFilters, DEFAULT_CONNECTOR_FILTERS);
	const debouncedSearch = useDebouncedValue(filters.search);
	const query = useMemo(
		() => normalizeConnectorQuery({ ...filters, search: debouncedSearch }),
		[filters, debouncedSearch],
	);

	// Deep-link: `?type=cloud` (from the overview "Add new → Cloud") lands filtered to Clouds.
	// Declared after the URL sync so the store is already hydrated from the URL when it runs.
	const typeHandledRef = useRef(false);
	useEffect(() => {
		if (typeHandledRef.current) return;
		typeHandledRef.current = true;
		if (searchParams.get("type") === "cloud") patchFilters({ groups: ["clouds"] });
		// eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only deep link
	}, []);

	// The board's rows + facet counts. The key carries the NORMALIZED query so two equivalent
	// filter states share one cache entry.
	//
	// NOTE (follow-up, out of this lane's scope): `getConnectorsWithStatus()` takes no
	// arguments, so the selection and the facet tally run in the queryFn rather than in SQL.
	// `selectConnectors`/`buildConnectorFacets` are pure and take the same normalized query the
	// action would, so moving them server-side is a signature change in
	// `app/server/actions/connectors.ts` and nothing here.
	const { data: view, isPlaceholderData } = useQuery({
		queryKey: qk.connectors(orgSlug, query),
		queryFn: async () =>
			buildConnectorsView(
				await getConnectorsWithStatus(),
				query,
				platformConfigured ?? {},
			),
		placeholderData: keepPreviousData,
		staleTime: 30_000,
		// The pristine view is already on the wire as this RSC's props — seed it rather than
		// re-fetching a list the page was rendered with.
		initialData: isPristineQuery(query)
			? () => buildConnectorsView(integrations, query, platformConfigured ?? {})
			: undefined,
	});

	/** Re-read the board after a mutation: the RSC props AND every cached connectors key. */
	const refreshBoard = useCallback(() => {
		router.refresh();
		void queryClient.invalidateQueries({ queryKey: qk.connectors(orgSlug) });
	}, [router, queryClient, orgSlug]);

	// Passive refresh: pick up sweep-driven connection-status changes (connected → degraded/
	// disconnected, or backfilled inventory) without a manual reload, while the tab is visible.
	useEffect(() => {
		const id = setInterval(() => {
			if (document.visibilityState === "visible") refreshBoard();
		}, 30_000);
		return () => clearInterval(id);
	}, [refreshBoard]);

	// Connect/disconnect flows OUTSIDE this file (the cloud-connect sheets) refresh the route
	// rather than this query. New props are the signal that they did, so the cached views are
	// re-read too — otherwise a freshly connected cloud kept reading "Not connected".
	const lastIntegrationsRef = useRef(integrations);
	useEffect(() => {
		if (lastIntegrationsRef.current === integrations) return;
		lastIntegrationsRef.current = integrations;
		void queryClient.invalidateQueries({ queryKey: qk.connectors(orgSlug) });
	}, [integrations, orgSlug, queryClient]);

	// Cloud connect flow (AWS/GCP/Azure/extra) — shared with the create-project cloud picker.
	// Seeded from the RSC props, which are the freshest copy of the catalog on the page.
	const cloudConnect = useCloudConnect({
		integrations,
		awsSetup: awsSetupProp,
		gcpSetup: gcpSetupProp,
		azureSetup: azureSetupProp,
		extraSetup: extraSetupProp,
	});

	const [apiKeySlug, setApiKeySlug] = useState<string | null>(null);
	const [disconnectTarget, setDisconnectTarget] = useState<{
		integration: ConnectorWithConnection;
		identityId?: string;
	} | null>(null);
	const [isDisconnecting, setIsDisconnecting] = useState(false);
	const [connectingSlug, setConnectingSlug] = useState<string | null>(null);

	const rows = view?.rows ?? [];
	const facets = view?.facets ?? { groups: [], health: [], vendors: [] };

	// The selected connector is derived from the live list (by slug) so the manage
	// sheet reflects fresh data after a refresh (disconnect / rename / add).
	const selectedIntegration = useMemo(
		() => integrations.find((i) => i.slug === selectedSlug) ?? null,
		[integrations, selectedSlug],
	);

	/** Looks up a connector by slug — used to glyph the connect-sheet headers. */
	const bySlug = (slug: string | null | undefined) =>
		slug ? integrations.find((i) => i.slug === slug) : undefined;

	/** Initiates the connect flow (or adds another cloud account). */
	const handleConnect = async (integration: ConnectorWithConnection) => {
		setDetailOpen(false);
		const slug = integration.slug;
		track("connector_connect_started", { provider: slug, category: integration.category });

		// Route by connect flow, category-first. A chain of `if`s here previously let the token clouds
		// (category `cloud`, auth_method `api_key`) fall into the api_key branch and open a blank sheet.
		switch (connectRoute(integration)) {
			case "git": {
				setConnectingSlug(slug);
				try {
					const provider = asGitProvider(slug);
					// ABSOLUTE, not relative. Better Auth validates a callbackURL against trustedOrigins:
					// an absolute URL matches by ORIGIN (window.location.origin is trusted), while a
					// RELATIVE one is checked against an allow-list regex whose char class excludes `~` —
					// so `/${org}/~/connectors` (the org tilde-route) 403s as INVALID_CALLBACK_URL. This
					// only surfaced on link (the origin check runs when a session cookie is present),
					// which is why login worked but Connect didn't.
					const callbackURL = `${window.location.origin}/${orgSlug}/~/connectors`;
					// `oauth2.link` was deleted in 1.7; generic providers link through
					// linkSocial like any other. Only github needs an explicit scope.
					const { error } = await authClient.linkSocial({
						provider,
						...(provider === "github" ? { scopes: ["repo"] } : {}),
						callbackURL,
					});
					// A successful link auto-redirects (Better Auth's redirect plugin), so reaching here
					// with an `error` — or a thrown exception — is always a failure. Hand the FULL error
					// object to the catch so we surface + capture its real status/code/message.
					if (error) throw error;
				} catch (err) {
					const detail = describeAuthError(err);
					// Report it: connector link failures were previously swallowed (generic toast only,
					// no capture), so they never reached PostHog and couldn't be diagnosed.
					captureException(err, { area: "connectors", provider: slug });
					console.error(`Error connecting ${slug}:`, err);
					toast.error(`Failed to connect ${integration.name}: ${detail}`);
				} finally {
					setConnectingSlug(null);
				}
				return;
			}
			case "cloud":
				// aws/gcp/azure AND the token clouds (hetzner/civo/digitalocean) → the shared sheet.
				await cloudConnect.openConnect(integration);
				return;
			case "api_key":
				setApiKeySlug(slug);
				return;
		}
	};

	// Deep-link: `?connect=<slug>` (e.g. from elench's connect action) auto-opens the connect sheet once,
	// then clears the param so a refresh doesn't reopen it. handleConnect routes by category.
	const connectHandledRef = useRef(false);
	useEffect(() => {
		if (connectHandledRef.current || !canManage) return;
		const slug = searchParams.get("connect");
		if (!slug) return;
		connectHandledRef.current = true;
		const integration = integrations.find((i) => i.slug === slug);
		router.replace(`/${orgSlug}/~/connectors`, { scroll: false });
		// Don't auto-open a connect sheet for a connector that can't be connected yet — a `coming_soon`
		// cloud (DO/Civo) has no provisioning templates, so connecting it would be a dead end.
		if (integration && integration.status !== "coming_soon") {
			void handleConnect(integration);
		}
		// handleConnect is intentionally excluded — the ref makes this run once.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [searchParams, integrations, canManage, orgSlug, router]);

	const openManage = (integration: ConnectorWithConnection) => {
		setSelectedSlug(integration.slug);
		setDetailOpen(true);
	};

	/** Re-runs a failed cloud verification with the stored credentials (no re-entry). */
	const handleReverify = async (integration: ConnectorWithConnection) => {
		if (!integration.reverify_identity_id) return;
		setConnectingSlug(integration.slug);
		try {
			await reverifyCloudIdentity(integration.reverify_identity_id);
			toast.success(`Re-verifying ${integration.name}…`);
			refreshBoard();
		} catch (err) {
			toast.error(
				err instanceof Error ? err.message : `Failed to re-verify ${integration.name}`,
			);
		} finally {
			setConnectingSlug(null);
		}
	};

	/** Re-verifies one specific cloud account from the manage sheet (a provider can hold several, and
	 *  only some of them may be broken). */
	const handleReverifyAccount = async (identityId: string) => {
		try {
			await reverifyCloudIdentity(identityId);
			toast.success("Re-verifying…");
			refreshBoard();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Failed to re-verify");
		}
	};

	/** Renames a cloud account, then refreshes so the sheet shows the new name. */
	const handleRename = async (identityId: string, name: string) => {
		try {
			await renameCloudIdentity(identityId, name);
			toast.success("Account renamed.");
			refreshBoard();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Failed to rename");
		}
	};

	const confirmDisconnect = async () => {
		if (!disconnectTarget) return;
		const { integration, identityId } = disconnectTarget;
		setIsDisconnecting(true);
		try {
			const cloudId =
				identityId ?? integration.connection_details?.cloud_identity_id;
			if (integration.category === "git") {
				const result = await deleteProviderToken(
					asGitProvider(integration.slug),
				);
				if (result.error) throw new Error(result.error);
			} else if (integration.slug === "aws") {
				if (!cloudId) throw new Error("Missing identity ID");
				await disconnectAwsIdentity(cloudId);
			} else if (integration.slug === "gcp") {
				if (!cloudId) throw new Error("Missing identity ID");
				await disconnectGcpIdentity(cloudId);
			} else if (integration.slug === "azure") {
				if (!cloudId) throw new Error("Missing identity ID");
				await disconnectAzureIdentity(cloudId);
			} else if (isEnumMember(integration.slug, EXTRA_CLOUDS)) {
				if (!cloudId) throw new Error("Missing identity ID");
				await disconnectExtraCloud(cloudId, integration.slug);
			} else if (integration.auth_method === "api_key") {
				const result = await deleteConnectorCredential(integration.slug);
				if (!result.ok) throw new Error(result.error);
			} else {
				// No branch matched — a new connector slug that nothing above handles. Fail loudly rather
				// than falling through to the success toast below having done nothing.
				throw new Error(
					`No disconnect path for ${integration.slug}. This is a bug — please report it.`,
				);
			}
			toast.success(`Disconnected ${integration.name}.`);
			setDisconnectTarget(null);
			refreshBoard();
		} catch (err) {
			console.error("Disconnect error:", err);
			// Surface the real reason. A ForbiddenError and a provider mismatch used to render as the
			// same opaque string, which made a failed disconnect impossible to act on.
			toast.error(
				err instanceof Error
					? err.message
					: `Failed to disconnect ${integration.name}`,
			);
		} finally {
			setIsDisconnecting(false);
		}
	};

	return (
		<>
			<div className="space-y-6">
				{/* No title — the sidebar entry you clicked and the breadcrumb both say
				    "Connectors". What is left is the count and the line that says what a
				    connector IS, neither of which the breadcrumb carries. */}
				<PageToolbar
					description="Credentials Alethia acts through — cloud accounts, git providers, registries, chart repos, secret stores, observability sinks and DNS."
					count={rows.length}
				/>

				<ConnectorsFilterBar
					facets={facets}
					end={
						<>
							<ViewToggle value={viewMode} onChange={setViewMode} />
							<a
								href="/docs/concepts/connectors"
								target="_blank"
								rel="noopener noreferrer"
								title="What are connectors?"
								className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border/60 bg-muted/20 text-muted-foreground transition-colors hover:text-foreground"
							>
								<BookOpen className="size-4" />
								<span className="sr-only">What are connectors?</span>
							</a>
						</>
					}
				/>

				{/* Dim while a newly-keyed view is still resolving — keepPreviousData keeps the
				    previous rows on screen instead of flashing a skeleton. */}
				<div className={cn("space-y-6", isPlaceholderData && "opacity-60")}>
					{GROUP_META.map((group) => {
						const items = rows.filter((i) => i.group === group.id);
						if (items.length === 0) return null;
						const connected = items.filter((i) => i.connected).length;
						const Icon = group.icon;
						return (
							<section key={group.id} className="space-y-3.5">
								<div className="flex items-center gap-3">
									<span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border/60 bg-muted/20 text-muted-foreground">
										<Icon className="size-3.5" />
									</span>
									<SectionHeading level={2} title={group.label} count={items.length} />
									<a
										href={group.docsHref}
										target="_blank"
										rel="noopener noreferrer"
										title={`Learn about ${group.label.toLowerCase()} connectors`}
										className="text-muted-foreground/70 transition-colors hover:text-foreground"
									>
										<BookOpen className="size-3.5" />
									</a>
									<span className="hidden max-w-[52ch] text-xs text-muted-foreground md:inline">
										{group.description}
									</span>
									<span className="ml-auto shrink-0 font-mono text-ui-2xs text-muted-foreground">
										{connected} connected
									</span>
								</div>

								{viewMode === "card" ? (
									<div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(280px,1fr))]">
										{items.map((integration) => (
											<ConnectorCard
												key={integration.id}
												integration={integration}
												canManage={canManage}
												platformConfigured={
													platformConfigured?.[integration.slug] ?? true
												}
												isConnecting={
													connectingSlug === integration.slug ||
													cloudConnect.connectingSlug === integration.slug
												}
												onConnect={() => handleConnect(integration)}
												onManage={() => openManage(integration)}
												onReverify={() => handleReverify(integration)}
											/>
										))}
									</div>
								) : (
									<div className="overflow-hidden rounded-xl border border-border/60">
										<Table>
											<TableHeader>
												<TableRow className="hover:bg-transparent">
													<TableHead>Connector</TableHead>
													<TableHead>Status</TableHead>
													<TableHead>Details</TableHead>
													<TableHead className="text-right">Action</TableHead>
												</TableRow>
											</TableHeader>
											<TableBody>
												{items.map((integration) => (
													<ConnectorRow
														key={integration.id}
														integration={integration}
														canManage={canManage}
														platformConfigured={
															platformConfigured?.[integration.slug] ?? true
														}
														isConnecting={
															connectingSlug === integration.slug ||
															cloudConnect.connectingSlug === integration.slug
														}
														onConnect={() => handleConnect(integration)}
														onManage={() => openManage(integration)}
														onReverify={() => handleReverify(integration)}
													/>
												))}
											</TableBody>
										</Table>
									</div>
								)}
							</section>
						);
					})}

					{rows.length === 0 && (
						<EmptyState
							className="border"
							icon={<SearchX />}
							title="No connectors match"
							description={`None of the ${view?.total ?? integrations.length} connectors in the catalog match these filters.`}
							action={
								<Button variant="outline" onClick={resetFilters}>
									Reset filters
								</Button>
							}
						/>
					)}
				</div>
			</div>

			<ConnectorDetailSheet
				integration={selectedIntegration}
				open={detailOpen}
				onOpenChange={setDetailOpen}
				canManage={canManage}
				platformConfigured={
					selectedIntegration
						? (platformConfigured?.[selectedIntegration.slug] ?? true)
						: true
				}
				isConnecting={
					selectedIntegration
						? connectingSlug === selectedIntegration.slug
						: false
				}
				onConnect={() =>
					selectedIntegration && handleConnect(selectedIntegration)
				}
				onDisconnectConnector={() =>
					selectedIntegration &&
					setDisconnectTarget({ integration: selectedIntegration })
				}
				onDisconnectAccount={(identityId) =>
					selectedIntegration &&
					setDisconnectTarget({ integration: selectedIntegration, identityId })
				}
				onReverifyAccount={handleReverifyAccount}
				onRenameAccount={handleRename}
			/>

			{cloudConnect.sheets}

			{/* api_key Connection Sheet */}
			<Sheet
				open={!!apiKeySlug}
				onOpenChange={(open) => {
					if (!open) {
						setApiKeySlug(null);
						refreshBoard();
					}
				}}
			>
				<SheetContent
					side="right"
					className="w-full overflow-y-auto p-0 sm:max-w-md"
				>
					{apiKeySlug &&
						(() => {
							const provider = getConnectorProviderBySlug(apiKeySlug);
							if (!provider) return null;
							return (
								<>
									<ConnectSheetHeader
										integration={bySlug(apiKeySlug)}
										title={`Connect ${provider.name}`}
										description="Provide an API credential. It is encrypted at rest and shared with your organization."
									/>
									<div className="px-6 py-6">
										<ApiKeyConnection
											provider={provider}
											onConnected={() => setApiKeySlug(null)}
										/>
									</div>
								</>
							);
						})()}
				</SheetContent>
			</Sheet>

			{/* Disconnect confirmation */}
			<AlertDialog
				open={!!disconnectTarget}
				onOpenChange={(open) => !open && setDisconnectTarget(null)}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							Disconnect {disconnectTarget?.integration.name}?
						</AlertDialogTitle>
						<AlertDialogDescription>
							{disconnectTarget?.integration.category === "cloud"
								? "This removes the stored connection. You won't be able to provision new infrastructure with this account until you reconnect. Existing resources are not affected."
								: disconnectTarget?.integration.category === "git"
									? `This unlinks your ${disconnectTarget?.integration.name} account. You won't be able to access its repositories until you reconnect.`
									: "This removes the stored credential for the whole organization. You won't be able to use this connector until you reconnect."}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={isDisconnecting}>
							Cancel
						</AlertDialogCancel>
						<AlertDialogAction
							onClick={confirmDisconnect}
							disabled={isDisconnecting}
						>
							{isDisconnecting ? (
								<Loader2 className="mr-1.5 size-3.5 animate-spin" />
							) : (
								<Unplug className="mr-1.5 size-3.5" />
							)}
							Disconnect
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}
