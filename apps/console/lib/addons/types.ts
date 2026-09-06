// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Types for the cluster add-on marketplace — free OSS apps (Grafana, Vault, Trivy, …) the
// customer's provisioned cluster comes up with, deployed as ArgoCD Helm Applications. The
// catalog (catalog.ts) is a code SSOT (no DB enum) modelled on lib/alerts/catalog.ts; the
// console resolves an enabled add-on into a fully-resolved install spec (chart coords +
// merged Helm values + mode) that rides the DEPLOY job's config snapshot to the runner.

import { z } from "zod";
import type { K8sRange } from "@/lib/compat";
import type { AddonMode } from "@/lib/db/schema/enums";
import type { ChartValuePathMap, ServiceBinding } from "@/types/jsonb.types";

/** Day-2 categories an add-on belongs to (drives grouping in the marketplace UI). */
export type AddOnCategory =
	| "observability"
	| "security"
	| "secrets"
	| "networking"
	| "platform"
	| "autoscaling"
	| "backup"
	| "policy"
	| "data";

/** How an add-on is delivered into the cluster. `managed` = Alethia renders + applies the
 * ArgoCD Application directly; `gitops` = the manifest is written into the customer's apps
 * repo and ArgoCD syncs it from there (they own + edit it). The generated `addon_mode` enum. */
export type AddOnMode = AddonMode;

/** lucide icon name the UI resolves — data stays JSX-free (mirrors the alerts catalog). */
export type AddOnIcon =
	| "LineChart"
	| "ScrollText"
	| "ShieldCheck"
	| "KeyRound"
	| "Network"
	| "Boxes"
	| "Gauge"
	| "Archive"
	| "Database"
	| "Lock";

/** A capability an add-on expects the environment to provide (informational gating). */
export type AddOnRequirement = "ingress" | "domain" | "storage";

/** The kind of a configurable add-on knob. `enum` = a fixed choice (carries `options`); `secret`
 * = a credential persisted encrypted-at-rest (EncryptedSecret), never plaintext; `nested` = a
 * one-level group of scalar sub-fields (e.g. `resources.requests.{cpu,memory}`). */
/**
 * The Pod Security Standards levels, most permissive first. A finite, externally-defined set — the
 * three levels the upstream `pod-security.kubernetes.io/enforce` label accepts.
 */
export const ADDON_POD_SECURITY_LEVELS = [
	"privileged",
	"baseline",
	"restricted",
] as const;

/** One Pod Security Standards level. */
export type AddOnPodSecurityLevel = (typeof ADDON_POD_SECURITY_LEVELS)[number];

export type AddOnFieldType =
	| "number"
	| "boolean"
	| "string"
	| "enum"
	| "secret"
	| "nested";

/** A serializable descriptor for one configurable knob — drives the configure form on the
 * client (the Zod `configSchema` still validates server-side; this mirrors its fields). Validate a
 * descriptor with `addOnFieldSchema` (W4 adds the descriptor↔schema consistency guard). */
export interface AddOnField {
	key: string;
	label: string;
	type: AddOnFieldType;
	/** Default for a scalar field. Omitted for `secret` (write-only) and `nested` (its children
	 * carry their own defaults). */
	default?: number | boolean | string;
	help?: string;
	min?: number;
	max?: number;
	/** Fixed choices for `type: "enum"` — the `value` is stored, the `label` is shown. */
	options?: { value: string; label: string }[];
	/** Child descriptors for `type: "nested"` — ONE level only (children must be scalar). */
	fields?: AddOnField[];
	/** Convenience flag equal to `type === "secret"` — persisted encrypted-at-rest, never plaintext. */
	secret?: boolean;
	/**
	 * This field is MINTED by `generateSecrets` and never shown in the configure form (#2846).
	 *
	 * Some charts read a credential from a Secret under a key THEY choose — harbor's data-encryption
	 * key must be stored under literally `secretKey`, and the chart says so. Such a field has to
	 * exist so `secretFieldKeys` includes it and the runner seeds it, but putting `secretKey` in a
	 * marketplace form would be noise at best: nobody has an opinion about its value, and changing
	 * it after install makes harbor unable to decrypt everything it has already stored.
	 *
	 * A `generated` field is therefore machine-owned. It still travels the ordinary secret path —
	 * encrypted at rest, stripped before validation, delivered by secretRef — it simply has no UI.
	 */
	generated?: boolean;
}

