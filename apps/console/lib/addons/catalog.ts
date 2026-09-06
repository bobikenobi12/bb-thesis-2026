// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The cluster add-on catalog — a code SSOT (no DB enum, like lib/alerts/catalog.ts) of free
// OSS Helm charts the customer's cluster can come up with. Each entry pins a chart + a small
// set of user-tunable knobs. The engine (packages/core/argocd/addons.go) renders ANY entry
// without code changes, so growing the catalog is data, not plumbing. v1 seeds the L10
// observability stack; the broader backlog (security/secrets/networking/…) lands per the
// plan's catalog table.

import { MATRIX } from "@/lib/compat";
import { asRecord } from "@/lib/records";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import {
	type ChartWorkloadOverlay,
	composeChartOverlay,
} from "./chart-overlay";
import {
	hasStoredSecret,
	htpasswdLine,
	randomCredential,
	randomRsaPrivateKeyPem,
	secretFieldKeys,
	stripAddonSecrets,
} from "./secrets";
import type { AddOnDef, AddOnInstallSpec, AddOnMode } from "./types";

/**
 * Deep-merges plain objects (later wins). Arrays and primitives are replaced, not merged —
 * matches how Helm values overrides behave. Used to layer user knobs onto an add-on's
 * `defaultValues`.
 */
export function deepMerge(
	base: Record<string, unknown>,
	override: Record<string, unknown>,
): Record<string, unknown> {
	const out: Record<string, unknown> = { ...base };
	for (const [k, v] of Object.entries(override)) {
		const b = out[k];
		if (
			v &&
			b &&
			typeof v === "object" &&
			typeof b === "object" &&
			!Array.isArray(v) &&
			!Array.isArray(b)
		) {
			out[k] = deepMerge(
				asRecord(b),
				asRecord(v),
			);
		} else {
			out[k] = v;
		}
	}
	return out;
}

/** Preserves each entry's Zod schema generic, so `toValues` receives a properly-typed `config`
 * (a plain `AddOnDef[]` annotation would erase it to `unknown`), and attaches the add-on's
 * Kubernetes support window from the compat matrix SSOT (`matrix.json` → `addon_k8s[id]`) — so
 * `k8sRange` is derived, never hand-authored, and can't drift from the engine's source. Fails
 * closed at module load if an add-on has no matrix entry (a new add-on must be added there
 * first — currently every catalog id has an `addon_k8s` key). */
function defineAddOn<S extends z.ZodTypeAny>(
	def: Omit<AddOnDef<S>, "k8sRange">,
): AddOnDef<S> {
	const k8sRange = MATRIX.addon_k8s[def.id];
	if (!k8sRange) {
		throw new Error(
			`AddOn "${def.id}" has no addon_k8s entry in the compat matrix ` +
				"(packages/core/compat/matrix.json). Add it before shipping the add-on.",
		);
	}
	return { ...def, k8sRange };
}

/** The curated catalog. Ordered for display; grouped by category in the UI.
 *
 * SSOT: this array is the single source of truth for the marketplace add-on set. Its length is
 * guarded by tests/lib/addons/catalog-count.test.ts (the BYOC proof's ArgoCD expected-set
 * derivation depends on it) — a deliberate add/remove here must update that test. */
/**
 * How each ExternalDNS provider AUTHENTICATES — the one table `configSchema`, `toValues`,
 * `secretValues` and the field descriptors all read from.
 *
 * WHY THIS EXISTS. The catalog offered six providers and wired credentials for two. The mapping was
 * a single line — `c.provider === "digitalocean" ? "DO_TOKEN" : "CF_API_TOKEN"` — so hetzner, aws,
 * google and azure each silently received a **Cloudflare-shaped env var**, and the schema had no
 * service-account knob at all, which put IRSA and Workload Identity out of reach entirely. Four of
 * six offers could not be honoured, and an add-on that starts and then fails every write reports
 * Degraded in exactly the way an unconfigured one does — so the offer looked fine until a real DNS
 * record failed to appear.
 *
 * The platform's own rail (`infra/templates/argocd/external-dns.yaml`) has always done this
 * correctly. This table is that rail's knowledge, moved to where the marketplace can use it.
 *
 * TWO AUTH SHAPES, and the difference is not cosmetic:
 *
 *   token       a provider API token, delivered as an env var from a runner-seeded Secret.
 *   identity    the cloud's own workload identity, delivered as a ServiceAccount ANNOTATION.
 *               There is no credential to store, which is the point — Alethia is keyless wherever
 *               the cloud allows it, and offering these a token field would invite a user to paste
 *               a long-lived key where none is needed.
 *
 * HETZNER IS NEITHER, QUITE. ExternalDNS ships no native `hetzner` provider, so `provider.name:
 * "hetzner"` — what the old wiring produced — is not a configuration the chart understands. Hetzner
 * DNS is reached through the official webhook SIDECAR, and the token goes to the sidecar's env
 * block rather than the controller's.
 */
/** How ONE ExternalDNS provider authenticates. Every field but `label` is optional because the
 * shapes are mutually exclusive — see the table below. */
interface ExternalDnsProviderAuth {
	label: string;
	/** Token providers: the env var the controller (or the webhook sidecar) reads its token from. */
	tokenEnv?: string;
	/** Workload-identity providers: the ServiceAccount annotation that carries the cloud identity. */
	saAnnotation?: string;
	/** Workload-identity providers: what the identity IS on this cloud, in the words a user needs to
	 * go and find one ("an IAM role ARN"). Set exactly when `saAnnotation` is — a compile-time pair
	 * is not expressible in TypeScript, so `externalDnsIdentityRequirement` reads them together and
	 * `external-dns-providers.test.ts` sweeps the table for the mismatch.
	 *
	 * It exists because the REFUSAL below has to be actionable. "workloadIdentity is required" tells
	 * a user nothing they can act on; "AWS Route 53 authenticates by IAM role — set it to an IAM
	 * role ARN" tells them what to go and get. One copy, here, next to the annotation it fills. */
	identityLabel?: string;
	/** Providers ExternalDNS has no native support for, reached through a webhook sidecar instead. */
	webhook?: { image: { repository: string; tag: string } };
	/** Providers whose ExternalDNS provider reads a CONFIG FILE off disk before it applies any flag
	 * — see `ExternalDnsConfigFile`. Absent for every provider that is fully configurable by flags
	 * and env, which is all of them but azure. */
	configFile?: ExternalDnsConfigFile;
}

/**
 * The knobs external-dns's Azure config file is assembled from.
 *
 * A tuple, so the REFUSAL, the field descriptors and the file's contents all read one list — the
 * same discipline `EXTERNAL_DNS_PROVIDERS` applies to the credential path. They are the three facts
 * `azure.json` needs that the ServiceAccount annotation does not already carry.
 */
export const EXTERNAL_DNS_CONFIG_FILE_KEYS = [
	"azureTenantId",
	"azureSubscriptionId",
	"azureResourceGroup",
] as const;

/** One knob an `ExternalDnsConfigFile` is built from. */
export type ExternalDnsConfigFileKey = (typeof EXTERNAL_DNS_CONFIG_FILE_KEYS)[number];

/** The knob values one config file is rendered from — every declared key, all present. */
type ExternalDnsConfigFileValues = Record<ExternalDnsConfigFileKey, string>;

/** One non-secret identifier a provider's config FILE is assembled from. */
interface ExternalDnsConfigFileField {
	/** The `configSchema` knob it reads. */
	key: ExternalDnsConfigFileKey;
	/** The form label, so the refusal and the field cannot name it two different things. */
	label: string;
	/** What it IS, in the words a user needs to go and find one — the `identityLabel` discipline. */
	describe: string;
}

/**
 * How a provider that reads a CONFIG FILE off disk is given one by the MARKETPLACE add-on.
 *
 * WHY THIS EXISTS — the defect it removes (#3589). external-dns's azure provider resolves its
 * settings in `provider/azure/config.go`'s `getConfig()`, which opens with an UNCONDITIONAL
 * `os.ReadFile(configFile)` (default `/etc/kubernetes/azure.json`) and returns an error when the
 * file is absent. The flag overrides for subscription and resource group are applied AFTER that
 * read, so they cannot rescue it, and `useWorkloadIdentityExtension` — without which
 * `getCredentials()` falls through workload identity to MSI and authenticates as the node's kubelet
 * identity — is FILE-ONLY: v0.15.0 has no flag for it anywhere. A workload-identity AKS cluster lays
 * no such file down (that path belongs to the legacy in-tree cloud provider), so the controller dies
 * in its constructor and CrashLoops.
 *
 * The PLATFORM RAIL (`infra/templates/argocd/external-dns.yaml`) has mounted this file since #2868,
 * from a Secret the deploy path seeds (`packages/core/argocd/install.go`, `azureDNSConfigJSON`). The
 * marketplace add-on had no equivalent and no knob to build one, so an azure user who pasted a
 * PERFECTLY VALID client id still got a crashing controller — #3469's rule refuses only an EMPTY
 * identity, and a valid one sailed straight through into a guaranteed CrashLoop. The rail is not
 * reachable from here: it renders only when the ENVIRONMENT manages DNS (`.DNSEnabled` and a
 * `.DNSProvider`), it is a different Application, and its Secret holds THAT environment's zone.
 *
 * So this is the rail's knowledge moved to where the marketplace can use it, exactly as
 * `EXTERNAL_DNS_PROVIDERS` itself was.
 *
 * WHY THE SECRET AND NOT `secretConfiguration`. The chart's own `secretConfiguration` block would
 * create and mount a Secret from inline values — and it is DEPRECATED in 1.15.0, so it can vanish
 * under a chart bump, and it would inline the identifiers into the Application spec (and into the
 * customer's gitops repo in `gitops` mode). The add-on already has a Secret the runner seeds
 * pre-sync (`alethia-addon-external-dns`), and `extraVolumes`/`extraVolumeMounts` are the chart's
 * supported, non-deprecated way to mount one — which is also what the rail does, so the two paths
 * stay one integration rather than two.
 *
 * NOTHING HERE IS A CREDENTIAL. The file holds four identifiers and a boolean; `aadClientSecret` is
 * absent, which is what keeps `getCredentials()` out of the service-principal branch and the whole
 * path keyless. It travels through `requiredSecretData` rather than `values` only so it lands in a
 * FILE at a path the provider reads, which is the one thing Helm values cannot express.
 */
interface ExternalDnsConfigFile {
	/** The file's name inside the mount — the basename external-dns reads. */
	fileName: string;
	/** The directory it is mounted at (external-dns's `--azure-config-file` default directory). */
	mountPath: string;
	/** The pod's volume name; also the volumeMount name, so the two cannot drift. */
	volumeName: string;
	/** The knobs it is assembled from, in the order a refusal should name them. */
	fields: readonly ExternalDnsConfigFileField[];
	/** Renders the file's contents. Deterministic — a value that moved between renders would keep
	 * the add-on permanently OutOfSync (#2822, #2823), so no clock, no randomness, fixed key order. */
	render: (values: ExternalDnsConfigFileValues) => string;
}

/**
 * `azure.json`, byte-for-byte the shape the platform rail seeds (`azureDNSConfigJSON` in
 * `packages/core/argocd/install.go`).
 *
 * `aadClientId` is deliberately OMITTED even though the user gave us one: the
 * `azure.workload.identity/use` pod label makes the webhook inject `AZURE_CLIENT_ID` from the
 * ServiceAccount's `client-id` annotation — which `toValues` already emits from `workloadIdentity` —
 * and azidentity reads it from the environment when the config leaves it empty. Writing it here as
 * well would give one fact two sources that can disagree.
 */
function externalDnsAzureConfigJson(values: ExternalDnsConfigFileValues): string {
	// JSON.stringify over an object literal: string keys serialise in insertion order, so the
	// rendered bytes are a pure function of the knobs.
	return `${JSON.stringify(
		{
			cloud: "AzurePublicCloud",
			tenantId: values.azureTenantId,
			subscriptionId: values.azureSubscriptionId,
			resourceGroup: values.azureResourceGroup,
			useWorkloadIdentityExtension: true,
		},
		null,
		2,
	)}\n`;
}

/** Azure's config file: what it is called, where it is mounted, and what it is built from. */
const EXTERNAL_DNS_AZURE_CONFIG: ExternalDnsConfigFile = {
	// external-dns's `--azure-config-file` DEFAULT is `/etc/kubernetes/azure.json`, and the add-on
	// passes no such flag — so the basename and the directory below are not a choice, they are what
	// the provider goes looking for.
	fileName: "azure.json",
	mountPath: "/etc/kubernetes",
	volumeName: "azure-config",
	fields: [
		{
			key: "azureTenantId",
			label: "Azure tenant ID",
			describe: "the directory (tenant) ID of the Entra ID tenant the managed identity belongs to",
		},
		{
			key: "azureSubscriptionId",
			label: "Azure subscription ID",
			describe: "the ID of the subscription the DNS zone lives in",
		},
		{
			key: "azureResourceGroup",
			label: "Azure resource group",
			describe: "the name of the resource group the DNS zone lives in",
		},
	],
	render: externalDnsAzureConfigJson,
};

/** The provider ids the catalog offers. */
export const EXTERNAL_DNS_PROVIDER_IDS = ["cloudflare", "digitalocean", "hetzner", "aws", "google", "azure"] as const;

/**
 * Exported so `catalog-export.ts` can map a CLOUD to the external-dns provider that cloud manages
 * its own DNS with, in a total `Record` — the same compile-time discipline
 * `EXTERNAL_DNS_PROVIDERS` below applies to the credential path.
 */
export type ExternalDnsProvider = (typeof EXTERNAL_DNS_PROVIDER_IDS)[number];

/**
 * Provider → how it authenticates. `Record<ExternalDnsProvider, …>` is doing real work here: adding
 * an id to the tuple above without giving it a credential path is a COMPILE error, so the offer and
 * the wiring cannot diverge again.
 */
