// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #3589. THE ADD-ON THAT COULD NOT WORK ON AZURE, AND THE GATE THAT SAID IT COULD.
//
// external-dns's Azure provider resolves its settings in `getConfig()`, which opens with an
// UNCONDITIONAL `os.ReadFile("/etc/kubernetes/azure.json")` and returns an error when the file is
// absent — the `--azure-subscription-id` / `--azure-resource-group` overrides are applied AFTER that
// read, so they cannot rescue it, and `useWorkloadIdentityExtension` (without which the controller
// authenticates as the node's kubelet identity rather than the managed identity) has no flag at all
// in v0.15.0. A workload-identity AKS cluster lays no such file down. So the controller exits in its
// provider constructor and CrashLoops.
//
// #3469 made `workloadIdentity` REQUIRED on a provider that authenticates by annotation, which
// refuses an EMPTY identity. It does not refuse a VALID one — and that is the customer-visible
// defect this file pins: an azure user pasted a real managed-identity client id, the console
// accepted it, the install succeeded, and the breakage surfaced as a CrashLoop they had to open
// ArgoCD to find. A refusal that fires only on the obviously-broken case, while the plausible case
// installs a guaranteed CrashLoop, is worse than an unsupported provider.
//
// WHAT THESE TESTS ARE FOR, in two halves that must not be confused:
//
//   * the REFUSAL half — a configuration that cannot possibly work is rejected at configure time,
//     on the fields it is missing, with a message that names them. Every assertion here failed
//     before the fix by REPORTING SUCCESS.
//   * the CAPABILITY half — the add-on can now actually be given the file, through the marketplace
//     path (`resolveAddOnInstall`), not merely through the platform rail. Refusing without this
//     would stop shipping a CrashLoop and still leave azure un-installable.
//
// And one thing they are deliberately careful about: the platform rail
// (`infra/templates/argocd/external-dns.yaml`) has mounted this file since #2868. It is a DIFFERENT
// Application, rendered only when the ENVIRONMENT manages DNS, seeded with that environment's zone.
// Mistaking it for coverage of the marketplace path is why this issue exists as its own issue, so
// the facts read out of it below are read out of the TEMPLATE rather than restated here — and one
// test asserts the add-on does NOT reach for the rail's Secret, which would render identically and
// die whenever the rail is not there.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
	EXTERNAL_DNS_CONFIG_FILE_KEYS,
	EXTERNAL_DNS_PROVIDER_IDS,
	getAddOn,
	resolveAddOnInstall,
} from "@/lib/addons/catalog";

const externalDns = getAddOn("external-dns");
if (!externalDns) throw new Error("the external-dns catalog entry is missing");

/** A managed-identity client id in Azure's real syntax. The point of the whole issue: this is a
 * VALID value, and on its own it still produces a controller that cannot start. */
const VALID_CLIENT_ID = "6f2b1c4e-9a3d-4f8b-88a1-0c5e7d2a1b34";

/** A complete, well-formed azure configuration — the one the console should accept. */
const COMPLETE_AZURE = {
	provider: "azure",
	workloadIdentity: VALID_CLIENT_ID,
	azureTenantId: "72f988bf-86f1-41af-91ab-2d7cd011db47",
	azureSubscriptionId: "3b1c9a55-2d6e-4f10-9c77-8ab4e0d61f23",
	azureResourceGroup: "dns-zones-rg",
} as const;

const RAIL_TEMPLATE = readFileSync(
	resolve(__dirname, "../../../../../infra/templates/argocd/external-dns.yaml"),
	"utf8",
);

/** Resolve the add-on for one configuration, or fail loudly. */
function resolved(config: Record<string, unknown>) {
	const spec = resolveAddOnInstall({ addon_id: "external-dns", mode: "managed", values: config });
	if (!spec) throw new Error(`external-dns did not resolve: ${JSON.stringify(config)}`);
	return spec;
}

