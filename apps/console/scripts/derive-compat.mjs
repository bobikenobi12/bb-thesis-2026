// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Upstream-derivation tool + drift detector for the version-compatibility matrix (#1216, epic #1186;
// see .github/workflows/compat-drift.yml).
//
// The matrix (packages/core/compat/matrix.json) is the SSOT the fail-closed engine reads. Its per-add-on
// Kubernetes windows (`addon_k8s`) were seeded EMPTY by the #1211 seams → the engine honestly returns
// not_evaluable for every add-on. This tool DERIVES the real windows from upstream so the matrix stops
// being a hand-maintained guess:
//   • Helm charts (always, no creds): each of the 19 marketplace charts declares a `kubeVersion` semver
//     constraint in its Chart.yaml (surfaced in the repo's index.yaml). We convert that to a k8s MINOR
//     window and diff it against what the matrix records.
//   • Cloud k8s versions (credential-gated): the aws/gcloud/az CLIs expose the supported control-plane
//     minors per cloud (describe-cluster-versions / get-server-config / get-versions). When the CLI is
//     absent or unauthenticated the cloud is SKIPPED (never a false failure) — so this runs green in a
//     plain cron and only refreshes k8s_cloud once creds are wired.
//   • Components (no creds): the ArgoCD chart pin (versions.go) and Talos pin (hetzner variables.tf) are
//     cross-checked to be a recorded matrix release (a light JS mirror of #1214's Go drift test).
//
// HONESTY RULE: a chart that declares NO kubeVersion yields an empty window — it STAYS not_evaluable.
// We never invent or widen a bound. Only a real, declared upstream constraint fills a window.
//
// Modes (argv):
//   (default) / --check   derive + diff + print a report; in CI with GITHUB_TOKEN + GITHUB_REPOSITORY it
//                         files/updates ONE deduped drift issue (hidden marker → search → patch vs create,
//                         the posthog-error-issues pattern). Add --strict to exit 1 on any finding.
//   --write               apply derived windows into matrix.json (addon_k8s; cloud k8s_cloud only when a
//                         cloud returned live data) + regenerate the TS mirror via gen-matrix.mjs. The
//                         remediation the filed issue points at.
//   --self-test           run the pure constraint-parser + differ assertions (no network); exit non-zero
//                         on failure. Keeps unit coverage in-file (a future #1217 can wire it into CI).
//   --dry-run             print what would be written/filed without side effects (pairs with --write / CI).
//
// Pure Node (global fetch, Node 20+) + the `yaml` dep (already a console dependency). Run from the console
// package so `yaml` resolves: `pnpm -C apps/console run derive:compat [-- <flags>]`.

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const MATRIX_PATH = resolve(repoRoot, "packages/core/compat/matrix.json");
// Any ONE per-cloud fixture is enough: the fixtures differ only in external-dns's `provider` knob,
// and the chart coordinates this derives from are identical across clouds. hetzner because it is the
// harness's own default cloud, so every reader agrees on which fixture "the" fixture is.
const FIXTURE_PATH = resolve(repoRoot, "test/e2e/fixtures/addon_catalog.hetzner.json");
const GEN_MATRIX = resolve(here, "gen-matrix.mjs");

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const MODE_WRITE = has("--write");
const MODE_SELFTEST = has("--self-test");
const DRY_RUN = has("--dry-run") || process.env.DRY_RUN === "1";
const STRICT = has("--strict");

const GH_TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
const REPO = process.env.GITHUB_REPOSITORY || ""; // owner/name
const MARKER = "<!-- compat-drift -->"; // hidden dedup key tying the GitHub issue back to this scout
const LABELS = ["wave:compat", "from:compat-drift"];
const FETCH_TIMEOUT_MS = Number(process.env.COMPAT_FETCH_TIMEOUT_MS || "60000");
const CLI_TIMEOUT_MS = Number(process.env.COMPAT_CLI_TIMEOUT_MS || "30000");

/** Fail with a clear message + non-zero exit. */
function die(msg) {
	console.error(`derive-compat: ${msg}`);
	process.exit(1);
}

const short = (s) => String(s).replace(/\s+/g, " ").trim().slice(0, 140);
const rel = (p) => p.replace(`${repoRoot}/`, "");
const fmtW = (w) => `[${w.k8s_min || "−∞"}, ${w.k8s_max || "+∞"}]`;

