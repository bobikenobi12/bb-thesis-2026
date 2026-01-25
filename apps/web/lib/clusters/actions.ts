import { createClient } from "@/lib/supabase/server";
import { randomBytes, createHash } from "crypto";

export interface RegisterClusterResult {
	cluster_id: string;
	agent_token: string;
}

/**
 * Registers a new cluster for a user and generates a unique agent token.
 */
export async function registerCluster(
	userId: string, 
	name: string, 
	metadata: Record<string, any> = {}
): Promise<RegisterClusterResult> {
	const supabase = await createClient();

	// 1. Generate Secure Agent Token
	const rawToken = randomBytes(32).toString("hex");
	const tokenHash = createHash("sha256")
		.update(rawToken)
		.digest("hex");

	// 2. Create Cluster Record
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
		throw new Error("Failed to create cluster record: " + dbError.message);
	}

	return {
		cluster_id: cluster.id,
		agent_token: rawToken,
	};
}
