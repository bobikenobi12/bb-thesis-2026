// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The decisions `gen-go-vocab.ts` needs and cannot derive.
 *
 * The split is the same one `brand-projection.ts` makes: the VALUES live with their owner
 * (`packages/ui/src/status-badge.tsx` for the vocabulary, `lib/db/schema` for the words'
 * provenance), and this file holds only the judgements — what a tier looks like on a cell grid,
 * and where a word that is in no pgEnum actually comes from.
 *
 * Every table here is audited in BOTH directions by the generator: a status with no decision
 * fails the build, and a decision about a status that no longer exists fails it too. A table
 * that describes things that are gone reads as more complete than it is.
 */

import type { StatusTier } from "@repo/ui/status-badge";

/**
 * The terminal projection of one tier.
 *
 * `why` is carried INTO the generated Go file, for the reason `brand-projection.ts` states about
 * its own: a reader who finds `·` against a destroyed cluster and does not find the sentence
 * saying why will file it as a bug and "fix" it back to the dash.
 */
export interface TierProjection {
	/** The glyph a terminal draws for this tier. */
	glyph: string;
	/** What the glyph says, and why it is this one. */
	why: string;
	/**
	 * The tier this one deliberately renders identically to.
	 *
	 * A terminal cell has fewer states than a browser does, so a collision can be honest — but
	 * an UNDECLARED one is two tiers a reader cannot tell apart with nothing saying so. The
	 * generator refuses one.
	 */
	sharesWith?: StatusTier;
}

/**
 * Tier → glyph. `Record<StatusTier, …>` on purpose: a tier added to `STATUS_TIERS` is a
 * TypeScript error here until somebody decides what the terminal draws for it, which is the
 * same refusal `gen-go-brand.ts` makes for a token with no projection.
 *
 * THE EM DASH APPEARS NOWHERE IN THIS TABLE, and the generator refuses it. `—` is the CLI's
 * absence sentinel (`packages/core/format.Dash`, reached through `ui.OrDash`, `ui.StrOrDash`,
 * `ui.StampOrDash`), so a status drawn as a dash is indistinguishable from a cell nobody could
 * fill. A destroyed cluster is a fact; a missing value is the lack of one. Go's `PlainStatusDot`
 * drew `DESTROYED` as `—` until this generator replaced it, and that is why `disabled` exists as
 * a distinct glyph.
 *
 * THE MIDDOT IS ALSO SPOKEN FOR, and that one was learned after the fact. `ui.SymbolBullet` is
 * `·`, the SEPARATOR between the segments of a picker label, and `opsPickProjectID` starts its
 * label with the status glyph — so while `disabled` was `·` a destroyed project rendered as
 * `· my-project · prod · a1b2c3d4` and its leading glyph could not be told from a separator. One
 * ambiguity had been traded for another. The generator can only see collisions BETWEEN TIERS;
 * TestStatusGlyphsAreDisjointFromSymbols (apps/cli/pkg/utils/ui) holds this table apart from the
 * CLI's non-status symbols, which is where the other half of the collision lives.
 */
export const TIER_GLYPHS: Record<StatusTier, TierProjection> = {
	active: {
		glyph: "●",
		why: "filled — running, healthy, or finished well",
	},
	pending: {
		glyph: "◐",
		why: "half-filled — in flight; something is happening and this is not its final answer",
	},
	idle: {
		glyph: "○",
		why: "hollow — present, reachable, and not doing anything",
	},
	failed: {
		glyph: "✗",
		why: "the brand's failure shape; the grayscale palette carries no red, so failure reads by shape and never by hue",
	},
	disabled: {
		glyph: "◌",
		why: "a dotted outline — the shape is still there and nothing is in it: gone, inert or skipped. NOT the em dash, which means we could not fill the cell at all, and NOT the middot, which is ui.SymbolBullet, the separator inside a picker label",
	},
	live: {
		glyph: "●",
		why: "the console blinks a live subject; a terminal cell cannot blink, so `live` arrives as an ordinary active dot and the 'still under examination' half of the meaning is lost",
		sharesWith: "active",
	},
};

/**
 * Where a status word comes from when it is in NO pgEnum.
 *
 * Required — the generator refuses to emit a vocabulary key that has neither an enum value nor
 * an entry here, and that refusal is this lane's deliverable. `STATUS_TIER` has no single owner:
 * its keys span the drizzle enums, the runner's wire statuses, and a handful of words that
 * belong to no schema at all, and until the provenance was written down there was no way to tell
 * a deliberate word from one somebody typed once.
 *
 * An entry here is NOT permission to keep a word — it is a statement of what emits it, and
 * "nothing emits this" is one of the answers it can give. No count of those is written down
 * anywhere: a number in prose beside a table that moves is the next stale sentence, and this one
 * was already wrong once — `error` sat here saying NOTHING EMITS THIS while
 * `stripe_webhook_event_status` spelled it, because the generator was reading one schema MODULE
 * rather than the schema.
 */
