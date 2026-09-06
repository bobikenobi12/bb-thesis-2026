// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The keep-honest compat gate at CI time (#1217, epic #1186). The version-compat
// matrix (packages/core/compat/matrix.json) records which Kubernetes minors each
// component/add-on version supports; this guard asserts that the versions the
// platform actually SHIPS BY DEFAULT are mutually compatible with the default
// Kubernetes minor. It would have caught the #1165 regression (ArgoCD chart 7.1.3
// / app v2.11 on a 1.35 cluster → GitOps never converges).
//
// Where "shipped default" comes from (each has ONE source of truth):
//   • Kubernetes default minor — matrix `k8s_cloud[*].default`. The platform
//     standardizes on a SINGLE minor across clouds (#1212), so the guard asserts
//     the defaults are identical and evaluates the shipped set against that one.
//   • ArgoCD chart — packages/core/argocd/argocd.DefaultArgoChartVersion (the one
//     component the matrix records multiple releases for: the current 9.5.11, the
//     superseded 8.6.4 and the historical-incompatible 7.1.3, so "which is shipped"
//     must come from the pin, not the matrix). Mirrors
//     compat/couplings_drift_test.go:TestCouplingArgoCD.
//   • Every other platform component — its single recorded matrix release.
//   • Every marketplace add-on — its recorded `addon_k8s[id]` window (add-on
//     windows are version-independent, keyed by id).
//
// The range logic mirrors apps/console/lib/compat/engine.ts (checkK8sRange): both
// bounds empty → not_evaluable (no window recorded, never a vacuous pass); an empty
// single bound → unbounded on that side. Only a hard `fail` gates. The runtime Go +
// TS engines are the deeper authority (and the Go couplings_drift_test locks the
// real template/Dockerfile pins to the matrix); this is the fast, Go-toolchain-free
// mirror that runs in the console `guards` job. Run: `node scripts/check-compat.mjs`
// (`pnpm -C apps/console run check:compat`), or `--self-test` to exercise the evaluator.

import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const matrixPath = resolve(repoRoot, "packages/core/compat/matrix.json");
const argocdVersionsPath = resolve(repoRoot, "packages/core/argocd/versions.go");

/** A parsed Kubernetes (major, minor); patch is ignored. */
function parseMinor(v) {
	if (!v) return null;
	const trimmed = String(v).trim().replace(/^v/, "");
	const parts = trimmed.split(".");
	if (parts.length < 2) return null;
	const major = Number(parts[0]);
	const minor = Number(parts[1]);
	if (!Number.isInteger(major) || !Number.isInteger(minor)) return null;
	return { major, minor };
}

/** Orders two parsed minors: -1 if a<b, 0 if equal, 1 if a>b. */
function cmpMinor(a, b) {
	if (a.major !== b.major) return a.major < b.major ? -1 : 1;
	if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
	return 0;
}

/**
 * The status of a Kubernetes minor against a [min, max] window — "pass" | "fail" |
 * "not_evaluable". Mirrors engine.ts checkK8sRange: both bounds empty (or an
 * unparseable/absent K8s) is not_evaluable; an empty single bound is unbounded.
 */
function checkRange(k8s, min, max) {
	if (!min && !max) return "not_evaluable";
	const kv = parseMinor(k8s);
	if (!kv) return "not_evaluable";
	if (min) {
		const mn = parseMinor(min);
		if (!mn) return "not_evaluable";
		if (cmpMinor(kv, mn) < 0) return "fail";
	}
	if (max) {
		const mx = parseMinor(max);
		if (!mx) return "not_evaluable";
		if (cmpMinor(kv, mx) > 0) return "fail";
	}
	return "pass";
}

/** Renders a [min, max] window for a human message ("1.33+", "≤1.32", "1.34–1.36"). */
function rangeLabel(min, max) {
	if (min && max) return `${min}–${max}`;
	if (min) return `${min}+`;
	if (max) return `≤${max}`;
	return "any";
}

/** Finds a component's recorded release by version, or undefined. */
function findRelease(matrix, componentId, version) {
	return matrix.components
		.find((c) => c.id === componentId)
		?.versions.find((r) => r.version === version);
}

