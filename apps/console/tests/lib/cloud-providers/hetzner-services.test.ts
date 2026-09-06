// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Hetzner in-cluster data services: canvas database/cache/queue nodes map to Helm install
// specs (CloudNativePG / Valkey / RabbitMQ). These pin the user-tunable sizing path — the
// optional `storage_gb`/`replicas` columns flow into the chart values, NULL keeps the
// mapper defaults authoritative, and a cache's explicit storage wins over memory_gb.

import { describe, expect, it } from "vitest";
import {
	HETZNER_CHARTS,
	HETZNER_VAULT_ADDON_ID,
	hetznerDataServicesToAddOns,
	hetznerRegistryHost,
	hetznerVaultHost,
} from "@/lib/cloud-providers/hetzner-services";

/**
 * Walks a decoded values tree by path, narrowing at every step. Used instead of chained `as` casts,
 * which this repo's lint refuses (consistent-type-assertions) — and which would tell the compiler
 * the shape is right rather than asking it, in a file whose whole job is to check the shape.
 */
function at(obj: unknown, ...path: string[]): Record<string, unknown> {
	let cur: unknown = obj;
	for (const key of path) {
		if (typeof cur !== "object" || cur === null || !(key in cur)) {
			throw new Error(`values path ${path.join(".")} stops at ${key}`);
		}
		cur = Object.getOwnPropertyDescriptor(cur, key)?.value;
	}
	if (typeof cur !== "object" || cur === null) {
		throw new Error(`values path ${path.join(".")} is not an object`);
	}
	return { ...cur };
}

/** One scalar at a values path (the leaf's own key), narrowed the same way. */
function leaf(obj: unknown, ...path: string[]): unknown {
	const key = path[path.length - 1];
	return at(obj, ...path.slice(0, -1))[key];
}

/** Narrow a spec's `values` for nested reads without repeating casts in every test. */
function values(spec: { values?: Record<string, unknown> } | undefined) {
	return (spec?.values ?? {}) as Record<string, Record<string, unknown>>;
}

describe("hetznerDataServicesToAddOns — databases (CloudNativePG)", () => {
	it("applies defaults (10Gi / 1 instance) when sizing is NULL", () => {
		const specs = hetznerDataServicesToAddOns({
			databases: [{ name: "primary", storage_gb: null, replicas: null }],
		});
		const db = specs.find((s) => s.id === "db-primary");
		const cluster = values(db).cluster;
		expect(cluster.instances).toBe(1);
		expect(cluster.storage).toMatchObject({ size: "10Gi" });
	});

	it("flows explicit storage_gb and replicas into the Cluster values", () => {
		const specs = hetznerDataServicesToAddOns({
			databases: [{ name: "primary", storage_gb: 50, replicas: 3 }],
		});
		const cluster = values(specs.find((s) => s.id === "db-primary")).cluster;
		expect(cluster.instances).toBe(3);
		expect(cluster.storage).toMatchObject({ size: "50Gi" });
	});

	it("installs the CNPG operator once (sync-wave 0) when any Postgres DB exists", () => {
		const specs = hetznerDataServicesToAddOns({
			databases: [{ name: "a" }, { name: "b" }],
		});
		const operators = specs.filter((s) => s.id === "cnpg-operator");
		expect(operators).toHaveLength(1);
		expect(operators[0].syncWave).toBe(0);
		expect(operators[0].chart).toBe(HETZNER_CHARTS.cnpgOperator.chart);
	});

	it("clamps invalid sizing (negatives / NaN / floats) via posInt", () => {
		const specs = hetznerDataServicesToAddOns({
			databases: [
				{ name: "neg", storage_gb: -5, replicas: 0 },
				{ name: "nan", storage_gb: Number.NaN, replicas: Number.NaN },
				{ name: "frac", storage_gb: 20.9, replicas: 2.7 },
			],
		});
		expect(values(specs.find((s) => s.id === "db-neg")).cluster).toMatchObject({
			instances: 1,
			storage: expect.objectContaining({ size: "10Gi" }),
		});
		expect(values(specs.find((s) => s.id === "db-nan")).cluster).toMatchObject({
			instances: 1,
			storage: expect.objectContaining({ size: "10Gi" }),
		});
		// Fractional inputs floor rather than round.
		expect(values(specs.find((s) => s.id === "db-frac")).cluster).toMatchObject({
			instances: 2,
			storage: expect.objectContaining({ size: "20Gi" }),
		});
	});
});

