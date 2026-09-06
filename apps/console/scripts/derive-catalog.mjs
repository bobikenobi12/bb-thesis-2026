// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Upstream-derivation tool + drift detector for the OFFLINE managed-database version baseline
// (#1373, epic #928; see .github/workflows/catalog-drift.yml). Sibling of derive-compat.mjs — same
// flags, same honesty rule, same deduped-issue mechanics.
//
// `packages/core/catalog/catalog.json` carries `database.<cloud>.engines[].versions` — the list the
// canvas picker falls back to when an account's capabilities haven't synced, and the value space that
// flows into each provider's tofu `engine_version` variable. It is hand-seeded from vendor docs, so
// it rots: a major reaches end of standard support and the picker keeps offering it.
//
// WHAT THIS BUYS TODAY — read before wiring the cron and expecting output. Unlike the compat scout,
// which has a public creds-free source (each chart's Chart.yaml `kubeVersion`), EVERY managed-DB
// version API is credential-gated. With no cloud creds attached this run SKIPS every cloud and
// reports nothing, deliberately and greenly. It starts earning its keep the moment read-only creds
// are wired into the workflow.
//
// CURATED-SET RULE (inherited from derive-compat's k8s_cloud handling, and load-bearing here):
// `versions` is a CURATED subset — the majors Alethia offers — NOT the cloud's full catalogue. Every
// cloud still offers EOL majors under paid extended support (AWS lists 11/12/13; Cloud SQL lists 9.6).
// So the cloud API is a VALIDATOR, never an overwrite source:
//   • stale   — the catalog offers a version the cloud NO LONGER offers. Real drift; --write prunes it.
//   • newer   — the cloud offers something above the catalog's ceiling. Report-only: adopting a major
//               is a decision (it may need template/param work), so it is never auto-written.
//   • default — the seeded `default_version` is no longer offered. Highest signal: every unversioned
//               project provisions on it. NEVER auto-written; changing a default is a product call.
//   • pin     — the TEMPLATE's pinned Aurora minor is no longer offered. Not a forecast: the apply is
//               already failing. Checked separately from the catalog because the catalog is
//               major-grained and a major does not rot — which is exactly how this scout reported
//               "baseline still offered" for months while every full-bar aws nightly died on
//               "Cannot find version 16.6 for aurora-postgresql".
//
// Modes (argv):
//   (default) / --check   derive + diff + print a report; in CI with GITHUB_TOKEN + GITHUB_REPOSITORY it
//                         files/updates ONE deduped drift issue (hidden marker → search → patch vs create).
//                         Add --strict to exit 1 on any finding.
//   --write               prune stale versions from catalog.json + regenerate the TS mirror via
//                         gen-catalog.mjs. Never adds, never touches a default.
//   --self-test           run the pure parser/differ assertions (no network, no creds); exit non-zero
//                         on failure.
//   --dry-run             print what would be written/filed without side effects.
//
// Pure Node (global fetch, Node 20+), no deps. Run from the console package:
//   pnpm -C apps/console run derive:catalog [-- <flags>]
// This script single-quotes its jq-free JSON fixtures and templates on purpose — SC2016 does not apply.

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const CATALOG_PATH = resolve(repoRoot, "packages/core/catalog/catalog.json");
const GEN_CATALOG = resolve(here, "gen-catalog.mjs");
// The SSOT for the Aurora minor every AWS template default is coupled to (TestAuroraVersionCouplings
// keeps the .tf copies equal to it, so reading the Go constant covers all of them).
const AWS_PROVIDER_GO = resolve(repoRoot, "packages/core/cloud/aws_provider.go");

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const MODE_WRITE = has("--write");
const MODE_SELFTEST = has("--self-test");
const DRY_RUN = has("--dry-run") || process.env.DRY_RUN === "1";
const STRICT = has("--strict");

