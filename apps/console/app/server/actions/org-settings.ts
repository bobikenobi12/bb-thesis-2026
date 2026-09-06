"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Reads the active org's General-settings fields. Name + slug live on the organization
// row; the rest (description, data region, default Project env, Terraform version) live in
// the org `metadata` JSON. Writes go through better-auth `organization.update` from the
// client (it owns the org row + hooks).

import { eq } from "drizzle-orm";
import { z } from "zod";
import { authorizeInOrg, currentActor } from "@/lib/authz/guard";
import { getServiceDb } from "@/lib/db";
import { organization } from "@/lib/db/schema";

export interface OrgSettings {
	name: string;
	slug: string;
	logo: string | null;
	description: string;
	/** Billing-derived primary address (set from checkout); null when unset. */
	primaryAddress: OrgPrimaryAddress | null;
	region: string;
	defaultEnv: string;
	terraformVersion: string;
}

/** The org's primary (billing-derived) address, stored in the org metadata JSON. */
const orgPrimaryAddressSchema = z.object({
	name: z.string(),
	line1: z.string(),
	line2: z.string().optional(),
	city: z.string().optional(),
	state: z.string().optional(),
	postalCode: z.string().optional(),
	country: z.string(),
});
export type OrgPrimaryAddress = z.infer<typeof orgPrimaryAddressSchema>;

/** The org metadata JSON blob. Every field is tolerant: a malformed value degrades to `undefined`
 *  (never throws, never lies), and a non-object blob to `{}` — parseMeta trusts nothing. */
const orgMetaSchema = z
	.object({
		region: z.string().optional().catch(undefined),
		description: z.string().optional().catch(undefined),
		defaultEnv: z.string().optional().catch(undefined),
		terraformVersion: z.string().optional().catch(undefined),
		primaryAddress: orgPrimaryAddressSchema.optional().catch(undefined),
	})
	.catch({});
type OrgMeta = z.infer<typeof orgMetaSchema>;

/** Tolerant parse of the org metadata JSON blob. */
function parseMeta(metadata: string | null): OrgMeta {
	if (!metadata) return {};
	try {
		return orgMetaSchema.parse(JSON.parse(metadata));
	} catch {
		return {};
	}
}

/** Current General-settings values, or null in the personal scope (no real org). */
/**
 * The General-settings values for a given org id (no session lookup) — the shared read behind
 * both getOrgSettings (web, session-scoped) and the CLI org-settings route (token-scoped). Returns
 * null when the org row is missing. Callers are responsible for the community-mode short-circuit.
 */
export async function orgSettingsForOrg(orgId: string): Promise<OrgSettings | null> {
	const [org] = await getServiceDb()
		.select({
			name: organization.name,
			slug: organization.slug,
			logo: organization.logo,
			metadata: organization.metadata,
		})
		.from(organization)
		.where(eq(organization.id, orgId))
		.limit(1);
	if (!org) return null;

	const m = parseMeta(org.metadata);
	return {
		name: org.name,
		slug: org.slug ?? "",
		logo: org.logo,
		description: m.description ?? "",
		primaryAddress: m.primaryAddress ?? null,
		region: m.region ?? "eu-west-1",
		defaultEnv: m.defaultEnv ?? "staging",
		terraformVersion: m.terraformVersion ?? "1.9.5",
	};
}

export async function getOrgSettings(): Promise<OrgSettings | null> {
	const actor = await currentActor();
	if (actor.orgId === actor.userId) return null;
	return orgSettingsForOrg(actor.orgId);
}

/**
 * Stores an org's primary address in its metadata JSON — set from the checkout form when "Use the
 * billing address as my team's primary address" is checked. Merged into the existing metadata.
 *
 * @param orgId the org to write to, when it is not the ambient one. NAMED for the same reason
 * `startProTrial` and `linkSubscriptionToNewOrg` are: the create-org sheet runs from a page inside
 * the CURRENT org and then writes to the org it has just created, so under URL-wins the ambient org
 * is the wrong one — ticking "use as my primary address" while creating a team from `/acme/…`
 * silently overwrote ACME's primary address, and the caller's `catch {}` meant nothing surfaced.
 * Optional because `upgrade-org-sheet` and `onboarding-form` genuinely mean the ambient org.
 *
 * It is still never client-supplied in the ambient case — an id passed here is authorized through
 * `authorizeInOrg`, which refuses an org the caller is not scoped to.
 */
export async function updateOrgPrimaryAddress(
	address: OrgPrimaryAddress,
	orgId?: string,
): Promise<{ ok: true }> {
	const actor = orgId
		? await authorizeInOrg("manage_billing", { type: "billing" }, orgId)
		: await currentActor();
	if (actor.orgId === actor.userId) {
		throw new Error("No organization in scope.");
	}
	const db = getServiceDb();
	const [org] = await db
		.select({ metadata: organization.metadata })
		.from(organization)
		.where(eq(organization.id, actor.orgId))
		.limit(1);
	const next: OrgMeta = { ...parseMeta(org?.metadata ?? null), primaryAddress: address };
	await db
		.update(organization)
		.set({ metadata: JSON.stringify(next), updatedAt: new Date() })
		.where(eq(organization.id, actor.orgId));
	return { ok: true };
}
