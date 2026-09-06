// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// revalidatePath guard. `revalidatePath` fails SILENTLY: hand it a path that matches no route
// and it returns void, revalidates nothing, and looks exactly like a working call. The C2 routing
// move (/dashboard/* -> /{org}/~/*) left 24 such calls behind, so mutating a runner, an alert, an
// SSO connection or a classification dimension left the user staring at a stale list. Nothing
// caught it because there is nothing to catch: no type error, no runtime error, no log line.
//
// Two rules, both mechanical:
//   1. Every revalidatePath target must resolve to a real route under app/.
//   2. A target containing a dynamic segment ("[") must pass the second argument, "page".
//      Next.js needs the route PATTERN plus its type; the pattern alone matches nothing.
//
// Targets given as a bare string literal are checked directly; a target passed as an identifier
// is resolved against a `const NAME = "…"` declared in the same file (the ALERTS_PATH /
// SSO_PATH / CLASSIFICATION_PATH shape). An identifier that cannot be resolved that way is
// reported as unverifiable rather than assumed fine — a guard that quietly skips what it cannot
// parse is how the original 24 survived.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const APP_DIR = "app";
const SCAN_DIRS = ["app", "lib"];

function walk(dir, out, pred) {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) walk(full, out, pred);
		else if (pred(full)) out.push(full);
	}
}

/** A missing directory means the guard is pointed at the wrong tree — say so, don't stack-trace. */
function walkOrDie(dir, out, pred) {
	try {
		walk(dir, out, pred);
	} catch (err) {
		console.error(`check-revalidate-paths: cannot walk ${dir}/ from ${process.cwd()} — ${err.message}`);
		console.error("Run this from apps/console (pnpm -C apps/console run check:revalidate-paths).");
		process.exit(1);
	}
}

/** Every route the app actually serves, as a Next.js route pattern. */
function collectRoutes() {
	const pages = [];
	walkOrDie(APP_DIR, pages, (f) => /[\\/]page\.tsx?$/.test(f));
	return new Set(
		pages.map((f) => {
			const segs = relative(APP_DIR, f)
				.split(sep)
				.slice(0, -1) // drop page.tsx
				.filter((s) => !/^\(.*\)$/.test(s)); // route groups are not in the URL
			return `/${segs.join("/")}`;
		}),
	);
}

const routes = collectRoutes();
if (routes.size === 0) {
	console.error(`check-revalidate-paths: found no page.tsx under ${APP_DIR}/.`);
	console.error("The guard cannot see the routes it exists to check. Fix the path.");
	process.exit(1);
}

const files = [];
for (const d of SCAN_DIRS) walkOrDie(d, files, (f) => /\.tsx?$/.test(f));

// revalidatePath(<literal-or-identifier>[, "<type>"])
const CALL = /revalidatePath\(\s*(?:"([^"]+)"|([A-Za-z_$][\w$]*))\s*(?:,\s*"([^"]+)")?\s*\)/g;
const CONST = (name) => new RegExp(`\\b${name}\\s*=\\s*"([^"]+)"`);

const problems = [];
let calls = 0;

for (const file of files) {
	const src = readFileSync(file, "utf8");
	if (!src.includes("revalidatePath(")) continue;
	for (const m of src.matchAll(CALL)) {
		calls++;
		const [, literal, ident, type] = m;
		const line = src.slice(0, m.index).split("\n").length;
		const where = `${relative(".", file)}:${line}`;

		let target = literal;
		if (!target) {
			const c = src.match(CONST(ident));
			if (!c) {
				problems.push(`${where}: revalidatePath(${ident}) — cannot resolve ${ident} to a string in this file`);
				continue;
			}
			target = c[1];
		}

		if (!routes.has(target)) {
			problems.push(`${where}: "${target}" matches no route under ${APP_DIR}/ — this call is a silent no-op`);
			continue;
		}
		if (target.includes("[") && type !== "page") {
			problems.push(
				`${where}: "${target}" is a dynamic route, so it needs the second argument "page"` +
					(type ? ` (got "${type}")` : " (missing)"),
			);
		}
	}
}

// Finding no calls at all means the scan dirs moved, not that the tree is clean.
if (calls === 0) {
	console.error(`check-revalidate-paths: no revalidatePath() calls found under ${SCAN_DIRS.join(", ")}/.`);
	console.error("That is not a clean tree — it means this guard is looking at the wrong thing.");
	process.exit(1);
}

if (problems.length > 0) {
	console.error("revalidatePath targets that will not revalidate anything:");
	for (const p of problems) console.error(`  ${p}`);
	console.error("");
	console.error('Use the route PATTERN as it appears under app/ (route groups like "(private)"');
	console.error('are not part of the URL), and pass "page" for any path with a dynamic segment.');
	process.exit(1);
}

console.log(`OK — ${calls} revalidatePath call(s) checked against ${routes.size} route(s); all resolve.`);
