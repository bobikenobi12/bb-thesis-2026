"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Settings2 } from "lucide-react";
import { useMemo } from "react";
import { Button } from "@repo/ui/button";
import { Label } from "@repo/ui/label";
import { SectionHeading } from "@repo/ui/section-heading";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@repo/ui/sheet";
import { PROJECT_NODE_ID, useCanvasStore } from "@/lib/stores/use-canvas-store";
import {
	NATIVE_LABELS,
	environmentConnector,
	registryUnavailable,
	secretsStoreUnavailable,
} from "@/lib/canvas/environment-connector";
import { ConfigFields } from "./inspector/config-fields";
import { getKindConfig } from "./inspector/config-schema";
import { ConnectorSelect } from "./inspector/connector-select";
import { useNodeCapabilities } from "./inspector/use-node-capabilities";
import { CompatAlert } from "./inspector/compat-alert";

/**
 * W2 — the cluster + network are no longer cards on the board (one environment IS one cluster inside
 * one VPC). They stay env-scoped DB singletons, edited here as environment settings. The rows persist
 * as hidden store nodes, so this edits them through the SAME `updateNodeConfig` + `CONFIG_SCHEMA`
 * the inspector used — graphToForm / the deploy snapshot are unchanged.
 *
 * The secret store joined them (#1412): it is env-level for the same reason, since the runtime reads
 * one store per environment. It is the one section NOT driven by `CONFIG_SCHEMA`, because unlike
 * cluster/network it has no singleton row to hang a schema off — the choice lives on the secret rows
 * themselves and is written through to all of them.
 *
 * "Per environment" needs no control here: the canvas is already scoped to one environment by the
 * topbar `EnvSwitcher` (`?environment_id=`), and the board is remounted when it changes. Switching
 * there switches which environment this sheet is editing.
 */
