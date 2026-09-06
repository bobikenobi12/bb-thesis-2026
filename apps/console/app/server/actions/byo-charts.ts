"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Bring-your-own (BYO) Helm chart server actions — attach / detach a chart from a connected git
// repo to a project environment, and read the attached charts for the canvas. A BYO chart is
// persisted as a `project_addons` row with source='byo' (chart_repo + chart_path + version=ref);
// the runner renders it as an ArgoCD Application in a hardened per-project "byo-<slug>" AppProject
// on the next DEPLOY. This layer only records intent — it never touches the cluster.
//
// TRUST GATE (MVP): the feature is flagged off by default and, when on, is limited to org-owner-
// authed edits of trusted charts on the org's own cluster. Untrusted third-party charts wait on a
// namespace-PSA + admission-controller (Kyverno/Gatekeeper) gate — see the plan's E2 section.

import { and, eq, notInArray } from "drizzle-orm";
import { signedJob } from "@/lib/db/signed-job";
import { assertJobQuotaAllowed } from "@/lib/billing/job-quota";
import { authorize } from "@/lib/authz/guard";
import { getServiceDb, withActorScope } from "@/lib/db";
import {
	type ChartWorkloadKind,
	type ComponentStatus,
	jobs,
	projectAddons,
	projectChartWorkloads,
	projectHelmRegistries,
} from "@/lib/db/schema";
import { resolveActiveEnvironmentId } from "@/app/server/actions/resolve";
import { parseValuesYaml } from "@/lib/addons/catalog";
import { inferValuePaths } from "@/lib/addons/chart-overlay";
import { isByoDescribeEnabled } from "@/lib/addons/describe-flag";
import { isByoHelmEnabled } from "@/lib/addons/byo-flag";
import { notifyScaler } from "@/lib/scaler";
import { replaceServiceBindings } from "@/lib/db/service-bindings-sync";
import { serviceBindingsByOwner } from "@/lib/db/normalized-reads";
import {
	chartWorkloadBindingsSchema,
	chartWorkloadConfigSchema,
	chartWorkloadValuePathsSchema,
	chartWorkloadWireArraySchema,
} from "@/lib/validations/chart-workloads";
import {
	byoChartAttachSchema,
	type ByoChartAttachInput,
} from "@/lib/validations/byo-charts";
import { chartSlug } from "@/lib/validations/names";
import type {
	AddOnValues,
	ChartValuePathMap,
	ChartWorkloadConfig,
	ChartWorkloadRendered,
	ServiceBinding,
	VerifyReport,
} from "@/types/jsonb.types";

/** Throws if the feature is disabled — every mutating BYO action calls this first. */
function assertByoHelmEnabled(): void {
	if (!isByoHelmEnabled()) {
		throw new Error(
			"Bring-your-own Helm charts are not enabled on this instance (set ALETHIA_BYO_HELM_ENABLED=true).",
		);
	}
}

/** An attached BYO chart as the canvas reads it back (one per chart node). */
export interface ByoChartState {
	id: string;
	repoUrl: string;
	chartPath: string;
	ref: string;
	namespace: string;
	values: AddOnValues;
	valuesYaml: string | null;
	status: ComponentStatus;
	health: string | null;
	sync: string | null;
	lastSyncedAt: string | null;
	/** Chart-safety scan lifecycle: unscanned | scanning | done | failed. */
	scanStatus: string;
	/** The elench verify.Report over the chart's rendered manifests (null until the first scan). */
	scanReport: VerifyReport | null;
	scannedAt: string | null;
}

/**
 * Attaches (or reconfigures) a BYO Helm chart on an environment. Upserts a source='byo'
 * project_addons row as PENDING so the next DEPLOY renders it. `id` is a stable per-env slug
 * (the chart node's id); re-attaching the same id updates it in place.
 *
 * `repoUrl` is a git remote (https://…/git@…) OR an `oci://<host>/<ns>/<chart>` reference to a
 * private OCI Helm registry. For git the chart lives at `chartPath` and `ref` is a git ref; for OCI
 * the chart name is the URL's last segment (no `chartPath`) and `ref` is the chart version.
 */
