// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The header `proxy.ts` publishes the request path on, read back by `lib/authz/org-scope.ts`.
 *
 * ITS OWN MODULE ON PURPOSE. `proxy.ts` is bundled for the proxy runtime, and `org-scope.ts`
 * imports the database and the drizzle schema to turn a slug into an org id. Importing the constant
 * from there would drag all of that into the proxy bundle. A leaf with no imports is the seam; the
 * alternative — writing the literal twice — is a header name with two sources of truth, which is
 * the drift this repo has already paid for elsewhere.
 *
 * Set by the proxy with `Headers.set`, so an inbound value from a client is REPLACED, never merged.
 */
export const ORG_PATH_HEADER = "x-alethia-path";
