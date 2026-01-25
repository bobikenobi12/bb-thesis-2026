import { createClient } from "@/lib/supabase/server";
import { getProviderToken } from "@/lib/supabase/tokens";
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

		// Get the Bitbucket access token from the session or database
		const provider_token = await getProviderToken(supabase, "bitbucket");

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

export async function POST(req: Request) {
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

		const provider_token = await getProviderToken(supabase, "bitbucket");
		if (!provider_token) {
			return NextResponse.json(
				{
					error: "No Bitbucket token found. Please link your Bitbucket account.",
				},
				{ status: 400 }
			);
		}

		const { name, workspace, projectKey } = await req.json();
		if (!name || !workspace || !projectKey) {
			return NextResponse.json(
				{ error: "Repository name, workspace, and project key are required." },
				{ status: 400 }
			);
		}

		const response = await fetch(
			`https://api.bitbucket.org/2.0/repositories/${workspace}/${name}`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${provider_token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					scm: "git",
					project: { key: projectKey },
					is_private: false,
				}),
			}
		);

		if (!response.ok) {
			const errorData = await response.json();
			return NextResponse.json(
				{
					error: `Failed to create Bitbucket repository: ${errorData.error.message}`,
				},
				{ status: response.status }
			);
		}

		const newRepo = await response.json();
		const repository: Repository = {
			id: newRepo.uuid,
			name: newRepo.name,
			full_name: newRepo.full_name,
			url: newRepo.links.html.href,
			private: newRepo.is_private,
			default_branch: newRepo.mainbranch?.name || "main",
			provider: "bitbucket" as const,
		};

		return NextResponse.json({ repository }, { status: 201 });
	} catch (error) {
		console.error("[v0] Error creating Bitbucket repository:", error);
		return NextResponse.json(
			{ error: "Failed to create repository" },
			{ status: 500 }
		);
	}
}
