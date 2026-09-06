#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * CI guard: project templates must survive `tofu plan -refresh-only` (#3351).
 *
 * WHAT BREAKS. Refresh-only refreshes what is IN STATE; it never plans a create. A resource whose
 * `count` is 1 in the config but which has no instance in state is therefore an EMPTY TUPLE, and
 * any `[0]` index into it aborts the whole plan in seconds:
 *
 *     Error: Invalid index … azurerm_user_assigned_identity.aks is empty tuple
 *
 * Measured on OpenTofu 1.9.0 — the engine the runner applies with — and on 1.12.3:
 *
 *   | predicate | in state | mode         | result                                              |
 *   |-----------|----------|--------------|-----------------------------------------------------|
 *   | false     | no       | refresh-only | clean: an untaken conditional arm is never evaluated |
 *   | true      | no       | refresh-only | **Invalid index — the whole plan aborts**           |
 *   | true      | no       | normal plan  | clean: it plans the create                          |
 *   | true      | no       | refresh-only | clean with `one(x[*].attr)`                         |
 *   | true      | no       | refresh-only | clean with `try(x[0].attr, …)`                      |
 *
 * So this is invisible to provisioning and to every e2e that applies and checks in one run. It
 * bites exactly one population: environments whose template has advanced past their last apply —
 * which is the population drift detection exists to serve. Drift detection was dead on a
 * production environment for five weeks, failing in 13 seconds with nothing else reported.
 *
 * AN EMPTY STATE DOES NOT REPRODUCE IT, and the near-miss is worth recording because it reads like
 * a disproof. `plan -refresh-only` against a state with NO resources at all walks nothing and never
 * evaluates the module inputs: measured on 1.9.0 against the pre-#3509 aws template, that run
 * reached provider credential validation without one "Invalid index". The failing condition is a
 * state that HAS instances plus a counted block the state does not have — an environment whose
 * template moved — which is why no fixture and no e2e in this repo can hold it, and why the
 * question is asked statically here instead.
 *
 * WHAT THIS ASKS — the cheapest sound question. For every RESOURCE or DATA SOURCE counted 0-or-1, is there an
 * unprotected `[0]` index into it in the same module directory? No HCL evaluation, no attempt to
 * know which environments are behind: `one(x[*].attr)` is correct wherever `x[0].attr` was, so
 * over-reporting costs a safer expression and nothing else.
 *
 * MODULES ASK THE SAME QUESTION AND TAKE A DIFFERENT ANSWER (#3509). The abort is identical, but
 * `one()` is the WRONG rewrite for a module, and three of the four candidate shapes fail:
 *
 *   | shape                                            | refresh-safe | cycle-safe   | typo-safe |
 *   |--------------------------------------------------|--------------|--------------|-----------|
 *   | `one(module.x[*].out)`                            | yes          | NO — whole   | yes       |
 *   | `length(module.x) > 0 ? module.x[0].out : f`      | yes          | NO — whole   | yes       |
 *   | `try(module.x[0].out, null)`                      | yes          | yes          | NO        |
 *   | `try(module.x[0].out, null) != null ? … : f`      | yes          | yes          | yes       |
 *
 * "whole" means the expression references the module AS A WHOLE rather than one instance, and that
 * coarser edge closes dependency CYCLES `tofu validate` refuses outright. Both failing shapes are
 * measured, not reasoned: `infra/templates/project/aws/rds.tf` carries the aws case from #1772 —
 * `module.eks` reads `local.secrets_kms_key_arns` + `local.eso_secret_arns`, so any whole-module
 * reference to `module.rds_maindb` from those locals makes rds_maindb wait on eks, which waits on
 * them. `length()` is NOT the safe half of that pair; it is the same edge as the splat.
 *
 * "typo-safe" is the reason bare `try()` loses: it swallows every evaluation error, not just the
 * empty-tuple one, so a renamed module output silently becomes null (measured: `tofu validate`
 * reports Success! on `try(module.m[0].nonexistent_output, null)`) and a NORMAL apply degrades
 * instead of failing its plan.
 *
 * The surviving shape probes ONE OUTPUT OF ONE INSTANCE and then repeats the traversal OUTSIDE the
 * `try()`, so the edge stays exactly as fine as the bare index it replaces and a misspelled output
 * is still a validation error:
 *
 *     try(module.x[0].out, null) != null ? module.x[0].out : <typed fallback>
 *
 * Wrap the true branch when the value needs it — the probe still names the single output:
 *
 *     try(module.aks[0].client_certificate, null) != null ? base64decode(module.aks[0].client_certificate) : ""
 *
 * THE FALLBACK MUST BE A VALUE THE TARGET ACCEPTS, and this guard cannot check that — it reads
 * lines, not provider schemas. It is the one half of the rewrite left to the author, so it is
 * stated here rather than left to be rediscovered: a bare `null` into a REQUIRED provider argument
 * trades one abort for another. Measured on 1.9.0 against `azurerm_federated_identity_credential`,
 * whose `issuer` the schema marks required — `issuer = null` fails the plan with
 *
 *     Error: Missing required argument — The argument "issuer" is required, but no definition was found.
 *
 * while `issuer = ""` plans clean. So `""` is the fallback wherever the value reaches a required
 * string; `null` is right only where the consumer accepts it — an OPTIONAL argument (azure's
 * `firewall_policy_id`, where "" would be an invalid resource id), a `compact([…])` that strips it
 * (aws/locals.tf), or a root output, which is a leaf and where null IS the "absent" signal the
 * runner harvests.
 *
 * Keep the probe on ONE LINE: this guard reads a line at a time and cannot see a probe wrapped
 * onto the line above. Every other counted-module index is a finding, and so is every counted
 * `module.x[*]` splat — nothing in these templates needs one, and reaching for it is what kept
 * #3509 open.
 *
 * `length(module.x)` READING NO OUTPUT IS NOT WHAT IS REJECTED, and the distinction is the whole
 * point rather than an exemption. What the table rules out is BUYING a whole-module edge to reach
 * an OUTPUT that an instance probe reaches with a finer one — `length(module.x) > 0 ? module.x[0].out
 * : f`. A pure existence test reads nothing and has no probe equivalent, because there is no output
 * to probe:
 *
 *     value     = length(module.karpenter) > 0 ? local.aws_default_tags : null   # aws/outputs.tf
 *     condition = (length(module.acr) > 0) == (var.provision_acr && …)           # azure/checks.tf
 *
 * Five such sites are deliberate, each carrying its own note: two aws outputs whose value is a local
 * (a root output is a graph leaf and cannot cycle) and three `check` blocks asserting a module's
 * EXPANSION against its predicate — which is the drift those checks exist to catch, and a check
 * block is likewise a leaf. THIS GUARD CANNOT SEE THEM: with no `[0]` there is no reference to
 * anchor on, so the paragraph above is prose, not enforcement. Stated because the guard's rule and
 * the tree would otherwise look like they disagree, and the wrong way to resolve that is to
 * "fix" a site whose `length()` is the only shape that can express what it asks.
 *
 * WHAT IT DOES NOT COVER, each for a measured reason:
 *
 *   - a resource counted by anything but a 0-or-1 conditional (`count = var.vswitch_count`) —
 *     there `[0]` is a real index and `one()` would be wrong, erroring on the second instance.
 *   - `try(…)`-wrapped references, and the template's own `length(x) > 0 ? x[0]… : …` idiom: both
 *     measured refresh-safe above. `length()` excuses a RESOURCE or DATA SOURCE only — on a module
 *     it is the cycle shape ruled out in the table above, so it is a finding there.
 *   - `depends_on`, and `moved`/`removed`/`import` blocks: not value expressions. The last three
 *     accept "a single static variable reference" only, so `one()` there is a hard error.
 *
 * Usage:
 *   node scripts/check-templates-refresh-safe.mjs [root]     # default infra/templates/project
 *   node scripts/check-templates-refresh-safe.mjs --self-test
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** A `count` expression that can only ever be 0 or 1. */
const ZERO_OR_ONE = /\?\s*1\s*:\s*0|\?\s*0\s*:\s*1/;

/** Every directory under `root` holding .tf files — a template or one of its modules. */
function moduleDirs(dir, out = []) {
	const entries = fs.readdirSync(dir, { withFileTypes: true });
	if (entries.some((e) => e.isFile() && e.name.endsWith(".tf"))) out.push(dir);
	for (const e of entries) {
		if (e.isDirectory() && !e.name.startsWith("."))
			moduleDirs(path.join(dir, e.name), out);
	}
	return out;
}

/**
 * Blank out `#`/`//` comments and heredoc bodies, preserving line and column positions.
 *
 * Block HEADERS are read from this form, not from the string-stripped one below:
 * `resource "type" "name"` is nothing but quoted strings, and masking those first is how the
 * first draft of this guard reported "0 counted blocks" over a tree full of them. The
 * examined-counts line printed on success is what caught that.
 */
function stripComments(src) {
	let inBlockComment = false;
	const lines = src.split("\n").map((line) => {
		let quoted = false;
		let escaped = false;
		let out = "";
		for (let i = 0; i < line.length; i++) {
			const ch = line[i];
			const next = line[i + 1];
			if (inBlockComment) {
				if (ch === "*" && next === "/") {
					out += "  ";
					i++;
					inBlockComment = false;
				} else out += " ";
				continue;
			}
			if (quoted) {
				out += ch;
				if (escaped) escaped = false;
				else if (ch === "\\") escaped = true;
				else if (ch === '"') quoted = false;
				continue;
			}
			if (ch === '"') {
				quoted = true;
				out += ch;
				continue;
			}
			if (ch === "/" && next === "*") {
				out += "  ";
				i++;
				inBlockComment = true;
				continue;
			}
			if (ch === "#" || (ch === "/" && next === "/")) {
				out += " ".repeat(line.length - i);
				break;
			}
			out += ch;
		}
		return out.padEnd(line.length, " ");
	});
	let heredoc = null;
	return lines
		.map((line) => {
			if (heredoc) {
				if (new RegExp(`^\\s*${heredoc}\\s*$`).test(line)) heredoc = null;
				return " ".repeat(line.length);
			}
			const withoutStrings = line.replace(/"(?:[^"\\]|\\.)*"/g, (m) =>
				" ".repeat(m.length),
			);
			const open = withoutStrings.match(/<<-?\s*([A-Z][A-Z0-9_]*)/);
			if (open) heredoc = open[1];
			return line;
		})
		.join("\n");
}

