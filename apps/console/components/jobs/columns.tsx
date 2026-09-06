"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { StatusBadge } from "@repo/ui/status-badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@repo/ui/tooltip";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@repo/ui/hover-card";
import { PROVIDER_LABELS, ProviderIcon } from "@repo/ui/provider-icon";
import { lookup } from "@/lib/typed-object";
import type { JobWithMeta } from "@/app/server/actions/jobs";
import type { ProvisionJobStatus, ProvisionJobType } from "@/lib/db/schema";
import { formatDuration, formatRelative } from "@repo/format";
import { JOB_TYPES } from "@/lib/jobs/format";
import { JobAuthor, type JobAuthorInfo } from "@/components/jobs/job-author";
import { ReleaseNotesPopover } from "@/components/runners/release-notes-popover";
import { projectHref } from "@/lib/routing";
import type { ColumnDef } from "@tanstack/react-table";
import { ArrowRight, Layers, Server } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

export { JOB_TYPES };

/** A job row enriched with joined project/runner/provider/environment data from getJobs(). */
type JobRow = JobWithMeta;

const RUNNING = new Set(["QUEUED", "CLAIMED", "PROCESSING"]);

/** Ticks once a second so an in-flight job's elapsed time stays live. */
function LiveDuration({ createdAt }: { createdAt: Date | string }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <span className="text-xs tabular-nums text-muted-foreground">
      {formatDuration(Date.now() - new Date(createdAt).getTime())}
    </span>
  );
}

/** Renders a grayscale job status, with a tooltip surfacing the error on FAILED. */
function JobStatus({
  status,
  errorMessage,
}: {
  status: ProvisionJobStatus;
  errorMessage?: string | null;
}) {
  const badge = <StatusBadge status={status} />;
  if (status === "FAILED" && errorMessage) {
    const truncated =
      errorMessage.length > 120
        ? `${errorMessage.slice(0, 120)}...`
        : errorMessage;
    return (
      <Tooltip>
        <TooltipTrigger render={badge} />
        <TooltipContent side="top" className="max-w-xs text-xs">
          {truncated}
        </TooltipContent>
      </Tooltip>
    );
  }
  return badge;
}

/**
 * The Project cell — the provider logo (full color when the job's cloud identity is connected,
 * grayscale otherwise) + a truncating project name, wrapped in a HoverCard that surfaces the
 * provider and a link to open the project. Rows are clickable, so the trigger stops propagation.
 */
function ProjectCell({
  orgSlug,
  projectName,
  projectSlug,
  provider,
  connected,
}: {
  orgSlug: string;
  projectName: string | null;
  projectSlug: string | null;
  provider: string | null;
  connected: boolean;
}) {
  const icon = provider ? (
    <ProviderIcon
      provider={provider}
      size={18}
      mono={!connected}
      className="shrink-0"
    />
  ) : null;

  // No project (e.g. an org-level job) — nothing to link to, so skip the hover card.
  if (!projectName) {
    return (
      <div className="flex items-center gap-1.5">
        {icon}
        <span className="text-xs text-muted-foreground">—</span>
      </div>
    );
  }

  const label = provider
    ? (lookup(PROVIDER_LABELS, provider) ?? provider)
    : null;

  return (
    <HoverCard>
      <HoverCardTrigger
        delay={150}
        closeDelay={80}
        render={
          <button
            type="button"
            onClick={(e) => e.stopPropagation()}
            className="flex min-w-0 max-w-[220px] items-center gap-1.5 text-left"
          >
            {icon}
            <span className="truncate text-xs font-medium text-foreground">
              {projectName}
            </span>
          </button>
        }
      />
      <HoverCardContent align="start" className="w-64 p-3">
        <div className="flex items-center gap-2">
          {provider && (
            <ProviderIcon
              provider={provider}
              size={22}
              mono={!connected}
              className="shrink-0"
            />
          )}
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-foreground">
              {projectName}
            </p>
            {label && (
              <p className="text-ui-xs text-muted-foreground">{label}</p>
            )}
          </div>
        </div>
        {projectSlug && (
          <Link
            href={projectHref(orgSlug, projectSlug)}
            onClick={(e) => e.stopPropagation()}
            className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-foreground hover:underline"
          >
            Open project
            <ArrowRight className="size-3" />
          </Link>
        )}
      </HoverCardContent>
    </HoverCard>
  );
}

/**
 * The Runner cell — the runner name; for a real release version (not `dev`), it's a button that
 * opens the release-notes / changelog popover (the same one the runners table uses). Stops row
 * propagation so opening the popover doesn't navigate to the job.
 */
