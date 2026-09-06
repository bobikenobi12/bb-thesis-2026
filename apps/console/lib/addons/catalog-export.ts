// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Resolves the whole marketplace catalog into the runner-facing install specs a deploy would
// actually install. Used by:
//   - scripts/export-addon-catalog.mts → test/e2e/fixtures/addon_catalog.<cloud>.json (the FULL add-on
//     surface the Go e2e harness seeds when ALETHIA_E2E_ALL_ADDONS=1);
//   - tests/lib/addons/catalog-export.test.ts, which reds CI if that fixture drifts from catalog.ts.
//
// It lives here (a normal module) rather than inside the script so the guard test can import it
// without reaching into a `.mts` entrypoint.

import {
	ADDON_CATALOG,
	EXTERNAL_DNS_PROVIDERS,
	resolveAddOnInstall,
} from "@/lib/addons/catalog";
import type { ExternalDnsProvider } from "@/lib/addons/catalog";
import type { AddOnInstallSpec } from "@/lib/addons/types";
import type { CloudProvider } from "@/lib/cloud-providers/connections";

/**
 * What the fixture stores in external-dns's `workloadIdentity` on a workload-identity cloud.
 *
 * The real value — an IRSA role ARN, a GSA email, a managed-identity client id — is per-run and
 * exists only after `tofu apply`, in the same deploy job that installs the add-on. So the fixture
 * carries a sentinel and the RUNNER substitutes the real identity just before the Applications
 * render (`packages/core/argocd/addon_identity.go`, ResolveAddOnCloudIdentity).
 *
 * ⚠️ MIRRORED IN GO as `argocd.CloudIdentityPlaceholder`. A drifted spelling does not fail loudly:
 * the runner would find no placeholder to replace, the annotation would ship holding this literal
 * string, and external-dns would construct its provider, report Healthy and write nothing — the
 * exact defect the substitution exists to remove. `catalog-export.test.ts` pins the two together.
 */
export const INFRA_IDENTITY_PLACEHOLDER = "alethia-infra:external-dns-workload-identity";

/**
 * A stand-in for "this secret key has a stored value".
 *
 * `resolveAddOnInstall` decides whether to emit a `secretRef` by asking `hasStoredSecret` which keys
 * are PRESENT — it never reads the value, because a secret knob is stripped before validation and can
 * never reach the rendered values. So a marker is enough to make the resolver take the stored-secret
 * branch, and NOTHING derived from it is emitted: a `secretRef` carries the Secret's name, namespace,
 * data KEY NAMES and the non-secret staticData, and no credential at any point.
 *
 * A guard test asserts this string does not appear in the generated fixture.
 */
// NOT named *_SECRET_*: gitleaks' `generic-api-key` rule matches on the NAME, and flagged this
// constant — whose entire job is to prove no secret reaches the output — as a leaked credential.
// Renaming is the fix rather than an allowlist entry: an allowlist would put a permanent hole in
// the one check that would catch a real value landing in exactly this file.
const PRESENCE_MARKER = "e2e-fixture-presence-marker";

/**
 * The external-dns provider each cloud manages its OWN DNS with, or `null` where the catalog offers
 * none for it.
 *
 * A total `Record<CloudProvider, …>` on purpose, mirroring `EXTERNAL_DNS_PROVIDERS` in catalog.ts:
 * adding a cloud without deciding this is a COMPILE error, so the offer and the fixture cannot
 * drift apart the way they just did.
 *
 * WHY THIS EXISTS. `provider` defaults to `cloudflare` (catalog.ts), which is right for a console
 * user picking a provider and wrong for the e2e full-add-on sweep: it installs external-dns pointed
 * at Cloudflare, on every cloud, with no Cloudflare token. It cannot converge and never could, so
 * that cell was not measuring the chart at all (#2717 class (c)).
 *
 * `null` is a recorded FACT, not a gap in this map: EXTERNAL_DNS_PROVIDER_IDS has no alibaba and no
 * civo entry, so there is nothing native to point them at. Those fixtures keep the catalog default,
 * exactly as today — this change does not make them worse, and it must not pretend to make them
 * better. Neither is in the current 24-cell parity target.
 */
