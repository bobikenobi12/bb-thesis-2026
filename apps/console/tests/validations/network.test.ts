// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The per-cloud `network.cidr_block` schemas (#3670).
//
// Nothing in the console validated this field before, and the apply gate
// (packages/core/cloud.validateNetworkCIDR) refuses a network the cloud's template cannot carve its
// subnets out of — so the only feedback was a failed deploy.
//
// The predicates' ANSWERS are pinned against Go by the conformance table. What that cannot reach is
// the schema wiring: whether each cloud's schema is actually built from its OWN floor, whether the
// shape check and the floor check produce the messages the user sees, and whether an unset value
// still means "the template default". Rewire `NETWORK_CIDR_SCHEMAS` to one shared floor and every
// Go test stays green.

import { describe, expect, it } from "vitest";
import { NETWORK_CIDR_MAX_PREFIX } from "@/lib/cloud-providers/cidr";
import {
	isCarvableFor,
	NETWORK_CIDR_CLOUDS,
	NETWORK_CIDR_SCHEMAS,
	networkCidrFloorMessage,
} from "@/lib/validations/network";

describe("NETWORK_CIDR_CLOUDS", () => {
	it("covers every cloud that has a floor, with a schema each", () => {
		expect([...NETWORK_CIDR_CLOUDS].sort()).toEqual(Object.keys(NETWORK_CIDR_MAX_PREFIX).sort());
		const wired = NETWORK_CIDR_CLOUDS.filter(
			(cloud) => NETWORK_CIDR_SCHEMAS[cloud] !== undefined && isCarvableFor[cloud] !== undefined,
		);
		expect(wired).toEqual([...NETWORK_CIDR_CLOUDS]);
	});
});

describe("each cloud's schema is built from its OWN floor", () => {
	// The property the whole per-cloud split exists for. A /22 is carvable on Hetzner, Alibaba and
	// GCP and is refused on AWS and Azure — so a single shared floor is wrong whichever value it
	// takes, and this fails if the schemas are ever collapsed onto one.
	it("accepts a /22 on Hetzner and refuses it on AWS", () => {
		expect(NETWORK_CIDR_SCHEMAS.hetzner.safeParse("10.0.0.0/22").success).toBe(true);
		expect(NETWORK_CIDR_SCHEMAS.aws.safeParse("10.0.0.0/22").success).toBe(false);
	});

	it("accepts a /29 on GCP, which has no floor, and refuses it everywhere else", () => {
		const accepted = NETWORK_CIDR_CLOUDS.filter(
			(cloud) => NETWORK_CIDR_SCHEMAS[cloud].safeParse("10.0.0.0/29").success,
		);
		expect(accepted).toEqual(["gcp"]);
	});

	it("accepts each cloud exactly at its floor and refuses one past it", () => {
		const atFloor = Object.fromEntries(
			NETWORK_CIDR_CLOUDS.map((cloud) => {
				const floor = NETWORK_CIDR_MAX_PREFIX[cloud];
				return [
					cloud,
					{
						at: NETWORK_CIDR_SCHEMAS[cloud].safeParse(`10.0.0.0/${floor}`).success,
						past: NETWORK_CIDR_SCHEMAS[cloud].safeParse(`10.0.0.0/${Math.min(floor + 1, 32)}`).success,
					},
				];
			}),
		);
		expect(atFloor).toEqual({
			aws: { at: true, past: false },
			azure: { at: true, past: false },
			// GCP's floor IS 32, so there is no "one past" — /32 is both, and that is the honest
			// expectation rather than a case skipped in a loop.
			gcp: { at: true, past: true },
			hetzner: { at: true, past: false },
			alibaba: { at: true, past: false },
		});
	});
});

describe("an unset network", () => {
	// `validateNetworkCIDR`'s own first line is `if cidr == "" { return nil }`. An unset value is
	// explicitly valid, not merely absent, and it is what every project predating the field stores —
	// so refusing it here would refuse input the server accepts.
	it("is accepted on every cloud", () => {
		const accepted = NETWORK_CIDR_CLOUDS.filter(
			(cloud) => NETWORK_CIDR_SCHEMAS[cloud].safeParse("").success && isCarvableFor[cloud](""),
		);
		expect(accepted).toEqual([...NETWORK_CIDR_CLOUDS]);
	});
});

describe("messages", () => {
	it("names the cloud's own floor, so the user is told what to type", () => {
		expect(networkCidrFloorMessage("aws")).toContain("/18");
		expect(networkCidrFloorMessage("hetzner")).toContain("/22");
		expect(networkCidrFloorMessage("alibaba")).toContain("/28");
	});

	it("does not talk about a floor for GCP, which has none", () => {
		const msg = networkCidrFloorMessage("gcp");
		expect(msg).not.toContain("/32");
		expect(msg).not.toContain("cidrsubnet");
	});

	/** The first issue's message, or a marker that the value was accepted. */
	const firstMessage = (value: string): string => {
		const out = NETWORK_CIDR_SCHEMAS.aws.safeParse(value);
		return out.success ? "<accepted>" : (out.error.issues[0]?.message ?? "<no issue>");
	};

	it("reports a value that is not a CIDR by its SHAPE, not by the floor", () => {
		expect(firstMessage("not-a-cidr")).toContain("valid IPv4 CIDR");
	});

	it("reports a well-formed but too-narrow value by the FLOOR, not the shape", () => {
		expect(firstMessage("10.0.0.0/24")).toBe(networkCidrFloorMessage("aws"));
	});
});

describe("the shape rule mirrors what the apply gate parses", () => {
	// Go's net.ParseCIDR refuses zero-padded octets and accepts a zero-padded prefix. Both
	// directions are wrong to get backwards: the first leaves the console silent on a value the
	// gate refuses, the second refuses a value the gate accepts.
	it.each([
		["a leading-zero octet", "010.0.0.0/8", false],
		["a zero-padded prefix", "10.0.0.0/016", true],
		["host bits set", "10.0.5.7/16", true],
		["an octet over 255", "300.0.0.0/16", false],
	])("%s", (_name, value, ok) => {
		expect(NETWORK_CIDR_SCHEMAS.aws.safeParse(value).success).toBe(ok);
	});
});