const addOnFieldOption = z.object({ value: z.string(), label: z.string() });

/** Fields common to every descriptor kind. */
const addOnFieldBase = {
	key: z.string().min(1),
	label: z.string().min(1),
	help: z.string().optional(),
	min: z.number().optional(),
	max: z.number().optional(),
};

/** A scalar (non-nested) descriptor. An `enum` must carry non-empty `options`. */
const addOnScalarFieldSchema = z
	.object({
		...addOnFieldBase,
		type: z.enum(["number", "boolean", "string", "enum", "secret"]),
		default: z.union([z.number(), z.boolean(), z.string()]).optional(),
		options: z.array(addOnFieldOption).optional(),
		secret: z.boolean().optional(),
	})
	.refine((f) => f.type !== "enum" || (f.options?.length ?? 0) > 0, {
		message: "an enum field requires non-empty options",
		path: ["options"],
	});

/** Validates one `AddOnField` descriptor: a scalar kind, or a one-level `nested` group whose
 * children are scalars (no deeper recursion — a deliberate W4 constraint). */
export const addOnFieldSchema = z.union([
	addOnScalarFieldSchema,
	z.object({
		...addOnFieldBase,
		type: z.literal("nested"),
		fields: z.array(addOnScalarFieldSchema).min(1),
	}),
]);

/**
 * A catalog entry: a curated OSS Helm chart plus the small set of user-tunable knobs the
 * marketplace surfaces. `configSchema` validates the knobs; `toValues` maps the parsed knobs
 * to a partial Helm-values object that is deep-merged onto `defaultValues`.
 */
