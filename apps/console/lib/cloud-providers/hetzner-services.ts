// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Hetzner is a compute-only cloud — it has no managed Postgres/Redis/queue services like
 * AWS/GCP/Azure. So on a Hetzner/Talos cluster, a canvas "database"/"cache"/"queue" node does
 * not map to a managed cloud resource; it becomes an **in-cluster Helm chart** deployed via
 * ArgoCD. This module is the single source of truth for WHICH chart backs each engine and how
 * a component's config maps to that chart's Helm values.
 *
 * The mapping produces `AddOnInstallSpec[]` — the exact runner-facing shape the marketplace
 * add-ons already use — which `buildConfigSnapshot` appends to the DEPLOY job's `addons`. The
 * runner renders one ArgoCD Application per spec (packages/core/argocd RenderManagedAddOns),
 * with zero Go changes: the renderer is generic over (chartRepo, chart, version, namespace,
 * values). Chart coordinates live here and are swappable without touching the pipeline.
 *
 * Coverage: Postgres→CloudNativePG, Redis→Valkey, queue→RabbitMQ, registry→Harbor,
 * secret→Vault, topic→NATS. `nosql` is the ONE kind Hetzner still refuses — see unsupported-kinds.ts.
 *
 * WHAT "CARRYING A KIND" MEANS HERE, because it is the thing most easily misread: each node
 * becomes one SERVER release, not one server-side object. A `queue` node is a RabbitMQ release,
 * not an AMQP queue; a `database` node is a Postgres cluster, not a schema. `topic` follows that
 * same rule — a NATS release whose SUBJECTS are the topics. That is why it needed no bootstrap Job.
 */

import type { AddOnInstallSpec } from "@/lib/addons/types";
import { DNS1123_LABEL_PATTERN } from "@/lib/validations/names";

/** The block-storage StorageClass the Hetzner/Talos template makes default (CSI driver). */
const HCLOUD_STORAGE_CLASS = "hcloud-volumes";

/** hcloud's minimum Block Storage volume is 10 GiB. Asking for less does not fail — the CSI driver
 *  rounds up — so a chart default below it produces a cluster that quietly disagrees with the
 *  values this repo rendered. Every volume we ask for is clamped here instead. */
const HCLOUD_MIN_VOLUME_GB = 10;

/** Shared namespaces per service category (auto-created by ArgoCD `CreateNamespace=true`). */
const NS = {
	postgres: "databases",
	cache: "caches",
	queue: "queues",
	registry: "registries",
	secret: "secrets",
	topic: "topics",
	nosql: "nosql",
	operators: "cnpg-system",
	scyllaOperators: "scylla-operator",
} as const;

/**
 * Pinned chart coordinates per in-cluster service. Versions resolve against the live Helm
 * repos at `tofu apply` time (not exercisable under type-check); bump here as the SSOT.
 */