export const EXTERNAL_DNS_PROVIDERS: Record<ExternalDnsProvider, ExternalDnsProviderAuth> = {
	cloudflare: { label: "Cloudflare", tokenEnv: "CF_API_TOKEN" },
	digitalocean: { label: "DigitalOcean", tokenEnv: "DO_TOKEN" },
	hetzner: {
		label: "Hetzner",
		tokenEnv: "HETZNER_TOKEN",
		// Pinned to the same image and tag the platform rail runs
		// (infra/templates/argocd/external-dns.yaml), so the marketplace path and the platform path
		// cannot drift into two different Hetzner integrations.
		webhook: { image: { repository: "docker.io/hetzner/external-dns-hetzner-webhook", tag: "v0.3.3" } },
	},
	aws: {
		label: "AWS Route 53",
		saAnnotation: "eks.amazonaws.com/role-arn",
		identityLabel: "an IAM role ARN",
	},
	google: {
		label: "Google Cloud DNS",
		saAnnotation: "iam.gke.io/gcp-service-account",
		identityLabel: "a service-account email",
	},
	azure: {
		label: "Azure DNS",
		saAnnotation: "azure.workload.identity/client-id",
		identityLabel: "a managed-identity client id",
		// The identity ALONE is not enough on azure, and that is not a parity quirk — see
		// ExternalDnsConfigFile. #3589.
		configFile: EXTERNAL_DNS_AZURE_CONFIG,
	},
};

/**
 * The ServiceAccount the marketplace external-dns add-on runs under.
 *
 * NOT `external-dns-sa`, and the difference is the whole reason this is a named constant.
 *
 * The PLATFORM RAIL (`infra/templates/argocd/external-dns.yaml`) installs its own external-dns into
 * this same namespace and sets `serviceAccount.name: external-dns-sa`, and all three clouds bind
 * their platform DNS identity to that exact name — `external-dns:external-dns-sa` in the EKS IRSA
 * trust policy (infra/templates/project/aws/modules/eks/irsa.tf:139), in the GKE member
 * (gcp/workload-identity.tf:74) and in the Azure federated-credential subject
 * (azure/workload-identity.tf:26).
 *
 * So an add-on that also named its ServiceAccount `external-dns-sa` would not merely sit beside the
 * rail — it would be the SAME Kubernetes object, owned by two ArgoCD Applications with different
 * content. The rail syncs `selfHeal: true`, so the two would take turns rewriting the annotation,
 * and the loser is the PLATFORM's DNS controller: the one that publishes the environment's Ingress
 * records. A marketplace add-on must not be able to do that to the platform by being installed.
 *
 * It was unreachable until now only because `workloadIdentity` was optional and empty by default, so
 * `toValues` emitted no serviceAccount block at all — the very hole #3469 closes. Requiring the
 * identity makes the collision the NORMAL path, which is why it is fixed in the same change.
 *
 * ⚠️ FOR #3470, which plans to make the add-on assume the role the platform template already
 * creates: that role's trust is bound to `external-dns-sa` above. It has to gain
 * `external-dns:addon-external-dns-sa` (and the GKE/Azure equivalents — all three clouds, one pass)
 * rather than have the add-on borrow the rail's ServiceAccount, which cannot work for the reason
 * just given.
 */
export const EXTERNAL_DNS_ADDON_SA = "addon-external-dns";

/** The external-dns catalog id. A named constant because the entry has to reach its OWN
 * runner-seeded Secret name (`addonSecretName`) from inside `toValues` to mount the azure config
 * file off it — and an id spelled twice is an id that can be spelled two ways. */
const EXTERNAL_DNS_ADDON_ID = "external-dns";

/**
 * Why an external-dns configuration cannot be installed, or null when it can.
 *
 * ONE rule, read off `EXTERNAL_DNS_PROVIDERS` rather than off a list of cloud names, so it covers
 * every workload-identity provider the catalog declares — aws, google and azure today, and any
 * fourth one the moment it is added with a `saAnnotation`. A refusal that named the three clouds
 * would be a parity break waiting to happen.
 *
 * WHAT IT REFUSES, and why only this: a provider that authenticates by ANNOTATION, with no identity
 * to put in the annotation. `toValues` then emits no serviceAccount block, the controller runs under
 * the chart's default ServiceAccount with no identity, and on AWS that install comes up **Healthy
 * and writes nothing** — the SDK's default chain always yields some credential through IMDS, so the
 * provider constructs and a per-record Route53 `AccessDenied` is not a constructor error. gcp and
 * azure fail inside the constructor and CrashLoop, so the product at least says something there;
 * aws reports success. #3469.
 *
 * WHAT IT DELIBERATELY DOES NOT REFUSE: a token provider with no `apiToken`. Not an oversight and
 * not a parity gap — `apiToken` is a SECRET knob, and secret knobs are stripped to their schema
 * default BEFORE validation (`stripAddonSecrets`, W4.5/#640), so the schema can never see whether
 * one is stored. A refine on it would fire on every install, including the ones that are correctly
 * configured. The identity path is closable here precisely because an identity is an IDENTIFIER
 * rather than a credential — it rides in the clear, so validation can see it.
 */
function externalDnsIdentityRequirement(config: {
	provider: ExternalDnsProvider;
	workloadIdentity: string;
}): string | null {
	const p = EXTERNAL_DNS_PROVIDERS[config.provider];
	if (!p.saAnnotation) return null;
	if (config.workloadIdentity.trim() !== "") return null;
	return (
		`${p.label} authenticates ExternalDNS through workload identity, not a token, so a ` +
		`"Workload identity" is required — ${p.identityLabel ?? "the cloud identity to assume"}. ` +
		`Without it the controller runs with no identity: on AWS it starts, reports healthy and ` +
		`silently writes no DNS records at all.`
	);
}

/**
 * One refusal per MISSING config-file knob, or an empty list when the provider needs no file (or has
 * everything it needs). #3589.
 *
 * WHY THIS IS A SEPARATE RULE FROM THE IDENTITY ONE ABOVE. They refuse different things and a user
 * can hit one without the other. `externalDnsIdentityRequirement` asks "is there an identity to put
 * in the annotation"; this asks "can the provider get far enough to USE it". On azure the answer to
 * the second was NO for every configuration the marketplace could express, including — and this is
 * the defect — one with a perfectly valid client id in it. A valid-but-unusable identity passed the
 * only gate there was and installed a controller that dies in its provider constructor before it
 * ever reads a flag, which the customer meets as a CrashLoop they have to open ArgoCD to find.
 *
 * ONE ISSUE PER FIELD, on that field's own path, rather than one summary issue on the object root:
 * the configure form renders a message against the knob it names, and three missing identifiers are
 * three things to go and find, not one. The message names the field and says what the value IS, for
 * the same reason `identityLabel` exists — "azureTenantId is required" closes no loop.
 *
 * DRIVEN OFF `EXTERNAL_DNS_PROVIDERS` rather than off `c.provider === "azure"`, so a second provider
 * that reads a config file is covered the moment it declares one, and so the rule cannot come to
 * disagree with the mount `toValues` emits from the same table.
 */
function externalDnsConfigFileRequirements(config: {
	provider: ExternalDnsProvider;
	azureTenantId: string;
	azureSubscriptionId: string;
	azureResourceGroup: string;
}): { path: ExternalDnsConfigFileKey; message: string }[] {
	const p = EXTERNAL_DNS_PROVIDERS[config.provider];
	if (!p.configFile) return [];
	const out: { path: ExternalDnsConfigFileKey; message: string }[] = [];
	for (const field of p.configFile.fields) {
		if (config[field.key].trim() !== "") continue;
		out.push({
			path: field.key,
			message:
				`${p.label} needs "${field.label}" — ${field.describe}. ExternalDNS reads it from ` +
				`${p.configFile.mountPath}/${p.configFile.fileName}, which it opens BEFORE it applies any ` +
				`flag, so a workload identity on its own cannot get the controller started: it exits in ` +
				`its provider constructor and CrashLoops.`,
		});
	}
	return out;
}

/**
 * The object-store PLUGINS velero can talk to a backup location through.
 *
 * These ids are velero's own `BackupStorageLocation.spec.provider` values, not cloud names — the
 * distinction the catalog previously blurred and that made velero read as un-offerable on two
 * clouds. `aws` is the S3 plugin, and it speaks the S3 API to ANY store that does: Hetzner Object
 * Storage, Alibaba OSS, MinIO, Ceph. Upstream says so directly — "Velero's AWS Object Store plugin
 * uses Amazon's Go SDK to connect to the AWS S3 API. Some third-party storage providers also support
 * the S3 API" (velero.io/docs/v1.14/supported-providers). What that needs is an ENDPOINT, which is
 * why `s3Url` and `s3ForcePathStyle` are knobs below.
 */
/**
 * The marketplace Vault's in-cluster API root, and the Secret its bootstrap keeps state in.
 *
 * ⚠️ DERIVED, NOT CHOSEN, and a drift here does not error — it resolves nowhere, and the only
 * symptom is a Vault that stays sealed with a Job retrying against a name that does not exist.
 * Three facts compose into this string, each verified against `helm template addon-vault
 * hashicorp/vault --version 0.28.1`:
 *
 *   1. ArgoCD names the Helm release after the Application, and the Application is `addon-` + the
 *      catalog id (packages/core/argocd/addons.go `AddOnAppName`).
 *   2. The chart's `vault.fullname` returns the RELEASE NAME unchanged when it already contains the
 *      chart name — `addon-vault` does — so the server Service is `addon-vault`, not
 *      `addon-vault-vault`.
 *   3. That Service sets `publishNotReadyAddresses: true`, which is the only reason this address
 *      works AT ALL for the bootstrap: a sealed Vault fails its readiness probe (`vault status`
 *      exits 2), so an ordinary Service would carry no endpoints and the Job could never reach the
 *      Vault it exists to unseal.
 *
 * A Go test reads the value back out of the generated fixture rather than restating it, the same
 * way `hetznerVaultHost()` is pinned for the platform Vault.
 */
const VAULT_ADDON_ID = "vault";
const VAULT_ADDON_NAMESPACE = "vault";
const VAULT_ADDON_API_BASE = `http://addon-${VAULT_ADDON_ID}.${VAULT_ADDON_NAMESPACE}.svc.cluster.local:8200`;

/**
 * Where the bootstrap keeps the unseal key.
 *
 * Deliberately NOT `alethia-addon-vault`, the #640 runner-seeded secret-knob Secret. Those carry
 * `alethia.io/managed-by=addon-marketplace` + an add-on-id label, and `PruneAddOnSecrets` deletes
 * every labelled Secret whose add-on is no longer enabled. The Job writes this one with no ArgoCD
 * and no marketplace labels, so nothing sweeps it — which is the property that matters: deleting
 * the unseal key leaves a Vault nobody can ever open, and that is unrecoverable rather than merely
 * broken. Separate name as well as separate labels, so the two cannot be confused by a reader.
 */
const VAULT_ADDON_STATE_SECRET = "alethia-vault-addon-state";

const VELERO_PROVIDER_IDS = ["aws", "gcp", "azure"] as const;

/** One velero object-store provider id. */
export type VeleroProvider = (typeof VELERO_PROVIDER_IDS)[number];

/** How one velero object-store provider is installed and described. */
interface VeleroProviderPlugin {
	/** The choice's label in the configure form. */
	label: string;
	/** The plugin container image, copied into the velero pod by an init container. */
	image: string;
}

/**
 * Provider → its plugin image, PINNED.
 *
 * WHY THIS EXISTS — and it is not a refinement. The velero chart ships `initContainers: []` and says
 * so in its own values.yaml: "Init containers to add to the Velero deployment's pod spec. **At least
 * one plugin provider image is required.**" The catalog set no initContainers at all, so every
 * velero this marketplace has ever installed came up with NO object-store plugin — a `velero server`
 * that cannot talk to S3, GCS or Blob and therefore cannot take a single backup, on any cloud, even
 * with a bucket, a region and a credentials file all correctly supplied. It reported Healthy while
 * doing it, because the deployment's probes are an HTTP GET on /metrics.
 *
 * The tag is pinned against the chart's OWN velero image (7.2.1 → velero v1.14.1) through upstream's
 * compatibility table, where plugin v1.10.x ↔ velero v1.14.x
 * (github.com/vmware-tanzu/velero-plugin-for-{aws,gcp,microsoft-azure} README). A bump of `version`
 * above must be re-checked against that table — an off-by-one major here is a plugin that loads and
 * then refuses every call.
 */
const VELERO_PROVIDERS: Record<VeleroProvider, VeleroProviderPlugin> = {
	aws: {
		label: "S3 — AWS, or any S3-compatible store",
		image: "velero/velero-plugin-for-aws:v1.10.1",
	},
	gcp: {
		label: "Google Cloud Storage",
		image: "velero/velero-plugin-for-gcp:v1.10.1",
	},
	azure: {
		label: "Azure Blob Storage",
		image: "velero/velero-plugin-for-microsoft-azure:v1.10.1",
	},
};

