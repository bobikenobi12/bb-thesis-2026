#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// check-hetzner-image-cache — the Talos snapshot cache's emitter and its two sweepers must not
// drift apart (#3027).
//
// ── WHAT THE CACHE IS, IN ONE PARAGRAPH ───────────────────────────────────────────────────────
//
// `imager_image` builds a Talos snapshot before any cluster exists: ~5 minutes on a good day, and
// the dominant flake of the hetzner floor — it blew its tofu `create` deadline twice (#2458, and
// the scheduled run 33080748841) with `failed to create snapshot: context deadline exceeded`, and
// losing that step loses the whole run. The snapshot is a pure function of
// (talos_version × architecture × location × extension set), so image.tf now looks for an existing
// one and skips the build on a hit.
//
// The entry survives a run's teardown because it carries `alethia.io/cache=talos-image` and NO
// `cluster` label, and `scripts/e2e/hcloud-cleanup.sh` deletes exactly what is labelled
// `cluster=<this run>`. That is a coupling between four separate files in three languages, in an
// hcloud account SHARED WITH PROD, and every way it can come apart is silent:
//
//   · the label stops being stamped → every run rebuilds again, 5–15m each, and nothing says so;
//   · the label acquires a `cluster` again → the sweeper deletes the cache after every run, and
//     nothing says so either;
//   · `count` stops consulting the cache → the lookup becomes dead code and the build is
//     unconditional, with a green plan and a green apply;
//   · a NEW key dimension is added to the stamp but not to hcloud-image-cache.sh → its
//     `--prune-superseded` groups on a key that is no longer the key, and deletes an image that is
//     not superseded at all. That one is a DELETE, in a shared account.
//
// None of those is visible to `tofu validate` (which evaluates neither `count` nor `check`), to a
// unit test, or to a reviewer reading one file. So they are asserted here, statically, on shapes.
//
// ── WHY SHAPES AND NOT SUBSTRINGS ─────────────────────────────────────────────────────────────
//
// The repo has already paid for this distinction once (#2549): a guard that asked
// `block.includes(KEY)` was satisfied by a COMMENT naming the key, so deleting the setting and
// keeping the prose left CI green over the exact regression the guard existed to catch. Every file
// read here is comment-stripped first — HCL through the same `stripComments` that guard uses, so
// there is one answer to "what is a comment" and not two — and what is matched is the rendered
// shape of a real assignment or a real argument.
//
// Both of this file's own directions are pinned by `--self-test`, which CI runs immediately before
// the real check. A guard whose failing branch is never exercised reports green through the
// regression it exists to catch.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { stripComments } from "./check-hetzner-lb-location.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const TEMPLATE = "infra/templates/project/hetzner/image.tf";
const SWEEPER = "scripts/e2e/hcloud-cleanup.sh";
const CACHE_TOOL = "scripts/e2e/hcloud-image-cache.sh";

/** The architectures image.tf builds. Both must be gated, or the ungated one rebuilds forever. */
const ARCHES = ["arm64", "amd64"];

/**
 * Strip `#` line comments from a shell script.
 *
 * Deliberately cruder than the HCL stripper and deliberately NOT string-aware: the only things read
 * out of these two scripts are top-of-file `NAME="value"` constants, and a `#` inside one of those
 * values would be a label containing a `#`, which hcloud's label grammar forbids outright. Being
 * crude here can only over-strip, and over-stripping a constant makes this guard FAIL rather than
 * pass — the safe direction, and the one #2549 established is not automatic.
 */
