// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { FormSkeleton, HeaderSkeleton } from "@/components/skeletons/page-skeletons";

/** Instant skeleton for the new-project route. */
export default function NewProjectLoading() {
	return (
		<div className="mx-auto w-full max-w-5xl space-y-6">
			<HeaderSkeleton />
			<FormSkeleton fields={5} />
		</div>
	);
}
