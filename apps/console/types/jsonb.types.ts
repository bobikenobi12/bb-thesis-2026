// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Typed JSONB shapes for the Drizzle schema's `.$type<>()` columns (lib/db/schema).
//
// A `Mirrors the Go X` comment below is a LOCK, not a note.
// `packages/core/jsonbmirror/jsonb_mirror_test.go` holds one committed fixture per mirrored
// interface and requires three sets to be equal: the interface's properties, the fixture's keys,
// and the Go struct's json tags. Adding, removing or renaming a property on either side alone
// turns that test red. The fixtures are hand-written — fix a failure by bringing the three into
// agreement, not by regenerating.
//
// Exactly three things in this file that name a Go type are NOT locked, and the test file lists
// the same three:
//   - the VALUES of `ArgocdHealthStatus` / `ArgocdSyncStatus` — ArgoCD's vocabulary is bare
//     string literals on the Go side, with no constant set to compare against;
//   - the VALUES of `GitopsStatusReport.mode` — `argocd.GitopsStatus.Mode` is a bare `string`;
//   - `HelmRegistryProviderConfig`, whose claim is about what the Go providers READ, not about a
//     struct's tags.
// Their FIELDS are still locked where an interface carries them. Every other string union here is
// checked against the Go constant block that defines it.

import type {
	AlertSeverity,
	CloudProvider,
	ProjectStatus,
	ServiceBindingFacet,
	ServiceBindingKind,
	TopicSubscriptionProtocol,
} from "@/lib/db/schema/enums";
// The compat report contract lives in its own file (types/compat.types) to keep the
// `wave:compat` scope disjoint; re-referenced here only for the ExecutionMetadata field.
import type { CompatReport } from "@/types/compat.types";

export type { ServiceBindingKind, ServiceBindingFacet };

// ── Typed JSONB interfaces ─────────────────────────────────────────

/**
 * The `credential_source` block of a GCP Workload Identity Federation
 * `external_account` credential — the union of the file/url/aws/executable
 * source shapes Google's client library accepts. All fields optional: the
 * concrete subset present depends on the federation type.
 */
export interface WifCredentialSource {
	file?: string;
	url?: string;
	headers?: Record<string, string>;
	environment_id?: string;
	region_url?: string;
	regional_cred_verification_url?: string;
	executable?: { command: string; timeout_millis?: number; output_file?: string };
	format?: { type?: string; subject_token_field_name?: string };
}

/**
 * A GCP Workload Identity Federation credential config (the pasted
 * `external_account` JSON). Fields are optional because the value is parsed
 * from untrusted input and validated field-by-field in `parseWifConfig`.
 */
export interface WifCredentialConfig {
	type?: string;
	audience?: string;
	subject_token_type?: string;
	token_url?: string;
	token_info_url?: string;
	service_account_impersonation_url?: string;
	service_account_impersonation?: { token_lifetime_seconds?: number };
	credential_source?: WifCredentialSource;
	universe_domain?: string;
}

export interface CloudCredentials {
	// AWS
	role_arn?: string | null;
	external_id?: string | null;
	account_id?: string | null;
	// GCP (WIF)
	project_id?: string | null;
	project_number?: string | null;
	service_account_email?: string | null;
	wif_config?: WifCredentialConfig | null;
	// Azure (Federated Identity)
	tenant_id?: string | null;
	client_id?: string | null;
	subscription_id?: string | null;
	// Alibaba (RAM role via AssumeRoleWithOIDC) — keyless + account-free: the role_arn above plus the
	// customer's RAM OIDC provider ARN. Zero stored credentials (the assertion is minted per-call).
	oidc_provider_arn?: string | null;
	// DigitalOcean / Hetzner / Civo — no role-federation exists for these clouds, so a
	// scoped API token is stored ENCRYPTED at rest (decrypted only on the runner at claim).
	token?: EncryptedSecret | null;
	// Hetzner Object Storage (S3-compatible) — an access-key/secret-key pair, DISTINCT from the
	// Cloud API `token` above. Hetzner has NO API to mint these, so the customer generates them
	// by hand in the Hetzner Console (Object Storage → S3 credentials) and pastes them into the
	// connector. Stored ENCRYPTED at rest (AES-GCM) exactly like `token`, decrypted only on the
	// runner at claim to provision buckets via the aminueza/minio provider against the Hetzner S3
	// endpoint. Optional (both-or-neither): token-only Hetzner connections that use no buckets
	// leave them null, so those connections keep working unchanged.
	s3_access_key?: EncryptedSecret | null;
	s3_secret_key?: EncryptedSecret | null;
	// Self-managed mode (token clouds only): no token is stored in Alethia at all — the
	// customer's self-hosted runner supplies it from its own environment (HCLOUD_TOKEN,
	// CIVO_TOKEN, DIGITALOCEAN_ACCESS_TOKEN). The honest zero-trust path for clouds with
	// no federation: the secret never enters Alethia's database.
	self_managed?: boolean | null;
}

export interface VpcInfo {
	ID: string;
	CIDR: string;
	Name: string;
	IsDefault: boolean;
}

/**
 * A service detected inside a source repo by the scanner (monorepo-aware). One repo
 * may yield several — e.g. `apps/api` + `apps/web` in a workspace. Stored on
 * `project_source_repos.services` and consumed by per-service inference.
 */
export interface DetectedService {
	/** Path within the repo, relative; "" = repo root. */
	path: string;
	/** Service name, derived from the directory or manifest. */
	name: string;
	/** Whether a Dockerfile exists at this service's path. */
	hasDockerfile: boolean;
	/** Inferred runtime (node/python/go/…), when detected. */
	runtime?: string;
	/** Container port, when detected from the Dockerfile/manifest. */
	port?: number;
	/** Normalized backing-service signals found in THIS service's own files (per-service
	 * attribution of the repo-wide signals) — mapped to SUGGESTED ServiceBindings (W3,
	 * lib/scanner/suggest-bindings.ts) for the user to accept/edit. */
	needs?: string[];
	/** Env-variable KEY names declared in THIS service's own .env.example-family files (values
	 * dropped). The scan authors them as empty-valued `services[].env` entries (Path-B W6
	 * "skeleton → real": the env surface arrives pre-populated for the user to fill). */
	env?: string[];
}

// ── Service / workload (W1) ─────────────────────────────────────────
// The typed JSONB shapes for a `project_services` row — a first-class canvas workload.
// Infra-binding edges (service→db/cache/secret) are W3; secret env-from is W4.

/** Where a service's container image comes from. */
export type ServiceSource =
	| { kind: "repo"; repo_url: string; path: string }
	| { kind: "image"; image: string };

/** Build config when `source.kind === "repo"` (the Dockerfile drives the W2 build/push). */
export interface ServiceBuild {
	dockerfile?: string;
	context?: string;
}

/** A plain environment variable on a service (secret env-from is W4). */
export interface ServiceEnvVar {
	name: string;
	value: string;
}

/** A container port a service exposes. */
export interface ServicePort {
	name?: string;
	container_port: number;
	protocol?: "TCP" | "UDP";
}

/** Compute requests/limits — Kubernetes quantity strings (e.g. "100m" / "128Mi"). */
export interface ServiceResources {
	requests: { cpu: string; memory: string };
	limits: { cpu: string; memory: string };
}

/** Readiness/liveness probe. */
export interface ServiceProbe {
	type: "http" | "tcp";
	path?: string;
	port: number;
}

// ── Service → backing-infra binding (W3) ────────────────────────────
// A service declares it NEEDS a backing resource and how that resource's connection info is
// injected into the workload's container env. Resolution is DEPLOY-TIME, not snapshot-time: a
// database's endpoint is a provisioned output unknown when the config is authored, so a binding
// models the INTENT and the runner resolves it against the provisioned resource.

/** The kind of backing resource a service can bind to (referenced together with its name — the
 * config join key every component shares). */
