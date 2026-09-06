// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The decision layer behind #3889 (what the consent screen is allowed to say, and which
// user_code may act on a request) and #3887 (a refusal that survives being polled).
//
// These predicates live in lib/** rather than in the route handlers because lib/** is
// inside the Vitest coverage scope and app/api/** is not. The routes stay thin transports
// over them; the route suite next door pins the transport.

import { describe, expect, it } from "vitest";
import {
	CLI_DEVICE_RATE_LIMIT,
	CLI_DEVICE_REQUEST_LIFECYCLES,
	CLI_DEVICE_START_RATE_LIMIT,
	CLI_GIT_PROVIDERS,
	CLIENT_METADATA_MAX_LENGTH,
	DEVICE_ACCESS_DENIED,
	DEVICE_APPROVAL_SCOPE_IDS,
	DEVICE_CODE_TTL_MS,
	PENDING_DEVICE_CODE_TTL_MS,
	checkUserCodeBinding,
	clientMetadataField,
	deviceApprovalScopes,
	deviceCodeExpiresAt,
	deviceCodeFail,
	deviceRequestReadOutcome,
	deviceRequestStatus,
	isCliGitProvider,
	isPendingRequestExpired,
	parseDeviceRequestView,
	pendingDeviceCodeExpiresAt,
	serverErrorMessage,
	type DeviceRequestRead,
} from "@/lib/auth/cli-device-code";

const CONSENT_USER_CODE = "BCDF-GHJK";
const CONSENT_OTHER_USER_CODE = "MNPQ-RSTV";

describe("checkUserCodeBinding", () => {
	// The whole point of #3889's binding half. Before it, `generate` validated the
	// user_code's SHAPE and never compared it against anything, so ANY well-formed code
	// approved any device code — the string on the consent screen was simply whatever the
	// link said.
	it("refuses a user_code that disagrees with the registered one", () => {
		expect(
			checkUserCodeBinding({ user_code: CONSENT_USER_CODE }, CONSENT_OTHER_USER_CODE),
		).toEqual({ ok: false, reason: "user_code_mismatch" });
	});

	it("accepts the registered user_code and reports it as bound", () => {
		expect(
			checkUserCodeBinding({ user_code: CONSENT_USER_CODE }, CONSENT_USER_CODE),
		).toEqual({ ok: true, bound: true });
	});

	// Compared exactly. The validators upstream pin the shape to upper-case AAAA-BBBB, so
	// a case-folding compare could only ever widen what counts as a match.
	it("does not case-fold a code into a match", () => {
		expect(
			checkUserCodeBinding({ user_code: CONSENT_USER_CODE }, "bcdf-ghjk"),
		).toEqual({ ok: false, reason: "user_code_mismatch" });
	});

	// The two permissive arms, and they are permissive DELIBERATELY: an already-shipped
	// `alethia login` never calls /api/auth/cli/start, so refusing them would sign every
	// released binary's users out the day this deploys. What they must NOT do is claim a
	// binding that does not exist — hence `bound: false`, which is what tells a caller the
	// code in front of the user was checked against nothing.
	it("permits a request with no row, and reports it as unbound", () => {
		expect(checkUserCodeBinding(undefined, CONSENT_USER_CODE)).toEqual({
			ok: true,
			bound: false,
		});
	});

	it("permits a row that stored no user_code, and reports it as unbound", () => {
		expect(checkUserCodeBinding({ user_code: null }, CONSENT_USER_CODE)).toEqual({
			ok: true,
			bound: false,
		});
	});
});

describe("deviceRequestStatus", () => {
	it("reads an unowned, unrefused row as pending", () => {
		expect(deviceRequestStatus({ profile_id: null, denied_at: null })).toBe("pending");
	});

	it("reads an owned row as approved", () => {
		expect(deviceRequestStatus({ profile_id: "user-1", denied_at: null })).toBe(
			"approved",
		);
	});

	// A refusal that lands after an approval must win, or the answer would depend on which
	// column the reader happened to look at first.
	it("lets a refusal win over an approval on the same row", () => {
		expect(
			deviceRequestStatus({ profile_id: "user-1", denied_at: new Date() }),
		).toBe("denied");
	});
});

