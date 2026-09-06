// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Input validation for the bring-your-own Helm chart attach flow — shared by the attach dialog
// (via zodResolver) and the `attachByoChart` server action, so a field the form accepts is exactly
// a field the action accepts.
//
// A chart arrives one of two ways and they are different shapes, not one shape with an odd URL: a
// GIT chart is a directory in a repo at a ref, an OCI chart is a packaged artifact addressed by one
// `oci://host/ns/chart` URL at a chart version. The schema stays FLAT with a `superRefine` keyed on
// `source` (the convention lib/validations/sso.ts uses for OIDC-vs-SAML) rather than becoming a
// discriminated union, so a wizard step can validate a single field path and switching source
// mid-flow never validates the branch that is no longer on screen.

import { z } from "zod";

/** A git remote — an https:// or git@ address. */
export function isPlausibleGitRepoUrl(url: string): boolean {
	return /^https:\/\/\S+$/.test(url) || /^git@\S+:\S+$/.test(url);
}

/**
 * An `oci://` chart reference. Needs a host AND at least one more segment: the last segment is the
 * CHART NAME (`resolveByoChartInstall` pops it to build the ArgoCD `chart` field), so `oci://ghcr.io`
 * alone would resolve to a nameless chart the Application can't pull.
 */
export function isPlausibleOciChartUrl(url: string): boolean {
	const trimmed = url.trim();
	if (!/^oci:\/\/\S+$/.test(trimmed)) return false;
	return (
		trimmed.slice("oci://".length).replace(/\/+$/, "").split("/").filter(Boolean).length >= 2
	);
}

/** Either shape — what the server accepts as a chart repo. */
export function isPlausibleChartRepoUrl(url: string): boolean {
	return isPlausibleGitRepoUrl(url) || isPlausibleOciChartUrl(url);
}

export const CHART_SOURCES = ["git", "oci"] as const;
export type ChartSource = (typeof CHART_SOURCES)[number];

// `chartSlug` lives in lib/validations/names.ts, beside the ONE slugifier and the add-on id's
// length budget. The copy that was here had no cap at all, and its output becomes an ArgoCD
// Application name via `argocd.AddOnAppName` ("addon-"+id) — a name Kubernetes bounds at 63.

/**
 * The attach form. Optional fields carry their defaults at the EDGE (`ref` → `HEAD`/`*`,
 * `namespace` → `default`) rather than in the action, so what the review step shows is what gets
 * persisted.
 */
export const byoChartFormSchema = z
	.object({
		source: z.enum(CHART_SOURCES),
		/** The git remote (source=git) or the whole `oci://host/ns/chart` reference (source=oci). */
		repoUrl: z.string().trim().min(1, "A chart source is required"),
		/** Chart directory within a git repo. Unused for OCI — the chart is named by the URL. */
		chartPath: z.string().trim().optional(),
		/** Git ref (source=git) or chart version (source=oci). Blank means the source's default. */
		ref: z.string().trim().optional(),
		/** Display name; blank derives one from the URL's last segment. */
		name: z.string().trim().optional(),
		namespace: z.string().trim().optional(),
		valuesYaml: z.string().optional(),
	})
	.superRefine((value, ctx) => {
		if (value.source === "oci") {
			if (!isPlausibleOciChartUrl(value.repoUrl)) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["repoUrl"],
					message:
						"Enter the whole chart reference — oci://host/namespace/chart, including the chart name.",
				});
			}
			return;
		}
		if (!isPlausibleGitRepoUrl(value.repoUrl)) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["repoUrl"],
				message: "Enter a valid git repository URL (https:// or git@…).",
			});
		}
		// Only the git branch needs a path: without it the runner has a clone and no chart in it.
		if (!value.chartPath) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["chartPath"],
				message: "Enter the chart path within the repository.",
			});
		}
	});

export type ByoChartFormValues = z.infer<typeof byoChartFormSchema>;

/** The `attachByoChart` wire input. `id` is the resolved slug; the form's `name` derives it. */
export const byoChartAttachSchema = z
	.object({
		// Ids are checked for presence only: `authorize` resolves the project under the actor's scope
		// and `resolveActiveEnvironmentId` the environment, so a bogus id fails there with the right
		// error. Shape-checking them here would just duplicate that in a worse place.
		projectId: z.string().min(1),
		environmentId: z.string().min(1).nullish(),
		id: z.string().trim().min(1),
		repoUrl: z
			.string()
			.trim()
			.refine(
				isPlausibleChartRepoUrl,
				"Enter a valid chart repository URL (https://, git@…, or oci://…).",
			),
		chartPath: z.string().trim().optional(),
		ref: z.string().trim().optional(),
		namespace: z.string().trim().optional(),
		valuesYaml: z.string().nullish(),
		gitCredentialId: z.string().min(1).nullish(),
		values: z.record(z.string(), z.unknown()).optional(),
	})
	.superRefine((value, ctx) => {
		// Re-checked server-side rather than trusted from the form: the action is a public entry
		// point, and a git chart with no path silently renders an empty Application.
		if (!value.repoUrl.startsWith("oci://") && !value.chartPath?.replace(/^\/+/, "")) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["chartPath"],
				message: "Enter the chart path within the repository.",
			});
		}
	});

export type ByoChartAttachInput = z.infer<typeof byoChartAttachSchema>;
