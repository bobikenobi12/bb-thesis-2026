// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Board-proposal validator for the `decompose` skill (spec → GitHub-Issues board).
//
// Decomposition used to be 100% manual: a maintainer hand-authored the seams issue +
// every fine lane, hand-checking that no two claimable units shared a `scope:` glob.
// That hand-check is exactly what stops the mega-commit tangle (two instances editing
// the same files, then one `git add -A` sweeping both features into one commit — see
// .claude/COORDINATION.md and the "Shared-checkout entanglement" incident). This script
// makes that check mechanical so the `decompose` skill can refuse to seed a bad board.
//
// It takes a JSON array of PROPOSED issues (pre-creation, dry-run) on stdin or a file
// arg and enforces the board contract:
//   (a) NO two units share a scope glob — the anti-tangle invariant. Overlap is detected
//       structurally (normalize + segment-match), so `lib/**` vs `lib/db/**` (prefix
//       subsumption) and `*.tf` vs `main.tf` collide, not just byte-identical globs.
//   (b) Every NON-seams unit declares at least one `blockedBy` (the interface-first shape:
//       one seams issue with no blocked-by; every fine lane blocked-by the seams issue).
//   (c) Every label is from the known board set (coordinate.sh --init-labels), and each
//       unit carries exactly one class: and at least one wave: label.
//   (d) The blockedBy graph (over in-proposal references) is ACYCLIC.
//
// Proposal unit shape (see .claude/skills/decompose/SKILL.md for the authored contract):
//   {
//     "id": 1,                                        // optional; defaults to 1-based index
//     "title": "seams: project_* shared types + schema",
//     "labels": ["wave:W1", "lane:schema", "class:backend"],
//     "scope": ["apps/console/lib/db/schema/project_*.ts"],
//     "blockedBy": []                                 // refs other units' ids (the seams unit)
//   }
// A unit is the "seams" unit when its title matches /\bseams?\b/i AND no OTHER PROPOSED unit
// blocks it. A blockedBy ref to an id the proposal does not define is an open BOARD issue number
// and does not disqualify it — that is how a seams unit clears a real overlap with the live board.
// That exemption is only as good as the SEEDING: this script judges a proposal, and the board
// learns the ordering solely from the `blocked-by:` line coordinate.sh parses out of the created
// issue's body. So every unit whose blockedBy names a board number gets a `board ordering` warning
// on the report spelling out the line that must be seeded — the seams issue included, which is the
// case the skill's seeding section used to tell the author to leave blocked-by OFF entirely.
//
// Usage:
//   node scripts/decompose-validate.mjs proposal.json   # validate a file
//   cat proposal.json | node scripts/decompose-validate.mjs
//   node scripts/decompose-validate.mjs --self-test     # inline fixtures (no I/O)
//   node scripts/decompose-validate.mjs --no-board      # deliberately skip live-board comparison
// Exits 0 on PASS, non-zero on FAIL / bad input.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { globsOverlap, scopeGlobs } from "./lib/scope-overlap.mjs";

// ── the known board label set ─────────────────────────────────────────────────
// DERIVED from scripts/lib/board-labels.json, which `coordinate.sh --init-labels` also reads. This
// was a hand-written mirror of that script, and it drifted: seven program waves (fabric, canvas,
// frontdoor, connectors-v2, capabilities, compat, offer-parity) were live on the board and rejected
// here as `unknown label`, so none of those programs could be decomposed.
const LABEL_CATALOG = JSON.parse(
	readFileSync(new URL("./lib/board-labels.json", import.meta.url), "utf8"),
);
const namesOfKind = (kind) =>
	new Set(LABEL_CATALOG.labels.filter((l) => l.kind === kind).map((l) => l.name));

const WAVE_LABELS = namesOfKind("wave");
const LANE_LABELS = namesOfKind("lane");
const CLASS_LABELS = namesOfKind("class");
// Operational labels are maintained at RUNTIME by claim-work.sh / coordinate.sh — a fresh
// proposal must not pre-set them (they'd corrupt the claim/blocked bookkeeping). mutex/needs
// labels ARE legitimately authored into a proposal. `kind: "board"` labels (today just `epic`) are
// minted for the board but are never valid on a proposed unit, so they stay out of KNOWN_LABELS
// and a proposal carrying one still fails — same behaviour as before.
const RUNTIME_LABELS = namesOfKind("runtime");
const AUTHORABLE_EXTRA = namesOfKind("authorable");
/**
 * The lanes that own RENDERED product UI. A `class:backend` unit in one of these is taking the
 * routing that skips the human design gate, and therefore owes a `check:`.
 *
 * It is a SET and not a single lane because a one-lane rule is escapable by relabelling: the
 * console and the canvas are one file tree (`lane:canvas` owns
 * `apps/console/components/design-project/**`, `lane:console` the rest), so a unit that owed a
 * check under `lane:console` could shed the obligation by moving to `lane:canvas` and still ship
 * exactly the same rendered change. Both lanes, or neither.
 */
const CONFORMANCE_LANES = new Set(["lane:console", "lane:canvas"]);

