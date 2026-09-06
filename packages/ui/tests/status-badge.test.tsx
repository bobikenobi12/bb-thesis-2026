// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Unit test for StatusBadge: product status strings map onto the five grayscale
// visual tiers (active/pending/idle/failed/disabled), the label defaults to the
// raw status string, and unknown statuses fall back to `idle`. Also covers the
// `statusTier` resolver, tier/label/showLabel overrides, and case-insensitivity.

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { StatusBadge, statusTier } from "../src/status-badge";

/** Returns the outer `.vx-status` element wrapping the given label text. */
function badgeForLabel(text: string): HTMLElement {
	const el = screen.getByText(text).closest(".vx-status");
	if (!(el instanceof HTMLElement)) throw new Error(`no badge for "${text}"`);
	return el;
}

describe("statusTier resolver", () => {
	it.each([
		["active", "active"],
		["online", "active"],
		["success", "active"],
		["succeeded", "active"],
		// The promotion vocabulary. Six values of promotion_status and approval_status had no word
		// here and fell to the idle fallback, so an approved promotion and a blocked one rendered
		// as the badge for "present and doing nothing" — and, being unmapped, each also tripped the
		// dev-mode warning below. #4117.
		["approved", "active"],
		["ready", "active"],
		["connected", "active"],
		["running", "active"],
		["queued", "pending"],
		["pending", "pending"],
		["pending_plan", "pending"],
		["pending_approval", "pending"],
		["processing", "pending"],
		["claimed", "pending"],
		["provisioning", "pending"],
		["creating", "pending"],
		["updating", "pending"],
		["deploying", "pending"],
		["destroying", "pending"],
		["idle", "idle"],
		["offline", "idle"],
		["draining", "idle"],
		["draft", "idle"],
		["cancelled", "idle"],
		["canceled", "idle"],
		["failed", "failed"],
		["error", "failed"],
		["errored", "failed"],
		["rejected", "failed"],
		["blocked", "failed"],
		["disabled", "disabled"],
		["destroyed", "disabled"],
		["skipped", "disabled"],
	])("maps %s -> %s tier", (status, tier) => {
		expect(statusTier(status)).toBe(tier);
	});

	it("is case-insensitive", () => {
		expect(statusTier("ACTIVE")).toBe("active");
		expect(statusTier("Processing")).toBe("pending");
		expect(statusTier("FaIlEd")).toBe("failed");
		// promotion_status SHOUTS on the wire and approval_status whispers; the two spellings of
		// `approved` are one word, which is the whole reason the Go mirror folds case too.
		expect(statusTier("PENDING_APPROVAL")).toBe("pending");
		expect(statusTier("APPROVED")).toBe("active");
		expect(statusTier("BLOCKED")).toBe("failed");
	});

	it("does not put opposite promotion outcomes on one tier", () => {
		// The property the six words were added FOR: an operator scanning the approvals table for
		// the row holding a promotion up got the same glyph on every line. Asserted as a
		// disagreement rather than as three tier names, because that is the thing that was wrong.
		expect(statusTier("approved")).not.toBe(statusTier("rejected"));
		expect(statusTier("APPROVED")).not.toBe(statusTier("BLOCKED"));
		expect(statusTier("APPROVED")).not.toBe(statusTier("PENDING_APPROVAL"));
	});

	it("falls back to idle for unknown statuses", () => {
		expect(statusTier("whatever")).toBe("idle");
		expect(statusTier("")).toBe("idle");
		expect(statusTier("nonsense-status")).toBe("idle");
	});
});