export function stripShellComments(sh) {
	return sh
		.split("\n")
		.map((line) => (/^\s*#/.test(line) ? "" : line))
		.join("\n");
}

/**
 * Extract a brace-balanced block whose header matches `headerRe`, ignoring braces inside quoted
 * strings. Returns null when the header is absent — which every caller treats as a HARD failure,
 * never a pass, because a missing block means this check has stopped looking at anything.
 * @returns {string|null}
 */
export function extractBlock(tf, headerRe) {
	const m = headerRe.exec(tf);
	if (!m) return null;
	const open = tf.indexOf("{", m.index);
	if (open === -1) return null;
	let depth = 0;
	let inString = false;
	for (let i = open; i < tf.length; i++) {
		const ch = tf[i];
		if (inString) {
			if (ch === "\\") i++;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') inString = true;
		else if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) return tf.slice(open, i + 1);
		}
	}
	return null;
}

/** The value of an HCL `name = "literal"` assignment, or null. */
export function hclStringLocal(tf, name) {
	const m = new RegExp(`(?:^|[\\s{])${name}\\s*=\\s*"([^"\\n]*)"`).exec(tf);
	return m ? m[1] : null;
}

/** The value of a shell `NAME="literal"` assignment at the start of a line, or null. */
export function shellConst(sh, name) {
	const m = new RegExp(`^${name}="([^"\\n]*)"`, "m").exec(sh);
	return m ? m[1] : null;
}

/**
 * Every `alethia.io/<name>` string literal that appears in real (non-comment) HCL — the cache key's
 * label keys. Returned as a sorted, de-duplicated array.
 */
export function alethiaLabelKeys(tf) {
	return [...new Set([...tf.matchAll(/"(alethia\.io\/[a-z0-9-]+)"/g)].map((m) => m[1]))].sort();
}

/**
 * Analyse the three files. Every field is a fact, never a verdict — `main` and the self-test decide
 * what each fact means, so both read the same numbers.
 */
export function analyse({ tf, sweeper, cacheTool }) {
	const hcl = stripComments(tf);
	const sh1 = stripShellComments(sweeper);
	const sh2 = stripShellComments(cacheTool);

	const blocks = Object.fromEntries(
		ARCHES.map((a) => [a, extractBlock(hcl, new RegExp(`resource\\s+"imager_image"\\s+"${a}"\\s*\\{`))]),
	);

	return {
		// ── The label, in all three places. ──
		templateKey: hclStringLocal(hcl, "talos_image_cache_label_key"),
		templateValue: hclStringLocal(hcl, "talos_image_cache_label_value"),
		sweeperKey: shellConst(sh1, "IMAGE_CACHE_LABEL_KEY"),
		sweeperValue: shellConst(sh1, "IMAGE_CACHE_LABEL_VALUE"),
		toolKey: shellConst(sh2, "IMAGE_CACHE_LABEL_KEY"),
		toolValue: shellConst(sh2, "IMAGE_CACHE_LABEL_VALUE"),

		// ── The cache-key dimensions, in the emitter and in the pruner. ──
		// The emitter's set is every `alethia.io/*` key it writes, minus the cache marker itself.
		templateDims: alethiaLabelKeys(hcl).filter((k) => k !== hclStringLocal(hcl, "talos_image_cache_label_key")),
		toolDims: ["LABEL_VERSION", "LABEL_ARCH", "LABEL_LOCATION", "LABEL_SCHEMATIC"]
			.map((n) => shellConst(sh2, n))
			.filter((v) => v !== null)
			.sort(),

		// ── The build is actually gated by the cache, per architecture. ──
		blocks,
		gated: Object.fromEntries(
			ARCHES.map((a) => [a, blocks[a] === null ? false : /count\s*=\s*local\.talos_image_build\./.test(blocks[a])]),
		),
		// ── The stamp writes the cache labels rather than the cluster-bearing default set. ──
		stamped: Object.fromEntries(
			ARCHES.map((a) => [
				a,
				blocks[a] === null ? false : /labels\s*=\s*.*local\.talos_image_cache_dims\./.test(blocks[a]),
			]),
		),
		// ── An existing cluster's image must not be forced to churn on the label change. ──
		frozen: Object.fromEntries(
			ARCHES.map((a) => [
				a,
				blocks[a] === null
					? false
					: /ignore_changes\s*=\s*\[[^\]]*\blabels\b[^\]]*\bdescription\b[^\]]*\]/.test(blocks[a]),
			]),
		),

		// ── The sweeper REPORTS the type it skips, and the report is actually CALLED. Defining a
		//    function nobody invokes is the "absent step is not an absent action" failure: the code
		//    reads correct and performs nothing.
		reportDefined: /^report_image_cache\(\)\s*\{/m.test(sh1),
		reportInvoked: /^report_image_cache$/m.test(sh1),
	};
}

/**
 * Turn the facts into findings. Returns an array of human-readable failures; empty means pass.
 * @returns {string[]}
 */
