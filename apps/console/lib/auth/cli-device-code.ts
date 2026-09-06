// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Decision logic for the CLI device-code flow (RFC 8628). It lives in `lib/**` rather
 * than inside the route handlers on purpose: `lib/**` is inside the Vitest coverage
 * scope and the mutation-testing globs, `app/api/**` is in neither. The two routes
 * (`/api/auth/cli/generate` and `/api/auth/cli/exchange`) stay thin transports over
 * the predicates below.
 *
 * Deliberately dependency-free: the /cli/login page is a client component and reuses
 * the validators, so this module must not drag server-side state (the in-memory
 * lib/rate-limit store) into the browser bundle. The routes own that call; this module
 * owns the decision of WHICH key to bucket on.
 */

/**
 * How long an approved device code stays redeemable. The CLI polls every 2s while the
 * user completes the browser half, so ten minutes is generous for a human and short
 * enough that an approved-but-never-collected code does not sit redeemable forever.
 */
export const DEVICE_CODE_TTL_MS = 10 * 60_000;

/**
 * The `user_code` shape the CLI mints (`apps/cli/cmd/auth_utils.go` · `newUserCode`):
 * two groups of four from an unambiguous upper-case consonant alphabet — no 0/O, no
 * 1/I/L. The console validates the shape so a mangled or hand-crafted link cannot put
 * an unreadable string in front of the user as "the code to compare".
 */
const USER_CODE_PATTERN = /^[BCDFGHJKMNPQRSTVWXZ]{4}-[BCDFGHJKMNPQRSTVWXZ]{4}$/;

/** RFC 4122 textual UUID — the shape `alethia login` mints its device_code in. */
const DEVICE_CODE_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Rate-limit budget for the unauthenticated CLI device-code routes.
 *
 * Sized against the real client: `alethia login` polls the exchange every 2 seconds, so
 * ONE honest login is already ~30 requests/minute. 240/60s leaves room for roughly eight
 * concurrent logins behind a single NAT before anyone is throttled.
 *
 * Be honest about what this buys: a cap on how many unauthenticated DB round-trips one
 * IP can force, nothing more. It is NOT brute-force protection — the device_code is a
 * 122-bit UUID and no request budget is what makes guessing it infeasible. And because
 * lib/rate-limit.ts is in-memory and per-process, a second replica or a restart resets
 * the counter: this is a damper, not a control.
 */
export const CLI_DEVICE_RATE_LIMIT = { limit: 240, windowMs: 60_000 } as const;

/** Reports whether `value` is a well-formed CLI `user_code`. */
export function isValidUserCode(value: unknown): value is string {
	return typeof value === "string" && USER_CODE_PATTERN.test(value);
}

/** Reports whether `value` is a well-formed (UUID-shaped) `device_code`. */
export function isValidDeviceCode(value: unknown): value is string {
	return typeof value === "string" && DEVICE_CODE_PATTERN.test(value);
}

/** The deadline a newly approved device code should carry. */
export function deviceCodeExpiresAt(now: number = Date.now()): Date {
	return new Date(now + DEVICE_CODE_TTL_MS);
}

/** The lifetime columns `cli_logins` carries. Both are nullable in the schema. */
export interface DeviceCodeLifetime {
	expires_at: Date | null;
	created_at: Date | null;
}

/**
 * The moment a device code stops being redeemable, or null when neither column can
 * supply one.
 *
 * `expires_at` was never written before this change, so every row already in the table
 * has it NULL. Falling back to `created_at + TTL` (created_at has `defaultNow()`) is
 * what makes the deadline real for those rows: a lenient `expires_at && expires_at <
 * now` would leave every existing row immortal — which is the bug — while a strict
 * reject of NULL would kill every in-flight login the moment this deploys.
 */
export function deviceCodeDeadline(row: DeviceCodeLifetime): Date | null {
	if (row.expires_at) return row.expires_at;
	if (row.created_at) return new Date(row.created_at.getTime() + DEVICE_CODE_TTL_MS);
	return null;
}

/**
 * Reports whether a device-code row is past its deadline and must not be redeemed.
 * A row with no usable deadline at all fails closed (treated as expired).
 */
