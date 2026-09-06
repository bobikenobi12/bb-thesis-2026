// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { eq } from "drizzle-orm";
import { ForbiddenError } from "@/lib/authz/types";
import type { Db, Tx } from "@/lib/db";
import { runners } from "@/lib/db/schema";

/**
 * Validates that a client-supplied runner can execute a job for the active org.
 *
 * Managed runners belong to the shared pool and have no org. `personalOrgId`
 * admits only a caller-owned runner written before #3874 stamped CLI runners
 * with the active org; claim-time compatibility remains independently narrowed
 * to lifecycle jobs created by that same owner.
 */
export async function assertRunnerInOrg(
	db: Db | Tx,
	runnerId: string,
	orgId: string,
	personalOrgId?: string,
): Promise<void> {
	const [row] = await db
		.select({ org_id: runners.org_id })
		.from(runners)
		.where(eq(runners.id, runnerId))
		.limit(1);

	const admitted =
		row !== undefined &&
		(row.org_id === null ||
			row.org_id === orgId ||
			(personalOrgId !== undefined && row.org_id === personalOrgId));

	if (!admitted) {
		throw new ForbiddenError(
			"deploy",
			{ type: "runner", id: runnerId },
			"runner not found or not in caller's org",
		);
	}
}