export async function attachByoChart(
	input: ByoChartAttachInput,
): Promise<{ ok: true; id: string }> {
	assertByoHelmEnabled();
	const parsed = byoChartAttachSchema.parse(input);
	const actor = await authorize("edit", { type: "project", id: parsed.projectId });

	const id = chartSlug(parsed.id);
	const repoUrl = parsed.repoUrl;
	const isOci = repoUrl.startsWith("oci://");
	// git charts live at a path within the repo; OCI charts are named by the URL's last segment.
	const chartPath = isOci ? null : (parsed.chartPath ?? "").replace(/^\/+/, "");

	const valuesYaml = parsed.valuesYaml?.trim() ? parsed.valuesYaml : null;
	if (valuesYaml && !parseValuesYaml(valuesYaml)) {
		throw new Error("Advanced values must be valid YAML describing a mapping (key: value).");
	}

	const envId = await resolveActiveEnvironmentId(parsed.projectId, parsed.environmentId);
	// `version` holds the git ref for a git chart, or the chart version for an OCI chart
	// (`*` = latest, an ArgoCD-supported Helm targetRevision).
	const ref = parsed.ref || (isOci ? "*" : "HEAD");
	const namespace = parsed.namespace || "default";
	const values: AddOnValues = parsed.values ?? {};

	await withActorScope(actor, async (tx) => {
		await tx
			.insert(projectAddons)
			.values({
				project_id: parsed.projectId,
				environment_id: envId,
				addon_id: id,
				source: "byo",
				chart_repo: repoUrl,
				chart_path: chartPath,
				git_credential_id: parsed.gitCredentialId ?? null,
				enabled: true,
				mode: "managed",
				version: ref,
				values,
				values_yaml: valuesYaml,
				namespace,
				status: "PENDING",
			})
			.onConflictDoUpdate({
				target: [projectAddons.project_id, projectAddons.environment_id, projectAddons.addon_id],
				set: {
					source: "byo",
					chart_repo: repoUrl,
					chart_path: chartPath,
					git_credential_id: parsed.gitCredentialId ?? null,
					enabled: true,
					mode: "managed",
					version: ref,
					values,
					values_yaml: valuesYaml,
					namespace,
					status: "PENDING",
					updated_at: new Date(),
				},
			});
	});

	// Auto-queue a safety scan so the user sees any issues right after attaching (best-effort — a
	// scan-queue failure must never fail the attach itself). Both chart sources scan: the runner
	// resolves a git chart by cloning and an OCI chart by pulling it from the registry (#1300).
	try {
		await scanByoChart({ projectId: parsed.projectId, environmentId: envId, id });
	} catch {
		/* ignore — the chart is attached; the user can re-run the scan from the node */
	}
	return { ok: true, id };
}

/** Detaches a BYO chart (deletes its row); the runner prunes it on the next DEPLOY. */
export async function detachByoChart(input: {
	projectId: string;
	environmentId?: string | null;
	id: string;
}): Promise<{ ok: true }> {
	assertByoHelmEnabled();
	const actor = await authorize("edit", { type: "project", id: input.projectId });
	const envId = await resolveActiveEnvironmentId(input.projectId, input.environmentId);
	await withActorScope(actor, async (tx) => {
		await tx
			.delete(projectAddons)
			.where(
				and(
					eq(projectAddons.project_id, input.projectId),
					eq(projectAddons.environment_id, envId),
					eq(projectAddons.addon_id, chartSlug(input.id)),
					eq(projectAddons.source, "byo"),
				),
			);
	});
	return { ok: true };
}