export function isDeviceCodeExpired(
	row: DeviceCodeLifetime,
	now: number = Date.now(),
): boolean {
	const deadline = deviceCodeDeadline(row);
	if (!deadline) return true;
	return now >= deadline.getTime();
}

/** The ownership column the binding check reads. */
export interface DeviceCodeOwner {
	profile_id: string | null;
}

/** Outcome of the generate route's ownership check. */
export type DeviceCodeBinding =
	| { ok: true }
	| { ok: false; reason: "bound_to_another_account" };

/**
 * Decides whether `profileId` may bind (or re-bind) an existing `cli_logins` row.
 *
 * This is the account-takeover gate. The route used to upsert with an unconditional
 * `onConflictDoUpdate`, so opening a phished `/cli/login?device_code=<attacker-uuid>`
 * link re-pointed the ATTACKER's device code at the victim's profile — and the
 * attacker's polling CLI collected the victim's access token, 90-day refresh token and
 * raw git-provider OAuth token. A code already owned by somebody else is now refused.
 */
export function checkDeviceCodeBinding(
	existing: DeviceCodeOwner | undefined,
	profileId: string,
): DeviceCodeBinding {
	if (!existing?.profile_id) return { ok: true };
	if (existing.profile_id === profileId) return { ok: true };
	return { ok: false, reason: "bound_to_another_account" };
}

/**
 * How long a REGISTERED-but-undecided request stays live — the window the consent screen
 * counts down.
 *
 * This is deliberately not `DEVICE_CODE_TTL_MS`. That one starts when the user presses
 * Approve and bounds how long the CLI has to redeem; this one starts when `alethia login`
 * runs and bounds how long the user has to decide. Showing the redemption window as the
 * countdown would be showing a clock for a period that has not begun.
 *
 * Ten minutes because that is `loginPollTimeout` in `apps/cli/cmd/login.go` — the point at
 * which the terminal gives up waiting. A pending window longer than that would keep offering
 * a consent screen for a login nothing is listening for any more.
 */
export const PENDING_DEVICE_CODE_TTL_MS = 10 * 60_000;

/** The deadline a freshly registered (not yet approved) device request should carry. */
export function pendingDeviceCodeExpiresAt(now: number = Date.now()): Date {
	return new Date(now + PENDING_DEVICE_CODE_TTL_MS);
}

/** The pending-window column the consent screen's countdown reads. */
export interface PendingDeviceRequestWindow {
	pending_expires_at: Date | null;
}

/**
 * Reports whether a registered request's decision window has closed.
 *
 * A row with no `pending_expires_at` fails OPEN here, and only here: that is a row written
 * by a CLI too old to register (or by `generate` directly, which never had one), and the
 * pending window is a display and refusal aid rather than the security boundary — the
 * boundary is `isDeviceCodeExpired`, which fails closed. Refusing every unregistered row
 * would break every already-shipped `alethia login` the day this deploys.
 */
export function isPendingRequestExpired(
	row: PendingDeviceRequestWindow,
	now: number = Date.now(),
): boolean {
	if (!row.pending_expires_at) return false;
	return now >= row.pending_expires_at.getTime();
}

/** The columns that say which of a device request's three lives it is in. */
export interface DeviceRequestState {
	profile_id: string | null;
	denied_at: Date | null;
}

/** Which life a `cli_logins` row is in — see the table comment in schema/accounts.ts. */
export type DeviceRequestStatus = "pending" | "approved" | "denied";

/**
 * Classifies a device request row.
 *
 * `denied` is checked FIRST and wins over an existing `profile_id`, so a refusal that lands
 * after an approval (the "I pressed the wrong button" case) is terminal rather than a race
 * whose winner is whichever column the reader happened to look at first.
 */
export function deviceRequestStatus(row: DeviceRequestState): DeviceRequestStatus {
	if (row.denied_at) return "denied";
	if (row.profile_id) return "approved";
	return "pending";
}

/** The stored `user_code`, as the binding check reads it. */
export interface DeviceCodeUserCode {
	user_code: string | null;
}