/** The rendered `extraVolumeMounts`, narrowed rather than cast — name, path and readOnly only. */
function volumeMounts(values: Record<string, unknown>): { name: string; mountPath: string; readOnly: boolean }[] {
	const raw = values.extraVolumeMounts;
	if (!Array.isArray(raw)) return [];
	return raw.flatMap((m) => {
		if (!m || typeof m !== "object") return [];
		const r: Record<string, unknown> = { ...m };
		return [
			{
				name: typeof r.name === "string" ? r.name : "",
				mountPath: typeof r.mountPath === "string" ? r.mountPath : "",
				readOnly: r.readOnly === true,
			},
		];
	});
}

/** The rendered `extraVolumes`, narrowed to the Secret projection each one carries. */
function secretVolumes(
	values: Record<string, unknown>,
): { name: string; secretName: string; items: string[] }[] {
	const raw = values.extraVolumes;
	if (!Array.isArray(raw)) return [];
	return raw.flatMap((v) => {
		if (!v || typeof v !== "object") return [];
		const r: Record<string, unknown> = { ...v };
		const secret = r.secret;
		if (!secret || typeof secret !== "object") return [];
		const s: Record<string, unknown> = { ...secret };
		const items = Array.isArray(s.items)
			? s.items.flatMap((i) =>
					i && typeof i === "object" && "key" in i && typeof i.key === "string" ? [i.key] : [],
				)
			: [];
		return [
			{
				name: typeof r.name === "string" ? r.name : "",
				secretName: typeof s.secretName === "string" ? s.secretName : "",
				items,
			},
		];
	});
}

