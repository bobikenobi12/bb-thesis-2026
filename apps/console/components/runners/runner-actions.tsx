"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Runner action + version controls, shared by the runner card. Extracted from the
// former table columns when the runners list moved to cards.

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
import { Badge } from "@repo/ui/badge";
import { Button } from "@repo/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@repo/ui/tooltip";
import { ReleaseNotesPopover } from "@/components/runners/release-notes-popover";
import { RunnerSelectPopover } from "@/components/runners/runner-select-popover";
import {
  useRunnersQuery,
  useSetDefaultRunner,
  useDestroyRunner,
  useDeleteRunner,
  type ActiveJob,
  type RunnerWithRelease,
} from "@/lib/query/use-runners-query";
import { ArrowUpCircle, Loader2, Star } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

/** A runner decorated with its in-flight job (if any) — the unit the card renders. */
export type RunnerRow = RunnerWithRelease & {
  activeJob: ActiveJob | null;
};

/** The lifecycle job currently acting on a runner, or null when idle. */
export function runnerBusyKind(
  runner: RunnerRow,
): "DEPLOY_RUNNER" | "UPDATE_RUNNER" | "DESTROY_RUNNER" | null {
  const t = runner.activeJob?.job_type;
  if (
    t === "DEPLOY_RUNNER" ||
    t === "UPDATE_RUNNER" ||
    t === "DESTROY_RUNNER"
  ) {
    return t;
  }
  return null;
}

/** Version label for a runner with an inline popover of its release notes, plus an
 *  "update available" badge (also a popover, with the Update action) when outdated. */
export function RunnerVersion({ runner }: { runner: RunnerRow }) {
  const { data: runnersData } = useRunnersQuery();
  const latestRelease = runnersData?.latestRelease ?? null;

  const release = runner.runner_releases;
  const displayVersion = release?.version ?? runner.version;
  const isRelease = displayVersion && displayVersion !== "dev";
  const isOutdated =
    latestRelease && isRelease && displayVersion !== latestRelease.version;

  return (
    <span
      className="flex items-center gap-1.5"
      onClick={(e) => e.stopPropagation()}
    >
      {displayVersion ? (
        isRelease ? (
          <ReleaseNotesPopover version={displayVersion}>
            <button
              type="button"
              className="cursor-pointer font-mono text-xs text-muted-foreground transition-colors hover:text-foreground hover:underline"
            >
              v{displayVersion}
            </button>
          </ReleaseNotesPopover>
        ) : (
          <span className="font-mono text-xs text-muted-foreground">
            {displayVersion}
          </span>
        )
      ) : (
        <span className="font-mono text-xs text-muted-foreground">Unknown</span>
      )}
      {isOutdated && (
        <ReleaseNotesPopover
          version={latestRelease.version}
          runnerId={runner.id}
          isOutdated
        >
          <TooltipProvider delayDuration={300}>
            <Tooltip>
              <TooltipTrigger
                render={
                  <button type="button">
                    <Badge
                      variant="outline"
                      className="gap-1 cursor-pointer border-border bg-muted py-0 text-ui-2xs text-muted-foreground hover:bg-muted/80"
                    >
                      <ArrowUpCircle className="h-3 w-3" />v
                      {latestRelease.version}
                    </Badge>
                  </button>
                }
              />
              <TooltipContent side="top" className="text-xs">
                Click to view release notes
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </ReleaseNotesPopover>
      )}
    </span>
  );
}

/** The default-star toggle + destroy/remove controls for a runner. While a lifecycle job
 *  is in flight it renders a link to that job instead. */
export function RunnerActions({ runner }: { runner: RunnerRow }) {
  const router = useRouter();
  const { mutateAsync: setDefaultRunner } = useSetDefaultRunner();
  const { mutateAsync: destroyRunner } = useDestroyRunner();
  const { mutateAsync: deleteRunner } = useDeleteRunner();
  const [showRemoveDialog, setShowRemoveDialog] = useState(false);
  const [acting, setActing] = useState(false);
  const [destroying, setDestroying] = useState(false);

  const isManaged = runner.operator === "managed";
  const busy = runnerBusyKind(runner);
  const hasCloudResources =
    !!runner.cloud_identity_id && !!runner.metadata?.deploy_config;

  const handleToggleDefault = async () => {
    try {
      const newValue = !runner.is_default;
      await setDefaultRunner(newValue ? runner.id : null);
      toast.success(
        newValue ? `${runner.name} set as default` : "Default runner cleared",
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update");
    }
  };

  const handleDestroy = async (assignedRunnerId: string | null) => {
    setDestroying(true);
    try {
      const { jobId } = await destroyRunner({
        runnerId: runner.id,
        assignedRunnerId,
      });
      toast.success("Destroy job queued", {
        action: {
          label: "View job",
          onClick: () => router.push(`/dashboard/jobs/${jobId}`),
        },
      });
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to queue destroy",
      );
      setDestroying(false);
    }
  };

  const handleRemove = async () => {
    setActing(true);
    try {
      await deleteRunner(runner.id);
      toast.success(`${runner.name} removed`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to remove");
    } finally {
      setActing(false);
      setShowRemoveDialog(false);
    }
  };

  if (busy && runner.activeJob) {
    const label =
      busy === "DEPLOY_RUNNER"
        ? "Provisioning…"
        : busy === "UPDATE_RUNNER"
          ? "Updating…"
          : "Destroying…";
    return (
      <Link
        href={`/dashboard/jobs/${runner.activeJob.id}`}
        onClick={(e) => e.stopPropagation()}
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground hover:underline"
      >
        <Loader2 className="h-3 w-3 animate-spin" />
        {label}
      </Link>
    );
  }

  return (
    <div
      className="flex items-center gap-1"
      onClick={(e) => e.stopPropagation()}
    >
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                onClick={handleToggleDefault}
                className="rounded p-1 transition-colors hover:bg-muted"
              >
                <Star
                  className={`h-3.5 w-3.5 ${runner.is_default ? "fill-foreground text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                />
              </button>
            }
          />
          <TooltipContent side="top" className="text-xs">
            {runner.is_default ? "Clear default" : "Set as default"}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>

      {!isManaged &&
        runner.provisioning === "deployed" &&
        hasCloudResources && (
          <RunnerSelectPopover
            trigger={
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive"
                disabled={destroying}
              >
                {destroying ? "Destroying…" : "Destroy"}
              </Button>
            }
            variant="destructive"
            confirmLabel="Destroy"
            description={`This will tear down all cloud resources for "${runner.name}" and delete the runner. This cannot be undone.`}
            excludeId={runner.id}
            onConfirm={handleDestroy}
            disabled={destroying}
          />
        )}

      {!isManaged &&
        !(runner.provisioning === "deployed" && hasCloudResources) && (
          <>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive"
              onClick={() => setShowRemoveDialog(true)}
            >
              Remove
            </Button>

            <AlertDialog
              open={showRemoveDialog}
              onOpenChange={(open) => !open && setShowRemoveDialog(false)}
            >
              <AlertDialogContent onClick={(e) => e.stopPropagation()}>
                <AlertDialogHeader>
                  <AlertDialogTitle>
                    Remove runner &ldquo;{runner.name}&rdquo;?
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    This will remove the runner record from the database. This
                    cannot be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel disabled={acting}>
                    Cancel
                  </AlertDialogCancel>
                  <AlertDialogAction
                    onClick={handleRemove}
                    disabled={acting}
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  >
                    {acting ? "Removing..." : "Remove"}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </>
        )}
    </div>
  );
}
