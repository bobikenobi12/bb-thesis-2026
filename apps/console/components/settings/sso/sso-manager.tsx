"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Settings · Single Sign-On. A REAL multi-provider list (the old page rendered providers[0] only,
// silently hiding every other IdP), with server-side search + type/status facets, a working domain
// -verification card, a real connection test, and edit/delete. The fake "Require SSO" toggle and the
// fake SCIM card (which advertised a /scim/v2 URL that never existed) are gone — SCIM is an honest
// "talk to us" note instead.

import { CheckCircle2, KeyRound, Pencil, Plus, ShieldCheck, Trash2, XCircle } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
	deleteSsoProvider,
	requestSsoDomainVerification,
	type SsoBootstrap,
	type SsoProviderRow,
	type SsoTestResult,
	testSsoProvider,
	verifySsoDomain,
} from "@/app/server/actions/sso";
import { FeatureUpsell } from "@/components/settings/upgrade/feature-upsell";
import { legalUrl } from "@/lib/legal";
import { useInvalidateSso, useSsoProvidersQuery } from "@/lib/query/use-sso-query";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useFilterUrlSync } from "@/hooks/use-filter-url-sync";
import { countActiveFilters } from "@/lib/stores/create-filter-store";
import { useSsoFilters } from "@/lib/stores/use-settings-filters";
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
import { CopyButton } from "@repo/ui/copy-button";
import { EmptyState } from "@repo/ui/empty";
import { FacetFilter } from "@repo/ui/facet-filter";
import { FilterBar, FilterBarReset } from "@repo/ui/filter-bar";
import { FilterSearch } from "@repo/ui/filter-search";
import { PageToolbar } from "@repo/ui/page-toolbar";
import { Spinner } from "@repo/ui/spinner";
import { StatusBadge } from "@repo/ui/status-badge";
import { cn } from "@repo/ui/utils";
import {
	DEFAULT_SSO_FILTERS,
	normalizeSsoQuery,
	SSO_STATUS_OPTIONS,
	SSO_TYPE_OPTIONS,
	ssoFacetCounts,
} from "./sso-filters";
import { ProviderSheet } from "./provider-sheet";

