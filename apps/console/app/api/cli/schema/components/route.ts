// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { authorizeCli } from "@/lib/authz/guard";
import {
	componentSchemaDocument,
	componentSchemaWire,
} from "@/lib/cli/project-components";
import { NextResponse } from "next/server";
import { cliJson } from "@/lib/cli/respond";

/**
 * `private` because the response is token-gated: never store it in a shared cache.
 *
 * `max-age` rather than `no-cache`, because `no-cache` means a stored copy MUST be revalidated
 * with the origin before every reuse — a round trip per `alethia project component kinds|add|set`,
 * which is precisely the cost this endpoint exists to remove. Those commands need no network at
 * all today. The document is a pure projection of committed code and cannot change without a
 * deploy, so a held copy is allowed to be USED; the ETag below still serves the revalidation that
 * happens at expiry, and turns it into a bodiless 304.
 *
 * 300s is deliberately short, and the reason is the epic's subset invariant. A client holding a
 * PRE-deploy document can refuse a kind or a field the server has just started accepting, and
 * "too strict" is the one direction that invariant forbids (too permissive is caught by the
 * server). This bounds that window; a consumer must additionally treat "not in my cached
 * document" as advisory — let the server decide — rather than as a refusal it is sure of.
 */
const CACHE_CONTROL = "private, max-age=300";

/**
 * True when `If-None-Match` names the current entity tag. Handles the list form ("a", "b"), the
 * weak-validator prefix, and `*` — which per RFC 9110 means "any current representation", and
 * there is always one here.
 */
function ifNoneMatchHits(header: string, etag: string): boolean {
	return header.split(",").some((candidate) => {
		const tag = candidate.trim().replace(/^W\//, "");
		return tag === "*" || tag === etag;
	});
}

/**
 * Publishes the component-kind registry — which kinds exist, which are singletons, and the JSON
 * Schema of the fields an add / `--set` request may assign.
 *
 * This exists so the CLI's `componentKinds` / `singletonKinds` literals become a CACHE of a
 * published schema instead of a second opinion. They have already drifted: the Go list omits
 * `helm_registries`, which this registry authors. And `--set` coercion runs in Go against a raw
 * string with no idea of the field's type, while the type lives here — the split-brain this
 * document closes by shipping the type with the field name.
 *
 * GATING — the same as its siblings, and deliberately not weaker. The document is derived from
 * committed code, so it holds no tenant data and is byte-identical for every caller; that makes
 * it cheap to serve, not public. It describes the authorable surface of a project, so it is
 * gated exactly like the component list it describes (`GET /api/cli/projects/[id]/components`):
 * a verified CLI token plus `project:view` enforced by the PDP. Read-only is not unauthenticated.
 * There is no query, so there is no tenancy scoping to add on top — `authorizeCli` is the whole
 * boundary here rather than half of it.
 *
 * Cacheable by content hash: the body's `version` is served as the ETag, so a client whose copy
 * has expired revalidates into a 304 with no body instead of refetching the document.
 */
export async function GET(req: Request) {
	const auth = await authorizeCli(req, "view", { type: "project" });
	if ("error" in auth) return auth.error;

	try {
		const document = componentSchemaDocument();
		const etag = `"${document.version}"`;
		const headers = { ETag: etag, "Cache-Control": CACHE_CONTROL };

		const ifNoneMatch = req.headers.get("If-None-Match");
		if (ifNoneMatch && ifNoneMatchHits(ifNoneMatch, etag)) {
			return new NextResponse(null, { status: 304, headers });
		}

		return cliJson(componentSchemaWire, document, { headers });
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