export const HETZNER_CHARTS = {
	/**
	 * CloudNativePG operator — installed once per cluster when ≥1 Postgres node exists.
	 *
	 * ⚠️ THIS URL WENT UNREACHABLE FOR A DAY AND IS STILL CORRECT. DO NOT "FIX" IT (#3961). It
	 * answers `301 -> https://cloudnative-pg.io/charts/index.yaml`, and for a while
	 * `cloudnative-pg.io` SERVFAILed: the four Route53 nameservers the .io registry delegated it to
	 * all answered REFUSED — a hosted zone that was gone. Not NXDOMAIN, no DS record, so a stale
	 * delegation rather than a move, and the content was in place throughout (`--resolve
	 * cloudnative-pg.io:443:185.199.108.153` returned `200 text/yaml` from GitHub Pages). The
	 * project has since re-delegated the domain to a new nameserver set and it resolves again.
	 *
	 * The primary source never changed and still names this exact string — the project's own
	 * operator-chart README on `main` says `helm repo add cnpg https://cloudnative-pg.github.io/charts`.
	 * Recording it here because the next reader will meet a red fetch before they meet that README,
	 * and the tempting repair — repointing at the 301 target, or at a guessed OCI ref — would have
	 * shipped to every user who adds Postgres and would still have been wrong once the name came back.
	 */
	cnpgOperator: {
		chartRepo: "https://cloudnative-pg.github.io/charts",
		chart: "cloudnative-pg",
		version: "0.22.1",
	},
	/** CloudNativePG `cluster` chart — one Application per database node (a Cluster CR). Same repo,
	 *  and the same #3961 note applies: the URL is right; it was the project's DNS that was not. */
	cnpgCluster: {
		chartRepo: "https://cloudnative-pg.github.io/charts",
		chart: "cluster",
		version: "0.0.11",
	},
	/**
	 * Valkey (OSS Redis fork) — one release per cache node, from the UPSTREAM VALKEY PROJECT'S
	 * OWN chart (valkey-io/valkey-helm), which ships the official `docker.io/valkey/valkey` image.
	 *
	 * NOT Bitnami: `bitnami/valkey` 1.0.6 was DELETED from the Bitnami index (`helm show chart`
	 * → "no chart version found for valkey-1.0.6"), so ArgoCD could not even fetch it — Hetzner
	 * caches were broken in production. Broadcom's Bitnami wind-down also relocated
	 * `docker.io/bitnami/*` images to `bitnamilegacy/*`, so staying on Bitnami means an
	 * unmaintained, unpatched image archive. This chart is first-party and maintained.
	 *
	 * ⚠️ Its value schema is NOTHING like Bitnami's — see hetznerCacheValues() for the mapping,
	 * which is verified against `helm show values`/`helm template`, never guessed.
	 */
	valkey: {
		chartRepo: "https://valkey-io.github.io/valkey-helm",
		chart: "valkey",
		version: "0.10.0",
	},
	/**
	 * RabbitMQ — the SQS analogue, one release per queue node. Pulls the OFFICIAL upstream
	 * `docker.io/rabbitmq` image (the chart digest-pins it), app v4.3.x.
	 *
	 * NOT Bitnami: `bitnami/rabbitmq` 14.7.0's default image
	 * `docker.io/bitnami/rabbitmq:3.13.7-debian-12-r2` is HTTP 404 — Broadcom relocated the
	 * Bitnami catalog's images to `bitnamilegacy/*` — so every fresh Hetzner queue
	 * ImagePullBackOff'd. The Bitnami-hosted `rabbitmq-cluster-operator` chart is NOT an escape:
	 * it still pulls `docker.io/bitnami/*`.
	 *
	 * Durable upgrade path (deliberately NOT taken here): the OFFICIAL RabbitMQ Cluster Operator
	 * (rabbitmq/cluster-operator, images `rabbitmqoperator/*`) ships as a `kubectl apply` release
	 * manifest, which the new `source: "manifest"` add-on rail can now install — but a
	 * RabbitmqCluster CR is not a Helm chart, so delivering the per-queue CR (and reading its
	 * health back) needs the inline-manifest + CR-health work. This chart keeps queues on the
	 * Helm rail (so ArgoCD health/status keeps working) with official images, today.
	 */
	rabbitmq: {
		chartRepo: "https://cloudpirates-io.github.io/helm-charts",
		chart: "rabbitmq",
		version: "0.21.9",
	},
	/**
	 * Harbor — the in-cluster substitute for ECR / Artifact Registry / ACR, one release per
	 * `registry` node. The SAME chart and pin as the `harbor` marketplace add-on
	 * (lib/addons/catalog.ts): a Hetzner project that also enables the add-on must not end up with
	 * two different Harbor versions in one cluster.
	 *
	 * ⚠️ It is not one release with one volume. Harbor ships its OWN Postgres, Redis and Trivy, so
	 * a registry node costs FIVE persistent volumes, and hcloud's minimum volume is 10 GiB — the
	 * chart's 1Gi/1Gi/5Gi defaults for the non-registry three would each be silently rounded up by
	 * the CSI driver. hetznerRegistryValues() asks for what it will actually get.
	 */
	harbor: {
		chartRepo: "https://helm.goharbor.io",
		chart: "harbor",
		version: "1.15.1",
	},
	/**
	 * HashiCorp Vault — the in-cluster substitute for Secrets Manager / Secret Manager / Key Vault /
	 * KMS, ONE release per cluster serving every `secret` node. The SAME chart and pin as the `vault`
	 * marketplace add-on (lib/addons/catalog.ts), for the reason Harbor's note above gives.
	 *
	 * ⚠️ It is deliberately NOT installed under the marketplace add-on's id or namespace. That
	 * add-on is a Vault the CUSTOMER runs and operates; this one is the PLATFORM's, and Alethia
	 * holds its unseal key. A project may reasonably want both, so they must not collide — hence
	 * the `secrets-vault` id and the `secrets` namespace here against the add-on's `vault`/`vault`.
	 */
	vault: {
		chartRepo: "https://helm.releases.hashicorp.com",
		chart: "vault",
		version: "0.28.1",
	},
	/**
	 * NATS — the SNS / Pub-Sub / Service Bus analogue, one release per `topic` node, from the
	 * NATS project's OWN chart (nats-io/k8s), which ships the official `nats` image.
	 *
	 * WHY NATS AND NOT KAFKA. A topic here is publish/subscribe fanout, which is core NATS'
	 * native model: a subject IS the topic, and a subscriber is a client that asks for it. Kafka
	 * (Strimzi) and Pulsar are log/stream systems that reach the same behaviour through a heavier
	 * broker, an operator and a CR — and Strimzi is not a Helm chart delivering a cluster, it is
	 * an operator plus a CR, which the note on RabbitMQ above explains this rail cannot yet
	 * deliver health for. NATS is one chart, one release, one Application, health readable.
	 *
	 * JetStream (persistence) is ON, because a topic whose messages vanish on a pod restart is a
	 * different product from the one the managed clouds sell.
	 */
	nats: {
		chartRepo: "https://nats-io.github.io/k8s/helm/charts/",
		chart: "nats",
		version: "2.14.6",
	},
	/**
	 * ScyllaDB operator — installed once per cluster when >=1 `nosql` node exists, exactly as the
	 * CloudNativePG operator is for `database`.
	 *
	 * Its admission webhook is `failurePolicy: Fail` and its serving certificate is issued through
	 * `cert-manager.io/inject-ca-from`, so the install spec sets `requiresCertManager` and the
	 * runner installs the cert-manager CONTROLLER for it. That is a real platform decision, not a
	 * detail: without the CA the webhook rejects every ScyllaCluster, so the kind is unusable
	 * rather than degraded (#3228).
	 */
	scyllaOperator: {
		chartRepo: "https://scylla-operator-charts.storage.googleapis.com/stable",
		chart: "scylla-operator",
		version: "v1.21.1",
	},
	/**
	 * ScyllaDB `scylla` chart — one ScyllaCluster CR per `nosql` node.
	 *
	 * WHY SCYLLA AND NOT MONGODB. The `nosql` kind is DynamoDB-shaped: `PartitionKey` +
	 * `SortKey`, on-demand or provisioned capacity. Scylla is a wide-column store whose data
	 * model is that shape natively (partition key + clustering key) — and it ships **Alternator**,
	 * a DynamoDB-compatible HTTP API, so the same client that talks to DynamoDB on AWS talks to
	 * this on Hetzner. MongoDB is a document store with no partition/sort key concept, so mapping
	 * the kind onto it would have meant inventing a translation the product would then own
	 * forever. Alternator is enabled in hetznerNosqlValues() for exactly that reason.
	 *
	 * Not Bitnami, and not a community repackage: this is ScyllaDB's own chart, on its own repo.
	 */
	scyllaCluster: {
		chartRepo: "https://scylla-operator-charts.storage.googleapis.com/stable",
		chart: "scylla",
		version: "v1.21.1",
	},
} as const;

