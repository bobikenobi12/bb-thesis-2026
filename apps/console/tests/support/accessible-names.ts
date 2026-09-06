// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The denominator for "every control the UI conformance audit requires a name on", plus the sweep
// that computes it. Extracted from tests/components/shell-chrome-accessible-names.test.tsx (#3749),
// which found the topbar switcher this way, and widened in #3756 so a second sweep can reuse it.
//
// WHY A SWEEP AND NOT A CLASS MATCH. `check-shared-surface.mjs` deliberately does not own this: an
// accessible name is a RENDERED property, not a shape in the source. `aria-label={x}` is present in
// the text and can still compute to `''`; a `<button>` with a `<Label htmlFor>` two components away
// has a name with no attribute anywhere near it. The only honest question is what the accname
// algorithm returns for the real tree, so the guard has to render one.

import { expect } from "vitest";

/**
 * Selector for the two axe rules that require a name on a COMMAND: `button-name`
 * (`selector: 'button'`, critical) and `aria-command-name` (`[role="link"], [role="button"],
 * [role="menuitem"]`, serious).
 *
 * Native `<button>` alone is not enough: base-ui's `useButton` stamps `role="button"` on whatever
 * element it is asked to render, so the org switcher's body is an `<a role="button">` that a
 * `button` query never sees.
 */
export const COMMAND_ROLES =
	'button, [role="button"], [role="link"], [role="menuitem"]';

/**
 * Selector for axe's third name rule, `aria-input-field-name` (serious) — verbatim, including the
 * five roles the console does not use today, because the rule does not care that we do not use them
 * and neither should the sweep.
 *
 * Read the ATTRIBUTE selectors literally: this matches `<input role="combobox">` but never a plain
 * `<input>`, exactly as axe does. Two consequences worth knowing, both measured against axe-core
 * 4.13.0 in jsdom rather than inferred:
 *
 *  - axe itself SKIPS `<input role="combobox">`. The rule's `matches` is `noNamingMethodMatches`,
 *    which excludes any element whose host language already gives it a naming method, and `<input>`
 *    has one; the rule fires on `<div role="combobox">`, where there is no native label to fall
 *    back on. This sweep does NOT reproduce that exclusion, on purpose — it is a statement about
 *    which rule owns the element, not about whether the element needs a name.
 *  - a bare `<input>` with no label is a real defect and is NOT in this denominator. It is axe's
 *    `label` rule, a different rule with a different remedy, and folding it in here would make this
 *    sweep's failures ambiguous about which fix they are asking for.
 */
export const INPUT_FIELD_ROLES =
	'[role="combobox"], [role="listbox"], [role="searchbox"], [role="slider"], [role="spinbutton"], [role="textbox"]';

/** Every element axe would require a discernible name on, across all three of its name rules. */
export const NAME_REQUIRED = `${COMMAND_ROLES}, ${INPUT_FIELD_ROLES}`;

/** Every control under `root` that the audit requires a name on. */
export function namedControlCandidates(
	root: HTMLElement,
	selector: string = NAME_REQUIRED,
): HTMLElement[] {
	return Array.from(root.querySelectorAll<HTMLElement>(selector));
}

/**
 * The outer HTML of every control under `root` that has no ACCESSIBLE NAME.
 *
 * The assertion is `toHaveAccessibleName()`, which runs the accname algorithm over the rendered
 * tree — deliberately not a check that some attribute is present. `aria-label={undefined}`,
 * `aria-label=""`, and an `aria-labelledby` pointing at an id that no longer renders all read as
 * "named" to an attribute check and as unnamed to a user.
 */
export function unnamedControls(
	root: HTMLElement,
	selector: string = NAME_REQUIRED,
): string[] {
	return namedControlCandidates(root, selector).flatMap((control) => {
		try {
			expect(control).toHaveAccessibleName();
			return [];
		} catch {
			return [control.outerHTML.slice(0, 200)];
		}
	});
}