export function findings(a) {
	const out = [];

	// The label, first — everything else is meaningless if this is not readable.
	for (const [what, v] of [
		[`${TEMPLATE} local.talos_image_cache_label_key`, a.templateKey],
		[`${TEMPLATE} local.talos_image_cache_label_value`, a.templateValue],
		[`${SWEEPER} IMAGE_CACHE_LABEL_KEY`, a.sweeperKey],
		[`${SWEEPER} IMAGE_CACHE_LABEL_VALUE`, a.sweeperValue],
		[`${CACHE_TOOL} IMAGE_CACHE_LABEL_KEY`, a.toolKey],
		[`${CACHE_TOOL} IMAGE_CACHE_LABEL_VALUE`, a.toolValue],
	]) {
		if (v === null) {
			out.push(
				`${what} is absent. It is the constant the whole cache is keyed on; a guard that cannot ` +
					`read it is not checking anything. Restore it, or delete this guard and say why.`,
			);
		}
	}
	if (out.length === 0) {
		if (a.sweeperKey !== a.templateKey || a.sweeperValue !== a.templateValue) {
			out.push(
				`the sweeper's skip-list label (${a.sweeperKey}=${a.sweeperValue}) is not the one the template ` +
					`stamps (${a.templateKey}=${a.templateValue}). ${SWEEPER} would then either delete the cache after ` +
					`every run, or skip something that is not the cache.`,
			);
		}
		if (a.toolKey !== a.templateKey || a.toolValue !== a.templateValue) {
			out.push(
				`${CACHE_TOOL}'s selector label (${a.toolKey}=${a.toolValue}) is not the one the template stamps ` +
					`(${a.templateKey}=${a.templateValue}). The only tool that can reclaim cache entries would be ` +
					`looking at the wrong set — and it DELETES.`,
			);
		}
	}

	// The key dimensions.
	if (a.templateDims.length === 0) {
		out.push(
			`${TEMPLATE} stamps no \`alethia.io/*\` cache-key dimensions at all. Either the cache key has been ` +
				`removed (then delete this guard) or it has been renamed (then update it) — but it must never ` +
				`simply stop being looked at.`,
		);
	} else if (a.templateDims.join(",") !== a.toolDims.join(",")) {
		out.push(
			`the cache-key dimensions have drifted: ${TEMPLATE} stamps [${a.templateDims.join(", ")}] but ` +
				`${CACHE_TOOL} groups on [${a.toolDims.join(", ")}]. \`--prune-superseded\` decides which entries ` +
				`are duplicates by grouping on that key, so a dimension it does not know about makes two DIFFERENT ` +
				`images look like the same one — and it deletes the older, in an account shared with prod.`,
		);
	}

	// The gating, the stamp, and the freeze — per architecture.
	for (const arch of ARCHES) {
		if (a.blocks[arch] === null) {
			out.push(
				`no \`resource "imager_image" "${arch}"\` block in ${TEMPLATE}. The build this cache exists to skip ` +
					`is gone or renamed; this guard has stopped looking at it either way.`,
			);
			continue;
		}
		if (!a.gated[arch]) {
			out.push(
				`\`imager_image.${arch}\`'s \`count\` does not consult \`local.talos_image_build\`. The cache lookup ` +
					`then decides nothing: the snapshot is rebuilt unconditionally on every apply — 5–15 minutes on ` +
					`the critical path, and the deadline flake of #2458 — with a green plan and nothing saying why.`,
			);
		}
		if (!a.stamped[arch]) {
			out.push(
				`\`imager_image.${arch}\`'s \`labels\` do not reference \`local.talos_image_cache_dims\`. A snapshot ` +
					`built without the cache labels can never be found again (so every run rebuilds), and one built ` +
					`with \`local.default_labels\` carries \`cluster=<name>\` — which makes ${SWEEPER} delete it at ` +
					`the end of the very run that built it.`,
			);
		}
		if (!a.frozen[arch]) {
			out.push(
				`\`imager_image.${arch}\` has no \`lifecycle { ignore_changes = [labels, description] }\`. Without ` +
					`it, every cluster provisioned BEFORE this cache existed sees both arguments change on its next ` +
					`apply — and if the imager provider cannot update a snapshot's labels in place, that is a ` +
					`REPLACEMENT: the 5–15m rebuild, on every existing cluster, caused by the change that exists to ` +
					`remove it.`,
			);
		}
	}

	// The report.
	if (!a.reportDefined) {
		out.push(
			`${SWEEPER} defines no \`report_image_cache\`. The image cache is the one hcloud type this repo ` +
				`deliberately never deletes, and an unswept type nobody mentions is indistinguishable from a swept one.`,
		);
	} else if (!a.reportInvoked) {
		out.push(
			`${SWEEPER} defines \`report_image_cache\` but never CALLS it at top level. A defined-and-uninvoked ` +
				`function reads exactly like a performed one and performs nothing — so every sweep would go on ` +
				`silently skipping the cache without ever saying that it had.`,
		);
	}

	return out;
}