const GH_TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
const REPO = process.env.GITHUB_REPOSITORY || ""; // owner/name
const MARKER = "<!-- catalog-drift -->"; // hidden dedup key tying the GitHub issue back to this scout
const LABELS = ["wave:capabilities", "from:catalog-drift"];
const CLI_TIMEOUT_MS = Number(process.env.CATALOG_CLI_TIMEOUT_MS || "60000");

// Clouds this scout cannot derive, and why. Recorded rather than silently absent (cloud-parity rule):
// a cloud missing from the report must be a documented decision, not a gap nobody noticed.
const EXCLUDED = {
	hetzner:
		"no enumeration API — the engine is the CloudNativePG Helm chart, pinned to one version by decision (#1351)",
	alibaba:
		"the ApsaraDB version call needs a signed aliyun API request; not wired in v1 (add creds + `aliyun rds DescribeAvailableResource`)",
};

function die(msg) {
	console.error(`✗ ${msg}`);
	process.exit(1);
}

const short = (s) => String(s).replace(/\s+/g, " ").trim().slice(0, 140);
const rel = (p) => p.replace(`${repoRoot}/`, "");

// ── pure version helpers ────────────────────────────────────────────────────────────────────────────

/**
 * Order two version strings newest-first by NUMERIC segment, so "9" sorts below "10" (a lexical
 * compare gets that backwards) and "8.0.21" below "8.4". Missing/non-numeric segments compare as 0,
 * which is what makes it total across every provider's grain — "16", "16.0" and "8.0.21" are the same
 * axis expressed three ways, and this file must not care which.
 */
function compareVersionsDesc(a, b) {
	const as = String(a).split(".");
	const bs = String(b).split(".");
	for (let i = 0; i < Math.max(as.length, bs.length); i++) {
		const an = Number.parseInt(as[i] ?? "", 10) || 0;
		const bn = Number.parseInt(bs[i] ?? "", 10) || 0;
		if (an !== bn) return bn - an;
	}
	return 0;
}

/** Unique versions, newest-first. */
function dedupeVersionsDesc(list) {
	return [...new Set(list.filter((v) => typeof v === "string" && v.length > 0))].sort(compareVersionsDesc);
}

/**
 * Parse a Cloud SQL databaseVersion token ("POSTGRES_16", "MYSQL_8_0") into { family, version }.
 * Underscores in the numeric tail become dots — which reproduces the grain the catalog and the
 * console's own GCP lane already use ("16", "8.0"), so all three agree on one value space.
 */
function parseSqlVersionToken(token) {
	const idx = String(token).indexOf("_");
	if (idx < 0) return null;
	const family = token.slice(0, idx);
	if (family !== "POSTGRES" && family !== "MYSQL") return null;
	return { family, version: token.slice(idx + 1).replace(/_/g, ".") };
}

/**
 * Pull server versions out of an `az … flexible-server list-skus` payload.
 *
 * Shape-tolerant by design: it walks the tree for version nodes rather than pinning one path, since a
 * hard path would turn a CLI reshape into a silent permanent skip — the failure mode this scout exists
 * to prevent. Verified against the live payload (2026-07-26, eastus):
 *   • MySQL nests the real set at `[].supportedFlexibleServerEditions[].supportedServerVersions[].name`.
 *   • PostgreSQL exposes `[].supportedServerVersions` directly — EMPTY when the subscription is
 *     provisioning-restricted in that region, which is an honest "this account offers nothing here".
 *
 * ARRAY-VALUED ONLY, deliberately: the same payload also carries a STRING
 * `supportedFastProvisioningEditions[].supportedServerVersions` ("12"), which is one edition's pinned
 * version, not the offered set. Accepting strings would quietly inject it into the account's offering.
 */