const KNOWN_LABELS = new Set([
	...WAVE_LABELS,
	...LANE_LABELS,
	...CLASS_LABELS,
	...RUNTIME_LABELS,
	...AUTHORABLE_EXTRA,
]);

// The scope-glob matcher lives in scripts/lib/scope-overlap.mjs, not here.
//
// `normalizeGlob`, `scopeGlobs`, `segToRegex`, `segMatch` and `globsOverlap` were module-private
// in this file, so the two other places that must answer the same question could not call them:
// board-dashboard.mjs grew a weaker copy (a separator-less `startsWith`), and coordinate.sh grew
// none at all — its report claimed a scope check that had never been written (#4115). One
// predicate, three callers, exactly the shape scripts/lib/board-pr.sh exists to enforce.

/**
 * A unit is the interface-first "seams" issue when its title says so and nothing IN THE PROPOSAL
 * blocks it. A ref to an id the proposal does not define is an OPEN BOARD issue number, not a
 * proposal edge — the same reading `validate()`'s cycle graph already takes — and naming one is
 * the only escape hatch from a legitimate overlap with something already on the board. Requiring a
 * literally empty `blockedBy` made that hatch unusable on the seams unit: taking it disqualified
 * the unit and `validate()` then reported "no interface-first seams unit found" instead.
 */
function isSeams(unit, idSet) {
	const blockedBy = unit.blockedBy ?? [];
	const inProposal = idSet ? blockedBy.filter((d) => idSet.has(d)) : blockedBy;
	return /\bseams?\b/i.test(unit.title ?? "") && inProposal.length === 0;
}

/**
 * Validate a proposed issue set against the board contract. Returns { errors, warnings } —
 * `errors` non-empty ⇒ the board must NOT be seeded.
 */
