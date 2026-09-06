// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration (real Postgres): the security-critical break-glass invariants.
//   1. breakglass_audit is APPEND-ONLY even for the service role (WORM trigger blocks UPDATE/DELETE/
//      TRUNCATE) — the customer audit_log's RLS-only immutability would NOT bind the service role.
//   2. Two-person approval: a self-approval is refused, a different operator's is consumed once, a
//      re-consume fails, and a wrong-resource token mismatches — all fail-closed.
//   3. Sessions are time-boxed: an expired session is not live.
//   4. unstick_env goes through the set_env_status CAS (not a raw UPDATE): a legal from-set moves the
//      env, a wrong from-set is a 409 refusal with NO change — and BOTH leave an audit trail
//      (attempt row committed before the act, result row after).

import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { executeBreakglassAction } from "@/lib/breakglass/actions";
import { consumeApproval, mintApproval } from "@/lib/breakglass/approval";
import { writeAttemptAudit } from "@/lib/breakglass/audit";
import type { BreakglassOperator } from "@/lib/breakglass/auth";
import { openBreakglassSession } from "@/lib/breakglass/session";
import { getServiceDb } from "@/lib/db";
import {
	breakglassApproval,
	breakglassAudit,
	breakglassSession,
	projectEnvironments,
	projects,
} from "@/lib/db/schema";
import { describeIfDb } from "./db";

const OP_A = `bg-a-${randomUUID()}@x.io`;
const OP_B = `bg-b-${randomUUID()}@x.io`;

