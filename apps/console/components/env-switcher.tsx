"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Check, Plus } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import {
	getEnvironmentsForSlug,
	type SwitcherEnv,
} from "@/app/server/actions/resolve";
import { NewEnvironmentDialog } from "@/components/environments/new-environment-dialog";
import { SwitcherTrigger } from "@/components/shell/switcher-trigger";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
	CommandSeparator,
} from "@repo/ui/command";
import { Popover, PopoverContent } from "@repo/ui/popover";

/**
 * Header environment switcher — the Vercel combobox after org + project. Lists the current
 * project's environments (name + a check on the active one), switches the active env via the
 * `?environment_id=` query param, and hosts the "New Environment" dialog. Only renders on a project
 * drilldown route (`/{org}/{project}`); hidden on `/dashboard/*`, the `~` org-global tree, and
 * the bare org overview.
 */
export function EnvSwitcher() {
	const router = useRouter();
	const pathname = usePathname();
	const searchParams = useSearchParams();
	const [open, setOpen] = useState(false);
	const [createOpen, setCreateOpen] = useState(false);
	const [envs, setEnvs] = useState<SwitcherEnv[]>([]);

	// Parse `/{org}/{project}` — never the legacy /dashboard or `~` global tree. The active
	// environment lives in the `?environment_id=` query param, so switching envs keeps the current
	// project view (architecture / jobs / …) and just swaps the id.
	const segs = pathname.split("/").filter(Boolean);
	const isDrilldown =
		segs[0] !== "dashboard" && segs[1] !== "~" && segs.length >= 2;
	const [, project] = segs;
	const envId = searchParams.get("environment_id") ?? undefined;

	/** The current view with a different active environment — preserves the path, swaps the id. */
	const envUrl = (id: string) =>
		`${pathname}?environment_id=${encodeURIComponent(id)}`;

	/** Fetches the project's environments (never throws — resolves to [] on failure). */
	const loadEnvs = useCallback(
		() => getEnvironmentsForSlug(project).catch(() => Array<SwitcherEnv>()),
		[project],
	);

	useEffect(() => {
		if (!isDrilldown) return;
		let live = true;
		loadEnvs().then((rows) => {
			if (live) setEnvs(rows);
		});
		return () => {
			live = false;
		};
	}, [isDrilldown, loadEnvs]);

	// Shift+Tab cycles environments for fast switching (skips while typing in a field so
	// normal reverse-tab focus still works).
	useEffect(() => {
		if (!isDrilldown || envs.length < 2) return;
		const onKey = (e: KeyboardEvent) => {
			const t = e.target instanceof HTMLElement ? e.target : null;
			const typing =
				!!t &&
				(t.tagName === "INPUT" ||
					t.tagName === "TEXTAREA" ||
					t.tagName === "SELECT" ||
					t.isContentEditable);
			if (typing) return;
			if (e.key !== "Tab" || !e.shiftKey) return;
			e.preventDefault();
			const current =
				envs.find((x) => x.id === envId) ??
				envs.find((x) => x.is_default) ??
				envs[0];
			const idx = envs.findIndex((x) => x.id === current.id);
			const next = envs[(idx + 1) % envs.length];
			router.push(`${pathname}?environment_id=${encodeURIComponent(next.id)}`);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [isDrilldown, envs, envId, pathname, router]);

	if (!isDrilldown || envs.length === 0) return null;

	const active =
		envs.find((e) => e.id === envId) ??
		envs.find((e) => e.is_default) ??
		envs[0];

	const handleSelect = (id: string) => {
		setOpen(false);
		router.push(envUrl(id));
	};

	/** After creating an env: refresh the list and switch to the new env in the current view. */
	const handleCreated = async (name: string) => {
		const rows = await loadEnvs();
		setEnvs(rows);
		const created = rows.find((e) => e.name === name);
		if (created) router.push(envUrl(created.id));
	};

	return (
		<>
			<span className="text-border/70 select-none" aria-hidden>
				/
			</span>
			<Popover open={open} onOpenChange={setOpen}>
				<SwitcherTrigger
					variant="topbar"
					open={open}
					ariaLabel="Switch environment"
					label={active?.name ?? ""}
				/>
				<PopoverContent className="w-64 p-0" align="start">
					<Command>
						<CommandInput placeholder="Find environment…" className="h-9" />
						<CommandList>
							<CommandEmpty>No environment found.</CommandEmpty>
							<CommandGroup heading="Environments">
								{envs.map((e) => (
									<CommandItem
										key={e.id}
										value={e.name}
										onSelect={() => handleSelect(e.id)}
										className="gap-2"
									>
										<span className="flex-1 truncate">{e.name}</span>
										{e.id === active?.id && (
											<Check className="h-4 w-4 shrink-0" />
										)}
									</CommandItem>
								))}
							</CommandGroup>
							<CommandSeparator />
							<CommandGroup>
								<CommandItem
									value="__new-environment"
									onSelect={() => {
										setOpen(false);
										setCreateOpen(true);
									}}
									className="gap-2 text-muted-foreground"
								>
									<Plus className="h-4 w-4 shrink-0" />
									<span className="flex-1">New Environment</span>
								</CommandItem>
							</CommandGroup>
						</CommandList>
					</Command>
				</PopoverContent>
			</Popover>

			<NewEnvironmentDialog
				open={createOpen}
				onOpenChange={setCreateOpen}
				projectId={envs[0]?.project_id ?? ""}
				envs={envs}
				onCreated={handleCreated}
			/>
		</>
	);
}
