"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Settings · Classification — author the org's classification taxonomy (dimensions = axes ×
// their allowed values) and see how it is actually used. A master/detail: the dimension rail
// selects, the detail edits values (drag-reorder, usage drill). Search is server-side.
// Read-only without `org:edit`. The section title lives in the settings sidebar, so this page
// leads straight into a toolbar (no in-page header). Reads/writes via the classification server
// actions through TanStack Query (shared cache with every picker).

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
import { SectionHeading } from "@repo/ui/section-heading";
import { Skeleton } from "@repo/ui/skeleton";
import { TooltipProvider } from "@repo/ui/tooltip";
import { useQueryClient } from "@tanstack/react-query";
import { BookOpen, Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import type {
	DimensionDTO,
	ValueDTO,
} from "@/app/server/actions/classification/dimensions";
import {
	createValue,
	deleteDimension,
	deleteValue,
	reorderDimensions,
	reorderValues,
	updateDimension,
} from "@/app/server/actions/classification/dimensions";
import { SettingsSearch } from "@/components/settings/settings-ui";
import { qk } from "@/lib/query/keys";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import {
	useCanEditClassification,
	useDimensionsQuery,
} from "@/lib/query/use-classification-query";
import {
	CLASSIFICATION_TEMPLATES,
	type ClassificationTemplate,
} from "./classification-templates";
import { Spinner } from "./classification-ui";
import { DimensionDetail } from "./dimension-detail";
import { DimensionEditorSheet } from "./dimension-editor-sheet";
import { slugifyOrEmpty } from "@/lib/utils/slugify";
import { DimensionRail } from "./dimension-rail";
import { ValueDrillDrawer } from "./value-drill-drawer";
import { ValueEditor } from "./value-editor";

type Sheet =
	| { mode: "create"; templateKey?: string }
	| { mode: "edit"; dimension: DimensionDTO }
	| null;
type DeleteTarget =
	| { kind: "dimension" | "value"; id: string; title: string; message: string }
	| null;

/** The Settings · Classification page body. */
export function ClassificationManager() {
	const qc = useQueryClient();
	const [searchInput, setSearchInput] = useState("");
	const search = useDebouncedValue(searchInput.trim());
	const searching = search.length > 0;

	const { data: dimensions, isPending, isFetching } = useDimensionsQuery(search);
	const { data: canEdit = false } = useCanEditClassification();

	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [sheet, setSheet] = useState<Sheet>(null);
	const [valueEditor, setValueEditor] = useState<{
		dimensionId: string;
		dimensionLabel: string;
		value?: ValueDTO;
	} | null>(null);
	const [drill, setDrill] = useState<{
		value: ValueDTO;
		dimensionLabel: string;
	} | null>(null);
	const [deleteTarget, setDeleteTarget] = useState<DeleteTarget>(null);
	const [deleting, setDeleting] = useState(false);

	/** Invalidate every dimensions query (base + any search-keyed) after a mutation. */
	const refresh = () =>
		qc.invalidateQueries({ queryKey: ["classification", "dimensions"] });

	const dims = dimensions ?? [];
	const selectedDim = dims.find((d) => d.id === selectedId) ?? dims[0] ?? null;
	const reorderable = canEdit && !searching;

	/** Optimistically reorder cached dimensions, then persist. */
	const onReorderDims = (ids: string[]) => {
		qc.setQueryData<DimensionDTO[]>(qk.classificationDimensions(), (old) =>
			old ? [...old].sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id)) : old,
		);
		reorderDimensions(ids)
			.then(refresh)
			.catch((e) => {
				refresh();
				toast.error(e instanceof Error ? e.message : "Couldn't reorder.");
			});
	};

	/** Optimistically reorder a dimension's cached values, then persist. */
	const onReorderVals = (dimId: string, ids: string[]) => {
		qc.setQueryData<DimensionDTO[]>(qk.classificationDimensions(), (old) =>
			old?.map((d) =>
				d.id === dimId
					? {
							...d,
							values: [...d.values].sort(
								(a, b) => ids.indexOf(a.id) - ids.indexOf(b.id),
							),
						}
					: d,
			),
		);
		reorderValues(ids)
			.then(refresh)
			.catch((e) => {
				refresh();
				toast.error(e instanceof Error ? e.message : "Couldn't reorder.");
			});
	};

	/** Quick-add a value to a dimension (awaited so the row can show pending). */
	const onAddValue = async (dim: DimensionDTO, label: string) => {
		try {
			await createValue(dim.id, {
				value: slugifyOrEmpty(label),
				label,
				position: dim.values.length,
			});
			refresh();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Couldn't add value.");
		}
	};

	/** Flip a dimension's single/multi mode (awaited so the switch can show pending). */
	const onToggleMulti = async (dim: DimensionDTO) => {
		try {
			await updateDimension(dim.id, {
				key: dim.key,
				label: dim.label,
				description: dim.description ?? undefined,
				multi: !dim.multi,
				position: dim.position,
			});
			refresh();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Couldn't update.");
		}
	};

	/** Confirm-and-delete the pending dimension or value, with a pending state. */
	const confirmDelete = async () => {
		if (!deleteTarget || deleting) return;
		setDeleting(true);
		try {
			if (deleteTarget.kind === "dimension") {
				await deleteDimension(deleteTarget.id);
			} else {
				await deleteValue(deleteTarget.id);
			}
			toast.success("Deleted.");
			setDeleteTarget(null);
			refresh();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Couldn't delete.");
		} finally {
			setDeleting(false);
		}
	};

	return (
		<TooltipProvider delayDuration={200}>
			{/* toolbar */}
			<div className="mb-4 flex items-center gap-2.5">
				<SettingsSearch
					value={searchInput}
					onChange={setSearchInput}
					placeholder="Search dimensions & values"
					className="w-[240px]"
				/>
				{searching && isFetching ? (
					<span className="text-text-tertiary">
						<Spinner size={13} />
					</span>
				) : (
					<span className="font-mono text-ui-xs text-text-tertiary">
						{searching
							? `${dims.length} match${dims.length === 1 ? "" : "es"}`
							: `${dims.length} dimension${dims.length === 1 ? "" : "s"}`}
					</span>
				)}
				<div className="flex-1" />
				<a
					href="/docs/console/classification"
					target="_blank"
					rel="noopener noreferrer"
					title="What is classification?"
					className="grid size-9 shrink-0 place-items-center rounded-sm border border-border-strong bg-surface-sunken text-text-tertiary transition-colors hover:text-text-primary"
				>
					<BookOpen className="size-4" />
					<span className="sr-only">What is classification?</span>
				</a>
				{canEdit && (
					<Button
						size="sm"
						className="gap-1.5"
						onClick={() => setSheet({ mode: "create" })}
					>
						<Plus className="size-3.5" />
						New dimension
					</Button>
				)}
			</div>

			{isPending ? (
				<div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[296px_1fr]">
					<Skeleton className="h-64 w-full rounded-lg" />
					<Skeleton className="h-80 w-full rounded-lg" />
				</div>
			) : dims.length === 0 && !searching ? (
				<TaxonomyBlankSlate
					canEdit={canEdit}
					onTemplate={(t) => setSheet({ mode: "create", templateKey: t.key })}
					onCreate={() => setSheet({ mode: "create" })}
				/>
			) : dims.length === 0 ? (
				// `p-12`, not `py-12`, so the empty-state matcher never saw this one — it is the same
				// hand-rolled centred nothing either way.
				<EmptyState
					className="border"
					title="No matches"
					description={`No dimensions or values match “${search}”.`}
				/>
			) : (
				<div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[296px_1fr]">
					<DimensionRail
						dims={dims}
						selectedId={selectedDim?.id ?? null}
						onSelect={setSelectedId}
						reorderable={reorderable}
						onReorder={onReorderDims}
					/>
					{selectedDim && (
						<DimensionDetail
							dim={selectedDim}
							canEdit={canEdit}
							reorderable={reorderable}
							onEditDimension={() =>
								setSheet({ mode: "edit", dimension: selectedDim })
							}
							onDeleteDimension={() =>
								setDeleteTarget({
									kind: "dimension",
									id: selectedDim.id,
									title: `Delete “${selectedDim.label}”?`,
									message:
										"This removes the dimension, its values, and every assignment of those values across all resources. This cannot be undone.",
								})
							}
							onToggleMulti={() => onToggleMulti(selectedDim)}
							onReorderValues={(ids) => onReorderVals(selectedDim.id, ids)}
							onAddValue={(label) => onAddValue(selectedDim, label)}
							onEditValue={(value) =>
								setValueEditor({
									dimensionId: selectedDim.id,
									dimensionLabel: selectedDim.label,
									value,
								})
							}
							onDeleteValue={(value) =>
								setDeleteTarget({
									kind: "value",
									id: value.id,
									title: `Delete “${value.label}”?`,
									message:
										"This removes the value and clears it from every resource it was assigned to.",
								})
							}
							onDrill={(value) =>
								setDrill({ value, dimensionLabel: selectedDim.label })
							}
						/>
					)}
				</div>
			)}

			{/* overlays */}
			<DimensionEditorSheet
				open={Boolean(sheet)}
				onOpenChange={(o) => !o && setSheet(null)}
				dimension={sheet?.mode === "edit" ? sheet.dimension : undefined}
				initialTemplateKey={sheet?.mode === "create" ? sheet.templateKey : undefined}
				onSaved={refresh}
			/>
			{valueEditor && (
				<ValueEditor
					open
					onOpenChange={(o) => !o && setValueEditor(null)}
					dimensionId={valueEditor.dimensionId}
					dimensionLabel={valueEditor.dimensionLabel}
					value={valueEditor.value}
					onSaved={refresh}
				/>
			)}
			<ValueDrillDrawer
				value={drill?.value ?? null}
				dimensionLabel={drill?.dimensionLabel ?? ""}
				onClose={() => setDrill(null)}
			/>
			<AlertDialog
				open={Boolean(deleteTarget)}
				onOpenChange={(o) => !o && !deleting && setDeleteTarget(null)}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>{deleteTarget?.title}</AlertDialogTitle>
						<AlertDialogDescription>
							{deleteTarget?.message}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
						<AlertDialogAction
							onClick={(e) => {
								e.preventDefault();
								confirmDelete();
							}}
							disabled={deleting}
						>
							{deleting && <Spinner />}
							Delete
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</TooltipProvider>
	);
}