describe("the pending window", () => {
	// #3889 says this in so many words: DEVICE_CODE_TTL_MS is the POST-approval redemption
	// window and displaying it as the countdown would be wrong. Two constants, and if they
	// ever collapse into one the consent screen starts showing a clock for a period that
	// has not begun.
	it("is a different clock from the post-approval redemption window", () => {
		const now = 1_700_000_000_000;
		expect(pendingDeviceCodeExpiresAt(now).getTime()).toBe(
			now + PENDING_DEVICE_CODE_TTL_MS,
		);
		expect(deviceCodeExpiresAt(now).getTime()).toBe(now + DEVICE_CODE_TTL_MS);
		expect(pendingDeviceCodeExpiresAt(now).getTime()).not.toBe(
			deviceCodeExpiresAt(now).getTime() - DEVICE_CODE_TTL_MS,
		);
	});

	it("closes once the deadline is reached", () => {
		const at = new Date(1_700_000_000_000);
		expect(isPendingRequestExpired({ pending_expires_at: at }, at.getTime() - 1)).toBe(
			false,
		);
		expect(isPendingRequestExpired({ pending_expires_at: at }, at.getTime())).toBe(true);
	});

	// The ONE place in this module that fails open, and only because it is a display aid:
	// the redemption boundary is isDeviceCodeExpired, which fails closed. A row with no
	// pending deadline is one an older CLI created, and refusing it would break every
	// in-flight login the moment this deploys.
	it("treats a row with no pending deadline as still open", () => {
		expect(isPendingRequestExpired({ pending_expires_at: null })).toBe(false);
	});
});

describe("clientMetadataField", () => {
	it("keeps an ordinary value", () => {
		expect(clientMetadataField(" alethia-cli ")).toBe("alethia-cli");
	});

	it("reports a missing, blank or non-string value as null rather than an empty answer", () => {
		expect(clientMetadataField(undefined)).toBeNull();
		expect(clientMetadataField("")).toBeNull();
		expect(clientMetadataField("   ")).toBeNull();
		expect(clientMetadataField(42)).toBeNull();
		expect(clientMetadataField({ toString: () => "x" })).toBeNull();
	});

	// These strings are rendered on a consent screen from an UNAUTHENTICATED request. An
	// unbounded one pushes the Approve/refuse buttons off the page, which is a denial of
	// the decision itself.
	it("cuts an oversized value to the display bound", () => {
		const flood = "A".repeat(CLIENT_METADATA_MAX_LENGTH * 10);
		expect(clientMetadataField(flood)).toHaveLength(CLIENT_METADATA_MAX_LENGTH);
	});
});

describe("deviceApprovalScopes", () => {
	// The screen said "A device is asking to sign in to your account" while approval also
	// returns a 90-day refresh token. Both have to be named.
	it("names the access token and the 90-day refresh token", () => {
		const ids = deviceApprovalScopes(null).map((s) => s.id);
		expect(ids).toEqual(["cli_access_token", "cli_refresh_token"]);
		expect(
			deviceApprovalScopes(null).find((s) => s.id === "cli_refresh_token")?.detail,
		).toMatch(/90 days/);
	});

	it("names the git-provider token, and which provider it is", () => {
		const git = deviceApprovalScopes("github").find(
			(s) => s.id === "git_provider_token",
		);
		expect(git?.label).toContain("GitHub");
		expect(git?.detail).toContain("GitHub");
	});

	// A screen that lists a token which will not be handed over teaches the reader to
	// discount the whole list.
	it("omits the git line when no provider will contribute a token", () => {
		expect(
			deviceApprovalScopes(null).some((s) => s.id === "git_provider_token"),
		).toBe(false);
	});

	// The summary and the route that actually stashes the token read ONE list. Two copies
	// is how a consent screen ends up under-reporting: add a provider to the stash alone
	// and approval starts handing over a token the screen never named.
	it("can describe every provider whose token approval hands over", () => {
		for (const provider of CLI_GIT_PROVIDERS) {
			expect(isCliGitProvider(provider)).toBe(true);
			const git = deviceApprovalScopes(provider).find(
				(s) => s.id === "git_provider_token",
			);
			expect(git).toBeDefined();
			// No provider may fall through to an "undefined" label.
			expect(git?.label).not.toMatch(/undefined/i);
		}
		expect(isCliGitProvider("google")).toBe(false);
	});
});

