// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { NODE_REGISTRY } from "@/components/design-project/canvas/graph/node-registry";
import type { NodeKind } from "@/components/design-project/canvas/graph/types";
import { DB_ENGINES, DEFAULT_REGION, type CloudProviderSlug } from "@/lib/cloud-providers";
import { slugify } from "@/lib/utils/slugify";
import { type ProjectFormData, projectFormSchema } from "@/lib/validations/project-form.schema";
import type { DetectedService } from "@/types/jsonb.types";
import type { InferredNeed, InferredStack } from "./schema";
import { bindableComponents, suggestBindings } from "./suggest-bindings";

const SERVICE_KINDS: InferredNeed["kind"][] = [
	"database",
	"cache",
	"queue",
	"topic",
	"nosql",
	"secret",
];

/** One scanned repo's inference result, for merging into a single project. */
export interface ScanInput {
	stack: InferredStack;
	repoUrl: string;
	ref?: string;
	/** Monorepo-aware services detected in the repo (carried onto the source repo row). */
	services?: DetectedService[];
}

/** Canonical slug capped at 25 chars (component/project names stay short), with a
 *  non-empty fallback when the name slugifies away entirely. */
function shortSlug(name: string, fallback = "app"): string {
	return slugify(name, fallback, 25);
}

function repoName(url: string): string {
	return url.replace(/\.git$/, "").split("/").filter(Boolean).pop() ?? "app";
}

/** Pick a valid DB engine option for the provider from a generic engine hint. */
function dbEngine(provider: CloudProviderSlug, hint?: string) {
	const opts = DB_ENGINES[provider];
	const picked = /mysql|maria/i.test(hint ?? "")
		? opts.find((o) => /mysql/.test(o.value))
		: opts.find((o) => /postgres/.test(o.value));
	return picked ?? opts[0];
}

/**
 * Collapse the backing needs of ONE OR MORE inferred stacks into per-kind component
 * configs, cloning the canonical `NODE_REGISTRY[kind].defaultData(provider)` and
 * overlaying engine/name. Every need becomes a component; names are made unique within
 * a kind (a count suffix for unnamed defaults, a collision suffix otherwise) so merging
 * repos never violates the `(project, environment, name)` constraint at insert.
 */
function collectComponents(
	needs: InferredNeed[],
	provider: CloudProviderSlug,
): Record<InferredNeed["kind"], Record<string, unknown>[]> {
	const dd = (k: NodeKind): Record<string, unknown> => ({
		...NODE_REGISTRY[k].defaultData(provider),
	});
	const byKind: Record<string, Record<string, unknown>[]> = {
		database: [],
		cache: [],
		queue: [],
		topic: [],
		nosql: [],
		secret: [],
	};
	const counts: Record<string, number> = {};
	const seen: Record<string, Set<string>> = {
		database: new Set(),
		cache: new Set(),
		queue: new Set(),
		topic: new Set(),
		nosql: new Set(),
		secret: new Set(),
	};

	for (const need of needs) {
		if (!SERVICE_KINDS.includes(need.kind)) continue;
		const cfg = dd(need.kind);
		const baseName = typeof cfg.name === "string" ? cfg.name : need.kind;
		counts[need.kind] = (counts[need.kind] ?? 0) + 1;
		let name = need.name
			? shortSlug(need.name, baseName)
			: counts[need.kind] > 1
				? `${baseName}-${counts[need.kind]}`
				: baseName;
		// Guarantee uniqueness within the kind (across merged repos).
		if (seen[need.kind].has(name)) {
			let i = 2;
			while (seen[need.kind].has(`${name}-${i}`)) i++;
			name = `${name}-${i}`;
		}
		seen[need.kind].add(name);
		cfg.name = name;
		if (need.kind === "database") {
			const eng = dbEngine(provider, need.engine);
			cfg.engine = eng.value;
			cfg.engine_version = eng.defaultVersion;
		}
		byKind[need.kind].push(cfg);
	}
	return byKind;
}

/**
 * Runtime-appropriate default resource requests/limits, so a promoted service arrives
 * production-shaped (every workload has a request + limit) rather than unset — a value the user
 * tunes on the canvas. Exact-match the scanner's runtime tokens (node/go/python/…): Go/Rust run
 * lean, the JVM runs heavy, everything else takes a modest middle default.
 */
function defaultResources(runtime?: string): {
	requests: { cpu: string; memory: string };
	limits: { cpu: string; memory: string };
} {
	switch ((runtime ?? "").toLowerCase()) {
		case "go":
		case "rust":
			return { requests: { cpu: "50m", memory: "64Mi" }, limits: { cpu: "250m", memory: "128Mi" } };
		case "java":
			return { requests: { cpu: "250m", memory: "512Mi" }, limits: { cpu: "1", memory: "1Gi" } };
		default:
			return { requests: { cpu: "100m", memory: "128Mi" }, limits: { cpu: "500m", memory: "256Mi" } };
	}
}

/**
 * A safe default TCP readiness/liveness probe on the detected container port — the most reliable
 * signal a scan has (an HTTP path would be a guess). Null when no port was detected, so we never
 * emit a port-less (invalid) probe; the user can switch it to an HTTP probe on the canvas.
 */
function defaultProbe(port?: number): { type: "tcp"; port: number } | null {
	return port ? { type: "tcp", port } : null;
}