function validate(proposal) {
	const errors = [];
	const warnings = [];

	if (!Array.isArray(proposal)) {
		return { errors: ["proposal must be a JSON array of issue objects"], warnings };
	}
	if (proposal.length === 0) {
		return { errors: ["proposal is empty — nothing to seed"], warnings };
	}

	// Assign a stable id to each unit (explicit `id`, else 1-based index) + basic shape checks.
	const units = proposal.map((u, idx) => ({
		id: u.id ?? idx + 1,
		title: u.title ?? "",
		labels: Array.isArray(u.labels) ? u.labels : [],
		scope: Array.isArray(u.scope) ? u.scope.filter(Boolean) : [],
		blockedBy: Array.isArray(u.blockedBy) ? u.blockedBy : [],
		check: typeof u.check === "string" ? u.check.trim() : "",
		_idx: idx,
	}));
	// Which refs are proposal edges and which are open board issue numbers. Needed by `isSeams`
	// below as well as by the graph further down, so it is computed here rather than there.
	const idSet = new Set(units.map((u) => u.id));

	const seen = new Set();
	for (const u of units) {
		const tag = `#${u.id} "${u.title || "(untitled)"}"`;
		if (seen.has(u.id)) errors.push(`duplicate unit id ${u.id}`);
		seen.add(u.id);
		if (!u.title) errors.push(`unit ${tag} has no title`);
		if (u.scope.length === 0) errors.push(`unit ${tag} declares no scope: glob`);
	}

	// ── (c) labels are from the known set; exactly one class: + at least one wave: ──────
	for (const u of units) {
		const tag = `#${u.id} "${u.title}"`;
		for (const label of u.labels) {
			if (!KNOWN_LABELS.has(label)) {
				errors.push(`unit ${tag} has unknown label "${label}" (not in the board label set)`);
			} else if (RUNTIME_LABELS.has(label)) {
				errors.push(
					`unit ${tag} pre-sets runtime label "${label}" — claimed/blocked are set by ` +
						`claim-work.sh / coordinate.sh, never authored into a proposal`,
				);
			}
		}
		const classes = u.labels.filter((l) => CLASS_LABELS.has(l));
		if (classes.length !== 1) {
			errors.push(`unit ${tag} must carry exactly one class: label (has ${classes.length})`);
		}
		const waves = u.labels.filter((l) => WAVE_LABELS.has(l));
		if (waves.length < 1) errors.push(`unit ${tag} carries no wave: label`);
		if (waves.length > 1) warnings.push(`unit ${tag} carries multiple wave: labels`);
		if (!u.labels.some((l) => LANE_LABELS.has(l))) {
			warnings.push(`unit ${tag} carries no lane: label (recommended for board reporting)`);
		}

		// ── a conformance unit that skips the human gate must say what measures it ────────
		//
		// `.claude/COORDINATION.md` routes console work that merely ADOPTS an already-decided
		// primitive (a raw `<h2>` → `SectionHeading`) to `class:backend`, so it lands
		// autonomously with no human ever seeing the rendered page. That is only sound because the
		// unit also ships the check that proves the adoption — and until this rule existed, that
		// obligation was a paragraph of prose with nothing behind it. A unit could be labelled
		// `lane:console` + `class:backend`, swap 24 headings, declare no check, pass this validator
		// with zero errors, be handed out by `claim-work.sh --class backend`, and be squash-merged
		// by Mergify. Nothing at any point asked.
		//
		// It is an ERROR and not a warning on purpose: a warning is exactly as enforceable as the
		// prose it replaces. The check need not be new — naming the existing command that will fail
		// if the adoption regresses is the point, not writing a fresh guard per unit.
		const conformanceLane = u.labels.find((l) => CONFORMANCE_LANES.has(l));
		if (conformanceLane && u.labels.includes("class:backend") && !u.check) {
			errors.push(
				`unit ${tag} is ${conformanceLane} + class:backend but declares no \`check:\` — ` +
					`name the command that proves the adoption (it may be an existing one). This routing ` +
					`skips the human design gate, and is only sound if something measures the claim.`,
			);
		}
	}

	// ── (b) every non-seams unit declares a blocked-by; exactly one seams root ──────────
	const seamsUnits = units.filter((u) => isSeams(u, idSet));
	if (seamsUnits.length === 0) {
		errors.push(
			"no interface-first seams unit found — expected exactly one unit whose title says " +
				'"seams" and that no OTHER PROPOSED unit blocks (the shared types/schema/contract ' +
				"everything blocks on; a blockedBy ref to an open board issue is allowed there)",
		);
	} else if (seamsUnits.length > 1) {
		warnings.push(
			`${seamsUnits.length} seams units found (${seamsUnits
				.map((u) => `#${u.id}`)
				.join(", ")}); the interface-first pattern seeds ONE seams root per wave`,
		);
	}
	for (const u of units) {
		if (isSeams(u, idSet)) continue;
		if (u.blockedBy.length === 0) {
			errors.push(
				`unit #${u.id} "${u.title}" has no blockedBy — every non-seams lane must be blocked-by ` +
					"the seams issue (interface-first: schema/contract lands before the lanes)",
			);
		}
	}

	// ── build the in-proposal blockedBy graph (shared by the scope + cycle checks) ──────
	const edges = new Map(); // id -> [ids it is blocked-by, restricted to in-proposal units]
	for (const u of units) {
		edges.set(
			u.id,
			u.blockedBy.filter((d) => idSet.has(d) && d !== u.id),
		);
		if (u.blockedBy.includes(u.id)) errors.push(`unit #${u.id} is blocked-by itself`);
	}

	/** Can `from` reach `to` by following blockedBy edges? (i.e. `to` transitively blocks `from`.) */
	const reaches = (from, to) => {
		const visited = new Set();
		const stack = [...(edges.get(from) ?? [])];
		while (stack.length) {
			const n = stack.pop();
			if (n === to) return true;
			if (visited.has(n)) continue;
			visited.add(n);
			stack.push(...(edges.get(n) ?? []));
		}
		return false;
	};

	// ── (a) no two CO-CLAIMABLE units share a scope glob (the anti-tangle invariant) ────
	// The invariant is over open+CLAIMABLE units. A unit and something that (transitively)
	// blocks it are never claimable at once — the blocked one waits — so a seams↔dependent
	// scope overlap is NOT a live tangle and is allowed. Only siblings (neither blocks the
	// other) can be worked simultaneously, so only those must have disjoint scopes.
	for (let i = 0; i < units.length; i++) {
		for (let j = i + 1; j < units.length; j++) {
			const a = units[i];
			const b = units[j];
			if (reaches(a.id, b.id) || reaches(b.id, a.id)) continue; // ordered by blocked-by
			for (const g1 of a.scope) {
				for (const g2 of b.scope) {
					if (globsOverlap(g1, g2)) {
						errors.push(
							`SCOPE COLLISION: #${a.id} ("${a.title}") glob "${g1}" overlaps ` +
								`#${b.id} ("${b.title}") glob "${g2}" — these units are co-claimable ` +
								"(neither blocks the other), so sharing files is the mega-commit tangle the board forbids",
						);
					}
				}
			}
		}
	}

	// ── (d) the blockedBy graph (over in-proposal refs) is acyclic ──────────────────────
	const WHITE = 0;
	const GREY = 1;
	const BLACK = 2;
	const color = new Map(units.map((u) => [u.id, WHITE]));
	const stack = [];
	let cycle = null;
	/** DFS that paints GREY on the recursion stack; a GREY re-visit is a back edge = cycle. */
	const dfs = (node) => {
		color.set(node, GREY);
		stack.push(node);
		for (const next of edges.get(node) ?? []) {
			if (color.get(next) === GREY) {
				const from = stack.indexOf(next);
				cycle = [...stack.slice(from), next];
				return true;
			}
			if (color.get(next) === WHITE && dfs(next)) return true;
		}
		stack.pop();
		color.set(node, BLACK);
		return false;
	};
	for (const u of units) {
		if (color.get(u.id) === WHITE && dfs(u.id)) break;
	}
	if (cycle) {
		errors.push(`blockedBy CYCLE: ${cycle.map((n) => `#${n}`).join(" → ")}`);
	}

	return { errors, warnings };
}

/**
 * Return whether an open board issue can be claimed alongside a new proposal.
 *
 * The exclusion list MIRRORS the emitter — `claim-work.sh`'s `ready` filter, which excludes
 * claimed / blocked / needs:human / epic and nothing else. `needs:design` is deliberately NOT
 * among them: it is an `authorable` label that the decompose skill puts on EVERY `class:ui` lane,
 * so `claim-work.sh --class ui` hands those out. Excluding it here made every open `class:ui` lane
 * invisible to this guard — a false green in exactly the case it exists to catch.
 */
