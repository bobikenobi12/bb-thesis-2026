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

		// Get the GitLab access token from the session
		const provider_token = session.provider_token;

		if (!provider_token) {
			return NextResponse.json(
				{
					error: "No GitLab token found. Please link your GitLab account.",
				},
				{ status: 400 }
			);
		}

		// Fetch repositories from GitLab API
		const response = await fetch(
			"https://gitlab.itgix.com/api/v4/projects?membership=true&per_page=100&order_by=updated_at",
			{
				headers: {
					Authorization: `Bearer ${provider_token}`,
				},
			}
		);

		if (!response.ok) {
			const { message } = await response.json();
			throw new Error(message);
		}

		const repos = await response.json();

		// Transform to our Repository interface
		const repositories: Repository[] = repos.map(
			(repo: {
				id: number;
				name: string;
				path_with_namespace: string;
				web_url: string;
				visibility: string;
				default_branch: string;
			}) => ({
				id: repo.id.toString(),
				name: repo.name,
				full_name: repo.path_with_namespace,
				url: repo.web_url,
				private: repo.visibility !== "public",
				default_branch: repo.default_branch || "main",
				provider: "gitlab" as const,
			})
		);

		return NextResponse.json({ repositories });
	} catch (error) {
		console.error("[v0] Error fetching GitLab repositories:", error);
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

		const provider_token = session.provider_token;
		if (!provider_token) {
			return NextResponse.json(
				{
					error: "No GitLab token found. Please link your GitLab account.",
				},
				{ status: 400 }
			);
		}

		const { name } = await req.json();
		if (!name) {
			return NextResponse.json(
				{ error: "Repository name is required." },
				{ status: 400 }
			);
		}

		const response = await fetch("https://gitlab.itgix.com/api/v4/projects", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${provider_token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				name,
				visibility: "public",
			}),
		});

		if (!response.ok) {
			const errorData = await response.json();
			return NextResponse.json(
				{
					error: `Failed to create GitLab repository: ${
						errorData.message.name?.[0] || errorData.message
					}`,
				},
				{ status: response.status }
			);
		}

		const newRepo = await response.json();
		const repository: Repository = {
			id: newRepo.id.toString(),
			name: newRepo.name,
			full_name: newRepo.path_with_namespace,
			url: newRepo.web_url,
			private: newRepo.visibility !== "public",
			default_branch: newRepo.default_branch || "main",
			provider: "gitlab" as const,
		};

		return NextResponse.json({ repository }, { status: 201 });
	} catch (error) {
		console.error("[v0] Error creating GitLab repository:", error);
		return NextResponse.json(
			{ error: "Failed to create repository" },
			{ status: 500 }
		);
	}
}