function collectAzureServerVersions(payload) {
	const out = [];
	const walk = (node) => {
		if (Array.isArray(node)) {
			for (const n of node) walk(n);
			return;
		}
		if (!node || typeof node !== "object") return;
		for (const [k, v] of Object.entries(node)) {
			if (/^(supported)?serverVersions?$/i.test(k) && Array.isArray(v)) {
				for (const entry of v) {
					if (typeof entry === "string") out.push(entry);
					else if (entry && typeof entry === "object") {
						const name = entry.serverVersion ?? entry.name ?? entry.serverVersionName;
						if (typeof name === "string") out.push(name);
					}
				}
			}
			walk(v);
		}
	};
	walk(payload);
	return dedupeVersionsDesc(out);
}

/**
 * Diff ONE catalog engine against what its cloud offers.
 *
 * `offered` empty means "the cloud told us nothing" and yields no findings at all — an unauthenticated
 * or reshaped API must never read as "every version you offer is gone".
 */
function diffEngine(engine, offered) {
	if (!offered || offered.length === 0) return { stale: [], newer: [], defaultGone: false };
	const have = new Set(offered);
	const stale = engine.versions.filter((v) => !have.has(v));
	const ceiling = engine.versions.slice().sort(compareVersionsDesc)[0];
	const newer = offered.filter((v) => compareVersionsDesc(v, ceiling) < 0);
	return { stale, newer, defaultGone: !have.has(engine.default_version) };
}

// ── cloud derivation (credential-gated) ─────────────────────────────────────────────────────────────

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

/**
 * AWS RDS — offered MAJOR versions per engine (`describe-db-engine-versions`).
 *
 * Keyed on `MajorEngineVersion` because the API returns one row per MINOR: 16.4/16.6/16.8 are one
 * offering, and the catalog (like the console's AWS lane) offers the major. AWS resolves a major to
 * its current default minor at create time, which is why a major-grained baseline doesn't rot the way
 * a pinned minor does.
 */
function deriveAws(engines) {
	const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";
	const out = {};
	for (const e of engines) {
		const r = tryCLI("aws", [
			"rds",
			"describe-db-engine-versions",
			"--engine",
			e.value,
			"--region",
			region,
			"--output",
			"json",
		]);
		if (!r.ok) return { provider: "aws", status: "skipped", reason: `aws CLI/auth: ${r.err}` };
		try {
			const rows = JSON.parse(r.out).DBEngineVersions || [];
			out[e.value] = dedupeVersionsDesc(rows.map((v) => v.MajorEngineVersion || v.EngineVersion));
		} catch (err) {
			return { provider: "aws", status: "skipped", reason: `parse: ${short(String(err))}` };
		}
	}
	return { provider: "aws", status: "live", byEngine: out };
}

/**
 * Cloud SQL — offered versions per engine family, from the union of every flag's `appliesTo`.
 *
 * `flags.list` is the same source the console's GCP capability lane reads: there is no dedicated
 * "list database versions" API, but every flag row carries the whole DATABASE_VERSION set it applies
 * to, so the union is the offered set.
 */
function deriveGcp(engines) {
	const r = tryCLI("gcloud", ["sql", "flags", "list", "--format", "json"]);
	if (!r.ok) return { provider: "gcp", status: "skipped", reason: `gcloud CLI/auth: ${r.err}` };
	let byFamily;
	try {
		byFamily = new Map();
		for (const flag of JSON.parse(r.out) ?? []) {
			for (const token of flag.appliesTo ?? []) {
				const parsed = parseSqlVersionToken(token);
				if (!parsed) continue;
				byFamily.set(parsed.family, [...(byFamily.get(parsed.family) ?? []), parsed.version]);
			}
		}
	} catch (err) {
		return { provider: "gcp", status: "skipped", reason: `parse: ${short(String(err))}` };
	}
	const out = {};
	for (const e of engines) {
		const fam = e.family === "mysql" ? "MYSQL" : "POSTGRES";
		out[e.value] = dedupeVersionsDesc(byFamily.get(fam) ?? []);
	}
	if (Object.values(out).every((v) => v.length === 0)) {
		return { provider: "gcp", status: "skipped", reason: "flags.list returned no DATABASE_VERSION tokens" };
	}
	return { provider: "gcp", status: "live", byEngine: out };
}