export const ADDON_CATALOG: AddOnDef[] = [
	defineAddOn({
		id: "kube-prometheus-stack",
		name: "Prometheus + Grafana",
		category: "observability",
		icon: "LineChart",
		summary:
			"Full metrics stack — Prometheus, Grafana dashboards, and Alertmanager — installed and wired to your cluster.",
		docsUrl: "https://github.com/prometheus-community/helm-charts/tree/main/charts/kube-prometheus-stack",
		license: "Apache-2.0",
		chartRepo: "https://prometheus-community.github.io/helm-charts",
		chart: "kube-prometheus-stack",
		version: "61.9.0",
		namespace: "monitoring",
		// #2837: the bundled prometheus-node-exporter DaemonSet needs hostNetwork, hostPID and three
		// hostPaths to read node metrics at all — every one forbidden by PodSecurity `baseline`, which
		// Talos enforces on every namespace but kube-system. This is the more dangerous of the two,
		// because the operator and Grafana come up fine and the stack LOOKS healthy; it is only the
		// node metrics that are silently missing.
		podSecurity: "privileged",
		defaultValues: {
			grafana: { enabled: true },
			// Keep the footprint small by default; the knobs below tune it.
			prometheus: { prometheusSpec: {} },
			// ⚠️ THE OPERATOR'S ADMISSION WEBHOOKS ARE OFF, AND THAT IS A DELIBERATE TRADE.
			//
			// The chart installs them through a certgen Job plus five RBAC objects declared as helm
			// hooks in BOTH `pre-install,pre-upgrade` AND `post-install,post-upgrade`, carrying
			// `hook-delete-policy: before-hook-creation,hook-succeeded` — so ArgoCD deletes each one
			// the moment it succeeds and re-creates it on the next phase.
			//
			// MEASURED on azure/addons runs 33249209041, 33255369578 and 33266338989: the
			// Application sits `phase=Running waiting for completion of hook
			// rbac.authorization.k8s.io/ClusterRole/…-admission`, health=Missing, for the whole
			// 35-minute budget, with not one error in 3965 controller log lines. The controller
			// computes `Synced … serverside-applied` for those hooks and then logs "No operation
			// updates necessary" — the result computed and never persisted. Twenty add-ons converge;
			// this one never does.
			//
			// What is GIVEN UP, stated rather than buried: admission-time validation of
			// PrometheusRule and AlertmanagerConfig. The operator still validates at reconcile and
			// reports it; what is lost is the API server refusing a malformed rule at `kubectl
			// apply`. Metrics collection, alerting and Grafana are unaffected.
			//
			// `tls.enabled: false` is NOT a second opinion — it is REQUIRED by the first. Rendered
			// and checked: with only `admissionWebhooks.enabled: false`, the operator Deployment
			// still mounts `secretName: …-admission` as its `tls-secret` and its ServiceMonitor
			// still reads that Secret's `ca` with `optional: false`. The Secret is gone with the
			// certgen Job, so the operator pod never starts — one stalled Application traded for a
			// broken one. With both, the render carries ZERO non-test helm hooks, no dangling
			// secret reference, and the operator's ServiceMonitor scrapes `port: http`.
			//
			// Not a per-cloud exclusion and not an ignoreDifferences entry: the hook phase is the
			// thing that stalls, so the fix removes the hook phase. It is a `defaultValues` entry,
			// so a customer who wants the webhooks back can deep-merge them on.
			prometheusOperator: {
				admissionWebhooks: { enabled: false },
				tls: { enabled: false },
			},
		},
		configSchema: z.object({
			/** Prometheus metric retention in days. */
			retentionDays: z.coerce.number().int().min(1).max(365).default(15),
			/** Persistent volume size for Prometheus (GiB). */
			storageGb: z.coerce.number().int().min(5).max(1000).default(20),
			/** How often Prometheus scrapes targets. */
			scrapeInterval: z.enum(["15s", "30s", "60s"]).default("30s"),
			/** Bundle Grafana dashboards. */
			grafana: z.boolean().default(true),
			/** Grafana admin username (paired with the password in the same admin Secret). */
			adminUser: z.string().min(1).default("admin"),
			/** Grafana admin password (secret — encrypted at rest; empty = Alethia mints one, #2846). */
			adminPassword: z.string().default(""),
			/** Deploy Alertmanager alongside Prometheus. */
			alertmanager: z.boolean().default(true),
		}),
		toValues: (c) => ({
			grafana: { enabled: c.grafana },
			alertmanager: { enabled: c.alertmanager },
			prometheus: {
				prometheusSpec: {
					retention: `${c.retentionDays}d`,
					scrapeInterval: c.scrapeInterval,
					storageSpec: {
						volumeClaimTemplate: {
							spec: {
								resources: { requests: { storage: `${c.storageGb}Gi` } },
							},
						},
					},
				},
			},
		}),
		// Grafana's chart resolves BOTH admin user and password from ONE Secret
		// (`grafana.admin.existingSecret` + userKey/passwordKey — verified via
		// `helm template kube-prometheus-stack --version 61.9.0`). The password rides the
		// #640 runner-seeded Secret; the username is not a secret, so it pairs in via
		// secretStaticData.
		//
		// This comment used to end "No stored password ⇒ no wiring (chart generates its own)".
		// IT DOES NOT. Decoding the rendered Secret at the catalog's own values gives
		// `admin-user: admin` / `admin-password: prom-operator` — the goharbor-style published
		// default, a constant sitting in the chart's values.yaml on GitHub. Because it is a
		// CONSTANT the render never drifts, so nothing ever flagged it: the Application reports
		// Healthy while Grafana accepts a password anyone can look up (#2846).
		secretValues: (refs) =>
			refs.adminPassword
				? {
						grafana: {
							admin: {
								existingSecret: refs.adminPassword.name,
								userKey: "adminUser",
								passwordKey: "adminPassword",
							},
						},
					}
				: {},
		secretStaticData: (c) => ({ adminUser: c.adminUser }),
		// #2846: a blank field must not mean "accept the chart's published default". Minting here
		// sets `hasStoredSecret`, which makes resolveAddOnInstall emit a secretRef, which makes the
		// wiring above point Grafana at a real credential instead of `prom-operator`.
		generateSecrets: (present): Record<string, string> =>
			present.has("adminPassword") ? {} : { adminPassword: randomCredential() },
		fields: [
			{
				key: "retentionDays",
				label: "Metric retention (days)",
				type: "number",
				default: 15,
				min: 1,
				max: 365,
			},
			{
				key: "storageGb",
				label: "Prometheus storage (GiB)",
				type: "number",
				default: 20,
				min: 5,
				max: 1000,
			},
			{
				key: "scrapeInterval",
				label: "Scrape interval",
				type: "enum",
				default: "30s",
				options: [
					{ value: "15s", label: "15 seconds" },
					{ value: "30s", label: "30 seconds" },
					{ value: "60s", label: "60 seconds" },
				],
			},
			{
				key: "grafana",
				label: "Bundle Grafana dashboards",
				type: "boolean",
				default: true,
			},
			{
				key: "adminUser",
				label: "Grafana admin username",
				type: "string",
				default: "admin",
			},
			{
				key: "adminPassword",
				label: "Grafana admin password",
				type: "secret",
				secret: true,
				help: "Stored encrypted; delivered to the cluster as a k8s Secret — never in the manifest. Leave it empty and Alethia mints one for you, ONCE — read it back with `kubectl -n monitoring get secret alethia-addon-kube-prometheus-stack`. It is not regenerated on a later save.",
			},
			{
				key: "alertmanager",
				label: "Enable Alertmanager",
				type: "boolean",
				default: true,
			},
		],
		syncWave: 2,
		requires: ["storage"],
	}),
	defineAddOn({
		id: "loki",
		name: "Grafana Loki",
		category: "observability",
		icon: "ScrollText",
		summary:
			"Log aggregation for the cluster — query pod logs in Grafana alongside your metrics.",
		docsUrl: "https://github.com/grafana/loki/tree/main/production/helm/loki",
		license: "AGPL-3.0",
		chartRepo: "https://grafana.github.io/helm-charts",
		chart: "loki",
		version: "6.6.0",
		namespace: "monitoring",
		defaultValues: {
			// Single-binary, filesystem-backed — the lightest footprint for a starter install.
			deploymentMode: "SingleBinary",
			loki: {
				commonConfig: { replication_factor: 1 },
				storage: { type: "filesystem" },
				schemaConfig: {
					configs: [
						{
							from: "2024-01-01",
							store: "tsdb",
							object_store: "filesystem",
							schema: "v13",
							index: { prefix: "index_", period: "24h" },
						},
					],
				},
			},
			// ZERO, and the zero is load-bearing. A non-zero replica count on any of these three
			// ACTIVATES the chart's scalable targets, and `loki/templates/validate.yaml` then refuses
			// to render at all against a filesystem store: "Cannot run scalable targets (backend,
			// read, write) or distributed targets without an object storage backend." With `1` here
			// the chart produced no manifest, so ArgoCD reported `sync=Unknown` — no target state to
			// compare — and Loki could not install on any cloud, for any customer (#2058).
			//
			// Omitting the keys is NOT equivalent: the chart's own defaults are non-zero, so a
			// deletion re-activates the scalable targets and reproduces the same failure.
			read: { replicas: 0 },
			write: { replicas: 0 },
			backend: { replicas: 0 },
			// The chunks-cache memcached sizes its memory REQUEST from `allocatedMemory`, whose
			// chart default is 8192 (MB) — so the pod asks for 9830Mi. On a 16 GB node that is not
			// merely large, it crowds out most of the rest of the surface, and in
			// hetzner/addons run 33051626972 the loki pod never scheduled at all:
			// `0/7 nodes are available: … 6 Insufficient memory`.
			//
			// A SingleBinary, filesystem-backed starter install does not need an eight-gigabyte
			// chunk cache. 1024 MB keeps the cache doing its job at a size a default node can hold.
			chunksCache: { allocatedMemory: 1024 },
		},
		configSchema: z.object({
			/** Log retention in days (0 = keep forever). */
			retentionDays: z.coerce.number().int().min(0).max(365).default(14),
			/** Persistent volume size for the single-binary store (GiB). */
			storageGb: z.coerce.number().int().min(5).max(1000).default(10),
		}),
		toValues: (c) => ({
			loki: {
				limits_config: {
					retention_period: c.retentionDays > 0 ? `${c.retentionDays * 24}h` : "0s",
				},
			},
			singleBinary: { persistence: { size: `${c.storageGb}Gi` } },
		}),
		fields: [
			{
				key: "retentionDays",
				label: "Log retention (days, 0 = forever)",
				type: "number",
				default: 14,
				min: 0,
				max: 365,
			},
			{
				key: "storageGb",
				label: "Log storage (GiB)",
				type: "number",
				default: 10,
				min: 5,
				max: 1000,
			},
		],
		syncWave: 3,
		requires: ["storage"],
	}),
	defineAddOn({
		id: "trivy-operator",
		name: "Trivy Operator",
		category: "security",
		icon: "ShieldCheck",
		summary:
			"Continuous in-cluster security scanning — vulnerabilities + misconfigurations, surfaced as Kubernetes reports.",
		docsUrl: "https://aquasecurity.github.io/trivy-operator/latest/",
		license: "Apache-2.0",
		chartRepo: "https://aquasecurity.github.io/helm-charts/",
		chart: "trivy-operator",
		version: "0.24.1",
		namespace: "trivy-system",
		defaultValues: { trivy: { ignoreUnfixed: true } },
		configSchema: z.object({
			/** Skip vulnerabilities with no available fix (reduces noise). */
			ignoreUnfixed: z.boolean().default(true),
		}),
		toValues: (c) => ({ trivy: { ignoreUnfixed: c.ignoreUnfixed } }),
		fields: [
			{
				key: "ignoreUnfixed",
				label: "Ignore unfixed vulnerabilities",
				type: "boolean",
				default: true,
			},
		],
		syncWave: 2,
	}),
	defineAddOn({
		id: "vault",
		name: "HashiCorp Vault",
		category: "secrets",
		icon: "KeyRound",
		summary:
			"In-cluster secrets management — dynamic secrets, encryption, and a UI (complements external-secrets-operator).",
		docsUrl: "https://developer.hashicorp.com/vault/docs/platform/k8s/helm",
		license: "BUSL-1.1",
		chartRepo: "https://helm.releases.hashicorp.com",
		chart: "vault",
		version: "0.28.1",
		namespace: "vault",
		defaultValues: { server: {} },
		configSchema: z.object({
			/** Enable the Vault web UI (ClusterIP service). */
			ui: z.boolean().default(true),
			/** High-availability (Raft) server instead of a single standalone pod. */
			ha: z.boolean().default(false),
			/**
			 * Run `vault operator init` + unseal once, from inside the cluster, and enable KV v2.
			 * Off means the operator does it themselves and the pod stays sealed until they do.
			 */
			initialize: z.boolean().default(true),
			/** The Agent sidecar injector — a cluster-wide mutating admission webhook. */
			injector: z.boolean().default(false),
		}),
		// ── injector: false, and the reason is measured in the chart, not a preference ─────────
		//
		// The chart's default is TRUE, and it installs a MutatingWebhookConfiguration with
		// `caBundle: ""` plus an injector whose ClusterRole grants `patch` on
		// `mutatingwebhookconfigurations` — because with `injector.certs.secretName: null` it runs in
		// "automatic management mode", generates its own certificate and writes the bundle into the
		// webhook itself (hashicorp/vault-helm 0.28.1 values.yaml + injector-clusterrole.yaml).
		//
		// Under an ArgoCD Application with `selfHeal: true` that is not a cosmetic diff, it is a
		// FIGHT: ArgoCD heals `caBundle` back to the empty string the chart declares, the injector
		// re-patches it, forever. The Application never reaches Synced and the injector's webhook is
		// intermittently unusable. The same class the render-determinism check exists for (#2822,
		// #2823), arrived at from the other direction — a value the CLUSTER rotates rather than one
		// the render does.
		//
		// It is also a second answer to a question the product already answers: secrets reach
		// workloads through external-secrets-operator here, and the platform Vault turns the injector
		// off for exactly that reason (apps/console/lib/cloud-providers/hetzner-services.ts).
		//
		// A knob rather than a hard-coded false, because a customer's Vault is theirs and Agent
		// injection is a legitimate way to use it. The field help states the consequence.
		toValues: (c) => ({
			ui: { enabled: c.ui },
			injector: { enabled: c.injector },
			server: { ha: { enabled: c.ha } },
		}),
		// ── Why a marketplace Vault needs a bootstrap at all ──────────────────────────────────
		//
		// A freshly installed Vault is SEALED and UNINITIALISED. Nothing in the chart changes that:
		// hashicorp/vault-helm 0.28.1 has no init hook of any kind (its `server.postStart` comment
		// offers the idea and its values ship `[]`), because upstream's position is that
		// initialising is an operator act. So the marketplace was offering a one-click install of a
		// product that cannot come up — `vault status` exits 2, the readiness probe never passes,
		// no pod is ever Ready, and the Application sits Progressing at any budget.
		//
		// AUTO-UNSEAL IS NOT AN ALTERNATIVE TO THIS, and that is the finding that shaped the
		// design. A cloud-KMS seal (`awskms` / `gcpckms` / `azurekeyvault`) removes the need to hold
		// an unseal key across RESTARTS; it does not initialise anything. `vault operator init` is
		// still required exactly once, and it still has to be run by somebody. A user who owns a KMS
		// key can already reach that seal today through the Advanced values YAML, which deep-merges
		// over `server.standalone.config` — and this Job then does the one thing they still cannot
		// automate. Alethia does not provision the KMS key or the workload identity for it: a
		// marketplace add-on is a chart plus user config and can see neither the project's cloud nor
		// its IaC outputs (the same wall that moved cert-manager onto the platform rail above).
		//
		// ── The custody statement ─────────────────────────────────────────────────────────────
		//
		// With the default Shamir seal, SOMETHING must hold the unseal key across restarts, and it
		// is a Kubernetes Secret in the customer's own cluster. Against a cluster-admin, an etcd
		// backup or a volume snapshot, that buys nothing over a plain Secret — the same honest
		// accounting packages/core/argocd/vault.go makes for the platform Vault, and it must be said
		// wherever this is described. What it does buy is a Vault that WORKS: audit, leases,
		// revocation and rotation, on a cluster the customer already fully controls.
		//
		// The ROOT TOKEN is revoked before the Job exits, so no standing unrestricted credential is
		// created. The owner mints one on demand with `vault operator generate-root`, which requires
		// the stored unseal key — Vault's own documented path, and auditable each time.
		//
		// ── Why not on HA ─────────────────────────────────────────────────────────────────────
		//
		// Raft means three replicas, each of which must be joined and unsealed. This rail unseals
		// ONE node, so on `ha` it would open a third of a cluster and report success. It returns
		// null instead, and the field help says so.
		bootstrap: (c) =>
			c.initialize && !c.ha
				? {
						kind: "vault-init",
						apiBase: VAULT_ADDON_API_BASE,
						stateSecret: VAULT_ADDON_STATE_SECRET,
					}
				: null,
		fields: [
			{ key: "ui", label: "Enable Vault UI", type: "boolean", default: true },
			{
				key: "ha",
				label: "High availability (Raft)",
				type: "boolean",
				default: false,
			},
			{
				key: "initialize",
				label: "Initialise and unseal automatically",
				type: "boolean",
				default: true,
				help: `A new Vault starts sealed and cannot come up on its own. With this on, Alethia runs \`vault operator init\` and unseals it once from inside the cluster, enables KV v2 at secret/, and revokes the root token. The unseal key is written to the "${VAULT_ADDON_STATE_SECRET}" Secret in this cluster and nowhere else — mint an operator token with \`vault operator generate-root\`. Not available with high availability (Raft), where every node needs unsealing. Turn it off to hold the key yourself.`,
			},
			{
				key: "injector",
				label: "Agent sidecar injector",
				type: "boolean",
				default: false,
				help: "Off by default. The injector installs a cluster-wide mutating admission webhook and then rewrites that webhook's CA bundle itself, which GitOps continuously heals back — so the add-on never reaches Synced while it is on. Secrets already reach workloads through external-secrets-operator.",
			},
		],
		syncWave: 2,
		requires: ["storage"],
	}),
	// cert-manager is NOT here any more. It is a PLATFORM add-on
	// (infra/templates/argocd/cert-manager.yaml), installed by the deploy when the project asks
	// for a managed certificate on a cloud where an ACME DNS01 challenge can actually complete.
	//
	// It could never work on this rail. A marketplace add-on is a chart plus a user-filled config
	// schema; it cannot see `.Provider`, the DNS zone, or the cloud identity external-dns holds,
	// and a DNS01 ClusterIssuer needs all three. So this entry installed a controller with no
	// issuer — TLS that looked one checkbox away and was not.
	//
	// Keeping BOTH would have been worse than either: `crds.enabled` makes whoever installs
	// cert-manager the owner of its cluster-scoped CRDs, and two owners of one set of CRDs is the
	// metrics-server collision of #1722.
	defineAddOn({
		id: "ingress-nginx",
		name: "Ingress NGINX",
		category: "networking",
		icon: "Network",
		summary:
			"The community NGINX ingress controller — routes external HTTP(S) traffic to your in-cluster services.",
		docsUrl: "https://kubernetes.github.io/ingress-nginx/",
		license: "Apache-2.0",
		chartRepo: "https://kubernetes.github.io/ingress-nginx",
		chart: "ingress-nginx",
		version: "4.11.2",
		namespace: "ingress-nginx",
		configSchema: z.object({
			/** Controller replicas (raise for HA). */
			replicas: z.coerce.number().int().min(1).max(10).default(1),
			/** How the controller is exposed. LoadBalancer needs a cloud LB; NodePort/ClusterIP don't. */
			serviceType: z.enum(["LoadBalancer", "NodePort", "ClusterIP"]).default("LoadBalancer"),
			/** Expose Prometheus metrics for the controller. */
			metrics: z.boolean().default(false),
		}),
		toValues: (c) => ({
			controller: {
				replicaCount: c.replicas,
				service: { type: c.serviceType },
				metrics: { enabled: c.metrics },
			},
		}),
		fields: [
			{ key: "replicas", label: "Controller replicas", type: "number", default: 1, min: 1, max: 10 },
			{
				key: "serviceType",
				label: "Service type",
				type: "enum",
				default: "LoadBalancer",
				options: [
					{ value: "LoadBalancer", label: "LoadBalancer" },
					{ value: "NodePort", label: "NodePort" },
					{ value: "ClusterIP", label: "ClusterIP" },
				],
			},
			{ key: "metrics", label: "Enable metrics", type: "boolean", default: false },
		],
		syncWave: 1,
		requires: ["ingress"],
	}),
	defineAddOn({
		id: "velero",
		name: "Velero",
		category: "backup",
		icon: "Archive",
		summary:
			"Cluster backup + restore + migration to an object-store backup location — S3 (including S3-compatible stores), GCS or Azure Blob.",
		docsUrl: "https://velero.io/docs/latest/",
		license: "Apache-2.0",
		chartRepo: "https://vmware-tanzu.github.io/helm-charts",
		chart: "velero",
		version: "7.2.1",
		namespace: "velero",
		configSchema: z.object({
			/** Object-store PLUGIN for the backup location — velero's own provider name, not a cloud. */
			provider: z.enum(VELERO_PROVIDER_IDS).default("aws"),
			/** Backup bucket name. Empty = no backup location configured (velero installs unconfigured). */
			bucket: z.string().default(""),
			/** Bucket region. Required by the S3 plugin; ignored by gcp. */
			region: z.string().default(""),
			/**
			 * S3 endpoint URL for a NON-AWS S3-compatible store (Hetzner Object Storage, Alibaba OSS,
			 * MinIO, Ceph). Empty = AWS's own endpoint. `provider: aws` only.
			 */
			s3Url: z.string().default(""),
			/** Address buckets as `<endpoint>/<bucket>` rather than `<bucket>.<endpoint>`. */
			s3ForcePathStyle: z.boolean().default(false),
			/** Also back up file volumes (deploys the node-agent DaemonSet). */
			deployNodeAgent: z.boolean().default(false),
			/** Take cloud volume snapshots alongside object-store backups. */
			snapshotsEnabled: z.boolean().default(true),
			/** Provider credentials FILE contents (secret — the velero plugin's cloud file;
			 * mounted from the runner-seeded Secret's `cloud` key, never inlined). */
			cloud: z.string().default(""),
		}),
		// ── Three facts about this chart that the values below exist to honour ─────────────────
		//
		// 1. NO PLUGIN, NO BACKUPS. `initContainers` is empty upstream and the chart's own comment
		//    says at least one plugin image is required. See VELERO_PROVIDERS above.
		//
		// 2. AN UNCONFIGURED VELERO MUST STILL RENDER A VALID MANIFEST. The chart's default
		//    `configuration.backupStorageLocation` is a one-element list of EMPTY placeholders, so
		//    emitting no `configuration` at all — which is what this entry used to do when `bucket`
		//    was blank — renders `provider: <null>` and `bucket: ""`. The BackupStorageLocation CRD
		//    marks `provider` and `objectStorage.bucket` required, so the API server REJECTS the
		//    document and the whole Application fails to sync: measured health=Missing on the add-on
		//    sweep (#2717 run 33124236998), and the reason the catalog's own claim — "empty bucket =
		//    velero installs unconfigured" — was false. An EMPTY LIST is what the template wants:
		//    `{{- range .Values.configuration.backupStorageLocation }}` over nothing renders nothing.
		//
		// 3. AN S3-COMPATIBLE ENDPOINT HAS NO SNAPSHOT API. `s3Url` points the aws plugin at a bucket
		//    somebody else runs; it does not give it an EC2 API to snapshot volumes with. So a
		//    VolumeSnapshotLocation is emitted only for a plugin talking to its own cloud — offering
		//    a snapshot location that can never take a snapshot is the class of dead offer the
		//    external-dns work above exists to stop repeating.
		toValues: (c) => {
			const plugin = VELERO_PROVIDERS[c.provider];
			// S3 endpoint knobs are the aws plugin's; gcp and azure have no such config keys, and a
			// stray one on their BSL is silently ignored rather than rejected — which is worse.
			const s3 =
				c.provider === "aws"
					? {
							...(c.s3Url ? { s3Url: c.s3Url } : {}),
							...(c.s3ForcePathStyle ? { s3ForcePathStyle: true } : {}),
						}
					: {};
			const config = { ...(c.region ? { region: c.region } : {}), ...s3 };
			// Volume snapshots need the plugin's own cloud (fact 3 above), and a snapshot location
			// with no backup location is not a configuration velero can act on.
			const snapshots = c.snapshotsEnabled && Boolean(c.bucket) && !c.s3Url;
			return {
				// 4. THE CHART'S CRD-UPGRADE HOOK IS DEAD WEIGHT UNDER ARGOCD, AND ITS IMAGE NO
				//    LONGER EXISTS. With `upgradeCRDs` at its default `true` the chart emits a Job
				//    whose container is `docker.io/bitnami/kubectl:<the CLUSTER's minor>` — the tag
				//    is derived from the cluster, not pinned. Bitnami withdrew their public Docker
				//    Hub catalog, so on a 1.35 cluster that resolves to `bitnami/kubectl:1.35`,
				//    which does not exist:
				//
				//      Failed to pull image "docker.io/bitnami/kubectl:1.35":
				//        code = NotFound ... -> ErrImagePull -> ImagePullBackOff (x218)
				//
				//    The Job is a pre-upgrade hook, so ArgoCD waits on it and syncs NOTHING: every
				//    resource reads Missing and the add-on never converges. Measured on
				//    hetzner/addons run 33199532768 — `addon-velero: health=Missing sync=OutOfSync`
				//    with all 20 resources "could not fetch".
				//
				//    Turning the hook OFF is the fix rather than re-pinning the image, because under
				//    ArgoCD the hook has nothing to do: ArgoCD renders with `--include-crds` and
				//    applies the CRDs as ordinary managed resources. Verified by rendering the
				//    pinned chart both ways — `upgradeCRDs=false` emits ZERO kubectl references and
				//    still carries all THIRTEEN velero CRDs. Pinning a replacement image would have
				//    kept a Docker Hub pull, a rate limit and a second version to track, to run a
				//    Job whose work ArgoCD has already done.
				upgradeCRDs: false,
				// The plugin binary, copied into the shared `plugins` emptyDir before velero starts.
				initContainers: [
					{
						name: "velero-plugin",
						image: plugin.image,
						imagePullPolicy: "IfNotPresent",
						volumeMounts: [{ mountPath: "/target", name: "plugins" }],
					},
				],
				snapshotsEnabled: snapshots,
				deployNodeAgent: c.deployNodeAgent,
				configuration: {
					backupStorageLocation: c.bucket
						? [
								{
									name: "default",
									provider: c.provider,
									bucket: c.bucket,
									default: true,
									...(Object.keys(config).length > 0 ? { config } : {}),
								},
							]
						: [],
					volumeSnapshotLocation: snapshots
						? [
								{
									name: "default",
									provider: c.provider,
									...(c.region ? { config: { region: c.region } } : {}),
								},
							]
						: [],
				},
			};
		},
		// Velero mounts `credentials.existingSecret` at /credentials and every provider env
		// (AWS_SHARED_CREDENTIALS_FILE, GOOGLE_APPLICATION_CREDENTIALS, …) points at the
		// fixed `cloud` KEY inside it — verified via `helm template velero --version 7.2.1`.
		// The field key is therefore `cloud`, and the whole credentials file rides the #640
		// runner-seeded Secret (NEVER `secretContents.cloud`, which would inline it).
		secretValues: (refs) =>
			refs.cloud ? { credentials: { existingSecret: refs.cloud.name } } : {},
		fields: [
			{
				key: "provider",
				label: "Object-store plugin",
				type: "enum",
				default: "aws",
				help: "Velero's own provider name, not a cloud. The S3 plugin talks to any store that speaks the S3 API — set the endpoint below for one that is not AWS.",
				// Derived from the table, so a plugin added there cannot be missing here — the
				// descriptor↔schema guard (tests/lib/addons/field-descriptors.test.ts) checks the
				// other direction, that every option the form offers is one the schema accepts.
				options: VELERO_PROVIDER_IDS.map((id) => ({
					value: id,
					label: VELERO_PROVIDERS[id].label,
				})),
			},
			{
				key: "bucket",
				label: "Backup bucket",
				type: "string",
				default: "",
				help: "A bucket you own, OUTSIDE this cluster's lifecycle — a backup store destroyed with the cluster it backs up is not a backup store. Leave empty to install velero now and configure the location later.",
			},
			{ key: "region", label: "Region", type: "string", default: "" },
			{
				key: "s3Url",
				label: "S3 endpoint URL (S3-compatible stores)",
				type: "string",
				default: "",
				help: "For a non-AWS S3 store, e.g. https://fsn1.your-objectstorage.com (Hetzner Object Storage) or https://oss-eu-central-1.aliyuncs.com (Alibaba OSS). Leave empty for AWS S3. Volume snapshots are unavailable against an S3-compatible endpoint.",
			},
			{
				key: "s3ForcePathStyle",
				label: "Path-style bucket addressing",
				type: "boolean",
				default: false,
				help: "Required by most S3-compatible stores, including Hetzner Object Storage and MinIO.",
			},
			{ key: "deployNodeAgent", label: "Back up file volumes (node-agent)", type: "boolean", default: false },
			{ key: "snapshotsEnabled", label: "Volume snapshots", type: "boolean", default: true },
			{
				key: "cloud",
				label: "Provider credentials file",
				type: "secret",
				secret: true,
				help: "The velero plugin's credentials file contents (e.g. an AWS credentials profile). Stored encrypted; delivered as a k8s Secret the chart mounts — never in the manifest.",
			},
		],
		syncWave: 3,
		requires: ["storage"],
	}),
	defineAddOn({
		id: "kyverno",
		name: "Kyverno",
		category: "policy",
		icon: "ShieldCheck",
		summary:
			"Kubernetes-native admission policy — validate, mutate, and generate resources with policies (no new language).",
		docsUrl: "https://kyverno.io/docs/installation/methods/",
		license: "Apache-2.0",
		chartRepo: "https://kyverno.github.io/kyverno/",
		chart: "kyverno",
		version: "3.2.6",
		namespace: "kyverno",
		configSchema: z.object({
			/** Admission-controller replicas (≥3 recommended for HA / production). */
			replicas: z.coerce.number().int().min(1).max(5).default(3),
			/** Run the background controller (scans + generates on existing resources). */
			backgroundScan: z.boolean().default(true),
		}),
		toValues: (c) => ({
			admissionController: { replicas: c.replicas },
			backgroundController: { enabled: c.backgroundScan },
		}),
		fields: [
			{ key: "replicas", label: "Admission replicas", type: "number", default: 3, min: 1, max: 5 },
			{
				key: "backgroundScan",
				label: "Background controller",
				type: "boolean",
				default: true,
			},
		],
		syncWave: 1,
	}),
	defineAddOn({
		id: "tempo",
		name: "Grafana Tempo",
		category: "observability",
		icon: "LineChart",
		summary:
			"Distributed tracing backend — store and query traces in Grafana alongside metrics and logs.",
		docsUrl: "https://grafana.com/docs/tempo/latest/setup/helm-chart/",
		license: "AGPL-3.0",
		chartRepo: "https://grafana.github.io/helm-charts",
		chart: "tempo",
		version: "1.10.3",
		namespace: "monitoring",
		configSchema: z.object({
			/** How long traces are retained. */
			retentionHours: z.coerce.number().int().min(1).max(8760).default(24),
			/** Persistent volume size for the trace store (GiB). */
			storageGb: z.coerce.number().int().min(5).max(1000).default(10),
		}),
		toValues: (c) => ({
			tempo: { retention: `${c.retentionHours}h` },
			persistence: { enabled: true, size: `${c.storageGb}Gi` },
		}),
		fields: [
			{ key: "retentionHours", label: "Trace retention (hours)", type: "number", default: 24, min: 1, max: 8760 },
			{ key: "storageGb", label: "Trace storage (GiB)", type: "number", default: 10, min: 5, max: 1000 },
		],
		syncWave: 3,
		requires: ["storage"],
	}),
	defineAddOn({
		id: "opentelemetry-collector",
		name: "OpenTelemetry Collector",
		category: "observability",
		icon: "LineChart",
		summary:
			"Vendor-neutral pipeline for metrics, logs, and traces — receive, process, and export telemetry.",
		docsUrl:
			"https://github.com/open-telemetry/opentelemetry-helm-charts/tree/main/charts/opentelemetry-collector",
		license: "Apache-2.0",
		chartRepo: "https://open-telemetry.github.io/opentelemetry-helm-charts",
		chart: "opentelemetry-collector",
		version: "0.108.0",
		namespace: "observability",
		// The chart requires a mode + a config; a minimal OTLP-in/debug-out pipeline is a safe
		// starting point the customer tunes via Advanced values.
		defaultValues: {
			mode: "deployment",
			image: { repository: "otel/opentelemetry-collector-contrib" },
			config: {
				receivers: { otlp: { protocols: { grpc: {}, http: {} } } },
				exporters: { debug: {} },
				service: {
					pipelines: {
						traces: { receivers: ["otlp"], exporters: ["debug"] },
						metrics: { receivers: ["otlp"], exporters: ["debug"] },
						logs: { receivers: ["otlp"], exporters: ["debug"] },
					},
				},
			},
		},
		configSchema: z.object({
			/** Deployment topology: one Deployment, a per-node DaemonSet, or a StatefulSet. */
			mode: z.enum(["deployment", "daemonset", "statefulset"]).default("deployment"),
			/** Replicas (deployment/statefulset modes; ignored for daemonset). */
			replicas: z.coerce.number().int().min(1).max(10).default(1),
		}),
		toValues: (c) => ({
			mode: c.mode,
			replicaCount: c.replicas,
		}),
		fields: [
			{
				key: "mode",
				label: "Mode",
				type: "enum",
				default: "deployment",
				options: [
					{ value: "deployment", label: "Deployment" },
					{ value: "daemonset", label: "DaemonSet (per node)" },
					{ value: "statefulset", label: "StatefulSet" },
				],
			},
			{ key: "replicas", label: "Replicas", type: "number", default: 1, min: 1, max: 10 },
		],
		syncWave: 3,
	}),
	defineAddOn({
		id: "goldilocks",
		name: "Goldilocks",
		category: "observability",
		icon: "Gauge",
		summary:
			"Right-size your workloads — recommends CPU/memory requests + limits from actual usage (needs VPA).",
		docsUrl: "https://goldilocks.docs.fairwinds.com/installation/",
		license: "Apache-2.0",
		chartRepo: "https://charts.fairwinds.com/stable",
		chart: "goldilocks",
		version: "9.0.0",
		namespace: "goldilocks",
		configSchema: z.object({
			/** Install the Vertical Pod Autoscaler dependency Goldilocks needs for recommendations. */
			vpa: z.boolean().default(false),
			/** Dashboard replicas. */
			dashboardReplicas: z.coerce.number().int().min(1).max(5).default(2),
		}),
		toValues: (c) => ({
			vpa: { enabled: c.vpa },
			dashboard: { replicaCount: c.dashboardReplicas },
		}),
		fields: [
			{ key: "vpa", label: "Install VPA", type: "boolean", default: false },
			{ key: "dashboardReplicas", label: "Dashboard replicas", type: "number", default: 2, min: 1, max: 5 },
		],
		syncWave: 4,
	}),
	defineAddOn({
		id: "falco",
		name: "Falco",
		category: "security",
		icon: "ShieldCheck",
		summary:
			"Runtime threat detection — flags anomalous container + host behaviour from kernel syscalls.",
		docsUrl: "https://falco.org/docs/setup/kubernetes/",
		license: "Apache-2.0",
		chartRepo: "https://falcosecurity.github.io/charts",
		chart: "falco",
		// chart 9.1.0 → falco 0.44.1. #2866: on Talos the modern eBPF probe died at `scap_init`,
		// which read as a Talos ceiling and is not one — it is falcosecurity/falco#3813, where a
		// stricter BPF verifier pushed `recvmmsg`/`sendmmsg` past the 1M verified-instruction
		// limit on modern kernels. Fixed upstream by falcosecurity/libs#2893, first shipped in
		// falco 0.44.0 (chart 9.0.0). The same jump also mounts `driver.sysfsMountPath`
		// (/sys/kernel) for modern_ebpf, which chart 4.9.0 never did.
		version: "9.1.0",
		namespace: "falco",
		// #2837: falco mounts ten hostPaths and runs `privileged: true` — every one of those is
		// forbidden by PodSecurity `baseline`, which Talos enforces on every namespace but
		// kube-system. Without this its DaemonSet is created, its pods are REJECTED, and it reports
		// Progressing forever having monitored nothing.
		podSecurity: "privileged",
		configSchema: z.object({
			/**
			 * Syscall capture driver. `auto` picks the best available for the kernel.
			 *
			 * The legacy `ebpf` probe is NOT offered: falco 0.44.0 removed it
			 * (falcosecurity/falco#3796), and chart 9.x `fail`s the render outright on
			 * `driver.kind=ebpf` rather than degrading — so offering it would ship a knob that
			 * cannot even template. `gvisor` went the same way and was never offered.
			 */
			driver: z.enum(["auto", "modern_ebpf", "kmod"]).default("auto"),
			/** Emit events as JSON (recommended for log pipelines). */
			jsonOutput: z.boolean().default(false),
			/** Deploy Falcosidekick to fan out alerts to external destinations. */
			falcosidekick: z.boolean().default(false),
		}),
		toValues: (c) => ({
			driver: { kind: c.driver },
			falco: { json_output: c.jsonOutput },
			falcosidekick: { enabled: c.falcosidekick },
		}),
		fields: [
			{
				key: "driver",
				label: "Driver",
				type: "enum",
				default: "auto",
				options: [
					{ value: "auto", label: "Auto" },
					{ value: "modern_ebpf", label: "Modern eBPF" },
					{ value: "kmod", label: "Kernel module" },
				],
			},
			{ key: "jsonOutput", label: "JSON output", type: "boolean", default: false },
			{ key: "falcosidekick", label: "Enable Falcosidekick", type: "boolean", default: false },
		],
		syncWave: 2,
	}),
	defineAddOn({
		id: "sealed-secrets",
		name: "Sealed Secrets",
		category: "secrets",
		icon: "Lock",
		summary:
			"Encrypt secrets so they're safe to commit to Git — the controller decrypts them in-cluster.",
		docsUrl: "https://github.com/bitnami-labs/sealed-secrets#helm-chart",
		license: "Apache-2.0",
		chartRepo: "https://bitnami.github.io/sealed-secrets",
		chart: "sealed-secrets",
		version: "2.16.1",
		namespace: "kube-system",
		configSchema: z.object({
			/** Sealing-key renewal period in days (0 = never renew). */
			keyRenewalDays: z.coerce.number().int().min(0).max(365).default(30),
		}),
		toValues: (c) => ({
			keyrenewperiod: c.keyRenewalDays > 0 ? `${c.keyRenewalDays * 24}h` : "0",
		}),
		fields: [
			{
				key: "keyRenewalDays",
				label: "Key renewal (days, 0 = never)",
				type: "number",
				default: 30,
				min: 0,
				max: 365,
			},
		],
		syncWave: 1,
	}),
	defineAddOn({
		id: "reloader",
		name: "Reloader",
		category: "platform",
		icon: "Boxes",
		summary:
			"Auto-restart Deployments/StatefulSets when their ConfigMap or Secret changes — no manual rollout.",
		docsUrl: "https://github.com/stakater/Reloader#helm-charts",
		license: "Apache-2.0",
		chartRepo: "https://stakater.github.io/stakater-charts",
		chart: "reloader",
		version: "1.1.0",
		namespace: "reloader",
		configSchema: z.object({
			/** Watch all namespaces (off = only namespaces/resources with the reloader annotation). */
			watchGlobally: z.boolean().default(true),
			/** Reloader replicas. */
			replicas: z.coerce.number().int().min(1).max(3).default(1),
		}),
		toValues: (c) => ({
			reloader: {
				watchGlobally: c.watchGlobally,
				deployment: { replicas: c.replicas },
			},
		}),
		fields: [
			{ key: "watchGlobally", label: "Watch all namespaces", type: "boolean", default: true },
			{ key: "replicas", label: "Replicas", type: "number", default: 1, min: 1, max: 3 },
		],
		syncWave: 1,
	}),
	defineAddOn({
		id: "keda",
		name: "KEDA",
		category: "autoscaling",
		icon: "Gauge",
		summary:
			"Event-driven autoscaling — scale workloads (to zero) on queue depth, cron, metrics, and 60+ sources.",
		docsUrl: "https://keda.sh/docs/latest/deploy/#helm",
		license: "Apache-2.0",
		chartRepo: "https://kedacore.github.io/charts",
		chart: "keda",
		version: "2.15.1",
		namespace: "keda",
		configSchema: z.object({
			/** Operator replicas (raise for HA). */
			replicas: z.coerce.number().int().min(1).max(3).default(1),
		}),
		toValues: (c) => ({
			operator: { replicaCount: c.replicas },
		}),
		fields: [
			{ key: "replicas", label: "Operator replicas", type: "number", default: 1, min: 1, max: 3 },
		],
		syncWave: 2,
	}),
	defineAddOn({
		id: "argo-rollouts",
		name: "Argo Rollouts",
		category: "autoscaling",
		icon: "Boxes",
		summary:
			"Progressive delivery — blue-green and canary deployments with automated analysis + rollback.",
		docsUrl: "https://argo-rollouts.readthedocs.io/en/stable/installation/",
		license: "Apache-2.0",
		chartRepo: "https://argoproj.github.io/argo-helm",
		chart: "argo-rollouts",
		version: "2.37.7",
		namespace: "argo-rollouts",
		configSchema: z.object({
			/** Controller replicas (raise for HA). */
			replicas: z.coerce.number().int().min(1).max(5).default(2),
			/** Deploy the Argo Rollouts dashboard. */
			dashboard: z.boolean().default(false),
		}),
		toValues: (c) => ({
			controller: { replicas: c.replicas },
			dashboard: { enabled: c.dashboard },
		}),
		fields: [
			{ key: "replicas", label: "Controller replicas", type: "number", default: 2, min: 1, max: 5 },
			{ key: "dashboard", label: "Enable dashboard", type: "boolean", default: false },
		],
		syncWave: 2,
	}),
	// ── OSS parity add-ons: S3/registry/DNS equivalents so a compute-only cloud (Hetzner)
	//    reaches AWS-level breadth without managed services. Cloud-agnostic — run on any cluster.
	defineAddOn({
		id: "minio",
		name: "MinIO",
		category: "data",
		icon: "Boxes",
		summary:
			"S3-compatible object storage in your cluster — buckets, versioning, and an S3 API for apps and backups (a self-hosted S3).",
		docsUrl: "https://min.io/docs/minio/kubernetes/upstream/",
		license: "AGPL-3.0",
		chartRepo: "https://charts.min.io/",
		chart: "minio",
		version: "5.2.0",
		namespace: "minio",
		// The chart's own default is `resources.requests.memory: 16Gi` — verified in minio 5.2.0's
		// values.yaml, not inferred. A cpx32 node is 16 GB TOTAL, so after kubelet and system
		// reserve there is no node in any default Alethia pool that can hold this pod, on any
		// cloud. It does not run slowly; it never schedules:
		//
		//   Warning FailedScheduling  0/7 nodes are available:
		//     1 node(s) had untolerated taint(s), 6 Insufficient memory.
		//
		// (hetzner/addons run 33051626972 — minio sat Pending for the whole budget and the Application
		// reported Degraded.) 512Mi suits the `standalone` mode this catalog ships; a user who wants a
		// production cache can raise it through the raw values escape hatch.
		//
		// Same class as #2846 — a chart default shipped unexamined — and invisible for the same
		// reason: it is a CONSTANT, so the render never drifts and no sync status ever objects.
		defaultValues: {
			mode: "standalone",
			resources: { requests: { memory: "512Mi" } },
		},
		configSchema: z.object({
			/** Persistent volume size for MinIO (GiB). */
			storageGb: z.coerce.number().int().min(5).max(2000).default(50),
			/** standalone (single node) or distributed (HA, ≥4 drives). */
			mode: z.enum(["standalone", "distributed"]).default("standalone"),
			/** Root (admin) username — paired with the password in the same Secret. */
			rootUser: z.string().min(3).default("admin"),
			/** Root password (secret — encrypted at rest; empty = Alethia mints one, #2822). */
			rootPassword: z.string().default(""),
		}),
		toValues: (c) => ({
			mode: c.mode,
			persistence: { size: `${c.storageGb}Gi` },
		}),
		// The minio chart's `existingSecret` reads FIXED keys `rootUser`/`rootPassword`
		// (verified via `helm template minio --version 5.2.0` — MINIO_ROOT_USER/_PASSWORD
		// secretKeyRefs). Field keys match; the username pairs in via secretStaticData.
		secretValues: (refs) =>
			refs.rootPassword ? { existingSecret: refs.rootPassword.name } : {},
		secretStaticData: (c) => ({ rootUser: c.rootUser }),
		// #2822: with no `existingSecret`, the minio chart mints a random rootUser AND rootPassword
		// on EVERY render — verified by rendering 5.2.0 twice and diffing, which differs. ArgoCD
		// re-renders on every reconcile, so the Secret is permanently OutOfSync and the credentials
		// rotate under a running workload: anything that authenticated once stops working, with
		// nothing to say why. A blank field therefore mints here instead, which sets
		// `existingSecret` and stops the render moving.
		generateSecrets: (present): Record<string, string> =>
			present.has("rootPassword") ? {} : { rootPassword: randomCredential() },
		fields: [
			{ key: "storageGb", label: "Storage (GiB)", type: "number", default: 50, min: 5, max: 2000 },
			{
				key: "mode",
				label: "Mode",
				type: "enum",
				default: "standalone",
				options: [
					{ value: "standalone", label: "Standalone (single node)" },
					{ value: "distributed", label: "Distributed (HA, ≥4 drives)" },
				],
			},
			{ key: "rootUser", label: "Root username", type: "string", default: "admin" },
			{
				key: "rootPassword",
				label: "Root password",
				type: "secret",
				secret: true,
				help: "Stored encrypted; delivered to the cluster as a k8s Secret — never in the manifest. Leave it empty and Alethia mints one for you, ONCE — read it back with `kubectl -n minio get secret alethia-addon-minio`. It is not regenerated on a later save.",
			},
		],
		syncWave: 2,
		requires: ["storage"],
	}),
	defineAddOn({
		id: "harbor",
		name: "Harbor",
		category: "platform",
		icon: "Boxes",
		summary:
			"Private OCI container registry with vulnerability scanning, RBAC, and image signing — a self-hosted ECR/GCR/ACR.",
		docsUrl: "https://goharbor.io/docs/",
		license: "Apache-2.0",
		chartRepo: "https://helm.goharbor.io",
		chart: "harbor",
		version: "1.15.1",
		namespace: "harbor",
		configSchema: z.object({
			/** Persistent volume size for the registry store (GiB). */
			storageGb: z.coerce.number().int().min(10).max(2000).default(50),
			/**
			 * How the registry is exposed outside the cluster.
			 *
			 * DEFAULT clusterIP, NOT the chart's `ingress` — the same call, for the same measured
			 * reason, that `hetznerRegistryValues` already makes for the `registry` KIND: an ingress
			 * needs an ingress controller AND a resolvable host, and the chart's default host
			 * `core.harbor.domain` resolves nowhere. An add-on installed at catalog defaults carries
			 * no domain, so the cluster network is the only address it truly has.
			 *
			 * This is not cosmetic. ArgoCD's Ingress health check reports **Progressing** until
			 * `.status.loadBalancer` is populated, and nothing populates it for an Ingress no
			 * controller has claimed — so `addon-harbor` sat Healthy-pods/Progressing-app forever,
			 * holding the whole add-on cell red. See the toValues comment for the proof.
			 */
			exposeType: z
				.enum(["ingress", "clusterIP", "nodePort", "loadBalancer"])
				.default("clusterIP"),
			/** Harbor admin password (secret — encrypted at rest; empty = Alethia mints one, #2846). */
			adminPassword: z.string().default(""),
			/**
			 * Harbor's data-encryption key (secret, MINTED — never shown in the form).
			 *
			 * The chart's default is the literal string `not-a-secure-key`, and this is the key
			 * Harbor encrypts data at rest with — including the credentials of every registry it
			 * replicates from. The key name is dictated by the chart: "If using
			 * existingSecretSecretKey, the key must be secretKey".
			 */
			secretKey: z
				.string()
				// The 16-char rule is the CHART's, not a style preference — Harbor refuses to start
				// on any other length. `generated: true` keeps this out of the form, but hidden is
				// not unsettable: `enableAddon` validates the incoming values before stripping
				// secrets, and every server action is reachable as a POST. So the invariant is
				// enforced here rather than resting on the fact that our own minting happens to
				// produce 16.
				.refine((v) => v === "" || v.length === 16, {
					message:
						"Harbor's data-encryption key must be exactly 16 characters (leave it blank and Alethia mints one).",
				})
				.default(""),
			/**
			 * Harbor's inter-service secrets and its own registry credential (#2823). All MINTED,
			 * never shown, and never a knob — a user has no reason to choose any of them.
			 *
			 * THE KEY NAMES ARE THE CHART'S, NOT OURS. A field key becomes the k8s Secret's data
			 * key verbatim (`resolveAddOnInstall` builds `refs[key] = {name, key}`), and for four
			 * of these the chart reads a HARDCODED key that no value can redirect:
			 *   `secret`            core-dpl.yaml    `key: secret` under core.existingSecret
			 *   `REGISTRY_PASSWD`   core-dpl.yaml    under registry.credentials.existingSecret
			 *   `REGISTRY_HTPASSWD` registry-dpl.yaml mounted `items: - key: REGISTRY_HTPASSWD`
			 *   `tls.key`           core-dpl.yaml    mounted `subPath: tls.key`
			 * The other three have a companion `*Key` value, and are named to match anyway so the
			 * mapping stays readable against the chart.
			 */
			secret: z.string().default(""),
			CSRF_KEY: z.string().default(""),
			JOBSERVICE_SECRET: z.string().default(""),
			REGISTRY_HTTP_SECRET: z.string().default(""),
			REGISTRY_PASSWD: z.string().default(""),
			REGISTRY_HTPASSWD: z.string().default(""),
			"tls.key": z.string().default(""),
		}),
		// RECREATE, NOT ROLLINGUPDATE — and this is a default rather than a knob on purpose.
		//
		// Harbor's `registry` and `jobservice` Deployments own persistent volumes. On RollingUpdate
		// the new pod is scheduled BEFORE the old one is torn down, so it waits for a volume the old
		// pod still holds — and the old pod waits for the new one to become ready. On any storage
		// class that is ReadWriteOnce, that is a permanent deadlock, and every cloud's default block
		// storage is RWO.
		//
		// Measured, not inferred. hetzner/addons run 32959867406:
		//
		//   addon-harbor-registry-5c7b89b786-bnqgd  Running  true,true    <none>
		//   addon-harbor-registry-65df4f667f-b7vdh  Pending  false,false  ContainerCreating
		//     Warning FailedAttachVolume  Multi-Attach error for volume "pvc-a9ffe492-…"
		//             Volume is already used by pod(s) addon-harbor-registry-5c7b89b786-bnqgd
		//
		// Every other harbor pod was Running and ready. Nothing was misconfigured; the update
		// strategy was wrong for the storage class.
		//
		// The chart's own values file says exactly this — "Set it as Recreate when RWM for volumes
		// isn't supported" — and RWM needs NFS/EFS/Filestore, which none of the five clouds provision
		// by default. A user should not have to know that, which is why it is a default and not a
		// field: the brief downtime Recreate costs on upgrade is the correct trade against a registry
		// that never finishes rolling.
		defaultValues: { updateStrategy: { type: "Recreate" } },
		toValues: (c) => ({
			persistence: {
				persistentVolumeClaim: { registry: { size: `${c.storageGb}Gi` } },
			},
			expose: {
				type: c.exposeType,
				// ── WHY THE TLS BLOCK FOLLOWS exposeType RATHER THAN BEING FIXED ──
				//
				// On the INGRESS path, `certSource: none` is load-bearing and stays: the chart
				// default `auto` calls genSignedCert on every render, so the ingress TLS Secret and
				// the pod-template checksums that hash it move every time ArgoCD reconciles
				// (#2823). `none` is the chart's own documented answer for "the ingress controller
				// already has a certificate", and TLS stays ENABLED so `externalURL` remains https
				// — which is why it is `none` and not `tls.enabled: false`.
				//
				// That comment used to add "which on every Alethia cluster it does: cert-manager is
				// the platform TLS mechanism". THAT IS NOT TRUE, and it matters here: cert-manager
				// installs CONDITIONALLY — `CertManagerEnabled` is `ManagedCertificate && DNSEnabled
				// && DomainName != "" && CertManagerSolver() != ""` (infra_facts.go). A cluster with
				// no managed certificate has no cert-manager and no terminating certificate, so on
				// the default path there is nothing for `certSource: none` to defer to.
				//
				// Off the ingress path there is no ingress TLS Secret at all, so #2823's
				// non-determinism cannot arise and enabling TLS would only promise an https
				// `externalURL` that nothing terminates. `hetznerRegistryValues` reaches the same
				// pair — clusterIP with tls disabled — for the `registry` kind.
				tls:
					c.exposeType === "ingress"
						? { enabled: true, certSource: "none" }
						: { enabled: false },
			},
		}),
		// Harbor reads HARBOR_ADMIN_PASSWORD from `existingSecretAdminPassword` at the key
		// named by `existingSecretAdminPasswordKey` — verified via `helm template harbor
		// --version 1.15.1`. Rides the #640 runner-seeded Secret.
		// Every rotating value harbor generates at render time, wired to the ONE add-on Secret
		// instead (#2823). Measured, not reasoned: rendering the pinned chart twice with these
		// values differs on 0 lines, down from 34.
		//
		// This is the `existingSecret` route rather than the "pass the value through" route the
		// issue first proposed, and it is strictly better — no credential reaches the rendered
		// manifest at all, so nothing lands in `config_snapshot`. It also retires
		// `harbor.REGISTRY_CREDENTIAL_PASSWORD` from published-defaults-allowed.txt: pinning
		// registry.credentials is what stops the chart shipping its published
		// `harbor_registry_password`.
		secretValues: (refs) => {
			const core: Record<string, string> = {};
			const jobservice: Record<string, string> = {};
			const registry: Record<string, unknown> = {};
			const out: Record<string, unknown> = {};

			if (refs.adminPassword) {
				out.existingSecretAdminPassword = refs.adminPassword.name;
				out.existingSecretAdminPasswordKey = "adminPassword";
			}
			// The key NAME is not ours to choose — the chart requires literally `secretKey`.
			if (refs.secretKey) out.existingSecretSecretKey = refs.secretKey.name;

			// core: `secret` (hardcoded key), CSRF_KEY, and the token-signing private key. The
			// last one is why this matters beyond tidiness — it signs the registry's auth tokens,
			// so rotating it silently invalidates every `docker pull` credential ever issued.
			if (refs.secret) core.existingSecret = refs.secret.name;
			if (refs.CSRF_KEY) {
				core.existingXsrfSecret = refs.CSRF_KEY.name;
				core.existingXsrfSecretKey = "CSRF_KEY";
			}
			if (refs["tls.key"]) core.secretName = refs["tls.key"].name;

			if (refs.JOBSERVICE_SECRET) {
				jobservice.existingSecret = refs.JOBSERVICE_SECRET.name;
				jobservice.existingSecretKey = "JOBSERVICE_SECRET";
			}

			if (refs.REGISTRY_HTTP_SECRET) {
				registry.existingSecret = refs.REGISTRY_HTTP_SECRET.name;
				registry.existingSecretKey = "REGISTRY_HTTP_SECRET";
			}
			// One knob covers both REGISTRY_PASSWD and REGISTRY_HTPASSWD — the chart reads them
			// from the same Secret at those two hardcoded keys — so it is wired on either ref
			// being present rather than on one arbitrarily chosen as the trigger.
			if (refs.REGISTRY_PASSWD || refs.REGISTRY_HTPASSWD) {
				registry.credentials = {
					existingSecret: (refs.REGISTRY_PASSWD ?? refs.REGISTRY_HTPASSWD).name,
				};
			}

			if (Object.keys(core).length > 0) out.core = core;
			if (Object.keys(jobservice).length > 0) out.jobservice = jobservice;
			if (Object.keys(registry).length > 0) out.registry = registry;
			return out;
		},
		// #2846: a blank field must not mean "ship the chart's published default". Both of these
		// are constants in goharbor's values.yaml on GitHub — `Harbor12345` and `not-a-secure-key`
		// — so leaving them unset shipped a registry whose admin login and data-encryption key are
		// public knowledge. Because they are CONSTANTS the render never drifted, so no sync status
		// and no determinism check could ever have noticed.
		generateSecrets: (present): Record<string, string> => {
			const out: Record<string, string> = {};
			if (!present.has("adminPassword")) out.adminPassword = randomCredential();
			if (!present.has("secretKey")) out.secretKey = randomCredential(12);
			// #2823. Each of these replaces a value the chart would otherwise mint per render.
			if (!present.has("secret")) out.secret = randomCredential();
			if (!present.has("CSRF_KEY")) out.CSRF_KEY = randomCredential();
			if (!present.has("JOBSERVICE_SECRET")) {
				out.JOBSERVICE_SECRET = randomCredential();
			}
			if (!present.has("REGISTRY_HTTP_SECRET")) {
				out.REGISTRY_HTTP_SECRET = randomCredential();
			}
			if (!present.has("tls.key")) out["tls.key"] = randomRsaPrivateKeyPem();
			// BOTH OR NEITHER. REGISTRY_HTPASSWD is the bcrypt of REGISTRY_PASSWD, and
			// `generateSecrets` is handed the set of keys that are present, never their values —
			// so minting one against a stored other is not something this can do correctly.
			// Minting them as a pair keeps the only reachable states consistent: both absent on a
			// fresh enable (or an upgrade from before this landed), both present afterwards.
			// Neither is user-settable, so no third state exists.
			if (!present.has("REGISTRY_PASSWD") && !present.has("REGISTRY_HTPASSWD")) {
				const registryPassword = randomCredential();
				out.REGISTRY_PASSWD = registryPassword;
				// The username is the CHART's default (`registry.credentials.username`), which we
				// do not override — the htpasswd line has to name the same user harbor's core
				// authenticates as, or the registry rejects it.
				out.REGISTRY_HTPASSWD = htpasswdLine(
					"harbor_registry_user",
					registryPassword,
				);
			}
			return out;
		},
		fields: [
			{ key: "storageGb", label: "Registry storage (GiB)", type: "number", default: 50, min: 10, max: 2000 },
			{
				key: "exposeType",
				label: "Expose type",
				type: "enum",
				default: "ingress",
				options: [
					{ value: "ingress", label: "Ingress" },
					{ value: "clusterIP", label: "ClusterIP" },
					{ value: "nodePort", label: "NodePort" },
					{ value: "loadBalancer", label: "LoadBalancer" },
				],
			},
			{
				key: "adminPassword",
				label: "Admin password",
				type: "secret",
				secret: true,
				help: "Stored encrypted; delivered to the cluster as a k8s Secret — never in the manifest. Leave it empty and Alethia mints one for you, ONCE — read it back with `kubectl -n harbor get secret alethia-addon-harbor`. It is not regenerated on a later save.",
			},
			{
				// MINTED, never shown: the chart dictates the key name, and changing it after
				// install makes Harbor unable to decrypt anything it has already stored.
				key: "secretKey",
				label: "Data encryption key",
				type: "secret",
				secret: true,
				generated: true,
			},
			// #2823 — harbor's inter-service secrets. All `generated`, so none of them renders a
			// form control; they are declared as FIELDS because that is what makes them
			// secret-typed, and only a secret-typed field is minted, encrypted at rest, kept out
			// of `config_snapshot`, and delivered as a Secret ref rather than a Helm value.
			{
				key: "secret",
				label: "Core secret",
				type: "secret",
				secret: true,
				generated: true,
			},
			{
				key: "CSRF_KEY",
				label: "CSRF key",
				type: "secret",
				secret: true,
				generated: true,
			},
			{
				key: "JOBSERVICE_SECRET",
				label: "Jobservice secret",
				type: "secret",
				secret: true,
				generated: true,
			},
			{
				key: "REGISTRY_HTTP_SECRET",
				label: "Registry HTTP secret",
				type: "secret",
				secret: true,
				generated: true,
			},
			{
				key: "REGISTRY_PASSWD",
				label: "Registry credential",
				type: "secret",
				secret: true,
				generated: true,
			},
			{
				key: "REGISTRY_HTPASSWD",
				label: "Registry htpasswd",
				type: "secret",
				secret: true,
				generated: true,
			},
			{
				// The token-signing private key. Rotating it invalidates every auth token the
				// registry has issued, which is why it is pinned rather than left to the chart.
				key: "tls.key",
				label: "Token-signing key",
				type: "secret",
				secret: true,
				generated: true,
			},
		],
		syncWave: 2,
		requires: ["storage"],
	}),
	defineAddOn({
		id: EXTERNAL_DNS_ADDON_ID,
		name: "ExternalDNS",
		category: "networking",
		icon: "Network",
		summary:
			"Automatically manages DNS records for your Services and Ingresses in an external DNS provider (Hetzner, Cloudflare, …).",
		docsUrl: "https://kubernetes-sigs.github.io/external-dns/latest/",
		license: "Apache-2.0",
		chartRepo: "https://kubernetes-sigs.github.io/external-dns/",
		chart: "external-dns",
		version: "1.15.0",
		namespace: "external-dns",
		configSchema: z.object({
			/** DNS provider the controller writes records to (a fixed choice — enum). */
			provider: z.enum(EXTERNAL_DNS_PROVIDER_IDS).default("cloudflare"),
			/** Restrict record management to this domain (optional). */
			domainFilter: z.string().default(""),
			/** Provider API token (secret — encrypted at rest). Used by the TOKEN providers only;
			 * see EXTERNAL_DNS_PROVIDERS. A workload-identity provider ignores it. */
			apiToken: z.string().default(""),
			/** The cloud identity external-dns assumes on a workload-identity provider: an IAM role
			 * ARN (aws), a service-account email (google) or a managed-identity client id (azure).
			 * NOT a secret — it is an identifier, and the whole point of the keyless path is that
			 * there is no credential to store. Ignored by the token providers.
			 *
			 * REQUIRED on a workload-identity provider — see the superRefine below. */
			workloadIdentity: z.string().default(""),
			/** The three identifiers external-dns's Azure config file is built from (#3589). NOT
			 * secrets — an Entra tenant id, a subscription id and a resource-group name are
			 * identifiers, so they ride in the clear exactly like `workloadIdentity`, and validation
			 * can therefore SEE whether they are there. Ignored by every other provider.
			 *
			 * REQUIRED on azure — see `externalDnsConfigFileRequirements` and the superRefine below. */
			azureTenantId: z.string().default(""),
			azureSubscriptionId: z.string().default(""),
			azureResourceGroup: z.string().default(""),
		})
			// #3469. A provider that authenticates by ANNOTATION with nothing to annotate is not a
			// half-configured install, it is an install that CANNOT work — and on AWS it does not
			// say so: it comes up Healthy and writes nothing. Refusing the combination here means
			// the console and the CLI both reject it at configure time (both call
			// `configSchema.safeParse`), which is the only moment a user can still fix it.
			//
			// The rule itself lives in `externalDnsIdentityRequirement` so that the refusal and its
			// reason have exactly one definition; this closure only reports it.
			.superRefine((c, ctx) => {
				const why = externalDnsIdentityRequirement(c);
				if (why) {
					ctx.addIssue({
						code: "custom",
						path: ["workloadIdentity"],
						message: why,
					});
				}
				// #3589. The identity being PRESENT is not the same question as the provider being
				// able to start, and azure is where the two come apart: a valid client id with no
				// azure.json installs a controller that CrashLoops in its provider constructor.
				// Reported alongside rather than instead — a user with neither should be told both,
				// once, rather than made to fix one and resubmit to discover the next.
				for (const missing of externalDnsConfigFileRequirements(c)) {
					ctx.addIssue({
						code: "custom",
						path: [missing.path],
						message: missing.message,
					});
				}
			}),
		toValues: (c) => {
			const p = EXTERNAL_DNS_PROVIDERS[c.provider];
			return {
				// Hetzner is reached through the webhook SIDECAR, never as a native provider name —
				// see EXTERNAL_DNS_PROVIDERS. The token half of the webhook block is added by
				// `secretValues` and deep-merged onto this.
				provider: p.webhook ? { name: "webhook", webhook: { image: p.webhook.image } } : { name: c.provider },
				...(c.domainFilter ? { domainFilters: [c.domainFilter] } : {}),
				// A workload-identity provider authenticates by ANNOTATION, not by env var.
				//
				// Gated on `p.saAnnotation` ALONE, deliberately — not on `&& c.workloadIdentity` as
				// it used to be. The schema now refuses an empty identity on these providers
				// (#3469), so the identity is guaranteed present here; and if that refusal were ever
				// removed, this renders an EMPTY annotation, which is visibly broken in the manifest
				// rather than silently absent from it. The old gate is what produced the defect:
				// with no identity it emitted no serviceAccount block at all, the controller ran
				// under the chart's default ServiceAccount, and the comment that used to sit here
				// claimed the result "reports Degraded exactly as an unconfigured token provider
				// does". That is true on gcp and azure, which fail inside the provider constructor,
				// and FALSE on aws, where the SDK's default chain always yields a credential through
				// IMDS: the pod stays Ready, ArgoCD reports Healthy, and every Route53 write is
				// refused one record at a time. Fail-open on exactly the cloud a user is most likely
				// to be on.
				...(p.saAnnotation
					? {
							serviceAccount: {
								name: EXTERNAL_DNS_ADDON_SA,
								annotations: { [p.saAnnotation]: c.workloadIdentity },
							},
							// Azure's workload-identity webhook only injects into labelled pods.
							...(c.provider === "azure" ? { podLabels: { "azure.workload.identity/use": "true" } } : {}),
						}
					: {}),
				// #3589. A provider whose ExternalDNS implementation reads a CONFIG FILE off disk
				// gets one, mounted from the add-on's OWN runner-seeded Secret — the same shape the
				// platform rail uses, and the reason this add-on was un-installable on azure by any
				// combination of values the console offered.
				//
				// `extraVolumes`/`extraVolumeMounts` and not the chart's `secretConfiguration`: that
				// block is DEPRECATED in chart 1.15.0 and would inline the identifiers into the
				// Application spec (and into the customer's repo in gitops mode). The Secret's
				// CONTENT comes from `requiredSecretData` below, which is what makes it a file at a
				// path rather than a Helm value.
				//
				// Unconditional on `p.configFile` — deliberately, and for the reason the
				// `saAnnotation` gate above states: the schema now refuses a config-file provider
				// with a missing identifier, so the Secret key is guaranteed to be seeded here; and
				// were that refusal ever removed, a pod that cannot mount its volume is visibly
				// stuck rather than silently running without the file.
				...(p.configFile
					? {
							extraVolumes: [
								{
									name: p.configFile.volumeName,
									secret: {
										secretName: addonSecretName(EXTERNAL_DNS_ADDON_ID),
										// PROJECTED rather than mounted whole: the same Secret carries
										// `apiToken` whenever one has ever been stored, and mounting
										// every key would drop a stray credential file into the
										// provider's config directory.
										items: [{ key: p.configFile.fileName, path: p.configFile.fileName }],
									},
								},
							],
							extraVolumeMounts: [
								{
									name: p.configFile.volumeName,
									mountPath: p.configFile.mountPath,
									readOnly: true,
								},
							],
						}
					: {}),
			};
		},
		secretValues: (refs, c) => {
			const ref = refs.apiToken;
			const p = EXTERNAL_DNS_PROVIDERS[c.provider];
			// A workload-identity provider takes NO token. Rendering one anyway is what the previous
			// wiring did — every non-digitalocean provider got `CF_API_TOKEN` — so aws, google and
			// azure received a Cloudflare-shaped env var they have no use for while their actual
			// identity path stayed unreachable. An env var that cannot work is worse than none: it
			// makes a broken install look configured.
			if (!ref || !p.tokenEnv) return {};
			const env = [{ name: p.tokenEnv, valueFrom: { secretKeyRef: { name: ref.name, key: ref.key } } }];
			// The webhook sidecar reads its token from ITS OWN env block, not the controller's.
			return p.webhook ? { provider: { webhook: { env } } } : { env };
		},
		/**
		 * The config FILE a provider reads off disk, as one key in the add-on's Secret (#3589).
		 *
		 * `requiredSecretData` and not `secretStaticData`: this file is needed whether or not any
		 * credential exists — on azure there is none, by design — so it has to be sufficient on its
		 * own to make the runner seed the Secret. Nothing in it is material a snapshot must not
		 * carry: four identifiers and a boolean, with `aadClientSecret` absent so the credential
		 * path stays keyless. The Secret is used only because external-dns wants a FILE at a path,
		 * which no Helm value can express.
		 *
		 * `toValues` above mounts it. The two read the SAME `configFile` descriptor, so the file
		 * this seeds and the path the controller opens cannot come to disagree.
		 */
		requiredSecretData: (c) => {
			const p = EXTERNAL_DNS_PROVIDERS[c.provider];
			if (!p.configFile) return {};
			return {
				[p.configFile.fileName]: p.configFile.render({
					azureTenantId: c.azureTenantId,
					azureSubscriptionId: c.azureSubscriptionId,
					azureResourceGroup: c.azureResourceGroup,
				}),
			};
		},
		fields: [
			{
				key: "provider",
				label: "DNS provider",
				type: "enum",
				default: "cloudflare",
				options: EXTERNAL_DNS_PROVIDER_IDS.map((id) => ({ value: id, label: EXTERNAL_DNS_PROVIDERS[id].label })),
			},
			{ key: "domainFilter", label: "Domain filter (optional)", type: "string", default: "" },
			{
				key: "apiToken",
				label: "Provider API token",
				type: "secret",
				secret: true,
				help: "Required for Cloudflare, DigitalOcean and Hetzner. AWS, Google and Azure authenticate through workload identity instead — leave this empty and fill in the identity below.",
			},
			{
				key: "workloadIdentity",
				label: "Workload identity (AWS / Google / Azure)",
				type: "string",
				default: "",
				help:
					"REQUIRED for AWS, Google and Azure — the identity external-dns assumes: an IAM role ARN (AWS), " +
					`a service-account email (Google) or a managed-identity client id (Azure). Bind it to the ` +
					`add-on's ServiceAccount, "${EXTERNAL_DNS_ADDON_SA}" in the "external-dns" namespace. Not needed ` +
					"for the token providers, which take an API token above instead.",
			},
			// #3589. Azure's three identifiers, derived from the provider table so the form, the
			// refusal and the file it ends up in are one list. They are identifiers, not credentials
			// — `type: "string"`, in the clear, exactly like the workload identity above.
			...EXTERNAL_DNS_AZURE_CONFIG.fields.map((f) => ({
				key: f.key,
				label: `${f.label} (Azure only)`,
				type: "string" as const,
				default: "",
				help:
					`REQUIRED for Azure — ${f.describe}. ExternalDNS's Azure provider reads these from ` +
					`${EXTERNAL_DNS_AZURE_CONFIG.mountPath}/${EXTERNAL_DNS_AZURE_CONFIG.fileName} before it applies ` +
					"any flag, so the workload identity alone cannot start it. Alethia builds that file and mounts " +
					"it for you; no credential goes in it. Leave empty for every other provider.",
			})),
		],
		syncWave: 2,
	}),
];