// ServiceBindingKind (database|cache|queue|secret) and ServiceBindingFacet
// (endpoint/port non-secret templated; username/password/connection_string keyless via ESO) are
// the `service_binding_kind` / `service_binding_facet` pgEnums (imported + re-exported above).

/** One env var on the workload ← one facet of the bound resource. */
export interface ServiceBindingInjection {
	env: string;
	from: ServiceBindingFacet;
}

/** The customer module's tofu OUTPUT names a BYO-IaC binding resolves its facets against
 * (chosen at bind time from IacScanReport.outputs). Only present on a BYO-IaC target. An
 * absent key makes that facet unsatisfiable (fail-closed) — never guessed. Wire keys mirror
 * the Go `ServiceBindingOutputKeys` json tags. */
export interface ServiceBindingOutputKeys {
	/** Output holding the connection endpoint/host. */
	endpoint?: string;
	/** Output holding the port; empty → the kind's conventional default. */
	port?: string;
	/** Output holding the master-credentials secret name/ARN (the ExternalSecret RemoteKey);
	 * empty → no keyless credential path, credential facets are unsatisfiable. */
	credential_secret?: string;
}

/** A service's edge to a backing resource plus the env it injects. `target` references the
 * resource by {kind, name}; the runner resolves the connection info at deploy time. A BYO-IaC
 * target additionally carries `address` (its Terraform address) + `output_keys` mapping each
 * facet to the customer module's real output, because a customer module's outputs follow the
 * customer's naming, which no platform key map can know (#687). */
export interface ServiceBinding {
	target: {
		kind: ServiceBindingKind;
		name: string;
		/** Terraform address of a BYO-IaC target; absent for a first-class component. */
		address?: string;
		/** Facet→output-name map for a BYO-IaC target; absent for a first-class component. */
		output_keys?: ServiceBindingOutputKeys;
	};
	inject: ServiceBindingInjection[];
}

// ── BYO chart described workload (W5 Path A — Option B) ─────────────
// A workload extracted from a bring-your-own Helm chart's rendered manifests (`helm template`) and
// surfaced as a read-mostly canvas node. The chart addon (project_addons source='byo') stays the
// single DEPLOY UNIT — its ArgoCD Application deploys everything; these rows only DESCRIBE what it
// runs and carry the user's binding/config overlay. Stored on `project_chart_workloads`. They are
// deliberately NOT `project_services` rows, so a described workload can never enter the deploy path
// (no double-deploy). See management/spec/features/w5-path-a-byo-services.md.

/**
 * The immutable description of a chart workload extracted from `helm template` output — image,
 * ports, env keys, resources, rendered replicas. Refreshed VERBATIM on every CHART_SCAN (it mirrors
 * the chart, not the user), so it never carries user edits. Env is reduced to KEY NAMES only
 * (values/valueFrom refs dropped, like the repo scanner) so a description never persists a rendered
 * secret value.
 */
export interface ChartWorkloadRendered {
	/** The workload's primary container image (first container). */
	image: string;
	/** Container ports declared across the workload's containers. */
	ports: ServicePort[];
	/** Env-variable KEY names on the containers (values + valueFrom dropped — names only). */
	env_keys: string[];
	/** Compute requests/limits from the first container that declares them; omitted otherwise. */
	resources?: ServiceResources;
	/** Replica count as rendered (Deployment/StatefulSet); omitted for DaemonSet/Job/CronJob. */
	replicas?: number;
}

/**
 * The user's editable overlay on a described chart workload (v1: replicas + env). Written back into
 * the owning chart's Helm `values` at the declared value-paths on deploy (Lane 2) — Alethia never
 * re-renders the workload itself. Preserved across re-scans.
 */
export interface ChartWorkloadConfig {
	replicas?: number;
	env?: ServiceEnvVar[];
}

/**
 * Where each logical binding/config knob writes into the owning chart's Helm `values`: a map from a
 * logical knob key (e.g. "replicas", or a binding target `"database:orders-db"`) to the dot-path
 * within the chart values (e.g. "postgresql.auth.existingSecret"). Auto-inferred at scan +
 * user-overridable (Lane 2). Preserved across re-scans.
 */
export type ChartValuePathMap = Record<string, string>;

// ── Support cases ───────────────────────────────────────────────────
// SupportContactPrefs / SupportCaseContext / SupportAbuseDetails moved to @repo/support
// (shared with the admin app); re-exported so `@/types/jsonb.types` still surfaces them.
export * from "@repo/support/types";

/**
 * One resource that has drifted from its provisioned state — mirrors the Go
 * `drift.ResourceDrift` (packages/core/drift). Stored on `environment_drift.details`;
 * produced by a DETECT_DRIFT job's `tofu plan -refresh-only` → `drift.Analyze`.
 */
/** How a resource diverged from state (mirrors the Go `drift.Kind`). */
export type DriftResourceKind = "modified" | "deleted" | "other";

// Mirrors the Go `drift.ResourceDrift` (packages/core/drift). This is the shape on the live
// path: `environment_drift.details` and `fabric_drift.details` are typed with it, and the canvas,
// evidence and drift readers all go through it.
export interface DriftDetail {
	/** Terraform address of the drifted resource. */
	address: string;
	/** Resource type (e.g. aws_db_instance). */
	type: string;
	/** "modified" | "deleted" | "other" — how it diverged. */
	kind: DriftResourceKind;
	/**
	 * The attribute PATHS that differed — never VALUES, same rule as
	 * DriftNormalizedResource.attributes and for the same reason.
	 *
	 * Optional because it is genuinely absent for verdicts reached before the leaf diff
	 * runs (a non-update action, or a change whose sides do not parse as objects). Empty
	 * therefore means "not computed", never "nothing differed".
	 *
	 * This field was missing here while a second, near-identical `DriftResource` interface
	 * carried it — the duplicate is gone and this one is locked, so they cannot diverge again.
	 */
	attributes?: string[];
}

/**
 * Honest structured result of a cluster-alive probe (BYOC B2) — mirrors the Go
 * `provisioner.ProbeDetail` (packages/core/provisioner, built in B2.2). Stored on
 * `environment_probes.detail`; produced by a PROBE_CLUSTER job that dials the env's
 * cluster API server. Every field is optional because a probe records only what it
 * could observe: an unreachable cluster fills `error` and little else; a reachable one
 * fills the health fields. NEVER holds a secret (no kubeconfig / token / cert material).
 */
export interface ProbeDetail {
	/** Cluster API-server endpoint the probe dialed (host:port or URL), when known. */
	endpoint?: string;
	/** How liveness was checked, e.g. "apiserver-readyz" | "apiserver-version". */
	method?: string;
	/** HTTP status the API-server health endpoint returned, when it answered. */
	statusCode?: number;
	/** Kubernetes server version reported by a reachable API server. */
	serverVersion?: string;
	/** Nodes the probe saw, and how many were Ready — omitted when it didn't list nodes. */
	nodeCount?: number;
	readyNodeCount?: number;
	/** Round-trip latency of the liveness check, in milliseconds. */
	latencyMs?: number;
	/** Failure reason when unreachable (dial error / TLS / timeout) — a message, never a secret. */
	error?: string;
}

/**
 * The honest outcome of a cluster-alive probe (BYOC B2) — mirrors the Go
 * `provisioner.ProbeResult` (packages/core/provisioner, built in B2.2). Posted by a
 * PROBE_CLUSTER job on `execution_metadata.probe_result` and ingested by the job-status
 * route into an `environment_probes` history row. An UNREACHABLE cluster is a SUCCESSFUL
 * probe with `reachable=false` (the honest "it's down" signal) — never a job failure —
 * and carries NO secret (no kubeconfig / token / cert material).
 */
export interface ProbeResult {
	/** True when the cluster API server answered the liveness probe. */
	reachable: boolean;
	/** Short human-readable summary for the console badge (esp. WHY unreachable). Never a secret. */
	message?: string;
	/** Structured, non-secret probe detail (mirrors environment_probes.detail). */
	detail?: ProbeDetail;
}