describe("the wire contract", () => {
	// A WIRE value: the exchange route writes it and pollForToken in apps/cli/cmd/login.go
	// compares against it. Spelt differently on either side the CLI falls through to its
	// generic "authentication failed (HTTP 403)" arm and the user learns nothing.
	it("uses RFC 8628's access_denied code verbatim", () => {
		expect(DEVICE_ACCESS_DENIED).toBe("access_denied");
	});

	it("answers in one JSON error shape, with an optional description", () => {
		return Promise.all([
			deviceCodeFail("Unauthorized", 401).json(),
			deviceCodeFail(DEVICE_ACCESS_DENIED, 403, "Refused in the browser.").json(),
		]).then(([plain, described]) => {
			expect(plain).toEqual({ error: "Unauthorized" });
			expect(described).toEqual({
				error: "access_denied",
				error_description: "Refused in the browser.",
			});
		});
	});

	// The one UNAUTHENTICATED route here that WRITES must not share the poll's budget: an
	// honest `alethia login` registers once and polls ~30 times a minute, so one bucket
	// would let ordinary polling authorise a flood of row inserts.
	it("gives the unauthenticated write route a tighter budget than the poll", () => {
		expect(CLI_DEVICE_START_RATE_LIMIT.limit).toBeLessThan(CLI_DEVICE_RATE_LIMIT.limit);
	});
});

// #3889's display half. Everything below is what stands between a string an unauthenticated
// process chose and the line a person reads while deciding whether to hand a terminal their
// account's tokens.
//
// Every hostile character in this file is written as a `\u` escape. A literal one is
// invisible in a diff and in a review — which is the same property that makes it worth
// stripping in the first place, and it would make these tests unreadable to the person
// checking whether they still test what they say.

/** U+202E RIGHT-TO-LEFT OVERRIDE and its neighbours, by name. */
const BIDI_OVERRIDE = "\u202E";
const BIDI_EMBEDDING = "\u202A";
const BIDI_ISOLATE_OPEN = "\u2066";
const BIDI_ISOLATE_CLOSE = "\u2069";
const LTR_MARK = "\u200E";
const RTL_MARK = "\u200F";
const ARABIC_LETTER_MARK = "\u061C";
const SOFT_HYPHEN = "\u00AD";
const MONGOLIAN_VOWEL_SEPARATOR = "\u180E";
const WORD_JOINER = "\u2060";
const INVISIBLE_TIMES = "\u2062";
const TAG_LATIN_SMALL_A = "\u{E0061}";
const ZERO_WIDTH_SPACE = "\u200B";
const ZERO_WIDTH_NON_JOINER = "\u200C";
const ZERO_WIDTH_JOINER = "\u200D";
const BYTE_ORDER_MARK = "\uFEFF";

