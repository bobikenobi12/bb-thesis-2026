"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Settings · Access — an inheritance info-note, a stat strip (Grants / Org-wide /
// Project-scoped), a toolbar (search · scope filter · Add grant), an inline
// grant builder with a live preview, and the grants table on the shared DataTable
// (sortable + paginated). Wired to grants.ts (listAccessGrants / getGrantOptions /
// assignGrant / revokeGrant). The page header lives in the settings shell; without the
// Enterprise `customRoles` entitlement the surface stays visible and shows the upsell.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { Info, Layers, MoreHorizontal, Plus, Shield, ShieldAlert } from "lucide-react";
import { useParams } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  type AccessGrantRow,
  assignGrant,
  getGrantOptions,
  type GrantOptions,
  listAccessGrants,
  revokeGrant,
} from "@/app/server/actions/grants";
import { lookup } from "@/lib/typed-object";
import { DataTable } from "@/components/data-table";
import { useEntitlement } from "@/components/settings/enterprise-gate";
import { FeatureUpsell } from "@/components/settings/upgrade/feature-upsell";
// `SettingsSelect` survives here as a FORM control inside the grant builder. The console
// filter standard bans Radix Selects from FILTER BARS, where a multi-select facet is the
// right shape; picking one role to grant is a single-choice form field, which is what a
// Select is for. The toolbar's old "All scopes" Select is gone.
import { SettingsSelect } from "@/components/settings/settings-ui";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useFilterUrlSync } from "@/hooks/use-filter-url-sync";
import { qk } from "@/lib/query/keys";
import { countActiveFilters } from "@/lib/stores/create-filter-store";
import { useAccessFilters } from "@/lib/stores/use-settings-filters";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@repo/ui/alert-dialog";
import { Button } from "@repo/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@repo/ui/dropdown-menu";
import { EmptyState } from "@repo/ui/empty";
import { FacetFilter } from "@repo/ui/facet-filter";
import { FilterBar, FilterBarReset } from "@repo/ui/filter-bar";
import { FilterSearch } from "@repo/ui/filter-search";
import { formatRelative } from "@repo/format";
import { MultiCombobox } from "@repo/ui/multi-combobox";
import { PageToolbar } from "@repo/ui/page-toolbar";
import { Skeleton } from "@repo/ui/skeleton";
import { StatusBadge } from "@repo/ui/status-badge";
import { cn } from "@repo/ui/utils";
import { userInitials } from "@/lib/user-display";
import {
  accessFacetCounts,
  DEFAULT_ACCESS_FILTERS,
  EFFECT_OPTIONS,
  filterGrants,
  grantRoleLabel,
  normalizeAccessQuery,
  reachLabel,
  SCOPE_LEVEL,
} from "./access-filters";
import { Combobox } from "./combobox";

const SCOPE_OPTIONS = [
  { value: "org", label: "Entire organization" },
  { value: "project", label: "A Project" },
  { value: "runner", label: "A runner" },
  { value: "cloud_identity", label: "A cloud identity" },
];

/**
 * The Access surface. When `projectId` is given the grants list, stats, and grant builder are scoped
 * to that single project (project-scoped Settings › Access); without it, the full org grants render.
 */