/**
 * Additionally blank out quoted strings, for the pass that looks for REFERENCES.
 *
 * A reference inside a string is prose: `error_message = "… module.acr[0] would fail the apply"`
 * is a sentence about this very bug, and flagging it would send a reader to edit an error message.
 */
function stripNonCode(src) {
	const clean = stripComments(src);
	let out = "";
	let inString = false;
	let escaped = false;
	let interpolationDepth = 0;
	for (let i = 0; i < clean.length; i++) {
		const ch = clean[i];
		const next = clean[i + 1];
		if (!inString) {
			if (ch === '"') {
				inString = true;
				out += " ";
			} else out += ch;
			continue;
		}
		if (interpolationDepth > 0) {
			out += ch;
			if (ch === "{") interpolationDepth++;
			else if (ch === "}") interpolationDepth--;
			continue;
		}
		if (escaped) {
			escaped = false;
			out += " ";
			continue;
		}
		if (ch === "\\") {
			escaped = true;
			out += " ";
			continue;
		}
		if (ch === '"') {
			inString = false;
			out += " ";
			continue;
		}
		if (ch === "$" && next === "{") {
			out += "${";
			i++;
			interpolationDepth = 1;
			continue;
		}
		out += ch === "\n" ? "\n" : " ";
	}
	return out;
}