describe("clientMetadataField, as a display guard", () => {
	// A newline turns one labelled line into two, and the second is written by whoever
	// registered the request. That is the impersonation move on a screen whose other lines
	// are the server's.
	it("neutralises a newline instead of letting it start a second line", () => {
		const cleaned = clientMetadataField("alethia-cli\nVerified by Alethia");
		expect(cleaned).not.toContain("\n");
		expect(cleaned).toBe("alethia-cli Verified by Alethia");
	});

	it("neutralises the whole C0 and C1 control range", () => {
		for (const code of [0x00, 0x07, 0x0d, 0x1b, 0x7f, 0x85, 0x9f]) {
			expect(clientMetadataField(`a${String.fromCharCode(code)}b`)).toBe("a b");
		}
	});

	// An RTL override reverses the RENDERED order of everything after it while leaving the
	// string equal to itself — on the one screen whose entire job is "does what you see match
	// what your terminal says".
	it("neutralises bidi overrides, embeddings, isolates and marks", () => {
		for (const ch of [
			BIDI_OVERRIDE,
			BIDI_EMBEDDING,
			BIDI_ISOLATE_OPEN,
			BIDI_ISOLATE_CLOSE,
			LTR_MARK,
			RTL_MARK,
			// The third implicit mark. It is in the same Bidi_Control set as LRM and RLM, and a
			// class defined by a Unicode property that covers two of its three members is a class
			// with a hole in it.
			ARABIC_LETTER_MARK,
		]) {
			expect(clientMetadataField(`cli${ch}evil`)).toBe("cli evil");
		}
	});

	// Invisible, so they split a word the eye reads as one: two client names that render
	// identically are two different strings, and only one is the client anybody has heard of.
	it("neutralises zero-width joiners and the BOM", () => {
		for (const ch of [
			ZERO_WIDTH_SPACE,
			ZERO_WIDTH_NON_JOINER,
			ZERO_WIDTH_JOINER,
			BYTE_ORDER_MARK,
			// U+FEFF is the DEPRECATED spelling of this function; U+2060 is what anyone reaching
			// for a word joiner today actually reaches for, so stripping only the first covers
			// the character nobody uses and misses the one they do.
			WORD_JOINER,
			INVISIBLE_TIMES,
			SOFT_HYPHEN,
			MONGOLIAN_VOWEL_SEPARATOR,
			// Above the BMP, which is why the pattern carries the `u` flag: without it this range
			// would have to be spelt as surrogate pairs, and it is the usual carrier for hidden
			// text precisely because it gets left out.
			TAG_LATIN_SMALL_A,
		]) {
			expect(clientMetadataField(`alethia${ch}-cli`)).toBe("alethia -cli");
		}
	});

	// A stripped character becomes a SPACE and not nothing: deleting the newline above would
	// weld two words into one and CHANGE the value the reader is shown rather than flatten it.
	it("does not weld two words together when it removes what separated them", () => {
		expect(clientMetadataField("alethia\ncli")).toBe("alethia cli");
	});

	// …and the substitution must not become its own padding attack. This is also the
	// plain-space version, where a run of spaces pushes the real value out of view and a
	// forgery takes its place.
	it("collapses a run of whitespace rather than letting it push the value out of view", () => {
		expect(clientMetadataField(`alethia-cli${" ".repeat(150)}(official)`)).toBe(
			"alethia-cli (official)",
		);
	});

	// The bound is applied AFTER the collapse, so padding cannot consume the budget the real
	// value needs.
	it("still cuts to the display bound after collapsing", () => {
		const flood = `${" ".repeat(500)}${"A".repeat(CLIENT_METADATA_MAX_LENGTH * 3)}`;
		expect(clientMetadataField(flood)).toHaveLength(CLIENT_METADATA_MAX_LENGTH);
	});

	// A value that was ONLY unsafe characters said nothing, and must report that as null
	// rather than as a space — a blank rendered next to a label reads as an answer.
	it("reports a value made only of stripped characters as null", () => {
		expect(clientMetadataField(`${BIDI_OVERRIDE}${ZERO_WIDTH_SPACE}`)).toBeNull();
	});
});

