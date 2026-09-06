// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The IPv4 CIDR helpers behind `network.cidr_block` and the `cidr_for_hosts` AI tool (#3670).
//
// `isCarvableCidr` is the TS half of the `network_cidr_max_prefix` conformance table, so its
// ANSWERS are already pinned against packages/core/validate. What a table cannot pin is the rest of
// the module — `parseCidr`'s masking and its refusals, and the clamp arithmetic in `cidrForHosts` —
// and those are where the two defects this PR fixes actually lived.

import { describe, expect, it } from "vitest";
import {
	CIDR_REGEX,
	cidrForHosts,
	isCarvableCidr,
	NETWORK_CIDR_MAX_PREFIX,
	parseCidr,
} from "@/lib/cloud-providers/cidr";

describe("NETWORK_CIDR_MAX_PREFIX", () => {
	// These mirror unexported constants in packages/core/cloud/validate.go. The Go side asserts the
	// mirror (TestNetworkCIDRFloorsMatchTheApplyGate reads both source files); this asserts the
	// property that makes the table meaningful at all — that the clouds genuinely disagree, so a
	// single shared floor could never have been right.
	it("does not collapse to one shared floor", () => {
		expect(new Set(Object.values(NETWORK_CIDR_MAX_PREFIX)).size).toBeGreaterThan(1);
	});

	it("gives GCP no floor, because its template does not carve subnets from the network", () => {
		expect(NETWORK_CIDR_MAX_PREFIX.gcp).toBe(32);
	});

	it("is tightest on AWS and Azure", () => {
		expect(NETWORK_CIDR_MAX_PREFIX.aws).toBe(18);
		expect(NETWORK_CIDR_MAX_PREFIX.azure).toBe(18);
		expect(NETWORK_CIDR_MAX_PREFIX.hetzner).toBe(22);
		expect(NETWORK_CIDR_MAX_PREFIX.alibaba).toBe(28);
	});
});

describe("parseCidr", () => {
	it("reports the MASKED network when host bits are set, as Go's net.ParseCIDR does", () => {
		const parsed = parseCidr("10.0.5.7/16");
		expect(parsed).not.toBeNull();
		expect(parsed?.rangeStart).toBe("10.0.0.0");
		expect(parsed?.rangeEnd).toBe("10.0.255.255");
		expect(parsed?.totalAddresses).toBe(65536);
		expect(parsed?.usableHosts).toBe(65534);
	});

	it("counts a /32 as two addresses short of nothing rather than going negative", () => {
		expect(parseCidr("10.0.0.1/32")?.usableHosts).toBe(0);
	});

	it("handles the whole address space", () => {
		const parsed = parseCidr("0.0.0.0/0");
		expect(parsed?.totalAddresses).toBe(4294967296);
		expect(parsed?.rangeEnd).toBe("255.255.255.255");
	});

	// Go's net.ParseCIDR has refused zero-padded OCTETS since 1.17 and still ACCEPTS a zero-padded
	// PREFIX. Both directions matter: accepting a padded octet made the console show no error on a
	// value the apply gate refuses, and refusing a padded prefix — which the first fix here did —
	// would refuse a value the apply gate accepts.
	it.each([
		["a leading-zero octet", "010.0.0.0/8", false],
		["a zero-padded octet", "10.00.0.0/16", false],
		["a zero-padded prefix, which Go still accepts", "10.0.0.0/016", true],
		["a bare zero octet", "0.0.0.0/8", true],
	])("%s", (_name, cidr, ok) => {
		expect(parseCidr(cidr) !== null).toBe(ok);
	});

	it.each([
		["no prefix at all", "10.0.0.0"],
		["not an address", "overlays/dev"],
		["an octet over 255", "999.0.0.0/16"],
		["a prefix over 32", "10.0.0.0/33"],
		["empty", ""],
	])("refuses %s", (_name, cidr) => {
		expect(parseCidr(cidr)).toBeNull();
	});

	it("admits a three-digit prefix at the SHAPE level so /016 can reach the range check", () => {
		// The regex is deliberately looser than the rule; `parseCidr` is what decides. A two-digit
		// cap here would refuse "10.0.0.0/016" for its shape, which Go accepts.
		expect(CIDR_REGEX.test("10.0.0.0/016")).toBe(true);
		expect(CIDR_REGEX.test("10.0.0.0/333")).toBe(true);
		expect(parseCidr("10.0.0.0/333")).toBeNull();
	});
});

