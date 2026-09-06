// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { asRecord, toRecordArray } from "@/lib/records";
import { boolOr, numOr, toArray, toStr, toStrArray } from "@/lib/coerce";
import { tool } from "ai";
import { z } from "zod";
import { getRegionPrices } from "@/app/server/actions/pricing";
import {
	AUTOSCALER,
	CACHE_NODE_TYPES,
	CERT_OPTIONS,
	DB_CAPACITY,
	DB_ENGINES,
	DEFAULT_CACHE_NODE,
	DEFAULT_K8S_VERSION,
	DEFAULT_REGION,
	getProvider,
	INSTANCE_TYPES,
	K8S_VERSIONS,
	MESSAGING,
	NOSQL,
	PROVIDERS,
	REGION_LABELS,
	WAF_OPTIONS,
	type CloudProviderMeta,
	type CloudProviderSlug,
} from "@/lib/cloud-providers";
import { cidrForHosts } from "@/lib/cloud-providers/cidr";
import { CLOUD_PROVIDER_SLUGS } from "@/lib/cloud-providers/provider-slug";
import { computeCostItems } from "@/lib/cost/compute-cost-items";
import {
	ADDABLE_KINDS,
	addableKindsFor,
	NODE_REGISTRY,
} from "@/components/design-project/canvas/graph/node-registry";
import type { NodeKind } from "@/components/design-project/canvas/graph/types";
import type { CanvasContext } from "../canvas-context";
import { proposeChangesInputSchema } from "../proposal";

/** kind → its provider-specific service-name field (for list_services). */
const SERVICE_FIELD: Partial<Record<NodeKind, keyof CloudProviderMeta>> = {
	cluster: "clusterService",
	network: "networkName",
	database: "dbService",
	cache: "cacheService",
	queue: "queueService",
	topic: "topicService",
	nosql: "nosqlService",
	dns: "dnsService",
	secret: "secretsService",
};

/** The clouds a project can be provisioned on today — the AI reasons across all of them. */
const PROVISIONABLE_CLOUDS: CloudProviderSlug[] = [
	"aws",
	"gcp",
	"azure",
	"alibaba",
	"hetzner",
];

/**
 * Where a component actually runs on a given cloud. The big managed clouds (aws/gcp/azure/alibaba)
 * back each component with a **managed service**; compute-only **Hetzner** provisions only the
 * cluster + network natively and runs data/registry/dns as **in-cluster OSS Helm charts** (via
 * ArgoCD) — so the agent must reason about what will actually be deployed, not just a service name.
 */
function deploymentKind(
	kind: NodeKind,
	provider: CloudProviderSlug,
): "managed" | "in-cluster-helm" | "native" | "unsupported" {
	// Derived from the SAME UNSUPPORTED_KINDS_BY_PROVIDER set the Add-palette hides (via
	// addableKindsFor): a kind the provider's template can't provision is "unsupported", so the
	// agent won't propose it in the first place (the deploy-time guard in buildConfigSnapshot is
	// the backstop). Un-hide a kind there and this follows automatically.
	if (!addableKindsFor(provider).includes(kind)) return "unsupported";
	if (provider !== "hetzner") return "managed";
	if (kind === "cluster" || kind === "network") return "native";
	return "in-cluster-helm";
}

/**
 * Catalog tools — pure, provider-neutral lookups with NO canvas context. Shared by
 * BOTH the canvas assistant and the general agent: what services exist, each
 * provider's valid options, and CIDR sizing.
 */