/** Node kinds Hetzner supports in v1 (the canvas hides the rest for Hetzner). */
export const HETZNER_SUPPORTED_DATA_KINDS = [
	"database",
	"cache",
	"queue",
	"registry",
	"secret",
	"topic",
	"nosql",
] as const;

/** Database engines available on Hetzner (Postgres only in v1 — via CloudNativePG). */
export const HETZNER_DB_ENGINES = ["postgres"] as const;

/** Cache engines available on Hetzner (the in-cluster chart is Valkey — Redis-compatible,
 *  but offering "Redis" would be dishonest: the deploy always ships Valkey). */
export const HETZNER_CACHE_ENGINES = ["valkey"] as const;

/** Minimal views of the component rows the mapper needs. `storage_gb` and `replicas` are
 *  the user-tunable in-cluster sizing columns (Hetzner-gated inspector fields); NULL means
 *  the defaults here stay authoritative. A cache's explicit `storage_gb` wins over the
 *  `memory_gb` fallback. */
interface DatabaseInput {
	name: string;
	engine_family?: string | null;
	engine_version?: string | null;
	storage_gb?: number | null;
	replicas?: number | null;
}
interface CacheInput {
	name: string;
	engine_version?: string | null;
	memory_gb?: number | null;
	num_cache_nodes?: number | null;
	storage_gb?: number | null;
}
interface QueueInput {
	name: string;
	storage_gb?: number | null;
}
/** A `registry` node. `storage_gb` sizes the IMAGE store only — Harbor's own database, Redis and
 *  Trivy volumes are fixed at hcloud's 10 GiB minimum and are not user-tunable. */
interface RegistryInput {
	name: string;
	storage_gb?: number | null;
}
/** A `secret` node. It carries no sizing of its own — every secret node on a project is one KV v2
 *  entry in the SAME Vault, so only the presence of at least one matters to the mapper. */
interface SecretInput {
	name: string;
}

/** A `topic` node. One NATS release per node; the SUBJECT is the topic and needs no server-side
 *  object, exactly as a `queue` node is one RabbitMQ release rather than one AMQP queue. */
interface TopicInput {
	name: string;
	storage_gb?: number | null;
}

/** A `nosql` node. One ScyllaCluster per node; the TABLE is created by the application, exactly as
 *  a `database` node is a Postgres cluster rather than a schema. */
interface NosqlInput {
	name: string;
	storage_gb?: number | null;
	replicas?: number | null;
}

interface HetznerDataServices {
	databases?: DatabaseInput[];
	caches?: CacheInput[];
	queues?: QueueInput[];
	registries?: RegistryInput[];
	secrets?: SecretInput[];
	topics?: TopicInput[];
	nosqlTables?: NosqlInput[];
}

/** Clamp a positive integer with a default, guarding null/NaN/negatives. */
function posInt(value: number | null | undefined, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
		return fallback;
	}
	return Math.floor(value);
}

/**
 * Maps a Hetzner project's data components to in-cluster Helm install specs. Returns an
 * `AddOnInstallSpec[]` to append to the DEPLOY snapshot's `addons`:
 *  - the CloudNativePG operator once (sync-wave 0) when any Postgres database is present;
 *  - one CNPG `cluster` Application per database (sync-wave 1);
 *  - one Valkey release per cache; one RabbitMQ release per queue (sync-wave 1);
 *  - one Harbor release per registry (sync-wave 2);
 *  - ONE Vault release for the whole project when any `secret` node exists (sync-wave 0).
 * Each id is unique per node (`db-<name>` / `cache-<name>` / `queue-<name>` / `registry-<name>`) so the runner's
 * `AddOnAppName` yields a distinct ArgoCD Application, and health reads back per component.
 */
/**
 * The id prefix each Hetzner-charted node kind gets, and the DNS-1123 rule that follows from it.
 *
 * These are the SINGLE definition: the `specs.push({ id: … })` sites below interpolate these
 * constants, and `hetznerNodeNameProblem` derives its length bound from them. A gate that reports
 * an emitter has to mirror every one of its conditions, and a hand-copied list of prefixes is a
 * copy that decays the day a seventh kind ships.
 *
 * Note what is ABSENT and why: a `secret` node and a `chart repo` node get no id, because a secret
 * is one KV entry inside the single project-wide Vault release rather than an object of its own.
 * Their names never become a Kubernetes object name, so they are not bound by this rule.
 */
export const HETZNER_ADDON_ID_PREFIXES = {
	databases: "db-",
	topics: "topic-",
	tables: "nosql-",
	caches: "cache-",
	registries: "registry-",
	queues: "queue-",
} as const;

