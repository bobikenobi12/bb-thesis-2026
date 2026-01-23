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
			.from("deployment_logs")
			.select("*")
			.eq("deployment_id", params.id)
			.order("created_at", { ascending: true });

		if (error) {
			return NextResponse.json(
				{
					error: `Failed to fetch logs: ${error.message}`,
				},
				{ status: 500 }
			);
		}

		return NextResponse.json({ logs: data });
	} catch (error) {
		console.error("[v0] Error fetching logs:", error);
		return NextResponse.json(
			{ error: "Failed to fetch logs" },
			{ status: 500 }
		);
	}
}

export async function POST(
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

		const { message, level, step } = await req.json();
		if (!message || !level) {
			return NextResponse.json(
				{ error: "Message and level are required." },
				{ status: 400 }
			);
		}

		const { data, error } = await supabase.from("deployment_logs").insert({
			deployment_id: params.id,
			message,
			level,
			step,
		});

		if (error) {
			return NextResponse.json(
				{ error: `Failed to create log entry: ${error.message}` },
				{ status: 500 }
			);
		}

		return NextResponse.json({ log: data }, { status: 201 });
	} catch (error) {
		console.error("[v0] Error creating log entry:", error);
		return NextResponse.json(
			{ error: "Failed to create log entry" },
			{ status: 500 }
		);
	}
}
