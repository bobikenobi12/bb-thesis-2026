"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { toStr } from "@/lib/coerce";
import { Plus, X } from "lucide-react";
import { useId } from "react";
import { Button } from "@repo/ui/button";
import { Input } from "@repo/ui/input";
import { Label } from "@repo/ui/label";
import { cn } from "@repo/ui/utils";
import { OptionSelect } from "./config-fields";
import type { FieldCtx, FieldDef, SubresourceSpec } from "./config-schema";

type Row = Record<string, unknown>;

/**
 * A row editor over a JSONB array of objects.
 *
 * The first thing this makes definable is `topic.subscriptions` — a `TopicSubscription[]` column
 * that has existed since the baseline migration, and which the inspector previously did not expose
 * AT ALL. You could name a topic and nothing else; there was literally no way to subscribe anything
 * to it from the product.
 */
export function SubresourceField({
	spec,
	value,
	ctx,
	onChange,
}: {
	spec: SubresourceSpec;
	value: Row[];
	/** The PARENT field's context, threaded through rather than rebuilt. A locally-constructed ctx
	 * silently loses whatever the parent carries (today: account capabilities), so row selects would
	 * resolve against different data than the fields beside them. */
	ctx: FieldCtx;
	onChange: (next: Row[]) => void;
}) {
	const rows = value ?? [];

	const patchRow = (index: number, patch: Row) =>
		onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));

	const removeRow = (index: number) => onChange(rows.filter((_, i) => i !== index));

	return (
		<div className="border border-border">
			{rows.length > 0 && (
				<ul>
					{rows.map((row, i) => (
						// Rows are positional — the array index is their identity.
						// eslint-disable-next-line react/no-array-index-key
						<li key={i} className="space-y-2.5 border-b border-border/60 bg-surface-sunken p-2.5">
							<div className="flex items-center gap-2">
								<span className="min-w-0 flex-1 truncate font-mono text-xs">
									{spec.title(row, i) || `${spec.singular} ${i + 1}`}
								</span>
								<Button
									type="button"
									variant="ghost"
									size="icon"
									className="h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
									aria-label={`Remove ${spec.title(row, i) || `${spec.singular} ${i + 1}`}`}
									onClick={() => removeRow(i)}
								>
									<X className="h-3.5 w-3.5" />
								</Button>
							</div>

							<div className="grid grid-cols-2 gap-2">
								{spec.fields
									.filter((f) => !f.visibleWhen || f.visibleWhen(row, { ...ctx, config: row }))
									.map((field) => (
										<RowField
											key={field.key}
											field={field}
											row={row}
											ctx={ctx}
											onChange={(patch) => patchRow(i, patch)}
										/>
									))}
							</div>
						</li>
					))}
				</ul>
			)}
			<button
				type="button"
				onClick={() => onChange([...rows, spec.create()])}
				className="flex w-full items-center gap-1.5 px-2.5 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
			>
				<Plus className="h-3.5 w-3.5" />
				Add a {spec.singular}
			</button>
		</div>
	);
}

/** One field inside a row. A deliberately small subset — rows are flat by construction. */
function RowField({
	field,
	row,
	ctx,
	onChange,
}: {
	field: FieldDef<Row>;
	row: Row;
	ctx: FieldCtx;
	onChange: (patch: Row) => void;
}) {
	const fieldId = useId();
	const raw = row[field.key];
	// The parent's context with the ROW as config — same capabilities, same provider, row-scoped
	// config. Never a fresh ctx: that is how this file used to drift from config-fields.tsx.
	const rowCtx: FieldCtx = { ...ctx, config: row };
	const options =
		typeof field.options === "function" ? field.options(rowCtx) : field.options;

	const full = field.full || field.type === "text";

	return (
		<div className={cn("space-y-1", full && "col-span-2")}>
			<Label htmlFor={fieldId} className="vx-eyebrow text-ui-3xs">
				{field.label}
			</Label>
			{field.type === "select" && options ? (
				<OptionSelect
					id={fieldId}
					options={options}
					value={toStr(raw)}
					onChange={(v) => onChange({ [field.key]: v })}
					className="h-8 text-xs"
				/>
			) : field.type === "number" ? (
				<Input
					id={fieldId}
					type="number"
					value={typeof raw === "number" ? raw : ""}
					onChange={(e) =>
						onChange({
							[field.key]: e.target.value === "" ? null : Number(e.target.value),
						})
					}
					className="h-8 font-mono text-xs"
				/>
			) : (
				<Input
					id={fieldId}
					value={toStr(raw)}
					placeholder={
						typeof field.placeholder === "string" ? field.placeholder : undefined
					}
					onChange={(e) =>
						onChange({
							[field.key]: field.transform
								? field.transform(e.target.value)
								: e.target.value,
						})
					}
					className={cn("h-8 text-xs", field.mono && "font-mono")}
				/>
			)}
		</div>
	);
}