function isCoClaimableBoardUnit(issue) {
	const labels = new Set((issue.labels ?? []).map((label) => label.name));
	return (
		["claimed", "blocked", "needs:human", "epic"].every((label) => !labels.has(label)) &&
		["class:backend", "class:ui", "wave:", "lane:"].some((prefix) =>
			[...labels].some((label) => label === prefix || label.startsWith(prefix)),
		)
	);
}

/** Validate proposal scopes against co-claimable open board units. */
function validateAgainstBoard(proposal, board) {
	const result = validate(proposal);
	if (!Array.isArray(board) || board.length === 0) {
		return {
			...result,
			errors: [...result.errors, "open board read returned no issues — use --no-board only for a deliberate offline run"],
		};
	}
	if (result.errors.length > 0 || !Array.isArray(proposal)) return result;

	const proposalUnits = proposal.map((unit, index) => ({
		id: unit.id ?? index + 1,
		title: unit.title ?? "(untitled)",
		scope: Array.isArray(unit.scope) ? unit.scope.filter(Boolean) : [],
		blockedBy: Array.isArray(unit.blockedBy) ? unit.blockedBy : [],
	}));
	const boardUnits = board.filter(isCoClaimableBoardUnit);

	// The escape hatch for a legitimate overlap is naming the open board issue in `blockedBy`, and
	// it must be TRANSITIVE for the same reason the in-proposal check at (a) uses `reaches()`: a
	// lane blocked-by a seams unit that is itself blocked-by board #900 is ordered behind #900 and
	// is not co-claimable with it. Direct-only would have forced every lane to repeat the number.
	const idSet = new Set(proposalUnits.map((u) => u.id));
	const byId = new Map(proposalUnits.map((u) => [u.id, u]));
	/** Open board issue numbers `unit` is ordered behind, following in-proposal blockedBy edges. */
	const boardBlockers = (unit) => {
		const numbers = new Set();
		const visited = new Set([unit.id]);
		const stack = [unit];
		while (stack.length) {
			for (const ref of stack.pop().blockedBy) {
				if (!idSet.has(ref)) {
					numbers.add(ref); // not a proposal id ⇒ an open board issue number
					continue;
				}
				if (visited.has(ref)) continue;
				visited.add(ref);
				const next = byId.get(ref);
				if (next) stack.push(next);
			}
		}
		return numbers;
	};

	for (const proposed of proposalUnits) {
		const ordered = boardBlockers(proposed);
		// The exemption above is granted to the PROPOSAL; the board only ever learns the ordering
		// from the `blocked-by:` line coordinate.sh parses out of the seeded issue body. Name the
		// DIRECT refs, because that is what goes on THIS unit's body — a lane inherits the seams
		// unit's board blockers here, but on the board it inherits them by being blocked-by the
		// seams issue, which stays blocked while they are open.
		const directBoardRefs = proposed.blockedBy.filter((ref) => !idSet.has(ref));
		if (directBoardRefs.length > 0) {
			result.warnings.push(
				`board ordering: proposed #${proposed.id} ("${proposed.title}") is exempted from the ` +
					`open board only because it is ordered behind ${directBoardRefs.map((n) => `#${n}`).join(" ")} — ` +
					`its seeded issue body MUST carry \`blocked-by: ${directBoardRefs.map((n) => `#${n}`).join(" ")}\` ` +
					"(the seams issue too), or coordinate.sh leaves it unblocked and claim-work.sh hands it out " +
					"alongside the issue it overlaps",
			);
		}
		for (const existing of boardUnits) {
			if (ordered.has(existing.number)) continue;
			for (const proposedGlob of proposed.scope) {
				for (const existingGlob of scopeGlobs(existing.body)) {
					if (globsOverlap(proposedGlob, existingGlob)) {
						result.errors.push(
							`SCOPE COLLISION: proposed #${proposed.id} ("${proposed.title}") glob "${proposedGlob}" overlaps ` +
								`open board #${existing.number} ("${existing.title ?? "(untitled)"}") glob "${existingGlob}" — ` +
								"these units are co-claimable, so sharing files is the mega-commit tangle the board forbids",
						);
					}
				}
			}
		}
	}
	return result;
}

// `gh issue list` returns newest-first and puts NOTHING in the JSON to say it truncated at
// `--limit`. Once the board passes this cap the OLDEST open issues — the long-lived lanes most
// likely to still be open across a decompose — silently fall out of the response and stop being
// compared, and the proposal PASSes against a partial board. A full page is the only truncation
// signal there is, so `readOpenBoard` treats it as one. (87 open issues on 2026-09-02.)
const BOARD_LIMIT = 300;

/**
 * Read the open GitHub issue board, failing closed when the response is unavailable, empty, or
 * large enough to have been truncated at `BOARD_LIMIT`.
 */