export type HetznerChartedKind = keyof typeof HETZNER_ADDON_ID_PREFIXES;

/** Kubernetes' own ceiling for a label / object-name segment. */
const DNS_1123_LABEL_MAX = 63;

/**
 * RFC-1123 DNS label: lower-case alphanumerics and hyphens, not starting or ending with one.
 *
 * The ONE grammar (lib/validations/names.ts). The runner has to agree with it — it derives every
 * Secret and Application name from a node name and refuses anything outside this charset before
 * interpolating one into a kubectl command — and it now does so by construction: `k8sNameRe` in
 * packages/core/argocd/addon_secrets.go IS `names.NamespacePattern`, generated from the same
 * constant and diff-gated by `pnpm -C apps/console run gen:go-names:check` (#3665). This file used to
 * restate the charset twice, once here and once as `K8S_LABEL`, checked against Go by a test that
 * read this file's source text.
 */
const DNS_1123_LABEL_RE = DNS1123_LABEL_PATTERN;

/**
 * Why a node name is unusable on Hetzner, or `null` when it is fine.
 *
 * The length bound is DERIVED — `63 - prefix.length` — not asserted. An earlier version of this
 * rule hard-coded 40, which is a number no emitter produces: `db-` plus a 45-character name is 48
 * and deploys today. A cap that refuses a name the cluster accepts introduces a failure instead of
 * surfacing one.
 */
export function hetznerNodeNameProblem(
	kind: HetznerChartedKind,
	name: string,
): string | null {
	const prefix = HETZNER_ADDON_ID_PREFIXES[kind];
	const max = DNS_1123_LABEL_MAX - prefix.length;
	if (name.length > max) {
		return (
			`"${name}" is ${name.length} characters; on Hetzner it becomes the Kubernetes object ` +
			`"${prefix}${name}", and Kubernetes allows at most ${DNS_1123_LABEL_MAX}. Use ${max} ` +
			`characters or fewer.`
		);
	}
	if (!DNS_1123_LABEL_RE.test(name)) {
		return (
			`"${name}" is not a valid DNS-1123 label. On Hetzner it becomes the Kubernetes object ` +
			`"${prefix}${name}", so it must be lower-case letters, digits or hyphens, and start and ` +
			`end with a letter or digit.`
		);
	}
	return null;
}