describe("parseDeviceRequestView", () => {
	/** The documented body of `GET /api/auth/cli/request`, with `over` applied on top. */
	function wireView(over: Record<string, unknown> = {}) {
		return {
			status: "pending",
			user_code: CONSENT_USER_CODE,
			account: { email: "ada@example.com", name: "Ada" },
			requester: {
				client_name: "alethia-cli",
				client_version: "0.42.1",
				user_agent: "alethia-cli/0.42.1 (darwin; arm64)",
				request_ip: "203.0.113.7",
			},
			scopes: deviceApprovalScopes("github"),
			expires_at: new Date(Date.now() + 60_000).toISOString(),
			...over,
		};
	}

	it("reads the documented body", () => {
		const view = parseDeviceRequestView(wireView());
		expect(view?.status).toBe("pending");
		expect(view?.user_code).toBe(CONSENT_USER_CODE);
		expect(view?.account).toEqual({ email: "ada@example.com", name: "Ada" });
		expect(view?.requester.request_ip).toBe("203.0.113.7");
		expect(view?.scopes.map((s) => s.id)).toContain("git_provider_token");
	});

	// THE REASON THIS IS NOT A CAST. `body as CliDeviceRequestView` makes `undefined`
	// type-check as a string and render as a blank — a consent screen whose empty fields look
	// like answers, which is the exact failure the route returns 404 rather than an empty view
	// to avoid. Every one of these has to produce NO view, so the caller says "unverified"
	// out loud instead of drawing one.
	it.each([
		["not an object at all", null],
		["an array", []],
		["a status outside the lifecycle", { status: "maybe" }],
		["no status", { user_code: CONSENT_USER_CODE }],
	])("returns null for %s", (_label, body) => {
		expect(parseDeviceRequestView(body)).toBeNull();
	});

	// The code a person is asked to match by eye. A mangled one must not reach the plate.
	it("refuses a body whose user_code is not a well-formed code", () => {
		expect(parseDeviceRequestView(wireView({ user_code: "nope" }))).toBeNull();
		expect(parseDeviceRequestView(wireView({ user_code: null }))).toBeNull();
	});

	it("refuses a body with no account object, or a non-string identity", () => {
		expect(parseDeviceRequestView(wireView({ account: null }))).toBeNull();
		expect(
			parseDeviceRequestView(wireView({ account: { email: 7, name: null } })),
		).toBeNull();
	});

	// A null email is a real answer — the layout's session read is best-effort — and the view
	// must survive it rather than collapsing to "no detail at all".
	it("keeps a null email rather than refusing the view", () => {
		const view = parseDeviceRequestView(
			wireView({ account: { email: null, name: null } }),
		);
		expect(view?.account).toEqual({ email: null, name: null });
	});

	it("refuses a body with no requester object", () => {
		expect(parseDeviceRequestView(wireView({ requester: "alethia-cli" }))).toBeNull();
	});

	// The parser is the LAST thing between an unauthenticated string and the screen, and it
	// does not assume the write path ran: rows predating #4035's normalisation are still in
	// the table and the route reads them straight out of a JSONB column.
	it("re-normalises the requester's client-supplied strings", () => {
		const view = parseDeviceRequestView(
			wireView({
				requester: {
					client_name: `alethia-cli${BIDI_OVERRIDE}laminret ruoy kcehC`,
					client_version: "  0.42.1  ",
					user_agent: "x".repeat(CLIENT_METADATA_MAX_LENGTH * 2),
					request_ip: "203.0.113.7",
				},
			}),
		);
		expect(view?.requester.client_name).not.toContain(BIDI_OVERRIDE);
		expect(view?.requester.client_version).toBe("0.42.1");
		expect(view?.requester.user_agent).toHaveLength(CLIENT_METADATA_MAX_LENGTH);
	});

	it("reports a requester that said nothing as nulls, not as empty strings", () => {
		const view = parseDeviceRequestView(
			wireView({
				requester: {
					client_name: "",
					client_version: null,
					user_agent: "  ",
					request_ip: null,
				},
			}),
		);
		expect(view?.requester).toEqual({
			client_name: null,
			client_version: null,
			user_agent: null,
			request_ip: null,
		});
	});

	// An unreadable scope line is a scope the page would not RENDER, and the defect this whole
	// screen exists to fix is a consent gesture made against an incomplete list. So it fails
	// the view rather than quietly shortening it.
	it.each([
		["a scope id it does not know", [{ id: "ssh_key", label: "L", detail: "D" }]],
		["a scope with no detail", [{ id: "cli_access_token", label: "L" }]],
		["a scope with a blank label", [{ id: "cli_access_token", label: " ", detail: "D" }]],
		["a scope that is not an object", ["cli_access_token"]],
		["scopes that are not an array", "cli_access_token"],
	])("refuses a body carrying %s", (_label, scopes) => {
		expect(parseDeviceRequestView(wireView({ scopes }))).toBeNull();
	});

	// "Approving hands over nothing" is the most reassuring thing this screen could wrongly
	// say, and `deviceApprovalScopes` never emits it — so an empty list did not come from it.
	it("refuses an empty scope list", () => {
		expect(parseDeviceRequestView(wireView({ scopes: [] }))).toBeNull();
	});

	// A deadline is optional; a PRESENT one has to be real. An unparseable string would render
	// as a NaN countdown, and a countdown that reads wrong is worse than one that is absent.
	it("accepts a missing deadline and refuses an unreal one", () => {
		expect(parseDeviceRequestView(wireView({ expires_at: null }))?.expires_at).toBeNull();
		expect(parseDeviceRequestView(wireView({ expires_at: "soon" }))).toBeNull();
		expect(parseDeviceRequestView(wireView({ expires_at: 1_700_000_000 }))).toBeNull();
	});

	// THE CONTROL. Every `toBeNull` above would pass vacuously against a parser that returned
	// null for everything, including the body the route actually sends.
	it("is not simply refusing every body", () => {
		expect(parseDeviceRequestView(wireView())).not.toBeNull();
	});

	// The parser's set of known scope ids is DERIVED from the tuple the emitter reads, so a
	// fourth scope cannot become one the page silently drops.
	it("accepts every scope id the emitter can produce", () => {
		for (const provider of CLI_GIT_PROVIDERS) {
			const scopes = deviceApprovalScopes(provider);
			expect(parseDeviceRequestView(wireView({ scopes }))?.scopes).toHaveLength(
				scopes.length,
			);
		}
		for (const id of DEVICE_APPROVAL_SCOPE_IDS) {
			expect(
				parseDeviceRequestView(wireView({ scopes: [{ id, label: "L", detail: "D" }] })),
			).not.toBeNull();
		}
	});
});

