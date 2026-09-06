// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// MCP/AI compose tools (lib/ai/tools/compose.ts). Mocked boundary: the only impure dep is the
// pricing server action (getRegionPrices — fetch/cache). Everything else (cloud-provider data maps,
// cidrForHosts, computeCostItems, the proposal zod schema, node-registry) is kept REAL so the
// catalog/cost/proposal logic is exercised end-to-end through the real tool wiring.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/app/server/actions/pricing", () => ({ getRegionPrices: vi.fn() }));

import { catalogTools, composeTools } from "@/lib/ai/tools/compose";
import { getRegionPrices, type RegionPrices } from "@/app/server/actions/pricing";
import { ADDABLE_KINDS } from "@/components/design-project/canvas/graph/node-registry";
import type { CanvasContext } from "@/lib/ai/canvas-context";

/** Invoke a `tool()`'s execute with throwaway ToolCallOptions. */
const run = <T>(t: { execute?: unknown }, input: T) =>
	(t.execute as (input: T, opts: unknown) => Promise<unknown>)(input, {
		toolCallId: "call-1",
		messages: [],
	});

beforeEach(() => {
	vi.clearAllMocks();
});

describe("catalogTools.list_services", () => {
	it("lists one entry per addable kind with label + classification", async () => {
		const out = (await run(catalogTools().list_services, {})) as {
			services: Array<{ kind: string; label: string; classification: string; serviceNames: unknown }>;
		};
		expect(out.services).toHaveLength(ADDABLE_KINDS.length);
		expect(out.services.map((s) => s.kind).sort()).toEqual([...ADDABLE_KINDS].sort());
		for (const s of out.services) {
			expect(typeof s.label).toBe("string");
			expect(s.label.length).toBeGreaterThan(0);
			expect(typeof s.classification).toBe("string");
		}
	});

	it("maps a kind with a service field to per-cloud concrete names (database → Aurora/…)", async () => {
		const out = (await run(catalogTools().list_services, {})) as {
			services: Array<{ kind: string; serviceNames: Record<string, string> | null }>;
		};
		const db = out.services.find((s) => s.kind === "database");
		expect(db?.serviceNames).toEqual({
			aws: "Aurora",
			gcp: expect.any(String),
			azure: expect.any(String),
			alibaba: expect.any(String),
			hetzner: expect.any(String),
		});
	});

	it("emits null serviceNames for a kind with no provider service field (repositories)", async () => {
		const out = (await run(catalogTools().list_services, {})) as {
			services: Array<{ kind: string; serviceNames: unknown }>;
		};
		expect(out.services.find((s) => s.kind === "repositories")?.serviceNames).toBeNull();
	});

	it("reports NO kind as unprovisionable on any cloud (unsupportedOn), so the agent stops refusing kinds the product backs", async () => {
		const out = (await run(catalogTools().list_services, {})) as {
			services: Array<{
				kind: string;
				deployment: Record<string, string> | null;
				unsupportedOn: string[];
			}>;
		};
		const svc = (kind: string) => out.services.find((s) => s.kind === kind);
		// NOTHING is flagged on Hetzner any more. nosql was the last one and left with #3228, when
		// cert-manager's install gate stopped being the same question as its ISSUE gate — topic
		// (NATS), registry (#2431) and secret (#2432) had gone before it.
		//
		// This matters more here than on the other boards: `unsupportedOn` is prose an AGENT acts
		// on, so a stale flag makes the model refuse a kind the product backs.
		expect(svc("nosql")?.unsupportedOn).toEqual([]);
		expect(svc("nosql")?.unsupportedOn).not.toContain("aws");
		expect(svc("topic")?.unsupportedOn).toEqual([]);
		expect(svc("bucket")?.unsupportedOn).not.toContain("hetzner");
		// The MODE is asserted too, not just `unsupportedOn`: topic must read as in-cluster on
		// Hetzner, which is the half that would silently regress if the derivation broke.
		expect(svc("topic")?.deployment?.hetzner).toBe("in-cluster-helm");
		// nosql now reads as in-cluster-helm on Hetzner too — a ScyllaCluster, not a refusal.
		expect(svc("nosql")?.deployment?.hetzner).toBe("in-cluster-helm");
		expect(svc("nosql")?.deployment?.aws).toBe("managed");
		// …while supported Hetzner kinds keep their real mode and an empty unsupportedOn there.
		// (cluster/network are no longer addable services — W2 made them env settings.)
		expect(svc("database")?.deployment?.hetzner).toBe("in-cluster-helm");
		expect(svc("database")?.unsupportedOn).not.toContain("hetzner");
		expect(svc("cluster")).toBeUndefined();
	});
});