export function hetznerDataServicesToAddOns(
	services: HetznerDataServices,
): AddOnInstallSpec[] {
	const specs: AddOnInstallSpec[] = [];

	const databases = services.databases ?? [];
	const caches = services.caches ?? [];
	const queues = services.queues ?? [];
	const registries = services.registries ?? [];
	const secrets = services.secrets ?? [];
	const topics = services.topics ?? [];
	const nosqlTables = services.nosqlTables ?? [];

	// Secrets → ONE Vault for the project (never one per node: a `secret` node is a KV entry, not a
	// server). syncWave 0 because the ClusterSecretStore over it, and every ExternalSecret that
	// resolves through it, are useless until Vault answers — and nothing waits on the reverse.
	if (secrets.length > 0) {
		specs.push({
			id: HETZNER_VAULT_ADDON_ID,
			mode: "managed",
			chartRepo: HETZNER_CHARTS.vault.chartRepo,
			chart: HETZNER_CHARTS.vault.chart,
			version: HETZNER_CHARTS.vault.version,
			namespace: NS.secret,
			values: hetznerVaultValues(),
			syncWave: 0,
		});
	}

	// Postgres databases: install the CNPG operator once, then a Cluster per node.
	const pgDatabases = databases.filter(
		(d) => (d.engine_family ?? "postgres") === "postgres",
	);
	if (pgDatabases.length > 0) {
		specs.push({
			id: "cnpg-operator",
			mode: "managed",
			chartRepo: HETZNER_CHARTS.cnpgOperator.chartRepo,
			chart: HETZNER_CHARTS.cnpgOperator.chart,
			version: HETZNER_CHARTS.cnpgOperator.version,
			namespace: NS.operators,
			values: {},
			syncWave: 0,
			// The CRD each database's `Cluster` CR (sync-wave 1) needs. The runner applies the
			// add-on Applications in wave order and BLOCKS on this CRD becoming Established before
			// wave 1 — ArgoCD's sync-wave annotation does NOT order separate top-level
			// Applications, so without this the operator and the Cluster CR race and the CR's first
			// sync fails with `no matches for kind "Cluster"`. Name verified against the real chart
			// (cloudnative-pg 0.22.1 renders clusters.postgresql.cnpg.io).
			crds: ["clusters.postgresql.cnpg.io"],
		});
	}
	for (const db of pgDatabases) {
		const cluster: Record<string, unknown> = {
			instances: posInt(db.replicas, 1),
			storage: {
				size: `${posInt(db.storage_gb, 10)}Gi`,
				storageClass: HCLOUD_STORAGE_CLASS,
			},
		};
		if (db.engine_version) {
			cluster.imageName = `ghcr.io/cloudnative-pg/postgresql:${db.engine_version}`;
		}
		specs.push({
			id: `${HETZNER_ADDON_ID_PREFIXES.databases}${db.name}`,
			mode: "managed",
			chartRepo: HETZNER_CHARTS.cnpgCluster.chartRepo,
			chart: HETZNER_CHARTS.cnpgCluster.chart,
			version: HETZNER_CHARTS.cnpgCluster.version,
			namespace: NS.postgres,
			values: { cluster },
			syncWave: 1,
		});
	}

	// Topics → NATS, one release per node (sync-wave 1). No operator and no CRD gate: the chart
	// delivers a plain StatefulSet, so unlike CNPG there is nothing for a later wave to wait
	// on.
	for (const topic of topics) {
		specs.push({
			id: `${HETZNER_ADDON_ID_PREFIXES.topics}${topic.name}`,
			mode: "managed",
			chartRepo: HETZNER_CHARTS.nats.chartRepo,
			chart: HETZNER_CHARTS.nats.chart,
			version: HETZNER_CHARTS.nats.version,
			namespace: NS.topic,
			values: hetznerTopicValues(topic),
			syncWave: 1,
		});
	}

	// NoSQL → ScyllaDB: the operator once (sync-wave 0), then a ScyllaCluster per node (wave 1).
	// This is the CNPG shape, for the CNPG reason — ArgoCD sync-waves do NOT order separate
	// top-level Applications, so the runner blocks on the CRD becoming Established before wave 1.
	// Without that the operator and the CR race and the CR's first sync fails with
	// `no matches for kind "ScyllaCluster"`. Name verified against the real chart
	// (scylla-operator v1.21.1 renders scyllaclusters.scylla.scylladb.com).
	//
	// `requiresCertManager` is the other half, and it is the one that took a platform decision:
	// the operator's ValidatingWebhookConfiguration is `failurePolicy: Fail` with its serving cert
	// injected by cert-manager, and this platform installs cert-manager CONDITIONALLY — on the
	// managed-certificate ask, which a project with a nosql node and no domain never makes. So the
	// spec DECLARES the dependency here and InfraFacts reads it back (webhookCAAddOns), rather
	// than Go re-deriving "hetzner + nosql" and drifting from this file (#3228).
	if (nosqlTables.length > 0) {
		specs.push({
			id: "scylla-operator",
			mode: "managed",
			chartRepo: HETZNER_CHARTS.scyllaOperator.chartRepo,
			chart: HETZNER_CHARTS.scyllaOperator.chart,
			version: HETZNER_CHARTS.scyllaOperator.version,
			namespace: NS.scyllaOperators,
			values: {},
			syncWave: 0,
			crds: ["scyllaclusters.scylla.scylladb.com"],
			requiresCertManager: true,
		});
	}
	for (const table of nosqlTables) {
		specs.push({
			id: `${HETZNER_ADDON_ID_PREFIXES.tables}${table.name}`,
			mode: "managed",
			chartRepo: HETZNER_CHARTS.scyllaCluster.chartRepo,
			chart: HETZNER_CHARTS.scyllaCluster.chart,
			version: HETZNER_CHARTS.scyllaCluster.version,
			namespace: NS.nosql,
			values: hetznerNosqlValues(table),
			syncWave: 1,
		});
	}

	// Caches → Valkey (standalone, or replication when >1 node).
	for (const cache of caches) {
		specs.push({
			id: `${HETZNER_ADDON_ID_PREFIXES.caches}${cache.name}`,
			mode: "managed",
			chartRepo: HETZNER_CHARTS.valkey.chartRepo,
			chart: HETZNER_CHARTS.valkey.chart,
			version: HETZNER_CHARTS.valkey.version,
			namespace: NS.cache,
			values: hetznerCacheValues(cache),
			syncWave: 1,
		});
	}

	// Registries → Harbor (one release per node). syncWave 2, after the data services: Harbor is
	// the heaviest thing on the cluster (five volumes, its own Postgres/Redis/Trivy) and nothing
	// else waits on it, so it converges last rather than competing for volume attachments while a
	// database is still coming up. Matches the marketplace add-on's own wave.
	for (const registry of registries) {
		specs.push({
			id: `${HETZNER_ADDON_ID_PREFIXES.registries}${registry.name}`,
			mode: "managed",
			chartRepo: HETZNER_CHARTS.harbor.chartRepo,
			chart: HETZNER_CHARTS.harbor.chart,
			version: HETZNER_CHARTS.harbor.version,
			namespace: NS.registry,
			values: hetznerRegistryValues(registry),
			syncWave: 2,
		});
	}

	// Queues → RabbitMQ (single node in v1).
	for (const queue of queues) {
		specs.push({
			id: `${HETZNER_ADDON_ID_PREFIXES.queues}${queue.name}`,
			mode: "managed",
			chartRepo: HETZNER_CHARTS.rabbitmq.chartRepo,
			chart: HETZNER_CHARTS.rabbitmq.chart,
			version: HETZNER_CHARTS.rabbitmq.version,
			namespace: NS.queue,
			values: hetznerQueueValues(queue),
			syncWave: 1,
		});
	}

	return specs;
}

/**
 * Helm values for one cache node, against the UPSTREAM valkey-io chart's REAL schema — which is
 * nothing like the Bitnami chart this replaced. Every key below was verified with
 * `helm show values` + `helm template` (a guessed mapping is how you ship a chart that silently
 * ignores your sizing, or that hard-errors at sync):
 *
 *  - `dataStorage.{enabled,requestedSize,className}` — the primary's PVC (Bitnami used
 *    `primary.persistence.{size,storageClass}`).
 *  - `replica.{enabled,replicas}` — replicas are ADDITIONAL to the primary, so N nodes ⇒
 *    `replicas: N-1` (asserted in the tests: 3 nodes renders 3 pods, not 4).
 *  - `replica.persistence.{size,storageClass}` — MANDATORY when replicas are on: the chart
 *    hard-fails with "Replica mode requires persistent storage" if it is missing. This is exactly
 *    the trap a translated-by-eye mapping falls into.
 */
