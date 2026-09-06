"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import {
  ArrowUpRight,
  BookOpen,
  Code2,
  Cookie,
  History,
  Home,
  LifeBuoy,
  LogOut,
  MessageSquare,
  MoreHorizontal,
  Settings,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { env } from "next-runtime-env";
import { useState } from "react";
import { useEntitlement } from "@/components/settings/enterprise-gate";
import { InlineThemeSwitcher } from "@/components/theme-menu";
import { authClient } from "@/lib/auth/client";
import { useAuthPrefsStore } from "@/lib/stores/use-auth-prefs-store";
import { legalUrl } from "@/lib/legal";
import { globalHref } from "@/lib/routing";
import { useActiveOrgSlug } from "@/lib/stores/use-workspace-store";
import { useUpgradeSheet } from "@/components/org/upgrade-sheet-provider";
import { displayName, userInitials } from "@/lib/user-display";
import { Avatar, AvatarFallback, AvatarImage } from "@repo/ui/avatar";
import { Button } from "@repo/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@repo/ui/dropdown-menu";
import { AccountSettingsDialog } from "./account-settings-dialog";
import { FeedbackDialog } from "./feedback-dialog";
import { NotificationsPopover } from "./notifications-popover";
import { useConsent } from "@repo/privacy/consent-provider";

/** Default issue tracker for self-hosted "Report an issue"; override per deployment. */
const DEFAULT_ISSUES_URL =
  "https://github.com/alethialabs-io/alethia/issues/new";

/**
 * The pinned bottom bar of the sidebar: avatar + username, a three-dot button that opens
 * the account menu, and the notifications bell. The popover carries the account header
 * (with a gear → settings), the menu list (Feedback, an inline theme toggle, the
 * help/docs links, Sign out), an optional "Upgrade to Pro" CTA, and a platform-status
 * widget. Feedback is hosted-only (a dialog that emails us); self-managed builds link to
 * GitHub issues instead.
 */
