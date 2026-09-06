// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Go e2e harness seeds Hetzner's three in-cluster data services (CloudNativePG / Valkey /
// RabbitMQ) from a GENERATED fixture — `test/e2e/fixtures/hetzner_data_services.json`, produced by
// `pnpm -C apps/console run export:hetzner-data-services` from hetzner-services.ts via the real
// `hetznerDataServicesToAddOns`.
//
// This guard is what makes that safe, and it is the sibling of catalog-export.test.ts. The mapper is
// the SSOT for chart coordinates, namespaces, sync-waves, the CNPG CRD gate and two value schemas
// that have each broken in production once (bitnami/valkey deleted from the index; bitnami/rabbitmq's
// image 404). A fixture that silently went stale would have a Hetzner full-bar nightly install
// YESTERDAY's charts against a real cloud and still report green. So: regenerate in-memory and
// compare. A chart bump that forgets the regeneration reds CI here — cheaply — instead of on a
// real-apply nightly a week later.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { exportHetznerDataServiceFixture } from "@/lib/cloud-providers/hetzner-services-export";
import { hetznerQueueValues } from "@/lib/cloud-providers/hetzner-services";

const FIXTURE = resolve(
	__dirname,
	"../../../../../test/e2e/fixtures/hetzner_data_services.json",
);

describe("hetzner data-service export fixture (e2e max-config in-cluster seed)", () => {
	it("is current with hetzner-services.ts — regenerate with `pnpm -C apps/console run export:hetzner-data-services`", () => {
		const onDisk = JSON.parse(readFileSync(FIXTURE, "utf8"));
		const live = JSON.parse(JSON.stringify(exportHetznerDataServiceFixture()));
		expect(onDisk).toEqual(live);
	});

	it("carries one Application per component plus the CNPG operator", () => {
		const fixture = exportHetznerDataServiceFixture();
		const ids = fixture.addons.map((a) => a.id);
		// The per-component ids are what the Go table's ArgoApp names ("addon-" + id) are derived
		// from; the operator is the CRD gate the database's Cluster CR needs at sync-wave 0.
		expect(ids).toContain("cnpg-operator");
		for (const db of fixture.components.databases) {
			expect(ids).toContain(`db-${db.name}`);
		}
		for (const cache of fixture.components.caches) {
			expect(ids).toContain(`cache-${cache.name}`);
		}
		for (const queue of fixture.components.queues) {
			expect(ids).toContain(`queue-${queue.name}`);
		}
	});

	// #3304. Left alone, cloudpirates/rabbitmq mints `auth.password` and `auth.erlangCookie` at
	// RENDER time: the Application is permanently OutOfSync and, with selfHeal on, rewrites both
	// every reconcile — which partitions the cluster (the cookie is its shared secret) and breaks
	// every client that already resolved the queue binding (the password).
	//
	// Read from the FIXTURE ON DISK, which is what the runner and the e2e harness actually consume.
	// Asserting against the mapper's own output here would only prove the mapper agrees with itself.
	it("hands every queue a runner-seeded credential and mints none itself", () => {
		// The fixture's shape is DECLARED, not asserted onto the parse: `JSON.parse` returns `any`,
		// and reading a spec off it would leave every field below unchecked.
		const onDisk: {
			addons: { id: string; values: { auth?: Record<string, unknown> } }[];
		} = JSON.parse(readFileSync(FIXTURE, "utf8"));
		const queues = onDisk.addons.filter((a) => a.id.startsWith("queue-"));
		expect(queues.length).toBeGreaterThan(0);

		const secretNames = new Set<unknown>();
		for (const spec of queues) {
			const auth = spec.values.auth;
			if (!auth) {
				throw new Error(
					`${spec.id} renders no auth block — the chart is minting its own credentials again (#3304)`,
				);
			}
			// The credential must exist only in the cluster. A value here is snapshot-persisted and
			// rides a rendered manifest into the customer's cluster.
			expect(auth.password).toBeUndefined();
			expect(auth.erlangCookie).toBeUndefined();
			expect(auth.existingSecret).toBe(
				`rabbitmq-${spec.id.slice("queue-".length)}-credentials`,
			);
			expect(auth.existingPasswordKey).toBe("password");
			expect(auth.existingErlangCookieKey).toBe("erlang-cookie");
			// The username the password belongs to is stated, not left to a chart default.
			expect(auth.username).toBe("admin");
			secretNames.add(auth.existingSecret);
		}
		// One Secret per queue. A shared erlang cookie would silently merge two clusters that the
		// canvas says are separate.
		expect(secretNames.size).toBe(queues.length);
	});

	// The runner refuses to seed a credential for a name that is not an RFC-1123 label, because the
	// names it derives interpolate into kubectl commands. Pointing the chart at a Secret that will
	// never be written turns a queue that runs — badly — into one that never starts, so such a name
	// keeps the chart's own minting instead. #3588 stops new ones being saved; this is for the rows
	// that already exist.
	it("leaves the chart minting for a name the runner cannot seed", () => {
		const withAuth = hetznerQueueValues({ name: "orders-v2", storage_gb: 8 });
		expect(withAuth.auth).toBeTruthy();

		const unseedable = ["orders.v2", "Orders", "orders_v2", "-orders"];
		// Collected, so a failure names WHICH name got an auth block rather than stopping at the
		// first — and so the assertion carries its diagnostic without a message argument, which
		// `vitest/valid-expect` rejects.
		const gotAuth = unseedable.filter(
			(name) => hetznerQueueValues({ name, storage_gb: 8 }).auth !== undefined,
		);
		expect(gotAuth).toEqual([]);

		for (const name of unseedable) {
			// And it is still a working queue spec, not a stripped one: the volume the node asked
			// for has to survive, or the fallback would trade one broken queue for another.
			const values = hetznerQueueValues({ name, storage_gb: 8 });
			expect(values.persistence).toEqual(withAuth.persistence);
			expect(values.replicaCount).toBe(1);
		}
	});

	it("pins a fetchable chart for every spec (the bitnami rot class)", () => {
		for (const spec of exportHetznerDataServiceFixture().addons) {
			// bitnami-labs.github.io was renamed → its index 404s, and Broadcom relocated
			// docker.io/bitnami/* to bitnamilegacy/*. Both are how a Hetzner data service ships a
			// chart ArgoCD cannot even fetch — valkey and rabbitmq have each been there.
			expect(spec.chartRepo).not.toContain("bitnami");
			expect(spec.chartRepo).toMatch(/^https:\/\//);
			expect(spec.chart).not.toBe("");
			expect(spec.version).not.toBe("");
			expect(spec.namespace).not.toBe("");
		}
	});
});