describe("azure needs a config FILE, and the catalog can now give it one (#3589)", () => {
	// VACUITY FIRST. Every sweep below is driven off the provider table; a table that stopped
	// declaring a config file would make them all pass by describing an empty set.
	it("at least one offered provider declares a config file, so nothing here is vacuous", () => {
		const withFile = EXTERNAL_DNS_PROVIDER_IDS.filter((p) => {
			const spec = resolveAddOnInstall({
				addon_id: "external-dns",
				mode: "managed",
				values: { ...COMPLETE_AZURE, provider: p },
			});
			return spec !== null && secretVolumes(spec.values).length > 0;
		});
		expect(withFile).toEqual(["azure"]);
		expect(EXTERNAL_DNS_CONFIG_FILE_KEYS.length).toBeGreaterThan(0);
	});

	// ── THE REFUSAL ────────────────────────────────────────────────────────────────────────────
	//
	// Before the fix every one of these reported SUCCESS: `safeParse` accepted the configuration,
	// `resolveAddOnInstall` returned a spec, and the deploy installed a controller that crashes.

	it("refuses a VALID client id with no azure config — the case #3469's rule lets through", () => {
		const result = externalDns.configSchema.safeParse({
			provider: "azure",
			workloadIdentity: VALID_CLIENT_ID,
		});
		expect(
			result.success,
			"a valid client id with no azure.json was accepted — it installs a CrashLoop",
		).toBe(false);
	});

	it.each([...EXTERNAL_DNS_CONFIG_FILE_KEYS])(
		"names %s on its own field, because the form shows a message against the knob it blames",
		(key) => {
			const result = externalDns.configSchema.safeParse({
				provider: "azure",
				workloadIdentity: VALID_CLIENT_ID,
			});
			expect(result.success).toBe(false);
			if (result.success) return;
			const issue = result.error.issues.find((i) => i.path.join(".") === key);
			expect(
				issue,
				`refused, but not on ${key}: ${JSON.stringify(result.error.issues.map((i) => i.path))}`,
			).toBeDefined();
			// Actionable, not merely negative: it must say what the value IS and why the identity
			// alone cannot substitute for it.
			expect(issue?.message).toMatch(/azure\.json/i);
			expect(issue?.message).toMatch(/before it applies any\s+flag|before it applies any flag/i);
		},
	);

	it.each([...EXTERNAL_DNS_CONFIG_FILE_KEYS])("refuses %s when it is only whitespace", (key) => {
		const result = externalDns.configSchema.safeParse({ ...COMPLETE_AZURE, [key]: "   " });
		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error.issues.some((i) => i.path.join(".") === key)).toBe(true);
	});

	it("reports every missing identifier at once, not one per resubmission", () => {
		const result = externalDns.configSchema.safeParse({
			provider: "azure",
			workloadIdentity: VALID_CLIENT_ID,
		});
		expect(result.success).toBe(false);
		if (result.success) return;
		const blamed = result.error.issues.map((i) => i.path.join(".")).sort();
		expect(blamed).toEqual([...EXTERNAL_DNS_CONFIG_FILE_KEYS].sort());
	});

	// The deploy-path half of the refusal. `resolveAddOnInstall` falls back to the schema DEFAULTS
	// for a merely stale row — and the default provider is cloudflare — so a refusal that were not
	// failed closed here would turn an azure row into a Cloudflare install with no token.
	it("fails closed on the deploy path rather than laundering the row into a Cloudflare install", () => {
		const spec = resolveAddOnInstall({
			addon_id: "external-dns",
			mode: "managed",
			values: { provider: "azure", workloadIdentity: VALID_CLIENT_ID },
		});
		expect(spec).toBeNull();
	});

	it("accepts the configuration once the three identifiers are there", () => {
		expect(externalDns.configSchema.safeParse(COMPLETE_AZURE).success).toBe(true);
	});

	// ── THE CAPABILITY ─────────────────────────────────────────────────────────────────────────
	//
	// Refusing alone would stop shipping a CrashLoop and leave azure un-installable, which the issue
	// says explicitly is not a substitute. These assert the add-on can be MADE to work.

	it("mounts a config file at the path the provider actually opens", () => {
		const mounts = volumeMounts(resolved(COMPLETE_AZURE).values);
		expect(mounts.map((m) => m.mountPath)).toEqual(["/etc/kubernetes"]);
		expect(mounts[0]?.readOnly, "a config file the controller only reads").toBe(true);
	});

	// Read out of the TEMPLATE rather than restated, so this cannot pass by agreeing with a copy of
	// the path that has since moved — and so it fails loudly if the rail stops declaring one.
	it("mounts it where the PLATFORM RAIL mounts it, which is the same provider reading the same file", () => {
		const railPath = /extraVolumeMounts:\s*\n\s*-\s*name:[^\n]*\n\s*mountPath:\s*(\S+)/.exec(RAIL_TEMPLATE)?.[1];
		expect(railPath, "the platform rail template declares no azure config mountPath").toBeTruthy();
		expect(volumeMounts(resolved(COMPLETE_AZURE).values)[0]?.mountPath).toBe(railPath);
	});

	// THE OBVIOUS WRONG ANSWER, which renders and dies identically. The rail's Secret lives in the
	// SAME namespace, so mounting it would look right in a diff and work in any environment that
	// happens to manage its own DNS on azure — and leave a pod stuck unable to mount its volume
	// everywhere else, because the rail renders only when `.DNSEnabled` and `.DNSProvider` are set.
	it("does not reach for the platform rail's Secret, which is not guaranteed to exist", () => {
		const railSecret = /secret:\s*\n\s*secretName:\s*(\S+)/.exec(RAIL_TEMPLATE)?.[1];
		expect(railSecret, "the platform rail template mounts no Secret to compare against").toBeTruthy();
		const volumes = secretVolumes(resolved(COMPLETE_AZURE).values);
		expect(volumes.length).toBe(1);
		expect(volumes[0]?.secretName).not.toBe(railSecret);
		// It mounts its OWN, the one the runner seeds for this add-on before the Application syncs.
		expect(volumes[0]?.secretName).toBe("alethia-addon-external-dns");
	});

	it("seeds that Secret with the file, even though no secret knob is set", () => {
		// The plumbing half of the fix: a Secret used to be seeded only when a SECRET-typed knob had
		// a stored value, so `secretStaticData` was unreachable on its own and the catalog had no way
		// to deliver a non-secret file at all.
		const spec = resolved(COMPLETE_AZURE);
		expect(spec.secretRef, "no Secret is seeded, so the mount above resolves to nothing").toBeDefined();
		expect(spec.secretRef?.secretName).toBe("alethia-addon-external-dns");
		expect(spec.secretRef?.namespace).toBe(spec.namespace);
		expect(spec.secretRef?.keys, "no secret knob is set, so there is nothing for the runner to fetch").toEqual([]);
		expect(Object.keys(spec.secretRef?.staticData ?? {})).toEqual(["azure.json"]);
	});

	it("projects ONLY azure.json out of that Secret, never every key it holds", () => {
		// The same Secret carries `apiToken` whenever one has ever been stored. Mounting the Secret
		// whole would drop that credential into the provider's config directory as a file.
		const spec = resolved({ ...COMPLETE_AZURE, apiToken: "a-token-that-should-not-be-mounted" });
		expect(secretVolumes(spec.values)[0]?.items).toEqual(["azure.json"]);
	});

	it("writes the file external-dns can actually authenticate from", () => {
		const raw = resolved(COMPLETE_AZURE).secretRef?.staticData?.["azure.json"];
		expect(raw, "no azure.json was seeded").toBeTruthy();
		const parsed: unknown = JSON.parse(raw ?? "{}");
		expect(parsed).toMatchObject({
			cloud: "AzurePublicCloud",
			tenantId: COMPLETE_AZURE.azureTenantId,
			subscriptionId: COMPLETE_AZURE.azureSubscriptionId,
			resourceGroup: COMPLETE_AZURE.azureResourceGroup,
			// THE LOAD-BEARING KEY, and the reason a file is needed rather than flags: it exists
			// nowhere else in v0.15.0. Without it `getCredentials()` falls through workload identity
			// to MSI and authenticates as the node's kubelet identity, which holds no DNS rights.
			useWorkloadIdentityExtension: true,
		});
	});

	it("puts NO credential in it, and does not restate the client id it already annotates", () => {
		const spec = resolved({ ...COMPLETE_AZURE, apiToken: "a-token" });
		const raw = spec.secretRef?.staticData?.["azure.json"] ?? "";
		// `aadClientSecret` absent is what keeps `getCredentials()` out of the service-principal
		// branch — it is the whole reason this path is keyless.
		expect(raw).not.toContain("aadClientSecret");
		expect(raw).not.toContain("a-token");
		// `aadClientId` is omitted deliberately: the `azure.workload.identity/use` pod label makes
		// the webhook inject AZURE_CLIENT_ID from the ServiceAccount annotation, and one fact with
		// two sources is one fact that can disagree with itself.
		expect(raw).not.toContain("aadClientId");
		expect(raw).not.toContain(VALID_CLIENT_ID);
	});

	// RENDER TWICE. A value that moves between renders leaves the Application permanently OutOfSync
	// and rolls the pods on every reconcile (#2822, #2823) — the cheap unit-level form of the rule
	// `scripts/addons/check-render-determinism.sh` enforces against the real chart.
	it("renders byte-identically twice, so the Application does not sit OutOfSync forever", () => {
		const a = resolved(COMPLETE_AZURE);
		const b = resolved(COMPLETE_AZURE);
		expect(JSON.stringify(a)).toBe(JSON.stringify(b));
	});

	// ── NARROWING ──────────────────────────────────────────────────────────────────────────────

	it.each(EXTERNAL_DNS_PROVIDER_IDS.filter((p) => p !== "azure"))(
		"%s is given no config file and no Secret it never asked for",
		(provider) => {
			const spec = resolved({ provider, apiToken: "t", workloadIdentity: "an-identity" });
			expect(spec.values).not.toHaveProperty("extraVolumes");
			expect(spec.values).not.toHaveProperty("extraVolumeMounts");
			expect(spec.secretRef?.staticData).toBeUndefined();
		},
	);

	it.each(EXTERNAL_DNS_PROVIDER_IDS.filter((p) => p !== "azure"))(
		"%s is not made to fill in azure's identifiers",
		(provider) => {
			// A cross-field rule that fired on the wrong provider would break every other cloud's
			// install — the parity break the table-driven form of the rule exists to prevent.
			const config =
				provider === "aws" || provider === "google"
					? { provider, workloadIdentity: "an-identity" }
					: { provider };
			expect(externalDns.configSchema.safeParse(config).success).toBe(true);
		},
	);
});