export interface AddOnDef<Schema extends z.ZodTypeAny = z.ZodTypeAny> {
	/** Stable catalog id, e.g. "kube-prometheus-stack" (the `project_addons.addon_id`). */
	id: string;
	name: string;
	category: AddOnCategory;
	icon: AddOnIcon;
	/** One-line description shown on the card. */
	summary: string;
	docsUrl: string;
	/** OSS license label (e.g. "Apache-2.0"). Every catalog add-on is free. */
	license: string;
	// ── Helm coordinates ────────────────────────────────────────────────
	chartRepo: string;
	chart: string;
	/** Pinned chart version (the install default; a row may override it). */
	version: string;
	/** Default install namespace. */
	namespace: string;
	/** Base Helm values always applied, before the user knobs are merged in. */
	defaultValues?: Record<string, unknown>;
	/** Zod schema for the surfaced knobs (with defaults) — drives the configure form. */
	configSchema: Schema;
	/** Maps the parsed knobs to a partial Helm-values object (deep-merged onto defaults).
	 * NEVER receives secret-typed knob values (W4.5): they are stripped to their schema
	 * defaults before the call, so a plaintext credential cannot reach `values`. */
	toValues?: (config: z.infer<Schema>) => Record<string, unknown>;
	/**
	 * Maps k8s SecretKeyRefs onto the chart's own secret-consumption knob (W4.5) — e.g.
	 * external-dns takes `env[].valueFrom.secretKeyRef`. Called with one ref per SECRET-typed
	 * field that has a stored value (`refs[fieldKey] = { name, key }`, the Secret the runner
	 * seeds in the add-on's namespace before sync) plus the parsed NON-secret knobs (the env
	 * var / values path may depend on them, e.g. the DNS provider); the returned fragment is
	 * deep-merged onto `toValues`' output. This is how a secret knob reaches the chart WITHOUT
	 * its value ever appearing in the rendered Application manifest (or the gitops repo).
	 */
	secretValues?: (
		refs: Record<string, AddOnSecretKeyRef>,
		config: z.infer<Schema>,
	) => Record<string, unknown>;
	/**
	 * NON-secret Secret data the chart expects alongside the secret keys (#644: e.g. the
	 * grafana/minio admin USERNAME — the chart resolves user and password from the SAME
	 * Secret, but the username is an ordinary knob). Called only when a Secret is being
	 * seeded (some secret field has a stored value); returns data-key → literal value.
	 * MUST NOT return credential material — this rides the config snapshot.
	 *
	 * PAIRED, and that is the whole contract: a username with no password beside it is not a Secret
	 * worth seeding. Data the chart needs whether or not any credential exists goes through
	 * `requiredSecretData` below instead.
	 */
	secretStaticData?: (config: z.infer<Schema>) => Record<string, string>;
	/**
	 * NON-secret Secret data the chart needs IN ITS OWN RIGHT — enough, on its own, to make the
	 * runner seed this add-on's Secret even when no secret-typed knob has a stored value (#3589).
	 *
	 * WHY IT IS NOT `secretStaticData`. That hook answers "what else belongs in the Secret we are
	 * already seeding" — it is meaningless without the credential beside it, and making a non-empty
	 * return sufficient on its own would hand grafana and minio a Secret holding nothing but an
	 * admin USERNAME on every install that never set a password. This one answers a different
	 * question: "does this chart need a Secret at all, credential or no".
	 *
	 * THE MEASURED CASE. external-dns's azure provider reads `/etc/kubernetes/azure.json` before it
	 * applies any flag, and `useWorkloadIdentityExtension` — the key that stops it authenticating as
	 * the node's kubelet identity — exists in no flag anywhere in v0.15.0. So the chart needs a FILE
	 * at a path, which no Helm value can express, and the file holds four identifiers and no
	 * credential. Until this existed the marketplace add-on could not be given one by any
	 * combination of values the console offered: an azure customer with a perfectly valid managed
	 * identity got a controller that CrashLoops in its constructor.
	 *
	 * MUST NOT return credential material, for exactly the reason `secretStaticData` must not: the
	 * value rides the DEPLOY job's config snapshot, which is persisted in Postgres. A real
	 * credential belongs in a `secret`-typed field, which never travels this way.
	 */
	requiredSecretData?: (config: z.infer<Schema>) => Record<string, string>;
	/**
	 * The Pod Security Standards level this add-on's OWN namespace must allow (#2837).
	 *
	 * Talos — which every hetzner cluster runs — enables the PodSecurity admission plugin with
	 * `enforce: baseline` and exempts only `kube-system`. Baseline forbids privileged containers,
	 * host namespaces and hostPath volumes, so a chart that needs any of those has its DaemonSet
	 * ADMITTED and its pods REJECTED: `desiredNumberScheduled > 0`, zero pods, Progressing forever,
	 * and nothing in the Application saying why.
	 *
	 * Declaring it here rather than relaxing the cluster is the point. It is scoped to this add-on's
	 * own namespace, so enabling falco does not weaken the namespace next door; it is visible, which
	 * is what a user deciding whether to install a node-level agent should be told; and an add-on
	 * that does not ask for host access still cannot get it.
	 *
	 * Omitted means "do not label the namespace" — the cluster's own default applies, which is the
	 * right answer for every add-on that runs as an ordinary workload.
	 */
	podSecurity?: AddOnPodSecurityLevel;
	/**
	 * Mints values for secret knobs the user left unset, at ENABLE time (#2822, #2823).
	 *
	 * Some charts generate their own credential when none is supplied — and they do it at RENDER
	 * time, with `randAlphaNum` or `genCA`. ArgoCD re-renders on every reconcile, so such a chart
	 * is PERMANENTLY OutOfSync, and the value it depends on rotates underneath the running
	 * workload. For those add-ons "leave it blank" cannot mean "let the chart decide"; it has to
	 * mean "Alethia decides once", so the rendered manifest stops moving.
	 *
	 * Called with the set of secret keys that ALREADY have a stored value, and returns plaintext
	 * for the keys it wants to fill — the caller encrypts them and never persists them otherwise.
	 * Returning a key that is already present is ignored, so an existing credential is never
	 * rotated by a reconfigure.
	 *
	 * It receives the present set (rather than being called per field) because generated
	 * credentials are often CORRELATED: a keypair whose halves must both be minted together, or a
	 * password and the hash derived from it. Only the definition knows which of its keys travel as
	 * a group.
	 */
	generateSecrets?: (present: ReadonlySet<string>) => Record<string, string>;
	/**
	 * The one-shot in-cluster bootstrap this add-on needs after its Application is applied, or
	 * `null` when the user's knobs say it needs none.
	 *
	 * A function of the parsed config rather than a constant, because whether a bootstrap is
	 * WANTED is a user decision (vault's "initialise automatically" switch) and whether it is
	 * SUPPORTED can depend on another knob (a Raft cluster needs every node unsealed, which is not
	 * what this rail does). Returning null in both cases keeps one answer in one place.
	 */
	bootstrap?: (config: z.infer<Schema>) => AddOnBootstrap | null;
	/** Serializable descriptors for the surfaced knobs (mirror `configSchema`) — drive the
	 * client configure form. Empty for add-ons with no knobs. */
	fields: AddOnField[];
	/** ArgoCD sync-wave ordering (lower installs first). */
	syncWave: number;
	/** Capabilities this add-on expects (surfaced as hints in the UI). */
	requires?: AddOnRequirement[];
	/**
	 * Per-add-on Kubernetes support window, DERIVED from the compat matrix SSOT
	 * (`packages/core/compat/matrix.json` → `addon_k8s[id]`) by the `defineAddOn` helper —
	 * not authored here, so it can never drift from the matrix the compat engine reads.
	 * Empty bounds → `not_evaluable` (honest; never a false pass). Read by the config-time
	 * compat resolver (#1218) and the compat UI (cluster inspector / add-on config sheet
	 * #1221, canvas node chip / palette badge #1222). Real windows land via #1216.
	 */
	k8sRange: K8sRange;
}