function readOpenBoard() {
	let raw;
	try {
		raw = execFileSync(
			"gh",
			[
				"issue",
				"list",
				"--state",
				"open",
				"--limit",
				String(BOARD_LIMIT),
				"--json",
				"number,title,body,labels",
			],
			{ encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
		);
	} catch (error) {
		throw new Error(`could not read open board: ${error.message ?? String(error)}; use --no-board for a deliberate offline run`);
	}
	let board;
	try {
		board = JSON.parse(raw);
	} catch (error) {
		throw new Error(`open board response was not valid JSON: ${error.message ?? String(error)}`);
	}
	if (!Array.isArray(board) || board.length === 0) {
		throw new Error("open board read returned no issues; use --no-board for a deliberate offline run");
	}
	if (board.length >= BOARD_LIMIT) {
		throw new Error(
			`open board read returned ${board.length} issues — that is the --limit cap, so the ` +
				"response is probably truncated and the oldest open lanes were dropped. Raise " +
				"BOARD_LIMIT in scripts/decompose-validate.mjs rather than comparing against a " +
				"partial board.",
		);
	}
	return board;
}

/** Print a PASS/FAIL report for a validation result and return the process exit code. */
function report(proposal, { errors, warnings }) {
	for (const w of warnings) console.warn(`  ⚠ ${w}`);
	if (errors.length === 0) {
		const n = Array.isArray(proposal) ? proposal.length : 0;
		console.log(`✓ PASS — ${n} proposed unit(s) form a well-shaped, tangle-free board.`);
		return 0;
	}
	console.error(`✗ FAIL — ${errors.length} problem(s); do NOT seed this board:\n`);
	for (const e of errors) console.error(`  • ${e}`);
	console.error(
		"\n  Fix the proposal (split overlapping scopes into disjoint lanes, add the missing\n" +
			"  blocked-by, correct the labels) and re-validate. See .claude/skills/decompose/SKILL.md.\n",
	);
	return 1;
}

// ── self-test: inline fixtures (no board / no I/O), mirroring claim-work.sh's run_self_test ──
function runSelfTest() {
	let fails = 0;
	/** Assert a fixture validates to the expected pass/fail, printing an ok/FAIL line. */
	const expect = (name, prop, shouldPass) => {
		const { errors } = validate(prop);
		const passed = errors.length === 0;
		if (passed === shouldPass) {
			console.log(`ok   - ${name}`);
		} else {
			fails++;
			console.error(
				`FAIL - ${name}: expected ${shouldPass ? "PASS" : "FAIL"} but got ${
					passed ? "PASS" : "FAIL"
				}${errors.length ? ` (${errors[0]})` : ""}`,
			);
		}
	};
	/**
	 * Assert a proposal validates against a stubbed open board as expected. A FAIL expectation
	 * MUST also give `expectError`, a regex over the joined error text: `validateAgainstBoard`
	 * returns before the board loop when the proposal is malformed on its own, so asserting the
	 * error COUNT alone lets a board test go green off an unrelated shape error without the board
	 * comparison ever running — which is precisely how the first two of these passed.
	 */
	const expectBoard = (name, prop, board, shouldPass, expectError) => {
		const { errors } = validateAgainstBoard(prop, board);
		const passed = errors.length === 0;
		const matched = shouldPass ? true : Boolean(expectError) && expectError.test(errors.join("\n"));
		if (passed === shouldPass && matched) {
			console.log(`ok   - ${name}`);
			return;
		}
		fails++;
		const why =
			passed !== shouldPass
				? `expected ${shouldPass ? "PASS" : "FAIL"} but got ${passed ? "PASS" : "FAIL"}`
				: `failed, but for the wrong reason — no error matched ${expectError}`;
		console.error(`FAIL - ${name}: ${why}${errors.length ? ` (${errors[0]})` : ""}`);
	};
	/**
	 * Assert the report carries a warning matching `expectWarning` (or, with `shouldWarn` false,
	 * that it carries none matching). The board exemption is only honoured if the author writes the
	 * number onto the seeded issue, so the reminder is the only part of that hand-off this script
	 * can hold — an assertion on the PASS/FAIL verdict alone cannot see it at all.
	 */
	const expectBoardWarning = (name, prop, board, shouldWarn, expectWarning) => {
		const { warnings } = validateAgainstBoard(prop, board);
		const matched = expectWarning.test(warnings.join("\n"));
		if (matched === shouldWarn) {
			console.log(`ok   - ${name}`);
			return;
		}
		fails++;
		console.error(
			`FAIL - ${name}: expected ${shouldWarn ? "a" : "no"} warning matching ${expectWarning}, got ${
				warnings.length ? warnings.join(" | ") : "(none)"
			}`,
		);
	};
	const boardIssue = (number, title, scope, labels = ["wave:W1", "lane:server", "class:backend"]) => ({
		number,
		title,
		body: `scope: ${scope}`,
		labels: labels.map((name) => ({ name })),
	});
	const boardOverlapProposal = [
		{
			id: 1,
			title: "seams: new contract",
			labels: ["wave:W1", "lane:schema", "class:backend"],
			scope: ["scripts/new-contract.mjs"],
			blockedBy: [],
		},
		{
			id: 2,
			// blockedBy: [1] is load-bearing. With an empty one this unit is not the seams unit and
			// has no blocker, so `validate()` errors on the SHAPE and `validateAgainstBoard` returns
			// before the board loop — the FAIL expectations below were then met by a rule that has
			// nothing to do with the board, and no test ever observed a board collision.
			title: "new canvas unit",
			labels: ["wave:W1", "lane:server", "class:backend"],
			scope: ["apps/console/components/design-project/new/**"],
			blockedBy: [1],
		},
	];
	const openBoard = [
		boardIssue(900, "existing canvas unit", "apps/console/components/design-project/**"),
	];
	expectBoard(
		"open board sibling overlap FAILs",
		boardOverlapProposal,
		openBoard,
		false,
		/SCOPE COLLISION: proposed #2 .* open board #900 /,
	);
	expectBoard(
		"an existing blocker permits overlapping scope",
		[boardOverlapProposal[0], { ...boardOverlapProposal[1], blockedBy: [1, 900] }],
		openBoard,
		true,
	);
	const prefixBoard = [boardIssue(901, "existing console unit", "apps/console/components/**")];
	expectBoard(
		"board prefix subsumption FAILs",
		boardOverlapProposal,
		prefixBoard,
		false,
		/SCOPE COLLISION: proposed #2 .* open board #901 /,
	);
	expectBoard(
		"empty board response FAILs closed",
		boardOverlapProposal,
		[],
		false,
		/open board read returned no issues/,
	);
	// `needs:design` is on EVERY class:ui lane and is not excluded by claim-work.sh's ready filter,
	// so such a lane is handed out and must be visible here.
	expectBoard(
		"a needs:design board unit is still co-claimable",
		boardOverlapProposal,
		[
			boardIssue(902, "design-gated canvas unit", "apps/console/components/design-project/**", [
				"wave:W1",
				"lane:canvas",
				"class:ui",
				"needs:design",
			]),
		],
		false,
		/SCOPE COLLISION: proposed #2 .* open board #902 /,
	);
	// A seams unit clears a real board overlap by naming the issue in blockedBy — and it stays the
	// seams unit while doing so. Everything ordered behind it inherits that, transitively.
	const boardBlockedSeams = [
		{
			id: 1,
			title: "seams: canvas contract",
			labels: ["wave:W1", "lane:schema", "class:backend"],
			scope: ["apps/console/components/design-project/contract.ts"],
			blockedBy: [900],
		},
		{
			id: 2,
			title: "canvas lane behind the seams",
			labels: ["wave:W1", "lane:server", "class:backend"],
			scope: ["apps/console/components/design-project/new/**"],
			blockedBy: [1],
		},
	];
	expectBoard("a board blocked-by keeps the seams unit a seams unit", boardBlockedSeams, openBoard, true);
	// …and the PASS says so out loud. The exemption lives in the proposal; the board only learns it
	// from the seeded `blocked-by:` line, which a seams issue otherwise does not have — so a silent
	// PASS here is how the tangle gets seeded behind a green verdict.
	expectBoardWarning(
		"the seams unit's board exemption warns that it must be SEEDED",
		boardBlockedSeams,
		openBoard,
		true,
		/board ordering: proposed #1 .*`blocked-by: #900`/,
	);
	// The reminder must be about THIS unit's own body line. Lane #2 is ordered behind #900 only
	// transitively, and on the board it inherits that by being blocked-by the seams issue — telling
	// the author to write `blocked-by: #900` on the lane would be wrong, and a warning naming every
	// unit would train the author to skim past all of them.
	expectBoardWarning(
		"a lane inheriting the exemption transitively is NOT told to seed the number",
		boardBlockedSeams,
		openBoard,
		false,
		/board ordering: proposed #2 /,
	);
	expectBoard(
		"the board exemption reaches nothing once the chain is cut",
		[{ ...boardBlockedSeams[0], blockedBy: [] }, boardBlockedSeams[1]],
		openBoard,
		false,
		/SCOPE COLLISION: proposed #2 .* open board #900 /,
	);

	// A clean interface-first set: one seams root, three disjoint lanes blocked-by it.
	const clean = [
		{
			id: 1,
			title: "seams: project_* shared types + schema contract",
			labels: ["wave:W1", "lane:schema", "class:backend"],
			scope: ["apps/console/lib/db/schema/project_shared.ts"],
			blockedBy: [],
		},
		{
			id: 2,
			title: "server actions for project placement",
			labels: ["wave:W1", "lane:server", "class:backend"],
			scope: ["apps/console/app/server/actions/placement/**"],
			blockedBy: [1],
		},
		{
			id: 3,
			title: "runner placement executor",
			labels: ["wave:W1", "lane:runner", "class:backend"],
			scope: ["apps/runner/internal/agent/placement/**"],
			blockedBy: [1],
		},
		{
			id: 4,
			title: "placement canvas node config sheet",
			labels: ["wave:W1", "lane:canvas", "class:ui"],
			scope: ["apps/console/components/canvas/placement/**"],
			blockedBy: [1],
		},
	];
	expect("clean interface-first set PASSes", clean, true);

	// Overlapping scope between two SIBLING lanes (both blocked-by the seams, so co-claimable):
	// prefix subsumption `lib/db/**` ⊇ `lib/db/schema/project.ts`.
	const overlap = [
		{
			id: 1,
			title: "seams: shared schema",
			labels: ["wave:W1", "lane:schema", "class:backend"],
			scope: ["apps/console/lib/db/schema/shared.ts"],
			blockedBy: [],
		},
		{
			id: 2,
			title: "db lane",
			labels: ["wave:W1", "lane:schema", "class:backend"],
			scope: ["apps/console/lib/db/**"],
			blockedBy: [1],
		},
		{
			id: 3,
			title: "placement schema lane",
			labels: ["wave:W1", "lane:server", "class:backend"],
			scope: ["apps/console/lib/db/schema/project.ts"],
			blockedBy: [1],
		},
	];
	expect("overlapping sibling scope (prefix subsumption) FAILs", overlap, false);

	// Seams ⊇ dependent overlap is ALLOWED — the dependent is blocked-by the seams, so they are
	// never claimable at the same time (no live tangle). This is the interface-first pattern.
	const seamsDependentOverlap = [
		{
			id: 1,
			title: "seams: shared schema contract",
			labels: ["wave:W1", "lane:schema", "class:backend"],
			scope: ["apps/console/lib/db/schema/**"],
			blockedBy: [],
		},
		{
			id: 2,
			title: "placement schema lane",
			labels: ["wave:W1", "lane:schema", "class:backend"],
			scope: ["apps/console/lib/db/schema/project.ts"],
			blockedBy: [1],
		},
	];
	expect("seams ⊇ dependent overlap PASSes (not co-claimable)", seamsDependentOverlap, true);

	// Wildcard-sibling overlap: `*.tf` vs `main.tf` in the same directory.
	const wildcardOverlap = [
		{
			id: 1,
			title: "seams: tofu contract",
			labels: ["wave:W2", "lane:core", "class:backend"],
			scope: ["packages/core/verify/report.go"],
			blockedBy: [],
		},
		{
			id: 2,
			title: "aws template lane",
			labels: ["wave:W2", "lane:core", "class:backend"],
			scope: ["infra/templates/project/aws/*.tf"],
			blockedBy: [1],
		},
		{
			id: 3,
			title: "aws main override lane",
			labels: ["wave:W2", "lane:core", "class:backend"],
			scope: ["infra/templates/project/aws/main.tf"],
			blockedBy: [1],
		},
	];
	expect("wildcard-sibling scope overlap FAILs", wildcardOverlap, false);

	// Disjoint sibling dirs must NOT be flagged.
	const disjoint = [
		{
			id: 1,
			title: "seams: shared",
			labels: ["wave:W1", "lane:schema", "class:backend"],
			scope: ["apps/console/lib/db/schema/shared.ts"],
			blockedBy: [],
		},
		{
			id: 2,
			title: "aws lane",
			labels: ["wave:W1", "lane:core", "class:backend"],
			scope: ["infra/templates/project/aws/**"],
			blockedBy: [1],
		},
		{
			id: 3,
			title: "gcp lane",
			labels: ["wave:W1", "lane:core", "class:backend"],
			scope: ["infra/templates/project/gcp/**"],
			blockedBy: [1],
		},
	];
	expect("disjoint sibling dirs PASS (no false positive)", disjoint, true);

	// Missing blocked-by on a non-seams lane.
	const missingBlockedBy = [
		{
			id: 1,
			title: "seams: shared",
			labels: ["wave:W1", "lane:schema", "class:backend"],
			scope: ["apps/console/lib/db/schema/shared.ts"],
			blockedBy: [],
		},
		{
			id: 2,
			title: "server lane with no blocker",
			labels: ["wave:W1", "lane:server", "class:backend"],
			scope: ["apps/console/app/server/actions/foo/**"],
			blockedBy: [],
		},
	];
	expect("non-seams unit missing blockedBy FAILs", missingBlockedBy, false);

	// Cyclic blocked-by.
	const cyclic = [
		{
			id: 1,
			title: "seams: shared",
			labels: ["wave:W1", "lane:schema", "class:backend"],
			scope: ["apps/console/lib/db/schema/shared.ts"],
			blockedBy: [3],
		},
		{
			id: 2,
			title: "server lane",
			labels: ["wave:W1", "lane:server", "class:backend"],
			scope: ["apps/console/app/server/actions/foo/**"],
			blockedBy: [1],
		},
		{
			id: 3,
			title: "runner lane",
			labels: ["wave:W1", "lane:runner", "class:backend"],
			scope: ["apps/runner/internal/agent/foo/**"],
			blockedBy: [2],
		},
	];
	expect("cyclic blockedBy FAILs", cyclic, false);

	// Unknown label.
	const badLabel = [
		{
			id: 1,
			title: "seams: shared",
			labels: ["wave:W9", "lane:schema", "class:backend"],
			scope: ["apps/console/lib/db/schema/shared.ts"],
			blockedBy: [],
		},
	];
	expect("unknown label FAILs", badLabel, false);

	// A PROGRAM wave (not one of W1-W7 / hygiene) validates. These live on the board and were
	// rejected here as `unknown label` while the set was a hand-written mirror of coordinate.sh, so
	// no program could be decomposed. Pinned so the two cannot drift apart again silently.
	const programWave = [
		{
			id: 1,
			title: "seams: shared",
			labels: ["wave:offer-parity", "lane:core", "class:backend"],
			scope: ["apps/console/scripts/check-offer-parity.mjs"],
			blockedBy: [],
		},
	];
	expect("a program wave (wave:offer-parity) PASSes", programWave, true);

	// `epic` is minted for the board but is never valid on a proposed unit — an umbrella is
	// decomposed, not built. It carries kind "board" in the catalog for exactly this reason.
	const epicLabel = [
		{
			id: 1,
			title: "seams: shared",
			labels: ["wave:hygiene", "lane:core", "class:backend", "epic"],
			scope: ["apps/console/lib/db/schema/shared.ts"],
			blockedBy: [],
		},
	];
	expect("a proposal carrying `epic` FAILs", epicLabel, false);

	// Two class labels.
	const twoClasses = [
		{
			id: 1,
			title: "seams: shared",
			labels: ["wave:W1", "lane:schema", "class:backend", "class:ui"],
			scope: ["apps/console/lib/db/schema/shared.ts"],
			blockedBy: [],
		},
	];
	expect("unit with two class: labels FAILs", twoClasses, false);

	// ── the `check:` obligation on lane:console + class:backend ────────────────────────────
	//
	// Four fixtures, because the rule has to bind on exactly one combination and stay silent on the
	// other three. A single "it fails without a check" fixture would also pass an implementation
	// that demanded a check from EVERY unit, which would make the whole board unseedable.
	const conformanceNoCheck = [
		{
			id: 1,
			title: "seams: the conformance contract",
			labels: ["wave:console-ui", "lane:tests", "class:backend"],
			scope: ["scripts/lib/console-routes.mjs"],
			blockedBy: [],
		},
		{
			id: 2,
			title: "settings adopts the shared surface",
			labels: ["wave:console-ui", "lane:console", "class:backend"],
			scope: ["apps/console/components/settings/**"],
			blockedBy: [1],
		},
	];
	expect("lane:console + class:backend with NO check: FAILs", conformanceNoCheck, false);

	const conformanceWithCheck = structuredClone(conformanceNoCheck);
	conformanceWithCheck[1].check = "pnpm check:shared-surface";
	expect("...and PASSes once it declares one", conformanceWithCheck, true);

	// A whitespace-only check is not a check. Without this, `check: " "` satisfies the rule and the
	// obligation is back to being decorative.
	const conformanceBlankCheck = structuredClone(conformanceNoCheck);
	conformanceBlankCheck[1].check = "   ";
	expect("...and a whitespace-only check: does NOT satisfy it", conformanceBlankCheck, false);

	// The rule must NOT fire on a class:ui console unit (it keeps the human gate, so the check is
	// not what makes it safe), nor on a backend unit in any other lane.
	const conformanceUi = structuredClone(conformanceNoCheck);
	conformanceUi[1].labels = ["wave:console-ui", "lane:console", "class:ui", "needs:design"];
	expect("lane:console + class:ui needs no check: (the human gate is intact)", conformanceUi, true);

	const otherLaneNoCheck = structuredClone(conformanceNoCheck);
	otherLaneNoCheck[1].labels = ["wave:console-ui", "lane:server", "class:backend"];
	expect("another lane + class:backend needs no check:", otherLaneNoCheck, true);

	// The escape the single-lane version of this rule allowed: shed the obligation by moving to the
	// OTHER lane that owns rendered UI, and ship the identical change.
	const relabelEscape = structuredClone(conformanceNoCheck);
	relabelEscape[1].labels = ["wave:console-ui", "lane:canvas", "class:backend"];
	relabelEscape[1].scope = ["apps/console/components/design-project/**"];
	expect("relabelling lane:console -> lane:canvas does NOT shed the check:", relabelEscape, false);

	if (fails === 0) {
		console.log("\nself-test: all passed");
		process.exit(0);
	}
	console.error(`\nself-test: ${fails} check(s) FAILED`);
	process.exit(1);
}

// ── entry point ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
if (args.includes("--self-test")) {
	runSelfTest();
}
const noBoard = args.includes("--no-board");

let raw;
const fileArg = args.find((a) => !a.startsWith("-"));
try {
	raw = fileArg ? readFileSync(fileArg, "utf8") : readFileSync(0, "utf8");
} catch (err) {
	console.error(`✗ could not read proposal (${fileArg ?? "stdin"}): ${err.message}`);
	process.exit(2);
}

let proposal;
try {
	proposal = JSON.parse(raw);
} catch (err) {
	console.error(`✗ proposal is not valid JSON: ${err.message}`);
	process.exit(2);
}

if (noBoard) {
	process.exit(report(proposal, validate(proposal)));
}

let board;
try {
	board = readOpenBoard();
} catch (error) {
	console.error(`✗ ${error.message ?? String(error)}`);
	process.exit(2);
}
process.exit(report(proposal, validateAgainstBoard(proposal, board)));