// ── semver-constraint → Kubernetes minor window ─────────────────────────────────────────────────────

/** Compare two "major.minor" strings: <0 if a<b, 0 if equal, >0 if a>b. */
function cmpMM(a, b) {
	const [amaj, amin] = a.split(".").map(Number);
	const [bmaj, bmin] = b.split(".").map(Number);
	return amaj !== bmaj ? amaj - bmaj : amin - bmin;
}

/** Tighten a window's lower bound to the MOST restrictive (highest) min seen. */
function setMin(out, maj, min) {
	if (min < 0) return;
	const v = `${maj}.${min}`;
	if (!out.k8s_min || cmpMM(v, out.k8s_min) > 0) out.k8s_min = v;
}

/** Tighten a window's upper bound to the MOST restrictive (lowest) max seen. */
function setMax(out, maj, min) {
	if (min < 0) return;
	const v = `${maj}.${min}`;
	if (!out.k8s_max || cmpMM(v, out.k8s_max) < 0) out.k8s_max = v;
}

/**
 * Convert a Helm `kubeVersion` semver constraint into an inclusive Kubernetes MINOR window
 * {k8s_min, k8s_max}. Empty strings = unbounded on that side (the engine's "" sentinel). Handles the
 * comparators Helm/Masterminds semver use (>=, >, <=, <, =, ~, ^); the `-0` prerelease suffix charts add
 * to admit prereleases is ignored, as is a leading `v`. Honesty: an empty/unparseable constraint yields
 * an all-empty window (→ not_evaluable), never an invented bound.
 */
export function constraintToWindow(constraint) {
	const out = { k8s_min: "", k8s_max: "" };
	if (!constraint || typeof constraint !== "string") return out;
	const s = constraint.trim();
	if (!s || s === "*" || s.toLowerCase() === "x") return out;

	const tokenRe = /(>=|<=|>|<|=|~|\^)?\s*v?(\d+)\.(\d+|x|\*)(?:\.(\d+|x|\*))?/gi;
	let m;
	while ((m = tokenRe.exec(s)) !== null) {
		const op = m[1] || "=";
		const major = Number(m[2]);
		const minorRaw = m[3];
		if (minorRaw === "x" || minorRaw === "*") continue; // "1.x" → unbounded within major; no minor bound
		const minor = Number(minorRaw);
		const patchRaw = m[4];
		const patchZeroOrAbsent =
			patchRaw === undefined || patchRaw === "x" || patchRaw === "*" || Number(patchRaw) === 0;
		switch (op) {
			case ">=":
				setMin(out, major, minor);
				break;
			case ">":
				setMin(out, major, minor + 1); // strictly greater on the minor axis
				break;
			case "<=":
				setMax(out, major, minor);
				break;
			case "<":
				// exclusive upper: `<1.31.0` admits up to 1.30; `<1.31.4` still admits 1.31.
				setMax(out, major, patchZeroOrAbsent ? minor - 1 : minor);
				break;
			case "~":
				// ~1.20 → >=1.20 <1.21 → the single minor 1.20
				setMin(out, major, minor);
				setMax(out, major, minor);
				break;
			case "^":
				// ^1.20 → >=1.20 <2.0 → floor only (k8s stays major 1, so no useful upper minor)
				setMin(out, major, minor);
				break;
			default:
				// bare "1.25" / "=1.25" → exactly that minor
				setMin(out, major, minor);
				setMax(out, major, minor);
				break;
		}
	}
	return out;
}

// ── Helm derivation ─────────────────────────────────────────────────────────────────────────────────

/** GET text with a timeout (AbortController); throws on non-2xx or timeout. */
async function fetchText(url) {
	const ctl = new AbortController();
	const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
	try {
		const res = await fetch(url, { signal: ctl.signal, headers: { "User-Agent": "alethia-derive-compat" } });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		return await res.text();
	} finally {
		clearTimeout(t);
	}
}

/** Fetch + parse a Helm repo `index.yaml` once (memoized per normalized repo URL). */
async function loadHelmIndex(chartRepo, cache) {
	const key = chartRepo.replace(/\/+$/, "");
	if (cache.has(key)) return cache.get(key);
	let idx;
	try {
		idx = parseYaml(await fetchText(`${key}/index.yaml`));
	} catch (e) {
		idx = { __error: short(e instanceof Error ? e.message : String(e)) };
	}
	cache.set(key, idx);
	return idx;
}