/** Return the closing brace for a block in position-preserving code, or -1. */
function closingBrace(code, opening) {
	let depth = 0;
	for (let i = opening; i < code.length; i++) {
		if (code[i] === "{") depth++;
		else if (code[i] === "}" && --depth === 0) return i;
	}
	return -1;
}

/** Read a possibly multiline count expression from one balanced block body. */
function countExpression(block) {
	const match = /^\s*count\s*=\s*/m.exec(block);
	if (!match) return null;
	let value = "";
	let depth = 0;
	for (let i = match.index + match[0].length; i < block.length; i++) {
		const ch = block[i];
		if (ch === "(" || ch === "[" || ch === "{") depth++;
		else if (ch === ")" || ch === "]" || ch === "}") depth--;
		if (ch === "\n" && depth === 0) break;
		value += ch;
	}
	return value.replace(/\s+/g, " ").trim();
}

/** True when the reference at `column` sits inside a `try(…)` call on this line. */
function isInsideTry(line, column) {
	const before = line.slice(0, column);
	let depth = 0;
	for (let i = before.length - 1; i >= 0; i--) {
		const ch = before[i];
		if (ch === ")") depth++;
		else if (ch === "(") {
			// Every ENCLOSING call, not just the innermost: the reference in
			// `try(length(trimspace(x[0].y)) > 0, false)` is three calls deep and still protected.
			// Stopping at the first `(` reported that line as a finding.
			if (depth === 0) {
				if (/\btry$/.test(before.slice(0, i))) return true;
			} else depth--;
		}
	}
	return false;
}

/**
 * True when the reference is protected by the template's own `length(<same address>)` idiom.
 *
 * With no instance in state the length is 0, the conditional takes its other arm, and an untaken
 * arm is never evaluated — measured.
 *
 * RESOURCES AND DATA SOURCES ONLY — a module never reaches this function, because a
 * `length(module.x) > 0` guard is the substantive thing #3509 rejects: it reads the module as a
 * WHOLE, exactly like `module.x[*]`, and aws/rds.tf records the cycle that closes. Refresh-safe
 * and cycle-UNSAFE buys a module site nothing, so the module branch in `scanRoot` never asks.
 */
function isLengthGuarded(line, address) {
	return line.includes(`length(${address})`);
}

/**
 * The `?` and `:` of the conditional that starts at `from`, at depth 0 relative to it.
 *
 * Positional, not structural, and that is all it needs to be: the question is only whether the
 * reference sits in the TRUE ARM. A reference nested inside `base64decode(…)`, a list literal or a
 * `${…}` interpolation is still positionally between the two.
 */
function ternaryArm(line, from) {
	let depth = 0;
	let question = -1;
	for (let i = from; i < line.length; i++) {
		const ch = line[i];
		if ("([{".includes(ch)) depth++;
		else if (")]}".includes(ch)) {
			if (depth === 0) break;
			depth--;
		} else if (depth === 0 && ch === "?" && question < 0) question = i;
		else if (depth === 0 && ch === ":" && question >= 0)
			return { question, colon: i };
	}
	// A conditional with no `:` is not one. Fail closed rather than treat the rest of the line as
	// the true arm — that is how "somewhere before the reference" accepted the false arm.
	return null;
}

/** The output name a reference traverses, or null when it traverses none (`module.x[0]` alone). */
function referencedOutput(line, address, column) {
	const escaped = address.replaceAll(".", "\\.");
	const m = new RegExp(`^${escaped}\\[0\\]\\.([a-z0-9_]+)`, "i").exec(
		line.slice(column),
	);
	return m === null ? null : m[1];
}

