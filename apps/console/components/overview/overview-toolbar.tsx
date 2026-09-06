"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Overview toolbar — a tight search that claims the row, a single funnel button whose popover
// collapses the cloud + repository filters and the sort order (Activity / Name), then the
// card/table view toggle and a Create menu. All state is owned by the page (URL search params) —
// the console filter standard's blessed URL→RSC variant — so this component only emits `onChange`.

import { lookup } from "@/lib/typed-object";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  Activity,
  ArrowDownAZ,
  ArrowLeft,
  Check,
  ChevronRight,
  Cloud,
  Filter,
  GitBranch,
  Plus,
} from "lucide-react";
import { Button } from "@repo/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@repo/ui/dropdown-menu";
import { FilterBar } from "@repo/ui/filter-bar";
import { FilterSearch } from "@repo/ui/filter-search";
import { Input } from "@repo/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@repo/ui/popover";
import { ProviderIcon, PROVIDER_LABELS } from "@repo/ui/provider-icon";
import { Separator } from "@repo/ui/separator";
import { cn } from "@repo/ui/utils";
import { ViewToggle } from "@repo/ui/view-toggle";
import type { ProjectListResult } from "@/app/server/actions/projects";
import { getCollaborationAccess } from "@/app/server/actions/billing";
import { InviteMemberDialog } from "@/components/settings/members/invite-member-dialog";
import { UpgradeDialog } from "@/components/settings/upgrade/upgrade-dialog";
import { countActiveFilters } from "@/lib/stores/create-filter-store";
import { globalHref } from "@/lib/routing";
import type { OverviewState } from "@/app/(private)/[org]/overview-client";

/** Human label for a cloud provider slug (shared vocabulary, uppercase fallback). */
function providerLabel(p: string): string {
  return lookup(PROVIDER_LABELS, p) ?? p.toUpperCase();
}

/** The filter dims Reset clears (view + sort are not filters, so they don't count). */
const FILTER_DEFAULTS = {
  q: "",
  clouds: Array<string>(),
  repos: Array<string>(),
};

export function OverviewToolbar({
  orgSlug,
  state,
  facets,
  onChange,
}: {
  orgSlug: string;
  state: OverviewState;
  facets: ProjectListResult["facets"];
  onChange: (next: Partial<OverviewState>) => void;
}) {
  // Local, immediate draft for the search box; the URL (server query) updates on a debounce.
  const [draft, setDraft] = useState(state.q);
  // Adopt an external change to the query (e.g. a Reset, or navigation) into the draft —
  // React's "adjust state during render" pattern, so it stays in sync without an effect.
  const [syncedQ, setSyncedQ] = useState(state.q);
  if (state.q !== syncedQ) {
    setSyncedQ(state.q);
    setDraft(state.q);
  }
  useEffect(() => {
    if (draft === state.q) return;
    const id = setTimeout(() => onChange({ q: draft }), 300);
    return () => clearTimeout(id);
  }, [draft, state.q, onChange]);

  return (
    <FilterBar
      end={
        <div className="flex items-center gap-2.5">
          <ViewToggle
            value={state.view}
            onChange={(view) => onChange({ view })}
          />
          <CreateMenu orgSlug={orgSlug} />
        </div>
      }
    >
      <FilterSearch
        value={draft}
        onChange={setDraft}
        placeholder="Search projects…"
        ariaLabel="Search projects"
        className="min-w-[200px] flex-1"
      />
      <FilterMenu state={state} facets={facets} onChange={onChange} />
    </FilterBar>
  );
}

/**
 * The single funnel popover: repository + cloud facets (each expands into its own search on click,
 * so the popover stays uncluttered) and the sort order as a right-checked list. The trigger carries
 * a count badge of the active facet selections.
 */
