import { SupabaseClient } from "@supabase/supabase-js";

export async function getProviderToken(
	supabase: SupabaseClient,
	provider: "github" | "gitlab" | "bitbucket"
): Promise<string | null> {
	const {
		data: { session },
	} = await supabase.auth.getSession();

	if (!session) return null;

	// 1. Check current session
	if (
		session.provider_token &&
		session.user.app_metadata.provider === provider
	) {
		return session.provider_token;
	}

	// 2. Check database
	const { data } = await supabase
		.from("provider_tokens" as any)
		.select("access_token")
		.eq("provider", provider)
		.eq("user_id", session.user.id)
		.single();

	return data?.access_token || null;
}