/**
 * Turn each DEPLOYABLE DetectedService (one with a Dockerfile) into a FIRST-CLASS W1 service:
 * a repo-sourced, buildable workload (W1 model / W2 build-from-source) with W3 bindings suggested
 * from its detected `needs` against the project's backing components. Names are made unique across
 * repos (project_services is unique per (project, env, name)). Non-Dockerfile detections stay
 * overlay-only on `source_repos`. This is the Path-B convergence (north-star W6): a scan yields
 * configurable, bindable, buildable services — not just a read-only overlay card. Promoted services
 * arrive production-shaped — a runtime-tuned resources request/limit + a TCP probe on the detected
 * port (skeleton → real), both editable on the canvas.
 */
function firstClassServices(
	inputs: ScanInput[],
	components: ReturnType<typeof bindableComponents>,
): ProjectFormData["services"] {
	const used = new Set<string>();
	const uniqueName = (base: string): string => {
		let name = base;
		for (let n = 2; used.has(name); n++) name = `${base}-${n}`;
		used.add(name);
		return name;
	};
	return inputs.flatMap((i) =>
		(i.services ?? [])
			// Only a Dockerfile'd service is a deployable workload; non-container dirs are skipped
			// (they remain on the source_repos overlay), mirroring manifests.FromServices.
			.filter((s) => s.hasDockerfile)
			.map((s) => ({
				name: uniqueName(shortSlug(s.name)),
				type: "deployment" as const,
				source: { kind: "repo" as const, repo_url: i.repoUrl, path: s.path },
				build: { dockerfile: "Dockerfile" },
				// Env surface pre-populated from the service's .env.example keys (empty values for the
				// user to fill) — Path-B "skeleton → real".
				env: (s.env ?? []).map((name) => ({ name, value: "" })),
				ports: s.port ? [{ container_port: s.port }] : [],
				replicas: 2,
				// Per-service runtime when the scan attributed one, else the repo-level stack runtime.
				resources: defaultResources(s.runtime ?? i.stack.runtime),
				probe: defaultProbe(s.port),
				bindings: suggestBindings(s, components),
			})),
	);
}

/**
 * Merge one or more scanned repos into a single, guaranteed-valid ProjectFormData:
 * union the backing needs (de-duped), attach every repo as a `source_repos` row (with
 * its detected services), promote every Dockerfile'd service to a first-class `services[]`
 * entry, set the project roots, and ASSERT `projectFormSchema` passes. The first repo seeds
 * the project name + the GitOps destination. The model can never produce an invalid project —
 * this code does.
 */
export function mergeScansToFormData(
	inputs: ScanInput[],
	opts: { identityId: string; provider: CloudProviderSlug; region?: string },
): ProjectFormData {
	const { provider } = opts;
	if (inputs.length === 0) throw new Error("mergeScansToFormData: no scan inputs");
	const dd = (k: NodeKind): Record<string, unknown> => ({
		...NODE_REGISTRY[k].defaultData(provider),
	});

	const byKind = collectComponents(
		inputs.flatMap((i) => i.stack.needs),
		provider,
	);
	// Bind targets for the suggested W3 bindings = the union'd backing components just built.
	// collectComponents types rows loosely (Record<string, unknown>); project the name out.
	const names = (rows: Record<string, unknown>[]) =>
		rows.map((r) => ({ name: String(r.name) }));
	const bindTargets = bindableComponents({
		databases: names(byKind.database),
		caches: names(byKind.cache),
		queues: names(byKind.queue),
		secrets: names(byKind.secret),
	});
	const primary = inputs[0];

	const candidate = {
		project: {
			project_name: shortSlug(repoName(primary.repoUrl)),
			environment_stage: "development",
			region: opts.region || DEFAULT_REGION[provider],
			cloud_identity_id: opts.identityId,
			iac_version: "1.11.4",
		},
		network: dd("network"),
		cluster: dd("cluster"),
		dns: { ...dd("dns"), enabled: false },
		// The single GitOps destination (Phase C generates/points manifests here).
		repositories: { apps_destination_repo: primary.repoUrl },
		// Every scanned repo (1:N), carrying its monorepo services.
		source_repos: inputs.map((i) => ({
			repo_url: i.repoUrl,
			ref: i.ref ?? null,
			scan_path: "",
			services: i.services ?? [],
		})),
		databases: byKind.database,
		caches: byKind.cache,
		queues: byKind.queue,
		topics: byKind.topic,
		nosql_tables: byKind.nosql,
		secrets: byKind.secret,
		// Path B (W6): promote every Dockerfile'd detected service to a first-class, buildable,
		// bindable W1 service — not just the read-only source_repos overlay.
		services: firstClassServices(inputs, bindTargets),
	};

	const parsed = projectFormSchema.safeParse(candidate);
	if (!parsed.success) {
		throw new Error(`Scanner produced an invalid project: ${parsed.error.message}`);
	}
	return parsed.data;
}

/**
 * Single-repo convenience over {@link mergeScansToFormData} — kept for the one-repo
 * scan path. `services` (monorepo detection) is optional.
 */
export function inferredStackToFormData(
	stack: InferredStack,
	opts: {
		identityId: string;
		provider: CloudProviderSlug;
		repoUrl: string;
		ref?: string;
		region?: string;
		services?: DetectedService[];
	},
): ProjectFormData {
	return mergeScansToFormData(
		[{ stack, repoUrl: opts.repoUrl, ref: opts.ref, services: opts.services }],
		opts,
	);
}
