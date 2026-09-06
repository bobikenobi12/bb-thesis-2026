// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The PAGE-OWNED half of the sweep #3749 started on the shell chrome
// (tests/components/shell-chrome-accessible-names.test.tsx). Same method, different surface: render
// the real components, compute every control's ACCESSIBLE NAME, and fail on the ones that have
// none.
//
// The idiom this exists to catch is `role="combobox"` on a trigger. That role is
// name-from-author-only — `namedFromContents` is false for it, so axe's `button-has-visible-text`
// check yields `''` — and every `@repo/ui/select` trigger is one, because base-ui stamps the role
// unconditionally (`SelectTrigger.js:115`, re-forced at `:193`). A settings row reading
// "eu-west-1 · Frankfurt" therefore scored `button-name` CRITICAL with its label visible on screen,
// which is why an eyeball review of these pages found nothing for weeks.
//
// TWO THINGS THIS FILE IS CAREFUL ABOUT, both of which this repo has been burned by:
//
//  - It asserts the NAME, never the attribute. `unnamedControls` runs the accname algorithm;
//    a test for `aria-label` being present passes for `aria-label=""`, for an `aria-labelledby`
//    pointing at an id that no longer renders, and for a name that says the wrong thing.
//  - It renders the REAL components — `OrgGeneral`, `PreviewSettings`, `RepositorySelector`,
//    `ConfigFields` — not a hand-built fixture shaped like them. A guard assembled out of its own
//    fix verifies a copy of itself; the whole point of #3756's `SettingsField` → `SettingsSelect`
//    context is that a CALL SITE which was never edited is now named, and only the call site can
//    show that.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NAME_REQUIRED, unnamedControls } from "../support/accessible-names";
import type { KindConfig } from "@/components/design-project/canvas/inspector/config-schema";

// ── Mocks: the server actions and client singletons these page components reach for on mount ──

vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));
vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock("@/lib/auth/client", () => ({
	authClient: {
		organization: { update: vi.fn(), delete: vi.fn() },
		linkSocial: vi.fn(),
	},
}));
vi.mock("@/lib/stores/use-workspace-store", () => ({
	useWorkspaceStore: (select: (st: unknown) => unknown) =>
		select({ activeOrgId: "org_1", fetchWorkspace: vi.fn() }),
}));
vi.mock("@/app/server/actions/org-settings", () => ({
	getOrgSettings: vi.fn(async () => ({
		name: "Acme",
		slug: "acme",
		logo: null,
		description: "",
		primaryAddress: null,
		region: "eu-west-1",
		defaultEnv: "production",
		terraformVersion: "1.9.0",
	})),
}));
vi.mock("@/app/server/actions/preview", () => ({
	configurePreviewEnvironments: vi.fn(),
}));
// RepositorySelector is rendered FOR REAL — inside PreviewSettings and inside ConfigFields — so
// only the two server actions behind it are stubbed. Returning a linked provider is the whole
// point: with none linked the component renders its "connect a provider" branch, which is exactly
// why the audit never scored its icon-only git-provider select on `…/settings/preview` (#3756).
vi.mock("@/app/server/actions/identities", () => ({
	getLinkedProviders: vi.fn(async () => ["github"]),
}));
vi.mock("@/app/server/actions/git/repositories", () => ({
	fetchRepositoriesByProvider: vi.fn(async () => ({
		repositories: [
			{
				id: "repo-1",
				name: "shop",
				full_name: "acme/shop",
				url: "https://github.com/acme/shop",
				private: true,
				default_branch: "main",
				provider: "github",
			},
		],
	})),
}));
vi.mock("@/components/design-project/repository-context", () => ({
	useRepositoryContext: () => null,
}));

const { OrgGeneral } = await import("@/components/settings/general/org-general");
const { PreviewSettings } = await import(
	"@/components/settings/preview/preview-settings"
);
const { RepositorySelector } = await import("@/components/repository-selector");
const { Combobox } = await import("@/components/settings/access/combobox");
const { SettingsField, SettingsSelect } = await import(
	"@/components/settings/settings-ui"
);
const { ConfigFields } = await import(
	"@/components/design-project/canvas/inspector/config-fields"
);

