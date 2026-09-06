"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { lookup } from "@/lib/typed-object";
import type React from "react";

import { authClient } from "@/lib/auth/client";
import { requestEmailCode } from "@/app/server/actions/auth";
import { track } from "@/lib/analytics/track";
import { safeNext } from "@/lib/auth/safe-next";
import { useAuthPrefsStore } from "@/lib/stores/use-auth-prefs-store";
import { arrayIncludes } from "@/lib/type-guards";
import { AuthCard } from "@/components/auth/auth-shell";
import { ProviderIcon, PROVIDER_LABELS, type Provider } from "@repo/ui/provider-icon";
import { Button } from "@repo/ui/button";
import { Input } from "@repo/ui/input";
import {
	InputOTP,
	InputOTPGroup,
	InputOTPSlot,
} from "@repo/ui/input-otp";
import { ArrowRight, KeyRound, Loader2, Lock } from "lucide-react";
import { REGEXP_ONLY_DIGITS } from "input-otp";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

type AuthProvider = "github" | "gitlab" | "bitbucket" | "google";
type Step = "providers" | "email" | "code" | "no-account";

export type AuthMode = "login" | "signup";

/** Leads the grid at full width — for a Kubernetes control plane it is GitHub. */
const PRIMARY_PROVIDER = "github" satisfies AuthProvider;
/** The rest, three-up beneath it. */
const SECONDARY_PROVIDERS: AuthProvider[] = ["google", "gitlab", "bitbucket"];
/** Everything the `?provider=` hint is allowed to name. */
const oauthProviders: AuthProvider[] = [PRIMARY_PROVIDER, ...SECONDARY_PROVIDERS];

/** Per-mode copy. Logic is identical — email-OTP (type "sign-in") creates the
 * user on first verify, so signup and login share the same code paths. */
const COPY: Record<
	AuthMode,
	{
		eyebrow: string;
		title: string;
		sub: string;
		emailEyebrow: string;
		emailTitle: string;
		verifyCta: string;
	}
> = {
	login: {
		eyebrow: "Welcome back",
		title: "Log in to Alethia",
		sub: "Your clusters are where you left them.",
		emailEyebrow: "Sign in",
		emailTitle: "Sign in with email",
		verifyCta: "Continue",
	},
	signup: {
		eyebrow: "Get started",
		title: "Create your account",
		sub: "Your first cluster, on any cloud.",
		emailEyebrow: "Get started",
		emailTitle: "Sign up with email",
		verifyCta: "Create account",
	},
};

/** Resend cooldown (seconds) — escalates with each resend (30s → 1m → 2m → 5m);
 *  the last value repeats. Guards against spamming the code-send endpoint. */
const RESEND_COOLDOWNS = [30, 60, 120, 300];

/** Formats a remaining-seconds count as `m:ss` (e.g. 29 → "0:29"). */
function fmtCountdown(seconds: number): string {
	const m = Math.floor(seconds / 60);
	const s = String(seconds % 60).padStart(2, "0");
	return `${m}:${s}`;
}

/**
 * Pulls a 6-digit code out of whatever was pasted — "418 902", "code: 418902", a whole
 * line lifted out of the email. Shared by the OTP field's own paste handling and the
 * step-level listener, so there is one definition of what a pasted code looks like.
 */
function digitsOnly(pasted: string): string {
	return pasted.replace(/\D/g, "").slice(0, 6);
}

/** Allowlisted banner copy keyed by `?error=` / `?message=`. Arbitrary querystring
 *  text is never rendered (anti-phishing) — unknown codes show no banner. */
const AUTH_MESSAGES: Record<string, string> = {
	oauth: "We couldn’t sign you in with that provider — try again.",
	access_denied: "Sign-in was cancelled.",
	session_expired: "Your session expired — please sign in again.",
	verify_email: "Check your email to finish signing in.",
	// The four reasons app/(public)/sso/[slug]/route.ts can bounce back with. They
	// arrive under `sso_error`, and none of them had an entry here — so every SP-
	// initiated SSO failure redirected to a login page that looked completely normal
	// and said nothing at all. An allowlist that silently drops a code its own
	// codebase emits is not an allowlist, it is a dropped error.
	unknown_org: "We don’t recognize that organization.",
	no_provider: "Single sign-on isn’t set up for that organization.",
	sso_unavailable: "Single sign-on is temporarily unavailable — try again shortly.",
	sign_in_unavailable: "We couldn’t start single sign-on — try again shortly.",
};

