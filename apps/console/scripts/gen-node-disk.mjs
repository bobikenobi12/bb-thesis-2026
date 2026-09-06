// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Generate the TypeScript mirror of every cloud's node-disk floor and template default (#1972).
//
// The inspector's `node_disk_size_gb` field needs a per-cloud lower bound: `min: 20` is right for
// aws, gcp and alibaba, but Azure's floor is 30 — the Azure OS-disk minimum — so a single
// cross-cloud number let 24 GB pass the form and fail the deploy. The floors already live in ONE
// place: each template's own disk-size variable declares them as `>= N` validations, and
// `TestNodeDiskFloorsMatchTemplates` (packages/core/cloud/validate_drift_test.go) pins the Go
// constants to those same literals. This generator reads the SAME literals, so TypeScript becomes
// the third reader of one source of truth rather than a fourth hand-written copy of "30" — which
// is the failure mode #1967 was filed against.
//
// GENERATED rather than hand-mirrored on purpose (the keyless-cells argument): a hand list detects
// drift at best; a generated one makes drift impossible, and CI diff-checks the output.
//
// Run: `pnpm -C apps/console run gen:node-disk` (from apps/console).

import { readFileSync, writeFileSync } from "node:fs";

const ROOT = "../..";
const CATALOG_TS = "lib/cloud-providers/generated/catalog.ts";
const OUT = "lib/cloud-providers/generated/node-disk.ts";

/** Each placeable cloud's disk-size variable, or null for a DELIBERATE absence. The same table
 * `nodeDiskFloorCouplings` pins on the Go side — if a cloud is added or a variable renamed, both
 * this table and that one fail loudly rather than drifting. */
const COUPLINGS = {
	aws: { rel: "infra/templates/project/aws/variables.tf", variable: "eks_disk_size" },
	gcp: { rel: "infra/templates/project/gcp/variables.tf", variable: "gke_disk_size_gb" },
	azure: { rel: "infra/templates/project/azure/variables.tf", variable: "aks_disk_size_gb" },
	alibaba: { rel: "infra/templates/project/alibaba/variables.tf", variable: "ack_disk_size_gb" },
	// hetzner has no disk knob ON PURPOSE — a server's disk comes with its server type, which is
	// why `cluster.node_disk_size_gb / hetzner` is a documented exclusion on the carriage board.
	// Asserted against the template below, not trusted from this comment.
	hetzner: null,
};

/** The clouds a project can actually be placed on, read off the generated catalog's slug union —
 * the same totality anchor gen-keyless-cells.mjs uses. A cloud this table forgot must fail the
 * build, not silently fall back to a cross-cloud constant. */
function placeableSlugs() {
	const src = readFileSync(CATALOG_TS, "utf8");
	const line = src.match(/export type CloudProviderSlug = Extract<CloudProvider,([^>]*)>/);
	if (!line) {
		throw new Error(
			`could not read CloudProviderSlug from ${CATALOG_TS} — the generator uses it as the set ` +
				"of clouds that must have a node-disk decision. If the declaration moved, update this regex.",
		);
	}
	return [...line[1].matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
}

/** Scrape one integer with a mandatory match — an unmatched pattern is an error, never a skip. */
function scrapeInt(src, rel, re, what) {
	const m = src.match(re);
	if (!m) {
		throw new Error(`${rel}: could not scrape ${what} (pattern ${re}) — did the variable move or lose its ${what}?`);
	}
	return Number.parseInt(m[1], 10);
}

const slugs = placeableSlugs();
for (const cloud of slugs) {
	if (!(cloud in COUPLINGS)) {
		throw new Error(
			`${cloud} is placeable but has no node-disk coupling — add its template's disk variable ` +
				"to COUPLINGS (or an explicit null with the reason), and the matching entry to " +
				"nodeDiskFloorCouplings in packages/core/cloud/validate_drift_test.go.",
		);
	}
}

const rows = [];
for (const cloud of slugs) {
	const coupling = COUPLINGS[cloud];
	if (coupling === null) {
		// The exemption is only true while the template declares no disk-size variable — the same
		// tripwire TestNodeDiskFloorsMatchTemplates springs on the Go side.
		const src = readFileSync(`${ROOT}/infra/templates/project/${cloud}/variables.tf`, "utf8");
		if (/variable "[a-z0-9_]*disk_size[a-z0-9_]*"/.test(src)) {
			throw new Error(
				`${cloud} now declares a node disk-size variable — give it a real COUPLINGS entry ` +
					"(and a Go coupling + ValidateConfig floor) instead of the null exemption.",
			);
		}
		rows.push(`\t${cloud}: null,`);
		continue;
	}
	const src = readFileSync(`${ROOT}/${coupling.rel}`, "utf8");
	// Bound the scrape to this variable's own block so a neighbouring variable's numbers can never
	// be read as this one's. A variable block ends where the next `variable "` begins.
	const block = src.match(new RegExp(`variable "${coupling.variable}"[\\s\\S]*?(?=\\nvariable "|$)`));
	if (!block) {
		throw new Error(`${coupling.rel}: variable "${coupling.variable}" not found — renamed?`);
	}
	const floorGb = scrapeInt(
		block[0],
		coupling.rel,
		new RegExp(`var\\.${coupling.variable}\\s*>=\\s*(\\d+)`),
		"floor validation",
	);
	const templateDefaultGb = scrapeInt(block[0], coupling.rel, /default\s*=\s*(\d+)/, "default");
	if (templateDefaultGb < floorGb) {
		throw new Error(
			`${coupling.rel}: ${coupling.variable} defaults to ${templateDefaultGb} GB, below its own ` +
				`${floorGb} GB floor — the template cannot plan with its own default.`,
		);
	}
	rows.push(`\t${cloud}: { floorGb: ${floorGb}, templateDefaultGb: ${templateDefaultGb} },`);
}

const out = `// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// GENERATED by apps/console/scripts/gen-node-disk.mjs — DO NOT EDIT.
// Source of truth: each template's own disk-size variable (its \`>= N\` validation and \`default\`),
// the same literals TestNodeDiskFloorsMatchTemplates pins the Go floors to.
// Run \`pnpm -C apps/console run gen:node-disk\` to regenerate.

import type { CloudProviderSlug } from "./catalog";

/** One cloud's node-disk bounds: the template's floor and its default when the field is empty. */
export interface NodeDiskSpec {
	floorGb: number;
	templateDefaultGb: number;
}

/** Total over every placeable cloud. \`null\` is a DELIBERATE absence, not a hole: the cloud has no
 * node-disk knob at all (hetzner — a server's disk comes with its server type), so the inspector
 * must not render the field rather than render it unbounded. */
export const NODE_DISK: Record<CloudProviderSlug, NodeDiskSpec | null> = {
${rows.join("\n")}
};
`;

writeFileSync(OUT, out);
console.log(`✓ node disk → ${OUT} — ${slugs.length} placeable cloud(s).`);