function FilterMenu({
  state,
  facets,
  onChange,
}: {
  state: OverviewState;
  facets: ProjectListResult["facets"];
  onChange: (next: Partial<OverviewState>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState<"root" | "cloud" | "repo">("root");
  const [search, setSearch] = useState("");

  // Open/close the popover, resetting back to the root panel on close.
  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setPanel("root");
      setSearch("");
    }
  };

  const badge = state.clouds.length + state.repos.length;
  const resetCount = countActiveFilters(
    { q: state.q, clouds: state.clouds, repos: state.repos },
    FILTER_DEFAULTS,
  );

  const toggle = (list: string[], value: string): string[] =>
    list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

  const q = search.trim().toLowerCase();
  const clouds = facets.clouds.filter((c) =>
    providerLabel(c.value).toLowerCase().includes(q),
  );
  const repos = facets.repos.filter((r) => r.label.toLowerCase().includes(q));

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            size="icon"
            className="relative"
            aria-label="Filter and sort"
          >
            <Filter className="size-4" />
            {badge > 0 && (
              <span className="absolute -right-1.5 -top-1.5 grid h-4 min-w-4 place-items-center rounded-full border-2 border-background bg-foreground px-1 font-mono text-ui-3xs font-semibold text-background">
                {badge}
              </span>
            )}
          </Button>
        }
      />
      <PopoverContent align="end" className="w-72 p-2">
        {panel === "root" && (
          <div className="flex flex-col">
            <Eyebrow>Filter by</Eyebrow>
            <FacetRow
              icon={<GitBranch className="size-3.5" />}
              label="Repository"
              count={state.repos.length}
              disabled={facets.repos.length === 0}
              onClick={() => {
                setSearch("");
                setPanel("repo");
              }}
            />
            <FacetRow
              icon={<Cloud className="size-3.5" />}
              label="Cloud"
              count={state.clouds.length}
              disabled={facets.clouds.length === 0}
              onClick={() => {
                setSearch("");
                setPanel("cloud");
              }}
            />

            <Separator className="my-2" />

            <Eyebrow>Sort by</Eyebrow>
            <SortRow
              icon={<Activity className="size-3.5" />}
              label="Activity"
              active={state.sort === "activity"}
              onClick={() => onChange({ sort: "activity" })}
            />
            <SortRow
              icon={<ArrowDownAZ className="size-3.5" />}
              label="Name"
              active={state.sort === "name"}
              onClick={() => onChange({ sort: "name" })}
            />

            {resetCount > 0 && (
              <div className="mt-1 flex justify-end pt-1">
                <button
                  type="button"
                  onClick={() => onChange({ q: "", clouds: [], repos: [] })}
                  className="font-mono text-ui-2xs text-muted-foreground transition-colors hover:text-foreground"
                >
                  Reset · {resetCount}
                </button>
              </div>
            )}
          </div>
        )}

        {panel === "cloud" && (
          <FacetPanel
            title="Cloud"
            placeholder="Search clouds…"
            search={search}
            onSearch={setSearch}
            onBack={() => setPanel("root")}
            empty={clouds.length === 0}
          >
            {clouds.map((c) => (
              <FacetOption
                key={c.value}
                selected={state.clouds.includes(c.value)}
                onClick={() =>
                  onChange({ clouds: toggle(state.clouds, c.value) })
                }
                leading={
                  <ProviderIcon provider={c.value} size={14} mono={false} />
                }
                label={providerLabel(c.value)}
                hint={String(c.count)}
              />
            ))}
          </FacetPanel>
        )}

        {panel === "repo" && (
          <FacetPanel
            title="Repository"
            placeholder="Search repositories…"
            search={search}
            onSearch={setSearch}
            onBack={() => setPanel("root")}
            empty={repos.length === 0}
          >
            {repos.map((r) => (
              <FacetOption
                key={r.url}
                selected={state.repos.includes(r.url)}
                onClick={() => onChange({ repos: toggle(state.repos, r.url) })}
                leading={
                  <GitBranch className="size-3.5 text-muted-foreground" />
                }
                label={r.label}
                mono
                hint={String(r.count)}
              />
            ))}
          </FacetPanel>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** A mono uppercase section marker inside the filter popover. */
function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-1.5 pb-1 pt-1 font-mono text-ui-3xs uppercase tracking-wider text-muted-foreground">
      {children}
    </div>
  );
}