export interface SubnetInfo {
	ID: string;
	CIDR: string;
	VpcID: string;
	AvailabilityZone: string;
}

export interface HostedZoneInfo {
	ID: string;
	Name: string;
	RecordCount: number;
	IsPrivate: boolean;
}

export interface IAMUserInfo {
	username: string;
	arn: string;
	path: string;
}

export interface CachedResources {
	regions: string[];
	vpcs: Record<string, VpcInfo[]>;
	subnets: Record<string, Record<string, SubnetInfo[]>>;
	hosted_zones: HostedZoneInfo[];
	iam_users?: IAMUserInfo[];
}

export interface GcpNetworkInfo {
	name: string;
	selfLink: string;
	autoCreateSubnetworks: boolean;
}

export interface GcpSubnetInfo {
	name: string;
	region: string;
	ipCidrRange: string;
	network: string;
}

export interface GcpManagedZoneInfo {
	name: string;
	dnsName: string;
	visibility: string;
}

export interface GcpCachedResources {
	regions: string[];
	networks: GcpNetworkInfo[];
	subnets: Record<string, GcpSubnetInfo[]>;
	managed_zones: GcpManagedZoneInfo[];
}

export interface AzureVnetInfo {
	name: string;
	id: string;
	location: string;
	addressPrefixes: string[];
}

export interface AzureSubnetInfo {
	name: string;
	id: string;
	addressPrefix: string;
	vnetName: string;
}

export interface AzureDnsZoneInfo {
	name: string;
	id: string;
	zoneType: string;
}

export interface AzureCachedResources {
	locations: string[];
	vnets: AzureVnetInfo[];
	subnets: Record<string, AzureSubnetInfo[]>;
	dns_zones: AzureDnsZoneInfo[];
}

export interface ClusterAdmin {
	username: string;
	groups: string[];
}

export interface ClusterProviderConfig {
	enable_karpenter?: boolean;
	enable_autopilot?: boolean;
	enable_cluster_autoscaler?: boolean;
}

export interface DnsProviderConfig {
	acm_certificate?: boolean;
	managed_certificate?: boolean;
	cloudfront_waf?: boolean;
	application_waf?: boolean;
	cloud_armor?: boolean;
	azure_waf?: boolean;
	// Cloudflare (pluggable DNS provider)
	zone_id?: string;
	proxied?: boolean;
}

export interface NosqlProviderConfig {
	partition_key_path?: string;
}

export interface RegistryProviderConfig {
	// `immutable_tags` and `vulnerability_scanning` used to live here. They are shown on all four
	// managed clouds, so they were cross-cloud switches misfiled as provider knobs — they are now
	// typed columns on project_container_registries (#1811). Nothing reads them from here; the
	// validator's `.strip()` discards any that survive in an old row.
	// Docker Hub
	namespace?: string;
	// The registry host for the providers that serve any host (generic-cr, ghcr-enterprise, harbor,
	// scaleway-cr require it; gitlab-cr and quay accept it). LOAD-BEARING, not cosmetic:
	// categories/registry_generic.go fails validation without it, and pullAuth uses it as the
	// dockerconfig `auths` key — so a pull secret built without it authenticates against nothing.
	registry_url?: string;
	// Cross-account keyless registries (*-xacct) — identity/resource REFERENCES, never keys.
	target_account_id?: string; // ecr-xacct
	target_project_id?: string; // gar-xacct
	target_subscription_id?: string; // acr-xacct
	region?: string;
	registry_host?: string;
	target_role_arn?: string; // ecr-xacct
	target_service_account?: string; // gar-xacct
	target_identity_client_id?: string; // acr-xacct
}

// Helm chart-repo connector (helm_registry category) — non-secret knobs only; the
// username/password/token credential lives in connector_credentials, never here. The
// keys mirror what the Go providers read from ProviderConfig (packages/core/categories/
// helm_registry_*.go): `repo_url` for the HTTPS repo (helm-https), `registry_host` for
// the OCI registries (generic/gitlab/scaleway CR). Fixed-host OCI providers
// (github_cr → oci://ghcr.io, docker_hub → oci://registry-1.docker.io) need neither.
export interface HelmRegistryProviderConfig {
	// HTTPS chart repository URL, e.g. "https://charts.example.com" (helm-https).
	repo_url?: string;
	// OCI registry host, e.g. "registry.example.com" (generic/gitlab/scaleway CR).
	registry_host?: string;
}

// Vault (pluggable secrets provider) — non-secret knobs only; the address/token
// credential lives in connector_credentials, never here.
//
// Also carries the cross-account keyless cloud-secret-manager (*-xacct) target: AWS Secrets Manager /
// GCP Secret Manager / Azure Key Vault / Alibaba KMS in a DIFFERENT account than the cluster. These are
// KEYLESS — no credential; the target account/project/subscription and the customer-created trust
// anchor (an identity/resource REFERENCE, never a key) live here and are read by
// categories.KeylessSecretTarget on the runner. Exactly one provider's field set applies per store.
export interface SecretsProviderConfig {
	// Vault / generic (credential-based)
	mount_path?: string;
	kv_version?: string;
	// Doppler — which project + config (its name for an environment) the token reads.
	project?: string;
	config?: string;
	// Infisical. It addresses one project by TWO identifiers and both are needed: workspace_id (the id)
	// is what the tofu write path provisions against, project_slug (the slug, copied from the project
	// settings) is what ESO's secretsScope reads in-cluster. They are not interchangeable.
	host?: string;
	workspace_id?: string;
	project_slug?: string;
	env_slug?: string;
	folder_path?: string;
	// 1Password — the vault the service account may read.
	vault?: string;
	// Cross-account keyless cloud secret managers (*-xacct)
	target_account_id?: string; // aws-sm-xacct / alibaba-kms-xacct (target RAM account)
	target_project_id?: string; // gcp-sm-xacct
	target_subscription_id?: string; // azure-kv-xacct
	region?: string; // aws / alibaba (required), gcp (optional regional secrets)
	target_role_arn?: string; // aws / alibaba — the role the ESO identity assumes
	vault_url?: string; // azure — the target Key Vault URL
	target_oidc_provider_arn?: string; // alibaba — the target-account RAM OIDC provider ARN
	// aws ONLY, optional: the sts:ExternalId the target role's trust policy requires, when the customer's
	// bootstrap set one. Omitted = the trust policy has no ExternalId condition (the default). The other
	// lanes have no equivalent — they bind the grant to a concrete principal instead. See
	// categories.KeylessSecretTarget for why this is an explicit per-cloud exclusion, not an oversight.
	external_id?: string;
}

// Datadog / Grafana Cloud — non-secret knobs only.
export interface ObservabilityProviderConfig {
	// Datadog
	site?: string;
	// Grafana Cloud remote-write
	remote_write_url?: string;
}

// project_addons.values — the user's tuned knobs for a marketplace add-on. Validated + typed
// per add-on by its Zod `configSchema` (lib/addons/catalog.ts); stored open here since the
// shape varies by add-on. In gitops mode this may instead hold a raw Helm-values override.
// W4: a `secret`-typed AddOnField's value is stored here as an `EncryptedSecret` envelope (below,
// encrypted-at-rest via lib/crypto/secrets.ts), NOT as plaintext — server code discriminates by
// shape and decrypts only when assembling the deploy snapshot.
export type AddOnValues = Record<string, unknown>;

// project_iac_sources.var_values — the customer's NON-SECRET tfvars for a bring-your-own IaC
// root module (scalar values only; secrets belong in the cloud's secret store / the module's
// own data sources, never here). Written verbatim into the job's tfvars at provision time.
export type IacVarValues = Record<string, string | number | boolean>;

// One issue raised by an IAC_SCAN over a BYO IaC module (static checks + `tofu validate`).
export interface IacScanFinding {
	severity: string;
	rule: string;
	file: string;
	line?: number;
	detail: string;
}

