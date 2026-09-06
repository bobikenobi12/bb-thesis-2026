// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// Generates a lexical search index over the docs (apps/docs/content/docs) so elench (the AI) can GROUND
// its answers about connectors / architecture / how-to in the real documentation instead of improvising.
// Chunks each MDX page by heading and writes a committed JSON the search_docs tool imports. Run via
// `pnpm -C apps/console run gen:docs-index` (wired into build/dev). Lexical now; an embedding index can swap in later.

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DOCS_ROOT = join(HERE, "../../..", "apps/docs/content/docs");
const OUT = join(HERE, "..", "lib/ai/docs-index.generated.json");

/** Recursively collect .mdx files. */
function walk(dir) {
	const out = [];
	for (const entry of readdirSync(dir)) {
		const p = join(dir, entry);
		if (statSync(p).isDirectory()) out.push(...walk(p));
		else if (entry.endsWith(".mdx")) out.push(p);
	}
	return out;
}

/** file path → doc route (e.g. console/connectors/aws.mdx → /console/connectors/aws; index.mdx → dir). */
function toRoute(file) {
	let r = relative(DOCS_ROOT, file).replace(/\\/g, "/").replace(/\.mdx$/, "");
	r = r.replace(/\/index$/, "").replace(/^index$/, "");
	return "/" + r;
}

/** Parse `---\n...\n---` frontmatter; return { title, description, body }. */
function parseFrontmatter(raw) {
	const m = raw.match(/^---\n([\s\S]*?)\n---\n?/);
	let title = "";
	let description = "";
	let body = raw;
	if (m) {
		body = raw.slice(m[0].length);
		for (const line of m[1].split("\n")) {
			const t = line.match(/^title:\s*(.+)$/);
			const d = line.match(/^description:\s*(.+)$/);
			if (t) title = t[1].replace(/^["']|["']$/g, "").trim();
			if (d) description = d[1].replace(/^["']|["']$/g, "").trim();
		}
	}
	return { title, description, body };
}

/** Light MDX → text: drop import/export lines and JSX tags, keep prose + code text. */
function stripMdx(s) {
	return s
		.split("\n")
		.filter((l) => !/^\s*(import|export)\s/.test(l))
		.join("\n")
		.replace(/<\/?[A-Za-z][^>]*>/g, " ") // JSX tags
		.replace(/```[a-zA-Z]*\n/g, "") // code fence openers (keep the code text)
		.replace(/```/g, "")
		.replace(/\|/g, " ") // table pipes
		.replace(/[ \t]+/g, " ");
}

/** GitHub-style heading slug for the #anchor. */
function slugify(h) {
	return h
		.toLowerCase()
		.replace(/[^\w\s-]/g, "")
		.trim()
		.replace(/\s+/g, "-");
}

/** Split a page body into { heading, anchor, text } chunks by ##/### headings. */
function chunkByHeading(body) {
	const lines = body.split("\n");
	const chunks = [];
	let cur = { heading: "", anchor: "", lines: [] };
	const push = () => {
		const text = stripMdx(cur.lines.join("\n")).trim();
		if (text) chunks.push({ heading: cur.heading, anchor: cur.anchor, text });
	};
	for (const line of lines) {
		const h = line.match(/^(#{1,3})\s+(.+?)\s*$/);
		if (h) {
			push();
			const heading = h[2].replace(/`/g, "");
			cur = { heading, anchor: slugify(heading), lines: [] };
		} else {
			cur.lines.push(line);
		}
	}
	push();
	return chunks;
}

const files = walk(DOCS_ROOT).sort();
const records = [];
for (const file of files) {
	const route = toRoute(file);
	const { title, description, body } = parseFrontmatter(readFileSync(file, "utf8"));
	const pageTitle = title || route;
	const chunks = chunkByHeading(body);
	// Page-level record (title + description) so a page matches even without a heading hit.
	records.push({
		id: `${route}#`,
		route,
		url: route,
		title: pageTitle,
		heading: "",
		text: `${pageTitle}. ${description}`.trim(),
	});
	for (const c of chunks) {
		records.push({
			id: `${route}#${c.anchor}`,
			route,
			url: c.anchor ? `${route}#${c.anchor}` : route,
			title: pageTitle,
			heading: c.heading,
			// Cap each chunk so the index stays lean and a single result is prompt-sized.
			text: c.text.slice(0, 1200),
		});
	}
}

writeFileSync(OUT, JSON.stringify({ generatedFrom: "apps/docs/content/docs", records }, null, 0) + "\n");
console.log(`docs-index: ${records.length} chunks from ${files.length} pages → ${relative(join(HERE, ".."), OUT)}`);
