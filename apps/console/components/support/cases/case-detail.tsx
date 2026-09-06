"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { SectionHeading } from "@repo/ui/section-heading";
import { formatBytes, formatDate } from "@repo/format";
import { Button } from "@repo/ui/button";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Download, Paperclip } from "lucide-react";
import Link from "next/link";
import { useEffect } from "react";
import { getCase } from "@/app/server/actions/support";
import { ClassificationControl } from "@/components/classification/classification-control";
import type { SupportAuthorType } from "@/lib/db/schema/enums";
import { qk } from "@/lib/query/keys";
import type { CaseWithThread, PublicMessage } from "@/lib/queries/support";
import {
	SUPPORT_CASE_TYPE_LABELS,
	SUPPORT_CATEGORY_LABELS,
} from "@/lib/validations/support";
import { CaseActions } from "./case-actions";
import { CaseComposer } from "./case-composer";
import { formatCaseNumber } from "./case-query";
import { CaseSeverityBadge } from "./case-severity-badge";
import { CaseStatusBadge } from "./case-status-badge";
import { CaseThread } from "./case-thread";

/** The JSON shape pushed over the case SSE stream (customer-visible messages only). */
interface StreamMessage {
	id: string;
	author_type: SupportAuthorType;
	author_name: string | null;
	body: string;
	created_at: string;
}

/**
 * The case-detail view: header (reference, subject, status/severity/type/category,
 * created date, lifecycle actions), the conversation thread, the reply composer, and the
 * attachment list. Reads the server-prefetched `getCase` cache, then subscribes to the
 * case SSE stream and pushes newly-arrived messages into that cache (deduped by id) so
 * staff/AI replies land live without a refetch.
 */
export function CaseDetail({
	caseId,
	orgSlug,
}: {
	caseId: string;
	orgSlug: string;
}) {
	const queryClient = useQueryClient();
	const { data } = useQuery({
		queryKey: qk.supportCase(caseId),
		queryFn: () => getCase(caseId),
	});

	// Live thread: append SSE messages into the case cache, deduped by message id.
	useEffect(() => {
		const source = new EventSource(`/api/stream/support/cases/${caseId}`);
		const key = qk.supportCase(caseId);

		source.onmessage = (event: MessageEvent<string>) => {
			let incoming: StreamMessage;
			try {
				incoming = JSON.parse(event.data);
			} catch {
				return;
			}
			queryClient.setQueryData<CaseWithThread | null>(key, (current) => {
				if (!current) return current;
				if (current.messages.some((m) => m.id === incoming.id)) return current;
				const message: PublicMessage = {
					id: incoming.id,
					case_id: caseId,
					author_type: incoming.author_type,
					author_id: null,
					author_name: incoming.author_name,
					body: incoming.body,
					created_at: new Date(incoming.created_at),
				};
				return { ...current, messages: [...current.messages, message] };
			});
		};

		return () => source.close();
	}, [caseId, queryClient]);

	if (!data) return null;

	const { case: supportCase, messages, attachments } = data;

	return (
		<div className="flex flex-col gap-6">
			{/* Header */}
			<div className="space-y-4">
				<Button
					variant="ghost"
					size="sm"
					className="-ml-2 h-7 w-fit text-muted-foreground"
					nativeButton={false}
					render={<Link href={`/${orgSlug}/~/support/my-cases`} />}
				>
					<ArrowLeft className="size-4" />
					My cases
				</Button>

				<div className="space-y-2">
					<div className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
						{formatCaseNumber(supportCase.case_number)}
					</div>
					{/* A section heading, not a page title. The console dropped its page titles because
					    the breadcrumb already says the route's name — but no breadcrumb will ever carry
					    a case SUBJECT: this route's last crumb is the case id, and the subject is the
					    thing the page is about. */}
					<SectionHeading
						title={supportCase.subject}
						description={
							<span className="flex flex-wrap items-center gap-2 text-xs">
								<CaseStatusBadge status={supportCase.status} />
								<CaseSeverityBadge severity={supportCase.severity} />
								<span>{SUPPORT_CASE_TYPE_LABELS[supportCase.type]}</span>
								<span aria-hidden>·</span>
								<span>{SUPPORT_CATEGORY_LABELS[supportCase.category]}</span>
								<span aria-hidden>·</span>
								<span>Opened {formatDate(supportCase.created_at)}</span>
							</span>
						}
						actions={<CaseActions caseId={caseId} status={supportCase.status} />}
					/>
					{/* Structured classification (Workstream B). The control shows a picker only
					    for org:edit holders (org taxonomy is an admin action), else read-only chips. */}
					<ClassificationControl kind="support_case" id={caseId} canEdit />
				</div>
			</div>

			{/* Attachments */}
			{attachments.length > 0 && (
				<div className="space-y-2 rounded-md border p-4">
					<div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
						<Paperclip className="size-3.5" />
						Attachments
					</div>
					<ul className="space-y-1">
						{attachments.map((att) => (
							<li key={att.id}>
								<a
									href={`/api/support/attachments/${att.id}`}
									className="flex items-center gap-2 text-sm text-foreground hover:underline"
								>
									<Download className="size-3.5 text-muted-foreground" />
									<span className="truncate">{att.file_name}</span>
									<span className="text-xs text-muted-foreground">
										{formatBytes(att.size_bytes)}
									</span>
								</a>
							</li>
						))}
					</ul>
				</div>
			)}

			{/* Thread */}
			<div className="rounded-md border">
				<CaseThread messages={messages} />
			</div>

			{/* Composer */}
			<CaseComposer caseId={caseId} caseStatus={supportCase.status} />
		</div>
	);
}