describe("deviceRequestReadOutcome", () => {
	/**
	 * Asserts the outcome is the failure `kind` and hands back its reason.
	 *
	 * `expect(outcome.kind).toBe("refused")` does not narrow — `expect` is a runtime assertion
	 * and TypeScript reads the next line against the whole union, where `reason` does not
	 * exist on the `ok` arm. The `throw` is what narrows, and it also makes the failure
	 * legible: a test that reached for `.reason` on an `ok` outcome should say so, not read
	 * `undefined` and compare it against a string.
	 */
	function reasonOf(
		outcome: DeviceRequestRead,
		kind: "refused" | "unverified",
	): string {
		if (outcome.kind === "ok") {
			throw new Error(`expected a ${kind} outcome, got ok`);
		}
		expect(outcome.kind).toBe(kind);
		return outcome.reason;
	}

	it("passes a described request through", () => {
		expect(deviceRequestReadOutcome(200)).toEqual({ kind: "ok" });
	});

	// KNOWN broken. `/api/auth/cli/generate` applies the identical gates, so the only thing an
	// Approve button adds here is a wasted press and a worse error. Note the SECOND argument:
	// a refusal has to look like one of ours, and the body is the only evidence of that.
	it.each([400, 401, 409])("refuses outright on %i from this route", (status) => {
		expect(deviceRequestReadOutcome(status, "Unauthorized").kind).toBe("refused");
	});

	// A STATUS ALONE DOES NOT ESTABLISH WHO SPOKE, and this is the outage the `unverified` arm
	// exists to prevent, reached through the other arm. An edge WAF, a bot rule or a corporate
	// proxy can 403 or 400 this fetch — the query string carries a UUID and a dashed code, a
	// shape WAFs do flag. Read as a refusal, that removes Approve under "Alethia will not
	// approve this request" for every user at once and kills CLI login, with the console
	// asserting a refusal the server never made.
	it.each([400, 401, 409])(
		"does NOT read a %i as a refusal when the body is not the documented shape",
		(status) => {
			expect(deviceRequestReadOutcome(status, null).kind).toBe("unverified");
			expect(deviceRequestReadOutcome(status, "").kind).toBe("unverified");
			// What a proxy's HTML error page leaves after `serverErrorMessage` finds no `error`.
			expect(deviceRequestReadOutcome(status, "   ").kind).toBe("unverified");
		},
	);

	// 403 is not on the list at all, on evidence rather than on taste: `request/route.ts` emits
	// 400, 401, 404, 409 and 429 and no 403, so a 403 on this fetch was written by something
	// that is not this route — even when it arrives carrying a plausible-looking body.
	it("never reads a 403 as a refusal, because this route cannot emit one", () => {
		expect(deviceRequestReadOutcome(403, "Forbidden").kind).toBe("unverified");
	});

	it("says what the server said when it refuses", () => {
		const reason = reasonOf(
			deviceRequestReadOutcome(409, "This login request belongs to another account"),
			"refused",
		);
		expect(reason).toBe("This login request belongs to another account");
	});

	// …but never a page of it. A proxy, an edge rate-limiter or a Next error page can answer
	// this fetch, and one of them putting an essay in `error` would push the buttons off the
	// screen exactly the way an unbounded client_name would.
	it("bounds and cleans what it repeats from the server", () => {
		expect(
			reasonOf(deviceRequestReadOutcome(409, "x".repeat(5_000)), "refused").length,
		).toBeLessThanOrEqual(CLIENT_METADATA_MAX_LENGTH);
		expect(
			reasonOf(deviceRequestReadOutcome(409, "bad\nline"), "refused"),
		).not.toContain("\n");
	});

	// The inverse of the arm above, stated as its own case because it used to be the opposite:
	// a 409 with no readable body fell through to a refusal wearing a default sentence. A
	// sentence Alethia wrote is not evidence that Alethia refused.
	it("warns rather than refusing when the server names no reason", () => {
		const outcome = deviceRequestReadOutcome(409, null);
		expect(outcome.kind).toBe("unverified");
		expect(reasonOf(outcome, "unverified")).toMatch(/could not load/i);
	});

	// UNKNOWN, not known-broken — and this arm is the difference between a security fix and an
	// outage. A 404 is an already-shipped `alethia login`: it never calls /api/auth/cli/start,
	// so it leaves no row to read, and refusing here would sign every one of them out the day
	// this deploys. Same permissiveness, for the same reason, as `checkUserCodeBinding` on a
	// NULL user_code and `isPendingRequestExpired` on a NULL deadline.
	it("does NOT refuse a request that was simply never registered", () => {
		expect(reasonOf(deviceRequestReadOutcome(404), "unverified")).toMatch(
			/did not register/i,
		);
	});

	it.each([429, 500, 502, 503])("treats %i as unverified rather than refused", (status) => {
		expect(deviceRequestReadOutcome(status).kind).toBe("unverified");
	});

	// No status at all — the fetch never completed, so nothing was said about the request.
	it("treats a transport failure as unverified", () => {
		expect(deviceRequestReadOutcome(null).kind).toBe("unverified");
	});

	// Whatever the arm, the reason is a SENTENCE. A blank one renders as a panel with a
	// heading and nothing under it, which is the same defect as a blank field.
	it("never answers with an empty reason", () => {
		for (const status of [400, 401, 403, 404, 409, 429, 500, null]) {
			const outcome = deviceRequestReadOutcome(status, "Unauthorized");
			if (outcome.kind === "ok") continue;
			expect(outcome.reason.trim()).not.toBe("");
		}
	});
});

