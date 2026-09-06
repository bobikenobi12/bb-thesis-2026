"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { toNum, toRecord, toStr, toStrArray } from "@/lib/coerce";
import { ChevronDown } from "lucide-react";
import { useId, useMemo, useState } from "react";
import type { NodeKind } from "../graph/types";
import { validateNodeConfig } from "./node-validation";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@repo/ui/collapsible";
import { Input } from "@repo/ui/input";
import { Label } from "@repo/ui/label";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectTrigger,
	SelectValue,
} from "@repo/ui/select";
import { Switch } from "@repo/ui/switch";
import { cn } from "@repo/ui/utils";
import { ProviderIcon } from "@repo/ui/provider-icon";
import { RepositorySelector } from "@/components/repository-selector";
import { ListField } from "./list-field";
import { SubresourceField } from "./subresource-field";
import { BindingsField, type ServiceBinding } from "./bindings-field";
import { groupRegions, type CloudProviderSlug } from "@/lib/cloud-providers";
import {
	NO_CAPABILITIES,
	type CapabilityBag,
	type FieldCtx,
	type FieldDef,
	type FieldOption,
	type KindConfig,
	type Resolvable,
	type SectionDef,
} from "./config-schema";
import { provenanceNote, regionCodes, withSelected } from "./capability-options";
import { RadioCardGroup } from "./radio-card-group";
import { ConnectorSelect } from "./connector-select";

type Config = Record<string, unknown>;

/** Resolve a static-or-derived field attribute against the current context. */
function resolve<T>(
	r: Resolvable<T> | undefined,
	ctx: FieldCtx,
): T | undefined {
	if (typeof r !== "function") return r;
	// @ts-expect-error Resolvable<T> = T | ((ctx)=>T); T may itself be a function type, so typeof==="function" can't narrow r to the resolver
	return r(ctx);
}

/**
 * The grouped region dropdown. Takes the whole ctx rather than just `provider` so the account-aware
 * source lives in `capability-options.regionCodes` alongside every other picker, instead of this
 * file growing a second, divergent notion of "which regions exist".
 */
function RegionSelect({
	ctx,
	id,
	provider,
	value,
	onChange,
}: {
	ctx: FieldCtx;
	/** Ties the trigger to its `<Label htmlFor>` — see `OptionSelect`. */
	id?: string;
	provider: CloudProviderSlug;
	value: string;
	onChange: (v: string) => void;
}) {
	const groups = groupRegions(regionCodes(ctx), provider);
	return (
		<Select value={value || ""} onValueChange={onChange}>
			<SelectTrigger id={id} className="h-9 text-sm">
				<SelectValue placeholder="Region" />
			</SelectTrigger>
			<SelectContent>
				{groups.map((g) => (
					<SelectGroup key={g.group}>
						<SelectLabel>{g.group}</SelectLabel>
						{g.regions.map((r) => (
							<SelectItem key={r.value} value={r.value}>
								{r.label} ({r.value})
							</SelectItem>
						))}
					</SelectGroup>
				))}
			</SelectContent>
		</Select>
	);
}

/**
 * The one select that renders `FieldOption[]` — shared by the inspector's `select` fields and by
 * subresource rows, which previously carried their own copy and drifted from it.
 *
 * Advisory is INK ONLY. A `not_launchable` option stays selectable, because availability is
 * design-time guidance and the deploy is the authority (#918) — never pass `disabled`.
 */