/**
 * True when this reference IS the probe — the occurrence inside `try(module.x[0].out, null)`.
 *
 * Needed because the module branch does NOT excuse a `try()`-wrapped reference the way the resource
 * branch does. A bare `try(module.x[0].out, "")` is the typo-unsafe shape the header rules out, so
 * only the probe's own occurrence may be skipped, and only when the probe is actually formed.
 */
function isProbeItself(line, address, column) {
	const out = referencedOutput(line, address, column);
	if (out === null) return false;
	if (!line.slice(0, column).endsWith(`try(`)) return false;
	return line.includes(`try(${address}[0].${out}, null) != null`);
}

/**
 * True when a counted-module reference sits in the TRUE ARM of its own single-output probe.
 *
 * The accepted shape, and the ONLY one:
 *
 *     try(module.x[0].out, null) != null ? … module.x[0].out … : <fallback>
 *
 * Four things are load-bearing and each rejects a shape that looks equivalent:
 *
 *   - the probe names `module.x[0]` — ONE INSTANCE — so the graph edge is as fine as the bare
 *     index. `try(module.x[0], null)` (the whole instance) depends on ALL of that instance's
 *     outputs; it reads as the same guard and is a coarser edge, so it is NOT accepted.
 *   - the probe names THE SAME OUTPUT as the reference it guards. A probe on some other output
 *     proves nothing about this one, so the output name is compared, not just the address.
 *   - the reference is in the arm the probe proves SAFE. Asserting only that the probe appears
 *     somewhere earlier on the line accepted `try(module.m[0].a, null) != null ? "" : module.m[0].a`
 *     — whose false arm is taken exactly when the tuple is empty, i.e. the #3351 abort on a line
 *     reported green.
 *   - the traversal is repeated OUTSIDE the `try()`, which is what keeps a misspelled output a
 *     validation error rather than a silent null.
 *
 * Line-scoped on purpose: this guard never evaluates HCL, and a probe wrapped onto the previous
 * line would be invisible to it. Over-reporting costs one long line and nothing else.
 */
function isModuleProbeGuarded(line, address, column) {
	const out = referencedOutput(line, address, column);
	if (out === null) return false;
	const probe = `try(${address}[0].${out}, null) != null`;
	const at = line.lastIndexOf(probe, column);
	if (at < 0) return false;
	const arm = ternaryArm(line, at + probe.length);
	return arm !== null && column > arm.question && column < arm.colon;
}

/** Every `module.x[*]` splat on a line — the whole-module edge that closes cycles (#3509). */
const MODULE_SPLAT = /(?<![\w.])(module\.[a-z0-9_]+)\[\*\]/gi;

/**
 * True for `depends_on`, or a `moved`/`removed`/`import` block's `to`/`from` — not values.
 *
 * The backward walk stops at the first CLOSED list (`]`), not at the enclosing `}`. Without that
 * it read a `depends_on = [...]` nine lines above an ordinary argument as still open and skipped
 * the argument — which is how the first draft of this guard passed over `aks.tf`, one of the two
 * lines named in #3351. A fixture cannot catch that; re-running the guard over the real tree with
 * the fix reverted is what did.
 */
function isNonEvaluatedContext(lines, index) {
	for (let i = index; i >= 0 && i > index - 12; i--) {
		const line = lines[i];
		// A depends_on that OPENS and CLOSES on one line is already behind us — treating it as
		// still open silenced every argument for eleven lines after it, which is how the first
		// draft passed over `aks.tf`, one of the two lines #3351 names.
		if (/^\s*depends_on\s*=\s*\[/.test(line)) {
			// On the reference's OWN line it is inside the list. On an earlier line it only still
			// covers us if the list did not close there.
			return i === index || !line.includes("]");
		}
		if (
			/^\s*(to|from)\s*=/.test(line) &&
			lines
				.slice(Math.max(0, i - 8), i + 1)
				.some((l) => /^(moved|removed|import)\s*\{/.test(l))
		) {
			return true;
		}
		if (i !== index && /^\s*[\]}]/.test(line)) return false;
	}
	return false;
}

/** An address indexed with a literal `[0]`. */
const REFERENCE =
	/(?<![\w.])((?:module\.[a-z0-9_]+)|(?:data\.[a-z][a-z0-9_]*\.[a-z0-9_]+)|(?:[a-z][a-z0-9_]*\.[a-z0-9_]+))\[0\]/gi;

/**
 * Scan a template root for indexes into counted blocks.
 *
 * @returns {{findings: string[], modules: string[], splats: string[], multiCount: string[], files: number, dirs: number, counted: number}}
 */
