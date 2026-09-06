// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { CloudProviderSlug } from "./generated/catalog";

/**
 * Matches an IPv4 CIDR like "10.0.0.0/16" — SHAPE only; octet and prefix RANGES are checked by
 * `parseCidr`, which is what any decision should go through.
 *
 * The prefix is `\d{1,3}` and not `\d{1,2}` deliberately. Go's `net.ParseCIDR` accepts a
 * zero-padded prefix ("10.0.0.0/016" is a /16), so a two-digit cap here would refuse a value the
 * apply gate accepts — the direction the shared invariant forbids. Three digits let the shape
 * through and `parseCidr` then rejects anything over 32, which is what Go does too. Pinned by
 * `a-zero-padded-prefix-which-go-still-accepts` and `a-prefix-over-32` in the conformance table.
 */
export const CIDR_REGEX = /^(\d{1,3}\.){3}\d{1,3}\/\d{1,3}$/;

/**
 * The widest prefix each cloud's template can carve its subnets out of, mirroring the constants
 * `packages/core/cloud/validate.go` enforces at the apply gate (`validateNetworkCIDR`):
 * `awsMaxNetworkPrefix`/`azureMaxNetworkPrefix` = 18, `hetznerMaxNetworkPrefix` = 22,
 * `alibabaMaxNetworkPrefix` = 32 - 4 = 28.
 *
 * A network NARROWER than its cloud's floor (a larger prefix) plans clean and then dies inside
 * `cidrsubnet()` mid-apply, which is the worst place to find out.
 *
 * GCP is 32 — not "no floor written down yet", but the deliberate answer: the GCP template does not
 * carve subnets out of the project network with `cidrsubnet()`, so `validateNetworkCIDR` is never
 * called for it and no prefix is refused on this axis. `packages/core/cloud/validate_test.go` states
 * the same thing as "gcp /29 is not this gate's business".
 *
 * `packages/core/validate/mirror_test.go` reads those constants out of their own source file
 * (`TestNetworkCIDRFloorsMatchTheApplyGate`) and this table out of THIS one
 * (`TestTheConsoleStatesTheSameFloors`), so neither end can drift alone.
 */
export const NETWORK_CIDR_MAX_PREFIX = {
	aws: 18,
	azure: 18,
	gcp: 32,
	hetzner: 22,
	alibaba: 28,
} as const satisfies Record<CloudProviderSlug, number>;

/**
 * The floor to assume when the cloud is not known yet: the TIGHTEST of them, so a block generated
 * without a cloud in hand is accepted by every cloud.
 *
 * This is the opposite end of the range from what a REFUSAL with no cloud in hand may use, and
 * deliberately so. Generating a value without a cloud must be conservative; refusing one without a
 * cloud must be permissive — and since GCP has no floor at all, "permissive" there means refusing
 * nothing on this axis. Collapsing the two is how you get a helper that hands back a block its own
 * validator rejects, which is the defect this replaces.
 */
const TIGHTEST_NETWORK_FLOOR = Math.min(...Object.values(NETWORK_CIDR_MAX_PREFIX));

/** The narrowest block `cidrForHosts` will ever hand back, cloud floors permitting. */
const SMALLEST_GENERATED_PREFIX = 28;
/** The widest block `cidrForHosts` will ever hand back. */
const LARGEST_GENERATED_PREFIX = 16;

export interface CidrInfo {
	cidr: string;
	prefix: number;
	/** 2^(32-prefix) — every address in the block. */
	totalAddresses: number;
	/** Total minus the network + broadcast addresses. */
	usableHosts: number;
	/** The cloud whose floor bounded the answer, or `null` when none was supplied. */
	cloud: CloudProviderSlug | null;
	/** The effective maximum prefix applied — `min(28, the cloud's floor)`. Reported rather than
	 * interpreted, so a caller can say WHY the block is wider than the host count needed. */
	maxPrefix: number;
}

/**
 * Smallest IPv4 CIDR that fits `hosts` addresses AND that `cloud`'s template can still carve its
 * subnets out of.
 *
 * Before #3670 this clamped to a hardcoded [16, 28] with no knowledge of the cloud, so
 * `cidr_for_hosts(200)` answered `10.0.0.0/24` — which `validateNetworkCIDR` refuses on AWS, Azure
 * and Hetzner. The helper is exposed to users as an AI tool, so that answer was handed out as
 * advice and then rejected by the apply gate.
 *
 * With no cloud supplied it clamps to the TIGHTEST floor across the clouds, so the answer is valid
 * everywhere rather than valid nowhere in particular.
 *
 * Pure. `base` is used verbatim as the network address — it is not masked to the prefix, which is
 * what the callers (a suggested `network.cidr_block`) want.
 */