export function SidebarProfile({ isHosted = false }: { isHosted?: boolean }) {
  const router = useRouter();
  const orgSlug = useActiveOrgSlug();
  const { openUpgrade } = useUpgradeSheet();
  const { openPreferences } = useConsent();
  const { data: session } = authClient.useSession();
  const user = session?.user ?? null;
  const [menuOpen, setMenuOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // "organizations" is the paid-plan floor; show the upgrade CTA only to free orgs on
  // the hosted control plane (self-hosters have no Stripe).
  const onPaidPlan = useEntitlement("organizations");
  const showUpgrade = isHosted && !onPaidPlan;

  /** Signs out and returns to the marketing root. */
  const handleLogout = async () => {
    await authClient.signOut();
    // Signing out is the one moment the person at the keyboard has said they are done
    // with this machine, so the sign-in form's memory of them goes too — the "Last used"
    // mark and the pre-filled address. Leaving them would show the next person which
    // provider this account uses and what its address is.
    useAuthPrefsStore.getState().forget();
    router.push("/");
  };

  const issuesUrl = env("NEXT_PUBLIC_FEEDBACK_REPO_URL") || DEFAULT_ISSUES_URL;

  return (
    <div className="flex h-14 shrink-0 items-center gap-1.5 border-t px-2.5">
      <div className="flex min-w-0 flex-1 items-center gap-2.5 px-1.5 py-1.5">
        <Avatar className="h-7 w-7">
          <AvatarImage src={user?.image ?? undefined} alt="" />
          <AvatarFallback className="bg-muted text-ui-2xs font-medium text-muted-foreground">
            {userInitials(user)}
          </AvatarFallback>
        </Avatar>
        <span className="min-w-0 flex-1 truncate text-ui-md font-medium text-foreground">
          {displayName(user)}
        </span>
      </div>

      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              aria-label="Account menu"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>
          }
        />
        <DropdownMenuContent align="end" side="top" className="w-64">
          <DropdownMenuLabel className="font-normal">
            <div className="flex items-center gap-2">
              <div className="flex min-w-0 flex-1 flex-col space-y-1">
                <p className="truncate text-sm font-medium leading-none">
                  {displayName(user)}
                </p>
                <p className="truncate text-xs leading-none text-muted-foreground">
                  {user?.email ?? "Loading…"}
                </p>
              </div>
              <button
                type="button"
                aria-label="Account settings"
                onClick={() => {
                  // Close the menu first, then open the dialog (avoids a focus race).
                  setMenuOpen(false);
                  setSettingsOpen(true);
                }}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
              >
                <Settings className="h-4 w-4" />
              </button>
            </div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />

          {isHosted ? (
            <DropdownMenuItem
              onSelect={(e) => {
                // Keep the dialog open after the menu dismisses (avoids a focus race).
                e.preventDefault();
                setFeedbackOpen(true);
              }}
              className="cursor-pointer"
            >
              Feedback
              <MessageSquare className="ml-auto h-4 w-4 text-muted-foreground" />
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem
              render={
                <a
                  href={issuesUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="cursor-pointer"
                >
                  Report an issue
                  <ArrowUpRight className="ml-auto h-3.5 w-3.5 text-muted-foreground" />
                </a>
              }
            />
          )}

          <InlineThemeSwitcher />

          <DropdownMenuItem
            render={
              <a
                href={isHosted ? "/home" : legalUrl("/")}
                className="cursor-pointer"
              >
                Home Page
                <Home className="ml-auto h-4 w-4 text-muted-foreground" />
              </a>
            }
          />
          <DropdownMenuItem
            render={
              <a
                href="https://github.com/alethialabs-io/alethialabs/releases"
                target="_blank"
                rel="noreferrer"
                className="cursor-pointer"
              >
                Changelog
                <History className="ml-auto h-4 w-4 text-muted-foreground" />
              </a>
            }
          />
          <DropdownMenuItem
            render={
              <Link href={globalHref(orgSlug, "support")} className="cursor-pointer">
                Help
                <LifeBuoy className="ml-auto h-4 w-4 text-muted-foreground" />
              </Link>
            }
          />
          <DropdownMenuItem
            onSelect={() => {
              setMenuOpen(false);
              openPreferences();
            }}
            className="cursor-pointer"
          >
            Privacy settings
            <Cookie className="ml-auto h-4 w-4 text-muted-foreground" />
          </DropdownMenuItem>
          <DropdownMenuItem
            render={
              <Link href="/docs" className="cursor-pointer">
                Docs
                <BookOpen className="ml-auto h-4 w-4 text-muted-foreground" />
              </Link>
            }
          />
          <DropdownMenuItem
            render={
              <a
                href={legalUrl("/legal/source")}
                target="_blank"
                rel="noreferrer"
                className="cursor-pointer"
              >
                Source &amp; licenses
                <Code2 className="ml-auto h-4 w-4 text-muted-foreground" />
              </a>
            }
          />

          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={handleLogout}
            className="cursor-pointer text-destructive focus:text-destructive"
          >
            Log Out
            <LogOut className="ml-auto h-4 w-4" />
          </DropdownMenuItem>

          {showUpgrade && (
            <>
              <DropdownMenuSeparator />
              <div className="px-1 py-1">
                <Button
                  className="w-full"
                  onClick={() => {
                    setMenuOpen(false);
                    openUpgrade();
                  }}
                >
                  Upgrade to Pro
                </Button>
              </div>
            </>
          )}

          <DropdownMenuSeparator />
          <a
            href="https://status.alethialabs.io"
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-2 px-2 py-1.5"
          >
            <span className="min-w-0 flex-1">
              <span className="block text-ui-2xs font-medium uppercase tracking-[0.08em] text-muted-foreground">
                Platform Status
              </span>
              <span className="block text-ui-md text-foreground">
                All systems normal.
              </span>
            </span>
            <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-foreground" />
          </a>
        </DropdownMenuContent>
      </DropdownMenu>

      <NotificationsPopover />

      {isHosted && (
        <FeedbackDialog open={feedbackOpen} onOpenChange={setFeedbackOpen} />
      )}
      <AccountSettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
      />
    </div>
  );
}