function scanRoot(root) {
	const findings = [];
	const modules = [];
	const splats = [];
	const multiCount = [];
	let files = 0;
	let dirs = 0;
	let counted = 0;

	for (const dir of moduleDirs(root)) {
		dirs++;
		const tfFiles = fs.readdirSync(dir).filter((f) => f.endsWith(".tf"));
		/** address → its `count` expression, for every counted block in this directory. */
		const countedBlocks = new Map();

		for (const file of tfFiles) {
			const raw = fs.readFileSync(path.join(dir, file), "utf8");
			const src = stripComments(raw);
			const code = stripNonCode(raw);
			const blocks =
				/^(resource|data|module)\s+"([^"]+)"(?:\s+"([^"]+)")?\s*\{/gm;
			let block;
			while ((block = blocks.exec(src))) {
				const [, kind, first, second] = block;
				const address =
					kind === "module"
						? `module.${first}`
						: kind === "data"
							? `data.${first}.${second}`
							: `${first}.${second}`;
				const opening = block.index + block[0].lastIndexOf("{");
				const closing = closingBrace(code, opening);
				if (closing < 0) continue;
				const count = countExpression(code.slice(opening + 1, closing));
				if (count !== null) {
					countedBlocks.set(address, count);
					counted++;
				}
			}
		}

		for (const file of tfFiles) {
			files++;
			const lines = stripNonCode(
				fs.readFileSync(path.join(dir, file), "utf8"),
			).split("\n");
			lines.forEach((line, i) => {
				REFERENCE.lastIndex = 0;
				let ref;
				while ((ref = REFERENCE.exec(line))) {
					const address = ref[1];
					if (!countedBlocks.has(address)) continue;
					const count = countedBlocks.get(address);
					const where = `${path.join(dir, file)}:${i + 1}`;
					if (isNonEvaluatedContext(lines, i)) continue;
					if (address.startsWith("module.")) {
						// NO `isInsideTry` HERE, unlike the resource branch below. A bare
						// `try(module.x[0].out, "")` IS refresh-safe and IS typo-unsafe, and the
						// header rules it out for the second reason — excusing it left five live
						// sites unreported under a success line claiming the class was covered.
						// Only the probe's own occurrence may be skipped.
						if (isProbeItself(line, address, ref.index)) continue;
						if (isModuleProbeGuarded(line, address, ref.index)) continue;
						// NO `ZERO_OR_ONE` HERE either. The resource waiver exists because `one()`
						// is WRONG on a multi-instance resource — it errors on the second one. The
						// probe has no such limit: `try(module.many[0].id, null) != null ?
						// module.many[0].id : f` returns instance 0 exactly as the bare index did.
						// So the one class the probe could cover was the class being waived, on a
						// green run, under a message that says "resource".
						modules.push(`${where}: ${address}[0] — count = ${count}`);
						continue;
					}
					if (isInsideTry(line, ref.index)) continue;
					if (isLengthGuarded(line, address)) continue;
					if (!ZERO_OR_ONE.test(count)) {
						multiCount.push(`${where}: ${address} (count = ${count})`);
						continue;
					}
					findings.push(`${where}: ${address}[0] — count = ${count}`);
				}

				// A splat into a 0-or-1 module is never acceptable, `try()`-wrapped or not: the
				// hazard is the WHOLE-MODULE graph edge, not an evaluation error, so try() cannot
				// excuse it.
				//
				// A splat into a module counted by anything else is the ONLY correct expression —
				// `[*]` is how you read every instance, and the probe's `[0]` would silently drop
				// 1..n. Flagging those would make this gate block the right answer and prescribe a
				// wrong one, so the count is consulted here exactly as it is for a resource index.
				MODULE_SPLAT.lastIndex = 0;
				let splat;
				while ((splat = MODULE_SPLAT.exec(line))) {
					const address = splat[1];
					if (!countedBlocks.has(address)) continue;
					if (!ZERO_OR_ONE.test(countedBlocks.get(address))) continue;
					if (isNonEvaluatedContext(lines, i)) continue;
					splats.push(`${path.join(dir, file)}:${i + 1}: ${address}[*]`);
				}
			});
		}
	}

	return { findings, modules, splats, multiCount, files, dirs, counted };
}

// ── self-test ─────────────────────────────────────────────────────────────────────────────────
// Fixtures are strings here, written to a temp dir — hermetic, and independent of whatever the
// real templates happen to contain today. A guard whose only evidence is "it passes on the tree"
// cannot tell "found nothing" from "asks nothing".

