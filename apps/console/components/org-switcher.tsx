"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Check, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { CreateOrgSheet } from "@/components/org/create-org-sheet";
import { OrgAvatar } from "@/components/org/org-avatar";
import { SwitcherTrigger } from "@/components/shell/switcher-trigger";
import { Badge } from "@repo/ui/badge";
import { Button } from "@repo/ui/button";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@repo/ui/command";
import { Popover, PopoverContent } from "@repo/ui/popover";
import { Separator } from "@repo/ui/separator";
import { planMeta } from "@repo/plan-catalog";
import {
	useActiveOrgSlug,
	useWorkspaceStore,
} from "@/lib/stores/use-workspace-store";
import { orgHref } from "@/lib/routing";

/**
 * Header organization switcher (Vercel-style). Lists the organizations the user
 * belongs to with their plan, marks the active one (which re-scopes the PDP + RLS on
 * switch), and offers a pinned "Create organization" action — always available, since
 * creating an org is the pay-to-collaborate path. The personal scope shows as
 * "Personal" (Free). "Create" opens the create sheet (name → pay → invite). The trigger is a
 * split button: clicking the org name/avatar navigates to the org home, only the chevron opens
 * the switcher.
 */
/**
 * Where choosing `orgId` should navigate to, or null when there is nowhere to go.
 *
 * A pure function because the decision is the testable half and the dropdown is not: the switcher's
 * menu renders through a portal that needs layout, which jsdom does not have, so a component test
 * can click the trigger and never see the item. This keeps the part #4133 depends on — that a
 * switch produces the TARGET org's url and not a refresh of the one being left — pinned at unit
 * speed, and leaves only the two-line `push`/`refresh` wiring to the e2e path.
 *
 * ⚠ It can only be as good as the slug it is given. `getWorkspaceContext` substitutes the reserved
 * personal segment for an org whose `slug` column is null (`organization.slug` is nullable), so a
 * slug-less TEAM org arrives here indistinguishable from the personal one and this would navigate
 * to `/~` while `switchOrg` has already written the session to that team. The substitution is the
 * defect and it is upstream of this file; nothing here can tell the two apart.
 */
export function switchTargetHref(
	// `slug: string | null`, not `string`: #4134 made `WorkspaceOrg.slug` nullable so a slugless org
	// stops impersonating the personal workspace. A `string` parameter here would not type-check
	// against the store's own value, and the `slug ?` guard below already answers the null case.
	organizations: readonly { id: string; slug: string | null }[],
	orgId: string,
): string | null {
	const slug = organizations.find((o) => o.id === orgId)?.slug;
	return slug ? orgHref(slug) : null;
}

