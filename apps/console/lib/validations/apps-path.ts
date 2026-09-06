// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Validation for `project_repositories.apps_path` (#1767) — the apps-repo subpath a PLACED
// environment syncs (the per-tier Kustomize overlay, "overlays/dev").
//
// This is the TS MIRROR of packages/core/argocd.ValidateAppsPath, which is the AUTHORITATIVE,
// fail-closed guard: the value lands verbatim in an ArgoCD Application's `source.path`, and the Go
// side re-checks it at the renderers' choke point and again in the provisioner before any cluster is
// touched. The console is not a trust boundary here (the API is reachable without it), so this copy
// exists to fail the user EARLY and legibly rather than at deploy time. Keep the two grammars in
// step: a value the console accepts and the runner rejects is a deploy that dies late.

import { z } from "zod";

/**
 * The conservative repo-subpath segment grammar: an alphanumeric start, then alphanumerics, '.',
 * '_' or '-'. Quotes, backticks, '$', spaces and every other YAML-hostile rune are excluded BY
 * CONSTRUCTION rather than by a denylist somebody has to keep ahead of the next escape idea.
 *
 * It also subsumes Go's `path.Clean` round-trip check: "." and ".." fail the alphanumeric start, and
 * a leading '/', a trailing '/' or a "//" all yield an empty segment, which fails too. That claim
 * was verified by running this grammar against the real Go function over a 228-input differential
 * corpus, not by reading the two side by side.
 */
const APPS_PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Bounds the rendered YAML scalar — far above any real Kustomize layout, low enough that a
 * pathological value cannot bloat every generated manifest. Mirrors appsPathMaxLen.
 *
 * Go measures BYTES (`len`) and this measures UTF-16 code units. The difference is unreachable:
 * any rune that could make the two counts disagree is non-ASCII, and non-ASCII already fails
 * APPS_PATH_SEGMENT on both sides before length can decide anything.
 */
const APPS_PATH_MAX_LEN = 512;

/**
 * The exact code-point set Go's `strings.TrimSpace` strips (`unicode.IsSpace`): U+0009-U+000D,
 * U+0020, U+0085, U+00A0, U+1680, U+2000-U+200A, U+2028, U+2029, U+202F, U+205F, U+3000.
 *
 * Deliberately NOT `String.prototype.trim()`. The two whitespace sets are near mirror images at the
 * edges: JS trims U+FEFF (ZWNBSP, the BOM) which Go does NOT, and Go trims U+0085 (NEL) which JS
 * does NOT. With `.trim()` the console ACCEPTED a U+FEFF-prefixed path — a BOM rides along on a
 * value pasted out of a rendered docs page or a spreadsheet cell — and the runner then REFUSES it,
 * which is exactly the late-dying deploy this mirror exists to prevent.
 */
const GO_SPACE_CLASS =
	"[\\t\\n\\v\\f\\r \\u0085\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000]";
const GO_SPACE = new RegExp(`^${GO_SPACE_CLASS}+|${GO_SPACE_CLASS}+$`, "gu");

/** Strips leading and trailing whitespace using Go's `unicode.IsSpace` set — see GO_SPACE_CLASS. */
export function goTrimSpace(s: string): string {
	return s.replace(GO_SPACE, "");
}

/**
 * Reports whether `p` is a safe apps-repo subpath. EMPTY IS VALID and means the repository root:
 * the runner defaults an unset path to ".", so an environment that predates this column renders
 * byte-identically.
 *
 * A traversal is REFUSED, never normalised — rewriting "../../shared" to "shared" would silently
 * hand the user a different directory than the one they asked for.
 */
export function isValidAppsPath(p: string): boolean {
	const trimmed = goTrimSpace(p);
	if (trimmed === "" || trimmed === ".") return true;
	if (trimmed.length > APPS_PATH_MAX_LEN) return false;
	return trimmed.split("/").every((seg) => APPS_PATH_SEGMENT.test(seg));
}

export const APPS_PATH_MESSAGE =
	"must be a repo-relative subpath such as overlays/dev (letters, digits, . _ - and /, no leading or trailing slash, no ..)";

/** Shown when only the length bound is violated, so a 4KB paste does not get the grammar lecture. */
export const APPS_PATH_TOO_LONG_MESSAGE = `must be at most ${APPS_PATH_MAX_LEN} characters`;

/**
 * Zod schema for an optional apps-repo subpath column. Nullish (the column is nullable and unset
 * means "repository root") and trimmed, but NOT otherwise rewritten — see isValidAppsPath.
 *
 * The trim is `goTrimSpace`, not zod's `.trim()`, so the value STORED is the same value this guard
 * judged and the same value Go will re-derive at the renderer.
 *
 * INVARIANT (#1767): no `.default("")` and no `?? null`. The key must stay omittable, and a
 * whitespace-only input must normalise to `""` — which is falsy, so `buildConfigSnapshot` leaves
 * `apps_path` ABSENT from the config snapshot rather than emitting a null. That absence is what
 * keeps every deploy that predates this column byte-identical.
 */
export const appsPathSchema = z
	.string()
	.transform(goTrimSpace)
	// The bound is stated DECLARATIVELY, and after the trim, so that
	// apps/console/scripts/gen-go-validation.ts can project it into packages/core/validate rather
	// than leaving it locked inside isValidAppsPath. It is not a new rule: isValidAppsPath applies
	// the same bound to the same trimmed value, so this only changes which message a 600-character
	// path gets.
	.pipe(z.string().max(APPS_PATH_MAX_LEN, APPS_PATH_TOO_LONG_MESSAGE))
	.refine(isValidAppsPath, APPS_PATH_MESSAGE)
	.nullish();