export function cidrForHosts(hosts: number, base = "10.0.0.0", cloud?: CloudProviderSlug): CidrInfo {
	const needed = Math.max(1, Math.floor(hosts));
	const floor = cloud === undefined ? TIGHTEST_NETWORK_FLOOR : NETWORK_CIDR_MAX_PREFIX[cloud];
	// The floor is a MAXIMUM prefix; a floor wider than SMALLEST_GENERATED_PREFIX (GCP's 32) must
	// not widen the range this helper was already willing to return.
	const narrowest = Math.min(SMALLEST_GENERATED_PREFIX, floor);
	// `+ 2` because the caller asks for HOSTS and a block spends two addresses on the network and
	// broadcast. Sizing by addresses answered `/23` for 511 hosts — 512 addresses, 510 usable, one
	// short of what was asked for. On AWS, Azure and Hetzner the floor widened the block and hid
	// it; on GCP and Alibaba, whose floors are looser than the fit, it was handed straight out.
	const fitting = 32 - Math.ceil(Math.log2(needed + 2));
	const prefix = Math.min(narrowest, Math.max(LARGEST_GENERATED_PREFIX, fitting));
	const totalAddresses = 2 ** (32 - prefix);
	return {
		cidr: `${base}/${prefix}`,
		prefix,
		totalAddresses,
		usableHosts: Math.max(totalAddresses - 2, 0),
		cloud: cloud ?? null,
		maxPrefix: narrowest,
	};
}

/** "010" and "00" are refused; "0" is not. Mirrors what Go's `net.ParseCIDR` does to an OCTET. */
function hasLeadingZero(part: string): boolean {
	return part.length > 1 && part.startsWith("0");
}

/**
 * Parses an IPv4 CIDR into address counts + range. Returns null when malformed.
 *
 * Accepts host bits outside the mask ("10.0.0.1/16"), matching Go's `net.ParseCIDR`, and reports
 * the MASKED network the way Go's returned `*net.IPNet` does.
 *
 * Rejects a LEADING ZERO in any OCTET, which `net.ParseCIDR` has done since Go 1.17 — but not in
 * the prefix, which Go still accepts ("10.0.0.0/016" is a /16). `CIDR_REGEX` admits `\d{1,3}` and `Number.parseInt` reads "010" as 10, so "010.0.0.0/8"
 * used to parse here and be refused by the apply gate — the console showing no error and the
 * deploy dying later, which is the whole failure this file's rules exist to prevent. Both
 * spellings are pinned in the conformance table.
 */
export function parseCidr(cidr: string): {
	prefix: number;
	totalAddresses: number;
	usableHosts: number;
	rangeStart: string;
	rangeEnd: string;
} | null {
	if (!CIDR_REGEX.test(cidr)) return null;
	const [ip, prefixStr] = cidr.split("/");
	const octets = ip.split(".");
	// OCTETS only. Driven against Go rather than reasoned about: `net.ParseCIDR` refuses
	// "010.0.0.0/8" and "10.00.0.0/16" but ACCEPTS "10.0.0.0/016" as a /16. Rejecting the padded
	// prefix here too — which the first version of this fix did — would refuse a value the apply
	// gate accepts, which is the same violation in the other direction. All three are cases.
	if (octets.some(hasLeadingZero)) return null;
	const prefix = Number.parseInt(prefixStr, 10);
	if (prefix < 0 || prefix > 32) return null;
	const parts = octets.map(Number);
	if (parts.some((p) => p < 0 || p > 255)) return null;

	const totalAddresses = 2 ** (32 - prefix);
	const ipNum =
		((parts[0] << 24) + (parts[1] << 16) + (parts[2] << 8) + parts[3]) >>> 0;
	const mask = prefix === 0 ? 0 : (~((1 << (32 - prefix)) - 1) >>> 0) >>> 0;
	const start = (ipNum & mask) >>> 0;
	const end = (start + totalAddresses - 1) >>> 0;
	const toIp = (n: number) =>
		`${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`;

	return {
		prefix,
		totalAddresses,
		usableHosts: Math.max(totalAddresses - 2, 0),
		rangeStart: toIp(start),
		rangeEnd: toIp(end),
	};
}

/**
 * The shared rule behind the `network_cidr_max_prefix` conformance table: is `cidr` a valid IPv4
 * network that `maxPrefix` still allows?
 *
 * Deliberately mirrors the Go side's ORDER of judgement — parse first, then compare — so a
 * malformed value is refused for being malformed on both sides rather than passing here and
 * failing there. That claim is only as good as what `parseCidr` refuses, which is why the
 * leading-zero spellings Go rejects are refused there too and pinned as cases.
 */
export function isCarvableCidr(cidr: string, maxPrefix: number): boolean {
	const parsed = parseCidr(cidr);
	if (parsed === null) return false;
	return parsed.prefix <= maxPrefix;
}