const EXTERNAL_DNS_NATIVE_PROVIDER: Record<CloudProvider, ExternalDnsProvider | null> = {
	aws: "aws",
	gcp: "google",
	azure: "azure",
	hetzner: "hetzner",
	digitalocean: "digitalocean",
	alibaba: null,
	civo: null,
};

/** The clouds a fixture is generated for — the e2e nightly's provider matrix. */
export const EXPORT_CLOUDS = ["aws", "gcp", "azure", "alibaba", "hetzner"] as const satisfies readonly CloudProvider[];

/**
 * Knobs that depend on the TARGET CLOUD rather than on the add-on alone.
 *
 * Returned as plain knob values and fed through the real `resolveAddOnInstall`, so the shapes the
 * emitter derives from them — the webhook sidecar for hetzner, the `saAnnotation` for the
 * workload-identity providers — come out of the emitter and are never restated here. That is the
 * whole reason this lives in TypeScript beside the catalog instead of in the Go harness.
 */
function cloudKnobs(addonId: string, cloud: CloudProvider): Record<string, unknown> {
	if (addonId !== "external-dns") return {};
	const native = EXTERNAL_DNS_NATIVE_PROVIDER[cloud];
	if (native === null) return {};
	if (EXTERNAL_DNS_PROVIDERS[native].saAnnotation !== undefined) {
		return {
			provider: native,
			workloadIdentity: INFRA_IDENTITY_PLACEHOLDER,
			domainFilter: "addon-e2e.invalid",
			// #3589: azure additionally REQUIRES the three identifiers its config file is built
			// from, so without these the exporter's own fail-loud check below fires and no azure
			// fixture is written at all. Supplied unconditionally rather than gated on the provider
			// id: Zod strips the keys a provider does not declare a use for, and gating here would
			// be a second copy of the table `EXTERNAL_DNS_PROVIDERS` already holds.
			...EXTERNAL_DNS_FIXTURE_AZURE_CONFIG,
		};
	}
	return { provider: native };
}

/**
 * Syntactically real, deliberately NON-EXISTENT azure identifiers for the fixture (#3589).
 *
 * The same reasoning as `EXTERNAL_DNS_FIXTURE_IDENTITY` below, for the same reason: the fixture
 * exists to pin the SHAPE the emitter produces — that azure's spec carries a mounted `azure.json`
 * built from these knobs — and it proves nothing about the add-on working. The real values are a
 * customer's own tenant, subscription and resource group; external-dns therefore stays on the
 * withheld list in `test/e2e/addon_exclusions.go`.
 *
 * The GUIDs are the all-zero placeholder the worked example in `examples/addons/external-dns/`
 * ships, so a reader who has seen one recognises the other as a stand-in rather than as something to
 * copy.
 */
const EXTERNAL_DNS_FIXTURE_AZURE_CONFIG = {
	azureTenantId: "00000000-0000-0000-0000-000000000000",
	azureSubscriptionId: "00000000-0000-0000-0000-000000000000",
	azureResourceGroup: "example-dns-rg",
} as const;

/**
 * A syntactically real, deliberately NON-EXISTENT cloud identity, per workload-identity provider.
 *
 * WHY THE FIXTURE HAS TO CARRY ONE AT ALL. #3469 made `workloadIdentity` REQUIRED on a provider that
 * authenticates by ServiceAccount annotation, because an empty one installs an add-on that is
 * Healthy on AWS and writes nothing. The fixture is resolved through the real
 * `resolveAddOnInstall`, so the moment that rule existed, `{provider: aws}` with no identity stopped
 * resolving — and the alternatives were both worse than a placeholder: dropping external-dns from
 * three clouds' fixtures would take it out of the 18-add-on surface entirely (and leave #3470
 * nothing to un-exclude), and letting it fall back to the catalog default would silently reinstate
 * `provider: cloudflare` on every cloud, which is the exact #2717 class (c) defect the per-cloud
 * split was created to end.
 *
 * WHAT IT PROVES AND WHAT IT DOES NOT. It proves the SHAPE: that each cloud's fixture names its own
 * DNS provider and carries that cloud's `saAnnotation`, emitted by the catalog rather than restated
 * here. It proves NOTHING about the add-on working — the identity does not exist in any account, and
 * external-dns therefore stays on the withheld list in `test/e2e/addon_exclusions.go`, which says so
 * in its own words. Supplying a REAL identity is a customer action, and doing it for the e2e (plus
 * asserting something stronger than Healthy, which is too weak a predicate for this add-on on any
 * workload-identity cloud) is #3470.
 *
 * Each value is in its cloud's real syntax — an ARN, a service-account email, a GUID — because a
 * value the cloud would reject as MALFORMED tests a different failure than a value it simply cannot
 * find, and the second is the one a customer with a typo'd role hits. They are the placeholder
 * shapes the worked examples in `examples/addons/external-dns/` already ship — the aws and azure
 * strings are identical to them — deliberately: a reader who has seen one recognises the other as a
 * stand-in rather than as something to copy.
 *
 * Keyed by PROVIDER and total over the provider union, mirroring `EXTERNAL_DNS_PROVIDERS` itself:
 * adding a provider forces a decision here, and `null` states positively that this one needs no
 * identity. `catalog-export.test.ts` sweeps the two tables against each other, so a `null` against a
 * provider that DOES annotate — the way this fixture would go quietly back to being unresolvable —
 * fails there rather than in a nightly.
 */
