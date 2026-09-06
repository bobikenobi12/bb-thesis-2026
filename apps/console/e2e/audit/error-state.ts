// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// T6 — "fault-injected, the page renders `components/errors/error-state`".
//
// Two halves, and both have a trap that was measured rather than reasoned about.
//
// **Recognising the shared component.** `ErrorState` carries no `data-slot`, so there is nothing to
// query for. Hard-coding its class list here would be a hand-written copy of somebody else's
// source, and a hand-written copy decays silently the first time that source is restyled — the
// detector would then answer "not the shared component" for a page that renders nothing but. So the
// signature is DERIVED from `components/errors/error-state.tsx` at run time, and the derivation
// RAISES if it cannot find the shape it expects. A detector that cannot find its subject must not
// report a clean page.
//
// **Injecting the fault.** A Next App Router error boundary catches a throw from the React tree
// below it. The audit raises one by poisoning a browser API the client tree reads while rendering —
// `window.matchMedia` — installed with `addInitScript` so it is in place before the page's first
// script runs. Nothing in the page's own code is edited and no build artifact is faked, so what
// answers is whatever boundary Next has covering that route.
//
// WHAT THIS PROVES, AND WHAT IT DOES NOT. The fault fires during HYDRATION, i.e. above the route
// segment, so the boundary that answers is the outermost one covering the route (`app/error.tsx`),
// not each segment's own `error.tsx`. Measured: `shellSurvived` is false on every route. So T6 as
// measured here says *a render fault under this route reaches the shared ErrorState rather than a
// blank page or the browser's own error*. It does NOT yet say that `[org]/error.tsx` and
// `[org]/[project]/error.tsx` each render it. `shellSurvived` is in the evidence precisely so that
// distinction is visible in the report instead of being inferred from a uniform column of PASSes;
// landing the fault inside the segment needs a client-side navigation into the route with the API
// already poisoned, which needs a real `next/link` click per route. That is a follow-up.
//
// Two other faults were tried and REJECTED ON EVIDENCE, so the next reader does not repeat them:
//   · breaking one of the route's own `_next/static/chunks` — the sandbox console runs Turbopack,
//     whose chunk graph has no `app/` segment at all, and the page recovered from a broken chunk
//     anyway. The chunk paths also differ from CI's built console, so the instrument would have
//     measured two different things in the two places it runs.
//   · a 500 on the RSC fetch for a client navigation — Next falls back to a hard navigation rather
//     than raising to the boundary.

import { readFileSync } from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { repoRoot } from "./manifest";

const SOURCE = path.join("apps", "console", "components", "errors", "error-state.tsx");

let signature: string[][] | null = null;

/**
 * The class-token sets that identify a rendered `ErrorState`, read out of its source.
 *
 * Both of its layout arms are captured (`fullPage` and the in-shell panel); a live element carrying
 * every token of either arm is the shared component. Raises when the source yields neither — the
 * component has been restyled past what this reads, and that must be a red run, not a silent one.
 */
export function errorStateSignature(): string[][] {
	if (signature) return signature;
	const file = path.join(repoRoot(), SOURCE);
	const src = readFileSync(file, "utf8");
	const arms: string[][] = [];
	for (const literal of src.matchAll(/"([^"]*min-h-(?:\[320px\]|screen)[^"]*)"/g)) {
		const tokens = literal[1].trim().split(/\s+/).filter(Boolean);
		if (tokens.length >= 3) arms.push(tokens);
	}
	if (arms.length === 0) {
		throw new Error(
			`T6 detector is broken: ${SOURCE} no longer contains a layout class literal with ` +
				`min-h-[320px] or min-h-screen, so a rendered ErrorState cannot be recognised. Fix the ` +
				`signature here — do NOT let T6 report on a detector that cannot find its subject.`,
		);
	}
	signature = arms;
	return arms;
}

/** Whether the page currently renders the shared error component. */
export async function rendersSharedErrorState(page: Page): Promise<boolean> {
	return page.evaluate((arms: string[][]) => {
		for (const el of Array.from(document.querySelectorAll<HTMLElement>("div"))) {
			const classes = new Set((el.className || "").split(/\s+/));
			if (arms.some((tokens) => tokens.every((t) => classes.has(t)))) {
				const r = el.getBoundingClientRect();
				if (r.width > 0 && r.height > 0) return true;
			}
		}
		return false;
	}, errorStateSignature());
}

