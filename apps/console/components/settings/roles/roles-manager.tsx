"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Settings · Roles — IAM-style master/detail. A left rail (built-in + custom roles) and a
// right detail panel (read-only permission matrix + classification). Custom roles are searched
// SERVER-SIDE (useRolesQuery) and created/edited through the AccordionForm RoleSheet. Built-ins
// come from the bootstrap (registry); custom-role authoring is gated on the customRoles entitlement.

import { Lock, Pencil, Plus, Shield, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
	deleteRole,
	type RoleRow,
	type RolesBootstrap,
} from "@/app/server/actions/roles";
import { ClassificationChips } from "@/components/classification/classification-chips";
import { ClassificationControl } from "@/components/classification/classification-control";
import { useEntitlement } from "@/components/settings/enterprise-gate";
import { UpgradeDialog } from "@/components/settings/upgrade/upgrade-dialog";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useFilterUrlSync } from "@/hooks/use-filter-url-sync";
import {
	useInvalidateRoles,
	useRolesQuery,
} from "@/lib/query/use-roles-query";
import { countActiveFilters } from "@/lib/stores/create-filter-store";
import { useRolesFilters } from "@/lib/stores/use-settings-filters";
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
import { EmptyState } from "@repo/ui/empty";
import { FacetFilter } from "@repo/ui/facet-filter";
import { FilterBar, FilterBarReset } from "@repo/ui/filter-bar";
import { FilterSearch } from "@repo/ui/filter-search";
import { PageToolbar } from "@repo/ui/page-toolbar";
import { Spinner } from "@repo/ui/spinner";
import { cn } from "@repo/ui/utils";
import {
	DEFAULT_ROLES_FILTERS,
	filterBuiltins,
	normalizeRolesQuery,
	ROLE_KIND_OPTIONS,
	showsKind,
} from "./roles-filters";
import { PermissionMatrix } from "./permission-matrix";
import { RoleSheet } from "./role-sheet";

/** A rail row — selectable role with its permission count. */
function RailRow({
	name,
	count,
	active,
	onClick,
}: {
	name: string;
	count: number;
	active: boolean;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={cn(
				"flex w-full items-center justify-between gap-2 rounded-sm px-2.5 py-2 text-left transition-colors",
				active ? "bg-surface-muted" : "hover:bg-surface-muted/60",
			)}
		>
			<span
				className={cn(
					"truncate text-ui-md capitalize",
					active ? "font-medium text-text-primary" : "text-text-secondary",
				)}
			>
				{name}
			</span>
			<span className="shrink-0 font-mono text-ui-2xs text-text-tertiary">
				{count}
			</span>
		</button>
	);
}