/** A reference into the per-add-on k8s Secret the runner seeds (W4.5): `name` is the
 * Secret's metadata.name, `key` the data key holding one secret field's value. */
export interface AddOnSecretKeyRef {
	name: string;
	key: string;
}

/**
 * The per-add-on Secret the runner must seed before the Application syncs (W4.5). Carries
 * NO values — only the deterministic name/namespace and which data keys the chart expects.
 * The values themselves never enter the config snapshot: the runner fetches them at
 * execution time over the authenticated job channel (like the git token) and applies the
 * Secret in-cluster, so no plaintext lands in the DB, the manifest, or the gitops repo.
 */
export interface AddOnSecretRef {
	/** metadata.name of the Secret (deterministic: `alethia-addon-<id>`). */
	secretName: string;
	/** Namespace the Secret lives in — the add-on's install namespace. */
	namespace: string;
	/** Data keys the runner must populate (= the secret-typed field keys with stored values).
	 * May be EMPTY: an add-on whose chart needs only non-secret data out of a Secret still gets one
	 * seeded (#3589), and the runner tolerates the shape (`EnsureAddOnSecrets`). */
	keys: string[];
	/**
	 * NON-secret constants that must live in the SAME Secret because the chart reads them from it —
	 * a paired key beside a credential (grafana's `userKey`, minio's `rootUser`), or a whole config
	 * FILE the chart mounts (external-dns's `azure.json`). Derived from the def's
	 * `secretStaticData` and `requiredSecretData` hooks, merged; snapshot-safe by declaration — a
	 * def must never route a credential through either. A colliding fetched value wins runner-side.
	 */
	staticData?: Record<string, string>;
}

/**
 * A fully-resolved install spec — the runner-facing shape written into the DEPLOY job's
 * config snapshot (mirrors the Go `types.AddOnInstall`). The runner renders one ArgoCD
 * Application per spec; it needs no catalog of its own.
 */
