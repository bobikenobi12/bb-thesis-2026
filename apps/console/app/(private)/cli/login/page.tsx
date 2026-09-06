"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { CheckCircle, Loader2, XCircle } from "lucide-react";
import { Button } from "@repo/ui/button";
import {
	deviceApprovalScopes,
	isValidDeviceCode,
	isValidUserCode,
	serverErrorMessage,
} from "@/lib/auth/cli-device-code";
import { useCliAccount } from "./cli-session";
import {
	CliRequestClosed,
	CliRequestDetails,
	CliRequestDetailsSkeleton,
	CliRequestUnverified,
	closedRequestCopy,
	useCliDeviceRequest,
	useRemainingMs,
} from "./cli-request";
import { CliLoginBodySkeleton } from "./loading";

type Stage = "confirm" | "approving" | "declining" | "approved" | "declined" | "error";

/**
 * The browser half of the CLI device flow (RFC 8628). It approves NOTHING on mount:
 * it shows the `user_code` the terminal printed and waits for an explicit press.
 *
 * That gesture is the whole security boundary. The device code is client-chosen, so a
 * link like /cli/login?device_code=<attacker-uuid> could be sent to any signed-in user;
 * when this page auto-approved on mount, opening it bound the victim's account to the
 * attacker's code and handed the attacker's polling CLI the victim's access token,
 * 90-day refresh token and raw git-provider OAuth token. The user must be able to see
 * WHAT they are approving and choose to approve it.
 *
 * THE INVARIANT, STATED SO IT SURVIVES THE NEXT REFACTOR: `approveDevice` has exactly one
 * caller — the Approve button's `onClick` below. No `useEffect` may call it, and neither
 * may anything that runs as a consequence of rendering. #2213 was not a bug in the fetch;
 * it was a bug in WHO started it.
 *
 * There IS now a fetch on mount, and it does not touch that invariant: `useCliDeviceRequest`
 * issues a session-gated GET that decides nothing and writes nothing, so it can be read as the
 * screen finding out what it is about to ask for. The rule the invariant states is about
 * `approveDevice`, and it is the rule a reader should check — not "does this file contain a
 * useEffect", which was never the property that mattered.
 *
 * #3889 is the other half of the same argument. A gesture is only worth what the person knew
 * when they made it, so the Approve button is offered only where this screen has SAID what
 * approving does — see `approvable` below, and `deviceRequestReadOutcome` for the one failure
 * mode where it is offered with the gap named instead.
 */
