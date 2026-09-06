// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Canonical organization URL. The console is the microfrontends *default* zone,
// served at the app root, so an org lives at `{host}/{slug}` (e.g.
// `alethialabs.io/acme`) — never a `console.` subdomain. Single source of truth
// for the host shown in onboarding + settings.

import { env } from "next-runtime-env";

/** Canonical brand host when the runtime origin is unset (dev/self-host). */
const DEFAULT_HOST = "alethialabs.io";

/** The bare host the console is served at (no protocol / trailing slash),
 *  derived from NEXT_PUBLIC_APP_URL. Falls back to the canonical brand host. */
export function orgHost(): string {
	const raw = env("NEXT_PUBLIC_APP_URL");
	if (!raw) return DEFAULT_HOST;
	try {
		return new URL(raw).host || DEFAULT_HOST;
	} catch {
		return raw.replace(/^https?:\/\//, "").replace(/\/+$/, "") || DEFAULT_HOST;
	}
}

/** Display URL for an organization, e.g. `alethialabs.io/acme`. */
export function orgUrl(slug: string): string {
	return `${orgHost()}/${slug}`;
}

