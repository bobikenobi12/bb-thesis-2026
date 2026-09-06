"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Shared shell for the Pro purchase sheets — the two-column PurchaseLayout (persistent
// "What's included" checklist + dynamic right panel), the post-purchase InviteView, and
// the small Field / Seat / RoleField primitives. Both the create-org sheet (new paid org)
// and the upgrade-org sheet (existing Hobby → Pro) render through these so the purchase
// UI has a single source of truth (per the monorepo "promote, don't duplicate" rule).

import { coerceEnum } from "@/lib/coerce";
import { ArrowRight, CreditCard, Plus, X } from "lucide-react";
import type React from "react";
import { z } from "zod";
import { PlanChecklist } from "@/components/billing/plan-checklist";
import type { PlanCatalogEntry } from "@repo/plan-catalog";
import { Button } from "@repo/ui/button";
import { Input } from "@repo/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@repo/ui/select";
import { cn } from "@repo/ui/utils";

export const ROLES = ["admin", "operator", "viewer"] as const;
export type Role = (typeof ROLES)[number];
export interface SentInvite {
	email: string;
	role: Role;
}

/** The two-column purchase shell: persistent checklist left, dynamic panel right. */
export function PurchaseLayout({
	meta,
	heading,
	subheading,
	onClose,
	children,
}: {
	meta: PlanCatalogEntry;
	heading: string;
	subheading?: string;
	onClose: () => void;
	children: React.ReactNode;
}) {
	return (
		<div className="grid grid-cols-1 lg:min-h-full lg:grid-cols-[260px_1fr]">
			{/* Left strip runs full height (grid rows stretch): checklist up top, a plan
			    summary anchored at the bottom so the panel never looks cut off / empty. */}
			<aside className="hidden border-r border-border-strong bg-surface-sunken px-7 py-8 lg:flex lg:flex-col">

				<PlanChecklist meta={meta} />
				<div className="mt-auto border-t border-border pt-5">
					<div className="flex items-baseline justify-between gap-2">
						<span className="font-display text-ui-lg font-semibold tracking-[-0.01em] text-text-primary">
							{meta.name}
						</span>
						<span className="font-mono text-ui-xs text-text-tertiary">
							{meta.priceLabel}
						</span>
					</div>
					<p className="mt-1.5 text-ui-xs leading-snug text-text-tertiary">
						{meta.tagline}
					</p>
				</div>
			</aside>
			<div className="relative flex h-full min-h-0 flex-col px-7 pt-8">
				<button
					type="button"
					aria-label="Close"
					onClick={onClose}
					className="absolute right-5 top-5 z-10 rounded-sm p-1.5 text-text-tertiary transition-colors hover:bg-surface-muted hover:text-text-primary"
				>
					<X size={15} />
				</button>
				<div className="mx-auto w-full max-w-[420px] shrink-0">
					<div className="mb-6 flex flex-col items-center text-center">
						<span className="rounded-full border border-border-strong px-2.5 py-0.5 font-mono text-ui-2xs uppercase tracking-[0.12em] text-text-secondary">
							{meta.name}
						</span>
						<h1 className="mt-3 font-display text-display-xs font-semibold tracking-[-0.02em] text-text-primary">
							{heading}
						</h1>
						<p className="mt-1.5 text-ui-sm text-text-tertiary">
							{subheading ?? "Unlock collaboration and improved performance."}
						</p>
					</div>
				</div>
				{/* Fills the remaining height so a child form can scroll its fields and pin its CTA. */}
				<div className="mx-auto flex w-full min-h-0 max-w-[420px] flex-1 flex-col pb-8">
					{children}
				</div>
			</div>
		</div>
	);
}