/** A catalog add-on id (the `project_addons.addon_id`). */
export type AddOnId = string;

/** Looks up a catalog entry by id, or null when the id is unknown/retired. */
export function getAddOn(id: string): AddOnDef | null {
	return ADDON_CATALOG.find((a) => a.id === id) ?? null;
}

/**
 * Parses a raw Helm-values YAML override into a plain object, or null when it's empty or not a
 * YAML mapping (a scalar/list is not a valid Helm values override). Never throws — resolution
 * treats a bad override as "no override".
 */
export function parseValuesYaml(
	yaml: string | null | undefined,
): Record<string, unknown> | null {
	if (!yaml || !yaml.trim()) return null;
	try {
		const parsed = parseYaml(yaml);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return asRecord(parsed);
		}
	} catch {
		// Malformed YAML — ignore (the enable action validates before persisting).
	}
	return null;
}

/** The deterministic name of the k8s Secret the runner seeds for an add-on's secret knobs
 * (W4.5). Per-add-on, in the add-on's install namespace — distinct from the platform's own
 * infra secrets (e.g. `external-dns-cloudflare` in the infra external-dns). */
export function addonSecretName(addonId: string): string {
	return `alethia-addon-${addonId}`;
}

/**
 * Resolves an enabled `project_addons` row into the runner-facing install spec: pins the
 * chart coords, validates + defaults the stored knobs, and deep-merges them onto the add-on's
 * base values. Returns null when the add-on id is no longer in the catalog (so a retired
 * add-on is skipped, not mis-provisioned).
 *
 * SECRET knobs (W4.5, #640): their values are NEVER resolved here — they are stripped before
 * validation (the schema default applies), so neither `toValues` nor the returned `values`
 * can carry a credential, and nothing plaintext enters the DEPLOY job's config snapshot.
 * Instead the spec carries a `secretRef` (deterministic Secret name + the data keys); the
 * runner fetches the plaintext at execution time over the authenticated job channel and
 * seeds the Secret in-cluster, and the def's `secretValues` wires the chart at it.
 */
