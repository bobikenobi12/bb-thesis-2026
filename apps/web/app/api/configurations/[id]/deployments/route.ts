import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

export async function GET(
	req: Request,
	{ params }: { params: { id: string } }
) {
	try {
		const supabase = await createClient();
		const {
			data: { session },
		} = await supabase.auth.getSession();

		if (!session) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		const { data, error } = await supabase
			.from("deployments")
			.select("*")
			.eq("configuration_id", params.id)
			.order("created_at", { ascending: false });

		if (error) {
			return NextResponse.json(
				{
					error: `Failed to fetch deployments: ${error.message}`,
				},
				{ status: 500 }
			);
		}

		return NextResponse.json({ deployments: data });
	} catch (error) {
		console.error("[v0] Error fetching deployments:", error);
		return NextResponse.json(
			{ error: "Failed to fetch deployments" },
			{ status: 500 }
		);
	}
}