const FIXTURE = `
resource "azurerm_user_assigned_identity" "aks" {
  count = local.encrypt ? 1 : 0
}

resource "azurerm_user_assigned_identity" "dns" {
  count = var.provision_aks ? 1 : 0
}

resource "alicloud_vswitch" "many" {
  count = var.vswitch_count
}

module "cluster" {
  source = "./mod"
  count  = var.provision ? 1 : 0
}

module "pool" {
  source = "./mod"
  count  = var.pool_count
}

data "example_item" "url" {
  count = var.provision ? 1 : 0
}

resource "example_item" "multi" {
  count = (
    var.provision ? 1 : 0
  )
}

resource "example_item" "uncounted" {
  note = "the previous block's count must not leak here"
}

resource "consumer" "c" {
  identity   = local.encrypt ? azurerm_user_assigned_identity.aks[0].id : ""
  tried      = try(azurerm_user_assigned_identity.dns[0].id, "")
  nested     = try(length(trimspace(azurerm_user_assigned_identity.dns[0].id)) > 0, false)
  guarded    = length(azurerm_user_assigned_identity.dns) > 0 ? azurerm_user_assigned_identity.dns[0].id : ""
  vswitch    = alicloud_vswitch.many[0].id
  from_mod   = var.provision ? module.cluster[0].id : ""
  mod_probed = try(module.cluster[0].id, null) != null ? module.cluster[0].id : ""
  mod_wrapped = try(module.cluster[0].ca, null) != null ? base64decode(module.cluster[0].ca) : ""
  mod_len    = length(module.cluster) > 0 ? module.cluster[0].id : ""
  mod_splat  = one(module.cluster[*].id)
  mod_othout = try(module.cluster[0].id, null) != null ? module.cluster[0].endpoint : ""
  mod_whole  = try(module.cluster[0], null) != null ? module.cluster[0].id : ""
  mod_object = module.cluster[0]
  mod_baretry = try(module.cluster[0].id, "")
  mod_falsearm = try(module.cluster[0].id, null) != null ? "" : module.cluster[0].id
  mod_many   = module.pool[0].id
  mod_manysplat = one(module.pool[*].id)
  mod_nocolon = try(module.cluster[0].id, null) != null ? module.cluster[0].id
  fallback_on_the_next_line = ""
  url         = "https://\${data.example_item.url[0].id}"
  comparison  = "compare A << B"
  after_text  = var.provision ? example_item.multi[0].id : ""
  uncounted   = example_item.uncounted[0].id
  described  = "azurerm_user_assigned_identity.aks[0].id is what used to break"
  # a comment naming azurerm_user_assigned_identity.aks[0].id is prose, not code
  depends_on = [azurerm_user_assigned_identity.aks[0]]
}

resource "heredoc_consumer" "c" {
  document = <<-DOC
    example_item.multi[0].id is prose inside a heredoc
  DOC
}

moved {
  from = azurerm_user_assigned_identity.aks[0]
  to   = azurerm_user_assigned_identity.dns[0]
}
`;

