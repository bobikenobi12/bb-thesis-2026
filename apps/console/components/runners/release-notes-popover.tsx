"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Popover, PopoverContent, PopoverTrigger } from "@repo/ui/popover";
import { ScrollArea } from "@repo/ui/scroll-area";
import { Button } from "@repo/ui/button";
import { Badge } from "@repo/ui/badge";
import { StatusBadge } from "@repo/ui/status-badge";
import { Skeleton } from "@repo/ui/skeleton";
import { getReleaseNotes } from "@/app/server/actions/runners";
import {
  useUpdateRunner,
  type RunnerReleaseInfo,
} from "@/lib/query/use-runners-query";
import { formatRelative } from "@repo/format";
import { ArrowUpCircle, ExternalLink, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import { toast } from "sonner";

interface ReleaseNotesPopoverProps {
  /** The version whose notes to show; null disables the popover. */
  version: string | null;
  /** When set with `isOutdated`, shows an "Update Runner" action. */
  runnerId?: string;
  isOutdated?: boolean;
  /** The clickable trigger (e.g. the version cell button). */
  children: React.ReactElement<Record<string, unknown>>;
}

/** Popover showing release notes for a specific runner version. Replaces the former modal
 *  dialog — opens inline from the version cell, with long notes in a scroll area. */
export function ReleaseNotesPopover({
  version,
  runnerId,
  isOutdated,
  children,
}: ReleaseNotesPopoverProps) {
  const router = useRouter();
  const { mutateAsync: updateRunner } = useUpdateRunner();
  const [open, setOpen] = useState(false);
  const [release, setRelease] = useState<RunnerReleaseInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [updating, setUpdating] = useState(false);

  useEffect(() => {
    if (!open || !version) {
      setRelease(null);
      return;
    }
    setLoading(true);
    getReleaseNotes(version)
      .then(setRelease)
      .catch(() => setRelease(null))
      .finally(() => setLoading(false));
  }, [open, version]);

  const handleUpdate = async () => {
    if (!runnerId) return;
    setUpdating(true);
    try {
      const { jobId } = await updateRunner(runnerId);
      toast.success("Update job queued", {
        action: {
          label: "View job",
          onClick: () => router.push(`/dashboard/jobs/${jobId}`),
        },
      });
      setOpen(false);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to queue update",
      );
    } finally {
      setUpdating(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={children} />
      <PopoverContent align="start" className="w-96 p-0">
        <div className="flex flex-col gap-1 border-b border-border p-3">
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm font-medium">v{version}</span>
            {release?.is_breaking && (
              <Badge variant="destructive" className="py-0 text-ui-2xs">
                Breaking
              </Badge>
            )}
            {isOutdated && <StatusBadge status="pending" label="Outdated" />}
          </div>
          {release?.released_at && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>
                Released{" "}
                {formatRelative(release.released_at)}
              </span>
              {release.commit_sha && (
                <span className="font-mono text-ui-2xs text-muted-foreground/60">
                  {release.commit_sha.slice(0, 7)}
                </span>
              )}
            </div>
          )}
        </div>

        <ScrollArea className="max-h-[50vh]">
          <div className="p-3">
            {loading ? (
              <div className="space-y-2">
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-4 w-1/2" />
                <Skeleton className="h-4 w-5/6" />
              </div>
            ) : release?.release_notes ? (
              <div className="prose prose-sm dark:prose-invert max-w-none [&_h2]:mt-4 [&_h2]:mb-2 [&_h2]:text-sm [&_h3]:text-sm [&_li]:my-0.5 [&_ul]:my-1">
                <ReactMarkdown>{release.release_notes}</ReactMarkdown>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                No release notes available for this version.
              </p>
            )}
          </div>
        </ScrollArea>

        {(release?.github_release_url || (isOutdated && runnerId)) && (
          <div className="flex items-center justify-end gap-2 border-t border-border p-3">
            {release?.github_release_url && (
              <Button
                variant="outline"
                size="sm"
                nativeButton={false}
                render={
                  <a
                    href={release.github_release_url}
                    target="_blank"
                    rel="noopener noreferrer"
                  />
                }
              >
                <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
                GitHub Release
              </Button>
            )}
            {isOutdated && runnerId && (
              <Button size="sm" disabled={updating} onClick={handleUpdate}>
                {updating ? (
                  <>
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    Updating...
                  </>
                ) : (
                  <>
                    <ArrowUpCircle className="mr-1.5 h-3.5 w-3.5" />
                    Update Runner
                  </>
                )}
              </Button>
            )}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
