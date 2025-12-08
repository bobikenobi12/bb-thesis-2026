import { verifyCliToken } from "@/lib/cli/auth";
import { createServiceRoleClient } from "@/lib/supabase/service-role-client";
import { NextResponse } from "next/server";

export async function GET(req: Request) {
	const { payload, error: authError } = await verifyCliToken(req);
	if (authError) {
		return authError;
	}

	const userId = payload.sub;
	if (!userId) {
		return new Response(
			JSON.stringify({ error: "Invalid token payload" }),
			{
				status: 400,
			}
		);
	}

	const supabase = await createServiceRoleClient();
	const { data: configurations, error } = await supabase
		.from("configurations")
		.select("*")
		.eq("user_id", userId);

	if (error) {
		return new Response(JSON.stringify({ error: error.message }), {
			status: 500,
		});
	}

	return NextResponse.json({
		configurations,
	});
}