/** Outcome of comparing a request's `user_code` against the stored one. */
export type UserCodeBinding =
	| { ok: true; bound: boolean }
	| { ok: false; reason: "user_code_mismatch" };

/**
 * Decides whether `userCode` may act on a `cli_logins` row.
 *
 * The `user_code` used to be client-minted and never persisted: `generate` validated its
 * shape and then never compared it against anything, so the code on the consent screen was
 * simply whatever the link said. Registration at `alethia login` time stores it, and every
 * later request — approve, deny, read — must present the same one.
 *
 * The three arms are not symmetric, on purpose:
 *
 *  - **No row at all** → `{ ok: true, bound: false }`. Nothing has been registered, so there
 *    is nothing to disagree with. The caller writes the code it was given, which is what
 *    binds it.
 *  - **A row with a NULL `user_code`** → the same. This is a row an already-shipped CLI
 *    created by approving directly, and refusing it would log out every user of every
 *    released binary the moment this deploys. `bound: false` is the honest report: this
 *    request carries no server-verified code and the caller must not claim otherwise.
 *  - **A stored code that differs** → refused. This is the only arm that is KNOWN wrong, and
 *    it is refused rather than coerced: a mismatch means the link in the browser and the
 *    process at the terminal are not the same login.
 *
 * Comparison is exact. The validators upstream already pin the shape to upper-case
 * `AAAA-BBBB`, so a case-folding compare would only ever widen what counts as a match.
 */
export function checkUserCodeBinding(
	existing: DeviceCodeUserCode | undefined,
	userCode: string,
): UserCodeBinding {
	if (!existing || existing.user_code === null) return { ok: true, bound: false };
	if (existing.user_code === userCode) return { ok: true, bound: true };
	return { ok: false, reason: "user_code_mismatch" };
}

/**
 * The longest a client-supplied descriptive field may be before it is cut.
 *
 * These strings are rendered on a consent screen, so their only job is to be READ. 200 is
 * past every honest value (a `user-agent` is ~120 characters, a semver is ~10) and short
 * enough that nobody can push the buttons off the page — or the useful text out of view —
 * by registering a request with a megabyte of "client name".
 */
export const CLIENT_METADATA_MAX_LENGTH = 200;

/**
 * Characters that must never survive into a line of the consent screen.
 *
 * Length is not the only way a client-supplied string can take a decision away from the
 * reader, and the cut above only answers length. These three families answer the rest, and
 * every one of them is reachable from `/api/auth/cli/start`, which is unauthenticated:
 *
 *  - **C0/C1 controls** (U+0000-U+001F, U+007F-U+009F). A newline in `client_name` turns one
 *    labelled line into two, and the second one is written by whoever registered the request.
 *    That is the whole impersonation move on a screen whose other lines are the server's.
 *  - **Bidi controls** - the marks (U+061C, U+200E, U+200F), the embeddings and overrides
 *    (U+202A-U+202E) and the isolates (U+2066-U+2069). An RTL override reverses the RENDERED
 *    order of everything after it while leaving the string equal to itself, so a value can read
 *    on screen as something it is not - and the reader is being asked to compare what they see
 *    against a terminal. All three of Unicode's implicit marks are here, U+061C included: it is
 *    in the same Bidi_Control set as LRM and RLM, and a class defined by a Unicode property that
 *    covers two of its three members is a class with a hole in it.
 *  - **Default-ignorable invisibles** - U+00AD SOFT HYPHEN, U+180E, the zero-width set
 *    (U+200B-U+200D), the word joiner and the invisible operators (U+2060-U+2064), U+FEFF, and
 *    the tag block (U+E0000-U+E007F). Invisible, so they split a word the eye reads as one: two
 *    `client_name`s that render identically are two different strings, and only one of them is
 *    the client anybody has heard of. U+2060 matters as much as U+FEFF and is easy to miss -
 *    U+FEFF is the DEPRECATED spelling of that function and U+2060 is what anyone reaching for a
 *    word joiner today actually reaches for. The tag block is the usual carrier for hidden text.
 *
 * React escapes markup already, so this is not about XSS. It is about a string that renders
 * as a different string than it is.
 *
 * Written as `\u` escapes rather than as the characters themselves. A literal C0 byte in a
 * source file is invisible in every diff and every review - which is the same property that
 * makes it worth stripping in the first place.
 *
 * The `u` flag is load-bearing: the tag block is above the BMP, and without it that range would
 * have to be spelt as surrogate pairs, which is how a range like it gets left out.
 */
