// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The membership-role → PDP-role map (#3730). The end-to-end claim — that an invited member can
// actually load `/{org}` — is measured against a real database and the real PDP in
// `tests/integration/invited-member-org-overview.test.ts`. This file covers the pure function on
// its own so the mapping stays asserted even in a run where the Postgres tier is not available.

import { describe, expect, it } from "vitest";
import {
	ORG_ROLES,
	storedRolesFor,
	toDisplayRole,
	toOrgRole,
	toPdpRole,
} from "@/lib/authz/org-access-control";

describe("toOrgRole — the roles a human may PICK", () => {
	it("narrows each of Alethia's own roles", () => {
		for (const role of ORG_ROLES) expect(toOrgRole(role)).toBe(role);
	});

	it("does NOT accept better-auth's `member` — it is not an option in a role picker", () => {
		// Deliberate: `member` is a stored value the auth library produces, not something a person
		// chooses in the members table. Keeping it out here is why the two functions are separate.
		expect(toOrgRole("member")).toBeNull();
	});
});

describe("toPdpRole — what a STORED membership role grants", () => {
	it("maps better-auth's built-in `member` to the read-only bundle", () => {
		// The defect: this answered null, `ensureMemberGrant` wrote nothing, and every accepted
		// invitation produced a member the PDP denied everywhere.
		expect(toPdpRole("member")).toBe("viewer");
	});

	it("passes Alethia's own roles through unchanged", () => {
		for (const role of ORG_ROLES) expect(toPdpRole(role)).toBe(role);
	});

	it("covers every role better-auth itself can store", () => {
		// better-auth's `plugins/organization/schema` defaultRoles. Two of the three are ours
		// already; the third is the one that cost #3730. If the library ever grows a fourth, this
		// is the assertion that should notice.
		for (const role of ["owner", "admin", "member"]) {
			expect(toPdpRole(role), `better-auth role "${role}" must map`).not.toBeNull();
		}
	});

	it("is a map, NOT a fallback — an unrecognised role grants nothing", () => {
		// "Anything I don't recognise means viewer" would turn a typo, a renamed role, or a deleted
		// custom role into read access over the whole org.
		expect(toPdpRole("billing-contact")).toBeNull();
		expect(toPdpRole("Member")).toBeNull();
		expect(toPdpRole("")).toBeNull();
		expect(toPdpRole(",")).toBeNull();
		expect(toPdpRole("viewer-ish")).toBeNull();
	});

	it("mirrors the plugin and TRIMS — a stray space is not a different role", () => {
		// better-auth reads membership back as `role.split(",").map((r) => r.trim())`, so a value
		// IT treats as owner must not be denied here over whitespace. Answering null would deny
		// the member everything, which is the failure this whole map exists to stop.
		expect(toPdpRole("owner ")).toBe("owner");
		expect(toPdpRole(" member")).toBe("viewer");
	});

	it("resolves a comma-joined role list to its most-privileged mapped role", () => {
		// `parseRoles` joins an invite's `role: string[]` with "," and `acceptInvitation` copies
		// the string verbatim into the member row, so "admin,viewer" is a legitimate stored value.
		// It used to answer null — an accepted invitation with zero permissions, #3730's failure
		// from a second cause.
		expect(toPdpRole("admin,viewer")).toBe("admin");
		expect(toPdpRole("viewer,admin")).toBe("admin");
		expect(toPdpRole("admin, operator")).toBe("admin");
		expect(toPdpRole("operator,member")).toBe("operator");
		expect(toPdpRole("owner,admin,operator,viewer")).toBe("owner");
	});

	it("ignores the components it does not recognise, and grants nothing when none map", () => {
		// A custom or deleted role in the list contributes no permissions — but it must not veto
		// the one that does map, or a member the plugin considers an admin is denied everything.
		expect(toPdpRole("billing-contact,operator")).toBe("operator");
		expect(toPdpRole("billing-contact,auditor")).toBeNull();
	});

	it("answers null for Object.prototype keys — the lookup has no inherited members", () => {
		// `member.role` is free-form text out of the database. Had the alias table been an object
		// literal, `ALIASES["toString"]` would answer a FUNCTION — truthy, so the caller's
		// `if (!resolved)` would let it through and index the role-id table with a non-role.
		for (const key of ["toString", "constructor", "hasOwnProperty", "__proto__"]) {
			expect(toPdpRole(key), `"${key}" must not resolve to a role`).toBeNull();
		}
	});
});

describe("the alias must not stop at the PDP", () => {
	it("displays a stored role under the name of what it grants", () => {
		// A `member` row that authorizes as a viewer but renders as "member" hands the members
		// table a role its own <select> cannot offer — the control comes up blank.
		expect(toDisplayRole("member")).toBe("viewer");
		expect(toDisplayRole("admin,viewer")).toBe("admin");
	});

	it("shows an unrecognised role as itself rather than renaming it", () => {
		// Silently displaying "viewer" for a role that grants NOTHING would be a lie the operator
		// cannot see through.
		expect(toDisplayRole("billing-contact")).toBe("billing-contact");
	});

	it("gives every stored spelling of a role, for the queries that FILTER or BILL on it", () => {
		// `countBillableSeats` excludes the free role by this list: comparing the raw string would
		// charge a paid seat for a `member` row that holds exactly the read-only bundle.
		expect(storedRolesFor("viewer").sort()).toEqual(["member", "viewer"]);
		for (const role of ORG_ROLES) {
			expect(storedRolesFor(role), `"${role}" must include itself`).toContain(role);
			// Every alias must resolve back to the role it was listed under.
			for (const stored of storedRolesFor(role)) expect(toPdpRole(stored)).toBe(role);
		}
	});
});