/** Azure flexible servers — offered versions per engine (`az {postgres,mysql} flexible-server list-skus`). */
function deriveAzure(engines) {
	const loc = process.env.AZURE_LOCATION || process.env.AZURE_DB_LOCATION || "eastus";
	const out = {};
	for (const e of engines) {
		const group = e.family === "mysql" ? "mysql" : "postgres";
		const r = tryCLI("az", [group, "flexible-server", "list-skus", "--location", loc, "-o", "json"]);
		if (!r.ok) return { provider: "azure", status: "skipped", reason: `az CLI/auth: ${r.err}` };
		try {
			out[e.value] = collectAzureServerVersions(JSON.parse(r.out));
		} catch (err) {
			return { provider: "azure", status: "skipped", reason: `parse: ${short(String(err))}` };
		}
	}
	if (Object.values(out).every((v) => v.length === 0)) {
		return { provider: "azure", status: "skipped", reason: "list-skus carried no server versions" };
	}
	return { provider: "azure", status: "live", byEngine: out };
}

/** Derive every cloud, then diff each engine. Excluded clouds are reported, not omitted. */
/**
 * Validate the AWS templates' PINNED AURORA MINOR against what AWS still offers.
 *
 * This is a different question from the catalog check above, and the difference cost a nightly. The
 * catalog is major-grained ("16"), and a major does not rot — so `deriveAws` reported
 * "baseline still offered" while every full-bar aws apply was dying on
 * "Cannot find version 16.6 for aurora-postgresql". The rot was in the TEMPLATE's full minor, a value
 * this scout never looked at.
 *
 * The pin has to be a full minor (AWS rejects a bare major with "Engine version is not a valid full
 * version"), which is exactly why it rots and why it needs watching.
 *
 * `-limitless` variants are filtered out deliberately: "16.6-limitless" still exists and is a
 * DIFFERENT offering (Aurora Limitless). Counting it as a match is how you conclude 16.6 is fine
 * while the apply fails.
 */
function deriveAuroraTemplatePin() {
	const name = "aws aurora-postgresql template pin";
	let pinned;
	try {
		const src = readFileSync(AWS_PROVIDER_GO, "utf8");
		const m = src.match(/DefaultAuroraPostgresVersion\s*=\s*"([^"]+)"/);
		if (!m) {
			return { kind: "pin", name, status: "skipped", reason: `no DefaultAuroraPostgresVersion in ${rel(AWS_PROVIDER_GO)} (renamed? re-anchor this check)` };
		}
		pinned = m[1];
	} catch (err) {
		return { kind: "pin", name, status: "skipped", reason: `read ${rel(AWS_PROVIDER_GO)}: ${short(String(err))}` };
	}

	const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";
	const r = tryCLI("aws", [
		"rds", "describe-db-engine-versions",
		"--engine", "aurora-postgresql",
		"--region", region,
		"--output", "json",
	]);
	if (!r.ok) return { kind: "pin", name, status: "skipped", reason: `aws CLI/auth: ${r.err}` };

	let offered;
	try {
		offered = (JSON.parse(r.out).DBEngineVersions || [])
			.map((v) => v.EngineVersion)
			.filter((v) => typeof v === "string" && !v.includes("-"));
	} catch (err) {
		return { kind: "pin", name, status: "skipped", reason: `parse: ${short(String(err))}` };
	}

	return {
		kind: "pin", name, status: "live", pinned, region,
		ok: offered.includes(pinned),
		offered: dedupeVersionsDesc(offered.filter((v) => v.split(".")[0] === pinned.split(".")[0])),
		source: rel(AWS_PROVIDER_GO),
	};
}