// The cache chart moved from Bitnami (whose valkey 1.0.6 was DELETED from the index — ArgoCD
// could not fetch it, so Hetzner caches were broken in prod) to the UPSTREAM valkey-io chart.
// Its value schema is completely different, so these assertions are written against the keys the
// real chart actually reads (verified with `helm show values` + `helm template`) — a mapping
// translated by eye ships a chart that silently ignores sizing, or hard-fails at sync.
describe("hetznerDataServicesToAddOns — caches (Valkey, upstream valkey-io chart)", () => {
	it("targets the upstream valkey-io chart, not Bitnami", () => {
		const specs = hetznerDataServicesToAddOns({ caches: [{ name: "primary" }] });
		const spec = specs.find((s) => s.id === "cache-primary");
		expect(spec?.chartRepo).toBe("https://valkey-io.github.io/valkey-helm");
		expect(spec?.chartRepo).not.toContain("bitnami");
	});

	it("explicit storage_gb wins over the memory_gb fallback (dataStorage.requestedSize)", () => {
		const specs = hetznerDataServicesToAddOns({
			caches: [{ name: "primary", memory_gb: 4, storage_gb: 32 }],
		});
		const v = values(specs.find((s) => s.id === "cache-primary"));
		expect(v.dataStorage).toMatchObject({
			enabled: true,
			requestedSize: "32Gi",
			className: "hcloud-volumes",
		});
	});

	it("uses the chart's REAL storage keys (dataStorage.requestedSize/className)", () => {
		const specs = hetznerDataServicesToAddOns({
			caches: [{ name: "primary", storage_gb: 32 }],
		});
		const v = values(specs.find((s) => s.id === "cache-primary"));
		const ds = v.dataStorage as Record<string, unknown>;
		// The Bitnami keys are gone — asserting their ABSENCE is what keeps a future edit from
		// silently reintroducing values this chart ignores.
		expect(v).not.toHaveProperty("primary");
		expect(v).not.toHaveProperty("architecture");
		expect(ds).not.toHaveProperty("size");
		expect(ds).not.toHaveProperty("storageClass");
		expect(ds.requestedSize).toBe("32Gi");
		expect(ds.className).toBe("hcloud-volumes");
	});

	it("replicas are ADDITIONAL to the primary (N nodes ⇒ N-1 replicas) and carry mandatory persistence", () => {
		const specs = hetznerDataServicesToAddOns({
			caches: [{ name: "primary", storage_gb: 32, num_cache_nodes: 3 }],
		});
		const replica = values(specs.find((s) => s.id === "cache-primary"))
			.replica as Record<string, unknown>;
		expect(replica.enabled).toBe(true);
		// 3 nodes = 1 primary + 2 replicas. (Bitnami's key was `replicaCount`.)
		expect(replica.replicas).toBe(2);
		// MANDATORY when replicas are on: the chart hard-errors with "Replica mode requires
		// persistent storage" without it — the exact trap a guessed mapping falls into.
		expect(replica.persistence).toMatchObject({
			size: "32Gi",
			storageClass: "hcloud-volumes",
		});
	});

	it("a single-node cache disables replication (no replica StatefulSet)", () => {
		const specs = hetznerDataServicesToAddOns({
			caches: [{ name: "solo", storage_gb: 8 }],
		});
		const replica = values(specs.find((s) => s.id === "cache-solo"))
			.replica as Record<string, unknown>;
		expect(replica.enabled).toBe(false);
		expect(replica.replicas).toBe(0);
	});

	it("falls back to memory_gb, then the 8Gi default", () => {
		const specs = hetznerDataServicesToAddOns({
			caches: [{ name: "mem", memory_gb: 4 }, { name: "bare" }],
		});
		expect(values(specs.find((s) => s.id === "cache-mem")).dataStorage).toMatchObject(
			{ requestedSize: "4Gi" },
		);
		expect(values(specs.find((s) => s.id === "cache-bare")).dataStorage).toMatchObject(
			{ requestedSize: "8Gi" },
		);
	});
});