/** One OAuth provider tile — spinner while its own sign-in is in flight. */
function ProviderButton({
	provider,
	isLoading,
	loadingProvider,
	lastUsed,
	onSelect,
}: {
	provider: AuthProvider;
	isLoading: boolean;
	loadingProvider: string | null;
	/** Mark this tile as the method that carried the last sign-in through. */
	lastUsed?: boolean;
	onSelect: (provider: AuthProvider) => void;
}) {
	return (
		<Button
			type="button"
			variant="outline"
			onClick={() => onSelect(provider)}
			disabled={isLoading}
			aria-label={
				lastUsed ? `${lookup(PROVIDER_LABELS, provider)} (last used)` : undefined
			}
			className="h-[46px] w-full gap-[9px] border-border-strong text-ui-md hover:border-ring hover:bg-surface-muted"
		>
			{loadingProvider === provider ? (
				<Loader2 className="size-[17px] animate-spin" />
			) : (
				<ProviderIcon provider={provider} size={17} decorative />
			)}
			{lookup(PROVIDER_LABELS, provider)}
			{/* The pill is aria-hidden and the BUTTON names itself instead — the same
			    shape the SSO button uses for its "Soon". Letting the pill text join the
			    name by itself was the first attempt and it announced "GitHubLast used":
			    the accessible name concatenates descendant text and knows nothing about
			    `ml-1`, and a JSX {" "} between them does not survive the render (checked
			    in the DOM — the text node is simply absent). An explicit label is the
			    only version whose spacing is not a guess.

			    Visually unchanged: `vx-badge-mono` carries font, tracking and colour but
			    no border or padding, so those come in here. */}
			{lastUsed ? (
				<span
					aria-hidden="true"
					className="vx-badge-mono ml-1 border border-border-strong px-1.5 py-px"
				>
					Last used
				</span>
			) : null}
		</Button>
	);
}

interface AuthFormProps {
	mode: AuthMode;
}

/**
 * Passwordless auth form for both `/login` and `/signup`. Three steps —
 * providers → email → code — keeping the email entry on its own card (Alethia's
 * variant of the design, which inlines it). On success a new account lands in
 * the `/onboarding` flow; an existing sign-in resumes `next` / `/dashboard`.
 */
