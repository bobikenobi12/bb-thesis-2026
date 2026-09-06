"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { cancelJob, rerunJob } from "@/app/server/actions/jobs";
import { provisionProject } from "@/app/server/actions/projects";
import { JOB_TYPES } from "@/components/jobs/columns";
import { RunnerSelectPopover } from "@/components/runners/runner-select-popover";
// `FactList`/`Fact` are the console's ONE label-and-value list. They live under `settings/usage`
// because that is where they were first needed, and this page is their second consumer — which is
// the argument for #3628 promoting them into `@repo/ui` beside `SectionHeading`. That promotion is
// one shared decision across two lanes and is deliberately NOT taken here; importing them is what
// keeps this page from becoming the third rendering of a term and its value.
import { Fact, FactList } from "@/components/settings/usage/usage-primitives";
import { useJobLogStream } from "@/hooks/use-job-log-stream";
import { useJobQuery } from "@/lib/query/use-jobs-query";
import { formatDate, formatDuration, formatRelative } from "@repo/format";
import { Button } from "@repo/ui/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@repo/ui/collapsible";
import { EmptyState } from "@repo/ui/empty";
import { PageToolbar } from "@repo/ui/page-toolbar";
import { ScrollArea } from "@repo/ui/scroll-area";
import { SectionHeading } from "@repo/ui/section-heading";
import { StatusBadge } from "@repo/ui/status-badge";
import { cn } from "@repo/ui/utils";
import {
	Ban,
	CheckCircle2,
	ChevronRight,
	Loader2,
	RefreshCw,
	Rocket,
	SearchX,
	Terminal,
	XCircle,
} from "lucide-react";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { JOB_DETAIL_COLUMN, JOB_VIEWPORT_HEIGHT } from "./detail-column";

/**
 * One collapsible block of the job's detail column — a real heading over a disclosure.
 *
 * The three blocks used to be three copies of a bare `<button>` carrying a 12px label, so nothing
 * on this page appeared in the document outline at all: a screen reader moving by heading skipped
 * from the breadcrumb to the end of the page. The heading is `SectionHeading` and the button lives
 * INSIDE it, which is the accordion pattern that keeps both — a heading you can navigate to, and a
 * control that says whether it is open. The reverse nesting (a heading inside a button) is what a
 * "make the whole row clickable" instinct produces and it is invalid content: a `<button>` takes
 * phrasing content, and it swallows the heading it contains.
 */
function DetailSection({ title, children }: { title: string; children: ReactNode }) {
	return (
		<Collapsible className="border-b border-border/40 last:border-b-0">
			{/* TWO hops, and both are needed — `[&>div]:w-full` alone leaves the target as small as
			    the label. `SectionHeading` nests `div > div.flex-col > div.flex-row > h2 > {title}`.
			    The first selector widens the direct child column, and the row inside it stretches on
			    its own (a `flex-col` parent's cross axis). But the `<h2>` is a flex ITEM of that row,
			    so it is `flex-grow: 0` and sized to its content — and the trigger's own `w-full`
			    resolves against exactly that box. `[&_h2]:flex-1` is what makes the heading claim the
			    row; `min-w-0` is what lets its `truncate` still shorten instead of overflowing. Without
			    the pair, four fifths of the row is dead — a smaller target than the full-width
			    `<button>` this replaced, and every other Collapsible in the console keeps `w-full`.
			    (`CountPill` renders null at this call site, so nothing else competes for the row.) */}
			<SectionHeading
				className="py-2.5 [&>div]:w-full [&_h2]:min-w-0 [&_h2]:flex-1"
				level={2}
				title={
					// `ring-inset`, and it is load-bearing: `SectionHeading` renders its heading with
					// `truncate` (`overflow: hidden`), so a default focus outline — drawn OUTSIDE the
					// button's border box — is clipped on all four sides and the control becomes
					// invisible to a keyboard. An inset ring is drawn inside the box and survives.
					<CollapsibleTrigger className="group flex w-full items-center gap-2 rounded-sm text-left text-text-secondary transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
						{/* `data-panel-open`, NOT `data-state=open`: `@repo/ui/collapsible` is base-ui,
						    which renamed the attribute, and the Tailwind variant that reads the Radix
						    name compiles to a selector nothing ever matches — a chevron that silently
						    never turns. Its own header records the rename. */}
						<ChevronRight className="size-3 shrink-0 transition-transform group-data-[panel-open]:rotate-90" />
						{title}
					</CollapsibleTrigger>
				}
			/>
			<CollapsibleContent className="pb-4">{children}</CollapsibleContent>
		</Collapsible>
	);
}