// One resource DECLARED by a BYO IaC module, as inventoried by the static IAC_SCAN walk
// (packages/core/iacsafety). This is the pre-plan skeleton the canvas draws so a BYO-IaC
// environment reads as an architecture before it has ever been planned.
//
// Declared, NOT expanded: the static gate never evaluates HCL, so a `count = 3` block
// appears once here where a plan reports three. A real plan's `resource_changes` therefore
// SUPERSEDES this wholesale — see lib/canvas/iac-inventory.ts.
export interface IacScanResource {
	/** The Terraform address — the key cost, drift and verify findings all join on. */
	address: string;
	/** Resource type, e.g. "aws_s3_bucket". */
	type: string;
	/** Local name, e.g. "assets". */
	name: string;
	/** Module path prefix — absent/"" for the root module, else "module.vpc". */
	module?: string;
}

// project_iac_sources.scan_report / execution_metadata.iac_scan_result — the result of an
// IAC_SCAN job: the runner clones the repo, pins the commit it checked out, inventories the
// module (providers + module sources + resources) and validates it. `ok=false` blocks
// provisioning. Keep in lockstep with the Go `types.IacScanReport`.
export interface IacScanReport {
	ok: boolean;
	/** Whether `tofu validate` ran clean on the root module. */
	validated: boolean;
	findings: IacScanFinding[];
	/** Provider sources the module requires (e.g. "registry.opentofu.org/hashicorp/aws"). */
	providers: string[];
	/** Module sources referenced by the root module (registry / git / local paths). */
	modules: string[];
	/**
	 * The module's declared resources. OPTIONAL on purpose: rows scanned by a runner older
	 * than W8 have no inventory, and the canvas must degrade to the PLAN-derived one rather
	 * than fabricate an empty architecture. Absent ≠ "the module has no resources".
	 */
	resources?: IacScanResource[];
	/**
	 * The ROOT module's declared `output` block names. When a service binds to a BYO-IaC
	 * resource, these are the choices the bind sheet offers for the endpoint / credential-secret
	 * output the binding maps to (#687) — they are exactly the keys of the deploy-time tofu
	 * outputs a W3 binding resolves against. OPTIONAL for the same reason as `resources`: a row
	 * scanned by a runner older than the output-capture change has none, and the picker must
	 * degrade (no candidates) rather than treat absence as "the module exports nothing".
	 */
	outputs?: string[];
	/** The commit the scan actually checked out — finalizeIacScan pins it onto the row's
	 *  commit_sha so deploys apply exactly what was scanned (TOCTOU protection). */
	commit_sha?: string;
}

// AES-256-GCM envelope for the secret fields of a connector credential
// (lib/crypto/secrets.ts). The plaintext is a JSON map of {fieldKey: value}.
export interface EncryptedSecret {
	v: number;
	// Key id (keyring) that sealed this envelope — lets a leaked key be rotated online without
	// downtime (decryption selects the matching key). ABSENT on legacy ciphertext written before
	// rotation existed; those decrypt under the active ALETHIA_CRED_ENCRYPTION_KEY. New writes
	// always stamp the active kid. See lib/crypto/secrets.ts.
	kid?: string;
	iv: string;
	tag: string;
	data: string;
}

// connector_credentials.credentials — non-secret fields (e.g. Vault address,
// Docker Hub username) stored plaintext; secret fields encrypted into `secret`.
export interface ConnectorCredentials {
	fields?: Record<string, string>;
	secret?: EncryptedSecret | null;
}

export interface StorageProviderConfig {
	// AES256 / aws:kms (S3), google-managed / CMEK (GCS), etc.
	encryption_algorithm?: string;
	kms_key?: string;
}

export interface QueueProviderConfig {
	// SQS-only delivery delay (Azure Service Bus / Pub/Sub have no direct equivalent).
	delay_seconds?: number;
}

// The CloudWatch log types a managed database can export. Finite and known, so a union
// rather than string[]: Aurora MySQL accepts audit/error/general/slowquery and Aurora
// PostgreSQL accepts only postgresql — a set that does not match the engine is rejected
// fail-closed at apply by RDS-ENGINE-003 (infra/templates/project/aws/checks_data.tf).
export type DatabaseLogExport =
	| "audit"
	| "error"
	| "general"
	| "slowquery"
	| "postgresql";

export interface DatabaseProviderConfig {
	// AWS only — `rds_logs_exports` is the sole DB log-export variable any template
	// declares (gcp/azure/alibaba have none). Unset → {audit, error, slowquery} on MySQL,
	// {postgresql} on Postgres.
	//
	// `general` is deliberately NOT a default: the MySQL general log records every
	// statement with its literal parameter values, so switching it on ships whatever the
	// application put in a WHERE clause to the customer's CloudWatch. `audit` covers the
	// security-forensics case without the statement text.
	log_exports?: DatabaseLogExport[];
}

// Provider-specific resource identifiers captured after a deploy (cloud-agnostic
// keys). Replaces the AWS-shaped typed columns (cluster_arn, *_secret_arn, kms…)
// — AWS fills arn/secret_ref/kms_key; GCP/Azure fill the keys their model uses.
export interface ProviderOutputs {
	arn?: string;
	identifier?: string;
	secret_ref?: string;
	extra_secret_ref?: string;
	kms_key?: string;
}

export interface TopicSubscription {
	protocol: TopicSubscriptionProtocol;
	endpoint: string;
}

export interface AuditChanges {
	[key: string]: unknown;
}

export interface RunnerDeployConfig {
	region: string;
	cloud_provider: CloudProvider;
	image_tag: string;
	alethia_url: string;
	cpu: number;
	memory: number;
	image_repository: string;
	// NOTE: the runner_token is deliberately NOT persisted here — it is a live bearer credential and
	// this JSONB is plaintext at rest. The console keeps only its SHA-256 hash and re-mints a fresh
	// token for each UPDATE/DESTROY job (#945).
}

export interface RunnerMetadata {
	deploy_config?: RunnerDeployConfig | null;
	/**
	 * Cloud instance id of the VM hosting this managed runner (e.g. a Hetzner server
	 * id). Set at bootstrap; lets the fleet scaler correlate a DB runner ↔ its server
	 * for graceful scale-down. Null for non-fleet (bundled/self) runners.
	 */
	cloud_instance_id?: string | null;
}

// fleet_actions.metadata — forensic context the fleet controller attaches to a ledger row
// (all optional; the load-bearing columns are provider/action/reason/queue_depth/pool_size).
export interface FleetActionMetadata {
	/** Location the create targeted / the affected instance lives in. */
	location?: string;
	/** Cloud instance id (drain/destroy) the action pertained to. */
	instance_id?: string;
	/** Image/version a create was launched at, when known. */
	version?: string | null;
}