/**
 * `apps/console`, found by ascent rather than assumed.
 *
 * NOT `import.meta.url` — Vitest's jsdom transform does not hand this module a `file:` URL, so
 * `fileURLToPath` throws. And not a bare `process.cwd()` either: this THROWS when it cannot find
 * the console, because the failure it has to avoid is a scan that silently reads an empty
 * directory and reports a derived set of zero, which is a guard reporting green for having looked
 * nowhere.
 */
function consoleRoot(): string {
	let dir = process.cwd();
	for (let up = 0; up < 6; up += 1) {
		if (
			existsSync(path.join(dir, "vitest.config.ts")) &&
			existsSync(path.join(dir, "components"))
		) {
			return dir;
		}
		dir = path.dirname(dir);
	}
	throw new Error(`could not locate apps/console from ${process.cwd()}`);
}

const CONSOLE_ROOT = consoleRoot();

// ── The subject set, DERIVED ────────────────────────────────────────────────────────────────────
//
// A hand-typed list of files to sweep stops covering silently: the next component to grow a select
// is simply absent from it, and absence is indistinguishable from "checked, fine". So the set is
// read out of the source on every run, and the ledgers below have to account for all of it.
//
// WHAT IS DERIVED is the set of files that ORIGINATE the idiom — a literal `role="combobox"`, or a
// `<SelectTrigger>` (which base-ui turns into one). Deliberately NOT the call sites of the console's
// select WRAPPERS: `SettingsSelect` names itself from its `SettingsField` now, so its four call
// sites are correct by construction and enumerating them would be enumerating the wrong thing. The
// wrapper's own file is in the derived set, and that is the file whose behaviour has to be proven.
//
// The matcher is plain text and it OVER-REPORTS: a file that only DISCUSSES the idiom in a comment
// matches too. That is the cheap sound direction. A structural matcher would be more precise and
// would have to resolve `<SelectTrigger>` through re-exports and renames to stay that way; an
// over-report costs one ledger line, and the ledger is checked in both directions so a line that
// stops being true fails as loudly as one that is missing.
const IDIOM = /<SelectTrigger|role="combobox"/;

/** Every console `.tsx` under `dirs` whose source originates a name-from-author-only trigger. */
function sourcesWithAuthorOnlyTriggers(dirs: string[]): string[] {
	const found: string[] = [];
	const walk = (rel: string) => {
		for (const entry of readdirSync(path.join(CONSOLE_ROOT, rel), {
			withFileTypes: true,
		})) {
			const next = path.posix.join(rel, entry.name);
			if (entry.isDirectory()) walk(next);
			else if (
				entry.name.endsWith(".tsx") &&
				IDIOM.test(readFileSync(path.join(CONSOLE_ROOT, next), "utf8"))
			) {
				found.push(next);
			}
		}
	};
	for (const dir of dirs) walk(dir);
	return found.sort();
}

/**
 * Source files a sweep RENDERS, and which sweep renders them.
 *
 * May legitimately be a superset of the derived set: `org-general.tsx` originates no trigger of its
 * own (it composes `SettingsSelect`) and is swept anyway, because it is the call site that proves
 * the label context reaches a file nobody edited.
 */
const SWEPT: Record<string, string> = {
	"components/settings/settings-ui.tsx": "this file",
	"components/settings/general/org-general.tsx": "this file",
	"components/settings/preview/preview-settings.tsx": "this file",
	"components/repository-selector.tsx": "this file",
	"components/settings/access/combobox.tsx": "this file",
	"components/design-project/canvas/inspector/config-fields.tsx": "this file",
	"components/shell/switcher-trigger.tsx": "shell-chrome-accessible-names.test.tsx",
};

/**
 * Files that originate the idiom and are NOT yet swept by any of them.
 *
 * SHRINK-ONLY, and checked in both directions. Growing it is a deliberate act with a diff, which is
 * the only property that matters here: the failure mode #3756 exists to end is a control that is
 * unnamed because no audited route happened to render it, and a list that can quietly gain a line
 * reproduces exactly that. An entry that stops matching also fails, so a file that loses its select
 * cannot leave a stale claim behind.
 */
