// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Negative / edge / validation paths for the Connectors board: the honest "not enabled on this
// instance" state for a managed cloud whose platform credentials are absent (AWS/GCP/Azure platform
// creds are unset in the QA env), connect-sheet validation errors, and a member-permission read-only
// check (skipped until the member persona exists). Uses Microsoft Azure / Google Cloud for the
// not-enabled assertions because those are never seeded connected by the happy-path spec (AWS is).

import { test, expect } from "../fixtures/qa";
import { seedCloudIdentity } from "../helpers/seed";

// The connectors route runs a heavy server-side setup on every load — allow generous headroom.
test.describe.configure({ timeout: 120_000 });

/** Navigates to the connectors board and waits for the search box. */
async function gotoConnectors(page: import("@playwright/test").Page, orgSlug: string) {
	await page.goto(`/${orgSlug}/~/connectors`, { waitUntil: "commit" });
	await expect(page.getByLabel(/search connectors/i)).toBeVisible({ timeout: 60_000 });
}

test.describe("Connectors — not-enabled managed cloud", () => {
	// Managed clouds (aws/gcp/azure/alibaba) whose Alethia platform creds are absent read
	// "Not enabled on this instance" WHEN NOT CONNECTED. The shared persona org can accumulate
	// seeded identities for any provider (a sibling agent seeded GCP here), so these tests target
	// Azure and skip if it happens to be connected in the shared org.
	test("Azure shows 'Not enabled on this instance' without platform creds", async ({ owner }) => {
		await gotoConnectors(owner.page, owner.orgSlug);
		await owner.page.getByLabel(/search connectors/i).fill("Microsoft Azure");
		await expect(owner.page.getByText("Microsoft Azure").first()).toBeVisible();
		const connected = await owner.page.getByRole("button", { name: "Manage" }).count();
		test.skip(connected > 0, "Azure is connected (seeded) in the shared org");
		await expect(
			owner.page.getByText("Not enabled on this instance"),
		).toBeVisible();
	});

	test("a not-enabled managed cloud shows the 'Unavailable' pill, no Connect button", async ({
		owner,
	}) => {
		await gotoConnectors(owner.page, owner.orgSlug);
		await owner.page.getByLabel(/search connectors/i).fill("Microsoft Azure");
		await expect(owner.page.getByText("Microsoft Azure").first()).toBeVisible();
		const connected = await owner.page.getByRole("button", { name: "Manage" }).count();
		test.skip(connected > 0, "Azure is connected (seeded) in the shared org");
		await expect(owner.page.getByText("Unavailable").first()).toBeVisible();
		await expect(owner.page.getByRole("button", { name: "Connect" })).toHaveCount(0);
	});
});

test.describe("Connectors — connect-sheet validation", () => {
	// BUG (see connectors.spec.ts): a connected token cloud's "Add another account" opens an EMPTY
	// sheet — token clouds are category "cloud" + auth_method "api_key", so handleConnect misroutes
	// them to the pluggable api-key sheet where getConnectorProviderBySlug returns undefined. Asserts
	// the intended empty-state absence of the token field is actually the token field being present.
	test("token-cloud sheet validates a too-short API token", async ({ owner }) => {
		await seedCloudIdentity(
			{ userId: owner.userId!, orgId: owner.orgId! },
			{ provider: "hetzner", name: `e2e-htz-neg-${Date.now()}` },
		);
		await gotoConnectors(owner.page, owner.orgSlug);
		await owner.page.getByLabel(/search connectors/i).fill("Hetzner");
		await owner.page.getByRole("button", { name: "Manage" }).first().click();
		await owner.page
			.getByRole("dialog")
			.getByRole("button", { name: /Add another account/i })
			.click();
		const token = owner.page.getByPlaceholder(/scoped API token/i);
		await expect(token).toBeVisible({ timeout: 30_000 });
		await token.fill("too-short");
		await expect(owner.page.getByText("Enter a valid API token.")).toBeVisible();
	});

	test("api-key sheet reports the SECOND missing required field once the first is filled", async ({
		owner,
	}) => {
		await gotoConnectors(owner.page, owner.orgSlug);
		await owner.page.getByLabel(/search connectors/i).fill("Datadog");
		await owner.page.getByRole("button", { name: "Connect" }).click();
		const sheet = owner.page.getByRole("dialog");
		// Fill only the API Key; Application Key is still required.
		await sheet.getByLabel(/API Key/i).fill("dd-fake-api-key");
		await sheet.getByRole("button", { name: "Connect" }).click();
		await expect(sheet.getByText("Application Key is required.")).toBeVisible();
	});
});

test.describe("Connectors — member permissions (read-only)", () => {
	test("a member without manage rights sees no Connect/Manage actions", async ({ member }) => {
		await gotoConnectors(member.page, member.orgSlug);
		await member.page.getByLabel(/search connectors/i).fill("Datadog");
		await expect(member.page.getByRole("button", { name: "Connect" })).toHaveCount(0);
	});
});
