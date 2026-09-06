// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/* Reached from both graphs — the server `layout.tsx` renders the provider, the client
   `page.tsx` calls the hook — so the boundary is declared rather than inferred, for the
   reason `components/auth/auth-shell.tsx` states at its top. */
"use client";

import { createContext, use, useContext } from "react";

/**
 * The account the approval would bind, resolved on the server and handed down.
 *
 * WHY A CONTEXT AND NOT A FETCH. `/cli/login` has to name the signed-in account — a person
 * may be signed into more than one, and approval binds *this* session's — but the identity
 * is a server fact and the approval UI is a client component (it owns `useSearchParams` and
 * the stage machine). A context lets `layout.tsx` read the session once, on the server, with
 * no request from the browser at all. The alternative was a `useEffect` fetch on mount, and
 * this page is #2213: it is worth a great deal that NOTHING here runs as a consequence of
 * rendering.
 *
 * `null` is a first-class value, not a bug: the session read is best-effort (see
 * `layout.tsx`), and a page rendered without the provider — which is how the unit tests
 * render it — gets `null` and simply omits the line. It must never be shown as "unknown
 * account" or as an empty string beside "Approving as".
 */
const CliAccountContext = createContext<Promise<string | null> | null>(null);

/**
 * Publishes the signed-in account's email to the approval UI below it.
 *
 * IT TAKES THE PROMISE, NOT THE RESOLVED VALUE, and that is the whole point. Next renders a
 * layout ABOVE the Suspense boundary `loading.tsx` creates — `<Layout><Suspense fallback=…>` —
 * so a layout that awaits the session resolves before the skeleton can paint, and a slow session
 * read reproduces exactly the blank viewport that skeleton was added to remove. Handing the
 * un-awaited promise down moves the wait to `use()` in `useCliAccount`, which runs inside
 * `page.tsx`'s own `<Suspense>`: the shell, the card and the heading paint immediately and the
 * body skeleton covers the account line until it arrives.
 */
export function CliAccountProvider({
	email,
	children,
}: {
	email: Promise<string | null>;
	children: React.ReactNode;
}) {
	return (
		<CliAccountContext.Provider value={email}>
			{children}
		</CliAccountContext.Provider>
	);
}

/**
 * The signed-in account's email, or `null` when it could not be resolved.
 *
 * `use()` is called conditionally on purpose, which is legal for `use` and for nothing else in
 * React: a page rendered WITHOUT the provider — which is how the unit tests render it — reads the
 * context default and must get `null` without suspending on a promise that does not exist.
 */
export function useCliAccount(): string | null {
	const pending = useContext(CliAccountContext);
	return pending === null ? null : use(pending);
}
