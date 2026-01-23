import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

export async function PUT(
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

		const { status, error_message } = await req.json();
		if (!status) {
			return NextResponse.json(
				{ error: "Status is required." },
				{ status: 400 }
			);
		}

		const { data: existingDeployment, error: fetchError } = await supabase
			.from("deployments")
			.select("started_at")
			.eq("id", params.id)
			.single();

		if (fetchError) {
			return NextResponse.json(
				{
					error: `Failed to fetch deployment: ${fetchError.message}`,
				},
				{ status: 500 }
			);
		}

		const updateData: any = {
			status,
			error_message,
		};

		if (status === "completed" || status === "failed") {
			const completedAt = new Date();
			const startedAt = new Date(existingDeployment.started_at as string);
			const durationSeconds = (completedAt.getTime() - startedAt.getTime()) / 1000;
			updateData.completed_at = completedAt.toISOString();
			updateData.duration_seconds = durationSeconds;
		}

		const { data, error } = await supabase
			.from("deployments")
			.update(updateData)
			.eq("id", params.id)
			.select()
			.single();

		if (error) {
			return NextResponse.json(
				{ error: `Failed to update deployment: ${error.message}` },
				{ status: 500 }
			);
		}

		return NextResponse.json({ deployment: data });
	} catch (error) {
		console.error("[v0] Error updating deployment:", error);
		return NextResponse.json(
			{ error: "Failed to update deployment" },
			{ status: 500 }
		);
	}
}
