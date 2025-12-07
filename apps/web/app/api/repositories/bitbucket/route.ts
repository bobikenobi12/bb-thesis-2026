import { createClient } from "@/lib/supabase/server";
import type { Repository } from "@/types/configuration";
import { NextResponse } from "next/server";

export async function GET() {
	try {
		const supabase = await createClient();

		const {
			data: { session },
		} = await supabase.auth.getSession();

		if (!session) {
			return NextResponse.json(
				{ error: "Unauthorized" },
				{ status: 401 }
			);
		}

		// Get the Bitbucket access token from the session
		const provider_token = session.provider_token;

		if (!provider_token) {
			return NextResponse.json(
				{
					error: "No Bitbucket token found. Please link your Bitbucket account.",
				},
				{ status: 400 }
			);
		}

		// Fetch repositories from Bitbucket API
		const response = await fetch(
			"https://api.bitbucket.org/2.0/repositories?role=member&pagelen=100",
			{
				headers: {
					Authorization: `Bearer ${provider_token}`,
					Accept: "application/json",
				},
			}
		);

		if (!response.ok) {
			throw new Error("Failed to fetch Bitbucket repositories");
		}

		const data = await response.json();
		const repos = data.values || [];

		// Transform to our Repository interface
		const repositories: Repository[] = repos.map(
			(repo: {
				uuid: string;
				name: string;
				full_name: string;
				links: { html: { href: string } };
				is_private: boolean;
				mainbranch?: { name: string };
			}) => ({
				id: repo.uuid,
				name: repo.name,
				full_name: repo.full_name,
				url: repo.links.html.href,
				private: repo.is_private,
				default_branch: repo.mainbranch?.name || "main",
				provider: "bitbucket" as const,
			})
		);

		return NextResponse.json({ repositories });
	} catch (error) {
		console.error("[v0] Error fetching Bitbucket repositories:", error);
		return NextResponse.json(
			{ error: "Failed to fetch repositories" },
			{ status: 500 }
		);
	}
}