const UNSAFE_DISPLAY_CHARS =
	/[\u0000-\u001F\u007F-\u009F\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\u{E0000}-\u{E007F}]/gu;

/**
 * Normalises one client-supplied descriptive field: a non-string, an empty string or a
 * blank one becomes null, anything in `UNSAFE_DISPLAY_CHARS` is neutralised, runs of
 * whitespace collapse to one space, and anything longer than `CLIENT_METADATA_MAX_LENGTH`
 * is cut.
 *
 * Null rather than `""` because the consent screen has to distinguish "the client did not
 * say" from "the client said nothing", and rendering an empty string as a value is how a
 * screen ends up showing a blank next to a label as though it were an answer.
 *
 * A stripped character becomes a SPACE and not nothing. Deleting a newline welds two words
 * into one (`alethia\ncli` → `alethiacli`), which changes the value the reader is being shown
 * rather than merely flattening it. The whitespace collapse that follows is what stops the
 * substitution from becoming its own padding attack — and it also answers the plain-space
 * version, where 150 spaces push the real value out of view and a forgery takes its place.
 *
 * Applied on BOTH sides on purpose. `/api/auth/cli/start` calls it so nothing unsafe is
 * stored, and `parseDeviceRequestView` calls it again on the way to the screen, because rows
 * written before this existed are still in the table and the writer is not the only thing
 * standing between an unauthenticated string and a consent surface.
 */
export function clientMetadataField(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const cleaned = value.replace(UNSAFE_DISPLAY_CHARS, " ").replace(/\s+/g, " ").trim();
	if (!cleaned) return null;
	return cleaned.slice(0, CLIENT_METADATA_MAX_LENGTH);
}

/**
 * Budget for `/api/auth/cli/start`, the one UNAUTHENTICATED route here that WRITES.
 *
 * Much tighter than `CLI_DEVICE_RATE_LIMIT`, because the traffic shape is the opposite:
 * `exchange` is polled every two seconds for the length of a login, whereas an honest
 * `alethia login` registers exactly once and retries at most a handful of times. 20/60s
 * still covers several people behind one NAT each starting a login in the same minute,
 * while bounding how many rows one address can insert into `cli_logins`.
 *
 * Same honesty as `CLI_DEVICE_RATE_LIMIT`: `lib/rate-limit.ts` is in-memory and
 * per-process, so a second replica or a restart resets the counter. A damper, not a control.
 */
export const CLI_DEVICE_START_RATE_LIMIT = { limit: 20, windowMs: 60_000 } as const;

/**
 * The JSON error shape every CLI device-code route answers in.
 *
 * One definition rather than a copy per route: the CLI switches on the STATUS and, for the
 * terminal refusal, on the `error` string, so two routes drifting into two shapes is a
 * client-side parse failure that shows up as "authentication failed" with nothing else.
 */
export function deviceCodeFail(error: string, status: number, description?: string) {
	return new Response(
		JSON.stringify(description ? { error, error_description: description } : { error }),
		{ status, headers: { "Content-Type": "application/json" } },
	);
}

/**
 * RFC 8628 §3.5's terminal error code for a request the user refused.
 *
 * A string constant because it is a WIRE value that two codebases have to agree on — the
 * exchange route writes it and `pollForToken` in apps/cli/cmd/login.go compares against it.
 * Spelt differently on either side, the CLI falls through to its generic
 * "authentication failed (HTTP 403)" arm and the user is told nothing about why.
 */
export const DEVICE_ACCESS_DENIED = "access_denied";

/**
 * The linked-account providers whose OAuth token approval hands to the CLI.
 *
 * ONE list, read by both the route that stashes the token (`/api/auth/cli/generate`) and
 * the one that tells the user it will be handed over (`/api/auth/cli/request`). Two copies
 * is how a consent screen ends up under-reporting: add a provider to the stash list alone
 * and approval starts handing over a token the screen never named.
 */
