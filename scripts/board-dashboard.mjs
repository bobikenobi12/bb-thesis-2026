// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// Live coordination-board control dashboard — the maintainer's glance-and-steer surface.
//
// `scripts/coordinate.sh --report` renders the same board as terminal text; this renders it as a
// self-contained, theme-aware HTML page you leave open in a tab. It reads the board READ-ONLY via
// the `gh` CLI (`gh issue list … --json`, `gh pr list … --json`, `gh issue view … --json comments`)
// and NEVER mutates anything — no label edits, no assigns, no merges. It surfaces the SAME signals
// coordinate.sh's report jq does, richer:
//   • per-wave READY / CLAIMED / BLOCKED / (recently) DONE counts + the unit list, holder + lease age
//   • in-flight PRs into `dev` with their checks rollup (green/red/pending) + mergeable state
//   • collisions to eyeball: >1 claimed `mutex:migration`, and overlapping `scope:` globs among the
//     claimable/claimed set (the same disjoint-scope invariant that prevents the mega-commit tangle)
//   • a prominent "NEEDS YOU" panel: `needs:human` units + `class:ui`/`needs:design` awaiting the
//     human + any PR with a FAILING required check
//
// Usage:
//   node scripts/board-dashboard.mjs                      # write /tmp/alethia-board.html
//   node scripts/board-dashboard.mjs --out board.html     # write to a path
//   node scripts/board-dashboard.mjs --open               # write, then `open` it (macOS)
//   node scripts/board-dashboard.mjs --json               # ALSO print the raw board model to stdout
//   node scripts/board-dashboard.mjs --self-test          # offline board-body parser fixtures
//
// Env: ALETHIA_LEASE_TTL (seconds, default 3600) — a lease older than this is flagged stale (matches
//      coordinate.sh). Pure Node (built-ins only) + the `gh` CLI on PATH; no npm installs.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { readScope, scopeGapReason, scopeListsOverlap } from "./lib/scope-overlap.mjs";

const LEASE_TTL = Number(process.env.ALETHIA_LEASE_TTL || "3600");
const args = process.argv.slice(2);
const DUMP_JSON = args.includes("--json");
const OPEN_AFTER = args.includes("--open");
const SELF_TEST = args.includes("--self-test");
const outIdx = args.indexOf("--out");
const OUT = outIdx >= 0 && args[outIdx + 1] ? args[outIdx + 1] : "/tmp/alethia-board.html";

/** Fail with a clear message + non-zero exit. */
function die(msg) {
	console.error(`board-dashboard: ${msg}`);
	process.exit(1);
}

/**
 * Run a `gh` subcommand and parse its JSON stdout. Guard-railed: only read-only verbs
 * (`issue list`, `issue view`, `pr list`) are ever passed here — this reporter must never mutate.
 */
