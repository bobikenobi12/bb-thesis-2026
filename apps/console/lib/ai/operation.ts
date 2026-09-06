// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";

/**
 * An agent-proposed operation on an EXISTING project. Every job-queuing mutation is a
 * proposal the user approves (HITL) — the agent never runs plan/deploy autonomously.
 * Inline project creation is intentionally out of scope (build on the canvas instead).
 */
export const operationSchema = z.discriminatedUnion("operation", [
	z.object({
		operation: z.literal("plan_project"),
		projectId: z.string().describe("The project to plan."),
	}),
	z.object({
		operation: z.literal("provision_project"),
		projectId: z.string().describe("The project to deploy."),
		planJobId: z
			.string()
			.optional()
			.describe("The prior successful PLAN job id, if any."),
	}),
]);

/**
 * Plan diff summary, surfaced on the approval card (from a prior plan).
 *
 * `monthly` is the plan's ABSOLUTE total monthly cost, never a delta or a saving. The card
 * renders it with `formatMonthlyRate(_, "exact")`, which clamps `<= 0` to `$0.00/mo` and loses
 * the sign — so a teardown reported as a negative would read as "nothing", not as money saved.
 * The bound is stated to the model rather than enforced with `.nonnegative()` on purpose: a
 * refusal here fails the whole `propose_operation` call and the user loses the approval card,
 * which is a worse outcome than one misleading figure. If the console ever needs to SHOW a
 * saving, `@repo/format` needs a credit register first — see `formatMonthlyRate`'s docstring.
 */
export const operationStatsSchema = z.object({
	add: z.number().optional(),
	change: z.number().optional(),
	destroy: z.number().optional(),
	monthly: z
		.number()
		.optional()
		.describe(
			"The plan's absolute total monthly cost in major units (copy costSummary.totalMonthlyCost). A total, never a delta or a saving — never negative.",
		),
});

/** Input the agent passes to `propose_operation`. */
export const proposeOperationInputSchema = z.object({
	label: z
		.string()
		.describe(
			"Short imperative label, e.g. 'Deploy ai-platform to prod-eu-west'.",
		),
	operation: operationSchema,
	stats: operationStatsSchema.optional(),
});

/** The emitted proposal (tool output) the approval card parses. */
export const operationProposalSchema = z.object({
	id: z.string(),
	label: z.string(),
	operation: operationSchema,
	stats: operationStatsSchema.optional(),
});

export type Operation = z.infer<typeof operationSchema>;
export type OperationProposal = z.infer<typeof operationProposalSchema>;
