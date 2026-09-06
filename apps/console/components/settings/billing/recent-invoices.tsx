"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Recent invoices — the compact invoice list on the main Billing panel. Shows the five most
// recent mirrored invoices (reusing the shared InvoicesTable + preview dialog) under an
// Invoices section whose action links to the full invoices page. Renders a one-line muted
// note when there are none. No TanStack Query — plain useEffect/useState, matching billing-panel.

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import {
	type InvoiceInfo,
	listInvoices,
} from "@/app/server/actions/billing";
import { SettingsSection } from "@/components/settings/settings-ui";
import { Skeleton } from "@repo/ui/skeleton";
import { InvoicePreviewDialog } from "./invoice-preview-dialog";
import { InvoicesTable } from "./invoices-table";

export function RecentInvoices() {
	const { org } = useParams<{ org: string }>();
	const [rows, setRows] = useState<InvoiceInfo[] | null>(null);

	// The preview dialog (open state + selected invoice).
	const [selected, setSelected] = useState<InvoiceInfo | null>(null);
	const [previewOpen, setPreviewOpen] = useState(false);

	useEffect(() => {
		listInvoices({ limit: 5 })
			.then(setRows)
			.catch(() => {
				setRows([]);
				toast.error("Couldn't load invoices.");
			});
	}, []);

	/** Open the preview dialog for a row. */
	function openPreview(row: InvoiceInfo) {
		setSelected(row);
		setPreviewOpen(true);
	}

	const viewAll = (
		<Link
			href={`/${org}/~/settings/billing/invoices`}
			className="font-mono text-ui-xs text-text-tertiary transition-colors hover:text-text-primary"
		>
			View all invoices →
		</Link>
	);

	return (
		<SettingsSection title="Invoices" action={rows && rows.length > 0 ? viewAll : undefined}>
			{rows === null ? (
				<Skeleton className="h-40 w-full" />
			) : (
				<InvoicesTable
					rows={rows}
					onPreview={openPreview}
					pageSize={5}
					emptyMessage="No invoices yet — they appear here after your first payment."
				/>
			)}

			<InvoicePreviewDialog
				invoice={selected}
				open={previewOpen}
				onOpenChange={setPreviewOpen}
			/>
		</SettingsSection>
	);
}