export const WIRE_ORIGINS: Record<string, string> = {
	ready: "the wire status of an add-on, an IaC source and a chart source (api.Addon, api.IacSource, api.ChartSource) — a text column, not a pgEnum, so nothing constrains it",
	running: "the agent panes' local phase union (components/agent/approval-card.tsx) and the ordinary Kubernetes word for a workload that is up; no column holds it",
	idle: "the tier's own name, reused as a word: the runner widget reports a runner as `idle` (components/widgets) where runner_status has only ONLINE/OFFLINE/DRAINING",
	errored: "NOTHING EMITS THIS. A past-tense alias of `failed`, kept because it is a word a hand-written wire status reaches for; it appears in packages/ui/tests/status-badge.test.tsx and nowhere else in the product. Delete it if a census ever proves it unreachable",
	disabled: "the tier's own name, reused as a word for an alert rule, channel or SSO provider whose `enabled` column is false — a boolean, rendered as a status",
	skipped: "a promotion gate's result (lib/promotions/gates.ts, typed in types/jsonb.types.ts as pass | fail | pending | skipped) — a JSONB field, so no enum constrains it",
};

/**
 * Per-word notes about a decision the two surfaces used to disagree about, carried into the
 * generated file.
 *
 * These are the measured disagreements between Go's `PlainStatusDot` (nine uppercase words and a
 * default) and this vocabulary (28 lower-cased keys), recorded so that the terminal's change of
 * behaviour is reviewable rather than archaeological. The generator refuses a note about a word
 * that is not in the vocabulary.
 *
 * They are NOT overrides. Every one of them resolves to whatever `STATUS_TIER` says, because a
 * per-key override table in the generator would be the second source of truth this whole unit
 * exists to remove.
 */
export const RULINGS: Record<string, string> = {
	draining:
		"CONTESTED, and the console wins by default rather than by argument. Go drew ◐ (in progress); this vocabulary says idle, whose own comment reads 'present but not doing anything'. A draining runner is finishing the work it holds and refusing new work, which is not nothing — so the CLI's answer was arguably the better one and this generator takes it away. The one-line fix is `draining: \"pending\"` in STATUS_TIER, which changes what the CONSOLE renders and is therefore a vocabulary decision, not this generator's. See #3660 case 1.",
	destroyed:
		"Go drew — , the same glyph OrDash/StrOrDash/StampOrDash return for 'we do not know', so a destroyed cluster and an unfillable cell were the same cell. It is now the disabled tier's ◌ and the em dash means one thing again. It was briefly the middot, which collided with ui.SymbolBullet inside a picker label — one ambiguity traded for another — so the tier moved again rather than the separator, which is the older and wider convention.",
	success:
		"One word had three renderings inside one product: ○ in `jobs list`, bold text via formatJobStatus in `job wait`, and a filled active dot in the console. It is ● everywhere now, and formatJobStatus is deleted.",
	processing:
		"Go defaulted it to ○ (idle) and inked it differently from CLAIMED for no stated reason; both are pending, ◐.",
	claimed:
		"Same as processing — a claimed job has a runner and is about to start, which is the pending tier, not the idle one.",
	pending:
		"Go had no case for the literal word and defaulted it to ○. component_status.PENDING is the pending tier.",
	destroying:
		"Go defaulted it to ○ while CREATING, UPDATING and PROVISIONING were ◐ — the same kind of work, drawn two ways depending on which word the wire happened to use.",
	// The promotion vocabulary. These five words were in NEITHER renderer: promotion_status and
	// approval_status between them have six values the vocabulary had no word for, so they resolved
	// to the idle fallback and drew ○ — "present, reachable, and not doing anything" — on both
	// surfaces. On a table an operator scans to find the row holding a promotion up, that is not an
	// absent signal but a WRONG one, and the CLI had just started drawing it where it previously
	// echoed the raw enum and asserted nothing. Ruled with #4117's review; see #3660.
	approved:
		"promotion_status.APPROVED and approval_status.approved. Read as ACTIVE rather than pending: on an approval slot the word is terminal and positive — that person decided, and decided yes — and on a promotion it means the gates are satisfied. `pending` would be defensible for the promotion (it is a cleared waypoint, the deploy has not run) and is plainly wrong for the slot; one word gets one tier, so it takes the reading that is never wrong. It drew ○, the idle glyph, until #4117.",
	rejected:
		"approval_status.rejected. The failed tier: a rejection is terminal and negative, and it is the reason a promotion is not moving. It drew ○ until #4117, identically to `approved` one row above it.",
	blocked:
		"promotion_status.BLOCKED — 'a hard gate failed (predecessor unhealthy / verify hard-fail)'. The failed tier, for the same reason `failed` is: it is terminal, it is negative, and it is the row an operator has to act on. It drew ○ until #4117.",
	pending_approval:
		"promotion_status.PENDING_APPROVAL — gates need a human. The pending tier's own definition, 'in flight; something is happening and this is not its final answer', and the word is literally `pending`. It drew ○ until #4117.",
	pending_plan:
		"promotion_status.PENDING_PLAN — the candidate is written and a PLAN job is queued. Genuinely in flight, so the pending tier, exactly as `queued` is. It drew ○ until #4117.",
};

/**
 * The absence sentinel, as this file believes it to be spelled.
 *
 * The generator does NOT trust this constant: it reads the real one out of
 * `packages/core/format/format.go` and refuses to run if it cannot find it, so a rename there is
 * loud rather than a refusal that quietly stops matching anything.
 */
export const ABSENCE_SENTINEL = "—";