/** A root-panel facet row that drills into its own searchable selector. */
function FacetRow({
  icon,
  label,
  count,
  disabled,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  count: number;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex h-8 items-center gap-2 rounded-sm px-1.5 text-ui-md text-foreground transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-40"
    >
      <span className="text-muted-foreground">{icon}</span>
      <span className="flex-1 text-left">{label}</span>
      {count > 0 && (
        <span className="font-mono text-ui-2xs text-muted-foreground">
          {count}
        </span>
      )}
      <ChevronRight className="size-3.5 text-muted-foreground" />
    </button>
  );
}

/** A sort option — right-checked (radio semantics), matching the console picker convention. */
function SortRow({
  icon,
  label,
  active,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className="flex h-8 items-center gap-2 rounded-sm px-1.5 text-ui-md text-foreground transition-colors hover:bg-muted"
    >
      <span className="text-muted-foreground">{icon}</span>
      <span className="flex-1 text-left">{label}</span>
      <Check className={cn("size-3.5", active ? "opacity-100" : "opacity-0")} />
    </button>
  );
}

/** Level-2 chrome: a back header, a search box, and the scrollable option list. */
function FacetPanel({
  title,
  placeholder,
  search,
  onSearch,
  onBack,
  empty,
  children,
}: {
  title: string;
  placeholder: string;
  search: string;
  onSearch: (v: string) => void;
  onBack: () => void;
  empty: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={onBack}
        className="mb-1 flex h-7 items-center gap-1.5 rounded-sm px-1 text-ui-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" />
        {title}
      </button>
      <Input
        value={search}
        onChange={(e) => onSearch(e.target.value)}
        placeholder={placeholder}
        className="mb-1.5 h-8"
        autoFocus
      />
      <div className="max-h-56 overflow-y-auto">
        {empty ? (
          <p className="px-1.5 py-4 text-center text-ui-sm text-muted-foreground">
            No matches.
          </p>
        ) : (
          children
        )}
      </div>
    </div>
  );
}

/** A selectable facet option with a right-aligned check when active. */
function FacetOption({
  selected,
  onClick,
  leading,
  label,
  hint,
  mono,
}: {
  selected: boolean;
  onClick: () => void;
  leading: React.ReactNode;
  label: string;
  hint?: string;
  mono?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-sm px-1.5 py-1.5 text-left text-ui-md text-foreground transition-colors hover:bg-muted"
    >
      <span className="grid size-4 shrink-0 place-items-center">{leading}</span>
      <span
        className={cn(
          "min-w-0 flex-1 truncate",
          mono && "font-mono text-ui-sm",
        )}
      >
        {label}
      </span>
      {hint && (
        <span className="font-mono text-ui-2xs text-muted-foreground">
          {hint}
        </span>
      )}
      <Check
        className={cn("size-3.5", selected ? "opacity-100" : "opacity-0")}
      />
    </button>
  );
}

/** "Create" menu — three plain actions: Project, Cloud, Org member. */
function CreateMenu({ orgSlug }: { orgSlug: string }) {
  const router = useRouter();
  // Invite is gated (card-backed/paid org): open the invite dialog when allowed, else the
  // upsell — mirroring the members table. Dialogs render outside the menu so they survive it
  // closing.
  const [inviteOpen, setInviteOpen] = useState(false);
  const [upsellOpen, setUpsellOpen] = useState(false);
  const [canInvite, setCanInvite] = useState(false);

  useEffect(() => {
    let alive = true;
    getCollaborationAccess()
      .then((a) => alive && setCanInvite(a.canInvite))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button size="default" className="gap-1.5">
              <Plus className="h-4 w-4" />
              Create
            </Button>
          }
        />
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuLabel className="font-mono text-ui-3xs uppercase tracking-wider text-muted-foreground">
            Create
          </DropdownMenuLabel>
          <DropdownMenuItem
            onSelect={() => router.push(globalHref(orgSlug, "new"))}
          >
            Project
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() =>
              router.push(`${globalHref(orgSlug, "connectors")}?type=cloud`)
            }
          >
            Cloud
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() =>
              canInvite ? setInviteOpen(true) : setUpsellOpen(true)
            }
          >
            Org member
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Controlled, trigger-less — opened from the "Org member" item above. */}
      <InviteMemberDialog open={inviteOpen} onOpenChange={setInviteOpen} />
      <UpgradeDialog
        feature="invite"
        open={upsellOpen}
        onOpenChange={setUpsellOpen}
      />
    </>
  );
}