/** Reads the BYO charts attached to an environment — the canvas renders one chart node each. */
export async function getProjectByoCharts(
	projectId: string,
	environmentId?: string | null,
): Promise<{ environmentId: string; charts: ByoChartState[] }> {
	const actor = await authorize("view", { type: "project", id: projectId });
	const envId = await resolveActiveEnvironmentId(projectId, environmentId);
	const rows = await withActorScope(actor, async (tx) =>
		tx
			.select()
			.from(projectAddons)
			.where(
				and(
					eq(projectAddons.project_id, projectId),
					eq(projectAddons.environment_id, envId),
					eq(projectAddons.source, "byo"),
				),
			),
	);
	const charts: ByoChartState[] = rows.map((r) => ({
		id: r.addon_id,
		repoUrl: r.chart_repo ?? "",
		chartPath: r.chart_path ?? "",
		ref: r.version ?? "HEAD",
		namespace: r.namespace ?? "default",
		values: r.values ?? {},
		valuesYaml: r.values_yaml,
		status: r.status,
		health: r.health,
		sync: r.sync_status,
		lastSyncedAt: r.last_synced_at?.toISOString() ?? null,
		scanStatus: r.scan_status,
		scanReport: r.scan_report ?? null,
		scannedAt: r.scanned_at?.toISOString() ?? null,
	}));
	return { environmentId: envId, charts };
}

/** A DESCRIBED chart workload as the canvas reads it back (W5 Path A). */
export interface ChartWorkloadState {
	id: string;
	/** The owning chart node (project_addons.addon_id slug) these group under. */
	chartId: string;
	name: string;
	kind: ChartWorkloadKind;
	/** Read-only description from `helm template` (image/ports/env keys/resources/replicas). */
	rendered: ChartWorkloadRendered;
	/** W3 bindings + the editable overlay — preserved across re-scans (empty until the bind lane). */
	bindings: ServiceBinding[];
	config: ChartWorkloadConfig;
	/** Logical knob → chart-values dot-path (inferred at scan, user-overridable). */
	valuePaths: ChartValuePathMap;
}

/**
 * Reads the DESCRIBED workloads of an environment's BYO charts (W5 Path A) — the canvas renders each
 * as a service-like child of its chart node (joined back to the chart's slug via the addon uuid).
 * Empty until a CHART_SCAN has run with the describe flag on.
 */
export async function getProjectChartWorkloads(
	projectId: string,
	environmentId?: string | null,
): Promise<{ environmentId: string; workloads: ChartWorkloadState[] }> {
	const actor = await authorize("view", { type: "project", id: projectId });
	const envId = await resolveActiveEnvironmentId(projectId, environmentId);
	const { rows, bindingsByWorkload } = await withActorScope(actor, async (tx) => {
		const rows = await tx
			.select({
				id: projectChartWorkloads.id,
				chartId: projectAddons.addon_id,
				name: projectChartWorkloads.name,
				kind: projectChartWorkloads.workload_kind,
				rendered: projectChartWorkloads.rendered,
				config: projectChartWorkloads.config,
				valuePaths: projectChartWorkloads.value_paths,
			})
			.from(projectChartWorkloads)
			.innerJoin(
				projectAddons,
				eq(projectChartWorkloads.addon_id, projectAddons.id),
			)
			.where(
				and(
					eq(projectChartWorkloads.project_id, projectId),
					eq(projectChartWorkloads.environment_id, envId),
				),
			);
		// Bindings live in the service_bindings child table (JSONB dropped, #1426).
		const bindingsByWorkload = await serviceBindingsByOwner(tx, {
			serviceIds: [],
			chartWorkloadIds: rows.map((r) => r.id),
		});
		return { rows, bindingsByWorkload };
	});
	return {
		environmentId: envId,
		workloads: rows.map((r) => ({
			id: r.id,
			chartId: r.chartId,
			name: r.name,
			kind: r.kind,
			rendered: r.rendered,
			bindings: bindingsByWorkload.get(r.id) ?? [],
			config: r.config,
			valuePaths: r.valuePaths,
		})),
	};
}

/**
 * Updates one described workload's overlay (config / value_paths), scoped to the caller's project.
 * `authorize("edit", project)` + RLS-scoped tx; the workload is matched by id AND project so a
 * cross-project id can never be written. Throws if the workload doesn't belong to the project.
 */
async function updateChartWorkloadOverlay(
	projectId: string,
	workloadId: string,
	patch: Partial<{ config: ChartWorkloadConfig; value_paths: ChartValuePathMap }>,
): Promise<void> {
	assertByoHelmEnabled();
	const actor = await authorize("edit", { type: "project", id: projectId });
	await withActorScope(actor, async (tx) => {
		const [row] = await tx
			.update(projectChartWorkloads)
			.set({ ...patch, updated_at: new Date() })
			.where(
				and(
					eq(projectChartWorkloads.id, workloadId),
					eq(projectChartWorkloads.project_id, projectId),
				),
			)
			.returning({ id: projectChartWorkloads.id });
		if (!row) throw new Error("Chart workload not found");
	});
}