describe("serverErrorMessage", () => {
	it("takes the route's own error string", () => {
		expect(serverErrorMessage({ error: "Unauthorized" }, "fallback")).toBe("Unauthorized");
	});

	// The fallback is a PARAMETER because the callers are not interchangeable: a failed
	// refusal's words carry an instruction ("close your terminal") a failed approval's do not.
	it.each([
		["a body that is not an object", "<html>502</html>"],
		["a body with no error field", { message: "nope" }],
		["a non-string error", { error: 42 }],
		["an empty error", { error: "   " }],
		["null", null],
	])("falls back on %s", (_label, body) => {
		expect(serverErrorMessage(body, "fallback")).toBe("fallback");
	});

	it("bounds what it will repeat", () => {
		expect(serverErrorMessage({ error: "y".repeat(5_000) }, "fallback")).toHaveLength(
			CLIENT_METADATA_MAX_LENGTH,
		);
	});
});

describe("the consent screen's lifecycle set", () => {
	// `deviceRequestStatus` answers three off the columns; the screen needs a fourth, because
	// "waiting for you" and "the window closed while you were reading" are different news and
	// only the first may carry a button.
	it("is the three column states plus expired", () => {
		expect([...CLI_DEVICE_REQUEST_LIFECYCLES]).toEqual([
			"pending",
			"approved",
			"denied",
			"expired",
		]);
		for (const row of [
			{ profile_id: null, denied_at: null },
			{ profile_id: "someone", denied_at: null },
			{ profile_id: null, denied_at: new Date() },
		]) {
			expect(CLI_DEVICE_REQUEST_LIFECYCLES).toContain(deviceRequestStatus(row));
		}
	});
});
