#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// EVERY pnpm SCRIPT A WORKFLOW OR A GUARD NAMES MUST EXIST — AND `pnpm -F <pkg> <script>` MUST
// NOT BE THE WAY IT IS NAMED.
//
// WHY THIS EXISTS (#3853). Measured, not reasoned about:
//
//     $ pnpm -F console definitely-not-a-real-script      ; echo $?
//     None of the selected packages has a "definitely-not-a-real-script" script
//     0
//     $ pnpm -C apps/console run definitely-not-a-real-script ; echo $?
//      ERR_PNPM_NO_SCRIPT  Missing script: definitely-not-a-real-script
//     1
//
// pnpm treats "no selected package has that script" as an EMPTY SELECTION, not an error. A
// filter that matches no package at all (`pnpm -F @alethia/nope build`) exits 0 for the same
// reason. So a workflow step written as `pnpm -F <pkg> <script>` reports SUCCESS having run
// nothing, and the only trace is one line of stdout nobody reads.
//
// It was caught live. #3827 shipped `pnpm -F console audit:report` to stop a scoreboard
// reporting green by never running; its own CI run printed
//
//     ##[group]Run pnpm -F console audit:report
//     None of the selected packages has a "audit:report" script
//
// and BOTH new steps concluded `success` having executed nothing, because the generator was
// not on `dev` yet. The step added to stop a guard going green by never running would itself
// have gone green by never running.
//
// At the time of writing, `.github/workflows/` carried 89 `pnpm -F` invocations, 32 of them
// guard-shaped (`check:*`, `gen:*`, `derive:*`) — including `check:ee-boundary`,
// `check:authz-scope` and `check:migrations`, which are fail-closed security and open-core
// boundary gates. Rename or delete any one of those scripts and its step goes green having
// executed nothing, with the PR that did it looking clean.
//
// THIS IS THE SAME DEFECT ONE LEVEL UP from the one this repo keeps fixing. `check-route-states`
// refuses to score when a predicate stops firing; `check-guards-independent` exists so one
// failure cannot skip 73 later checks. Those are "the guard stopped matching". This is "the
// guard was never invoked", and it is invisible in exactly the way that matters — a green check.
//
// ── THE TWO RULES ─────────────────────────────────────────────────────────────────────────────
//
// The corpus is two populations, DERIVED from `git ls-files`: every workflow, and every tracked
// file under a `scripts/` directory — the guards and generators themselves, whose `::error::` and
// "Regenerate with:" lines are what a human copy-pastes. #3810's audit-report emits "run
// `pnpm -F console audit:report --write` and commit"; follow that after a rename and you get one
// line of output and exit 0, and conclude you have fixed it.
//
// R1 · RESOLUTION. Every pnpm script named anywhere in that corpus — in a `run:`, in an
//      `::error::` string, in a `// Run:` usage header — resolves to a script that exists in the
//      target `package.json`, and its filter selects a workspace package that exists. Prose that
//      tells someone to run a script that was renamed is the same defect with a slower fuse.
//
// R2 · SHAPE. A `pnpm -F <selector> <script>` whose selector names exactly one workspace package
//      is refused, WHEREVER it is written — a command, an error string, a usage comment. It is
//      the silent-exit-0 form, and `pnpm -C <dir> run <script>` is the loud equivalent with
//      identical working-directory semantics and identical `--` argument passing (both probed).
//      R1 alone would catch a rename today; R2 is what stops the shape coming back tomorrow and
//      re-arming the whole class.
//
// Command position still decides one thing — whether an UNFILTERED `pnpm <script>` is an
// invocation at all — because `- name: Every pnpm script a workflow names exists` parses as one.
// See isCommandPosition / isQuotedMention.
//
// ── WHAT IS DELIBERATELY EXEMPT ───────────────────────────────────────────────────────────────
//
// `pnpm -F <pkg> exec <cmd>` is a DIFFERENT shape and is not affected: exec resolves a binary,
// not a script entry, and a missing one exits 254 whichever form is used (probed, both ways).
// Rewriting the playwright/`next start` steps would be churn with no defect behind it.
//
// `@alethia/ee` is exempt from R2 by name, and its absence is not an R1 failure — see EXCEPTIONS.
//
// The UNFILTERED form (`pnpm <script>`, no `-F`/`-C`) is resolved in workflows only. In a source
// file it cannot be told from English — `pnpm uses package-import-method=auto`, `checkout · pnpm ·
// node`, a fixture's `pnpm x` — and root scripts are plain words too, so no shape test separates
// `pnpm vitest` from `pnpm build`. `-F`/`-C` carry their own evidence and are checked everywhere.
//
// OUT OF CORPUS, and stated so nobody reads the green as wider than it is: Markdown (held by
// check-docs-contract.mjs), the Dockerfiles' `RUN pnpm --filter <app> build` — the same defect in
// an image build, but a behaviour change no offline check here can exercise — and
// `.claude/hooks/guard-runtime.sh`'s allow-fixtures, which assert what that hook permits rather
// than instructing anyone. Follow-up rather than silence.
//
// ── BLINDNESS FLOORS ──────────────────────────────────────────────────────────────────────────
//
// This is a line parser (the `yaml` package is a dependency of apps/console, not of the root,
// and this runs under plain `node` — the same constraint as check-workflow-shape.mjs and
// check-guards-independent.mjs). A line parser that stops matching finds nothing and reports
// success. So "found nothing" and "found nothing wrong" are given DIFFERENT exit codes. Each of
// these is a hard error, not a clean bill of health: fewer workflows/corpus files/invocations
// than the floors below, a workspace index that does not contain the console, and — found by
// mutation — a tracked corpus file the disk could not produce. That last one mattered: deleting
// `.github/workflows/` left `git ls-files` reporting all 37, the read errors were swallowed, and
// the check reported GREEN over 106 fewer invocations.
//
//   node scripts/ci/check-pnpm-script-refs.mjs
//   node scripts/ci/check-pnpm-script-refs.mjs --self-test
//
// Do NOT pipe this into `tail`/`head`: a pipe reports the exit code of the LAST command in it.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const WORKFLOW_DIR = ".github/workflows";