export function RolesManager({ bootstrap }: { bootstrap: RolesBootstrap }) {
	const { builtin, canManage } = bootstrap;
	// Client entitlement mirrors the server bootstrap; the store hydrates it app-wide.
	const entitled = useEntitlement("customRoles") || bootstrap.customRoles;

	// Filter state: the store is the source of truth, the URL mirrors it (shareable views),
	// and the free text is debounced before it can reach a query key.
	const filters = useRolesFilters((s) => s.filters);
	const set = useRolesFilters((s) => s.set);
	const reset = useRolesFilters((s) => s.reset);
	useFilterUrlSync(useRolesFilters, DEFAULT_ROLES_FILTERS);
	const search = useDebouncedValue(filters.search.trim());
	const query = useMemo(
		() => normalizeRolesQuery(filters, search),
		[filters, search],
	);
	const searching = Boolean(query.search);

	// Custom roles are filtered SERVER-SIDE by search (listRoles); the kind facet is a pure
	// show/hide over two fixed buckets, so it never needs to reach the server.
	const { data: customAll = [], isFetching } = useRolesQuery(query.search);
	const custom = showsKind(query, "custom") ? customAll : [];
	const invalidate = useInvalidateRoles();

	const [selectedId, setSelectedId] = useState<string>(builtin[0]?.id ?? "");
	const [sheetOpen, setSheetOpen] = useState(false);
	const [editingRole, setEditingRole] = useState<RoleRow | null>(null);
	const [deleting, setDeleting] = useState<RoleRow | null>(null);
	const [upsellOpen, setUpsellOpen] = useState(false);

	// Built-ins ship with the page bootstrap, not the query, so they are narrowed by the pure
	// `filterBuiltins` predicate rather than a server round-trip.
	const builtinList = useMemo(
		() => filterBuiltins(builtin, query),
		[builtin, query],
	);
	const activeFilters = countActiveFilters(filters, DEFAULT_ROLES_FILTERS);

	const selected =
		[...builtin, ...custom].find((r) => r.id === selectedId) ?? builtin[0] ?? null;

	function openCreate() {
		if (!entitled) {
			setUpsellOpen(true);
			return;
		}
		setEditingRole(null);
		setSheetOpen(true);
	}

	function openEdit(r: RoleRow) {
		setEditingRole(r);
		setSheetOpen(true);
	}

	async function confirmDelete(r: RoleRow) {
		try {
			await deleteRole(r.id);
			toast.success("Role deleted");
			setDeleting(null);
			if (selectedId === r.id) setSelectedId(builtin[0]?.id ?? "");
			invalidate();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Couldn't delete role");
		}
	}

	return (
		<div>
			<PageToolbar
				className="mb-4"
				description="Built-in roles plus the custom roles this organization defines."
				count={builtinList.length + custom.length}
				actions={
					<Button size="sm" onClick={openCreate}>
						{entitled ? <Plus size={13} /> : <Lock size={13} />}
						Create role
					</Button>
				}
			/>

			<FilterBar
				end={
					searching && isFetching ? (
						<Spinner className="size-3.5 text-text-tertiary" />
					) : undefined
				}
			>
				<FilterSearch
					value={filters.search}
					onChange={(v) => set("search", v)}
					placeholder="Search roles…"
					className="w-[240px] max-w-[380px] flex-1"
				/>
				<FacetFilter
					label="Kind"
					icon={Shield}
					options={ROLE_KIND_OPTIONS.map((o) => ({
						value: o.value,
						label: o.label,
						hint: String(o.value === "builtin" ? builtin.length : customAll.length),
					}))}
					value={filters.kinds}
					onChange={(next) => set("kinds", next)}
					searchPlaceholder="Filter kind…"
					emptyText="No kinds."
				/>
				<FilterBarReset count={activeFilters} onReset={reset} />
			</FilterBar>

			{/* master-detail */}
			<div className="grid grid-cols-1 gap-4 lg:grid-cols-[260px_1fr]">
				{/* rail */}
				<div className="rounded-lg border border-border bg-surface p-2 shadow-sm">
					{/* The Kind facet hides a whole bucket rather than emptying it — an
					    unexplained empty "Built-in" heading reads as a broken fetch. */}
					{showsKind(query, "builtin") && (
						<>
							<div className="px-2.5 py-2 font-mono text-ui-3xs uppercase tracking-[0.12em] text-text-tertiary">
								Built-in
							</div>
							{builtinList.length === 0 ? (
								<div className="px-2.5 py-2 text-ui-xs text-text-tertiary">
									No matching built-in roles.
								</div>
							) : (
								builtinList.map((r) => (
									<RailRow
										key={r.id}
										name={r.name}
										count={r.permissionKeys.length}
										active={selectedId === r.id}
										onClick={() => setSelectedId(r.id)}
									/>
								))
							)}
						</>
					)}
					{showsKind(query, "builtin") && showsKind(query, "custom") && (
						<div className="my-2 h-px bg-border" />
					)}
					{showsKind(query, "custom") && (
						<>
							<div className="px-2.5 py-2 font-mono text-ui-3xs uppercase tracking-[0.12em] text-text-tertiary">
								Custom
							</div>
							{custom.length === 0 ? (
								<div className="px-2.5 py-2 text-ui-xs text-text-tertiary">
									{searching ? "No matching custom roles." : "No custom roles yet."}
								</div>
							) : (
								custom.map((r) => (
									<RailRow
										key={r.id}
										name={r.name}
										count={r.permissionKeys.length}
										active={selectedId === r.id}
										onClick={() => setSelectedId(r.id)}
									/>
								))
							)}
						</>
					)}
				</div>

				{/* detail */}
				<div className="rounded-lg border border-border bg-surface shadow-sm">
					{selected ? (
						<RoleDetail
							role={selected}
							canManage={canManage}
							onEdit={() => openEdit(selected)}
							onDelete={() => setDeleting(selected)}
						/>
					) : (
						<EmptyState
							title="No role selected"
							description="Pick a role from the list to see the permissions it grants."
						/>
					)}
				</div>
			</div>

			<RoleSheet
				open={sheetOpen}
				onOpenChange={setSheetOpen}
				role={editingRole}
				templates={builtin}
				canManage={canManage}
				onSaved={invalidate}
			/>

			<UpgradeDialog
				feature="roles"
				open={upsellOpen}
				onOpenChange={setUpsellOpen}
			/>

			<AlertDialog
				open={deleting !== null}
				onOpenChange={(o) => !o && setDeleting(null)}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Delete this role?</AlertDialogTitle>
						<AlertDialogDescription>
							{deleting && deleting.grantCount > 0
								? `${deleting.grantCount} member${deleting.grantCount === 1 ? "" : "s"} ${deleting.grantCount === 1 ? "is" : "are"} granted this role — deleting revokes it for ${deleting.grantCount === 1 ? "them" : "all of them"}. `
								: "No members are currently granted this role. "}
							This cannot be undone.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction
							onClick={() => deleting && void confirmDelete(deleting)}
							className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
						>
							Delete role
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	);
}

