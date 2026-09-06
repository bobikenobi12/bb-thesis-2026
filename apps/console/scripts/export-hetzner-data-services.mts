// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Writes the Hetzner in-cluster data-service install specs — resolved through the real
// `hetznerDataServicesToAddOns` — to `test/e2e/fixtures/hetzner_data_services.json`, the artifact the
// Go e2e harness appends to a Hetzner max-config DEPLOY snapshot's `addons` so its three
// `CarriedInCluster` kinds (database/cache/queue) actually have an ArgoCD Application to converge.
//
// Sibling of export-addon-catalog.mts, and generated for the same reason: hetzner-services.ts is the
// SSOT for the chart coordinates, namespaces, sync-waves and value schemas. Re-typing them in Go
// would go stale the first time someone bumped a chart, and the drift would surface only as a red
// nightly against a real cloud. Here the fixture is DERIVED, and
// `tests/lib/cloud-providers/hetzner-data-services-export.test.ts` fails CI if it is stale.
//
// Usage: pnpm -C apps/console run export:hetzner-data-services

import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exportHetznerDataServiceFixture } from "../lib/cloud-providers/hetzner-services-export.js";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "../../../test/e2e/fixtures/hetzner_data_services.json");
const fixture = exportHetznerDataServiceFixture();
writeFileSync(out, `${JSON.stringify(fixture, null, "\t")}\n`);
console.log(`wrote ${fixture.addons.length} hetzner data-service specs → ${out}`);