describe("catalogTools.list_service_options", () => {
	it("returns the real per-provider catalog for aws", async () => {
		const out = (await run(catalogTools().list_service_options, { provider: "aws" as const })) as {
			provider: string;
			default_region: string;
			regions: Array<{ code: string; label: string; group: string }>;
			instance_types: string[];
			default_k8s_version: string;
			db_engines: unknown;
		};
		expect(out.provider).toBe("aws");
		expect(out.default_region).toBe("eu-west-1");
		expect(Array.isArray(out.instance_types)).toBe(true);
		expect(out.instance_types.length).toBeGreaterThan(0);
		expect(out.regions.length).toBeGreaterThan(0);
		expect(out.regions[0]).toEqual({
			code: expect.any(String),
			label: expect.any(String),
			group: expect.any(String),
		});
		expect(out.default_k8s_version).toBeTruthy();
	});

	it("switches the default region per provider (gcp)", async () => {
		const out = (await run(catalogTools().list_service_options, { provider: "gcp" as const })) as {
			provider: string;
			default_region: string;
		};
		expect(out.provider).toBe("gcp");
		expect(out.default_region).toBe("europe-west1");
	});
});

describe("catalogTools.cidr_for_hosts", () => {
	// #3670: the helper used to clamp to a hardcoded [16, 28] with no idea which cloud the answer
	// was for, so 511 hosts produced a /23 — which cloud.validateNetworkCIDR rejects on AWS, Azure
	// and Hetzner. It is exposed to users as an AI tool, so that answer was handed out as advice
	// and then refused by the apply gate.
	it("widens to the cloud's floor rather than handing back a block the apply gate refuses", async () => {
		const out = (await run(catalogTools().cidr_for_hosts, { hosts: 511, cloud: "aws" })) as {
			cidr: string;
			prefix: number;
			maxPrefix: number;
		};
		expect(out).toMatchObject({ cidr: "10.0.0.0/18", prefix: 18, maxPrefix: 18 });
	});

	it("uses the cloud's OWN floor, not one shared floor", async () => {
		const hetzner = (await run(catalogTools().cidr_for_hosts, { hosts: 511, cloud: "hetzner" })) as {
			prefix: number;
		};
		const gcp = (await run(catalogTools().cidr_for_hosts, { hosts: 511, cloud: "gcp" })) as {
			prefix: number;
		};
		// Hetzner carves down to /22 and GCP has no floor at all, so neither is widened to AWS's /18.
		// Both land on /22 here for different reasons: Hetzner because its floor binds, GCP because
		// 511 HOSTS needs 513 addresses and so does not fit a /23 at all.
		expect(hetzner.prefix).toBe(22);
		expect(gcp.prefix).toBe(22);
	});

	// The block is sized by HOSTS, and a block spends two addresses on network + broadcast. Sizing
	// by addresses answered /23 for 511 hosts — 510 usable, one short of what was asked for. AWS's
	// floor hid it; GCP and Alibaba, whose floors are looser than the fit, handed it straight out.
	it.each([
		["gcp", 511],
		["alibaba", 511],
		["aws", 511],
		["gcp", 254],
		["gcp", 2],
	])("returns a block that actually holds the hosts asked for (%s, %i)", async (cloud, hosts) => {
		const out = (await run(catalogTools().cidr_for_hosts, { hosts, cloud })) as {
			usableHosts: number;
		};
		expect(out.usableHosts).toBeGreaterThanOrEqual(hosts);
	});

	it("clamps to the tightest floor when no cloud is given, so the answer is valid everywhere", async () => {
		const out = (await run(catalogTools().cidr_for_hosts, { hosts: 511 })) as {
			cidr: string;
			prefix: number;
			cloud: string | null;
		};
		expect(out).toMatchObject({ cidr: "10.0.0.0/18", prefix: 18, cloud: null });
	});

	it("still lets the host count bind when it asks for more than the floor", async () => {
		const out = (await run(catalogTools().cidr_for_hosts, { hosts: 60000, cloud: "aws" })) as {
			prefix: number;
			maxPrefix: number;
			usableHosts: number;
		};
		// 60000 hosts needs a /16, which is already wider than AWS's /18 floor — so the answer comes
		// from the host count, not from the clamp. Without this the two cases above would be
		// satisfied by a helper that returned /18 for everything.
		expect(out).toMatchObject({ prefix: 16, maxPrefix: 18 });
		expect(out.usableHosts).toBeGreaterThanOrEqual(60000);
	});

	it("honors a custom base address", async () => {
		const out = (await run(catalogTools().cidr_for_hosts, { hosts: 10, base: "10.1.0.0" })) as {
			cidr: string;
		};
		expect(out.cidr.startsWith("10.1.0.0/")).toBe(true);
	});
});