export const CLI_GIT_PROVIDERS = ["github", "gitlab", "bitbucket"] as const;

/** A provider whose token the device flow may hand over. */
export type CliGitProvider = (typeof CLI_GIT_PROVIDERS)[number];

/** Reports whether `providerId` is one whose token the device flow hands over. */
export function isCliGitProvider(providerId: string): providerId is CliGitProvider {
	return CLI_GIT_PROVIDERS.some((provider) => provider === providerId);
}

/** Display names for the providers, so the consent screen says "GitHub", not "github". */
const GIT_PROVIDER_LABELS: Record<CliGitProvider, string> = {
	github: "GitHub",
	gitlab: "GitLab",
	bitbucket: "Bitbucket",
};

/**
 * Every scope line the device flow can emit.
 *
 * A TUPLE and not just a union, because `parseDeviceRequestView` has to decide whether an id
 * arriving over the wire is one of these, and the alternative is a second hand-written list
 * that stops covering the day a fourth scope is added. The union below is derived from this,
 * so the set and the answer cannot drift apart.
 */
export const DEVICE_APPROVAL_SCOPE_IDS = [
	"cli_access_token",
	"cli_refresh_token",
	"git_provider_token",
] as const;

/** Stable identifier for one scope line. */
export type DeviceApprovalScopeId = (typeof DEVICE_APPROVAL_SCOPE_IDS)[number];

/** One line of "what approving this hands over", for the consent screen. */
export interface DeviceApprovalScope {
	/** Stable identifier, so the page can key and order without matching on prose. */
	id: DeviceApprovalScopeId;
	/** The short name of the thing being handed over. */
	label: string;
	/** What it lets the holder do, and for how long. */
	detail: string;
}

/**
 * Enumerates what pressing Approve actually hands to the terminal.
 *
 * The screen used to say "A device is asking to sign in to your account", which is true and
 * incomplete: approval returns the account's access token, a 90-day refresh token AND the
 * raw OAuth token of the first linked git provider. A git-provider token is materially more
 * than a sign-in — it is credential the user granted to Alethia being passed onward — and a
 * consent gesture is only worth what the person knew when they made it.
 *
 * `gitProvider` is null when no linked provider will contribute a token, and the third line
 * is then absent rather than hedged: a screen that lists a token that will not be handed
 * over teaches the user to discount the list.
 */
export function deviceApprovalScopes(
	gitProvider: CliGitProvider | null,
): DeviceApprovalScope[] {
	const scopes: DeviceApprovalScope[] = [
		{
			id: "cli_access_token",
			label: "An access token for your account",
			detail: "Lets the device act as you in the Alethia API. Expires after 1 hour.",
		},
		{
			id: "cli_refresh_token",
			label: "A refresh token",
			detail:
				"Lets the device mint new access tokens without asking you again, for 90 days.",
		},
	];
	if (gitProvider) {
		scopes.push({
			id: "git_provider_token",
			label: `Your ${GIT_PROVIDER_LABELS[gitProvider]} access token`,
			detail: `The OAuth token you granted Alethia for ${GIT_PROVIDER_LABELS[gitProvider]}, passed to the device as-is.`,
		});
	}
	return scopes;
}

/**
 * The lives a device request can be in as the CONSENT SCREEN sees them.
 *
 * `deviceRequestStatus` above answers three, off the columns. This adds `expired`, which is
 * not a column at all — it is `pending` plus a clock — because the screen has to distinguish
 * "waiting for you" from "the window closed while you were reading", and only the first of
 * those may offer a button.
 */
export const CLI_DEVICE_REQUEST_LIFECYCLES = [
	"pending",
	"approved",
	"denied",
	"expired",
] as const;

/** Where a device request is in its life, as `/api/auth/cli/request` reports it. */
export type CliDeviceRequestLifecycle = (typeof CLI_DEVICE_REQUEST_LIFECYCLES)[number];

/**
 * What `/cli/login` renders its consent screen from.
 *
 * It lives HERE and not in the route that answers it, because both ends need it and only one
 * of them may import the other: the page is a client component, and reaching into
 * `app/api/**` for a type drags a module that imports the service-role db handle into the
 * browser graph's import list. One declaration, two importers, no cast at the boundary.
 */
