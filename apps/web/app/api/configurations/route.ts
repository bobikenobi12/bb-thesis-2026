import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

export const runtime = "edge";

// GET all configurations for the current user
export async function GET(request: Request) {
	try {
		const supabase = await createClient();

		// Get current user
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

		// Parse query parameters
		const { searchParams } = new URL(request.url);
		const status = searchParams.get("status");
		const limit = searchParams.get("limit");
		const offset = searchParams.get("offset");

		// Build query
		let query = supabase
			.from("configurations")
			.select("*")
			.eq("user_id", user.id)
			.order("created_at", { ascending: false });

		// Apply filters
		if (status) {
			query = query.eq("status", status);
		}

		if (limit) {
			query = query.limit(Number.parseInt(limit));
		}

		if (offset) {
			query = query.range(
				Number.parseInt(offset),
				Number.parseInt(offset) +
					(limit ? Number.parseInt(limit) : 10) -
					1
			);
		}

		const { data, error } = await query;

		if (error) {
			console.error("[v0] Error fetching configurations:", error);
			return NextResponse.json({ error: error.message }, { status: 500 });
		}

		return NextResponse.json({ configurations: data });
	} catch (error) {
		console.error("[v0] Unexpected error:", error);
		return NextResponse.json(
			{ error: "Internal server error" },
			{ status: 500 }
		);
	}
}

// POST create a new configuration
export async function POST(request: Request) {
	try {
		const supabase = await createClient();

		// Get current user
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

		const body = await request.json();

		// Insert configuration
		const { data, error } = await supabase
			.from("configurations")
			.insert({
				user_id: user.id,
				...body,
			})
			.select()
			.single();

		if (error) {
			console.error("[v0] Error creating configuration:", error);
			return NextResponse.json({ error: error.message }, { status: 500 });
		}

		return NextResponse.json({ configuration: data }, { status: 201 });
	} catch (error) {
		console.error("[v0] Unexpected error:", error);
		return NextResponse.json(
			{ error: "Internal server error" },
			{ status: 500 }
		);
	}
}