/** Post-purchase view — invite teammates (paid), or upsell to pay (card-less trial). */
export function InviteView({
	isTrialOrg,
	ownerEmail,
	inviteEmail,
	setInviteEmail,
	inviteRole,
	setInviteRole,
	sent,
	onAdd,
	onFinish,
	onAddPayment,
}: {
	isTrialOrg: boolean;
	ownerEmail: string;
	inviteEmail: string;
	setInviteEmail: (v: string) => void;
	inviteRole: Role;
	setInviteRole: (r: Role) => void;
	sent: SentInvite[];
	onAdd: () => void;
	onFinish: () => void;
	onAddPayment: () => void;
}) {
	return (
		<div className="mx-auto flex w-full max-w-[460px] flex-col gap-4 px-7 py-8">
			<div className="flex flex-col gap-1">
				<h1 className="font-display text-display-xs font-semibold tracking-[-0.02em] text-text-primary">
					Invite your team
				</h1>
				<p className="text-ui-sm text-text-tertiary">
					{isTrialOrg
						? "Teammates are free during your trial — add them now or later from settings."
						: "Add teammates now, or skip and invite them later from settings."}
				</p>
			</div>

			<Seat avatar="YO" name={ownerEmail || "You"} meta="Organization owner">
				<span className="rounded-full border border-border-strong px-2 py-0.5 font-mono text-ui-2xs uppercase tracking-wide text-text-secondary">
					Owner
				</span>
			</Seat>

			<div className="flex gap-2">
				<Input
					placeholder="name@company.com"
					autoComplete="off"
					value={inviteEmail}
					onChange={(e) => setInviteEmail(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							e.preventDefault();
							onAdd();
						}
					}}
				/>
				<RoleField
					value={inviteRole}
					onChange={setInviteRole}
					className="w-[120px] shrink-0"
				/>
				<Button
					type="button"
					variant="outline"
					size="sm"
					className="shrink-0"
					onClick={onAdd}
				>
					<Plus size={14} />
					Invite
				</Button>
			</div>
			<p className="text-ui-xs text-text-tertiary">
				{isTrialOrg
					? "Teammates are free while you're on trial — each becomes a $20/seat/mo charge once it converts (viewers are free)."
					: "Each teammate becomes a billable seat once they accept (viewers are free)."}
			</p>
			{sent.map((inv, i) => (
				<Seat
					key={`${inv.email}-${i}`}
					avatar={inv.email.slice(0, 2).toUpperCase()}
					name={inv.email}
					meta="Invited · pending"
				>
					<span className="rounded-full border border-border px-2 py-0.5 font-mono text-ui-2xs capitalize text-text-tertiary">
						{inv.role}
					</span>
				</Seat>
			))}

			{isTrialOrg && (
				<button
					type="button"
					onClick={onAddPayment}
					className="flex items-center justify-center gap-1.5 text-ui-xs text-text-tertiary transition-colors hover:text-text-primary"
				>
					<CreditCard size={13} />
					Add a payment method to keep your team after the trial
				</button>
			)}

			<Button className="mt-2 w-full" onClick={onFinish}>
				{sent.length === 0 ? "Go to organization" : "Finish"}
				<ArrowRight size={15} />
			</Button>
		</div>
	);
}

/** Validates an email for the invite field (shared by both sheets). */
export function isValidInviteEmail(email: string): boolean {
	return z.string().email().safeParse(email.trim()).success;
}

/** A compact role <select> on the shadcn Select primitive. */
export function RoleField({
	value,
	onChange,
	className,
}: {
	value: Role;
	onChange: (role: Role) => void;
	className?: string;
}) {
	return (
		<Select value={value} onValueChange={(v) => onChange(coerceEnum(v, ROLES, "viewer"))}>
			<SelectTrigger size="sm" aria-label="Role" className={cn("capitalize", className)}>
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				{ROLES.map((r) => (
					<SelectItem key={r} value={r} className="capitalize">
						{r}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

/** A labeled form field with an optional error. */
export function Field({
	label,
	required,
	error,
	children,
}: {
	label: string;
	required?: boolean;
	error?: string;
	children: React.ReactNode;
}) {
	return (
		<div className="space-y-1.5">
			<div className="flex items-center gap-1.5 text-ui-md font-medium text-text-primary">
				{label}
				{required && (
					<span className="font-mono text-ui-2xs uppercase tracking-wide text-text-tertiary">
						required
					</span>
				)}
			</div>
			{children}
			{error && <p className="text-ui-xs text-destructive">{error}</p>}
		</div>
	);
}

/** A seat row (owner / invited member). */
export function Seat({
	avatar,
	name,
	meta,
	children,
}: {
	avatar: string;
	name: string;
	meta: string;
	children: React.ReactNode;
}) {
	return (
		<div className="flex items-center gap-3 rounded-lg border border-border px-3 py-2">
			<span className="flex size-7 shrink-0 items-center justify-center rounded-full border border-border-strong bg-surface-muted font-mono text-ui-2xs text-text-secondary">
				{avatar}
			</span>
			<div className="flex min-w-0 flex-1 flex-col">
				<span className="truncate text-ui-sm text-text-primary">{name}</span>
				<span className="font-mono text-ui-2xs text-text-tertiary">{meta}</span>
			</div>
			{children}
		</div>
	);
}
