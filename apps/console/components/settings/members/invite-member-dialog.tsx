"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Invite teammates to the active organization (Pro — gated by `canOrgInvite`). Supports
// adding several emails at once, each with its own role, validates inline (format, in-batch
// duplicates, already-a-member / already-invited from the live invite context), and shows
// the per-seat cost so the inviter sees the billing impact. Works controlled (`open` /
// `onOpenChange`) or uncontrolled (pass a `trigger`).

import { zodResolver } from "@hookform/resolvers/zod";
import { Plus, Trash2, UserPlus } from "lucide-react";
import {
  type ReactElement,
  type ReactNode,
  useEffect,
  useMemo,
  useState,
} from "react";
import { FormProvider, useFieldArray, useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { Button } from "@repo/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@repo/ui/dialog";
import { FormControl, FormField, FormItem, FormMessage } from "@repo/ui/form";
import { Input } from "@repo/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/ui/select";
import {
  getInviteContext,
  type InviteContext,
} from "@/app/server/actions/members";
import { authClient } from "@/lib/auth/client";
import { track } from "@/lib/analytics/track";
import { INVITE_ROLES } from "@/lib/members/roles";

interface InviteFormData {
  invites: { email: string; role: string }[];
}

/** Inviteable org roles (owner is the creator, never invited). */
type InviteRole = "admin" | "operator" | "viewer";

/** Narrows a free-form role string to an InviteRole (no unsafe cast); falls back to viewer. */
function toInviteRole(value: string): InviteRole {
  switch (value) {
    case "admin":
    case "operator":
    case "viewer":
      return value;
    default:
      return "viewer";
  }
}

/** Builds the form schema, flagging emails already taken (member/pending) or duplicated. */
function buildSchema(existing: Set<string>, pending: Set<string>) {
  return z
    .object({
      invites: z
        .array(
          z.object({
            email: z.string().min(1, "Required").email("Enter a valid email"),
            role: z.string().min(1, "Pick a role"),
          }),
        )
        .min(1),
    })
    .superRefine((val, ctx) => {
      const seen = new Set<string>();
      val.invites.forEach((inv, i) => {
        const e = inv.email.trim().toLowerCase();
        if (!e || !inv.email.includes("@")) return;
        const path = ["invites", i, "email"] as const;
        if (existing.has(e))
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Already a member",
            path: [...path],
          });
        else if (pending.has(e))
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Already invited",
            path: [...path],
          });
        if (seen.has(e))
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Duplicate email",
            path: [...path],
          });
        seen.add(e);
      });
    });
}