function deriveAll(catalog) {
	const results = [];
	for (const [provider, dp] of Object.entries(catalog.database)) {
		if (EXCLUDED[provider]) {
			results.push({ provider, status: "excluded", reason: EXCLUDED[provider] });
			continue;
		}
		const derive = { aws: deriveAws, gcp: deriveGcp, azure: deriveAzure }[provider];
		if (!derive) {
			results.push({ provider, status: "skipped", reason: "no deriver for this cloud" });
			continue;
		}
		const r = derive(dp.engines);
		if (r.status !== "live") {
			results.push(r);
			continue;
		}
		const engines = dp.engines.map((e) => ({
			engine: e.value,
			catalog: e.versions,
			defaultVersion: e.default_version,
			offered: r.byEngine[e.value] ?? [],
			...diffEngine(e, r.byEngine[e.value] ?? []),
		}));
		results.push({ provider, status: "live", engines });
	}
	results.push(deriveAuroraTemplatePin());
	return results;
}

// ── report ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * True when the report carries anything worth acting on. "newer available" is an informational nudge
 * that stays true until a human adopts the major, so it never triggers an issue on its own — the same
 * call derive-compat makes, and for the same reason: a permanently-true finding trains people to
 * ignore the scout.
 */
function hasFindings(rep) {
	return rep.some((r) => {
		// A withdrawn template pin is the highest-signal finding this scout can make: it is not a
		// forecast, it is an apply that is already failing.
		if (r.kind === "pin") return r.status === "live" && !r.ok;
		return r.status === "live" && r.engines.some((e) => e.stale.length > 0 || e.defaultGone);
	});
}

function printReport(rep) {
	console.log("\nManaged-database engine versions (curated baseline validated against what the cloud offers):");
	for (const r of rep) {
		if (r.kind === "pin") {
			if (r.status !== "live") {
				console.log(`  · skipped  ${r.name}: ${r.reason}`);
			} else if (r.ok) {
				console.log(`  ✓ ${r.name}: ${r.pinned} still offered in ${r.region}`);
			} else {
				console.log(
					`  ✗ ${r.name}: ${r.pinned} is NO LONGER OFFERED in ${r.region} — every AWS apply that ` +
						`does not override engine_version fails. Cloud offers ${JSON.stringify(r.offered)}. Fix ${r.source}.`,
				);
			}
			continue;
		}
		if (r.status === "excluded") {
			console.log(`  · excluded ${r.provider}: ${r.reason}`);
			continue;
		}
		if (r.status !== "live") {
			console.log(`  · skipped  ${r.provider}: ${r.reason}`);
			continue;
		}
		for (const e of r.engines) {
			if (e.offered.length === 0) {
				console.log(`  · skipped  ${r.provider}/${e.engine}: cloud returned no versions`);
				continue;
			}
			if (e.defaultGone) {
				console.log(
					`  ✗ ${r.provider}/${e.engine}: DEFAULT ${e.defaultVersion} is no longer offered (cloud: ${JSON.stringify(e.offered)})`,
				);
			}
			if (e.stale.length) {
				console.log(`  ✗ ${r.provider}/${e.engine}: catalog offers ${JSON.stringify(e.stale)}, the cloud does not`);
			}
			if (e.newer.length) {
				console.log(`  ○ ${r.provider}/${e.engine}: cloud offers ${JSON.stringify(e.newer)} above the catalog ceiling (adopt deliberately)`);
			}
			if (!e.defaultGone && !e.stale.length && !e.newer.length) {
				console.log(`  ✓ ${r.provider}/${e.engine}: baseline still offered`);
			}
		}
	}
}

// ── write (prune only) ──────────────────────────────────────────────────────────────────────────────

/**
 * Prune stale versions from BOTH catalog surfaces (`database` and the camelCase `live.dbEngines`
 * mirror) and return the count removed.
 *
 * Only ever removes. Adding a major is a decision with template blast radius, and rewriting a default
 * changes what every unversioned project provisions — both are reported for a human instead. A prune
 * that would empty a list, or that would remove the default, is refused: an empty `versions` breaks
 * the fail-open picker, which is a worse outcome than a stale entry.
 */
