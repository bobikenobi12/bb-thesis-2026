// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The browser half of the CLI device flow, and the two defects it has carried.
//
// #2213 — the page approved the device code in a useEffect ON MOUNT, so merely opening a
// phished /cli/login link bound the victim's account to the attacker's device code. Nothing
// may be approved without an explicit press, and the user_code must be on screen to compare
// against the terminal.
//
// #3889 — the press was then offered against a screen that did not say what it was for. It
// named no account, no scopes, no requester and no deadline, while approval hands over an
// access token, a 90-day refresh token and the raw OAuth token of a linked git provider.
// `GET /api/auth/cli/request` describes the request; this suite is about whether the SCREEN
// does, and about what it does when the description cannot be had.
//
// THE PROPERTY UNDER TEST IS NOT "the fields render when present". That version passes
// against a page which, when the read fails, quietly draws a complete-looking consent screen
// and offers the button anyway — the exact shape of the defect. What is asserted here is that
// the screen never leaves those four facts UNSTATED: where a fact is unavailable it says so,
// and where approving is known to be pointless the button is gone.

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// next/navigation is mocked per-test: the query string is a mutable module-level string.
let hygCliAuthflowSearch = "";
vi.mock("next/navigation", () => ({
	useSearchParams: () => new URLSearchParams(hygCliAuthflowSearch),
}));

// The signed-in account, as `cli-session.tsx` hands it down. MOCKED AT THE HOOK, and the reason
// is measured rather than assumed: `CliAccountProvider` passes a PROMISE and `useCliAccount`
// resolves it with React 19's `use()`, which is the supported shape only because the promise
// crosses the RSC boundary — `layout.tsx` is a Server Component and Next streams it. There is no
// RSC boundary in jsdom, so a promise handed to that provider from a test never resolves and the
// page sits in its Suspense fallback forever. A 20-line probe rendering nothing but the provider
// and a `useCliAccount` caller reproduced it with no page involved, so this is a property of
// client-side `use()` under the unit tier and not of the screen under test.
//
// What is lost is the wiring, which is #4058's and already landed. What is kept is the question
// this suite is for: GIVEN the context resolves to an account, does the screen name it — and does
// it omit the line rather than print a blank when it resolves to null.
let hygCliAuthflowAccount: string | null = null;
vi.mock("@/app/(private)/cli/login/cli-session", () => ({
	useCliAccount: () => hygCliAuthflowAccount,
}));

import CliLoginPage from "@/app/(private)/cli/login/page";
import { deviceApprovalScopes } from "@/lib/auth/cli-device-code";

const HYG_CLI_AUTHFLOW_DEVICE_CODE = "2f1c8c1e-7a4b-4d2e-9a3f-0b5c6d7e8f90";
const HYG_CLI_AUTHFLOW_USER_CODE = "BCDF-GHJK";
const HYG_CLI_AUTHFLOW_ACCOUNT = "ada@example.com";

/** U+202E RIGHT-TO-LEFT OVERRIDE, as an escape — a literal one is invisible in a diff. */
const HYG_CLI_AUTHFLOW_RTL_OVERRIDE = "\u202E";

const hygCliAuthflowFetch = vi.fn();

/** What the mocked `GET /api/auth/cli/request` will answer with. */
let hygCliAuthflowRequest: { status: number; body: unknown } | "never" | "network-error";

/** What the mocked approve/deny POST will answer with. */
let hygCliAuthflowPost: { ok: boolean; body: unknown };

/**
 * The body `GET /api/auth/cli/request` documents, with `over` applied on top.
 *
 * Built from `deviceApprovalScopes` rather than from three hand-written literals, so a fixture
 * that has stopped matching the wire shape fails here instead of passing while the real screen
 * renders something else.
 */
function hygCliAuthflowView(over: Record<string, unknown> = {}) {
	return {
		status: "pending",
		user_code: HYG_CLI_AUTHFLOW_USER_CODE,
		account: { email: HYG_CLI_AUTHFLOW_ACCOUNT, name: "Ada" },
		requester: {
			client_name: "alethia-cli",
			client_version: "0.42.1",
			user_agent: "alethia-cli/0.42.1 (darwin; arm64)",
			request_ip: "203.0.113.7",
		},
		scopes: deviceApprovalScopes("github"),
		expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
		...over,
	};
}

/** Renders the page with the account context resolved to `account`. */
function renderCliLogin(account: string | null = HYG_CLI_AUTHFLOW_ACCOUNT) {
	hygCliAuthflowAccount = account;
	return render(<CliLoginPage />);
}