export function hetznerCacheValues(
	cache: CacheInput,
): Record<string, unknown> {
	const nodes = posInt(cache.num_cache_nodes, 1);
	const storageGb = posInt(cache.storage_gb ?? cache.memory_gb, 8);
	const size = `${storageGb}Gi`;

	const values: Record<string, unknown> = {
		dataStorage: {
			enabled: true,
			requestedSize: size,
			className: HCLOUD_STORAGE_CLASS,
		},
		replica: {
			enabled: nodes > 1,
			// The primary is not a replica — N nodes ⇒ N-1 replicas.
			replicas: Math.max(0, nodes - 1),
			// Required whenever replica.enabled: the chart refuses to render without it. Same
			// volume size as the primary so "N GiB per node" stays true.
			persistence: { size, storageClass: HCLOUD_STORAGE_CLASS },
		},
	};
	if (cache.engine_version) {
		values.image = { tag: cache.engine_version };
	}
	return values;
}

/**
 * The in-cluster DNS name a `registry` node's Harbor answers on. Exported because it is the
 * registry HOST — it goes into `externalURL`, into the dockerconfigjson the runner seeds, and into
 * the Talos containerd mirror entry, and those three MUST agree or the pull fails in a way that
 * looks like a credential problem.
 */
export function hetznerRegistryHost(name: string): string {
	return `registry-${name}.${NS.registry}.svc.cluster.local`;
}

/**
 * Helm values for one registry node, against the pinned Harbor chart's REAL schema — verified with
 * `helm show values` + `helm template harbor --version 1.15.1`, never guessed. #2058 is why:
 * self-contradictory values render NO manifest at all, and ArgoCD then reports `sync=Unknown`
 * rather than `OutOfSync`, so the failure is invisible.
 *
 *  - `expose.type: clusterIP` with `tls.enabled: false`. NOT `ingress`, the chart default: an
 *    ingress needs an ingress controller AND a resolvable host, and the chart's default host
 *    (`core.harbor.domain`) resolves nowhere — a registry reachable at an address that does not
 *    exist is not a registry. A canvas `registry` node carries no domain, so the cluster network
 *    is the only address it truly has.
 *  - `expose.clusterIP.name` fixes the Service name, so the host is derivable rather than a
 *    function of the Helm release name.
 *  - `externalURL` must agree with how the chart is exposed; Harbor bakes it into the tokens it
 *    issues, so a mismatch yields a registry that authenticates and then 401s on every pull.
 *  - all FIVE volumes are pinned to the hcloud StorageClass at >= 10 GiB. Harbor ships its own
 *    Postgres, Redis and Trivy; the chart's 1Gi/1Gi/5Gi defaults for those are below hcloud's
 *    minimum volume size, so the CSI driver rounds them up and the cluster's actual footprint
 *    stops matching what this repo asked for.
 */
export function hetznerRegistryValues(
	registry: RegistryInput,
): Record<string, unknown> {
	const host = hetznerRegistryHost(registry.name);
	// The image store is the only user-tunable volume; hcloud's floor applies to it too.
	const imageStore = `${Math.max(posInt(registry.storage_gb, 50), HCLOUD_MIN_VOLUME_GB)}Gi`;
	const supporting = {
		size: `${HCLOUD_MIN_VOLUME_GB}Gi`,
		storageClass: HCLOUD_STORAGE_CLASS,
	};
	const credentialSecret = `harbor-${registry.name}-admin`;
	return {
		// The admin password comes from a Secret the RUNNER seeds and never from a literal here:
		// values are snapshot-persisted and reach the customer's cluster through a rendered
		// manifest. Without these two keys the chart falls back to its published default
		// (`harborAdminPassword: "Harbor12345"`) — which is what #2430 shipped, and what #2431 fixes.
		// The names must match packages/core/argocd/harbor.go exactly; a mismatch is silent.
		existingSecretAdminPassword: credentialSecret,
		existingSecretAdminPasswordKey: "HARBOR_ADMIN_PASSWORD",
		existingSecretSecretKey: credentialSecret,
		core: {
			existingSecret: credentialSecret,
			existingXsrfSecret: credentialSecret,
			existingXsrfSecretKey: "CSRF_KEY",
			secretName: credentialSecret,
		},
		jobservice: {
			existingSecret: credentialSecret,
			existingSecretKey: "JOBSERVICE_SECRET",
		},
		registry: {
			existingSecret: credentialSecret,
			existingSecretKey: "REGISTRY_HTTP_SECRET",
			credentials: {
				existingSecret: credentialSecret,
				// STATED, not inherited. The runner hashes this exact name into REGISTRY_HTPASSWD
				// (harborRegistryUsername in packages/core/argocd/harbor.go) and Harbor core
				// authenticates to the internal registry as whoever the chart names here. Leaving it
				// to the chart's default meant the two agreed only by coincidence: a rename upstream
				// would 401 every core->registry request while every pod reported Ready. The value is
				// deliberately identical to the chart's default, so the render is byte-for-byte
				// unchanged and this costs nothing but the correspondence.
				username: "harbor_registry_user",
			},
		},
		expose: {
			type: "clusterIP",
			tls: { enabled: false },
			clusterIP: { name: `registry-${registry.name}` },
		},
		externalURL: `http://${host}`,
		// RECREATE, NOT ROLLINGUPDATE. Harbor's `registry` and `jobservice` Deployments own
		// persistent volumes, and hcloud-volumes — like every cloud's default block storage — is
		// ReadWriteOnce. On RollingUpdate the new pod is scheduled BEFORE the old one is torn down,
		// so it waits for a volume the old pod still holds while the old pod waits for the new one
		// to become ready: a permanent deadlock, and the Application sits Degraded.
		//
		// Measured on hetzner/maxconfig run 33244231777, which FAILED on exactly this:
		//
		//   addon-registry-app-images-harbor-registry-7dfb9f9796-td9jm   Running   true,true
		//   addon-registry-app-images-harbor-registry-6cbf58965c-dktzc   Pending   ContainerCreating
		//     Warning FailedAttachVolume  Multi-Attach error for volume "pvc-f05b7576-…"
		//             Volume is already used by pod(s) …-harbor-registry-7dfb9f9796-td9jm
		//
		// The chart's own values file says it: "Set it as Recreate when RWM for volumes isn't
		// supported" — and RWM needs NFS/EFS/Filestore, which Hetzner does not provision.
		//
		// The marketplace `harbor` add-on has carried this since #2823; THIS renderer did not, and
		// that gap is the whole defect. Two places render the same chart and only one of them knew.
		// tests/lib/cloud-providers/hetzner-services.test.ts now asserts it over both.
		updateStrategy: { type: "Recreate" },
		persistence: {
			persistentVolumeClaim: {
				registry: { size: imageStore, storageClass: HCLOUD_STORAGE_CLASS },
				jobservice: { jobLog: supporting },
				database: supporting,
				redis: supporting,
				trivy: supporting,
			},
		},
	};
}

