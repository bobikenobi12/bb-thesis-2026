// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Runtime provider-slug narrows + helpers + the resource-cache TTL — the NON-catalog logic that used
// to live in the registry.ts barrel shim (deleted in #940c). The provider DATA (PROVIDERS, the slug
// types, CloudProviderMeta) is the generated catalog SSOT (./generated/catalog); this module holds only
// the runtime helpers over it, which depend on the DB `cloud_provider` enum and so are kept OUT of the
// generated file (that file is regenerated from catalog.json — hand-authored logic there would be lost).

import { cloudProvider } from "@/lib/db/schema/enums";
import {
	type CloudProviderMeta,
	type CloudProviderSlug,
	type ConnectableCloudSlug,
	PROVIDERS,
} from "./generated/catalog";

/** The provisioning-slug values as a runtime set, kept in lockstep with the type via `satisfies`. */
export const CLOUD_PROVIDER_SLUGS = [
	"aws",
	"gcp",
	"azure",
	"hetzner",
	"alibaba",
] as const satisfies readonly CloudProviderSlug[];
const CLOUD_PROVIDER_SLUG_SET = new Set<string>(CLOUD_PROVIDER_SLUGS);
const CONNECTABLE_SLUG_SET = new Set<string>(cloudProvider.enumValues);

/** Cast-free narrow: true when a string is a provisioning-capable cloud slug. */
export function isCloudProviderSlug(s: string): s is CloudProviderSlug {
	return CLOUD_PROVIDER_SLUG_SET.has(s);
}

/** Cast-free narrow: true when a string is a connectable cloud (the full cloud_provider enum). */
export function isConnectableCloudSlug(s: string): s is ConnectableCloudSlug {
	return CONNECTABLE_SLUG_SET.has(s);
}

/** A string as a provisioning slug, defaulting to `aws` when it isn't one. */
export function asCloudProviderSlug(s: string): CloudProviderSlug {
	return isCloudProviderSlug(s) ? s : "aws";
}

/** How long cached cloud resources are considered fresh (hours). */
export const CACHE_TTL_HOURS = 24;

/** Returns provider metadata, defaulting to AWS if slug is unrecognized. */
export function getProvider(slug: string): CloudProviderMeta {
	return isConnectableCloudSlug(slug) ? PROVIDERS[slug] : PROVIDERS.aws;
}