/** Invite a teammate (or several) to the active organization. */
export function InviteMemberDialog({
  onInvited,
  trigger,
  open: openProp,
  onOpenChange,
}: {
  onInvited?: () => void;
  trigger?: ReactElement<Record<string, unknown>>;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = openProp ?? internalOpen;
  const setOpen = onOpenChange ?? setInternalOpen;

  const [ctx, setCtx] = useState<InviteContext | null>(null);

  const existing = useMemo(
    () => new Set(ctx?.existingEmails ?? []),
    [ctx?.existingEmails],
  );
  const pending = useMemo(
    () => new Set(ctx?.pendingEmails ?? []),
    [ctx?.pendingEmails],
  );
  const schema = useMemo(
    () => buildSchema(existing, pending),
    [existing, pending],
  );
  const roles = ctx?.roles ?? INVITE_ROLES;

  const form = useForm<InviteFormData>({
    resolver: zodResolver(schema),
    defaultValues: { invites: [{ email: "", role: "viewer" }] },
    mode: "onChange",
  });
  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: "invites",
  });

  // Pull the live invite context (gate, seat figures, taken emails) each time it opens.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    getInviteContext()
      .then((c) => alive && setCtx(c))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [open]);

  // Reset to a single empty row whenever the dialog is freshly opened.
  useEffect(() => {
    if (open) form.reset({ invites: [{ email: "", role: "viewer" }] });
  }, [open, form]);

  const onSubmit = async (data: InviteFormData) => {
    // Invite each row through Better Auth (client). The ee `beforeCreateInvitation`
    // hook enforces the collaboration gate server-side and the email/alert fire there.
    const ok: string[] = [];
    const failed: { email: string; error: string }[] = [];
    for (const inv of data.invites) {
      const email = inv.email.trim().toLowerCase();
      const { error } = await authClient.organization.inviteMember({
        email,
        role: toInviteRole(inv.role),
      });
      if (error) failed.push({ email, error: error.message ?? "Failed" });
      else {
        ok.push(email);
        track("member_invited", { role: inv.role });
      }
    }

    if (ok.length > 0)
      toast.success(
        ok.length === 1
          ? `Invitation sent to ${ok[0]}`
          : `${ok.length} invitations sent`,
      );
    for (const f of failed) toast.error(`${f.email}: ${f.error}`);
    if (failed.length === 0) {
      setOpen(false);
      form.reset({ invites: [{ email: "", role: "viewer" }] });
      onInvited?.();
    }
  };

  const seatBanner =
    ctx?.hosted && ctx.unitAmountUsd != null ? (
      <p className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">
          {ctx.memberCount} {ctx.memberCount === 1 ? "seat" : "seats"} in use
        </span>{" "}
        · ${ctx.unitAmountUsd}/seat — each new member adds a seat to your
        subscription.
      </p>
    ) : null;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {trigger && <DialogTrigger render={trigger} />}
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Invite members</DialogTitle>
          <DialogDescription>
            Add one or more teammates — each gets an email to join this
            organization with the role you choose.
          </DialogDescription>
        </DialogHeader>

        {seatBanner}

        <FormProvider {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-3">
            <div className="space-y-2">
              {fields.map((field, i) => (
                <div key={field.id} className="flex items-start gap-2">
                  <FormField
                    control={form.control}
                    name={`invites.${i}.email`}
                    render={({ field: f }) => (
                      <FormItem className="flex-1">
                        <FormControl>
                          <Input
                            type="email"
                            placeholder="teammate@company.com"
                            autoFocus={i === 0}
                            {...f}
                          />
                        </FormControl>
                        <FormMessage className="text-ui-xs" />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name={`invites.${i}.role`}
                    render={({ field: f }) => (
                      <FormItem className="w-32 shrink-0">
                        <Select value={f.value} onValueChange={f.onChange}>
                          <FormControl>
                            <SelectTrigger className="h-9 w-full">
                              <SelectValue />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {roles.map((r) => (
                              <SelectItem key={r.value} value={r.value}>
                                {r.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </FormItem>
                    )}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label="Remove"
                    disabled={fields.length === 1}
                    onClick={() => remove(i)}
                    className="h-9 w-9 shrink-0"
                  >
                    <Trash2 className="h-4 w-4 text-muted-foreground" />
                  </Button>
                </div>
              ))}
            </div>

            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => append({ email: "", role: "viewer" })}
              className="gap-1.5 text-xs"
            >
              <Plus className="h-3.5 w-3.5" />
              Add another
            </Button>

            {/* Role legend — what each role grants (descriptions, no overflow). */}
            <ul className="space-y-0.5 border-t pt-2.5 text-ui-xs text-muted-foreground">
              {roles.map((r) => (
                <li key={r.value}>
                  <span className="font-medium text-foreground">{r.label}</span>{" "}
                  — {r.description}
                </li>
              ))}
            </ul>

            <DialogFooter>
              <Button type="submit" disabled={form.formState.isSubmitting}>
                <UserPlus className="h-4 w-4" />
                Send {fields.length > 1 ? `${fields.length} invites` : "invite"}
              </Button>
            </DialogFooter>
          </form>
        </FormProvider>
      </DialogContent>
    </Dialog>
  );
}
