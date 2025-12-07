import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service-role-client";
import { NextResponse } from "next/server";

export async function POST(req: Request) {
	const supabase = await createClient();
	const {
		data: { session },
	} = await supabase.auth.getSession();

	if (!session) {
		return new Response(JSON.stringify({ error: "Unauthorized" }), {
			status: 401,
			headers: { "Content-Type": "application/json" },
		});
	}

	const { device_code } = await req.json();
	if (!device_code) {
		return new Response(JSON.stringify({ error: "Missing device_code" }), {
			status: 400,
			headers: { "Content-Type": "application/json" },
		});
	}

	const supabaseServiceRole = await createServiceRoleClient();

	const { error } = await supabaseServiceRole.from("cli_logins").upsert({
		device_code,
		profile_id: session.user.id,
	});

	if (error) {
		console.error("Error saving CLI login attempt:", error);
		return new Response(
			JSON.stringify({ error: "Failed to save login attempt" }),
			{
				status: 500,
				headers: { "Content-Type": "application/json" },
			}
		);
	}

	return NextResponse.json({ success: true });
}