export function AuthForm({ mode }: AuthFormProps) {
	const copy = COPY[mode];
	const searchParams = useSearchParams();
	const router = useRouter();

	// URL params: prefill the email (and skip the provider grid), validate `next`,
	// and surface an allowlisted banner message.
	const prefillEmail = searchParams.get("email") ?? "";
	const next = safeNext(searchParams.get("next"));

	// What the browser remembers from last time. Read AFTER mount, never during render:
	// this form is server-prerendered and then hydrated, so a first client render that
	// consulted localStorage would not match the server's HTML. Same shape as
	// packages/ui/src/theme-toggle.tsx — the DOM is identical on the first client render
	// and the remembered marks appear on the second.
	const rememberedMethod = useAuthPrefsStore((s) => s.lastMethod);
	const rememberedEmail = useAuthPrefsStore((s) => s.lastEmail);
	const remember = useAuthPrefsStore((s) => s.remember);
	const forget = useAuthPrefsStore((s) => s.forget);
	const [mounted, setMounted] = useState(false);
	/** Wraps the OTP field, so the window paste listener can tell "already handled" from "not". */
	const otpRef = useRef<HTMLDivElement>(null);
	useEffect(() => setMounted(true), []);
	const lastMethod = mounted ? rememberedMethod : null;

	const [step, setStep] = useState<Step>(prefillEmail ? "email" : "providers");
	const [isLoading, setIsLoading] = useState(false);
	const [loadingProvider, setLoadingProvider] = useState<string | null>(null);
	const [email, setEmail] = useState(prefillEmail);
	// Pre-fill the remembered address once, after mount, and only when the field is
	// still empty — a `?email=` param, or anything already typed, wins.
	//
	// The VALUE only. `step` is initialised from `prefillEmail`, and feeding remembered
	// state into that would move a returning user off the provider tiles and onto the
	// email form a beat after the page settled, which is a worse experience than the one
	// this is meant to improve.
	useEffect(() => {
		if (!mounted || prefillEmail) return;
		setEmail((current) => current || (rememberedEmail ?? ""));
	}, [mounted, prefillEmail, rememberedEmail]);
	const [code, setCode] = useState("");
	const [error, setError] = useState<string | null>(() => {
		const code =
			searchParams.get("error") ??
			searchParams.get("message") ??
			searchParams.get("sso_error");
		return code ? (AUTH_MESSAGES[code] ?? null) : null;
	});

	// Resend guard: number of resends so far + seconds left before resend re-enables.
	const [resendCount, setResendCount] = useState(0);
	const [cooldown, setCooldown] = useState(0);

	// Tick the cooldown down once per second while it's active.
	useEffect(() => {
		if (cooldown <= 0) return;
		const id = setTimeout(() => setCooldown((s) => s - 1), 1000);
		return () => clearTimeout(id);
	}, [cooldown]);

	/** Arms the cooldown for the given (cumulative) resend count, escalating the wait. */
	const armCooldown = (count: number) =>
		setCooldown(RESEND_COOLDOWNS[Math.min(count, RESEND_COOLDOWNS.length - 1)]);

	// OAuth-resume context: Better Auth's mcp() plugin redirects an unauthenticated
	// /api/auth/mcp/authorize request here with the original authorize query appended
	// (client_id, response_type, redirect_uri, …). After we sign the user in, the flow
	// must return to the authorize endpoint to mint the code. Social login resumes
	// automatically (the callback is a full-page nav the plugin's after-hook catches);
	// email-OTP verifies over XHR, so we must navigate back ourselves.
	const isOAuthResume =
		searchParams.has("client_id") && searchParams.has("response_type");
	const resumeUrl = `/api/auth/mcp/authorize?${searchParams.toString()}`;

	// Where a successful auth lands. New accounts (signup) go to the onboarding
	// wizard; the wizard itself is also gated server-side as a safety net.
	const successDestination = isOAuthResume
		? resumeUrl
		: mode === "signup"
			? (next ?? "/onboarding")
			: (next ?? "/dashboard");

	const handleOAuthLogin = async (provider: AuthProvider) => {
		setIsLoading(true);
		setLoadingProvider(provider);
		setError(null);

		// Native providers go through signIn.social; self-hosted GitLab +
		// Bitbucket are wired via the genericOAuth plugin (signIn.oauth2). Both
		// redirect the browser, so control only returns here on error.
		// First-time OAuth users land in onboarding (carrying `next`); existing users
		// resume `next`/dashboard. Provider failures bounce back with ?error=oauth.
		const callbackURL = successDestination;
		const newUserCallbackURL = isOAuthResume
			? resumeUrl
			: next
				? `/onboarding?next=${encodeURIComponent(next)}`
				: "/onboarding";
		const errorCallbackURL = `${mode === "signup" ? "/signup" : "/login"}?error=oauth`;
		// 1.7 promoted the generic providers (gitlab, bitbucket) to first-class social
		// providers and deleted `signIn.oauth2`, so the github/google split is gone —
		// one call now covers every provider.
		// Remember the choice before handing off. OAuth leaves the page, so there is no
		// "after" to run here — this is the last moment this code is alive.
		//
		// That makes the write optimistic, so EVERY path that does not reach the provider
		// has to roll it back: the error branch below, and the no-url/no-error branch at
		// the end. Both call forget(). Only the `window.location.href` hand-off keeps the
		// mark. This comment used to assert that a failed attempt never leaves a mark
		// while the third branch quietly did — the invariant is only worth stating if
		// every exit actually holds it.
		remember(provider);

		const { data, error } = await authClient.signIn.social({
			provider,
			callbackURL,
			newUserCallbackURL,
			errorCallbackURL,
		});

		if (error) {
			// The hand-off never happened — don't leave "Last used" on a tile that failed.
			forget();
			setError(error.message ?? `Failed to sign in with ${provider}`);
			setIsLoading(false);
			setLoadingProvider(null);
			return;
		}
		// Better Auth's redirect plugin normally navigates on `{ url, redirect: true }`,
		// but don't depend on it — redirect explicitly so the button never hangs on the
		// spinner. If there's neither a url nor an error, surface it instead of spinning.
		if (data && "url" in data && typeof data.url === "string" && data.url) {
			window.location.href = data.url;
			return;
		}
		// Third exit, and the one the rollback originally missed: no url AND no error, so
		// the hand-off never happened either. Without this the tile keeps its "Last used"
		// mark and the form goes on recommending the provider that most recently failed.
		forget();
		setError(`Could not start ${provider} sign-in. Please try again.`);
		setIsLoading(false);
		setLoadingProvider(null);
	};

	// `?provider=github` (etc.) auto-starts that OAuth provider once — one-click
	// deep links from marketing/docs. Validated against the allowlist.
	const providerHintFired = useRef(false);
	useEffect(() => {
		if (providerHintFired.current) return;
		const hinted = searchParams.get("provider");
		if (hinted && arrayIncludes(oauthProviders, hinted)) {
			providerHintFired.current = true;
			void handleOAuthLogin(hinted);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const sendCode = async () => {
		const { error } = await authClient.emailOtp.sendVerificationOtp({
			email,
			type: "sign-in",
		});
		if (error) throw new Error(error.message ?? "Failed to send code");
	};

	const handleSendCode = async (e: React.FormEvent) => {
		e.preventDefault();
		setIsLoading(true);
		setLoadingProvider("email");
		setError(null);

		try {
			// Gate the login flow: an unknown email is emailed a "sign up" message
			// instead of silently creating an account. Signup always proceeds.
			const { outcome } = await requestEmailCode({ email, mode });
			if (outcome === "no-account") {
				setStep("no-account");
				return;
			}
			await sendCode();
			track("signup_email_requested", { mode });
			setCode("");
			setStep("code");
			setResendCount(0);
			armCooldown(0);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to send code");
		} finally {
			setIsLoading(false);
			setLoadingProvider(null);
		}
	};

	const handleVerify = async (value: string) => {
		if (value.length < 6 || isLoading) return;
		setIsLoading(true);
		setLoadingProvider("verify");
		setError(null);

		const { error } = await authClient.signIn.emailOtp({ email, otp: value });
		if (error) {
			setError("That code didn’t work — try again.");
			setCode("");
			setIsLoading(false);
			setLoadingProvider(null);
			return;
		}
		track("login_succeeded", { method: "otp" });
		// Verified, so this address is worth keeping — see the note on `lastEmail`.
		remember("email", email);
		// Resume the OAuth authorize flow with a full-page navigation (the user now
		// has a session) so the redirect to the connector lands in the browser.
		if (isOAuthResume) {
			window.location.href = resumeUrl;
			return;
		}
		router.push(successDestination);
	};

	// Paste anywhere on the code step. The OTP field handles its own paste, but only
	// while one of its slots holds focus — and the natural gesture after switching to the
	// mail app and back is Cmd-V against a page nobody has clicked. This catches that.
	//
	// It defers to the field whenever the paste is already headed there (checked via the
	// event target, not activeElement, so a slot that is focused but not the target still
	// resolves correctly), so a code is never applied twice.
	useEffect(() => {
		if (step !== "code") return;
		const onPaste = (e: ClipboardEvent) => {
			const target = e.target;
			if (target instanceof Node && otpRef.current?.contains(target)) return;
			const pasted = digitsOnly(e.clipboardData?.getData("text") ?? "");
			if (pasted.length < 6) return;
			e.preventDefault();
			setCode(pasted);
			void handleVerify(pasted);
		};
		window.addEventListener("paste", onPaste);
		return () => window.removeEventListener("paste", onPaste);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [step, email, isLoading]);

	const handleResend = async () => {
		if (cooldown > 0 || isLoading) return;
		setIsLoading(true);
		setLoadingProvider("resend");
		setError(null);
		try {
			await sendCode();
			setCode("");
			const next = resendCount + 1;
			setResendCount(next);
			armCooldown(next);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to resend code");
		} finally {
			setIsLoading(false);
			setLoadingProvider(null);
		}
	};

	/** Back to the email step, clearing the half-typed code and any stale error. */
	const backToEmail = () => {
		setStep("email");
		setCode("");
		setError(null);
	};

	// `role="alert"`: on a failed verification the text swaps in place and the OTP
	// field clears underneath it. A sighted user sees both; without a live region a
	// screen-reader user got neither.
	const errorBanner = error ? (
		<div
			role="alert"
			className="border border-destructive/20 bg-destructive/10 px-4 py-3 text-sm text-destructive"
		>
			{error}
		</div>
	) : null;

	// Step 3 — enter the 6-digit code.
	if (step === "code") {
		return (
			<AuthCard key={step}>
				<div className="mb-6 flex flex-col gap-2.5">
					<p className="vx-eyebrow">Verify</p>
					<h1 className="font-grotesk text-display-sm font-semibold leading-[1.05] tracking-display text-text-primary">
						Enter your code
					</h1>
					<p className="text-ui-lg leading-[1.55] text-text-secondary">
						We sent a 6-digit code to{" "}
						<span className="font-medium text-text-primary">{email}</span>.{" "}
						<button
							type="button"
							onClick={backToEmail}
							className="text-text-tertiary underline underline-offset-2 transition-colors hover:text-text-primary"
						>
							Change
						</button>
					</p>
				</div>

				<div className="space-y-4">
					{errorBanner}

					{/* The wrapper carries the ref the window paste listener tests against —
					    InputOTP renders a hidden field plus the slots, so there is no single
					    node of its own to point at. */}
					<div ref={otpRef}>
					<InputOTP
						maxLength={6}
						value={code}
						onChange={setCode}
						onComplete={handleVerify}
						pattern={REGEXP_ONLY_DIGITS}
						// Strip spaces/labels so pasting the grouped code from the email
						// ("418 902") or "code: 418902" fills all six boxes.
						pasteTransformer={digitsOnly}
						disabled={isLoading}
						// Never let session replay capture the login code (OTP digits render as text, not
						// a masked <input>, so maskAllInputs alone wouldn't hide them).
						data-ph-mask
						containerClassName="w-full"
						autoFocus
					>
						<InputOTPGroup className="grid w-full grid-cols-6 gap-[9px]">
							{[0, 1, 2, 3, 4, 5].map((i) => (
								<InputOTPSlot
									key={i}
									index={i}
									className="h-14 w-full border-border-strong bg-surface-sunken font-mono text-[22px] font-medium"
								/>
							))}
						</InputOTPGroup>
					</InputOTP>
					</div>

					<PrimaryButton
						type="button"
						onClick={() => handleVerify(code)}
						disabled={isLoading || code.length < 6}
						loading={loadingProvider === "verify"}
						loadingLabel="Verifying…"
					>
						{copy.verifyCta}
					</PrimaryButton>

					<div className="flex items-center justify-between text-ui-md">
						<button
							type="button"
							onClick={backToEmail}
							className="text-text-tertiary transition-colors hover:text-text-primary"
						>
							← Use a different email
						</button>
						<button
							type="button"
							onClick={handleResend}
							disabled={isLoading || cooldown > 0}
							className="text-text-tertiary transition-colors hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
						>
							{cooldown > 0
								? `Resend in ${fmtCountdown(cooldown)}`
								: loadingProvider === "resend"
									? "Sending…"
									: "Resend code"}
						</button>
					</div>
				</div>
			</AuthCard>
		);
	}

	// No account for this email (login only) — we emailed a sign-up prompt.
	if (step === "no-account") {
		const signupParams = new URLSearchParams();
		if (email) signupParams.set("email", email);
		if (next) signupParams.set("next", next);
		const signupHref = signupParams.toString()
			? `/signup?${signupParams.toString()}`
			: "/signup";
		return (
			<AuthCard key={step}>
				<div className="mb-6 flex flex-col gap-2.5">
					<p className="vx-eyebrow">No account</p>
					<h1 className="font-grotesk text-display-sm font-semibold leading-[1.05] tracking-display text-text-primary">
						No account for this email
					</h1>
					<p className="text-ui-lg leading-[1.55] text-text-secondary">
						We couldn’t find an Alethia account for{" "}
						<span className="font-medium text-text-primary">{email}</span>. We’ve
						emailed you a link to create one.
					</p>
				</div>

				<div className="space-y-4">
					<PrimaryButton
						type="button"
						onClick={() => router.push(signupHref)}
						loadingLabel="Redirecting…"
					>
						Create an account
					</PrimaryButton>

					<button
						type="button"
						onClick={() => {
							setStep("email");
							setError(null);
						}}
						className="mx-auto block text-ui-md text-text-tertiary transition-colors hover:text-text-primary"
					>
						← Use a different email
					</button>
				</div>
			</AuthCard>
		);
	}

	// Step 2 — enter email.
	if (step === "email") {
		return (
			<AuthCard key={step}>
				<div className="mb-6 flex flex-col gap-2.5">
					<p className="vx-eyebrow">{copy.emailEyebrow}</p>
					<h1 className="font-grotesk text-display-sm font-semibold leading-[1.05] tracking-display text-text-primary">
						{copy.emailTitle}
					</h1>
				</div>

				<form onSubmit={handleSendCode} className="flex flex-col gap-[9px]">
					{errorBanner}

					<div className="flex flex-col gap-2">
						<label
							htmlFor="email"
							className="font-mono text-ui-2xs uppercase tracking-[0.14em] text-text-tertiary"
						>
							Work email
						</label>
						{/* The clamp is on this wrapper, not on the Input: a replaced
						    element renders no ::before, so an <input> cannot draw its own
						    corner marks. --field makes the wrapper answer to the focus of
						    the input inside it. */}
						<div className="vx-clamp vx-clamp--tight vx-clamp--field">
							<Input
								id="email"
								type="email"
								placeholder="name@company.com"
								value={email}
								onChange={(e) => setEmail(e.target.value)}
								required
								disabled={isLoading}
								autoFocus
								className="h-[46px] w-full border-border-strong bg-surface-sunken text-sm"
							/>
						</div>
					</div>

					<PrimaryButton
						type="submit"
						disabled={isLoading || !email}
						loading={loadingProvider === "email"}
						loadingLabel="Sending code…"
					>
						Continue with email
					</PrimaryButton>

					<button
						type="button"
						onClick={() => {
							setStep("providers");
							setError(null);
						}}
						className="mx-auto mt-2 block text-ui-md text-text-tertiary transition-colors hover:text-text-primary"
					>
						← Other sign-in options
					</button>
				</form>
			</AuthCard>
		);
	}

	// Step 1 — provider list.
	return (
		<AuthCard key={step}>
			<div className="mb-6 flex flex-col gap-2.5">
				<p className="vx-eyebrow">{copy.eyebrow}</p>
				<h1 className="font-grotesk text-display-sm font-semibold leading-[1.05] tracking-display text-text-primary">
					{copy.title}
				</h1>
				<p className="text-ui-lg leading-[1.55] text-text-secondary">
					{copy.sub}
				</p>
			</div>

			<div className="space-y-[9px]">
				{errorBanner}

				{/* A flat 2x2 of four equal tiles said "we have no idea which one you
				    want". For a Kubernetes control plane it is overwhelmingly GitHub, so
				    it leads at full width and the other three share a row. The e2e specs
				    select by accessible name, so nothing here is position-dependent. */}
				<ProviderButton
					provider={PRIMARY_PROVIDER}
					isLoading={isLoading}
					loadingProvider={loadingProvider}
					lastUsed={lastMethod === PRIMARY_PROVIDER}
					onSelect={handleOAuthLogin}
				/>
				<div className="grid grid-cols-3 gap-[9px]">
					{SECONDARY_PROVIDERS.map((provider) => (
						<ProviderButton
							key={provider}
							provider={provider}
							isLoading={isLoading}
							loadingProvider={loadingProvider}
							lastUsed={lastMethod === provider}
							onSelect={handleOAuthLogin}
						/>
					))}
				</div>

				<div className="flex items-center gap-3.5 py-2">
					<span className="h-px flex-1 bg-border" />
					<span className="font-mono text-ui-2xs uppercase tracking-[0.18em] text-text-disabled">
						or
					</span>
					<span className="h-px flex-1 bg-border" />
				</div>

				<Button
					type="button"
					variant="outline"
					onClick={() => {
						setStep("email");
						setError(null);
					}}
					disabled={isLoading}
					className="group h-[46px] w-full gap-[9px] border-border-strong text-ui-md hover:border-ring hover:bg-surface-muted"
				>
					<KeyRound className="size-4 opacity-80" />
					Continue with email
					{lastMethod === "email" ? (
						<span
							aria-hidden="true"
							className="vx-badge-mono ml-1 border border-border-strong px-1.5 py-px"
						>
							Last used
						</span>
					) : null}
				</Button>

				{/* SSO — not wired yet; visible but disabled (coming soon). An e2e spec
				    asserts it is present AND disabled, so neither may change here. What
				    could change is where it sits: it used to be the first full-width
				    control under the provider grid, so a third of the visible options
				    were dead before the visitor read a word. It now follows the live
				    ones. The spec selects by accessible name, so the move is free.

				    The raw <button>s elsewhere in this file are inline TEXT affordances
				    — "← Other sign-in options", "Resend", the back-links. They are
				    deliberately not `Button`: they have no box for the clamp to grip,
				    and the `link` variant would underline them. */}
				<Button
					type="button"
					variant="outline"
					disabled
					title="SSO is coming soon"
					aria-label="Continue with SSO (coming soon)"
					className="h-[46px] w-full cursor-not-allowed gap-[9px] border-border-strong text-ui-md opacity-55"
				>
					<Lock className="size-4 opacity-80" />
					Continue with SSO
					<span className="vx-badge-mono ml-1 border border-border-strong px-1.5 py-px">
						Soon
					</span>
				</Button>

			</div>
		</AuthCard>
	);
}

/**
 * The primary action, 46px with an arrow that nudges on hover.
 *
 * It used to pass `bg-ink text-ink-foreground hover:bg-ink-hover`, which is the
 * `default` variant restated by hand — so the variant was overridden with a copy of
 * itself and drifted from it for free. Only the size and the group hook are local now.
 */
function PrimaryButton({
	loading,
	loadingLabel,
	children,
	...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
	loading?: boolean;
	loadingLabel: string;
}) {
	return (
		<Button
			{...props}
			className="group relative h-[46px] w-full text-sm"
		>
			{loading ? (
				<>
					<Loader2 className="mr-1 size-4 animate-spin" />
					{loadingLabel}
				</>
			) : (
				<>
					{children}
					<ArrowRight className="ml-1 size-4 transition-transform group-hover:translate-x-[3px]" />
					{/* Every form this button ends submits on Enter; the affordance just
					    says so. aria-hidden and absolutely positioned on purpose: the
					    accessible name has to stay exactly "Continue with email" /
					    "Create account", because the e2e fixtures match those and
					    capture.setup.ts needs /continue with email/i to resolve to one
					    node per step. Hidden below `sm` — on a touch keyboard there is
					    no Enter key to point at. */}
					<span
						aria-hidden="true"
						className="vx-badge-mono absolute right-3 hidden border border-current/25 px-1 py-px opacity-45 sm:inline"
					>
						↵
					</span>
				</>
			)}
		</Button>
	);
}
