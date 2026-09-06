// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/** Returns this month's usage-window start, anchored to an open-ended grant's start day. */
export function effectiveBillingPeriodStart(
	periodStart: Date | null | undefined,
	periodEnd: Date | null | undefined,
	now: Date,
): Date {
	if (!periodStart) return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
	if (periodEnd || periodStart > now) return periodStart;

	const anchorDay = periodStart.getUTCDate();
	let year = now.getUTCFullYear();
	let month = now.getUTCMonth();
	const inMonth = Math.min(anchorDay, new Date(Date.UTC(year, month + 1, 0)).getUTCDate());
	let candidate = new Date(
		Date.UTC(
			year,
			month,
			inMonth,
			periodStart.getUTCHours(),
			periodStart.getUTCMinutes(),
			periodStart.getUTCSeconds(),
			periodStart.getUTCMilliseconds(),
		),
	);
	if (candidate > now) {
		month -= 1;
		if (month < 0) {
			month = 11;
			year -= 1;
		}
		const priorDay = Math.min(anchorDay, new Date(Date.UTC(year, month + 1, 0)).getUTCDate());
		candidate = new Date(
			Date.UTC(
				year,
				month,
				priorDay,
				periodStart.getUTCHours(),
				periodStart.getUTCMinutes(),
				periodStart.getUTCSeconds(),
				periodStart.getUTCMilliseconds(),
			),
		);
	}
	return candidate;
}
