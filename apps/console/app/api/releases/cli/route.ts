// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { cliJson } from "@/lib/cli/respond";
import { getServiceDb } from "@/lib/db";
import { cliReleases } from "@/lib/db/schema";
import {
	cliLatestReleaseWire,
	cliReleasePublishWire,
} from "@/lib/validations/cli-contract";
import { desc } from "drizzle-orm";
import { NextResponse } from "next/server";
import { bearerMatches } from "@/lib/auth/internal-auth";

/**
 * Public: the latest published alethia CLI release. The CLI polls this to tell
 * the user when a newer version exists, so it is intentionally unauthenticated
 * (a logged-out user should still see the upgrade hint). Returns 404 when no
 * release has been published yet — the CLI treats that as "no info" and stays
 * silent.
 */
export async function GET() {
	const db = getServiceDb();
	const [latest] = await db
		.select({
			version: cliReleases.version,
			release_notes: cliReleases.release_notes,
			released_at: cliReleases.released_at,
			github_release_url: cliReleases.github_release_url,
			min_supported_version: cliReleases.min_supported_version,
		})
		.from(cliReleases)
		.orderBy(desc(cliReleases.released_at))
		.limit(1);

	if (!latest) {
		return NextResponse.json({ error: "No releases published" }, { status: 404 });
	}

	return cliJson(cliLatestReleaseWire, latest);
}

/** CI calls this endpoint to publish a new CLI release (mirrors runner releases). */
export async function POST(req: Request) {
	if (!bearerMatches(req, process.env.RELEASE_API_SECRET)) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	const parsed = cliReleasePublishWire.safeParse(
		await req.json().catch(() => null),
	);
	if (!parsed.success) {
		return NextResponse.json(
			{ error: "Invalid release metadata", issues: parsed.error.issues },
			{ status: 400 },
		);
	}
	const {
		version,
		release_notes,
		released_at,
		github_release_url,
		commit_sha,
		min_supported_version,
		is_breaking,
	} = parsed.data;

	try {
		const db = getServiceDb();
		const [row] = await db
			.insert(cliReleases)
			.values({
				version,
				release_notes,
				released_at: new Date(released_at),
				github_release_url,
				commit_sha,
				...(min_supported_version !== undefined
					? { min_supported_version }
					: {}),
				is_breaking: is_breaking ?? false,
			})
			.onConflictDoUpdate({
				target: cliReleases.version,
				set: {
					release_notes,
					released_at: new Date(released_at),
					github_release_url,
					commit_sha,
					...(min_supported_version !== undefined
						? { min_supported_version }
						: {}),
					...(is_breaking !== undefined ? { is_breaking } : {}),
				},
			})
			.returning({ id: cliReleases.id });

		return NextResponse.json({ success: true, id: row.id });
	} catch (err: unknown) {
		const message =
			err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json(
			{ error: "Failed to insert release: " + message },
			{ status: 500 },
		);
	}
}