/**
 * Parse a semver into comparable parts. Deliberately dependency-free, like parseMinor above —
 * this file is the Go-toolchain-free guard and pulling a package in for four lines would be worse.
 *
 * Accepts the truncated `vMAJOR.MINOR` form, because the matrix records `v2.11` and it must
 * participate in a comparison rather than being silently excused as unparseable. Mirrors
 * golang.org/x/mod/semver, which compat.CheckSemverWindow uses on the Go side.
 */
function parseSemver(v) {
	const m = /^v?(\d+)\.(\d+)(?:\.(\d+))?(-[0-9A-Za-z.-]+)?$/.exec(String(v ?? "").trim());
	if (!m) return null;
	return { major: +m[1], minor: +m[2], patch: m[3] === undefined ? 0 : +m[3], pre: m[4] ?? "" };
}

/** Compare two parsed semvers. A pre-release sorts BELOW its release, as x/mod does. */
function cmpSemver(a, b) {
	if (a.major !== b.major) return a.major < b.major ? -1 : 1;
	if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
	if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
	if (a.pre === b.pre) return 0;
	if (a.pre === "") return 1; // a release outranks any pre-release of itself
	if (b.pre === "") return -1;
	return a.pre < b.pre ? -1 : 1;
}

/**
 * checkRange's contract on the full-semver axis. Mirrors compat.CheckSemverWindow: both bounds
 * empty is not_evaluable, an unparseable subject or bound is not_evaluable — NEVER a pass.
 */
function checkSemverRange(v, min, max) {
	if (!min && !max) return "not_evaluable";
	const sv = parseSemver(v);
	if (!sv) return "not_evaluable";
	if (min) {
		const mn = parseSemver(min);
		if (!mn) return "not_evaluable";
		if (cmpSemver(sv, mn) < 0) return "fail";
	}
	if (max) {
		const mx = parseSemver(max);
		if (!mx) return "not_evaluable";
		if (cmpSemver(sv, mx) > 0) return "fail";
	}
	return "pass";
}

/** Finds a component by id, or undefined. */
function findComponent(matrix, componentId) {
	return matrix.components.find((c) => c.id === componentId);
}

/**
 * Exercises the range evaluator against the #1165 fixtures so a regression in the
 * mirror logic itself reds here rather than silently passing every real check.
 */
function selfTest() {
	const cases = [
		["argocd 8.6.4 (min 1.33) @ 1.35", checkRange("1.35", "1.33", ""), "pass"],
		["argocd 7.1.3 (max 1.32) @ 1.35", checkRange("1.35", "", "1.32"), "fail"],
		["below floor 1.32 vs min 1.33", checkRange("1.32", "1.33", ""), "fail"],
		["above ceiling 1.36 vs max 1.35", checkRange("1.36", "", "1.35"), "fail"],
		["within window 1.35 in 1.34–1.36", checkRange("1.35", "1.34", "1.36"), "pass"],
		["no window recorded", checkRange("1.35", "", ""), "not_evaluable"],
		["unparseable k8s", checkRange("", "1.33", ""), "not_evaluable"],

		// ── the app-version axis (#3126). Mirrors compat.CheckSemverWindow's table. ──
		["argo v3.3.9 vs floor v3.3.9", checkSemverRange("v3.3.9", "v3.3.9", ""), "pass"],
		["argo v3.4.1 vs floor v3.3.9", checkSemverRange("v3.4.1", "v3.3.9", ""), "pass"],
		["argo v3.1.8 vs floor v3.3.9 (the #2717 release)", checkSemverRange("v3.1.8", "v3.3.9", ""), "fail"],
		["argo v2.11 — a two-component version still compares", checkSemverRange("v2.11", "v3.3.9", ""), "fail"],
		["a missing v prefix is normalised", checkSemverRange("3.3.9", "v3.3.9", ""), "pass"],
		["upper bound is inclusive", checkSemverRange("v3.4.0", "v3.3.0", "v3.4.0"), "pass"],
		["above the ceiling", checkSemverRange("v3.4.1", "v3.3.0", "v3.4.0"), "fail"],
		["a pre-release sorts below its release", checkSemverRange("v3.3.9-rc1", "v3.3.9", ""), "fail"],
		["no window recorded is never a pass", checkSemverRange("v3.3.9", "", ""), "not_evaluable"],
		["an unparseable subject is never a pass", checkSemverRange("latest", "v3.3.9", ""), "not_evaluable"],
		["an unparseable bound is never a pass", checkSemverRange("v3.3.9", "banana", ""), "not_evaluable"],
	];
	const failed = cases.filter(([, got, want]) => got !== want);
	for (const [name, got, want] of cases) {
		console.log(`  ${got === want ? "✓" : "✗"} ${name} → ${got} (want ${want})`);
	}
	if (failed.length > 0) {
		console.error(`\n✗ check-compat self-test failed (${failed.length} case(s))`);
		process.exit(1);
	}
	console.log("\n✓ check-compat self-test passed");
	process.exit(0);
}

