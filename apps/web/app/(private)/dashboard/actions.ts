"use server";

import { createClient } from "@/lib/supabase/server";
import { PublicGitProvider } from "@/lib/validations/db.schemas";

export async function hasCloudIdentity() {
	const supabase = await createClient();
	const {
		data: { user },
	} = await supabase.auth.getUser();

	if (!user) return false;

	const { count, error } = await supabase
		.from("cloud_identities")
		.select("*", { count: "exact", head: true })
		.eq("user_id", user.id)
		.eq("is_verified", true);

	if (error) {
		console.error("Error checking cloud identities:", error);
		return false;
	}

	return (count || 0) > 0;
}

export async function getLinkedProviders() {
	const supabase = await createClient();
	const {
		data: { user },
	} = await supabase.auth.getUser();

	if (!user) return [];

	const { data, error } = await supabase
		.from("provider_tokens")
		.select("provider")
		.eq("user_id", user.id);

	if (error) {
		console.error("Error fetching linked providers:", error);
		return [];
	}

	return data?.map((p) => p.provider) || [];
}

export async function saveProviderToken(
	provider: PublicGitProvider,
	accessToken: string,
	refreshToken?: string,
) {
	const supabase = await createClient();
	const {
		data: { user },
	} = await supabase.auth.getUser();

	if (!user) {
		throw new Error("User not authenticated");
	}

	const { error } = await supabase.from("provider_tokens").upsert(
		{
			user_id: user.id,
			provider,
			access_token: accessToken,
			refresh_token: refreshToken,
			updated_at: new Date().toISOString(),
		},
		{
			onConflict: "user_id, provider",
		},
	);

	if (error) {
		console.error("Error saving provider token:", error);
		throw new Error("Failed to save provider token");
	}

	return { success: true };
}
