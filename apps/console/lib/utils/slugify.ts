// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// THE slugifier. One implementation, for every free-text name (org / project / environment /
// chart / classification key) that becomes a URL segment, a Kubernetes object name or an ArgoCD
// Application name.
//
// It replaced five that disagreed (#3665):
//   - lib/slug.ts            — folded accents, optional cap, could return ""
//   - validations/byo-charts.chartSlug — no accent folding, NO CAP AT ALL, and its output became
//                              an ArgoCD Application name via argocd.AddOnAppName ("addon-"+id)
//   - three copies in components/classification/ — no accent folding, cap 64
//   - argocd.ByoProjectName / argocd.namespaceTenantName (Go) — dropped non-ASCII outright, so
//                              `café` slugged to `cafe` in TS and `caf` in Go
//
// The rules, settled in #3612:
//   - NFKD-fold accents, so `José's API` → `joses-api` on BOTH surfaces;
//   - collapse any run of non-alphanumerics to a single dash;
//   - cap at 63 characters (the DNS-1123 label limit — a slug that is not a legal Kubernetes
//     name is a deploy that dies late);
//   - NEVER return "". A name that slugs away entirely takes a caller-supplied fallback.
//
// `packages/core/names` is the Go mirror, held to the conformance table generated from THIS file
// by apps/console/scripts/gen-go-names.ts. Keep it dependency-free: server actions, route
// handlers and client components all import it.

/** The DNS-1123 label limit, and therefore the slug limit. A Kubernetes Namespace, an ArgoCD
 *  Application and a URL segment all live inside it. */
export const SLUG_MAX_LENGTH = 63;

/** Unicode combining diacritical marks — what NFKD splits an accented letter into.
 *  Exactly U+0300–U+036F, the Combining Diacritical Marks block; the Go mirror strips the same
 *  range rather than all of category Mn, because the two are not the same set. */
const COMBINING_MARKS = /[\u0300-\u036f]/g;

/** Apostrophes / quotes that should vanish rather than become a dash (`bob's` → `bobs`). */
const APOSTROPHES = /['\u2019\u02bc`]+/g;

/**
 * Normalizes a free-text name into a slug, which may be the empty string.
 *
 * Prefer {@link slugify}: the empty case is the live bug this module exists to close
 * (`resolveTargetEnvironment` fed the result straight into an ArgoCD destination namespace).
 * Use this one only where an empty answer is the correct answer — an as-you-type slug preview,
 * or {@link canSlugify}'s "would this name survive slugification?" question.
 */
export function slugifyOrEmpty(raw: string, maxLength: number = SLUG_MAX_LENGTH): string {
	const s = raw
		.normalize("NFKD") // split accented letters into base char + combining mark
		.replace(COMBINING_MARKS, "") // strip the marks: José → Jose
		.toLowerCase()
		.replace(APOSTROPHES, "") // bob's → bobs (not bob-s)
		.replace(/[^a-z0-9]+/g, "-") // any other non-alphanumeric run → a single dash
		.replace(/^-+|-+$/g, ""); // trim leading/trailing dashes
	// The cut can expose a trailing dash ("ab-cd-ef" capped at 6 is "ab-cd-"), so re-trim.
	return s.length > maxLength ? s.slice(0, maxLength).replace(/-+$/g, "") : s;
}

/**
 * Normalizes a free-text name into a slug that is never empty.
 *
 * `fallback` is used when `raw` slugs away entirely (`"@#$%"`, `"''"`, `""`). It is itself
 * slugified and capped, so the return value always satisfies the DNS-1123 label grammar.
 *
 * Throws when `fallback` ALSO slugs to nothing. That is a caller bug and there is no honest
 * answer to return: silently handing back "" is precisely the failure mode this signature
 * exists to make impossible.
 */
export function slugify(
	raw: string,
	fallback: string,
	maxLength: number = SLUG_MAX_LENGTH,
): string {
	const slug = slugifyOrEmpty(raw, maxLength);
	if (slug) return slug;
	const fromFallback = slugifyOrEmpty(fallback, maxLength);
	if (fromFallback) return fromFallback;
	throw new TypeError(
		`slugify(${JSON.stringify(raw)}, ${JSON.stringify(fallback)}): the fallback slugs to nothing, ` +
			`so there is no non-empty slug to return. Pass a fallback containing at least one letter or digit.`,
	);
}

/** Whether `raw` survives slugification — i.e. contains at least one letter or digit that
 *  {@link slugifyOrEmpty} keeps. The question a form's "enter at least one letter or number"
 *  refinement is asking. */
export function canSlugify(raw: string, maxLength: number = SLUG_MAX_LENGTH): boolean {
	return slugifyOrEmpty(raw, maxLength).length > 0;
}
