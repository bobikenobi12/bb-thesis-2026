// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The audit's route set — READ FROM THE SEAM, never re-walked.
//
// `scripts/lib/console-routes.mjs` is the ONE definition of "the console's private route set"
// (#3636). Two definitions of the denominator is the failure the seams unit exists to prevent: a
// route the audit never visited and a route that scored zero are indistinguishable in a report
// whose route list came from somewhere else. So this module shells out to the seam and parses its
// JSON — it does not re-implement any part of it, and it does not filter the result.
//
// Why a child process rather than an import: the seam is ESM (`.mjs`) and Playwright transforms
// specs to CJS, where `require()` of an ESM module is version-dependent. `execFileSync` is the
// same answer under every Node, it is one process for the whole run, and — critically — it
// propagates the seam's raises. The seam throws on a missing scope directory and on a zero-route
// scan; `execFileSync` turns a non-zero exit into a throw, so those raises reach the test runner
// instead of becoming an empty sweep that reports green over nothing.
//
// NOT PIPED, deliberately: `node … | tail` reports tail's exit code and every raise goes invisible.

import { execFileSync } from "node:child_process";
import path from "node:path";

/** A route parameter as the seam reports it (`[org]`, `[[...rest]]`, …). */
export interface RouteParam {
	segment: string;
	name: string;
	catchAll: boolean;
	optional: boolean;
}

/** One record out of `collectConsoleRoutes()`. Only the fields the live audit reads are named. */
export interface RouteRecord {
	route: string;
	file: string;
	dir: string;
	params: RouteParam[];
	isRedirectOnly: boolean;
	hasMetadata: boolean;
	shell: string | null;
	shellChain: string[];
}

export interface RouteManifest {
	version: number;
	scope: string;
	routes: RouteRecord[];
	shells: { name: string; file: string }[];
}

/** The record shape this module was written against. A bump must be read, not absorbed. */
const EXPECTED_VERSION = 1;

/** Repo root, from `apps/console/e2e/audit` (Playwright runs with cwd = apps/console). */
export function repoRoot(): string {
	return path.resolve(__dirname, "..", "..", "..", "..");
}

let cached: RouteManifest | null = null;

/** The stderr of a failed child process, if it carried one — narrowed, never cast. */
function describeSpawnFailure(err: unknown): string {
	if (err instanceof Error && "stderr" in err) {
		const { stderr } = err;
		if (typeof stderr === "string" && stderr.trim()) return stderr;
		if (stderr instanceof Buffer) return stderr.toString("utf8");
	}
	return err instanceof Error ? err.message : String(err);
}

/** Structural check on the seam's JSON — the fields this audit reads, and nothing more. */
function isRouteManifest(value: unknown): value is RouteManifest {
	if (typeof value !== "object" || value === null) return false;
	if (!("version" in value) || typeof value.version !== "number") return false;
	if (!("routes" in value) || !Array.isArray(value.routes)) return false;
	return value.routes.every(
		(r: unknown) =>
			typeof r === "object" &&
			r !== null &&
			"route" in r &&
			typeof r.route === "string" &&
			"params" in r &&
			Array.isArray(r.params) &&
			"isRedirectOnly" in r &&
			typeof r.isRedirectOnly === "boolean",
	);
}

/**
 * Every private console route, straight from `scripts/lib/console-routes.mjs`.
 *
 * Raises — never returns an empty list — when the seam raises, when its output is not the manifest
 * shape, or when it reports a record version this module has not been read against.
 */
export function consoleRoutes(): RouteManifest {
	if (cached) return cached;
	const seam = path.join(repoRoot(), "scripts", "lib", "console-routes.mjs");
	let raw: string;
	try {
		raw = execFileSync(process.execPath, [seam, "--json"], {
			encoding: "utf8",
			maxBuffer: 32 * 1024 * 1024,
		});
	} catch (err) {
		throw new Error(
			`the console route manifest could not be produced — the audit has no denominator and ` +
				`MUST NOT run over an assumed one.\n  seam: ${seam}\n  ${describeSpawnFailure(err)}`,
		);
	}

	const parsed: unknown = JSON.parse(raw);
	if (!isRouteManifest(parsed)) {
		throw new Error(`${seam} --json did not produce a route manifest: ${raw.slice(0, 200)}`);
	}
	const manifest: RouteManifest = parsed;
	if (manifest.version !== EXPECTED_VERSION) {
		throw new Error(
			`console-routes.mjs reports record version ${manifest.version}; this audit was written ` +
				`against ${EXPECTED_VERSION}. Read the change and update e2e/audit/manifest.ts — do not ` +
				`widen the check.`,
		);
	}
	if (!Array.isArray(manifest.routes) || manifest.routes.length === 0) {
		// The seam already raises on a zero-route scan. This is the belt: an empty array reaching
		// here would make every predicate vacuously satisfied over nothing.
		throw new Error(`${seam} --json produced no routes — a broken scan, not an empty app.`);
	}
	cached = manifest;
	return manifest;
}