/** Read-only detail for a role: header + description + view-only matrix + classification.
 *  Custom roles get Edit/Delete affordances (gated on canManage). */
function RoleDetail({
	role,
	canManage,
	onEdit,
	onDelete,
}: {
	role: RoleRow;
	canManage: boolean;
	onEdit: () => void;
	onDelete: () => void;
}) {
	return (
		<div>
			<div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
				<div className="min-w-0">
					<div className="flex items-center gap-2">
						<Shield size={15} className="text-text-tertiary" />
						<span className="text-ui-lg font-semibold capitalize text-text-primary">
							{role.name}
						</span>
						<span className="rounded-full border border-border-strong px-2 py-0.5 font-mono text-ui-3xs uppercase tracking-[0.1em] text-text-secondary">
							{role.builtin ? "Built-in" : "Custom"}
						</span>
					</div>
					{role.description && (
						<p className="mt-1.5 text-ui-sm text-text-secondary">
							{role.description}
						</p>
					)}
				</div>
				{!role.builtin && (
					<div className="flex shrink-0 items-center gap-2">
						<Button
							variant="outline"
							size="sm"
							disabled={!canManage}
							onClick={onEdit}
						>
							<Pencil size={13} />
							Edit
						</Button>
						<Button
							variant="outline"
							size="sm"
							disabled={!canManage}
							onClick={onDelete}
						>
							<Trash2 size={13} />
							Delete
						</Button>
					</div>
				)}
			</div>
			<div className="px-5 py-4">
				<p className="mb-3 text-ui-md font-medium text-text-primary">
					Permissions{" "}
					<span className="font-mono text-ui-xs font-normal text-text-tertiary">
						({role.permissionKeys.length})
					</span>
				</p>
				<PermissionMatrix value={role.permissionKeys} readOnly />
			</div>
			{/* Classification — built-in roles show read-only chips; custom roles the control. */}
			<div className="border-t border-border px-5 py-4">
				{role.builtin ? (
					<ClassificationChips kind="role" id={role.id} />
				) : (
					<ClassificationControl kind="role" id={role.id} canEdit={canManage} />
				)}
			</div>
		</div>
	);
}
