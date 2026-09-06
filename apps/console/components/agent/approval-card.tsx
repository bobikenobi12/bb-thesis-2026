"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Check, ShieldCheck, X } from "lucide-react";
import { useState } from "react";
import { planProject, provisionProject } from "@/app/server/actions/projects";
import { formatMonthlyRate } from "@repo/format";
import { Button } from "@repo/ui/button";
import { track } from "@/lib/analytics/track";
import type { OperationProposal } from "@/lib/ai/operation";
import { useArtifactStore } from "@/lib/stores/use-artifact-store";
import { cn } from "@repo/ui/utils";

type Phase = "idle" | "running" | "done" | "rejected" | "denied";

/**
 * HITL approval for an agent-proposed plan/deploy. Approve calls the PDP-gated
 * planProject/provisionProject (the M1 placement + usage gates run inside them) and opens
 * the artifact Logs tab on the returned job; a denial (Forbidden / usage cap) shows
 * the "held back" note from the action's error message.
 */
export function ApprovalCard({
	proposal,
	onResolve,
}: {
	proposal: OperationProposal;
	/** Feed the outcome back to the model (closes the HITL loop → it continues). */
	onResolve?: (output: unknown) => void;
}) {
	const open = useArtifactStore((s) => s.open);
	const [phase, setPhase] = useState<Phase>("idle");
	const [reason, setReason] = useState<string | null>(null);

	const isDeploy = proposal.operation.operation === "provision_project";

	const approve = async () => {
		track("elench_tool_approved", { tool: "propose_operation" });
		setPhase("running");
		setReason(null);
		try {
			const op = proposal.operation;
			const { jobId } =
				op.operation === "plan_project"
					? await planProject(op.projectId)
					: await provisionProject(op.projectId, op.planJobId);
			open({ projectId: op.projectId, jobId }, "logs");
			setPhase("done");
			onResolve?.({
				status: "approved",
				operation: op.operation,
				projectId: op.projectId,
				jobId,
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : "Operation failed.";
			setPhase("denied");
			setReason(message);
			onResolve?.({ status: "denied", reason: message });
		}
	};

	const reject = () => {
		track("elench_tool_denied", { tool: "propose_operation" });
		setPhase("rejected");
		onResolve?.({ status: "rejected" });
	};

	return (
		<div
			className={cn(
				"w-full border",
				phase === "denied" ? "border-border" : "border-foreground",
			)}
		>
			<div className="flex items-center gap-2.5 border-b border-border px-3.5 py-3">
				<span className="flex h-7 w-7 flex-none items-center justify-center border border-foreground">
					<ShieldCheck className="h-3.5 w-3.5" />
				</span>
				<div className="min-w-0">
					<div className="truncate text-ui-md font-medium">{proposal.label}</div>
					<div className="vx-eyebrow text-ui-3xs">
						{isDeploy ? "Provisions live infrastructure" : "Queues a plan"}
					</div>
				</div>
			</div>

			<div className="space-y-3 px-3.5 py-3">
				{proposal.stats && (
					/* One mono line, not a stat strip. §6 bans the strips with no qualifier, and
					   the reason is this card exactly: it asks for a decision, and a row of four
					   18px numbers takes the space above the Approve button to tell you what is
					   countable instead of what you are agreeing to. The same four facts read in
					   a sentence, at the weight of the sentence beside them. The money goes
					   through `formatMonthlyRate` in the `"exact"` register, so this card and the
					   plan panel's Est. cannot disagree about the symbol, the separators or the
					   cents. `"exact"` and not the default `"estimate"` because this IS the plan
					   panel's total — the agent is told to copy `costSummary.totalMonthlyCost`
					   into `stats.monthly`, and `artifact-panel` renders that same number exact.
					   On the default the two read `<$1/mo` against `$0.75/mo`, and `$0/mo`
					   against `$0.00/mo`, for one plan.

					   What `"exact"` does NOT buy is the sign: it clamps `<= 0`, so a negative
					   `monthly` renders `$0.00/mo` and a teardown's saving reads as nothing.
					   `stats.monthly` is declared to the model as an absolute total for that
					   reason (`lib/ai/operation.ts`); showing a saving would need a credit
					   register in `@repo/format`, which does not exist in either language. */
					<div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-ui-xs text-muted-foreground">
						<span className="text-foreground">
							{proposal.stats.add ?? 0} to add
						</span>
						<span aria-hidden>·</span>
						<span className="text-foreground">
							{proposal.stats.change ?? 0} to change
						</span>
						<span aria-hidden>·</span>
						<span className="text-foreground">
							{proposal.stats.destroy ?? 0} to destroy
						</span>
						{proposal.stats.monthly != null && (
							<>
								<span aria-hidden>·</span>
								<span className="text-foreground">
									{formatMonthlyRate(proposal.stats.monthly, "exact")} est.
								</span>
							</>
						)}
					</div>
				)}

				{phase === "done" ? (
					<div className="flex items-center gap-2 font-mono text-ui-xs text-muted-foreground">
						<span className="h-1.5 w-1.5 rounded-full bg-foreground" />
						{isDeploy ? "Approved · deploying…" : "Planning…"} — logs in the panel.
					</div>
				) : phase === "rejected" ? (
					<div className="font-mono text-ui-xs text-muted-foreground">
						Rejected.
					</div>
				) : phase === "denied" ? (
					<div className="flex items-start gap-2.5 border border-foreground bg-muted/40 px-3 py-2.5">
						<span className="mt-0.5 flex h-5 w-5 flex-none items-center justify-center border border-foreground">
							<X className="h-3 w-3" />
						</span>
						<div className="text-ui-sm leading-relaxed text-muted-foreground">
							<span className="font-medium text-foreground">
								Operation held back.
							</span>{" "}
							{reason}
						</div>
					</div>
				) : (
					<div className="flex items-center justify-between gap-3">
						<span className="text-ui-xs text-muted-foreground">
							{isDeploy
								? "The agent will apply the plan exactly as shown."
								: "Review the plan in the panel after it runs."}
						</span>
						<div className="flex flex-none gap-2">
							<Button
								variant="ghost"
								size="sm"
								className="h-8 rounded-none"
								disabled={phase === "running"}
								onClick={reject}
							>
								Reject
							</Button>
							<Button
								size="sm"
								className="h-8 gap-1.5 rounded-none"
								disabled={phase === "running"}
								onClick={approve}
							>
								<Check className="h-3.5 w-3.5" />
								{isDeploy ? "Approve & deploy" : "Approve & plan"}
							</Button>
						</div>
					</div>
				)}
			</div>
		</div>
	);
}