// jobs.execution_metadata — written by the runner via update_job_status. Known
// shape (deploy outputs + cached cloud resources from CONNECTION_TEST/FETCH jobs).
export interface ExecutionMetadata {
	cluster_name?: string;
	cluster_endpoint?: string;
	/** The post-apply reachability gate confirmed the API server answered + nodes are Ready
	 *  (a working cluster, not just "tofu apply exited 0"). Set by the runner on a real deploy. */
	cluster_ready?: boolean;
	argocd_url?: string;
	// The ArgoCD admin password is deliberately absent: the runner never persists it (it is
	// retrieved on-demand from the cluster's argocd-initial-admin-secret), so it never appears
	// in execution_metadata. See the runner's buildDeployMetadata + scrubMetadataTree.
	outputs?: Record<string, unknown>;
	cached_resources?:
		| CachedResources
		| GcpCachedResources
		| AzureCachedResources;
	// PLAN jobs: the runner stores the raw OpenTofu plan JSON + Infracost breakdown
	// here (opaque payloads parsed by lib/plan/parse-plan.ts / parse-cost.ts).
	plan_result?: Record<string, unknown>;
	cost_breakdown?: Record<string, unknown>;
	// ANALYZE_REPO jobs: the runner's static repo analysis (packages/core/scanner).
	repo_digest?: RepoDigest;
	// PLAN/DEPLOY jobs: the elench verification gate's result for the plan
	// (packages/core/verify). On DEPLOY a blocking verdict stops apply.
	verify_result?: VerifyReport;
	// PLAN/DEPLOY jobs: the signed evidence receipt sealing the report to the plan
	// hash + tool versions (packages/core/verify Receipt/SignedReceipt).
	verify_receipt?: SignedReceipt;
	// PLAN/DEPLOY jobs: the version-compatibility gate result for the config
	// (packages/core/compat, #1215). On DEPLOY a blocking verdict stops apply
	// under COMPAT-001. Rendered by CompatBlock in the artifact panel (#1219).
	compat_result?: CompatReport;
	// DETECT_DRIFT jobs: the per-environment drift posture (packages/core/drift).
	drift_posture?: DriftPosture;
	// PROBE_CLUSTER jobs: the cluster-alive probe result (BYOC B2). An unreachable cluster is a
	// SUCCESS with reachable=false — the status route ingests it into environment_probes and
	// alerts on a true→false liveness transition.
	probe_result?: ProbeResult;
	// BUILD jobs (W2): per-service pushed-image digest map { service_name → image_digest_uri }
	// (e.g. "<acct>.dkr.ecr.<region>.amazonaws.com/<repo>@sha256:…") for every service with
	// source.kind === "repo". The console persists each entry into project_services.resolved_image.
	// Digests are non-secret (pass the scrub denylist); registry credentials must NEVER appear here.
	build_result?: Record<string, string>;
	// DEPLOY jobs: post-apply ArgoCD health/sync per managed marketplace add-on, keyed by
	// the ArgoCD Application name ("addon-<id>"). Written back to project_addons by the
	// deploy finalizer. Mirrors the Go `argocd.AddOnHealth`.
	addon_status?: Record<string, AddOnStatusEntry>;
	// DEPLOY jobs: the cluster's aggregated Trivy-Operator vulnerability posture (L9), written
	// back to environment_security by the deploy finalizer. Mirrors the Go `argocd.SecurityPosture`.
	security_report?: SecurityReport;
	// IAC_SCAN jobs: the BYO IaC module scan result — finalizeIacScan writes it back onto the
	// project_iac_sources row (scan_report + pinned commit_sha).
	iac_scan_result?: IacScanReport;
	// CANCELLED DEPLOY jobs: set by the runner when a cancel tore down a job that had already
	// started `tofu apply`, so cloud resources may exist outside tofu state (an operator must
	// reconcile). The status route raises a `system.project.orphan_risk` alert on this.
	orphan_risk?: boolean;
	orphan_risk_reason?: string;
	// DEPLOY + DETECT_DRIFT jobs (#574): GitOps wiring outcome + apps-Application health
	// snapshot. On a wiring hard-fail the runner posts a PARTIAL result carrying which step
	// died; absent on pre-#574 jobs. Mirrors the Go `argocd.GitopsStatus`.
	gitops_status?: GitopsStatusReport;
	// CHART_SCAN jobs (W5 Path A — DESCRIBE): the chart's rendered workloads extracted from the
	// helm-template render. An opaque wire payload — validated by lib/validations/chart-workloads.ts
	// before reconcileChartWorkloads persists it into project_chart_workloads.
	chart_workloads?: unknown;
}

/** ArgoCD Application/resource health (packages/core/argocd). ArgoCD's fixed health set. */
export type ArgocdHealthStatus =
	| "Healthy"
	| "Progressing"
	| "Degraded"
	| "Suspended"
	| "Missing"
	| "Unknown";

/** ArgoCD sync state (status.sync.status). ArgoCD's fixed sync set. */
export type ArgocdSyncStatus = "Synced" | "OutOfSync" | "Unknown";

/**
 * The scan lifecycle shared by the chart-describe (CHART_SCAN) and IaC-safety (projectAddons)
 * flows: `unscanned` → `scanning` → `done` | `failed`.
 */
export type ScanStatus = "unscanned" | "scanning" | "done" | "failed";

/** Which GitOps wiring step died (packages/core/argocd `GitopsStatus.FailedStep`). */
export type GitopsFailedStep =
	| "argocd_install"
	| "git_token"
	| "repo_credentials"
	| "templates_missing"
	| "render"
	| "apply";

// One managed add-on's ArgoCD status (packages/core/argocd `AddOnHealth`). Health ∈
// {Healthy, Progressing, Degraded, Suspended, Missing, Unknown}; sync ∈ {Synced, OutOfSync,
// Unknown}.
export interface AddOnStatusEntry {
	health: ArgocdHealthStatus;
	sync: ArgocdSyncStatus;
}

/**
 * GitOps wiring outcome + apps-Application health snapshot for one DEPLOY (or the day-2
 * DETECT_DRIFT refresh). Mirrors the Go `argocd.GitopsStatus` (#574). Fail-loud contract:
 * `failed_step` set ⇒ the deploy died INSIDE the wiring and no health was read — render
 * every component Unknown, never a stale pass.
 */
export interface GitopsStatusReport {
	/** "gitops" when an apps destination repo is wired, "direct" otherwise. */
	mode: "gitops" | "direct";
	/** The customer's apps destination repo URL (gitops mode only). */
	apps_repo?: string;
	/** The ArgoCD Application syncing the apps repo ("apps"). */
	argocd_app?: string;
	/** The apps Application's status.sync.revision — the deployed commit. */
	revision?: string;
	/** Which wiring step died: argocd_install | git_token | repo_credentials |
	 *  templates_missing | render | apply. Absent ⇒ the wiring did not fail. */
	failed_step?: GitopsFailedStep;
	/** The wiring failure message, token-sanitized at the source (Go). */
	error?: string;
	/** The whole apps Application's aggregate health/sync — the honest fallback row. */
	app_health?: AddOnStatusEntry;
	/** Per-workload health from the apps Application's resources, keyed by name.
	 *  Empty = unreadable (an honest unknown), NOT "no services". */
	services?: Record<string, GitopsServiceHealth>;
	/** Non-fatal manifest-generation warnings (skipped service, unresolved binding endpoint,
	 *  unsatisfiable credential facet). No secret values — names only (Go `ManifestWarnings`). */
	manifest_warnings?: string[];
}

/** One workload's ArgoCD resource status inside the apps Application (Go `argocd.ServiceHealth`):
 *  health/sync plus ArgoCD's per-resource health message ("Deployment exceeded its progress
 *  deadline…"); empty when healthy. */
export interface GitopsServiceHealth {
	health: ArgocdHealthStatus;
	sync: ArgocdSyncStatus;
	message?: string;
}

// The cluster's aggregated Trivy-Operator vulnerability posture (packages/core/argocd
// `SecurityPosture`). `scanned=false` means Trivy-Operator isn't installed / no reports yet.
export interface SecurityReport {
	critical: number;
	high: number;
	medium: number;
	low: number;
	report_count: number;
	scanned: boolean;
}

// Why a refresh delta was dismissed as representational rather than counted as drift.
// Mirrors the Go `drift.NormalizedReason` (packages/core/drift/normalize.go).
export type DriftNormalizedReason =
	| "empty_collection"
	| "undeclared_collection"
	| "computed_attribute";

// One resource whose every refresh delta was representational — a difference in how the
// provider encodes a value, not a difference in the infrastructure.
//
// `attributes` carries attribute PATHS and never VALUES: plan JSON values are plaintext
// secrets, and this shape reaches the job log, execution_metadata and Postgres.
export interface DriftNormalizedResource {
	address: string;
	type: string;
	attributes?: string[];
	reason: DriftNormalizedReason;
}

// Mirrors the Go `drift.Posture` (packages/core/drift). `unmanaged_known` is false for a
// refresh-only plan — it cannot see resources that exist in the cloud but not in state.
export interface DriftPosture {
	in_sync: boolean;
	drifted: number;
	details?: DriftDetail[];
	// What the detector examined and dismissed. Kept rather than dropped so the
	// dismissal is auditable — "0 drifted" with no trace is a control that cannot be
	// shown to have operated.
	normalized?: number;
	normalized_details?: DriftNormalizedResource[];
	unmanaged: number;
	unmanaged_known: boolean;
	scanned_at?: string;
}

