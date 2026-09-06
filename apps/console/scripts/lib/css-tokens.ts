// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A small, deliberately literal scanner for CSS custom-property DECLARATIONS.
 *
 * It exists because the census in `gen-go-brand.ts` has to be complete: a token that the
 * scanner fails to see is a token with no projection entry that nothing ever reports. The
 * obvious `grep -oE '^\s*--[a-z-]+:'` is not complete — `tokens.css` contains
 *
 *     :root { --text-display-lg: 44px; --text-display-md: 34px; --text-display-sm: 26px; }
 *
 * on one physical line, so a line-anchored pattern sees one of three. It is also not SOUND:
 * `var(--text-primary, currentColor)` is a USE, not a declaration, and a pattern that keys on
 * `--name:` alone would invent tokens out of `background: var(--x)` in a shorthand.
 *
 * So: a linear scan that consumes strings and parenthesised groups atomically, tracks the block
 * stack, and calls a declaration exactly what CSS calls one — `--name : value` terminated by
 * `;` or the end of its block.
 *
 * It is NOT a CSS parser and does not try to be. It knows nothing about specificity, the
 * cascade, or `@supports`. Everything it does not understand it reports as a `local` scope,
 * which still lands in the census and therefore still demands a projection entry — the failure
 * direction that produces a question rather than a silent gap.
 */

/** Where a declaration was written. Drives which theme map (if any) takes its value. */
export type TokenScope = "theme" | "root" | "dark" | "local";

export interface TokenDeclaration {
	/** Full custom-property name, including the leading `--`. */
	name: string;
	/** Raw declaration value, whitespace-collapsed, without the trailing `;`. */
	value: string;
	/** The innermost meaningful block the declaration sits in. */
	scope: TokenScope;
	/** True when the declaration is nested inside an `@media` (a breakpoint variant). */
	inMedia: boolean;
	/** The full block stack, outermost first — kept for error messages. */
	stack: readonly string[];
}

/** Replaces every `/* … *​/` comment with a single space, preserving declaration boundaries. */
export function stripComments(css: string): string {
	let out = "";
	let i = 0;
	while (i < css.length) {
		if (css.startsWith("/*", i)) {
			const end = css.indexOf("*/", i + 2);
			// An unterminated comment swallows the rest of the file — which is what a browser
			// does too, so mirroring it keeps the census honest rather than optimistic.
			i = end === -1 ? css.length : end + 2;
			out += " ";
			continue;
		}
		if (css[i] === '"' || css[i] === "'") {
			const quote = css[i];
			out += css[i];
			i++;
			while (i < css.length) {
				if (css[i] === "\\" && i + 1 < css.length) {
					out += css.slice(i, i + 2);
					i += 2;
					continue;
				}
				out += css[i];
				if (css[i] === quote) {
					i++;
					break;
				}
				i++;
			}
			continue;
		}
		out += css[i];
		i++;
	}
	return out;
}

/** Collapses runs of whitespace to one space and trims. */
function collapse(s: string): string {
	return s.replace(/\s+/g, " ").trim();
}

/** Classifies a block stack into the scope that decides which theme map a value lands in. */
function scopeOf(stack: readonly string[]): TokenScope {
	// `@theme` / `@theme inline` is Tailwind v4's token block; treat it as the base theme.
	if (stack.some((s) => /^@theme\b/.test(s))) return "theme";
	for (let i = stack.length - 1; i >= 0; i--) {
		const sel = stack[i];
		if (sel.startsWith("@")) continue;
		if (sel === ":root") return "root";
		if (sel === ".dark") return "dark";
		return "local";
	}
	return "local";
}

/**
 * Extracts every custom-property declaration in source order, including several on one line
 * and several nested block levels deep.
 */
export function parseDeclarations(css: string): TokenDeclaration[] {
	const src = stripComments(css);
	const decls: TokenDeclaration[] = [];
	const stack: string[] = [];
	let buf = "";

	/** Records `buf` if it reads as a custom-property declaration, then clears it. */
	const flush = (): void => {
		const text = collapse(buf);
		buf = "";
		if (!text.startsWith("--")) return;
		const colon = text.indexOf(":");
		if (colon === -1) return;
		const name = text.slice(0, colon).trim();
		if (!/^--[A-Za-z0-9_-]+$/.test(name)) return;
		decls.push({
			name,
			value: collapse(text.slice(colon + 1)),
			scope: scopeOf(stack),
			inMedia: stack.some((s) => /^@media\b/.test(s)),
			stack: [...stack],
		});
	};

	let i = 0;
	while (i < src.length) {
		const ch = src[i];
		if (ch === '"' || ch === "'") {
			// Strings are opaque: a brace or semicolon inside one is data, not structure.
			const quote = ch;
			buf += ch;
			i++;
			while (i < src.length) {
				if (src[i] === "\\" && i + 1 < src.length) {
					buf += src.slice(i, i + 2);
					i += 2;
					continue;
				}
				buf += src[i];
				const done = src[i] === quote;
				i++;
				if (done) break;
			}
			continue;
		}
		if (ch === "(") {
			// Balanced groups are opaque for the same reason: `cubic-bezier(0.2, 0, 0, 1)` and
			// `var(--x, y)` both carry commas, and `url(...)` can carry almost anything.
			let depth = 0;
			while (i < src.length) {
				if (src[i] === "(") depth++;
				else if (src[i] === ")") depth--;
				buf += src[i];
				i++;
				if (depth === 0) break;
			}
			continue;
		}
		if (ch === "{") {
			stack.push(collapse(buf));
			buf = "";
			i++;
			continue;
		}
		if (ch === "}") {
			// A block's last declaration may omit its `;`.
			flush();
			stack.pop();
			buf = "";
			i++;
			continue;
		}
		if (ch === ";") {
			flush();
			i++;
			continue;
		}
		buf += ch;
		i++;
	}
	flush();
	return decls;
}

/**
 * The census: every custom-property name declared anywhere in the sheet, deduplicated,
 * in first-declaration order.
 */
export function tokenCensus(css: string): string[] {
	const seen = new Set<string>();
	const order: string[] = [];
	for (const d of parseDeclarations(css)) {
		if (seen.has(d.name)) continue;
		seen.add(d.name);
		order.push(d.name);
	}
	return order;
}