export function SsoManager({ bootstrap }: { bootstrap: SsoBootstrap }) {
	const { canManage, slug, origin } = bootstrap;
	const invalidate = useInvalidateSso();

	// Filter state: the store is the source of truth, the URL mirrors it (shareable views),
	// and the free text is debounced before it can reach a query key. Eleven `useState` calls
	// collapse to one store plus the four that hold selection / dialog state, not filters.
	const filters = useSsoFilters((s) => s.filters);
	const set = useSsoFilters((s) => s.set);
	const reset = useSsoFilters((s) => s.reset);
	useFilterUrlSync(useSsoFilters, DEFAULT_SSO_FILTERS);
	const search = useDebouncedValue(filters.search);
	const query = useMemo(
		() => normalizeSsoQuery(filters, search),
		[filters, search],
	);

	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [sheetOpen, setSheetOpen] = useState(false);
	const [editing, setEditing] = useState<SsoProviderRow | null>(null);
	const [deleting, setDeleting] = useState<SsoProviderRow | null>(null);

	// Filtered SERVER-SIDE by `listSsoProviders`.
	const { data: providers = [], isFetching } = useSsoProvidersQuery(query);
	// The UNFILTERED universe, purely for the facet counts — the base key, which the page
	// prefetches. An option whose count came from the current result would disappear the
	// moment you selected it, which is exactly what the standard forbids.
	const { data: universe = [] } = useSsoProvidersQuery();
	const counts = useMemo(() => ssoFacetCounts(universe), [universe]);
	const activeFilters = countActiveFilters(filters, DEFAULT_SSO_FILTERS);

	// Enterprise gate — the whole surface is replaced by the upsell.
	if (!bootstrap.sso) return <FeatureUpsell feature="sso" />;

	const selected =
		providers.find((p) => p.id === selectedId) ?? providers[0] ?? null;

	function connect() {
		setEditing(null);
		setSheetOpen(true);
	}

	async function confirmDelete(p: SsoProviderRow) {
		try {
			await deleteSsoProvider(p.id);
			toast.success("Provider removed");
			setDeleting(null);
			setSelectedId(null);
			invalidate();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Couldn't remove the provider");
		}
	}

	return (
		<div className="space-y-4">
			<PageToolbar
				description="Identity providers your members can sign in through."
				count={providers.length}
				actions={
					<Button size="sm" disabled={!canManage} onClick={connect}>
						<Plus size={13} />
						Connect provider
					</Button>
				}
			/>

			<FilterBar
				end={isFetching ? <Spinner className="size-3.5 text-text-tertiary" /> : undefined}
			>
				<FilterSearch
					value={filters.search}
					onChange={(v) => set("search", v)}
					placeholder="Search providers…"
					className="w-[240px] max-w-[380px] flex-1"
				/>
				<FacetFilter
					label="Protocol"
					icon={KeyRound}
					options={SSO_TYPE_OPTIONS.map((o) => ({
						value: o.value,
						label: o.label,
						hint: String(counts.types[o.value] ?? 0),
					}))}
					value={filters.types}
					onChange={(next) => set("types", next)}
					searchPlaceholder="Filter protocol…"
					emptyText="No protocols."
				/>
				<FacetFilter
					label="Status"
					icon={ShieldCheck}
					options={SSO_STATUS_OPTIONS.map((o) => ({
						value: o.value,
						label: o.label,
						hint: String(counts.statuses[o.value] ?? 0),
					}))}
					value={filters.statuses}
					onChange={(next) => set("statuses", next)}
					searchPlaceholder="Filter status…"
					emptyText="No statuses."
				/>
				<FilterBarReset count={activeFilters} onReset={reset} />
			</FilterBar>

			{providers.length === 0 ? (
				<EmptyState
					className="border border-border bg-surface"
					icon={<KeyRound />}
					title={
						activeFilters > 0
							? "No matching providers"
							: "No identity provider connected"
					}
					description={
						activeFilters > 0
							? "No identity provider matches these filters."
							: "Connect your IdP (Okta, Entra ID, OneLogin…) so your team signs in with SSO."
					}
					action={
						activeFilters > 0 ? (
							<Button variant="outline" size="sm" onClick={reset}>
								Clear filters
							</Button>
						) : (
							<Button size="sm" disabled={!canManage} onClick={connect}>
								<Plus size={13} />
								Connect provider
							</Button>
						)
					}
				/>
			) : (
				<div className="grid grid-cols-1 gap-4 lg:grid-cols-[280px_1fr]">
					<div className="rounded-lg border border-border bg-surface p-2 shadow-sm">
						{providers.map((p) => (
							<button
								key={p.id}
								type="button"
								onClick={() => setSelectedId(p.id)}
								className={cn(
									"flex w-full items-center gap-2.5 rounded-sm px-2.5 py-2 text-left transition-colors",
									selected?.id === p.id
										? "bg-surface-muted"
										: "hover:bg-surface-muted/60",
								)}
							>
								<span className="min-w-0 flex-1">
									<span className="block truncate text-ui-md text-text-primary">
										{p.providerId}
									</span>
									<span className="block truncate font-mono text-ui-2xs text-text-tertiary">
										{p.type === "unknown" ? "misconfigured" : p.type} · {p.domain}
									</span>
								</span>
								{/* Domain verification is the thing that gates sign-in, so it reads
								    through the SHARED status device rather than a local pill. */}
								<StatusBadge
									className="shrink-0"
									status={p.domainVerified ? "verified" : "pending"}
									tier={p.domainVerified ? "active" : "pending"}
									label={p.domainVerified ? "Verified" : "Pending"}
								/>
							</button>
						))}
					</div>

					{selected && (
						<ProviderDetail
							key={selected.id}
							provider={selected}
							origin={origin}
							slug={slug}
							canManage={canManage}
							onEdit={() => {
								setEditing(selected);
								setSheetOpen(true);
							}}
							onDelete={() => setDeleting(selected)}
							onChanged={invalidate}
						/>
					)}
				</div>
			)}

			{/* SCIM — honest. The old page advertised a /scim/v2/<tenant> URL that did not exist. */}
			<div className="rounded-lg border border-border bg-surface px-5 py-4 shadow-sm">
				<p className="text-ui-md font-medium text-text-primary">SCIM provisioning</p>
				<p className="mt-1 text-ui-sm text-text-secondary">
					Automatic user provisioning/deprovisioning from your IdP isn&apos;t available
					yet — SSO users are provisioned just-in-time on first sign-in. If SCIM is a
					requirement,{" "}
					<a
						href={legalUrl("/contact/sales")}
						target="_blank"
						rel="noreferrer"
						className="underline underline-offset-2 hover:text-text-primary"
					>
						talk to us
					</a>
					.
				</p>
			</div>

			<ProviderSheet
				open={sheetOpen}
				onOpenChange={setSheetOpen}
				provider={editing}
				canManage={canManage}
				onSaved={invalidate}
			/>

			<AlertDialog
				open={deleting !== null}
				onOpenChange={(o) => !o && setDeleting(null)}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Remove this identity provider?</AlertDialogTitle>
						<AlertDialogDescription>
							Members who sign in through <strong>{deleting?.providerId}</strong> will
							no longer be able to. Their accounts and memberships are kept. This cannot
							be undone.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction
							onClick={() => deleting && void confirmDelete(deleting)}
							className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
						>
							Remove provider
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	);
}