/** Every call the page made that was NOT the mount-time read. */
function hygCliAuthflowPostCalls() {
	return hygCliAuthflowFetch.mock.calls.filter(
		([url]) => !String(url).startsWith("/api/auth/cli/request"),
	);
}

beforeEach(() => {
	hygCliAuthflowFetch.mockReset();
	hygCliAuthflowRequest = { status: 200, body: hygCliAuthflowView() };
	hygCliAuthflowPost = { ok: true, body: {} };
	hygCliAuthflowFetch.mockImplementation((url: string) => {
		if (String(url).startsWith("/api/auth/cli/request")) {
			if (hygCliAuthflowRequest === "never") return new Promise(() => {});
			if (hygCliAuthflowRequest === "network-error") {
				return Promise.reject(new TypeError("Failed to fetch"));
			}
			const { status, body } = hygCliAuthflowRequest;
			return Promise.resolve({
				ok: status >= 200 && status < 300,
				status,
				json: async () => body,
			});
		}
		return Promise.resolve({
			ok: hygCliAuthflowPost.ok,
			status: hygCliAuthflowPost.ok ? 200 : 409,
			json: async () => hygCliAuthflowPost.body,
		});
	});
	vi.stubGlobal("fetch", hygCliAuthflowFetch);
	hygCliAuthflowSearch = `device_code=${HYG_CLI_AUTHFLOW_DEVICE_CODE}&user_code=${HYG_CLI_AUTHFLOW_USER_CODE}`;
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("/cli/login — the approval gesture (#2213)", () => {
	// The invariant, restated for the change that added a mount-time fetch: what mattered was
	// never "a fetch on mount", it was WHICH fetch. #2213's was the approval itself. This one
	// is a session-gated GET that decides nothing — so the assertion is no longer "no request
	// was made", which would now be false for a safe reason, but "no APPROVAL was made".
	it("describes the request on mount and approves nothing while doing it", async () => {
		renderCliLogin();

		expect(
			await screen.findByRole("button", { name: /approve/i }),
		).toBeInTheDocument();
		expect(screen.getByText(HYG_CLI_AUTHFLOW_USER_CODE)).toBeInTheDocument();

		// Exactly one call, and it is the read.
		expect(hygCliAuthflowFetch).toHaveBeenCalledTimes(1);
		const [url, init] = hygCliAuthflowFetch.mock.calls[0];
		expect(String(url)).toContain("/api/auth/cli/request");
		expect(String(url)).toContain(`device_code=${HYG_CLI_AUTHFLOW_DEVICE_CODE}`);
		expect(String(url)).toContain("user_code=BCDF-GHJK");
		// A GET. `method` unset is a GET, and anything else here is #2213 returning.
		expect(init?.method ?? "GET").toBe("GET");
		expect(hygCliAuthflowPostCalls()).toHaveLength(0);
	});

	it("binds the device code only when the user presses Approve", async () => {
		const user = userEvent.setup();
		renderCliLogin();

		await user.click(await screen.findByRole("button", { name: /approve/i }));

		await waitFor(() => expect(hygCliAuthflowPostCalls()).toHaveLength(1));
		const [url, init] = hygCliAuthflowPostCalls()[0];
		expect(url).toBe("/api/auth/cli/generate");
		expect(JSON.parse(init.body)).toEqual({
			device_code: HYG_CLI_AUTHFLOW_DEVICE_CODE,
			user_code: HYG_CLI_AUTHFLOW_USER_CODE,
		});
		expect(await screen.findByText(/authentication successful/i)).toBeInTheDocument();
	});

	// #3887. "Declines without sending anything" was literally true — the press set React
	// state and the server was never told, so the polling CLI kept waiting and re-opening the
	// same link offered the prompt again.
	it("records the refusal server-side when the user declines", async () => {
		const user = userEvent.setup();
		renderCliLogin();

		await user.click(await screen.findByRole("button", { name: /isn't me/i }));

		await waitFor(() => expect(hygCliAuthflowPostCalls()).toHaveLength(1));
		const [url, init] = hygCliAuthflowPostCalls()[0];
		expect(url).toBe("/api/auth/cli/deny");
		expect(JSON.parse(init.body)).toEqual({
			device_code: HYG_CLI_AUTHFLOW_DEVICE_CODE,
			user_code: HYG_CLI_AUTHFLOW_USER_CODE,
		});
		expect(await screen.findByText(/not approved/i)).toBeInTheDocument();
	});

	// Telling somebody their refusal was recorded when it was not is worse than telling them
	// to close the terminal, so the failure is surfaced rather than swallowed into the
	// reassuring "Sign-in not approved" screen.
	it("does not claim the refusal was recorded when the server refuses it", async () => {
		hygCliAuthflowPost = {
			ok: false,
			body: { error: "This login request belongs to another account" },
		};
		const user = userEvent.setup();
		renderCliLogin();

		await user.click(await screen.findByRole("button", { name: /isn't me/i }));

		expect(
			await screen.findByText(/belongs to another account/i),
		).toBeInTheDocument();
		expect(screen.queryByText(/refusal has been recorded/i)).toBeNull();
	});

	it("refuses a link with no user_code instead of offering to approve it", async () => {
		hygCliAuthflowSearch = `device_code=${HYG_CLI_AUTHFLOW_DEVICE_CODE}`;
		renderCliLogin();

		expect(
			await screen.findByText(/not a valid CLI login request/i),
		).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /approve/i })).toBeNull();
		// Nothing is asked about a request that does not parse — not even the read.
		expect(hygCliAuthflowFetch).not.toHaveBeenCalled();
	});

	it("surfaces the server's refusal when approval is rejected", async () => {
		hygCliAuthflowPost = {
			ok: false,
			body: { error: "This login request belongs to another account" },
		};
		const user = userEvent.setup();
		renderCliLogin();

		await user.click(await screen.findByRole("button", { name: /approve/i }));

		expect(
			await screen.findByText(/belongs to another account/i),
		).toBeInTheDocument();
	});
});

describe("/cli/login — what the screen says it is approving (#3889)", () => {
	// The four facts, in one assertion, because the issue is that they were absent TOGETHER.
	it("names the account, the scopes, the requester and the deadline", async () => {
		renderCliLogin();

		// The account — from the server-resolved session context, which is this page's single
		// source for that field. The view carries an `account` too; it is deliberately not read.
		expect(await screen.findByText(HYG_CLI_AUTHFLOW_ACCOUNT)).toBeInTheDocument();

		// The scopes — every line the SERVER emitted, including the git-provider token, which
		// the old hand-written list hedged as "if you have one linked".
		for (const scope of deviceApprovalScopes("github")) {
			expect(screen.getByText(scope.label)).toBeInTheDocument();
		}
		expect(screen.getByText(/GitHub access token/i)).toBeInTheDocument();

		// The requester — the client's claims and the IP the server observed.
		expect(screen.getByText("alethia-cli")).toBeInTheDocument();
		expect(screen.getByText("0.42.1")).toBeInTheDocument();
		expect(
			screen.getByText("alethia-cli/0.42.1 (darwin; arm64)"),
		).toBeInTheDocument();
		expect(screen.getByText("203.0.113.7")).toBeInTheDocument();

		// The deadline — the PENDING window, counted down. `pending_expires_at`, not
		// `expires_at`: the second is the post-approval redemption window and showing it would
		// be a clock for a period that has not begun.
		const deadline = screen.getByText(/this request expires in/i);
		expect(deadline.textContent).toMatch(/\d+m \d+s|\d+s/);

		// …and only then is the button offered.
		expect(screen.getByRole("button", { name: /approve/i })).toBeInTheDocument();
	});

	// `null` is a first-class value for the account, not a bug: `layout.tsx`'s session read is
	// best-effort and a stale token makes it throw. The line is then OMITTED. It must never
	// render as "unknown account" or as an empty string beside "Signed in as", which is the
	// blank-that-reads-as-an-answer failure in its smallest form.
	it("omits the account line rather than printing a blank when it cannot be resolved", async () => {
		renderCliLogin(null);

		expect(await screen.findByRole("button", { name: /approve/i })).toBeInTheDocument();
		expect(screen.queryByText(/signed in as/i)).toBeNull();
		// The rest of the description is unaffected — this is one missing fact, not four.
		expect(screen.getByText("alethia-cli")).toBeInTheDocument();
		expect(screen.getByText(/this request expires in/i)).toBeInTheDocument();
	});

	// A press against a skeleton is consent given to a screen that has not finished saying
	// what it is for.
	it("does not offer Approve while the request is still being described", async () => {
		hygCliAuthflowRequest = "never";
		renderCliLogin();

		expect(
			await screen.findByLabelText(/loading the details of this login request/i),
		).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /approve/i })).toBeNull();
		// Refusing is the safe direction and stays available throughout.
		expect(screen.getByRole("button", { name: /isn't me/i })).toBeInTheDocument();
	});

	// THE CASE THE NAIVE VERSION OF THIS SUITE MISSES. The read fails, and the question is
	// what the page does next. It must not fall back to a screen that looks complete.
	it("says it cannot describe the request instead of drawing a screen of blanks", async () => {
		hygCliAuthflowRequest = "network-error";
		renderCliLogin();

		expect(
			await screen.findByText(/cannot describe this request/i),
		).toBeInTheDocument();
		expect(screen.getByText(/could not load the details/i)).toBeInTheDocument();

		// No fabricated requester and no fabricated deadline — the two facts that exist ONLY in
		// the view. A page that rendered the block with empty fields would pass a test that
		// only checked the fields render when present; these are the assertions that fail it.
		expect(screen.queryByText(/alethia saw the request come from/i)).toBeNull();
		expect(screen.queryByText(/this request expires in/i)).toBeNull();
		expect(screen.queryByText(/the device says it is/i)).toBeNull();

		// Approval REMAINS available, and that is a decision rather than an oversight — see
		// `deviceRequestReadOutcome`. What is not allowed is offering it silently, so the
		// caveat and the button are asserted together: the reader is told what is missing in
		// the same breath they are offered the press.
		expect(screen.getByRole("button", { name: /approve/i })).toBeInTheDocument();
		expect(screen.getByText(/list may be incomplete/i)).toBeInTheDocument();
	});

	// The compatibility arm. An already-shipped `alethia login` never calls
	// /api/auth/cli/start, so it leaves no row and the read 404s. Refusing here would sign
	// every released binary out the day this deploys.
	it("keeps approval available for a login whose client never registered it", async () => {
		hygCliAuthflowRequest = { status: 404, body: { error: "No such login request" } };
		renderCliLogin();

		expect(await screen.findByText(/did not register its details/i)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /approve/i })).toBeInTheDocument();

		// The two tokens EVERY approval hands over are still named, from the same function the
		// route reads. Only the git-provider line is unknown without the server, and the screen
		// says that rather than guessing either way.
		for (const scope of deviceApprovalScopes(null)) {
			expect(screen.getByText(scope.label)).toBeInTheDocument();
		}
	});

	// KNOWN broken, so the button goes. /api/auth/cli/generate applies the identical gates;
	// the only thing an Approve button adds here is a wasted press and a worse error.
	it("withdraws Approve when the server refuses to describe the request", async () => {
		hygCliAuthflowRequest = {
			status: 409,
			body: { error: "This login request belongs to another account" },
		};
		renderCliLogin();

		expect(
			await screen.findByText(/belongs to another account/i),
		).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /approve/i })).toBeNull();
		expect(screen.getByRole("button", { name: /isn't me/i })).toBeInTheDocument();
		expect(hygCliAuthflowPostCalls()).toHaveLength(0);
	});

	// THE OUTAGE THE OTHER ARM WOULD CAUSE, asserted at the screen. An edge WAF or corporate
	// proxy can put a 403 — or a 400 — on this fetch; the query string carries a UUID and a
	// dashed code, a shape WAFs do flag. Read as Alethia's refusal, that removes Approve for
	// EVERY user at once under a heading asserting a refusal the server never made, and CLI
	// login is dead product-wide. The body is the evidence of who spoke, and a proxy's error
	// page carries no `error` field.
	it.each([
		["a 403, which this route cannot even emit", 403, { error: "Forbidden" }],
		["a 400 whose body is a proxy error page", 400, "<html>400 Bad Request</html>"],
		["a 409 with no readable body at all", 409, null],
	])("keeps Approve when the refusal did not come from Alethia — %s", async (_label, status, body) => {
		hygCliAuthflowRequest = { status, body };
		renderCliLogin();

		expect(await screen.findByText(/cannot describe this request/i)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /approve/i })).toBeInTheDocument();
		expect(screen.queryByText(/will not approve this request/i)).toBeNull();
	});

	// The control for the three above: a refusal that DOES carry the route's documented body
	// still withdraws the button. Without this, the assertions above would pass against a
	// function that had simply stopped refusing anything.
	it("still withdraws Approve for a refusal that carries the route's own error", async () => {
		hygCliAuthflowRequest = {
			status: 409,
			body: { error: "This login request does not match that code" },
		};
		renderCliLogin();

		expect(await screen.findByText(/does not match that code/i)).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /approve/i })).toBeNull();
	});

	// A described request is not necessarily an approvable one.
	it.each([
		["approved", /already been approved/i],
		["denied", /already refused/i],
		["expired", /has expired/i],
	])("withdraws Approve for a request that is %s", async (status, copy) => {
		hygCliAuthflowRequest = { status: 200, body: hygCliAuthflowView({ status }) };
		renderCliLogin();

		expect(await screen.findByText(copy)).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /approve/i })).toBeNull();
	});

	// The countdown is a CONTROL, not decoration. The server called it pending; the clock has
	// moved since, and the browser reads the deadline rather than re-polling for permission to
	// stop offering a button that would now fail.
	it("withdraws Approve when the decision window has already closed", async () => {
		hygCliAuthflowRequest = {
			status: 200,
			body: hygCliAuthflowView({
				status: "pending",
				expires_at: new Date(Date.now() - 1_000).toISOString(),
			}),
		};
		renderCliLogin();

		expect(await screen.findByText(/has expired/i)).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /approve/i })).toBeNull();
	});

	// A row too old to carry a pending deadline. Absent is not zero, and neither renders as an
	// answer: the screen says there is no deadline, and does NOT treat that as expired.
	it("says a request carries no deadline rather than showing one or withdrawing the button", async () => {
		hygCliAuthflowRequest = {
			status: 200,
			body: hygCliAuthflowView({ expires_at: null }),
		};
		renderCliLogin();

		expect(await screen.findByText(/carries no deadline/i)).toBeInTheDocument();
		expect(screen.queryByText(/this request expires in/i)).toBeNull();
		expect(screen.getByRole("button", { name: /approve/i })).toBeInTheDocument();
	});

	// A 200 whose body is not the documented shape is not a described request. Rendering it
	// anyway is how `undefined` becomes a blank and a blank reads as an answer — which is the
	// failure the route returns 404 rather than an empty view to avoid.
	it("treats a 200 with an unreadable body as no description at all", async () => {
		hygCliAuthflowRequest = { status: 200, body: { status: "pending" } };
		renderCliLogin();

		expect(await screen.findByText(/cannot describe this request/i)).toBeInTheDocument();
		expect(screen.queryByText(/alethia saw the request come from/i)).toBeNull();
	});
});