function CliLoginContent() {
	const account = useCliAccount();
	const searchParams = useSearchParams();
	const deviceCode = searchParams.get("device_code");
	const userCode = searchParams.get("user_code");
	const linkIsWellFormed =
		isValidDeviceCode(deviceCode) && isValidUserCode(userCode);

	const [stage, setStage] = useState<Stage>(
		linkIsWellFormed ? "confirm" : "error",
	);
	const [error, setError] = useState(
		linkIsWellFormed
			? ""
			: "This link is not a valid CLI login request. Run `alethia login` and open the link it prints.",
	);

	// #3889. The server's description of what is being approved — which account, what is handed
	// over, who is asking, how long is left. Read on mount, and only ever READ: see the note on
	// `useCliDeviceRequest` for why a GET here does not reopen #2213, which was about a POST.
	//
	// Passed nulls for a malformed link, so nothing is asked about a request that does not
	// parse. The page is already in its error stage in that case.
	const request = useCliDeviceRequest(
		linkIsWellFormed ? deviceCode : null,
		linkIsWellFormed ? userCode : null,
	);
	const remainingMs = useRemainingMs(
		request.phase === "verified" ? request.view.expires_at : null,
	);

	// The countdown reaching zero is a STATE CHANGE, not a number hitting a bound: the decision
	// window has closed, `/api/auth/cli/generate` will refuse, and the button has to go. Reading
	// it here rather than re-fetching means the screen closes at the same instant the server
	// does, without a poll.
	const windowClosed = remainingMs !== null && remainingMs <= 0;
	const lifecycle =
		request.phase === "verified"
			? windowClosed && request.view.status === "pending"
				? "expired"
				: request.view.status
			: null;

	// THE GATE THIS ISSUE IS ABOUT. Approve is offered only where the screen has said what
	// approving does:
	//   · `verified` + `pending` — the request is described and live.
	//   · `unverified`           — the detail could not be READ, which is not the same as the
	//                              request being bad. Withdrawing the button here would sign out
	//                              every already-shipped `alethia login`, which never registers
	//                              and so leaves nothing to read. The screen states the gap in
	//                              place of the detail rather than rendering blanks as answers.
	// Everything else — still loading, refused by the server, or already approved/denied/expired
	// — offers no Approve at all.
	const approvable =
		request.phase === "unverified" ||
		(request.phase === "verified" && lifecycle === "pending");

	// The lifecycle with `pending` taken out, so `closedRequestCopy` is reached with a value
	// its map is total over. Deriving it here rather than asserting at the call site is what
	// makes a fifth lifecycle a compile error instead of an undefined heading.
	const closedLifecycle =
		lifecycle === null || lifecycle === "pending" ? null : lifecycle;

	/** Binds this device code to the signed-in account — only ever from the button. */
	async function approveDevice() {
		setStage("approving");
		try {
			const response = await fetch("/api/auth/cli/generate", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ device_code: deviceCode, user_code: userCode }),
			});

			if (!response.ok) {
				const body: unknown = await response.json().catch(() => null);
				setError(serverErrorMessage(body, "Failed to approve device."));
				setStage("error");
				return;
			}
			setStage("approved");
		} catch {
			setError("Could not reach the control plane. Please try again.");
			setStage("error");
		}
	}

	/**
	 * Records the refusal SERVER-SIDE — only ever from the "This isn't me" button.
	 *
	 * This page used to call `setStage("declined")` and nothing else, and said so honestly in
	 * the declined copy below: the refusal lived in React state, so re-opening the link offered
	 * the prompt again and the polling CLI never learned it had been refused. That was #3887,
	 * which this file's own comment pointed at — and it has since landed, so the button can now
	 * do what the screen always claimed.
	 *
	 * A failure is SURFACED rather than swallowed. Telling somebody their refusal was recorded
	 * when it was not is worse than telling them to close the terminal.
	 */
	async function declineDevice() {
		setStage("declining");
		try {
			const response = await fetch("/api/auth/cli/deny", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ device_code: deviceCode, user_code: userCode }),
			});
			if (!response.ok) {
				const body: unknown = await response.json().catch(() => ({}));
				setError(
					serverErrorMessage(
						body,
						// NOT the approval fallback. A deny that fails with a body carrying no
						// `error` — a 502 HTML page from the proxy, a Next error page, an edge
						// rate-limit page — would otherwise tell somebody who pressed "This isn't
						// me" that APPROVAL failed, and drop the one instruction that matters when
						// a refusal did not record. The sibling `catch` arm below says the same
						// thing for the same reason.
						"Could not record the refusal. Close your terminal to be sure nothing is shared.",
					),
				);
				setStage("error");
				return;
			}
			setStage("declined");
		} catch {
			setError(
				"Could not reach the control plane to record the refusal. Close your terminal to be sure nothing is shared.",
			);
			setStage("error");
		}
	}

	if (stage === "confirm" || stage === "approving" || stage === "declining") {
		const busy = stage === "approving" || stage === "declining";
		return (
			<div className="flex flex-col gap-6">
				<div className="space-y-2 text-center">
					<p className="text-sm font-medium text-text-primary">
						Confirm the code from your terminal
					</p>
					<p className="text-xs text-text-secondary">
						A device is asking to sign in to your account. Approve it only if this
						code matches the one <code>alethia login</code> printed.
					</p>
				</div>

				{/* The code is set at a display size rather than at a `--text-ui-*` rung, and that
				    is a decision rather than drift: the reader is character-matching this string
				    against a terminal, one glyph at a time, and legibility of a code being typed
				    is not reading type. It is the same call the maintainer made for the sign-in
				    OTP input on 2026-09-02. `text-2xl` and not a hardcoded `text-[24px]`, so it
				    stays on a scale rather than becoming a number this file invented.

				    The REGISTERED code once one is known, and the link's only until then. They
				    are equal by construction whenever both exist — `/api/auth/cli/request` 409s
				    on a disagreement — and preferring the server's is what makes this plate mean
				    "what the terminal printed" rather than "what the link said", which is the
				    only reading under which comparing it by eye is worth anything. */}
				<div
					className="border border-border bg-surface-sunken py-4 text-center font-mono text-2xl tracking-[0.3em] text-text-primary"
					aria-label="Device confirmation code"
				>
					{request.phase === "verified" ? request.view.user_code : userCode}
				</div>

				{/* WHAT IS BEING APPROVED. This block used to be three `<li>`s written by hand in
				    this file, plus a comment saying the requester and the deadline were "#3889's
				    server half" and could not be shown. That half landed (#4035):
				    `/api/auth/cli/request` answers with the scopes `deviceApprovalScopes` emits —
				    the same function `/api/auth/cli/generate` reads when it decides which
				    git-provider token to stash — along with the account, the requester and the
				    pending deadline. The screen reads them rather than restating them, so a
				    provider added to the stash cannot become a token this list never named.

				    Every arm renders SOMETHING. There is no branch in which the panel is absent,
				    because "no panel" and "a panel with nothing in it" are how a reader ends up
				    consenting to a description that was never given. */}
				{request.phase === "verified" && closedLifecycle === null ? (
					<CliRequestDetails
						view={request.view}
						account={account}
						remainingMs={remainingMs}
					/>
				) : closedLifecycle !== null ? (
					<CliRequestClosed {...closedRequestCopy(closedLifecycle)} />
				) : request.phase === "unverified" ? (
					<CliRequestUnverified
						reason={request.reason}
						// `deviceApprovalScopes(null)` — the server's own words for the two tokens
						// EVERY approval hands over, from the same function the route calls. What
						// it cannot know without the server is whether a git-provider token joins
						// them, and `CliRequestUnverified` says exactly that instead of guessing.
						scopes={deviceApprovalScopes(null)}
						account={account}
					/>
				) : request.phase === "refused" ? (
					<CliRequestClosed
						heading="Alethia will not approve this request"
						body={request.reason}
					/>
				) : (
					<CliRequestDetailsSkeleton />
				)}

				<div className="flex flex-col gap-2">
					{/* ABSENT rather than disabled where approval is not on offer. A greyed-out
					    Approve invites the reader to look for the thing that would enable it,
					    which on a refused or expired request is nothing — and on a still-loading
					    one is a wait they should not be made to watch for. The refuse button
					    stays in every case: refusing is the safe direction, `/api/auth/cli/deny`
					    revokes an approval as well as pre-empting one, and its own failure is
					    surfaced honestly by `declineDevice`. */}
					{approvable ? (
						<Button onClick={approveDevice} disabled={busy}>
							{stage === "approving" ? (
								<>
									<Loader2 className="h-4 w-4 animate-spin" />
									Approving…
								</>
							) : (
								"Approve"
							)}
						</Button>
					) : null}
					<Button variant="ghost" onClick={declineDevice} disabled={busy}>
						{stage === "declining" ? (
							<>
								<Loader2 className="h-4 w-4 animate-spin" />
								Recording…
							</>
						) : (
							"This isn't me"
						)}
					</Button>
				</div>

				<p className="text-center text-xs text-text-secondary">
					If you did not start this sign-in, do not approve it.
				</p>
			</div>
		);
	}

	if (stage === "approved") {
		return (
			<div className="flex flex-col items-center justify-center gap-4">
				<div className="h-12 w-12 rounded-full bg-surface-muted flex items-center justify-center">
					<CheckCircle className="h-6 w-6 text-text-primary" />
				</div>
				<div className="text-center space-y-1">
					<p className="text-sm font-medium text-text-primary">
						Authentication successful
					</p>
					<p className="text-xs text-text-secondary">
						You can close this window and return to your terminal.
					</p>
				</div>
			</div>
		);
	}

	if (stage === "declined") {
		return (
			<div className="flex flex-col items-center justify-center gap-4">
				<div className="h-12 w-12 rounded-full bg-surface-muted flex items-center justify-center">
					<XCircle className="h-6 w-6 text-text-primary" />
				</div>
				<div className="text-center space-y-1">
					<p className="text-sm font-medium text-text-primary">
						Sign-in not approved
					</p>
					{/* This wording tracks the behaviour exactly, and it moved when the behaviour
					    did. It used to promise only that nothing was approved, because the refusal
					    was browser-local and that was all that was true. #3887 landed, so the
					    refusal is now recorded, the polling CLI is told, and the link cannot be
					    approved afterwards — all three are claims the server now backs. */}
					<p className="text-xs text-text-secondary">
						Nothing was shared, and the refusal has been recorded — the device has been
						told, and this link cannot be approved later. You can close this window.
					</p>
				</div>
			</div>
		);
	}

	return (
		<div className="flex flex-col items-center justify-center gap-4">
			<div className="h-12 w-12 rounded-full bg-destructive/10 flex items-center justify-center">
				<XCircle className="h-6 w-6 text-destructive" />
			</div>
			<div className="text-center space-y-1">
				<p className="text-sm font-medium text-text-primary">
					Authentication failed
				</p>
				<p className="text-xs text-destructive">{error}</p>
			</div>
		</div>
	);
}