describe("StatusBadge", () => {
	it("renders the status string (verbatim) as the label by default", () => {
		render(<StatusBadge status="ACTIVE" />);
		const badge = badgeForLabel("ACTIVE");
		expect(badge).toHaveClass("vx-status");
		expect(badge).toHaveClass("vx-status--active");
	});

	it.each([
		["ACTIVE", "vx-status--active"],
		["PROCESSING", "vx-status--pending"],
		["FAILED", "vx-status--failed"],
		["destroyed", "vx-status--disabled"],
		["offline", "vx-status--idle"],
	])("status %s gets the %s tier class", (status, tierClass) => {
		render(<StatusBadge status={status} />);
		const badge = badgeForLabel(status);
		expect(badge).toHaveClass(tierClass);
		// Exactly one tier class is applied.
		const tierClasses = Array.from(badge.classList).filter((c) =>
			c.startsWith("vx-status--"),
		);
		expect(tierClasses).toEqual([tierClass]);
	});

	it("falls back to the idle tier for an unknown status", () => {
		render(<StatusBadge status="bananas" />);
		const badge = badgeForLabel("bananas");
		expect(badge).toHaveClass("vx-status--idle");
	});

	it("always renders the dot element", () => {
		const { container } = render(<StatusBadge status="active" />);
		expect(container.querySelector(".vx-status__dot")).not.toBeNull();
	});

	it("honors an explicit tier override regardless of the status string", () => {
		// status "active" would resolve to the active tier, but tier wins.
		render(<StatusBadge status="active" tier="failed" />);
		const badge = badgeForLabel("active");
		expect(badge).toHaveClass("vx-status--failed");
		expect(badge).not.toHaveClass("vx-status--active");
	});

	it("renders a custom label instead of the status string", () => {
		render(<StatusBadge status="active" label="Online now" />);
		expect(screen.queryByText("active")).toBeNull();
		const badge = badgeForLabel("Online now");
		expect(badge).toHaveClass("vx-status--active");
	});

	it("hides the text label when showLabel is false but keeps the dot + tier", () => {
		const { container } = render(
			<StatusBadge status="FAILED" showLabel={false} />,
		);
		expect(screen.queryByText("FAILED")).toBeNull();
		const dot = container.querySelector(".vx-status__dot");
		expect(dot).not.toBeNull();
		const badge = dot?.closest(".vx-status");
		expect(badge).toHaveClass("vx-status--failed");
	});

	it("merges a caller-supplied className and forwards pass-through props", () => {
		render(
			<StatusBadge status="active" className="extra-class" data-testid="sb" />,
		);
		const badge = screen.getByTestId("sb");
		expect(badge).toHaveClass("vx-status");
		expect(badge).toHaveClass("vx-status--active");
		expect(badge).toHaveClass("extra-class");
	});

	// The failure this guards is not a crash — it is a badge that renders perfectly and means
	// nothing. STATUS_TIER is keyed on the infrastructure vocabulary; a domain with its own
	// words (support cases: open / pending_support / resolved / closed) gets "idle" for every
	// one, so an open urgent case and a closed one look identical. Nobody files that as a bug.
	describe("an unmapped status", () => {
		it("resolves to idle, and says so in development", () => {
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			expect(statusTier("pending_customer")).toBe("idle");
			expect(warn).toHaveBeenCalledOnce();
			expect(warn.mock.calls[0]?.[0]).toContain("pending_customer");
			warn.mockRestore();
		});

		it("warns once per distinct status, not once per row", () => {
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			statusTier("brand_new_status");
			statusTier("brand_new_status");
			statusTier("brand_new_status");
			expect(warn).toHaveBeenCalledOnce();
			warn.mockRestore();
		});

		it("stays silent when the caller passes an explicit tier — the documented escape", () => {
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			const { container } = render(<StatusBadge status="resolved" tier="disabled" />);
			expect(container.querySelector(".vx-status--disabled")).not.toBeNull();
			expect(warn).not.toHaveBeenCalled();
			warn.mockRestore();
		});

		it("does not warn for a status that IS mapped", () => {
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			expect(statusTier("FAILED")).toBe("failed");
			expect(warn).not.toHaveBeenCalled();
			warn.mockRestore();
		});
	});
});
