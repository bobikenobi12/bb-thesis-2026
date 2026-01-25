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
				error: "Bitbucket token missing. Please log in again via the CLI to capture your token.",
			},
			{ status: 400 }
		);
	}

	try {
		const response = await fetch(
			"https://api.bitbucket.org/2.0/repositories?role=member&pagelen=100",
			{
				headers: {
					Authorization: `Bearer ${providerToken}`,
					Accept: "application/json",
				},
			}
		);

		if (!response.ok) {
			const errBody = await response.text();
			return NextResponse.json(
				{ error: `Bitbucket API error: ${response.status} ${errBody}` },
				{ status: response.status }
			);
		}

		const data = await response.json();
		const repos = data.values || [];

		const repositories = repos.map(
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
				provider: "bitbucket",
			})
		);

		return NextResponse.json({ repositories });
	} catch (error) {
		console.error("[CLI] Error fetching Bitbucket repositories:", error);
		return NextResponse.json(
			{ error: "Failed to fetch repositories" },
			{ status: 500 }
		);
	}
}