export function OrgSwitcher() {
	const router = useRouter();
	const orgSlug = useActiveOrgSlug();
	const [open, setOpen] = useState(false);
	const [createOpen, setCreateOpen] = useState(false);
	const { activeOrgId, organizations, fetchWorkspace } = useWorkspaceStore();

	useEffect(() => {
		fetchWorkspace();
	}, [fetchWorkspace]);

	const active =
		organizations.find((o) => o.id === activeOrgId) ?? organizations[0] ?? null;
	const meta = planMeta(active?.plan ?? "community");

	const handleSelect = (orgId: string) => {
		setOpen(false);
		if (orgId === activeOrgId) return;
		// The extracted, TESTED helper from this branch (tests/components/org-switcher-target.test.ts),
		// kept over the inline lookup that #4134 landed — same answer, and this one is reachable from
		// a test without mounting the component.
		const target = switchTargetHref(organizations, orgId);
		// NO `~` FALLBACK, AND NO REFRESH FALLBACK. `organizations.slug` is `text().unique()` with no
		// notNull, so a real org can have none, and `getWorkspaceContext` used to alias that onto `~`
		// — two layers agreeing to call a real org the personal workspace, so picking it navigated to
		// a different tenant silently. #4134 removed both halves; `WorkspaceOrg.slug` is
		// `string | null` now and reports the truth.
		//
		// This branch originally answered a null target with `router.refresh()`. That is the same bug
		// from the other side: a refresh re-resolves the tenant from the URL being LEFT, so the chip
		// would read the new org while every server read stayed on the old one. Refusing to move is
		// the only honest branch — not moving beats moving somewhere else. The list renders such an
		// org disabled, so this is the second line of defence rather than the first.
		if (!target) return;
		// NAVIGATE, and do NOT persist the session first. The `{org}` URL segment is what scopes the
		// request — `[org]/layout.tsx` calls `resolveOrgScope`, which itself calls
		// `setActiveOrganization` — so the destination writes the session.
		//
		// The `await switchOrg(orgId)` this branch had here persisted the session to the TARGET org
		// BEFORE navigating, so every server action, in-flight refetch and prefetch still running on
		// the CURRENT page executed under an org its URL did not name — the exact
		// session-disagrees-with-URL window both #4133 and #4134 exist to close. #4134 removed it and
		// it is not reinstated here; `switchOrg` is no longer destructured in this component.
		router.push(target);
	};

	const startCreate = () => {
		setOpen(false);
		setCreateOpen(true);
	};

	return (
		<>
			<Popover open={open} onOpenChange={setOpen}>
				<SwitcherTrigger
					variant="sidebar"
					open={open}
					href={orgHref(orgSlug)}
					ariaLabel="Switch organization"
					leading={
						<OrgAvatar
							name={active?.name ?? "Personal"}
							logo={active?.logo}
							size={24}
							className="rounded-full"
						/>
					}
					label={active?.name ?? "Personal"}
					badge={
						<span className="shrink-0 rounded-full border px-1.5 py-px font-mono text-ui-3xs uppercase tracking-wide text-muted-foreground">
							{meta.name}
						</span>
					}
				/>
				<PopoverContent className="w-72 p-0" align="start">
					<Command>
						<CommandInput placeholder="Find organization…" className="h-9" />
						<CommandList>
							<CommandEmpty>No organization found.</CommandEmpty>
							<CommandGroup heading="Organizations">
								{organizations.map((o) => {
									const meta = planMeta(o.plan);
									return (
										<CommandItem
											key={o.id}
											value={o.name}
											// An org with no slug has no URL to navigate to — see handleSelect.
											// Disabled rather than hidden: a workspace the user belongs to that
											// silently vanished from the switcher is harder to report than one
											// that is visibly not selectable.
											disabled={!o.slug}
											onSelect={() => handleSelect(o.id)}
											className="gap-2"
										>
											<OrgAvatar
												name={o.name}
												logo={o.logo}
												size={20}
												className="rounded-full"
											/>
											<span className="flex-1 truncate">{o.name}</span>
											{o.status === "trialing" && (
								<Badge className="bg-ink px-1.5 text-ui-3xs font-medium uppercase tracking-wide text-ink-foreground">
													Trial
												</Badge>
											)}
											<Badge
												variant="outline"
									className="text-ui-2xs font-normal text-muted-foreground"
											>
												{meta.name}
											</Badge>
											{o.id === active?.id && (
												<Check className="h-4 w-4 shrink-0" />
											)}
										</CommandItem>
									);
								})}
							</CommandGroup>
						</CommandList>
						<Separator />
						{/* Pinned footer — outside CommandList so search never hides it. */}
						<div className="p-1">
							<Button
								variant="ghost"
								onClick={startCreate}
								className="h-auto w-full justify-start gap-2 whitespace-normal px-2 py-2 text-left"
							>
								<Plus className="h-4 w-4 shrink-0 text-muted-foreground" />
								<span className="flex min-w-0 flex-col">
									<span className="text-sm font-medium">Create organization</span>
									<span className="text-xs text-muted-foreground">
										Collaborate with others in a shared organization
									</span>
								</span>
							</Button>
						</div>
					</Command>
				</PopoverContent>
			</Popover>

			<CreateOrgSheet open={createOpen} onOpenChange={setCreateOpen} />
		</>
	);
}