/**
 * The add-on id of the project's single platform Vault, and therefore — through
 * `argocd.AddOnAppName` — the ArgoCD Application name AND the Helm release name ArgoCD syncs under.
 *
 * ⚠️ The release name is what the chart names its Service (`vault.fullname` is `.Release.Name`), so
 * this id, the namespace, and `hetznerVaultReleaseHost` in packages/core/argocd/vault.go are ONE
 * fact spelled in two languages. The Go test reads it back out of the generated fixture rather than
 * trusting a copy: a drifted host does not error, it resolves nowhere, and the only symptom is a
 * ClusterSecretStore that is simply never Valid.
 */
export const HETZNER_VAULT_ADDON_ID = "secrets-vault";

/**
 * The in-cluster address the platform Vault answers on — the bootstrap Job's api-base and ESO's
 * `server` are both this one address.
 *
 * That they CAN be one address is a property of the chart, not an assumption: its Service sets
 * `publishNotReadyAddresses: true` (verified in the rendered manifest). A sealed Vault fails its
 * readiness probe — `vault status` exits 2 when sealed — so an ordinary Service would carry no
 * endpoints and the bootstrap Job could never reach the very Vault it exists to unseal.
 */
export function hetznerVaultHost(): string {
	return `addon-${HETZNER_VAULT_ADDON_ID}.${NS.secret}.svc.cluster.local`;
}

/**
 * Helm values for the platform Vault, against the pinned chart's REAL schema — verified with
 * `helm show values` + `helm template vault --version 0.28.1`, never guessed.
 *
 *  - `injector.enabled: false`. The Agent sidecar injector is a SECOND delivery path for the same
 *    secrets, carrying a mutating webhook that sits in front of every pod admission in the cluster.
 *    Secrets reach workloads through ESO here, exactly as on the other four clouds; installing a
 *    rival path would be two answers to one question.
 *  - `ui.enabled: false`. The UI is a login surface for a Vault whose only legitimate client is
 *    ESO, and the platform holds the root credential — there is no human meant to log in.
 *  - `server.standalone.enabled: true` / `server.ha.enabled: false`. Raft HA means three replicas,
 *    three volumes and an unseal apiece; one node is what this seal model can actually operate, and
 *    pretending otherwise would ship an HA cluster that stays two-thirds sealed.
 *  - `server.dataStorage` is the KV store; `server.auditStorage` backs the audit device. Audit is
 *    on deliberately: an audit log of every read is the ONLY thing this Vault buys over a plain
 *    Kubernetes Secret (see the custody note in packages/core/argocd/vault.go), so shipping it
 *    without one would make that claim false. Both are pinned to hcloud's StorageClass at its
 *    10 GiB minimum — which is what the CSI driver rounds anything smaller up to anyway.
 */
export function hetznerVaultValues(): Record<string, unknown> {
	const volume = {
		enabled: true,
		size: `${HCLOUD_MIN_VOLUME_GB}Gi`,
		storageClass: HCLOUD_STORAGE_CLASS,
	};
	return {
		injector: { enabled: false },
		ui: { enabled: false },
		server: {
			standalone: { enabled: true },
			ha: { enabled: false },
			dataStorage: volume,
			auditStorage: volume,
		},
	};
}

/**
 * Helm values for one queue node. The chart pulls the OFFICIAL upstream `docker.io/rabbitmq`
 * image (digest-pinned by the chart), not a Bitnami image — the previous `bitnami/rabbitmq`
 * chart's default image tag is now HTTP 404 (Broadcom relocated it to `bitnamilegacy/*`), so
 * every fresh Hetzner queue ImagePullBackOff'd. Keys verified with `helm template`.
 *
 * THE AUTH BLOCK IS WHAT KEEPS THE RELEASE STABLE (#3304). Left alone, this chart mints BOTH
 * `auth.password` and `auth.erlangCookie` at RENDER time, so every render produces a different
 * Secret: the Application is permanently OutOfSync and, with selfHeal on, rewrites both forever.
 * Neither value tolerates that. The erlang cookie is the cluster's shared secret — rotating it
 * partitions the nodes, which then refuse to re-form — and the password is the credential the
 * customer's `queue` binding already handed to their application.
 *
 * So the RUNNER mints both ONCE into this Secret and the chart only reads them. The name must
 * match HetznerQueue.CredentialSecretName in packages/core/argocd/rabbitmq.go exactly; a
 * mismatch is silent, and shows up as a pod that cannot start.
 */