function RunnerCell({
  runnerId,
  runnerName,
  runnerVersion,
}: {
  runnerId: string | null;
  runnerName: string | null;
  runnerVersion: string | null;
}) {
  if (!runnerId && !runnerName)
    return <span className="text-xs text-muted-foreground">—</span>;

  const name = runnerName ?? runnerId?.slice(0, 8);
  const isRelease = Boolean(runnerVersion) && runnerVersion !== "dev";

  if (!isRelease) {
    return (
      <div className="flex items-center gap-1.5">
        <Server className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="text-xs text-foreground">{name}</span>
        {runnerVersion && (
          <span className="font-mono text-ui-2xs text-muted-foreground">
            {runnerVersion}
          </span>
        )}
      </div>
    );
  }

  return (
    <span className="inline-flex" onClick={(e) => e.stopPropagation()}>
      <ReleaseNotesPopover version={runnerVersion}>
        <button type="button" className="flex items-center gap-1.5 text-left">
          <Server className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="text-xs text-foreground hover:underline">
            {name}
          </span>
          <span className="font-mono text-ui-2xs text-muted-foreground">
            v{runnerVersion}
          </span>
        </button>
      </ReleaseNotesPopover>
    </span>
  );
}

/**
 * The jobs table columns. `showProject` is false in a project-scoped context (the project is
 * implied). `authorById` resolves each job's initiator to the org-member identity for the avatar.
 * `orgSlug` builds the project link in the Project cell's hover card.
 */
export function buildJobColumns({
  showProject = true,
  authorById,
  orgSlug,
}: {
  showProject?: boolean;
  authorById: Map<string, JobAuthorInfo>;
  orgSlug: string;
}): ColumnDef<JobRow>[] {
  const columns: ColumnDef<JobRow>[] = [
    {
      accessorKey: "job_type",
      header: "Type",
      enableSorting: true,
      cell: ({ row }) => {
        const type = row.getValue<ProvisionJobType>("job_type");
        const info = JOB_TYPES[type];
        if (!info) return <span className="text-xs">{type}</span>;
        const Icon = info.icon;
        return (
          <div className="flex items-center gap-2">
            <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <span className="text-xs font-medium">{info.label}</span>
              <p className="hidden text-ui-2xs text-muted-foreground sm:block">
                {info.description}
              </p>
            </div>
          </div>
        );
      },
    },
    {
      accessorKey: "status",
      header: "Status",
      enableSorting: true,
      cell: ({ row }) => {
        const { status, created_at, completed_at, error_message } =
          row.original;
        const running = !completed_at && RUNNING.has(status);
        return (
          <div className="flex items-center gap-2">
            <JobStatus status={status} errorMessage={error_message} />
            {created_at && running ? (
              <LiveDuration createdAt={created_at} />
            ) : created_at && completed_at ? (
              <span className="text-xs tabular-nums text-muted-foreground">
                {formatDuration(
                  new Date(completed_at).getTime() -
                    new Date(created_at).getTime(),
                )}
              </span>
            ) : null}
          </div>
        );
      },
    },
  ];

  if (showProject) {
    columns.push({
      accessorKey: "project_id",
      header: "Project",
      enableSorting: false,
      cell: ({ row }) => {
        const {
          project_name,
          project_slug,
          cloud_provider,
          cloud_identity_status,
        } = row.original;
        // A degraded identity authenticated fine (it just lacks some provisioning
        // permissions) — it still counts as connected for the color treatment.
        const connected =
          cloud_identity_status === "connected" ||
          cloud_identity_status === "degraded";
        return (
          <ProjectCell
            orgSlug={orgSlug}
            projectName={project_name}
            projectSlug={project_slug}
            provider={cloud_provider}
            connected={connected}
          />
        );
      },
    });
  }

  columns.push(
    {
      accessorKey: "runner_id",
      header: "Runner",
      enableSorting: false,
      cell: ({ row }) => {
        const { runner_id, runner_name, runner_version } = row.original;
        return (
          <RunnerCell
            runnerId={runner_id}
            runnerName={runner_name}
            runnerVersion={runner_version}
          />
        );
      },
    },
    {
      id: "environment",
      header: "Environment",
      enableSorting: false,
      cell: ({ row }) => {
        const { environment_name } = row.original;
        if (!environment_name)
          return <span className="text-xs text-muted-foreground">—</span>;
        return (
          <div className="flex items-center gap-1.5">
            <Layers className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="text-xs text-foreground">{environment_name}</span>
          </div>
        );
      },
    },
    {
      id: "when",
      header: "Initiated",
      enableSorting: true,
      accessorFn: (row) => row.created_at,
      cell: ({ row }) => {
        const { created_at, user_id } = row.original;
        const author = user_id ? (authorById.get(user_id) ?? null) : null;
        return (
          <div className="flex items-center justify-end gap-2">
            {created_at && (
              <span className="whitespace-nowrap text-xs text-muted-foreground">
                {formatRelative(created_at)}
              </span>
            )}
            <JobAuthor author={author} />
          </div>
        );
      },
    },
  );

  return columns;
}
