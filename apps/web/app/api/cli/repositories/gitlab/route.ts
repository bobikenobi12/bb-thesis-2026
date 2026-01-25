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
				error: "GitLab token missing. Please log in again via the CLI to capture your token.",
			},
			{ status: 400 }
		);
	}

	try {
		const response = await fetch(
			"https://gitlab.itgix.com/api/v4/projects?membership=true&per_page=100&order_by=updated_at",
			{
				headers: {
					Authorization: `Bearer ${providerToken}`,
				},
			}
		);

		if (!response.ok) {
			const errBody = await response.text();
			return NextResponse.json(
				{ error: `GitLab API error: ${response.status} ${errBody}` },
				{ status: response.status }
			);
		}

		const repos = await response.json();

		const repositories = repos.map(
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
				provider: "gitlab",
			})
		);

		return NextResponse.json({ repositories });
	} catch (error) {
		console.error("[CLI] Error fetching GitLab repositories:", error);
		return NextResponse.json(
			{ error: "Failed to fetch repositories" },
			{ status: 500 }
		);
	}
}