export function resolveAddOnInstall(row: {
	addon_id: string;
	mode: AddOnMode;
	version?: string | null;
	values?: Record<string, unknown> | null;
	values_yaml?: string | null;
}): AddOnInstallSpec | null {
	const def = getAddOn(row.addon_id);
	if (!def) return null;
	const stored = row.values ?? {};
	// Strip secret-typed knobs BEFORE validation — the schema sees its default, never a
	// credential (neither an EncryptedSecret envelope nor a legacy pre-W4 plaintext).
	const sansSecrets = stripAddonSecrets(def, stored);
	// Validate the stored knobs. Two failure modes, and they must NOT be treated alike:
	//
	//   SHAPE mismatch (invalid_type, invalid_value, too_small …) — a stale row left behind by a
	//     schema that moved. Fall back to the schema defaults so it never blocks a deploy: the
	//     add-on installs in its default configuration, which is the one the catalog ships.
	//
	//   A CUSTOM issue — a rule the catalog author wrote on purpose, saying this combination cannot
	//     work (external-dns on a workload-identity provider with no identity, #3469). Falling back
	//     to defaults here would be worse than useless: it would resolve a DIFFERENT add-on
	//     configuration than the row asks for and install it silently. Concretely, an AWS
	//     external-dns row would deploy pointed at CLOUDFLARE, because that is the schema default —
	//     a refusal laundered into a wrong install. Fail closed instead: the add-on does not resolve,
	//     exactly as a retired one does not, and the caller skips it.
	//
	// Reachable only for a row stored BEFORE the rule existed — `enableAddon` and the CLI route both
	// run this same schema and reject a new one — so "skipped" means "an install that could never
	// have worked is no longer applied". The row stays enabled and the configure form states the
	// reason, which is where a user can act on it.
	const parsed = def.configSchema.safeParse(sansSecrets);
	if (!parsed.success && parsed.error.issues.some((i) => i.code === "custom")) return null;
	const config = parsed.success ? parsed.data : def.configSchema.parse({});
	const knobValues = def.toValues ? def.toValues(config) : {};
	// Which secret fields actually HAVE a stored value → the Secret's data keys + the refs
	// handed to the def's chart wiring.
	const secretKeys = secretFieldKeys(def).filter((k) => hasStoredSecret(stored[k]));
	const secretName = addonSecretName(def.id);
	const refs = Object.fromEntries(
		secretKeys.map((k) => [k, { name: secretName, key: k }]),
	);
	const secretWiring =
		secretKeys.length > 0 && def.secretValues ? def.secretValues(refs, config) : {};
	// NON-secret data the chart needs IN ITS OWN RIGHT (#3589) — computed before the decision below
	// because it is now half of that decision.
	//
	// A Secret used to be seeded only when some SECRET-typed knob had a stored value. external-dns
	// on azure needs a Secret and no credential at all: its `azure.json` is four identifiers and a
	// boolean, and the provider reads it as a FILE off a path before it applies any flag, so no Helm
	// value can carry it. Under the old gate the add-on could not be given one by any combination of
	// values the console offered, and an azure user who pasted a perfectly valid managed-identity
	// client id still got a controller that CrashLoops in its constructor.
	//
	// Deliberately NOT `secretStaticData`, which is PAIRED data — widening that one instead would
	// seed grafana and minio a Secret holding nothing but an admin username on every install that
	// never set a password.
	//
	// The runner already handles this shape: `EnsureAddOnSecrets` seeds `StaticData` first and
	// tolerates an empty `Keys` (packages/core/argocd/addon_secrets.go), so nothing changes there.
	const requiredData = def.requiredSecretData ? def.requiredSecretData(config) : {};
	const needsSecret = secretKeys.length > 0 || Object.keys(requiredData).length > 0;
	const bootstrap = def.bootstrap ? def.bootstrap(config) : null;
	// Precedence (low → high): chart defaults → schema knobs → secret wiring → the user's raw
	// Helm-values YAML. Unparseable raw YAML is ignored (the save-time action validates it) so
	// it never blocks a deploy.
	let values = deepMerge(def.defaultValues ?? {}, knobValues);
	values = deepMerge(values, secretWiring);
	const rawOverride = parseValuesYaml(row.values_yaml);
	if (rawOverride) values = deepMerge(values, rawOverride);
	return {
		id: def.id,
		mode: row.mode,
		chartRepo: def.chartRepo,
		chart: def.chart,
		version: row.version ?? def.version,
		namespace: def.namespace,
		values,
		syncWave: def.syncWave,
		// #2837: only when the add-on asks. An absent field leaves the namespace unlabelled and the
		// cluster's own default in force.
		...(def.podSecurity ? { podSecurity: def.podSecurity } : {}),
		// The one-shot in-cluster bootstrap this add-on's knobs ask for (a sealed Vault's init +
		// unseal). Derived from the PARSED config, so a stored row that fails validation falls back
		// to the schema defaults here exactly as `values` does — the two can never disagree about
		// which configuration was resolved.
		...(bootstrap ? { bootstrap } : {}),
		...(needsSecret
			? {
					secretRef: {
						secretName,
						namespace: def.namespace,
						keys: secretKeys,
						// Paired NON-secret Secret data (#644): the admin USERNAME a chart reads from
						// the same Secret as the password — plus, since #3589, data the chart needs
						// in its own right (a config FILE it mounts). Both snapshot-safe by contract;
						// they share one k8s Secret, so they merge here rather than at the runner.
						// Omitted entirely when neither yields anything, so an add-on with only
						// secret knobs exports the spec it always did.
						...(def.secretStaticData || Object.keys(requiredData).length > 0
							? {
									staticData: {
										...(def.secretStaticData ? def.secretStaticData(config) : {}),
										...requiredData,
									},
								}
							: {}),
					},
				}
			: {}),
	};
}