/**
 * What `alethia login` opens in the browser — the CLI's device-approval screen.
 *
 * The shell it wears is no longer mounted here: `layout.tsx` renders `AuthShell`/`AuthCard`
 * around this page and around `loading.tsx`, so one file decides the route's frame and its
 * width. It stays under `(private)` deliberately — an anonymous visitor should be bounced to
 * `/login?next=…` rather than shown an approval prompt.
 *
 * The heading stays. It is one of the six surfaces in the shared-surface allowlist that sit
 * outside the console shell entirely: there is no sidebar entry and no breadcrumb above this
 * page, and it is arrived at from a terminal, so the heading is the only thing on screen that
 * says what the page is.
 */
export default function CliLoginPage() {
	return (
		<>
			<div className="mb-6 text-center">
				<p className="vx-eyebrow">Device authorization</p>
				{/* `text-display-xs` — the display rung for type rendered inside a shell,
				    24/22/20px. It replaces this file's own `text-[22px]`, which was one of the five
				    console sites sitting in the gap between the UI ladder's 17px top and the display
				    ladder's 30px bottom. The rung is CONSUMED here rather than invented: #3806 added
				    it to packages/brand/src/tokens.css's `@theme`, where it resolves today — four
				    other console files already read it. */}
				<h1 className="mt-2 font-grotesk text-display-xs font-semibold tracking-[-0.03em] text-text-primary">
					CLI Authentication
				</h1>
			</div>
			{/* The same body `loading.tsx` draws. `useSearchParams` forces a client bailout, and
			    the picture it falls back to must not be a second, different picture of this card
			    — the fallback used to be a centred spinner, which is a third one. */}
			<Suspense fallback={<CliLoginBodySkeleton />}>
				<CliLoginContent />
			</Suspense>
		</>
	);
}