// ── Verification gate (elench) ───────────────────────────────────────────────
// Mirrors the Go `verify.Report` (packages/core/verify/types.go). The deterministic
// policy gate runs between `tofu plan` and `tofu apply`; `not_evaluable` means the
// plan JSON lacked the information to judge a control — NEVER a silent pass.

export type VerifyStatus = "pass" | "fail" | "warn" | "not_evaluable";

export interface VerifyFinding {
	address: string;
	message: string;
}

export interface VerifyControlResult {
	id: string;
	title: string;
	severity: "high" | "medium" | "low";
	status: VerifyStatus;
	frameworks?: string[];
	provider: string;
	findings?: VerifyFinding[];
	/** Plain-language note on what this control could NOT inspect on this plan. */
	coverage?: string;
}

export interface VerifySummary {
	pass: number;
	fail: number;
	warn: number;
	not_evaluable: number;
}

export interface VerifyReport {
	verdict: VerifyStatus;
	catalog_version: string;
	provider: string;
	controls: VerifyControlResult[];
	summary: VerifySummary;
}

// A waiver recorded in the receipt when an apply proceeded despite a failing
// control (the verdict itself is NOT rewritten — the exception explains why).
export interface RecordedException {
	controls: string[];
	reason: string;
	by: string;
	expiry?: string;
}

// jobs.verify_override — an authorized, time-boxed waiver attached to a DEPLOY job.
// The runner passes it to the fail-closed gate (packages/core/verify Override). `by`
// is set server-side to the authorizing actor; `expiry` is RFC3339.
export interface VerifyOverrideInput {
	controls: string[];
	reason: string;
	by: string;
	expiry?: string;
}

// Mirrors the Go `verify.Receipt` — the per-apply evidence record.
export interface VerifyReceiptBody {
	version: string;
	plan_sha256: string;
	tofu_version?: string;
	provider_versions?: Record<string, string>;
	catalog_version: string;
	provider: string;
	verdict: VerifyStatus;
	report: VerifyReport;
	exception?: RecordedException;
	runner?: string;
	evaluated_at?: string;
}

// Mirrors the Go `verify.SignedReceipt`. `algorithm` is "ed25519" when signed or
// "none" when a signing key was not configured.
export interface SignedReceipt {
	receipt: VerifyReceiptBody;
	algorithm: string;
	key_id?: string;
	signature?: string;
	/**
	 * base64(std) ed25519 public key the signature verifies under (#884). Lets an auditor
	 * self-verify a downloaded receipt offline. "Is this the org's key?" is answered out-of-band
	 * (the recorded key_id→public_key history / a Rekor anchor), never by trusting this field.
	 * Empty on unsigned receipts / pre-#884 signatures.
	 */
	public_key?: string;
	/**
	 * Transparency-log anchor (#885): offline proof this receipt's digest was entered into an
	 * append-only Rekor log. Populated console-side after the receipt is authenticated; absent
	 * when anchoring is disabled or the log was unreachable (anchoring is additive evidence).
	 * Mirrors the Go `verify.RekorAnchor`.
	 */
	rekor?: RekorAnchor;
}

// Mirrors the Go `verify.RekorInclusionProof` — the RFC 6962 Merkle audit path + signed
// checkpoint proving the entry is in the log tree.
export interface RekorInclusionProof {
	log_index: number;
	/** lowercase-hex Merkle root the audit path resolves to. */
	root_hash: string;
	tree_size: number;
	/** lowercase-hex sibling hashes (leaf→root). */
	hashes: string[];
	/** the log's signed tree head; stored for the consistency-monitor follow-on. */
	checkpoint?: string;
}

// Mirrors the Go `verify.RekorAnchor` — a self-contained, offline-verifiable Rekor inclusion
// proof for a receipt digest. The receipt BODY is never logged (a `hashedrekord` hash-only
// entry); the logged signature is a dedicated platform ECDSA-P256 anchor signature, separate
// from the ed25519 receipt signature.
export interface RekorAnchor {
	log_url?: string;
	/** lowercase-hex SHA-256 of the DER log public key. */
	log_id: string;
	log_index: number;
	/** log self-asserted integration time (Unix seconds, Rekor v1); not externally trustworthy. */
	integrated_time?: number;
	/** base64(std) canonicalized `hashedrekord` entry as logged (the Merkle leaf source). */
	body: string;
	inclusion_proof: RekorInclusionProof;
	/** base64(std) signed entry timestamp — the log key's signed inclusion promise (Rekor v1). */
	signed_entry_timestamp?: string;
	/** anchor-signature scheme, always "ecdsa-p256-sha256" today. */
	anchor_algorithm: string;
	/** base64(std) ASN.1-DER ECDSA-P256 signature over sha256(canonical receipt). */
	anchor_signature: string;
	/** base64(std) PEM-encoded ECDSA-P256 public key the anchor signature verifies under. */
	anchor_public_key: string;
}

// One captured (truncated) file from a scanned repo. Mirrors the Go `types.RepoFile`
// (packages/core/types/repo_digest.go).
export interface RepoFile {
	path: string;
	content: string;
	truncated?: boolean;
}

// Deterministic static analysis of a repository (ANALYZE_REPO job). Mirrors the Go
// `RepoDigest` (packages/core/types/repo_digest.go); fed to the model to infer a Project.
export interface RepoDigest {
	repo_url: string;
	ref?: string;
	scanned_at: string;
	file_count: number;
	truncated?: boolean;
	languages?: Record<string, number>;
	manifests?: RepoFile[];
	dockerfiles?: RepoFile[];
	compose?: RepoFile[];
	k8s_manifests?: RepoFile[];
	ci_configs?: RepoFile[];
	env_examples?: RepoFile[];
	signals?: string[];
	/** Monorepo-aware deployable services detected in the repo (path + runtime/port). */
	services?: DetectedService[];
}

// ── Alerting (dataroom/spec/mvp/25-alerting-notifications.md) ────────────────────────────

// alert_channels.config — non-secret channel settings. The sensitive material
// (webhook/Slack/RocketChat URL, optional webhook signing secret) lives in the
// encrypted `secret` column, never here.
export interface AlertChannelConfig {
	// email channel: who receives the alert.
	recipients?: string[];
}

// alert_rules.match — field-equality narrowing of an event type. Empty = "all
// events of this type". Compound/boolean expressions are an ee/ capability.
export interface AlertRuleMatch {
	job_types?: string[];
	project_ids?: string[];
	resource_types?: string[];
	actions?: string[];
	min_severity?: AlertSeverity;
}

// alert_deliveries.context — the rendered event payload captured at emit time, so
// a delivery is replayable and the Activity view is self-describing. Fields are
// optional because they vary by source (authz vs jobs vs connector health).
export interface AlertEventContext {
	title: string;
	summary?: string;
	severity?: AlertSeverity;
	// authz / governance sources
	actor_id?: string;
	action?: string;
	resource_type?: string;
	resource_id?: string;
	reason?: string;
	// job / project sources
	job_id?: string;
	job_type?: string;
	project_id?: string;
	// connector source
	connector_slug?: string;
	// deep link into the console
	link?: string;
}

// email_suppression.detail — the salient bits of the SES bounce/complaint
// notification that produced the suppression, kept for audit/debugging.
export interface EmailSuppressionDetail {
	// SES feedback id (bounce/complaint) — also the natural idempotency key.
	feedback_id?: string;
	// Original outbound message id, when the event carries it.
	ses_message_id?: string;
	// Bounce classification (e.g. "Permanent" / "General").
	bounce_type?: string;
	bounce_sub_type?: string;
	// Complaint feedback type (e.g. "abuse").
	complaint_feedback_type?: string;
	// Remote MTA diagnostic text, if any.
	diagnostic?: string;
}