const UNSWEPT = [
	"components/addons/addon-config-sheet.tsx",
	"components/ai-elements/code-block.tsx",
	"components/ai-elements/prompt-input.tsx",
	"components/alerts/channel-routing.tsx",
	"components/alerts/policy-conditions.tsx",
	"components/alerts/throttle-field.tsx",
	"components/billing/billing-checkout-form.tsx",
	"components/connectors/provider-config-fields.tsx",
	"components/create-project/environment-placement.tsx",
	"components/create-project/region-select.tsx",
	"components/data-table.tsx",
	"components/design-project/byo/byo-iac-dialog.tsx",
	"components/design-project/canvas/inspector/bindings-field.tsx",
	"components/design-project/canvas/inspector/connector-select.tsx",
	"components/design-project/cloud-identity-selector.tsx",
	"components/design-project/placement-selector.tsx",
	"components/environments/new-environment-dialog.tsx",
	"components/environments/promote-dialog.tsx",
	"components/org/org-purchase-ui.tsx",
	"components/projects/duplicate-project-dialog.tsx",
	"components/runners/add-runner-dialog.tsx",
	"components/runners/fleet-pool-wizard.tsx",
	"components/settings/members/invite-member-dialog.tsx",
	"components/settings/members/members-table.tsx",
	"components/shell/feedback-dialog.tsx",
	"components/support/abuse/abuse-form.tsx",
	"components/support/submit/steps/step-category.tsx",
	"components/support/submit/steps/step-contact.tsx",
];

describe("the sweep's subject set is derived, not typed", () => {
	it("accounts for every console source that originates a name-from-author-only trigger", () => {
		const derived = sourcesWithAuthorOnlyTriggers(["components", "app"]);
		expect(derived.length).toBeGreaterThan(0);
		const accounted = new Set([...Object.keys(SWEPT), ...UNSWEPT]);
		expect(derived.filter((file) => !accounted.has(file))).toEqual([]);
	});

	it("carries no stale entry in the unswept ledger", () => {
		const derived = new Set(sourcesWithAuthorOnlyTriggers(["components", "app"]));
		expect(UNSWEPT.filter((file) => !derived.has(file))).toEqual([]);
	});

	it("keeps the unswept ledger shrink-only", () => {
		// 28 at #3756. Lower it when a sweep takes one over; never raise it.
		expect(UNSWEPT.length).toBeLessThanOrEqual(28);
	});
});

// ── The sweeps ──────────────────────────────────────────────────────────────────────────────────