describe("composeTools.estimate_cost", () => {
	it("returns an error and never prices when there is no canvas context", async () => {
		const out = (await run(composeTools(undefined).estimate_cost, {})) as { error?: string };
		expect(out.error).toBe("No canvas context available.");
		expect(getRegionPrices).not.toHaveBeenCalled();
	});

	it("estimates from fallback rates (no region) without calling the pricing action", async () => {
		const ctx: CanvasContext = { provider: "aws", form: {} };
		const out = (await run(composeTools(ctx).estimate_cost, {})) as {
			region: string;
			currency: string;
			monthly_total: number;
			items: Array<{ label: string; monthly: number }>;
		};
		expect(getRegionPrices).not.toHaveBeenCalled();
		expect(out.region).toBe("(none selected)");
		expect(out.currency).toBe("USD");
		expect(out.items.some((i) => i.label === "EKS Control Plane")).toBe(true);
		// fallback EKS control plane = 0.1 * 730 = 73 → contributes to a positive total
		expect(out.monthly_total).toBeGreaterThan(0);
		expect(Number.isInteger(out.monthly_total)).toBe(true);
	});

	it("uses the provider's cluster label and includes database line items", async () => {
		const ctx: CanvasContext = {
			provider: "gcp",
			form: { databases: [{ name: "primary", min_capacity: 1, max_capacity: 8 }] },
		};
		const out = (await run(composeTools(ctx).estimate_cost, {})) as {
			items: Array<{ label: string }>;
		};
		// getProvider("gcp").clusterService === "GKE"
		expect(out.items.some((i) => i.label === "GKE Control Plane")).toBe(true);
		expect(out.items.some((i) => i.label === "DB: primary")).toBe(true);
	});

	it("fetches live region prices when a region is set and rounds the total", async () => {
		const prices: RegionPrices = {
			eksControlPlane: 0.1,
			natGateway: 0.048,
			auroraACU: 0.14,
			wafWebACL: 5,
			ec2: { "t3.large": 0.0912 },
			cache: {},
			region: "us-east-1",
			fetchedAt: new Date().toISOString(),
		};
		vi.mocked(getRegionPrices).mockResolvedValue(prices);
		const ctx: CanvasContext = {
			provider: "aws",
			form: {
				project: { region: "us-east-1" },
				cluster: { instance_types: ["t3.large"], node_desired_size: 3 },
			},
		};
		const out = (await run(composeTools(ctx).estimate_cost, {})) as {
			region: string;
			monthly_total: number;
		};
		expect(getRegionPrices).toHaveBeenCalledTimes(1);
		expect(getRegionPrices).toHaveBeenCalledWith("us-east-1");
		expect(out.region).toBe("us-east-1");
		// nodes: 0.0912 * 3 * 730 ≈ 199.7 → present in a non-trivial rounded total
		expect(out.monthly_total).toBeGreaterThan(200);
	});
});

describe("composeTools.propose_changes", () => {
	it("is a HITL tool with NO execute (the user accepts client-side)", () => {
		// Removing execute makes the model's turn pause on the proposal until the user
		// accepts it on the canvas; the accepted outcome returns via addToolResult.
		expect(
			(composeTools(undefined).propose_changes as { execute?: unknown }).execute,
		).toBeUndefined();
	});

	it("wires the real proposal schema as its input contract (min 1 action)", () => {
		// inputSchema is typed as AI SDK FlexibleSchema, but at runtime it's the real zod schema.
		const schema = composeTools(undefined).propose_changes.inputSchema as unknown as {
			safeParse: (v: unknown) => { success: boolean };
		};
		expect(schema.safeParse({ label: "x", actions: [] }).success).toBe(false);
		expect(
			schema.safeParse({
				label: "x",
				actions: [{ kind: "add_node", nodeKind: "cluster" }],
			}).success,
		).toBe(true);
	});
});
