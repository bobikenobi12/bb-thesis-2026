"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { coerceEnum } from "@/lib/coerce";
import type { z } from "zod";
import type { serviceBindingSchema } from "@/lib/validations/project-form.schema";
import { ArrowRight, Plus, X } from "lucide-react";
import { Button } from "@repo/ui/button";
import { Input } from "@repo/ui/input";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectTrigger,
	SelectValue,
} from "@repo/ui/select";
import { useCanvasStore } from "@/lib/stores/use-canvas-store";
import { configName } from "../graph/node-config";
import { type NodeKind, nodeOfKind } from "../graph/types";

/**
 * A service→backing-infra binding. A service declares which resources it needs and which environment
 * variables each connection injects; the runner resolves them at deploy — non-secret facets
 * (endpoint/port) as templated values, credential facets as a Kubernetes `secretKeyRef`. The shape
 * mirrors `serviceBindingSchema` (lib/validations/project-form.schema.ts) exactly.
 */
const BINDING_TARGET_KINDS = ["database", "cache", "queue", "secret"] as const;
export type BindingTargetKind = (typeof BINDING_TARGET_KINDS)[number];
// DERIVED from serviceBindingSchema, not re-listed. This union was hand-maintained and drifted the
// moment the `value` facet was added to the zod schema + the service_binding_facet pgEnum — a
// type-only import keeps it honest with zero runtime cost, so the next facet cannot half-land again.
export type BindingFrom = z.infer<
	typeof serviceBindingSchema
>["inject"][number]["from"];
/**
 * A BYO-IaC target's facet→output mapping: which of the customer module's tofu outputs carries each
 * facet's value. Only set when the target is a BYO-IaC resource (`target.address`). Mirrors
 * `ServiceBindingOutputKeys` in jsonb.types.ts / the Go `ServiceBindingTarget`.
 */
export interface ServiceBindingOutputKeys {
	endpoint?: string;
	port?: string;
	credential_secret?: string;
}
export interface ServiceBinding {
	target: {
		kind: BindingTargetKind;
		name: string;
		/** Terraform address — set only for a BYO-IaC target; "" / absent for a first-class one. */
		address?: string;
		/** The customer module's output names per facet — only for a BYO-IaC target. */
		output_keys?: ServiceBindingOutputKeys;
	};
	inject: { env: string; from: BindingFrom }[];
}

const TARGET_KINDS: { value: BindingTargetKind; label: string }[] = [
	{ value: "database", label: "Database" },
	{ value: "cache", label: "Cache" },
	{ value: "queue", label: "Queue" },
	{ value: "secret", label: "Secret" },
];

/** Which facets are credentials — delivered as a secretKeyRef, never written into the manifest. */
const FROM_FACETS: { value: BindingFrom; label: string; secret: boolean }[] = [
	{ value: "endpoint", label: "endpoint", secret: false },
	{ value: "port", label: "port", secret: false },
	{ value: "username", label: "username", secret: true },
	{ value: "password", label: "password", secret: true },
	{ value: "connection_string", label: "connection string", secret: true },
	// value — a `secret`-kind binding's single opaque value (a project secret resolved from a
	// pluggable SaaS store via ESO). Always a credential: delivered as a secretKeyRef, never
	// templated into the manifest.
	{ value: "value", label: "value", secret: true },
];

const isSecretFacet = (from: BindingFrom): boolean =>
	FROM_FACETS.find((f) => f.value === from)?.secret ?? false;

/** Radix Select forbids an empty-string value, so the "not mapped" option carries this sentinel. */
const OUTPUT_NONE = "__none__";

/**
 * One facet→output row for a BYO-IaC binding: a Select over the module's declared outputs, plus a
 * "not mapped" choice that clears the mapping (⇒ the facet is unsatisfiable at deploy, mirroring the
 * runner's fail-closed report). Value `undefined` means unmapped.
 */
