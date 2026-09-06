"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The project's Environments surface. Leads with the active-promotion panel (when a promotion is in
// flight), then the environments spine (grouped by stage, each with drift/deploy, classification,
// the "gates into this env" protection summary, and auto-heal/duplicate/delete), a consistency
// matrix, and the promotions history. Destructive/confirm actions go through the shared AlertDialog.
// No page header — the section labels carry it.

import { ArrowUpFromLine, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import {
	deleteEnvironment,
	type EnvConsistency,
	setAutoHeal,
} from "@/app/server/actions/projects";
import type { ProtectionSummary } from "@/app/server/actions/protection";
import {
	approvePromotion,
	cancelPromotion,
	type PromotionDetail,
	rejectPromotion,
} from "@/app/server/actions/promotions";
import type { EnvReconcileState } from "@/app/server/actions/reconcile";
import type { SwitcherEnv } from "@/app/server/actions/resolve";
import { ConfirmDialog } from "@/components/alerts/confirm-dialog";
import { NewEnvironmentDialog } from "@/components/environments/new-environment-dialog";
import { ProtectionRulesDialog } from "@/components/environments/protection-rules-dialog";
import { PromoteDialog } from "@/components/environments/promote-dialog";
import { useAssignmentsForKind } from "@/lib/query/use-classification-query";
import { Button } from "@repo/ui/button";
import { EmptyState } from "@repo/ui/empty";
import { SectionHeading } from "@repo/ui/section-heading";
import { ActivePromotionPanel } from "./active-promotion-panel";
import { ConsistencyMatrix } from "./consistency-matrix";
import { EnvironmentCard } from "./environment-card";
import { PromotionDetailOverlay } from "./promotion-detail-overlay";
import { PromotionsHistory } from "./promotions-history";

/** One environment row (serialized from the DB — `updated_at` is an ISO string). */
export interface EnvRow {
	id: string;
	name: string;
	stage: string;
	is_default: boolean;
	updated_at: string;
}

/** A promotion row projected for the client. */
export interface PromotionRowView {
	id: string;
	source_environment_id: string;
	target_environment_id: string;
	status: string;
	error_message: string | null;
	created_at: string;
}

const STAGE_ORDER = ["development", "staging", "production"];
const STAGE_LABEL: Record<string, string> = {
	development: "Development",
	staging: "Staging",
	production: "Production",
};

export function EnvironmentsView({
	org,
	project,
	projectId,
	envs,
	consistency,
	reconcile,
	promotions,
	activePromotion,
	protectionByEnv,
}: {
	org: string;
	project: string;
	projectId: string;
	envs: EnvRow[];
	consistency: EnvConsistency;
	reconcile: EnvReconcileState[];
	promotions: PromotionRowView[];
	activePromotion: PromotionDetail | null;
	protectionByEnv: Record<string, ProtectionSummary>;
}) {
	const router = useRouter();
	const [createOpen, setCreateOpen] = useState(false);
	const [duplicateFrom, setDuplicateFrom] = useState<EnvRow | null>(null);
	const [promoteOpen, setPromoteOpen] = useState(false);
	const [protectFor, setProtectFor] = useState<EnvRow | null>(null);
	const [pendingDelete, setPendingDelete] = useState<EnvRow | null>(null);
	const [detailOpen, setDetailOpen] = useState(false);
	const [confirmReject, setConfirmReject] = useState(false);
	const [confirmCancel, setConfirmCancel] = useState(false);

	const switcherEnvs: SwitcherEnv[] = envs.map((e) => ({
		id: e.id,
		project_id: projectId,
		name: e.name,
		stage: e.stage,
		is_default: e.is_default,
	}));
	const reconcileById = new Map(reconcile.map((r) => [r.environmentId, r]));
	const envName = (id: string) => envs.find((e) => e.id === id)?.name ?? "—";
	const { data: classMap = {} } = useAssignmentsForKind(
		"project_environment",
		envs.map((e) => e.id),
	);

	/** Group environments by stage in dev → staging → prod order. */
	const groups = STAGE_ORDER.map((stage) => ({
		stage,
		label: STAGE_LABEL[stage] ?? stage,
		envs: envs.filter((e) => e.stage === stage),
	})).filter((g) => g.envs.length > 0);

	const run = async (fn: () => Promise<unknown>, ok: string) => {
		try {
			await fn();
			toast.success(ok);
			router.refresh();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Action failed");
		}
	};

	return (
		<div className="mx-auto max-w-4xl space-y-8">
			{/* Active promotion */}
			{activePromotion && (
				<ActivePromotionPanel
					detail={activePromotion}
					canApprove={
						activePromotion.status === "PENDING_APPROVAL" &&
						activePromotion.approved < activePromotion.required
					}
					canCancel={["PENDING_PLAN", "PENDING_APPROVAL", "DEPLOYING"].includes(
						activePromotion.status,
					)}
					onApprove={() =>
						run(() => approvePromotion(activePromotion.id), "Promotion approved")
					}
					onReject={() => setConfirmReject(true)}
					onCancel={() => setConfirmCancel(true)}
					onOpenDetail={() => setDetailOpen(true)}
				/>
			)}

			{/* Environments spine */}
			<section className="space-y-4">
				{/* The count rides the header's pill, which is where the console filter standard
				    puts a result count — it used to be prose ("N total") beside the heading. */}
				<SectionHeading
					level={2}
					title="Environments"
					count={envs.length}
					actions={
						<>
							<Button size="sm" onClick={() => setCreateOpen(true)}>
								<Plus className="mr-1.5 size-3.5" />
								New Environment
							</Button>
							{envs.length > 1 && (
								<Button size="sm" variant="outline" onClick={() => setPromoteOpen(true)}>
									<ArrowUpFromLine className="mr-1.5 size-3.5" />
									Promote
								</Button>
							)}
						</>
					}
				/>

				{groups.map((g) => (
					<div key={g.stage} className="space-y-2.5">
						<div className="font-mono text-ui-2xs uppercase tracking-[0.16em] text-text-tertiary">
							{g.label}
						</div>
						{g.envs.map((env) => (
							<EnvironmentCard
								key={env.id}
								env={env}
								org={org}
								project={project}
								reconcile={reconcileById.get(env.id)}
								protection={protectionByEnv[env.id]}
								classAssignments={classMap[env.id]}
								canEdit
								onEditRules={() => setProtectFor(env)}
								onToggleHeal={(v) =>
									run(
										() => setAutoHeal(projectId, env.id, v),
										`Auto-heal ${v ? "on" : "off"} for ${env.name}`,
									)
								}
								onDuplicate={() => {
									setDuplicateFrom(env);
									setCreateOpen(true);
								}}
								onDelete={() => setPendingDelete(env)}
							/>
						))}
					</div>
				))}

				{/* Two states, not one. The predicate here used to be `<= 1`, which folded the
				    empty list into the one-environment hint and asserted "Only one environment"
				    over nothing at all. */}
				{envs.length === 0 && (
					<EmptyState
						level={3}
						className="border border-dashed border-border-strong"
						title="No environments"
						description="Create one to deploy this project, then add a second to promote changes up a chain."
					/>
				)}

				{/* A note under a POPULATED list, so NOT an `EmptyState`: that is a centred panel at
				    `p-6 md:p-12` with an 18px headline, and sitting under the one environment card
				    it reads as "this list is empty" when it is not. */}
				{envs.length === 1 && (
					<p className="rounded-lg border border-dashed border-border-strong px-4 py-3 text-ui-md text-text-tertiary">
						Only one environment. Create another to compare configuration and promote
						changes up the chain.
					</p>
				)}
			</section>

			{consistency.rows.length > 0 && (
				<ConsistencyMatrix consistency={consistency} />
			)}
			{promotions.length > 0 && (
				<PromotionsHistory
					promotions={promotions}
					envName={envName}
					onView={() => setDetailOpen(true)}
				/>
			)}

			{/* Overlays */}
			<NewEnvironmentDialog
				open={createOpen}
				onOpenChange={(o) => {
					setCreateOpen(o);
					if (!o) setDuplicateFrom(null);
				}}
				projectId={projectId}
				envs={switcherEnvs}
				defaultBaseId={duplicateFrom?.id}
				onCreated={() => router.refresh()}
			/>
			<PromoteDialog
				open={promoteOpen}
				onOpenChange={setPromoteOpen}
				projectId={projectId}
				envs={envs.map((e) => ({ id: e.id, name: e.name, stage: e.stage }))}
				onPromoted={() => router.refresh()}
			/>
			{protectFor && (
				<ProtectionRulesDialog
					open={!!protectFor}
					onOpenChange={(o) => !o && setProtectFor(null)}
					projectId={projectId}
					envId={protectFor.id}
					envName={protectFor.name}
				/>
			)}
			<PromotionDetailOverlay
				detail={detailOpen ? activePromotion : null}
				onClose={() => setDetailOpen(false)}
			/>

			<ConfirmDialog
				open={!!pendingDelete}
				onOpenChange={(o) => !o && setPendingDelete(null)}
				title={`Delete ${pendingDelete?.name ?? "environment"}?`}
				description="This permanently deletes the environment and its staged configuration. Provisioned infrastructure is not destroyed. This cannot be undone."
				confirmLabel="Delete environment"
				onConfirm={() => {
					if (pendingDelete)
						void run(
							() => deleteEnvironment(projectId, pendingDelete.id),
							`Deleted ${pendingDelete.name}`,
						);
				}}
			/>
			<ConfirmDialog
				open={confirmReject}
				onOpenChange={setConfirmReject}
				title="Reject this promotion?"
				description="The promotion is cancelled and nothing is deployed. The initiator can start a new one."
				confirmLabel="Reject promotion"
				onConfirm={() => {
					if (activePromotion)
						void run(
							() => rejectPromotion(activePromotion.id),
							"Promotion rejected",
						);
				}}
			/>
			<ConfirmDialog
				open={confirmCancel}
				onOpenChange={setConfirmCancel}
				title="Cancel this promotion?"
				description="The in-flight promotion is stopped. Nothing further is deployed."
				confirmLabel="Cancel promotion"
				onConfirm={() => {
					if (activePromotion)
						void run(() => cancelPromotion(activePromotion.id), "Promotion cancelled");
				}}
			/>
		</div>
	);
}