function readOrDie(rel) {
	try {
		return readFileSync(path.join(ROOT, rel), "utf8");
	} catch (e) {
		// A missing file is a failure, never a skip. A guard that passes because it could not read
		// its own subject is the failure mode this repo has paid for more than once.
		console.error(`::error::check-hetzner-image-cache: cannot read ${rel}: ${e.message}`);
		process.exit(1);
	}
}

function main() {
	const a = analyse({
		tf: readOrDie(TEMPLATE),
		sweeper: readOrDie(SWEEPER),
		cacheTool: readOrDie(CACHE_TOOL),
	});
	const found = findings(a);
	if (found.length > 0) {
		for (const f of found) console.error(`::error::check-hetzner-image-cache: ${f}`);
		process.exit(1);
	}
	// The success line CARRIES THE COUNTS it verified. "✓ nothing wrong" and "✓ I found nothing to
	// look at" are the same sentence otherwise, and the second one is how a guard goes vacuous
	// without anybody noticing.
	console.log(
		`✓ check-hetzner-image-cache: label ${a.templateKey}=${a.templateValue} agrees across ${TEMPLATE}, ` +
			`${SWEEPER} and ${CACHE_TOOL}; ${a.templateDims.length} cache-key dimension(s) ` +
			`[${a.templateDims.join(", ")}] agree with the pruner; ${ARCHES.length} imager_image block(s) are ` +
			`cache-gated, cache-stamped and label-frozen; the sweeper reports what it skips.`,
	);
}