export interface CliDeviceRequestView {
	/** Where the request is in its life — `expired` once the decision window has closed. */
	status: CliDeviceRequestLifecycle;
	/** The code the CLI registered. Server-verified, unlike the one in the URL. */
	user_code: string;
	/** WHICH account approval would bind — the user may be signed into more than one. */
	account: { email: string | null; name: string | null };
	/** What the requesting client said about itself, plus the IP we saw it from. */
	requester: CliDeviceRequester;
	/** What approval actually hands over. */
	scopes: DeviceApprovalScope[];
	/** ISO-8601 deadline for the DECISION, or null on a row too old to carry one. */
	expires_at: string | null;
}

/**
 * Who is asking — three fields the CLIENT chose and one the SERVER observed.
 *
 * They are one object because they render as one block, and they must never render as one
 * KIND of fact: `client_name`, `client_version` and `user_agent` arrive from an
 * unauthenticated process that can say anything, while `request_ip` is what the trusted proxy
 * header carried. The screen labels the difference; this type is where the difference is
 * written down.
 */
export interface CliDeviceRequester {
	/** The product name the client reported. Untrusted. */
	client_name: string | null;
	/** The version the client reported. Untrusted. */
	client_version: string | null;
	/** The `user-agent` header on the registration request. Untrusted. */
	user_agent: string | null;
	/** The IP the trusted proxy header carried. Server-derived. */
	request_ip: string | null;
}

/**
 * Pulls the `error` string out of a JSON body one of the CLI device routes answered, falling
 * back to the CALLER'S sentence when the body is not the shape those routes document.
 *
 * The fallback is a parameter and not a constant because the callers are not interchangeable.
 * A failed approval and a failed refusal need different words — and the refusal's words carry
 * an instruction ("close your terminal") that a person who pressed "This isn't me" must not
 * lose to a proxy error page.
 *
 * `response.json()` is typed `any`, and CLAUDE.md §6 forbids one — so the body is taken as
 * `unknown` and narrowed. It is not merely a style rule here: this string is RENDERED to the
 * user as the reason their sign-in failed, and reaching through `any` would let `undefined`,
 * a number or an object land in that sentence. It is also length-bounded, because the body
 * being narrowed is not always ours: a proxy, an edge rate-limiter or a Next error page can
 * answer this fetch, and one of them putting a page of text in `error` would push the buttons
 * off the screen exactly the way an unbounded `client_name` would.
 */
export function serverErrorMessage(body: unknown, fallback: string): string {
	if (
		typeof body === "object" &&
		body !== null &&
		"error" in body &&
		typeof body.error === "string"
	) {
		const message = clientMetadataField(body.error);
		if (message) return message;
	}
	return fallback;
}

/** Narrows an arbitrary parsed JSON value to a plain object. */
function isJsonObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Narrows a value that the wire allows to be a string, `null`, or simply absent.
 *
 * A PREDICATE rather than the inline `x !== null && x !== undefined && typeof x !== "string"`
 * it replaces. That form reads as the same three questions and type-checks as none of them:
 * negating a conjunction leaves a disjunction, and a disjunction narrows `unknown` to nothing
 * — so the fields came out of the check still `unknown` and went into the view that way.
 */
function isNullableString(value: unknown): value is string | null | undefined {
	return value === null || value === undefined || typeof value === "string";
}

/**
 * Narrows one element of the wire `scopes` array.
 *
 * Returns null rather than a partial line. A scope the page cannot read is a scope it would
 * not RENDER, and the whole defect this screen exists to fix is a consent gesture made
 * against an incomplete list — so an unreadable element has to be able to fail the view,
 * not quietly shorten it.
 */
