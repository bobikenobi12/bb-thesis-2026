// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// OFFER PARITY for the ExternalDNS add-on: every provider the catalog OFFERS must have a credential
// path that could actually work.
//
// The catalog offered six and wired two. The mapping was one line —
// `c.provider === "digitalocean" ? "DO_TOKEN" : "CF_API_TOKEN"` — so hetzner, aws, google and azure
// each received a Cloudflare-shaped env var, and there was no service-account knob at all, which put
// IRSA and Workload Identity out of reach. Four of six offers could not be honoured.
//
// WHAT MAKES THIS TESTABLE AT ALL. An add-on that starts and then fails every write reports
// `Degraded` in exactly the way an unconfigured one does, so the symptom cannot distinguish "the
// user has not configured it" from "we sent it a credential it has no use for". These tests read the
// RENDERED VALUES instead of the health, because the values are where the two differ.
//
// The sweep at the end is the load-bearing part: it is driven by the offered enum rather than a
// hand-written list, so ADDING a provider to the offer without a credential path fails here.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	EXTERNAL_DNS_PROVIDER_IDS,
	EXTERNAL_DNS_PROVIDERS,
	getAddOn,
	resolveAddOnInstall,
} from "@/lib/addons/catalog";

const externalDns = getAddOn("external-dns");
if (!externalDns) throw new Error("the external-dns catalog entry is missing");

/** Every provider id the console actually offers, read off the field descriptor the UI renders. */
const OFFERED = (externalDns.fields.find((f) => f.key === "provider")?.options ?? []).map((o) => o.value);

/** Resolve the add-on's Helm values for one configuration.
 *
 * A non-empty `apiToken` in the stored values IS a stored secret as far as `hasStoredSecret` is
 * concerned, so passing one is what activates the `secretValues` path — the same route a real
 * encrypted envelope takes.
 *
 * Since #3469 a REFUSED configuration resolves to null rather than to the schema defaults, so this
 * throws instead of quietly handing back a Cloudflare install for an AWS config. Every caller below
 * therefore supplies a `workloadIdentity`, which a workload-identity provider now requires; the
 * refusal itself is asserted directly, further down. */
function values(config: Record<string, unknown>) {
	const resolved = resolveAddOnInstall({ addon_id: "external-dns", mode: "managed", values: installable(config) });
	if (!resolved) throw new Error(`external-dns did not resolve: ${JSON.stringify(config)}`);
	return resolved.values as Record<string, unknown>;
}

/**
 * Knobs a provider needs BEYOND its credential before the schema will accept the configuration at
 * all.
 *
 * Azure alone has any (#3589): its ExternalDNS provider reads `/etc/kubernetes/azure.json` before it
 * applies any flag, so the three identifiers that file is assembled from are required alongside the
 * workload identity — a valid client id on its own installs a controller that CrashLoops in its
 * constructor.
 *
 * Filled in here, in one place, so this file stays about the CREDENTIAL path it was written for
 * rather than restating azure's file requirement at a dozen call sites. The requirement itself is
 * covered by `external-dns-azure-config.test.ts`; supplying it below only makes an azure
 * configuration valid enough to render, which is what every assertion here is about.
 */
const AZURE_CONFIG_FILE_KNOBS = {
	azureTenantId: "72f988bf-86f1-41af-91ab-2d7cd011db47",
	azureSubscriptionId: "3b1c9a55-2d6e-4f10-9c77-8ab4e0d61f23",
	azureResourceGroup: "dns-zones-rg",
};

/** `config`, plus whatever else its provider needs before the schema will accept it. */
function installable(config: Record<string, unknown>): Record<string, unknown> {
	return config.provider === "azure" ? { ...AZURE_CONFIG_FILE_KNOBS, ...config } : config;
}

/** A config with BOTH credential knobs filled — the only shape that resolves for every offered
 * provider, since a token provider ignores the identity and an identity provider now refuses to be
 * without one. Exactly one credential path may render from it; which one is the provider's answer,
 * never the caller's. */
const bothKnobs = (provider: string) => ({
	provider,
	apiToken: "t",
	workloadIdentity: "id-for-this-cloud",
});

/** Does this provider authenticate by ServiceAccount annotation? Answered by RENDERING rather than
 * by a second copy of EXTERNAL_DNS_PROVIDERS — the emitter is the only description of the table this
 * file is allowed to hold. */
function annotates(provider: string): boolean {
	return serviceAccountOf(bothKnobs(provider)).annotations.length > 0;
}

/** The rendered `serviceAccount` block, narrowed rather than cast: its name (or null when the block
 * is absent) and the annotation KEYS it carries. */