export interface AddOnInstallSpec {
	id: string;
	mode: AddOnMode;
	chartRepo: string;
	chart: string;
	version: string;
	/** How the add-on is delivered. Omitted / "helm" = a Helm-registry chart (chartRepo+chart);
	 * "git" = a bring-your-own chart directory inside a git repo (chartRepo=git URL, path=chart
	 * dir, version=git ref); "manifest" = a plain YAML manifest the RUNNER kubectl-applies
	 * (chartRepo = the PINNED manifest URL, version = the release tag) — the operator rail, for
	 * operators that ship as `kubectl apply` release manifests rather than charts (an ArgoCD
	 * Application source cannot be a bare https://…yaml). Manifest add-ons get NO ArgoCD
	 * Application and install BEFORE the chart Applications. Mirrors the Go `AddOnInstall.Source`. */
	source?: "helm" | "git" | "manifest";
	/** Chart directory within a git-source repo (source==="git"). Omitted for Helm charts. */
	path?: string;
	/** CRD names a manifest-source add-on establishes (e.g. "rabbitmqclusters.rabbitmq.com"). The
	 * runner waits for each to reach condition=Established after applying, so a CR can't be synced
	 * before the operator that owns its schema exists. Omitted for helm/git sources. */
	crds?: string[];
	/** Marks an add-on whose admission webhook takes its serving certificate from cert-manager (the
	 * chart annotates it `cert-manager.io/inject-ca-from`). The runner then installs the cert-manager
	 * CONTROLLER even on a deploy that issues no public certificate, because a `failurePolicy: Fail`
	 * webhook with no CA does not degrade the add-on — it rejects every CR the operator owns.
	 *
	 * Declared on the SPEC rather than inferred from the id in Go, so exactly one place knows which
	 * operators need it: the mapper that adds the operator. `InfraFacts.WebhookCAAddOns` reads it
	 * back. Mirrors the Go `AddOnInstall.RequiresCertManager` (#3228). */
	requiresCertManager?: boolean;
	/** ArgoCD AppProject the Application is placed in. Omitted = "infra" (marketplace default);
	 * BYO charts are pinned to their hardened "byo-<slug>" project by the runner. */
	project?: string;
	namespace: string;
	/** Fully-merged Helm values (defaults + user knobs, or a raw override in gitops mode).
	 * NEVER contains a secret-typed knob's value (W4.5) — only SecretKeyRef wiring. */
	values: Record<string, unknown>;
	syncWave: number;
	/** The Pod Security Standards level this add-on's namespace must allow (#2837). The renderer
	 * turns it into `syncPolicy.managedNamespaceMetadata.labels`, so ArgoCD labels the namespace it
	 * creates. Absent = leave the namespace unlabelled and let the cluster's default stand.
	 * Mirrors the Go `AddOnInstall.PodSecurity`. */
	podSecurity?: AddOnPodSecurityLevel;
	/** The k8s Secret the runner seeds pre-sync for this add-on's secret knobs (W4.5).
	 * Absent when the add-on has no secret-typed field with a stored value. */
	secretRef?: AddOnSecretRef;
	/** A BYO chart's described workloads' binding overlay (W5 Lane 2b): the runner resolves each
	 * workload's W3 bindings against the provision's tofu outputs at deploy and writes them into
	 * `values` at the declared value-paths (a keyless existingSecret ref for a credential facet,
	 * a literal for endpoint/port). Absent for non-BYO add-ons. Mirrors the Go `AddOnInstall.Workloads`. */
	workloads?: ChartWorkloadBindingSpec[];
	/** A one-shot in-cluster bootstrap the runner runs after this add-on's Application is applied.
	 * Absent for every add-on that needs none. Mirrors the Go `AddOnInstall.Bootstrap`. */
	bootstrap?: AddOnBootstrap;
}

/**
 * The one-shot bootstraps the runner knows how to perform for an add-on, as a closed set.
 *
 * A closed set and not a free string, because the runner DISPATCHES on it: an unknown kind is
 * refused rather than skipped, so a typo in a catalog entry fails loudly instead of shipping a
 * marketplace add-on whose promised bootstrap silently never runs.
 */
export const ADDON_BOOTSTRAP_KINDS = ["vault-init"] as const;

/** One bootstrap kind. */
export type AddOnBootstrapKind = (typeof ADDON_BOOTSTRAP_KINDS)[number];

/**
 * A one-shot bootstrap the runner runs INSIDE the cluster after the add-on's Application is
 * applied.
 *
 * WHY THE RUNNER AND NOT A CHART HOOK. Some charts install a component that is not usable until
 * someone performs a one-time operation against its API — a freshly installed HashiCorp Vault is
 * SEALED, and neither the chart nor ArgoCD can open it. The API answers only on the cluster
 * network, so the runner (which holds a kubeconfig and no route to a ClusterIP) cannot do it
 * directly either. It applies a Job instead, and the Job does it from inside.
 *
 * WHAT MAY TRAVEL HERE. Names, namespaces and addresses only. This struct rides the DEPLOY job's
 * config snapshot, which is persisted in Postgres — so it carries nothing a credential could be
 * derived from, exactly like `AddOnSecretRef`. Any key material the bootstrap needs is MINTED
 * INSIDE the pod and written straight to a Secret in the cluster; it never enters the runner
 * process, the job log, or this object.
 */
export interface AddOnBootstrap {
	kind: AddOnBootstrapKind;
	/** The in-cluster API base the Job talks to (scheme + host + port, no path). */
	apiBase: string;
	/** The Secret the Job writes its state into, in the add-on's own namespace. */
	stateSecret: string;
}

/** One described BYO-chart workload's runtime-resolvable binding overlay (its W3 bindings + the
 * value_paths they write to). Mirrors the Go `types.ChartWorkloadBinding`. */
export interface ChartWorkloadBindingSpec {
	name: string;
	bindings: ServiceBinding[];
	valuePaths: ChartValuePathMap;
}