/** Sets a described workload's editable config (v1: replicas + env), written to the chart on deploy. */
export async function setChartWorkloadConfig(input: {
	projectId: string;
	workloadId: string;
	config: ChartWorkloadConfig;
}): Promise<{ ok: true }> {
	const config = chartWorkloadConfigSchema.parse(input.config);
	await updateChartWorkloadOverlay(input.projectId, input.workloadId, {
		config,
	});
	return { ok: true };
}

/**
 * Overrides a described workload's value-paths (logical knob → chart-values dot-path) — the user's
 * correction of the inferred defaults.
 */
export async function setChartWorkloadValuePaths(input: {
	projectId: string;
	workloadId: string;
	valuePaths: ChartValuePathMap;
}): Promise<{ ok: true }> {
	const value_paths = chartWorkloadValuePathsSchema.parse(input.valuePaths);
	await updateChartWorkloadOverlay(input.projectId, input.workloadId, {
		value_paths,
	});
	return { ok: true };
}

/**
 * Sets a described workload's W3 bindings, merging inferred value-paths for any new credential facet
 * (existing user paths win — an override is never clobbered). The binding write-back to the chart's
 * values is runner-side (Lane 2b); this records the declared bindings + where each credential ref
 * will land, so nothing is composed with a plaintext credential console-side.
 */
export async function setChartWorkloadBindings(input: {
	projectId: string;
	workloadId: string;
	bindings: ServiceBinding[];
}): Promise<{ ok: true }> {
	assertByoHelmEnabled();
	const actor = await authorize("edit", {
		type: "project",
		id: input.projectId,
	});
	const bindings = chartWorkloadBindingsSchema.parse(input.bindings);
	await withActorScope(actor, async (tx) => {
		const [row] = await tx
			.select({
				rendered: projectChartWorkloads.rendered,
				config: projectChartWorkloads.config,
				value_paths: projectChartWorkloads.value_paths,
			})
			.from(projectChartWorkloads)
			.where(
				and(
					eq(projectChartWorkloads.id, input.workloadId),
					eq(projectChartWorkloads.project_id, input.projectId),
				),
			)
			.limit(1);
		if (!row) throw new Error("Chart workload not found");
		const inferred = inferValuePaths({
			rendered: row.rendered,
			config: row.config,
			bindings,
		});
		const value_paths: ChartValuePathMap = { ...inferred, ...row.value_paths };
		await tx
			.update(projectChartWorkloads)
			.set({ value_paths, updated_at: new Date() })
			.where(
				and(
					eq(projectChartWorkloads.id, input.workloadId),
					eq(projectChartWorkloads.project_id, input.projectId),
				),
			);
		// The bindings JSONB was dropped in the contract phase (#1426); service_bindings is the store.
		// This is a granular UPDATE (not delete-all-reinsert), so replace this workload's binding rows.
		await replaceServiceBindings(
			tx,
			{ chart_workload_id: input.workloadId },
			bindings,
		);
	});
	return { ok: true };
}

/** Reports whether a chart_repo value addresses an OCI registry rather than a git repository. */
function isOciChartRepo(chartRepo: string): boolean {
	return chartRepo.trim().toLowerCase().startsWith("oci://");
}

/**
 * Queues a CHART_SCAN job for an attached BYO chart: the runner resolves the chart to a local
 * directory (git clone, or an OCI registry pull), `helm template`s it, and runs
 * verify.EvaluateManifests over the rendered manifests, posting a verify.Report that
 * finalizeChartScan writes back onto the row. Marks the row `scanning` immediately so the UI can
 * show progress. The job's config_snapshot carries the chart coords (repo_url so the runner's
 * git-token route resolves a token) + the row identity so the result maps back.
 *
 * For an OCI chart there is no chart_path (the repository path IS the chart), and the pull may need
 * the project's private chart-repo credential. The snapshot therefore carries the environment's
 * `helm_registries` selections — their non-secret provider config only. The claim route reads that
 * same key to attach the DECRYPTED credential out-of-band, so the secret half never touches the
 * snapshot (and so never reaches the job row, the logs, or the sandbox).
 */
