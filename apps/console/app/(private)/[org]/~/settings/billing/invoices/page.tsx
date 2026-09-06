// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import Link from "next/link";
import { InvoicesPanel } from "@/components/settings/billing/invoices-panel";
import { pageMetadata } from "@/lib/seo/page-metadata";

export const metadata = pageMetadata({
	title: "Invoices · Billing",
	description: "Your organization's invoice history and downloadable receipts.",
});

/** Invoices — the dedicated, filterable history of the org's paid invoices. */
export default function InvoicesPage() {
	return (
		<div>
			<Link
				href="../"
				className="mb-4 inline-flex items-center font-mono text-ui-xs text-text-tertiary transition-colors hover:text-text-primary"
			>
				← Billing
			</Link>
			<InvoicesPanel />
		</div>
	);
}