if (process.argv.includes("--self-test")) selfTest();

const errors = [];
const matrix = JSON.parse(readFileSync(matrixPath, "utf8"));

// ── The single standard Kubernetes minor (#1212) ────────────────────────────
// Every cloud default must be a version it actually supports, and all clouds must
// agree on one minor — the platform ships a single standard K8s minor, which is the
// version the shipped component/add-on set is evaluated against.
const clouds = Object.entries(matrix.k8s_cloud);
for (const [slug, c] of clouds) {
	if (!Array.isArray(c.supported) || !c.supported.includes(c.default)) {
		errors.push(
			`cloud "${slug}" default ${c.default} is not in its supported set [${(c.supported ?? []).join(", ")}]`,
		);
	}
}
const distinctDefaults = [...new Set(clouds.map(([, c]) => c.default))];
if (distinctDefaults.length !== 1) {
	errors.push(
		`cloud Kubernetes defaults diverge (${distinctDefaults.join(", ")}) — the platform standardizes on a SINGLE minor (#1212), and this guard evaluates the shipped component/add-on set against one default. Reconcile matrix.json k8s_cloud defaults, or teach check-compat a per-cloud component set.`,
	);
}
const defaultK8s = distinctDefaults[0];

// ── Shipped ArgoCD chart ↔ default Kubernetes (the #1165 catch) ─────────────
// ArgoCD is the one component the matrix records multiple releases for, so the
// shipped version must come from the installer's pin, not the matrix.
const argocdSrc = readFileSync(argocdVersionsPath, "utf8");
const argocdRel = relative(repoRoot, argocdVersionsPath);
const argocdMatch = argocdSrc.match(/DefaultArgoChartVersion\s*=\s*"([^"]+)"/);
if (!argocdMatch) {
	errors.push(
		`could not read DefaultArgoChartVersion from ${argocdRel} — format changed? re-anchor the compat guard`,
	);
} else if (defaultK8s) {
	const argocdPin = argocdMatch[1];
	const rel = findRelease(matrix, "argocd", argocdPin);
	if (!rel) {
		errors.push(
			`shipped ArgoCD chart ${argocdPin} (${argocdRel}) is not a recorded matrix release — bump matrix.json or the const in lockstep`,
		);
	} else {
		if (!rel.k8s_min) {
			errors.push(
				`ArgoCD ${argocdPin}: matrix records no k8s_min — the #1165 floor (1.33, where gitops-engine gains the .status.terminatingReplicas schema) must be recorded`,
			);
		}
		// ── The support WINDOW (#3126): the ArgoCD version is a product contract ──
		// Mirrors TestCouplingArgoCD, in both directions: the pin must be admitted, and no
		// release the matrix records as `unsupported` may be.
		const comp = findComponent(matrix, "argocd");
		const win = comp?.supported;
		if (!win || (!win.app_version_min && !win.app_version_max)) {
			errors.push(
				`matrix.json components[argocd] declares no \`supported\` window — the ArgoCD version is a product contract (#3126), and an undeclared window is not an open one`,
			);
		} else if (!rel.app_version) {
			errors.push(
				`ArgoCD ${argocdPin}: no app_version recorded, so the shipped pin cannot be placed inside the support window ${rangeLabel(win.app_version_min, win.app_version_max)}`,
			);
		} else {
			const label = rangeLabel(win.app_version_min, win.app_version_max);
			if (checkSemverRange(rel.app_version, win.app_version_min, win.app_version_max) !== "pass") {
				errors.push(
					`shipped ArgoCD chart ${argocdPin} (app ${rel.app_version}) is outside the declared support window ${label} — bump the pin or widen the window, in lockstep`,
				);
			}
			let flagged = 0;
			for (const r of comp.versions) {
				if (!r.unsupported) continue;
				flagged += 1;
				if (checkSemverRange(r.app_version, win.app_version_min, win.app_version_max) === "pass") {
					errors.push(
						`the ArgoCD support window ${label} ADMITS chart ${r.version} (app ${r.app_version}), which matrix.json records as unsupported — widen the window only by recording a known-good release, never by reaching past a broken one`,
					);
				}
			}
			if (flagged === 0) {
				errors.push(
					`no ArgoCD release is marked \`unsupported\`, so the window-vs-rows check compared nothing — a window that refuses nothing is a claim with no content`,
				);
			}
		}
		if (checkRange(defaultK8s, rel.k8s_min, rel.k8s_max) === "fail") {
			errors.push(
				`shipped ArgoCD ${argocdPin} requires Kubernetes ${rangeLabel(rel.k8s_min, rel.k8s_max)}, but the standard default is ${defaultK8s} — this is the #1165 GitOps-never-converges combination`,
			);
		}
	}
}

