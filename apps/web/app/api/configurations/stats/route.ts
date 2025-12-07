import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

export const runtime = "edge";

// GET configuration statistics for the current user
export async function GET() {
	try {
		const supabase = await createClient();

		const {
			data: { user },
			error: userError,
		} = await supabase.auth.getUser();

		if (userError || !user) {
			return NextResponse.json(
				{ error: "Unauthorized" },
				{ status: 401 }
			);
		}

		// Get all configurations
		const { data: allConfigs, error: allError } = await supabase
			.from("configurations")
			.select("status, created_at")
			.eq("user_id", user.id);

		if (allError) {
			return NextResponse.json(
				{ error: allError.message },
				{ status: 500 }
			);
		}

		// Calculate stats
		const total = allConfigs?.length || 0;
		const draft =
			allConfigs?.filter((c) => c.status === "draft").length || 0;
		const completed =
			allConfigs?.filter((c) => c.status === "completed").length || 0;
		const archived =
			allConfigs?.filter((c) => c.status === "archived").length || 0;

		// Get recent count (last 7 days)
		const sevenDaysAgo = new Date();
		sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
		const recentCount =
			allConfigs?.filter((c) => new Date(c.created_at!) > sevenDaysAgo)
				.length || 0;

		return NextResponse.json({
			stats: {
				total,
				draft,
				completed,
				archived,
				recentCount,
			},
		});
	} catch (error) {
		console.error("[v0] Unexpected error:", error);
		return NextResponse.json(
			{ error: "Internal server error" },
			{ status: 500 }
		);
	}
}
