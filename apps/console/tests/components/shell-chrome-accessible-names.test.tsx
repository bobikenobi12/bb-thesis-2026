// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The shell chrome renders on EVERY private route, so one unnamed control in it is a defect on
// every page in the product at once — which is exactly what happened: the UI conformance audit
// (#3632) scored axe `button-name` CRITICAL on 39 of 40 routes, the fortieth being the one route
// that does not mount the shell. The cause was `role="combobox"` on the switcher trigger: the role
// takes its name from the author only, so the visible label ("All projects", "production") was not
// the accessible name and the button had none.
//
// This test is deliberately a SWEEP rather than an assertion about that one button. A per-button
// assertion would have passed for the two switchers and said nothing about the next control added
// to the topbar. Every element the chrome renders in a COMMAND role — native `<button>` plus the
// `role="button" | "link" | "menuitem"` shapes axe covers under `aria-command-name` — must have an
// accessible name, and the sweep is what carries that forward.

import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NAME_REQUIRED, unnamedControls } from "../support/accessible-names";

const { pathname, environments } = vi.hoisted(() => ({
	pathname: { current: "/acme/~/support/my-cases" },
	environments: { current: [] as { id: string; name: string; is_default: boolean }[] },
}));

vi.mock("next/navigation", () => ({
	usePathname: () => pathname.current,
	useParams: () => ({ org: "acme" }),
	useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
	useSearchParams: () => new URLSearchParams(),
}));
vi.mock("next-runtime-env", () => ({ env: (key: string) => process.env[key] }));
vi.mock("@/app/server/actions/resolve", () => ({
	resolveProjectId: vi.fn(),
	getEnvironmentsForSlug: vi.fn(async () => environments.current),
	resolveOrgScope: vi.fn(),
}));
vi.mock("@/lib/auth/client", () => ({
	authClient: {
		useSession: () => ({ data: { user: { name: "User", email: "user@example.com" } } }),
		signOut: vi.fn(),
		listAccounts: vi.fn(async () => ({ data: [] })),
	},
}));
vi.mock("@repo/privacy/consent-provider", () => ({
	useConsent: () => ({ openPreferences: vi.fn() }),
}));
vi.mock("@/components/org/upgrade-sheet-provider", () => ({
	useUpgradeSheet: () => ({ openUpgrade: vi.fn() }),
}));
vi.mock("@/components/settings/enterprise-gate", () => ({ useEntitlement: () => true }));
vi.mock("@/lib/query/use-projects-query", () => ({ useProjectsQuery: () => ({ data: [] }) }));
vi.mock("@/lib/query/use-jobs-query", () => ({ useJobsQuery: () => ({ data: [] }) }));
vi.mock("@/hooks/use-support-notifications", () => ({
	useSupportNotifications: () => ({
		notifications: [],
		unreadCount: 0,
		markAsRead: vi.fn(),
		markAllRead: vi.fn(),
	}),
}));
vi.mock("@/lib/stores/use-workspace-store", () => ({
	useActiveOrgSlug: () => "acme",
	useWorkspaceStore: Object.assign(
		() => ({
			activeOrgId: "org_1",
			organizations: [{ id: "org_1", name: "Acme", slug: "acme", plan: "hobby" }],
			fetchWorkspace: vi.fn(),
			switchOrg: vi.fn(),
		}),
		{ getState: () => ({ fetchWorkspace: vi.fn() }) },
	),
}));

const { AppSidebar } = await import("@/components/shell/app-sidebar");
const { Topbar } = await import("@/components/shell/topbar");

// The denominator moved to tests/support/accessible-names.ts in #3756 so a second sweep — over the
// page-owned components that carry the same name-from-author-only idiom — measures the same thing
// this one does, and `NAME_REQUIRED` widened there from the two COMMAND rules to all three of axe's
// name rules. `scanA11y` keeps serious AND critical, so every one of the three is inside the audit's
// denominator and must be inside a sweep's.

beforeEach(() => {
	pathname.current = "/acme/~/support/my-cases";
	environments.current = [];
});

describe("shell chrome — accessible names", () => {
	it("names every button in the topbar at org scope", () => {
		const { container } = render(<Topbar onOpenSidebar={() => {}} />);
		expect(container.querySelectorAll(NAME_REQUIRED).length).toBeGreaterThan(0);
		expect(unnamedControls(container)).toEqual([]);
	});

	it("names every button in the topbar inside a project, with the env switcher mounted", async () => {
		pathname.current = "/acme/atlas/environments";
		environments.current = [{ id: "env_1", name: "production", is_default: true }];
		const { container } = render(<Topbar onOpenSidebar={() => {}} />);
		// The env switcher only mounts once its list resolves — wait for it, or this asserts
		// against a topbar that never rendered the control the audit flagged.
		await screen.findByRole("button", { name: /Switch environment/i });
		expect(unnamedControls(container)).toEqual([]);
	});

	// Both flags change WHAT the sidebar renders — `selfRunners` builds a different nav (whose
	// "Soon" rows are disabled buttons) and `isHosted` gates the Upgrade CTA, the feedback entry
	// and the issues link. Sweeping one combination would leave the self-managed shape unswept,
	// which is the deployment the other half of this PR exists to unbreak.
	it.each([
		[true, true],
		[true, false],
		[false, true],
		[false, false],
	])("names every button in the sidebar (isHosted=%s, selfRunners=%s)", (isHosted, selfRunners) => {
		const { container } = render(
			<AppSidebar isHosted={isHosted} selfRunners={selfRunners} />,
		);
		expect(container.querySelectorAll(NAME_REQUIRED).length).toBeGreaterThan(0);
		expect(unnamedControls(container)).toEqual([]);
	});

	it("puts the switcher's purpose ahead of the current selection", async () => {
		pathname.current = "/acme/atlas/environments";
		environments.current = [{ id: "env_1", name: "production", is_default: true }];
		render(<Topbar onOpenSidebar={() => {}} />);

		// The name is context + selection, not one or the other: "Switch project" alone never says
		// which project is active, and "All projects" alone never says it is a switcher. The visible
		// text stays part of the name (WCAG 2.5.3, label in name).
		const project = screen.getByRole("button", { name: "Switch project: All projects" });
		expect(within(project).getByText("All projects")).toBeInTheDocument();
		expect(
			await screen.findByRole("button", { name: "Switch environment: production" }),
		).toBeInTheDocument();
	});

	it("keeps the org switcher a split control: the org body and a separately named chevron", () => {
		render(<AppSidebar isHosted selfRunners />);
		// The body navigates to the org (base-ui renders the anchor with role=button); only the
		// chevron opens the picker, and it is the half that carries the author-supplied name.
		expect(screen.getByRole("button", { name: /Acme/ })).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Switch organization" }),
		).toBeInTheDocument();
	});
});
