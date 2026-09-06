// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
	cliCloudIdentitiesResponse,
	cliClusterDetailResponse,
	cliClustersPageResponse,
	cliJobLogsResponse,
	cliJobResponse,
	cliJobsPageResponse,
	cliPageInfo,
	cliRepositoriesResponse,
	cliLatestReleaseWire,
	cliReleasePublishWire,
	cliByoChartAttachResponse,
	cliByoScanResponse,
	cliRunnerRegistrationResponse,
	cliDesignApplyResponse,
	cliRunnersResponse,
	cliSigningKeysResponse,
	cliUsageResponse,
	connectIdentityWire,
	deployRunnerWire,
	initIdentityWire,
	jobWire,
	providerStatusWire,
} from "@/lib/validations/cli-contract";

// The CLI wire fixtures live next to the Go contract test (packages/core/api/
// testdata) and are decoded there into the Go structs the CLI uses. This suite
// is the other half of the guard: it asserts every fixture still satisfies the
// Zod contract. So when the DB schema (and thus the contract) changes, a stale
// fixture fails here — and once regenerated, the new fixture fails the Go strict
// decode until the Go struct is updated. Neither side can drift silently.
const fixturesDir = join(
	dirname(fileURLToPath(import.meta.url)),
	"../../../../packages/core/api/testdata",
);

function loadFixture(name: string): unknown {
	return JSON.parse(readFileSync(join(fixturesDir, name), "utf8"));
}

const cases: ReadonlyArray<[string, z.ZodType]> = [
	["runners.json", cliRunnersResponse],
	["byo_attach.json", cliByoChartAttachResponse],
	["byo_scan.json", cliByoScanResponse],
	["runner_registration.json", cliRunnerRegistrationResponse],
	["design_apply.json", cliDesignApplyResponse],
	["clusters_page.json", cliClustersPageResponse],
	["cluster_detail.json", cliClusterDetailResponse],
	["cloud_identities.json", cliCloudIdentitiesResponse],
	["jobs_page.json", cliJobsPageResponse],
	// The paging vocabulary's own fixture. It was registered in the contract by #3666 and
	// never listed here, so it carried `"limit": 0` against `pageInfoSchema`'s `.positive()`
	// for as long as it existed — the Go side strict-decodes it, which checks the SHAPE and
	// says nothing about whether the value is one the schema allows.
	["page_info.json", cliPageInfo],
	["job.json", jobWire],
	["job_logs.json", cliJobLogsResponse],
	["repositories.json", cliRepositoriesResponse],
	["provider_status.json", providerStatusWire],
	["deploy_runner.json", deployRunnerWire],
	["latest_release.json", cliLatestReleaseWire],
	["job_response.json", cliJobResponse],
	["init_identity.json", initIdentityWire],
	["connect_identity.json", connectIdentityWire],
	["usage.json", cliUsageResponse],
	["signing_keys.json", cliSigningKeysResponse],
];

describe("CLI wire contract ↔ fixtures", () => {
	it.each(cases)("%s conforms to its contract schema", (file, schema) => {
		const result = schema.safeParse(loadFixture(file));
		if (!result.success) {
			throw new Error(
				`${file} violates its CLI wire contract:\n${JSON.stringify(result.error.issues, null, 2)}`,
			);
		}
		expect(result.success).toBe(true);
	});
});

describe("CLI release publication contract", () => {
	it("accepts stable, attributable release metadata", () => {
		expect(
			cliReleasePublishWire.safeParse({
				version: "1.2.3",
				release_notes: "Notes",
				released_at: "2026-08-31T05:37:26Z",
				github_release_url:
					"https://github.com/alethialabs-io/alethia-cli/releases/tag/v1.2.3",
				commit_sha: "a".repeat(40),
			}).success,
		).toBe(true);
	});

	it("rejects aliases and unattributable commits", () => {
		expect(
			cliReleasePublishWire.safeParse({
				version: "latest",
				release_notes: "Notes",
				released_at: "today",
				github_release_url: "not-a-url",
				commit_sha: "short",
			}).success,
		).toBe(false);
	});
});
