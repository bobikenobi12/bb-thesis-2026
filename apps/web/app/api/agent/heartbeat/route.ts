import { createServiceRoleClient } from "@/lib/supabase/service-role-client";
import { createHash } from "crypto";
import { NextResponse } from "next/server";

export async function POST(req: Request) {
	const clusterId = req.headers.get("X-Cluster-ID");
	const agentToken = req.headers.get("X-Agent-Token");

	if (!clusterId || !agentToken) {
		return NextResponse.json(
			{ error: "Missing X-Cluster-ID or X-Agent-Token" },
			{ status: 401 }
		);
	}

	try {
		const supabase = await createServiceRoleClient();
		const tokenHash = createHash("sha256").update(agentToken).digest("hex");

		// 1. Verify token
		const { data: cluster, error: fetchError } = await supabase
			.from("clusters")
			.select("id, agent_token_hash")
			.eq("id", clusterId)
			.single();

		if (fetchError || !cluster || cluster.agent_token_hash !== tokenHash) {
			return NextResponse.json(
				{ error: "Invalid cluster ID or agent token" },
				{ status: 401 }
			);
		}

		// 2. Update heartbeat
		const { error: updateError } = await supabase
			.from("clusters")
			.update({
				last_heartbeat: new Date().toISOString(),
				status: "ONLINE",
			})
			.eq("id", clusterId);

		if (updateError) {
			console.error("Heartbeat update error:", updateError);
			return NextResponse.json(
				{ error: "Failed to update heartbeat" },
				{ status: 500 }
			);
		}

		return NextResponse.json({ success: true });
	} catch (err: any) {
		console.error("Heartbeat error:", err);
		return NextResponse.json(
			{ error: "Internal Server Error" },
			{ status: 500 }
		);
	}
}
