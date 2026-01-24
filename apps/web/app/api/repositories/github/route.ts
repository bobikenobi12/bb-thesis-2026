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

		// Get the GitHub access token from the session
		const provider_token = session.provider_token;

		if (!provider_token) {
			return NextResponse.json(
				{
					error: "No GitHub token found. Please link your GitHub account.",
				},
				{ status: 400 }
			);
		}

		// Fetch repositories from GitHub API
		const response = await fetch(
			"https://api.github.com/user/repos?per_page=100&sort=updated",
			{
				headers: {
					Authorization: `Bearer ${provider_token}`,
					Accept: "application/vnd.github.v3+json",
				},
			}
		);

		if (!response.ok) {
			throw new Error("Failed to fetch GitHub repositories");
		}

		const repos = await response.json();

		// Transform to our Repository interface
		const repositories: Repository[] = repos.map(
			(repo: {
				id: number;
				name: string;
				full_name: string;
				html_url: string;
				private: boolean;
				default_branch: string;
			}) => ({
				id: repo.id.toString(),
				name: repo.name,
				full_name: repo.full_name,
				url: repo.html_url,
				private: repo.private,
				default_branch: repo.default_branch,
				provider: "github" as const,
			})
		);

		return NextResponse.json({ repositories });
	} catch (error) {
		console.error("[v0] Error fetching GitHub repositories:", error);
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
					error: "No GitHub token found. Please link your GitHub account.",
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

		const response = await fetch("https://api.github.com/user/repos", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${provider_token}`,
				Accept: "application/vnd.github.v3+json",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				name,
				private: false,
			}),
		});

		if (!response.ok) {
			const errorData = await response.json();
			return NextResponse.json(
				{
					error: `Failed to create GitHub repository: ${errorData.message}`,
				},
				{ status: response.status }
			);
		}

		const newRepo = await response.json();
		const repository: Repository = {
			id: newRepo.id.toString(),
			name: newRepo.name,
			full_name: newRepo.full_name,
			url: newRepo.html_url,
			private: newRepo.private,
			default_branch: newRepo.default_branch,
			provider: "github" as const,
		};

		return NextResponse.json({ repository }, { status: 201 });
	} catch (error) {
		console.error("[v0] Error creating GitHub repository:", error);
		return NextResponse.json(
			{ error: "Failed to create repository" },
			{ status: 500 }
		);
	}
}