/**
 * Payload of a staged project change (project_changes.payload). It's a cloud-indifferent
 * component-config delta whose shape depends on component_type (database, cache, …), so it
 * is intentionally an open record rather than one fixed interface — the canvas diff and
 * applyStagedChanges validate it against the matching drizzle-zod schema before it lands.
 */
export type StagedChangePayload = Record<string, unknown>;

/**
 * Cloud-indifferent cluster node capability (project_cluster.node_size). The Go catalog
 * resolver maps it to the nearest per-provider instance type at provision time.
 */
export interface NodeSize {
	vcpu: number;
	memory_gb: number;
}

/**
 * Provider-nuance bag on a cloud inventory row (cloud_* tables' `attributes`). The typed columns
 * carry the cross-cloud common shape; this holds the genuinely provider-specific extras
 * (e.g. AWS `arn`, Azure `resource_group`, GCP `self_link`, tags) — heterogeneous by design, so a
 * constrained primitive map rather than one fixed interface.
 */
export type CloudInventoryAttributes = Record<
	string,
	string | number | boolean | null | string[]
>;

/**
 * The reconnaissance-sensitive attributes of an inventory row (CIDRs, IPs, endpoints, DNS domains).
 * Sealed with AES-GCM into the `sensitive` text column (via inventory/upsert `sealSensitive`) and
 * decrypted only on read (`openSensitive`). All values are strings (the AES envelope stores a
 * `Record<string,string>`). We never store raw resource tags.
 */
export interface CloudSensitiveAttrs {
	cidr_block?: string;
	private_ip?: string;
	public_ip?: string;
	endpoint?: string;
	domain?: string;
	repository_url?: string;
}

// ============================================================
// Classification enforcement. Stored on `classification_value.enforcement` (nullable).
// ============================================================

/**
 * The promotion-gate policy a classification value imposes on any environment carrying it.
 * When an env is tagged with a value that has this config, promotions INTO that env inherit
 * these gates on top of the env's own protection rules — the label drives the policy. Null on
 * the column ⇒ the value is inert (the default). See lib/promotions/gates.ts.
 */
export interface ClassificationEnforcement {
	/** Force manual approval on promotions into an env carrying this value. */
	require_approval: boolean;
	/** Force the elench verify gate on those promotions. */
	require_verify_pass: boolean;
	/** Minimum distinct approvals when approval is required (≥ 1). */
	min_approvals: number;
}

/**
 * The frozen per-dimension classification captured into a job's `config_snapshot` at
 * enqueue time (B1.1). Keyed by classification dimension `key`; each entry is the sorted,
 * de-duplicated list of assigned value slugs on that dimension. Environment-level
 * assignments OVERRIDE the project's values per dimension (the environment is the more
 * specific scope); dimensions the environment doesn't touch inherit the project's values.
 * Keys and value arrays are sorted so the snapshot's `configuration_hash` is deterministic
 * regardless of DB row order. The runner (B1.2+) maps this onto per-cloud resource
 * tags/labels. Built by `resolveClassificationSnapshot` (lib/classification/snapshot.ts).
 */
export interface ClassificationSnapshot {
	/** dimension `key` → sorted, de-duplicated assigned value slugs */
	[dimension: string]: string[];
}

// ============================================================
// Environment promotion (Phase 2). Stored on environment_promotions / _protection_rules.
// ============================================================

/** Who may approve a promotion into a protected environment. Stored on `environment_protection_rules.approvers`. */
export interface ApproverSpec {
	/** Explicit user ids allowed to approve. */
	user_ids: string[];
	/** A built-in role (owner/admin/operator/…) whose members may approve; null = only listed users. */
	role: string | null;
	/** How many distinct approvals are required. */
	min_count: number;
}

/** A single field's before/after in a promotion UPDATE. */
export interface ComponentFieldChange {
	from: unknown;
	to: unknown;
}

/** One component's change in a promotion changeset. `key` is the component_type for singletons,
 * else the resource `name` (source_repos: `repo_url|scan_path`). */
export interface ComponentChange {
	component_type: string;
	key: string;
	op: "CREATE" | "UPDATE" | "DELETE";
	/** Structural field diffs (UPDATE only). */
	fields?: Record<string, ComponentFieldChange>;
}

/** The promotable delta from a source env's design to a target env's, plus a human summary.
 * Stored on `environment_promotions.diff_summary`. */
export interface PromotionDiff {
	changes: ComponentChange[];
	summary: string[];
	/** Whether the actor opted into applying DELETEs (target-only components). */
	include_removals: boolean;
}

/** Per-rule outcome of a protection-gate evaluation. */
export interface GateResult {
	type:
		| "predecessor_healthy"
		| "manual_approval"
		| "verify_pass"
		| "soak_timer"
		| "cost_delta";
	status: "pass" | "fail" | "pending" | "skipped";
	detail: string;
}

/** The overall gate evaluation for a promotion. Stored on `environment_promotions.gate_evaluations`. */
export interface GateEvaluation {
	overall: "pass" | "blocked" | "pending_approval";
	results: GateResult[];
	/** RFC3339 timestamp of the evaluation. */
	evaluated_at: string;
}

// ── Generative dashboard DSL (Elench "build_dashboard" tool) ─────────
// A small, renderable block list the AI agent emits; the console interprets it with
// grayscale primitives (no charting library). Kept intentionally minimal.

/** A single headline metric (big number/value + optional caption). */
export interface DashboardStatBlock {
	kind: "stat";
	title: string;
	value: string | number;
	sub?: string;
}

/** A categorical comparison rendered as vertical grayscale bars. */
export interface DashboardBarBlock {
	kind: "bar";
	title: string;
	data: Array<{ label: string; value: number }>;
}

/** A trend rendered as an ink-weight sparkline. */
export interface DashboardLineBlock {
	kind: "line";
	title: string;
	points: number[];
	label?: string;
}

/** A compact key/value grid (a set of labelled cells). */
export interface DashboardGridBlock {
	kind: "grid";
	title: string;
	cells: Array<{ label: string; value: string | number }>;
}

/** One renderable dashboard block (discriminated by `kind`). */
export type DashboardBlock =
	| DashboardStatBlock
	| DashboardBarBlock
	| DashboardLineBlock
	| DashboardGridBlock;

/** A full generative dashboard: a title and an ordered list of blocks. */
export interface DashboardSpec {
	title: string;
	blocks: DashboardBlock[];
}

/**
 * The recorded `input` of a break-glass action (breakglass_audit.input, and the
 * approval-binding surface). Deliberately a small, explicit shape — NOT
 * Record<string, unknown> — so what an operator asked to do is legible in the
 * immutable audit forever. Every field is optional because the relevant subset
 * depends on the action (see lib/breakglass/catalog.ts); the dispatcher validates
 * per-action required fields with zod before writing the row.
 */
export interface BreakglassActionInput {
	/** unstick_env: the explicit CAS precondition — the env must currently be in one of these. */
	expectedFrom?: ProjectStatus[];
	/** unstick_env: the target status to move the env to (the CAS `to`). */
	to?: ProjectStatus;
	/** force_release_state_lock / state_surgery: the tofu state object key. */
	stateKey?: string;
	/** drain_runner / restart_runner: the fleet-action "why" reason token echoed to the ledger. */
	fleetReason?: string;
	/** orphan_detect / orphan_clean: the run scope these are constrained to (never account-wide). */
	projectId?: string;
	environmentId?: string;
	/** state_surgery: a free-form operator description of the intended repair (audit only). */
	surgeryNote?: string;
	/** replay_webhook: whether the replay suppressed the branded emails (default true). */
	suppressEmails?: boolean;
	/**
	 * replay_webhook: whether the replay suppressed the invoice.payment_failed backup-card retry
	 * (default true — a replay re-processes state, it must not re-charge a customer unless opted in).
	 */
	suppressPaymentRetry?: boolean;
}

