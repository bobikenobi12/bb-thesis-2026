import { verifyCliToken } from "@/lib/cli/auth";
import { NextResponse } from "next/server";

export async function GET(req: Request) {
	const { error: authError } = await verifyCliToken(req);
	if (authError) {
		return authError;
	}

	const providerToken = req.headers.get("X-Provider-Token");

	if (!providerToken) {
		return NextResponse.json(
			{
				error: "GitHub token missing. Please log in again via the CLI to capture your token.",
			},
			{ status: 400 }
		);
	}

	try {
		const response = await fetch(
			"https://api.github.com/user/repos?per_page=100&sort=updated",
			{
				headers: {
					Authorization: `Bearer ${providerToken}`,
					Accept: "application/vnd.github.v3+json",
				},
			}
		);

		if (!response.ok) {
			const errBody = await response.text();
			return NextResponse.json(
				{ error: `GitHub API error: ${response.status} ${errBody}` },
				{ status: response.status }
			);
		}

		const repos = await response.json();

		const repositories = repos.map(
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
				provider: "github",
			})
		);

		return NextResponse.json({ repositories });
	} catch (error) {
		console.error("[CLI] Error fetching GitHub repositories:", error);
		return NextResponse.json(
			{ error: "Failed to fetch repositories" },
			{ status: 500 }
		);
	}
}