export function AccessManager({ projectId }: { projectId?: string } = {}) {
  const entitled = useEntitlement("customRoles");
  const { org } = useParams<{ org: string }>();
  const qc = useQueryClient();

  // Filter state: the store is the source of truth, the URL mirrors it (shareable views),
  // and the free text is DEBOUNCED — this surface had none, so every keystroke re-ran the
  // whole predicate. Fifteen `useState` calls collapse to one store plus two dialog flags.
  const filters = useAccessFilters((s) => s.filters);
  const set = useAccessFilters((s) => s.set);
  const reset = useAccessFilters((s) => s.reset);
  useFilterUrlSync(useAccessFilters, DEFAULT_ACCESS_FILTERS);
  const search = useDebouncedValue(filters.search);
  const query = useMemo(
    () => normalizeAccessQuery(filters, search, projectId),
    [filters, search, projectId],
  );

  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<AccessGrantRow | null>(null);

  // Custom-scoped grants are Enterprise. Without the entitlement the server rejects these
  // (requireAccessAdmin), so both queries stay disabled and the upsell renders instead.
  //
  // The key carries only `projectId` — the one axis `listAccessGrants` understands — so the
  // fetched rows are the UNFILTERED universe for this scope, which is what the facet counts
  // below must be computed over.
  const grantsQuery = useQuery({
    queryKey: qk.accessGrants(org, projectId ? { projectId } : undefined),
    queryFn: () => listAccessGrants(projectId),
    enabled: entitled,
  });
  const optionsQuery = useQuery({
    queryKey: ["access", "grant-options", org] as const,
    queryFn: () => getGrantOptions(),
    enabled: entitled,
    staleTime: 60_000,
  });
  const options: GrantOptions | null = optionsQuery.data ?? null;

  const invalidate = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ["access", "grants", org] });
    void qc.invalidateQueries({ queryKey: ["access", "grant-options", org] });
  }, [qc, org]);

  // Resolve a scoped resource id → a friendly label via the option lists.
  const resourceLabel = useMemo(() => {
    const map = new Map<string, string>();
    if (options) {
      for (const [type, list] of Object.entries(options.resources)) {
        for (const r of list) map.set(`${type}:${r.id}`, r.label);
      }
    }
    return (type: string, id: string | null) =>
      id ? (map.get(`${type}:${id}`) ?? `${id.slice(0, 8)}…`) : "—";
  }, [options]);

  const revoke = async (g: AccessGrantRow) => {
    try {
      await revokeGrant(g.id);
      toast.success("Access revoked");
      setDeleting(null);
      invalidate();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't revoke access");
    }
  };

  const all = useMemo(() => grantsQuery.data ?? [], [grantsQuery.data]);
  /** The label the Scope column shows — the search must match what the row displays. */
  const scopeLabel = useCallback(
    (g: AccessGrantRow) =>
      g.resourceType === "org"
        ? "organization"
        : resourceLabel(g.resourceType, g.resourceId),
    [resourceLabel],
  );
  const filtered = useMemo(
    () => filterGrants(all, query, scopeLabel),
    [all, query, scopeLabel],
  );
  const counts = useMemo(() => accessFacetCounts(all), [all]);
  const activeFilters = countActiveFilters(filters, DEFAULT_ACCESS_FILTERS);

  const columns = useMemo<ColumnDef<AccessGrantRow>[]>(
    () => [
      {
        id: "principal",
        header: "Principal",
        enableSorting: false,
        cell: ({ row }) => {
          const g = row.original;
          return (
            <div className="flex items-center gap-2.5">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-full border bg-muted font-mono text-ui-xs text-muted-foreground">
                {userInitials({ name: g.principalLabel })}
              </span>
              <div className="flex min-w-0 flex-col">
                <span className="truncate text-foreground">
                  {g.principalLabel}
                </span>
                <span className="font-mono text-ui-2xs uppercase tracking-wide text-muted-foreground">
                  {g.principalType === "team" ? "Team" : "Member"}
                </span>
              </div>
            </div>
          );
        },
      },
      {
        id: "role",
        header: "Role",
        enableSorting: false,
        cell: ({ row }) => {
          const g = row.original;
          return (
            <div className="flex items-center gap-2">
              {g.roleName ? (
                <span className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium capitalize text-foreground">
                  <Shield size={12} className="text-muted-foreground" />
                  {g.roleName}
                </span>
              ) : (
                <code className="font-mono text-xs text-foreground">
                  {g.permissionKey ?? "—"}
                </code>
              )}
              {/* A deny is the one thing on this row that changes its meaning, so it reads
                  through the SHARED status device rather than a local pill. */}
              {g.effect === "deny" && (
                <StatusBadge status="deny" tier="failed" label="Deny" />
              )}
            </div>
          );
        },
      },
      {
        id: "scope",
        header: "Scope",
        enableSorting: false,
        cell: ({ row }) => {
          const g = row.original;
          return (
            <div className="flex flex-col">
              <span className="text-foreground">
                {g.resourceType === "org"
                  ? "Organization"
                  : resourceLabel(g.resourceType, g.resourceId)}
              </span>
              <span className="font-mono text-ui-2xs uppercase tracking-wide text-muted-foreground">
                {SCOPE_LEVEL[g.resourceType] ?? g.resourceType}
              </span>
            </div>
          );
        },
      },
      {
        id: "reach",
        header: "Effective reach",
        enableSorting: false,
        cell: ({ row }) => (
          <span className="whitespace-nowrap font-mono text-xs text-muted-foreground">
            {reachLabel(row.original.resourceType)}
          </span>
        ),
      },
      {
        accessorKey: "createdAt",
        header: "Granted",
        cell: ({ row }) => (
          <span className="whitespace-nowrap font-mono text-xs text-muted-foreground">
            {formatRelative(row.original.createdAt)}
          </span>
        ),
      },
      {
        id: "actions",
        header: "",
        enableSorting: false,
        cell: ({ row }) => (
          <div className="text-right">
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    aria-label="Manage grant"
                  >
                    <MoreHorizontal size={16} />
                  </Button>
                }
              />
              <DropdownMenuContent align="end" className="w-40">
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  onClick={() => setDeleting(row.original)}
                >
                  Revoke access
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ),
      },
    ],
    [resourceLabel],
  );

  return (
    <div>
      {/* inheritance note */}
      <div className="mb-[18px] flex gap-3 rounded-lg border border-border bg-surface-sunken p-4">
        <Info size={16} className="mt-0.5 shrink-0 text-text-tertiary" />
        <p className="text-ui-sm leading-relaxed text-text-secondary">
          {projectId ? (
            <>
              <b className="font-medium text-text-primary">
                Grants on this Project.
              </b>{" "}
              These bind a principal to a role or permission on this Project
              alone. Org-wide grants also apply here but are managed in
              organization settings.
            </>
          ) : (
            <>
              <b className="font-medium text-text-primary">
                Org → Project inheritance.
              </b>{" "}
              A grant on the org applies everywhere; a grant on a single Project
              is exact. Lower scopes can add access, never remove it.
            </>
          )}
        </p>
      </div>

      {!entitled ? (
        <FeatureUpsell feature="access" />
      ) : grantsQuery.isPending ? (
        <div className="space-y-3">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      ) : (
        <>
          <PageToolbar
            className="mb-4"
            description="Who is granted what, and where it applies."
            count={filtered.length}
            actions={
              <Button size="sm" onClick={() => setCreating((v) => !v)}>
                <Plus size={13} />
                Add grant
              </Button>
            }
          />

          <FilterBar>
            <FilterSearch
              value={filters.search}
              onChange={(v) => set("search", v)}
              placeholder="Search principal or scope…"
              className="w-[240px] max-w-[380px] flex-1"
            />
            {/* Scope filter is meaningless when the list is already scoped to one project. */}
            {!projectId && (
              <FacetFilter
                label="Scope"
                icon={Layers}
                options={Object.keys(SCOPE_LEVEL).map((value) => ({
                  value,
                  label: SCOPE_LEVEL[value] ?? value,
                  hint: String(counts.scopes[value] ?? 0),
                }))}
                value={filters.scopes}
                onChange={(next) => set("scopes", next)}
                searchPlaceholder="Filter scope…"
                emptyText="No scopes."
              />
            )}
            {/* Roles are an open-ended entity list (built-ins + every custom role + direct
                permission grants), so this is a searchable MultiCombobox, not a facet popover. */}
            <MultiCombobox
              placeholder="All roles"
              icon={Shield}
              className="w-[190px]"
              options={Object.keys(counts.roles)
                .sort()
                .map((value) => ({
                  value,
                  label: grantRoleLabel(value),
                  hint: String(counts.roles[value] ?? 0),
                }))}
              value={filters.roles}
              onChange={(next) => set("roles", next)}
            />
            <FacetFilter
              label="Effect"
              icon={ShieldAlert}
              options={EFFECT_OPTIONS.map((o) => ({
                value: o.value,
                label: o.label,
                hint: String(counts.effects[o.value] ?? 0),
              }))}
              value={filters.effects}
              onChange={(next) => set("effects", next)}
              searchPlaceholder="Filter effect…"
              emptyText="No effects."
            />
            <FilterBarReset count={activeFilters} onReset={reset} />
          </FilterBar>

          {/* inline grant builder */}
          {creating && options && (
            <GrantBuilder
              options={options}
              resourceLabel={resourceLabel}
              projectId={projectId}
              onCancel={() => setCreating(false)}
              onGranted={() => {
                setCreating(false);
                invalidate();
              }}
            />
          )}

          {filtered.length === 0 ? (
            <EmptyState
              className="border border-border bg-surface-sunken"
              icon={<Shield />}
              title={all.length === 0 ? "No grants yet" : "No matching grants"}
              description={
                all.length === 0
                  ? "Add a grant to bind a member or team to a role."
                  : "No grant matches these filters."
              }
              action={
                all.length === 0 ? undefined : (
                  <Button variant="outline" size="sm" onClick={reset}>
                    Clear filters
                  </Button>
                )
              }
            />
          ) : (
            <DataTable columns={columns} data={filtered} pageSize={15} />
          )}
        </>
      )}

      <AlertDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke this grant?</AlertDialogTitle>
            <AlertDialogDescription>
              The principal loses this access immediately. Inherited access from
              other grants is unaffected. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleting && void revoke(deleting)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Revoke access
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** The inline grant builder — principal · effect · role/permission · scope + live preview. When
 * `projectId` is set the scope is fixed to that project (the picker is hidden). */
function GrantBuilder({
  options,
  resourceLabel,
  projectId,
  onCancel,
  onGranted,
}: {
  options: GrantOptions;
  resourceLabel: (type: string, id: string | null) => string;
  projectId?: string;
  onCancel: () => void;
  onGranted: () => void;
}) {
  const [principalId, setPrincipalId] = useState("");
  const [effect, setEffect] = useState<"allow" | "deny">("allow");
  const [mode, setMode] = useState<"role" | "permission">("role");
  const [roleId, setRoleId] = useState("");
  const [permissionKey, setPermissionKey] = useState("");
  const [scopeType, setScopeType] = useState(projectId ? "project" : "org");
  const [resourceId, setResourceId] = useState(projectId ?? "");
  const [saving, setSaving] = useState(false);

  const principalOpts = options.principals.map((p) => ({
    value: p.id,
    label: p.type === "team" ? `${p.label} · team` : p.label,
  }));
  const permissionOpts = options.permissions.map((p) => ({
    value: p.key,
    label: p.key,
  }));
  const resourceOpts = (lookup(options.resources, scopeType) ?? []).map(
    (r) => ({
      value: r.id,
      label: r.label,
    }),
  );

  const what = mode === "role" ? roleId : permissionKey;
  const valid = Boolean(
    principalId && what && (scopeType === "org" || resourceId),
  );

  const preview = useMemo(() => {
    if (!valid) return null;
    const pName =
      options.principals.find((p) => p.id === principalId)?.label ?? "—";
    const wName =
      mode === "role"
        ? (options.roles.find((r) => r.id === roleId)?.name ?? "—")
        : permissionKey;
    const sName =
      scopeType === "org"
        ? "the organization"
        : resourceLabel(scopeType, resourceId);
    return { pName, wName, sName, reach: reachLabel(scopeType) };
  }, [
    valid,
    options,
    principalId,
    mode,
    roleId,
    permissionKey,
    scopeType,
    resourceId,
    resourceLabel,
  ]);

  async function submit() {
    if (!valid) return;
    setSaving(true);
    try {
      const principal = options.principals.find((p) => p.id === principalId);
      await assignGrant({
        principalType: principal?.type ?? "user",
        principalId,
        effect,
        roleId: mode === "role" ? roleId : null,
        permissionKey: mode === "permission" ? permissionKey : null,
        resourceType: scopeType === "org" ? "org" : scopeType,
        resourceId: scopeType === "org" ? null : resourceId,
      });
      toast.success("Access granted");
      onGranted();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't grant access");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mb-4 rounded-lg border border-border bg-surface p-4 shadow-sm">
      <p className="text-ui-md font-medium text-text-primary">New grant</p>
      <p className="mb-3 text-ui-xs text-text-tertiary">
        Bind a principal to a role or permission on a scope. Inheritance is
        computed from the scope you pick.
      </p>

      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <div className="mb-1.5 text-ui-xs text-text-tertiary">
            Principal
          </div>
          <Combobox
            options={principalOpts}
            value={principalId}
            onChange={setPrincipalId}
            placeholder="Select a member or team…"
          />
        </div>
        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-ui-xs text-text-tertiary">Grant</span>
            <Toggle
              value={mode}
              onChange={setMode}
              options={[
                { value: "role", label: "Role" },
                { value: "permission", label: "Permission" },
              ]}
            />
          </div>
          {mode === "role" ? (
            <SettingsSelect
              aria-label="Role"
              value={roleId}
              onChange={setRoleId}
              options={[
                { value: "", label: "Select a role…" },
                ...options.roles.map((r) => ({
                  value: r.id,
                  label: r.builtin ? `${r.name} (built-in)` : r.name,
                })),
              ]}
            />
          ) : (
            <Combobox
              options={permissionOpts}
              value={permissionKey}
              onChange={setPermissionKey}
              placeholder="Select a permission…"
            />
          )}
        </div>
        <div>
          <div className="mb-1.5 text-ui-xs text-text-tertiary">Scope</div>
          {projectId ? (
            // Fixed to this project — the list is already project-scoped.
            <div className="flex h-9 items-center rounded-md border border-border bg-surface-sunken px-3 text-ui-sm text-text-secondary">
              {resourceLabel("project", projectId)}
            </div>
          ) : (
            <>
              <SettingsSelect
                aria-label="Scope"
                value={scopeType}
                onChange={(v) => {
                  setScopeType(v);
                  setResourceId("");
                }}
                options={SCOPE_OPTIONS}
              />
              {scopeType !== "org" && (
                <div className="mt-2">
                  <Combobox
                    options={resourceOpts}
                    value={resourceId}
                    onChange={setResourceId}
                    placeholder="Select a resource…"
                  />
                </div>
              )}
            </>
          )}
        </div>
      </div>

      <div className="mt-3 flex items-center gap-2">
        <span className="text-ui-xs text-text-tertiary">Effect</span>
        <Toggle
          value={effect}
          onChange={setEffect}
          options={[
            { value: "allow", label: "Allow" },
            { value: "deny", label: "Deny" },
          ]}
        />
      </div>

      {preview && (
        <div className="mt-3 flex items-start gap-2 rounded-md border border-border bg-surface-sunken px-3 py-2.5">
          <Info size={13} className="mt-0.5 shrink-0 text-text-tertiary" />
          <span className="text-ui-sm text-text-secondary">
            <b className="font-medium text-text-primary">{preview.pName}</b>{" "}
            will {effect}{" "}
            <b className="font-medium text-text-primary">{preview.wName}</b> on{" "}
            <b className="font-medium text-text-primary">{preview.sName}</b> —{" "}
            {preview.reach.toLowerCase()}.
          </span>
        </div>
      )}

      <div className="mt-3 flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={!valid || saving}
          onClick={() => void submit()}
        >
          {saving ? "Adding…" : "Add grant"}
        </Button>
      </div>
    </div>
  );
}

/** A small two-option segmented toggle. */
function Toggle<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <div className="inline-flex gap-0.5 rounded-sm border border-border-strong bg-surface-sunken p-[2px]">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn(
            "rounded-[3px] px-2 py-0.5 text-ui-xs font-medium transition-colors",
            o.value === value
              ? "bg-surface text-text-primary shadow-sm"
              : "text-text-tertiary hover:text-text-secondary",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
