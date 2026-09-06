"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { ArrowUpRight, Check, LifeBuoy, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { submitCase } from "@/app/server/actions/support";
import type { SupportCaseProposal } from "@/lib/ai/support/case";
import { Button } from "@repo/ui/button";
import { cn } from "@repo/ui/utils";

type Phase = "idle" | "running" | "done" | "rejected" | "denied";

/**
 * HITL approval for an assistant-proposed support case. Approve calls the
 * `submitCase` server action (the model only PROPOSED the case; the write happens on
 * the user's click, mirroring the plan/deploy `ApprovalCard`) and then links to the
 * created case at `/{org}/~/support/cases/{id}`. A failure surfaces the action's error.
 */
export function SupportCaseApprovalCard({
	proposal,
	orgSlug,
	onResolve,
}: {
	proposal: SupportCaseProposal;
	orgSlug: string;
	/** Feed the outcome back to the model (closes the HITL loop → it continues). */
	onResolve?: (output: unknown) => void;
}) {
	const router = useRouter();
	const [phase, setPhase] = useState<Phase>("idle");
	const [reason, setReason] = useState<string | null>(null);
	const [caseNumber, setCaseNumber] = useState<number | null>(null);
	const [caseId, setCaseId] = useState<string | null>(null);

	const approve = async () => {
		setPhase("running");
		setReason(null);
		try {
			const { id, caseNumber } = await submitCase({
				type: proposal.type,
				category: proposal.category,
				severity: proposal.severity,
				subject: proposal.subject,
				description: proposal.description,
				context: proposal.context ?? {},
			});
			setCaseId(id);
			setCaseNumber(caseNumber);
			setPhase("done");
			onResolve?.({ status: "submitted", caseId: id, caseNumber });
		} catch (err) {
			const message = err instanceof Error ? err.message : "Could not open the case.";
			setPhase("denied");
			setReason(message);
			onResolve?.({ status: "failed", reason: message });
		}
	};

	const dismiss = () => {
		setPhase("rejected");
		onResolve?.({ status: "dismissed" });
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
					<LifeBuoy className="h-3.5 w-3.5" />
				</span>
				<div className="min-w-0">
					<div className="truncate text-ui-md font-medium">{proposal.subject}</div>
					<div className="vx-eyebrow text-ui-3xs">
						{proposal.type} · {proposal.category} · {proposal.severity}
					</div>
				</div>
			</div>

			<div className="space-y-3 px-3.5 py-3">
				<p className="whitespace-pre-wrap text-ui-sm leading-relaxed text-muted-foreground">
					{proposal.description}
				</p>

				{phase === "done" ? (
					<div className="flex items-center justify-between gap-3">
						<div className="flex items-center gap-2 font-mono text-ui-xs text-muted-foreground">
							<span className="h-1.5 w-1.5 rounded-full bg-foreground" />
							Case {caseNumber != null ? `#${caseNumber}` : ""} opened.
						</div>
						{caseId && (
							<Button
								size="sm"
								className="h-8 gap-1.5 rounded-none"
								onClick={() =>
									router.push(`/${orgSlug}/~/support/cases/${caseId}`)
								}
							>
								View case
								<ArrowUpRight className="h-3.5 w-3.5" />
							</Button>
						)}
					</div>
				) : phase === "rejected" ? (
					<div className="font-mono text-ui-xs text-muted-foreground">
						Dismissed.
					</div>
				) : phase === "denied" ? (
					<div className="flex items-start gap-2.5 border border-foreground bg-muted/40 px-3 py-2.5">
						<span className="mt-0.5 flex h-5 w-5 flex-none items-center justify-center border border-foreground">
							<X className="h-3 w-3" />
						</span>
						<div className="text-ui-sm leading-relaxed text-muted-foreground">
							<span className="font-medium text-foreground">
								Case not opened.
							</span>{" "}
							{reason}
						</div>
					</div>
				) : (
					<div className="flex items-center justify-between gap-3">
						<span className="text-ui-xs text-muted-foreground">
							Review the details, then submit this case to support.
						</span>
						<div className="flex flex-none gap-2">
							<Button
								variant="ghost"
								size="sm"
								className="h-8 rounded-none"
								disabled={phase === "running"}
								onClick={dismiss}
							>
								Dismiss
							</Button>
							<Button
								size="sm"
								className="h-8 gap-1.5 rounded-none"
								disabled={phase === "running"}
								onClick={approve}
							>
								<Check className="h-3.5 w-3.5" />
								Submit case
							</Button>
						</div>
					</div>
				)}
			</div>
		</div>
	);
}