function writeCatalog(rep) {
	const catalog = JSON.parse(readFileSync(CATALOG_PATH, "utf8"));
	let removed = 0;
	for (const r of rep) {
		if (r.status !== "live") continue;
		for (const e of r.engines) {
			if (!e.stale.length) continue;
			const engines = catalog.database[r.provider].engines;
			const idx = engines.findIndex((x) => x.value === e.engine);
			if (idx < 0) continue;
			const kept = engines[idx].versions.filter((v) => !e.stale.includes(v));
			if (kept.length === 0 || !kept.includes(engines[idx].default_version)) {
				console.error(
					`  ! ${r.provider}/${e.engine}: pruning ${JSON.stringify(e.stale)} would empty the list or drop the default — refused, fix by hand`,
				);
				continue;
			}
			removed += engines[idx].versions.length - kept.length;
			engines[idx].versions = kept;
			// The live mirror is index-parallel with database.engines; gen-catalog.mjs re-checks that.
			catalog.live.dbEngines[r.provider][idx].versions = kept;
		}
	}
	if (removed) writeFileSync(CATALOG_PATH, `${JSON.stringify(catalog, null, "\t")}\n`);
	return removed;
}

// ── GitHub issue (deduped by hidden marker) ─────────────────────────────────────────────────────────

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
			body: JSON.stringify({ name, color: "1d76db", description: "catalog version drift scout" }),
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

function renderIssue(rep) {
	// The pin rows carry no `engines`; keep them out of every engine-shaped flatMap below.
	const pinRows = rep.filter((r) => r.kind === "pin");
	const live = rep.filter((r) => r.status === "live" && r.kind !== "pin");
	const staleRows = live.flatMap((r) => r.engines.filter((e) => e.stale.length).map((e) => ({ ...e, provider: r.provider })));
	const defaultRows = live.flatMap((r) => r.engines.filter((e) => e.defaultGone).map((e) => ({ ...e, provider: r.provider })));
	const newerRows = live.flatMap((r) => r.engines.filter((e) => e.newer.length).map((e) => ({ ...e, provider: r.provider })));

	const title = `Catalog DB-version drift: ${staleRows.length} stale · ${defaultRows.length} default gone`;
	const lines = [
		"The offline managed-database version baseline drifted from what the clouds actually offer.",
		"Auto-filed by the `catalog-drift` scout (`.github/workflows/catalog-drift.yml`).",
		"",
		"This is the list the canvas falls back to when an account's capabilities haven't synced, and the",
		"value space that reaches each provider's tofu `engine_version` — so a stale entry is an apply that",
		"fails, not a cosmetic UI nit.",
		"",
	];
	const brokenPins = pinRows.filter((r) => r.status === "live" && !r.ok);
	if (brokenPins.length) {
		lines.push(
			"### Template pin withdrawn — APPLY IS ALREADY FAILING",
			"",
			"This is not a forecast. Any apply that does not override `engine_version` fails at the cluster",
			"with `InvalidParameterCombination: Cannot find version <v>`.",
			"",
			"| pin | value | region | cloud offers (same major) | source |",
			"| --- | --- | --- | --- | --- |",
		);
		for (const r of brokenPins)
			lines.push(`| \`${r.name}\` | \`${r.pinned}\` | \`${r.region}\` | ${JSON.stringify(r.offered)} | \`${r.source}\` |`);
		lines.push(
			"",
			"Fix the Go constant; `TestAuroraVersionCouplings` then forces the template copies to follow.",
			"",
		);
	}
	if (defaultRows.length) {
		lines.push(
			"### Default no longer offered — highest signal",
			"",
			"Every project that doesn't pin a version provisions on this value.",
			"",
			"| cloud | engine | default | cloud offers |",
			"| --- | --- | --- | --- |",
		);
		for (const e of defaultRows)
			lines.push(`| \`${e.provider}\` | \`${e.engine}\` | \`${e.defaultVersion}\` | ${JSON.stringify(e.offered)} |`);
		lines.push("");
	}
	if (staleRows.length) {
		lines.push("### Stale — catalog offers versions the cloud dropped", "", "| cloud | engine | stale | cloud offers |", "| --- | --- | --- | --- |");
		for (const e of staleRows)
			lines.push(`| \`${e.provider}\` | \`${e.engine}\` | ${JSON.stringify(e.stale)} | ${JSON.stringify(e.offered)} |`);
		lines.push("");
	}
	if (newerRows.length) {
		lines.push("### Newer available (informational)", "");
		for (const e of newerRows)
			lines.push(`- \`${e.provider}/${e.engine}\`: cloud offers ${JSON.stringify(e.newer)} above the catalog ceiling — adopt deliberately (may need template work)`);
		lines.push("");
	}
	const notLive = rep.filter((r) => r.status !== "live");
	if (notLive.length) {
		lines.push("### Not derived this run", "");
		for (const r of notLive) lines.push(`- \`${r.provider ?? r.name}\` — ${r.status}: ${r.reason}`);
		lines.push("");
	}
	lines.push(
		"### Remediation",
		"Prune the stale entries, review the diff, and open a PR into `dev`:",
		"```",
		"pnpm -C apps/console run derive:catalog -- --write",
		"```",
		"`--write` only ever REMOVES. Adopting a newer major, or changing a `default_version`, is a",
		"deliberate decision with template blast radius and is never written automatically.",
		"",
		MARKER,
	);
	return { title, body: lines.join("\n") };
}