/** Read the `kubeVersion` declared for chart@version in a parsed Helm index (v-prefix insensitive). */
function kubeVersionFromIndex(idx, chart, version) {
	if (!idx || idx.__error) return { found: false, error: idx?.__error || "no index" };
	const entries = idx.entries?.[chart];
	if (!Array.isArray(entries)) return { found: false, error: `chart '${chart}' absent from index` };
	const want = String(version).replace(/^v/, "");
	const entry = entries.find((e) => String(e.version).replace(/^v/, "") === want);
	if (!entry) return { found: false, error: `version '${version}' absent from index` };
	return { found: true, kubeVersion: entry.kubeVersion || "" };
}

/** Derive each add-on's upstream window from its chart's declared kubeVersion. */
async function deriveAddOns(addons) {
	const cache = new Map();
	const out = [];
	for (const a of addons) {
		const idx = await loadHelmIndex(a.chartRepo, cache);
		const kv = kubeVersionFromIndex(idx, a.chart, a.version);
		if (!kv.found) {
			out.push({ id: a.id, chart: a.chart, version: a.version, status: "skipped", reason: kv.error });
		} else if (!kv.kubeVersion) {
			out.push({ id: a.id, chart: a.chart, version: a.version, status: "no_kubeversion" });
		} else {
			out.push({
				id: a.id,
				chart: a.chart,
				version: a.version,
				status: "declared",
				constraint: kv.kubeVersion,
				window: constraintToWindow(kv.kubeVersion),
			});
		}
	}
	return out;
}

// ── differ (add-ons) ──────────────────────────────────────────────────────────────────────────────

/** Classify each add-on's derived window against what the matrix records. */
export function diffAddOns(matrix, derived) {
	const report = { drift: [], uncovered: [], overclaim: [], matched: [], skipped: [] };
	for (const d of derived) {
		const cur = matrix.addon_k8s[d.id] || { k8s_min: "", k8s_max: "" };
		const curEmpty = !cur.k8s_min && !cur.k8s_max;
		if (d.status === "skipped") {
			report.skipped.push({ id: d.id, reason: d.reason });
		} else if (d.status === "no_kubeversion") {
			if (curEmpty) report.matched.push({ id: d.id, kind: "both-empty" });
			else report.overclaim.push({ id: d.id, current: cur });
		} else if (curEmpty) {
			report.uncovered.push({ ...d });
		} else if (cur.k8s_min === d.window.k8s_min && cur.k8s_max === d.window.k8s_max) {
			report.matched.push({ id: d.id, kind: "match" });
		} else {
			report.drift.push({ ...d, current: cur });
		}
	}
	return report;
}

// ── cloud version derivation (credential-gated) ─────────────────────────────────────────────────────

/** Run a CLI, returning {ok, out} or {ok:false, err}. Never throws (missing binary / auth error → err). */
function tryCLI(bin, args) {
	try {
		const out = execFileSync(bin, args, {
			timeout: CLI_TIMEOUT_MS,
			stdio: ["ignore", "pipe", "ignore"],
			encoding: "utf8",
			maxBuffer: 16 * 1024 * 1024,
		});
		return { ok: true, out };
	} catch (e) {
		return { ok: false, err: short(e instanceof Error ? e.message : String(e)) };
	}
}

/** Extract the "major.minor" of a version string, or null. */
function minorOf(v) {
	const m = String(v)
		.replace(/^v/, "")
		.match(/^(\d+)\.(\d+)/);
	return m ? `${m[1]}.${m[2]}` : null;
}

/** Unique "major.minor" list, sorted newest→oldest. */
function uniqMinors(list) {
	const s = new Set();
	for (const v of list) {
		const mm = minorOf(v);
		if (mm) s.add(mm);
	}
	return [...s].sort((a, b) => cmpMM(b, a));
}

/** AWS EKS supported control-plane minors (aws eks describe-cluster-versions). */
function deriveAwsK8s() {
	const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";
	const r = tryCLI("aws", ["eks", "describe-cluster-versions", "--region", region, "--output", "json"]);
	if (!r.ok) return { provider: "aws", status: "skipped", reason: `aws CLI/auth: ${r.err}` };
	try {
		const rows = JSON.parse(r.out).clusterVersions || [];
		const supported = uniqMinors(rows.map((x) => x.clusterVersion).filter(Boolean));
		if (!supported.length) return { provider: "aws", status: "skipped", reason: "no versions returned" };
		return { provider: "aws", status: "live", supported, default: supported[0] };
	} catch (e) {
		return { provider: "aws", status: "skipped", reason: `parse: ${short(String(e))}` };
	}
}