describe("isCarvableCidr", () => {
	it("accepts a network exactly at the floor and refuses one past it", () => {
		expect(isCarvableCidr("10.0.0.0/18", 18)).toBe(true);
		expect(isCarvableCidr("10.0.0.0/19", 18)).toBe(false);
	});

	it("refuses a malformed value rather than letting it through to the apply gate", () => {
		expect(isCarvableCidr("not-a-cidr", 18)).toBe(false);
		expect(isCarvableCidr("10.0.0.0", 18)).toBe(false);
	});
});

describe("cidrForHosts", () => {
	// The defect: this clamped to a hardcoded [16, 28] with no idea which cloud the answer was for,
	// so 200 hosts answered /24 — which validateNetworkCIDR refuses on AWS, Azure and Hetzner. It
	// is exposed to users as an AI tool, so that answer was advice the apply gate then rejected.
	it("never hands back a block its own cloud's gate would refuse", () => {
		const refused: string[] = [];
		for (const cloud of ["aws", "azure", "gcp", "hetzner", "alibaba"] as const) {
			for (const hosts of [1, 10, 200, 511, 4000, 60000]) {
				const out = cidrForHosts(hosts, "10.0.0.0", cloud);
				if (!isCarvableCidr(out.cidr, NETWORK_CIDR_MAX_PREFIX[cloud])) {
					refused.push(`${cloud}/${hosts} -> ${out.cidr}`);
				}
			}
		}
		expect(refused).toEqual([]);
	});

	// The second defect: the block was sized by ADDRESSES while the caller asks for HOSTS, so 511
	// hosts answered /23 — 510 usable, one short. AWS's floor hid it; GCP and Alibaba handed it out.
	it("returns a block that actually holds the hosts asked for", () => {
		const short: string[] = [];
		for (const cloud of ["aws", "gcp", "alibaba", "hetzner"] as const) {
			for (const hosts of [1, 2, 254, 255, 510, 511, 512, 1000]) {
				const out = cidrForHosts(hosts, "10.0.0.0", cloud);
				if (out.usableHosts < hosts) {
					short.push(`${cloud}/${hosts} -> ${out.cidr} holds ${out.usableHosts}`);
				}
			}
		}
		expect(short).toEqual([]);
	});

	it("clamps to the tightest floor when no cloud is given, so the answer is valid everywhere", () => {
		const out = cidrForHosts(511);
		expect(out).toMatchObject({ cidr: "10.0.0.0/18", prefix: 18, cloud: null, maxPrefix: 18 });
		const carvableOn = (["aws", "azure", "gcp", "hetzner", "alibaba"] as const).filter((cloud) =>
			isCarvableCidr(out.cidr, NETWORK_CIDR_MAX_PREFIX[cloud]),
		);
		expect(carvableOn).toEqual(["aws", "azure", "gcp", "hetzner", "alibaba"]);
	});

	it("lets the host count bind when it asks for more than the floor", () => {
		// 60000 hosts needs a /16, already wider than AWS's /18 floor — so the answer comes from the
		// count, not the clamp. Without this the assertions above are satisfied by always returning
		// the floor.
		const out = cidrForHosts(60000, "10.0.0.0", "aws");
		expect(out.prefix).toBe(16);
		expect(out.maxPrefix).toBe(18);
	});

	it("does not widen past /16 however many hosts are asked for", () => {
		expect(cidrForHosts(10_000_000, "10.0.0.0", "gcp").prefix).toBe(16);
	});

	it("reports the cloud whose floor bounded the answer", () => {
		expect(cidrForHosts(10, "10.0.0.0", "hetzner")).toMatchObject({ cloud: "hetzner", maxPrefix: 22 });
		expect(cidrForHosts(10).cloud).toBeNull();
	});

	it("uses the base address verbatim rather than masking it", () => {
		expect(cidrForHosts(10, "192.168.4.0", "gcp").cidr.startsWith("192.168.4.0/")).toBe(true);
	});

	it.each([
		["zero", 0],
		["negative", -5],
		["fractional", 2.7],
	])("treats a %s host count as at least one host", (_name, hosts) => {
		const out = cidrForHosts(hosts, "10.0.0.0", "gcp");
		expect(out.usableHosts).toBeGreaterThanOrEqual(1);
		expect(parseCidr(out.cidr)).not.toBeNull();
	});
});
