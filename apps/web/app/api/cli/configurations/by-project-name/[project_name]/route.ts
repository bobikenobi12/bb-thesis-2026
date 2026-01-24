import { verifyCliToken } from "@/lib/cli/auth";
import { createServiceRoleClient } from "@/lib/supabase/service-role-client";
import { NextResponse } from "next/server";

export async function GET(
	req: Request,
	{ params }: { params: Promise<{ project_name: string }> }
) {
	try {
		const { payload, error: authError } = await verifyCliToken(req);
		if (authError) {
			return authError;
		}

		const userId = payload.sub;
		if (!userId) {
			return NextResponse.json(
				{ error: "Invalid token payload" },
				{ status: 400 }
			);
		}

		const supabase = await createServiceRoleClient();

		const { project_name } = await params;
		const { data, error } = await supabase
			.from("configurations")
			.select("*")
			.eq("project_name", project_name)
			.eq("user_id", userId)
			.single();

		if (error) {
			if (error.code === "PGRST116") {
				// No rows found
				return NextResponse.json(
					{ error: "Configuration not found" },
					{ status: 404 }
				);
			}
			return NextResponse.json(
				{ error: `Failed to fetch configuration: ${error.message}` },
				{ status: 500 }
			);
		}

		return NextResponse.json({ configuration: data });
	} catch (error) {
		console.error("[v0] Error fetching configuration:", error);
		return NextResponse.json(
			{ error: "Failed to fetch configuration" },
			{ status: 500 }
		);
	}
}
