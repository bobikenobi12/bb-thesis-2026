// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Lock-file guard: every project template pins its providers, and nothing quietly unpins them.
//
// Production never resolves providers at job time — the runner image pre-initializes each template at
// build time and `copyDir` (packages/core/provisioner/deploy.go) carries the baked .terraform tree into
// each job workdir. The e2e nightly does the opposite: it drives a natively built runner against
// infra/templates/project/<cloud> straight from the checkout, so its `tofu init` starts cold.
//
// With no lock file that cold init resolved versions live against the registry, which broke twice over:
//
//   · 2026-07-27 — `hashicorp/kubernetes v3.2.1`: "failed to retrieve authentication checksums for
//     provider … 500 Internal Server Error returned from github.com". Dead at 47 seconds, nothing
//     provisioned. A registry hiccup could red the nightly at any time.
//   · Worse and quieter — the nightly resolved a DIFFERENT provider set than production ships, because
//     the image baked whatever was newest at build time. The run meant to prove production works was
//     exercising another dependency graph.
//
// A committed .terraform.lock.hcl fixes both, and this guard keeps it fixed. It checks three things:
//
//   A · MISSING       a project-template root declares `required_providers` but has no lock file, so a
//                     newly added cloud silently reopens the hole.
//   B · THIN          a locked provider carries fewer `h1:` hashes than the platforms we lock for. Each
//                     h1 is one platform package; too few means some platform re-fetches checksums at
//                     init and gets the 07-27 failure on that arch alone.
//   C · UNPINNED      a runner Dockerfile passes `-upgrade` to a template `tofu init`. That one word
//                     makes OpenTofu disregard the lock file and re-resolve — every lock file in the
//                     repo becomes decorative, and nothing else would notice.
//
// On [B] the platform check is a COUNT, not an identity check, and that limit is real: the lock file
// format records hashes without naming their platforms, so this can prove there are four of them and
// cannot prove they are the four we asked for. Stated rather than papered over — the same reason
// check-keyless-cells.mjs declines to verify the tofu IAM flag instead of hand-listing a marker per cell.
//
// Run from apps/console (`pnpm -C apps/console run check:tofu-lockfiles`).

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = "../..";
const TEMPLATES = `${ROOT}/infra/templates/project`;
const RUNNER_DIR = `${ROOT}/apps/runner`;

/** The platforms `tofu providers lock` is run with. Both linux arches are load-bearing: the fleet ships
 * per-cloud runner images on amd64 AND arm64, and an arch mismatch already burned ~100 VMs in 8h. */
const PLATFORMS = ["linux_amd64", "linux_arm64", "darwin_amd64", "darwin_arm64"];

/** Roots that are not provisioned by any cloud job, so they need no pinned providers. */
const EXCLUDED = new Set(["local"]);

const findings = [];

// ── A + B: every template root pins, and pins for every platform ─────────────────────

const roots = existsSync(TEMPLATES)
	? readdirSync(TEMPLATES, { withFileTypes: true })
			.filter((e) => e.isDirectory() && !EXCLUDED.has(e.name))
			.map((e) => e.name)
			.sort()
	: [];

if (roots.length === 0) {
	console.error(`✗ tofu lock files — no template roots found under ${TEMPLATES}.`);
	console.error("  The guard resolves roots from that directory; if templates moved, update TEMPLATES here.");
	process.exit(1);
}

let lockedProviders = 0;
for (const cloud of roots) {
	const dir = join(TEMPLATES, cloud);
	// Only roots that actually declare providers need a lock file.
	const declares = readdirSync(dir)
		.filter((f) => f.endsWith(".tf"))
		.some((f) => readFileSync(join(dir, f), "utf8").includes("required_providers"));
	if (!declares) continue;

	const lockPath = join(dir, ".terraform.lock.hcl");
	if (!existsSync(lockPath)) {
		findings.push({
			shape: "missing",
			where: `infra/templates/project/${cloud}`,
			detail:
				"declares required_providers but has no .terraform.lock.hcl, so `tofu init` resolves live\n" +
				`      against the registry. Generate it:\n` +
				`        cd infra/templates/project/${cloud} && tofu init -backend=false -input=false \\\n` +
				`          && tofu providers lock ${PLATFORMS.map((p) => `-platform=${p}`).join(" ")}`,
		});
		continue;
	}

	// Each `provider "…" { … }` block carries one h1: hash per locked platform.
	const lock = readFileSync(lockPath, "utf8");
	for (const block of lock.matchAll(/provider\s+"([^"]+)"\s*\{([\s\S]*?)\n\}/g)) {
		lockedProviders++;
		const h1 = [...block[2].matchAll(/"h1:/g)].length;
		if (h1 < PLATFORMS.length) {
			findings.push({
				shape: "thin",
				where: `infra/templates/project/${cloud}/.terraform.lock.hcl`,
				detail:
					`${block[1]} has ${h1} h1: hash(es), want ${PLATFORMS.length} (one per locked platform).\n` +
					`      Re-lock: tofu providers lock ${PLATFORMS.map((p) => `-platform=${p}`).join(" ")}`,
			});
		}
	}
}

// ── C: nothing re-resolves past the lock file ────────────────────────────────────────

// Match the FLAG on an init command line, not the word — the Dockerfiles' comments explain why
// `-upgrade` is absent, and a guard that trips on its own rationale would be turned off within a week.
for (const f of readdirSync(RUNNER_DIR).filter((n) => n.startsWith("Dockerfile"))) {
	const src = readFileSync(join(RUNNER_DIR, f), "utf8");
	for (const line of src.split("\n")) {
		if (/^\s*#/.test(line)) continue;
		if (/tofu\s+init\b/.test(line) && /\s-upgrade\b/.test(line)) {
			findings.push({
				shape: "unpinned",
				where: `apps/runner/${f}`,
				detail:
					"`tofu init … -upgrade` disregards .terraform.lock.hcl and re-resolves against the registry.\n" +
					`      The image would bake whatever is newest at BUILD time while the nightly pins the lock\n` +
					`      file — production and its own proof back on different provider sets.\n      ${line.trim()}`,
			});
		}
	}
}

// ── report ──────────────────────────────────────────────────────────────────────────

if (findings.length === 0) {
	console.log(
		`✓ tofu lock files — ${roots.length} template root(s), ${lockedProviders} pinned provider(s) ` +
			`× ${PLATFORMS.length} platforms, and no \`tofu init -upgrade\` to unpin them.`,
	);
	process.exit(0);
}

console.error(`\n✗ tofu lock files — ${findings.length} finding(s):\n`);
for (const f of findings) {
	console.error(`  [${f.shape}] ${f.where}`);
	console.error(`      ${f.detail}`);
}
console.error(`
An unpinned template resolves providers live at init. That is one registry outage away from a red
nightly that provisioned nothing, and — quieter — it lets the run meant to prove production works
install a different provider set than production ships.
`);
process.exit(1);