function parseApprovalScope(raw: unknown): DeviceApprovalScope | null {
	if (!isJsonObject(raw)) return null;
	const { id, label, detail } = raw;
	if (typeof id !== "string") return null;
	if (!DEVICE_APPROVAL_SCOPE_IDS.some((known) => known === id)) return null;
	if (typeof label !== "string" || label.trim() === "") return null;
	if (typeof detail !== "string" || detail.trim() === "") return null;
	// `id` is still a bare `string` to TypeScript after `.some()`, and CLAUDE.md §6 forbids
	// the cast that would fix that — so the union is reached by finding the member itself,
	// which narrows the VALUE rather than asserting it.
	const known = DEVICE_APPROVAL_SCOPE_IDS.find((candidate) => candidate === id);
	if (!known) return null;
	return { id: known, label, detail };
}

/**
 * Narrows the body of `GET /api/auth/cli/request` into the view the consent screen renders,
 * or null when the body is not that shape.
 *
 * WHY THIS IS NOT A CAST. The page must never show a field it did not actually receive. A
 * `body as CliDeviceRequestView` makes `undefined` type-check as a string and renders as
 * blank — a consent screen whose empty fields look like answers, which is the exact failure
 * `/api/auth/cli/request` returns 404 rather than an empty view to avoid. Everything the
 * route documents is checked here, and a body that fails any check produces no view at all.
 *
 * FAIL CLOSED, not lenient. Every arm returns null rather than substituting a default,
 * because the caller's null branch says "this request carries no server-verified detail" out
 * loud, and a default would say nothing.
 *
 * The requester's three client-supplied strings are re-normalised through
 * `clientMetadataField` on the way through. `/api/auth/cli/start` already did it, so for
 * anything registered since #4035 this is a no-op — but rows written before it exist, the
 * route reads them straight out of a JSONB column, and the last thing between an
 * unauthenticated string and a consent surface should not be a write path that ran months ago.
 */
export function parseDeviceRequestView(body: unknown): CliDeviceRequestView | null {
	if (!isJsonObject(body)) return null;

	// Each field is lifted into a local before it is checked. Narrowing a property PATH works,
	// but it is lost the moment anything reassigns along it — and this function's whole value
	// is that the object it returns was checked rather than asserted.
	const status = CLI_DEVICE_REQUEST_LIFECYCLES.find(
		(candidate) => candidate === body.status,
	);
	if (!status) return null;

	// The server-verified code. Shape-checked with the same validator the routes use, so a
	// body carrying a mangled one cannot put an unreadable string on screen as "the code to
	// compare" — which is the one thing on this page a person is asked to match by eye.
	const userCode = body.user_code;
	if (!isValidUserCode(userCode)) return null;

	const account = body.account;
	if (!isJsonObject(account)) return null;
	const email = account.email;
	const name = account.name;
	if (!isNullableString(email)) return null;
	if (!isNullableString(name)) return null;

	const rawRequester = body.requester;
	if (!isJsonObject(rawRequester)) return null;
	const requester: CliDeviceRequester = {
		client_name: clientMetadataField(rawRequester.client_name),
		client_version: clientMetadataField(rawRequester.client_version),
		user_agent: clientMetadataField(rawRequester.user_agent),
		request_ip: clientMetadataField(rawRequester.request_ip),
	};

	if (!Array.isArray(body.scopes)) return null;
	const rawScopes: unknown[] = body.scopes;
	const scopes: DeviceApprovalScope[] = [];
	for (const raw of rawScopes) {
		const scope = parseApprovalScope(raw);
		if (!scope) return null;
		scopes.push(scope);
	}
	// An EMPTY list is refused too. `deviceApprovalScopes` always emits at least the access
	// and refresh tokens, so zero lines means the body did not come from it — and "approving
	// hands over nothing" is the most reassuring thing this screen could wrongly say.
	if (scopes.length === 0) return null;

	// A deadline is optional (a row too old to carry one), but a PRESENT one has to be real.
	// An unparseable string would render as "Invalid Date" or as a NaN countdown, and a
	// countdown that reads wrong is worse than a screen that says there is no deadline.
	const rawExpiresAt = body.expires_at;
	let expires_at: string | null = null;
	if (typeof rawExpiresAt === "string") {
		if (!Number.isFinite(Date.parse(rawExpiresAt))) return null;
		expires_at = rawExpiresAt;
	} else if (rawExpiresAt !== null && rawExpiresAt !== undefined) {
		return null;
	}

	return {
		status,
		user_code: userCode,
		account: { email: email ?? null, name: name ?? null },
		requester,
		scopes,
		expires_at,
	};
}