async function fileDriftIssue(rep) {
	await ensureLabel(LABELS[0]);
	await ensureLabel(LABELS[1]);
	const { title, body } = renderIssue(rep);
	const existing = await findExistingIssue();
	if (existing) {
		await gh(`/repos/${REPO}/issues/${existing.number}`, { method: "PATCH", body: JSON.stringify({ title, body }) });
		await gh(`/repos/${REPO}/issues/${existing.number}/comments`, {
			method: "POST",
			body: JSON.stringify({ body: "Catalog-drift report refreshed — the version baseline still drifts from the clouds." }),
		});
		console.log(`updated drift issue #${existing.number}`);
	} else {
		const res = await gh(`/repos/${REPO}/issues`, { method: "POST", body: JSON.stringify({ title, body, labels: LABELS }) });
		console.log(`created drift issue #${res.number}`);
	}
}

// ── self-test (pure; no network, no creds) ──────────────────────────────────────────────────────────

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

	// Numeric, not lexical: "9" below "10" is the ordering a string sort gets backwards.
	eq(dedupeVersionsDesc(["9", "10", "8.4", "8.0"]), ["10", "9", "8.4", "8.0"], "numeric ordering, newest-first");
	eq(dedupeVersionsDesc(["16", "16", "15"]), ["16", "15"], "de-duplicates");
	eq(dedupeVersionsDesc(["8.0.21", "8.4", "5.7"]), ["8.4", "8.0.21", "5.7"], "mixed grain still orders");
	eq(compareVersionsDesc("16", "16.0"), 0, "'16' and '16.0' are the same version at two grains");

	eq(parseSqlVersionToken("POSTGRES_16"), { family: "POSTGRES", version: "16" }, "postgres token");
	eq(parseSqlVersionToken("MYSQL_8_0"), { family: "MYSQL", version: "8.0" }, "mysql token, underscores → dots");
	eq(parseSqlVersionToken("SQLSERVER_2019_STANDARD"), null, "family the picker does not model → null");
	eq(parseSqlVersionToken("NOPE"), null, "token with no separator → null");

	eq(
		collectAzureServerVersions({ value: [{ supportedServerVersions: [{ serverVersion: "16" }, { serverVersion: "17" }] }] }),
		["17", "16"],
		"azure: nested supportedServerVersions objects",
	);
	eq(collectAzureServerVersions({ a: { serverVersions: ["8.0.21", "8.4"] } }), ["8.4", "8.0.21"], "azure: plain string array");
	eq(collectAzureServerVersions({ skus: [{ name: "Standard_D2s_v3" }] }), [], "azure: no version nodes → empty, not garbage");
	// The real payload's MySQL nesting, and the string-valued fast-provisioning key that must NOT count.
	eq(
		collectAzureServerVersions([
			{
				supportedFlexibleServerEditions: [{ supportedServerVersions: [{ name: "8.4" }, { name: "5.7" }] }],
				supportedFastProvisioningEditions: [{ supportedServerVersions: "12" }],
			},
		]),
		["8.4", "5.7"],
		"azure: real MySQL nesting; the STRING fast-provisioning version is ignored",
	);
	eq(collectAzureServerVersions([{ supportedServerVersions: [] }]), [], "azure: provisioning-restricted region → empty, reported as skipped");

	const engine = { value: "aurora-postgresql", default_version: "16", versions: ["18", "17", "16"] };
	// The cloud offering an OLDER major than the catalog carries is not a finding: `versions` is a
	// curated subset, and every cloud keeps EOL majors on sale under extended support. Reporting those
	// would mean permanently nagging to re-adopt PostgreSQL 11.
	eq(diffEngine(engine, ["18", "17", "16", "15"]), { stale: [], newer: [], defaultGone: false }, "differ: cloud offers an older major → not a finding");
	eq(diffEngine(engine, ["19", "18", "17", "16"]), { stale: [], newer: ["19"], defaultGone: false }, "differ: cloud above ceiling → newer");
	eq(diffEngine(engine, ["18", "17"]), { stale: ["16"], newer: [], defaultGone: true }, "differ: dropped major → stale + default gone");
	eq(diffEngine(engine, []), { stale: [], newer: [], defaultGone: false }, "differ: no cloud answer → NO findings (never 'everything is gone')");

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

	const catalog = JSON.parse(readFileSync(CATALOG_PATH, "utf8"));
	const engineCount = Object.values(catalog.database).reduce((n, dp) => n + dp.engines.length, 0);
	console.log(`Validating the offline DB-version baseline — ${engineCount} engines across ${Object.keys(catalog.database).length} clouds.`);

	const rep = deriveAll(catalog);
	printReport(rep);

	if (MODE_WRITE) {
		const pending = rep
			.filter((r) => r.status === "live")
			.reduce((n, r) => n + r.engines.reduce((m, e) => m + e.stale.length, 0), 0);
		if (pending === 0) {
			console.log("\nNothing to prune — the baseline matches what the clouds offer (or no cloud answered).");
		} else if (DRY_RUN) {
			console.log(`\n[dry-run] would prune ${pending} stale version(s) + regenerate catalog.ts.`);
		} else {
			const n = writeCatalog(rep);
			console.log(`\n✓ pruned ${n} version(s) from ${rel(CATALOG_PATH)}; regenerating catalog.ts…`);
			execFileSync("node", [GEN_CATALOG], { stdio: "inherit" });
		}
		return;
	}

	if (hasFindings(rep) && GH_TOKEN && REPO && !DRY_RUN) {
		await fileDriftIssue(rep);
	} else if (hasFindings(rep)) {
		const why = !GH_TOKEN || !REPO ? " (no GITHUB_TOKEN/GITHUB_REPOSITORY — not filing)" : "";
		console.log(`\n${DRY_RUN ? "[dry-run] " : ""}findings present${why}.`);
	} else {
		console.log("\n✓ no drift to report (a cloud that could not be reached is reported as skipped, not as clean).");
	}

	if (STRICT && hasFindings(rep)) process.exit(1);
}

main().catch((e) => die(e instanceof Error ? e.stack || e.message : String(e)));
