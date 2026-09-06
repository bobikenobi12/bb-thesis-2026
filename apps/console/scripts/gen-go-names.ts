// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Generates the Go half of the ONE slugifier and the ONE name grammar (#3665):
 *
 *   packages/core/names/names_gen.go        — the grammar DATA (regex source, limits, reserved
 *                                             names), emitted from lib/validations/names.ts.
 *   packages/core/names/testdata/name-cases.json
 *                                           — the ALGORITHM contract, produced by running the
 *                                             REAL lib/utils/slugify.ts over curated inputs.
 *
 * That split is the epic's rule: data is codegen'd, an algorithm gets a generated conformance
 * table both sides are tested against. Direction follows authority — a slug is a console URL
 * segment before it is a Kubernetes name, so TypeScript generates and Go is held to it. Go cannot
 * write either file, so a Go-only change has no way to make itself right.
 *
 * It ALSO runs a census (`assertNoSecondSlugifier`) over the repo, because the failure this lane
 * fixes was not a wrong slugifier — it was FIVE of them, each locally reasonable. A generated
 * mirror stops Go from drifting; only the census stops a sixth from being written next to it.
 *
 * Usage:
 *   pnpm -C apps/console run gen:go-names:check   # non-zero if the committed files are stale
 *   pnpm -C apps/console run gen:go-names         # regenerate
 *
 * ⚠️  REGENERATING name-cases.json REWRITES AN EXPECTATION. It is exactly what somebody runs when
 * the Go table test is red, and doing so makes the Go test pass against a TypeScript change
 * nobody reviewed. The case ids are SEMANTIC so a diff names the boundary that moved, and this
 * script prints the changed cases rather than only the file name.
 */

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

import {
	ADDON_APP_NAME_PREFIX,
	ADDON_ID_MAX_LENGTH,
	DNS1123_LABEL_PATTERN_SOURCE,
	DNS1123_LABEL_MAX_LENGTH,
	ENVIRONMENT_NAME_INPUT_MAX_LENGTH,
	ENVIRONMENT_NAME_MAX_LENGTH,
	RESERVED_ENVIRONMENT_NAMES,
	environmentNameProblem,
	namespaceProblem,
	normalizeEnvironmentName,
} from "@/lib/validations/names";
import { SLUG_MAX_LENGTH, slugifyOrEmpty } from "@/lib/utils/slugify";

const HERE = dirname(fileURLToPath(import.meta.url));
/** apps/console/scripts -> the repo root is three levels up. */
const ROOT = resolve(HERE, "../../..");
const GO_OUT = resolve(ROOT, "packages/core/names/names_gen.go");
const CASES_OUT = resolve(ROOT, "packages/core/names/testdata/name-cases.json");

/** The table's schema version. Bump only for a shape change, never for a value change. */
const VERSION = 1;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The cases. Ids are semantic on purpose: a diff on this table must name the boundary that
// moved, not an array index.
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface SlugCase {
	id: string;
	in: string;
	max?: number;
}

/** Slug inputs. Every one of these is a rule somebody could plausibly re-derive differently —
 *  which is how five implementations happened. */