/** GKE supported master minors (gcloud container get-server-config). */
function deriveGcpK8s() {
	const r = tryCLI("gcloud", ["container", "get-server-config", "--format", "json"]);
	if (!r.ok) return { provider: "gcp", status: "skipped", reason: `gcloud CLI/auth: ${r.err}` };
	try {
		const j = JSON.parse(r.out);
		const supported = uniqMinors(j.validMasterVersions || []);
		if (!supported.length) return { provider: "gcp", status: "skipped", reason: "no versions returned" };
		return { provider: "gcp", status: "live", supported, default: minorOf(j.defaultClusterVersion) || supported[0] };
	} catch (e) {
		return { provider: "gcp", status: "skipped", reason: `parse: ${short(String(e))}` };
	}
}

/** AKS supported minors (az aks get-versions). */
function deriveAzureK8s() {
	const loc = process.env.AZURE_LOCATION || process.env.AKS_LOCATION || "eastus";
	const r = tryCLI("az", ["aks", "get-versions", "--location", loc, "-o", "json"]);
	if (!r.ok) return { provider: "azure", status: "skipped", reason: `az CLI/auth: ${r.err}` };
	try {
		const j = JSON.parse(r.out);
		const vers = Array.isArray(j.values)
			? j.values.map((v) => v.version || v.orchestratorVersion).filter(Boolean)
			: (j.orchestrators || []).map((v) => v.orchestratorVersion).filter(Boolean);
		const supported = uniqMinors(vers);
		if (!supported.length) return { provider: "azure", status: "skipped", reason: "no versions returned" };
		return { provider: "azure", status: "live", supported, default: supported[0] };
	} catch (e) {
		return { provider: "azure", status: "skipped", reason: `parse: ${short(String(e))}` };
	}
}

/** Alibaba ACK — the version-metadata call needs the aliyun CLI + a signed API request; not wired in v1. */
function deriveAlibabaK8s() {
	return {
		provider: "alibaba",
		status: "skipped",
		reason: "aliyun ACK version metadata not wired in v1 (add creds + `aliyun cs DescribeKubernetesVersionMetadata`)",
	};
}

/**
 * Validate the matrix's CURATED per-cloud support set against what the cloud actually offers.
 *
 * `k8s_cloud.supported` is a deliberate subset — the minors Alethia's templates pin + test — NOT the
 * cloud's full catalogue. So the cloud API is a VALIDATOR, not an overwrite source:
 *   • unsupported — the matrix still claims a minor the cloud NO LONGER offers (real drift: the cloud
 *     EOL'd a k8s version Alethia advertises). High signal; triggers a drift issue.
 *   • newer — the cloud offers a minor newer than the matrix's curated ceiling (informational nudge to
 *     adopt; it needs template work, so it's report-only and never triggers an issue on its own).
 * The matrix set is never auto-written from a cloud (that would falsely claim support Alethia hasn't wired).
 */
function diffClouds(matrix, cloudResults) {
	const skipped = [];
	const ok = [];
	const unsupported = [];
	const newer = [];
	for (const c of cloudResults) {
		if (c.status !== "live") {
			skipped.push({ provider: c.provider, reason: c.reason });
			continue;
		}
		const cur = matrix.k8s_cloud[c.provider];
		if (!cur) {
			unsupported.push({ provider: c.provider, kind: "missing-in-matrix", offered: c.supported });
			continue;
		}
		const offered = new Set(c.supported);
		const gone = cur.supported.filter((v) => !offered.has(v));
		if (gone.length) unsupported.push({ provider: c.provider, gone, curated: cur.supported, offered: c.supported });
		else ok.push({ provider: c.provider });

		const curMax = cur.supported.slice().sort((a, b) => cmpMM(b, a))[0];
		const higher = c.supported.filter((v) => cmpMM(v, curMax) > 0);
		if (higher.length) newer.push({ provider: c.provider, higher, curatedMax: curMax });
	}
	return { skipped, ok, unsupported, newer };
}

