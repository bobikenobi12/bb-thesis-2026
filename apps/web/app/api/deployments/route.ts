import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

export async function POST(req: Request) {
	try {
		const supabase = await createClient();
		const {
			data: { session },
		} = await supabase.auth.getSession();

		if (!session) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		const { configuration_id, name, iac_tool, terraform_version } =
			await req.json();
		if (!configuration_id || !name || !iac_tool) {
			return NextResponse.json(
				{
					error:
						"configuration_id, name, and iac_tool are required.",
				},
				{ status: 400 }
			);
		}

		const { data, error } = await supabase
			.from("deployments")
			.insert({
				configuration_id,
				name,
				iac_tool,
				terraform_version,
				profile_id: session.user.id,
				status: "pending",
			})
			.select()
			.single();

		if (error) {
			return NextResponse.json(
				{ error: `Failed to create deployment: ${error.message}` },
				{ status: 500 }
			);
		}

		return NextResponse.json({ deployment: data }, { status: 201 });
	} catch (error) {
		console.error("[v0] Error creating deployment:", error);
		return NextResponse.json(
			{ error: "Failed to create deployment" },
			{ status: 500 }
		);
	}
}