/**
 * Selectors that may legitimately match NOTHING, and are therefore exempt from R2 and from the
 * "selector matches no workspace package" half of R1.
 *
 * `@alethia/ee` is the whole open-core boundary: ee/README.md's first boundary rule is "the
 * community application must install, build, test, and run with this directory absent", and
 * pnpm-workspace.yaml lists `ee` as optional for that reason. `pnpm -F @alethia/ee build`
 * skipping in a community checkout is the CORRECT behaviour; `pnpm -C ee run build` would be a
 * hard failure there. Every one of its four call sites is followed immediately by a
 * `test -f ee/dist/index.js` step that fails loudly if the build did not happen — the invariant
 * this guard exists to protect is already asserted there, by a check that cannot be satisfied
 * by an empty selection.
 */
export const EXCEPTIONS = new Map([
	["@alethia/ee", "optional in a community checkout (ee/README.md); each call site asserts ee/dist/index.js separately"],
]);

/** A parser that stops reading the workflow directory must not report a clean bill of health. */
export const MIN_WORKFLOWS = 5;
/** …nor one whose corpus collapsed to the workflows alone. There were ~250 files when written. */
export const MIN_FILES = 100;
/** …nor one that stops recognising `pnpm` invocations. There were ~120 when this was written. */
export const MIN_INVOCATIONS = 40;

/**
 * pnpm's own subcommands. A token in this set is not a script name, so nothing is asserted
 * about it. `run` is handled before this set is consulted; `exec` is exempt on purpose (see
 * the header).
 */
const RESERVED = new Set([
	"add", "approve-builds", "audit", "bin", "config", "create", "dedupe", "deploy", "dlx",
	"doctor", "env", "exec", "fetch", "i", "import", "init", "install", "licenses", "link",
	"list", "ln", "ls", "node", "outdated", "pack", "patch", "patch-commit", "patch-remove",
	"prune", "publish", "rb", "rebuild", "recursive", "remove", "rm", "root", "run", "self-update",
	"server", "setup", "store", "un", "uninstall", "unlink", "up", "update", "why",
]);

// NOT in that set, deliberately: `test` and `start`. pnpm treats them as ALIASES for
// `run test` / `run start`, so `pnpm -F console test` is the defective form, not a
// subcommand — and it is one of the commonest spellings of it in this repo.

/** Flags that consume the following token, so a value is never mistaken for a script name. */
const VALUE_FLAGS = new Set(["-F", "--filter", "-C", "--dir", "--reporter", "--loglevel", "--filter-prod", "--workspace-concurrency"]);

// ── Workspace index ───────────────────────────────────────────────────────────────────────────

/**
 * The `packages:` globs declared by pnpm-workspace.yaml. Line-based, and it RAISES rather than
 * returning [] — a workspace index built from no globs would make every filter unresolvable and
 * every check vacuous.
 * @param {string} text
 * @returns {string[]}
 */
export function parseWorkspaceGlobs(text) {
	const lines = text.split("\n");
	const start = lines.findIndex((l) => /^packages:\s*$/.test(l));
	if (start === -1) throw new Error("pnpm-workspace.yaml has no `packages:` block");
	const globs = [];
	for (let i = start + 1; i < lines.length; i++) {
		if (/^\S/.test(lines[i])) break;
		const m = lines[i].match(/^\s+-\s*["']?([^"'#]+?)["']?\s*$/);
		if (m) globs.push(m[1]);
	}
	if (!globs.length) throw new Error("pnpm-workspace.yaml declares no workspace packages");
	return globs;
}

