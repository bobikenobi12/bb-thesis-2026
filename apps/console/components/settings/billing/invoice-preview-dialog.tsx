"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Invoice preview dialog — the detail view for a single mirrored invoice: header metadata
// (number, status, paid date, billing period, description, total) over an embedded PDF
// preview (inline `pdf` route in an iframe). The footer downloads the PDF or, when there's no
// self-hosted PDF, links out to Stripe's hosted receipt. Presentational — the parent owns the
// open state + which invoice is selected.

import { Download, ExternalLink } from "lucide-react";
import { useParams } from "next/navigation";
import type { InvoiceInfo } from "@/app/server/actions/billing";
import { formatDate, formatMoney } from "@repo/format";
import { Button } from "@repo/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@repo/ui/dialog";
import {
	formatBillingPeriod,
	InvoiceStatusBadge,
	invoicePdfHref,
} from "./invoices-table";

/** A labeled metadata row for the invoice detail grid. */
function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="flex items-baseline justify-between gap-4 py-1.5">
			<span className="font-mono text-ui-2xs uppercase tracking-[0.1em] text-text-tertiary">
				{label}
			</span>
			<span className="min-w-0 truncate text-right text-ui-md text-text-secondary">
				{children}
			</span>
		</div>
	);
}

/**
 * The invoice preview dialog. Renders nothing meaningful until an `invoice` is selected;
 * embeds the inline PDF route when a self-hosted PDF exists, and always offers a download
 * (or an external hosted-receipt link when there's no PDF).
 */
export function InvoicePreviewDialog({
	invoice,
	open,
	onOpenChange,
}: {
	invoice: InvoiceInfo | null;
	open: boolean;
	onOpenChange: (o: boolean) => void;
}) {
	const { org } = useParams<{ org: string }>();

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-2xl">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2.5 font-mono text-sm">
						{invoice?.number ?? "Invoice"}
						{invoice && <InvoiceStatusBadge status={invoice.status} />}
					</DialogTitle>
					<DialogDescription>
						{invoice?.description ?? "Invoice details and receipt."}
					</DialogDescription>
				</DialogHeader>

				{invoice && (
					<>
						<div className="rounded-md border border-border bg-surface-sunken px-4 py-2">
							<DetailRow label="Paid">
								{formatDate(invoice.paidAt)}
							</DetailRow>
							<DetailRow label="Billing period">
								{formatBillingPeriod(invoice)}
							</DetailRow>
							<DetailRow label="Total">
								<span className="font-mono text-text-primary">
									{/* `total` is ALREADY minor units — formatMoney takes cents. */}
									{formatMoney(invoice.total, invoice.currency.toUpperCase())}
								</span>
							</DetailRow>
						</div>

						{invoice.hasPdf && (
							<iframe
								title={`Invoice ${invoice.number ?? invoice.id}`}
								src={invoicePdfHref(org, invoice.id)}
								className="h-[60vh] w-full rounded-md border border-border bg-surface"
							/>
						)}

						<DialogFooter>
							{invoice.hasPdf ? (
								<Button size="sm" nativeButton={false} render={<a href={invoicePdfHref(org, invoice.id, true)} />}>
									<Download size={14} />
									Download PDF
								</Button>
							) : (
								invoice.hostedInvoiceUrl && (
									<Button
										size="sm"
										variant="outline"
										nativeButton={false}
										render={
											<a
												href={invoice.hostedInvoiceUrl}
												target="_blank"
												rel="noopener noreferrer"
											/>
										}
									>
										<ExternalLink size={14} />
										Open receipt
									</Button>
								)
							)}
						</DialogFooter>
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}