// ── Elench widget grid (per-chat bento canvas) ─────────
// Structured tool results pin to a 5-column grid next to the chat as widgets
// (`thread_widgets` rows). A widget either replays a read tool (`source` set) or
// renders a frozen DashboardBlock (`block` set, from an exploded build_dashboard).

/** The replayable tool call behind a live widget (`null` args = call with no input). */
export interface WidgetSource {
	/** Tool name from the AI tool registry (read tools only). */
	tool: string;
	args: Record<string, unknown> | null;
}

/** live = refetches via `source` on an interval; frozen = a pinned snapshot. */
export type WidgetMode = "live" | "frozen";

/** How a widget renders (drives the body renderer + default size). */
export type WidgetKind = "table" | "stat" | "bar" | "line" | "keyvalue";

/** The data payload a widget renders: a tool output snapshot or a dashboard block. */
export interface WidgetData {
	/** Snapshot of the source tool's output (tool-driven widgets). */
	output?: unknown;
	/** A single generative dashboard block (exploded build_dashboard widgets). */
	block?: DashboardBlock;
}

/** One widget inside a saved artifact — a portable thread_widgets row (no ids). */
export interface ArtifactWidget {
	kind: WidgetKind;
	title: string;
	source: WidgetSource | null;
	data: WidgetData;
	mode: WidgetMode;
	position: { x: number; y: number };
	size: { colspan: number; rowspan: number };
}

/** A saved artifact's payload (`agent_artifacts.spec`): widgets + relative layout.
 * kind "widget" = one entry; "dashboard" = a whole grid, positions normalized. */
export interface ArtifactSpec {
	widgets: ArtifactWidget[];
}

/**
 * One pinned knowledge document on `agent_context.documents` — the analogue of a file in a
 * Claude Project's knowledge base. Every document rides the system prompt of every chat in
 * that scope, so each one is a named, individually removable unit rather than one opaque blob.
 */
export interface KnowledgeDoc {
	id: string;
	title: string;
	content: string;
	/** ISO-8601. Stored as a string so the JSONB round-trips without a Date revival step. */
	updated_at: string;
}

/**
 * One priced resource from an Infracost breakdown, persisted on `environment_cost.resources`.
 * `address` is the Terraform address — the same key the drift map uses — so a cost line can be
 * attributed back to the canvas card that designed it.
 */
export interface CostResourceLine {
	address: string;
	resourceType: string;
	monthlyCost: number;
}

// ── Contract formation and consumer rights (#2372) ───────────────────────────

/**
 * Request evidence on `legal_acceptance.evidence` — the minimum that makes an acceptance
 * attributable to a person at a moment.
 *
 * Deliberately narrow. It is personal data, and every field beyond attribution is data we would
 * have to justify holding for the life of a contract; a session id, a referrer or a device
 * fingerprint would not make the acceptance any more provable.
 */
export interface LegalAcceptanceEvidence {
	/** The submitting IP, as observed. May be null behind a proxy that strips it — recorded as null
	 *  rather than as a placeholder, so an absent value never reads as a real one. */
	ip: string | null;
	userAgent: string | null;
	/** ISO-8601, as the CLIENT reported it. Kept alongside the server's `accepted_at`: a large gap
	 *  between the two is itself a signal, and reconciling them later needs both. */
	clientTimestamp: string | null;
	/** How the acceptance was presented — which surface rendered the checkbox or the order button. */
	surface: "signup" | "console-gate" | "checkout";
}

/** A billing address as GIVEN, snapshotted on `commerce_order.billing_address`. Free-form lines
 *  rather than a normalized shape: address formats differ by country, and normalizing would lose
 *  what the payer actually wrote — which is the thing the record has to preserve. */
export interface CommerceBillingAddress {
	line1: string;
	line2: string | null;
	city: string;
	postalCode: string;
	/** Region/state/province, where the country uses one. */
	region: string | null;
	/** ISO 3166-1 alpha-2, upper-case. Mirrors `commerce_order.billing_country`. */
	country: string;
}

/**
 * The legal documents in force when an order was placed, on `commerce_order.document_versions`.
 * Version AND hash for each, so the order names text that can still be reproduced.
 */
export interface CommerceDocumentVersions {
	documents: {
		id: string;
		version: string;
		hash: string;
	}[];
}

// ── Privacy operations (#2373) ───────────────────────────────────────────────

/**
 * What a privacy case covers, and what was actually done — on `privacy_case.scope` and, after the
 * fact, on `privacy_erasure_tombstone.scope`.
 *
 * `pseudonymized` is separate from `erased` because they are different outcomes with different
 * consequences. Deleting a row that other tenants' records point at (a message author, a job's
 * actor) would break THEIR data, so the identifier is replaced instead and the record stays
 * coherent. Recording that as "erased" would overstate what happened; omitting it would understate
 * it. Both are wrong in a way the subject is entitled to know about.
 */
export interface PrivacyCaseScope {
	/** Tables from which rows were removed outright. */
	erased: string[];
	/** Tables where the identifier was replaced but the row was kept, with why. */
	pseudonymized: { table: string; reason: string }[];
	/** Tables deliberately NOT touched, with the obligation that requires keeping them. */
	retained: { table: string; basis: string }[];
	/** Third parties told to erase, and whether each confirmed. */
	vendors: { name: string; notifiedAt: string; confirmedAt: string | null }[];
}

/**
 * Structured detail on one `privacy_case_event`.
 *
 * ⚠️ It must NEVER carry the subject's personal data. The ledger outlives the erasure it records, so
 * anything copied in here is data that survived a deletion — inside the very machinery that
 * performed it. Counts, table names and reasons; never values.
 */
export interface PrivacyEventDetail {
	/** One line of what happened, safe to show the subject. */
	summary: string;
	/** Optional counts, e.g. `{ rows_erased: 412 }`. Numbers only. */
	counts?: Record<string, number>;
	/** Tables involved, when the event is about specific ones. */
	tables?: string[];
}

/**
 * The signed manifest that ships with an export, on `privacy_case.export_manifest`.
 *
 * An archive with no manifest is a bag of files the recipient has to trust. The manifest says what
 * was included, what each part contains, and the digest of the archive it describes — so a person
 * can verify they received what we said we sent, and we can show later what that was.
 */
export interface PrivacyExportManifest {
	/** Manifest schema version, so an old export stays readable. */
	version: 1;
	/** ISO-8601, when the archive was produced. */
	generatedAt: string;
	/** SHA-256 of the archive bytes, lower-case hex. */
	archiveSha256: string;
	/** Byte length of the archive, so a truncated download is detectable. */
	archiveBytes: number;
	/** One entry per file inside, in the order they appear. */
	parts: {
		path: string;
		/** What this part holds, in plain language. */
		describes: string;
		rows: number;
		sha256: string;
	}[];
	/** Ed25519 signature over the canonical manifest body, base64. Null when signing is unavailable. */
	signature: string | null;
	/** The key that signed it, so the signature can be checked later. Null when unsigned. */
	signingKeyId: string | null;
}

/**
 * What the client that ran `alethia login` said about itself, on `cli_logins.client_metadata`.
 *
 * Every field here is **attacker-controllable** — it arrives on the unauthenticated
 * `/api/auth/cli/start` request, from a process nobody has authenticated yet. That is exactly
 * why the three of them live together in one column instead of being spread across the table
 * next to `request_ip`: `request_ip` is read from the deployment's trusted proxy header and is
 * server-derived, these are not, and a reader of the schema must not have to guess which is
 * which. Render them as a claim the user is being asked to weigh ("this device says it is
 * alethia-cli v0.42 on macOS"), never as a fact the control plane is asserting.
 *
 * Null on any row written before the client registered, and on any field the client omitted.
 */
export interface CliDeviceClientMetadata {
	/** The product name the client reported, e.g. `alethia-cli`. */
	client_name: string | null;
	/** The version the client reported, e.g. `0.42.1`. */
	client_version: string | null;
	/** The `user-agent` header on the registration request. */
	user_agent: string | null;
}