describe("hetznerDataServicesToAddOns — queues (RabbitMQ)", () => {
	it("applies the 8Gi default and flows explicit storage_gb", () => {
		const specs = hetznerDataServicesToAddOns({
			queues: [{ name: "jobs" }, { name: "big", storage_gb: 64 }],
		});
		expect(values(specs.find((s) => s.id === "queue-jobs")).persistence)
			.toMatchObject({ size: "8Gi" });
		expect(values(specs.find((s) => s.id === "queue-big")).persistence)
			.toMatchObject({ size: "64Gi" });
	});

	it("uses the chart's `persistence.storageClass` key (NOT the k8s storageClassName)", () => {
		const specs = hetznerDataServicesToAddOns({ queues: [{ name: "jobs" }] });
		const persistence = values(specs.find((s) => s.id === "queue-jobs")).persistence;
		expect(persistence.enabled).toBe(true);
		expect(persistence.storageClass).toBe("hcloud-volumes");
		expect(persistence).not.toHaveProperty("storageClassName");
	});

	// bitnami/rabbitmq 14.7.0's default image (docker.io/bitnami/rabbitmq:3.13.7-debian-12-r2) is
	// now HTTP 404 — Broadcom relocated the Bitnami images to bitnamilegacy/* — so every fresh
	// Hetzner queue ImagePullBackOff'd. The replacement chart pulls the OFFICIAL docker.io/rabbitmq
	// image. Guard the repo so nobody drifts back onto the archive.
	it("does NOT use a Bitnami chart (its images were relocated and 404)", () => {
		const specs = hetznerDataServicesToAddOns({ queues: [{ name: "jobs" }] });
		const spec = specs.find((s) => s.id === "queue-jobs");
		expect(spec?.chartRepo).not.toContain("bitnami");
		expect(spec?.chartRepo).toBe("https://cloudpirates-io.github.io/helm-charts");
	});
});

describe("hetznerDataServicesToAddOns — engine filtering (databases)", () => {
	it("charts only postgres-family databases (NULL family defaults to postgres)", () => {
		const specs = hetznerDataServicesToAddOns({
			databases: [
				{ name: "pg", engine_family: "postgres" },
				{ name: "legacy", engine_family: null },
				{ name: "my", engine_family: "mysql" },
			],
		});
		expect(specs.some((s) => s.id === "db-pg")).toBe(true);
		expect(specs.some((s) => s.id === "db-legacy")).toBe(true);
		// The mapper drops it — buildConfigSnapshot's fail-closed gate must throw first.
		expect(specs.some((s) => s.id === "db-my")).toBe(false);
	});
});

