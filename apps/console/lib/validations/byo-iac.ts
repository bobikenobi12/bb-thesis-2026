// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Input validation for the bring-your-own IaC (E3) server actions — derived from the
// project_iac_sources drizzle schema per the drizzle-zod convention, with the JSONB /
// user-facing columns refined (repo URL shape, normalized path, scalar-only tfvars).

import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { projectIacSources } from "@/lib/db/schema";
import type { IacVarValues } from "@/types/jsonb.types";

/** Basic sanity on a git repo URL — an https:// or git@ remote. Deep validation happens when the
 * runner clones it; this just rejects obvious garbage at save time. */
export function isPlausibleRepoUrl(url: string): boolean {
	return /^https:\/\/\S+$/.test(url) || /^git@\S+:\S+$/.test(url);
}

/**
 * The reserved platform variable namespace. The runner publishes the frozen Alethia context as
 * `TF_VAR_alethia_*` environment variables, and a customer entry of the same name is written into
 * the `-var-file`, which has HIGHER precedence — so `alethia_project_id` in var_values would shadow
 * the platform's own value. `provisioner.coerceByoVarValues` drops any such key.
 *
 * Until #3670 the prefix was enforced only in Go, so the console happily STORED `alethia_project_id`
 * and the user then watched it vanish at apply with nothing in the UI to explain why.
 *
 * CASE-SENSITIVE, matching `strings.HasPrefix(k, "alethia_")` exactly. A case-insensitive check here
 * would refuse `Alethia_project_id`, which the runner passes through as an ordinary variable — the
 * console would be refusing input the server accepts.
 */
export const RESERVED_TFVAR_PREFIX = "alethia_";

/** Reports whether `key` is outside the reserved platform namespace — see RESERVED_TFVAR_PREFIX. */
export function isNotReservedTfvarKey(key: string): boolean {
	return !key.startsWith(RESERVED_TFVAR_PREFIX);
}

/**
 * The message every surface uses for a reserved key, so the console, the API and the CLI say the
 * same thing.
 *
 * It opens with "Invalid" for a second reason worth stating, because it looks like a style choice
 * and is not: `byoWriteError` (lib/cli/byo-write.ts) classifies an unhandled throw by regex over
 * the message, and a ZodError's message is the JSON issue array — so a message without one of its
 * 400 keywords lands the caller a 500 carrying a raw Zod dump. That is a BACKSTOP, not the
 * mechanism: the CLI route validates the key in its own body schema and returns a proper 400 long
 * before this can throw.
 */
export const RESERVED_TFVAR_MESSAGE = `Invalid variable name: the "${RESERVED_TFVAR_PREFIX}" prefix is reserved for the platform context.`;

/**
 * One BYO IaC variable NAME. The shared spec `iac_var_key`
 * (apps/console/scripts/gen-go-validation.ts) is projected from exactly this schema.
 *
 * Note the split the generator makes visible: `.min(1)` and `.regex(...)` become data in
 * packages/core/validate/spec_gen.go, while `.trim()` and the reserved-prefix `.refine()` cannot be
 * — the first is a console-side normalisation, the second is held to a conformance table.
 */
export const iacVarKeySchema = z
	.string()
	.trim()
	.min(1, "Variable name is required.")
	.regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Use a valid tfvar name (letters, digits, underscore).")
	.refine(isNotReservedTfvarKey, RESERVED_TFVAR_MESSAGE);

/** The attachIacSource input — the insertable user-facing columns of project_iac_sources.
 * Server-derived columns (commit_sha, scan_*, status, timestamps) are omitted: the scan
 * pipeline owns them. */
export const iacSourceAttachSchema = createInsertSchema(projectIacSources, {
	repo_url: z
		.string()
		.trim()
		.refine(isPlausibleRepoUrl, "Enter a valid git repository URL (https:// or git@…)."),
	ref: z.string().trim().min(1).nullish(),
	path: z
		.string()
		.trim()
		// Normalize "/foo/" → "foo" so the runner joins it safely under the clone dir.
		.transform((p) => p.replace(/^\/+|\/+$/g, ""))
		.optional(),
	git_credential_id: z.string().uuid().nullish(),
	// Scalar-only tfvars (IacVarValues) — no nested objects/arrays, no secrets, and no key in the
	// reserved platform namespace. The key check is HERE as well as on the form row because the
	// server action is reachable without the form (the CLI and the API post straight to it), and
	// storing a key the runner will drop is the defect this closes.
	var_values: z
		.record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
		.refine(
			(v) => Object.keys(v).every(isNotReservedTfvarKey),
			RESERVED_TFVAR_MESSAGE,
		)
		.optional()
		.transform((v): IacVarValues => v ?? {}),
}).pick({
	repo_url: true,
	ref: true,
	path: true,
	git_credential_id: true,
	var_values: true,
});

export type IacSourceAttachInput = z.input<typeof iacSourceAttachSchema>;

/** The scalar tfvar kinds a BYO IaC variable can hold (secrets are NOT allowed here). */
export const IAC_VAR_KINDS = ["string", "number", "bool"] as const;
export type IacVarKind = (typeof IAC_VAR_KINDS)[number];

/**
 * One row in the attach dialog's variable editor (react-hook-form `useFieldArray`). Kept as a flat
 * `{ key, kind, value }` string triple so the field array is trivial to render; the value is parsed
 * to its scalar kind (and validated) on submit, then folded into an `IacVarValues` record.
 */
export const iacVarRowSchema = z
	.object({
		key: iacVarKeySchema,
		kind: z.enum(IAC_VAR_KINDS),
		// Raw text as typed; refined per-kind below so a `number`/`bool` can't hold garbage.
		value: z.string(),
	})
	.superRefine((row, ctx) => {
		if (row.kind === "number" && row.value.trim() !== "" && Number.isNaN(Number(row.value))) {
			ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["value"], message: "Enter a number." });
		}
		if (row.kind === "bool" && !["true", "false"].includes(row.value.trim().toLowerCase())) {
			ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["value"], message: "Use true or false." });
		}
	});
export type IacVarRow = z.infer<typeof iacVarRowSchema>;

/**
 * The attach-dialog form schema (react-hook-form). Repo/path/ref reuse the same rules as
 * `iacSourceAttachSchema`; variables are the editable rows above (uniqueness enforced across the
 * array). `toIacVarValues` folds validated rows into the `IacVarValues` record the action wants.
 */
export const iacSourceFormSchema = z.object({
	repo_url: z
		.string()
		.trim()
		.refine(isPlausibleRepoUrl, "Enter a valid git repository URL (https:// or git@…)."),
	path: z.string().trim().optional(),
	ref: z.string().trim().optional(),
	variables: z
		.array(iacVarRowSchema)
		.superRefine((rows, ctx) => {
			const seen = new Set<string>();
			rows.forEach((row, i) => {
				const key = row.key.trim();
				if (key && seen.has(key)) {
					ctx.addIssue({
						code: z.ZodIssueCode.custom,
						path: [i, "key"],
						message: "Duplicate variable name.",
					});
				}
				seen.add(key);
			});
		}),
});
export type IacSourceFormValues = z.infer<typeof iacSourceFormSchema>;

/** Folds validated variable rows into the scalar `IacVarValues` record the server action stores. */
export function toIacVarValues(rows: IacVarRow[]): IacVarValues {
	const out: IacVarValues = {};
	for (const row of rows) {
		const key = row.key.trim();
		if (!key) continue;
		if (row.kind === "number") out[key] = Number(row.value);
		else if (row.kind === "bool") out[key] = row.value.trim().toLowerCase() === "true";
		else out[key] = row.value;
	}
	return out;
}