/**
 * The page's VISIBLE text — `innerText`, never `textContent`.
 *
 * A measured trap, not a style preference. The sandbox console serves tens of kilobytes of INLINE
 * SCRIPT SOURCE in the document, and `textContent` returns all of it: a probe reported 74,505
 * characters for a page rendering nothing but an error panel. Every "is this page blank?" question
 * built on `textContent` therefore answers "no", always — which is exactly the check T6 and T7 both
 * rest on. `innerText` sees what a person sees.
 */
export async function visibleText(page: Page): Promise<string> {
	return page.evaluate(() => {
		const root: HTMLElement = document.querySelector("main") ?? document.body;
		return root.innerText.trim().replace(/\s+/g, " ");
	});
}

/** Visible text that reads as an error surface — used to tell "the wrong state" from "a blank". */
export async function visibleErrorish(page: Page): Promise<string | null> {
	const text = await visibleText(page);
	if (!text) return null;
	return /(went wrong|couldn'?t|could not|error|failed|try again|unavailable)/i.test(text)
		? text.slice(0, 200)
		: null;
}

export interface FaultResult {
	/** Whether the shell survived — `false` means the OUTERMOST boundary answered, not the segment's. */
	shellSurvived: boolean;
	rendersSharedErrorState: boolean;
	errorish: string | null;
	/** Visible characters, so a blank can be told from a state. */
	visibleLength: number;
}

/**
 * `window.matchMedia` made to throw. Installed before any of the page's scripts run.
 *
 * Chosen because every console page's client tree reaches it (the theme script and the responsive
 * shell both do) and because it is a BROWSER API rather than a build artifact — so the same fault
 * means the same thing on the sandbox's Turbopack console and on CI's built one.
 */
const CLIENT_FAULT =
	'Object.defineProperty(window, "matchMedia", { configurable: true, get() { ' +
	'throw new Error("ui-audit: injected client render fault (T6)"); } });';

/**
 * Load `url` in a page whose client render will throw, and report what rendered.
 *
 * A page of its own: `addInitScript` cannot be taken back off the audit's main page, so every later
 * navigation on it would render the error state instead of the route.
 */
export async function loadWithInjectedFault(page: Page, url: string): Promise<FaultResult> {
	const faulted = await page.context().newPage();
	try {
		await faulted.addInitScript(CLIENT_FAULT);
		await faulted.goto(url, { waitUntil: "domcontentloaded" }).catch(() => {});
		// WAIT FOR THE OUTCOME, WITH A TIMEOUT AS THE CEILING — never a fixed duration.
		//
		// `domcontentloaded` returns as soon as the HTML is parsed, before the client bundle has
		// hydrated, which is when the poisoned `matchMedia` actually throws and the boundary
		// renders. A flat 1.5s wait made that whole window the budget, and it failed in the "not
		// yet" direction: on a slow runner the boundary had simply not rendered, `T6` recorded FAIL,
		// and the evidence was indistinguishable from a route that genuinely has no shared error
		// state. A timing flake reported as a conformance defect is worse than one reported as a
		// timeout, so this polls for the signature and only concludes FAIL after 15s.
		await faulted
			.waitForFunction(
				(arms: string[][]) =>
					Array.from(document.querySelectorAll<HTMLElement>("div")).some((el) => {
						const classes = new Set((el.className || "").split(/\s+/));
						if (!arms.some((tokens) => tokens.every((t) => classes.has(t)))) return false;
						const r = el.getBoundingClientRect();
						return r.width > 0 && r.height > 0;
					}),
				errorStateSignature(),
				{ timeout: 15_000 },
			)
			.catch(() => {});
		const text = await visibleText(faulted);
		return {
			shellSurvived: await faulted.evaluate(
				() => !!document.querySelector("main") && !!document.querySelector("nav"),
			),
			rendersSharedErrorState: await rendersSharedErrorState(faulted),
			errorish: await visibleErrorish(faulted),
			visibleLength: text.length,
		};
	} finally {
		await faulted.close();
	}
}
