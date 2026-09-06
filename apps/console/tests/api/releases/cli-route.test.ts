// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
	limit: vi.fn(),
	values: vi.fn(),
	onConflictDoUpdate: vi.fn(),
	returning: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
	getServiceDb: () => ({
		select: () => ({
			from: () => ({
				orderBy: () => ({ limit: dbMocks.limit }),
			}),
		}),
		insert: () => ({ values: dbMocks.values }),
	}),
}));

import { GET, POST } from "@/app/api/releases/cli/route";

const savedSecret = process.env.RELEASE_API_SECRET;
const release = {
	version: "1.2.3",
	release_notes: "Notes",
	released_at: "2026-08-31T05:37:26.000Z",
	github_release_url:
		"https://github.com/alethialabs-io/alethia-cli/releases/tag/v1.2.3",
	commit_sha: "a".repeat(40),
};

/** Builds a release publication request with the configured bearer. */
function request(body: unknown, bearer = "release-secret"): Request {
	return new Request("http://localhost/api/releases/cli", {
		method: "POST",
		headers: {
			authorization: `Bearer ${bearer}`,
			"content-type": "application/json",
		},
		body: JSON.stringify(body),
	});
}

beforeEach(() => {
	process.env.RELEASE_API_SECRET = "release-secret";
	dbMocks.limit.mockReset();
	dbMocks.values.mockReset();
	dbMocks.onConflictDoUpdate.mockReset();
	dbMocks.returning.mockReset();
	dbMocks.values.mockReturnValue({
		onConflictDoUpdate: dbMocks.onConflictDoUpdate,
	});
	dbMocks.onConflictDoUpdate.mockReturnValue({ returning: dbMocks.returning });
	dbMocks.returning.mockResolvedValue([{ id: "release-id" }]);
});

afterEach(() => {
	if (savedSecret === undefined) delete process.env.RELEASE_API_SECRET;
	else process.env.RELEASE_API_SECRET = savedSecret;
});

describe("GET /api/releases/cli", () => {
	it("returns the latest published release", async () => {
		dbMocks.limit.mockResolvedValue([
			{ ...release, released_at: new Date(release.released_at), min_supported_version: null },
		]);

		const response = await GET();
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			version: "1.2.3",
			released_at: release.released_at,
		});
	});

	it("returns 404 when no release has been published", async () => {
		dbMocks.limit.mockResolvedValue([]);
		const response = await GET();
		expect(response.status).toBe(404);
	});
});

describe("POST /api/releases/cli", () => {
	it("fails closed without the matching bearer", async () => {
		const response = await POST(request(release, "wrong"));
		expect(response.status).toBe(401);
		expect(dbMocks.values).not.toHaveBeenCalled();
	});

	it("rejects malformed release metadata", async () => {
		const response = await POST(
			request({ ...release, version: "latest", commit_sha: "not-a-sha" }),
		);
		expect(response.status).toBe(400);
		expect(dbMocks.values).not.toHaveBeenCalled();
	});

	it("idempotently upserts the authoritative release timestamp", async () => {
		const response = await POST(request(release));
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ success: true, id: "release-id" });
		expect(dbMocks.values).toHaveBeenCalledWith(
			expect.objectContaining({
				version: "1.2.3",
				released_at: new Date(release.released_at),
				is_breaking: false,
			}),
		);
		expect(dbMocks.onConflictDoUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				set: expect.objectContaining({
					released_at: new Date(release.released_at),
				}),
			}),
		);
	});

	it("does not erase an existing support floor when the payload omits it", async () => {
		await POST(request(release));
		const conflict = dbMocks.onConflictDoUpdate.mock.calls[0]?.[0];
		expect(conflict?.set).not.toHaveProperty("min_supported_version");
		expect(conflict?.set).not.toHaveProperty("is_breaking");
	});

	it("returns 500 when persistence fails", async () => {
		dbMocks.returning.mockRejectedValue(new Error("database unavailable"));
		const response = await POST(request(release));
		expect(response.status).toBe(500);
	});
});