const SLUG_CASES: SlugCase[] = [
	{ id: "plain", in: "Acme Cloud" },
	{ id: "surrounding-whitespace", in: "  Acme Cloud  " },
	{ id: "runs-collapse", in: "Foo___Bar!!Baz" },
	{ id: "leading-and-trailing-dashes", in: "--Hello  World--" },
	{ id: "already-a-slug", in: "acme-cloud" },
	{ id: "digits-lead", in: "1dev" },
	{ id: "apostrophe-vanishes", in: "bobikenobi12's Org" },
	{ id: "apostrophe-typographic", in: "Bob’s Team" },
	{ id: "apostrophe-modifier-letter", in: "Bobʼs Team" },
	{ id: "apostrophe-backtick", in: "Bob`s Team" },
	// The divergence that named this issue: TypeScript folded the accent, Go dropped the rune.
	{ id: "accent-folds-cafe", in: "café" },
	{ id: "accent-folds-jose-api", in: "José's API" },
	{ id: "accent-folds-umlaut", in: "Zürich" },
	{ id: "accent-folds-diaeresis", in: "naïve coördination" },
	// NFKD is COMPATIBILITY decomposition, so a ligature and a font-variant digit fold too.
	{ id: "nfkd-ligature", in: "o\uFB01ce" },
	{ id: "nfkd-fullwidth", in: "\uFF21\uFF22\uFF23" },
	{ id: "nfkd-kelvin-sign", in: "\u212Alvin" },
	// U+0130 decomposes to I + U+0307; the mark is in the stripped block, so the dot does not
	// survive into a dash. JavaScript's toLowerCase would re-introduce it if the order were wrong.
	{ id: "dotted-capital-i", in: "\u0130stanbul" },
	{ id: "non-latin-script-drops-out", in: "中文" },
	{ id: "emoji-becomes-a-separator", in: "team 🚀 rocket" },
	{ id: "astral-only", in: "🚀🚀" },
	{ id: "empty", in: "" },
	{ id: "punctuation-only", in: "@#$%" },
	{ id: "apostrophes-only", in: "''" },
	{ id: "dashes-only", in: "---" },
	// The cap, and the trailing dash the cut exposes.
	{ id: "cap-default-63", in: "a".repeat(80) },
	{ id: "cap-exposes-trailing-dash", in: "ab cd ef gh ij", max: 6 },
	{ id: "cap-mid-word", in: "my-very-long-project-name-here", max: 10 },
	{ id: "cap-not-reached", in: "repo", max: 25 },
	{ id: "cap-addon-id-budget", in: `${"chart-".repeat(12)}name`, max: ADDON_ID_MAX_LENGTH },
	{ id: "cap-environment-budget", in: "a very long environment name that keeps going and going", max: ENVIRONMENT_NAME_MAX_LENGTH },
];

/** Namespace inputs. `dev-` and `1dev` are the two the old grammars got backwards. */
const NAMESPACE_CASES: { id: string; in: string }[] = [
	{ id: "plain", in: "boutique-dev" },
	{ id: "single-char", in: "a" },
	{ id: "single-digit", in: "1" },
	{ id: "digit-leading-is-legal", in: "1dev" },
	{ id: "all-digits", in: "12345" },
	{ id: "internal-dashes", in: "a-b-c" },
	{ id: "trailing-dash-is-refused", in: "dev-" },
	{ id: "leading-dash-is-refused", in: "-dev" },
	{ id: "lone-dash-is-refused", in: "-" },
	{ id: "uppercase-is-refused", in: "Dev" },
	{ id: "underscore-is-refused", in: "dev_1" },
	{ id: "dot-is-refused", in: "dev.1" },
	{ id: "slash-is-refused", in: "dev/1" },
	{ id: "empty-is-refused", in: "" },
	{ id: "at-the-limit", in: "a".repeat(63) },
	{ id: "one-over-the-limit", in: "a".repeat(64) },
	{ id: "over-the-limit-non-ascii", in: "é".repeat(64) },
];

/** Environment-name inputs: the rules the two creation paths disagreed about. */
const ENVIRONMENT_NAME_CASES: { id: string; in: string }[] = [
	{ id: "already-canonical", in: "prod" },
	{ id: "mixed-case-normalizes", in: "Prod" },
	{ id: "spaces-normalize", in: "My Preview Env" },
	{ id: "trailing-dash-normalizes", in: "dev-" },
	{ id: "digit-leading", in: "1dev" },
	{ id: "accented", in: "Préprod" },
	{ id: "empty-is-refused", in: "" },
	{ id: "punctuation-only-is-refused", in: "!!!" },
	{ id: "reserved-settings-is-refused", in: "settings" },
	{ id: "reserved-jobs-is-refused", in: "Jobs" },
	{ id: "reserved-architecture-is-refused", in: "architecture" },
	{ id: "over-input-limit-is-refused", in: "a".repeat(ENVIRONMENT_NAME_INPUT_MAX_LENGTH + 1) },
	{ id: "long-but-readable-truncates", in: "staging environment for the european region" },
];

// `chartSlug` is NOT in this table. It is a TypeScript-only rule — Go has no caller that derives an
// add-on id — and it is a lookup-key canonicaliser rather than a pure derivation, so a Go mirror
// would be dead code holding an unused implementation to a contract. Its expectations live in
// apps/console/tests/validations/names.test.ts, hand-written, including the identity property that
// keeps `project_addons.addon_id` resolvable.

/** One row of the table: a semantic id plus whatever inputs and expectations its algorithm has. */
type Row = { id: string } & Record<string, unknown>;

