// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Writes EVERY marketplace add-on, resolved through the real `resolveAddOnInstall`, to
// `test/e2e/fixtures/addon_catalog.<cloud>.json` — the runner-facing `AddOnInstallSpec[]` the Go
// e2e harness seeds when it exercises the FULL add-on surface (all 18 charts, not just the one
// lean seed).
//
// Why a generated fixture rather than a hand-written Go table: `catalog.ts` is the SSOT for chart
// coordinates. Re-typing them in Go would silently drift the moment someone bumped a chart — and the
// drift would only surface as a red nightly against a real cloud. Here the fixture is DERIVED, and
// `tests/lib/addons/catalog-export.test.ts` fails CI if any of them is stale, so a chart bump forces
// a regeneration.
//
// Why one file PER CLOUD: some knobs are only correct relative to the target cloud. external-dns is
// the measured case — its `provider` knob defaults to `cloudflare`, so a single cloud-agnostic
// fixture installed external-dns pointed at Cloudflare on every cloud, with no Cloudflare token. It
// could not converge and never could, and that made the 18-chart cell a test of the fixture rather
// than of the chart (#2717 class (c)). The per-cloud value is resolved through the SAME
// `resolveAddOnInstall`, so the shapes it implies — hetzner's webhook sidecar, the workload-identity
// `saAnnotation`s — are the emitter's output and are never restated.
//
// Usage: pnpm -C apps/console run export:addon-catalog

import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EXPORT_CLOUDS, exportCatalogSpecs } from "../lib/addons/catalog-export.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = resolve(here, "../../../test/e2e/fixtures");

for (const cloud of EXPORT_CLOUDS) {
	const out = resolve(fixtures, `addon_catalog.${cloud}.json`);
	const specs = exportCatalogSpecs(cloud);
	writeFileSync(out, `${JSON.stringify(specs, null, "\t")}\n`);
	console.log(`wrote ${specs.length} add-on specs → ${out}`);
}
