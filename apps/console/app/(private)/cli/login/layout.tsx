// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { headers } from "next/headers";
import { AuthCard, AuthShell } from "@/components/auth/auth-shell";
import { auth } from "@/lib/auth";
import { pageMetadata } from "@/lib/seo/page-metadata";
import { CliAccountProvider } from "./cli-session";

// The page itself is a client component (it owns the approval gesture and its stages), so it
// cannot export metadata. This layout is where the route's title lives.
export const metadata = pageMetadata({
	title: "Approve CLI sign-in",
	description: "Confirm the device code your terminal printed to sign the Alethia CLI in.",
});

/**
 * Which account an approval on this page would bind — read here, on the server, so the
 * approval UI needs no request of its own.
 *
 * Best-effort by design, and it mirrors `lib/auth/owner.ts`'s `safeGetSession`: a stale token
 * that the optimistic proxy let through makes the session-table read throw, and this page must
 * still render the approval prompt in that case rather than 500. The consequence is stated
 * where it lands — `null` omits the line rather than showing an empty or guessed identity.
 *
 * It is NOT an authorization gate, and must not be mistaken for one. The gate is
 * `/api/auth/cli/generate`, which 401s without a session and refuses a device code already
 * bound to another account. Gating here would also be actively worse than the proxy that
 * already does it: a layout cannot read `searchParams`, so any `next=` it built would drop
 * `device_code`/`user_code` and strand the user on an error state after signing in.
 */
async function signedInEmail(): Promise<string | null> {
	try {
		const session = await auth.api.getSession({ headers: await headers() });
		return session?.user?.email ?? null;
	} catch (error) {
		console.error("[cli-login] session lookup failed:", error);
		return null;
	}
}

/**
 * The frame for `/cli/login` — and #3834 left the question of whether there should be one to
 * this issue. The answer is yes, and it belongs HERE rather than in `page.tsx`.
 *
 * The shell was mounted from inside the page, which is why the route scored FAIL on both of
 * RUBRIC.md's width predicates while visibly wearing the right chrome. S1 asks whether a known
 * shell is mounted somewhere in the LAYOUT CHAIN, and S2 asks whether the one max-width
 * governing the content comes from that shell rather than from the page — a page that mounts
 * its own shell answers "no" to both, and the next screen added to this segment would have had
 * to remember to mount it again. Moving the two lines up makes the pass-through layout the
 * thing that carries the route, and `loading.tsx` next door then renders inside the same card
 * instead of over a bare viewport.
 *
 * `AuthShell` is a client component; rendering one from a server layout is ordinary, and it is
 * what keeps `metadata` above exportable.
 */
export default function CliLoginLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	// NOT awaited here. This layout sits ABOVE the Suspense boundary `loading.tsx` creates, so
	// awaiting the session would block the shell and the skeleton behind it — the blank viewport
	// that skeleton exists to remove. The promise is handed down and resolved with `use()` inside
	// `page.tsx`'s own boundary. `signedInEmail` never rejects (it catches and returns null), so an
	// un-awaited promise cannot surface as an unhandled rejection.
	const email = signedInEmail();
	return (
		<AuthShell>
			<AuthCard>
				<CliAccountProvider email={email}>{children}</CliAccountProvider>
			</AuthCard>
		</AuthShell>
	);
}
