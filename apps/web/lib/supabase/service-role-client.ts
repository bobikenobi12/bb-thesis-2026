import { Database } from "@/types/database.types";
import { createClient } from "@supabase/supabase-js";

export async function createServiceRoleClient() {
    return createClient<Database>(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SERVICE_ROLE_SECRET!,
        {
            auth: {
                persistSession: false,
                autoRefreshToken: false,
                detectSessionInUrl: false,
            },
        },
    );
}