describeIfDb("break-glass invariants", () => {
	let projectId: string;
	let envId: string;
	const operatorA: BreakglassOperator = { email: OP_A, userId: null };

	beforeAll(async () => {
		const db = getServiceDb();
		const [p] = await db
			.insert(projects)
			.values({
				user_id: randomUUID(),
				project_name: "bg-test",
				region: "us-east-1",
				iac_version: "1.9.5",
			})
			.returning({ id: projects.id });
		projectId = p.id;
		const [e] = await db
			.insert(projectEnvironments)
			.values({ project_id: projectId, user_id: randomUUID(), name: "prod", status: "DRAFT", is_default: true })
			.returning({ id: projectEnvironments.id });
		envId = e.id;
	});

	afterAll(async () => {
		const db = getServiceDb();
		// breakglass_audit is append-only (can't DELETE), so leave its test rows; clean the rest.
		await db.delete(breakglassApproval).where(eq(breakglassApproval.approver_email, OP_A));
		await db.delete(breakglassSession).where(eq(breakglassSession.operator_email, OP_A));
		await db.delete(projectEnvironments).where(eq(projectEnvironments.project_id, projectId));
		await db.delete(projects).where(eq(projects.id, projectId));
	});

	// ── (1) WORM append-only ──────────────────────────────────────────────────────────────────
	it("breakglass_audit blocks UPDATE, DELETE and TRUNCATE even for the service role", async () => {
		const id = await writeAttemptAudit({
			sessionId: null,
			actorEmail: OP_A,
			action: "inspect_job",
			blastRadius: "none",
			resourceType: "job",
			resourceId: randomUUID(),
			reason: "worm-test attempt",
		});
		const db = getServiceDb();

		// drizzle wraps the driver error, so match against the full error chain (message + cause).
		const errText = (e: unknown): string => {
			const err = e as { message?: string; cause?: { message?: string } };
			return `${err?.message ?? ""} ${err?.cause?.message ?? ""}`;
		};

		const upd = await db
			.update(breakglassAudit)
			.set({ detail: "tamper" })
			.where(eq(breakglassAudit.id, id))
			.then(() => null)
			.catch((e) => e);
		expect(upd, "UPDATE must be blocked").not.toBeNull();
		expect(errText(upd)).toMatch(/append-only/i);

		const del = await db
			.delete(breakglassAudit)
			.where(eq(breakglassAudit.id, id))
			.then(() => null)
			.catch((e) => e);
		expect(del, "DELETE must be blocked").not.toBeNull();
		expect(errText(del)).toMatch(/append-only/i);

		const trunc = await db
			.execute(sql`truncate table public.breakglass_audit`)
			.then(() => null)
			.catch((e) => e);
		expect(trunc, "TRUNCATE must be blocked").not.toBeNull();
		expect(errText(trunc)).toMatch(/append-only/i);

		// The row is still intact + unchanged.
		const [row] = await db
			.select({ detail: breakglassAudit.detail })
			.from(breakglassAudit)
			.where(eq(breakglassAudit.id, id));
		expect(row.detail).toBeNull();
	});

	// ── (2) Two-person approval ───────────────────────────────────────────────────────────────
	it("enforces two-person: self-approval refused, different operator consumed once, re-consume fails", async () => {
		const stateKey = `projects/${projectId}/${envId}/tofu.tfstate`;
		const approval = await mintApproval({
			approverEmail: OP_B,
			action: "force_release_state_lock",
			resourceType: "state_lock",
			resourceId: stateKey,
			input: undefined,
			reason: "incident: stranded lock",
		});

		// Wrong resource → mismatch (fail-closed).
		const wrong = await consumeApproval({
			approvalId: approval.id,
			actorEmail: OP_A,
			action: "force_release_state_lock",
			resourceType: "state_lock",
			resourceId: `projects/${projectId}/other/tofu.tfstate`,
		});
		expect(wrong).toEqual({ ok: false, reason: "mismatch" });

		// A DIFFERENT operator (A) consumes B's approval → ok.
		const good = await consumeApproval({
			approvalId: approval.id,
			actorEmail: OP_A,
			action: "force_release_state_lock",
			resourceType: "state_lock",
			resourceId: stateKey,
		});
		expect(good.ok).toBe(true);

		// Single-use: a second consume fails.
		const again = await consumeApproval({
			approvalId: approval.id,
			actorEmail: OP_A,
			action: "force_release_state_lock",
			resourceType: "state_lock",
			resourceId: stateKey,
		});
		expect(again).toEqual({ ok: false, reason: "expired_or_consumed" });
	});

	it("refuses a self-approval (approver === actor)", async () => {
		const approval = await mintApproval({
			approverEmail: OP_A,
			action: "force_release_state_lock",
			resourceType: "state_lock",
			resourceId: `projects/${projectId}/self/tofu.tfstate`,
			input: undefined,
			reason: "self approval attempt",
		});
		const res = await consumeApproval({
			approvalId: approval.id,
			actorEmail: OP_A,
			action: "force_release_state_lock",
			resourceType: "state_lock",
			resourceId: `projects/${projectId}/self/tofu.tfstate`,
		});
		expect(res).toEqual({ ok: false, reason: "same_operator" });
	});

	// ── (3) Session time-box ──────────────────────────────────────────────────────────────────
	it("an expired session is not live", async () => {
		const db = getServiceDb();
		const [s] = await db
			.insert(breakglassSession)
			.values({
				operator_email: OP_A,
				reason: "expired session test",
				expires_at: new Date(Date.now() - 1000),
			})
			.returning({ id: breakglassSession.id });
		// executeBreakglassAction with a resolvable-but-expired session id must refuse (no live session).
		const res = await executeBreakglassAction(operatorA, {
			sessionId: s.id,
			action: "inspect_job",
			resourceId: randomUUID(),
			reason: "should be refused: expired session",
		});
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.code).toBe(403);
	});

	// ── (4) unstick_env goes through the CAS, with audit-before-act ───────────────────────────
	it("unstick_env uses the CAS: legal from moves it, wrong from is a 409 with no change; both audited", async () => {
		const db = getServiceDb();
		// A live session for operator A.
		const session = await openBreakglassSession(operatorA, "incident: env stuck in QUEUED", {});
		// Force the env to QUEUED.
		await db.update(projectEnvironments).set({ status: "QUEUED" }).where(eq(projectEnvironments.id, envId));

		// Wrong from-set → CAS miss → 409 refusal, env untouched.
		const wrong = await executeBreakglassAction(operatorA, {
			sessionId: session.id,
			action: "unstick_env",
			resourceId: envId,
			confirm: envId,
			reason: "unstick from wrong precondition",
			input: { expectedFrom: ["ACTIVE"], to: "FAILED" },
		});
		expect(wrong.ok).toBe(false);
		if (!wrong.ok) expect(wrong.code).toBe(409);
		const [afterWrong] = await db
			.select({ status: projectEnvironments.status })
			.from(projectEnvironments)
			.where(eq(projectEnvironments.id, envId));
		expect(afterWrong.status).toBe("QUEUED");

		// Legal from-set → CAS moves it.
		const ok = await executeBreakglassAction(operatorA, {
			sessionId: session.id,
			action: "unstick_env",
			resourceId: envId,
			confirm: envId,
			reason: "unstick from correct precondition",
			input: { expectedFrom: ["QUEUED", "PROVISIONING"], to: "FAILED" },
		});
		expect(ok.ok).toBe(true);
		const [afterOk] = await db
			.select({ status: projectEnvironments.status })
			.from(projectEnvironments)
			.where(eq(projectEnvironments.id, envId));
		expect(afterOk.status).toBe("FAILED");

		// Audit-before-act: BOTH an attempt row (pre-act) and a result row exist for this session.
		const rows = await db
			.select({ phase: breakglassAudit.phase, outcome: breakglassAudit.outcome })
			.from(breakglassAudit)
			.where(
				and(
					eq(breakglassAudit.session_id, session.id),
					eq(breakglassAudit.action, "unstick_env"),
				),
			);
		const phases = rows.map((r) => r.phase);
		expect(phases.filter((p) => p === "attempt").length).toBeGreaterThanOrEqual(2);
		expect(phases.filter((p) => p === "result").length).toBeGreaterThanOrEqual(2);
		// The wrong attempt produced an error result; the good one an ok result.
		expect(rows.some((r) => r.outcome === "error")).toBe(true);
		expect(rows.some((r) => r.outcome === "ok")).toBe(true);

		// Typed-confirm mismatch is refused server-side.
		const badConfirm = await executeBreakglassAction(operatorA, {
			sessionId: session.id,
			action: "unstick_env",
			resourceId: envId,
			confirm: "not-the-id",
			reason: "typed-confirm mismatch should refuse",
			input: { expectedFrom: ["FAILED"], to: "ACTIVE" },
		});
		expect(badConfirm.ok).toBe(false);
		if (!badConfirm.ok) expect(badConfirm.code).toBe(400);
	});
});
