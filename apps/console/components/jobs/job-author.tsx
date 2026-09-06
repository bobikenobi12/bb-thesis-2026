"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The avatar (+ identity hover-card) of the member who initiated a job — shown at the end of
// each jobs-table row. Resolves from the org members list (passed in by the table), falling back
// to initials when the initiator is no longer a member.

import { Avatar, AvatarFallback, AvatarImage } from "@repo/ui/avatar";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@repo/ui/hover-card";
import { displayName, userInitials } from "@/lib/user-display";

/** The member fields the author card reads (a subset of MemberRow). */
export interface JobAuthorInfo {
  name: string | null;
  username: string | null;
  email: string;
  image: string | null;
}

function AuthorAvatar({
  image,
  initials,
  size,
}: {
  image: string | null;
  initials: string;
  size: "sm" | "md";
}) {
  return (
    <Avatar
      className={`${size === "sm" ? "size-6" : "size-8"} shrink-0 border border-border`}
    >
      <AvatarImage src={image ?? undefined} alt="" />
      <AvatarFallback
        className={`font-mono ${size === "sm" ? "text-ui-3xs" : "text-ui-xs"} text-muted-foreground`}
      >
        {initials}
      </AvatarFallback>
    </Avatar>
  );
}

/** Initiator avatar + a hover-card showing just the avatar + display name (name→username→email). */
export function JobAuthor({ author }: { author?: JobAuthorInfo | null }) {
  const name = author ? displayName(author) : "Unknown";
  const initials = userInitials(author);

  return (
    <HoverCard>
      <HoverCardTrigger
        delay={150}
        closeDelay={80}
        render={
          <button
            type="button"
            onClick={(e) => e.stopPropagation()}
            aria-label={`Initiated by ${name}`}
            className="rounded-full outline-none ring-offset-background transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring"
          >
            <AuthorAvatar
              image={author?.image ?? null}
              initials={initials}
              size="sm"
            />
          </button>
        }
      />
      <HoverCardContent
        align="end"
        className="flex w-auto items-center gap-2.5 p-2.5"
      >
        <AuthorAvatar
          image={author?.image ?? null}
          initials={initials}
          size="md"
        />
        <p className="whitespace-nowrap pr-1 text-sm font-medium text-foreground">
          {name}
        </p>
      </HoverCardContent>
    </HoverCard>
  );
}