/**
 * Build `dir → { name, scripts }` for every workspace package plus the root.
 * A glob directory that does not exist is skipped, not an error: `ee` is optional by design.
 * @param {string} root
 * @returns {Map<string, {name: string, scripts: Set<string>}>}
 */
export function loadPackages(root) {
	const pkgs = new Map();
	/** Read one package.json into the index. */
	const add = (dir) => {
		const file = path.join(root, dir, "package.json");
		if (!fs.existsSync(file)) return;
		const json = JSON.parse(fs.readFileSync(file, "utf8"));
		pkgs.set(dir, { name: json.name ?? dir, scripts: new Set(Object.keys(json.scripts ?? {})) });
	};
	add(".");
	for (const glob of parseWorkspaceGlobs(fs.readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf8"))) {
		if (glob.endsWith("/*")) {
			const parent = glob.slice(0, -2);
			let entries = [];
			try {
				entries = fs.readdirSync(path.join(root, parent), { withFileTypes: true });
			} catch {
				continue;
			}
			for (const e of entries) if (e.isDirectory()) add(`${parent}/${e.name}`);
		} else {
			add(glob);
		}
	}
	return pkgs;
}

// ── Extraction ────────────────────────────────────────────────────────────────────────────────

// `pnpm` as a word, not `pnpm/action-setup`, not `pnpm-lock.yaml`, not `cache: pnpm`.
const PNPM = /(?<![\w./@-])pnpm[ \t]+/g;

/**
 * Split the text after `pnpm ` into argument tokens, stopping at the first shell/markup
 * terminator. `gen:matrix'` inside an echo string yields `gen:matrix`, and everything after the
 * quote belongs to the prose, not to the command.
 * @param {string} rest
 * @returns {string[]}
 */
export function tokenize(rest) {
	const tokens = [];
	for (const raw of rest.split(/[ \t]+/)) {
		if (!raw) continue;
		if (raw === "&&" || raw === "||" || raw === "|" || raw === ";") break;
		// A quoted argument (`-F './packages/*'`) is one token, not a terminator. Only a quote
		// that OPENS the token can close it; a quote partway through one — `gen:matrix'` inside
		// an `echo` string — is where the command ends and the prose resumes.
		const q = raw[0];
		if (q === "'" || q === '"') {
			const end = raw.indexOf(q, 1);
			if (end === -1) break;
			tokens.push(raw.slice(1, end));
			continue;
		}
		// A backslash ends the token: these strings live inside JS template literals and Go/JS
		// string constants, where the closer is written `\`` and a line ends `\n`. Without this,
		// `gen:catalog\` and `gen:go-names\n` are reported as missing scripts, which is a guard
		// crying wolf about its own quoting.
		const cut = raw.search(/[`'";)\\]/);
		if (cut === 0) break;
		if (cut > 0) {
			tokens.push(trimPunctuation(raw.slice(0, cut)));
			break;
		}
		tokens.push(trimPunctuation(raw));
	}
	return tokens.filter(Boolean);
}

/** Sentence punctuation is not part of a script name: "run `pnpm env:down`," is `env:down`. */
function trimPunctuation(t) {
	return t.replace(/[,.;:!?]+$/, "");
}

/**
 * Is this `pnpm` the head of a command the shell will actually run, as opposed to a mention of
 * one inside prose, a YAML comment or an `echo` string?
 * @param {string} prefix everything on the line before the `pnpm` token
 * @returns {boolean}
 */
export function isCommandPosition(prefix) {
	if (/^\s*#/.test(prefix)) return false; // a YAML or shell comment line
	let p = prefix.replace(/^\s*/, "");
	p = p.replace(/^-\s+/, ""); // `- run: pnpm …`
	p = p.replace(/^run:\s*/, "");
	if (p === "") return true;
	// A shell operator immediately before the command still leaves it in command position.
	return /(?:&&|\|\||[;|&{(]|\$\(|\bthen\b|\belse\b|\bdo\b)\s*$/.test(p);
}

/**
 * Is this `pnpm` PRESENTED as a command — inside a backtick span, or inside a quoted string?
 *
 * Outside command position, that is the only thing that separates an instruction from English.
 * `- name: Every pnpm script a workflow names exists` parses as `pnpm <script>` and reported a
 * missing root script called `script`; prose about pnpm is not a promise about pnpm.
 * check-docs-contract.mjs makes the identical restriction for the identical reason — it inspects
 * inline code spans only, because "prose is not a contract".
 *
 * The delimiter must CLOSE after the match. An apostrophe in "Turbo's local cache" opens a quote
 * that never ends, and treating that as a quoted mention would put the whole rest of the line
 * back in scope.
 *
 * @param {string} line
 * @param {number} index offset of the `pnpm` token
 * @returns {boolean}
 */
export function isQuotedMention(line, index) {
	let backtickOpen = -1;
	let quote = null;
	let quoteOpen = -1;
	for (let i = 0; i < index; i++) {
		const c = line[i];
		if (quote) {
			if (c === quote) {
				quote = null;
				quoteOpen = -1;
			}
			continue;
		}
		if (c === "`") {
			backtickOpen = backtickOpen === -1 ? i : -1;
			continue;
		}
		if (c === "'" || c === '"') {
			quote = c;
			quoteOpen = i;
		}
	}
	if (backtickOpen !== -1) return line.indexOf("`", index) !== -1;
	if (quote !== null && quoteOpen !== -1) return line.indexOf(quote, index) !== -1;
	return false;
}

/**
 * Every pnpm script invocation named in one workflow's text.
 * @param {string} text
 * @param {string} file for reporting
 * @returns {{file: string, line: number, filter: string|null, dir: string|null, script: string, runKeyword: boolean, commandPosition: boolean, raw: string}[]}
 */
export function extractInvocations(text, file) {
	const out = [];
	const lines = text.split("\n");
	lines.forEach((line, idx) => {
		PNPM.lastIndex = 0;
		for (const m of line.matchAll(PNPM)) {
			const prefix = line.slice(0, m.index);
			const tokens = tokenize(line.slice(m.index + m[0].length));
			let i = 0;
			let filter = null;
			let dir = null;
			while (i < tokens.length) {
				const t = tokens[i];
				if (t === "-F" || t === "--filter") {
					filter = tokens[i + 1] ?? null;
					i += 2;
					continue;
				}
				if (t.startsWith("--filter=")) {
					filter = t.slice("--filter=".length);
					i += 1;
					continue;
				}
				if (t === "-C" || t === "--dir") {
					dir = tokens[i + 1] ?? null;
					i += 2;
					continue;
				}
				if (t.startsWith("--dir=")) {
					dir = t.slice("--dir=".length);
					i += 1;
					continue;
				}
				if (VALUE_FLAGS.has(t)) {
					i += 2;
					continue;
				}
				if (t.startsWith("-")) {
					i += 1;
					continue;
				}
				break;
			}
			if (i >= tokens.length) continue; // `pnpm install --frozen-lockfile` style tail, or no args
			let runKeyword = false;
			let script = tokens[i];
			if (script === "run") {
				runKeyword = true;
				script = tokens[i + 1] ?? null;
			} else if (RESERVED.has(script)) {
				continue; // a pnpm subcommand, not a script
			}
			if (!script) continue;
			// A name assembled at runtime (`${{ matrix.script }}`) or standing in for one
			// (`pnpm -F <app> build`) cannot be resolved statically, in either position.
			// `*` is NOT a placeholder in a selector — it is a pnpm glob, and resolveFilter must
			// see it so an unmodelled selector is reported rather than skipped.
			if (/[${}<>*]/.test(script)) continue;
			if (filter !== null && /[${}<>]/.test(filter)) continue;
			if (dir !== null && /[${}<>*]/.test(dir)) continue;
			// `-F` and `-C` carry their own evidence — English does not contain `pnpm -F` — so a
			// filtered invocation is in scope wherever it is written, including a bare
			// `// Run: pnpm -F console gen:go-enums` usage header, which is exactly the line
			// someone copies. An UNFILTERED one is only in scope where the shell will run it, or
			// where it is presented as a command in backticks or quotes; otherwise
			// `- name: Every pnpm script a workflow names exists` parses as `pnpm <script>`.
			const commandPosition = isCommandPosition(prefix);
			const filtered = filter !== null || dir !== null;
			if (!filtered && !commandPosition && !isQuotedMention(line, m.index)) continue;
			out.push({
				file,
				line: idx + 1,
				filter,
				dir,
				script,
				runKeyword,
				commandPosition,
				raw: line.trim(),
			});
		}
	});
	return out;
}

// ── Resolution ────────────────────────────────────────────────────────────────────────────────

/**
 * Resolve a `-F` selector against the workspace index.
 * @param {string} sel
 * @param {Map<string, {name: string, scripts: Set<string>}>} pkgs
 * @returns {{kind: "dirs", dirs: string[]} | {kind: "none"} | {kind: "unmodelled"}}
 */
export function resolveFilter(sel, pkgs) {
	// Globs, dependency traversals (`...pkg`), `[since]` selectors: shapes this guard does not
	// model. It says so rather than passing them — an unmodelled selector is exactly how a new
	// silent form would enter unnoticed.
	if (/[*!{}\[\]^]|\.\.\./.test(sel)) return { kind: "unmodelled" };
	// Three spellings pnpm accepts for one package, tried in the order it resolves them: a
	// directory path, the full package name, then the name without its scope.
	const asPath = sel.replace(/^\.\//, "").replace(/\/$/, "");
	if (pkgs.has(asPath) && asPath !== ".") return { kind: "dirs", dirs: [asPath] };
	const byName = [...pkgs].filter(([d, p]) => d !== "." && p.name === sel);
	if (byName.length) return { kind: "dirs", dirs: byName.map(([d]) => d) };
	const unscoped = [...pkgs].filter(([d, p]) => d !== "." && p.name.replace(/^@[^/]+\//, "") === sel);
	if (unscoped.length) return { kind: "dirs", dirs: unscoped.map(([d]) => d) };
	return { kind: "none" };
}

/**
 * Apply R1 and R2 to one extracted invocation.
 * @param {ReturnType<typeof extractInvocations>[number]} inv
 * @param {Map<string, {name: string, scripts: Set<string>}>} pkgs
 * @returns {{rule: string, msg: string, hint?: string}[]}
 */
export function classify(inv, pkgs) {
	const findings = [];
	/** Record one violation. */
	const fail = (rule, msg, hint) => findings.push({ rule, msg, hint });

	let dirs;
	if (inv.dir !== null) {
		const d = inv.dir.replace(/^\.\//, "").replace(/\/$/, "");
		if (!pkgs.has(d)) {
			fail("R1", `pnpm -C ${inv.dir} run ${inv.script}: ${d}/package.json is not a workspace package`);
			return findings;
		}
		dirs = [d];
	} else if (inv.filter !== null) {
		const r = resolveFilter(inv.filter, pkgs);
		if (r.kind === "unmodelled") {
			fail("R1", `pnpm -F ${inv.filter} ${inv.script}: selector shape not modelled by this guard`, "extend resolveFilter() rather than leaving it unchecked — an unmodelled selector is how the silent form returns");
			return findings;
		}
		if (r.kind === "none") {
			if (!EXCEPTIONS.has(inv.filter))
				fail("R1", `pnpm -F ${inv.filter} ${inv.script}: no workspace package matches that filter (pnpm exits 0 on an empty selection)`);
			return findings;
		}
		dirs = r.dirs;
		// Not gated on command position. A `::error::` string naming this form is the line a
		// human copy-pastes; following it after a rename prints one line and exits 0, which reads
		// as "done". The remedy a guard prints must fail as loudly as the guard does.
		if (!EXCEPTIONS.has(inv.filter) && dirs.length === 1)
			fail(
				"R2",
				`pnpm -F ${inv.filter} ${inv.runKeyword ? "run " : ""}${inv.script}: exits 0 when the script is missing`,
				`use \`pnpm -C ${dirs[0]} run ${inv.script}\` — same working directory, ERR_PNPM_NO_SCRIPT instead of silence`,
			);
	} else {
		// An UNFILTERED `pnpm <script>` is only checked inside a workflow, where a `run:` line and
		// a backticked remediation are commands by construction. In a source file it cannot be
		// told from English: `pnpm uses package-import-method=auto`, `checkout · pnpm · node`,
		// "NOT `pnpm vitest --project apps/console`" and a synthetic fixture's `pnpm x` all parse
		// as a script name, and no shape test separates `pnpm vitest` from `pnpm build` — root
		// scripts are plain words too. `-F`/`-C` carry their own evidence: English does not
		// contain `pnpm -F`, and those are the forms #3853 is about, so they are checked
		// everywhere. Reporting the ambiguous half everywhere would teach people to route around
		// the guard, which costs more than the half it would add.
		if (!inv.file.startsWith(`${WORKFLOW_DIR}/`)) return findings;
		dirs = ["."];
	}

	for (const d of dirs) {
		const pkg = pkgs.get(d);
		if (!pkg || !pkg.scripts.size) continue; // a package with no scripts asserts nothing
		if (!pkg.scripts.has(inv.script))
			fail("R1", `${inv.script}: no such script in ${d}/package.json`, nearest(inv.script, pkg.scripts));
	}
	return findings;
}

/** Cheapest useful suggestion: a script sharing this one's prefix. */
function nearest(script, scripts) {
	const stem = script.split(":")[0];
	const near = [...scripts].filter((s) => s.startsWith(stem)).slice(0, 4);
	return near.length ? `did you mean: ${near.join(" · ")}` : undefined;
}

// ── Run ───────────────────────────────────────────────────────────────────────────────────────

/**
 * The corpus, DERIVED from `git ls-files` rather than typed out — a hand-written list of what a
 * guard watches stops covering silently.
 *
 * Two populations, for one reason each:
 *
 *   `.github/workflows/**` — a step that runs nothing and reports success. Nobody reads the log.
 *
 *   every tracked file under a `scripts/` directory — the guards and generators themselves, whose
 *   `::error::` and "Regenerate with:" messages are the line a human COPY-PASTES. #3810's
 *   audit-report emits "run `pnpm -F console audit:report --write` and commit"; follow that after
 *   a rename and you get exit 0 and conclude you have fixed it. Same defect, one layer out, and
 *   arguably worse because a person acts on it by hand.
 *
 * Markdown is NOT here: check-docs-contract.mjs already holds every `pnpm` script named in the
 * operating docs to a real script, by the same technique over a different input set. Two guards
 * on one corpus is how their verdicts start disagreeing.
 *
 * @param {string} root
 * @returns {string[]} repo-relative paths
 */
export function corpus(root) {
	return execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
		.split("\n")
		.filter(Boolean)
		.filter(inCorpus)
		.filter((f) => f !== SELF);
}

/**
 * This file, excluded from its own corpus.
 *
 * A guard whose subject is a string pattern cannot scan itself: the header quotes the measurement
 * verbatim (`pnpm -F console definitely-not-a-real-script`) and the self-test drives both rules
 * over fixtures that are, by construction, the defect. Scanning them would make the only way to
 * pass "stop writing down what the guard refuses", and the fixtures are what prove it can fail.
 *
 * Derived from `import.meta.url`, not typed, so a rename cannot silently re-arm it.
 */
export const SELF = path.relative(ROOT, fileURLToPath(import.meta.url));

/**
 * Is one repo-relative path in the corpus? Extracted so the membership rule is testable without
 * a git checkout — and so it is one rule rather than two that can drift.
 * @param {string} f
 * @returns {boolean}
 */
export function inCorpus(f) {
	if (f.startsWith(`${WORKFLOW_DIR}/`)) return f.endsWith(".yml") || f.endsWith(".yaml");
	return f.split("/").slice(0, -1).includes("scripts");
}

/**
 * Scan the corpus and score it.
 * @param {string} root
 * @returns {{files: number, workflows: number, invocations: number, findings: object[]}}
 */
export function run(root) {
	const files = corpus(root);
	const workflows = files.filter((f) => f.startsWith(`${WORKFLOW_DIR}/`)).length;
	const pkgs = loadPackages(root);
	if (!pkgs.has(".")) throw new Error("no root package.json — the workspace index is empty and every check would be vacuous");
	if (![...pkgs].some(([d]) => d === "apps/console"))
		throw new Error("the workspace index does not contain apps/console — it is not reading this repository");

	const invocations = [];
	// A corpus file git lists but the disk cannot produce is BLINDNESS, not absence: the file
	// count stays put while its contents go unscanned. Found by mutation — deleting
	// `.github/workflows/` left `git ls-files` reporting all 37 and the guard reported GREEN over
	// 106 fewer invocations. Skipping a read is the one thing this check must never do quietly.
	const unreadable = [];
	for (const f of files) {
		let text;
		try {
			text = fs.readFileSync(path.join(root, f), "utf8");
		} catch (e) {
			unreadable.push(`${f} (${e.code ?? e.message})`);
			continue;
		}
		invocations.push(...extractInvocations(text, f));
	}
	if (unreadable.length)
		throw new Error(`${unreadable.length} tracked corpus file(s) could not be read, so they were not scanned:\n    ${unreadable.slice(0, 10).join("\n    ")}`);

	const findings = [];
	for (const inv of invocations) for (const f of classify(inv, pkgs)) findings.push({ ...f, file: inv.file, line: inv.line, raw: inv.raw });
	return { files: files.length, workflows, invocations: invocations.length, findings };
}

// ── Self-test ─────────────────────────────────────────────────────────────────────────────────

/**
 * Drive both rules over synthetic fixtures, in BOTH directions. A guard that only proves it can
 * pass proves nothing; each case below has a sibling that must NOT fire.
 * @returns {number} failing case count
 */
function selfTest() {
	/** @type {Map<string, {name: string, scripts: Set<string>}>} */
	const pkgs = new Map([
		[".", { name: "alethia", scripts: new Set(["check:open-core", "gen:programme"]) }],
		["apps/console", { name: "console", scripts: new Set(["build", "check:migrations", "gen:matrix"]) }],
		["packages/ui", { name: "@repo/ui", scripts: new Set(["build"]) }],
		["ee", { name: "@alethia/ee", scripts: new Set(["build"]) }],
	]);
	const WF = `${WORKFLOW_DIR}/f.yml`;
	const SRC = "apps/console/scripts/gen-thing.mjs";
	/** Rules fired by one line, read as a workflow line unless a file is given. */
	const rules = (line, file = WF) =>
		extractInvocations(line, file)
			.flatMap((i) => classify(i, pkgs))
			.map((f) => f.rule)
			.sort()
			.join(",");

	const cases = [
		// ── corpus membership ─────────────────────────────────────────────────────────────────
		["a workflow is in the corpus", () => inCorpus(`${WORKFLOW_DIR}/ci.yml`) === true],
		["a non-workflow file in that directory is not", () => inCorpus(`${WORKFLOW_DIR}/README.md`) === false],
		["a guard under scripts/ is in the corpus", () => inCorpus("apps/console/scripts/gen-catalog.mjs") === true],
		["a library file is not", () => inCorpus("apps/console/lib/cli/paging.ts") === false],
		["a directory merely NAMED scripts.ts is not", () => inCorpus("apps/console/lib/scripts.ts") === false],
		// A guard whose subject is a string pattern cannot scan its own fixtures — but the
		// exemption must be exactly one file, derived, not a directory anyone can hide in.
		["this file resolves as its own exemption", () => SELF === "scripts/ci/check-pnpm-script-refs.mjs"],
		["its SIBLINGS are still scanned", () => inCorpus("scripts/ci/check-workflow-shape.mjs") === true],

		// ── extraction ────────────────────────────────────────────────────────────────────────
		["a -F invocation is extracted", () => extractInvocations("        run: pnpm -F console build", WF).length === 1],
		["pnpm/action-setup is not an invocation", () => extractInvocations("      - uses: pnpm/action-setup@v6", WF).length === 0],
		["`cache: pnpm` is not an invocation", () => extractInvocations("          cache: pnpm", WF).length === 0],
		["a bare pnpm subcommand is not a script", () => extractInvocations("        run: pnpm install --frozen-lockfile", WF).length === 0],
		["exec is not a script (it fails loudly either way)", () => extractInvocations("        run: pnpm -F console exec playwright test", WF).length === 0],
		["a runtime-assembled name is not guessed at", () => extractInvocations("        run: pnpm -F console ${{ matrix.script }}", WF).length === 0],
		["a placeholder selector is not guessed at", () => extractInvocations("// runs as `pnpm -F <app> build`", SRC).length === 0],
		["a quoted mention stops at the quote", () => tokenize("-F console gen:matrix' and commit.\"")[2] === "gen:matrix"],
		["a shell operator ends the command", () => tokenize("-F console build && echo hi").length === 3],
		["a quoted argument is one token, not a terminator", () => tokenize("-F './packages/*' build")[1] === "./packages/*"],
		// Both of these reported phantom missing scripts before they were handled: these strings
		// live inside JS template literals and Go constants, where the closer is `\`` and a line
		// break is `\n`, and sentences end in a full stop.
		["a backslash ends the token", () => tokenize("-F console gen:catalog\\` to regenerate")[2] === "gen:catalog"],
		["sentence punctuation is not part of the name", () => tokenize("-F console env:down, then")[2] === "env:down"],

		// ── R1, both directions ───────────────────────────────────────────────────────────────
		["a missing script is reported", () => rules("        run: pnpm -C apps/console run check:gone") === "R1"],
		["an existing script is not reported", () => rules("        run: pnpm -C apps/console run check:migrations") === ""],
		["a missing ROOT script is reported", () => rules("        run: pnpm check:nope") === "R1"],
		["an existing root script is not reported", () => rules("        run: pnpm check:open-core") === ""],
		["a renamed script named only in prose is reported", () => rules("          || { echo \"::error::stale — run 'pnpm -F console gen:gone' and commit.\"; exit 1; }").includes("R1")],
		["a live script named in prose is not reported as missing", () => !rules("          || { echo \"::error::stale — run 'pnpm -F console gen:matrix' and commit.\"; exit 1; }").includes("R1")],
		["a filter matching no package is reported", () => rules("        run: pnpm -F nonesuch build") === "R1"],
		["an unmodelled selector is reported, not skipped", () => rules("        run: pnpm -F './packages/*' build") === "R1"],
		["a -C dir that is not a package is reported", () => rules("        run: pnpm -C apps/nope run build") === "R1"],
		// The ambiguous half. In a source file `pnpm uses package-import-method=auto` and a
		// fixture's `pnpm x` parse as script names, and no shape test separates them from
		// `pnpm build` — so the UNFILTERED form is checked in workflows only.
		["an unfiltered mention in a source file is not checked", () => rules("// no .npmrc — pnpm uses package-import-method=auto", SRC) === ""],
		["…but the same line in a workflow IS", () => rules("        run: pnpm uses", WF) === "R1"],
		["a FILTERED mention in a source file IS checked", () => rules("// Run: pnpm -F console gen:gone", SRC).includes("R1")],

		// ── R2, both directions ───────────────────────────────────────────────────────────────
		["the silent -F form in command position is refused", () => rules("        run: pnpm -F console build") === "R2"],
		["`-F <pkg> run <script>` is refused too (same empty selection)", () => rules("        run: pnpm -F console run build") === "R2"],
		["the -C run form is accepted", () => rules("        run: pnpm -C apps/console run build") === ""],
		["a block-scalar line is refused", () => rules("          pnpm -F console gen:matrix") === "R2"],
		["after a shell operator is refused", () => rules("          cd x && pnpm -F console build") === "R2"],
		// Not gated on command position: the remedy a guard PRINTS is the line a human runs.
		["a remedy string is refused", () => rules("          echo \"run 'pnpm -F console build' first\"") === "R2"],
		["a bare usage comment in a guard is refused", () => rules("// Run: pnpm -F console gen:matrix", SRC) === "R2"],
		["a declared exception is exempt from R2", () => rules("        run: pnpm -F @alethia/ee build") === ""],
		["…and its absence is not an R1 failure", () => {
			const thin = new Map([[".", { name: "alethia", scripts: new Set(["x"]) }]]);
			return extractInvocations("        run: pnpm -F @alethia/ee build", WF).flatMap((i) => classify(i, thin)).length === 0;
		}],
		["an UNDECLARED absent package still fails", () => {
			const thin = new Map([[".", { name: "alethia", scripts: new Set(["x"]) }]]);
			return extractInvocations("        run: pnpm -F console build", WF).flatMap((i) => classify(i, thin)).some((f) => f.rule === "R1");
		}],
		// The false positive that shipped in the first draft: a step NAME containing the word
		// pnpm parsed as `pnpm <script>` and reported a missing root script called `script`.
		["a step name mentioning pnpm is not an invocation", () => rules("      - name: Every pnpm script a workflow names exists") === ""],
		["…while a backticked one in the same file is", () => rules("      # see `pnpm -F console gen:matrix`") === "R2"],

		// ── blindness floors ──────────────────────────────────────────────────────────────────
		["a workspace file with no packages raises", () => {
			try {
				parseWorkspaceGlobs("name: x\n");
				return false;
			} catch {
				return true;
			}
		}],
		["an empty packages block raises", () => {
			try {
				parseWorkspaceGlobs("packages:\n\nother: 1\n");
				return false;
			} catch {
				return true;
			}
		}],
		["the real globs parse", () => parseWorkspaceGlobs('packages:\n  - "apps/*"\n  # a note\n  - "ee"\n').join(",") === "apps/*,ee"],
	];

	let bad = 0;
	for (const [name, fn] of cases) {
		let ok = false;
		try {
			ok = fn() === true;
		} catch (e) {
			ok = false;
			console.error(`    (threw: ${e.message})`);
		}
		if (!ok) {
			console.error(`  ✗ ${name}`);
			bad++;
		}
	}
	console.log(`  ${cases.length - bad}/${cases.length} self-test cases passed`);
	return bad;
}

// ── Entry ─────────────────────────────────────────────────────────────────────────────────────

if (process.argv.includes("--self-test")) {
	process.exit(selfTest() ? 1 : 0);
}

let result;
try {
	result = run(ROOT);
} catch (e) {
	console.error(`✗ check-pnpm-script-refs: ${e.message}`);
	console.error("  This is a BLINDNESS failure, not a clean run — nothing was checked.");
	process.exit(1);
}

if (result.workflows < MIN_WORKFLOWS) {
	console.error(`✗ check-pnpm-script-refs: only ${result.workflows} workflow file(s) found (floor ${MIN_WORKFLOWS}).`);
	console.error("  A scan that reads no workflows reports no violations. That is blindness, not health.");
	process.exit(1);
}
if (result.files < MIN_FILES) {
	console.error(`✗ check-pnpm-script-refs: only ${result.files} corpus file(s) found (floor ${MIN_FILES}).`);
	console.error("  The corpus rule has stopped matching the tree. Nothing was checked.");
	process.exit(1);
}
if (result.invocations < MIN_INVOCATIONS) {
	console.error(`✗ check-pnpm-script-refs: only ${result.invocations} pnpm invocation(s) extracted (floor ${MIN_INVOCATIONS}).`);
	console.error("  The line parser has stopped recognising what it believes it reads.");
	process.exit(1);
}

if (result.findings.length) {
	console.error(`✗ check-pnpm-script-refs: ${result.findings.length} violation(s) across ${result.files} files (${result.workflows} workflows).\n`);
	let last = "";
	for (const f of result.findings) {
		if (f.file !== last) {
			console.error(`  ${f.file}`);
			last = f.file;
		}
		console.error(`    :${f.line}  [${f.rule}] ${f.msg}`);
		if (f.hint) console.error(`         → ${f.hint}`);
	}
	console.error("\n`pnpm -F <pkg> <script>` exits 0 when the script does not exist (#3853) — a CI step");
	console.error("written that way reports success having executed nothing.");
	process.exit(1);
}

console.log(
	`✓ check-pnpm-script-refs: ${result.invocations} pnpm invocations across ${result.files} files ` +
		`(${result.workflows} workflows + every scripts/ directory) all resolve, and none uses the exit-0 filter form.`,
);