/**
 * The blank-slate: starter templates (open the editor pre-filled) + create-from-scratch.
 *
 * NOT `EmptyState` from `@repo/ui/empty`, and no longer named as though it were: a grid of
 * pickable starter templates is more than that component expresses, and one file cannot hold two
 * things called `EmptyState`. The no-search-matches state above IS the shared one.
 */
function TaxonomyBlankSlate({
	canEdit,
	onTemplate,
	onCreate,
}: {
	canEdit: boolean;
	onTemplate: (t: ClassificationTemplate) => void;
	onCreate: () => void;
}) {
	return (
		<div className="rounded-md border border-dashed border-border-strong bg-surface px-[30px] py-[34px]">
			<div className="max-w-[60ch]">
				{/* 19px was this file's own answer to a rung the console typesets at 15px
				    everywhere else. The shared component owns the size now; the block below keeps
				    the spacing the heading used to carry. */}
				<SectionHeading className="mb-[7px]" level={2} title="Start your taxonomy" />
				<p className="m-0 mb-[22px] text-ui-md leading-relaxed text-text-secondary">
					A classification is a set of named axes (dimensions) and their allowed
					values. Begin from a common template — you can adjust everything before
					creating — or author one from scratch.
				</p>
			</div>
			{canEdit && (
				<>
					<div className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
						{CLASSIFICATION_TEMPLATES.map((t) => (
							<div
								key={t.key}
								className="flex flex-col gap-2.5 rounded-[4px] border bg-surface-sunken px-4 py-[15px]"
							>
								<div className="flex items-baseline justify-between gap-2.5">
									<span className="text-ui-md font-semibold text-text-primary">
										{t.label}
									</span>
									<span className="rounded-full border border-border-strong px-[7px] py-0.5 font-mono text-ui-3xs uppercase tracking-wide text-text-tertiary">
										{t.multi ? "multi" : "single"}
									</span>
								</div>
								<div className="min-h-[34px] text-ui-xs leading-relaxed text-text-tertiary">
									{t.description}
								</div>
								<div className="flex items-center justify-between gap-2.5">
									<span className="font-mono text-ui-2xs text-text-tertiary">
										{t.values.map((v) => v.label).join(" · ")}
									</span>
									<Button size="sm" variant="outline" onClick={() => onTemplate(t)}>
										Use template
									</Button>
								</div>
							</div>
						))}
					</div>
					<Button className="gap-1.5" onClick={onCreate}>
						<Plus className="size-3.5" />
						Create a dimension
					</Button>
				</>
			)}
		</div>
	);
}