function selfTest() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "refresh-safe-selftest-"));
	fs.writeFileSync(path.join(dir, "main.tf"), FIXTURE);
	const result = scanRoot(dir);

	let failures = 0;
	const check = (label, ok, detail = "") => {
		if (ok) console.log(`  ✓ ${label}`);
		else {
			failures++;
			console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
		}
	};

	check(
		"flags all three unprotected conditional indexes and no prose/uncounted reference",
		result.findings.length === 3 &&
			result.findings.some((f) =>
				f.includes("azurerm_user_assigned_identity.aks[0]"),
			) &&
			result.findings.some((f) => f.includes("data.example_item.url[0]")) &&
			result.findings.some((f) => f.includes("example_item.multi[0]")),
		`findings: ${JSON.stringify(result.findings)}`,
	);
	check(
		"preserves interpolation code after https:// inside a quoted string",
		result.findings.some((f) => f.includes("data.example_item.url[0]")),
		`findings: ${JSON.stringify(result.findings)}`,
	);
	check(
		"a << token inside a string does not hide the remainder of the file",
		result.findings.some((f) => f.includes("example_item.multi[0]")),
		`findings: ${JSON.stringify(result.findings)}`,
	);
	// The module fixtures differ from one another on ONE axis each: probed vs bare, probed through a
	// wrapping call vs not, `length()` vs the probe, and — the axis a self-test that only ever varied
	// the ADDRESS would never reach — the probe naming the SAME OUTPUT as the reference it guards
	// versus a different one. Line numbers are derived from the fixture's own text, never written
	// as literals: a literal that drifts past the end of the fixture asserts nothing and passes.
	const fixtureLine = (needle) => {
		const n = FIXTURE.split("\n").findIndex((l) => l.includes(needle));
		if (n < 0) throw new Error(`fixture has no line containing ${needle}`);
		return n + 1;
	};
	const reported = (needle) =>
		result.modules.some((m) => m.includes(`:${fixtureLine(needle)}: `));

	check(
		"a bare, a length()-guarded and a wrong-output-probed module index are all findings",
		result.modules.length === 10 &&
			reported("from_mod") &&
			reported("mod_len") &&
			reported("mod_othout"),
		`modules: ${JSON.stringify(result.modules)}`,
	);
	check(
		"a single-output probe clears the reference it guards, wrapped or not",
		!reported("mod_probed") && !reported("mod_wrapped"),
		`modules: ${JSON.stringify(result.modules)}`,
	);
	// `try(module.x[0], null) != null` reads as the same guard and is a COARSER edge — it depends on
	// every output of the instance. It must not be accepted, and the reference it cannot parse
	// (`module.cluster[0]`, no output) must fail closed rather than be waved through.
	check(
		"the whole-instance probe is not accepted, and an unparseable reference fails closed",
		reported("mod_whole") && reported("mod_object"),
		`modules: ${JSON.stringify(result.modules)}`,
	);
	// The module branch does NOT inherit the resource branch's `try()` waiver. A bare try() is
	// refresh-safe and typo-UNSAFE, and the header rules it out for the second reason; excusing it
	// left five live sites unreported under a success line claiming the class was covered.
	check(
		"a bare try() around a module output is a finding, unlike the resource branch",
		reported("mod_baretry"),
		`modules: ${JSON.stringify(result.modules)}`,
	);
	// The arm matters. Asserting only that the probe appears earlier on the line accepted a
	// reference in the arm taken exactly when the tuple is EMPTY — the #3351 abort, reported green.
	check(
		"a reference in the probe's FALSE arm is a finding",
		reported("mod_falsearm"),
		`modules: ${JSON.stringify(result.modules)}`,
	);
	// A conditional whose `:` wrapped to the next line has no arm this guard can see. It is a
	// finding, not an open arm running to end-of-line — treating it as open is how "somewhere after
	// the `?`" would creep back in, and the header already tells authors to keep the probe on one
	// line, so over-reporting here costs a reflow.
	check(
		"a probe whose colon wrapped to the next line is a finding, not an open arm",
		reported("mod_nocolon"),
		`modules: ${JSON.stringify(result.modules)}`,
	);
	// A multi-instance module: `[0]` still needs the probe (which returns instance 0 exactly as the
	// bare index did), but `[*]` is the only correct expression and must NOT be blocked.
	check(
		"a non-0/1 counted module: [0] is a finding, [*] is left alone",
		reported("mod_many") &&
			result.splats.length === 1 &&
			!result.splats.some((m) => m.includes("module.pool")) &&
			!result.multiCount.some((m) => m.includes("module.")),
		`modules: ${JSON.stringify(result.modules)}; splats: ${JSON.stringify(result.splats)}; multiCount: ${JSON.stringify(result.multiCount)}`,
	);
	check(
		"a counted module splat is its own finding",
		result.splats.length === 1 && result.splats[0].includes("module.cluster[*]"),
		`splats: ${JSON.stringify(result.splats)}`,
	);
	check(
		"length() still clears a RESOURCE — the module exclusion is not a blanket one",
		!result.findings.some((f) =>
			f.includes("azurerm_user_assigned_identity.dns[0]"),
		),
		`findings: ${JSON.stringify(result.findings)}`,
	);
	check(
		"reports a non-boolean count as not covered",
		result.multiCount.length === 1 &&
			result.multiCount[0].includes("alicloud_vswitch.many"),
		`multiCount: ${JSON.stringify(result.multiCount)}`,
	);
	check(
		"counts what it examined",
		result.files === 1 && result.counted === 7,
		`${result.files} file(s), ${result.counted} counted block(s)`,
	);

	fs.mkdirSync(path.join(dir, ".terraform", "vendor"), { recursive: true });
	fs.writeFileSync(path.join(dir, ".terraform", "vendor", "main.tf"), FIXTURE);
	const withoutVendor = scanRoot(dir);
	check(
		"does not recurse into .terraform vendor trees",
		withoutVendor.files === 1,
		`${withoutVendor.files} file(s) examined`,
	);

	// The anti-probe. Every assertion above is about what the detector REJECTS; without this one
	// they would all still hold for a detector that flags the first line of every file.
	const fixed = FIXTURE.replace(
		'local.encrypt ? azurerm_user_assigned_identity.aks[0].id : ""',
		'local.encrypt ? one(azurerm_user_assigned_identity.aks[*].id) : ""',
	)
		.replace("data.example_item.url[0].id", "one(data.example_item.url[*].id)")
		.replace("example_item.multi[0].id", "one(example_item.multi[*].id)")
		.replace(
			'var.provision ? module.cluster[0].id : ""',
			'try(module.cluster[0].id, null) != null ? module.cluster[0].id : ""',
		)
		.replace(
			'length(module.cluster) > 0 ? module.cluster[0].id : ""',
			'try(module.cluster[0].id, null) != null ? module.cluster[0].id : ""',
		)
		.replace(
			"one(module.cluster[*].id)",
			'try(module.cluster[0].id, null) != null ? module.cluster[0].id : ""',
		)
		.replace(
			'try(module.cluster[0].id, null) != null ? module.cluster[0].endpoint : ""',
			'try(module.cluster[0].endpoint, null) != null ? module.cluster[0].endpoint : ""',
		)
		.replace(
			'try(module.cluster[0], null) != null ? module.cluster[0].id : ""',
			'try(module.cluster[0].id, null) != null ? module.cluster[0].id : ""',
		)
		.replace(
			"mod_object = module.cluster[0]",
			'mod_object = try(module.cluster[0].id, null) != null ? module.cluster[0].id : ""',
		)
		.replace(
			'mod_baretry = try(module.cluster[0].id, "")',
			'mod_baretry = try(module.cluster[0].id, null) != null ? module.cluster[0].id : ""',
		)
		.replace(
			'mod_falsearm = try(module.cluster[0].id, null) != null ? "" : module.cluster[0].id',
			'mod_falsearm = try(module.cluster[0].id, null) != null ? module.cluster[0].id : ""',
		)
		.replace(
			"mod_many   = module.pool[0].id",
			'mod_many   = try(module.pool[0].id, null) != null ? module.pool[0].id : ""',
		)
		.replace(
			"mod_nocolon = try(module.cluster[0].id, null) != null ? module.cluster[0].id\n  fallback_on_the_next_line = \"\"",
			'mod_nocolon = try(module.cluster[0].id, null) != null ? module.cluster[0].id : ""',
		);
	fs.writeFileSync(path.join(dir, "main.tf"), fixed);
	const after = scanRoot(dir);
	check(
		"the same fixture reports nothing once every index is written in its own safe shape",
		after.findings.length === 0 &&
			after.modules.length === 0 &&
			after.splats.length === 0,
		`findings: ${JSON.stringify(after.findings)}, modules: ${JSON.stringify(after.modules)}, splats: ${JSON.stringify(after.splats)}`,
	);

	// THE REPORT IS THE PRODUCT. Everything above calls scanRoot() directly; this runs the guard the
	// way CI does and asserts the author is shown WHERE to look. A failure branch that exits 1 with
	// an empty list is, to CI, indistinguishable from one that names every site — and the list is
	// the whole reason the exit code is actionable.
	fs.writeFileSync(path.join(dir, "main.tf"), FIXTURE);
	const cli = spawnSync(process.execPath, [process.argv[1], dir], {
		encoding: "utf8",
	});
	const shown = cli.stdout + cli.stderr;
	check(
		"the failing run exits 1 and PRINTS every site it found",
		cli.status === 1 &&
			shown.includes(`main.tf:${fixtureLine("from_mod")}:`) &&
			shown.includes(`main.tf:${fixtureLine("mod_splat")}:`) &&
			shown.includes(`main.tf:${fixtureLine("identity   =")}:`) &&
			shown.includes("try(module.x[0].out, null) != null"),
		`status ${cli.status}; output: ${JSON.stringify(shown.slice(0, 400))}`,
	);

	fs.rmSync(dir, { recursive: true, force: true });
	if (failures > 0) {
		console.error(
			`\ncheck-templates-refresh-safe self-test: ${failures} failure(s)`,
		);
		process.exit(1);
	}
	console.log("\nself-test: all passed");
}

