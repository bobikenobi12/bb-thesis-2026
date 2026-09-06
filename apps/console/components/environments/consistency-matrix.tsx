"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The cross-environment consistency matrix — which components each environment defines and where
// they diverge. ● present · ≠ differs · – absent.
//
// This is the one shape in the lane that `DataTable` cannot express: the columns ARE the data
// (one per environment, discovered at render), and there is nothing to sort, filter or paginate.
// So it composes `@repo/ui/table` directly, which is the shell `DataTable` itself renders
// through — same padding, borders and hover as every other console table, and a real
// `<th scope>` per environment so a screen reader can name the cell it is reading.

import type { EnvConsistency } from "@/app/server/actions/projects";
import { SectionHeading } from "@repo/ui/section-heading";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@repo/ui/table";

/** One matrix cell. */
function Cell({ state }: { state: "present" | "differs" | "absent" }) {
	if (state === "present")
		return <span className="font-mono text-text-primary">●</span>;
	if (state === "differs")
		return (
			<span
				className="font-mono font-bold text-text-primary"
				title="Differs across environments"
			>
				≠
			</span>
		);
	return <span className="font-mono text-text-disabled">–</span>;
}

export function ConsistencyMatrix({ consistency }: { consistency: EnvConsistency }) {
	return (
		<section>
			<SectionHeading
				className="mb-3"
				level={2}
				title="Consistency"
				description={
					<>
						Which services each environment defines, and where they diverge.{" "}
						<span className="font-mono text-text-primary">●</span> present ·{" "}
						<span className="font-mono font-bold text-text-primary">≠</span> differs ·{" "}
						<span className="font-mono text-text-disabled">–</span> absent
					</>
				}
			/>
			<div className="overflow-hidden rounded-lg border bg-surface shadow-sm">
				{/* `containerClassName="pb-1"` is the ROW CLAMP'S REACH, not spacing. `scroll` gives the
				    wrapper `overflow-x-auto`, and per spec that computes `overflow-y` to `auto` as well —
				    the coupling `@repo/ui/table`'s own doc comment names. Every `TableRow` carries
				    `.vx-clamp--tight`, whose corner marks are a `::before` drawn 2px OUTSIDE the row
				    (`inset: calc(-1 * var(--cl-gap))`), and a scroll container measures that decoration as
				    content — so the last row put 2px of marks, plus the row's fractional height, below the
				    wrapper's content box and the wrapper scrolled vertically by 3px with nothing in it
				    (86/83 at 768, 1280, 1440 and 1920 — R3's only FAIL on this route, #3885).
				    4px of block-end padding covers both. Block END only: a scroll container's scrollable
				    overflow region extends at the block end, so the first row's 2px above is clipped and
				    unreachable rather than scrollable, and padding it would only inset the header row. */}
				<Table scroll containerClassName="pb-1" className="text-ui-sm">
					<TableHeader>
						<TableRow className="bg-surface-muted">
							<TableHead
								scope="col"
								className="font-mono text-ui-xs uppercase tracking-[0.1em] text-text-tertiary"
							>
								Component
							</TableHead>
							{consistency.envs.map((e) => (
								<TableHead
									key={e.id}
									scope="col"
									className="text-center font-mono font-normal text-text-secondary"
								>
									{e.name}
								</TableHead>
							))}
						</TableRow>
					</TableHeader>
					<TableBody>
						{consistency.rows.map((row) => (
							<TableRow key={`${row.component_type}-${row.key}`}>
								<TableCell>
									<span className="text-text-tertiary">{row.component_type}</span>{" "}
									<span className="font-mono text-text-primary">{row.key}</span>
								</TableCell>
								{consistency.envs.map((e) => (
									<TableCell key={e.id} className="text-center">
										<Cell state={row.perEnv[e.id]} />
									</TableCell>
								))}
							</TableRow>
						))}
					</TableBody>
				</Table>
			</div>
		</section>
	);
}