/** The sync-wave BYO charts install on — after core infra add-ons (0) so a chart depending on,
 * say, an ingress controller finds it present. */
const BYO_CHART_SYNC_WAVE = 5;

/**
 * Resolves a bring-your-own (source='byo') project_addons row into a git-source install spec the
 * runner renders as an ArgoCD Application inside the project's hardened "byo-<slug>" AppProject.
 * The chart comes from the customer's git repo (chart_repo + chart_path + version=ref), NOT the
 * OSS catalog — so there is no schema to validate against; the stored `values` ride through as-is,
 * with a raw Helm-values YAML override deep-merged on top (same precedence as catalog add-ons).
 * Returns null when required git coordinates are missing (a mis-built row is skipped, never
 * mis-provisioned).
 */
export function resolveByoChartInstall(
	row: {
		addon_id: string;
		mode: AddOnMode;
		version?: string | null;
		chart_repo?: string | null;
		chart_path?: string | null;
		namespace?: string | null;
		values?: Record<string, unknown> | null;
		values_yaml?: string | null;
	},
	// The described workloads' user overlay (W5 Lane 2). Their static config (replicas/env) is
	// composed onto the pristine `values` at each knob's value-path — see lib/addons/chart-overlay.
	// Binding write-back is runner-side (Lane 2b) and intentionally not composed here.
	workloads: ChartWorkloadOverlay[] = [],
): AddOnInstallSpec | null {
	if (!row.chart_repo) return null;
	// An `oci://` repo is a private OCI Helm registry (source='helm'); anything else is a git repo
	// (source='git') whose chart lives at chart_path.
	const isOci = row.chart_repo.startsWith("oci://");
	if (!isOci && !row.chart_path) return null;
	// Precedence (low → high): pristine project_addons.values → workload config overlay → raw YAML.
	let values: Record<string, unknown> = { ...(row.values ?? {}) };
	if (workloads.length > 0) {
		values = composeChartOverlay(values, workloads).values;
	}
	const rawOverride = parseValuesYaml(row.values_yaml);
	if (rawOverride) values = deepMerge(values, rawOverride);
	// Forward the workloads' bindings + value_paths for the runner to resolve at deploy (Lane 2b):
	// only those with bindings (the runtime write-back is the only reason the runner needs them).
	const bound = workloads
		.filter((w) => w.bindings.length > 0)
		.map((w) => ({
			name: w.name,
			bindings: w.bindings,
			valuePaths: w.value_paths,
		}));
	if (isOci) {
		// Private OCI Helm chart. ArgoCD's OCI source splits `oci://<host>/<ns>/<chart>` into
		// repoURL (host + namespace, chart stripped) + chart (the last path segment) + targetRevision
		// (the chart version). We KEEP the `oci://` scheme so the Application repoURL is a prefix of
		// the seeded repo-cred `url` (e.g. cred `oci://ghcr.io` prefixes `oci://ghcr.io/acme`) — the
		// convention packages/core/argocd/helm_repo_secrets.go + the helm_registry_oci_* providers
		// already commit to. (Note: some ArgoCD versions want repoURL without the scheme; if that
		// surfaces, strip `oci://` on BOTH the Application and the seeded cred in lockstep.)
		const segments = row.chart_repo
			.slice("oci://".length)
			.replace(/\/+$/, "")
			.split("/")
			.filter(Boolean);
		const chart = segments.pop() ?? "";
		// Need at least a host AND a chart segment to address a chart.
		if (!chart || segments.length === 0) return null;
		return {
			id: row.addon_id,
			mode: row.mode,
			source: "helm",
			chartRepo: `oci://${segments.join("/")}`,
			// Unused for a helm source (the chart is named separately), but the spec requires it.
			path: "",
			chart,
			// The chart version (ArgoCD targetRevision); `*` = latest when unset.
			version: row.version || "*",
			namespace: row.namespace ?? "default",
			values,
			syncWave: BYO_CHART_SYNC_WAVE,
			...(bound.length > 0 ? { workloads: bound } : {}),
			// project is set by the runner (byo-<slug>); leave undefined here.
		};
	}
	return {
		id: row.addon_id,
		mode: row.mode,
		source: "git",
		chartRepo: row.chart_repo,
		// The chart directory within the repo (rendered as ArgoCD `source.path`).
		path: row.chart_path ?? "",
		// Unused for git source, but the spec requires the field; keep it empty.
		chart: "",
		// The git ref (branch/tag/sha); default to HEAD so an unset ref still resolves.
		version: row.version ?? "HEAD",
		namespace: row.namespace ?? "default",
		values,
		syncWave: BYO_CHART_SYNC_WAVE,
		...(bound.length > 0 ? { workloads: bound } : {}),
		// project is set by the runner (byo-<slug>); leave undefined here.
	};
}
