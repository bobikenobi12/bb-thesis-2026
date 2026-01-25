import { createClient } from "@/lib/supabase/server";
import { PublicGitProvider } from "@/lib/validations/db.schemas";
import { NextResponse } from "next/server";
import * as fs from 'fs';
import * as path from 'path';

export async function GET(request: Request) {
	const { searchParams, origin } = new URL(request.url);
	const code = searchParams.get("code");
	// if "next" is in param, use it as the redirect target
	const next = searchParams.get("next") ?? "/dashboard/profile";
	// Capture the provider from params if passed (critical for linking flows)
	const providerParam = searchParams.get("provider");

	if (code) {
		const supabase = await createClient();
		const { data, error } =
			await supabase.auth.exchangeCodeForSession(code);

		if (!error && data?.session) {
			const { session } = data;
			// Capture provider token
			const providerToken = session.provider_token;
			const refreshToken = session.provider_refresh_token;

			// Determine which provider this token belongs to.
			// 1. Prefer the explicit 'provider' param from the redirect URL.
			// 2. Fallback to 'app_metadata.provider' (works for initial login, but unreliable for linking).
			let provider = providerParam;
			
			if (!provider && session.user.app_metadata.provider) {
				provider = session.user.app_metadata.provider;
			}

            const logPath = path.join(process.cwd(), 'debug_auth.log');
            const logEntry = `[${new Date().toISOString()}] Provider: ${provider}, Param: ${providerParam}, Token: ${providerToken ? 'YES' : 'NO'}, Refresh: ${refreshToken ? 'YES' : 'NO'}, User: ${session.user.id}\n`;
            try {
                fs.appendFileSync(logPath, logEntry);
            } catch (e) {
                console.error("Failed to write to log file", e);
            }

            console.log("[Auth Callback] Debug Info:", {
                userId: session.user.id,
                hasProviderToken: !!providerToken,
                hasRefreshToken: !!refreshToken,
                detectedProvider: provider,
                paramProvider: providerParam,
                metaProvider: session.user.app_metadata.provider
            });

			// Validate if it's one of our supported git providers
			if (provider && ['github', 'gitlab', 'bitbucket'].includes(provider) && providerToken) {
				const { error: upsertError } = await supabase
					.from("provider_tokens")
					.upsert(
						{
							user_id: session.user.id,
							provider: provider as PublicGitProvider,
							access_token: providerToken,
							refresh_token: refreshToken,
							updated_at: new Date().toISOString(),
						},
						{
							onConflict: "user_id, provider",
						},
					);

				if (upsertError) {
					console.error("[Auth Callback] Failed to save provider token", upsertError);
                    try {
                        fs.appendFileSync(logPath, `[${new Date().toISOString()}] Upsert Error: ${JSON.stringify(upsertError)}\n`);
                    } catch (e) {}
				} else {
                    console.log("[Auth Callback] Successfully saved token for", provider);
                    try {
                        fs.appendFileSync(logPath, `[${new Date().toISOString()}] Upsert Success for ${provider}\n`);
                    } catch (e) {}
                }
			} else {
                console.warn("[Auth Callback] Skipping token save. Missing provider or token.", {
                    validProvider: provider && ['github', 'gitlab', 'bitbucket'].includes(provider),
                    validToken: !!providerToken
                });
                try {
                    fs.appendFileSync(logPath, `[${new Date().toISOString()}] Skipping save. ValidProvider: ${provider && ['github', 'gitlab', 'bitbucket'].includes(provider)}, ValidToken: ${!!providerToken}\n`);
                } catch (e) {}
            }

			const forwardedHost = request.headers.get("x-forwarded-host"); // original origin before load balancer
			const isLocalEnv = process.env.NODE_ENV === "development";

			if (isLocalEnv) {
				// we can be sure that there is no load balancer in between, so no need to watch for X-Forwarded-Host
				return NextResponse.redirect(`${origin}${next}`);
			} else if (forwardedHost) {
				return NextResponse.redirect(`https://${forwardedHost}${next}`);
			} else {
				return NextResponse.redirect(`${origin}${next}`);
			}
		}
	}

	// return the user to an error page with instructions
	return NextResponse.redirect(`${origin}/auth/auth-code-error`);
}