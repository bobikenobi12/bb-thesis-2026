// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/* The approval UI is a client component (it owns `useSearchParams` and the stage machine),
   and this is the half of it that reads the server's description of the request. */
"use client";

import { useEffect, useState, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { formatDuration } from "@repo/format";
import { Skeleton } from "@repo/ui/skeleton";
import {
	deviceRequestReadOutcome,
	parseDeviceRequestView,
	serverErrorMessage,
	type CliDeviceRequestLifecycle,
	type DeviceRequestRead,
	type CliDeviceRequestView,
	type CliDeviceRequester,
	type DeviceApprovalScope,
} from "@/lib/auth/cli-device-code";

/**
 * What `/cli/login` knows about the request it is being asked to approve.
 *
 * Four phases and not a boolean, because the three non-success ones mean different things to
 * the button:
 *
 *  - `idle`     — the link itself is malformed, so nothing was asked. The page is already in
 *                 its error stage; this exists so "we never asked" is a state rather than a
 *                 `loading` that happens never to end.
 *  - `loading`  — asked, no answer yet. Approve is not offered: a press during this window is
 *                 a consent given to a screen that has not finished saying what it is for.
 *  - `verified` — the server described the request. Note that a described request is not
 *                 necessarily an approvable one; `view.status` still has to be `pending`.
 *  - `unverified` / `refused` — see `deviceRequestReadOutcome`, which is where the difference
 *                 between them is argued. `refused` withdraws the button, `unverified` keeps
 *                 it and makes the gap visible.
 */
export type CliDeviceRequestState =
	| { phase: "idle" }
	| { phase: "loading" }
	| { phase: "verified"; view: CliDeviceRequestView }
	| { phase: "unverified"; reason: string }
	| { phase: "refused"; reason: string };

/**
 * The panel state one read outcome puts the page into, or null for `ok` — where the caller
 * still has to parse the body before it has a view.
 *
 * Written out arm by arm rather than as `{ phase: outcome.kind, reason: outcome.reason }`.
 * The short version leans on TypeScript distributing a union-typed discriminant across a
 * discriminated union, which it does, and which makes the one place the two vocabularies meet
 * unreadable — `kind` is the READ's answer and `phase` is the PANEL's, and they agree only by
 * coincidence of spelling.
 */
function stateFor(outcome: DeviceRequestRead): CliDeviceRequestState | null {
	if (outcome.kind === "refused") return { phase: "refused", reason: outcome.reason };
	if (outcome.kind === "unverified") return { phase: "unverified", reason: outcome.reason };
	return null;
}

/**
 * Reads `GET /api/auth/cli/request` so the consent screen can name what it is consenting to.
 *
 * THIS IS THE ONE THING ON THIS PAGE THAT RUNS AS A CONSEQUENCE OF RENDERING, and the reason
 * that is allowed here is the reason it was forbidden in #2213: what mattered was never
 * "a fetch on mount", it was WHICH fetch. #2213's was `POST /api/auth/cli/generate` — the
 * approval itself, fired with no gesture, which bound a victim's account to a phished device
 * code merely because they opened the link. This one is a session-gated GET that decides
 * nothing and writes nothing; the worst a phished link can do with it is show its own sender's
 * details to the person deciding, which is the entire point of showing them.
 *
 * The invariant `page.tsx` states is therefore unchanged and still checkable: `approveDevice`
 * has exactly one caller, the Approve button.
 *
 * It cannot be a server read the way the ACCOUNT is (see `cli-session.tsx`). That one is a
 * session fact and a layout can get it; this one is keyed on `device_code` and `user_code`,
 * and a layout cannot read `searchParams` at all.
 *
 * @param deviceCode the device code from the link, or null when the link is malformed.
 * @param userCode the user code from the link, or null when the link is malformed.
 */
export function useCliDeviceRequest(
	deviceCode: string | null,
	userCode: string | null,
): CliDeviceRequestState {
	// ONLY THE ANSWER IS STATE. `idle` and `loading` are derived below from the arguments and
	// from whether an answer has arrived, so nothing in the effect BODY writes state — the only
	// `setAnswered` calls are inside the async callback, which is the subscribe-to-an-external-
	// source shape `react-hooks/set-state-in-effect` describes as the correct one. The obvious
	// version, seeding `loading` and re-seeding it from the effect, writes state twice on every
	// mount to express something both reads already know.
	//
	// The answer is KEYED on the codes it was fetched for. The abort below already stops a
	// resolved fetch touching a component that has moved on, but an abort is a race the key is
	// not: an answer about a device_code the page is no longer showing can never be rendered as
	// though it were about the current one.
	const requestKey = deviceCode && userCode ? `${deviceCode} ${userCode}` : null;
	const [answered, setAnswered] = useState<{
		key: string;
		state: CliDeviceRequestState;
	} | null>(null);

	useEffect(() => {
		if (!deviceCode || !userCode) return;
		const key = `${deviceCode} ${userCode}`;
		const setState = (state: CliDeviceRequestState) => setAnswered({ key, state });

		// Aborted on unmount, and the abort is checked before every `setState`. Without it a
		// StrictMode double-mount (and every fast navigation away) resolves into a component
		// that is gone, which React reports as an update-on-unmounted warning.
		const controller = new AbortController();

		const query = new URLSearchParams({
			device_code: deviceCode,
			user_code: userCode,
		});

		void (async () => {
			try {
				const response = await fetch(`/api/auth/cli/request?${query}`, {
					signal: controller.signal,
					headers: { accept: "application/json" },
					// The answer names the signed-in account and the requester's IP, and its
					// countdown is only correct at the instant it was computed. The route says
					// `no-store`; saying it here too means a bfcache restore or a back-button
					// return re-asks rather than re-showing a decision window that has closed.
					cache: "no-store",
				});
				const body: unknown = await response.json().catch(() => null);
				if (controller.signal.aborted) return;

				const failed = stateFor(
					deviceRequestReadOutcome(
						response.status,
						response.ok ? null : serverErrorMessage(body, ""),
					),
				);
				if (failed) {
					setState(failed);
					return;
				}

				const view = parseDeviceRequestView(body);
				if (!view) {
					// A 200 whose body is not the documented shape is not a described request.
					// Treating it as one is how a consent screen renders `undefined` as a blank
					// and the blank reads as an answer.
					setState({
						phase: "unverified",
						reason:
							"Alethia could not read the details of this login request. Nothing below has been checked against the server.",
					});
					return;
				}
				setState({ phase: "verified", view });
			} catch {
				if (controller.signal.aborted) return;
				// No status at all — a transport failure. Unknown, not known-broken, so the
				// screen warns rather than withdrawing the button. See deviceRequestReadOutcome,
				// which never answers `ok` without one, hence the `?? { phase: "loading" }` that
				// is unreachable rather than meaningful.
				setState(stateFor(deviceRequestReadOutcome(null)) ?? { phase: "loading" });
			}
		})();

		return () => controller.abort();
	}, [deviceCode, userCode]);

	if (requestKey === null) return { phase: "idle" };
	return answered?.key === requestKey ? answered.state : { phase: "loading" };
}

/** How often the decision countdown re-reads the clock. */
const COUNTDOWN_TICK_MS = 1_000;

/**
 * Milliseconds left before a request's decision window closes, ticking down, or null when the
 * request carries no deadline.
 *
 * It reaches zero rather than going negative, and the caller treats zero as expired — so the
 * screen stops offering a button at the moment the button would stop working, instead of
 * offering one that fails on press. That is the difference between a countdown that is
 * decoration and one that is a control.
 *
 * `null` for a row with no `pending_expires_at` (a client too old to register one). The caller
 * says so in words; it must not render as `0s`, which would read as "expired".
 */
export function useRemainingMs(expiresAt: string | null): number | null {
	const deadline = expiresAt === null ? null : Date.parse(expiresAt);
	const usable = deadline !== null && Number.isFinite(deadline) ? deadline : null;

	// THE CLOCK IS THE STATE; the remaining time is derived from it. The obvious shape — hold
	// `remaining` in state and `setRemaining` from the effect — reads the clock in a render
	// expression and writes state synchronously in an effect body, which is what
	// `react-hooks/purity` and `react-hooks/set-state-in-effect` are both pointing at. Here the
	// only writer is the interval CALLBACK, which is the subscribe-to-an-external-source shape
	// those rules describe as correct, and the one clock read is a LAZY initialiser that runs
	// once.
	//
	// The consequence worth knowing: between mount and the first tick, `now` is as old as the
	// read that produced `expiresAt` — a few hundred milliseconds on a live request. It costs a
	// countdown that starts fractionally high and is corrected within a second, and it buys a
	// deadline already in the past being reported as closed on the FIRST render rather than one
	// tick later, which is the case that actually matters.
	const [now, setNow] = useState(() => Date.now());

	useEffect(() => {
		if (usable === null) return;
		const timer = setInterval(() => setNow(Date.now()), COUNTDOWN_TICK_MS);
		return () => clearInterval(timer);
	}, [usable]);

	return usable === null ? null : Math.max(0, usable - now);
}

/**
 * One labelled fact about the requester.
 *
 * `<dt>`/`<dd>` rather than two spans: these are label/value pairs, and a screen reader that
 * cannot tell which half is which reads the block as a run-on sentence — on the one screen
 * where the reader is being asked to judge whether the values look right.
 */
function RequesterFact({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex flex-wrap items-baseline gap-x-2">
			<dt className="shrink-0 text-xs text-text-tertiary">{label}</dt>
			{/* `break-all` and not `truncate`. These strings are bounded to 200 characters by
			    `clientMetadataField`, so they cannot flood the card — but a user-agent is one
			    long token, and truncating the value a person is being asked to judge hides the
			    end of it behind an ellipsis. Wrapping shows all of it. */}
			<dd className="min-w-0 break-all font-mono text-xs text-text-secondary">{value}</dd>
		</div>
	);
}

/**
 * Who registered this login request.
 *
 * THE TRUST BOUNDARY RUNS THROUGH THE MIDDLE OF THIS BLOCK, and the block is laid out to say
 * so. `client_name`, `client_version` and `user_agent` come from an unauthenticated process
 * that can put any string it likes in them; `request_ip` is what the trusted proxy header
 * carried. They are therefore introduced by different words — "The device says it is" against
 * "Alethia saw the request come from" — rather than listed as four peers, because a device
 * that could name itself in the same voice the server uses could name itself anything.
 *
 * The strings themselves are normalised by `clientMetadataField` on the way in
 * (`parseDeviceRequestView`): bounded to 200 characters, control characters and bidi overrides
 * neutralised, whitespace runs collapsed. React escapes the markup. What is left is a string
 * that renders as itself.
 */
function RequesterBlock({ requester }: { requester: CliDeviceRequester }) {
	const claimed: Array<{ label: string; value: string }> = [];
	if (requester.client_name) {
		claimed.push({ label: "Client", value: requester.client_name });
	}
	if (requester.client_version) {
		claimed.push({ label: "Version", value: requester.client_version });
	}
	if (requester.user_agent) {
		claimed.push({ label: "User agent", value: requester.user_agent });
	}

	// Nothing at all is a real answer here and gets its own sentence. A block that simply
	// disappeared would leave the reader unable to tell "no client details" from "we did not
	// look", and the second is the thing this whole screen is about.
	if (claimed.length === 0 && !requester.request_ip) {
		return (
			<p className="text-xs text-text-secondary">
				The device did not say anything about itself, and Alethia did not record where
				the request came from.
			</p>
		);
	}

	return (
		<div className="space-y-2">
			{claimed.length > 0 ? (
				<div
					role="group"
					aria-label="Details the device reported about itself"
					className="space-y-1"
				>
					<p className="text-xs text-text-secondary">
						The device says it is{" "}
						<span className="text-text-tertiary">(it could say anything)</span>:
					</p>
					<dl className="space-y-0.5">
						{claimed.map((fact) => (
							<RequesterFact key={fact.label} label={fact.label} value={fact.value} />
						))}
					</dl>
				</div>
			) : (
				<p className="text-xs text-text-secondary">
					The device did not say what it is.
				</p>
			)}

			{requester.request_ip ? (
				<p className="text-xs text-text-secondary">
					Alethia saw the request come from{" "}
					<span className="font-mono text-text-primary">{requester.request_ip}</span>.
				</p>
			) : (
				<p className="text-xs text-text-secondary">
					Alethia did not record where the request came from.
				</p>
			)}
		</div>
	);
}

/**
 * The decision deadline, in words.
 *
 * `formatDuration` from `@repo/format` rather than a local `Math.floor(ms / 60000)`: a plan
 * card and a consent screen disagreeing about how to write four and a half minutes is exactly
 * what the shared formatter exists to stop.
 */
function DeadlineLine({ remainingMs }: { remainingMs: number | null }) {
	if (remainingMs === null) {
		return (
			<p className="text-xs text-text-secondary">
				This request carries no deadline, because the client that started it did not
				register one.
			</p>
		);
	}
	return (
		<p className="text-xs text-text-secondary">
			This request expires in{" "}
			<span className="font-mono text-text-primary">{formatDuration(remainingMs)}</span>.
		</p>
	);
}

/**
 * What approving this hands to the terminal, as the SERVER enumerates it.
 *
 * The list used to be three `<li>`s written into `page.tsx` by hand, which was the honest
 * thing to do before `/api/auth/cli/request` existed and is the wrong thing to do now: the
 * route derives its lines from `deviceApprovalScopes`, the same function
 * `/api/auth/cli/generate` reads when it decides which git-provider token to stash. One list,
 * so a provider added to the stash cannot become a token the screen never named.
 */
function ScopeList({ scopes }: { scopes: DeviceApprovalScope[] }) {
	return (
		<ul className="space-y-1.5">
			{scopes.map((scope) => (
				<li key={scope.id} className="text-xs text-text-secondary">
					<span className="font-medium text-text-primary">{scope.label}</span>
					{" — "}
					{scope.detail}
				</li>
			))}
		</ul>
	);
}

/**
 * The consent block: which account, what is handed over, who is asking, how long is left.
 *
 * Those four are #3889's whole subject — "a user is asked to approve something the screen does
 * not describe" — and they are rendered together rather than scattered, so that the reader's
 * eye finds the decision in one place and so that a future edit cannot drop one of them
 * without the omission being obvious in this file.
 */
export function CliRequestDetails({
	view,
	account,
	remainingMs,
}: {
	view: CliDeviceRequestView;
	/** The signed-in account from `cli-session.tsx` — the page's single source for it. */
	account: string | null;
	remainingMs: number | null;
}) {
	return (
		<div className="space-y-3 border border-border/60 bg-surface-sunken/40 px-4 py-3">
			<div className="space-y-1.5">
				<p className="text-xs font-medium text-text-primary">
					Approving gives that terminal
				</p>
				<ScopeList scopes={view.scopes} />
			</div>

			{account ? (
				<p className="text-xs text-text-secondary">
					Signed in as{" "}
					<span className="font-medium text-text-primary">{account}</span>. Approval
					binds the terminal to this account.
				</p>
			) : null}

			<div className="space-y-1.5 border-t border-border/60 pt-3">
				<p className="text-xs font-medium text-text-primary">Who is asking</p>
				<RequesterBlock requester={view.requester} />
				<DeadlineLine remainingMs={remainingMs} />
			</div>
		</div>
	);
}

/**
 * Said when the request could not be described, above a button that still works.
 *
 * This is the honest form of `unverified`: the screen cannot name the requester or the
 * deadline, so it says that it cannot, in place of the block it would otherwise draw. The
 * alternative was to render the block with every field blank, and a consent screen whose
 * empty fields look like answers is the failure `/api/auth/cli/request` returns 404 to avoid
 * — reproducing it in the client would defeat the endpoint's own design.
 *
 * The scope list survives, because it does not depend on the request: `deviceApprovalScopes`
 * is the same function the route calls, so these are the server's words for the two tokens
 * every approval hands over. What it cannot know without the server is whether a git-provider
 * token joins them, and the caveat below says exactly that rather than guessing either way.
 */
export function CliRequestUnverified({
	reason,
	scopes,
	account,
}: {
	reason: string;
	scopes: DeviceApprovalScope[];
	account: string | null;
}) {
	// DASHED, and that is the whole visual difference from the block next door. The design
	// system is grayscale — `packages/brand/src/tokens.css` has no warning hue, and
	// `--signal-critical` is the same gray as everything else — so a caveat cannot be
	// coloured into legibility. A broken border is the one thing on this card that reads
	// as "provisional" without borrowing a meaning the palette does not carry.
	//
	// `role="status"` rather than `role="alert"`: this is the state the panel is in when
	// it first paints, and an assertive live region announcing it would interrupt a
	// screen-reader user mid-heading.
	//
	// The comment lives HERE, not inside the parentheses. `{/* … */}` is JSX syntax and is only
	// legal INSIDE an element; as the first thing after `return (` it makes TypeScript read the
	// parenthesised expression as an object literal, which is what `TS1005: ')' expected` and
	// `TS2657: JSX expressions must have one parent element` were reporting.
	return (
		<div
			role="status"
			className="space-y-3 border border-dashed border-border bg-surface-sunken/40 px-4 py-3"
		>
			<div className="space-y-1.5">
				<p className="flex items-center gap-1.5 text-xs font-medium text-text-primary">
					<AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
					Alethia cannot describe this request
				</p>
				<p className="text-xs text-text-secondary">{reason}</p>
				{/* THE PHISHING SHAPE, NAMED. This is the state a link from an attacker reaches
				    most easily — an unregistered device_code leaves no row, so the read 404s —
				    and the button is still on offer for the compatibility reason argued in
				    `deviceRequestReadOutcome`. What the reader gets instead of a refusal is the
				    one test they can actually apply: did YOU just run the command. The page's
				    closing line says something similar for every state; this says it where the
				    screen has nothing else to offer. */}
				<p className="text-xs text-text-secondary">
					Approve it only if you ran <code>alethia login</code> yourself, just now, in a
					terminal you are looking at.
				</p>
			</div>

			<div className="space-y-1.5 border-t border-border/60 pt-3">
				<p className="text-xs font-medium text-text-primary">
					Approving still gives that terminal
				</p>
				<ScopeList scopes={scopes} />
				<p className="text-xs text-text-secondary">
					…and, if you have a git provider linked, its access token. Alethia could not
					check which, so this list may be incomplete.
				</p>
			</div>

			{account ? (
				<p className="text-xs text-text-secondary">
					Signed in as{" "}
					<span className="font-medium text-text-primary">{account}</span>. Approval
					binds the terminal to this account.
				</p>
			) : null}
		</div>
	);
}

/**
 * The detail block's shape while the request is being read.
 *
 * It draws the block that is coming rather than a spinner, for the reason `loading.tsx` gives
 * next door: the picture a card falls back to must not be a second, different picture of that
 * card. The Approve button is withheld for as long as this is on screen — a press against a
 * skeleton is consent given to a screen that has not finished saying what it is for.
 */
export function CliRequestDetailsSkeleton() {
	return (
		<div
			className="space-y-2 border border-border/60 px-4 py-3"
			aria-busy="true"
			aria-label="Loading the details of this login request"
		>
			<Skeleton className="h-3 w-40" />
			<Skeleton className="h-2.5 w-52" />
			<Skeleton className="h-2.5 w-56" />
			<Skeleton className="h-2.5 w-48" />
		</div>
	);
}

/**
 * What each terminal life of a request says to somebody who just opened its link.
 *
 * Keyed off the lifecycle union with `pending` excluded, so adding a fifth life to
 * `CLI_DEVICE_REQUEST_LIFECYCLES` fails to type-check here rather than falling through to a
 * blank panel. Every one of these withdraws the Approve button, and each says why in its own
 * words — "already approved" and "expired" are not the same news, and only one of them is
 * worth acting on.
 */
const CLOSED_REQUEST_COPY: Record<
	Exclude<CliDeviceRequestLifecycle, "pending">,
	{ heading: string; body: ReactNode }
> = {
	approved: {
		heading: "This request has already been approved",
		// THE TOKENS HAVE NOT BEEN HANDED OVER YET, and that is what makes this panel worth
		// reading rather than worth apologising for. `/api/auth/cli/exchange` claims a row by
		// DELETING it (`isNotNull(profile_id)` in its predicate), so a request the read can still
		// describe as `approved` is one the terminal has not collected — and `/api/auth/cli/deny`
		// clears `profile_id`, after which the claiming DELETE matches nothing. Refusing here
		// genuinely stops the handover.
		//
		// It used to end "and change your password", which named an action the product does not
		// have: `lib/auth/index.ts` sets `emailAndPassword: { enabled: false }` and sign-in is
		// OTP/OAuth only. A remediation nobody can perform is worse than none — it sends somebody
		// hunting for a setting that does not exist while the one thing that would help is a
		// button already on screen.
		body: (
			<>
				The terminal that started it has not collected its tokens yet. If that approval was
				not yours, refuse it below — the refusal clears the binding, so there is nothing left
				for the device to collect.
			</>
		),
	},
	denied: {
		heading: "This request was already refused",
		body: (
			<>Nothing was shared, and it cannot be approved later. You can close this window.</>
		),
	},
	expired: {
		heading: "This request has expired",
		// `<code>`, not backticks. This panel renders its body as text, so the grave accents were
		// on screen — on the one line that tells somebody exactly what to type, and in the one
		// place on this page where the same command is not already marked up the same way.
		body: (
			<>
				Its decision window has closed, so approving it would do nothing. Run{" "}
				<code>alethia login</code> again to start a new one.
			</>
		),
	},
};

/**
 * Said in place of the consent block when there is nothing left to consent to — either the
 * request has reached a terminal life, or the server refused to describe it at all.
 *
 * The panel and the missing button are one decision: a screen that explains why approval is
 * pointless while still offering it teaches the reader that the explanation is decoration.
 */
export function CliRequestClosed({
	heading,
	body,
}: {
	heading: string;
	body: ReactNode;
}) {
	return (
		<div
			role="status"
			className="space-y-1.5 border border-border/60 bg-surface-sunken/40 px-4 py-3"
		>
			<p className="text-xs font-medium text-text-primary">{heading}</p>
			<p className="text-xs text-text-secondary">{body}</p>
		</div>
	);
}

/** The copy for a request that has reached one of its terminal lives. */
export function closedRequestCopy(
	lifecycle: Exclude<CliDeviceRequestLifecycle, "pending">,
) {
	return CLOSED_REQUEST_COPY[lifecycle];
}