export function hetznerQueueValues(
	queue: QueueInput,
): Record<string, unknown> {
	const persistence = {
		enabled: true,
		size: `${posInt(queue.storage_gb, 8)}Gi`,
		storageClass: HCLOUD_STORAGE_CLASS,
	};
	// A NAME THE RUNNER CANNOT SEED KEEPS THE CHART'S OWN MINTING, deliberately. `HetznerQueues`
	// (packages/core/argocd/rabbitmq.go) refuses anything that is not an RFC-1123 LABEL, because the
	// names it derives interpolate into kubectl commands. `orders.v2` is a name Kubernetes accepts
	// and that predicate does not: pointing the chart at a Secret the runner will never write turns a
	// queue that runs — badly, rotating its credentials — into one that never starts at all.
	//
	// So the fix applies to the names it can actually fix, and everything else is left exactly as it
	// was. The console refuses such names at the form now (#3588); this branch exists for the rows
	// that were saved before it did.
	if (!DNS_1123_LABEL_RE.test(queue.name)) {
		return { replicaCount: 1, persistence };
	}
	return {
		replicaCount: 1,
		auth: {
			existingSecret: `rabbitmq-${queue.name}-credentials`,
			// The two key names are the chart's own defaults, RESTATED rather than inherited: the
			// runner writes exactly these keys, and a default is a thing upstream may rename.
			existingPasswordKey: "password",
			existingErlangCookieKey: "erlang-cookie",
			// STATED for the same reason as harbor's registry.credentials.username above: the
			// password the runner mints belongs to ONE user, and if the chart names a different one
			// the two agree only by coincidence. Deliberately the chart's current default, so the
			// render is unchanged apart from the Secret it no longer mints.
			username: "admin",
		},
		persistence,
	};
}

/**
 * Helm values for one topic node — a NATS server with JetStream file storage.
 *
 * JetStream is ON deliberately. Core NATS delivers a subject to whoever is connected and forgets
 * it; SNS, Pub/Sub and Service Bus all retain until delivery, so a topic that dropped every
 * message on a pod restart would be a different product wearing the same name. File storage is
 * sized from the node's `storage_gb` and clamped to hcloud's 10 GiB minimum volume.
 *
 * Keys verified against `helm show values nats/nats --version 2.14.6`, never guessed — the chart
 * nests persistence under `jetstream.fileStore.pvc`, which is not where the older 0.x charts (or
 * any Bitnami repackage) put it.
 */
export function hetznerTopicValues(topic: TopicInput): Record<string, unknown> {
	return {
		config: {
			jetstream: {
				enabled: true,
				fileStore: {
					enabled: true,
					pvc: {
						enabled: true,
						size: `${Math.max(posInt(topic.storage_gb, HCLOUD_MIN_VOLUME_GB), HCLOUD_MIN_VOLUME_GB)}Gi`,
						storageClassName: HCLOUD_STORAGE_CLASS,
					},
				},
			},
		},
	};
}

/**
 * Helm values for one nosql node — a single-rack ScyllaCluster with the DynamoDB-compatible
 * Alternator API enabled.
 *
 * THREE chart defaults have to be overridden here, and each one is a cluster that does not start
 * if it is left alone:
 *
 *  1. `alternator.enabled` is FALSE by default. It is the entire reason this chart backs the
 *     `nosql` kind — without it Scylla speaks CQL only, and the kind's DynamoDB-shaped model
 *     (partition key + sort key) would need a translation layer this repo would then own.
 *  2. `racks[].storage.storageClassName` defaults to `scylladb-local-xfs`, which does not exist on
 *     a Hetzner/Talos cluster. It becomes the hcloud CSI class, like every other volume here.
 *  3. `racks[].placement` defaults to a REQUIRED nodeAffinity on
 *     `scylla.scylladb.com/node-type=scylla` plus a matching toleration — that is ScyllaDB's
 *     dedicated-node-pool topology. On a general-purpose Hetzner cluster no node carries that
 *     label, so every Scylla pod would sit Pending forever while the Application reported
 *     Progressing. `placement` is therefore cleared rather than inherited.
 */
export function hetznerNosqlValues(table: NosqlInput): Record<string, unknown> {
	return {
		alternator: { enabled: true, insecureEnableHTTP: true, writeIsolation: "always" },
		developerMode: true,
		cpuset: false,
		datacenter: "hetzner",
		racks: [
			{
				name: "rack-1",
				members: posInt(table.replicas, 1),
				storage: {
					storageClassName: HCLOUD_STORAGE_CLASS,
					capacity: `${Math.max(posInt(table.storage_gb, HCLOUD_MIN_VOLUME_GB), HCLOUD_MIN_VOLUME_GB)}Gi`,
				},
				resources: {
					limits: { cpu: 1, memory: "2Gi" },
					requests: { cpu: "500m", memory: "1Gi" },
				},
				placement: {},
			},
		],
	};
}
