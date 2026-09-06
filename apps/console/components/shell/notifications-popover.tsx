"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Bell, ClipboardList, LifeBuoy } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useMemo } from "react";
import { formatRelative } from "@repo/format";
import { Button } from "@repo/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@repo/ui/popover";
import {
  useJobNotifications,
  type JobNotification,
} from "@/hooks/use-job-notifications";
import {
  useSupportNotifications,
  type SupportNotification,
} from "@/hooks/use-support-notifications";
import { formatCaseNumber } from "@/components/support/cases/case-list-item";
import { JOB_TYPES } from "@/lib/jobs/format";
import { SUPPORT_STATUS_LABELS } from "@/lib/validations/support";
import { cn } from "@repo/ui/utils";

/** A job or support entry unified for the merged, recency-sorted feed. */
type FeedItem =
  | { kind: "job"; ts: number; job: JobNotification }
  | { kind: "support"; ts: number; support: SupportNotification };

/**
 * Notifications bell + popover for the sidebar profile bar. Composes the two live feeds — jobs
 * (`useJobNotifications`) and support cases (`useSupportNotifications`) — into one recency-sorted
 * list, so the bell surfaces provisioning outcomes and staff/AI case replies together. The unread
 * dot rides the bell for the combined unread count; each row links org-scoped to its job or case,
 * and "Mark all read" clears both feeds.
 */
export function NotificationsPopover() {
  const { org } = useParams<{ org: string }>();
  const jobs = useJobNotifications();
  const support = useSupportNotifications();

  const unreadCount = jobs.unreadCount + support.unreadCount;

  const feed = useMemo<FeedItem[]>(() => {
    const items: FeedItem[] = [
      ...jobs.notifications.map<FeedItem>((job) => ({
        kind: "job",
        ts: new Date(job.createdAt).getTime(),
        job,
      })),
      ...support.notifications.map<FeedItem>((s) => ({
        kind: "support",
        ts: new Date(s.lastMessageAt).getTime(),
        support: s,
      })),
    ];
    return items.sort((a, b) => b.ts - a.ts);
  }, [jobs.notifications, support.notifications]);

  /** Marks every job AND support notification read (the header action). */
  function markAllRead(): void {
    jobs.markAllRead();
    support.markAllRead();
  }

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            className="relative h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground"
          >
            <Bell className="h-4 w-4" />
            {unreadCount > 0 && (
              <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-foreground ring-2 ring-background" />
            )}
            <span className="sr-only">Notifications</span>
          </Button>
        }
      />
      <PopoverContent className="w-80 p-0" align="end" side="top">
        <div className="flex items-center justify-between border-b border-border/40 px-4 py-3">
          <div>
            <p className="text-sm font-semibold text-foreground">
              Notifications
            </p>
            <p className="text-ui-xs text-muted-foreground">
              {unreadCount > 0 ? `${unreadCount} unread` : "All caught up"}
            </p>
          </div>
          {unreadCount > 0 && (
            <button
              onClick={markAllRead}
              className="text-ui-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              Mark all read
            </button>
          )}
        </div>
        <div className="max-h-[320px] overflow-y-auto">
          {feed.map((item) =>
            item.kind === "job" ? (
              <JobRow
                key={`job-${item.job.jobId}`}
                n={item.job}
                org={org}
                onRead={jobs.markAsRead}
              />
            ) : (
              <SupportRow
                key={`support-${item.support.caseId}`}
                n={item.support}
                org={org}
                onRead={support.markAsRead}
              />
            ),
          )}
          {feed.length === 0 && (
            <div className="p-8 text-center text-ui-sm text-muted-foreground">
              You&apos;re all caught up!
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** One job notification row: type + status, its scope, and an unread dot for finished work. */
function JobRow({
  n,
  org,
  onRead,
}: {
  n: JobNotification;
  org: string;
  onRead: (jobId: string) => void;
}) {
  const label = JOB_TYPES[n.jobType]?.label ?? n.jobType;
  const scope = [n.projectName, n.environmentName].filter(Boolean).join(" · ");
  return (
    <Link href={`/${org}/~/jobs/${n.jobId}`} onClick={() => onRead(n.jobId)}>
      <div
        className={cn(
          "flex items-center gap-3 border-b border-border/20 px-4 py-2.5 transition-colors hover:bg-muted/50",
          !n.read && "bg-muted/20",
        )}
      >
        <div
          className={cn(
            "shrink-0 rounded-md p-1",
            n.status === "FAILED" ? "bg-destructive/10" : "bg-muted",
          )}
        >
          <ClipboardList
            className={cn(
              "h-3.5 w-3.5",
              n.status === "FAILED"
                ? "text-destructive"
                : n.status === "SUCCESS"
                  ? "text-foreground"
                  : "text-muted-foreground",
            )}
          />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium text-foreground">
            {label} — {n.status.toLowerCase()}
          </p>
          <p className="mt-0.5 truncate text-ui-xs text-muted-foreground">
            {scope ? `${scope} · ` : ""}
            {formatRelative(n.createdAt)}
          </p>
        </div>
        {!n.read && TERMINAL_BADGE.has(n.status) && (
          <span
            className={cn(
              "h-2 w-2 shrink-0 rounded-full",
              n.status === "FAILED" ? "bg-destructive" : "bg-foreground",
            )}
          />
        )}
      </div>
    </Link>
  );
}

/** One support-case row: the case reference + subject + status, with an unread dot. */
function SupportRow({
  n,
  org,
  onRead,
}: {
  n: SupportNotification;
  org: string;
  onRead: (caseId: string) => void;
}) {
  return (
    <Link
      href={`/${org}/~/support/cases/${n.caseId}`}
      onClick={() => onRead(n.caseId)}
    >
      <div
        className={cn(
          "flex items-center gap-3 border-b border-border/20 px-4 py-2.5 transition-colors hover:bg-muted/50",
          !n.read && "bg-muted/20",
        )}
      >
        <div className="shrink-0 rounded-md bg-muted p-1">
          <LifeBuoy className="h-3.5 w-3.5 text-muted-foreground" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium text-foreground">
          <span className="font-mono text-ui-xs text-muted-foreground">
              {formatCaseNumber(n.caseNumber)}
            </span>{" "}
            {n.subject}
          </p>
          <p className="mt-0.5 truncate text-ui-xs text-muted-foreground">
            {SUPPORT_STATUS_LABELS[n.status]} ·{" "}
            {formatRelative(n.lastMessageAt)}
          </p>
        </div>
        {!n.read && (
          <span className="h-2 w-2 shrink-0 rounded-full bg-foreground" />
        )}
      </div>
    </Link>
  );
}

/** Statuses that earn an unread dot in the list (finished, unacknowledged work). */
const TERMINAL_BADGE = new Set(["SUCCESS", "FAILED", "CANCELLED"]);
