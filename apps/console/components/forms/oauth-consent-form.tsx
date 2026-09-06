"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Loader2 } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { Button } from "@repo/ui/button";

/** Human-readable copy for the OAuth scopes Better Auth's mcp() plugin can request. */
const SCOPE_LABELS: Record<string, string> = {
	openid: "Verify your identity",
	profile: "Read your basic profile (name, avatar)",
	email: "Read your email address",
	offline_access: "Stay connected without re-approving (refresh access)",
};

/**
 * OAuth consent screen for the MCP connector. Better Auth redirects here (when a
 * client requests prompt=consent) with ?consent_code&client_id&scope, having set a
 * signed oidc_consent_prompt cookie. Approve/Deny POSTs to the plugin's
 * /api/auth/oauth2/consent endpoint and navigates to the returned redirectURI
 * (back to the client with a code, or an access_denied error).
 */
export function OAuthConsentForm() {
	const searchParams = useSearchParams();
	const consentCode = searchParams.get("consent_code");
	const clientId = searchParams.get("client_id");
	const scopes = (searchParams.get("scope") ?? "")
		.split(" ")
		.map((s) => s.trim())
		.filter(Boolean);

	const [isLoading, setIsLoading] = useState(false);
	const [pending, setPending] = useState<"approve" | "deny" | null>(null);
	const [error, setError] = useState<string | null>(null);

	const decide = async (accept: boolean) => {
		setIsLoading(true);
		setPending(accept ? "approve" : "deny");
		setError(null);
		try {
			const res = await fetch("/api/auth/oauth2/consent", {
				method: "POST",
				headers: { "content-type": "application/json" },
				// same-origin → the session cookie rides along (the endpoint requires it).
				credentials: "include",
				body: JSON.stringify({ accept, consent_code: consentCode }),
			});
			const data: { redirectURI?: string } = await res.json().catch(() => ({}));
			if (!res.ok || !data.redirectURI) {
				throw new Error("Couldn't complete the request. The link may have expired.");
			}
			window.location.href = data.redirectURI;
		} catch (err) {
			setError(err instanceof Error ? err.message : "Something went wrong.");
			setIsLoading(false);
			setPending(null);
		}
	};

	// Missing the consent code → the page was opened directly, not via the OAuth flow.
	if (!consentCode) {
		return (
			<div className="space-y-3">
				<p className="vx-eyebrow">Authorize</p>
				<h1 className="font-grotesk text-display-sm font-semibold leading-[1.05] tracking-display text-text-primary">
					Nothing to authorize
				</h1>
				<p className="text-ui-lg text-text-tertiary">
					This page is part of connecting an external app. Start the connection from
					that app to continue.
				</p>
			</div>
		);
	}

	return (
		<div className="space-y-8">
			<div className="space-y-3">
				<p className="vx-eyebrow">Authorize</p>
				<h1 className="font-grotesk text-display-sm font-semibold leading-[1.05] tracking-display text-text-primary">
					Connect an external app
				</h1>
				<p className="text-ui-lg text-text-tertiary">
					An application
					{clientId ? (
						<>
							{" "}
							(<span className="font-mono text-text-primary">{clientId}</span>)
						</>
					) : null}{" "}
					is requesting access to your Alethia account.
				</p>
			</div>

			<div className="space-y-4">
				{error ? (
					<div className="bg-destructive/10 border border-destructive/20 text-destructive px-4 py-3 rounded-none text-sm">
						{error}
					</div>
				) : null}

				<div className="border border-border">
					<p className="vx-eyebrow px-4 pt-3 pb-2">It will be able to</p>
					<ul className="divide-y divide-border">
						{(scopes.length ? scopes : ["openid"]).map((scope) => (
							<li
								key={scope}
								className="px-4 py-3 text-sm text-text-primary flex items-baseline gap-2"
							>
								<span aria-hidden="true" className="text-text-tertiary">
									·
								</span>
								{SCOPE_LABELS[scope] ?? scope}
							</li>
						))}
					</ul>
				</div>

				<p className="text-xs text-text-tertiary">
					Access is read-only and bounded by your account permissions. You can revoke
					it anytime from settings.
				</p>

				<div className="flex gap-2">
					<Button
						type="button"
						onClick={() => decide(false)}
						disabled={isLoading}
						variant="outline"
						className="flex-1 h-12 text-sm font-medium"
					>
						{pending === "deny" ? (
							<Loader2 className="w-4 h-4 animate-spin" />
						) : (
							"Deny"
						)}
					</Button>
					<Button
						type="button"
						onClick={() => decide(true)}
						disabled={isLoading}
						className="flex-1 h-12 text-sm font-medium"
					>
						{pending === "approve" ? (
							<Loader2 className="w-4 h-4 animate-spin" />
						) : (
							"Approve"
						)}
					</Button>
				</div>
			</div>
		</div>
	);
}