// ── Every other component's shipped release ↔ default Kubernetes ────────────
// Each non-ArgoCD component records exactly one shipped release; a component that
// grows a second version needs a shipped-pin source wired here (as ArgoCD has),
// so we fail loudly rather than guess which is shipped.
for (const comp of matrix.components) {
	if (comp.id === "argocd") continue; // handled above via its Go-const pin
	if (!Array.isArray(comp.versions) || comp.versions.length === 0) {
		errors.push(`component "${comp.id}" records no versions in matrix.json`);
		continue;
	}
	if (comp.versions.length > 1) {
		errors.push(
			`component "${comp.id}" records ${comp.versions.length} releases — check:compat can't tell which is shipped. Wire its shipped-pin source (as ArgoCD uses DefaultArgoChartVersion) into check-compat.mjs.`,
		);
		continue;
	}
	const rel = comp.versions[0];
	if (defaultK8s && checkRange(defaultK8s, rel.k8s_min, rel.k8s_max) === "fail") {
		errors.push(
			`component "${comp.id}" ${rel.version} requires Kubernetes ${rangeLabel(rel.k8s_min, rel.k8s_max)}, but the standard default is ${defaultK8s}`,
		);
	}
}

// ── Every marketplace add-on's window ↔ default Kubernetes ───────────────────
for (const [id, rng] of Object.entries(matrix.addon_k8s)) {
	if (defaultK8s && checkRange(defaultK8s, rng.k8s_min, rng.k8s_max) === "fail") {
		errors.push(
			`add-on "${id}" supports Kubernetes ${rangeLabel(rng.k8s_min, rng.k8s_max)}, but the standard default is ${defaultK8s}`,
		);
	}
}

if (errors.length > 0) {
	console.error("✗ compat check failed — shipped defaults are not mutually compatible:\n");
	for (const e of errors) console.error(`  • ${e}`);
	console.error(
		`\n  The version-compat matrix (packages/core/compat/matrix.json) is the source of truth.\n` +
			`  Fix the shipped pin or the recorded window so the default Kubernetes minor is in range.\n`,
	);
	process.exit(1);
}

console.log(
	`✓ compat OK — shipped defaults compatible at Kubernetes ${defaultK8s} ` +
		`(${matrix.components.length} components, ${Object.keys(matrix.addon_k8s).length} add-ons, catalog ${matrix.catalog_version})`,
);