const EXTERNAL_DNS_FIXTURE_IDENTITY: Record<ExternalDnsProvider, string | null> = {
	cloudflare: null,
	digitalocean: null,
	hetzner: null,
	aws: "arn:aws:iam::000000000000:role/external-dns",
	google: "external-dns@example-project.iam.gserviceaccount.com",
	azure: "00000000-0000-0000-0000-000000000000",
};

/** True when this provider authenticates by ServiceAccount annotation (and so needs an identity). */
export function externalDnsNeedsIdentity(provider: ExternalDnsProvider): boolean {
	return EXTERNAL_DNS_PROVIDERS[provider].saAnnotation !== undefined;
}

/** The fixture's stand-in identity for one provider, or null where the provider needs none.
 * Exported so the guard test can sweep it against `EXTERNAL_DNS_PROVIDERS` instead of re-listing. */
export function externalDnsFixtureIdentity(
	provider: ExternalDnsProvider,
): string | null {
	return EXTERNAL_DNS_FIXTURE_IDENTITY[provider];
}

/** Every catalog add-on, resolved with its default knobs in managed mode, in a stable order. */
export function exportCatalogSpecs(cloud: CloudProvider): AddOnInstallSpec[] {
	const specs: AddOnInstallSpec[] = [];
	for (const def of ADDON_CATALOG) {
		// An add-on that MINTS its own secrets at enable time (#2822) is resolved as if those
		// secrets were already stored, so the exported spec carries the `secretRef` the runner needs
		// to seed the in-cluster Secret. Without this the fixture describes an add-on that was never
		// enabled through the console — no secretRef, so `EnsureAddOnSecrets` skips it, so the chart
		// falls back to generating its own credential at RENDER time, which differs on every
		// reconcile. #2835.
		const minted = def.generateSecrets
			? Object.keys(def.generateSecrets(new Set<string>()))
			: [];
		const values = {
			...Object.fromEntries(minted.map((key) => [key, PRESENCE_MARKER])),
			...cloudKnobs(def.id, cloud),
		};
		const spec = resolveAddOnInstall({
			addon_id: def.id,
			mode: "managed",
			...(Object.keys(values).length > 0 ? { values } : {}),
		});
		// Fail LOUD, never silently short. `resolveAddOnInstall` returns null for a retired id and —
		// since #3469 — for knobs the catalog REFUSES (a workload-identity provider with no
		// identity). Either way the fixture would otherwise be written one add-on short and the
		// full-surface run would go green having installed 17 charts.
		if (!spec) {
			throw new Error(
				`catalog add-on ${def.id} failed to resolve for ${cloud}: its id is retired, or the ` +
					`knobs this exporter supplies (${JSON.stringify(values)}) are refused by its ` +
					"configSchema — see cloudKnobs / EXTERNAL_DNS_FIXTURE_IDENTITY above",
			);
		}
		specs.push(spec);
	}
	// Deterministic order so the generated fixture's diff is stable across regenerations.
	specs.sort((a, b) => a.id.localeCompare(b.id));
	return specs;
}
