"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The inspector's `connector` field: which of the org's CONNECTED pluggable connectors a component
// uses, plus that provider's non-secret knobs.
//
// A pluggable connector has two halves. The SECRET half is org-level and lives once on
// `connector_credentials` (connected on the Connectors page). The non-secret half — the host, URL or
// path that varies by project — belongs to the component row's `provider_config`. This control is
// where the second half is set, and it writes both keys together because a knob means nothing
// without the slug that defines it.
//
// Category-generic on purpose. `helm_registry` is the first consumer; `registry`, `secrets` and
// `dns` are the same shape and can adopt it with one field entry in their CONFIG_SCHEMA block.

import { useCallback, useMemo } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Plug } from "lucide-react";
import { Button } from "@repo/ui/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@repo/ui/select";
import { ConnectorIcon } from "@/components/connectors/connector-icon";
import { ProviderConfigFields } from "@/components/connectors/provider-config-fields";
import { useConnectedProviders } from "@/components/design-project/connectors-context";
import {
	getConnectorProviderBySlug,
	type ConnectorField,
	type ConnectorProviderMeta,
	type PluggableCategory,
} from "@/lib/connectors/registry.generated";

interface ConnectorSelectProps {
	category: PluggableCategory;
	/** The stored `connectors.slug`, or null when the component has no connector yet. */
	value: string | null;
	/** The stored `provider_config` JSONB. */
	providerConfig: Record<string, unknown>;
	/** Patches `provider` and `provider_config` on the node config in one write. */
	onChange: (patch: {
		provider: string | null;
		provider_config: Record<string, unknown>;
	}) => void;
	id?: string;
	/** Per-`provider_config`-key validation messages. */
	errors?: Record<string, string>;
	/**
	 * Renders a first option meaning "no connector — use the platform default", which writes
	 * `{provider: null, provider_config: {}}`.
	 *
	 * Only for categories that HAVE a default. `secrets` does (the cluster cloud's own secret store,
	 * which is what a project gets until it picks one), so it must also be possible to go back to it.
	 * `helm_registry` doesn't — there is no implicit chart repo — so it omits this and the control
	 * stays as it was.
	 */
	nativeOption?: { label: string; description?: string };
	/**
	 * Why a connected provider cannot be selected, or null when it can. A non-null reason renders the
	 * option DISABLED with that text rather than hiding it — an option that silently isn't there reads
	 * as a bug, while one that says why is an answer.
	 *
	 * Distinct from the `coming_soon` filter below, which is about a provider that isn't finished.
	 * This is for one that is finished and connectable but cannot work HERE.
	 */
	unavailable?: (provider: ConnectorProviderMeta) => string | null;
	/**
	 * Knobs this surface owns ELSEWHERE, so the connector must not render a second, divergent input
	 * for them.
	 *
	 * DNS is the case: `project_dns.zone_id` is a real column with its own field, and the Cloudflare
	 * connector also declares a `zone_id` knob. Two inputs writing to two places for one concept is
	 * worse than either alone, so the column wins and this hides the knob. It cannot be expressed in
	 * the catalog instead — `ConnectorField` is generated from catalog.json, which is also the
	 * runtime's contract, and dns_cloudflare.go genuinely reads provider_config.zone_id (it just
	 * falls back to the column, which is what makes suppression safe).
	 */
	hiddenKnobs?: (field: ConnectorField) => boolean;
}

/**
 * The value the Select carries for `nativeOption`. A Select item cannot hold "" (that is the
 * "nothing selected" sentinel and would render the placeholder), so the platform default needs a
 * token of its own. It is UI-only: choosing it writes `provider: null`, never this string — the
 * column's own sentinel for "no connector" is NULL.
 */
const NATIVE_VALUE = "__native__";

/** Only strings/booleans reach `provider_config`; anything else is a stale value we ignore. */
function toKnobValues(
	config: Record<string, unknown>,
): Record<string, string | boolean | undefined> {
	const out: Record<string, string | boolean | undefined> = {};
	for (const [key, value] of Object.entries(config)) {
		if (typeof value === "string" || typeof value === "boolean") out[key] = value;
	}
	return out;
}