export function catalogTools() {
	return {
		list_services: tool({
			description:
				"List the infrastructure services that can be added to the canvas. For each, gives every cloud's concrete service name (aws/gcp/azure/alibaba/hetzner) AND how it is deployed there — 'managed' (a managed cloud service), 'native' (cluster/network), 'in-cluster-helm' (Hetzner runs data as OSS Helm charts via ArgoCD — CloudNativePG, Valkey, RabbitMQ, Harbor, Vault, NATS, ScyllaDB), or 'unsupported' (that cloud's template can't provision this kind). Each entry also carries `unsupportedOn`: the clouds whose template can't provision that kind — do NOT propose a kind on a cloud listed there (today it is EMPTY — every cloud backs every kind). Use this to reason about what actually gets provisioned on each cloud.",
			inputSchema: z.object({}),
			execute: async () => ({
				services: ADDABLE_KINDS.map((kind) => {
					const field = SERVICE_FIELD[kind];
					return {
						kind,
						label: NODE_REGISTRY[kind].label,
						classification: NODE_REGISTRY[kind].classification,
						serviceNames: field
							? Object.fromEntries(
									PROVISIONABLE_CLOUDS.map((p) => [p, PROVIDERS[p][field]]),
								)
							: null,
						deployment: field
							? Object.fromEntries(
									PROVISIONABLE_CLOUDS.map((p) => [p, deploymentKind(kind, p)]),
								)
							: null,
						// Clouds whose built-in template can't provision this kind — derived from the
						// SAME set the Add-palette hides (addableKindsFor), so it can't drift.
						unsupportedOn: PROVISIONABLE_CLOUDS.filter(
							(p) => !addableKindsFor(p).includes(kind),
						),
					};
				}),
			}),
		}),

		list_service_options: tool({
			description:
				"Per-provider catalog of valid values: instance types, k8s versions, db engines + capacity model, cache node types, regions, nosql, messaging, autoscaler key, WAF/cert. Use this to map a request like 'size X' onto valid node configs/enums.",
			inputSchema: z.object({
				provider: z.enum(["aws", "gcp", "azure", "alibaba", "hetzner"]),
			}),
			execute: async ({ provider }) => {
				const p: CloudProviderSlug = provider;
				return {
					provider: p,
					default_region: DEFAULT_REGION[p],
					regions: Object.entries(REGION_LABELS[p] ?? {}).map(([code, meta]) => ({
						code,
						label: meta.label,
						group: meta.group,
					})),
					instance_types: INSTANCE_TYPES[p],
					k8s_versions: K8S_VERSIONS[p],
					default_k8s_version: DEFAULT_K8S_VERSION[p],
					autoscaler: AUTOSCALER[p],
					db_engines: DB_ENGINES[p],
					db_capacity: DB_CAPACITY[p],
					cache_node_types: CACHE_NODE_TYPES[p],
					default_cache_node: DEFAULT_CACHE_NODE[p],
					nosql: NOSQL[p],
					messaging: MESSAGING[p],
					waf_options: WAF_OPTIONS[p],
					cert_option: CERT_OPTIONS[p],
				};
			},
		}),

		cidr_for_hosts: tool({
			description:
				"Compute the smallest VPC CIDR block that fits N hosts AND that the target cloud's " +
				"template can still carve its subnets out of. Pass `cloud` whenever it is known — the " +
				"clouds disagree (AWS and Azure need a /18 or wider, Hetzner a /22, Alibaba a /28), and " +
				"the apply gate rejects a network below its cloud's floor. Without `cloud` the answer is " +
				"widened to a /18 so it is valid everywhere. Pass the result as the network node's cidr_block.",
			inputSchema: z.object({
				hosts: z.number().int().positive(),
				base: z.string().optional(),
				cloud: z.enum(CLOUD_PROVIDER_SLUGS).optional(),
			}),
			execute: async ({ hosts, base, cloud }) => cidrForHosts(hosts, base, cloud),
		}),
	};
}

/**
 * Canvas-building tools = the catalog + cost estimation + the propose-changes
 * proposal. estimate_cost/propose_changes close over the request's canvas context;
 * mutations are PROPOSED only (applied client-side after the user accepts).
 */
export function composeTools(ctx: CanvasContext | undefined) {
	return {
		...catalogTools(),

		estimate_cost: tool({
			description:
				"Estimate the monthly cost of the current canvas (uses live region prices when a region is set).",
			inputSchema: z.object({}),
			execute: async () => {
				if (!ctx) return { error: "No canvas context available." };
				const f = ctx.form;
				const cluster = asRecord(f.cluster);
				const network = asRecord(f.network);
				const dnsCfg = asRecord(asRecord(f.dns).provider_config);
				const project = asRecord(f.project);
				const region = toStr(project.region);
				const prices = region ? await getRegionPrices(region) : null;
				const meta = getProvider(ctx.provider);
				const { items, total } = computeCostItems(
					{
						instanceTypes: toStrArray(cluster.instance_types),
						nodeDesiredSize: numOr(cluster.node_desired_size, 2),
						singleNatGateway: boolOr(network.single_nat_gateway, true),
						databases: toRecordArray(f.databases),
						caches: toRecordArray(f.caches),
						cloudfrontWaf: Boolean(dnsCfg.cloudfront_waf),
						applicationWaf: Boolean(dnsCfg.application_waf),
						nosqlCount: toArray(f.nosql_tables).length,
						secretsCount: toArray(f.secrets).length,
					},
					prices,
					{
						clusterService: meta.clusterService,
						secretsService: meta.secretsService,
					},
				);
				return {
					region: region || "(none selected)",
					currency: "USD",
					monthly_total: Math.round(total),
					items: items.map((i) => ({
						label: i.label,
						monthly: Math.round(i.cost),
						detail: i.detail,
					})),
				};
			},
		}),

		propose_changes: tool({
			description:
				"Propose one or more canvas changes (e.g. add a database) for the user to accept or dismiss. Use add_node for new resources; reference existing node ids (from the canvas summary) for set_identity/update_config.",
			inputSchema: proposeChangesInputSchema,
			// No execute (HITL) — the user accepts client-side, applying the actions to the
			// canvas; the accepted outcome returns via addToolResult so the model continues.
		}),
	};
}
