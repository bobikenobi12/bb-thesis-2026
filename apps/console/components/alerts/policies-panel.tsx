"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Alerts hub · Policies panel. A master-detail: a rail of policies + an inline view/edit
// detail. Creating a policy opens the guided PolicySheet (paged stepper); existing ones
// edit in place (updatePolicy / togglePolicy / deletePolicy) using the shared EventMatrix,
// ChannelRouting, PolicyConditions and ThrottleField. Mutation affordances are hidden when
// the caller can't manage; security
// (authz.*) events are locked without the advancedAlerting entitlement.

import { Bell, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import {
	type AlertsBootstrap,
	deletePolicy,
	type PolicyDTO,
	togglePolicy,
	updatePolicy,
} from "@/app/server/actions/alerts";
import {
	type ChannelBinding,
	ChannelRouting,
} from "@/components/alerts/channel-routing";
import { ChannelIcon } from "@/components/alerts/channel-icon";
import { PoliciesFilterBar } from "@/components/alerts/alerts-filter-bar";
import type { PoliciesView } from "@/components/alerts/alerts-filters";
import { policyBadge } from "@/components/alerts/alerts-status";
import { ClassificationChips } from "@/components/classification/classification-chips";
import { ClassificationControl } from "@/components/classification/classification-control";
import { useAssignmentsForKind } from "@/lib/query/use-classification-query";
import { ConfirmDialog } from "@/components/alerts/confirm-dialog";
import { EventMatrix } from "@/components/alerts/event-matrix";
import {
	type ConditionsValue,
	PolicyConditions,
} from "@/components/alerts/policy-conditions";
import { PolicySheet } from "@/components/alerts/policy-sheet";
import { isSeverity, toMinSeverity } from "@/components/alerts/policy-shared";
import { ThrottleField } from "@/components/alerts/throttle-field";
import { useAlertsSection } from "@/lib/stores/use-alerts-section";
import type { PolicyInput } from "@/lib/validations/alerts";
import { Button } from "@repo/ui/button";
import { EmptyState } from "@repo/ui/empty";
import { Input } from "@repo/ui/input";
import { StatusBadge } from "@repo/ui/status-badge";
import { Switch } from "@repo/ui/switch";
import { Textarea } from "@repo/ui/textarea";
import { cn } from "@repo/ui/utils";

interface Draft {
	name: string;
	description: string;
	events: Set<string>;
	channels: ChannelBinding[];
	minSeverity: string;
	project_ids: string[];
	job_types: string[];
	resource_types: string[];
	actions: string[];
	throttle: number;
}

function draftFrom(p: PolicyDTO): Draft {
	return {
		name: p.name,
		description: p.description ?? "",
		events: new Set(p.event_patterns),
		channels: p.channels.map((c) => ({
			id: c.id,
			min_severity: c.minSeverity ?? undefined,
		})),
		minSeverity: p.match.min_severity ?? "any",
		project_ids: p.match.project_ids ?? [],
		job_types: p.match.job_types ?? [],
		resource_types: p.match.resource_types ?? [],
		actions: p.match.actions ?? [],
		throttle: p.throttle_seconds,
	};
}

interface PoliciesPanelProps {
	bootstrap: AlertsBootstrap;
	/** The filter standard's resolved view — rows, facets, active-filter count. */
	view: PoliciesView;
	onChanged: () => void;
	onOpenChannel: (id?: string) => void;
}

/** Policies master-detail. */
export function PoliciesPanel({
	bootstrap,
	view,
	onChanged,
	onOpenChannel,
}: PoliciesPanelProps) {
	const { policies, channels, advancedAlerting, canManage } = bootstrap;
	const selectedId = useAlertsSection((s) => s.selectedPolicyId);
	const setSelectedId = useAlertsSection((s) => s.setSelectedPolicyId);

	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState<Draft | null>(null);
	const [saving, setSaving] = useState(false);
	const [sheetOpen, setSheetOpen] = useState(false);
	const [deleteTarget, setDeleteTarget] = useState<PolicyDTO | null>(null);

	const selected =
		policies.find((p) => p.id === selectedId) ?? policies[0] ?? null;
	const { rows, facets } = view;
	// One batched query hydrates every rail row's classification chips.
	const { data: classMap = {} } = useAssignmentsForKind(
		"alert_rule",
		policies.map((p) => p.id),
	);

	const patch = (p: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...p } : d));
	const toggleEvent = (key: string) =>
		setDraft((d) => {
			if (!d) return d;
			const events = new Set(d.events);
			events.has(key) ? events.delete(key) : events.add(key);
			return { ...d, events };
		});
	const startEdit = () => {
		if (!selected) return;
		setDraft(draftFrom(selected));
		setEditing(true);
	};
	const cancel = () => {
		setEditing(false);
		setDraft(null);
	};

	const save = async () => {
		if (!draft || !selected) return;
		if (draft.events.size === 0) return toast.error("Pick at least one event.");
		if (draft.channels.length === 0)
			return toast.error("Bind at least one channel.");
		const input: PolicyInput = {
			name: draft.name.trim() || "Untitled policy",
			description: draft.description.trim() || undefined,
			event_patterns: [...draft.events],
			channels: draft.channels.map((b) => ({
				id: b.id,
				min_severity:
					b.min_severity && isSeverity(b.min_severity) ? b.min_severity : undefined,
			})),
			match: {
				...(isSeverity(draft.minSeverity)
					? { min_severity: draft.minSeverity }
					: {}),
				...(draft.project_ids.length ? { project_ids: draft.project_ids } : {}),
				...(draft.job_types.length ? { job_types: draft.job_types } : {}),
				...(draft.resource_types.length
					? { resource_types: draft.resource_types }
					: {}),
				...(draft.actions.length ? { actions: draft.actions } : {}),
			},
			severity: "warning",
			throttle_seconds: draft.throttle,
			escalate: false,
			recipient: undefined,
			enabled: selected.enabled,
		};
		setSaving(true);
		try {
			await updatePolicy(selected.id, input);
			toast.success("Policy saved");
			setEditing(false);
			setDraft(null);
			onChanged();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Failed to save policy");
		} finally {
			setSaving(false);
		}
	};

	const onToggleEnabled = async (p: PolicyDTO, next: boolean) => {
		try {
			await togglePolicy(p.id, next);
			onChanged();
		} catch {
			toast.error("Failed to update");
		}
	};
	const doDelete = async (p: PolicyDTO) => {
		try {
			await deletePolicy(p.id);
			toast.success("Policy deleted");
			setSelectedId(null);
			onChanged();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Failed to delete");
		}
	};

	const newPolicyBtn = canManage && (
		<Button size="sm" onClick={() => setSheetOpen(true)}>
			<Plus className="mr-1 size-3.5" /> New policy
		</Button>
	);

	return (
		<div>
			{policies.length === 0 ? (
				<EmptyState
					icon={<Bell />}
					title="No policies yet"
					description={`A policy watches a set of events and routes matches to your channels.${canManage ? " Create one to start." : ""}`}
					action={canManage ? newPolicyBtn : undefined}
				/>
			) : (
				<>
					<PoliciesFilterBar facets={facets} action={newPolicyBtn} />

					{/* master-detail */}
					<div className="flex flex-wrap items-start gap-4">
						<div className="min-w-[290px] flex-1 overflow-hidden rounded-xl border border-border/60 bg-background shadow-sm">
							<div className="px-4 py-3 font-mono text-ui-3xs uppercase tracking-[0.14em] text-muted-foreground/70">
								Policies
							</div>
							{rows.length === 0 ? (
								<div className="px-4 py-4 text-muted-foreground/70 text-xs">
									No policies match these filters.
								</div>
							) : (
								rows.map((p) => (
									<button
										key={p.id}
										type="button"
										onClick={() => {
											setEditing(false);
											setDraft(null);
											setSelectedId(p.id);
										}}
										className={cn(
											"flex w-full items-center gap-3 border-b border-l-2 border-border/60 px-3.5 py-3 text-left transition-colors hover:bg-muted/40",
											selected?.id === p.id
												? "border-l-foreground bg-muted/40"
												: "border-l-transparent",
										)}
									>
										<StatusBadge {...policyBadge(p)} showLabel={false} />
										<span className="min-w-0 flex-1">
											<span className="block truncate font-medium text-ui-md">
												{p.name}
											</span>
											<span className="font-mono text-ui-2xs text-muted-foreground">
												{p.event_patterns.length} events ·{" "}
												{p.enabled ? "enabled" : "off"}
											</span>
											<ClassificationChips
												kind="alert_rule"
												id={p.id}
												initialAssignments={classMap[p.id]}
												className="mt-1 flex"
											/>
										</span>
										<span className="flex gap-1">
											{p.channelIds.slice(0, 4).map((cid) => {
												const ch = channels.find((c) => c.id === cid);
												if (!ch) return null;
												return (
													<span
														key={cid}
														className="flex size-[18px] items-center justify-center rounded border border-border/60"
													>
														<ChannelIcon
															type={ch.type}
															active={ch.is_verified}
															size={11}
														/>
													</span>
												);
											})}
										</span>
									</button>
								))
							)}
						</div>

						<div className="min-w-[min(500px,100%)] flex-[100]">
							{selected ? (
								<PolicyDetail
									policy={selected}
									draft={draft}
									editing={editing}
									saving={saving}
									canManage={canManage}
									advancedAlerting={advancedAlerting}
									bootstrap={bootstrap}
									patch={patch}
									toggleEvent={toggleEvent}
									onStartEdit={startEdit}
									onCancel={cancel}
									onSave={save}
									onToggleEnabled={onToggleEnabled}
									onDelete={setDeleteTarget}
									onOpenChannel={onOpenChannel}
								/>
							) : (
								<div className="rounded-xl border border-border/60 bg-background p-12 text-center text-muted-foreground text-sm shadow-sm">
									Select a policy to view it.
								</div>
							)}
						</div>
					</div>
				</>
			)}

			{canManage && (
				<PolicySheet
					open={sheetOpen}
					onOpenChange={setSheetOpen}
					bootstrap={bootstrap}
					onSaved={onChanged}
					onGoChannels={() => onOpenChannel()}
				/>
			)}

			<ConfirmDialog
				open={deleteTarget !== null}
				onOpenChange={(o) => !o && setDeleteTarget(null)}
				title={`Delete policy "${deleteTarget?.name ?? ""}"?`}
				description="This policy stops watching its events immediately. Delivery history is kept. This cannot be undone."
				confirmLabel="Delete policy"
				onConfirm={() => {
					if (deleteTarget) doDelete(deleteTarget);
					setDeleteTarget(null);
				}}
			/>
		</div>
	);
}

