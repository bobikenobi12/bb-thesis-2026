// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The single branded surface for 404s and error boundaries. No "use client" —
// usable from both server components (not-found.tsx) and client error boundaries
// (error.tsx / global-error.tsx). Actions are passed in by the caller so each
// boundary supplies its own links / reset() buttons.

import type { ReactNode } from "react";
import { AlethiaMark } from "@repo/brand/lockup";
import { cn } from "@repo/ui/utils";

interface ErrorStateProps {
	/** Big mono status line above the title, e.g. "404" or "500". */
	code?: string;
	title: string;
	description?: string;
	/** A row of buttons/links — the caller owns navigation + reset(). */
	actions?: ReactNode;
	/** Centered full-screen layout with the logo (for top-level pages); otherwise a
	 * compact in-content panel (for errors rendered inside the dashboard shell). */
	fullPage?: boolean;
	className?: string;
}

/** Branded empty/error state shared by every 404 and error boundary. */
export function ErrorState({
	code,
	title,
	description,
	actions,
	fullPage = false,
	className,
}: ErrorStateProps) {
	const body = (
		<div
			className={cn(
				"flex flex-col items-center text-center",
				fullPage ? "max-w-[420px] gap-5" : "max-w-[360px] gap-3",
				className,
			)}
		>
			{fullPage && (
				<AlethiaMark className="mb-1 h-7 w-7 text-text-primary" aria-hidden />
			)}
			{code && (
				<span className="font-mono text-ui-sm uppercase tracking-[0.22em] text-text-tertiary">
					{code}
				</span>
			)}
			<h1
				className={cn(
					"font-grotesk font-semibold tracking-[-0.02em] text-text-primary",
					fullPage ? "text-ui-xl" : "text-ui-xl",
				)}
			>
				{title}
			</h1>
			{description && (
				<p className="text-ui-md leading-relaxed text-text-tertiary">
					{description}
				</p>
			)}
			{actions && (
				<div className="mt-2 flex flex-wrap items-center justify-center gap-2">
					{actions}
				</div>
			)}
		</div>
	);

	if (!fullPage) {
		return (
			<div className="flex min-h-[320px] flex-1 items-center justify-center px-6 py-12">
				{body}
			</div>
		);
	}
	return (
		<div className="flex min-h-screen items-center justify-center bg-background px-6">
			{body}
		</div>
	);
}