// ── component cross-check (no creds) ────────────────────────────────────────────────────────────────

function readRepoFile(relPath) {
	try {
		return readFileSync(resolve(repoRoot, relPath), "utf8");
	} catch {
		return "";
	}
}

/** Flag a pinned ArgoCD/Talos version that is no longer a recorded matrix release (a bump that missed
 *  the matrix). A light JS mirror of #1214's Go couplings drift test, so the scout catches it too. */
function crossCheckComponents(matrix) {
	const drift = [];
	const recorded = (id) =>
		(matrix.components.find((c) => c.id === id)?.versions || []).map((v) => String(v.version).replace(/^v/, ""));

	const argocdSrc = readRepoFile("packages/core/argocd/versions.go");
	const am = argocdSrc.match(/DefaultArgoChartVersion\s*=\s*"([^"]+)"/);
	if (am && !recorded("argocd").includes(am[1].replace(/^v/, ""))) {
		drift.push({
			component: "argocd",
			pinned: am[1],
			source: "packages/core/argocd/versions.go",
			reason: "pinned chart version is not a recorded matrix release",
		});
	}

	const talosSrc = readRepoFile("infra/templates/project/hetzner/variables.tf");
	const tm = talosSrc.match(/variable "talos_version"[^}]*?default\s*=\s*"([^"]+)"/s);
	if (tm && !recorded("talos").includes(tm[1].replace(/^v/, ""))) {
		drift.push({
			component: "talos",
			pinned: tm[1],
			source: "infra/templates/project/hetzner/variables.tf",
			reason: "pinned Talos version is not a recorded matrix release",
		});
	}
	return drift;
}

// ── report / write / issue-filing ───────────────────────────────────────────────────────────────────

/** True when the report carries anything worth acting on. Cloud "newer available" is an informational
 *  nudge (permanent until adopted via template work), so it never triggers on its own. */
function hasFindings(rep) {
	const a = rep.addons;
	return Boolean(
		a.drift.length || a.uncovered.length || a.overclaim.length || rep.clouds.unsupported.length || rep.components.length,
	);
}

/** Human-readable console report (✓/✗ house style). */
function printReport(rep) {
	const a = rep.addons;
	console.log("\nAdd-on Kubernetes windows (from Helm chart kubeVersion):");
	console.log(
		`  matched ${a.matched.length} · uncovered ${a.uncovered.length} · drift ${a.drift.length} · overclaim ${a.overclaim.length} · skipped ${a.skipped.length}`,
	);
	for (const u of a.uncovered)
		console.log(`  ○ uncovered  ${u.id} → ${fmtW(u.window)}  (${u.chart}@${u.version} kubeVersion '${u.constraint}')`);
	for (const d of a.drift)
		console.log(
			`  ✗ drift      ${d.id}: matrix ${fmtW(d.current)} vs upstream ${fmtW(d.window)}  (${d.chart}@${d.version} '${d.constraint}')`,
		);
	for (const o of a.overclaim)
		console.log(`  ! overclaim  ${o.id}: matrix ${fmtW(o.current)} but chart declares no kubeVersion`);
	for (const s of a.skipped) console.log(`  · skipped    ${s.id}: ${s.reason}`);

	console.log("\nCloud Kubernetes versions (curated set validated against what the cloud offers):");
	for (const c of rep.clouds.ok) console.log(`  ✓ ${c.provider}: curated set still offered by the cloud`);
	for (const u of rep.clouds.unsupported)
		console.log(
			`  ✗ ${u.provider}: matrix claims ${JSON.stringify(u.gone || u.offered)} the cloud no longer offers (offered: ${JSON.stringify(u.offered || "—")})`,
		);
	for (const n of rep.clouds.newer)
		console.log(`  ○ ${n.provider}: cloud now offers ${JSON.stringify(n.higher)} newer than curated ceiling ${n.curatedMax} (adopt via templates)`);
	for (const s of rep.clouds.skipped) console.log(`  · skipped ${s.provider}: ${s.reason}`);

	if (rep.components.length) {
		console.log("\nComponents:");
		for (const c of rep.components) console.log(`  ✗ ${c.component} pinned ${c.pinned} — ${c.reason} (${c.source})`);
	}
}