function gh(argv) {
	const READONLY = new Set(["list", "view"]);
	if (!READONLY.has(argv[1])) die(`refusing non-read-only gh call: ${argv.join(" ")}`);
	try {
		const out = execFileSync("gh", argv, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
		return out.trim() ? JSON.parse(out) : null;
	} catch (e) {
		die(`gh ${argv.join(" ")} failed: ${e.message?.slice(0, 300)}`);
	}
}

/** The set of label names on an issue/PR record. */
function labelSet(o) {
	return new Set((o.labels || []).map((l) => l.name));
}

/** The `wave:*` label of an issue, or "wave:—" when it carries none. */
function waveOf(o) {
	for (const n of labelSet(o)) if (n.startsWith("wave:")) return n;
	return "wave:—";
}

/** The lane:* label of an issue (or "" if none). */
function laneOf(o) {
	for (const n of labelSet(o)) if (n.startsWith("lane:")) return n.slice("lane:".length);
	return "";
}

/**
 * The coordination state of a board unit, mirroring coordinate.sh's `st` jq:
 * EPIC (umbrella/tracker, never claimable) > CLAIMED (held) > BLOCKED (a blocker still open) >
 * READY (claimable). Epics are surfaced but never counted as ready work.
 */
function stateOf(o) {
	const s = labelSet(o);
	if (s.has("epic")) return "EPIC";
	if (s.has("claimed")) return "CLAIMED";
	if (s.has("blocked")) return "BLOCKED";
	return "READY";
}

/**
 * The reason a unit's `scope:` could not be (fully) compared, or "" when it could.
 *
 * A unit whose scope cannot be read is NOT a unit with a disjoint scope. Before #4115 this file
 * simply filtered those out (`u.scope.length > 0`) and reported "no collisions detected" over
 * whatever was left, which is the same silence the terminal report was filed for.
 */
function scopeGapOf(body) {
	const scope = readScope(body);
	if (scope.globs.length > 0 && scope.unusable.length === 0) return "";
	return scopeGapReason(scope);
}


/**
 * The body's lines with every CLOSED fenced block (``` or ~~~, delimiters included) removed.
 *
 * A line inside a fence genuinely starts at column 0, so the start-of-line anchor cannot tell a
 * declaration from a quoted one. That is the #3639 symptom: the seeding snippet in
 * `.claude/skills/decompose/SKILL.md` prints `blocked-by: #$SEAMS` at column 0 inside a ```bash
 * fence, so a body pasting it with a real number acquires a phantom dependency.
 *
 * CLOSED only. An unterminated fence leaves the rest of the body in play, because dropping it
 * would fail OPEN — the coordinator removes the `blocked` label when `deps` is empty — and one
 * stray backtick run would silently mark a lane READY. Over-reporting fails closed and is visible.
 * Mirrors the awk pre-pass in `blocked_by_from_body`.
 */
function unfencedLines(body) {
	const lines = (body || "").split("\n");
	const drop = new Array(lines.length).fill(false);
	let open = -1;
	for (let i = 0; i < lines.length; i++) {
		if (!/^[ \t]*(```|~~~)/.test(lines[i])) continue;
		if (open >= 0) {
			for (let j = open; j <= i; j++) drop[j] = true;
			open = -1;
		} else {
			open = i;
		}
	}
	return lines.filter((_, i) => !drop[i]);
}

/**
 * Parse the `blocked-by: #12 #14` declarations from an issue body → ascending, de-duplicated numbers.
 *
 * EVERY declaration line, not the first. This used to be a single `.match(/…/m)`, which takes ONE
 * match: a body carrying `blocked-by: #10` and `blocked-by: #11` on separate lines yielded `[10]`
 * here while `blocked_by_from_body` in coordinate.sh unioned both and returned `10 11`. The
 * dashboard then rendered `◂ #10` for an issue the coordinator was blocking on two things — and the
 * shared fixture file could not catch it, because no fixture carried a multi-line body. The two
 * parsers are a contract; the fixture set only proves it where it has a case.
 *
 * The normalisation mirrors the shell exactly: closed fenced blocks come out, a leading list marker
 * and any `**` come off, the declaration must still start its line, and the result is sorted
 * ascending and de-duplicated the way `sort -nu` does. Matching that ordering is what lets one
 * fixture file express both sides.
 */
function blockedBy(body) {
	const numbers = new Set();
	for (const line of unfencedLines(body)) {
		const bare = line.replace(/^[ \t]*[-*+][ \t]+/, " ").replace(/\*\*/g, "");
		const m = bare.match(/^[ \t]*[Bb]locked-by:[ \t]*(.*)$/);
		if (!m) continue;
		for (const x of m[1].matchAll(/#(\d+)/g)) numbers.add(Number(x[1]));
	}
	return [...numbers].sort((a, b) => a - b);
}

/** Exercise the dashboard parser against the contract shared with the coordinator. */
function runBoardBodySelfTest() {
	const fixtures = JSON.parse(readFileSync(new URL("./lib/board-body-fixtures.json", import.meta.url), "utf8"));
	// An empty or absent `cases` array ran zero checks and printed "all passed" — the same
	// nothing-found-reads-as-nothing-wrong shape the shell half had. Refuse it here too, so the two
	// self-tests cannot disagree about what an empty suite means.
	if (!Array.isArray(fixtures.cases) || fixtures.cases.length === 0) {
		die("self-test: board-body-fixtures.json contains no cases — asserting nothing is not passing.");
	}
	let failures = 0;
	for (const fixture of fixtures.cases) {
		const actual = blockedBy(fixture.body);
		if (JSON.stringify(actual) === JSON.stringify(fixture.blockedBy)) {
			console.log(`ok   - ${fixture.name}`);
		} else {
			console.error(`FAIL - ${fixture.name}: want ${JSON.stringify(fixture.blockedBy)} got ${JSON.stringify(actual)}`);
			failures++;
		}
	}
	if (failures > 0) die(`self-test: ${failures} check(s) FAILED`);
	console.log("self-test: all passed");
}

if (SELF_TEST) {
	runBoardBodySelfTest();
	process.exit(0);
}

/** ISO-8601 → epoch seconds (0 if unparseable). */
function toEpoch(ts) {
	const t = Date.parse(ts || "");
	return Number.isFinite(t) ? Math.floor(t / 1000) : 0;
}

/** Human "3h 12m" from a second count. */
function humanAge(sec) {
	if (sec < 0 || !Number.isFinite(sec)) return "—";
	const d = Math.floor(sec / 86400);
	const h = Math.floor((sec % 86400) / 3600);
	const m = Math.floor((sec % 3600) / 60);
	if (d > 0) return `${d}d ${h}h`;
	if (h > 0) return `${h}h ${m}m`;
	return `${m}m`;
}

/** Roll a PR's statusCheckRollup into one of: green / red / pending / none. */
function checksRollup(pr) {
	const rollup = pr.statusCheckRollup || [];
	if (rollup.length === 0) return { state: "none", pass: 0, fail: 0, pend: 0, failed: [] };
	let pass = 0;
	let fail = 0;
	let pend = 0;
	const failed = [];
	for (const c of rollup) {
		// CheckRun: {status, conclusion, name}. StatusContext: {state, context}.
		const concl = (c.conclusion || c.state || "").toUpperCase();
		const status = (c.status || "").toUpperCase();
		const name = c.name || c.context || "check";
		if (status && status !== "COMPLETED" && !concl) {
			pend++;
			continue;
		}
		if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(concl)) pass++;
		else if (["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(concl)) {
			fail++;
			failed.push(name);
		} else pend++;
	}
	const state = fail > 0 ? "red" : pend > 0 ? "pending" : "green";
	return { state, pass, fail, pend, failed };
}

/** HTML-escape a string for safe interpolation into the page. */
function esc(s) {
	return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// ── gather the board (READ-ONLY) ────────────────────────────────────────────
const now = Math.floor(Date.now() / 1000);
const issues = gh(["issue", "list", "--state", "open", "--limit", "300", "--json", "number,title,labels,body,assignees,updatedAt,url"]) || [];
const prs =
	gh([
		"pr",
		"list",
		"--state",
		"open",
		"--base",
		"dev",
		"--limit",
		"300",
		"--json",
		"number,title,headRefName,isDraft,mergeable,statusCheckRollup,labels,url,author,updatedAt",
	]) || [];

// Only issues carrying a board taxonomy label (wave:* / class:* / lane:*) are board units.
const boardUnits = issues.filter((i) => {
	for (const n of labelSet(i)) if (n.startsWith("wave:") || n.startsWith("class:") || n.startsWith("lane:")) return true;
	return false;
});

// Lease age for each CLAIMED unit — one extra read per claimed unit (rare), same source as
// coordinate.sh's reclaim loop (the last ```lease comment's stamped_at/claimed_at).
const leaseAge = new Map();
for (const i of boardUnits) {
	if (!labelSet(i).has("claimed")) continue;
	const v = gh(["issue", "view", String(i.number), "--json", "comments"]);
	const comments = (v && v.comments) || [];
	const leases = comments.map((c) => c.body || "").filter((b) => b.startsWith("```lease"));
	const last = leases[leases.length - 1] || "";
	const stamp = (last.match(/stamped_at:\s*(\S+)/) || last.match(/claimed_at:\s*(\S+)/) || [])[1];
	if (stamp) leaseAge.set(i.number, now - toEpoch(stamp));
}

// ── shape the model ─────────────────────────────────────────────────────────
const unitModel = boardUnits.map((i) => {
	const labels = labelSet(i);
	return {
		number: i.number,
		title: i.title,
		url: i.url,
		wave: waveOf(i).replace(/^wave:/, ""),
		lane: laneOf(i),
		class: labels.has("class:ui") ? "ui" : labels.has("class:backend") ? "backend" : "",
		state: stateOf(i),
		assignee: (i.assignees && i.assignees[0] && i.assignees[0].login) || "",
		leaseAgeSec: leaseAge.has(i.number) ? leaseAge.get(i.number) : null,
		leaseStale: leaseAge.has(i.number) ? leaseAge.get(i.number) > LEASE_TTL : false,
		needsHuman: labels.has("needs:human"),
		needsDesign: labels.has("needs:design"),
		mutexMigration: labels.has("mutex:migration"),
		blockedBy: blockedBy(i.body),
		// `readScope` is the shared parser (scripts/lib/scope-overlap.mjs). It separates "declares no
		// scope" from "declares one this parser cannot read" — a backtick-wrapped `scope:` line reads
		// as scoped to a human and as unscoped to every parser — so the panel below can say which
		// units it could NOT compare instead of quietly dropping them out of the comparison.
		scope: readScope(i.body).globs,
		scopeGap: scopeGapOf(i.body),
	};
});

const prModel = prs.map((p) => {
	const r = checksRollup(p);
	return {
		number: p.number,
		title: p.title,
		url: p.url,
		branch: p.headRefName,
		draft: !!p.isDraft,
		author: (p.author && p.author.login) || "",
		mergeable: p.mergeable || "UNKNOWN",
		checks: r,
	};
});

// Group units by wave (sorted: known waves first by label, then wave:— last).
const waveOrder = [...new Set(unitModel.map((u) => u.wave))].sort((a, b) => {
	if (a === "—") return 1;
	if (b === "—") return -1;
	return a.localeCompare(b, undefined, { numeric: true });
});
const byWave = waveOrder.map((w) => ({
	wave: w,
	units: unitModel.filter((u) => u.wave === w).sort((a, b) => a.number - b.number),
}));

// ── collisions to eyeball ───────────────────────────────────────────────────
const collisions = [];
// (1) >1 claimed mutex:migration (coordinate.sh's COLLISION flag).
const claimedMigrations = unitModel.filter((u) => u.state === "CLAIMED" && u.mutexMigration);
if (claimedMigrations.length > 1) {
	collisions.push({
		kind: "migration-mutex",
		text: `${claimedMigrations.length} claimed migration units at once — only one may generate migrations`,
		units: claimedMigrations.map((u) => u.number),
	});
}
// (2) overlapping scope: globs among the claimable/claimed set (the disjoint-scope invariant),
// decided by the SHARED matcher so this panel and coordinate.sh's report cannot disagree.
const workable = unitModel.filter((u) => u.state === "READY" || u.state === "CLAIMED");
const active = workable.filter((u) => u.scope.length > 0);
for (let x = 0; x < active.length; x++) {
	for (let y = x + 1; y < active.length; y++) {
		const hit = scopeListsOverlap(active[x].scope, active[y].scope);
		if (hit) {
			collisions.push({
				kind: "scope-overlap",
				text: `#${active[x].number} "${hit.g1}" overlaps #${active[y].number} "${hit.g2}" (${active[x].state.toLowerCase()} ∩ ${active[y].state.toLowerCase()})`,
				units: [active[x].number, active[y].number],
			});
		}
	}
}
// The units this panel could NOT compare. Kept OUT of `collisions` — an unread scope is not a
// disjoint one — and rendered separately, because "no collisions found" over a set that silently
// excluded half the board is the failure #4115 was filed for.
const scopeUnchecked = workable.filter((u) => u.scopeGap).map((u) => ({ number: u.number, why: u.scopeGap }));
const scopeWorkable = workable.length;
const scopeCompared = active.length;

// ── the NEEDS-YOU set ───────────────────────────────────────────────────────
const needsHumanUnits = unitModel.filter((u) => u.needsHuman);
const uiAwaiting = unitModel.filter((u) => u.class === "ui" && (u.needsDesign || u.needsHuman));
const redPRs = prModel.filter((p) => !p.draft && p.checks.state === "red");
// De-dup for the panel (a unit can be both needs:human and class:ui).
const needsYouUnits = [...new Map([...needsHumanUnits, ...uiAwaiting].map((u) => [u.number, u])).values()].sort((a, b) => a.number - b.number);

const totals = {
	units: unitModel.length,
	ready: unitModel.filter((u) => u.state === "READY").length,
	claimed: unitModel.filter((u) => u.state === "CLAIMED").length,
	blocked: unitModel.filter((u) => u.state === "BLOCKED").length,
	prs: prModel.length,
	prsDraft: prModel.filter((p) => p.draft).length,
	prsRed: redPRs.length,
	prsGreen: prModel.filter((p) => !p.draft && p.checks.state === "green").length,
};

const model = { generatedAt: new Date().toISOString(), leaseTtlSec: LEASE_TTL, totals, byWave, prs: prModel, collisions, scopeUnchecked, scopeCompared, scopeWorkable, needsYou: { units: needsYouUnits, redPRs } };

if (DUMP_JSON) console.log(JSON.stringify(model, null, 2));

// ── render HTML ─────────────────────────────────────────────────────────────
/** A small state pill for a unit (READY/CLAIMED/BLOCKED). */
function statePill(s) {
	return `<span class="pill state-${s.toLowerCase()}">${s}</span>`;
}

/** The claimed-holder cell (login + lease age, stale-flagged). */
function holderCell(u) {
	if (u.state !== "CLAIMED") return "";
	const age = u.leaseAgeSec == null ? "no lease stamp" : humanAge(u.leaseAgeSec);
	const stale = u.leaseStale ? ' <span class="pill warn">STALE</span>' : "";
	return `${esc(u.assignee || "?")} · <span class="dim">${esc(age)}</span>${stale}`;
}

/** One wave section (header counts + a scrolling unit table). */
function waveSection(w) {
	const c = { READY: 0, CLAIMED: 0, BLOCKED: 0, EPIC: 0 };
	for (const u of w.units) c[u.state]++;
	const rows = w.units
		.map((u) => {
			const tags = [];
			if (u.class) tags.push(`<span class="pill class-${u.class}">${u.class}</span>`);
			if (u.mutexMigration) tags.push('<span class="pill warn">migration</span>');
			if (u.needsDesign) tags.push('<span class="pill human">needs:design</span>');
			if (u.needsHuman) tags.push('<span class="pill human">needs:human</span>');
			const blk = u.blockedBy.length ? `<span class="dim">◂ ${u.blockedBy.map((n) => "#" + n).join(" ")}</span>` : "";
			return `<tr>
	<td class="num"><a href="${esc(u.url)}">#${u.number}</a></td>
	<td>${statePill(u.state)}</td>
	<td class="title">${esc(u.title)} ${blk}</td>
	<td class="tags">${tags.join(" ")}</td>
	<td class="holder">${holderCell(u)}</td>
</tr>`;
		})
		.join("\n");
	return `<section class="wave">
	<h2>${esc(w.wave === "—" ? "no wave" : "wave:" + w.wave)}
		<span class="counts">
			<span class="c-ready">${c.READY} ready</span>
			<span class="c-claimed">${c.CLAIMED} claimed</span>
			<span class="c-blocked">${c.BLOCKED} blocked</span>${c.EPIC ? ` <span class="c-epic">${c.EPIC} epic</span>` : ""}
		</span>
	</h2>
	<div class="tablewrap">
		<table>
			<thead><tr><th>#</th><th>state</th><th>unit</th><th>tags</th><th>holder · lease</th></tr></thead>
			<tbody>${rows || '<tr><td colspan="5" class="dim">no units</td></tr>'}</tbody>
		</table>
	</div>
</section>`;
}

/** The in-flight-PR table. */
function prSection() {
	if (prModel.length === 0) return '<p class="dim">No open PRs into dev.</p>';
	const rows = prModel
		.map((p) => {
			const ck = p.checks;
			const ckPill = `<span class="pill checks-${ck.state}">${ck.state}</span>`;
			const detail = ck.state === "none" ? "" : `<span class="dim">${ck.pass}✓ ${ck.fail}✗ ${ck.pend}◦</span>`;
			const mrg =
				p.mergeable === "MERGEABLE"
					? '<span class="pill ok">mergeable</span>'
					: p.mergeable === "CONFLICTING"
						? '<span class="pill warn">conflict</span>'
						: `<span class="dim">${esc(p.mergeable.toLowerCase())}</span>`;
			const draft = p.draft ? ' <span class="pill dim-pill">draft</span>' : "";
			const failed = ck.failed.length ? `<div class="dim failed">✗ ${ck.failed.slice(0, 4).map(esc).join(", ")}</div>` : "";
			return `<tr>
	<td class="num"><a href="${esc(p.url)}">#${p.number}</a></td>
	<td class="title">${esc(p.title)}${draft}${failed}</td>
	<td>${ckPill} ${detail}</td>
	<td>${mrg}</td>
	<td class="dim">${esc(p.author)}</td>
</tr>`;
		})
		.join("\n");
	return `<div class="tablewrap"><table>
		<thead><tr><th>#</th><th>PR → dev</th><th>checks</th><th>merge</th><th>by</th></tr></thead>
		<tbody>${rows}</tbody>
	</table></div>`;
}

/** The prominent NEEDS-YOU panel. */
function needsYouSection() {
	const parts = [];
	for (const u of needsYouUnits) {
		const why = [u.needsDesign ? "needs:design" : "", u.needsHuman ? "needs:human" : "", u.class === "ui" ? "class:ui" : ""].filter(Boolean).join(" · ");
		parts.push(`<li><a href="${esc(u.url)}">#${u.number}</a> <span class="dim">${esc(why)}</span> — ${esc(u.title)}</li>`);
	}
	for (const p of redPRs) {
		parts.push(
			`<li><a href="${esc(p.url)}">#${p.number}</a> <span class="pill checks-red">red check</span> — ${esc(p.title)} <span class="dim">(${esc(p.checks.failed.slice(0, 3).map(String).join(", "))})</span></li>`,
		);
	}
	if (parts.length === 0) return '<p class="dim">Nothing is waiting on you right now.</p>';
	return `<ul class="needs-list">${parts.join("\n")}</ul>`;
}

/**
 * The collisions-to-eyeball panel — collisions AND the units whose scope could not be read.
 * Three outcomes, never two: found / checked-and-clean / could-not-check.
 */
function collisionSection() {
	const checked = `<p class="dim">Compared ${scopeCompared} of ${scopeWorkable} claimed-or-ready unit(s) for overlapping scope globs.</p>`;
	const gaps = scopeUnchecked.length
		? `<p class="dim">⚠ NOT compared — ${scopeUnchecked.length} unit(s) whose <code>scope:</code> could not be read: ${scopeUnchecked
				.map((u) => esc(`#${u.number} (${u.why})`))
				.join(" · ")}</p>`
		: "";
	if (collisions.length === 0) {
		return `<p class="dim">No scope/migration collisions detected.</p>${checked}${gaps}`;
	}
	return `<ul class="coll-list">${collisions
		.map((c) => `<li><span class="pill warn">${esc(c.kind)}</span> ${esc(c.text)}</li>`)
		.join("\n")}</ul>${checked}${gaps}`;
}

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Alethia · coordination board</title>
<style>
:root {
	--bg: #ffffff; --fg: #111111; --dim: #6b7280; --line: #e5e7eb; --panel: #fafafa;
	--ready: #0e7a2e; --claimed: #b45309; --blocked: #b91c1c; --human: #6d28d9; --epic: #7c3aed; --warn: #b91c1c; --ok: #0e7a2e;
	--mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
	:root {
		--bg: #0a0a0a; --fg: #ededed; --dim: #8b8b8b; --line: #262626; --panel: #141414;
		--ready: #4ade80; --claimed: #fbbf24; --blocked: #f87171; --human: #c4b5fd; --epic: #a78bfa; --warn: #f87171; --ok: #4ade80;
	}
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
a { color: inherit; text-decoration: none; border-bottom: 1px solid var(--line); }
a:hover { border-bottom-color: currentColor; }
header { padding: 24px 24px 8px; border-bottom: 1px solid var(--line); position: sticky; top: 0; background: var(--bg); z-index: 10; }
header h1 { margin: 0; font-size: 16px; font-weight: 600; letter-spacing: -0.01em; }
header .meta { color: var(--dim); font-family: var(--mono); font-size: 12px; margin-top: 4px; }
.summary { display: flex; flex-wrap: wrap; gap: 8px 20px; margin-top: 12px; font-family: var(--mono); font-size: 12px; }
.summary b { font-weight: 600; }
main { padding: 20px 24px 64px; max-width: 1200px; }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 24px; }
@media (max-width: 860px) { .grid { grid-template-columns: 1fr; } }
.panel { border: 1px solid var(--line); border-radius: 8px; padding: 14px 16px; background: var(--panel); }
.panel h2 { margin: 0 0 10px; font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }
.panel.alert { border-color: var(--warn); }
.panel.alert h2 { color: var(--warn); }
section.wave { margin-bottom: 22px; }
section.wave h2 { font-size: 14px; font-weight: 600; margin: 0 0 8px; display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
.counts { font-family: var(--mono); font-size: 12px; font-weight: 400; display: flex; gap: 12px; }
.c-ready { color: var(--ready); } .c-claimed { color: var(--claimed); } .c-blocked { color: var(--blocked); }
.tablewrap { overflow-x: auto; border: 1px solid var(--line); border-radius: 8px; }
table { border-collapse: collapse; width: 100%; font-size: 13px; }
th { text-align: left; font-weight: 500; color: var(--dim); font-size: 11px; text-transform: uppercase; letter-spacing: 0.03em; padding: 8px 10px; border-bottom: 1px solid var(--line); white-space: nowrap; }
td { padding: 8px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
tr:last-child td { border-bottom: none; }
td.num { font-family: var(--mono); white-space: nowrap; }
td.title { min-width: 260px; }
td.tags, td.holder { white-space: nowrap; }
.dim { color: var(--dim); }
.failed { font-family: var(--mono); font-size: 11px; margin-top: 2px; }
.pill { display: inline-block; font-family: var(--mono); font-size: 11px; padding: 1px 6px; border-radius: 4px; border: 1px solid var(--line); line-height: 1.6; white-space: nowrap; }
.pill.state-ready { color: var(--ready); border-color: var(--ready); }
.pill.state-claimed { color: var(--claimed); border-color: var(--claimed); }
.pill.state-blocked { color: var(--blocked); border-color: var(--blocked); }
.pill.state-epic { color: var(--epic); border-color: var(--epic); }
.c-epic { color: var(--epic); }
.pill.class-backend { color: var(--fg); }
.pill.class-ui { color: var(--human); border-color: var(--human); }
.pill.human { color: var(--human); border-color: var(--human); }
.pill.warn { color: var(--warn); border-color: var(--warn); }
.pill.ok { color: var(--ok); border-color: var(--ok); }
.pill.dim-pill { color: var(--dim); }
.pill.checks-green { color: var(--ok); border-color: var(--ok); }
.pill.checks-red { color: var(--warn); border-color: var(--warn); }
.pill.checks-pending { color: var(--claimed); border-color: var(--claimed); }
.pill.checks-none { color: var(--dim); }
ul.needs-list, ul.coll-list { margin: 0; padding-left: 18px; }
ul.needs-list li, ul.coll-list li { margin: 6px 0; }
</style>
</head>
<body>
<header>
	<h1>Alethia · coordination board</h1>
	<div class="meta">generated ${esc(model.generatedAt)} · lease TTL ${LEASE_TTL}s · read-only</div>
	<div class="summary">
		<span><b>${totals.units}</b> units</span>
		<span class="c-ready"><b>${totals.ready}</b> ready</span>
		<span class="c-claimed"><b>${totals.claimed}</b> claimed</span>
		<span class="c-blocked"><b>${totals.blocked}</b> blocked</span>
		<span><b>${totals.prs}</b> PRs (<b>${totals.prsGreen}</b> green · <b>${totals.prsRed}</b> red · <b>${totals.prsDraft}</b> draft)</span>
	</div>
</header>
<main>
	<div class="grid">
		<div class="panel alert">
			<h2>⚑ Needs you</h2>
			${needsYouSection()}
		</div>
		<div class="panel${collisions.length ? " alert" : ""}">
			<h2>⚠ Collisions to eyeball</h2>
			${collisionSection()}
		</div>
	</div>

	<div class="panel" style="margin-bottom:24px">
		<h2>In-flight PRs → dev</h2>
		${prSection()}
	</div>

	${byWave.map(waveSection).join("\n")}
</main>
</body>
</html>
`;

writeFileSync(OUT, html, "utf8");
console.error(`board-dashboard: wrote ${OUT} (${boardUnits.length} board units, ${prModel.length} open PRs → dev)`);

if (OPEN_AFTER) {
	try {
		execFileSync("open", [OUT], { stdio: "ignore" });
	} catch {
		console.error(`board-dashboard: could not \`open\` ${OUT} (non-macOS?) — open it manually`);
	}
}