/**
 * What the consent screen may do after trying to read the request view.
 *
 * `refused` and `unverified` are NOT the same answer, and collapsing them is the decision
 * this type exists to prevent — see `deviceRequestReadOutcome`.
 */
export type DeviceRequestRead =
	| { kind: "ok" }
	| { kind: "unverified"; reason: string }
	| { kind: "refused"; reason: string };

/**
 * The requester detail a request registered before #4035, or by a released CLI that predates
 * `/api/auth/cli/start`, will never have. Its own words, because the CLI prints the matching
 * half at the terminal ("The browser will show fewer details about this request.").
 */
const UNREGISTERED_REQUEST_REASON =
	"This login was started by a client that did not register its details, so Alethia cannot say who is asking or when the request expires.";

/**
 * Decides what a non-200 from `GET /api/auth/cli/request` means for the Approve button.
 *
 * THE WHOLE POINT IS THAT THE TWO FAILURE KINDS ARE DIFFERENT, and getting them the same way
 * round is the difference between a security fix and an outage:
 *
 *  - **refused** — the SERVER has told us this request is not approvable by this session: 400
 *    (the codes are malformed), 401 (no session) or 409 (bound to another account, or the
 *    `user_code` disagrees with the registered one). `/api/auth/cli/generate` applies the
 *    identical gates, so pressing Approve would fail anyway — the only thing the button adds is
 *    a wasted press and a worse error. It is not offered.
 *
 *  - **unverified** — the DETAIL could not be read, and nothing was said about the request
 *    itself: 404 (never registered), 429, any 5xx, or a transport failure with no status at
 *    all. Refusing here would sign out every already-shipped `alethia login` binary the day
 *    this deploys, because those never call `/start` and so leave no row to read — the same
 *    compatibility that makes `checkUserCodeBinding` permissive on a NULL `user_code` and
 *    `isPendingRequestExpired` fail open. Approval stays available and the screen SAYS the
 *    detail is missing; it does not quietly render a complete-looking consent screen.
 *
 * Refuse only what is known broken; warn on the unknown.
 *
 * A STATUS ALONE DOES NOT ESTABLISH WHO SPOKE, and that is why `serverError` is not merely the
 * wording. An edge WAF, a bot rule or a corporate proxy can put a 403 — or a 400 — on this
 * fetch; the query string carries a UUID and a dashed code, which is a shape WAFs do flag. Read
 * as a refusal, that removes the Approve button under the heading "Alethia will not approve this
 * request" for EVERY user at once and kills CLI login outright, with the console asserting a
 * refusal the server never made. That is precisely the outage the `unverified` arm exists to
 * prevent, reached through the other arm.
 *
 * So a refusal has to look like one of OURS: the status must be a refusal this route can
 * actually emit, AND the body must have parsed as the documented `{ error: <non-empty string> }`
 * shape (which is what a non-null `serverError` means here — see `serverErrorMessage`). A proxy's
 * HTML error page carries no such field and falls through to the warn side, where a thing nobody
 * can attribute belongs. 403 is absent from the list on the same evidence: `request/route.ts`
 * emits 400, 401, 404, 409 and 429 and no 403 at all, so a 403 on this fetch was written by
 * something that is not this route.
 *
 * @param status the HTTP status, or null when the request never got one (network, abort).
 * @param serverError the `error` string from the body, when the body carried the documented one.
 */
export function deviceRequestReadOutcome(
	status: number | null,
	serverError?: string | null,
): DeviceRequestRead {
	if (status === 200) return { kind: "ok" };

	const stated = clientMetadataField(serverError);
	if (stated && (status === 400 || status === 401 || status === 409)) {
		return { kind: "refused", reason: stated };
	}
	if (status === 404) {
		return { kind: "unverified", reason: UNREGISTERED_REQUEST_REASON };
	}
	return {
		kind: "unverified",
		reason:
			"Alethia could not load the details of this login request. Nothing below has been checked against the server.",
	};
}
