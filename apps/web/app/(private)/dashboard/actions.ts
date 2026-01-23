"use server";

import { createClient } from "@/lib/supabase/server";

export async function hasCloudIdentity() {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    
    if (!user) return false;

    const { count, error } = await supabase
        .from("cloud_identities")
        .select("*", { count: 'exact', head: true })
        .eq("user_id", user.id)
        .eq("is_verified", true);

    if (error) {
        console.error("Error checking cloud identities:", error);
        return false;
    }

    return (count || 0) > 0;
}