describe("/cli/login — the requester is untrusted display data", () => {
	// The trust boundary runs through the middle of the requester block, and the block has to
	// SAY so: three fields an unauthenticated process chose, one the server observed. A device
	// that could speak in the server's voice could name itself anything.
	it("attributes the client's claims to the client and the IP to Alethia", async () => {
		renderCliLogin();

		const claims = await screen.findByText(/the device says it is/i);
		expect(claims.textContent).toMatch(/could say anything/i);
		expect(
			screen.getByText(/alethia saw the request come from/i),
		).toBeInTheDocument();

		// The claimed values sit inside the region labelled as the DEVICE's account of itself,
		// and the server-observed IP sits outside it. Scoped by that label rather than by
		// `claims.parentElement`, which could only be used behind an `if` — and an `expect`
		// inside an `if` is one that can silently not run.
		const claimed = within(
			screen.getByRole("group", { name: /details the device reported/i }),
		);
		expect(claimed.getByText("alethia-cli")).toBeInTheDocument();
		expect(claimed.queryByText("203.0.113.7")).toBeNull();
	});

	// Rendered as ONE line of text. React escapes the markup; `clientMetadataField` — applied
	// by the route on the way out and by `parseDeviceRequestView` on the way in — is what stops
	// the string rendering as something other than itself.
	it("renders a forged client name as text rather than as a second server line", async () => {
		hygCliAuthflowRequest = {
			status: 200,
			body: hygCliAuthflowView({
				requester: {
					client_name: `alethia-cli${HYG_CLI_AUTHFLOW_RTL_OVERRIDE}forged`,
					client_version: "0.42.1\nAlethia says: this device is trusted",
					user_agent: null,
					request_ip: "203.0.113.7",
				},
			}),
		};
		renderCliLogin();

		const claimed = await screen.findByRole("group", {
			name: /details the device reported/i,
		});
		expect(claimed.textContent).not.toContain(HYG_CLI_AUTHFLOW_RTL_OVERRIDE);
		expect(claimed.textContent).not.toContain("\n");
		// Scrubbed, not blanked — the value is still the one the reader has to judge.
		expect(claimed.textContent).toContain("alethia-cli");
	});

	// Nothing at all is a real answer, and it gets its own sentence. A block that simply
	// disappeared would leave the reader unable to tell "no client details" from "we did not
	// look" — and the second is what this whole screen is about.
	it("says the device gave no details rather than rendering an empty block", async () => {
		hygCliAuthflowRequest = {
			status: 200,
			body: hygCliAuthflowView({
				requester: {
					client_name: null,
					client_version: null,
					user_agent: null,
					request_ip: null,
				},
			}),
		};
		renderCliLogin();

		expect(
			await screen.findByText(/did not say anything about itself/i),
		).toBeInTheDocument();
		// Still approvable: a registered request with a silent client is ordinary.
		expect(screen.getByRole("button", { name: /approve/i })).toBeInTheDocument();
	});
});
