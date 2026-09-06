// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { ReactNode } from "react";
import { SectionHeading } from "@repo/ui/section-heading";
import { cn } from "@repo/ui/utils";

interface SettingsCardProps {
	title?: string;
	description?: string;
	children: ReactNode;
	/** Optional footer band (e.g. a Save button, or a "managed by your IdP" note). */
	footer?: ReactNode;
	className?: string;
}

/** A titled content card — the building block of a settings section. */
export function SettingsCard({
	title,
	description,
	children,
	footer,
	className,
}: SettingsCardProps) {
	return (
		<div
			className={cn(
				"rounded-lg border border-border/40 bg-card shadow-sm",
				className,
			)}
		>
			{(title || description) && (
				<div className="border-b border-border/40 px-5 py-4">
					{title ? (
						// `level={2}` preserves the outline rung this card already occupied; the
						// `text-sm font-semibold` it used to typeset it at was one of the five sizes
						// the console rendered a second-level heading at.
						<SectionHeading level={2} title={title} description={description} />
					) : (
						<p className="text-xs text-muted-foreground">{description}</p>
					)}
				</div>
			)}
			<div className="px-5 py-4">{children}</div>
			{footer && (
				<div className="border-t border-border/40 bg-muted/10 px-5 py-3">
					{footer}
				</div>
			)}
		</div>
	);
}

interface SettingRowProps {
	label: string;
	description?: string;
	/** The control (input, switch, button, badge) shown on the right. */
	children?: ReactNode;
	danger?: boolean;
}

/** A labeled setting row: label/description on the left, control on the right. */
export function SettingRow({
	label,
	description,
	children,
	danger,
}: SettingRowProps) {
	return (
		<div className="flex items-center justify-between gap-4 py-3">
			<div className="space-y-0.5">
				<p
					className={cn(
						"text-sm font-medium",
						danger ? "text-destructive" : "text-foreground",
					)}
				>
					{label}
				</p>
				{description && (
					<p className="text-xs text-muted-foreground">{description}</p>
				)}
			</div>
			{children && <div className="shrink-0">{children}</div>}
		</div>
	);
}