/** Provenance note recorded on a filled add-on window. */
function provenanceNote(d) {
	return `Chart kubeVersion '${d.constraint}' (${d.chart}@${d.version}); derived by derive-compat.mjs.`;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Write the derived add-on windows into matrix.json via a SURGICAL text replacement — each empty
 * `addon_k8s` entry is a compact one-liner and we keep it that way, so the diff is exactly the filled
 * entries (a JSON.parse→stringify round-trip would re-expand the whole hand-authored file). Returns the
 * count changed. Cloud `k8s_cloud.supported` is a CURATED set (templates + testing), never auto-written
 * from a cloud API — a cloud-EOL drift is reported for a human to act on instead.
 */
function writeMatrix(rep) {
	let text = readFileSync(MATRIX_PATH, "utf8");
	let changed = 0;
	for (const d of [...rep.addons.uncovered, ...rep.addons.drift]) {
		const entry =
			`"${d.id}": { "k8s_min": ${JSON.stringify(d.window.k8s_min)}, ` +
			`"k8s_max": ${JSON.stringify(d.window.k8s_max)}, "note": ${JSON.stringify(provenanceNote(d))} }`;
		const re = new RegExp(`"${escapeRe(d.id)}":\\s*\\{[^{}]*\\}`);
		if (!re.test(text)) {
			console.error(`  ! could not locate addon_k8s.${d.id} in matrix.json — skipped`);
			continue;
		}
		text = text.replace(re, entry);
		changed++;
	}
	if (changed) writeFileSync(MATRIX_PATH, text);
	return changed;
}

/** GitHub REST helper (Bearer GITHUB_TOKEN); die()s on a non-ok response. */
async function gh(path, init = {}) {
	const res = await fetch(`https://api.github.com${path}`, {
		...init,
		headers: {
			Authorization: `Bearer ${GH_TOKEN}`,
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
			...(init.body ? { "Content-Type": "application/json" } : {}),
			...init.headers,
		},
	});
	if (!res.ok) {
		const text = await res.text().catch(() => "");
		die(`GitHub ${init.method || "GET"} ${path} → ${res.status}: ${text.slice(0, 300)}`);
	}
	return res.status === 204 ? null : res.json();
}

/** Best-effort create a label (ignore "already exists"). */
async function ensureLabel(name) {
	try {
		await fetch(`https://api.github.com/repos/${REPO}/labels`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${GH_TOKEN}`,
				Accept: "application/vnd.github+json",
				"X-GitHub-Api-Version": "2022-11-28",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ name, color: "1d76db", description: "compat matrix drift scout" }),
		});
	} catch {
		/* best-effort */
	}
}

/** Find the single open drift issue via the hidden marker. */
async function findExistingIssue() {
	const q = encodeURIComponent(`repo:${REPO} in:body "${MARKER}" type:issue state:open`);
	const r = await gh(`/search/issues?q=${q}&per_page=1`);
	return r.items && r.items[0] ? r.items[0] : null;
}

/** Build the drift issue's title + body. */
function renderIssue(rep) {
	const a = rep.addons;
	const title = `Compat matrix drift: ${a.drift.length} drift · ${a.uncovered.length} uncovered · ${rep.clouds.unsupported.length} cloud`;
	const lines = [
		"The compatibility matrix drifted from upstream reality. Auto-filed by the `compat-drift` scout",
		"(`.github/workflows/compat-drift.yml`).",
		"",
	];
	if (a.drift.length) {
		lines.push("### Drift — recorded window contradicts upstream", "", "| add-on | matrix | upstream | source |", "| --- | --- | --- | --- |");
		for (const d of a.drift) lines.push(`| \`${d.id}\` | ${fmtW(d.current)} | ${fmtW(d.window)} | ${d.chart}@${d.version} \`${d.constraint}\` |`);
		lines.push("");
	}
	if (a.uncovered.length) {
		lines.push("### Uncovered — matrix empty, upstream declares a window", "", "| add-on | upstream window | chart |", "| --- | --- | --- |");
		for (const u of a.uncovered) lines.push(`| \`${u.id}\` | ${fmtW(u.window)} | ${u.chart}@${u.version} \`${u.constraint}\` |`);
		lines.push("");
	}
	if (a.overclaim.length) {
		lines.push("### Over-claim — matrix records a window the chart no longer declares", "");
		for (const o of a.overclaim) lines.push(`- \`${o.id}\`: matrix ${fmtW(o.current)}`);
		lines.push("");
	}
	if (rep.clouds.unsupported.length) {
		lines.push("### Cloud Kubernetes versions — matrix claims support the cloud dropped", "");
		for (const u of rep.clouds.unsupported)
			lines.push(`- \`${u.provider}\`: curated ${JSON.stringify(u.gone || u.offered)} no longer offered (cloud offers ${JSON.stringify(u.offered || "—")})`);
		lines.push("");
	}
	if (rep.clouds.newer.length) {
		lines.push("### Cloud Kubernetes versions — newer available (informational)", "");
		for (const n of rep.clouds.newer)
			lines.push(`- \`${n.provider}\`: cloud offers ${JSON.stringify(n.higher)} newer than curated ceiling \`${n.curatedMax}\` — adopt via templates if desired`);
		lines.push("");
	}
	if (rep.components.length) {
		lines.push("### Components", "");
		for (const c of rep.components) lines.push(`- \`${c.component}\` pinned ${c.pinned} — ${c.reason} (\`${c.source}\`)`);
		lines.push("");
	}
	lines.push(
		"### Remediation",
		"Regenerate the windows, review the diff, and open a PR into `dev`:",
		"```",
		"pnpm -C apps/console run derive:compat -- --write",
		"```",
		"Windows are recorded honestly — a chart that declares no `kubeVersion` stays empty (`not_evaluable`).",
		"",
		MARKER,
	);
	return { title, body: lines.join("\n") };
}

/** File or update the single deduped drift issue. */
async function fileDriftIssue(rep) {
	await ensureLabel(LABELS[0]);
	await ensureLabel(LABELS[1]);
	const { title, body } = renderIssue(rep);
	const existing = await findExistingIssue();
	if (existing) {
		await gh(`/repos/${REPO}/issues/${existing.number}`, { method: "PATCH", body: JSON.stringify({ title, body }) });
		await gh(`/repos/${REPO}/issues/${existing.number}/comments`, {
			method: "POST",
			body: JSON.stringify({ body: "Compat-drift report refreshed — the matrix still drifts from upstream." }),
		});
		console.log(`updated drift issue #${existing.number}`);
	} else {
		const res = await gh(`/repos/${REPO}/issues`, { method: "POST", body: JSON.stringify({ title, body, labels: LABELS }) });
		console.log(`created drift issue #${res.number}`);
	}
}

// ── self-test (pure; no network) ────────────────────────────────────────────────────────────────────

function selfTest() {
	let fails = 0;
	const eq = (got, want, label) => {
		const g = JSON.stringify(got);
		const w = JSON.stringify(want);
		if (g === w) console.log(`ok   - ${label}`);
		else {
			console.error(`FAIL - ${label}: want ${w} got ${g}`);
			fails++;
		}
	};

	eq(constraintToWindow(">=1.16.0-0"), { k8s_min: "1.16", k8s_max: "" }, ">= lower bound, prerelease stripped");
	eq(constraintToWindow(">=1.16.0-0 <1.31.0-0"), { k8s_min: "1.16", k8s_max: "1.30" }, "range: exclusive .0 upper → minor-1");
	eq(constraintToWindow(">= 1.23.0-0"), { k8s_min: "1.23", k8s_max: "" }, "spaced >=");
	eq(constraintToWindow("<=1.28"), { k8s_min: "", k8s_max: "1.28" }, "<= inclusive upper");
	eq(constraintToWindow("<1.28.4"), { k8s_min: "", k8s_max: "1.28" }, "< with non-zero patch keeps the minor");
	eq(constraintToWindow("~1.20"), { k8s_min: "1.20", k8s_max: "1.20" }, "~ tilde → single minor");
	eq(constraintToWindow("^1.20"), { k8s_min: "1.20", k8s_max: "" }, "^ caret → floor only");
	eq(constraintToWindow("1.25"), { k8s_min: "1.25", k8s_max: "1.25" }, "bare exact minor");
	eq(constraintToWindow(">1.19"), { k8s_min: "1.20", k8s_max: "" }, "strict > bumps the minor");
	eq(constraintToWindow(""), { k8s_min: "", k8s_max: "" }, "empty → unbounded (honest)");
	eq(constraintToWindow("*"), { k8s_min: "", k8s_max: "" }, "wildcard → unbounded");
	eq(constraintToWindow(">=1.19.0-0 <1.22.0-0"), { k8s_min: "1.19", k8s_max: "1.21" }, "tight range");

	const matrix = {
		addon_k8s: {
			a: { k8s_min: "", k8s_max: "" },
			b: { k8s_min: "1.20", k8s_max: "1.30" },
			c: { k8s_min: "1.20", k8s_max: "" },
			f: { k8s_min: "", k8s_max: "" },
			g: { k8s_min: "1.20", k8s_max: "1.30" },
		},
		k8s_cloud: {},
		components: [],
	};
	const derived = [
		{ id: "a", chart: "a", version: "1", status: "declared", window: { k8s_min: "1.22", k8s_max: "" }, constraint: ">=1.22" },
		{ id: "b", chart: "b", version: "1", status: "declared", window: { k8s_min: "1.20", k8s_max: "1.30" }, constraint: ">=1.20 <1.31" },
		{ id: "c", chart: "c", version: "1", status: "declared", window: { k8s_min: "1.21", k8s_max: "" }, constraint: ">=1.21" },
		{ id: "f", chart: "f", version: "1", status: "no_kubeversion" },
		{ id: "g", chart: "g", version: "1", status: "no_kubeversion" },
	];
	const d = diffAddOns(matrix, derived);
	eq(d.uncovered.map((x) => x.id), ["a"], "differ: empty + declared → uncovered");
	eq(d.matched.filter((x) => x.kind === "match").map((x) => x.id), ["b"], "differ: equal window → matched");
	eq(d.drift.map((x) => x.id), ["c"], "differ: differing window → drift");
	eq(d.matched.filter((x) => x.kind === "both-empty").map((x) => x.id), ["f"], "differ: empty + no kubeVersion → both-empty");
	eq(d.overclaim.map((x) => x.id), ["g"], "differ: recorded window + no kubeVersion → over-claim");

	if (fails) {
		console.error(`\nself-test: ${fails} check(s) FAILED`);
		process.exit(1);
	}
	console.log("\nself-test: all passed");
	process.exit(0);
}

// ── main ────────────────────────────────────────────────────────────────────────────────────────────

async function main() {
	if (MODE_SELFTEST) return selfTest();

	const matrix = JSON.parse(readFileSync(MATRIX_PATH, "utf8"));
	const addons = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")).map((a) => ({
		id: a.id,
		chart: a.chart,
		chartRepo: a.chartRepo,
		version: a.version,
	}));
	console.log(`Deriving compat from upstream — ${addons.length} add-on charts + cloud version APIs.`);

	const rep = {
		addons: diffAddOns(matrix, await deriveAddOns(addons)),
		clouds: diffClouds(matrix, [deriveAwsK8s(), deriveGcpK8s(), deriveAzureK8s(), deriveAlibabaK8s()]),
		components: crossCheckComponents(matrix),
	};
	printReport(rep);

	if (MODE_WRITE) {
		const pending = rep.addons.uncovered.length + rep.addons.drift.length;
		if (pending === 0) {
			console.log("\nNo windows to write — matrix already matches upstream.");
		} else if (DRY_RUN) {
			console.log(`\n[dry-run] would write ${pending} matrix entr${pending === 1 ? "y" : "ies"} + regenerate matrix.ts.`);
		} else {
			const n = writeMatrix(rep);
			console.log(`\n✓ wrote ${n} entr${n === 1 ? "y" : "ies"} to ${rel(MATRIX_PATH)}; regenerating matrix.ts…`);
			execFileSync("node", [GEN_MATRIX], { stdio: "inherit" });
		}
		return;
	}

	// Scout mode: file/update ONE deduped issue when there are findings + a token + a repo (never on dry-run).
	if (hasFindings(rep) && GH_TOKEN && REPO && !DRY_RUN) {
		await fileDriftIssue(rep);
	} else if (hasFindings(rep)) {
		const why = !GH_TOKEN || !REPO ? " (no GITHUB_TOKEN/GITHUB_REPOSITORY — not filing)" : "";
		console.log(`\n${DRY_RUN ? "[dry-run] " : ""}findings present${why}.`);
	} else {
		console.log("\n✓ matrix is in sync with upstream — nothing to file.");
	}

	if (STRICT && hasFindings(rep)) process.exit(1);
}

main().catch((e) => die(e instanceof Error ? e.stack || e.message : String(e)));
