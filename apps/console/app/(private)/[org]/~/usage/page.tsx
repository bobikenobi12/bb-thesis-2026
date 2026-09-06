// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { UsagePanel } from "@/components/settings/usage/usage-panel";
import { pageMetadata } from "@/lib/seo/page-metadata";

export const metadata = pageMetadata({
	title: "Usage",
	description:
		"Seats, runner-minutes and projects consumed by your organization this period.",
});

/** Usage: seats, runner-minutes, projects consumed this period (+ AI when it lands). */
export default function UsagePage() {
	return <UsagePanel />;
}
