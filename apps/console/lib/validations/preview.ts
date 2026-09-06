// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Validation for the ephemeral PR-preview config (W-f). Derived from the project_preview_config
// table with drizzle-zod, refined to the user-facing subset. `dedicated` is intentionally rejected
// as a preview placement — a preview is a lightweight namespace|vcluster tenant, never a whole
// dedicated Fabric (spec environments-fabric-placement.md, D3).

import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { projectPreviewConfig } from "@/lib/db/schema";
import { appsPathSchema } from "@/lib/validations/apps-path";

/** Placement modes valid for an ephemeral preview (dedicated is excluded). */
export const PREVIEW_PLACEMENT_MODES = ["namespace", "vcluster"] as const;
export type PreviewPlacementMode = (typeof PREVIEW_PLACEMENT_MODES)[number];

/**
 * A namespace prefix, MIRRORING Go's `validatePreviewNamespacePrefix`
 * (packages/core/argocd/preview_validate.go), which is the authoritative guard — the value is
 * rendered into the preview ApplicationSet's `destination.namespace` and into the guardrails
 * AppProject's destination pin, and the console is not a trust boundary for either.
 *
 * The previous rule here was `/^[a-z0-9-]+$/` with a message calling it "a DNS-1123 label prefix",
 * which it is not: it accepted `-`, `--` and `a-`. A lone `-` rendered `namespace: -` in the
 * vcluster arm, which is not even a well-formed YAML scalar.
 *
 * Keep these two constants in step with Go — `preview_prefix_mirror_test.go` reads them out of
 * this file and fails when they drift.
 */
const DNS1123_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
/** 63 (Kubernetes' label limit) minus 8 reserved for `-` plus a seven-digit PR number. */
const PREVIEW_PREFIX_MAX_LEN = 55;

/** A GitHub/GitLab owner or repo segment: no whitespace, slashes, or path traversal. */
const repoSegment = z
	.string()
	.trim()
	.min(1)
	.max(100)
	.regex(/^[A-Za-z0-9._-]+$/, "must be a single owner/repo segment");

/** Input schema for configurePreviewEnvironments — the settings a user edits. */
export const previewConfigSchema = createInsertSchema(projectPreviewConfig, {
	git_provider: z.enum(["github", "gitlab", "bitbucket"]),
	repo_owner: repoSegment,
	repo_name: repoSegment,
	// THE SHARED RULE, not a third one. This field was previously validated here by a local
	// charset check whose class contained `/` and allowed a segment to start with `.`, so
	// `../../etc` passed every clause and was stored — while the placed-env lane used
	// appsPathSchema, and Go's ValidateAppsPath guarded the same value at five other sites.
	// See packages/core/argocd/preview_validate.go.
	//
	// Empty means the repository root, spelled ".", matching what namespace_tenant.go,
	// vcluster_app.go and now applicationset_preview.go default to at render.
	apps_path: appsPathSchema.transform((p) => (p == null || p === "" ? "." : p)),
	placement_mode: z.enum(PREVIEW_PLACEMENT_MODES).optional(),
	namespace_prefix: z
		.string()
		.trim()
		.max(PREVIEW_PREFIX_MAX_LEN, `must be at most ${PREVIEW_PREFIX_MAX_LEN} characters`)
		.regex(DNS1123_LABEL, "must be a DNS-1123 label: lowercase alphanumerics and '-', starting and ending alphanumeric")
		.optional(),
	fabric_id: z.string().uuid().nullish(),
	git_credential_id: z.string().uuid().nullish(),
	enabled: z.boolean().optional(),
}).pick({
	enabled: true,
	git_provider: true,
	repo_owner: true,
	repo_name: true,
	apps_path: true,
	placement_mode: true,
	fabric_id: true,
	namespace_prefix: true,
	git_credential_id: true,
});

export type PreviewConfigInput = z.input<typeof previewConfigSchema>;
export type PreviewConfigParsed = z.output<typeof previewConfigSchema>;