/** The whole table: section name -> rows. */
type Table = Record<string, Row[]>;

/** Build the table. Inputs sit beside outputs so a reviewer can read a row without cross-
 *  referencing, and so the Go test needs no knowledge of this file's ordering. */
function build(): Table {
	return {
		slug: SLUG_CASES.map((c) => ({
			id: c.id,
			in: c.in,
			max: c.max ?? SLUG_MAX_LENGTH,
			want: slugifyOrEmpty(c.in, c.max ?? SLUG_MAX_LENGTH),
		})),
		namespace: NAMESPACE_CASES.map((c) => ({
			id: c.id,
			in: c.in,
			wantProblem: namespaceProblem(c.in) ?? "",
		})),
		environmentName: ENVIRONMENT_NAME_CASES.map((c) => ({
			id: c.id,
			in: c.in,
			wantNormalized: normalizeEnvironmentName(c.in),
			wantProblem: environmentNameProblem(c.in) ?? "",
		})),
	};
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The census. A generated mirror keeps Go honest; it does nothing about a SIXTH slugifier being
// written next to the five.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Where a slug-shaped expression is allowed to live, and why. Keyed on the repo-relative path.
 *  An entry that no longer matches anything FAILS — a stale exception is a reason nobody can
 *  check, and it is how a hand-written subject list stops covering silently. */
const CENSUS_EXCEPTIONS: Record<string, string> = {
	"apps/console/lib/utils/slugify.ts":
		"THE slugifier. This is the implementation the census exists to protect.",
	"apps/console/lib/validations/names.ts":
		"THE name grammar, generated into Go by this script.",
	"packages/core/names/names.go":
		"The Go mirror of lib/utils/slugify.ts, held to testdata/name-cases.json.",
	"packages/core/names/names_gen.go":
		"Generated by this script from lib/validations/names.ts.",
	"packages/core/manifests/generate.go":
		"dns1123/dns1123Max is a LOSSY normalizer for k8s object names with documented collision " +
		"semantics (NameCollisions, #2234), not a URL slugifier. Routing it through names.Slugify " +
		"would rename live Deployments and Services. Tracked separately from #3665.",
	"packages/core/imagebuild/kaniko.go":
		"The reference copy of manifests.dns1123Max (its comment says so), for the kaniko build " +
		"names. Same reason as manifests/generate.go.",
	"packages/core/cloud/tags.go":
		"A cloud TAG charset (gcpTagStyle), not a name slug — the grammar is the provider's.",
	"packages/core/argocd/preview_validate.go":
		"Preview namespace/subdomain validation. dns1123Subdomain is a SUBDOMAIN (dot-separated " +
		"labels), a grammar names.IsNamespace does not express; the label rule it shares now comes " +
		"from names.NamespacePattern.",
	"apps/console/lib/validations/preview.ts":
		"The TypeScript mirror of preview_validate.go, whose contract is that file's grammar.",
	"apps/console/components/design-project/canvas/inspector/config-schema.ts":
		"Canvas field sanitizers that strip characters from a k8s field as the user types; they " +
		"are not deriving a name from a display name.",
	"apps/console/scripts/check-offer-parity.mjs":
		"Tokenises an offer axis name for matching; produces no stored name.",
	"apps/runner/internal/agent/exec_stage.go":
		"sanitizeForPath makes a job id safe as a TEMP DIRECTORY component; it keeps uppercase and " +
		"'_', which no k8s name may contain. A different grammar for a different target.",
	"packages/core/sandbox/container.go":
		"containerName is a Docker container name (uppercase and '_' are legal there), keyed on the " +
		"job id for the reaper. Not a product name.",
	"packages/core/cloud/aws_provider.go":
		"ecrRepoBaseName is the ECR REPOSITORY grammar, which is AWS's, not Kubernetes'.",
	"packages/core/cloud/subscription_name.go":
		"A cloud subscription name with a hash suffix, folded to stay valid for SEVERAL provider " +
		"grammars at once. Deliberately not one of them.",
	"packages/core/argocd/harbor_test.go":
		"Asserts a generated PASSWORD contains an upper, a lower and a digit. Not a name at all — " +
		"the rune-range pattern cannot tell the two apart, which is the price of seeing the " +
		"switch-based slugifiers.",
	"apps/console/lib/cloud-providers/gcp-wif.ts":
		"GCP_PROJECT_ID_REGEX is GOOGLE's grammar for a project id (6-30 characters, leading " +
		"letter), not ours to unify — a name we accept and GCP refuses fails at their API, which " +
		"is the whole reason it is checked here.",
	"packages/core/argocd/manifest_addons.go":
		"crdNameRe is a DNS-1123 SUBDOMAIN (dot-separated labels), which is a different grammar from " +
		"a label — the file's own comment says reusing the label rule would refuse every real CRD.",
};

/** Regexes that mean 'somebody is deriving a name here'. Deliberately TEXTUAL and deliberately
 *  over-reporting: the cheapest question that is still sound. A parser would be more precise and
 *  would have to be taught every new spelling; a false positive costs one line in the table above,
 *  and every entry there carries its reason. */
const CENSUS_PATTERNS: { id: string; re: RegExp }[] = [
	{ id: "non-alphanumeric-run", re: /\[\^a-z0-9/ },
	{ id: "dns1123-label-grammar", re: /\[a-z0-9\]\(\[-?a-z0-9-?\]\*\[a-z0-9\]\)\?/ },
	// A leading-LETTER name grammar — the rule #3665 removes, in any of its three spellings.
	// Deliberately NOT anchored on the quantifier: the first version of this pattern ended in a
	// literal star, so it saw the unbounded spelling and missed the COUNTED one that
	// lib/queries/projects.ts used — the file that then 500'd on a name the schema had just
	// accepted. The second alternative catches the grouped spelling. This prose deliberately
	// writes none of the three out: a guard that matches its own description needs an exception,
	// and an exception on the guard file is a place real hits can hide.
	{ id: "leading-letter-name-grammar", re: /\^\[a-z\](\[a-z0-9-\]|\()/ },
	// Not every slugifier is spelled as a regex. packages/core/manifests and packages/core/imagebuild
	// filter runes in a switch, which the three patterns above cannot see at all — and a blind spot a
	// guard does not know about is the failure mode this whole lane is about.
	// The `\s+` is what keeps this file from matching its OWN pattern list: a guard that scans
	// itself reports a hit nobody can act on, and then gets an exception that hides real ones.
	{ id: "rune-range-slug-filter", re: /r >= 'a' &&\s+r <= 'z'/ },
];

/** Whole trees the census does NOT read, and why. Kept as a list of EXCLUSIONS rather than a
 *  list of inclusions: a hand-written list of what a guard watches stops covering silently the
 *  first time somebody adds a directory, whereas an exclusion list makes the gap explicit and is
 *  itself checked (an exclusion matching nothing fails, below). */
const CENSUS_EXCLUDED_TREES: Record<string, string> = {
	"test/": ""
		+ "The e2e harness recomputes the name it expects a renderer to produce (t2_namespace_tenant.go, "
		+ "t2_vcluster_tenant.go, t2_fabric_demo.go). Those are duplicates of packages/core/argocd's "
		+ "namers and should call them, but the fix belongs with the harness rather than with the "
		+ "slugifier: they assert against a live cluster, and #3662 owns part of that tree. Named here "
		+ "so the gap is visible rather than absent.",
};

/** Files the census reads: every `.ts` / `.tsx` / `.mjs` / `.go` file git can see outside the
 *  excluded trees. `git ls-files` over the WHOLE repo rather than a walk of hand-listed
 *  directories, so a new top-level directory is covered the day it appears and `.gitignore`
 *  (node_modules, build output) is honoured for free.
 *
 *  `--others --exclude-standard` includes files that are not staged yet, because the run that
 *  matters most is the one before `git add` — a sixth slugifier is easiest to catch while it is
 *  still being written. */
function censusFiles(): { scanned: string[]; excluded: string[] } {
	const out = execFileSync("git", ["-C", ROOT, "ls-files", "--cached", "--others", "--exclude-standard"], {
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	});
	const all = out
		.split("\n")
		.filter((p) => /\.(ts|tsx|mjs|go)$/.test(p))
		.filter((p) => !p.includes("/node_modules/"));
	const isExcluded = (p: string) =>
		Object.keys(CENSUS_EXCLUDED_TREES).some((tree) => p.startsWith(tree));
	return {
		scanned: all.filter((p) => !isExcluded(p)),
		excluded: all.filter(isExcluded),
	};
}

/**
 * Fails when a slug-shaped expression appears outside the canonical modules and outside the
 * declared exceptions — and fails just as loudly when the census finds NOTHING, because a census
 * that has stopped matching reads exactly like a clean repo.
 */
function assertNoSecondSlugifier(): void {
	const { scanned, excluded } = censusFiles();
	if (scanned.length === 0) {
		fail(
			"census: `git ls-files` matched no source files. A census cannot report a clean repo it " +
				"never looked at.",
		);
	}

	/** repo-relative path -> the pattern ids that matched it. */
	const hitsIn = (paths: string[]): Map<string, string[]> => {
		const hits = new Map<string, string[]>();
		for (const rel of paths) {
			let text: string;
			try {
				text = readFileSync(join(ROOT, rel), "utf8");
			} catch {
				continue; // a path git knows about that the worktree does not (deleted but staged)
			}
			const matched = CENSUS_PATTERNS.filter((pattern) => pattern.re.test(text)).map((pattern) => pattern.id);
			if (matched.length > 0) hits.set(rel, matched);
		}
		return hits;
	};

	const hits = hitsIn(scanned);

	// Vacuity, named as the specific files rather than counted: if the canonical implementation
	// itself no longer matches, the patterns have rotted and every "clean" verdict below is a lie.
	const mustMatch = ["apps/console/lib/utils/slugify.ts", "packages/core/names/names.go"];
	const silent = mustMatch.filter((path) => !hits.has(path));
	if (silent.length > 0) {
		fail(
			`census: the patterns no longer match the canonical implementation (${silent.join(", ")}). ` +
				"The census is broken, not the repo. Fix CENSUS_PATTERNS.",
		);
	}

	const undeclared = [...hits.keys()].filter((path) => !(path in CENSUS_EXCEPTIONS));
	if (undeclared.length > 0) {
		fail(
			`census: ${undeclared.length} file(s) derive a name with their own slug-shaped expression:\n` +
				undeclared.map((path) => `  - ${path}  [${hits.get(path)?.join(", ")}]`).join("\n") +
				"\n\nUse @/lib/utils/slugify (TypeScript) or packages/core/names (Go). If the expression " +
				"genuinely is not a name slugifier, add it to CENSUS_EXCEPTIONS in this file WITH THE " +
				'REASON — "n/a" is indistinguishable from an oversight.',
		);
	}

	const staleExceptions = Object.keys(CENSUS_EXCEPTIONS).filter((path) => !hits.has(path));
	if (staleExceptions.length > 0) {
		fail(
			`census: ${staleExceptions.length} exception(s) no longer match anything:\n` +
				staleExceptions.map((path) => `  - ${path}`).join("\n") +
				"\n\nRemove them. A stale exception is a reason nobody can check, and it makes the list " +
				"look bigger than the problem it describes.",
		);
	}

	// An excluded tree that contains nothing the census would have flagged is not an exclusion —
	// it is a line of prose asserting a gap that has since closed. Checked the same way as a stale
	// exception, so the exclusion list cannot quietly become fiction either.
	const excludedHits = hitsIn(excluded);
	const staleTrees = Object.keys(CENSUS_EXCLUDED_TREES).filter(
		(tree) => ![...excludedHits.keys()].some((path) => path.startsWith(tree)),
	);
	if (staleTrees.length > 0) {
		fail(
			`census: ${staleTrees.length} excluded tree(s) contain nothing the census would flag:\n` +
				staleTrees.map((tree) => `  - ${tree}`).join("\n") +
				"\n\nDelete the exclusion and let the tree be scanned — the gap it describes has closed.",
		);
	}

	console.log(
		`census: ${scanned.length} files scanned (${excluded.length} in excluded trees), ` +
			`${hits.size} slug-shaped file(s), all declared`,
	);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Emission
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Aborts with a message. Every failure path in this script goes through here so none of them
 *  can accidentally exit 0. */
function fail(message: string): never {
	console.error(`FAIL: ${message}`);
	process.exit(1);
}

/** A Go string literal for `value`, using JSON escaping (which Go accepts for the characters that
 *  appear in these names). */
function goString(value: string): string {
	return JSON.stringify(value);
}

/** The generated Go constants — the grammar DATA half. */
function renderGo(): string {
	const reserved = RESERVED_ENVIRONMENT_NAMES.map((s) => `\t${goString(s)},`).join("\n");
	return `// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Code generated by apps/console/scripts/gen-go-names.ts; DO NOT EDIT.
// Regenerate with: pnpm -C apps/console run gen:go-names
//
// The name grammar, mirrored from apps/console/lib/validations/names.ts. Every limit and every
// pattern here has exactly one definition, and it is the TypeScript one — the console owns these
// names because they are URL segments before they are anything else.

package names

import "regexp"

// SlugMaxLength is the DNS-1123 label limit, and therefore the slug limit.
const SlugMaxLength = ${SLUG_MAX_LENGTH}

// NamespaceMaxLength is the longest name Kubernetes accepts for a Namespace.
const NamespaceMaxLength = ${DNS1123_LABEL_MAX_LENGTH}

// NamespacePatternSource is Kubernetes' own DNS-1123 label grammar. Both surfaces compile this
// exact string; RE2 and JavaScript agree on it.
const NamespacePatternSource = ${goString(DNS1123_LABEL_PATTERN_SOURCE)}

// NamespacePattern is NamespacePatternSource, compiled.
var NamespacePattern = regexp.MustCompile(NamespacePatternSource)

// EnvironmentNameMaxLength is the slug cap for an environment name — shorter than a DNS-1123
// label because the env name is a SEGMENT of longer derived names.
const EnvironmentNameMaxLength = ${ENVIRONMENT_NAME_MAX_LENGTH}

// EnvironmentNameInputMaxLength bounds the RAW name the rules will look at, measured in UTF-16
// code units (what JavaScript's String.prototype.length counts).
const EnvironmentNameInputMaxLength = ${ENVIRONMENT_NAME_INPUT_MAX_LENGTH}

// AddOnAppNamePrefix is what argocd.AddOnAppName puts in front of an add-on id. It is part of the
// ArgoCD Application name's length budget, which is why it lives beside the cap.
const AddOnAppNamePrefix = ${goString(ADDON_APP_NAME_PREFIX)}

// AddOnIDMaxLength is the cap for an add-on / BYO-chart id: the label limit minus the prefix, so
// that AddOnAppNamePrefix+id is still a legal Kubernetes name.
const AddOnIDMaxLength = ${ADDON_ID_MAX_LENGTH}

// ReservedEnvironmentNames are the environment names a console route would permanently shadow
// (/{org}/{project}/settings wins over an environment called "settings").
var ReservedEnvironmentNames = []string{
${reserved}
}
`;
}

/** The generated conformance table — the ALGORITHM half. */
function renderCases(table: Table): string {
	const doc = {
		_doc:
			"GENERATED by apps/console/scripts/gen-go-names.ts from apps/console/lib/utils/slugify.ts " +
			"and apps/console/lib/validations/names.ts. DO NOT EDIT. Regenerate: pnpm -C apps/console run " +
			"gen:go-names. Consumed by packages/core/names/conformance_test.go and " +
			"apps/console/tests/lib/name-conformance.test.ts. Regenerating rewrites an EXPECTATION — " +
			"read the diff, do not skim it.",
		version: VERSION,
		cases: table,
	};
	return `${JSON.stringify(doc, null, 2)}\n`;
}

/**
 * Every section must be non-empty, and the reserved-name list must be non-empty.
 *
 * A section that exists but is empty is worse than one that is absent: the Go table test iterates
 * it, passes, and reports a covered algorithm. "Ran 0 cases" and "passed" must not share an exit
 * code, on either side of the table.
 */
function assertNotVacuous(table: Table): void {
	const empty = Object.entries(table)
		.filter(([, rows]) => rows.length === 0)
		.map(([name]) => name);
	if (empty.length > 0) {
		fail(`${empty.join(", ")} — section(s) present but with zero cases; the Go table test would pass vacuously`);
	}
	if (RESERVED_ENVIRONMENT_NAMES.length === 0) {
		fail(
			"RESERVED_ENVIRONMENT_NAMES is empty, so the generated Go list is empty and " +
				"EnvironmentNameProblem would accept every reserved route name.",
		);
	}
	// Every case id must be unique within its section, or the changed-case report silently
	// collapses two rows onto one and stops naming the boundary that moved.
	for (const [section, rows] of Object.entries(table)) {
		const ids = rows.map((r) => r.id);
		const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
		if (dupes.length > 0) fail(`${section}: duplicate case id(s) ${[...new Set(dupes)].join(", ")}`);
	}
}

/** Index a previously-generated table as `section/id -> the whole row`, narrowing from `unknown`
 *  without a cast. A malformed or absent file yields an empty index, which makes every case read
 *  as new — the honest answer when there is nothing to compare against. */
function previousRows(before: unknown): Map<string, string> {
	const index = new Map<string, string>();
	if (before === null || typeof before !== "object") return index;
	const doc: Record<string, unknown> = { ...before };
	if (doc.cases === null || typeof doc.cases !== "object") return index;
	for (const [section, rows] of Object.entries({ ...doc.cases })) {
		if (!Array.isArray(rows)) continue;
		for (const row of rows) {
			if (row === null || typeof row !== "object") continue;
			const entry: Record<string, unknown> = { ...row };
			if (typeof entry.id === "string") index.set(`${section}/${entry.id}`, JSON.stringify(entry));
		}
	}
	return index;
}

/** What moved between the committed table and this run. Added and removed ids are reported
 *  alongside changed ones: the detector matches on `section/id`, so RENAMING a case while also
 *  changing its value would otherwise report "0 changed" and hide the move entirely. */
function changedIds(before: unknown, after: Table): string[] {
	const prev = previousRows(before);
	const seen = new Set<string>();
	const changed: string[] = [];
	for (const [section, rows] of Object.entries(after)) {
		for (const row of rows) {
			const key = `${section}/${row.id}`;
			seen.add(key);
			const was = prev.get(key);
			const now = JSON.stringify(row);
			if (was === undefined) changed.push(`+ ${key}  (new) ${now}`);
			else if (was !== now) changed.push(`~ ${key}: ${was} -> ${now}`);
		}
	}
	for (const [key, was] of prev) {
		if (!seen.has(key)) changed.push(`- ${key}  (removed) ${was}`);
	}
	return changed;
}

/** Reads a file, or null when it does not exist. */
function readOrNull(path: string): string | null {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

function main(): void {
	const write = process.argv.includes("--write");

	const table = build();
	assertNotVacuous(table);

	const nextGo = renderGo();
	const nextCases = renderCases(table);
	const currentGo = readOrNull(GO_OUT);
	const currentCases = readOrNull(CASES_OUT);

	const total = Object.values(table).reduce((n, rows) => n + rows.length, 0);
	const goStale = currentGo !== nextGo;
	const casesStale = currentCases !== nextCases;

	if (!goStale && !casesStale) {
		assertNoSecondSlugifier();
		console.log(`names: ${total} cases across ${Object.keys(table).length} algorithms — up to date`);
		return;
	}

	let parsed: unknown = null;
	if (currentCases !== null) {
		try {
			parsed = JSON.parse(currentCases);
		} catch {
			parsed = null;
		}
	}
	const changed = casesStale ? changedIds(parsed, table) : [];

	if (!write) {
		assertNoSecondSlugifier();
		const which = [goStale ? relative(ROOT, GO_OUT) : null, casesStale ? relative(ROOT, CASES_OUT) : null]
			.filter((p): p is string => p !== null)
			.join(", ");
		console.error(
			`FAIL: ${which} is stale — the implementation and the committed files disagree.\n` +
				"Regenerate with:  pnpm -C apps/console run gen:go-names\n" +
				"\nname-cases.json is a CONTRACT packages/core/names is held to, not a snapshot: read the\n" +
				"changed-case list below rather than regenerating past it.",
		);
		if (changed.length > 0) {
			console.error(`\n${changed.length} case(s) differ  (~ changed · + new · - removed):`);
			changed.forEach((c) => console.error(`  ${c}`));
		}
		process.exit(1);
	}

	mkdirSync(dirname(CASES_OUT), { recursive: true });
	writeFileSync(GO_OUT, nextGo, "utf8");
	writeFileSync(CASES_OUT, nextCases, "utf8");
	// After the write: on a first-ever generation the census's own canonical file (names_gen.go)
	// does not exist until this point, and a census that has not seen it cannot vouch for it.
	assertNoSecondSlugifier();
	console.log(
		`names: wrote ${relative(ROOT, GO_OUT)} and ${relative(ROOT, CASES_OUT)} — ${total} cases, ${changed.length} changed`,
	);
	if (changed.length > 0) {
		console.log("\nCASES CHANGED  (~ changed · + new · - removed):");
		changed.forEach((c) => console.log(`  ${c}`));
	}
}

main();
