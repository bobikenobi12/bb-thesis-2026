// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Validation for `network.cidr_block` — the project network a cloud template carves its subnets
// out of.
//
// Nothing in the console validated this field before #3670. The apply gate
// (packages/core/cloud.validateNetworkCIDR) refuses a network narrower than the cloud's floor,
// because the template builds its subnets with `cidrsubnet()` and a too-narrow parent plans clean
// and then dies mid-apply. So the only feedback a user got was a failed deploy.
//
// This is the TS half of the `network_cidr_max_prefix` conformance table; the Go half is
// packages/core/validate/rules.go. Neither side is a copy of the other's code — they are held to
// the same named cases.
//
// PRECONDITION, and it is load-bearing: this rule applies only to a project that PROVISIONS ITS OWN
// network. `validateNetworkCIDR` returns early for a brownfield network (one with an existing
// network id), so a /28 is perfectly fine there — applying this schema to a brownfield field would
// refuse input the server accepts, which the shared invariant forbids.

import { z } from "zod";
import {
	CIDR_REGEX,
	isCarvableCidr,
	NETWORK_CIDR_MAX_PREFIX,
} from "@/lib/cloud-providers/cidr";
import type { CloudProviderSlug } from "@/lib/cloud-providers/generated/catalog";

/**
 * The cloud slugs a project network can be provisioned on, in a stable order — the order the
 * generated spec ids and the conformance table are emitted in.
 */
export const NETWORK_CIDR_CLOUDS = [
	"aws",
	"azure",
	"gcp",
	"hetzner",
	"alibaba",
] as const satisfies readonly CloudProviderSlug[];

/**
 * The field's shape: an IPv4 CIDR, or EMPTY meaning "let the template use its default".
 *
 * Empty has to be admitted by the pattern rather than handled by a wrapping `.optional()`, because
 * the apply gate's own first line is `if cidr == "" { return nil }` — an unset value is not merely
 * absent, it is explicitly valid, and it is what every project that predates this field stores.
 */
const NETWORK_CIDR_PATTERN = new RegExp(`^$|${CIDR_REGEX.source}`);

/**
 * The per-cloud carvability predicates, as ONE stable instance each.
 *
 * They are built once and exported rather than produced by a factory at each call site for a
 * mechanical reason: `apps/console/scripts/gen-go-validation.ts` identifies a `.refine()` by the
 * IDENTITY of the function zod stored, so a fresh closure per call would make every declaration
 * unmatchable and the generator would (correctly) refuse to emit anything.
 *
 * Each one admits "" for the same reason the pattern does, and `packages/core/validate`'s
 * `network_cidr_max_prefix` does the same — the empty case is in the conformance table on both
 * sides rather than left to two independent readings of "unset".
 */
export const isCarvableFor: Record<CloudProviderSlug, (v: string) => boolean> = {
	aws: (v) => v === "" || isCarvableCidr(v, NETWORK_CIDR_MAX_PREFIX.aws),
	azure: (v) => v === "" || isCarvableCidr(v, NETWORK_CIDR_MAX_PREFIX.azure),
	gcp: (v) => v === "" || isCarvableCidr(v, NETWORK_CIDR_MAX_PREFIX.gcp),
	hetzner: (v) => v === "" || isCarvableCidr(v, NETWORK_CIDR_MAX_PREFIX.hetzner),
	alibaba: (v) => v === "" || isCarvableCidr(v, NETWORK_CIDR_MAX_PREFIX.alibaba),
};

/** The message the console shows and the CLI repeats, so both surfaces say the same words. */
export function networkCidrFloorMessage(cloud: CloudProviderSlug): string {
	const floor = NETWORK_CIDR_MAX_PREFIX[cloud];
	return floor >= 32
		? "Enter a valid IPv4 CIDR, for example 10.0.0.0/16."
		: `This cloud carves its subnets out of the network with cidrsubnet(), so it needs a /${floor} or wider. Try 10.0.0.0/16.`;
}

/** The shape message, shown when the value is not a CIDR at all. */
const NETWORK_CIDR_SHAPE_MESSAGE =
	"Enter a valid IPv4 CIDR, for example 10.0.0.0/16, or leave it blank for the template default.";

/** Builds one cloud's schema — see NETWORK_CIDR_SCHEMAS, which holds the instances. */
function makeNetworkCidrSchema(cloud: CloudProviderSlug): z.ZodType<string> {
	return z
		.string()
		.regex(NETWORK_CIDR_PATTERN, NETWORK_CIDR_SHAPE_MESSAGE)
		.refine(isCarvableFor[cloud], networkCidrFloorMessage(cloud));
}

/**
 * The `network.cidr_block` schema per cloud.
 *
 * There is deliberately no cloud-less variant. GCP has no floor at all (its template does not carve
 * subnets from the project network), so with the cloud unknown there is no prefix the server would
 * CERTAINLY reject — and a shared floor would refuse a /22 that Hetzner is happy with. A rule that
 * cannot name its cloud has nothing to say here.
 */
export const NETWORK_CIDR_SCHEMAS: Record<CloudProviderSlug, z.ZodType<string>> = {
	aws: makeNetworkCidrSchema("aws"),
	azure: makeNetworkCidrSchema("azure"),
	gcp: makeNetworkCidrSchema("gcp"),
	hetzner: makeNetworkCidrSchema("hetzner"),
	alibaba: makeNetworkCidrSchema("alibaba"),
};