describe("hetznerDataServicesToAddOns — registries (Harbor)", () => {
	const specsFor = (registries: { name: string; storage_gb?: number }[]) =>
		hetznerDataServicesToAddOns({ registries });
	const specOf = (registries: { name: string; storage_gb?: number }[], id: string) =>
		specsFor(registries).find((s) => s.id === id);

	it("charts one Harbor release per registry node, at sync-wave 2", () => {
		const harbor = specsFor([{ name: "app-images" }, { name: "base" }]).filter(
			(s) => s.chart === "harbor",
		);
		expect(harbor.map((s) => s.id)).toEqual([
			"registry-app-images",
			"registry-base",
		]);
		for (const spec of harbor) {
			expect(spec.chartRepo).toBe("https://helm.goharbor.io");
			expect(spec.namespace).toBe("registries");
			// After the data services: Harbor is five volumes plus its own Postgres/Redis/Trivy, and
			// nothing else waits on it.
			expect(spec.syncWave).toBe(2);
		}
	});

	it("EVERY renderer of the harbor chart sets updateStrategy Recreate", async () => {
		// Harbor's `registry` and `jobservice` Deployments own persistent volumes, and every cloud's
		// default block storage is ReadWriteOnce. RollingUpdate schedules the new pod before tearing
		// the old one down, so it blocks on a volume the old pod holds — a permanent deadlock the
		// Application reports as Degraded.
		//
		// hetzner/maxconfig run 33244231777 died on it:
		//   Warning FailedAttachVolume  Multi-Attach error for volume "pvc-f05b7576-…"
		//           Volume is already used by pod(s) …-harbor-registry-7dfb9f9796-td9jm
		//
		// The marketplace add-on has set Recreate since #2823. hetznerRegistryValues did not, and
		// nothing compared them — TWO RENDERERS OF ONE CHART, ONE OF THEM FIXED. So this asserts
		// over every renderer there is, and derives the registry-node half from the generated specs
		// rather than calling hetznerRegistryValues directly: a spec that stopped carrying the
		// values would pass a direct call and fail here, which is the way round that matters.
		const { ADDON_CATALOG } = await import("@/lib/addons/catalog");
		const marketplace = ADDON_CATALOG.find((a) => a.id === "harbor");
		expect(marketplace).toBeDefined();

		const renderers: Array<{ what: string; values: unknown }> = [
			...specsFor([{ name: "app-images" }, { name: "base" }])
				.filter((s) => s.chart === "harbor")
				.map((s) => ({ what: `the \`registry\` node ${s.id}`, values: s.values })),
			{
				what: "the harbor marketplace add-on",
				values: marketplace?.defaultValues,
			},
		];
		// A guard whose "nothing found" branch is indistinguishable from "nothing wrong" is not a
		// guard: two registry nodes plus the add-on is three, and finding fewer means this stopped
		// looking rather than started passing.
		expect(renderers).toHaveLength(3);

		for (const r of renderers) {
			const values = r.values as { updateStrategy?: { type?: string } } | undefined;
			expect(
				values?.updateStrategy?.type,
				`${r.what} renders harbor with updateStrategy ${JSON.stringify(values?.updateStrategy)} — RollingUpdate deadlocks on ReadWriteOnce storage`,
			).toBe("Recreate");
		}
	});

	it("pins the SAME chart version as the harbor marketplace add-on", async () => {
		// Two Harbor versions in one cluster is what a Hetzner project that ALSO enables the
		// marketplace add-on would get, and nothing else in the tree would notice.
		const { ADDON_CATALOG } = await import("@/lib/addons/catalog");
		const marketplace = ADDON_CATALOG.find((a) => a.id === "harbor");
		expect(marketplace).toBeDefined();
		expect(HETZNER_CHARTS.harbor.version).toBe(marketplace?.version);
		expect(HETZNER_CHARTS.harbor.chartRepo).toBe(marketplace?.chartRepo);
	});

	it("exposes clusterIP with TLS off — NOT the chart's default ingress", () => {
		// The chart defaults to `expose.type: ingress` at host `core.harbor.domain`, which resolves
		// nowhere. A canvas registry node carries no domain, so the cluster network is the only
		// address it actually has.
		const spec = specOf([{ name: "app-images" }], "registry-app-images");
		expect(leaf(spec?.values, "expose", "type")).toBe("clusterIP");
		expect(leaf(spec?.values, "expose", "tls", "enabled")).toBe(false);
		expect(leaf(spec?.values, "expose", "clusterIP", "name")).toBe(
			"registry-app-images",
		);
	});

	it("agrees with hetznerRegistryHost on the externalURL", () => {
		// Harbor bakes externalURL into the tokens it issues, so a host that disagrees with the
		// Service name authenticates and then 401s on every pull. The runner's dockerconfigjson and
		// the Talos containerd mirror read the same helper.
		expect(hetznerRegistryHost("app-images")).toBe(
			"registry-app-images.registries.svc.cluster.local",
		);
		const spec = specOf([{ name: "app-images" }], "registry-app-images");
		expect(spec?.values.externalURL).toBe(
			`http://${hetznerRegistryHost("app-images")}`,
		);
	});

	it("references every Harbor credential through the runner-seeded Secret", () => {
		const spec = specOf([{ name: "app-images" }], "registry-app-images");
		const secret = "harbor-app-images-admin";
		expect(leaf(spec?.values, "existingSecretAdminPassword")).toBe(secret);
		expect(leaf(spec?.values, "existingSecretAdminPasswordKey")).toBe(
			"HARBOR_ADMIN_PASSWORD",
		);
		expect(leaf(spec?.values, "existingSecretSecretKey")).toBe(secret);
		expect(leaf(spec?.values, "core", "existingSecret")).toBe(secret);
		expect(leaf(spec?.values, "core", "existingXsrfSecret")).toBe(secret);
		expect(leaf(spec?.values, "core", "existingXsrfSecretKey")).toBe("CSRF_KEY");
		expect(leaf(spec?.values, "core", "secretName")).toBe(secret);
		expect(leaf(spec?.values, "jobservice", "existingSecret")).toBe(secret);
		expect(leaf(spec?.values, "jobservice", "existingSecretKey")).toBe(
			"JOBSERVICE_SECRET",
		);
		expect(leaf(spec?.values, "registry", "existingSecret")).toBe(secret);
		expect(leaf(spec?.values, "registry", "existingSecretKey")).toBe(
			"REGISTRY_HTTP_SECRET",
		);
		expect(
			leaf(spec?.values, "registry", "credentials", "existingSecret"),
		).toBe(secret);
		// The one half that is NOT a secret reference, and the one that fails silently: the runner
		// hashes this exact name into REGISTRY_HTPASSWD, and Harbor core authenticates to the
		// internal registry as whoever this names. Inherited from the chart they agreed only by
		// coincidence — an upstream rename 401s every core->registry request with all pods Ready.
		expect(
			leaf(spec?.values, "registry", "credentials", "username"),
		).toBe("harbor_registry_user");
	});

	it("pins ALL FIVE volumes to the hcloud StorageClass, never the cluster default", () => {
		// Harbor ships its own Postgres, Redis and Trivy. Leaving four of the five unset works only
		// while hcloud-volumes happens to be the cluster's default StorageClass.
		const v = specOf([{ name: "app-images" }], "registry-app-images")?.values;
		const claims = [
			["registry"],
			["jobservice", "jobLog"],
			["database"],
			["redis"],
			["trivy"],
		];
		for (const claim of claims) {
			expect(
				leaf(v, "persistence", "persistentVolumeClaim", ...claim, "storageClass"),
			).toBe("hcloud-volumes");
		}
	});

	it("never asks for a volume below hcloud's 10 GiB minimum", () => {
		// The chart defaults database/redis/jobLog to 1Gi. hcloud's minimum volume is 10 GiB, so the
		// CSI driver rounds them up and the cluster quietly stops matching what this repo rendered —
		// a divergence, not an error, which is why it needs a test rather than a stack trace.
		const v = specOf([{ name: "small", storage_gb: 2 }], "registry-small")?.values;
		for (const claim of [
			["registry"],
			["jobservice", "jobLog"],
			["database"],
			["redis"],
			["trivy"],
		]) {
			const size = leaf(v, "persistence", "persistentVolumeClaim", ...claim, "size");
			expect(Number.parseInt(String(size), 10)).toBeGreaterThanOrEqual(10);
		}
		// An explicit 2 GiB is CLAMPED, not honoured.
		expect(
			leaf(v, "persistence", "persistentVolumeClaim", "registry", "size"),
		).toBe("10Gi");
	});

	it("defaults the image store to 50Gi and honours a storage_gb above the floor", () => {
		const sizeOf = (name: string, storage_gb?: number) =>
			leaf(
				specOf([{ name, storage_gb }], `registry-${name}`)?.values,
				"persistence",
				"persistentVolumeClaim",
				"registry",
				"size",
			);
		expect(sizeOf("app-images")).toBe("50Gi");
		expect(sizeOf("big", 500)).toBe("500Gi");
	});

	it("charts nothing when the project declares no registry", () => {
		const specs = hetznerDataServicesToAddOns({ databases: [{ name: "db" }] });
		expect(specs.some((s) => s.chart === "harbor")).toBe(false);
	});
});