export function ConnectorSelect({
	category,
	value,
	providerConfig,
	onChange,
	id,
	errors,
	nativeOption,
	unavailable,
	hiddenKnobs,
}: ConnectorSelectProps) {
	const params = useParams<{ org?: string }>();
	const connected = useConnectedProviders(category);

	// A `coming_soon` provider can't be connected, but filter anyway so a catalog change can never
	// put an unselectable option in front of someone.
	const options = useMemo(
		() => connected.filter((p) => p.status !== "coming_soon"),
		[connected],
	);

	const selected = value ? getConnectorProviderBySlug(value) : undefined;
	// Whatever this control writes lands in the component row's `provider_config`, which
	// `buildConfigSnapshot` spreads WHOLE into the Postgres-persisted `config_snapshot`. So a knob
	// flagged `secret` is dropped rather than rendered: a secret belongs in `connector_credentials`
	// (encrypted, attached out-of-band at job claim), never on a snapshot. No catalog entry declares
	// one today — this keeps it that way when `secrets`/`registry`/`dns` adopt this field.
	// ONE filter for both the knobs we RENDER and the knobs we CARRY OVER on a provider switch.
	// They were two copies of `!f.secret`; suppressing in only the render half would let a hidden
	// knob survive a switch and ride into the config snapshot — exactly what the carry-over logic
	// below exists to prevent.
	const visibleKnobs = useCallback(
		(provider: ConnectorProviderMeta | undefined) =>
			(provider?.providerConfigFields ?? []).filter(
				(f) => !f.secret && !(hiddenKnobs?.(f) ?? false),
			),
		[hiddenKnobs],
	);
	const knobs = useMemo(() => visibleKnobs(selected), [visibleKnobs, selected]);
	// Drop knobs this surface doesn't own from a stored bag, so they can't outlive the field that
	// replaced them.
	const sanitize = useCallback(
		(config: Record<string, unknown>) => {
			if (!hiddenKnobs) return config;
			const out: Record<string, unknown> = {};
			for (const [key, v] of Object.entries(config)) {
				const field = selected?.providerConfigFields?.find((f) => f.key === key);
				if (field && hiddenKnobs(field)) continue;
				out[key] = v;
			}
			return out;
		},
		[hiddenKnobs, selected],
	);
	// The stored connector may have been disconnected since this was configured. Showing it (marked)
	// beats rendering an empty Select that reads as "nothing chosen" — the row is still pointing at
	// it, and the deploy will still try to use it.
	const staleSelection = Boolean(value && !options.some((p) => p.slug === value));

	const connectorsHref = params?.org ? `/${params.org}/~/connectors` : "/";

	// With a native default there is always something to choose, so the "connect one" empty state
	// would be wrong — it would hide the very option the project is currently using.
	if (options.length === 0 && !value && !nativeOption) {
		return (
			<div className="flex items-center justify-between gap-3 rounded-none border border-dashed border-border p-3">
				<div className="flex items-center gap-2 text-xs text-muted-foreground">
					<Plug className="h-3.5 w-3.5 shrink-0" />
					No connector connected for this
				</div>
				<Button variant="outline" size="sm" className="h-7 shrink-0 text-xs" render={
					<Link href={connectorsHref}>Connect</Link>
				} />
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-3">
			<Select
				value={value ?? (nativeOption ? NATIVE_VALUE : "")}
				onValueChange={(slug) => {
					// Back to the platform default: drop the knobs too, since they describe a provider
					// that is no longer selected and would otherwise ride into the config snapshot.
					if (slug === NATIVE_VALUE) {
						onChange({ provider: null, provider_config: {} });
						return;
					}
					const next = getConnectorProviderBySlug(slug);
					// Carry over only the knobs the NEW provider actually declares. Otherwise switching
					// (say) an HTTPS repo to a GHCR one leaves a stale `repo_url` behind in the JSONB,
					// which then rides into the config snapshot and the seeded credential.
					const keep = new Set(visibleKnobs(next).map((f) => f.key));
					const carried: Record<string, unknown> = {};
					for (const [key, v] of Object.entries(providerConfig)) {
						if (keep.has(key)) carried[key] = v;
					}
					onChange({ provider: slug, provider_config: carried });
				}}
			>
				<SelectTrigger id={id} className="h-9 text-sm">
					<SelectValue placeholder="Select a connector" />
				</SelectTrigger>
				<SelectContent>
					{nativeOption ? (
						<SelectItem value={NATIVE_VALUE}>
							<span className="flex items-center gap-2">
								{nativeOption.label}
								{nativeOption.description ? (
									<span className="vx-eyebrow text-ui-2xs text-muted-foreground">
										{nativeOption.description}
									</span>
								) : null}
							</span>
						</SelectItem>
					) : null}
					{options.map((provider) => {
						const reason = unavailable?.(provider) ?? null;
						return (
							<SelectItem key={provider.slug} value={provider.slug} disabled={Boolean(reason)}>
								<span className="flex items-center gap-2">
									<span className="flex h-4 w-4 items-center justify-center">
										<ConnectorIcon src={provider.icon_url} name={provider.name} size={16} />
									</span>
									{provider.name}
									{reason ? (
										<span className="vx-eyebrow text-ui-2xs text-muted-foreground">{reason}</span>
									) : null}
								</span>
							</SelectItem>
						);
					})}
					{staleSelection && value ? (
						<SelectItem value={value}>
							<span className="flex items-center gap-2">
								{selected?.name ?? value}
								<span className="vx-eyebrow text-ui-2xs text-muted-foreground">
									not connected
								</span>
							</span>
						</SelectItem>
					) : null}
				</SelectContent>
			</Select>

			{staleSelection ? (
				<p className="text-xs text-muted-foreground">
					This connector isn&apos;t connected for your organization.{" "}
					<Link href={connectorsHref} className="underline underline-offset-2">
						Connect it
					</Link>{" "}
					or pick another, or the deploy won&apos;t be able to authenticate.
				</p>
			) : null}

			{selected ? (
				<ProviderConfigFields
					fields={knobs}
					values={toKnobValues(providerConfig)}
					onChange={(key, next) =>
						onChange({
							provider: value,
							// Sanitize on the way out, not just on a provider switch. A hidden knob can
							// already be in the bag — set by the CLI, or by this connector before the
							// surface took ownership of it — and it would then keep winning over the field
							// that owns it (dns_cloudflare.go PREFERS provider_config.zone_id over the
							// column). Editing any knob is the moment to drop it.
							provider_config: { ...sanitize(providerConfig), [key]: next },
						})
					}
					errors={errors}
					idPrefix={`${id ?? "connector"}-cfg`}
				/>
			) : null}
		</div>
	);
}