function FacetOutputRow({
	label,
	hint,
	noneLabel,
	value,
	outputs,
	onChange,
}: {
	label: string;
	hint?: string;
	noneLabel: string;
	value: string | undefined;
	outputs: string[];
	onChange: (next: string | undefined) => void;
}) {
	return (
		<div className="space-y-1">
			<span className="vx-eyebrow text-ui-3xs">{label}</span>
			<Select
				value={value || OUTPUT_NONE}
				onValueChange={(v) => onChange(v === OUTPUT_NONE ? undefined : v)}
			>
				<SelectTrigger className="h-8 font-mono text-xs">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					<SelectItem value={OUTPUT_NONE}>{noneLabel}</SelectItem>
					{outputs.map((o) => (
						<SelectItem key={o} value={o} className="font-mono">
							{o}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			{hint ? (
				<p className="text-ui-2xs leading-tight text-muted-foreground">{hint}</p>
			) : null}
		</div>
	);
}

/**
 * The Bindings editor — a service's edges to the infrastructure it depends on. Each row picks a
 * backing resource (by kind + a real node on the canvas) and lists the env vars its connection
 * injects. Unlike the generic subresource row editor, a binding nests a variable-length `inject[]`,
 * so it gets its own field type.
 */
export function BindingsField({
	value,
	onChange,
	enableIacTargets = false,
}: {
	value: ServiceBinding[];
	onChange: (next: ServiceBinding[]) => void;
	/**
	 * Surface BYO-IaC resources (external module cards) as bind targets and show the facet→output
	 * picker. Only the SERVICE inspector opts in — the chart-workload lane does not resolve
	 * `output_keys`, so it leaves this off and behaves exactly as before (#823).
	 */
	enableIacTargets?: boolean;
}) {
	const nodes = useCanvasStore((s) => s.nodes);
	const iacOutputs = useCanvasStore((s) => s.iacOutputs);
	const bindings = value ?? [];

	/** Canvas resources of a given kind, as first-class target-name options. */
	const namesForKind = (kind: BindingTargetKind): string[] =>
		nodes
			.filter((n) => n.data.kind === kind)
			.map((n) => configName(n.data))
			.filter((name): name is string => !!name);

	/**
	 * BYO-IaC resources of a given kind: members of the customer module's external cards whose
	 * `mappedKind` matches. Each is a bind target identified by its Terraform address (the unique
	 * join key). Empty unless the caller opted in — mirrors the backend's db/cache/queue kind gate.
	 */
	const iacTargetsForKind = (
		kind: BindingTargetKind,
	): { name: string; address: string }[] => {
		if (!enableIacTargets) return [];
		const out: { name: string; address: string }[] = [];
		for (const n of nodes) {
			const ext = nodeOfKind(n, "external");
			if (ext && ext.data.config.mappedKind === kind) {
				for (const m of ext.data.config.members) {
					out.push({ name: m.name, address: m.address });
				}
			}
		}
		return out;
	};

	const patchBinding = (index: number, next: ServiceBinding) =>
		onChange(bindings.map((b, i) => (i === index ? next : b)));
	const removeBinding = (index: number) =>
		onChange(bindings.filter((_, i) => i !== index));
	const addBinding = () =>
		onChange([
			...bindings,
			{ target: { kind: "database", name: "" }, inject: [] },
		]);

	return (
		<div className="space-y-2">
			{bindings.map((binding, bi) => {
				const names = namesForKind(binding.target.kind);
				const iacTargets = iacTargetsForKind(binding.target.kind);
				const hasResourceOptions = names.length > 0 || iacTargets.length > 0;
				// A BYO-IaC target is keyed by its (unique) address; a first-class one by name.
				const resourceValue = binding.target.address || binding.target.name || "";
				// Which facets this binding injects — drives which output pickers show for a BYO target.
				const injectsEndpoint = binding.inject.some((i) => i.from === "endpoint");
				const injectsPort = binding.inject.some((i) => i.from === "port");
				const injectsCredential = binding.inject.some((i) => isSecretFacet(i.from));
				const pickResource = (v: string) => {
					const iac = iacTargets.find((t) => t.address === v);
					patchBinding(
						bi,
						iac
							? // BYO-IaC target: carry its address + reset the facet→output mapping.
								{ ...binding, target: { kind: binding.target.kind, name: iac.name, address: iac.address, output_keys: {} } }
							: // First-class component: clear any BYO fields.
								{ ...binding, target: { kind: binding.target.kind, name: v } },
					);
				};
				const patchOutputKey = (
					facet: keyof ServiceBindingOutputKeys,
					next: string | undefined,
				) =>
					patchBinding(bi, {
						...binding,
						target: {
							...binding.target,
							output_keys: { ...binding.target.output_keys, [facet]: next },
						},
					});
				return (
					// Bindings are positional — the array index is their identity.
					// eslint-disable-next-line react/no-array-index-key
					<div key={bi} className="space-y-2.5 border border-border bg-surface-sunken p-2.5">
						<div className="flex items-center gap-2">
							<span className="min-w-0 flex-1 truncate font-mono text-xs">
								{binding.target.name
									? `${binding.target.kind} · ${binding.target.name}`
									: `Bind a ${binding.target.kind}`}
							</span>
							<Button
								type="button"
								variant="ghost"
								size="icon"
								className="h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
								aria-label="Remove binding"
								onClick={() => removeBinding(bi)}
							>
								<X className="h-3.5 w-3.5" />
							</Button>
						</div>

						<div className="grid grid-cols-2 gap-2">
							<div className="space-y-1">
								<span className="vx-eyebrow text-ui-3xs">Target kind</span>
								<Select
									value={binding.target.kind}
									onValueChange={(v) =>
										patchBinding(bi, {
											...binding,
											// Changing kind clears the name — it referenced a resource of the old kind.
											target: { kind: coerceEnum(v, BINDING_TARGET_KINDS, "database"), name: "" },
										})
									}
								>
									<SelectTrigger className="h-8 text-xs">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{TARGET_KINDS.map((k) => (
											<SelectItem key={k.value} value={k.value}>
												{k.label}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>
							<div className="space-y-1">
								<span className="vx-eyebrow text-ui-3xs">Resource</span>
								{hasResourceOptions ? (
									<Select value={resourceValue} onValueChange={pickResource}>
										<SelectTrigger className="h-8 text-xs">
											<SelectValue placeholder="Choose one" />
										</SelectTrigger>
										<SelectContent>
											{names.length > 0 ? (
												<SelectGroup>
													{iacTargets.length > 0 ? (
														<SelectLabel>In this design</SelectLabel>
													) : null}
													{names.map((name) => (
														<SelectItem key={name} value={name}>
															{name}
														</SelectItem>
													))}
												</SelectGroup>
											) : null}
											{iacTargets.length > 0 ? (
												<SelectGroup>
													<SelectLabel>BYO-IaC module</SelectLabel>
													{iacTargets.map((t) => (
														<SelectItem key={t.address} value={t.address}>
															<span className="font-mono">{t.name}</span>
															<span className="ml-1.5 font-mono text-ui-2xs text-muted-foreground">
																{t.address}
															</span>
														</SelectItem>
													))}
												</SelectGroup>
											) : null}
										</SelectContent>
									</Select>
								) : (
									// No resource of this kind on the canvas yet — let them type the name it will have.
									<Input
										value={binding.target.name}
										placeholder={`no ${binding.target.kind} on canvas`}
										className="h-8 font-mono text-xs"
										onChange={(e) =>
											patchBinding(bi, {
												...binding,
												target: { ...binding.target, name: e.target.value },
											})
										}
									/>
								)}
							</div>
						</div>

						<div className="space-y-1.5">
							<span className="vx-eyebrow text-ui-3xs">Inject</span>
							{binding.inject.map((inj, ii) => (
								// Injections are positional too.
								// eslint-disable-next-line react/no-array-index-key
								<div key={ii} className="flex items-center gap-1.5">
									<Input
										value={inj.env}
										placeholder="ENV_VAR"
										className="h-8 flex-1 font-mono text-xs"
										onChange={(e) =>
											patchBinding(bi, {
												...binding,
												inject: binding.inject.map((x, j) =>
													j === ii ? { ...x, env: e.target.value } : x,
												),
											})
										}
									/>
									<ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
									<Select
										value={inj.from}
										onValueChange={(v) =>
											patchBinding(bi, {
												...binding,
												inject: binding.inject.map((x, j) =>
													j === ii ? { ...x, from: coerceEnum(v, FROM_FACETS.map((ff) => ff.value), FROM_FACETS[0].value) } : x,
												),
											})
										}
									>
										<SelectTrigger className="h-8 w-[44%] text-xs">
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											{FROM_FACETS.map((f) => (
												<SelectItem key={f.value} value={f.value}>
													{f.label}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
									{isSecretFacet(inj.from) && (
										<span className="shrink-0 rounded-sm border border-border px-1 font-mono text-ui-3xs uppercase tracking-wide text-muted-foreground">
											secret
										</span>
									)}
									<Button
										type="button"
										variant="ghost"
										size="icon"
										className="h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
										aria-label="Remove injection"
										onClick={() =>
											patchBinding(bi, {
												...binding,
												inject: binding.inject.filter((_, j) => j !== ii),
											})
										}
									>
										<X className="h-3.5 w-3.5" />
									</Button>
								</div>
							))}
							<button
								type="button"
								className="flex items-center gap-1.5 rounded-sm border border-dashed border-border-strong px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:border-border hover:text-foreground"
								onClick={() =>
									patchBinding(bi, {
										...binding,
										inject: [...binding.inject, { env: "", from: "endpoint" }],
									})
								}
							>
								<Plus className="h-3.5 w-3.5" />
								Inject a value
							</button>
						</div>

						{/* BYO-IaC facet→output mapping — only for a BYO-IaC target (has an address), and only
						    where the context resolves output_keys (services, not chart workloads — gated by
						    enableIacTargets). The customer module's outputs follow their own naming, so each
						    injected facet must be mapped to the output that carries it (#823); unmapped is
						    unsatisfiable. */}
						{enableIacTargets && binding.target.address ? (
							<div className="space-y-2 border-t border-border pt-2.5">
								<span className="vx-eyebrow text-ui-3xs">Map to module outputs</span>
								{iacOutputs.length === 0 ? (
									<p className="text-ui-xs leading-relaxed text-muted-foreground">
										This module exports no{" "}
										<span className="font-mono">output</span> blocks to bind to. Add them and
										re-scan the IaC source.
									</p>
								) : (
									<div className="space-y-2">
										{injectsEndpoint ? (
											<FacetOutputRow
												label="endpoint"
												noneLabel="unmapped · unsatisfiable"
												value={binding.target.output_keys?.endpoint}
												outputs={iacOutputs}
												onChange={(v) => patchOutputKey("endpoint", v)}
											/>
										) : null}
										{injectsPort ? (
											<FacetOutputRow
												label="port"
												noneLabel="use kind default"
												value={binding.target.output_keys?.port}
												outputs={iacOutputs}
												onChange={(v) => patchOutputKey("port", v)}
											/>
										) : null}
										{injectsCredential ? (
											<FacetOutputRow
												label="credential secret"
												hint="The cloud secret-store reference (name / ARN), not the value — ESO reads it keylessly."
												noneLabel="unmapped · unsatisfiable"
												value={binding.target.output_keys?.credential_secret}
												outputs={iacOutputs}
												onChange={(v) => patchOutputKey("credential_secret", v)}
											/>
										) : null}
									</div>
								)}
							</div>
						) : null}
					</div>
				);
			})}

			<button
				type="button"
				onClick={addBinding}
				className="flex w-full items-center gap-1.5 border border-border px-2.5 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
			>
				<Plus className="h-3.5 w-3.5" />
				Bind a resource
			</button>

			<p className="font-mono text-ui-xs leading-relaxed text-muted-foreground">
				Alethia injects the endpoint and credentials at deploy — keyless, via ExternalSecret. A
				secret facet becomes a Kubernetes secretKeyRef, never written into the manifest.
			</p>
		</div>
	);
}