describe("hetznerDataServicesToAddOns — secrets (in-cluster Vault)", () => {
	const vaultSpecs = (names: string[]) =>
		hetznerDataServicesToAddOns({
			secrets: names.map((name) => ({ name })),
		}).filter((s) => s.chart === "vault");

	// THE property that distinguishes a `secret` node from every other kind in this mapper: it is a
	// KV entry, not a server. One release per PROJECT, however many secrets — N releases would be N
	// Vaults, of which N-1 are unseeded, unreferenced, and each holding two 10 GiB volumes.
	it("renders exactly ONE release however many secrets the project declares", () => {
		expect(vaultSpecs(["api-key"])).toHaveLength(1);
		expect(vaultSpecs(["api-key", "signing-key", "webhook-secret"])).toHaveLength(1);
	});

	it("charts nothing when the project declares no secret", () => {
		expect(vaultSpecs([])).toHaveLength(0);
		// A Vault nobody asked for costs two volumes and an audit surface for nothing.
		expect(
			hetznerDataServicesToAddOns({ databases: [{ name: "db" }] }).some(
				(s) => s.chart === "vault",
			),
		).toBe(false);
	});

	// The host is DERIVED from the id and namespace, not chosen: the vault chart names its Service
	// after the Helm release, and ArgoCD's release name is `addon-` + the spec id. Go's
	// hetznerVaultReleaseHost must equal this, and a drift resolves nowhere rather than erroring.
	it("derives the host from the install spec ArgoCD will actually sync", () => {
		const [spec] = vaultSpecs(["api-key"]);
		expect(spec.id).toBe(HETZNER_VAULT_ADDON_ID);
		expect(hetznerVaultHost()).toBe(
			`addon-${spec.id}.${spec.namespace}.svc.cluster.local`,
		);
		// NOT the marketplace add-on's id or namespace — a project may run both, and the platform's
		// Vault is the one whose unseal key Alethia holds.
		expect(spec.id).not.toBe("vault");
		expect(spec.namespace).not.toBe("vault");
	});

	it("converges first, before anything that would read a secret out of it", () => {
		expect(vaultSpecs(["api-key"])[0].syncWave).toBe(0);
	});

	it("pins the same chart as the marketplace add-on, so one cluster cannot run two versions", () => {
		const [spec] = vaultSpecs(["api-key"]);
		expect(spec.chartRepo).toBe(HETZNER_CHARTS.vault.chartRepo);
		expect(spec.version).toBe(HETZNER_CHARTS.vault.version);
	});

	// Each of these is a value whose default would ship something we do not mean, verified against
	// `helm template` rather than guessed.
	it("disables the injector and the UI, stays standalone, and pins both volumes", () => {
		const v = values(vaultSpecs(["api-key"])[0]);
		// A second delivery path for the same secrets, behind a mutating webhook in front of every
		// pod admission in the cluster. ESO is the path; there is not a second one.
		expect(leaf(v, "injector", "enabled")).toBe(false);
		// A login surface for a Vault whose only legitimate client is ESO.
		expect(leaf(v, "ui", "enabled")).toBe(false);
		// Raft HA is three replicas needing three unseals; this seal model operates one node.
		expect(leaf(v, "server", "standalone", "enabled")).toBe(true);
		expect(leaf(v, "server", "ha", "enabled")).toBe(false);
		for (const store of ["dataStorage", "auditStorage"]) {
			expect(leaf(v, "server", store, "enabled")).toBe(true);
			// hcloud's minimum volume is 10 GiB; asking for less is silently rounded up, so the
			// cluster would stop matching the values this repo rendered.
			expect(leaf(v, "server", store, "size")).toBe("10Gi");
			expect(leaf(v, "server", store, "storageClass")).toBe("hcloud-volumes");
		}
	});

	// The audit device is the ONLY thing this Vault buys over a plain Kubernetes Secret — the unseal
	// key lives in the same etcd either way. Shipping it with audit storage off would make the claim
	// that justifies the whole feature false.
	it("provisions the audit volume the custody claim depends on", () => {
		expect(leaf(values(vaultSpecs(["api-key"])[0]), "server", "auditStorage", "enabled")).toBe(
			true,
		);
	});
});
