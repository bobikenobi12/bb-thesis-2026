import { verifyCliToken } from "@/lib/cli/auth";
import { createServiceRoleClient } from "@/lib/supabase/service-role-client";
import { createHash, randomBytes } from "crypto";
import { NextResponse } from "next/server";

export async function POST(req: Request) {
	// 1. Authenticate CLI User
	const { payload, error } = await verifyCliToken(req);
	if (error) {
		return error;
	}

	const userId = payload?.sub; // 'sub' in JWT is typically the user ID
	if (!userId) {
		return NextResponse.json(
			{ error: "Invalid token payload: missing subject" },
			{ status: 401 },
		);
	}

	try {
		// 2. Parse Request
		const { name, vpc_id, vpc_cidr, region } = await req.json();
		if (!name) {
			return NextResponse.json(
				{ error: "Cluster name is required" },
				{ status: 400 },
			);
		}

		const metadata = {
			vpc_id,
			vpc_cidr,
			region,
			registered_at: new Date().toISOString(),
		};

		// 3. Register Cluster (Using Service Role to bypass RLS for CLI)
		const supabase = await createServiceRoleClient();

		// Generate Secure Agent Token
		const rawToken = randomBytes(32).toString("hex");
		const tokenHash = createHash("sha256").update(rawToken).digest("hex");

		// Create Cluster Record
		const { data: cluster, error: dbError } = await supabase
			.from("clusters")
			.insert({
				name: name,
				user_id: userId,
				status: "PENDING",
				agent_token_hash: tokenHash,
				metadata: metadata,
			})
			.select()
			.single();

		if (dbError) {
			console.error("Database error registering cluster:", dbError);
			throw new Error(
				"Failed to create cluster record: " + dbError.message,
			);
		}

		const result = {
			cluster_id: cluster.id,
			agent_token: rawToken,
		};

		return NextResponse.json(result, { status: 201 });
	} catch (err: any) {
		console.error("Cluster registration failed:", err);
		return NextResponse.json(
			{ error: err.message || "Internal Server Error" },
			{ status: 500 },
		);
	}
}

export async function GET(req: Request) {
	// 1. Authenticate CLI User
	const { payload, error } = await verifyCliToken(req);
	if (error) {
		return error;
	}

	const userId = payload?.sub;
	if (!userId) {
		return NextResponse.json(
			{ error: "Invalid token payload" },
			{ status: 401 },
		);
	}

	try {
		// Use Service Role client to bypass RLS, but manually filter by user_id
		const supabase = await createServiceRoleClient();

		const { data: clusters, error: dbError } = await supabase
			.from("clusters")
			.select("*")
			.eq("user_id", userId)
			.order("created_at", { ascending: false });

		if (dbError) {
			console.error("Database error fetching clusters:", dbError);
			return NextResponse.json(
				{ error: "Failed to fetch clusters" },
				{ status: 500 },
			);
		}

		return NextResponse.json({ clusters });
	} catch (err: any) {
		console.error("Error fetching clusters:", err);
		return NextResponse.json(
			{ error: "Internal Server Error" },
			{ status: 500 },
		);
	}
}