function serviceAccountOf(config: Record<string, unknown>): {
	name: string | null;
	annotations: string[];
} {
	const sa = values(config).serviceAccount;
	if (!sa || typeof sa !== "object") return { name: null, annotations: [] };
	const record: Record<string, unknown> = { ...sa };
	const annotations = record.annotations;
	return {
		name: typeof record.name === "string" ? record.name : null,
		annotations:
			annotations && typeof annotations === "object" ? Object.keys(annotations) : [],
	};
}

/** Walk a rendered values object and collect every `name` under any `env:` array, at any depth. */
function envNames(v: unknown): string[] {
	const found: string[] = [];
	const walk = (node: unknown) => {
		if (Array.isArray(node)) return node.forEach(walk);
		if (!node || typeof node !== "object") return;
		for (const [k, child] of Object.entries(node)) {
			if (k === "env" && Array.isArray(child)) {
				for (const e of child) if (e && typeof e === "object" && "name" in e) found.push(String(e.name));
			}
			walk(child);
		}
	};
	walk(v);
	return found;
}

describe("ExternalDNS offers exactly the providers it can authenticate", () => {
	it("offers six providers", () => {
		expect(OFFERED).toEqual(["cloudflare", "digitalocean", "hetzner", "aws", "google", "azure"]);
	});

	// THE SWEEP. Every offered provider, driven from the offer itself — so adding a seventh without
	// a credential path fails here rather than in a customer's cluster.
	it.each(OFFERED)("%s renders a credential path that could work", (provider) => {
		const rendered = values(bothKnobs(provider));

		const tokenEnvs = envNames(rendered);
		const sa = (rendered as Record<string, { annotations?: Record<string, string> }>).serviceAccount;
		const annotations = Object.keys(sa?.annotations ?? {});

		// Exactly one of the two shapes, never both and never neither. "Neither" is the bug this
		// file was written for; "both" would mean we ask a user for a credential they do not need.
		expect(
			tokenEnvs.length > 0 !== annotations.length > 0,
			`${provider}: token envs ${JSON.stringify(tokenEnvs)}, SA annotations ${JSON.stringify(annotations)}`,
		).toBe(true);
	});

	it("never sends a Cloudflare env var to a provider that is not Cloudflare", () => {
		for (const provider of OFFERED) {
			if (provider === "cloudflare") continue;
			expect(envNames(values(bothKnobs(provider))), `${provider} got CF_API_TOKEN`).not.toContain(
				"CF_API_TOKEN",
			);
		}
	});
});

describe("the token providers", () => {
	it.each([
		["cloudflare", "CF_API_TOKEN"],
		["digitalocean", "DO_TOKEN"],
		["hetzner", "HETZNER_TOKEN"],
	])("%s delivers its token as %s", (provider, env) => {
		expect(envNames(values({ provider, apiToken: "t" }))).toContain(env);
	});

	it("renders no env at all when no token is stored — an empty credential must not look configured", () => {
		expect(envNames(values({ provider: "cloudflare" }))).toEqual([]);
	});
});

describe("hetzner goes through the webhook sidecar, not a native provider", () => {
	// ExternalDNS ships NO native `hetzner` provider, so `provider.name: "hetzner"` — what the old
	// wiring produced — is not a configuration the chart understands. This is the assertion that
	// pins the difference between an offer that renders and an offer that runs.
	it("never names hetzner as the provider", () => {
		const v = values({ provider: "hetzner", apiToken: "t" }) as { provider: { name: string } };
		expect(v.provider.name).toBe("webhook");
	});

	it("puts the token in the SIDECAR's env, not the controller's", () => {
		const v = values({ provider: "hetzner", apiToken: "t" }) as {
			env?: unknown[];
			provider: { webhook: { env: { name: string }[]; image: { repository: string; tag: string } } };
		};
		expect(v.provider.webhook.env.map((e) => e.name)).toEqual(["HETZNER_TOKEN"]);
		expect(v.env, "the controller must not also carry the token").toBeUndefined();
		expect(v.provider.webhook.image.repository).toContain("external-dns-hetzner-webhook");
	});
});