/** A copyable key/value row. */
function KvRow({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex items-start justify-between gap-3 border-b border-border px-4 py-2.5 last:border-b-0">
			<span className="shrink-0 text-ui-sm text-text-tertiary">{label}</span>
			<span className="flex min-w-0 items-center gap-1.5">
				<span className="truncate font-mono text-ui-xs text-text-secondary">{value}</span>
				<CopyButton text={value} />
			</span>
		</div>
	);
}

function ProviderDetail({
	provider: p,
	origin,
	slug,
	canManage,
	onEdit,
	onDelete,
	onChanged,
}: {
	provider: SsoProviderRow;
	origin: string;
	slug: string;
	canManage: boolean;
	onEdit: () => void;
	onDelete: () => void;
	onChanged: () => void;
}) {
	const [test, setTest] = useState<SsoTestResult | null>(null);
	const [busy, setBusy] = useState<"test" | "token" | "verify" | null>(null);
	const [dns, setDns] = useState<{ record: string; token: string } | null>(null);

	async function runTest() {
		setBusy("test");
		try {
			setTest(await testSsoProvider(p.id));
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Test failed");
		} finally {
			setBusy(null);
		}
	}

	async function getToken() {
		setBusy("token");
		try {
			setDns(await requestSsoDomainVerification(p.id));
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Couldn't mint a token");
		} finally {
			setBusy(null);
		}
	}

	async function verify() {
		setBusy("verify");
		try {
			await verifySsoDomain(p.id);
			toast.success("Domain verified — SSO sign-in is now enabled");
			onChanged();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Couldn't verify the domain yet");
		} finally {
			setBusy(null);
		}
	}

	return (
		<div className="space-y-4">
			<div className="rounded-lg border border-border bg-surface shadow-sm">
				<div className="flex items-start justify-between gap-3 px-5 py-4">
					<div className="min-w-0">
						<div className="flex items-center gap-2">
							<span className="text-ui-lg font-semibold text-text-primary">
								{p.providerId}
							</span>
							{/* Third local status pill in this file, folded into the shared device. */}
							<StatusBadge
								status={p.domainVerified ? "connected" : "pending"}
								tier={p.domainVerified ? "active" : "pending"}
								label={p.domainVerified ? "Connected" : "Pending domain"}
							/>
						</div>
						<p className="mt-1 font-mono text-ui-xs text-text-tertiary">
							{p.type === "saml"
								? "SAML 2.0"
								: p.type === "oidc"
									? "OIDC"
									: "misconfigured"}{" "}
							· {p.domain}
						</p>
					</div>
					<div className="flex shrink-0 items-center gap-2">
						<Button
							variant="outline"
							size="sm"
							disabled={!canManage || busy !== null}
							onClick={() => void runTest()}
						>
							{busy === "test" ? "Testing…" : "Test connection"}
						</Button>
						<Button
							variant="outline"
							size="sm"
							aria-label="Edit provider"
							disabled={!canManage}
							onClick={onEdit}
						>
							<Pencil size={13} />
						</Button>
						<Button
							variant="outline"
							size="sm"
							aria-label="Remove provider"
							disabled={!canManage}
							onClick={onDelete}
						>
							<Trash2 size={13} />
						</Button>
					</div>
				</div>
				{test && (
					<div className="border-t border-border px-5 py-3">
						{test.checks.map((c) => (
							<div key={c.id} className="flex items-start gap-2 py-1">
								{c.ok ? (
									<CheckCircle2 size={13} className="mt-0.5 shrink-0 text-text-secondary" />
								) : (
									<XCircle size={13} className="mt-0.5 shrink-0 text-destructive" />
								)}
								<span className="text-ui-sm text-text-secondary">
									{c.label}
									<span className="ml-1.5 font-mono text-ui-xs text-text-tertiary">
										{c.detail}
									</span>
								</span>
							</div>
						))}
					</div>
				)}
			</div>

			{/* Domain verification — the thing that actually gates sign-in. */}
			{!p.domainVerified && (
				<div className="rounded-lg border border-border bg-surface shadow-sm">
					<div className="px-5 py-4">
						<p className="text-ui-md font-medium text-text-primary">
							Verify {p.domain}
						</p>
						<p className="mt-1 text-ui-sm text-text-secondary">
							Sign-in through this provider stays disabled until you prove you control
							the domain. Add this DNS TXT record, then verify.
						</p>
					</div>
					{dns && (
						<div className="border-t border-border">
							<KvRow label="Record" value={dns.record} />
							<KvRow label="Value" value={dns.token} />
						</div>
					)}
					<div className="flex items-center gap-2 border-t border-border bg-surface-sunken px-5 py-3">
						<Button
							variant="outline"
							size="sm"
							disabled={!canManage || busy !== null}
							onClick={() => void getToken()}
						>
							{busy === "token" ? "…" : dns ? "Re-issue record" : "Show DNS record"}
						</Button>
						<Button
							size="sm"
							disabled={!canManage || busy !== null}
							onClick={() => void verify()}
						>
							{busy === "verify" ? "Verifying…" : "Verify domain"}
						</Button>
					</div>
				</div>
			)}

			{/* What the IdP admin needs from us. */}
			<div className="rounded-lg border border-border bg-surface shadow-sm">
				<div className="px-4 py-2.5 font-mono text-ui-3xs uppercase tracking-[0.12em] text-text-tertiary">
					Service provider details
				</div>
				<div className="border-t border-border">
					{p.type === "saml" ? (
						<>
							<KvRow label="ACS URL" value={`${origin}/api/auth/sso/saml2/sp/acs`} />
							<KvRow
								label="SP metadata"
								value={`${origin}/api/auth/sso/saml2/sp/metadata`}
							/>
						</>
					) : (
						<KvRow
							label="Redirect URI"
							value={`${origin}/api/auth/sso/callback/${p.providerId}`}
						/>
					)}
					<KvRow label="Start URL" value={`${origin}/sso/${slug}`} />
				</div>
			</div>
		</div>
	);
}