export function EnvSettingsSheet() {
	// Open state lives in the store, not here, so the Secrets panel's "Store · …" readout can send
	// you straight to the control that changes it.
	const open = useCanvasStore((s) => s.envSettingsOpen);
	const setOpen = useCanvasStore((s) => s.setEnvSettingsOpen);
	const nodes = useCanvasStore((s) => s.nodes);
	const updateNodeConfig = useCanvasStore((s) => s.updateNodeConfig);
	const provider = useCanvasStore((s) => s.getEffectiveProvider(PROJECT_NODE_ID));

	const secretsStore = environmentConnector(nodes, "secret");
	const secretNodes = nodes.filter((n) => n.data.kind === "secret");
	const registryStore = environmentConnector(nodes, "registry");
	const registryNodes = nodes.filter((n) => n.data.kind === "registry");

	const cluster = nodes.find((n) => n.data.kind === "cluster");
	const network = nodes.find((n) => n.data.kind === "network");
	const clusterSchema = getKindConfig("cluster");
	const networkSchema = getKindConfig("network");

	// Cluster and network are env-level singletons, but each resolves through its OWN node so a
	// per-resource placement override is honoured rather than silently reading the project's account.
	const clusterCaps = useNodeCapabilities(cluster?.id ?? null);

	// The compat subject, assembled from the store — no new query. `addon` nodes are the environment's
	// enabled marketplace installs; the config-time resolver also sees Hetzner data services and BYO
	// charts, which is why CompatAlert never claims a clean bill of health.
	const clusterK8s =
		cluster && "cluster_version" in cluster.data.config &&
		typeof cluster.data.config.cluster_version === "string"
			? cluster.data.config.cluster_version || undefined
			: undefined;
	const addonIds = useMemo(
		() =>
			nodes
				.filter((n) => n.data.kind === "addon")
				.map((n) => ("id" in n.data.config && typeof n.data.config.id === "string" ? n.data.config.id : ""))
				.filter(Boolean),
		[nodes],
	);
	const networkCaps = useNodeCapabilities(network?.id ?? null);

	return (
		<>
			<Button
				type="button"
				size="sm"
				variant="outline"
				className="h-8 text-xs"
				onClick={() => setOpen(true)}
			>
				<Settings2 className="mr-1 h-3.5 w-3.5" />
				Environment settings
			</Button>
			<Sheet open={open} onOpenChange={setOpen}>
				<SheetContent className="w-[440px] overflow-y-auto sm:max-w-[440px]">
					<SheetHeader>
						<SheetTitle>Environment settings</SheetTitle>
						<SheetDescription>
							Settings that belong to this environment as a whole rather than to any one card —
							its cluster and VPC (one environment is one cluster, and everything on the board
							deploys into it), and where its secrets are read from.
						</SheetDescription>
					</SheetHeader>
					<div className="mt-5 space-y-6 px-1">
						{cluster && clusterSchema && (
							<section className="space-y-2">
								<SectionHeading level={3} title="Cluster" />
						{/* Compat sits next to the Kubernetes version that causes it (#1221). Silent unless
						    something actually fails — see CompatAlert's two honesty rules. */}
						<CompatAlert
							provider={provider}
							k8sVersion={clusterK8s}
							addonIds={addonIds}
						/>
								<ConfigFields
									schema={clusterSchema}
									config={cluster.data.config}
									provider={provider}
									kind="cluster"
									capabilities={clusterCaps}
									onChange={(patch) => updateNodeConfig(cluster.id, patch)}
								/>
							</section>
						)}
						{network && networkSchema && (
							<section className="space-y-2">
								<SectionHeading level={3} title="Network (VPC)" />
								<ConfigFields
									schema={networkSchema}
									config={network.data.config}
									provider={provider}
									kind="network"
									capabilities={networkCaps}
									onChange={(patch) => updateNodeConfig(network.id, patch)}
								/>
							</section>
						)}
						<section className="space-y-2">
							{/* A Label rather than the `SectionHeading` cluster/network use, so the select has
							    an accessible name — it is the only control in this section, and "Secrets" is
							    exactly what names it. It carries `SectionHeading`'s own rung (`--text-ui-lg`,
							    medium, tight) so all four sections still read alike, which is the whole
							    reason that heading has ONE size at every level. */}
							<Label
								htmlFor="env-secrets-store"
								className="text-ui-lg font-medium tracking-tight"
							>
								Secrets
							</Label>
							{secretNodes.length === 0 ? (
								<p className="text-xs text-muted-foreground">
									Add a secret to choose where this environment&apos;s secrets are read from.
								</p>
							) : (
								<>
									<ConnectorSelect
										id="env-secrets-store"
										category="secrets"
										value={secretsStore.provider}
										providerConfig={secretsStore.providerConfig}
										// The cluster's own secret store is the default and must stay reachable —
										// a project that tried Vault has to be able to go back.
										nativeOption={{
											label: NATIVE_LABELS.secret,
											description: "cloud secret manager",
										}}
										unavailable={(p) => secretsStoreUnavailable(p.slug)}
										// WRITE-THROUGH: one store per environment, so the choice goes to every
										// secret row. Leaving the others behind would mean the database says two
										// different things while the deploy silently picks one (dominantProvider),
										// which is exactly the ambiguity this control exists to remove.
										onChange={(patch) => {
											for (const node of secretNodes) updateNodeConfig(node.id, patch);
										}}
									/>
									<p className="text-xs text-muted-foreground">
										Applies to all {secretNodes.length}{" "}
										{secretNodes.length === 1 ? "secret" : "secrets"} in this environment — one
										environment reads through one store.
									</p>
								</>
							)}
						</section>
						<section className="space-y-2">
							<Label
								htmlFor="env-registry"
								className="text-ui-lg font-medium tracking-tight"
							>
								Container registry
							</Label>
							{registryNodes.length === 0 ? (
								<p className="text-xs text-muted-foreground">
									Add a container registry to choose where this environment&apos;s images are
									pushed and pulled from.
								</p>
							) : (
								<>
									<ConnectorSelect
										id="env-registry"
										category="registry"
										value={registryStore.provider}
										providerConfig={registryStore.providerConfig}
										// The cloud's own registry (ECR / Artifact Registry / ACR) is the default,
										// and a credential-based connector REPLACES it — so going back must be
										// possible.
										nativeOption={{
											label: NATIVE_LABELS.registry,
											description: "ECR / Artifact Registry / ACR",
										}}
										unavailable={(p) => registryUnavailable(p.slug)}
										// WRITE-THROUGH: dominantProvider takes the first pluggable row's slug for
										// the whole project and there is exactly ONE pull secret, so a row left
										// behind would have its images pulled with a credential for another
										// registry — an ImagePullBackOff against a secret that exists.
										onChange={(patch) => {
											for (const node of registryNodes) {
												// `provider_config` may be replaced whole now. It used to also carry
												// this row's OWN cloud-registry settings (immutable tags, scanning),
												// which are per row while the provider is per environment, so the
												// patch had to be merged over them or two registries' distinct
												// settings were flattened on any provider change. Those two became
												// typed columns in #1811, and this write never touches them.
												updateNodeConfig(node.id, {
													provider: patch.provider,
													provider_config: patch.provider_config,
												});
											}
										}}
									/>
									<p className="text-xs text-muted-foreground">
										Applies to all {registryNodes.length}{" "}
										{registryNodes.length === 1 ? "registry" : "registries"} in this environment
										— one environment pushes through one registry.
									</p>
								</>
							)}
						</section>
					</div>
				</SheetContent>
			</Sheet>
		</>
	);
}