describe("the workload-identity providers", () => {
	it.each([
		["aws", "eks.amazonaws.com/role-arn"],
		["google", "iam.gke.io/gcp-service-account"],
		["azure", "azure.workload.identity/client-id"],
	])("%s annotates its ServiceAccount with %s", (provider, annotation) => {
		const v = values({ provider, workloadIdentity: "the-identity" }) as {
			serviceAccount: { name: string; annotations: Record<string, string> };
		};
		expect(v.serviceAccount.annotations[annotation]).toBe("the-identity");
		expect(v.serviceAccount.name).toBe("addon-external-dns");
	});

	// THE ADD-ON MUST NOT OWN THE PLATFORM RAIL'S SERVICEACCOUNT.
	//
	// The rail (infra/templates/argocd/external-dns.yaml) installs its own external-dns into the
	// SAME namespace and names its ServiceAccount `external-dns-sa`; all three clouds bind their
	// platform DNS identity to that exact name (aws IRSA trust, GKE member, Azure federated
	// subject). An add-on that reused the name would not sit beside the rail — it would be the same
	// Kubernetes object under two ArgoCD Applications with different annotations, and the rail
	// syncs selfHeal, so they would take turns rewriting the identity of the controller that
	// publishes the environment's Ingress records.
	//
	// Read out of the TEMPLATE rather than restated, so this cannot pass by agreeing with a copy of
	// the name that has since moved, and it fails loudly if the template stops declaring one at all.
	it("does not name its ServiceAccount after the platform rail's", () => {
		const template = readFileSync(
			resolve(__dirname, "../../../../../infra/templates/argocd/external-dns.yaml"),
			"utf8",
		);
		const railSa = /serviceAccount:\s*\n\s*name:\s*(\S+)/.exec(template)?.[1];
		// A template that has stopped declaring a ServiceAccount name leaves this guard with nothing
		// to compare against — it must say so rather than pass.
		expect(railSa, "the platform rail template declares no serviceAccount.name").toBeTruthy();
		const addonSa = serviceAccountOf({ provider: "aws", workloadIdentity: "arn" }).name;
		expect(addonSa, "the add-on renders no ServiceAccount to compare").toBeTruthy();
		expect(addonSa).not.toBe(railSa);
	});

	// A token on a keyless provider is not merely useless — it invites a user to paste a long-lived
	// key where none is needed, which is the opposite of what this product claims about credentials.
	it.each(["aws", "google", "azure"])("%s takes NO token even when one is stored", (provider) => {
		expect(envNames(values({ provider, apiToken: "t", workloadIdentity: "id" }))).toEqual([]);
	});

	it("azure also labels its pods, or the identity webhook never injects", () => {
		const v = values({ provider: "azure", workloadIdentity: "client-id" }) as {
			podLabels?: Record<string, string>;
		};
		expect(v.podLabels?.["azure.workload.identity/use"]).toBe("true");
	});

});