export async function scanByoChart(input: {
	projectId: string;
	environmentId?: string | null;
	id: string;
}): Promise<{ ok: true; jobId: string }> {
	assertByoHelmEnabled();
	const actor = await authorize("edit", { type: "project", id: input.projectId });
	const envId = await resolveActiveEnvironmentId(input.projectId, input.environmentId);
	const id = chartSlug(input.id);

	await assertJobQuotaAllowed(actor.orgId);
	const jobId = await withActorScope(actor, async (tx) => {
		const [row] = await tx
			.select()
			.from(projectAddons)
			.where(
				and(
					eq(projectAddons.project_id, input.projectId),
					eq(projectAddons.environment_id, envId),
					eq(projectAddons.addon_id, id),
					eq(projectAddons.source, "byo"),
				),
			)
			.limit(1);
		if (!row || !row.chart_repo) {
			throw new Error("Chart not found (attach it before scanning).");
		}
		const isOci = isOciChartRepo(row.chart_repo);
		// A git chart needs a directory inside the repo; an OCI chart's repository path IS the chart.
		if (!isOci && !row.chart_path) {
			throw new Error("Chart not found (attach it before scanning).");
		}

		// The environment's connected chart repos — non-secret provider config only. The runner
		// matches the chart's host against these the same way ArgoCD matches an Application to a
		// repository credential, so the scan authenticates against exactly the repo the deploy will.
		const helmRegistries = isOci
			? (
					await tx
						.select({
							name: projectHelmRegistries.name,
							provider: projectHelmRegistries.provider,
							provider_config: projectHelmRegistries.provider_config,
						})
						.from(projectHelmRegistries)
						.where(
							and(
								eq(projectHelmRegistries.project_id, input.projectId),
								eq(projectHelmRegistries.environment_id, envId),
							),
						)
				).map((r) => ({
					name: r.name,
					provider: r.provider,
					provider_config: r.provider_config ?? {},
				}))
			: [];

		const [job] = await tx
			.insert(jobs)
			.values(signedJob({
				user_id: actor.userId,
				org_id: actor.orgId,
				job_type: "CHART_SCAN",
				initiated_by: "user",
				status: "QUEUED",
				config_snapshot: {
					// repo_url (not chart_repo) so the runner's FetchGitToken route resolves a token.
					repo_url: row.chart_repo,
					chart_path: row.chart_path,
					// Carries a git ref for a git chart and a chart version for an OCI one. "*" is
					// Helm's "latest release", which is also what the deploy path sends ArgoCD.
					ref: row.version ?? (isOci ? "*" : "HEAD"),
					values: row.values ?? {},
					// Read by the claim route to attach the decrypted chart-repo credential.
					...(isOci ? { helm_registries: helmRegistries } : {}),
					// Row identity for finalizeChartScan → the result maps back to this chart.
					project_id: input.projectId,
					environment_id: envId,
					addon_id: id,
				},
			}))
			.returning({ id: jobs.id });
		await tx
			.update(projectAddons)
			.set({ scan_status: "scanning", updated_at: new Date() })
			.where(
				and(
					eq(projectAddons.project_id, input.projectId),
					eq(projectAddons.environment_id, envId),
					eq(projectAddons.addon_id, id),
				),
			);
		return job.id;
	});
	notifyScaler();
	return { ok: true, jobId };
}

/**
 * Writes a finished CHART_SCAN job's verify.Report back onto its chart row (called from the job
 * status route on SUCCESS/FAILED). Uses the service DB (the runner-facing status route has no user
 * session) and maps back via the row identity stashed in config_snapshot.
 */