interface DetailProps {
	policy: PolicyDTO;
	draft: Draft | null;
	editing: boolean;
	saving: boolean;
	canManage: boolean;
	advancedAlerting: boolean;
	bootstrap: AlertsBootstrap;
	patch: (p: Partial<Draft>) => void;
	toggleEvent: (key: string) => void;
	onStartEdit: () => void;
	onCancel: () => void;
	onSave: () => void;
	onToggleEnabled: (p: PolicyDTO, next: boolean) => void;
	onDelete: (p: PolicyDTO) => void;
	onOpenChannel: (id?: string) => void;
}

/** Inline view/edit of one existing policy. */
function PolicyDetail({
	policy,
	draft,
	editing,
	saving,
	canManage,
	advancedAlerting,
	bootstrap,
	patch,
	toggleEvent,
	onStartEdit,
	onCancel,
	onSave,
	onToggleEnabled,
	onDelete,
	onOpenChannel,
}: DetailProps) {
	const { categories, channels, conditionOptions } = bootstrap;
	const ed = editing && draft !== null;

	const events = ed ? [...draft.events] : policy.event_patterns;
	const channelBindings: ChannelBinding[] = ed
		? draft.channels
		: policy.channels.map((c) => ({
				id: c.id,
				min_severity: c.minSeverity ?? undefined,
			}));
	const conditions: ConditionsValue = ed
		? {
				min_severity: toMinSeverity(draft.minSeverity),
				project_ids: draft.project_ids,
				job_types: draft.job_types,
				resource_types: draft.resource_types,
				actions: draft.actions,
			}
		: {
				min_severity: policy.match.min_severity ?? "any",
				project_ids: policy.match.project_ids ?? [],
				job_types: policy.match.job_types ?? [],
				resource_types: policy.match.resource_types ?? [],
				actions: policy.match.actions ?? [],
			};
	const throttle = ed ? draft.throttle : policy.throttle_seconds;
	const name = ed ? draft.name : policy.name;
	const description = ed ? draft.description : (policy.description ?? "");
	const totalEv = categories.reduce((n, c) => n + c.events.length, 0);
	const throttleLabel =
		throttle <= 0 ? "Every event" : `${Math.round(throttle / 60)} min`;

	return (
		<div className="overflow-hidden rounded-xl border border-border/60 bg-background shadow-sm">
			{/* header */}
			<div className="flex items-start justify-between gap-4 border-b border-border/60 p-5">
				<div className="flex min-w-0 gap-3">
					<span className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-muted/30">
						<Bell className="size-5 text-muted-foreground" />
					</span>
					<div className="min-w-0 space-y-1.5">
						<div className="flex flex-wrap items-center gap-2.5">
							{ed ? (
								<Input
									value={name}
									onChange={(e) => patch({ name: e.target.value })}
									placeholder="Policy name"
									className="h-8 w-64 font-semibold"
								/>
							) : (
								<span className="font-display font-semibold text-lg tracking-tight">
									{name}
								</span>
							)}
							{policy.is_security && (
								<span className="rounded-full border border-border/60 px-2 py-0.5 font-mono text-ui-3xs uppercase tracking-wider text-muted-foreground">
									security
								</span>
							)}
						</div>
						{ed ? (
							<Textarea
								rows={2}
								value={description}
								onChange={(e) => patch({ description: e.target.value })}
								placeholder="What this policy watches and why"
								className="text-xs"
							/>
						) : (
							description && (
								<p className="max-w-prose text-muted-foreground text-xs leading-relaxed">
									{description}
								</p>
							)
						)}
						{/* Classification (Workstream B) — chips + a picker for managers. */}
						<ClassificationControl
							kind="alert_rule"
							id={policy.id}
							canEdit={canManage}
							className="pt-1"
						/>
					</div>
				</div>
				<div className="flex flex-none items-center gap-2">
					<StatusBadge {...policyBadge(policy)} className="text-ui-2xs" />
					<Switch
						checked={policy.enabled}
						disabled={!canManage || ed}
						onCheckedChange={(c) => onToggleEnabled(policy, c)}
					/>
					{canManage &&
						(ed ? (
							<>
								<Button
									variant="ghost"
									size="sm"
									onClick={onCancel}
									disabled={saving}
								>
									Cancel
								</Button>
								<Button size="sm" onClick={onSave} disabled={saving}>
									{saving ? "Saving…" : "Save"}
								</Button>
							</>
						) : (
							<Button size="sm" variant="outline" onClick={onStartEdit}>
								Edit policy
							</Button>
						))}
				</div>
			</div>

			{/* meta */}
			<div className="flex flex-wrap border-b border-border/60">
				<MetaCell k="Events" v={`${events.length} of ${totalEv}`} />
				<MetaCell
					k="Routes to"
					v={`${channelBindings.length} ${channelBindings.length === 1 ? "channel" : "channels"}`}
				/>
				<MetaCell k="Throttle" v={throttleLabel} />
			</div>

			{/* events */}
			<div className="space-y-3 border-b border-border/60 p-5">
				<div className="flex items-center gap-2">
					<span className="font-mono text-ui-2xs uppercase tracking-wider text-foreground/70">
						Trigger · events
					</span>
					<span className="ml-auto font-mono text-ui-2xs text-muted-foreground">
						{events.length} selected
					</span>
				</div>
				<EventMatrix
					categories={categories}
					selected={events}
					onToggle={toggleEvent}
					advancedAlerting={advancedAlerting}
					editable={ed}
				/>
			</div>

			{/* routing */}
			<div className="space-y-3 border-b border-border/60 p-5">
				<div className="flex items-center gap-2">
					<span className="font-mono text-ui-2xs uppercase tracking-wider text-foreground/70">
						Routing · channels
					</span>
					<button
						type="button"
						onClick={() => onOpenChannel()}
						className="ml-auto text-muted-foreground text-xs hover:text-foreground"
					>
						All channels →
					</button>
				</div>
				<ChannelRouting
					channels={channels}
					value={channelBindings}
					onChange={(next) => patch({ channels: next })}
					editable={ed}
					onGoChannels={() => onOpenChannel()}
				/>
			</div>

			{/* conditions */}
			<div className="space-y-3 border-b border-border/60 p-5">
				<span className="font-mono text-ui-2xs uppercase tracking-wider text-foreground/70">
					Conditions
				</span>
				<PolicyConditions
					options={conditionOptions}
					editable={ed}
					value={conditions}
					onChange={(c) =>
						patch({
							minSeverity: c.min_severity,
							project_ids: c.project_ids,
							job_types: c.job_types,
							resource_types: c.resource_types,
							actions: c.actions,
						})
					}
				/>
			</div>

			{/* throttle */}
			<div className="space-y-2 p-5">
				<div className="flex items-center gap-1.5">
					<span className="font-mono text-ui-2xs uppercase tracking-wider text-foreground/70">
						Notify at most once per
					</span>
				</div>
				{ed ? (
					<ThrottleField
						value={throttle}
						onChange={(s) => patch({ throttle: s })}
					/>
				) : (
					<p className="text-muted-foreground text-sm">{throttleLabel}</p>
				)}
			</div>

			{/* footer */}
			{canManage && !ed && (
				<div className="flex items-center justify-between border-t border-border/60 bg-muted/20 px-5 py-3">
					<span className="text-muted-foreground text-xs">
						{policy.is_security
							? "Security policy · PDP-sourced events"
							: "Operational policy"}
					</span>
					<Button variant="ghost" size="sm" onClick={() => onDelete(policy)}>
						<Trash2 className="mr-1.5 size-3.5" /> Delete policy
					</Button>
				</div>
			)}
		</div>
	);
}

function MetaCell({ k, v }: { k: string; v: string }) {
	return (
		<div className="min-w-[120px] flex-1 border-r border-border/60 px-5 py-3 last:border-r-0">
			<div className="font-mono text-ui-3xs uppercase tracking-wider text-muted-foreground">
				{k}
			</div>
			<div className="mt-1.5 truncate text-ui-md">{v}</div>
		</div>
	);
}