// #3469. THE HOLE THIS CLOSES, and why "renders no ServiceAccount" was the wrong assertion to be
// satisfied with.
//
// This block replaces a test that read "renders no ServiceAccount when no identity is supplied — a
// half-configured install must not look whole". It passed, and what it pinned was the DEFECT: with
// `workloadIdentity` empty, `toValues` emitted no serviceAccount block, so external-dns ran under
// the chart's default ServiceAccount with no cloud identity at all. The catalog's comment claimed
// that install "reports Degraded exactly as an unconfigured token provider does" — true on gcp and
// azure, which fail inside the provider constructor and CrashLoop, and FALSE on aws, where the SDK's
// default credential chain always yields something through IMDS: the provider constructs, the pod
// stays Ready, ArgoCD reports **Healthy**, and every Route53 write is refused one record at a time.
// The product reported success for an add-on writing nothing.
//
// So the configuration is refused instead — at configure time, where a user can still act on it,
// by the same `configSchema` the console action and the CLI route both run.
describe("a workload-identity provider refuses an empty identity (#3469)", () => {
	// Split off the PROVIDER UNION rather than off `OFFERED` (which is `string[]`, read out of the
	// form descriptor) so each case is typed as a real provider id and the table below can be
	// indexed without a cast. The two lists must be the same set — asserted, not assumed.
	const IDENTITY_PROVIDERS = EXTERNAL_DNS_PROVIDER_IDS.filter(annotates);
	const TOKEN_PROVIDERS = EXTERNAL_DNS_PROVIDER_IDS.filter((p) => !annotates(p));

	// VACUITY FIRST. Both halves of the sweep below are `it.each` over a filtered list, and a filter
	// that returns nothing makes every case pass by describing an empty set.
	it("has providers of both kinds to sweep, and sweeps everything the form offers", () => {
		expect(IDENTITY_PROVIDERS.length).toBeGreaterThan(0);
		expect(TOKEN_PROVIDERS.length).toBeGreaterThan(0);
		expect([...IDENTITY_PROVIDERS, ...TOKEN_PROVIDERS].sort()).toEqual([...OFFERED].sort());
	});

	it.each(IDENTITY_PROVIDERS)("%s is refused with no identity, on the identity's own field", (provider) => {
		const result = externalDns.configSchema.safeParse({ provider });
		expect(result.success).toBe(false);
		if (result.success) return;
		// The FIELD matters as much as the refusal: the configure form shows the message against the
		// knob it names, and a refusal parked on the object root would be invisible there.
		const issue = result.error.issues.find((i) => i.path.join(".") === "workloadIdentity");
		expect(issue, `refused, but not on workloadIdentity: ${JSON.stringify(result.error.issues)}`).toBeDefined();
		// Actionable, not merely negative — it must name the provider and what to go and get.
		expect(issue?.message).toMatch(/workload identity/i);
	});

	// `identityLabel` has to be set on exactly the providers that annotate — TypeScript cannot pair
	// two optional fields, so the pairing is asserted instead. Without it the refusal quietly falls
	// back to "the cloud identity to assume" and a user is told a provider needs something, but not
	// what: the difference between a message that closes the loop and one that just says no.
	it.each(IDENTITY_PROVIDERS)("%s names what its identity IS, in the refusal itself", (provider) => {
		const label = EXTERNAL_DNS_PROVIDERS[provider].identityLabel;
		expect(label, `${provider} annotates but declares no identityLabel`).toBeTruthy();
		const result = externalDns.configSchema.safeParse({ provider });
		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error.issues.map((i) => i.message).join(" ")).toContain(label);
	});

	it.each(IDENTITY_PROVIDERS)("%s refuses whitespace, which is not an identity either", (provider) => {
		expect(externalDns.configSchema.safeParse({ provider, workloadIdentity: "   " }).success).toBe(false);
	});

	it.each(IDENTITY_PROVIDERS)("%s accepts the configuration once the identity is there", (provider) => {
		// …and once anything ELSE that provider requires is there — azure's config-file identifiers
		// (#3589). The refusal under test here is the identity's; `installable` supplies the rest so
		// this case cannot pass or fail for the other rule's reason.
		expect(
			externalDns.configSchema.safeParse(installable({ provider, workloadIdentity: "an-identity" })).success,
		).toBe(true);
	});

	// The token providers must stay installable with NOTHING filled in. `apiToken` is a secret knob,
	// stripped to its default before validation (W4.5/#640), so the schema cannot see whether one is
	// stored — a refusal built on it would fire on every correctly-configured install. That
	// asymmetry is the reason only the identity path is closed here, and it is asserted rather than
	// left as a comment.
	it.each(TOKEN_PROVIDERS)("%s is still accepted with neither knob set", (provider) => {
		expect(externalDns.configSchema.safeParse({ provider }).success).toBe(true);
	});

	// THE LAUNDERING GUARD, and the reason `resolveAddOnInstall` had to change with the schema.
	// Its fallback for knobs that fail validation is `configSchema.parse({})` — the DEFAULTS — and
	// the default provider is cloudflare. Left alone, a refused AWS row would have deployed
	// external-dns pointed at Cloudflare with no Cloudflare token: a refusal turned into a wrong
	// install, silently, on the deploy path. It must fail closed instead.
	it("does not launder a refused row into a Cloudflare install", () => {
		const spec = resolveAddOnInstall({
			addon_id: "external-dns",
			mode: "managed",
			values: { provider: "aws" },
		});
		expect(spec).toBeNull();
	});

	// …while a merely STALE row — one whose shape no longer matches — still resolves on its
	// defaults, because blocking a deploy over a knob that moved is not what fail-closed means here.
	it("still falls back to defaults for a stale row that is only the wrong SHAPE", () => {
		const spec = resolveAddOnInstall({
			addon_id: "external-dns",
			mode: "managed",
			// A knob the schema types as a string, holding a number: the shape moved, nobody decided
			// anything. It resolves on the catalog's own defaults rather than being withheld.
			values: { provider: "digitalocean", domainFilter: 42 },
		});
		expect(spec, "a stale row must not be treated as a refusal").not.toBeNull();
		expect(spec?.values).toMatchObject({ provider: { name: "cloudflare" } });
	});
});

describe("the knobs that were already right stay right", () => {
	it("passes a domain filter through", () => {
		const v = values({ provider: "cloudflare", domainFilter: "example.com" }) as { domainFilters: string[] };
		expect(v.domainFilters).toEqual(["example.com"]);
	});

	it("omits domainFilters entirely when the filter is empty, rather than sending an empty list", () => {
		expect(values({ provider: "cloudflare" })).not.toHaveProperty("domainFilters");
	});
});
