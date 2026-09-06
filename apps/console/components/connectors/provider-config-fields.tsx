"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Renders a pluggable connector's NON-SECRET knobs (`providerConfigFields` in the generated
// registry) as a form. These are the per-project half of a connector: the secret lives once on the
// org's `connector_credentials` row, while the host/URL/path that varies per project lives in the
// component row's `provider_config` JSONB.
//
// Declarative on purpose — the field set comes from `packages/core/categories/catalog.json`, so a
// new provider (or a new knob on an existing one) needs no component change. Written against a
// plain `values` + `onChange` contract rather than react-hook-form so the canvas inspector (which is
// config+patch, not RHF) and the connector sheets can share it. `helm_registry` is the first
// consumer; `registry`, `secrets` and `dns` have the same shape and no per-project surface yet.

import { Input } from "@repo/ui/input";
import { Label } from "@repo/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@repo/ui/select";
import { Switch } from "@repo/ui/switch";
import { FieldHelp } from "@repo/ui/field-help";
import type { ConnectorField } from "@/lib/connectors/registry.generated";

interface ProviderConfigFieldsProps {
	fields: ConnectorField[];
	/** Current `provider_config` contents. */
	values: Record<string, string | boolean | undefined>;
	onChange: (key: string, value: string | boolean) => void;
	/** Per-key validation message, keyed like `values`. */
	errors?: Record<string, string>;
	/** Prefix for input ids so two instances on one page don't collide. */
	idPrefix: string;
	disabled?: boolean;
}

/** The declarative renderer for a provider's non-secret configuration knobs. */
export function ProviderConfigFields({
	fields,
	values,
	onChange,
	errors,
	idPrefix,
	disabled,
}: ProviderConfigFieldsProps) {
	if (fields.length === 0) return null;
	return (
		<div className="flex flex-col gap-3">
			{fields.map((field) => {
				const id = `${idPrefix}-${field.key}`;
				const error = errors?.[field.key];
				const raw = values[field.key];
				return (
					<div key={field.key} className="flex flex-col gap-1.5">
						{field.type === "boolean" ? (
							<div className="flex items-center justify-between gap-3">
								<Label htmlFor={id} className="font-normal">
									{field.label}
								</Label>
								<Switch
									id={id}
									checked={typeof raw === "boolean" ? raw : Boolean(field.default)}
									onCheckedChange={(next) => onChange(field.key, next)}
									disabled={disabled}
								/>
							</div>
						) : (
							<>
								<div className="flex items-center gap-1.5">
									<Label htmlFor={id}>{field.label}</Label>
									{field.required ? (
										<span className="vx-eyebrow text-ui-2xs text-muted-foreground">
											required
										</span>
									) : null}
									{field.help ? (
										<FieldHelp title={field.label}>{field.help}</FieldHelp>
									) : null}
								</div>
								{field.type === "select" ? (
									<Select
										value={typeof raw === "string" ? raw : String(field.default ?? "")}
										onValueChange={(next) => onChange(field.key, next)}
										disabled={disabled}
									>
										<SelectTrigger id={id} className="h-8 text-xs">
											<SelectValue placeholder="Select…" />
										</SelectTrigger>
										<SelectContent>
											{(field.options ?? []).map((option) => (
												<SelectItem key={option} value={option}>
													{option}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								) : (
									<Input
										id={id}
										type={field.secret ? "password" : "text"}
										value={typeof raw === "string" ? raw : ""}
										onChange={(e) => onChange(field.key, e.target.value)}
										placeholder={
											typeof field.default === "string" ? field.default : undefined
										}
										className="h-8 font-mono text-xs"
										disabled={disabled}
										aria-invalid={error ? true : undefined}
									/>
								)}
							</>
						)}
						{error ? <p className="text-xs text-destructive">{error}</p> : null}
					</div>
				);
			})}
		</div>
	);
}