describe("settings pages — accessible names", () => {
	it("names every control on Settings · General", async () => {
		const { container } = render(<OrgGeneral />);
		// The panel renders skeletons until `getOrgSettings` resolves — without the wait this
		// asserts against a tree that contains no select at all and passes for the wrong reason.
		await screen.findByText("Data region");
		expect(container.querySelectorAll(NAME_REQUIRED).length).toBeGreaterThan(0);
		expect(unnamedControls(container)).toEqual([]);
	});

	it("takes the two Defaults selects' names from their visible row labels", async () => {
		render(<OrgGeneral />);
		// Neither call site passes an `aria-label`; both are named by `SettingsField` publishing the
		// id of the label the user can already read. Asserting the NAME (not the attribute) is what
		// makes this a claim about what a screen reader says.
		expect(
			await screen.findByRole("combobox", { name: "Data region" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("combobox", { name: "Default Project environment" }),
		).toBeInTheDocument();
	});

	it("names every control on Settings · Preview environments", async () => {
		const { container } = render(
			<PreviewSettings
				projectId="proj-1"
				initialConfig={null}
				fabrics={[
					{
						id: "11111111-1111-4111-8111-111111111111",
						name: "shared",
						region: "eu-west-1",
						status: "ACTIVE",
					},
				]}
				gitCredentials={[
					{
						id: "22222222-2222-4222-8222-222222222222",
						purpose: "argocd",
						method: "oauth",
					},
				]}
				gitlabBaseUrl="https://gitlab.com"
			/>,
		);
		// RepositorySelector loads its provider list asynchronously; the icon-only git-provider
		// select does not exist until it resolves, and it is one of the controls under test.
		await screen.findByRole("combobox", { name: "Git provider: github" });
		expect(unnamedControls(container)).toEqual([]);
	});

	it("keeps the visible row label inside each name where one row holds several selects", async () => {
		render(
			<PreviewSettings
				projectId="proj-1"
				initialConfig={null}
				fabrics={[]}
				gitCredentials={[]}
				gitlabBaseUrl="https://gitlab.com"
			/>,
		);
		// "Placement" is the row label and cannot name two controls, so each says which half it is —
		// and each still contains the visible label, so "placement" reaches both (WCAG 2.5.3).
		for (const name of ["Placement mode", "Placement fabric", "Credentials"]) {
			expect(
				await screen.findByRole("combobox", { name }),
			).toBeInTheDocument();
		}
	});
});

describe("repository selector — accessible names", () => {
	it("names every control once a provider is linked", async () => {
		const { container } = render(
			<RepositorySelector label="Repository" value={undefined} onChange={() => {}} />,
		);
		await screen.findByRole("combobox", { name: "Git provider: github" });
		expect(unnamedControls(container)).toEqual([]);
	});

	it("names the repository trigger from its visible text, and adds purpose once one is picked", async () => {
		const { container } = render(
			<RepositorySelector
				label="Repository"
				value="https://github.com/acme/shop"
				onChange={() => {}}
			/>,
		);
		// The role came OFF the popover trigger, so base-ui's own `aria-haspopup="dialog"` is no
		// longer contradicted by a `combobox` that owns no listbox.
		//
		// THE NAME AND THE ATTRIBUTE ARE AWAITED TOGETHER, and that is the whole point of the
		// `waitFor`. They come from different writers on different renders:
		//
		//  - the accessible name is written by this app's own JSX (`components/repository-selector.tsx`)
		//    and lands in the same flush as `repositories` + the end of `fetchingRepos`, so it is
		//    present on render N;
		//  - `aria-haspopup` is written by base-ui. `PopoverTrigger` reads it out of the popover
		//    store (`popover/trigger/PopoverTrigger.js:87`, `store.useState('triggerProps', …)`),
		//    whose `activeTriggerProps`/`inactiveTriggerProps` are initialised to `EMPTY_OBJECT`
		//    (`utils/popups/store.js:27-28`) and are only filled by `PopoverRoot` through
		//    `store.useSyncedValues({ activeTriggerProps, inactiveTriggerProps, … })`
		//    (`popover/root/PopoverRoot.js:99-115`) — which is a LAYOUT EFFECT
		//    (`@base-ui-components/utils/store/ReactStore.js:81-95`, `useIsoLayoutEffect`). It
		//    therefore reaches the DOM on render N+1.
		//
		// So waiting for the NAME and then asserting the ATTRIBUTE waits for the earlier of the two
		// and asserts the later one: the trigger is guaranteed to exist, correctly named, one render
		// before it can carry `aria-haspopup`. That is the 111 ms-fail / 306–706 ms-pass signature
		// of #4079 — it is a race, not a wrong expectation, and it only ever failed by losing it.
		// `getByRole` still throws when the name is wrong, so the name claim in this test's title is
		// unchanged; it is only no longer used as the synchronisation point for someone else's write.
		await waitFor(() =>
			expect(
				screen.getByRole("button", { name: "Select repository: acme/shop" }),
			).toHaveAttribute("aria-haspopup", "dialog"),
		);
		expect(unnamedControls(container)).toEqual([]);
	});
});

describe("access combobox — accessible names", () => {
	const OPTIONS = [
		{ value: "k8s.read", label: "Kubernetes read" },
		{ value: "k8s.write", label: "Kubernetes write" },
	];

	it("lets the placeholder name the control while nothing is selected", () => {
		const { container } = render(
			<Combobox
				options={OPTIONS}
				value=""
				onChange={() => {}}
				placeholder="Select a permission…"
			/>,
		);
		expect(unnamedControls(container)).toEqual([]);
		// No redundant author name: the visible placeholder IS the accessible name.
		expect(
			screen.getByRole("button", { name: "Select a permission…" }),
		).toBeInTheDocument();
	});

	it("adds the purpose once a selection replaces the placeholder", () => {
		const { container } = render(
			<Combobox
				options={OPTIONS}
				value="k8s.read"
				onChange={() => {}}
				placeholder="Select a permission…"
			/>,
		);
		expect(unnamedControls(container)).toEqual([]);
		expect(
			screen.getByRole("button", {
				name: "Select a permission: Kubernetes read",
			}),
		).toBeInTheDocument();
	});
});

describe("the settings field primitive", () => {
	it("lets an explicit name win, and never sets both naming attributes", () => {
		// `aria-labelledby` beats `aria-label` in the accname algorithm, so a select that carried
		// both would silently discard the explicit one — which is what the two `access-manager` call
		// sites pass, from OUTSIDE a `SettingsField`.
		render(
			<SettingsField label="Data region">
				<SettingsSelect
					aria-label="Role"
					value="admin"
					onChange={() => {}}
					options={[{ value: "admin", label: "Administrator" }]}
				/>
			</SettingsField>,
		);
		const trigger = screen.getByRole("combobox", { name: "Role" });
		expect(trigger).not.toHaveAttribute("aria-labelledby");
	});

	it("names a select that is not inside a field row from its own label", () => {
		const { container } = render(
			<SettingsSelect
				aria-label="Scope"
				value="org"
				onChange={() => {}}
				options={[{ value: "org", label: "Organization" }]}
			/>,
		);
		expect(unnamedControls(container)).toEqual([]);
		expect(screen.getByRole("combobox", { name: "Scope" })).toBeInTheDocument();
	});
});

// The inspector's generic field renderer. Rendered through `ConfigFields` rather than through its
// inner controls, because the label→control binding it is being asked about is a property of the
// COMPOSITION: `FieldRow` mints the id and renders the `<Label htmlFor>`, `FieldControl` forwards
// it, and the control has to accept it. `RegionSelect` accepted no id at all before #3756, so its
// label pointed at nothing and the trigger was unnamed — a defect invisible to any test that
// rendered `RegionSelect` and its label together by hand.
const INSPECTOR_SCHEMA: KindConfig = {
	sections: [
		{
			id: "essentials",
			title: "Essentials",
			defaultOpen: true,
			fields: [
				{ key: "name", type: "text", label: "Name" },
				{ key: "count", type: "number", label: "Count", min: 1 },
				{
					key: "engine",
					type: "select",
					label: "Engine",
					options: [
						{ value: "postgres", label: "PostgreSQL" },
						{ value: "mysql", label: "MySQL" },
					],
				},
				{
					key: "instance_class",
					type: "combobox",
					label: "Instance class",
					options: [{ value: "db.t4g.micro", label: "db.t4g.micro" }],
					mono: true,
				},
				{ key: "region", type: "region", label: "Region" },
				{ key: "repository", type: "repository", label: "Repository" },
				{ key: "public", type: "switch", label: "Publicly reachable" },
				{
					key: "tier",
					type: "radio-card",
					label: "Tier",
					options: [
						{ value: "dev", label: "Development" },
						{ value: "prod", label: "Production" },
					],
				},
				{ key: "cidrs", type: "list", label: "Allowed CIDRs" },
			],
		},
	],
	summary: () => "",
};

describe("canvas inspector — accessible names", () => {
	it("names every control the generic field renderer produces", async () => {
		const { container } = render(
			<ConfigFields
				schema={INSPECTOR_SCHEMA}
				config={{ name: "db", count: 1, engine: "postgres", region: "eu-west-1" }}
				provider="aws"
				onChange={() => {}}
			/>,
		);
		await screen.findByRole("combobox", { name: "Git provider: github" });
		expect(container.querySelectorAll(NAME_REQUIRED).length).toBeGreaterThan(0);
		expect(unnamedControls(container)).toEqual([]);
	});

	it("names the region trigger and the suggest input from their <Label htmlFor>", async () => {
		render(
			<ConfigFields
				schema={INSPECTOR_SCHEMA}
				config={{ name: "db", count: 1, engine: "postgres", region: "eu-west-1" }}
				provider="aws"
				onChange={() => {}}
			/>,
		);
		// `<button>` and `<input>` are both labelable elements, so a real `<Label htmlFor>` names
		// them whatever ARIA role they carry. This is the assertion behind leaving
		// `OptionCombobox`'s `role="combobox"` alone: the name is already right, and the role is
		// true of a text input with a suggestion list.
		expect(
			await screen.findByRole("combobox", { name: "Region" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("combobox", { name: "Instance class" }),
		).toBeInTheDocument();
		expect(screen.getByRole("combobox", { name: "Engine" })).toBeInTheDocument();
	});
});