// ── self-test ─────────────────────────────────────────────────────────────────────────────────
function selfTest() {
	let fails = 0;
	const ok = (name, cond) => {
		if (cond) console.log(`ok   - ${name}`);
		else {
			console.error(`FAIL - ${name}`);
			fails++;
		}
	};

	const goodTf = `
locals {
  talos_image_cache_label_key   = "alethia.io/cache"
  talos_image_cache_label_value = "talos-image"
  talos_image_cache_labels = {
    (local.talos_image_cache_label_key) = local.talos_image_cache_label_value
    "alethia.io/talos-version"          = var.talos_version
    "alethia.io/talos-location"         = var.region
    "alethia.io/talos-schematic"        = local.talos_schematic_key
  }
  talos_image_cache_dims = { for a, h in local.talos_hcloud_arch : a => merge(local.talos_image_cache_labels, { "alethia.io/talos-arch" = h }) }
}
resource "imager_image" "arm64" {
  count  = local.talos_image_build.arm64 ? 1 : 0
  labels = local.talos_image_cache_stamp ? local.talos_image_cache_dims.arm64 : merge(local.default_labels, { os = "talos" })
  lifecycle { ignore_changes = [labels, description] }
}
resource "imager_image" "amd64" {
  count  = local.talos_image_build.amd64 ? 1 : 0
  labels = local.talos_image_cache_stamp ? local.talos_image_cache_dims.amd64 : merge(local.default_labels, { os = "talos" })
  lifecycle { ignore_changes = [labels, description] }
}`;
	const goodSweeper = `
IMAGE_CACHE_LABEL_KEY="alethia.io/cache"
IMAGE_CACHE_LABEL_VALUE="talos-image"
report_image_cache() {
	echo hi
}
purge image "images"
report_image_cache
`;
	const goodTool = `
IMAGE_CACHE_LABEL_KEY="alethia.io/cache"
IMAGE_CACHE_LABEL_VALUE="talos-image"
LABEL_VERSION="alethia.io/talos-version"
LABEL_ARCH="alethia.io/talos-arch"
LABEL_LOCATION="alethia.io/talos-location"
LABEL_SCHEMATIC="alethia.io/talos-schematic"
`;
	const good = { tf: goodTf, sweeper: goodSweeper, cacheTool: goodTool };
	const run = (o) => findings(analyse({ ...good, ...o }));

	ok("the real shape passes", run({}).length === 0);

	// ── THE REGRESSION: the count stops consulting the cache. This is the failure that leaves the
	//    lookup in place as dead code and rebuilds on every apply, greenly.
	const ungated = goodTf.replace(/count\s*=\s*local\.talos_image_build\.amd64 \? 1 : 0/, "count = local.need_amd64 ? 1 : 0");
	ok("an UNGATED count fails", run({ tf: ungated }).some((f) => f.includes("does not consult")));
	ok("...and it names the architecture that regressed", run({ tf: ungated }).some((f) => f.includes("imager_image.amd64")));
	ok("...and the other architecture is not blamed", !run({ tf: ungated }).some((f) => f.includes("imager_image.arm64`'s `count`")));

	// The cluster label coming back — the sweeper then deletes the cache after every run.
	const clustered = goodTf.replace(
		'labels = local.talos_image_cache_stamp ? local.talos_image_cache_dims.amd64 : merge(local.default_labels, { os = "talos" })',
		'labels = merge(local.default_labels, { os = "talos" })',
	);
	ok("re-adding the cluster-bearing default labels fails", run({ tf: clustered }).some((f) => f.includes("talos_image_cache_dims")));

	// The freeze, removed — every pre-existing cluster pays a rebuild.
	const thawed = goodTf.replace(/lifecycle \{ ignore_changes = \[labels, description\] \}\n\}\s*$/, "}");
	ok("dropping ignore_changes fails", run({ tf: thawed }).some((f) => f.includes("ignore_changes")));

	// ── The label, drifted in each direction independently. ──
	ok(
		"a sweeper skip-list that no longer matches the stamp fails",
		run({ sweeper: goodSweeper.replace("alethia.io/cache", "alethia.io/kache") }).some((f) => f.includes("skip-list label")),
	);
	ok(
		"a pruner selector that no longer matches the stamp fails",
		run({ cacheTool: goodTool.replace('IMAGE_CACHE_LABEL_VALUE="talos-image"', 'IMAGE_CACHE_LABEL_VALUE="talos-img"') }).some(
			(f) => f.includes("selector label"),
		),
	);

	// ── #2549's lesson, applied here: prose must not satisfy any of it. ──
	const onlyProse = `
# IMAGE_CACHE_LABEL_KEY="alethia.io/cache"
# IMAGE_CACHE_LABEL_VALUE="talos-image"
# report_image_cache
`;
	ok(
		"constants named ONLY in a shell comment do not satisfy the check",
		run({ sweeper: onlyProse }).some((f) => f.includes("IMAGE_CACHE_LABEL_KEY is absent")),
	);
	const tfProse = goodTf.replace(
		'  talos_image_cache_label_key   = "alethia.io/cache"',
		'  # talos_image_cache_label_key = "alethia.io/cache"',
	);
	ok(
		"a template constant named only in an HCL comment does not satisfy it",
		run({ tf: tfProse }).some((f) => f.includes("talos_image_cache_label_key is absent")),
	);

	// ── The dimension set. A NEW dimension the pruner does not know about is a DELETE bug. ──
	const extraDim = goodTf.replace(
		'"alethia.io/talos-schematic"        = local.talos_schematic_key',
		'"alethia.io/talos-schematic"        = local.talos_schematic_key\n    "alethia.io/talos-platform"         = "hcloud"',
	);
	ok("a new key dimension the pruner does not know fails", run({ tf: extraDim }).some((f) => f.includes("dimensions have drifted")));
	ok(
		"...and a dimension dropped from the PRUNER fails the same way",
		run({ cacheTool: goodTool.replace('LABEL_LOCATION="alethia.io/talos-location"\n', "") }).some((f) =>
			f.includes("dimensions have drifted"),
		),
	);

	// ── An absent step is not an absent action. ──
	ok(
		"defining report_image_cache but never calling it FAILS",
		run({ sweeper: goodSweeper.replace(/^report_image_cache$/m, "") }).some((f) => f.includes("never CALLS it")),
	);
	ok(
		"...and naming it only in a comment is not a call",
		run({ sweeper: goodSweeper.replace(/^report_image_cache$/m, "# report_image_cache") }).some((f) =>
			f.includes("never CALLS it"),
		),
	);
	ok(
		"removing the function entirely reports the function, not the call",
		run({ sweeper: goodSweeper.replace(/report_image_cache\(\)\s*\{\n\techo hi\n\}/, "") }).some((f) =>
			f.includes("defines no `report_image_cache`"),
		),
	);

	// ── The vacuity guards: an empty subject must FAIL, never pass. ──
	ok("an empty template fails rather than passing vacuously", run({ tf: "" }).length > 0);
	ok("...naming the absent constant first", run({ tf: "" })[0].includes("talos_image_cache_label_key is absent"));
	ok(
		"a template with the constants but no imager_image blocks still fails",
		run({ tf: goodTf.replace(/resource "imager_image"[\s\S]*$/, "") }).some((f) => f.includes("no `resource \"imager_image\"")),
	);

	console.log(fails === 0 ? "\nself-test: all passed" : `\nself-test: ${fails} FAILED`);
	process.exit(fails === 0 ? 0 : 1);
}

const isEntryPoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntryPoint) {
	if (process.argv.includes("--self-test")) selfTest();
	else main();
}