// ── main ──────────────────────────────────────────────────────────────────────────────────────

if (process.argv.includes("--self-test")) {
	selfTest();
} else {
	const root = process.argv[2] ?? "infra/templates/project";
	const { findings, modules, splats, multiCount, files, dirs, counted } =
		scanRoot(root);
	const examined = `examined ${files} .tf file(s) in ${dirs} module dir(s); ${counted} counted block(s)`;

	// Modules are reported FIRST and separately. They abort a refresh-only plan for the same reason
	// resources do, but they take a different rewrite, and printing them under the resource message
	// would tell the reader to write `one()` — the shape that closes a cycle (#3509).
	if (modules.length > 0 || splats.length > 0) {
		console.error(
			`❌ refresh-safety violation — ${modules.length + splats.length} unprotected reference(s) into a counted MODULE:`,
		);
		console.error("");
		for (const m of modules) console.error(`  ${m}`);
		for (const m of splats) console.error(`  ${m}  (module splat)`);
		console.error("");
		console.error(
			"A counted module with no instance in state is an EMPTY TUPLE under `-refresh-only`,",
		);
		console.error(
			"and `[0]` aborts the whole plan (#3351). Write the single-output existence probe:",
		);
		console.error("");
		console.error(
			"  try(module.x[0].out, null) != null ? module.x[0].out : <typed fallback>",
		);
		console.error("");
		console.error(
			"NOT `one(module.x[*].out)` and NOT `length(module.x) > 0 ? …`: both read the module as",
		);
		console.error(
			"a WHOLE, and that edge closes a dependency cycle `tofu validate` refuses — see the",
		);
		console.error(
			"comment on `rds_security_groups` in infra/templates/project/aws/rds.tf, which measured",
		);
		console.error(
			"it. NOT a bare `try(module.x[0].out, null)` either: it swallows a renamed output too,",
		);
		console.error(
			"so repeat the traversal outside the `try()`. Keep the probe on ONE line — this guard",
		);
		console.error("reads a line at a time. Reasoning in this file's header.");
		console.error("");
	}

	if (findings.length > 0) {
		console.error(
			`❌ refresh-safety violation — ${findings.length} unprotected index(es) into a counted resource or data source:`,
		);
		console.error("");
		for (const f of findings) console.error(`  ${f}`);
		console.error("");
		console.error(
			"`tofu plan -refresh-only` never plans a create, so a counted resource with no",
		);
		console.error(
			"instance in state is an EMPTY TUPLE and `[0]` aborts the whole plan — drift",
		);
		console.error(
			"detection dies for every environment whose template has advanced past its",
		);
		console.error(
			"last apply (#3351). Write `one(<address>[*].<attr>)`: identical where the",
		);
		console.error(
			"instance exists, null instead of a fatal error where it does not.",
		);
		console.error("");
	}

	// ONE exit, after BOTH blocks. Exiting inside the module block sent an author who has both away
	// with only half the worklist, to rediscover the rest on the next run.
	if (modules.length > 0 || splats.length > 0 || findings.length > 0) {
		console.error(examined);
		process.exit(1);
	}

	console.log(
		`✓ no unprotected index into a counted resource, data source or MODULE — ${examined}.`,
	);
	console.log(
		"  NOT COVERED, deliberately — the header records the measurement behind each:",
	);
	console.log(
		`    ${multiCount.length} reference(s) into a resource counted by something other than a 0-or-1 conditional, where [0] is a real index:`,
	);
	for (const m of multiCount) console.log(`      ${m}`);
}