export function OptionSelect({
	id,
	options,
	value,
	onChange,
	placeholder,
	className,
}: {
	id?: string;
	options: FieldOption[];
	value: string;
	onChange: (v: string) => void;
	placeholder?: string;
	className?: string;
}) {
	// Pin the stored value in, so a value the account can't launch (or one left over from a provider
	// change) can't vanish and leave a blank trigger silently disagreeing with the saved config.
	const opts = withSelected(options, value);
	return (
		<Select value={value || opts[0]?.value || ""} onValueChange={onChange}>
			<SelectTrigger id={id} className={className ?? "h-9 text-sm"}>
				<SelectValue placeholder={placeholder} />
			</SelectTrigger>
			<SelectContent>
				{opts.map((o) => (
					<SelectItem key={o.value} value={o.value}>
						<span className="flex items-center gap-2">
							<span
								className={cn(o.advisory?.level === "unavailable" && "text-muted-foreground")}
							>
								{o.label}
							</span>
							{o.advisory ? (
								<span
									className="vx-eyebrow shrink-0 text-ui-3xs text-muted-foreground"
									title={o.advisory.note}
								>
									{o.advisory.level === "unavailable" ? "unavailable" : "unverified"}
								</span>
							) : null}
						</span>
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

/**
 * A free-text field that SUGGESTS the account's offerings — the control for a value the cloud may
 * never list back.
 *
 * `instance_class` and a cache `engine_version` are the escape hatches: they override the portable
 * model with a provider-specific string, and a user must be able to pin one the enumeration lanes
 * have not reported (an account that hasn't synced, a SKU only orderable on an older version, a
 * region the anchor didn't cover). A `<Select>` structurally cannot hold such a value, so these keep
 * a real input — the suggestions are additive, never a gate.
 *
 * The input IS the value: typing patches the config exactly as the plain text control does, so the
 * list never has to open for the field to work. Suggestions filter on what has been typed.
 *
 * Deliberately NOT a base-ui Popover, for the reason `@repo/ui/multi-combobox` documents: an
 * input-is-the-trigger typeahead fights that trigger/dismiss model (opening on focus vs its
 * outside-press dismiss). This mirrors that component instead — controlled `open`, closed on blur,
 * rows `preventDefault` their mousedown so a click doesn't blur the input out from under itself.
 *
 * Advisory is INK ONLY here as well (#918): a `not_launchable` suggestion stays pickable.
 */
export function OptionCombobox({
	id,
	options,
	value,
	onChange,
	placeholder,
	mono,
}: {
	id?: string;
	options: FieldOption[];
	value: string;
	onChange: (v: string) => void;
	placeholder?: string;
	mono?: boolean;
}) {
	const [open, setOpen] = useState(false);
	const q = value.trim().toLowerCase();
	// Filter on the typed text, but never hide everything just because the value matches one option
	// exactly — after picking a suggestion the list would otherwise collapse to that single row.
	const filtered = q
		? options.filter((o) => `${o.value} ${o.label}`.toLowerCase().includes(q))
		: options;

	return (
		<div className="relative">
			{/* The `role="combobox"` STAYS, against #3756's third bullet, and the two claims that
			    bullet rests on were both measured false against the pinned versions:

			    1. "The role is untrue: no text input." There IS one — this control is an `<input>` the
			       user types into, and `<input role="combobox">` is the ARIA 1.2 combobox pattern
			       itself. The other two sites the issue names are `<button>`s inside a base-ui
			       Popover, where the role is untrue and comes off; this one is the opposite shape,
			       which is why it is the one the issue asked to check before changing.
			    2. "axe covers it under `aria-input-field-name`." It does not. That rule's `matches` is
			       `noNamingMethodMatches`, which excludes any element whose host language already
			       gives it a naming method — and `<input>` has one. Driven against axe-core 4.13.0 in
			       jsdom, `<input role="combobox">` with no name at all comes back INAPPLICABLE to all
			       three name rules, not violating. The rule fires on `<div role="combobox">`, where
			       there is no native label to fall back on.

			    What names this input is the same thing that names it without the role: it is a
			    labelable element, `FieldRow` renders a real `<Label htmlFor>`, and the accessible name
			    is the field's label. Removing a true role to satisfy a rule that never applied would
			    have traded a working typeahead announcement for nothing. The sweep asserts the NAME,
			    so the claim survives either way. */}
			<Input
				id={id}
				value={value}
				placeholder={placeholder}
				autoComplete="off"
				role="combobox"
				aria-expanded={open}
				className={cn("h-9 text-sm", mono && "font-mono")}
				onChange={(e) => {
					onChange(e.target.value);
					setOpen(true);
				}}
				onFocus={() => setOpen(true)}
				onBlur={() => setOpen(false)}
			/>
			{/* The list below is a typeahead popover, so it takes the overlay rung by NAME. `z-50`
			    sat in the gap the scale leaves empty (its in-flow lifts stop at 30, its chrome
			    starts at 100), so it painted under the site header and under the sheet this
			    inspector opens inside — the one place a combobox must never be. */}
			{open && options.length > 0 ? (
				<div className="absolute top-full left-0 z-[var(--z-overlay)] mt-1 w-full rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md">
					<div className="max-h-56 overflow-y-auto">
						{filtered.length === 0 ? (
							// Not an error: an unlisted value is a legitimate pin, so the input keeps it.
							<div className="px-2 py-3 text-center text-xs text-muted-foreground">
								No matches — your value is kept as typed.
							</div>
						) : (
							filtered.map((o) => (
								<button
									key={o.value}
									type="button"
									// Keep focus in the input so the click lands before the blur closes us.
									onMouseDown={(e) => e.preventDefault()}
									onClick={() => {
										onChange(o.value);
										setOpen(false);
									}}
									className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent"
								>
									<span
										className={cn(
											"min-w-0 flex-1 truncate",
											o.advisory?.level === "unavailable" && "text-muted-foreground",
										)}
									>
										{o.label}
									</span>
									{o.advisory ? (
										<span
											className="vx-eyebrow shrink-0 text-ui-3xs text-muted-foreground"
											title={o.advisory.note}
										>
											{o.advisory.level === "unavailable" ? "unavailable" : "unverified"}
										</span>
									) : null}
								</button>
							))
						)}
					</div>
				</div>
			) : null}
		</div>
	);
}

/** Render one field's control. */
function FieldControl({
	field,
	ctx,
	onChange,
	id,
}: {
	field: FieldDef;
	ctx: FieldCtx;
	onChange: (patch: Config) => void;
	/** Ties the control to its <Label>. Without it the label is decorative and screen readers —
	 * and every accessible query — can't find the input. */
	id?: string;
}) {
	const { provider, config } = ctx;
	const raw = field.get ? field.get(config) : config[field.key];
	const patch = (value: unknown) =>
		onChange(field.set ? field.set(value, config) : { [field.key]: value });

	if (field.requiresProvider && !provider) {
		return (
			<p className="text-xs text-muted-foreground">
				Select a cloud account to configure this.
			</p>
		);
	}

	// Same slot-replacement as above, for a field this cell cannot honor. Prose instead of a disabled
	// control, so one gate covers all eleven field types rather than each inventing its own `disabled`
	// plumbing. (Switches render in FieldRow and handle it themselves — a toggle you can SEE is off is
	// a better answer than a sentence where the toggle used to be.)
	const unavailable = field.unavailableWhen?.(config, ctx) ?? null;
	if (unavailable) {
		return <p className="text-xs text-muted-foreground">{unavailable}</p>;
	}

	switch (field.type) {
		case "text":
			return (
				<Input
					id={id}
					value={toStr(raw)}
					placeholder={resolve(field.placeholder, ctx)}
					className={cn("h-9 text-sm", field.mono && "font-mono")}
					onChange={(e) =>
						patch(
							field.transform
								? field.transform(e.target.value)
								: e.target.value,
						)
					}
				/>
			);

		case "number": {
			const step = resolve(field.step, ctx);
			const isFloat = field.float || (typeof step === "number" && step < 1);
			return (
				<Input
					id={id}
					type="number"
					min={resolve(field.min, ctx)}
					max={resolve(field.max, ctx)}
					step={step}
					placeholder={resolve(field.placeholder, ctx)}
					value={toNum(raw)}
					className="h-9 text-sm"
					onChange={(e) => {
						const n = isFloat
							? Number.parseFloat(e.target.value)
							: Number.parseInt(e.target.value, 10);
						// Clearing an OPTIONAL number field means "use the default" → patch null
						// (the columns are nullable; 0 would trip min(1) validation with no way
						// back). Required numbers keep the legacy 0 so they never go null.
						patch(Number.isNaN(n) ? (field.optional ? null : 0) : n);
					}}
				/>
			);
		}

		case "select":
			return (
				<OptionSelect
					id={id}
					options={resolve(field.options, ctx) ?? []}
					value={toStr(raw)}
					onChange={patch}
					placeholder={resolve(field.placeholder, ctx)}
				/>
			);

		// A value the cloud may never list back (a SKU, an engine version) has to stay TYPEABLE — a
		// select can only hold what is in its list. The suggestions are the account's real offerings.
		case "combobox":
			return (
				<OptionCombobox
					id={id}
					options={resolve(field.options, ctx) ?? []}
					value={toStr(raw)}
					onChange={patch}
					placeholder={resolve(field.placeholder, ctx)}
					mono={field.mono}
				/>
			);

		case "radio-card": {
			const options = resolve(field.options, ctx) ?? [];
			return (
				<RadioCardGroup
					ariaLabel={field.label}
					value={toStr(raw) || options[0]?.value || ""}
					onChange={patch}
					options={options}
					columns={options.length >= 2 ? 2 : 1}
				/>
			);
		}

		case "switch":
			// Switches render as a full labelled row (handled in FieldRow); this is unreachable.
			return null;

		case "region":
			return provider ? (
				<RegionSelect
					ctx={ctx}
					id={id}
					provider={provider}
					value={toStr(raw)}
					onChange={patch}
				/>
			) : null;

		case "repository":
			return (
				<RepositorySelector
					label=""
					placeholder="Select repository"
					value={toStr(raw) || undefined}
					onChange={(v) => patch(v || "")}
				/>
			);

		case "list":
			return (
				<ListField
					ariaLabel={field.label}
					value={toStrArray(raw)}
					placeholder={field.item?.placeholder}
					mono={field.item?.mono ?? field.mono}
					// Blank rows are dropped on write: an empty CIDR isn't a value, and letting one
					// through would fail zod at deploy with a confusing message.
					onChange={(next) => patch(next.filter((v) => v.trim() !== ""))}
				/>
			);

		case "subresource":
			return field.sub ? (
				<SubresourceField
					spec={field.sub}
					ctx={ctx}
					value={Array.isArray(raw) ? raw : []}
					onChange={patch}
				/>
			) : null;

		case "bindings":
			return (
				<BindingsField
					value={Array.isArray(raw) ? raw : []}
					onChange={patch}
					// The service inspector surfaces BYO-IaC resources as bind targets + the facet→output
					// picker; the chart-workload lane (its own panel) leaves it off (#823).
					enableIacTargets
				/>
			);

		case "connector":
			// Writes two keys at once, so it bypasses the single-key `patch` helper above — the
			// provider's knobs are only meaningful alongside the slug that declares them.
			return field.category ? (
				<ConnectorSelect
					id={id}
					category={field.category}
					value={toStr(raw) || null}
					providerConfig={toRecord(config.provider_config)}
					hiddenKnobs={field.hiddenKnobs}
					onChange={onChange}
				/>
			) : null;
	}
}

/** A field wrapped with its label (or, for switches, a label+switch row). */
function FieldRow({
	field,
	ctx,
	onChange,
	error,
}: {
	field: FieldDef;
	ctx: FieldCtx;
	onChange: (patch: Config) => void;
	/** W4 — the inline zod validation message for this field, if it's currently invalid. */
	error?: string;
}) {
	const fieldId = useId();
	const raw = field.get ? field.get(ctx.config) : ctx.config[field.key];
	const unit = resolve(field.unit, ctx);
	const label = unit ? `${field.label} (${unit})` : field.label;
	// Resolved here (not inside FieldControl) so the count reflects exactly what the control renders.
	const provenance = provenanceNote(
		ctx,
		field.capabilityAxis,
		(resolve(field.options, ctx) ?? []).length,
	);

	if (field.type === "switch") {
		// A switch renders here rather than in FieldControl, so it owns both gates itself.
		// `requiresProvider` first: with no cloud picked there is nothing to be unavailable ON, and
		// letting `unavailableWhen` answer that too would give one question two owners.
		const needsProvider = Boolean(field.requiresProvider) && !ctx.provider;
		const unavailable = needsProvider
			? null
			: (field.unavailableWhen?.(ctx.config, ctx) ?? null);
		const note = needsProvider
			? "Select a cloud account to configure this."
			: unavailable;
		const off = Boolean(needsProvider || unavailable);
		return (
			<div
				className={cn(
					"col-span-full flex items-center justify-between gap-4 rounded-none border px-3 py-2.5",
					// Hairline weight is the de-emphasis, the same move `advanced` makes with a sunken
					// surface. No colour: an unavailable cell is a fact, not a warning.
					off ? "border-border/40" : "border-border/60",
				)}
			>
				<div className="min-w-0">
					<p
						className={cn(
							"flex items-center gap-2 text-sm font-medium",
							off && "text-muted-foreground",
						)}
					>
						{field.label}
						{/* Same typography as the option advisory above, a DIFFERENT mechanism: that one
						    is ink-only and must never disable (#918), this one marks a real gate. */}
						{unavailable && (
							<span className="vx-eyebrow shrink-0 text-ui-3xs text-muted-foreground">
								unavailable
							</span>
						)}
					</p>
					{(note ?? field.description) && (
						<p id={`${fieldId}-note`} className="mt-0.5 text-xs text-muted-foreground">
							{note ?? field.description}
						</p>
					)}
				</div>
				{/* A switch's label is a sibling <p>, not a <Label htmlFor>, so without these the
				    control has NO accessible name — a screen reader reads "switch, off" and the reason
				    for a disabled one is never announced at all. */}
				<Switch
					aria-label={field.label}
					aria-describedby={note ?? field.description ? `${fieldId}-note` : undefined}
					checked={off ? false : raw !== false}
					disabled={off}
					onCheckedChange={(v) => onChange({ [field.key]: v })}
				/>
				{error && (
					<p className="col-span-full text-xs font-medium text-foreground">{error}</p>
				)}
			</div>
		);
	}

	const full =
		field.full ||
		field.type === "radio-card" ||
		field.type === "region" ||
		field.type === "repository" ||
		field.type === "list" ||
		field.type === "subresource" ||
		field.type === "bindings";

	// Composite controls (list / subresource / bindings / radio-card / repository) label their own
	// inner rows, so the section label stays decorative for those; everything else gets a real
	// label→control binding.
	//
	// `repository` joined that list in #3756. `RepositorySelector` is a SHELL of three controls — a
	// provider select, the repository trigger, and a refresh/relink button — and `htmlFor` binds
	// exactly one element, so the id it was being handed matched nothing at all and the `<Label>`
	// was decorative in fact while claiming otherwise. Each of those controls now names itself.
	const composite =
		field.type === "list" ||
		field.type === "subresource" ||
		field.type === "bindings" ||
		field.type === "radio-card" ||
		field.type === "repository";

	return (
		<div className={cn("space-y-1.5", full && "col-span-full")}>
			<Label htmlFor={composite ? undefined : fieldId} className="text-xs">
				{label}
			</Label>
			<FieldControl
				field={field}
				ctx={ctx}
				onChange={onChange}
				id={composite ? undefined : fieldId}
			/>
			{error ? (
				// The inline zod error replaces the description while the field is invalid (W4). Grayscale
				// per the design system — emphasis reads through weight, not hue.
				<p className="text-xs font-medium text-foreground">{error}</p>
			) : (
				field.description &&
				field.type !== "radio-card" && (
					<p className="text-xs text-muted-foreground">{field.description}</p>
				)
			)}
			{/* Provenance, once per field rather than per option: is this list THIS account's, or the
			    whole catalog? The fail-open is invisible in the options by design, so without this the
			    two read identically. Informational only — it gates nothing. */}
			{provenance && (
				<p className="vx-eyebrow text-ui-2xs text-muted-foreground">{provenance}</p>
			)}
		</div>
	);
}

/** Compact one-line summary of a section's current values (for the collapsed header). */
function sectionSummary(section: SectionDef, ctx: FieldCtx): string {
	const chips: string[] = [];
	for (const field of section.fields) {
		if (chips.length >= 2) break;
		if (field.type === "switch") continue;
		// A list of twelve CIDRs is not a one-line summary; count them instead.
		if (
			field.type === "list" ||
			field.type === "subresource" ||
			field.type === "bindings"
		) {
			const items = field.get ? field.get(ctx.config) : ctx.config[field.key];
			if (Array.isArray(items) && items.length > 0) chips.push(`${items.length}`);
			continue;
		}
		if (field.visibleWhen && !field.visibleWhen(ctx.config, ctx)) continue;
		const raw = field.get ? field.get(ctx.config) : ctx.config[field.key];
		if (raw == null || raw === "") continue;
		if (field.type === "select" || field.type === "radio-card") {
			const opts = resolve(field.options, ctx) ?? [];
			chips.push(
				opts.find((o: FieldOption) => o.value === raw)?.label ?? String(raw),
			);
		} else if (field.type === "number") {
			const unit = resolve(field.unit, ctx);
			chips.push(unit ? `${raw} ${unit}` : String(raw));
		} else {
			chips.push(String(raw));
		}
	}
	return chips.join(" · ");
}

/** A single collapsible settings section. */
function Section({
	section,
	ctx,
	onChange,
	errors,
}: {
	section: SectionDef;
	ctx: FieldCtx;
	onChange: (patch: Config) => void;
	errors: Record<string, string>;
}) {
	const advanced = section.tier === "advanced";
	const fields = section.fields.filter(
		(f) => !f.visibleWhen || f.visibleWhen(ctx.config, ctx),
	);
	// A collapsed section hiding an invalid field would hide the error, so open it when one of its
	// fields is failing (W4).
	const hasError = fields.some((f) => errors[f.key]);
	// Advanced = provider-specific knobs. Collapsed by default, so the portable fields stay the
	// thing you see first; you have to deliberately open the door to leave cloud-indifferent ground.
	const [open, setOpen] = useState(section.defaultOpen ?? false);
	const summary = sectionSummary(section, ctx);

	// A section scoped to clouds this project isn't on doesn't exist for it.
	if (
		section.providerScope &&
		(!ctx.provider || !section.providerScope.includes(ctx.provider))
	) {
		return null;
	}

	// A section whose every field is hidden (e.g. provider-gated sizing) renders nothing.
	if (fields.length === 0) return null;

	return (
		<Collapsible
			open={open || hasError}
			onOpenChange={setOpen}
			className={cn(
				"rounded-none border border-border",
				advanced && "bg-surface-sunken/40",
				hasError && "border-foreground/40",
			)}
		>
			<CollapsibleTrigger className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left">
				<span className="flex min-w-0 flex-1 items-center gap-2">
					<span className="min-w-0">
						<span className="block text-sm font-medium">{section.title}</span>
						{!open && summary && (
							<span className="block truncate text-xs text-muted-foreground">
								{summary}
							</span>
						)}
					</span>
					{/* Badge the cloud whose knobs these are, so it's obvious the field is not portable. */}
					{advanced && ctx.provider && (
						<span className="ml-1 inline-flex shrink-0 items-center gap-1 border border-border-strong px-1.5 py-0.5 font-mono text-ui-3xs uppercase tracking-wide text-muted-foreground">
							<ProviderIcon provider={ctx.provider} size={10} />
							only
						</span>
					)}
				</span>
				<ChevronDown
					className={cn(
						"h-4 w-4 shrink-0 text-muted-foreground transition-transform",
						open && "rotate-180",
					)}
				/>
			</CollapsibleTrigger>
			<CollapsibleContent className="grid grid-cols-1 gap-4 border-t border-border/60 px-4 py-4 sm:grid-cols-2">
				{fields.map((field) => (
					<FieldRow
						key={field.key}
						field={field}
						ctx={ctx}
						onChange={onChange}
						error={errors[field.key]}
					/>
				))}
			</CollapsibleContent>
		</Collapsible>
	);
}

/** Renders a node kind's whole Settings body from its config schema. */
export function ConfigFields({
	schema,
	config,
	provider,
	onChange,
	kind,
	capabilities,
}: {
	schema: KindConfig;
	config: Config;
	provider: CloudProviderSlug | null;
	onChange: (patch: Config) => void;
	/** When set, each field is validated inline against this kind's zod item schema (W4). Omit for
	 * surfaces that don't want inline errors. */
	kind?: NodeKind;
	/** Account-scoped options for this node's effective identity. OPTIONAL and defaulted, so every
	 * existing mount point and test keeps working and simply resolves the static catalog. */
	capabilities?: CapabilityBag;
}) {
	const ctx: FieldCtx = { provider, config, caps: capabilities ?? NO_CAPABILITIES };
	// W4 — validate against the DB-derived per-node schema so what the form accepts conforms to what
	// the DB stores. Draft→Save is unchanged; this only surfaces per-field errors as you edit.
	const errors = useMemo(
		() => (kind ? validateNodeConfig(kind, config) : {}),
		[kind, config],
	);
	return (
		<div className="space-y-3">
			{schema.sections.map((section) => (
				<Section
					key={section.id}
					section={section}
					ctx={ctx}
					onChange={onChange}
					errors={errors}
				/>
			))}
		</div>
	);
}