export async function finalizeChartScan(jobId: string): Promise<void> {
	const db = getServiceDb();
	const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
	if (!job || job.job_type !== "CHART_SCAN") return;
	const snap = job.config_snapshot ?? {};
	const projectId = typeof snap.project_id === "string" ? snap.project_id : null;
	const environmentId = typeof snap.environment_id === "string" ? snap.environment_id : null;
	const addonId = typeof snap.addon_id === "string" ? snap.addon_id : null;
	if (!projectId || !environmentId || !addonId) return;

	const meta = job.execution_metadata;
	const report = meta?.verify_result ?? null;
	const done = job.status === "SUCCESS" && report !== null;

	await db
		.update(projectAddons)
		.set({
			scan_status: done ? "done" : "failed",
			scan_report: report,
			scanned_at: new Date(),
			updated_at: new Date(),
		})
		.where(
			and(
				eq(projectAddons.project_id, projectId),
				eq(projectAddons.environment_id, environmentId),
				eq(projectAddons.addon_id, addonId),
				eq(projectAddons.source, "byo"),
			),
		);

	// W5 Path A — DESCRIBE: on a clean scan, persist the chart's rendered workloads so the canvas can
	// show + bind them. Dark-launched (ALETHIA_BYO_DESCRIBE_ENABLED). The chart stays the deploy
	// unit — project_chart_workloads never feeds the deploy path, so a described workload can't
	// double-deploy. Only reconciles on SUCCESS (a failed scan keeps the last-known description).
	if (done && isByoDescribeEnabled()) {
		await reconcileChartWorkloads(db, {
			projectId,
			environmentId,
			addonSlug: addonId,
			workloads: meta?.chart_workloads,
		});
	}
}

/**
 * Reconciles the DESCRIBED workloads of a BYO chart into project_chart_workloads from a CHART_SCAN's
 * execution_metadata.chart_workloads wire: validates it, resolves the owning chart addon's uuid,
 * UPSERTs each workload refreshing ONLY the rendered description (the user overlay —
 * bindings/config/value_paths — is preserved across re-scans), then prunes workloads the chart no
 * longer renders. Uses the service DB (the runner-facing status route has no user session).
 */
async function reconcileChartWorkloads(
	db: ReturnType<typeof getServiceDb>,
	args: {
		projectId: string;
		environmentId: string;
		addonSlug: string;
		workloads: unknown;
	},
): Promise<void> {
	const parsed = chartWorkloadWireArraySchema.safeParse(args.workloads ?? []);
	if (!parsed.success) {
		console.error("finalizeChartScan: invalid chart_workloads wire", parsed.error);
		return;
	}
	const workloads = parsed.data;

	// The FK target is the addon's uuid PK; the job only carries the per-env slug.
	const [addon] = await db
		.select({ id: projectAddons.id })
		.from(projectAddons)
		.where(
			and(
				eq(projectAddons.project_id, args.projectId),
				eq(projectAddons.environment_id, args.environmentId),
				eq(projectAddons.addon_id, args.addonSlug),
				eq(projectAddons.source, "byo"),
			),
		)
		.limit(1);
	if (!addon) return;

	for (const w of workloads) {
		await db
			.insert(projectChartWorkloads)
			.values({
				project_id: args.projectId,
				environment_id: args.environmentId,
				addon_id: addon.id,
				name: w.name,
				workload_kind: w.workload_kind,
				rendered: w.rendered,
				// Seed inferred value-paths on first describe (replicaCount/extraEnvVars); the user can
				// override later. On re-scan the set-clause omits value_paths, so overrides survive.
				value_paths: inferValuePaths({
					rendered: w.rendered,
					config: {},
					bindings: [],
				}),
			})
			.onConflictDoUpdate({
				target: [
					projectChartWorkloads.project_id,
					projectChartWorkloads.environment_id,
					projectChartWorkloads.addon_id,
					projectChartWorkloads.name,
				],
				set: {
					workload_kind: w.workload_kind,
					rendered: w.rendered,
					updated_at: new Date(),
				},
			});
	}

	// Prune workloads the chart no longer renders (their overlay is moot once they're gone).
	const names = workloads.map((w) => w.name);
	await db
		.delete(projectChartWorkloads)
		.where(
			names.length > 0
				? and(
						eq(projectChartWorkloads.addon_id, addon.id),
						notInArray(projectChartWorkloads.name, names),
					)
				: eq(projectChartWorkloads.addon_id, addon.id),
		);
}