/** A pretty-printed JSONB payload — the config snapshot and the execution metadata. */
function JsonBlock({ value }: { value: unknown }) {
	return (
		<pre className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded-md border bg-muted/30 p-3 font-mono text-ui-xs text-text-tertiary">
			{JSON.stringify(value, null, 2)}
		</pre>
	);
}

/**
 * Full-page job detail view with realtime log streaming (SSE).
 *
 * THE FRAME IS HYBRID, and `detail-column.ts` carries the reason: the log runs the full width of
 * the shell's frame while everything else — the status line, the outcome, the job's facts and the
 * two JSON payloads — sits in a narrower centred column, because one of those is scanned and the
 * rest are read.
 */
export default function JobDetailPage() {
	const { org, id: jobId } = useParams<{ org: string; id: string }>();
	const router = useRouter();

	// The job row (status + error_message included) comes from the shared query, which
	// polls every 3s while in-flight and idles on terminal status.
	const { data: job, isPending: isLoading, refetch } = useJobQuery(jobId);
	const jobState = job?.status ?? null;
	const jobError = job?.error_message ?? null;
	const { logs } = useJobLogStream(jobId);
	const [actionLoading, setActionLoading] = useState(false);

	const bottomRef = useRef<HTMLDivElement>(null);

	const scrollToBottom = useCallback(() => {
		setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }), 100);
	}, []);

	// Auto-scroll as streamed logs (from useJobLogStream) arrive.
	useEffect(() => {
		if (logs.length > 0) scrollToBottom();
	}, [logs.length, scrollToBottom]);

	const handleRerun = async () => {
		if (!jobId) return;
		setActionLoading(true);
		try {
			const newJob = await rerunJob(jobId);
			toast.success("Job re-queued");
			router.push(`/${org}/~/jobs/${newJob.id}`);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Failed to re-run");
			setActionLoading(false);
		}
	};

	const handleCancel = async () => {
		if (!jobId) return;
		setActionLoading(true);
		try {
			await cancelJob(jobId);
			await refetch();
			toast.success("Job cancelled");
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Failed to cancel");
		} finally {
			setActionLoading(false);
		}
	};

	const handleApply = async (runnerId: string | null) => {
		if (!job?.project_id || !jobId) return;
		setActionLoading(true);
		try {
			const { jobId: deployJobId } = await provisionProject(job.project_id, jobId, runnerId);
			toast.success("Deploy job created");
			router.push(`/${org}/~/jobs/${deployJobId}`);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Failed to apply");
			setActionLoading(false);
		}
	};

	const isActive = jobState === "QUEUED" || jobState === "CLAIMED" || jobState === "PROCESSING";
	const isTerminal = jobState === "SUCCESS" || jobState === "FAILED" || jobState === "CANCELLED";
	const isPlanSuccess = job?.job_type === "PLAN" && jobState === "SUCCESS";
	const info = job ? JOB_TYPES[job.job_type] : null;
	const Icon = info?.icon;

	// The FOURTH copy of the duration rendering used to live here, inline and byte-different from
	// the other three: no roll into hours, and no guard, so a `created_at` a second ahead of the
	// browser clock rendered `-1s` and an unparseable one `NaNs`. It defers to `@repo/format` now,
	// which is the whole point of there being one ruling.
	const duration = () => {
		if (!job?.created_at) return null;
		const end = job.completed_at ? new Date(job.completed_at) : new Date();
		return formatDuration(end.getTime() - new Date(job.created_at).getTime());
	};

	if (isLoading) {
		return (
			<div className="flex h-full min-h-[50dvh] items-center justify-center">
				<Loader2 className="size-6 animate-spin text-muted-foreground" />
			</div>
		);
	}

	if (!job) {
		// The bare "Job not found." paragraph this replaces was the console's smallest empty state
		// and its least useful: a slug someone pasted wrong, an org they are no longer in and a job
		// that was deleted all rendered the same four words with nowhere to go from them. The
		// SENTENCE IS KEPT VERBATIM, trailing full stop and all, because `deploy-jobs.negative.spec`
		// asserts it exactly — this issue's scope is the component these states are built from, not
		// the words in them, and quietly rewriting copy an out-of-scope spec pins is how a lane
		// lands green and reds the QA run instead.
		return (
			<EmptyState
				className="min-h-[50dvh]"
				icon={<SearchX />}
				level={2}
				title="Job not found."
				description="This job has been deleted, or it belongs to an organisation you are not a member of."
				action={
					// `render` + `nativeButton={false}`, not `asChild`: `@repo/ui/button` is base-ui,
					// which has no `asChild` prop at all — it would not compile.
					<Button
						variant="outline"
						size="sm"
						nativeButton={false}
						render={<Link href={`/${org}/~/jobs`} />}
					>
						Back to jobs
					</Button>
				}
			/>
		);
	}

	return (
		<div className={cn("-m-4 flex flex-col sm:-m-6 lg:-m-8 xl:-m-10", JOB_VIEWPORT_HEIGHT)}>
			{/* Status header — the bar spans the frame, its contents sit in the detail column. */}
			<header className="shrink-0 border-b border-border/40 bg-muted/5 px-6 py-4">
				<div className={JOB_DETAIL_COLUMN}>
					<div className="flex items-start gap-3">
						{Icon && <Icon className="mt-0.5 size-5 shrink-0 text-muted-foreground" />}
						{/* No title: the breadcrumb resolves this job's UUID to the very same
						    `JOB_TYPES[...].label` this row used to repeat under it. What is left is the
						    job's live state and its actions, which the breadcrumb carries none of. */}
						<PageToolbar
							className="min-w-0 flex-1"
							description={
								<span className="flex flex-wrap items-center gap-x-2 gap-y-1">
									<StatusBadge status={jobState ?? job.status} />
									{duration() && <span>{duration()}</span>}
									<span className="font-mono">{job.id.slice(0, 8)}</span>
									{job.runner_id && (
										<span>
											· Runner <span className="font-mono">{job.runner_id.slice(0, 8)}</span>
										</span>
									)}
									{job.created_at && <span>· {formatRelative(job.created_at)}</span>}
								</span>
							}
							actions={
								<>
									{isActive && (
										<Button
											variant="outline"
											size="sm"
											className="h-8 text-destructive hover:text-destructive"
											onClick={handleCancel}
											disabled={actionLoading}
										>
											{actionLoading ? (
												<Loader2 className="mr-1.5 size-3.5 animate-spin" />
											) : (
												<Ban className="mr-1.5 size-3.5" />
											)}
											Cancel
										</Button>
									)}
									{isPlanSuccess && job.project_id && (
										<RunnerSelectPopover
											trigger={
												<Button size="sm" className="h-8" disabled={actionLoading}>
													<Rocket className="mr-1.5 size-3.5" />
													Apply
												</Button>
											}
											onConfirm={handleApply}
											disabled={actionLoading}
										/>
									)}
									{isTerminal && (
										<Button
											variant="outline"
											size="sm"
											className="h-8"
											onClick={handleRerun}
											disabled={actionLoading}
										>
											{actionLoading ? (
												<Loader2 className="mr-1.5 size-3.5 animate-spin" />
											) : (
												<RefreshCw className="mr-1.5 size-3.5" />
											)}
											Re-run
										</Button>
									)}
								</>
							}
						/>
					</div>

					{/* The outcome, next to the status it explains rather than below the log. A failure
					    message is bounded: an OpenTofu error can run to hundreds of lines, and letting
					    it grow here would push the log — the thing the page is for — off the screen. */}
					{jobState === "SUCCESS" && (
						<p className="mt-3 flex items-center gap-2 text-ui-md text-text-secondary">
							<CheckCircle2 className="size-4 shrink-0" />
							Job completed successfully.
						</p>
					)}
					{(jobState === "FAILED" || jobState === "CANCELLED") && (
						<div
							className={cn(
								"mt-3 rounded-md border px-3 py-2",
								jobState === "FAILED"
									? "border-destructive/30 bg-destructive/5"
									: "border-border bg-muted/30",
							)}
						>
							<p className="flex items-center gap-2 text-ui-md font-medium text-text-primary">
								{jobState === "FAILED" ? (
									<XCircle className="size-4 shrink-0 text-destructive" />
								) : (
									<Ban className="size-4 shrink-0 text-text-tertiary" />
								)}
								{jobState === "FAILED" ? "Job failed" : "Job cancelled"}
							</p>
							{jobError && (
								<p className="mt-1 max-h-24 overflow-y-auto break-all pl-6 text-ui-xs text-text-tertiary">
									{jobError}
								</p>
							)}
						</div>
					)}
				</div>
			</header>

			{/* The log — the ONE region that does not obey the detail column. See detail-column.ts. */}
			<div className="flex-1 overflow-hidden bg-muted/20 font-mono text-xs">
				<ScrollArea className="h-full w-full p-6">
					{logs.length === 0 && isActive ? (
						<EmptyState
							className="min-h-[40dvh] font-sans"
							icon={<Loader2 className="animate-spin" />}
							title="Waiting for runner to claim job"
							description="The runner polls every 10 seconds. Logs will appear here automatically."
						/>
					) : logs.length === 0 ? (
						<EmptyState
							className="min-h-[40dvh] font-sans"
							icon={<Terminal />}
							title="No logs recorded for this job."
						/>
					) : (
						<div className="pb-10">
							{logs.map((log, i) => (
								<div
									key={`${log.id}-${i}`}
									className="group flex gap-4 rounded px-2 py-0.5 transition-colors hover:bg-muted/40"
								>
									<span className="w-8 shrink-0 select-none text-right text-muted-foreground/40">
										{i + 1}
									</span>
									<span className="w-[85px] shrink-0 select-none text-muted-foreground/60">
										{formatDate(log.created_at || Date.now(), "time")}
									</span>
									<span
										className={cn(
											"break-all leading-relaxed",
											log.stream_type === "STDERR" || log.stream_type === "stderr"
												? "text-destructive"
												: "text-foreground/80",
										)}
									>
										{log.log_chunk}
									</span>
								</div>
							))}
							<div ref={bottomRef} />
							{isActive && (
								<div className="mt-2 flex gap-4 px-2">
									<span className="w-8" />
									<span className="w-[85px]" />
									<span className="block h-4 w-2 animate-pulse bg-muted-foreground/30" />
								</div>
							)}
						</div>
					)}
				</ScrollArea>
			</div>

			{/* The job's facts and its frozen payloads — back inside the detail column. */}
			<div className="max-h-[40dvh] shrink-0 overflow-y-auto border-t border-border/40 px-6">
				<div className={JOB_DETAIL_COLUMN}>
					<DetailSection title="Job details">
						{/* A `<dl>`, not the `grid grid-cols-2 md:grid-cols-3` of unlabelled `<p>` pairs
						    this replaces: assistive tech had no way to tell which value belonged to
						    which term, and on a narrow window the two-column wrap put them in an order
						    that did not read at all.

						    `Fact` TYPESETS EVERY VALUE IN MONO, and that is accepted here rather than
						    worked around. The grid this replaces was mixed — mono for the three ids,
						    proportional for the type and the three timestamps — and six of these seven
						    values are an identifier or a timestamp, both of which read BETTER in a
						    column that aligns. Only `Type` is prose, and one row of prose is not worth
						    either a `font-sans` override at the call site or a new prop on a component
						    #3628 is deciding the future of. */}
						<div className="overflow-hidden rounded-md border border-border">
							<FactList>
								<Fact label="Job ID" value={job.id} />
								<Fact label="Type" value={info?.label ?? job.job_type} />
								<Fact label="Runner" value={job.runner_id ?? "—"} />
								<Fact label="Created" value={formatDate(job.created_at, "datetime")} />
								<Fact label="Started" value={formatDate(job.started_at, "datetime")} />
								<Fact label="Completed" value={formatDate(job.completed_at, "datetime")} />
								{job.project_id && <Fact label="Project" value={job.project_id} />}
							</FactList>
						</div>
					</DetailSection>

					{Object.keys(job.config_snapshot || {}).length > 0 && (
						<DetailSection title="Config snapshot">
							<JsonBlock value={job.config_snapshot} />
						</DetailSection>
					)}

					{job.execution_metadata && Object.keys(job.execution_metadata).length > 0 && (
						<DetailSection title="Execution metadata">
							<JsonBlock value={job.execution_metadata} />
						</DetailSection>
					)}
				</div>
			</div>
		</div>
	);
}
