"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The project workspace's icon rail. Reuses the same nav groups as the full <AppSidebar> — just the
// [·] brand mark, uniform icon-buttons (label on hover), and a user avatar that opens the account
// settings modal. Persists across every project view; the full sidebar returns on org routes.

import { AlethiaMark } from "@repo/brand/lockup";
import { PanelLeftOpen } from "lucide-react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { authClient } from "@/lib/auth/client";
import { orgHref } from "@/lib/routing";
import { useSidebarCollapse } from "@/lib/stores/use-sidebar-store";
import { useActiveOrgSlug } from "@/lib/stores/use-workspace-store";
import { displayName, userInitials } from "@/lib/user-display";
import { Avatar, AvatarFallback, AvatarImage } from "@repo/ui/avatar";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@repo/ui/tooltip";
import { cn } from "@repo/ui/utils";
import { AccountSettingsDialog } from "./account-settings-dialog";
import {
  buildProjectSidebarNav,
  buildSidebarNav,
  isNavItemActive,
  type NavItem,
  projectScope,
} from "./nav-config";

/** Shared icon-button chrome — one uniform size whether in the rail or (later) the full sidebar. */
const ICON_BUTTON =
  "flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground";

/** One nav item: an icon-only link with its label on hover. Carries the active env so switching
 * views keeps the environment (harmless on project-level views that ignore the param). */
function RailLink({
  item,
  pathname,
  envQuery,
}: {
  item: NavItem;
  pathname: string;
  envQuery: string;
}) {
  const target = item.href ?? item.anchor;
  if (!target) return null;
  const Icon = item.icon;
  const active = isNavItemActive(item, pathname);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Link
            href={`${target}${envQuery}`}
            aria-label={item.label}
            aria-disabled={item.disabled}
            className={cn(
              ICON_BUTTON,
              active && "bg-muted text-foreground",
              item.disabled && "pointer-events-none opacity-40",
            )}
          >
            <Icon className="h-4 w-4" />
          </Link>
        }
      />
      <TooltipContent side="right">{item.label}</TooltipContent>
    </Tooltip>
  );
}

/** The user avatar — clicking it opens the account settings modal directly. */
function RailAccount() {
  const { data: session } = authClient.useSession();
  const user = session?.user ?? null;
  const [settingsOpen, setSettingsOpen] = useState(false);
  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label="Account settings"
              onClick={() => setSettingsOpen(true)}
              className="rounded-full outline-none transition-opacity hover:opacity-80 focus-visible:ring-1 focus-visible:ring-ring"
            >
              <Avatar className="h-7 w-7">
                <AvatarImage src={user?.image ?? undefined} alt="" />
                <AvatarFallback className="bg-muted text-ui-2xs font-medium text-muted-foreground">
                  {userInitials(user)}
                </AvatarFallback>
              </Avatar>
            </button>
          }
        />
        <TooltipContent side="right">{displayName(user)}</TooltipContent>
      </Tooltip>
      <AccountSettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
      />
    </>
  );
}

/** The collapsed icon rail shown across a project's views. */
export function SidebarRail({
  selfRunners = false,
}: {
  selfRunners?: boolean;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const orgSlug = useActiveOrgSlug();
  const { toggle, canToggle } = useSidebarCollapse();
  const projectSlug = projectScope(pathname)?.projectSlug ?? null;
  const groups = useMemo(
    () =>
      projectSlug
        ? buildProjectSidebarNav(orgSlug, projectSlug)
        : buildSidebarNav(orgSlug, { selfRunners }),
    [orgSlug, projectSlug, selfRunners],
  );

  // Keep the active environment when moving between views.
  const envId = searchParams.get("environment_id");
  const envQuery = envId ? `?environment_id=${encodeURIComponent(envId)}` : "";

  return (
    <TooltipProvider delayDuration={0}>
      <div className="flex h-full w-full flex-col items-center bg-background">
        {/* Brand mark → org home */}
        <div className="flex h-[53px] w-full shrink-0 items-center justify-center border-b">
          <Link
            href={orgHref(orgSlug)}
            aria-label="Home"
            className="flex h-9 w-9 items-center justify-center rounded-md hover:bg-muted/60"
          >
            <AlethiaMark className="h-6 w-6" />
          </Link>
        </div>

        {/* Icon nav — all project items sit at the top */}
        <nav className="flex w-full flex-1 flex-col items-center gap-1 overflow-y-auto py-3">
          {/* Expand back to the full sidebar. */}
          {canToggle && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label="Expand sidebar"
                    onClick={toggle}
                    className={cn(ICON_BUTTON, "mb-1")}
                  >
                    <PanelLeftOpen className="h-4 w-4" />
                  </button>
                }
              />
              <TooltipContent side="right">Expand sidebar</TooltipContent>
            </Tooltip>
          )}
          {groups.top.map((item) => (
            <RailLink
              key={item.label}
              item={item}
              pathname={pathname}
              envQuery={envQuery}
            />
          ))}
          {groups.pinned.map((item) => (
            <RailLink
              key={item.label}
              item={item}
              pathname={pathname}
              envQuery={envQuery}
            />
          ))}
        </nav>

        <div className="flex h-14 w-full shrink-0 items-center justify-center border-t">
          <RailAccount />
        </div>
      </div>
    </TooltipProvider>
  );
}
