#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// programme-rollup — derive PROGRAMME.md's generated half from the tree.
//
// WHY THIS EXISTS. The MVP programme is "5 clouds × the capability surface, proven e2e, driven from
// the CLI". Its state was spread across ~15 hand-maintained Markdown boards, a Go harness and the
// issue board, so answering "where are we?" meant re-reading all of it — and the boards did not
// agree with each other:
//
//   · docs/testing/provisioning-e2e-parity.md cited #1714/#1716/#1722/#2058 as OPEN blockers. All
//     four are CLOSED.
//   · docs/testing/runner-xcloud-parity.md says hetzner is `✅ (nightly)` for cluster provision while
//     provisioning-e2e-parity.md says `🚫` — two files, one directory, contradicting each other,
//     both passing CI.
//   · Both boards imply clouds have been proven. The proof LEDGER says otherwise: every 2026-07-22
//     PASS was later RETRACTED as a gate-off skip, so the honest count of proven cells is ZERO.
//
// A hand-maintained board rots because nothing makes it agree with the tree. So this derives the
// status half of PROGRAMME.md and CI diff-gates the result: the numbers cannot be typed, and a stale
// file fails the build. It is deliberately NOT a 16th board — it is the join of the boards' inputs.
//
// PURE and OFFLINE: reads files, writes one file, never calls gh or a cloud. The live-board half of
// PROGRAMME.md (open REDs, blocked-on-human, board delta) is a separate cron-committed snapshot, so
// that this — the half every PR diff-gates — stays a deterministic function of the tree.
//
// ── What is DERIVED, and therefore cannot be faked ──
//
// Everything below. There is no hand-authored verdict table anywhere in this design, on purpose:
//
//   `proven`     a ledger row for (cloud × dimension) whose latest claim is PASS, NOT superseded by
//                a later RETRACTED, AND whose bundle is a path that EXISTS in the tree.
//   `failing`    the latest claim is FAIL — and where that claim is the `full` composite's rather
//                than this cell's own, the bar has to have REACHED this dimension. A bar that died
//                in `apply` never asserted the add-on surface, so it cannot red it. Credit and
//                discredit are governed by the same fact about what a run actually reached; they
//                were not, and `azure/addons` read ❌ off a cause never observed there (#3243).
//   `blocked`    the latest claim is BLOCKED (the harness refused before spending).
//   `never_run`  no surviving claim, and a vehicle exists — INCLUDING a claim there was but that
//                this cell may not be credited or discredited with. Every refusal lands here and
//                none can land on `proven`: withholding a red removes a verdict, it never invents
//                one, and a false PASS is worse than the false FAIL it would replace.
//   `no_vehicle` nothing asserts this cell at all.
//   `ceiling`    the cloud genuinely cannot (MaxConfigCarriage.CloudCeiling / CLIReach.CloudManual).
//   `deferred`   OUR debt — a shipped chart backs it and only the mapping is missing
//                (MaxConfigCarriage.DeferredInProduct). Kept apart from `ceiling` because a ceiling
//                is about the cloud and deferral is about us; merging them is how hetzner's
//                registry→Harbor and secret→Vault stopped being counted.
//   `cost`       OUR SPEND — the cloud offers the kind and the product ships it, but provisioning it
//                buys something not billed by the hour, so the harness declines
//                (MaxConfigCarriage.ExcludedByCost). Kept apart from `ceiling` for the same reason
//                deferral is: a ceiling says the cloud cannot, and this says we would rather not pay.
//                Reading it as a ceiling would let a 150 USD/month decision hide inside a capability
//                claim — the exact substitution the two above were separated to prevent.
//
// The three hand-asserted verdicts (`ceiling`, `deferred`, `cost`) are NOT authored here — they are read from
// the Go tables that already own and validate them, via test/e2e/generated/programme.json. One
// deriver, every consumer.
//
// Run: `node scripts/programme-rollup.mjs`            check + print the diff, exit 2 if stale
//      `node scripts/programme-rollup.mjs --write`    rewrite the generated region in place
//      `node scripts/programme-rollup.mjs --self-test`
//
// Exit codes — a non-zero must MEAN something:
//   0  clean
//   1  INTEGRITY failure: a cell is lying, or a required invariant broke
//   2  the generated region is stale (run --write and commit)
//   3  a required input is unreadable — never degrade silently to a prettier-looking answer

import fs from "node:fs";
import path from "node:path";
import { validateReaperResult } from "./e2e/reaper-result.mjs";

const SNAPSHOT = "docs/testing/programme-snapshot.json";
const LEDGER = "demos/proofs/provisioning-e2e-log.md";
/**
 * How many marketplace add-ons the generated catalog carries. `undefined` when it cannot be read —
 * NOT a default. A default here would be a number nobody measured, quietly deciding whether a proof
 * counts.
 */
function addOnCatalogCount() {
	try {
		const c = JSON.parse(fs.readFileSync(ADDON_CATALOG, "utf8"));
		return Array.isArray(c) && c.length > 0 ? c.length : undefined;
	} catch {
		return undefined;
	}
}

const ADDON_CATALOG = "test/e2e/fixtures/addon_catalog.hetzner.json";
const LEDGER_BASELINE = "demos/proofs/ledger-baseline.json";
const SPINE = "test/e2e/generated/programme.json";
const WORKFLOW = ".github/workflows/e2e-nightly.yml";
// The fidelity table moved OUT of the workflow's inline `env:` and into the resolver (#2356), so a
// gate is now "mentioned" if EITHER file mentions it. Reading only the workflow made two live gates
// report `no_vehicle` — the detector mirroring an emitter that had moved.
const RESOLVER = "scripts/e2e/resolve-dimension.sh";
const UNSUPPORTED_KINDS = "apps/console/lib/cloud-providers/unsupported-kinds.ts";
const PROOFS_DIR = "demos/proofs";
const TARGET = "PROGRAMME.md";
const REAPER_FRESH_HOURS = 48;

const BEGIN = "<!-- BEGIN GENERATED: programme-rollup · tree-derived · DO NOT EDIT BELOW -->";
const END = "<!-- END GENERATED: programme-rollup -->";

/**
 * How far the deploy spine got, LOWEST FIRST — the ladder `demos/proofs/capture-proof.sh` writes into
 * every bundle's `provision-summary.json` as `deploy_stage`.
 *
 * It is a monotone ladder because that is how the emitter builds it: `deploy_stage` starts at
 * `queued` and each successive `log_has` for the next banner OVERWRITES it, so the recorded value is
 * the HIGHEST rung whose banner appeared. That single property is what makes "did the run reach rung
 * N?" answerable at all, and it is why this list must stay in the emitter's order rather than in any
 * order that reads nicely here.
 *
 * A hand-kept copy of another file's vocabulary is how two sources of truth drift, so `--self-test`
 * parses the ladder back out of capture-proof.sh and fails if the two disagree — the same treatment
 * FULL_EXCLUDES already gets.
 */
export const DEPLOY_STAGES = ["queued", "planning", "applying", "applied", "deployed", "argocd-installed", "argocd-ready"];

/**
 * The dimensions one cloud must clear, in the order they are attempted, and the gate that turns each
 * on. Vocabulary is `provisioning-e2e.sh`'s (`floor|maxconfig|addons|byo|day2|full`) so a row it
 * appends and a cell rendered here always name the same thing.
 *
 * `full` is deliberately NOT a cell: it is the composite that runs every dimension in one apply, so
 * a `full` PASS is evidence for ALL of them. Treating it as a sixth column would let a cloud look
 * 1/6 proven when a full bar had in fact proven everything.
 */
// `gateNames` is the CONCRETE list checked against the workflow — never parsed back out of `gate`,
// which is display prose and once contained a `*` wildcard that resolved to a name nothing declares
// and rendered a false "no".
// `gates` entries carry HOW the gate is turned on, because the two are not interchangeable:
//   `derived` — the workflow's resolve step exports it from the chosen DIMENSION (post-#2356's
//               fidelity table). Always reachable via a dispatch; there is no repo variable to set,
//               so reporting it "unwired" sends somebody hunting for a variable that cannot exist.
//   `repo`    — a maintainer sets a repo variable or secret. THIS is what "unwired" means.
//
// `reachedAt` is the rung of DEPLOY_STAGES at which this dimension's surface FIRST comes into play
// — the earliest point at which a composite failure could honestly be this dimension's fault. It
// exists because a `full` bar credits and DISCREDITS several columns at once, and a bar that died in
// `apply` never asserted the add-on surface, the GitOps surface or a day-2 access path. See
// `compositeReached` for the one direction this licenses (#3243).
//
// EVERY value here is the EARLIEST plausible rung, not the likeliest one, because the inference is
// one-directional: it may only rule a dimension OUT. Picking a higher rung would erase reds the
// evidence does not answer for.
const DIMENSIONS = [
	// `queued`, the bottom rung: the floor IS the spine, so a bar that failed anywhere failed
	// somewhere on it. There is no stage at which a composite FAIL stops being a floor concern, and
	// saying so explicitly beats omitting the field and leaving the next reader to guess whether it
	// was forgotten.
	{ id: "floor", label: "floor", gate: "(the cloud gate alone)", gates: [], reachedAt: "queued", what: "real apply → cluster_ready → ArgoCD Healthy+Synced over the derived app set" },
	// `applying`: the extra kinds are created by the SAME tofu apply as the floor's, so a bar that
	// never started applying created none of them and cannot have failed on one. This is the rung
	// azure's 2026-08-25 bar DID reach — its cache kind is a maxconfig kind and is what died — so
	// that cell keeps its red.
	{ id: "maxconfig", label: "all kinds", gate: "ALETHIA_E2E_MAX_CONFIG", gates: [{ name: "ALETHIA_E2E_MAX_CONFIG", kind: "derived" }], reachedAt: "applying", what: "every kind this cloud offers lands in tofu state (or converges as its named Application)" },
	{
		id: "addons",
		label: "18 add-ons",
		gate: "ALETHIA_E2E_ALL_ADDONS",
		gates: [{ name: "ALETHIA_E2E_ALL_ADDONS", kind: "derived" }],
		// The marketplace add-ons converge as ArgoCD Applications. Nothing about them is asserted, or
		// can be, before ArgoCD exists — which is exactly what azure's 2026-08-25 bar never got to.
		reachedAt: "argocd-installed",
		what: "all 18 marketplace add-ons Healthy+Synced",
		// THE ONE DIMENSION WHOSE COMPOSITE CREDIT COULD NEVER BE WITHHELD (#2671).
		//
		// `compositeCreditsFor` asks "were this dimension's REPO gates wired?", and `addons` has no repo
		// gate — its only gate is `derived`. `[].every(…)` is `true`, so the credit was unconditionally
		// granted, on every cloud, forever. The guard built to withhold this credit was structurally
		// incapable of withholding THIS one.
		//
		// That is fine while the assertion is trustworthy, and it was not. `argoAddOnCount` sized the
		// convergence BUDGET from the catalog while the assertion sized its SCOPE from the observed
		// applications, so a run that saw 4 Applications passed a sweep this column advertises as 18.
		// #2642 fixed the assertion. The CREDITING side stayed wrong in both directions: before that fix
		// a `full` PASS made `addons` proven from a floor-sized sweep, and after it the shrunken run
		// FAILS and the composite lands that failure on `addons` — a cell then reading "we exercised
		// add-ons and they failed" when the run died on drift with six Applications in scope.
		//
		// So the dimension states its own requirement and the credit is refused unless the bundle shows
		// it was met. Gate wiring answers "was the layer switched on?"; this answers "did the layer
		// assert what this column claims?", and those come apart.
		asserts: assertsFullAddOnSweep,
	},
	// RENAMED from `byo`, and the rename IS the correction. This column asserts A0.6 — a customer
	// apps-DESTINATION repo plus a BYO Helm chart converging as ArgoCD Applications, each managing at
	// least one real resource. Under the old label ("BYO-IaC", "customer IaC/charts applied, and
	// Alethia services bound to their outputs") three cells read as proven BYO-IaC while proving
	// this, which is a different thing. demos/proofs/provisioning-e2e-log.md recorded the
	// discrepancy and said one of the two definitions should move; this is it moving.
	//
	// NOTHING IS RETRACTED. The rows are true — the label was wrong, not the evidence — and `aliases`
	// carries them forward: ledger rows filed under `byo` key onto this column unchanged.
	// `argocd-installed`, for the same reason as `addons`: the customer repo and the BYO chart are
	// ArgoCD Applications, and there is no such surface to fail on until ArgoCD is up.
	{ id: "gitops", label: "GitOps repos", aliases: ["byo"], gate: "E2E_ARGO_APPS_REPO + E2E_GIT_TOKEN", gates: [{ name: "E2E_ARGO_APPS_REPO", kind: "repo" }, { name: "E2E_GIT_TOKEN", kind: "repo" }], reachedAt: "argocd-installed", what: "a customer apps-destination repo and a BYO Helm chart converge, and each manages at least one real resource" },
	// The proof the old `byo` column CLAIMED and never delivered: test/e2e/t2_byo_iac.go's seven-job
	// custody chain. It had never executed in CI — ALETHIA_E2E_BYO_IAC was a step-level `env:` key in
	// e2e-nightly.yml and a step-level key wins over $GITHUB_ENV, so no dimension could switch it on.
	// It now has a dimension of its own.
	//
	// `composedByFull: false` MIRRORS FULL_EXCLUDES in scripts/e2e/resolve-dimension.sh — `full` does
	// not compose this dimension, so a full-bar PASS must never credit it. The self-test READS that
	// shell file and fails if the two disagree, because a hand-kept second copy is how they drift.
	{ id: "byo-iac", label: "BYO-IaC", gate: "ALETHIA_E2E_BYO_IAC", gates: [{ name: "ALETHIA_E2E_BYO_IAC", kind: "derived" }], composedByFull: false, what: "a customer OpenTofu root module is refused when unsafe, applied through the state proxy, drifts, heals and destroys — with state cleared" },
	// `deployed`, deliberately one rung BELOW the ArgoCD surface it mostly exercises. Day-2 access is
	// "kubeconfig / ArgoCD surface", so `argocd-ready` would be the tighter guess — and a tighter
	// guess here erases reds on a hunch. `deployed` is the point past which a day-2 failure is at
	// least possible, which is all this is allowed to assert.
	{ id: "day2", label: "day-2", gate: "ALETHIA_E2E_SOAK (dimension) / E2E_DAY2_ACCESS", gates: [{ name: "ALETHIA_E2E_SOAK", kind: "derived" }, { name: "E2E_DAY2_ACCESS", kind: "repo" }], reachedAt: "deployed", what: "a real access path beyond the soak — kubeconfig / ArgoCD surface" },
	// MVP predicate 4's second half. The reachability bar already answers the first — the command
	// surface resolves, with zero CLI gaps — but the product has never been PROVISIONED through the
	// binary: the T2 spine writes the DEPLOY job straight into Postgres, so the CLI has never been
	// the actor. This column exists so that gap is COUNTED rather than described, which is the same
	// reason `byo-iac` got a column of its own.
	//
	// `composedByFull: false`, mirroring FULL_EXCLUDES: `full` re-drives the same spine through a
	// seeded job row, so composing it in would buy a second cluster plus a console build per bar and
	// red three cells on a CLI defect. A full-bar PASS must never credit this.
	{ id: "cli-demo", label: "CLI-driven", gate: "ALETHIA_E2E_CLI_DEMO_PROVISION", gates: [{ name: "ALETHIA_E2E_CLI_DEMO_PROVISION", kind: "derived" }], composedByFull: false, what: "a floor-shaped cluster provisioned through the real `alethia` binary rather than a seeded job row — the ACTOR, not the surface area" },
];
// The composite dimension. A PASS here is evidence for every dimension the full bar ACTUALLY
// EXERCISES — which is not the same as every dimension in DIMENSIONS, and the difference is
// load-bearing. `full` (scripts/e2e/resolve-dimension.sh) exports SOAK + MAX_CONFIG + ALL_ADDONS
// and nothing else, so a dimension gated on a `repo` variable that is unset green-skips inside the
// run. See deriveCell's `compositeCredits`: the composite credits a dimension only once every
// `repo`-kind gate it declares is wired, and refuses on `unknown` so a missing snapshot cannot buy
// a proof.
const COMPOSITE = "full";

const LEDGER_VERDICTS = new Set(["PASS", "FAIL", "RETRACTED", "BLOCKED"]);

// ───────────────────────────── parsing ─────────────────────────────

/**
 * Parse the append-only proof ledger. Rows are `| date | sha | cloud | dimension | **VERDICT** |
 * detail | bundle | issue |`. Order matters: the file is append-only and a RETRACTED row VOIDS the
 * earlier claim for its (cloud, dimension) pair rather than replacing it with a verdict of its own.
 * @returns {{rows: object[], errors: string[]}}
 */
export function parseLedger(text) {
	const rows = [];
	const errors = [];
	for (const [i, line] of text.split("\n").entries()) {
		if (!line.trimStart().startsWith("|")) continue;
		const cells = line.split("|").slice(1, -1).map((c) => c.trim());
		if (cells.length < 8) continue;
		if (/^UTC date$/i.test(cells[0]) || /^-+$/.test(cells[0])) continue;
		const verdict = cells[4].replace(/\*/g, "").trim().toUpperCase();
		if (!LEDGER_VERDICTS.has(verdict)) {
			errors.push(`${LEDGER}:${i + 1}: unknown verdict ${JSON.stringify(cells[4])} — expected one of ${[...LEDGER_VERDICTS].join(", ")}`);
			continue;
		}
		rows.push({
			line: i + 1,
			date: cells[0],
			sha: cells[1],
			cloud: cells[2].toLowerCase(),
			dimension: cells[3].toLowerCase(),
			verdict,
			detail: cells[5],
			bundle: cells[6].replace(/`/g, "").trim(),
			issue: cells[7] === "—" ? "" : cells[7],
		});
	}
	return { rows, errors };
}

/**
 * A bundle reference is one of three things, and the difference decides whether a PASS can be
 * believed. A committed PATH can be checked here. A bare `nightly-<run_id>` RUN TAG names a CI
 * artifact that expires (retention-days: 30) and is unverifiable offline — so it can never support
 * `proven`. Saying "unverifiable" is the whole point: the four 2026-07-22 PASSes carried run tags
 * and were later RETRACTED because no bundle had ever existed.
 * @returns {"path"|"run-tag"|"none"}
 */
/**
 * Do a ledger row's sha and its bundle's sha name the same commit?
 *
 * BOTH DIRECTIONS, because the two are abbreviated independently and to different lengths — the
 * ledger carries 7- and 8-character forms side by side (`7050809` next to `29d4074e`), so a
 * one-way `startsWith` would call half the real matches a mismatch and the other half a match
 * depending only on which side happened to be shorter.
 *
 * A minimum length is required so that emptiness, `unknown`, or a truncated cell cannot agree with
 * everything. Anything shorter than a git short-sha is not a comparison, it is a coincidence.
 * @param {string} rowSha
 * @param {string} bundleSha
 */
export function shasAgree(rowSha, bundleSha) {
	const a = (rowSha ?? "").trim().toLowerCase();
	const b = (bundleSha ?? "").trim().toLowerCase();
	const MIN = 7;
	if (a.length < MIN || b.length < MIN) return false;
	if (!/^[0-9a-f]+$/.test(a) || !/^[0-9a-f]+$/.test(b)) return false;
	return a.startsWith(b) || b.startsWith(a);
}

export function bundleKind(ref) {
	if (!ref) return "none";
	if (ref.startsWith(`${PROOFS_DIR}/`) || /^[a-z]+\/\d{8}T\d{6}Z$/.test(ref)) return "path";
	if (/^nightly-\d+$/.test(ref) || /^gate-\d+/.test(ref)) return "run-tag";
	return "none";
}

/** Resolve a `path`-kind bundle reference to a repo path. */
export function bundlePath(ref) {
	return ref.startsWith(`${PROOFS_DIR}/`) ? ref : path.join(PROOFS_DIR, ref);
}

/**
 * Collapse the ledger into the surviving claim per (cloud × dimension). Append-only + RETRACTED
 * supersession means "the last row wins" is WRONG: a RETRACTED row removes a claim rather than being
 * one. So we replay in file order and let RETRACTED clear the slot.
 * @returns {Map<string, object|null>} "cloud/dimension" → the surviving row, or null if voided
 */
/**
 * Did this leg actually get PAST its cloud gate?
 *
 * The `Record gate-off proof` step runs only when the gate is OFF, so a naive reading is
 * `conclusion === "skipped"`. That reading is UNSOUND, and the failure mode is the one this whole
 * mechanism exists to avoid — pointing the other way.
 *
 * The step carries a bare `if: steps.gate.outputs.run == 'false'`, and a bare `if:` implies
 * `success()`. So `skipped` means EITHER:
 *
 *   - the gate was ON and the leg proceeded            → reached
 *   - an EARLIER step failed, so this one never ran     → NOT reached
 *
 * The second would print a confident ✅ for a leg that never started. A false green is worse than
 * the `? unknown` it replaces, because the hedge at least invites somebody to check.
 *
 * So an earlier failure disqualifies the reading. A failure AFTER the gate-off step does not — that
 * leg genuinely did pass its gate and then broke on something else, which is exactly what gcp did on
 * 2026-08-26 (it died at *Configure GCP credentials*, step 20-odd, long past the gate at step 6).
 *
 * A cleaner mechanism exists and the workflow already names it: have the gate-off step STAMP its own
 * provenance, so a POSITIVE marker is the signal. A marker cannot be produced by a step that never
 * ran, where an absence can be produced by three different things. That is a workflow change; this
 * is the sound reading of what the workflow emits today.
 *
 * @returns {boolean|null} null when the observation cannot be read at all.
 */
export function gateReached(observation) {
	if (!observation || typeof observation.gate_off !== "string") return null;
	if (observation.earlier_failure === true) return false;
	return observation.gate_off === "skipped";
}

/**
 * Ledger dimension token → the column it belongs to. A RENAMED dimension keeps its old token working
 * here rather than having its rows rewritten: the ledger is append-only, the rows were true when
 * written, and rewriting history to match a corrected label is the more expensive error.
 * @type {Map<string, string>}
 */
/**
 * Did this run assert the WHOLE marketplace add-on surface? `"yes"` · `"no"` · `"unknown"`.
 *
 * THREE-VALUED, AND THE THIRD VALUE IS THE POINT. Bundles in this tree come in three shapes and
 * collapsing any of them onto a boolean gets one of the two failures this exists to prevent:
 *
 *   · pre-#2688 bundles carry `argocd_total: 0` and `argocd_healthy_synced: 0` for EVERY run,
 *     passing and failing alike, because capture-proof.sh counted the cluster AFTER teardown had
 *     already removed it. Reading that 0 as an observation refuses every historical credit.
 *   · older bundles still carry neither field. Reading absent as "fine" reinstates the hole.
 *   · post-#2688 bundles carry the ASSERTION-TIME counts, written by AssertArgoAppsHealthy before
 *     the cleanup runs, and `null` where nothing was measured.
 *
 * SO IT READS THE ASSERTED FIELDS, NOT THE CAPTURED ONES, and this is where #2671's own suggestion
 * has been overtaken: it proposed `argocd_total`, which is exactly the capture-time field that
 * #2688 made `null` on purpose. A check written against it today would find `null` in every new
 * bundle — the newest bundle in the tree carries `argocd_total: null` beside
 * `argocd_healthy_synced_asserted: 8` — and, written the obvious way, credit the dimension anyway.
 * That is this repo's dominant defect class landing inside the fix for it.
 *
 * `unknown` REFUSES the credit and says which bundle could not be measured. Refusing is the safe
 * direction here for the same reason the run-tag rule is: a PASS nobody can check is not a proof,
 * and the cost of being wrong is a cell that reads `never_run` until somebody re-runs it.
 */
export function assertsFullAddOnSweep(summary, required) {
	if (!summary || typeof summary !== "object") return "unknown";
	const expected = summary.argocd_expected_total;
	const asserted = summary.argocd_healthy_synced_asserted;
	const outcome = summary.argocd_assert_outcome;
	// Neither assertion-time field present at all: a bundle written before #2688 taught the harness to
	// record what it asserted. Not measurable, in either direction.
	if (typeof expected !== "number" && typeof asserted !== "number") return "unknown";
	if (typeof expected !== "number" || typeof asserted !== "number") return "unknown";
	// The harness's own word for "the assertion did not run or could not read the cluster". Trusting
	// the counts beside it would be trusting numbers it has just disclaimed.
	if (outcome !== undefined && outcome !== "converged") return "unknown";
	if (!Number.isFinite(required) || required <= 0) return "unknown";
	return expected >= required && asserted >= required ? "yes" : "no";
}

/**
 * Did this run get FAR ENOUGH for `requiredStage`'s dimension to be at fault? `"yes"` · `"no"` ·
 * `"unknown"`.
 *
 * THE DEFECT THIS ANSWERS (#3243). `full` credits and discredits four columns together, and the two
 * directions were reading DIFFERENT facts. `compositeCredits` already refuses to CREDIT a dimension
 * from a bar PASS unless the bar demonstrably exercised it — `composedByFull`, the repo gates, and
 * (for `addons`) the bundle's own assertion counts. Nothing symmetrical governed the DISCREDIT, so a
 * bar that died in `apply` marked every composed column FAIL, including three surfaces it never
 * touched. `azure/addons` read ❌ off a 2026-08-25 bar that died on the `cache` kind at
 * `deploy_stage: applying`, 1724 seconds in and long before ArgoCD existed: nobody has ever observed
 * an add-on fail on azure, and the cell said somebody had.
 *
 * ONE DIRECTION ONLY, AND THAT IS THE WHOLE DESIGN. `deploy_stage` supports the inference "the run
 * never reached rung N, so the failure cannot belong to a dimension that begins at rung N". It does
 * NOT support the converse — reaching `argocd-ready` does not make a failure the add-ons' fault, it
 * only stops ruling them out. So this rules dimensions OUT and never in, and a `"yes"` leaves the
 * red exactly where it was.
 *
 * THREE-VALUED, AND `"unknown"` KEEPS THE RED — the opposite of `assertsFullAddOnSweep`, on purpose.
 * There, refusing was safe: the cost of being wrong is a cell reading `never_run` until somebody
 * re-runs it. Here the costs are reversed. Withholding a discredit turns ❌ into `never_run`, which
 * un-ranks the cell and drops a diagnosed failure off the board — so an unreadable bundle must not
 * be able to erase a recorded FAIL. Only a bundle that positively says the run stopped short does
 * that. Both directions still land in `never_run` and NEITHER can produce `proven`: turning a false
 * FAIL into a false PASS would be a worse bug than the one this fixes.
 *
 * @param {unknown} summary the run's parsed `provision-summary.json`, or null when unreadable
 * @param {unknown} requiredStage the dimension's `reachedAt`
 * @returns {"yes"|"no"|"unknown"}
 */
export function compositeReached(summary, requiredStage) {
	if (!summary || typeof summary !== "object") return "unknown";
	// A stage this file's ladder does not carry means capture-proof.sh has grown a rung and the two
	// vocabularies have drifted. `indexOf` would answer -1, and -1 compares as "before everything",
	// which would silently withhold every discredit — the "nothing found" branch reading as "nothing
	// wrong". `--self-test` fails the build on that drift; here it is `unknown`, which keeps the red.
	const stage = summary.deploy_stage;
	if (typeof stage !== "string") return "unknown";
	const got = DEPLOY_STAGES.indexOf(stage);
	if (got < 0) return "unknown";
	// The same trap pointed the other way, and ONE guard covers every shape of it: an undeclared,
	// misspelled or non-string `reachedAt` all answer -1, and `got >= -1` is true for every run,
	// which would grant every discredit and quietly restore the bug. A requirement nobody declared is
	// not a requirement of zero. (A separate `typeof` check here would be dead code — `findIndex`
	// matches nothing for a number or for `undefined` either — and dead code that looks like a guard
	// is worse than none, because the next reader trusts it.)
	const need = DEPLOY_STAGES.findIndex((s) => s === requiredStage);
	if (need < 0) return "unknown";
	return got >= need ? "yes" : "no";
}

export const DIMENSION_ALIASES = new Map(DIMENSIONS.flatMap((d) => (d.aliases ?? []).map((a) => [a, d.id])));

/** Resolve a ledger row's dimension token to its column id. */
export function canonicalDimension(token) {
	return DIMENSION_ALIASES.get(token) ?? token;
}

/**
 * The ONE dimension label that names a composite run rather than a grid column.
 *
 * `scripts/e2e/resolve-dimension.sh`'s `dimension_label()` is the emitter, and its vocabulary is
 * closed: `full` → `full-bar`; `maxconfig|addons|byo|gitops|byo-iac|day2|cli-demo` → itself; `floor`
 * and the UNSET token → `floor`; anything else is REFUSED rather than labelled. Every one of those
 * is a grid column (`byo` through DIMENSION_ALIASES) EXCEPT `full-bar`, which names a bar that
 * exercises the whole row. `--self-test` pins the two vocabularies together.
 *
 * The refusal arm is the fix for #4086. `cli-demo` was missing from the enumerated arm and fell
 * through the old permissive `*) echo "floor"`, so a cli-demo red and a genuine floor red on one
 * cloud produced the SAME title — and `parseNightlyRed` below reads that title as the dedup key, so
 * the two collapsed onto one issue. #4086 itself was filed as "hetzner RED (floor)" for a cli-demo
 * console build failure that never touched a cloud.
 */
export const COMPOSITE_RED_DIMENSION = "full-bar";

/**
 * Which grid columns a nightly RED's dimension label refers to.
 *
 * THREE ANSWERS, NEVER TWO. A label this file does not recognise returns an EMPTY list with
 * `known:false`, and the caller must not read that as "no cells affected" — it is "we could not
 * tell", which is a different statement and the one that has to be reported.
 *
 * This existed as a bare `grid[cloud]?.[dim]` lookup whose miss was a silent `continue`, and
 * `full-bar` fell straight through it: five open bar-wide REDs (#2550 #2384 #2383 #2382 #2099) were
 * invisible to the contested check in BOTH directions, so a bar that went red after a cell was
 * proven contested nothing at all.
 *
 * `compositeIds` is the set the BAR actually exercises, which is NOT every column: `cli-demo`
 * carries `composedByFull: false` (mirroring FULL_EXCLUDES) because `full` re-drives the spine
 * through a seeded job row and must never credit the real-binary cell. Passing every column instead
 * would hold a bar-wide red open forever on a cell that bar never ran.
 *
 * @returns {{known: boolean, composite: boolean, dimensions: string[]}}
 */
export function redDimensions(label, dimensionIds, compositeIds) {
	const dim = canonicalDimension(label);
	if (dim === COMPOSITE_RED_DIMENSION) return { known: true, composite: true, dimensions: [...compositeIds] };
	if (dimensionIds.includes(dim)) return { known: true, composite: false, dimensions: [dim] };
	return { known: false, composite: false, dimensions: [] };
}

export function collapseLedger(rows) {
	/** @type {Map<string, object|null>} */
	const claims = new Map();
	for (const r of rows) {
		const key = `${r.cloud}/${canonicalDimension(r.dimension)}`;
		if (r.verdict === "RETRACTED") {
			claims.set(key, null); // the earlier claim is void; the pair is back to "no evidence"
			continue;
		}
		claims.set(key, r);
	}
	return claims;
}

/**
 * Which `ALETHIA_E2E_*` / `E2E_*` / cloud-token names the nightly workflow actually references.
 *
 * "References" means the name appears anywhere executable in the file, NOT just as a YAML `env:`
 * key. The fidelity vars are exported by the resolve step as `echo "ALETHIA_E2E_MAX_CONFIG=1" >>
 * "$GITHUB_ENV"`, so an `env:`-key-only match reported the two heaviest dimensions as unreachable
 * when the workflow sets them itself — a false "no" is worse than no column, because it sends
 * somebody to wire a gate that is already wired.
 */
export function referencedGates(workflowText, resolverText = "") {
	const names = new Set();
	for (const line of (workflowText + "\n" + resolverText).split("\n")) {
		if (/^\s*#/.test(line)) continue;
		for (const m of line.matchAll(/\b(?:vars|secrets)\.([A-Z0-9_]+)\b/g)) names.add(m[1]);
		for (const m of line.matchAll(/\b(ALETHIA_E2E_[A-Z0-9_]+|E2E_[A-Z0-9_]+)\b/g)) names.add(m[1]);
	}
	return names;
}

/**
 * The 19-kind canvas parity grid: per cloud, which NodeKinds the product refuses. Source is the ONE
 * file that drives both the palette and the deploy-time fail-closed gate, so this cannot disagree
 * with what a user actually sees.
 * @returns {Record<string, string[]>}
 */
export function parseUnsupportedKinds(tsText) {
	const body = tsText.match(/UNSUPPORTED_KINDS_BY_PROVIDER[^=]*=\s*\{([\s\S]*?)\n\}/);
	if (body === null) return {};
	/** @type {Record<string, string[]>} */
	const out = {};
	for (const m of body[1].matchAll(/([a-z]+)\s*:\s*\[([^\]]*)\]/g)) {
		out[m[1]] = [...m[2].matchAll(/["']([a-z_]+)["']/g)].map((k) => k[1]);
	}
	return out;
}

// ───────────────────────────── derivation ─────────────────────────────

/**
 * The programme state of one (cloud × dimension) cell. Six values; there is no "unknown" that could
 * be mistaken for progress, and no default that reads as pending.
 */
export const STATE = {
	proven: "proven",
	failing: "failing",
	blocked: "blocked",
	neverRun: "never_run",
	// The last verdict was FAIL but its cause is CLOSED — needs a re-run, not a fix. Distinct from
	// `failing` (open work) and from `never_run` (never attempted): it has been attempted, and what it
	// is waiting for is the cheapest possible action.
	stale: "stale",
	// The ledger's surviving claim is PASS, and an OPEN nightly-red issue for the same cell was
	// filed AFTER the run that proved it. Neither source is wrong on its own terms and this state
	// takes no side: it says the two disagree and that the ✅ is not currently trustworthy.
	contested: "contested",
	ceiling: "ceiling",
	deferred: "deferred",
	cost: "cost",
};

const STATE_GLYPH = {
	proven: "✅",
	failing: "❌",
	blocked: "⛔",
	never_run: "·",
	stale: "♻️",
	contested: "⚠️",
	ceiling: "—",
	deferred: "🔶",
	cost: "💰",
};

/**
 * Derive one cell. `claims` is the collapsed ledger.
 *
 * `compositeCredits` decides whether this cloud's surviving `full` claim counts as evidence for
 * THIS dimension. It is not always true, and assuming it was is what this parameter exists to stop:
 * the `full` token exports only SOAK + MAX_CONFIG + ALL_ADDONS (scripts/e2e/resolve-dimension.sh),
 * so a dimension whose gate is a repo variable nobody set GREEN-SKIPS inside the full run. Crediting
 * it anyway promotes a scenario that never executed to `proven` — the exact green-skip-as-proof
 * failure that retracted every 2026-07-22 row.
 *
 * `compositeRefusedWhy` carries the caller's reason when there is one. There is more than one way to
 * refuse the credit now (#2671 added "the bundle does not show the assertion this column claims"),
 * and the hardcoded sentence below would confidently name the wrong cause for every new reason — a
 * refusal that names a cause it did not establish is a defect this file has already shipped twice.
 *
 * `compositeDiscredits` is the SAME question pointed at a FAIL, and it exists because the two
 * directions were not symmetrical (#3243). A composite claim that counts against this dimension is a
 * positive statement — "this dimension was exercised, and it broke" — so it has to earn the same
 * thing a credit does: evidence that the bar reached the dimension at all. `azure/addons` read ❌ off
 * a bar that died in `apply` on the `cache` kind, which is a cause never observed on that surface.
 *
 * BOTH REFUSALS LAND IN `never_run`, AND NEITHER CAN REACH `proven`. A withheld discredit removes a
 * verdict; it never manufactures one. Turning a false FAIL into a false PASS would be strictly worse
 * than the bug being fixed here, so the refusal path returns the same honest "nothing was measured"
 * state as every other refusal, carrying a `why` that says which of the two it was.
 *
 * @returns {{state: string, why: string, row: object|null}}
 */
export function deriveCell({ cloud, dimension, claims, bundleExists, compositeCredits = true, compositeRefusedWhy = null, compositeDiscredits = true, compositeWithheldWhy = null }) {
	const direct = claims.get(`${cloud}/${dimension}`) ?? null;
	const compositeClaim = claims.get(`${cloud}/${COMPOSITE}`) ?? null;
	// Which direction is this composite claim pointing? A FAIL counts AGAINST the dimension, so the
	// caller's discredit gate governs it; everything else counts FOR it (or is neutral) and the credit
	// gate governs. Reading one gate for both is the asymmetry #3243 names: a bar PASS could not
	// credit a green-skipped layer, and the identical bar FAIL discredited it anyway.
	//
	// BLOCKED is deliberately left on the credit side and is NOT reach-checked. Its rendered sentence
	// is "the harness refused before spending", which is true of every dimension in a refused bar and
	// attributes the failure to none of them. There is no false accusation to withhold.
	const against = compositeClaim !== null && compositeClaim.verdict === "FAIL";
	const counts = against ? compositeDiscredits : compositeCredits;
	const refusedWhy = against ? compositeWithheldWhy : compositeRefusedWhy;
	const composite = counts ? compositeClaim : null;
	// A direct claim beats the composite: it is the more specific statement about this dimension.
	const row = direct ?? composite;
	if (row === null) {
		// Say WHICH branch we are in. "No claim at all" and "a claim we refused to count" are
		// different facts, and collapsing them hides the refusal that is the whole point here.
		const why =
			compositeClaim === null
				? "no surviving ledger claim"
				: refusedWhy
					? `no surviving ledger claim — ${refusedWhy}`
					: `no surviving ledger claim — this cloud's \`${COMPOSITE}\` run does NOT count for this dimension, whose layer green-skips until its repo gate is set`;
		return { state: STATE.neverRun, why, row: null };
	}
	const via = direct === null ? ` (via the \`${COMPOSITE}\` composite run)` : "";
	if (row.verdict === "FAIL") {
		return { state: STATE.failing, why: `ledger ${row.date}${via}`, row };
	}
	if (row.verdict === "BLOCKED") {
		return { state: STATE.blocked, why: `ledger ${row.date}${via} — refused before spending`, row };
	}
	// PASS is the only verdict that must EARN its state, because it is the only one anybody is
	// tempted to overstate. A PASS whose bundle cannot be produced is not a proof.
	const kind = bundleKind(row.bundle);
	if (kind !== "path") {
		return {
			state: STATE.neverRun,
			why:
				kind === "run-tag"
					? `ledger ${row.date} claims PASS but its bundle \`${row.bundle}\` is an EXPIRING CI run tag, not a committed path — unverifiable, so not a proof`
					: `ledger ${row.date} claims PASS with no bundle reference — unverifiable, so not a proof`,
			row,
		};
	}
	if (!bundleExists(bundlePath(row.bundle))) {
		return { state: STATE.neverRun, why: `ledger ${row.date} claims PASS but bundle \`${row.bundle}\` is MISSING from the tree`, row };
	}
	return { state: STATE.proven, why: `ledger ${row.date}${via}, bundle \`${row.bundle}\``, row };
}

/**
 * How long a CARRIED gate inventory may stand before every declared gate reads `unknown`.
 *
 * Measured between two PERSISTED timestamps — `inventory_observed_at` and `derived_at` — never
 * against the wall clock, so the rendered region stays a pure function of the snapshot.
 */
export const INVENTORY_FRESH_HOURS = 24 * 7;

/**
 * The window a nightly RED may close inside and still be counted, when the snapshot does not carry
 * a `previous_derived_at` to bound it exactly. One nightly cadence: programme.yml runs at 08:47.
 */
export const DERIVATION_WINDOW_FALLBACK_HOURS = 24;

/**
 * The cell a nightly RED issue names, parsed out of its title — or `null`.
 *
 * ONE PARSER, TWO CALLERS. Open reds and reds that closed inside the derivation window are the same
 * fact arriving through two lists, and a second copy of this regex would be a second vocabulary to
 * keep in step with `dimension_label()` — which `--self-test` pins statically against exactly one.
 *
 * `matrix` is skipped deliberately: those issues say "no per-leg proof" and are about the matrix job
 * itself, not about any cloud's cell.
 *
 * @returns {{cloud: string, dimension: string, number: number, date: string}|null}
 */
export function parseNightlyRed(issue) {
	const m = /^e2e nightly:\s*(\S+)\s+RED\s*\(([^)·]+?)\s*(?:·[^)]*)?\)/.exec(issue?.title ?? "");
	if (!m || m[1] === "matrix") return null;
	return { cloud: m[1], dimension: m[2].trim(), number: issue.number, date: String(issue.createdAt ?? "").slice(0, 10) };
}

/**
 * Build the whole programme view. Pure — every input is passed in, so `--self-test` drives it with
 * fixtures and the real run reads files once.
 */
/**
 * The LIVE board half. `snapshot` is the committed output of scripts/programme-fetch.sh, or null when
 * absent. Everything here is three-valued on purpose: with no snapshot the answer is `unknown`, and
 * `unknown` never collapses to either value — a cell may not leave `never_run`, and a gate may not be
 * called unwired, on the strength of a file nobody fetched.
 */
export function deriveBoard(snapshot) {
	if (snapshot === null || snapshot === undefined) {
		return {
			present: false,
			ageHours: null,
			issueState: () => "unknown",
			issueListComplete: null,
			inventoryObservedAt: null,
			inventoryAgeHours: null,
			inventoryPresent: false,
			inventoryFresh: null,
			windowStart: null,
			windowClosedRedIssues: [],
			gateState: () => "unknown",
			observedGate: () => null,
			reaperObservation: () => null,
			derivedAt: null,
			needsHuman: [],
			// Empty, not "no contradictions". With no snapshot there is nothing to contradict the
			// ledger WITH, and the check below is skipped rather than reported as clean — absence of
			// evidence must not render as evidence of absence in a file whose point is trust.
			openRedIssues: [],
		};
	}
	// Newest-first in the snapshot, so the FIRST entry per cloud is the most recent observation.
	// Built defensively: a snapshot written before this field existed simply has none, and every
	// cloud falls back to the declared inventory rather than reading as unobserved-and-therefore-off.
	const observations = new Map();
	// (see gateReached below — the snapshot carries raw facts, this file decides what they mean)
	for (const o of snapshot.gate_observations ?? []) {
		if (o && typeof o.provider === "string" && !observations.has(o.provider)) {
			observations.set(o.provider, o);
		}
	}
	const reaperObservations = new Map();
	for (const o of snapshot.orphan_reaper_observations ?? []) {
		if (o && typeof o.provider === "string" && !reaperObservations.has(o.provider)) {
			reaperObservations.set(o.provider, o);
		}
	}
	const open = new Map((snapshot.open_issues ?? []).map((i) => [i.number, i]));
	const closed = new Map((snapshot.closed_issues ?? []).map((i) => [i.number, i]));
	const names = new Set([...(snapshot.variables ?? []), ...(snapshot.secrets ?? [])]);
	const derivedAt = snapshot.derived_at ? Date.parse(snapshot.derived_at) : NaN;

	// ── HOW OLD IS THE READING, not how old is the FILE. ──────────────────────────────────────────
	//
	// `programme-fetch.sh` cannot list repo variables or secrets — no workflow permission scope for
	// it exists — so EVERY nightly carries the previous inventory forward and stamps
	// `inventory_observed_at` with the moment it was actually observed. That field was written and
	// read by nothing: the only staleness rule ages `derived_at`, which the same run re-stamps, so
	// the bound could never bind. `derived_at` reached 2026-09-01 against an inventory observed
	// 2026-08-27, and deleting `E2E_ARGO_APPS_REPO` would have left the GitOps row rendering
	// `✅ wired` indefinitely.
	//
	// So it is measured HERE, and against `derived_at` rather than the clock — two persisted
	// timestamps, so the rendered region stays byte-identical until the snapshot changes.
	//
	// A MISSING OR UNREADABLE FIELD IS `unknown`, NOT FRESH. A non-empty inventory with no record of
	// when it was observed is precisely the state this rule exists to refuse; reading absence as
	// freshness would restore the defect for any snapshot written by an older fetch.
	const inventoryObservedAt = typeof snapshot.inventory_observed_at === "string" && snapshot.inventory_observed_at !== "" ? snapshot.inventory_observed_at : null;
	const observedAtMs = inventoryObservedAt === null ? NaN : Date.parse(inventoryObservedAt);
	const inventoryAgeHours = Number.isNaN(observedAtMs) || Number.isNaN(derivedAt) ? null : (derivedAt - observedAtMs) / 3_600_000;
	// Negative is FRESH, not suspicious: `inventory_observed_at` is stamped a few seconds AFTER
	// `derived_at` within the same run, so an un-carried reading is normally a hair in the future.
	const inventoryFresh = inventoryAgeHours !== null && inventoryAgeHours <= INVENTORY_FRESH_HOURS;
	// A repo with zero variables AND zero secrets is not a state this repo can be in — it needs both
	// to run anything. So an empty inventory is evidence the fetch failed, not evidence of absence.
	// A STALE inventory gets the same `unknown`, and for the same reason: it is not a measurement of
	// today, and a gate deleted since it was taken would still read wired.
	const gatesKnown = names.size > 0 && inventoryFresh;

	// ── THE DERIVATION WINDOW. ────────────────────────────────────────────────────────────────────
	//
	// Issues that closed since the previous snapshot. A red filed and closed BETWEEN two refreshes
	// appears in neither one's `open_issues`, so nothing contests its cell and no cell cites it, so
	// staleness cannot fire either — #3580 was filed 09:46Z, closed 11:25Z, and the 11:32Z snapshot
	// published `0 failing` for a leg that had failed that morning.
	//
	// `previous_derived_at` is the exact boundary and is recorded by the fetch. The 24h fallback is
	// for a snapshot written before that field existed: the cadence is nightly, so one day is the
	// window it would have had. Without either timestamp there is no window and nothing is claimed.
	const previousDerivedAt = snapshot.previous_derived_at ? Date.parse(snapshot.previous_derived_at) : NaN;
	const windowStart = !Number.isNaN(previousDerivedAt)
		? previousDerivedAt
		: Number.isNaN(derivedAt)
			? null
			: derivedAt - DERIVATION_WINDOW_FALLBACK_HOURS * 3_600_000;

	// The snapshot carries the only timestamp in the mechanism, so "now" is read here and never
	// rendered — a clock inside a diff-gated region would make every PR stale on arrival.
	const ageHours = Number.isNaN(derivedAt) ? null : (Date.now() - derivedAt) / 3_600_000;
	return {
		present: true,
		ageHours,
		/**
		 * Is the issue list COMPLETE? Three-valued: `true` complete, `false` truncated, `null` the
		 * snapshot cannot say.
		 *
		 * A count cannot tell "exactly N" from "capped at N", and `--limit 500` had been silently
		 * dropping 228 closed issues per refresh. It matters because `issueState` answers `unknown`
		 * for a dropped issue while `staleCitations` fires only on `closed`, so a red cell citing one
		 * stays `failing` forever.
		 *
		 * `null` IS NOT `true`, and the distinction is not academic: the snapshot in the tree when
		 * this was written WAS capped at 500 and carries no flag, because the fetch that wrote it
		 * could not answer the question. Reading a missing flag as "complete" would render that
		 * snapshot clean — the same collapse of unknown into a value that this file refuses
		 * everywhere else.
		 */
		issueListComplete:
			snapshot.closed_issues_truncated === undefined && snapshot.open_issues_truncated === undefined
				? null
				: snapshot.closed_issues_truncated !== true && snapshot.open_issues_truncated !== true,
		/** When the gate inventory was actually observed, verbatim, or null. */
		inventoryObservedAt,
		/** How much older than `derived_at` that reading is, in hours, or null when unmeasurable. */
		inventoryAgeHours,
		/** Was anything at all fetched? Distinguishes "stale reading" from "no reading". */
		inventoryPresent: names.size > 0,
		/** Is that reading recent enough to act on? */
		inventoryFresh,
		/** Epoch ms the derivation window opens at, or null. */
		windowStart,
		/** The snapshot's own timestamp, verbatim — the only form safe to RENDER (see the provenance note). */
		derivedAt: snapshot.derived_at ?? null,
		/** @returns {"open"|"closed"|"unknown"} */
		issueState: (ref) => {
			const n = Number(String(ref ?? "").replace(/^#/, ""));
			if (!Number.isFinite(n) || n === 0) return "unknown";
			if (open.has(n)) return "open";
			if (closed.has(n)) return "closed";
			return "unknown"; // beyond the fetch limit, or a different repo — never guess "open"
		},
		/** @returns {"wired"|"unwired"|"unknown"} */
		/**
		 * @returns {"wired"|"unwired"|"unknown"}
		 *
		 * An EMPTY gate inventory means "nobody fetched them", not "none are set" — the same
		 * epistemic state as an absent snapshot, and it gets the same `unknown`.
		 *
		 * This is not hypothetical. `scripts/programme-fetch.sh` swallowed the error from
		 * `gh variable list` / `gh secret list` and substituted `[]`, and programme.yml grants the
		 * default token only `contents: write` + `pull-requests: write` — which cannot read repo
		 * variables or secrets at all. So every refresh produced `variables: [], secrets: []` beside
		 * 42 correctly-fetched issues, and the board rendered EVERY gate `⛔ unwired` — including
		 * `HCLOUD_TOKEN`, which a green hetzner run had already proven wired.
		 *
		 * Collapsing that to `unwired` is the expensive direction, because `deriveCell`'s
		 * `compositeCredits` refuses to credit a dimension whose repo gate reads unwired: a full-bar
		 * PASS would silently not credit `byo` or `day2`, and the fix for one green-skip-as-proof bug
		 * would have been disarmed by another. `unknown` keeps the refusal honest — it says the gate
		 * was not measured rather than asserting it is off.
		 */
		gateState: (name) => (gatesKnown ? (names.has(name) ? "wired" : "unwired") : "unknown"),
		/**
		 * What the nightly OBSERVED for one cloud, or null.
		 *
		 * A DIFFERENT AND BETTER QUESTION than gateState's. That one answers "is this gate
		 * DECLARED?"; this answers "did a leg actually get past it?". They come apart, and gcp is the
		 * standing proof: `E2E_GCP_WIF_PROVIDER` was set the whole time while every dispatch died at
		 * *Configure GCP credentials*, because a bare apply on infra/gcp-e2e narrowed the WIF trust
		 * to ref-only. A variable listing would have printed a confident ✅ for a cloud that had not
		 * federated in weeks — a false green in the one region of this file whose whole purpose is
		 * that its status half can be trusted.
		 *
		 * Sourced from the `Record gate-off proof` step, which runs ONLY when the gate is off — see
		 * `gateReached` for why its conclusion alone is not enough to read.
		 */
		observedGate: (cloud) => observations.get(cloud) ?? null,
		/** The newest persisted real-reclaim result for one cloud, or null. */
		reaperObservation: (cloud) => reaperObservations.get(cloud) ?? null,
		needsHuman: [...open.values()].filter((i) => (i.labels ?? []).includes("needs:human")),
		/**
		 * Every OPEN nightly-red issue, parsed out of its title, as `{cloud, dimension, number, date}`.
		 *
		 * The ledger cannot see these. A nightly that goes red files an issue and writes NO ledger
		 * row, so from the ledger's point of view the failure never happened and a cell proven
		 * earlier stays proven forever. That makes the grid a HIGH-WATER MARK rather than current
		 * state, in the direction that overstates. This is the only source that can contradict it.
		 *
		 * `matrix` is skipped deliberately: those issues say "no per-leg proof" and are about the
		 * matrix job itself, not about any cloud's cell.
		 */
		openRedIssues: [...open.values()].flatMap((i) => {
			const red = parseNightlyRed(i);
			return red === null ? [] : [red];
		}),
		/**
		 * Every nightly RED that was CLOSED inside this derivation window — filed and resolved
		 * between the previous snapshot and this one, so it never appeared in any `open_issues`.
		 *
		 * THE ONE STATE NEITHER EXISTING CHECK CAN SEE. `openRedIssues` contests a cell only while
		 * the issue is open; `staleCitations` fires only on a closed issue a cell CITES, and a
		 * nightly red writes no ledger row so no cell cites it. #3580 was filed 2026-09-01T09:46Z
		 * for the run whose gcp leg failed at *T2 — real runner provisions a real cloud cluster*,
		 * closed 11:25Z, and the 11:32Z snapshot published `0 failing` and `gcp/floor ✅`.
		 *
		 * A red is evidence whether or not its issue is still open. This is the list that says so.
		 *
		 * It is deliberately BOUNDED by the window rather than by "is closed". A closed red that was
		 * already visible to an earlier derivation has had the file's documented clearing act applied
		 * to it — "close the issue if that run was a flake" — and reviving it forever would contest
		 * every cell that ever went red, which is most of them. What was missing is the derivation
		 * that never got to see it at all.
		 */
		windowClosedRedIssues:
			windowStart === null
				? []
				: [...closed.values()].flatMap((i) => {
						const red = parseNightlyRed(i);
						if (red === null) return [];
						const closedAtMs = Date.parse(String(i.closedAt ?? ""));
						// No `closedAt` — a snapshot from before the fetch captured it — is UNKNOWN,
						// and unknown never collapses: it is not "closed inside the window".
						if (Number.isNaN(closedAtMs) || closedAtMs < windowStart) return [];
						return [{ ...red, closedOn: String(i.closedAt).slice(0, 10) }];
					}),
	};
}

/**
 * Derive one cloud's standing-resource state from persisted timestamps and raw result facts.
 * No wall clock enters this function, so the generated Markdown stays byte-identical until its
 * committed snapshot changes.
 */
export function deriveReaperObservation(observation, snapshotAt) {
	if (observation === null || observation === undefined) {
		return { state: "indeterminate", why: "no durable reclaim result", observation: null, integrityFailure: null };
	}
	const validation = validateReaperResult(observation, true);
	if (!validation.ok) {
		return {
			state: "indeterminate",
			why: `malformed durable result: ${validation.errors.join("; ")}`,
			observation,
			integrityFailure: `orphan-reaper result for ${observation.provider ?? "unknown provider"} is malformed: ${validation.errors.join("; ")}`,
		};
	}
	const reference = Date.parse(snapshotAt ?? "");
	const completed = Date.parse(observation.completed_at);
	// THE GRACE MUST BOUND THE FETCH, NOT A CLOCK SKEW. `derived_at` is stamped at the TOP of a
	// programme-fetch run that then makes 120+ API calls, so the snapshot's own timestamp is already
	// minutes older than the moment it is written. A five-minute window was narrower than the
	// script's own runtime: a reaper dispatch finishing while the fetch was still walking runs
	// committed a `completed_at` ahead of `derived_at` and made that cell indeterminate — a false
	// negative from a benign race, on evidence that was perfectly good.
	//
	// An hour bounds the fetch with room and still refuses the thing this check is for: a result
	// timestamped well after the snapshot it claims to belong to, which would mean the evidence and
	// the snapshot are not describing the same moment.
	const REAPER_COMPLETION_GRACE_MS = 60 * 60_000;
	if (Number.isNaN(reference) || completed > reference + REAPER_COMPLETION_GRACE_MS) {
		return {
			state: "indeterminate",
			why: "result timestamp cannot be reconciled with the snapshot",
			observation,
			integrityFailure: `orphan-reaper result for ${observation.provider} has a completion time outside its snapshot`,
		};
	}
	const run = `run ${observation.run_id} at ${observation.completed_at}`;
	if (observation.mode !== "reclaim") return { state: "indeterminate", why: `${run} was a dry run`, observation, integrityFailure: null };
	if (!observation.gate_ran) return { state: "indeterminate", why: `${run} skipped its cloud gate`, observation, integrityFailure: null };
	if (!observation.log_present) return { state: "indeterminate", why: `${run} produced no sweep log`, observation, integrityFailure: null };
	if (observation.sweep_exit_code !== 0) return { state: "indeterminate", why: `${run} exited ${observation.sweep_exit_code ?? "without a status"}`, observation, integrityFailure: null };
	if (observation.residual_detected) return { state: "standing", why: `${run} reported residual orphan resources`, observation, integrityFailure: null };
	// A DISCOVERY THAT NEVER ANSWERED USED TO RENDER `clean`. Every check above and below this one
	// asks about something the sweep REPORTED, and a preflight whose discovery call failed reports
	// nothing at all: the orphan list comes back empty, the `[ -z "$orphans" ] → exit 0` early
	// return fires, and the log is byte-identical to a genuinely empty account — exit 0, no
	// residual, zero unverified. `unverified_count` could not catch it, because on four of five
	// clouds the warning it keys on is emitted BELOW that early return, and aws called the tagging
	// API raw with `2>/dev/null` so a throttle never reached the ledger either. The cell then read
	// ✅ clean and PROGRAMME.md published "nothing standing" — about resources that BILL.
	//
	// The sweepers now emit a POSITIVE marker on every path a preflight can leave (see
	// probe_report_discovery in scripts/e2e/lib/sweep-probe.sh). Absence is the fail-closed answer:
	// a log that never said discovery ran is not evidence that it did. This sits AFTER the residual
	// check on purpose — a run that FOUND orphans plainly discovered them, and `standing` is the
	// stronger and truer verdict there.
	if (!observation.discovery_reported) return { state: "indeterminate", why: `${run} never reported completing its orphan discovery — a discovery that failed silently looks exactly like an empty account`, observation, integrityFailure: null };
	if (observation.unverified_count > 0) return { state: "indeterminate", why: `${run} could not verify ${observation.unverified_count} check(s)`, observation, integrityFailure: null };
	if (observation.unattributable_count > 0) return { state: "indeterminate", why: `${run} found ${observation.unattributable_count} unattributable resource(s)`, observation, integrityFailure: null };
	const ageHours = (reference - completed) / 3_600_000;
	if (ageHours > REAPER_FRESH_HOURS) {
		return { state: "stale", why: `${run} was clean but is older than ${REAPER_FRESH_HOURS} hours at this snapshot`, observation, integrityFailure: null };
	}
	const incident = observation.orphan_runs_found > 0
		? `reclaimed ${observation.orphan_runs_found} orphan run(s) / ${observation.resources_reclaimed} resource(s), then verified clean`
		: "found no orphan runs and verified clean";
	return { state: "clean", why: `${run} ${incident}`, observation, integrityFailure: null };
}

export function derive({ ledgerText, spine, workflowText, resolverText = "", unsupportedText, bundleExists, readBundleSummary = () => null, exclusionCounts, snapshot, ledgerBaseline = {}, assertRequirements = {} }) {
	const failures = [];
	const notes = [];
	/** Cells whose composite credit was refused for want of a MEASUREMENT, not for a verdict. */
	const unmeasuredComposites = [];
	const { rows, errors } = parseLedger(ledgerText);
	failures.push(...errors);
	const claims = collapseLedger(rows);
	const clouds = spine.clouds;

	// The board is read here, before the grid, because the grid needs gate state: whether this
	// cloud's `full` claim may be credited to a dimension depends on that dimension's repo gates
	// being wired. It is read once and reused by the gate-reality section further down.
	const board = deriveBoard(snapshot);

	// ── the proof grid: cloud × dimension ──
	/** @type {Record<string, Record<string, {state: string, why: string, row: object|null}>>} */
	const grid = {};
	// A dimension gated only on `derived` names (or on nothing) is exercised by any full bar — the
	// resolve step exports those from the dimension itself. A `repo` gate is the one a human sets,
	// and an unset one means the layer green-skipped. `unknown` (no snapshot) is NOT `wired`, so a
	// missing snapshot fails closed rather than buying a proof.
	// TWO independent reasons the composite may not credit a dimension, and both must hold for it to:
	//
	//   composedByFull  `full` does not turn this dimension's switch on AT ALL (FULL_EXCLUDES in
	//                   scripts/e2e/resolve-dimension.sh). No gate state can rescue that — the code
	//                   simply never ran. This is the stronger of the two.
	//   repo gates      the switch IS composed, but a repo variable a human must set is unset, so the
	//                   layer green-skipped inside the run. `unknown` is NOT `wired`, so a missing
	//                   snapshot fails closed rather than buying a proof.
	//
	//   asserts()       the switch was on and the layer ran, but the BUNDLE does not show it
	//                   asserting what this dimension claims. This one is per-CLOUD, because the
	//                   evidence is a bundle and each cloud has its own — which is why the credit is
	//                   computed inside the loop rather than once per dimension (#2671).
	//
	// THE FIRST TWO ARE STRUCTURAL AND GOVERN BOTH DIRECTIONS (#3243). "`full` never turned this
	// switch on" and "the layer green-skipped for want of a repo variable" both say the code did not
	// run — which disqualifies the bar as evidence FOR the dimension and equally as evidence AGAINST
	// it. Only the third condition is direction-specific, and it forks: a PASS must satisfy
	// `asserts()`, a FAIL must satisfy `reachedAt`.
	const compositeAppliesTo = new Map(
		DIMENSIONS.map((d) => [
			d.id,
			d.composedByFull !== false && d.gates.filter((g) => g.kind === "repo").every((g) => board.gateState(g.name) === "wired"),
		]),
	);
	/** Cells whose composite DISCREDIT was withheld because the bar stopped short of the dimension. */
	const unreachedComposites = [];
	for (const cloud of clouds) {
		grid[cloud] = {};
		const compositeClaim = claims.get(`${cloud}/${COMPOSITE}`) ?? null;
		const compositeBundle = compositeClaim && bundleKind(compositeClaim.bundle) === "path" ? compositeClaim.bundle : null;
		const compositeSummary = compositeBundle ? readBundleSummary(path.join(bundlePath(compositeBundle), "provision-summary.json")) : null;
		for (const d of DIMENSIONS) {
			const applies = compositeAppliesTo.get(d.id);
			let credits = applies;
			let discredits = applies;
			// The default message names the repo-gate cause, which is the ONLY cause it could have had
			// before this. A refusal that names a cause it did not establish is the defect this file
			// has now been fixed for twice, so every new refusal carries its own sentence.
			let refusedWhy;
			let withheldWhy;
			// ── the CREDIT half: a PASS must show it asserted what the column claims (#2671).
			//
			// Guarded on the verdict, which it was not before. PASS is the only verdict that must EARN
			// its state, and `assertsFullAddOnSweep` asks a PASS-shaped question in PASS-shaped prose —
			// "crediting it would promote a floor-sized run to a full one", "a re-run closes it". It
			// ran against every verdict, so a bar that died in apply (no assertion counts, therefore
			// `unknown`) was reported as one that "could have been credited", and a BLOCKED bar turned
			// this one column `never_run` while its siblings correctly read `blocked`. Both are the
			// wrong-cause class this file keeps paying for.
			//
			// `compositeClaim !== null` for the same reason: with no `full` row at all there is no credit
			// to refuse, and reporting one made the note below name clouds that have never run a bar.
			if (credits && compositeClaim !== null && compositeClaim.verdict === "PASS" && typeof d.asserts === "function") {
				const verdict = d.asserts(compositeSummary, assertRequirements[d.id]);
				if (verdict === "no") {
					credits = false;
					refusedWhy =
						`this cloud's \`${COMPOSITE}\` run did not assert what this column claims — its own bundle ` +
						`\`${compositeBundle}\` records a smaller add-on sweep than the ${assertRequirements[d.id]} the catalog carries, ` +
						`so crediting it would promote a floor-sized run to a full one`;
				} else if (verdict === "unknown") {
					credits = false;
					refusedWhy =
						`this cloud's \`${COMPOSITE}\` run cannot be shown to have asserted what this column claims — ` +
						`${compositeBundle ? `its bundle \`${compositeBundle}\` records no assertion-time add-on counts` : "it has no committed bundle to read"}. ` +
						`Unmeasured is not proven: re-run it, or record a direct claim for this dimension`;
					unmeasuredComposites.push(`${cloud}/${d.id}${compositeBundle ? ` (\`${compositeBundle}\`)` : ""}`);
				}
			}
			// ── the DISCREDIT half: a FAIL must show the bar REACHED this dimension (#3243).
			//
			// Only `"no"` withholds. `"unknown"` keeps the red — see `compositeReached` for why the safe
			// direction is the opposite of the credit half's. And a withheld discredit yields
			// `never_run`, never `proven`: this removes an unearned verdict, it never invents one.
			if (discredits && compositeClaim?.verdict === "FAIL") {
				const reach = compositeReached(compositeSummary, d.reachedAt);
				if (reach === "no") {
					discredits = false;
					withheldWhy =
						`this cloud's \`${COMPOSITE}\` run FAILED, but its own bundle \`${compositeBundle}\` records ` +
						`\`deploy_stage: "${compositeSummary?.deploy_stage}"\` — it stopped before \`${d.reachedAt}\`, where this column's surface ` +
						`begins, so it never exercised this dimension and cannot have failed on it. NOT a pass: nothing here has been measured`;
					unreachedComposites.push({ cloud, dimension: d.id, bundle: compositeBundle, stage: String(compositeSummary?.deploy_stage ?? ""), reachedAt: String(d.reachedAt ?? "") });
				}
			}
			grid[cloud][d.id] = deriveCell({
				cloud,
				dimension: d.id,
				claims,
				bundleExists,
				compositeCredits: credits,
				compositeRefusedWhy: refusedWhy,
				compositeDiscredits: discredits,
				compositeWithheldWhy: withheldWhy,
			});
		}
	}

	// ── INTEGRITY: a ledger row naming a cloud or dimension nobody declares ──
	for (const r of rows) {
		if (!clouds.includes(r.cloud)) {
			failures.push(`${LEDGER}:${r.line}: cloud ${JSON.stringify(r.cloud)} is not one of the declared clouds (${clouds.join(", ")})`);
		}
		if (r.dimension !== COMPOSITE && !DIMENSIONS.some((d) => d.id === canonicalDimension(r.dimension))) {
			failures.push(
				`${LEDGER}:${r.line}: dimension ${JSON.stringify(r.dimension)} is not one of ${DIMENSIONS.map((d) => d.id).join(", ")}, ${COMPOSITE} — ` +
					`a row nobody can render is a proof nobody counts`,
			);
		}
	}

	// ── INTEGRITY: a BLOCKED row whose own bundle says the run SPENT ──
	//
	// `BLOCKED` and `FAIL` are defined against one axis and one only. This file says "the harness
	// refused before spending" and the self-test below puts it plainly: "one spent money and broke,
	// the other refused before spending". The ledger's own legend says "couldn't run".
	//
	// The verdict is typed by a human. `provision-summary.json`, sitting in the SAME committed
	// bundle, is written by the harness and already records `outcome` and `deploy_stage`. Nothing
	// compared them, so a row could claim BLOCKED while the file beside it said
	// `FAILED at stage 'applying'` and every gate stayed green.
	//
	// That is not hypothetical, and it is not a one-off. It happened TWICE on 2026-08-25, on two
	// clouds, in two PRs: hetzner/full (#2575) reached `applying`, ran 237s and created 19 resources;
	// azure/full (#2587) reached `applying`, ran 1724s and created 55, including a Cosmos DB account
	// and a NAT gateway. Both were filed BLOCKED.
	//
	// The cost is not bookkeeping. `deriveCell` hardcodes "— refused before spending" into every
	// BLOCKED rationale, so PROGRAMME.md asserts something the bundle contradicts; and because
	// failing cells rank ABOVE never-run ones, ⛔ files a run that cost money BELOW cells nobody has
	// ever attempted.
	//
	// ONE DIRECTION on purpose. A FAIL row on a run that never spent is a conservative mislabel — it
	// overstates the damage, ranks the cell for attention, and costs nobody a proof. BLOCKED on a run
	// that spent understates it, which is the direction that hides money. Only that one is refused.
	//
	// It does NOT check `destroyed`. That flag is captured at failure, before teardown runs, so a
	// false `false` is expected and gating on it would refuse honest rows. Orphan detection is the
	// sweeper's job, not the ledger's.
	//
	// CHECKS THE SURVIVING CLAIM ONLY, not every row. The ledger is append-only, so a corrected row
	// is still in the file forever — #2585 superseded the hetzner/full BLOCKED row with a RETRACTED
	// plus a FAIL re-record, and the original is still sitting at line 53. Walking `rows` fired on
	// that corpse and failed the build on history that had already been fixed properly, which would
	// have made this rule punish exactly the behaviour it is asking for. `claims` is the collapsed
	// view, so a voided row is simply not in it.
	{
		const SPENDING_STAGE = "applying";
		for (const r of claims.values()) {
			if (!r || r.verdict !== "BLOCKED") continue;
			if (bundleKind(r.bundle) !== "path") continue;
			const summary = readBundleSummary(path.join(bundlePath(r.bundle), "provision-summary.json"));
			if (!summary || typeof summary !== "object") continue;
			if (summary.deploy_stage !== SPENDING_STAGE) continue;
			const spent = summary.duration_seconds ? ` after ${summary.duration_seconds}s` : "";
			failures.push(
				`${LEDGER}:${r.line}: ${r.cloud}/${r.dimension} is recorded BLOCKED, but its own bundle ` +
					`\`${r.bundle}/provision-summary.json\` says \`deploy_stage: "${summary.deploy_stage}"\`` +
					`${summary.outcome ? ` and \`outcome: "${summary.outcome}"\`` : ""}${spent}. ` +
					`BLOCKED means the harness refused BEFORE spending; a run that reached '${SPENDING_STAGE}' spent and broke, which is FAIL. ` +
					`The ledger is append-only — supersede the row with a RETRACTED naming it, then re-record as FAIL.`,
			);
		}
	}

	// ── INTEGRITY: a surviving claim's `git sha` must match the sha inside its OWN bundle ──
	//
	// A proof row says "this cell was proven, at this commit, and here is the bundle". Nothing
	// checked that the last two agreed, and they frequently do not: measured across the whole
	// ledger, 29 rows match, 7 do not, and 15 name no committed bundle to compare against.
	//
	// The drift RUNS BOTH WAYS, which is what rules out every benign explanation. Four rows name a
	// commit NEWER than the run and three name one OLDER, so "the row is written after the code
	// moved" cannot cover it. The mechanism is structural: `provisioning-e2e.sh` takes
	// `git rev-parse --short HEAD` in the ROLLUP job while the bundle's `git_sha` is stamped in the
	// LEG job, so any merge landing between them separates the two.
	//
	// It matters most where it is least visible. Two of the seven back cells the grid renders
	// PROVEN. A PASS naming a commit its run never executed is unverifiable in precisely the way an
	// expiring CI run tag was — and every 2026-07-22 row was retracted for that.
	//
	// SURVIVING CLAIMS ONLY, for the same reason the BLOCKED-vs-spent rule above walks `claims`:
	// the ledger is append-only, a corrected row stays in the file forever, and firing on a corpse
	// punishes the supersession convention this repo is asking people to follow.
	//
	// SHRINK-ONLY, keyed on IDENTITY not on a count. Each grandfathered row is named in
	// demos/proofs/ledger-baseline.json under `sha_drift`; a mismatch that is not named fails, and a
	// name that no longer matches a real mismatch fails too. A bare ceiling of "7" would let an eighth
	// mismatch move in the moment one of these is retracted.
	{
		const ackList = Array.isArray(ledgerBaseline?.sha_drift?.records) ? ledgerBaseline.sha_drift.records : [];
		const ackKey = (o) => `${o.cloud}/${o.dimension}@${o.row_sha ?? o.sha}→${o.bundle_sha}`;
		// Built by hand rather than `new Map(entries)` so a DUPLICATE key is reported instead of
		// silently overwritten. The first draft of this baseline listed the hetzner/full RETRACTED
		// row and its FAIL replacement separately; both render the same key, `new Map` kept one, and
		// the redundant record was accepted without a word. A ratchet that quietly absorbs a record
		// it is not using can be padded — which is the one thing a shrink-only list must not allow.
		const unmatchedAck = new Map();
		for (const a of ackList) {
			const k = ackKey(a);
			if (unmatchedAck.has(k)) {
				failures.push(`${LEDGER_BASELINE}: duplicate record for \`${k}\`. Only surviving claims are checked, so one record per cell is the most that can ever match; the extra can never be satisfied and would pad the ratchet.`);
				continue;
			}
			unmatchedAck.set(k, a);
		}
		let unstamped = 0;
		for (const r of claims.values()) {
			if (!r || bundleKind(r.bundle) !== "path") continue;
			const summary = readBundleSummary(path.join(bundlePath(r.bundle), "provision-summary.json"));
			const bundleSha = summary && typeof summary === "object" ? summary.git_sha : undefined;
			// `unknown` is capture-proof.sh's own fallback when `git rev-parse` fails, so it is an
			// absence wearing a value. Counted and reported, never compared — comparing against it
			// would manufacture a mismatch out of a missing measurement.
			if (typeof bundleSha !== "string" || bundleSha === "" || bundleSha === "unknown") {
				unstamped++;
				continue;
			}
			if (shasAgree(r.sha, bundleSha)) continue;
			const key = `${r.cloud}/${r.dimension}@${r.sha}→${bundleSha}`;
			if (unmatchedAck.has(key)) {
				unmatchedAck.delete(key);
				continue;
			}
			failures.push(
				`${LEDGER}:${r.line}: ${r.cloud}/${r.dimension} is recorded at \`${r.sha}\`, but its own bundle ` +
					`\`${r.bundle}/provision-summary.json\` says the run executed \`${bundleSha}\`. ` +
					`A ${r.verdict} naming a commit its run never executed cannot be checked against the tree. ` +
					`The ledger is append-only — supersede the row with a RETRACTED naming it, then re-record with the sha the bundle carries. ` +
					`If this row is genuinely to be grandfathered, name it in ${LEDGER_BASELINE} with the reason.`,
			);
		}
		for (const [key, a] of unmatchedAck) {
			failures.push(
				`${LEDGER_BASELINE}: the acknowledged mismatch \`${key}\` no longer corresponds to a surviving claim whose sha disagrees with its bundle. ` +
					`Either it was superseded (delete the record — this ratchet only shrinks) or the row/bundle it named has moved. ` +
					`A record for a mismatch that does not exist is the same stale-evidence shape the record was meant to expose.` +
					(a.issue ? ` Filed as ${a.issue}.` : ""),
			);
		}
		if (unstamped > 0) {
			notes.push(
				`${unstamped} surviving claim(s) name a committed bundle that carries no usable \`git_sha\`, so their row sha could not be checked at all. ` +
					`That is not a pass — it is an unmeasured cell.`,
			);
		}
	}

	// ── INTEGRITY: a cell's rows must not go BACKWARDS in time down the file ──
	//
	// `collapseLedger` replays in file order and lets the last row win. So file order IS the
	// chronology, and a cell whose rows descend in date silently promotes the OLDEST run.
	//
	// That is not hypothetical. On 2026-08-24 `append_ledger` inserted each new row directly
	// beneath the sentinel — newest-first — and a hetzner/floor PASS was masked by the FAIL from
	// three hours earlier: PROGRAMME.md rendered "0 proven" with the proof committed in the same
	// file. The writers now append at the end; this is the reader refusing to be lied to either
	// way, because the invariant was carried by the writer alone and a hand-edit would restore it.
	//
	// Same-day rows are fine — dates here are day-granular and a cell can legitimately be
	// re-driven twice in one day. Only a STRICT decrease is an error.
	{
		/** @type {Map<string, {date: string, line: number}>} */
		const lastSeen = new Map();
		for (const r of rows) {
			const key = `${r.cloud}/${canonicalDimension(r.dimension)}`;
			const prev = lastSeen.get(key);
			if (prev && r.date < prev.date) {
				failures.push(
					`${LEDGER}:${r.line}: ${key} row dated ${r.date} appears BELOW its ${prev.date} row (line ${prev.line}). ` +
						`The ledger is replayed in file order, so this makes the OLDER run the surviving claim — append new rows at the END.`,
				);
			}
			lastSeen.set(key, { date: r.date, line: r.line });
		}
	}

	// ── the 11-kind carriage grid, straight from the Go mirror ──
	const carriage = { tofu: 0, in_cluster: 0, ceiling: 0, deferred: 0, cost: 0 };
	const deferredCells = [];
	const ceilingCells = [];
	const costCells = [];
	for (const k of spine.kinds) {
		for (const cloud of clouds) {
			const cell = k.cells[cloud];
			if (cell === undefined) {
				failures.push(`${SPINE}: kind ${k.kind} has no cell for ${cloud} — the mirror is incomplete`);
				continue;
			}
			carriage[cell.carriage] = (carriage[cell.carriage] ?? 0) + 1;
			if (cell.carriage === "deferred") deferredCells.push({ cloud, kind: k.kind, chart: cell.chart, why: cell.why });
			if (cell.carriage === "ceiling") ceilingCells.push({ cloud, kind: k.kind, why: cell.why });
			// NOT folded into ceilingCells: the price is the whole point of this verdict, and a reader
			// deciding whether to fund the cell needs the number, not the exclusion.
			if (cell.carriage === "cost") costCells.push({ cloud, kind: k.kind, cost: cell.cost, why: cell.why });
		}
	}

	// ── the CLI bar, straight from the Go mirror ──
	const cli = { cli: 0, cli_gap: 0, cloud_manual: 0, console_only: 0 };
	const cliBlockers = [];
	for (const s of spine.cli_steps) {
		cli[s.reach] = (cli[s.reach] ?? 0) + 1;
		if (s.reach === "cli_gap" || s.reach === "cloud_manual") {
			cliBlockers.push({ id: s.id, reach: s.reach, issue: s.issue, clouds: s.clouds ?? [], why: s.why });
		}
	}

	// ── gate reality: which dimension gates the workflow even MENTIONS ──
	const gates = referencedGates(workflowText, resolverText);

	// ── the 19-kind canvas grid ──
	const unsupported = parseUnsupportedKinds(unsupportedText);

	// The live board half runs HERE, before the tally and the ranking, because it RECLASSIFIES cells
	// to `stale` — a tally computed above it would report 2 failing / 0 stale, and the ranking would
	// offer a fix for a cause that is already closed. `board` itself is built above the grid (it
	// gates composite crediting); this is the point at which its RECLASSIFICATION runs.
	// ── the live board half ──

	// Open REDs: the join a reader actually wants — which cell, which issue, is that issue still open.
	const reds = [];
	for (const cloud of clouds) {
		for (const d of DIMENSIONS) {
			const c = grid[cloud][d.id];
			if (c.state !== STATE.failing && c.state !== STATE.blocked) continue;
			const issue = c.row?.issue ?? "";
			reds.push({ cloud, dimension: d.id, state: c.state, issue, issueState: board.issueState(issue), why: c.why, row: c.row });
		}
	}

	// STALE — the state that turns a lint into information.
	//
	// A cell whose last verdict is FAIL but whose cited issue is CLOSED is not blocked on anything: its
	// cause has been fixed and nobody has re-driven it. Rendering that as `failing` is misleading (it
	// implies open work) and rendering it as an integrity error is wrong (the ledger is append-only —
	// the row was TRUE when written and must not be rewritten). What it actually needs is a re-run,
	// which is cheap, so it gets its own state and ranks at the top of the mechanical next.
	//
	// This is the same defect class that misled the whole programme from the other direction:
	// provisioning-e2e-parity.md cited #1714/#1716/#1722/#2058 as OPEN floor blockers when all four
	// were closed, sending every reader to work already done. Here the tree cannot lie about it,
	// because the issue's state is looked up rather than remembered.
	const staleCitations = reds.filter((r) => r.issueState === "closed");
	for (const r of staleCitations) {
		grid[r.cloud][r.dimension] = {
			...grid[r.cloud][r.dimension],
			state: STATE.stale,
			why: `${grid[r.cloud][r.dimension].why} — but ${r.issue} is CLOSED, so the cause is fixed and this needs a fresh run, not a fix`,
		};
		r.state = STATE.stale;
	}
	// ── UNFILED REDS: an unowned red is the one state the grid cannot RANK ────────────────────────
	//
	// A closed citation is information — the cause is fixed, the cell needs a re-run, and `stale`
	// above says exactly that. A red with NO citation is the opposite: it carries a verdict and no
	// diagnosis, so nothing downstream can do anything with it.
	//
	// That is a ranking defect, not a tidiness one. PROGRAMME.md's "mechanical next" orders failing
	// cells ABOVE never-run ones on the argument that a red already has a diagnosed cause and is
	// therefore cheaper to advance. An uncited red enters that ordering carrying none, so it is
	// ranked above work that is genuinely readier, on a property it does not have. It reads as work
	// while being nobody's — strictly worse than a never-run cell, which at least advertises what it
	// is.
	//
	// This was a `notes.push` until #3157, "kept a note rather than a failure while the ledger still
	// holds pre-convention rows". That was right when it was written and wrong afterwards for a
	// reason worth stating: until #3151 reconnected the advisory channel, `notes` was WRITE-ONLY —
	// pushed to here, returned from derive(), and dropped. So the compromise position was not "a
	// quieter guard", it was no guard at all, and nothing stopped the next one arriving.
	//
	// SHRINK-ONLY, keyed on the ROW rather than the cell. Each grandfathered red is named in
	// demos/proofs/ledger-baseline.json under `unfiled_reds`; an uncited red that is not named fails,
	// and a name that no longer matches an uncited red fails too. The key carries the row's date and
	// sha, so a record cannot launder the NEXT uncited row for the same cell — which is the only
	// thing it could plausibly be padded with.
	//
	// WHY GRANDFATHERING IS NEEDED AT ALL, and why it is not a loophole: the ledger is append-only
	// and is never corrected in place, so a row already in the file CANNOT be given a citation. Its
	// remedy lands on the next row for that cell, which needs a run. A rule that fired on those
	// would be unfixable-by-construction, which is how a guard trains people to route around it. A
	// row being written NOW, by contrast, is trivially fixable — fill the last column — which is the
	// case this rule is actually for.
	//
	// AND IT IS SATISFIABLE BY CONSTRUCTION, which is what makes promoting it fair rather than
	// merely stricter. scripts/e2e/provisioning-e2e.sh files or updates the tracking issue BEFORE it
	// appends the row, precisely so the number is available to write into the last column — it was
	// reordered for that reason, and its comment says so. So the ordinary path already cites. The
	// only way an uncited FAIL row is produced today is the one documented failure branch, where
	// `gh issue create` did not succeed and the script emits "the ledger row will cite none". That
	// branch is a warning in a run log nobody reads afterwards; here it becomes a red, at the point
	// where the row is being brought into the tree by scripts/e2e/commit-proof.sh and a human can
	// still put the number in.
	{
		const recs = Array.isArray(ledgerBaseline?.unfiled_reds?.records) ? ledgerBaseline.unfiled_reds.records : [];
		const redKey = (o) => `${o.cloud}/${o.dimension}@${o.date ?? ""}@${o.row_sha ?? ""}`;
		// Built by hand rather than `new Map(entries)` for the same reason the sha ratchet is: a
		// duplicate must be REPORTED, not silently overwritten. One record per cell is the ceiling —
		// only surviving claims are walked — so a second can never be satisfied and exists only to
		// pad the list.
		const unmatched = new Map();
		for (const rec of recs) {
			const k = redKey(rec);
			if (unmatched.has(k)) {
				failures.push(
					`${LEDGER_BASELINE}: duplicate unfiled-red record for \`${k}\`. Only surviving claims are checked, so one record per cell is the most that can ever match; the extra can never be satisfied and would pad the ratchet.`,
				);
				continue;
			}
			unmatched.set(k, rec);
		}
		for (const r of reds.filter((x) => x.issue === "")) {
			const key = redKey({ cloud: r.cloud, dimension: r.dimension, date: r.row?.date, row_sha: r.row?.sha });
			const rec = unmatched.get(key);
			if (rec) {
				unmatched.delete(key);
				// Grandfathered, never silenced. The whole point of the record is that somebody DOES
				// own this — it just cannot be written into a row that is already in the file.
				notes.push(
					`\`${r.cloud}/${r.dimension}\` is ${r.state} and its ledger row names no issue. Grandfathered in ${LEDGER_BASELINE}` +
						(rec.issue ? `, owned by ${rec.issue}` : "") +
						`: ${rec.reason ?? "no reason recorded"}. The citation lands when this cell is next recorded.`,
				);
				continue;
			}
			failures.push(
				`${LEDGER}${r.row?.line ? `:${r.row.line}` : ""}: ${r.cloud}/${r.dimension} is ${r.state} and names no issue in its last column. ` +
					`An unfiled red is an unowned red: it enters the "mechanical next" ranking above never-run cells on the claim that a red carries a diagnosed cause, and this one carries none. ` +
					`If this is the row you are writing — or bringing in with scripts/e2e/commit-proof.sh — put the issue number in its last column. ` +
					`If no issue exists, file one — the nightly convention is \`e2e nightly: ${r.cloud} RED (${r.dimension})\`, which this script already parses. ` +
					`If the row predates the convention and cannot be corrected (the ledger is append-only), name it in ${LEDGER_BASELINE} under \`unfiled_reds\` with the issue that does own it.`,
			);
		}
		for (const [key, rec] of unmatched) {
			failures.push(
				`${LEDGER_BASELINE}: the unfiled-red record \`${key}\` no longer corresponds to a red whose surviving row names no issue. ` +
					`Either the cell was re-recorded WITH a citation, or it is no longer red — delete the record, this ratchet only shrinks. ` +
					`A record for a violation that does not exist is the same stale-evidence shape the record was meant to expose.` +
					(rec.issue ? ` It named ${rec.issue}.` : ""),
			);
		}
	}

	// ── CONTESTED: a cell the ledger calls PROVEN with an open RED filed after the proving run ──
	//
	// The ledger's rule — a cell is proven when the surviving claim is PASS and its bundle exists —
	// is correct on its own terms, and it is a ONE-WAY RATCHET. Ledger rows are written for runs
	// somebody records; a nightly that goes red files an ISSUE and produces no row. So a later
	// failure cannot downgrade a cell: from the ledger's point of view it never happened.
	//
	// PASS is durable, a later FAIL is invisible. That makes the grid a high-water mark presented as
	// current state — the exact quiet overstatement the proof grid exists to prevent. It was not
	// theoretical: PROGRAMME.md read 11 proven / 8 failing while the board held 15 open nightly REDs,
	// four of them against cells the grid called proven (`gcp/floor` #2743, `azure/floor` #2744,
	// `hetzner/floor` #2742, `aws/floor` #2329).
	//
	// It does NOT say the cell FAILED, and it is not an integrity failure. Two deliberate choices:
	//
	// · Not `failing`. Whether a later red is a flake or a regression needs someone to read the run.
	//   The gcp one really was an ArgoCD repo-server refusing a connection, which is probably
	//   transient — and "probably transient" is a judgement, not a derivation. `contested` claims
	//   only what is derivable: the two sources disagree, so the ✅ is not trustworthy right now.
	//
	// · Not a build failure. `programme-rollup.mjs` is a required check with no path filter, so an
	//   integrity failure here reds EVERY pull request in the repo — for a contradiction no PR
	//   author can resolve and that only the nightly can clear. That is the fail-open rule this
	//   repo already applies to its other repo-wide gates. The rendered state is the better lever
	//   anyway: PROGRAMME.md's status half is generated and diff-gated, so a cell going ⚠️ shows up
	//   in the tree and in the diff of the very next PR, which is where a reader actually looks.
	//
	// Resolution is one of two human acts: close the issue if that run was a flake, or append a
	// FAIL row for it if it was not. Either one clears the ⚠️ on the next derivation.
	const contested = [];
	/** Open REDs a LATER proof has already answered — stale board entries, safe to close. */
	const supersededReds = [];
	/** Open bar-wide REDs that are NOT superseded, with the cells still missing a later proof. */
	const compositeReds = [];
	/** Open REDs whose dimension label this file could not resolve. Reported, never dropped. */
	const unmappedReds = [];
	const dimensionIds = DIMENSIONS.map((d) => d.id);
	// What the BAR exercises — the same `composedByFull` declaration deriveCell's composite credit
	// reads, so the two can never disagree about what a `full` run covers.
	const compositeDimensionIds = DIMENSIONS.filter((d) => d.composedByFull !== false).map((d) => d.id);

	// Snapshot every cell's proving date BEFORE the loop mutates any of them. A composite red reads
	// the whole row, so without this its answer would depend on whether a per-cell red for the same
	// cloud happened to be processed first and flipped that cell to `contested` — a verdict that
	// varies with issue-number order is not a derivation.
	const provenOnBefore = {};
	for (const cloud of clouds) {
		provenOnBefore[cloud] = {};
		for (const d of DIMENSIONS) {
			const cell = grid[cloud]?.[d.id];
			provenOnBefore[cloud][d.id] = cell?.state === STATE.proven ? (cell.row?.date ?? "") : "";
		}
	}
	/** Did a run that PROVED this cell land on or after `redDate`? */
	const answeredBy = (cloud, dim, redDate) => {
		const provenOn = provenOnBefore[cloud]?.[dim] ?? "";
		return provenOn && redDate <= provenOn ? provenOn : "";
	};

	for (const red of board.openRedIssues) {
		const { known, composite, dimensions } = redDimensions(red.dimension, dimensionIds, compositeDimensionIds);
		if (!known) {
			unmappedReds.push({ cloud: red.cloud, dimension: red.dimension, issue: `#${red.number}`, redFiledOn: red.date });
			// A NOTE, not a failure. The subject is an issue TITLE, which a human can edit at any
			// time — reding every PR in the repo over someone's typo is the wrong lever. Genuine
			// drift between this file's vocabulary and the emitter's is caught by `--self-test`,
			// which compares the two statically and IS a build failure.
			notes.push(
				`#${red.number} is an open nightly RED whose dimension \`${red.dimension}\` resolves to no grid column, so it contests nothing and supersedes nothing. ` +
					`The emitter is \`dimension_label()\` in scripts/e2e/resolve-dimension.sh; its labels are ${[...dimensionIds, COMPOSITE_RED_DIMENSION].map((d) => `\`${d}\``).join(", ")}. ` +
					`Either the title was hand-edited, or the two vocabularies have drifted.`,
			);
			continue;
		}

		if (composite) {
			// A bar-wide red is superseded only when EVERY cell it should have covered has since been
			// proven. Anything less and it stays open.
			const missing = dimensions.filter((d) => !answeredBy(red.cloud, d, red.date));
			if (missing.length === 0) {
				supersededReds.push({
					cloud: red.cloud,
					dimension: COMPOSITE_RED_DIMENSION,
					issue: `#${red.number}`,
					redFiledOn: red.date,
					provenOn: dimensions.map((d) => provenOnBefore[red.cloud][d]).sort().at(-1) ?? "",
					evidence: dimensions.map((d) => `${d} ${provenOnBefore[red.cloud][d]}`).join(" · "),
				});
			} else {
				compositeReds.push({ cloud: red.cloud, issue: `#${red.number}`, redFiledOn: red.date, missing });
			}
			// It contests NO individual cell, deliberately. A bar does not necessarily reach every
			// dimension — `byo` and `day2` activate only from caller vars, which is why
			// `compositeCredits` already refuses to CREDIT them from a bar PASS. Contesting a cell the
			// bar may never have run would be that same overstatement pointed the other way.
			continue;
		}

		const [dim] = dimensions;
		const answered = answeredBy(red.cloud, dim, red.date);
		if (answered) {
			supersededReds.push({
				cloud: red.cloud,
				dimension: dim,
				issue: `#${red.number}`,
				redFiledOn: red.date,
				provenOn: answered,
				evidence: grid[red.cloud]?.[dim]?.row?.bundle ?? "",
			});
			continue;
		}
		const cell = grid[red.cloud]?.[dim];
		if (!cell || cell.state !== STATE.proven) continue;
		const provenOn = cell.row?.date ?? "";
		if (!provenOn) continue;
		grid[red.cloud][dim] = {
			...cell,
			state: STATE.contested,
			why: `${cell.why} — but #${red.number} is OPEN and was filed ${red.date}, AFTER the ${provenOn} run that proved it`,
		};
		contested.push({ cloud: red.cloud, dimension: dim, issue: `#${red.number}`, provenOn, redFiledOn: red.date });
	}

	// ── REDS THAT CLOSED INSIDE THE DERIVATION WINDOW ─────────────────────────────────────────────
	//
	// The blind spot between the two checks above. `openRedIssues` contests only while the issue is
	// OPEN; `staleCitations` fires only on a CLOSED issue a cell CITES — and a nightly red writes no
	// ledger row, so no cell cites it. A red filed 09:46Z and closed 11:25Z, snapshot derived 11:32Z,
	// entered neither: PROGRAMME.md published `0 failing` and `gcp/floor ✅` on a day that leg failed.
	// The ✅ was defensible on the last *proven* state; `0 failing` is a claim about today.
	//
	// So a red the window saw close still contests its cell for THIS derivation, exactly as an open
	// one does. It is not a second, weaker verdict — the contradiction is identical, and `contested`
	// already takes no side about whether the run was a flake or a regression.
	//
	// WHAT THIS DOES NOT DO, stated so nobody reads more into it: it does not make PROGRAMME.md a
	// historical record. On the next refresh the red is outside the window and the cell returns to
	// ✅, because closing the issue is one of the two acts the file already documents as clearing a
	// contest. What it fixes is a derivation that never got to see the red AT ALL.
	//
	// EVERY window-closed red is reported, whatever happens to its cell — "leaves no trace" is the
	// defect, and a red that contests nothing because its cell was never proven still happened.
	for (const red of board.windowClosedRedIssues) {
		const { known, composite, dimensions } = redDimensions(red.dimension, dimensionIds, compositeDimensionIds);
		const label = `#${red.number} (\`${red.cloud}/${red.dimension}\`, filed ${red.date}, closed ${red.closedOn})`;
		if (!known) {
			// Same lever as the open-red case: an issue TITLE is human-editable, so this is an
			// advisory rather than a failure that would red every PR in the repo over a typo.
			notes.push(
				`${label} is a nightly RED that was filed and closed INSIDE this derivation window, and its dimension \`${red.dimension}\` resolves to no grid column, so it contests nothing. ` +
					`The emitter is \`dimension_label()\` in scripts/e2e/resolve-dimension.sh; its labels are ${[...dimensionIds, COMPOSITE_RED_DIMENSION].map((d) => `\`${d}\``).join(", ")}.`,
			);
			continue;
		}
		if (composite) {
			// A bar does not necessarily reach every dimension, so it contests no individual cell —
			// the same refusal `compositeCredits` already applies in the crediting direction.
			const missing = dimensions.filter((d) => !answeredBy(red.cloud, d, red.date));
			notes.push(
				missing.length === 0
					? `${label} is a bar-wide nightly RED that closed inside this derivation window; every cell it covers has since been proven on or after it.`
					: `${label} is a bar-wide nightly RED that closed inside this derivation window, unseen by any derivation. It contests no single cell (a bar does not necessarily reach every dimension), but ${missing.length} of ${compositeDimensionIds.length} cells have no proof dated on or after it — ${missing.join(", ")}.`,
			);
			continue;
		}
		const [dim] = dimensions;
		const answered = answeredBy(red.cloud, dim, red.date);
		if (answered) {
			// Answered by a later proof AND already closed. Nothing to contest and nothing to ask a
			// human for — `supersededReds` exists to say "close it", and this one is closed. It is
			// still REPORTED, because a red that happened is a fact whatever answered it.
			notes.push(
				`${label} is a nightly RED that was filed and closed INSIDE this derivation window, so no derivation ever saw it open. ` +
					`It contests nothing: \`${red.cloud}/${dim}\` was proven ${answered}, on or after the red.`,
			);
			continue;
		}
		const cell = grid[red.cloud]?.[dim];
		// NO SECOND DATE COMPARISON HERE. `answeredBy` above is the ordering rule, and repeating it
		// as `red.date <= provenOn` produced a branch no fixture could reach — a defensive test that
		// can only ever pass is indistinguishable from no test, which is the failure mode this file
		// keeps rediscovering. The open-red loop above compares once for the same reason.
		const provenOn = cell?.state === STATE.proven ? (cell.row?.date ?? "") : "";
		if (!provenOn) {
			notes.push(
				`${label} is a nightly RED that was filed and closed INSIDE this derivation window, so no derivation ever saw it open. ` +
					`It contests nothing: \`${red.cloud}/${dim}\` is \`${cell?.state ?? "unknown"}\`, not a cell the ledger calls proven.`,
			);
			continue;
		}
		grid[red.cloud][dim] = {
			...cell,
			state: STATE.contested,
			why: `${cell.why} — but #${red.number} was filed ${red.date}, AFTER the ${provenOn} run that proved it, and CLOSED ${red.closedOn} inside this refresh window, so no derivation ever saw it open`,
		};
		contested.push({ cloud: red.cloud, dimension: dim, issue: `#${red.number}`, provenOn, redFiledOn: red.date, closedOn: red.closedOn });
	}

	// ── SUPERSEDED: the inverse of `contested`, and the direction nothing reported ──
	//
	// `contested` fires when a red is filed AFTER the run that proved a cell. The complement among
	// proven cells — a proof that landed AFTER the red — means the red has already been ANSWERED and
	// the board is carrying a resolved cell as open work. That was a bare `continue`, so these
	// accumulated indefinitely: thirteen of seventeen open nightly REDs were in this state, and
	// MVP predicate 6 ("no board cites a closed issue as open") cannot be met while they are.
	//
	// An ADVISORY, like the unfiled-red note above and for the same reason: a stale issue is a
	// bookkeeping gap, not a lying cell, and `render()` never reads `notes` — so this cannot churn
	// PROGRAMME.md's diff-gated generated half. `--superseded-reds` prints the list for the board
	// report; closing is a human act, because only a human can confirm the run really did answer it.
	for (const s of supersededReds) {
		notes.push(
			`${s.issue} (\`${s.cloud}/${s.dimension}\`, filed ${s.redFiledOn}) is SUPERSEDED — that cell was proven ${s.provenOn}, on or after the red. ` +
				`Evidence: ${s.evidence || "(none recorded)"}. Close it, or append a FAIL row if the later run did not in fact answer it.`,
		);
	}
	for (const c of compositeReds) {
		notes.push(
			`${c.issue} (\`${c.cloud}/${COMPOSITE_RED_DIMENSION}\`, filed ${c.redFiledOn}) stays OPEN: it names the whole bar, and ${c.missing.length} of ${compositeDimensionIds.length} cells have no proof dated on or after it — ${c.missing.join(", ")}. ` +
				`It contests no single cell, because a bar does not necessarily reach every dimension.`,
		);
	}

	// Gate reality, three-valued.
	const gateReality = DIMENSIONS.map((d) => ({
		...d,
		states: d.gates.map((g) => {
			const referenced = gates.has(g.name) || gates.has(g.name.replace(/^ALETHIA_/, ""));
			// A gate the workflow never mentions cannot be turned on at all — `no_vehicle`, not `unwired`.
			if (!referenced) return { ...g, state: "no_vehicle" };
			// A dimension-derived gate needs no variable: a dispatch picks the dimension and the fidelity
			// table exports it. Only a `repo` gate can be genuinely unwired.
			if (g.kind === "derived") return { ...g, state: "derived" };
			return { ...g, state: board.gateState(g.name) };
		}),
	}));

	// The per-cloud gate that decides whether a leg provisions at all.
	const CLOUD_GATES = { hetzner: "HCLOUD_TOKEN", aws: "E2E_AWS_ROLE_ARN", gcp: "E2E_GCP_WIF_PROVIDER", azure: "E2E_AZURE_CLIENT_ID", alibaba: "E2E_ALIBABA_ROLE_ARN" };
	const cloudGates = clouds.map((c) => {
		const declared = board.gateState(CLOUD_GATES[c] ?? "");
		const observed = board.observedGate(c);
		// OBSERVATION WINS over the declaration, in BOTH directions. A leg that got past its gate
		// proves the gate works, whatever the inventory says — and a leg that recorded a gate-off
		// proof proves it does not, even if the variable is present. `state` stays the declared
		// reading so nothing downstream changes meaning; `effective` is what a reader should act on.
		const reached = gateReached(observed);
		// `null` — an observation this file cannot read — falls back to the declaration rather than
		// being treated as a negative. Unreadable is not the same as off.
		const effective = reached === null ? declared : reached ? "wired" : "unwired";
		return { cloud: c, gate: CLOUD_GATES[c] ?? "(unknown)", state: declared, observed, effective };
	});

	// MVP predicate 6: the latest REAL reclaim result per cloud, compared only with the persisted
	// snapshot timestamp. A reclaimed incident may end clean; ambiguity and age never do.
	const reaper = clouds.map((cloud) => ({ cloud, ...deriveReaperObservation(board.reaperObservation(cloud), board.derivedAt) }));
	// AN UNREADABLE OBSERVATION DEGRADES ITS CELL; IT DOES NOT RED THE REPOSITORY.
	//
	// These used to go into `failures`, which exits 1 — and this file runs on every PR. That made a
	// single malformed carried-forward observation red EVERY PR, permanently and unfixably:
	// `programme-fetch.sh` carries `prev_reaper` forward without re-validating, so the offending
	// entry is re-committed unchanged every night, and no PR can remove it because every PR is red.
	// Bumping REAPER_RESULT_SCHEMA_VERSION would have done exactly that to every stale v1 entry at
	// once.
	//
	// Nothing is silenced by this. `deriveReaperObservation` already returns `indeterminate` for
	// both cases, so the cell renders `? indeterminate` with its reason in the table a human reads,
	// and the notice below names it on stderr. Indeterminate is the correct fail-closed answer for
	// "this evidence cannot be read" — it is not `clean`, and it never counts toward `reaperClean`.
	// It is also self-healing: the next real reclaim result replaces the entry.
	for (const result of reaper) {
		if (result.integrityFailure !== null) {
			console.error(`::notice::${result.integrityFailure} — the ${result.cloud} cell is indeterminate until a later reclaim result replaces it.`);
		}
	}
	const reaperClean = reaper.filter((result) => result.state === "clean").length;

	// Snapshot freshness. A broken cron produces NO signal, so staleness has to be an error eventually
	// rather than a note nobody reads — but it warns first, because a quiet week should not red the repo
	// on a Monday morning.
	if (board.present && board.ageHours !== null && board.ageHours > 24 * 7) {
		failures.push(`${SNAPSHOT} is ${Math.round(board.ageHours / 24)} days old — the live half is not being refreshed. Check the programme cron.`);
	}

	// ── A TRUNCATED ISSUE LIST IS AN UNSOUND DERIVATION, AND IT USED TO BE SILENT. ────────────────
	//
	// `gh issue list --limit 500` returned exactly 500 closed issues for weeks — indistinguishable,
	// in every signal the mechanism produced, from a repo that has exactly 500. 228 were dropped
	// every night. `issueState` answers `unknown` for a dropped issue and `staleCitations` fires
	// only on `closed`, so a red cell citing one can never be reclassified and stays `failing`
	// forever: the #1714/#1722/#2058 defect, reintroduced by truncation rather than by logic.
	//
	// AN ADVISORY, NOT A FAILURE, for the reason this file has now recorded twice: `failures` exits
	// 1 and this runs on every PR, while the snapshot is refreshed by a cron no PR author can
	// re-drive. Reding every PR over a truncated fetch is the wedge the malformed-reaper-result rule
	// was rewritten to avoid. The fetch annotates its own run `::error::`, the cells that actually
	// lose an answer are named below, and the rendered table says which `?` cannot be resolved.
	//
	// AND A MISSING FLAG IS `null`, NOT `false`. The snapshot in the tree when this landed WAS capped
	// at 500 and says nothing about it, because the fetch that wrote it never asked. Reading that as
	// "complete" would render the actually-truncated snapshot clean, which is the whole defect one
	// level up.
	if (board.present && board.issueListComplete !== true) {
		notes.push(
			board.issueListComplete === false
				? `${SNAPSHOT} carries a TRUNCATED issue list — a query came back at its limit, so the tail was dropped and every dropped issue reads \`unknown\`. ` +
						`A red cell citing one can never be reclassified \`stale\`. Raise the limit in scripts/programme-fetch.sh and re-run the refresh.`
				: `${SNAPSHOT} predates the truncation check, so whether its issue list is complete is UNKNOWN. ` +
						`It is not evidence the list is whole: the query that wrote it was capped at 500 and reported the same count either way. The next refresh answers it.`,
		);
		for (const r of reds.filter((x) => x.issue !== "" && x.issueState === "unknown")) {
			notes.push(
				`\`${r.cloud}/${r.dimension}\` cites ${r.issue}, which is in neither the open nor the closed list, and that list is ` +
					`${board.issueListComplete === false ? "TRUNCATED" : "of UNKNOWN completeness"}. ` +
					`It is rendered \`${r.state}\` because its citation could not be resolved, not because the issue was checked and found open.`,
			);
		}
	}

	// ── A CARRIED GATE INVENTORY THAT NOBODY AGED. ────────────────────────────────────────────────
	//
	// `inventory_observed_at` was written by the fetch and read by nothing (#3652). The only
	// staleness rule ages `derived_at`, which the same run re-stamps, so a carried inventory could
	// stand indefinitely: `derived_at` reached 2026-09-01 against a reading taken 2026-08-27, and
	// deleting a gate variable would have left its row rendering `✅ wired` forever.
	//
	// `deriveBoard` now degrades every DECLARED gate to `unknown` past the bound. That is the
	// correction, and it is fail-closed rather than fail-loud on purpose — an OBSERVED gate (a leg
	// that actually got past it) still wins in both directions, so what goes unknown is exactly the
	// half that was never a measurement of today. This note says why the states changed.
	if (board.present && board.inventoryPresent && !board.inventoryFresh) {
		notes.push(
			board.inventoryObservedAt === null
				? `${SNAPSHOT} carries a gate inventory with no \`inventory_observed_at\`, so there is no record of when it was read. Every DECLARED gate reads \`unknown\` until a refresh stamps one.`
				: `${SNAPSHOT}'s gate inventory was observed ${board.inventoryObservedAt}, ${Math.round((board.inventoryAgeHours ?? 0) / 24)} days before the snapshot was derived — past the ${INVENTORY_FRESH_HOURS / 24}-day bound. ` +
					`Every DECLARED gate reads \`unknown\` until it is re-read. The nightly token cannot list variables or secrets at all, so refreshing it takes a run with a PAT.`,
		);
	}


	// ── tallies ──
	const tally = { proven: 0, failing: 0, blocked: 0, never_run: 0, stale: 0, contested: 0 };
	for (const cloud of clouds) {
		for (const d of DIMENSIONS) tally[grid[cloud][d.id].state]++;
	}

	// ── the mechanical NEXT: the cheapest cell that would move the programme ──
	// Failing first (a red cell has a diagnosed cause and costs nothing new to re-drive), then
	// never-run in dimension order. Ranking, never claiming — claiming is claim-work.sh's job.
	const next = [];
	// `stale` first: its cause is already fixed, so a re-run is the cheapest action on the board and it
	// either converts the cell to proven or produces a real, current diagnosis.
	for (const st of [STATE.stale, STATE.contested, STATE.failing]) {
		for (const d of DIMENSIONS) {
			for (const cloud of clouds) {
				if (grid[cloud][d.id].state === st) next.push({ cloud, dimension: d.id, state: st, why: grid[cloud][d.id].why });
			}
		}
	}
	for (const d of DIMENSIONS) {
		for (const cloud of clouds) {
			if (grid[cloud][d.id].state === STATE.neverRun) next.push({ cloud, dimension: d.id, state: STATE.neverRun, why: grid[cloud][d.id].why });
		}
	}

	// A refusal for want of a MEASUREMENT is not the same as a cell nobody ran, and the grid renders
	// them identically (`never_run`). Saying which is which is the difference between "nobody has
	// tried this" and "somebody did and we cannot check it" — the second is one dispatch from proven.
	if (unmeasuredComposites.length > 0) {
		notes.push(
			`${unmeasuredComposites.length} cell(s) could have been credited from a \`${COMPOSITE}\` run but its bundle records no assertion-time evidence: ` +
				`${unmeasuredComposites.join(", ")}. Unmeasured is not proven — but it is not never-run either, and a re-run closes it.`,
		);
	}

	// The same argument for the DISCREDIT direction (#3243). A withheld discredit removes a ❌ from
	// the grid, and a verdict that silently DISAPPEARS is worse than one that was wrong: somebody
	// looked at that cell yesterday. So say which cells lost a red and why, every run.
	//
	// Reported ONLY where it changed the answer. A direct claim beats the composite, so a cell that
	// is proven from its own ledger row never saw this rule at all, and listing it would advertise a
	// correction nobody made — the same wrong-cause reporting this whole mechanism exists to stop.
	{
		const changed = unreachedComposites.filter((u) => grid[u.cloud]?.[u.dimension]?.state === STATE.neverRun);
		if (changed.length > 0) {
			notes.push(
				`${changed.length} cell(s) are NOT credited with their cloud's \`${COMPOSITE}\` FAIL, because that bar stopped before their surface: ` +
					`${changed.map((u) => `${u.cloud}/${u.dimension} (\`${u.bundle}\` reached \`${u.stage}\`, this column begins at \`${u.reachedAt}\`)`).join(", ")}. ` +
					`They read never-run, NOT proven — the bar never measured them in either direction, and a standalone dispatch is what settles it.`,
			);
		}
	}

	return { rows, claims, clouds, notes, kindCount: spine.kinds.length, grid, carriage, deferredCells, ceilingCells, cli, cliBlockers, gates, unsupported, tally, next, failures, exclusionCounts, board, reds, staleCitations, contested, supersededReds, compositeReds, unmappedReds, costCells, gateReality, cloudGates, reaper, reaperClean, unreachedComposites };
}

// ───────────────────────────── rendering ─────────────────────────────

/** @param {ReturnType<typeof derive>} v */
export function render(v) {
	const L = [];
	const total = v.clouds.length * DIMENSIONS.length;

	L.push("## Where the programme actually is");
	L.push("");
	// EVERY STATE THE TALLY COUNTS IS PRINTED. `contested` was omitted, which made the headline the
	// one place a reader could not see that the ledger and the board disagree: a cell leaving
	// `proven` simply lowered the numerator and the rest of the line still read `0 failing`. A
	// summary that counts a state and does not name it is the same silent overstatement the grid
	// exists to prevent.
	L.push(
		`**${v.tally.proven} of ${total} proof cells are proven.** ` +
			`${v.tally.failing} failing · ${v.tally.contested} contested (the ledger and the board disagree) · ` +
			`${v.tally.stale} stale (cause fixed, needs a re-run) · ` +
			`${v.tally.blocked} blocked · ${v.tally.never_run} never run.`,
	);
	L.push("");
	L.push(
		"A cell is `proven` only when the proof ledger's surviving claim is PASS **and** its bundle is a " +
			"committed path that exists. A PASS carrying an expiring CI run tag is not a proof — that is " +
			"why every 2026-07-22 row was retracted, and the rule is enforced here rather than remembered.",
	);
	L.push("");

	// ── the proof grid ──
	L.push("### Proof grid — cloud × dimension");
	L.push("");
	L.push(`| cloud | ${DIMENSIONS.map((d) => d.label).join(" | ")} |`);
	L.push(`|---|${DIMENSIONS.map(() => ":---:").join("|")}|`);
	for (const cloud of v.clouds) {
		L.push(`| **${cloud}** | ${DIMENSIONS.map((d) => STATE_GLYPH[v.grid[cloud][d.id].state]).join(" | ")} |`);
	}
	L.push("");
	L.push(`Legend: ${Object.entries(STATE_GLYPH).map(([s, g]) => `${g} ${s.replace("_", "-")}`).join(" · ")}`);
	L.push("");
	const evidence = [];
	for (const cloud of v.clouds) {
		for (const d of DIMENSIONS) {
			const c = v.grid[cloud][d.id];
			if (c.state !== STATE.neverRun || c.row !== null) evidence.push(`- \`${cloud}/${d.id}\` **${c.state}** — ${c.why}${c.row?.issue ? ` (${c.row.issue})` : ""}`);
		}
	}
	if (evidence.length > 0) {
		L.push("<details><summary>Every cell that has any evidence at all</summary>");
		L.push("");
		L.push(...evidence);
		L.push("");
		L.push("</details>");
		L.push("");
	}

	// ── the mechanical next ──
	L.push("### The mechanical next");
	L.push("");
	if (v.next.length === 0) {
		L.push("Nothing is actionable from the tree — every cell is proven, a ceiling, or blocked on a human.");
	} else {
		const n = v.next[0];
		L.push(`**\`${n.cloud}/${n.dimension}\`** — ${n.state}. ${n.why}`);
		L.push("");
		L.push(
			"Failing cells rank above never-run ones: a red cell already has a diagnosed cause and costs " +
				"nothing new to re-drive, where a never-run cell needs its gate enabled first. " +
				"This RANKS; it never claims — `scripts/claim-work.sh` claims.",
		);
		L.push("");
		L.push("<details><summary>The next 10</summary>");
		L.push("");
		for (const c of v.next.slice(0, 10)) L.push(`1. \`${c.cloud}/${c.dimension}\` — ${c.state}`);
		L.push("");
		L.push("</details>");
	}
	L.push("");

	// ── capability surface ──
	L.push("### Capability surface");
	L.push("");
	const carriageTotal = Object.values(v.carriage).reduce((a, b) => a + b, 0);
	L.push(
		`**Proof grid (${v.kindCount} provisionable kinds × ${v.clouds.length} clouds = ${carriageTotal} cells):** ` +
			`${v.carriage.tofu} carried by tofu · ${v.carriage.in_cluster} carried in-cluster · ` +
			`${v.carriage.ceiling} cloud ceilings · **${v.carriage.deferred} deferred (our debt)** · ` +
			`${v.carriage.cost} excluded by cost.`,
	);
	L.push("");
	if (v.deferredCells.length > 0) {
		L.push(
			"The deferred cells are the last **product** debt in the capability matrix — a chart this repo " +
				"already ships backs the kind, and only the mapping is missing. They install on every " +
				"full-bar run while the kind that would use them is refused:",
		);
		L.push("");
		for (const d of v.deferredCells) L.push(`- \`${d.cloud}/${d.kind}\` → chart **${d.chart}**`);
		L.push("");
	}
	if (v.costCells.length > 0) {
		L.push(
			"Excluded by **cost** — the cloud offers the kind and the product ships it, but provisioning it " +
				"in the harness would buy something not billed by the hour. These are spend decisions, not " +
				"capability limits, and the price is printed so the decision can be re-taken rather than inherited:",
		);
		L.push("");
		for (const c of v.costCells) L.push(`- \`${c.cloud}/${c.kind}\` → ${c.cost}`);
		L.push("");
	}
	if (v.ceilingCells.length > 0) {
		L.push("Cloud ceilings (the cloud genuinely does not offer the kind — not our debt):");
		L.push("");
		for (const c of v.ceilingCells) L.push(`- \`${c.cloud}/${c.kind}\``);
		L.push("");
	}
	const unsupportedEntries = Object.entries(v.unsupported);
	L.push(
		`**Parity grid (19 canvas NodeKinds × ${v.clouds.length} clouds):** ` +
			(unsupportedEntries.length === 0
				? "every cloud backs every kind."
				: unsupportedEntries.map(([c, ks]) => `${c} refuses ${ks.length} (${ks.join(", ")})`).join("; ") +
					"; every other cloud backs all 19."),
	);
	L.push("");

	// ── the CLI bar ──
	L.push("### Driven from the CLI");
	L.push("");
	L.push(
		`**${v.cli.cli} steps CLI-driven · ${v.cli.cli_gap} CLI gaps (our debt) · ` +
			`${v.cli.cloud_manual} cloud ceilings · ${v.cli.console_only} console by design.**`,
	);
	L.push("");
	if (v.cli.cli_gap === 0) {
		L.push(
			"The CLI debt is **zero** — every remaining blocker is a thing the cloud offers no API for, " +
				"not a thing Alethia has not built. That distinction is the one worth carrying into a demo.",
		);
	}
	L.push("");
	L.push("⚠️ Reachability only. The bar asserts the command surface resolves; it does **not** provision, and its real-binary half runs only when `E2E_CLI_DEMO` is set.");
	L.push("");
	if (v.cliBlockers.length > 0) {
		L.push("| step | verdict | clouds | issue |");
		L.push("|---|---|---|---|");
		for (const b of v.cliBlockers) {
			L.push(`| \`${b.id}\` | ${b.reach} | ${b.clouds.length === 0 ? "all" : b.clouds.join(", ")} | ${b.issue || "—"} |`);
		}
		L.push("");
	}

	// ── gate reality ──
	L.push("### Gate reality");
	L.push("");
	L.push("Whether a dimension can run at all. A gate the workflow never mentions cannot be turned on by setting a variable.");
	L.push("");
	L.push("**Which clouds can provision at all.** A leg whose gate is unwired green-skips every night.");
	L.push("");
	L.push("| cloud | gate | state | evidence |");
	L.push("|---|---|:---:|---|");
	for (const g of v.cloudGates) {
		const glyph = { wired: "✅ wired", unwired: "⛔ **unwired**", unknown: "? unknown" }[g.effective];
		// An OBSERVED state names the run that observed it, because "a leg got past this gate" is a
		// checkable claim and "a variable is set somewhere" is not. A declared-only state says so,
		// so the two are never mistaken for each other.
		const reached = g.observed ? gateReached(g.observed) : null;
		const evidence = reached !== null
			? `${reached ? "a leg reached the gate" : g.observed.earlier_failure ? "the leg failed BEFORE its gate" : "a gate-off proof was recorded"} — run ${g.observed.run}`
			: g.state === "unknown"
				? "not observed, and the inventory was not readable"
				: "declared only — no recent run observed this leg";
		L.push(`| **${g.cloud}** | \`${g.gate}\` | ${glyph} | ${evidence} |`);
	}
	L.push("");
	L.push("**Which dimensions can run.** A gate the nightly never mentions has no vehicle — setting a variable would not turn it on.");
	L.push("");
	L.push("| dimension | gate | state | what it proves |");
	L.push("|---|---|:---:|---|");
	for (const d of v.gateReality) {
		let cell;
		if (d.gates.length === 0) {
			cell = "n/a";
		} else {
			const label = { wired: "✅ wired", derived: "✅ by dimension", unwired: "⛔ **unwired**", no_vehicle: "🚧 no vehicle", unknown: "? unknown" };
			cell = d.states.map((s) => `${label[s.state]}: \`${s.name}\``).join("<br>");
		}
		L.push(`| ${d.label} | \`${d.gate}\` | ${cell} | ${d.what} |`);
	}
	L.push("");
	if (!v.board.present) {
		L.push(
			"⚠️ **No snapshot** (`" + SNAPSHOT + "` absent), so every gate state above reads `unknown`. " +
				"It never collapses to a guess: a cell may not leave `never-run`, and a gate may not be called " +
				"unwired, on the strength of a file nobody fetched.",
		);
		L.push("");
	} else if (v.board.inventoryPresent && !v.board.inventoryFresh) {
		// The declared half of gate reality is a CARRIED reading, because the nightly token cannot
		// list variables or secrets at all. Past the bound it stops being a measurement of today, and
		// the whole point of `inventory_observed_at` is to say when it stopped.
		L.push(
			`⚠️ **The gate inventory is stale.** It was observed **${v.board.inventoryObservedAt ?? "(never recorded)"}**, more than ` +
				`${INVENTORY_FRESH_HOURS / 24} days before this snapshot was derived, so every **declared** gate above reads \`unknown\` rather than ` +
				"asserting a variable that may since have been deleted. An **observed** gate — a leg that actually got past it — " +
				"still wins in both directions. The nightly's token cannot list repo variables or secrets at all, so the " +
				"inventory only refreshes on a run carrying a PAT.",
		);
		L.push("");
	}

	// ── the live board join ──
	L.push("### Open REDs");
	L.push("");
	// A STATEMENT ABOUT THE SNAPSHOT, NOT ABOUT THE REDS, so it is rendered whether or not any cell
	// is red. Tucking it inside the table's `else` would have hidden it on exactly the mornings the
	// grid looks cleanest — and "no cell is failing" is a weaker claim than it reads when the list
	// that resolves citations may be missing its tail.
	if (v.board.present && v.board.issueListComplete !== true) {
		L.push(
			v.board.issueListComplete === false
				? "⚠️ **The issue list in the snapshot is TRUNCATED** — a query came back at its limit, so its tail was " +
						"dropped and every dropped issue reads `unknown`. A red cell citing one can never be reclassified " +
						"`stale`, so it stays `failing` whether or not its cause was fixed. Raise the limit in " +
						"`scripts/programme-fetch.sh` and re-run the refresh."
				: "⚠️ **This snapshot predates the truncation check**, so whether its issue list is complete is unknown — " +
						"and it is not evidence that it is: the query that wrote it was capped at 500 and reported the same " +
						"count whether or not it dropped the tail. The next refresh answers it.",
		);
		L.push("");
	}
	if (v.reds.length === 0) {
		L.push("No cell is failing or blocked.");
	} else {
		L.push("| cell | state | issue | issue state |");
		L.push("|---|---|---|:---:|");
		for (const r of v.reds) {
			// `?` MUST SAY WHICH `?` IT IS. An issue in neither list is either from another repo or
			// past the fetch limit, and while the fetch is TRUNCATED the second is the likely one —
			// a cell whose citation was dropped stays `failing` forever, because the reclassification
			// to `stale` fires only on a resolved `closed`. Rendering both as a bare `?` is what made
			// that indistinguishable from a citation that was checked.
			const unknownLabel = v.board.issueListComplete === false
				? "? **unresolvable (list truncated)**"
				: v.board.issueListComplete === null
					? "? **unresolvable (completeness unknown)**"
					: "?";
			const s = { open: "open", closed: "⛔ **CLOSED**", unknown: unknownLabel }[r.issueState];
			L.push(`| \`${r.cloud}/${r.dimension}\` | ${r.state} | ${r.issue || "**none**"} | ${s} |`);
		}
		L.push("");
		if (v.staleCitations.length > 0) {
			L.push(
				`♻️ **${v.staleCitations.length} cell(s) cite a CLOSED issue**, so they are rendered \`stale\` rather ` +
					"than `failing`: the cause is fixed and what they need is a **re-run**, not a fix. They rank first " +
					"in the mechanical next for exactly that reason — it is the cheapest action on the board.\n\n" +
					"The ledger row itself is not wrong and is not rewritten (it is append-only, and it was true when " +
					"written). What was wrong was reading it as open work — the same defect that had the parity board " +
					"citing four closed issues as live floor blockers.",
			);
			L.push("");
		}
	}

	// ── contested ──
	//
	// Rendered even when empty is NOT the choice here — an empty section would train a reader to
	// scroll past it. It appears only when the two sources actually disagree, and when it appears
	// it says which act clears it.
	if (v.contested.length > 0) {
		L.push("### ⚠️ Contested — proven by the ledger, contradicted by a red");
		L.push("");
		L.push(
			"A nightly that goes red files an **issue** and writes **no ledger row**. So from the ledger's point of " +
				"view that failure never happened, and a cell proven earlier stays ✅ forever: PASS is durable, a later " +
				"FAIL is invisible. That makes the grid a **high-water mark** presented as current state, in the one " +
				"direction that overstates — which is the thing this whole file exists to prevent.",
		);
		L.push("");
		L.push("| cell | proven by a run dated | red | filed | red's state |");
		L.push("|---|:---:|---|:---:|---|");
		for (const c of v.contested) {
			// A red that was filed AND closed between two refreshes is contradiction the board can no
			// longer show you: it was never in any snapshot's `open_issues`. It contests the cell for
			// this derivation exactly as an open one does, and the column says which it was so the
			// reader knows whether there is still an issue to go and read.
			const state = c.closedOn ? `closed ${c.closedOn}, inside this refresh window` : "open";
			L.push(`| \`${c.cloud}/${c.dimension}\` | ${c.provenOn} | ${c.issue} | ${c.redFiledOn} | ${state} |`);
		}
		L.push("");
		L.push(
			"`contested` takes **no side**. Whether a later red is a flake or a regression needs someone to read the " +
				"run, and guessing either way is worse than naming the contradiction. It claims only what is " +
				"derivable — the two sources disagree, so the ✅ is not trustworthy right now.\n\n" +
				"**Two human acts clear it, and either one is fine:** close the issue if that run was a flake, or " +
				"append a `FAIL` row for it if it was not. The next derivation picks the answer up.\n\n" +
				"A row marked **closed … inside this refresh window** is a red that was filed and closed between two " +
				"snapshots, so it was never in anybody's `open_issues` and no derivation ever saw it. It is shown once, " +
				"here, and clears on the next refresh — the closing act has already happened. That is the whole of it: " +
				"a red is evidence whether or not its issue is still open, and `0 failing` is a claim about **today**.",
		);
		L.push("");
	}

	L.push("");
	L.push("### Orphan reaper — nothing standing");
	L.push("");
	L.push(`**${v.reaperClean} of ${v.clouds.length} clouds are verified clean.** A real reclaim result stays current for ${REAPER_FRESH_HOURS} hours.`);
	L.push("");
	L.push("A run that reclaimed an orphan may still finish clean; the incident counts remain visible. Dry runs, skipped gates, failed or missing logs, unverifiable checks and unattributable resources never count as clean.");
	L.push("");
	L.push("| cloud | state | durable evidence |");
	L.push("|---|:---:|---|");
	const reaperGlyph = { clean: "✅ clean", standing: "❌ standing", indeterminate: "? indeterminate", stale: "♻️ stale" };
	for (const result of v.reaper) L.push(`| **${result.cloud}** | ${reaperGlyph[result.state]} | ${result.why} |`);
	L.push("");

	L.push("### Blocked on a human");
	L.push("");
	const unwiredClouds = v.cloudGates.filter((g) => g.effective === "unwired");
	if (!v.board.present) {
		L.push("Unknown without a snapshot.");
	} else if (unwiredClouds.length === 0 && v.board.needsHuman.length === 0) {
		L.push("Nothing.");
	} else {
		for (const g of unwiredClouds) L.push(`- **\`${g.cloud}\` cannot provision** — \`${g.gate}\` is not set, so the leg green-skips.`);
		for (const i of v.board.needsHuman) L.push(`- #${i.number} — ${i.title}`);
	}
	L.push("");

	// ── debt ratchets ──
	if (v.exclusionCounts !== undefined) {
		L.push("### Debt ratchets");
		L.push("");
		L.push("| board | recorded debt |");
		L.push("|---|---|");
		for (const [name, counts] of Object.entries(v.exclusionCounts)) {
			L.push(`| \`${name}\` | ${Object.entries(counts).map(([k, n]) => `${k}: ${n}`).join(" · ")} |`);
		}
		L.push("");
	}

	// ── provenance ──
	L.push("### Provenance");
	L.push("");
	L.push("Every number above is derived from these, and from nothing else:");
	L.push("");
	for (const f of [SPINE, LEDGER, WORKFLOW, RESOLVER, UNSUPPORTED_KINDS, `${PROOFS_DIR}/<cloud>/<stamp>/`, SNAPSHOT]) L.push(`- \`${f}\``);
	L.push("");
	L.push(
		v.board.present
			? `Live board snapshot: taken **${v.board.derivedAt ?? "(no timestamp)"}** — refreshed by ` +
					"`.github/workflows/programme.yml`, which opens a PR rather than pushing. Warns past 48h, fails past 7 days.\n\n" +
					"The timestamp is printed VERBATIM from the snapshot, never as an age. An age is computed from the " +
					"current clock, so it would drift with no change to any input and make this diff-gated region stale " +
					"an hour after every refresh — redding CI for everyone. The clock is only ever used to FAIL on a " +
					"snapshot older than 7 days, which is a deliberate exception: a refresh that has silently stopped " +
					"produces no other signal."
			: "Live board snapshot: **absent**. Every issue state and gate state above reads `unknown`.",
	);
	L.push("");
	if (v.board.present) {
		// TWO TIMESTAMPS, NOT ONE. `derived_at` says when the fetch ran; `inventory_observed_at` says
		// when the gate inventory it carries was actually READ, and those are days apart by design —
		// the nightly token cannot list variables or secrets, so every refresh carries the previous
		// reading forward. Printing only the first is what let a five-day-old inventory look freshly
		// measured. Both are printed VERBATIM, never as an age, for the reason stated above.
		L.push(
			`Gate inventory observed: **${v.board.inventoryObservedAt ?? "(not recorded)"}** — carried forward on every refresh whose token ` +
				`cannot list repo variables or secrets. Past ${INVENTORY_FRESH_HOURS / 24} days behind the snapshot it stops being a measurement of today, ` +
				"and every declared gate degrades to `unknown`.",
		);
		L.push("");
	}
	L.push(
		`Ledger rows read: **${v.rows.length}** · surviving claims: **${[...v.claims.values()].filter((c) => c !== null).length}** ` +
			`(a \`RETRACTED\` row voids a claim rather than replacing it, so surviving < rows is expected).`,
	);
	L.push("");
	L.push("_Generated by `scripts/programme-rollup.mjs`. Do not edit below the marker — run `pnpm gen:programme`._");

	return L.join("\n");
}

// ───────────────────────────── splice ─────────────────────────────

/** Replace the generated region. Hard-errors on a missing or duplicated marker. */
export function splice(existing, generated) {
	const begins = existing.split(BEGIN).length - 1;
	const ends = existing.split(END).length - 1;
	if (begins === 0 || ends === 0) {
		throw new Error(`${TARGET}: missing the generated-region markers. Expected exactly one ${BEGIN} and one ${END}.`);
	}
	if (begins > 1 || ends > 1) {
		// Splicing into the first of two would silently orphan everything after the second — the
		// classic fail-open append. Refuse.
		throw new Error(`${TARGET}: found ${begins} BEGIN and ${ends} END markers — expected exactly one of each. Refusing to guess which region is live.`);
	}
	const head = existing.slice(0, existing.indexOf(BEGIN) + BEGIN.length);
	const tail = existing.slice(existing.indexOf(END));
	return `${head}\n\n${generated}\n\n${tail}`;
}

/**
 * The intent half may state intent, decisions and identifiers — never STATUS. Anything above the
 * marker that would need editing when a test result changes is a defect. This grep is the only
 * structural reason a 16th hand-maintained board cannot re-emerge inside this very file.
 */
export function intentHalfViolations(existing) {
	const idx = existing.indexOf(BEGIN);
	const intent = idx === -1 ? existing : existing.slice(0, idx);
	return statusClaimsIn(intent).map(
		(c) => `${TARGET}:${c.line}: ${c.kind === "glyph"
			? "a verdict glyph in the intent half — status belongs below the marker."
			: c.kind === "count"
				? "a derived count in the intent half — it will rot. Let the rollup render it."
				: 'a status claim in the intent half ("is green"/"is proven"/…) — status belongs below the marker.'}`,
	);
}

/**
 * The three shapes that make a line a STATUS CLAIM rather than intent: a verdict glyph, a derived
 * count, or an "is/are (now) green|proven|passing|red".
 *
 * Exported because `scripts/check-one-board.mjs` asks the same question of `docs/testing/*.md`, and
 * two definitions of "this line asserts status" would be exactly the drift both guards exist to
 * stop. This function is the definition; both callers phrase the message their own way.
 *
 * @param {string} text
 * @returns {{line: number, kind: "glyph"|"count"|"claim", text: string}[]}
 */
export function statusClaimsIn(text, { prose = true } = {}) {
	const out = [];
	for (const [i, raw] of text.split("\n").entries()) {
		// `prose: true` is PROGRAMME.md's intent half, where `#` is a heading and `>` is quoted
		// rationale — neither asserts status, and skipping them is what lets the file document the
		// very phrasings it forbids.
		//
		// `prose: false` is a BOARD, where that reasoning inverts: a heading and a blockquote are
		// exactly where a board's status lives. `### hetzner ✅ green` is a verdict, and blockquoting
		// a matrix is a one-character-per-line edit that made the whole corpus invisible to the
		// guard. So the skip is dropped and a leading quote marker is STRIPPED before matching,
		// rather than treated as an exemption.
		const line = prose ? raw : raw.replace(/^\s*>+\s?/, "");
		if (prose && /^\s*(#|>|_)/.test(line)) continue; // headings and quoted rationale
		// A CITATION is not a claim. Strip backticked code and double-quoted spans before matching,
		// so prose may name the very phrasing it forbids — the anti-patterns section has to be able
		// to say `"is green"` without tripping the rule that forbids saying it. Without this the
		// guard's only stable state is one where nobody can document it.
		const matchable = line.replace(/`[^`]*`/g, " ").replace(/"[^"]*"/g, " ").replace(/[“][^”]*[”]/g, " ");
		if (/[✅❌⛔🔶]/.test(matchable)) out.push({ line: i + 1, kind: "glyph", text: line });
		if (/\b\d+\s*(?:of|\/)\s*\d+\s+(?:cells|clouds|proven|passing|green)\b/i.test(matchable)) {
			out.push({ line: i + 1, kind: "count", text: line });
		}
		if (/\b(?:is|are)\s+(?:now\s+)?(?:green|proven|passing|red)\b/i.test(matchable)) {
			out.push({ line: i + 1, kind: "claim", text: line });
		}
	}
	return out;
}

// ───────────────────────────── inputs ─────────────────────────────

/** Count the sections of one exclusions YAML, without pretending to parse YAML. */
function countExclusions(file) {
	if (!fs.existsSync(file)) return undefined;
	const text = fs.readFileSync(file, "utf8");
	/** @type {Record<string, number>} */
	const counts = {};
	let section = null;
	for (const line of text.split("\n")) {
		if (/^\s*#/.test(line)) continue;
		const top = line.match(/^([a-z_]+):\s*$/);
		if (top !== null) {
			section = top[1];
			counts[section] = 0;
			continue;
		}
		const scalar = line.match(/^([a-z_]+):\s*(\d+)\s*$/);
		if (scalar !== null) {
			counts[scalar[1]] = Number(scalar[2]);
			section = null;
			continue;
		}
		if (section !== null && /^\s+-\s/.test(line)) counts[section]++;
	}
	return counts;
}

function readInputs() {
	const need = (f) => {
		if (!fs.existsSync(f)) {
			console.error(`::error::programme-rollup: required input ${f} is missing. Refusing to render a partial ledger.`);
			process.exit(3);
		}
		return fs.readFileSync(f, "utf8");
	};
	const snapshot = fs.existsSync(SNAPSHOT) ? JSON.parse(fs.readFileSync(SNAPSHOT, "utf8")) : null;
	return {
		snapshot,
		ledgerText: need(LEDGER),
		spine: JSON.parse(need(SPINE)),
		workflowText: need(WORKFLOW),
		resolverText: need(RESOLVER),
		unsupportedText: need(UNSUPPORTED_KINDS),
		// ABSENT MEANS EMPTY, not "skip the rule". A ratchet whose baseline file can be deleted to
		// silence it is not a ratchet — removing the file must make the guard louder (every
		// mismatch becomes a failure), never quieter.
		ledgerBaseline: fs.existsSync(LEDGER_BASELINE) ? JSON.parse(fs.readFileSync(LEDGER_BASELINE, "utf8")) : {},
		// WHAT EACH DIMENSION'S CLAIM REQUIRES, read from the same generated fixture the harness seeds
		// rather than hardcoded here. `addons` says "18 add-ons" in its label and the number has to
		// come from the catalog, or the two drift and the guard measures against a stale figure —
		// which is the class of defect it was written to catch. A catalog that cannot be read yields
		// `undefined`, and the predicate treats that as `unknown`: refusing to credit, never guessing.
		assertRequirements: { addons: addOnCatalogCount() },
		bundleExists: (p) => fs.existsSync(p),
		// Tolerant on purpose: an absent or unreadable summary means "cannot check", which is not the
		// same as "checked and fine". The rule below simply does not fire, rather than inventing a
		// verdict from a file it could not read.
		readBundleSummary: (p) => {
			try {
				return JSON.parse(fs.readFileSync(p, "utf8"));
			} catch {
				return null;
			}
		},
		exclusionCounts: Object.fromEntries(
			[
				["infra/offer-exclusions.yaml", countExclusions("infra/offer-exclusions.yaml")],
				["infra/config-carriage-exclusions.yaml", countExclusions("infra/config-carriage-exclusions.yaml")],
				["infra/template-parity-exclusions.yaml", countExclusions("infra/template-parity-exclusions.yaml")],
			].filter(([, c]) => c !== undefined),
		),
	};
}

// ───────────────────────────── self-test ─────────────────────────────

const FIXTURE_SPINE = {
	clouds: ["aws", "hetzner"],
	kinds: [
		{ kind: "cluster", doc: "", foundational: true, cells: { aws: { carriage: "tofu", offered: true }, hetzner: { carriage: "tofu", offered: true } } },
		{ kind: "nosql", doc: "", foundational: false, cells: { aws: { carriage: "tofu", offered: true }, hetzner: { carriage: "ceiling", offered: false, why: "no service" } } },
		{ kind: "registry", doc: "", foundational: false, cells: { aws: { carriage: "tofu", offered: true }, hetzner: { carriage: "deferred", offered: false, chart: "harbor", why: "mapping missing" } } },
	],
	cli_steps: [
		{ id: "login", title: "", reach: "cli" },
		{ id: "dns-delegation", title: "", reach: "cloud_manual", issue: "#1773", why: "registrar" },
	],
};

function runSelfTest() {
	let fails = 0;
	const ok = (name, cond, detail = "") => {
		if (cond) console.log(`ok   - ${name}`);
		else {
			console.error(`FAIL - ${name}${detail ? `: ${detail}` : ""}`);
			fails++;
		}
	};
	const base = {
		spine: FIXTURE_SPINE,
		// Mirrors the real tree post-#2356: the workflow no longer names the fidelity gates inline —
		// the resolver exports them. Keeping them in workflowText here would have hidden the very
		// regression this fixture exists to catch.
		workflowText: "        # ALETHIA_E2E_MAX_CONFIG is exported by the resolver\n",
		resolverText: "\t\techo \"ALETHIA_E2E_MAX_CONFIG=1\"\n\t\techo \"ALETHIA_E2E_ALL_ADDONS=1\"\n",
		unsupportedText: 'export const UNSUPPORTED_KINDS_BY_PROVIDER = {\n\thetzner: ["topic", "nosql"],\n}\n',
		bundleExists: () => true,
	};
	const hdr = "| UTC date | git sha | cloud | dimension | verdict | detail | bundle | issue |\n";
	const row = (d, cloud, dim, v, bundle, issue = "—") => `| ${d} | abc1234 | ${cloud} | ${dim} | **${v}** | detail | \`${bundle}\` | ${issue} |\n`;

	// A PASS with a committed bundle path is the ONLY thing that proves a cell.
	let r = derive({ ...base, ledgerText: hdr + row("2026-08-01", "aws", "floor", "PASS", "demos/proofs/aws/20260801T000000Z") });
	ok("a PASS with an existing committed bundle is proven", r.grid.aws.floor.state === "proven", r.grid.aws.floor.why);

	// The regression that produced four retracted rows: a PASS whose bundle is an expiring run tag.
	r = derive({ ...base, ledgerText: hdr + row("2026-07-22", "aws", "floor", "PASS", "nightly-29895597616") });
	ok("a PASS carrying an expiring CI run tag is NOT proven", r.grid.aws.floor.state === "never_run", r.grid.aws.floor.why);
	ok("...and says why in terms of the run tag", /run tag/i.test(r.grid.aws.floor.why));

	// A PASS whose bundle path is absent from the tree.
	r = derive({ ...base, bundleExists: () => false, ledgerText: hdr + row("2026-08-01", "aws", "floor", "PASS", "demos/proofs/aws/20260801T000000Z") });
	ok("a PASS whose bundle is missing from the tree is NOT proven", r.grid.aws.floor.state === "never_run", r.grid.aws.floor.why);

	// ── BLOCKED vs FAIL, reconciled against the bundle's own summary. ──
	//
	// Both directions, and the negative cases matter more than the positive one: a rule that fires
	// on everything is not a check, it is a ban on the verdict.
	{
		const summaries = (m) => (p) => m[p] ?? null;
		const AT = "demos/proofs/hetzner/20260825T130348Z";
		const spent = { outcome: "failure", deploy_stage: "applying", duration_seconds: 237 };

		// THE REGRESSION, twice over: #2575 and #2587 both typed this.
		r = derive({
			...base,
			ledgerText: hdr + row("2026-08-25", "hetzner", "full", "BLOCKED", AT),
			readBundleSummary: summaries({ [`${AT}/provision-summary.json`]: spent }),
		});
		ok(
			"a BLOCKED row whose bundle reached 'applying' is an integrity failure",
			r.failures.some((f) => /recorded BLOCKED, but its own bundle/.test(f)),
			JSON.stringify(r.failures),
		);
		ok("...and the message names the stage it actually reached", r.failures.some((f) => /deploy_stage: "applying"/.test(f)), JSON.stringify(r.failures));

		// A genuine refusal — the harness stopped at a prerequisite gate, before any apply.
		r = derive({
			...base,
			ledgerText: hdr + row("2026-08-25", "hetzner", "full", "BLOCKED", AT),
			readBundleSummary: summaries({ [`${AT}/provision-summary.json`]: { outcome: "failure", deploy_stage: "prerequisites" } }),
		});
		ok("a BLOCKED row that never reached 'applying' is left alone", !r.failures.some((f) => /recorded BLOCKED/.test(f)), JSON.stringify(r.failures));

		// FAIL is the correct verdict for the same summary, so it must raise nothing. Without this
		// the rule could be keyed on the summary alone and still pass the case above.
		r = derive({
			...base,
			ledgerText: hdr + row("2026-08-25", "hetzner", "full", "FAIL", AT),
			readBundleSummary: summaries({ [`${AT}/provision-summary.json`]: spent }),
		});
		ok("the same bundle recorded FAIL raises nothing", !r.failures.some((f) => /recorded BLOCKED/.test(f)), JSON.stringify(r.failures));

		// ONE DIRECTION: a FAIL on a run that never spent overstates the damage, which costs nobody
		// a proof. It is deliberately not refused.
		//
		// This is the one assertion in the file that demands `failures` be EMPTY rather than free of
		// one pattern, which is worth keeping — it catches any new rule that fires on an ordinary
		// row. That is exactly what it did when #3157 landed, so the fixture now cites an issue, as
		// a real FAIL row must.
		r = derive({
			...base,
			ledgerText: hdr + row("2026-08-25", "hetzner", "full", "FAIL", AT, "#2718"),
			readBundleSummary: summaries({ [`${AT}/provision-summary.json`]: { outcome: "failure", deploy_stage: "prerequisites" } }),
		});
		ok("a FAIL on a run that did not spend is NOT refused", r.failures.length === 0, JSON.stringify(r.failures));

		// No summary in the bundle ⇒ cannot check. That is not the same as checked-and-fine, and it
		// must not invent a verdict from a file it could not read.
		r = derive({
			...base,
			ledgerText: hdr + row("2026-08-25", "hetzner", "full", "BLOCKED", AT),
			readBundleSummary: () => null,
		});
		ok("an unreadable summary does not fire the rule", !r.failures.some((f) => /recorded BLOCKED/.test(f)), JSON.stringify(r.failures));

		// THE CASE THE REAL TREE TAUGHT ME. The ledger is append-only, so a row corrected the proper
		// way is still in the file forever: #2585 superseded hetzner/full with a RETRACTED plus a
		// FAIL re-record, and the original BLOCKED row is still at line 53. Walking every row fired
		// on it and failed the build on history that had already been fixed — the rule would have
		// punished exactly the correction it asks for. It reads the collapsed claim instead.
		r = derive({
			...base,
			ledgerText:
				hdr +
				row("2026-08-25", "hetzner", "full", "BLOCKED", AT) +
				row("2026-08-25", "hetzner", "full", "RETRACTED", AT, "#2575") +
				row("2026-08-25", "hetzner", "full", "FAIL", AT, "#2568"),
			readBundleSummary: summaries({ [`${AT}/provision-summary.json`]: spent }),
		});
		ok(
			"a BLOCKED row already superseded by a RETRACTED + re-record does NOT fire",
			!r.failures.some((f) => /recorded BLOCKED/.test(f)),
			JSON.stringify(r.failures),
		);
		ok("...and the re-recorded FAIL is the surviving claim", r.grid.hetzner.maxconfig.state === "failing", r.grid.hetzner.maxconfig.why);

		// A run-tag bundle has no committed summary to read, so the rule cannot apply to it at all.
		r = derive({
			...base,
			ledgerText: hdr + row("2026-08-25", "hetzner", "full", "BLOCKED", "nightly-32850686520"),
			readBundleSummary: summaries({ "nightly-32850686520/provision-summary.json": spent }),
		});
		ok("a run-tag bundle is not reconciled", !r.failures.some((f) => /recorded BLOCKED/.test(f)), JSON.stringify(r.failures));
	}

	// ── A row's sha vs its own bundle's sha (#2718). ──
	//
	// The negatives carry the weight. A rule that fires on every row is not a check, and a
	// baseline that can be padded is not a ratchet.
	{
		ok("shasAgree: identical", shasAgree("abc1234", "abc1234"), "");
		ok("shasAgree: the LONGER row sha extends the bundle's", shasAgree("abc12345", "abc1234"), "");
		ok("shasAgree: the LONGER bundle sha extends the row's", shasAgree("abc1234", "abc12345"), "");
		ok("shasAgree: different commits disagree", !shasAgree("abc1234", "def5678"), "");
		// Without a minimum length an empty or truncated cell agrees with everything, and the guard
		// reports green on exactly the rows it cannot read.
		ok("shasAgree: an empty sha agrees with nothing", !shasAgree("", "abc1234"), "");
		ok("shasAgree: a too-short prefix is a coincidence, not a match", !shasAgree("abc", "abc1234"), "");
		ok("shasAgree: 'unknown' is not a sha", !shasAgree("unknown", "abc1234"), "");

		const AT = "demos/proofs/gcp/20260825T200519Z";
		const at = (git_sha) => (p) => (p === `${AT}/provision-summary.json` ? { outcome: "success", git_sha } : null);
		const shaRow = (sha, bundle) => `| 2026-08-25 | ${sha} | gcp | floor | **PASS** | detail | \`${bundle}\` | — |\n`;
		const MISMATCH = /is recorded at .* but its own bundle/;

		r = derive({ ...base, ledgerText: hdr + shaRow("09911316", AT), readBundleSummary: at("f3cb966") });
		ok("a row naming a commit its run never executed is an integrity failure", r.failures.some((f) => MISMATCH.test(f)), JSON.stringify(r.failures));
		ok("...and the message names both shas", r.failures.some((f) => /09911316/.test(f) && /f3cb966/.test(f)), JSON.stringify(r.failures));

		// The positive case, both abbreviation lengths — the ledger carries 7- and 8-char forms side
		// by side, so a one-way comparison would call half the real matches a mismatch.
		r = derive({ ...base, ledgerText: hdr + shaRow("f3cb966", AT), readBundleSummary: at("f3cb9661234") });
		ok("a row whose sha is a PREFIX of its bundle's raises nothing", !r.failures.some((f) => MISMATCH.test(f)), JSON.stringify(r.failures));
		r = derive({ ...base, ledgerText: hdr + shaRow("f3cb9661234", AT), readBundleSummary: at("f3cb966") });
		ok("a row whose sha EXTENDS its bundle's raises nothing", !r.failures.some((f) => MISMATCH.test(f)), JSON.stringify(r.failures));

		// An absent measurement is not a pass. It must not fail the build, and it must not be silent.
		r = derive({ ...base, ledgerText: hdr + shaRow("09911316", AT), readBundleSummary: at("unknown") });
		ok("a bundle whose sha is 'unknown' is not compared", !r.failures.some((f) => MISMATCH.test(f)), JSON.stringify(r.failures));
		ok("...but it is reported as unmeasured", r.notes.some((n) => /no usable `git_sha`/.test(n)), JSON.stringify(r.notes));
		r = derive({ ...base, ledgerText: hdr + shaRow("09911316", AT), readBundleSummary: () => null });
		ok("an unreadable summary is not compared either", !r.failures.some((f) => MISMATCH.test(f)), JSON.stringify(r.failures));

		// The ratchet.
		const ack = (o) => ({ sha_drift: { records: [{ cloud: "gcp", dimension: "floor", row_sha: "09911316", bundle_sha: "f3cb966", ...o }] } });
		r = derive({ ...base, ledgerText: hdr + shaRow("09911316", AT), readBundleSummary: at("f3cb966"), ledgerBaseline: ack({}) });
		ok("an acknowledged mismatch is grandfathered", !r.failures.some((f) => MISMATCH.test(f)), JSON.stringify(r.failures));

		// Shrink-only: the record must stop being accepted once the row it names agrees.
		r = derive({ ...base, ledgerText: hdr + shaRow("f3cb966", AT), readBundleSummary: at("f3cb966"), ledgerBaseline: ack({}) });
		ok("a record for a mismatch that no longer exists is an integrity failure", r.failures.some((f) => /no longer corresponds/.test(f)), JSON.stringify(r.failures));

		// A record must not grandfather a DIFFERENT mismatch than the one it names — otherwise one
		// acknowledgement launders every future drift on that cell.
		r = derive({ ...base, ledgerText: hdr + shaRow("09911316", AT), readBundleSummary: at("9999999"), ledgerBaseline: ack({}) });
		ok("an acknowledgement does not cover a mismatch against a different bundle sha", r.failures.some((f) => MISMATCH.test(f)), JSON.stringify(r.failures));

		// A duplicate can never be satisfied — only surviving claims are checked, so one record per
		// cell is the ceiling. Absorbing it silently would let the list be padded.
		r = derive({
			...base,
			ledgerText: hdr + shaRow("09911316", AT),
			readBundleSummary: at("f3cb966"),
			ledgerBaseline: { sha_drift: { records: [...ack({}).sha_drift.records, ...ack({}).sha_drift.records] } },
		});
		ok("a duplicate baseline record is an integrity failure", r.failures.some((f) => /duplicate record/.test(f)), JSON.stringify(r.failures));

		// Deleting the baseline must make the guard LOUDER, never quieter.
		r = derive({ ...base, ledgerText: hdr + shaRow("09911316", AT), readBundleSummary: at("f3cb966"), ledgerBaseline: undefined });
		ok("no baseline at all means every mismatch fails", r.failures.some((f) => MISMATCH.test(f)), JSON.stringify(r.failures));
	}

	// ── the unfiled-red ratchet (#3157) ───────────────────────────────────────────────────────────
	//
	// The negatives are the ones that matter here. A rule that fires on every red is not a check —
	// three of the four reds in the tree the day this landed were correctly cited — and a baseline
	// that a stale record can pad is not a ratchet.
	{
		const UNCITED = /names no issue in its last column/;
		const STALE = /no longer corresponds to a red whose surviving row names no issue/;
		const redRow = (issue) => row("2026-08-01", "aws", "floor", "FAIL", "demos/proofs/aws/20260801T000000Z", issue);
		// `abc1234` is what `row()` stamps; the key pins the ROW, not just the cell.
		const rec = (o) => ({ unfiled_reds: { records: [{ cloud: "aws", dimension: "floor", date: "2026-08-01", row_sha: "abc1234", ...o }] } });

		r = derive({ ...base, ledgerText: hdr + redRow("—") });
		ok("a red whose row names no issue is an integrity failure", r.failures.some((f) => UNCITED.test(f)), JSON.stringify(r.failures));
		// A refusal that does not say what to do next is how a guard teaches people to route around
		// it. Both remedies must be in the message: the one for a row you are writing, and the one
		// for a row the append-only ledger will not let you touch.
		ok("...and it names the cell and the ledger line", r.failures.some((f) => /aws\/floor/.test(f) && /provisioning-e2e-log\.md:\d+/.test(f)), JSON.stringify(r.failures));
		ok("...and tells you to fill the last column", r.failures.some((f) => /put the issue number in its last column/.test(f)), JSON.stringify(r.failures));
		ok("...and gives the exact title to file under", r.failures.some((f) => /e2e nightly: aws RED \(floor\)/.test(f)), JSON.stringify(r.failures));
		ok("...and names the grandfathering escape for a row that cannot be corrected", r.failures.some((f) => /unfiled_reds/.test(f)), JSON.stringify(r.failures));

		// The two negatives that keep it from being a rule that fires on everything.
		r = derive({ ...base, ledgerText: hdr + redRow("#3098") });
		ok("a red that cites an issue raises nothing", !r.failures.some((f) => UNCITED.test(f)), JSON.stringify(r.failures));
		r = derive({ ...base, ledgerText: hdr + row("2026-08-01", "aws", "floor", "PASS", "demos/proofs/aws/20260801T000000Z", "—") });
		ok("a PROVEN cell with no issue raises nothing — only reds need an owner", !r.failures.some((f) => UNCITED.test(f)), JSON.stringify(r.failures));

		// BLOCKED is a red too: the harness refused before spending, and that refusal has a cause
		// somebody owns. Excluding it would leave the cheapest-to-diagnose state unowned.
		r = derive({ ...base, ledgerText: hdr + row("2026-08-01", "aws", "floor", "BLOCKED", "demos/proofs/aws/20260801T000000Z", "—") });
		ok("a BLOCKED cell with no issue is also unowned", r.failures.some((f) => UNCITED.test(f)), JSON.stringify(r.failures));

		// The ratchet.
		r = derive({ ...base, ledgerText: hdr + redRow("—"), ledgerBaseline: rec({ issue: "#3098", reason: "predates the convention" }) });
		ok("a grandfathered unfiled red is not a failure", !r.failures.some((f) => UNCITED.test(f)), JSON.stringify(r.failures));
		// Grandfathered is not silenced. The record exists because somebody DOES own the red, and a
		// reader who cannot see that has the same problem the rule was written to fix.
		ok("...but it is still reported, naming its owner", r.notes.some((n) => /aws\/floor/.test(n) && /#3098/.test(n)), JSON.stringify(r.notes));

		// A record must pin the ROW. Keyed on the cell alone, one acknowledgement would launder
		// every future uncited row for that cell — which is exactly what a re-run produces.
		r = derive({ ...base, ledgerText: hdr + redRow("—"), ledgerBaseline: rec({ row_sha: "9999999" }) });
		ok("a record does not cover a DIFFERENT row for the same cell", r.failures.some((f) => UNCITED.test(f)), JSON.stringify(r.failures));

		// Shrink-only, both ways it can go stale: the cell gets cited, or the cell stops being red.
		r = derive({ ...base, ledgerText: hdr + redRow("#3098"), ledgerBaseline: rec({}) });
		ok("a record for a red that is now cited is an integrity failure", r.failures.some((f) => STALE.test(f)), JSON.stringify(r.failures));
		r = derive({ ...base, ledgerText: hdr + row("2026-08-01", "aws", "floor", "PASS", "demos/proofs/aws/20260801T000000Z", "—"), ledgerBaseline: rec({}) });
		ok("a record for a cell that is no longer red is an integrity failure", r.failures.some((f) => STALE.test(f)), JSON.stringify(r.failures));

		r = derive({ ...base, ledgerText: hdr + redRow("—"), ledgerBaseline: { unfiled_reds: { records: [...rec({}).unfiled_reds.records, ...rec({}).unfiled_reds.records] } } });
		ok("a duplicate unfiled-red record is an integrity failure", r.failures.some((f) => /duplicate unfiled-red record/.test(f)), JSON.stringify(r.failures));

		// Deleting the baseline must make the guard LOUDER, never quieter.
		r = derive({ ...base, ledgerText: hdr + redRow("—"), ledgerBaseline: undefined });
		ok("no baseline at all means every unfiled red fails", r.failures.some((f) => UNCITED.test(f)), JSON.stringify(r.failures));
	}

	// ── the composite must not credit a dimension its own bundle does not evidence (#2671) ────────
	//
	// `addons` is the one dimension whose composite credit could never be withheld: its only gate is
	// `derived`, so the repo-gate filter leaves an empty array and `[].every(…)` is true. The
	// negatives below are therefore the entire content of the fix — a rule that credits everything is
	// what was already there.
	{
		const FULL = "demos/proofs/aws/full";
		const at = (v) => (p) => (p === `${FULL}/provision-summary.json` ? v : null);
		const run = (summary, required = 18) =>
			derive({
				...base,
				ledgerText: hdr + row("2026-08-01", "aws", "full", "PASS", FULL),
				readBundleSummary: typeof summary === "function" ? summary : at(summary),
				assertRequirements: { addons: required },
			});
		const converged = (n) => ({ argocd_assert_outcome: "converged", argocd_expected_total: n, argocd_healthy_synced_asserted: n });

		// The predicate, alone. Each of these is a bundle shape that exists in the tree today.
		ok("a run that asserted the whole catalog says yes", assertsFullAddOnSweep(converged(18), 18) === "yes");
		ok("a run that asserted MORE than the catalog says yes", assertsFullAddOnSweep(converged(24), 18) === "yes");
		ok("a run that asserted a floor-sized set says no", assertsFullAddOnSweep(converged(6), 18) === "no", "the #2642 shape: 6 Applications passing a sweep advertised as 18");
		// THE TRAP #2671 NAMES BY NUMBER. Every pre-#2688 bundle carries these zeros, on passing and
		// failing runs alike, because capture-proof.sh counted the cluster after teardown removed it.
		// Reading them as an observation would refuse every historical credit on a measurement nobody
		// took; reading their absence as fine reinstates the hole. Both are wrong, so it is `unknown`.
		ok("a pre-#2688 bundle's captured zeros are UNKNOWN, not a small sweep", assertsFullAddOnSweep({ argocd_total: 0, argocd_healthy_synced: 0 }, 18) === "unknown");
		ok("a bundle with neither field is unknown", assertsFullAddOnSweep({ outcome: "success" }, 18) === "unknown");
		// The field #2671 itself proposed. It is null by design in every post-#2688 bundle, so a check
		// written against it would find nothing and — written the obvious way — credit anyway.
		ok("the capture-time field alone is unknown, whatever it says", assertsFullAddOnSweep({ argocd_total: null, argocd_healthy_synced: null }, 18) === "unknown");
		ok("the harness's own 'unmeasured' verdict is believed over the numbers beside it", assertsFullAddOnSweep({ ...converged(18), argocd_assert_outcome: "unmeasured" }, 18) === "unknown");
		ok("an unreadable summary is unknown", assertsFullAddOnSweep(null, 18) === "unknown");
		// An unreadable catalog must not silently become a requirement of zero, which every run meets.
		ok("an unknown requirement is unknown, never satisfied", assertsFullAddOnSweep(converged(18), undefined) === "unknown");
		ok("...and neither is a requirement of zero", assertsFullAddOnSweep(converged(0), 0) === "unknown");
		// Half-measured is not measured: expected without asserted says what was hoped for, not seen.
		ok("expected without asserted is unknown", assertsFullAddOnSweep({ argocd_assert_outcome: "converged", argocd_expected_total: 18 }, 18) === "unknown");

		// End to end, through derive().
		r = run(converged(18));
		ok("a full run that asserted the catalog credits addons", r.grid.aws.addons.state === "proven", r.grid.aws.addons.why);
		r = run(converged(6));
		ok("a full run that asserted six does NOT credit addons", r.grid.aws.addons.state === "never_run", r.grid.aws.addons.why);
		// A refusal that names a cause it did not establish is the defect this file has shipped twice.
		// The repo-gate sentence is wrong here — `addons` has no repo gate — so it must not appear.
		ok("...and the refusal names the assertion, not the repo gate", /did not assert what this column claims/.test(r.grid.aws.addons.why), r.grid.aws.addons.why);
		ok("...and does NOT blame a repo gate it has no repo gate to blame", !/repo gate is set/.test(r.grid.aws.addons.why), r.grid.aws.addons.why);
		ok("...and names the bundle, so the claim can be checked", r.grid.aws.addons.why.includes(FULL), r.grid.aws.addons.why);

		r = run(() => null);
		ok("an unmeasurable bundle refuses the credit", r.grid.aws.addons.state === "never_run", r.grid.aws.addons.why);
		ok("...saying it cannot be SHOWN, not that it failed", /cannot be shown to have asserted/.test(r.grid.aws.addons.why), r.grid.aws.addons.why);
		// `never_run` renders identically for "nobody tried" and "somebody did and we cannot check".
		// The note is the only thing that separates them, and the second is one dispatch from proven.
		ok("...and it is reported, so unmeasured is not silently never-run", r.notes.some((n) => /no assertion-time evidence/.test(n) && /aws\/addons/.test(n)), JSON.stringify(r.notes));

		// The other dimensions must be untouched: this is a per-dimension declaration, not a new
		// blanket requirement that every composite credit carry a bundle measurement.
		ok("a dimension that declares no requirement is credited as before", r.grid.aws.maxconfig.state === "proven", r.grid.aws.maxconfig.why);

		// A DIRECT claim is the more specific statement and never passes through this at all.
		r = derive({
			...base,
			ledgerText: hdr + row("2026-08-01", "aws", "full", "PASS", FULL) + row("2026-08-02", "aws", "addons", "PASS", "demos/proofs/aws/addons"),
			readBundleSummary: at(converged(6)),
			assertRequirements: { addons: 18 },
		});
		ok("a DIRECT addons claim is unaffected by the composite's evidence", r.grid.aws.addons.state === "proven", r.grid.aws.addons.why);
	}

	// ── #3243: A COMPOSITE **FAIL** MAY ONLY DISCREDIT WHAT THE BAR REACHED. ──
	//
	// The mirror image of the block above, and the reason it had to be written: the credit side had
	// three conditions and the discredit side had none, so one bar FAIL reded every composed column
	// whether or not the run got within a mile of it. The worked case is azure's 2026-08-25 bar,
	// which died on the `cache` kind at `deploy_stage: applying` — `azure/gitops` and `azure/day2`
	// read ❌ off a run that never installed ArgoCD.
	//
	// BOTH DIRECTIONS ARE PINNED HERE, because a rule that only ever withholds is the same defect
	// wearing the opposite sign: it would erase every red on the board and the grid would go quiet.
	{
		const FULL = "demos/proofs/azure/full";
		const at = (v) => (p) => (p === `${FULL}/provision-summary.json` ? v : null);
		// Every repo gate a composed dimension declares, wired — named from DIMENSIONS rather than
		// retyped, so renaming a gate cannot leave this passing against a name nothing reads. Without
		// it `gitops` and `day2` refuse the composite STRUCTURALLY and this block would be measuring
		// the repo-gate rule instead of the reach rule.
		const repoGates = DIMENSIONS.filter((d) => d.composedByFull !== false).flatMap((d) => d.gates.filter((g) => g.kind === "repo").map((g) => g.name));
		const wiredSnap = {
			gate_observations: [],
			derived_at: new Date(Date.now() - 3600_000).toISOString(),
			// Stamped, because an inventory with no observation time is `unknown` rather than wired —
			// without it this block would measure the staleness rule instead of the reach rule.
			inventory_observed_at: new Date(Date.now() - 3600_000).toISOString(),
			open_issues: [],
			closed_issues: [],
			variables: repoGates,
			secrets: [],
		};
		const bar = (summary) =>
			derive({
				...base,
				ledgerText: hdr + row("2026-08-25", "aws", "full", "FAIL", FULL, "#2383"),
				readBundleSummary: at(summary),
				assertRequirements: { addons: 18 },
				snapshot: wiredSnap,
			});
		ok("the reach block's repo gates are actually wired, or it measures the wrong rule", repoGates.length > 0, JSON.stringify(repoGates));
		// The two real bundles this rule was derived from, by shape.
		const diedInApply = { outcome: "failure", deploy_stage: "applying", duration_seconds: 1724 };
		const diedAtArgo = { outcome: "failure", deploy_stage: "argocd-ready" };

		// ── the predicate, alone. Vary the STAGE, which is the axis the rule turns on.
		ok("a run that reached the rung says yes", compositeReached({ deploy_stage: "argocd-ready" }, "argocd-installed") === "yes");
		ok("a run that stopped exactly at the rung says yes", compositeReached({ deploy_stage: "applying" }, "applying") === "yes");
		ok("a run that stopped one rung short says no", compositeReached({ deploy_stage: "applied" }, "deployed") === "no");
		ok("azure's died-in-apply bundle did NOT reach the add-on surface", compositeReached(diedInApply, "argocd-installed") === "no");
		ok("...but it DID reach the kinds its own apply creates", compositeReached(diedInApply, "applying") === "yes");
		// `unknown` KEEPS the red — the opposite default from the credit half, and the one thing about
		// this rule that is easy to get backwards. An unreadable bundle must not erase a diagnosed FAIL.
		ok("an unreadable summary is unknown, never 'did not reach'", compositeReached(null, "argocd-installed") === "unknown");
		ok("a summary with no deploy_stage is unknown", compositeReached({ outcome: "failure" }, "argocd-installed") === "unknown");
		// THE TWO -1 TRAPS. `indexOf` answers -1 for an unknown token, and -1 compares as "before
		// everything": an unrecognised STAGE would satisfy no requirement (withholding every red), and
		// an unrecognised REQUIREMENT would be satisfied by every run (restoring the bug outright).
		// Both must be `unknown`, and neither may be reached by simply comparing the two numbers.
		ok("a stage this ladder does not carry is unknown, not 'stopped short'", compositeReached({ deploy_stage: "quiescing" }, "applying") === "unknown");
		ok("a requirement this ladder does not carry is unknown, not 'satisfied by everything'", compositeReached({ deploy_stage: "queued" }, "no-such-rung") === "unknown");
		ok("...and an undeclared requirement is unknown, never a requirement of zero", compositeReached({ deploy_stage: "queued" }, undefined) === "unknown");

		// ── end to end, through derive(). DIRECTION ONE: a bar that reached the dimension still reds it.
		r = bar(diedAtArgo);
		ok("a bar FAIL that reached the add-on surface STILL discredits addons", r.grid.aws.addons.state === "failing", r.grid.aws.addons.why);
		ok("...and still discredits gitops", r.grid.aws.gitops.state === "failing", r.grid.aws.gitops.why);
		ok("...and still discredits day2", r.grid.aws.day2.state === "failing", r.grid.aws.day2.why);
		ok("...and still discredits the floor and the kinds", r.grid.aws.floor.state === "failing" && r.grid.aws.maxconfig.state === "failing", `${r.grid.aws.floor.state}/${r.grid.aws.maxconfig.state}`);
		ok("...and reports NO withheld discredit, so 'nothing withheld' is a distinct answer", r.unreachedComposites.length === 0, JSON.stringify(r.unreachedComposites));

		// ── DIRECTION TWO: the azure case. A bar that died in apply reds only what it reached.
		r = bar(diedInApply);
		ok("a bar FAIL that died in apply does NOT discredit addons", r.grid.aws.addons.state === "never_run", r.grid.aws.addons.why);
		ok("...nor gitops", r.grid.aws.gitops.state === "never_run", r.grid.aws.gitops.why);
		ok("...nor day2", r.grid.aws.day2.state === "never_run", r.grid.aws.day2.why);
		// THE LINE THAT MATTERS MOST. A withheld discredit removes a verdict; it must never invent
		// one. Turning a false FAIL into a false PASS is a worse bug than the one being fixed.
		ok(
			"a withheld discredit is never_run and NEVER proven",
			["addons", "gitops", "day2"].every((id) => r.grid.aws[id].state !== "proven"),
			JSON.stringify(["addons", "gitops", "day2"].map((id) => [id, r.grid.aws[id].state])),
		);
		// The cells the bar DID reach keep their reds — this is the half that stops the rule from
		// quietly emptying the board. azure's cache kind is a maxconfig kind and is what died.
		ok("...while the floor and the kinds, which that apply DID reach, stay red", r.grid.aws.floor.state === "failing" && r.grid.aws.maxconfig.state === "failing", `${r.grid.aws.floor.state}/${r.grid.aws.maxconfig.state}`);
		// A refusal that names a cause it did not establish is the defect this file has shipped
		// twice. The repo-gate sentence and the assertion sentence are both wrong here.
		ok("...and the withholding names the STAGE, not a repo gate or an assertion", /stopped before/.test(r.grid.aws.addons.why) && !/green-skips/.test(r.grid.aws.addons.why) && !/did not assert/.test(r.grid.aws.addons.why), r.grid.aws.addons.why);
		ok("...and names the bundle and the stage, so the claim can be checked", r.grid.aws.addons.why.includes(FULL) && r.grid.aws.addons.why.includes("applying"), r.grid.aws.addons.why);
		ok("...and says plainly that this is not a pass", /NOT a pass/.test(r.grid.aws.addons.why), r.grid.aws.addons.why);
		ok("...and it is REPORTED, so a vanished red is not a silent one", r.notes.some((n) => /stopped before their surface/.test(n) && /aws\/addons/.test(n)), JSON.stringify(r.notes));

		// ── DIRECTION THREE, and the one a `reach !== "yes"` slip would silently break: UNKNOWN KEEPS
		// THE RED. Only a bundle that positively says the run stopped short may withhold a discredit.
		// An unreadable one, or one from before capture-proof.sh recorded a stage, must leave every
		// red exactly where it was — otherwise a missing file quietly empties the grid, which is this
		// repo's dominant defect class (a guard whose "nothing found" branch reads as "nothing wrong")
		// pointed at the proof board itself.
		for (const [name, summary] of [
			["an UNREADABLE bundle", null],
			["a bundle with no deploy_stage", { outcome: "failure" }],
			["a bundle naming a rung this ladder does not carry", { outcome: "failure", deploy_stage: "quiescing" }],
		]) {
			r = bar(summary);
			ok(
				`${name} keeps every red the bar filed — unknown never withholds`,
				["floor", "maxconfig", "addons", "gitops", "day2"].every((id) => r.grid.aws[id].state === "failing"),
				JSON.stringify(["floor", "maxconfig", "addons", "gitops", "day2"].map((id) => [id, r.grid.aws[id].state])),
			);
			ok(`...and ${name} withholds nothing at all`, r.unreachedComposites.length === 0, JSON.stringify(r.unreachedComposites));
		}

		// A DIRECT claim is the more specific statement and never passes through this at all — in
		// EITHER direction. A cell with its own FAIL row keeps it however far the bar got.
		r = derive({
			...base,
			ledgerText: hdr + row("2026-08-25", "aws", "full", "FAIL", FULL, "#2383") + row("2026-08-26", "aws", "addons", "FAIL", "demos/proofs/aws/addons", "#1"),
			readBundleSummary: at(diedInApply),
			assertRequirements: { addons: 18 },
			snapshot: wiredSnap,
		});
		ok("a DIRECT FAIL survives a bar that never reached the dimension", r.grid.aws.addons.state === "failing", r.grid.aws.addons.why);
		// The note must not advertise a correction nobody made — but it must STILL name the two cells
		// the rule really did change, or "reported nothing" would be indistinguishable from "the rule
		// stopped firing". Both halves, in one derivation.
		ok(
			"...and is NOT reported as a withheld discredit, while its untouched siblings still are",
			r.notes.some((n) => /stopped before their surface/.test(n) && !/aws\/addons/.test(n) && /aws\/gitops/.test(n) && /aws\/day2/.test(n)),
			JSON.stringify(r.notes.filter((n) => /stopped before/.test(n))),
		);

		// A BLOCKED bar is deliberately NOT reach-checked: "the harness refused before spending" is
		// true of every dimension in a refused bar and accuses none of them, so there is nothing to
		// withhold. Pinned because the obvious generalisation — reach-check every negative verdict —
		// would turn ⛔ into `never_run` and hide a run that was refused.
		r = derive({
			...base,
			ledgerText: hdr + row("2026-08-25", "aws", "full", "BLOCKED", FULL),
			readBundleSummary: at({ outcome: "failure", deploy_stage: "queued" }),
			assertRequirements: { addons: 18 },
			snapshot: wiredSnap,
		});
		ok(
			"a BLOCKED bar still marks every composed cell blocked, not never-run",
			["floor", "maxconfig", "addons", "gitops", "day2"].every((id) => r.grid.aws[id].state === "blocked"),
			JSON.stringify(["floor", "maxconfig", "addons", "gitops", "day2"].map((id) => [id, r.grid.aws[id].state])),
		);

		// STRUCTURAL REFUSALS GOVERN BOTH DIRECTIONS — the asymmetry #3243 is named for, in its other
		// form. `base` carries no snapshot, so every repo gate reads `unknown`, which is not `wired`:
		// the layer green-skipped inside the bar. A bar PASS could not credit it, and the identical
		// bar FAIL must not discredit it either. `byo-iac` is the stronger case — `full` does not
		// compose it at ALL — and this held before, but nothing pinned it against a FAIL.
		r = bar(diedAtArgo);
		ok(
			"a bar FAIL does NOT discredit a dimension full never composes",
			r.grid.aws["byo-iac"].state === "never_run" && r.grid.aws["cli-demo"].state === "never_run",
			`${r.grid.aws["byo-iac"].state}/${r.grid.aws["cli-demo"].state}`,
		);

		// VACUITY. Every one of the assertions above would also pass if `derive` simply never
		// discredited anything, or if `reachedAt` were silently undefined on every column. Neither is
		// checkable from a cell state alone, so check the declaration itself.
		const composedDims = DIMENSIONS.filter((d) => d.composedByFull !== false);
		ok(
			"every dimension the bar composes declares a reachedAt rung on the ladder",
			composedDims.length > 0 && composedDims.every((d) => DEPLOY_STAGES.includes(d.reachedAt)),
			JSON.stringify(composedDims.map((d) => [d.id, d.reachedAt])),
		);
		ok(
			"...and they do NOT all sit on the same rung, or the rule could not tell them apart",
			new Set(composedDims.map((d) => d.reachedAt)).size > 1,
			JSON.stringify(composedDims.map((d) => [d.id, d.reachedAt])),
		);
	}

	// ── THE THIRD TWO-FILE INVARIANT: the deploy-stage ladder. ──
	//
	// DEPLOY_STAGES is a copy of the rungs `demos/proofs/capture-proof.sh` assigns to `deploy_stage`,
	// and the whole rule above rests on TWO properties of that copy: the rungs are the same words,
	// and they are in the same ORDER. A hand-kept copy loses both silently — a renamed rung makes
	// every bundle read `unknown` (every red kept, the rule inert and green), and a reordered one
	// would withhold and grant discredits at random. So parse the shell and hold them to each other.
	{
		const capture = fs.readFileSync(new URL("../demos/proofs/capture-proof.sh", import.meta.url), "utf8");
		// The emitter is a run of `deploy_stage="x"` assignments, lowest rung first, each overwriting
		// the last — which is exactly what makes the ladder monotone. Read them in file order.
		const emitted = [...capture.matchAll(/^\s*(?:log_has [^\n]*&&\s*)?deploy_stage="([a-z-]+)"/gm)].map((m) => m[1]);
		ok(
			"the deploy_stage ladder was actually parsed out of capture-proof.sh",
			emitted.length >= 5,
			`parsed ${JSON.stringify(emitted)} — the regex or the shell assignments changed shape`,
		);
		ok(
			"this file's ladder is capture-proof.sh's, in capture-proof.sh's order",
			JSON.stringify(emitted) === JSON.stringify(DEPLOY_STAGES),
			`capture-proof.sh emits ${JSON.stringify(emitted)}, this file carries ${JSON.stringify(DEPLOY_STAGES)}`,
		);
	}

	// RETRACTED supersession — voids the claim rather than replacing it.
	r = derive({
		...base,
		ledgerText: hdr + row("2026-07-22", "aws", "floor", "PASS", "demos/proofs/aws/20260722T000000Z") + row("2026-07-31", "aws", "floor", "RETRACTED", "demos/proofs/aws/20260722T000000Z", "#1723"),
	});
	ok("a RETRACTED row voids the earlier PASS", r.grid.aws.floor.state === "never_run", r.grid.aws.floor.why);

	// ...and a PASS recorded AFTER a retraction stands again.
	r = derive({
		...base,
		ledgerText:
			hdr +
			row("2026-07-22", "aws", "floor", "PASS", "demos/proofs/aws/a") +
			row("2026-07-31", "aws", "floor", "RETRACTED", "demos/proofs/aws/a", "#1723") +
			row("2026-08-05", "aws", "floor", "PASS", "demos/proofs/aws/b"),
	});
	ok("a later PASS after a retraction is proven again", r.grid.aws.floor.state === "proven", r.grid.aws.floor.why);

	// FAIL and BLOCKED are distinct — one spent money and broke, the other refused before spending.
	r = derive({ ...base, ledgerText: hdr + row("2026-08-01", "aws", "floor", "FAIL", "demos/proofs/aws/x", "#2329") + row("2026-08-01", "hetzner", "floor", "BLOCKED", "demos/proofs/hetzner/x") });
	ok("FAIL renders as failing", r.grid.aws.floor.state === "failing");
	ok("BLOCKED is kept distinct from failing", r.grid.hetzner.floor.state === "blocked", r.grid.hetzner.floor.why);

	// The composite: a `full` PASS is evidence for every dimension the full bar ACTUALLY EXERCISES.
	// `base` carries no snapshot, so every gate reads `unknown` — which is deliberately NOT `wired`.
	// The fixture now carries ASSERTION-TIME evidence, because "exercises" gained a third condition in
	// #2671: a dimension may also declare what its own claim requires, and `addons` does. Without the
	// counts below this assertion fails on `addons` — correctly, which is the whole point of that
	// change and the reason this fixture had to grow rather than the rule shrink.
	const FULL_SWEEP = { argocd_assert_outcome: "converged", argocd_expected_total: 18, argocd_healthy_synced_asserted: 18 };
	const sweepAt = (b, v) => (p) => (p === `${b}/provision-summary.json` ? v : null);
	r = derive({
		...base,
		ledgerText: hdr + row("2026-08-01", "aws", "full", "PASS", "demos/proofs/aws/full"),
		readBundleSummary: sweepAt("demos/proofs/aws/full", FULL_SWEEP),
		assertRequirements: { addons: 18 },
	});
	// "Exercises" now has TWO conditions, not one. A dimension is exercised by the full bar only if
	// `full` composes its switch at all (composedByFull) AND every repo-kind gate it declares is
	// wired. The first condition is new: byo-iac is declared out of the composite entirely, so no
	// gate state could make a full-bar PASS evidence for it.
	const composed = DIMENSIONS.filter((d) => d.composedByFull !== false);
	const derivedOnly = composed.filter((d) => d.gates.every((g) => g.kind !== "repo")).map((d) => d.id);
	const repoGated = composed.filter((d) => d.gates.some((g) => g.kind === "repo")).map((d) => d.id);
	const notComposed = DIMENSIONS.filter((d) => d.composedByFull === false).map((d) => d.id);
	ok("a `full` PASS proves every dimension it exercises", derivedOnly.every((id) => r.grid.aws[id].state === "proven"), JSON.stringify(derivedOnly.map((id) => [id, r.grid.aws[id].state])));
	ok(
		"...and proves NOTHING for a dimension full does not compose",
		notComposed.length > 0 && notComposed.every((id) => r.grid.aws[id].state !== "proven"),
		JSON.stringify(notComposed.map((id) => [id, r.grid.aws[id].state])),
	);
	ok("...and says it came via the composite", /composite/.test(r.grid.aws.maxconfig.why));
	// The regression this pins: `full` exports SOAK + MAX_CONFIG + ALL_ADDONS and nothing else, so a
	// repo-gated layer green-skips inside the run. Crediting it would manufacture a proof for a
	// scenario that never executed — and there is more than one such dimension, so assert the set.
	ok("a `full` PASS does NOT prove a repo-gated dimension whose gate is unset", repoGated.length > 0 && repoGated.every((id) => r.grid.aws[id].state === "never_run"), JSON.stringify(repoGated.map((id) => [id, r.grid.aws[id].state])));
	ok("...and the refusal is distinguishable from having no claim at all", repoGated.every((id) => /does NOT count for this dimension/.test(r.grid.aws[id].why)), r.grid.aws[repoGated[0]].why);

	// A direct claim beats the composite — the more specific statement wins.
	r = derive({ ...base, ledgerText: hdr + row("2026-08-01", "aws", "full", "PASS", "demos/proofs/aws/full") + row("2026-08-02", "aws", "addons", "FAIL", "demos/proofs/aws/y", "#1") });
	ok("a direct FAIL overrides a composite PASS", r.grid.aws.addons.state === "failing", r.grid.aws.addons.why);

	// INTEGRITY: rows nobody can render.
	r = derive({ ...base, ledgerText: hdr + row("2026-08-01", "vultr", "floor", "PASS", "demos/proofs/vultr/x") });
	ok("a ledger row naming an undeclared cloud is an integrity failure", r.failures.some((f) => /not one of the declared clouds/.test(f)), JSON.stringify(r.failures));
	r = derive({ ...base, ledgerText: hdr + row("2026-08-01", "aws", "vibes", "PASS", "demos/proofs/aws/x") });
	ok("a ledger row naming an unknown dimension is an integrity failure", r.failures.some((f) => /not one of/.test(f)), JSON.stringify(r.failures));
	r = derive({ ...base, ledgerText: hdr + "| 2026-08-01 | abc | aws | floor | **PROBABLY** | d | `b` | — |\n" });
	ok("an unknown verdict is an integrity failure, never a skip", r.failures.some((f) => /unknown verdict/.test(f)), JSON.stringify(r.failures));

	// INTEGRITY: file order IS the chronology, because collapseLedger replays in file order.
	// A cell whose rows descend in date promotes the OLDER run — the 2026-08-24 defect where a
	// hetzner/floor PASS was masked by the FAIL three hours before it and the grid read 0 proven.
	r = derive({
		...base,
		ledgerText: hdr + row("2026-08-24", "aws", "floor", "PASS", "demos/proofs/aws/x") + row("2026-08-01", "aws", "floor", "FAIL", "demos/proofs/aws/y", "#1"),
	});
	ok("a cell's rows going backwards in time is an integrity failure", r.failures.some((f) => /makes the OLDER run the surviving claim/.test(f)), JSON.stringify(r.failures));
	ok("...and it is caught even though the older row would otherwise win", r.grid.aws.floor.state === "failing", r.grid.aws.floor.why);

	// The same two rows the right way round are fine, and the newer one wins.
	r = derive({
		...base,
		ledgerText: hdr + row("2026-08-01", "aws", "floor", "FAIL", "demos/proofs/aws/y", "#1") + row("2026-08-24", "aws", "floor", "PASS", "demos/proofs/aws/x"),
	});
	ok("chronological rows raise no ordering failure", !r.failures.some((f) => /surviving claim/.test(f)), JSON.stringify(r.failures));
	ok("...and the newest row is the surviving claim", r.grid.aws.floor.state === "proven", r.grid.aws.floor.why);

	// Two runs of the same cell on ONE day is normal — a re-run — and must not trip it.
	r = derive({
		...base,
		ledgerText: hdr + row("2026-08-24", "aws", "floor", "FAIL", "demos/proofs/aws/y", "#1") + row("2026-08-24", "aws", "floor", "PASS", "demos/proofs/aws/x"),
	});
	ok("same-day re-runs are not an ordering failure", !r.failures.some((f) => /surviving claim/.test(f)), JSON.stringify(r.failures));

	// The Go mirror carries the two exclusions apart.
	r = derive({ ...base, ledgerText: hdr });
	ok("deferred debt is surfaced separately from ceilings", r.carriage.deferred === 1 && r.carriage.ceiling === 1, JSON.stringify(r.carriage));
	ok("...and the deferred cell names its chart", r.deferredCells[0]?.chart === "harbor", JSON.stringify(r.deferredCells));
	ok("cloud_manual CLI steps are surfaced as blockers", r.cliBlockers.some((b) => b.id === "dns-delegation"));
	ok("the 19-kind grid is read from unsupported-kinds.ts", (r.unsupported.hetzner ?? []).join(",") === "topic,nosql", JSON.stringify(r.unsupported));

	// VACUITY. An empty ledger must report every cell never-run, not zero cells.
	const empty = derive({ ...base, ledgerText: hdr });
	const cells = empty.clouds.length * DIMENSIONS.length;
	ok("vacuity: an empty ledger reports every cell never-run", empty.tally.never_run === cells && empty.tally.proven === 0, JSON.stringify(empty.tally));
	ok("vacuity: the grid is fully populated", empty.clouds.every((c) => DIMENSIONS.every((d) => empty.grid[c][d.id] !== undefined)));
	ok("vacuity: rendering an all-never-run grid still produces the tables", (() => {
		const out = render(empty);
		return out.includes("Proof grid") && out.includes("The mechanical next") && out.includes("Provenance");
	})());

	// The mechanical next ranks failing above never-run.
	r = derive({ ...base, ledgerText: hdr + row("2026-08-01", "hetzner", "day2", "FAIL", "demos/proofs/hetzner/x", "#1") });
	ok("the mechanical next puts a failing cell first", r.next[0]?.state === "failing" && r.next[0]?.dimension === "day2", JSON.stringify(r.next[0]));

	// splice() refuses ambiguity rather than silently appending into the first region.
	ok("splice writes between the markers", splice(`intro\n${BEGIN}\nstale\n${END}\ntail`, "FRESH").includes("FRESH"));
	ok("splice drops the previous generated content", !splice(`intro\n${BEGIN}\nstale\n${END}\ntail`, "FRESH").includes("stale"));
	ok("splice preserves the intent half and the tail", (() => {
		const out = splice(`intro\n${BEGIN}\nstale\n${END}\ntail`, "FRESH");
		return out.startsWith("intro") && out.endsWith("tail");
	})());
	for (const [name, doc] of [
		["a missing marker", "no markers here"],
		["a duplicated BEGIN", `${BEGIN}\na\n${BEGIN}\nb\n${END}`],
		["a duplicated END", `${BEGIN}\na\n${END}\nb\n${END}`],
	]) {
		let threw = false;
		try {
			splice(doc, "X");
		} catch {
			threw = true;
		}
		ok(`splice refuses ${name}`, threw);
	}

	// The intent-half grep — the structural reason a hand board cannot re-emerge inside this file.
	ok("a verdict glyph above the marker is rejected", intentHalfViolations(`we are ✅ on aws\n${BEGIN}\n${END}`).length > 0);
	ok("a derived count above the marker is rejected", intentHalfViolations(`3 of 5 clouds proven\n${BEGIN}\n${END}`).length > 0);
	ok("a status claim above the marker is rejected", intentHalfViolations(`azure is green now\n${BEGIN}\n${END}`).length > 0);
	ok("ordinary intent prose is accepted", intentHalfViolations(`Order: floor, then all kinds, then the full bar. Next: #2356.\n${BEGIN}\n${END}`).length === 0);
	ok("a heading naming a glyph is not a false positive", intentHalfViolations(`# Anti-patterns: never type ✅\n${BEGIN}\n${END}`).length === 0);
	// A citation is not a claim: the anti-patterns section must be able to name the phrasing it
	// forbids. Both directions are asserted, because an over-broad strip would gut the rule.
	ok('a QUOTED example of forbidden phrasing is accepted', intentHalfViolations(`Never write "is green" here.\n${BEGIN}\n${END}`).length === 0);
	ok("a BACKTICKED glyph is accepted", intentHalfViolations(`Legend lives below: \`✅\`.\n${BEGIN}\n${END}`).length === 0);
	ok(
		"...but an UNQUOTED claim on the same line as a quoted one is still caught",
		intentHalfViolations(`Never write "is green"; but azure is proven today.\n${BEGIN}\n${END}`).length > 0,
	);

	// GATE DETECTION. The fidelity vars are exported by a `run:` step as
	// `echo "ALETHIA_E2E_MAX_CONFIG=1" >> "$GITHUB_ENV"`, not as a YAML `env:` key. Matching only
	// `NAME:` reported the two heaviest dimensions as unreachable while the workflow set them itself.
	// A false "no" sends somebody to wire a gate that is already wired, so both shapes are pinned.
	ok("a gate exported via $GITHUB_ENV counts as referenced", referencedGates('  run: echo "ALETHIA_E2E_MAX_CONFIG=1" >> "$GITHUB_ENV"').has("ALETHIA_E2E_MAX_CONFIG"));
	ok("a gate declared as a YAML env key counts as referenced", referencedGates("        ALETHIA_E2E_ALL_ADDONS: 1").has("ALETHIA_E2E_ALL_ADDONS"));
	ok("a gate read from vars/secrets counts as referenced", referencedGates("        FOO: ${{ secrets.E2E_GIT_TOKEN }}").has("E2E_GIT_TOKEN"));
	ok("a gate named only in a COMMENT does not count", !referencedGates("      # ALETHIA_E2E_NEVER_WIRED is a nice idea").has("ALETHIA_E2E_NEVER_WIRED"));
	ok("every declared gate name is a concrete name, never a wildcard", DIMENSIONS.every((d) => d.gates.every((g) => /^[A-Z0-9_]+$/.test(g.name))), JSON.stringify(DIMENSIONS.map((d) => d.gates)));

	// The cell arithmetic is rendered, so it must be counted rather than composed — this asserts the
	// grid total equals kinds × clouds, which is what a `0 cells` slip broke.
	{
		const r2 = derive({ ...base, ledgerText: hdr });
		const total = Object.values(r2.carriage).reduce((a, b) => a + b, 0);
		ok("carriage cells total kinds × clouds", total === r2.kindCount * r2.clouds.length, `${total} != ${r2.kindCount} × ${r2.clouds.length}`);
		ok("...and the rendered text says so rather than 0", render(r2).includes(`× ${r2.clouds.length} clouds = ${total} cells`), render(r2).split("\n").find((l) => l.includes("cells):")));
	}

	// ── the LIVE BOARD half ──
	const snap = (open = [], closed = [], variables = [], secrets = [], gate_observations = [], orphan_reaper_observations = []) => {
		const derived_at = new Date(Date.now() - 3600_000).toISOString();
		return {
			gate_observations,
			orphan_reaper_observations,
			derived_at,
			// A FIXTURE HAS TO MODEL A REAL SNAPSHOT. `programme-fetch.sh` stamps both of these on
			// every write, and both are now READ: an absent `inventory_observed_at` means "no record
			// of when the gate inventory was read", which degrades every declared gate to `unknown`,
			// and `previous_derived_at` bounds the window a closed red may count inside.
			inventory_observed_at: derived_at,
			previous_derived_at: new Date(Date.now() - 25 * 3600_000).toISOString(),
			open_issues_truncated: false,
			closed_issues_truncated: false,
			open_issues: open.map((n) => ({ number: n, title: `t${n}`, labels: [] })),
			closed_issues: closed.map((n) => ({ number: n, title: `t${n}`, labels: [] })),
			variables,
			secrets,
		};
	};
	const failRow = row("2026-08-01", "aws", "floor", "FAIL", "demos/proofs/aws/x", "#1040");

	// THE HEADLINE. A FAIL citing a CLOSED issue is not open work — its cause is fixed and it needs a
	// re-run. This is the shape of the defect that had the parity board sending readers to four closed
	// issues, and here the tree cannot lie about it because the state is looked up.
	r = derive({ ...base, ledgerText: hdr + failRow, snapshot: snap([], [1040]) });
	ok("a FAIL citing a CLOSED issue becomes `stale`, not `failing`", r.grid.aws.floor.state === "stale", r.grid.aws.floor.state);
	ok("...and the tally counts it as stale, not failing", r.tally.stale === 1 && r.tally.failing === 0, JSON.stringify(r.tally));
	ok("...and it ranks FIRST in the mechanical next (a re-run is the cheapest action)", r.next[0]?.state === "stale", JSON.stringify(r.next[0]));
	ok("...and the reason says the cause is fixed", /CLOSED/.test(r.grid.aws.floor.why) && /fresh run/.test(r.grid.aws.floor.why), r.grid.aws.floor.why);

	// The same row with the issue still OPEN stays `failing` — the reclassification must not swallow
	// real open work.
	r = derive({ ...base, ledgerText: hdr + failRow, snapshot: snap([1040], []) });
	ok("a FAIL citing an OPEN issue stays `failing`", r.grid.aws.floor.state === "failing", r.grid.aws.floor.state);

	// UNKNOWN NEVER COLLAPSES. With no snapshot, an issue's state is unknowable, so the cell must not
	// be reclassified in either direction.
	r = derive({ ...base, ledgerText: hdr + failRow, snapshot: null });
	ok("with NO snapshot a FAIL stays `failing` — unknown never becomes stale", r.grid.aws.floor.state === "failing", r.grid.aws.floor.state);
	ok("...and the board reports itself absent", r.board.present === false);
	ok("...and every gate reads unknown rather than unwired", r.cloudGates.every((g) => g.effective === "unknown"), JSON.stringify(r.cloudGates));

	// An issue beyond the fetch limit is `unknown`, NOT `open` — guessing open would hide a stale cite.
	r = derive({ ...base, ledgerText: hdr + failRow, snapshot: snap([9999], [8888]) });
	ok("an issue in neither list is unknown, never assumed open", r.reds[0]?.issueState === "unknown", JSON.stringify(r.reds[0]));

	// CONTESTED. A nightly red files an issue and writes NO ledger row, so the ledger cannot see it
	// and a cell proven earlier stays ✅ forever — a high-water mark presented as current state.
	{
		const passRow = row("2026-08-01", "aws", "floor", "PASS", "demos/proofs/aws/x");
		/** A snapshot carrying one titled nightly-red issue. */
		const redSnap = (title, createdAt, number = 7001) => ({
			...snap(),
			open_issues: [{ number, title, labels: [], createdAt }],
		});

		r = derive({ ...base, ledgerText: hdr + passRow, snapshot: redSnap("e2e nightly: aws RED (floor)", "2026-08-02T00:00:00Z") });
		ok("a PROVEN cell with an open red filed AFTER it becomes `contested`", r.grid.aws.floor.state === "contested", r.grid.aws.floor.state);
		ok("...and the tally stops counting it as proven", r.tally.proven === 0 && r.tally.contested === 1, JSON.stringify(r.tally));
		ok("...and it names the issue and both dates", /#7001/.test(r.grid.aws.floor.why) && /2026-08-02/.test(r.grid.aws.floor.why) && /2026-08-01/.test(r.grid.aws.floor.why), r.grid.aws.floor.why);
		ok("...and it is NOT an integrity failure (this gate reds every PR in the repo)", r.failures.length === 0, JSON.stringify(r.failures));
		ok("...and it ranks in the mechanical next", r.next.some((n) => n.state === "contested"), JSON.stringify(r.next.slice(0, 2)));
		ok("...and it renders a section naming the two acts that clear it", /Contested/.test(render(r)) && /close the issue/.test(render(r)));

		// A red filed BEFORE the proving run is the ordinary case: the run that proved it came after,
		// so there is no contradiction. Getting this backwards would flag every proven cell that ever
		// had a red, which is most of them.
		r = derive({ ...base, ledgerText: hdr + passRow, snapshot: redSnap("e2e nightly: aws RED (floor)", "2026-07-01T00:00:00Z") });
		ok("a red filed BEFORE the proving run does not contest it", r.grid.aws.floor.state === "proven", r.grid.aws.floor.state);

		// Same day is not a contradiction either — dates here are day-granular, and a cell can
		// legitimately be re-driven green on the day it failed.
		r = derive({ ...base, ledgerText: hdr + passRow, snapshot: redSnap("e2e nightly: aws RED (floor)", "2026-08-01T23:00:00Z") });
		ok("a same-day red does not contest (dates are day-granular)", r.grid.aws.floor.state === "proven", r.grid.aws.floor.state);

		// A CLOSED red cannot contest anything — closing it is one of the two acts that clears this.
		r = derive({
			...base,
			ledgerText: hdr + passRow,
			snapshot: { ...snap(), closed_issues: [{ number: 7001, title: "e2e nightly: aws RED (floor)", labels: [], createdAt: "2026-08-02T00:00:00Z" }] },
		});
		ok("a CLOSED red does not contest — closing it is how you clear this", r.grid.aws.floor.state === "proven", r.grid.aws.floor.state);

		// The DIMENSION has to match. A red against a different cell must not contest this one.
		r = derive({ ...base, ledgerText: hdr + passRow, snapshot: redSnap("e2e nightly: aws RED (day2)", "2026-08-02T00:00:00Z") });
		ok("a red against a DIFFERENT dimension does not contest this cell", r.grid.aws.floor.state === "proven", r.grid.aws.floor.state);

		// `matrix` is a pseudo-cloud: those issues say "no per-leg proof" and are about the matrix job
		// itself. Treating it as a cloud would contest nothing that exists, or worse, throw.
		r = derive({ ...base, ledgerText: hdr + passRow, snapshot: redSnap("e2e nightly: matrix RED (floor · no per-leg proof)", "2026-08-02T00:00:00Z") });
		ok("a `matrix` red is not a cloud and contests nothing", r.grid.aws.floor.state === "proven", r.grid.aws.floor.state);

		// With NO snapshot there is nothing to contradict the ledger WITH. Absence of evidence must
		// not render as evidence of absence.
		r = derive({ ...base, ledgerText: hdr + passRow, snapshot: null });
		ok("with NO snapshot a proven cell is never contested", r.grid.aws.floor.state === "proven", r.grid.aws.floor.state);

		// And a red against a FAILING cell changes nothing — that cell already says so.
		r = derive({ ...base, ledgerText: hdr + failRow, snapshot: redSnap("e2e nightly: aws RED (floor)", "2026-08-02T00:00:00Z") });
		ok("a red against an already-failing cell leaves it failing", r.grid.aws.floor.state === "failing", r.grid.aws.floor.state);
	}

	// ── #3652: A RED THAT CLOSES INSIDE THE DERIVATION WINDOW IS INVISIBLE ────────────────────────
	//
	// The blind spot between the two checks above. `contested` reads OPEN issues; `staleCitations`
	// reads a CLOSED issue a cell CITES — and a nightly red writes no ledger row, so no cell cites
	// it. A red filed and closed between two refreshes therefore entered NEITHER, and PROGRAMME.md
	// published `0 failing` and `gcp/floor ✅` on a morning that leg failed.
	//
	// The fixture is the worked case from the issue, to the minute: #3580 filed 2026-09-01T09:46Z,
	// closed 11:25Z, snapshot derived 11:32Z — seven minutes later.
	{
		const passRow = row("2026-08-01", "aws", "floor", "PASS", "demos/proofs/aws/x");
		/** A snapshot whose window opened at the previous nightly and closed at 11:32Z. */
		const winSnap = (closed_issues) => ({
			...snap(),
			derived_at: "2026-09-01T11:32:00Z",
			previous_derived_at: "2026-08-31T08:47:00Z",
			inventory_observed_at: "2026-09-01T11:32:00Z",
			closed_issues,
		});
		const red3580 = (overrides = {}) => ({
			number: 3580,
			title: "e2e nightly: aws RED (floor)",
			labels: [],
			createdAt: "2026-09-01T09:46:00Z",
			closedAt: "2026-09-01T11:25:00Z",
			...overrides,
		});

		r = derive({ ...base, ledgerText: hdr + passRow, snapshot: winSnap([red3580()]) });
		ok("a red filed AND closed inside the derivation window still contests its cell", r.grid.aws.floor.state === "contested", r.grid.aws.floor.state);
		ok("...and the tally stops counting it as proven", r.tally.proven === 0 && r.tally.contested === 1, JSON.stringify(r.tally));
		ok("...and it names the issue, the filing date and the closing date", /#3580/.test(r.grid.aws.floor.why) && /2026-09-01/.test(r.grid.aws.floor.why) && /2026-08-01/.test(r.grid.aws.floor.why), r.grid.aws.floor.why);
		ok("...and it is NOT an integrity failure (this gate reds every PR in the repo)", r.failures.length === 0, JSON.stringify(r.failures));
		{
			const out = render(r);
			// THE HEADLINE NUMBER. `0 failing` was true and useless: the cell left `proven` and no
			// count named where it went, so the summary read the same as a clean morning.
			ok("...and the summary NAMES the contested count rather than only lowering the numerator", /1 contested/.test(out), out.split("\n").find((l) => /proof cells are proven/.test(l)));
			// A reader sent to an OPEN issue that is closed learns the mechanism is lying to them.
			ok("...and the contested table says the red is already closed", /closed 2026-09-01, inside this refresh window/.test(out), out.split("\n").find((l) => /#3580/.test(l)));
		}

		// A red closed BEFORE the window opened has already been through the file's documented
		// clearing act. Reviving it forever would contest every cell that ever went red.
		r = derive({ ...base, ledgerText: hdr + passRow, snapshot: winSnap([red3580({ closedAt: "2026-08-30T00:00:00Z" })]) });
		ok("a red closed BEFORE the window opened does not contest — closing it is the documented clearing act", r.grid.aws.floor.state === "proven", r.grid.aws.floor.state);

		// UNKNOWN NEVER COLLAPSES. A snapshot written before the fetch captured `closedAt` must not
		// have every closed red read as "closed just now".
		r = derive({ ...base, ledgerText: hdr + passRow, snapshot: winSnap([red3580({ closedAt: undefined })]) });
		ok("a closed red with no closedAt is unknown, never in-window", r.grid.aws.floor.state === "proven", r.grid.aws.floor.state);

		// The ordering rule is the same one the open half uses: a red that predates the proof was
		// answered by it. Getting this backwards would contest most of the grid.
		r = derive({ ...base, ledgerText: hdr + passRow, snapshot: winSnap([red3580({ createdAt: "2026-07-01T00:00:00Z" })]) });
		ok("a window-closed red filed BEFORE the run that proved the cell does not contest it", r.grid.aws.floor.state === "proven", r.grid.aws.floor.state);
		ok("...and says so, rather than vanishing", r.notes.some((n) => /#3580/.test(n) && /proven 2026-08-01, on or after the red/.test(n)), JSON.stringify(r.notes.filter((n) => /3580/.test(n))));

		// The same vocabulary rules as the open half, through the SAME parser.
		r = derive({ ...base, ledgerText: hdr + passRow, snapshot: winSnap([red3580({ title: "e2e nightly: matrix RED (floor · no per-leg proof)" })]) });
		ok("a window-closed `matrix` red is not a cloud and contests nothing", r.grid.aws.floor.state === "proven", r.grid.aws.floor.state);
		r = derive({ ...base, ledgerText: hdr + passRow, snapshot: winSnap([red3580({ title: "e2e nightly: aws RED (day2)" })]) });
		ok("a window-closed red against a DIFFERENT dimension does not contest this cell", r.grid.aws.floor.state === "proven", r.grid.aws.floor.state);

		// LEAVING NO TRACE IS THE DEFECT. A window-closed red that contests nothing still happened,
		// and must be reported rather than silently dropped.
		r = derive({ ...base, ledgerText: hdr + failRow, snapshot: winSnap([red3580()]) });
		ok("a window-closed red against an already-failing cell leaves it failing", r.grid.aws.floor.state === "failing", r.grid.aws.floor.state);
		ok("...but is still REPORTED — 'leaves no trace' is the defect", r.notes.some((n) => /#3580/.test(n) && /INSIDE this derivation window/.test(n)), JSON.stringify(r.notes.filter((n) => /3580/.test(n))));

		// A bar-wide red contests no single cell, exactly as the open half refuses to — a bar does
		// not necessarily reach every dimension. It is reported instead.
		r = derive({ ...base, ledgerText: hdr + passRow, snapshot: winSnap([red3580({ title: "e2e nightly: aws RED (full-bar)" })]) });
		ok("a window-closed bar-wide red contests no single cell", r.grid.aws.floor.state === "proven", r.grid.aws.floor.state);
		ok("...and is reported instead", r.notes.some((n) => /#3580/.test(n) && /bar-wide/.test(n)), JSON.stringify(r.notes.filter((n) => /3580/.test(n))));

		// A label this file cannot resolve is reported, never dropped — same lever as the open half.
		r = derive({ ...base, ledgerText: hdr + passRow, snapshot: winSnap([red3580({ title: "e2e nightly: aws RED (teleportation)" })]) });
		ok("a window-closed red whose dimension resolves to no column is reported", r.notes.some((n) => /#3580/.test(n) && /resolves to no grid column/.test(n)), JSON.stringify(r.notes.filter((n) => /3580/.test(n))));

		// THE WINDOW WITHOUT ITS BOUNDARY. A snapshot written before `previous_derived_at` existed
		// still has to have a window, or the fix does nothing until the second refresh after it
		// lands. One nightly cadence is what it would have had.
		const noPrev = (closedAt) => {
			const s = { ...snap(), closed_issues: [red3580({ closedAt })] };
			delete s.previous_derived_at;
			return s;
		};
		r = derive({ ...base, ledgerText: hdr + passRow, snapshot: noPrev(new Date(Date.now() - 2 * 3600_000).toISOString()) });
		ok("with no previous_derived_at the window falls back to one nightly cadence", r.grid.aws.floor.state === "contested", r.grid.aws.floor.state);
		r = derive({ ...base, ledgerText: hdr + passRow, snapshot: noPrev(new Date(Date.now() - 30 * 3600_000).toISOString()) });
		ok("...and a red closed before that fallback window is outside it", r.grid.aws.floor.state === "proven", r.grid.aws.floor.state);

		// And with NO timestamps at all there is no window, so nothing is claimed in either direction.
		const noClock = { ...snap(), closed_issues: [red3580()] };
		delete noClock.previous_derived_at;
		delete noClock.derived_at;
		r = derive({ ...base, ledgerText: hdr + passRow, snapshot: noClock });
		ok("with no timestamps there is no window and nothing is claimed", r.grid.aws.floor.state === "proven", r.grid.aws.floor.state);
	}

	// ── #3652: A TRUNCATED ISSUE LIST MUST BE REPORTED AS TRUNCATED ───────────────────────────────
	//
	// `gh issue list --limit 500` returned exactly 500 closed issues for weeks. Every signal the
	// mechanism produced — the array length, the trailing printf — read identically to a repo that
	// has exactly 500, while 228 were dropped nightly. The consequence is load-bearing:
	// `issueState` answers `unknown` for a dropped issue and `staleCitations` fires only on
	// `closed`, so a red cell citing one stays `failing` forever.
	//
	// The OBSERVABLE is asserted, not the pagination: a capped fetch is REPORTED as capped.
	{
		const truncated = { ...snap([], []), closed_issues_truncated: true };
		r = derive({ ...base, ledgerText: hdr + failRow, snapshot: truncated });
		ok("a truncated closed list is visible to the derivation", r.board.issueListComplete === false, JSON.stringify(r.board.issueListComplete));
		ok("...and is reported, naming the consequence for a cell that cites a dropped issue", r.notes.some((n) => /TRUNCATED/.test(n) && /stale/.test(n)), JSON.stringify(r.notes));
		ok("...and the cell whose citation could not be resolved is named", r.notes.some((n) => /aws\/floor/.test(n) && /#1040/.test(n) && /TRUNCATED/.test(n)), JSON.stringify(r.notes));
		{
			const out = render(r);
			// A bare `?` reads as "checked, and it is neither open nor closed". While the list is
			// truncated it means "we never looked", and those must not render the same.
			ok("...and the rendered table says the `?` is unresolvable rather than checked", /unresolvable \(list truncated\)/.test(out), out.split("\n").find((l) => /aws\/floor/.test(l) && /#1040/.test(l)));
			ok("...and the section says how to fix it", /issue list in the snapshot is TRUNCATED/.test(out) && /programme-fetch\.sh/.test(out));
		}
		// AN UNTRUNCATED FETCH MUST NOT SAY THIS. A warning that is always on is not a warning.
		r = derive({ ...base, ledgerText: hdr + failRow, snapshot: snap([], []) });
		ok("an untruncated fetch reports no truncation", r.board.issueListComplete === true && !r.notes.some((n) => /TRUNCATED/.test(n)), JSON.stringify(r.notes));
		ok("...and renders a bare `?`, not the unresolvable form", !/unresolvable/.test(render(r)));
		// The OPEN query has the same defect class and the same flag; it is not closed-only.
		r = derive({ ...base, ledgerText: hdr + failRow, snapshot: { ...snap([], []), open_issues_truncated: true } });
		ok("a truncated OPEN list is reported too", r.board.issueListComplete === false && r.notes.some((n) => /TRUNCATED/.test(n)), JSON.stringify(r.notes));

		// A MISSING FLAG IS `null`, NEVER `true`. The snapshot in the tree when this landed was capped
		// at 500 and says nothing about it, so reading absence as completeness renders the
		// actually-truncated snapshot clean — the defect, one level up.
		const unasked = { ...snap([], []) };
		delete unasked.open_issues_truncated;
		delete unasked.closed_issues_truncated;
		r = derive({ ...base, ledgerText: hdr + failRow, snapshot: unasked });
		ok("a snapshot that never asked about truncation is unknown, never complete", r.board.issueListComplete === null, JSON.stringify(r.board.issueListComplete));
		ok("...and says so rather than rendering clean", r.notes.some((n) => /predates the truncation check/.test(n)), JSON.stringify(r.notes));
		ok("...and its unresolvable citation is marked as such", /unresolvable \(completeness unknown\)/.test(render(r)), render(r).split("\n").find((l) => /#1040/.test(l)));
	}

	// ── #3652: `inventory_observed_at` WAS WRITTEN AND READ BY NOTHING ────────────────────────────
	//
	// The nightly token cannot list repo variables or secrets — no workflow permission scope for it
	// exists — so every refresh carries the previous inventory forward and stamps when it was
	// actually observed. The only staleness rule aged `derived_at`, which the same run re-stamps, so
	// the bound could never bind: `derived_at` reached 2026-09-01 against a reading taken
	// 2026-08-27, and deleting a gate variable would have left its row rendering `✅ wired` forever.
	//
	// The bound is measured between two PERSISTED timestamps, so it cannot put a clock in the
	// diff-gated region.
	{
		const GATE = "E2E_AWS_ROLE_ARN";
		const invSnap = (observed, extra = {}) => {
			const s = { ...snap([], [], [GATE]), derived_at: "2026-09-01T00:00:00Z", inventory_observed_at: observed, ...extra };
			if (observed === undefined) delete s.inventory_observed_at;
			return s;
		};
		const awsGate = (view) => view.cloudGates.find((g) => g.cloud === "aws");

		r = derive({ ...base, ledgerText: hdr, snapshot: invSnap("2026-08-31T00:00:00Z") });
		ok("a freshly observed inventory reads wired", awsGate(r)?.effective === "wired", JSON.stringify(awsGate(r)));

		// BOTH SIDES OF THE BOUNDARY, one second apart. A rule tested only well inside its range
		// proves the direction and not the threshold.
		r = derive({ ...base, ledgerText: hdr, snapshot: invSnap("2026-08-25T00:00:00Z") });
		ok(`an inventory exactly ${INVENTORY_FRESH_HOURS / 24} days old is still fresh`, awsGate(r)?.effective === "wired", JSON.stringify(awsGate(r)));
		r = derive({ ...base, ledgerText: hdr, snapshot: invSnap("2026-08-24T23:59:59Z") });
		ok("one second past the bound, every DECLARED gate degrades to unknown", awsGate(r)?.effective === "unknown", JSON.stringify(awsGate(r)));
		ok("...and it is REPORTED, naming when the inventory was actually observed", r.notes.some((n) => /2026-08-24T23:59:59Z/.test(n) && /DECLARED gate/.test(n)), JSON.stringify(r.notes));
		ok("...and the rendered gate section says why, rather than an unexplained `?`", /The gate inventory is stale/.test(render(r)) && /2026-08-24T23:59:59Z/.test(render(r)));
		// The dimension table reads the SAME `gateState`, so it is not asserted twice here — in this
		// fixture the workflow text mentions no repo gate, so every row is `no_vehicle` and the
		// assertion would pass without measuring the rule. `referencedGates` is what it would be
		// testing, which has its own block above.

		// AN INVENTORY WITH NO OBSERVATION TIME IS `unknown`, NOT FRESH. Reading absence as freshness
		// would restore the defect for every snapshot an older fetch wrote.
		r = derive({ ...base, ledgerText: hdr, snapshot: invSnap(undefined) });
		ok("an inventory with no observation time is unknown, never fresh", awsGate(r)?.effective === "unknown", JSON.stringify(awsGate(r)));

		// AN OBSERVATION IS A MEASUREMENT OF TODAY AND STILL WINS. The declaration going unknown must
		// not erase a leg that demonstrably got past its gate — that would be the fix overshooting
		// into the false-red this file's other half exists to prevent.
		const observedRun = [{ provider: "aws", gate_off: "skipped", earlier_failure: false, run: "999", at: "2026-08-31T09:00:00Z" }];
		r = derive({ ...base, ledgerText: hdr, snapshot: invSnap("2026-08-24T23:59:59Z", { gate_observations: observedRun }) });
		ok("a stale inventory does not erase an OBSERVED gate", awsGate(r)?.effective === "wired", JSON.stringify(awsGate(r)));
		ok("...while the declaration it replaced still reads unknown, so the two are never confused", awsGate(r)?.state === "unknown", JSON.stringify(awsGate(r)));

		// The provenance has to print BOTH timestamps. Printing only `derived_at` is what let a
		// five-day-old inventory look freshly measured.
		const fresh = render(derive({ ...base, ledgerText: hdr, snapshot: invSnap("2026-08-31T00:00:00Z") }));
		ok("the provenance prints when the inventory was observed, not just derived_at", /Gate inventory observed: \*\*2026-08-31T00:00:00Z\*\*/.test(fresh), fresh.split("\n").find((l) => /Gate inventory/.test(l)));
		ok("...verbatim, never as an age", !/\b(hours? old|days old|ago)\b/.test(fresh), fresh.split("\n").find((l) => /Gate inventory/.test(l)));
	}

	// Composite crediting, the OTHER half: once a repo-gated dimension's gates are wired, its layer
	// really does run inside a full bar, so the composite must credit it again. Without this the
	// refusal above could be a permanent "no" — a guard that never says yes is not measuring anything.
	{
		const fullRow = row("2026-08-01", "aws", "full", "PASS", "demos/proofs/aws/full");
		const gitopsGates = DIMENSIONS.find((d) => d.id === "gitops").gates.filter((g) => g.kind === "repo").map((g) => g.name);
		// Every repo gate the `gitops` dimension declares, wired — named from DIMENSIONS rather than
		// retyped, so renaming a gate cannot leave this test passing against a name nothing reads.
		const wired = derive({ ...base, ledgerText: hdr + fullRow, snapshot: snap([], [], gitopsGates, []) });
		ok("with its repo gates wired, the composite DOES credit the dimension", wired.grid.aws.gitops.state === "proven", wired.grid.aws.gitops.why);
		// And it must be ALL of them, not any: a half-wired gate set still green-skips.
		const half = derive({ ...base, ledgerText: hdr + fullRow, snapshot: snap([], [], gitopsGates.slice(0, 1), []) });
		ok("a half-wired gate set does not credit the composite", gitopsGates.length > 1 && half.grid.aws.gitops.state === "never_run", half.grid.aws.gitops.why);
	}

	// Cloud gates: wired vs unwired, from NAMES only.
	r = derive({ ...base, ledgerText: hdr, snapshot: snap([], [], ["E2E_AWS_ROLE_ARN"], []) });
	ok("a cloud gate present in the snapshot reads wired", r.cloudGates.find((g) => g.cloud === "aws")?.state === "wired");
	ok("a cloud gate absent from the snapshot reads unwired", r.cloudGates.find((g) => g.cloud === "hetzner")?.state === "unwired");

	// An EMPTY gate inventory is a FAILED FETCH, not an empty repo. The real snapshot shipped
	// `variables: [], secrets: []` beside 42 correctly-fetched issues, because programme.yml's token
	// cannot list either — and every gate rendered `⛔ unwired`, including ones a green run had
	// proven wired. Collapsing that to `unwired` also disarms deriveCell's compositeCredits, which
	// refuses to credit a dimension whose repo gate reads unwired: a full-bar PASS would silently
	// not credit `byo`/`day2`. So empty must read `unknown`, exactly like an absent snapshot.
	{
		const empty = derive({ ...base, ledgerText: hdr, snapshot: snap([], [], [], []) });
		ok("an EMPTY gate inventory reads unknown, never unwired", empty.cloudGates.every((g) => g.state === "unknown"), JSON.stringify(empty.cloudGates.map((g) => [g.cloud, g.state])));
		// ...and it must not be vacuous: with ONE name present the inventory is trusted again, so
		// this cannot degrade into "every gate is always unknown".
		const oneName = derive({ ...base, ledgerText: hdr, snapshot: snap([], [], ["E2E_AWS_ROLE_ARN"], []) });
		ok("...but one known name makes the inventory trusted again", oneName.cloudGates.find((g) => g.cloud === "aws")?.state === "wired" && oneName.cloudGates.find((g) => g.cloud === "hetzner")?.state === "unwired");
		// The composite must not credit a repo-gated dimension on an unknown gate either — unknown
		// is not `wired`, and fail-closed is the whole point.
		const fullRow = row("2026-08-01", "aws", "full", "PASS", "demos/proofs/aws/full");
		const credited = derive({ ...base, ledgerText: hdr + fullRow, snapshot: snap([], [], [], []) });
		ok("an unknown gate does not let the composite credit a repo-gated dimension", credited.grid.aws.gitops.state === "never_run", credited.grid.aws.gitops.why);
	}

	// Dimension gates: a DERIVED gate is never "unwired" — there is no variable to set. Reporting one
	// as unwired sends somebody hunting for a repo variable that cannot exist.
	r = derive({ ...base, ledgerText: hdr, snapshot: snap() });
	const maxc = r.gateReality.find((d) => d.id === "maxconfig");
	ok("a dimension-derived gate reads `derived`, never `unwired`", maxc?.states[0]?.state === "derived", JSON.stringify(maxc?.states));
	// The emitter moved (#2356): the fidelity table lives in the resolver, not the workflow's inline
	// `env:`. A detector reading only the workflow reported these two as `no_vehicle` — i.e. "nothing
	// can turn this on" — about gates a dispatch turns on every time. Pin BOTH halves: a gate only the
	// resolver emits is still `derived`, and a gate NEITHER file mentions is still `no_vehicle`.
	const addons = r.gateReality.find((d) => d.id === "addons");
	ok("a gate emitted only by the resolver reads `derived`, not `no_vehicle`", addons?.states[0]?.state === "derived", JSON.stringify(addons?.states));
	const rNoResolver = derive({ ...base, resolverText: "", ledgerText: hdr, snapshot: snap() });
	ok(
		"drop the resolver and the same gate falls back to `no_vehicle` — the detector reads it, not luck",
		rNoResolver.gateReality.find((d) => d.id === "addons")?.states[0]?.state === "no_vehicle",
		JSON.stringify(rNoResolver.gateReality.find((d) => d.id === "addons")?.states),
	);
	// `unwired` requires the workflow to REFERENCE the gate; a gate it never mentions is `no_vehicle`,
	// which is a different remedy (write the wiring, not set a variable). Both are pinned.
	const gitopsNoVehicle = r.gateReality.find((d) => d.id === "gitops");
	ok("a gate the workflow never references reads `no_vehicle`, not `unwired`", gitopsNoVehicle?.states.every((x) => x.state === "no_vehicle"), JSON.stringify(gitopsNoVehicle?.states));
	const rWired = derive({
		...base,
		workflowText: base.workflowText + "        FOO: ${{ vars.E2E_ARGO_APPS_REPO }}\n        BAR: ${{ secrets.E2E_GIT_TOKEN }}\n",
		ledgerText: hdr,
		snapshot: snap([], [], ["E2E_ARGO_APPS_REPO"], []),
	});
	const gitopsMixed = rWired.gateReality.find((d) => d.id === "gitops");
	ok(
		"a REFERENCED maintainer-set gate reads wired/unwired from the snapshot",
		gitopsMixed?.states.find((x) => x.name === "E2E_ARGO_APPS_REPO")?.state === "wired" &&
			gitopsMixed?.states.find((x) => x.name === "E2E_GIT_TOKEN")?.state === "unwired",
		JSON.stringify(gitopsMixed?.states),
	);

	// ── THE TWO-FILE INVARIANT. `composedByFull: false` above is a copy of FULL_EXCLUDES in
	//    scripts/e2e/resolve-dimension.sh, and a hand-kept copy is how two sources of truth drift.
	//    So read the shell file and hold them to each other. This is the check that would have caught
	//    the original defect: `byo` turned on ALETHIA_E2E_ARGO_REPOS_REQUIRE, `full` never emitted it,
	//    and this rollup credited `full` for the `byo` column anyway. ──
	{
		const resolver = fs.readFileSync(new URL("./e2e/resolve-dimension.sh", import.meta.url), "utf8");
		const declared = new Set((/^FULL_EXCLUDES="([^"]*)"/m.exec(resolver)?.[1] ?? "").split(/\s+/).filter(Boolean));
		const inJs = new Set(DIMENSIONS.filter((d) => d.composedByFull === false).map((d) => d.id));
		ok(
			"FULL_EXCLUDES is non-empty in the resolver, so this check is not vacuous",
			declared.size > 0,
			"no FULL_EXCLUDES line matched — the regex or the shell declaration changed shape",
		);
		ok(
			"every dimension the resolver excludes from `full` is composedByFull:false here",
			[...declared].every((d) => inJs.has(d)),
			`resolver excludes ${JSON.stringify([...declared])}, this file marks ${JSON.stringify([...inJs])}`,
		);
		ok(
			"...and nothing here claims to be excluded that the resolver still composes",
			[...inJs].every((d) => declared.has(d)),
			`this file marks ${JSON.stringify([...inJs])}, resolver excludes ${JSON.stringify([...declared])}`,
		);
		// The dimension ids themselves must exist on both sides, or one file is describing a
		// programme the other has never heard of.
		const resolverDims = new Set((/^DIMENSIONS="([^"]*)"/m.exec(resolver)?.[1] ?? "").split(/\s+/).filter(Boolean));
		ok(
			"every rollup column is a dimension the resolver can actually run",
			DIMENSIONS.every((d) => resolverDims.has(d.id)),
			`columns ${JSON.stringify(DIMENSIONS.map((d) => d.id))} vs resolver ${JSON.stringify([...resolverDims])}`,
		);
	}

	// ── THE SECOND TWO-FILE INVARIANT: the RED-ISSUE vocabulary. ──
	//
	// `dimension_label()` in the same resolver decides the words that go in a nightly issue TITLE,
	// and `redDimensions` above has to resolve every one of them. They drifted by exactly one:
	// `full` labels as `full-bar`, which is not a grid column, so `grid[cloud]?.["full-bar"]` was
	// `undefined` and the contested check `continue`d — five open bar-wide REDs were invisible in
	// BOTH directions, and the "nothing found" branch was indistinguishable from "nothing wrong".
	//
	// A LITERAL list would drift the same way. So read the shell `case` and hold it to this file.
	{
		const resolver = fs.readFileSync(new URL("./e2e/resolve-dimension.sh", import.meta.url), "utf8");
		const body = /dimension_label\(\)\s*\{([\s\S]*?)\n\}/.exec(resolver)?.[1] ?? "";
		// Every quoted word the case arms can echo, plus the bare `$1` passthrough arm's own patterns.
		const emitted = new Set();
		for (const m of body.matchAll(/^\s*([a-z0-9|\- \t]+?)\)\s*echo\s+"([^"]*)"/gm)) {
			const [, patterns, out] = m;
			if (out === "$1") for (const t of patterns.split("|").map((x) => x.trim()).filter(Boolean)) emitted.add(t);
			else if (out) emitted.add(out);
		}
		ok(
			"dimension_label's vocabulary was actually parsed out of the resolver",
			emitted.size >= 6,
			`parsed ${JSON.stringify([...emitted])} from dimension_label() — the regex or the shell case changed shape`,
		);
		ok(
			"`full-bar` is among the labels, so this check covers the composite that broke",
			emitted.has(COMPOSITE_RED_DIMENSION),
			`parsed ${JSON.stringify([...emitted])}`,
		);
		const ids = DIMENSIONS.map((d) => d.id);
		const comp = DIMENSIONS.filter((d) => d.composedByFull !== false).map((d) => d.id);
		const unresolved = [...emitted].filter((label) => !redDimensions(label, ids, comp).known);
		ok(
			"every label a nightly issue title can carry resolves to at least one grid column",
			unresolved.length === 0,
			`these labels resolve to nothing, so a RED carrying one is silently dropped: ${JSON.stringify(unresolved)}`,
		);
		ok(
			"...and an unknown label is reported as unknown rather than as an empty match",
			redDimensions("no-such-dimension", ids, comp).known === false && redDimensions("floor", ids, comp).known === true,
			JSON.stringify(redDimensions("no-such-dimension", ids, comp)),
		);
		ok(
			"the composite expands to what the BAR runs, not to every column",
			redDimensions(COMPOSITE_RED_DIMENSION, ids, comp).dimensions.length === comp.length && comp.length < ids.length,
			`composite=${JSON.stringify(comp)} all=${JSON.stringify(ids)}`,
		);
	}

	// A renamed dimension's OLD ledger rows must still land on its column — the whole reason nothing
	// was retracted. Keyed under `byo`, read out as `gitops`.
	{
		const renamed = derive({
			...base,
			ledgerText: hdr + row("2026-08-25", "aws", "byo", "PASS", "demos/proofs/aws/legacy"),
			snapshot: snap([], [], ["E2E_ARGO_APPS_REPO", "E2E_GIT_TOKEN"], []),
		});
		ok(
			"a ledger row filed under the legacy `byo` token still proves the `gitops` column",
			renamed.grid.aws.gitops.state === "proven",
			`${renamed.grid.aws.gitops.state}: ${renamed.grid.aws.gitops.why}`,
		);
		ok(
			"...and does NOT leak into the new byo-iac column, which nothing has proven",
			renamed.grid.aws["byo-iac"].state !== "proven",
			`${renamed.grid.aws["byo-iac"].state}: ${renamed.grid.aws["byo-iac"].why}`,
		);
		ok(
			"...and the legacy token raises no 'unknown dimension' integrity failure",
			!renamed.failures.some((f) => /is not one of/.test(f)),
			JSON.stringify(renamed.failures),
		);
	}

	// A `full` PASS must NOT credit byo-iac, which `full` does not compose. This is the difference
	// between a composite that means something and one that launders unproven cells into `proven`.
	{
		const fullPass = derive({
			...base,
			ledgerText: hdr + row("2026-08-26", "aws", "full", "PASS", "demos/proofs/aws/full"),
			snapshot: snap([], [], ["E2E_ARGO_APPS_REPO", "E2E_GIT_TOKEN"], []),
		});
		ok(
			"a full-bar PASS credits maxconfig, which full DOES compose",
			fullPass.grid.aws.maxconfig.state === "proven",
			`${fullPass.grid.aws.maxconfig.state}: ${fullPass.grid.aws.maxconfig.why}`,
		);
		ok(
			"a full-bar PASS does NOT credit byo-iac, which full does NOT compose",
			fullPass.grid.aws["byo-iac"].state !== "proven",
			`${fullPass.grid.aws["byo-iac"].state}: ${fullPass.grid.aws["byo-iac"].why}`,
		);
	}

	// ── GATE REALITY, OBSERVED. The declaration and the observation come apart, and when they do the
	//    observation is the one worth acting on. ──
	{
		// The RAW facts the snapshot carries. `reached` is not among them — that is this file's
		// judgement, and gateReached below is what makes it.
		const obs = (provider, gate_off, earlier_failure = false) => ({
			provider,
			gate_off,
			earlier_failure,
			run: "999",
			at: "2026-08-26T09:00:00Z",
		});

		// ── THE UNSOUND READING, and why `skipped` alone is not enough. ──
		//
		// `Record gate-off proof` carries a bare `if:`, which implies success(). So `skipped` means
		// either "the gate was on and the leg proceeded" OR "an earlier step failed and we never got
		// here". Reading the second as reached prints a confident ✅ for a leg that never started —
		// a false green, which is worse than the `? unknown` this whole mechanism replaces.
		ok("a skipped gate-off step with no earlier failure reads as REACHED", gateReached(obs("aws", "skipped")) === true);
		ok("...but the SAME conclusion after an earlier failure does NOT", gateReached(obs("aws", "skipped", true)) === false);
		ok("a gate-off proof that actually RAN means the gate was off", gateReached(obs("aws", "success")) === false);
		// A failure AFTER the gate-off step is not disqualifying: that leg genuinely passed its gate
		// and broke on something else. gcp did exactly this on 2026-08-26 — it died at *Configure GCP
		// credentials*, twenty-odd steps past the gate at step 6.
		ok("a leg that failed LATER still reached its gate", gateReached(obs("gcp", "skipped", false)) === true);
		// Unreadable is not the same as off.
		ok("an observation with no conclusion is unreadable, not negative", gateReached(obs("aws", undefined)) === null);
		ok("a missing observation is unreadable, not negative", gateReached(null) === null);

		// A leg that got past its gate proves the gate WORKS, whatever the inventory says — and the
		// inventory here says nothing at all, which is the situation programme.yml is actually in.
		const observed = derive({
			...base,
			ledgerText: hdr,
			snapshot: snap([], [], [], [], [obs("aws", "skipped")]),
		});
		const awsGate = observed.cloudGates.find((g) => g.cloud === "aws");
		ok("an observed leg beats an unreadable inventory", awsGate?.effective === "wired", JSON.stringify(awsGate));
		ok("...and the DECLARED reading is kept alongside, not overwritten", awsGate?.state === "unknown", JSON.stringify(awsGate));
		ok("...and a cloud with no observation still falls back to the declaration",
			observed.cloudGates.find((g) => g.cloud === "hetzner")?.effective === "unknown",
			JSON.stringify(observed.cloudGates.find((g) => g.cloud === "hetzner")));

		// THE OTHER DIRECTION, and the one that matters more. A variable being present is not the
		// same as a gate working — gcp's WIF was declared the whole time it was rejecting every
		// dispatch. A leg that recorded a gate-off proof says the gate is off, and that must win over
		// a present variable rather than being outvoted by it.
		const contradicted = derive({
			...base,
			ledgerText: hdr,
			snapshot: snap([], [], ["E2E_AWS_ROLE_ARN"], [], [obs("aws", "success")]),
		});
		const contradictedGate = contradicted.cloudGates.find((g) => g.cloud === "aws");
		ok("an observed gate-off beats a PRESENT variable", contradictedGate?.effective === "unwired", JSON.stringify(contradictedGate));
		ok("...and the declaration still reads wired, so the disagreement is visible", contradictedGate?.state === "wired", JSON.stringify(contradictedGate));

		// THE CASE THAT WOULD HAVE BEEN A FALSE GREEN. A leg that failed before ever reaching its
		// gate must NOT be credited, even though its gate-off step reads `skipped` like a healthy one.
		const failedEarly = derive({
			...base,
			ledgerText: hdr,
			snapshot: snap([], [], [], [], [obs("aws", "skipped", true)]),
		});
		const earlyGate = failedEarly.cloudGates.find((g) => g.cloud === "aws");
		ok("a leg that failed BEFORE its gate is not credited as reaching it", earlyGate?.effective === "unwired", JSON.stringify(earlyGate));
		ok("...and the rendered evidence says so, rather than blaming a gate-off proof",
			/failed BEFORE its gate/.test(render(failedEarly)), "evidence line missing");

		// The rendered table must NAME the run, or an observed claim is as unfalsifiable as the
		// declared one it replaced.
		const rendered = render(observed);
		ok("the rendered table cites the run that observed the gate", /run 999/.test(rendered), rendered.slice(0, 200));

		// A snapshot written BEFORE this field existed must not read as "no cloud was observed,
		// therefore all are off". Absent evidence is not evidence of absence.
		const legacy = derive({ ...base, ledgerText: hdr, snapshot: snap([], [], ["E2E_AWS_ROLE_ARN"]) });
		ok("a snapshot with no observations falls back to the declaration",
			legacy.cloudGates.find((g) => g.cloud === "aws")?.effective === "wired",
			JSON.stringify(legacy.cloudGates.find((g) => g.cloud === "aws")));
	}

	// needs:human flows through to the blocked list.
	r = derive({
		...base,
		ledgerText: hdr,
		snapshot: { ...snap(), open_issues: [{ number: 1773, title: "delegate a zone", labels: ["needs:human"] }, { number: 1, title: "other", labels: [] }] },
	});
	ok("only needs:human issues reach the blocked-on-human list", r.board.needsHuman.length === 1 && r.board.needsHuman[0].number === 1773, JSON.stringify(r.board.needsHuman));

	// A snapshot older than a week is an integrity failure: a broken cron otherwise produces NO signal.
	r = derive({ ...base, ledgerText: hdr, snapshot: { ...snap(), derived_at: new Date(Date.now() - 9 * 864e5).toISOString() } });
	ok("a snapshot older than 7 days fails", r.failures.some((f) => /days old/.test(f)), JSON.stringify(r.failures));
	r = derive({ ...base, ledgerText: hdr, snapshot: { ...snap(), derived_at: new Date(Date.now() - 2 * 864e5).toISOString() } });
	ok("...but a 2-day-old snapshot does not", !r.failures.some((f) => /days old/.test(f)), JSON.stringify(r.failures));

	// ORPHAN REAPER: post-sweep state, not incident-free history. Every ambiguity is explicitly
	// non-clean, and freshness compares two persisted timestamps rather than the wall clock.
	{
		const result = (overrides = {}) => ({
			schema_version: 2,
			provider: "aws",
			region: "us-east-1",
			run_id: "123",
			run_attempt: 1,
			event_name: "schedule",
			mode: "reclaim",
			gate_ran: true,
			sweep_exit_code: 0,
			log_present: true,
			discovery_reported: true,
			orphan_runs_found: 0,
			resources_reclaimed: 0,
			residual_detected: false,
			unverified_count: 0,
			unattributable_count: 0,
			completed_at: "2026-09-01T00:00:00Z",
			...overrides,
		});
		const at48 = deriveReaperObservation(result(), "2026-09-03T00:00:00Z");
		ok("a verified reclaim exactly 48h old is clean", at48.state === "clean", JSON.stringify(at48));
		const stale = deriveReaperObservation(result(), "2026-09-03T00:00:01Z");
		ok("a verified reclaim older than 48h is stale", stale.state === "stale", JSON.stringify(stale));
		const reclaimed = deriveReaperObservation(result({ orphan_runs_found: 2, resources_reclaimed: 7 }), "2026-09-02T00:00:00Z");
		ok("a run that reclaimed incidents and verified afterward is clean", reclaimed.state === "clean" && /reclaimed 2/.test(reclaimed.why), JSON.stringify(reclaimed));
		ok("an explicit residual is standing", deriveReaperObservation(result({ residual_detected: true }), "2026-09-02T00:00:00Z").state === "standing");
		for (const [name, changes] of [
			["dry run", { mode: "dry_run" }],
			["skipped gate", { gate_ran: false }],
			["missing log", { log_present: false }],
			["failed sweep", { sweep_exit_code: 4 }],
			["unverified check", { unverified_count: 1 }],
			["unattributable resource", { unattributable_count: 1 }],
			// THE FALSE ALL-CLEAR. Every other row here is a fact the sweep REPORTED; this one is a
			// fact it never got to. A preflight whose discovery call failed produces an empty orphan
			// list, takes its early return and exits 0 — no residual, nothing unverified, a log
			// byte-identical to an empty account — and this cell used to read ✅ clean while
			// PROGRAMME.md published "nothing standing" about resources that BILL.
			["unreported discovery", { discovery_reported: false }],
		]) {
			const status = deriveReaperObservation(result(changes), "2026-09-02T00:00:00Z");
			ok(`${name} is indeterminate, never clean`, status.state === "indeterminate", JSON.stringify(status));
		}
		// …and it must not swallow a stronger verdict: a run that found residual orphans plainly
		// DID discover them, so `standing` wins over the discovery check that follows it.
		ok(
			"a residual finding still reads standing, not indeterminate",
			deriveReaperObservation(result({ residual_detected: true, discovery_reported: false }), "2026-09-02T00:00:00Z").state === "standing",
		);
		const malformed = derive({
			...base,
			ledgerText: hdr,
			snapshot: { ...snap(), derived_at: "2026-09-02T00:00:00Z", orphan_reaper_observations: [result({ raw_log: "must never persist" })] },
		});
		// A MALFORMED DURABLE RESULT DEGRADES ITS CELL, IT DOES NOT RED THE REPOSITORY. This used to
		// assert the opposite. It was changed deliberately: `failures` exits 1 and this file runs on
		// every PR, while `programme-fetch.sh` carries a bad entry forward without re-validating it —
		// so one malformed observation redded every PR permanently, and no PR could remove it because
		// every PR was red. Both halves are asserted here so a future "tighten this up" cannot
		// re-introduce the wedge without also deleting a stated reason.
		ok(
			"a malformed durable result does NOT fail the build",
			!malformed.failures.some((failure) => /orphan-reaper result/.test(failure)),
			JSON.stringify(malformed.failures),
		);
		const malformedCell = deriveReaperObservation(result({ raw_log: "must never persist" }), "2026-09-02T00:00:00Z");
		ok(
			"...and is indeterminate, never clean",
			malformedCell.state === "indeterminate" && malformedCell.integrityFailure !== null,
			JSON.stringify(malformedCell),
		);
		const fullyClean = derive({
			...base,
			ledgerText: hdr,
			snapshot: {
				...snap(),
				derived_at: "2026-09-02T00:00:00Z",
				orphan_reaper_observations: [result(), result({ provider: "hetzner", region: "nbg1", run_id: "124" })],
			},
		});
		ok("the clean tally is per declared cloud", fullyClean.reaperClean === 2, JSON.stringify(fullyClean.reaper));
		ok("the rendered table preserves reclaimed incident history", /reclaimed 2 orphan run/.test(render({ ...fullyClean, reaper: fullyClean.reaper.map((entry) => entry.cloud === "aws" ? { ...reclaimed, cloud: "aws" } : entry) })));
	}

	// NO CLOCK IN THE RENDERED OUTPUT. An age is computed from Date.now(), so rendering one would make
	// this diff-gated region go stale an hour after every refresh with no input change — redding CI for
	// everybody. Rendering the same snapshot twice must be byte-identical regardless of when.
	{
		const fixed = { ...snap([], [1040]), derived_at: "2026-08-01T00:00:00Z" };
		const a = render(derive({ ...base, ledgerText: hdr + failRow, snapshot: fixed }));
		const b = render(derive({ ...base, ledgerText: hdr + failRow, snapshot: fixed }));
		ok("rendering is byte-identical across calls (no clock in the output)", a === b);
		ok("the provenance prints the snapshot timestamp verbatim", a.includes("2026-08-01T00:00:00Z"), a.split("\n").find((l) => l.includes("Live board snapshot")) ?? "");
		ok("...and never an age", !/\b(hours? old|h old|days old|under an hour)\b/.test(a), a.split("\n").find((l) => /old/.test(l)) ?? "");
	}

	// bundleKind.
	ok("bundleKind: committed path", bundleKind("demos/proofs/aws/20260801T000000Z") === "path");
	ok("bundleKind: bare cloud/stamp is a path", bundleKind("hetzner/20260805T064043Z") === "path");
	ok("bundleKind: nightly run tag", bundleKind("nightly-29895597616") === "run-tag");
	ok("bundleKind: empty", bundleKind("") === "none");

	if (fails > 0) {
		console.error(`\nself-test: ${fails} check(s) FAILED`);
		process.exit(1);
	}
	console.log("\nself-test: all passed");
}

// ───────────────────────────── main ─────────────────────────────

const executedDirectly = process.argv[1] !== undefined && import.meta.url === `file://${fs.realpathSync(process.argv[1])}`;

if (!executedDirectly) {
	// imported — expose the helpers, touch nothing.
} else if (process.argv.includes("--self-test")) {
	runSelfTest();
} else if (process.argv.includes("--superseded-reds")) {
	// The closable list, for `scripts/coordinate.sh --report`.
	//
	// stdout, machine-readable, and it MUTATES NOTHING — closing an issue is a human act, because
	// only a human can confirm the later run really answered this red rather than merely postdating
	// it. Exit 0 with a stated "none" line when the list is empty: a silent success and a genuine
	// zero must not look the same, which is the defect this whole reporter exists to fix.
	const v = derive(readInputs());
	const rows = v.supersededReds;
	if (rows.length === 0) {
		console.log("superseded-reds: none — every open nightly RED is either unanswered or already contested.");
	} else {
		console.log(`superseded-reds: ${rows.length} open nightly RED(s) have been answered by a LATER proof and can be closed.`);
		for (const r of rows) {
			console.log(`  ${r.issue}\t${r.cloud}/${r.dimension}\tfiled ${r.redFiledOn}\tproven ${r.provenOn}\t${r.evidence || "(no bundle recorded)"}`);
		}
	}
	for (const c of v.compositeReds) {
		console.log(`  (stays open) ${c.issue}\t${c.cloud}/${COMPOSITE_RED_DIMENSION}\tno proof on/after for: ${c.missing.join(",")}`);
	}
	for (const u of v.unmappedReds) {
		console.log(`  (UNMAPPED) ${u.issue}\t${u.cloud}/${u.dimension}\t— this file could not resolve that dimension label`);
	}
} else if (process.argv.includes("--epic-body")) {
	// The tracking epic is a RENDERING of the generated grid, never a second board.
	//
	// That is the whole design constraint. This repo has fifteen boards already, and the one thing
	// that must not happen is a sixteenth that is hand-kept and drifts from the ledger — a grid
	// someone updates by hand is a grid that lies the first time a run lands while they are asleep.
	//
	// So this emits `render(derive(...))` VERBATIM — the same function, the same inputs, the same
	// bytes PROGRAMME.md's generated half gets. It deliberately does not select or re-lay-out
	// sections: a second renderer is a second thing to keep in step, and the epic drifting from the
	// ledger would be indistinguishable from the ledger being wrong.
	//
	// stdout only, and no write: the caller pipes it to `gh issue edit --body-file -`. Nothing here
	// touches PROGRAMME.md, so this is safe to run on a branch whose generated half is stale — and
	// it does NOT run the integrity check, because the epic's job is to REPORT the state including
	// a failing one, not to gate on it. `pnpm gen:programme` is the gate.
	process.stdout.write(render(derive(readInputs())).trimEnd() + "\n");
} else {
	const view = derive(readInputs());
	const generated = render(view);

	const existing = fs.existsSync(TARGET) ? fs.readFileSync(TARGET, "utf8") : "";
	if (existing === "") {
		console.error(`::error::programme-rollup: ${TARGET} does not exist. Create it with the two generated-region markers first.`);
		process.exit(3);
	}

	const intentViolations = intentHalfViolations(existing);
	const integrity = [...view.failures, ...intentViolations];

	// ── ADVISORIES ──
	//
	// `notes` was pushed to and never read. One note has been generated since it was written — "an
	// unfiled red is an unowned red" — and nobody has ever seen it, because the array was returned
	// and dropped. A finding routed into a channel with no outlet is indistinguishable from no
	// finding, which is the exact failure mode this file exists to prevent one level up.
	//
	// Advisories are NOT integrity failures and must not gate the build: an unfiled red is a
	// bookkeeping gap, not a lying cell. They are printed on every run and annotated in CI.
	for (const n of view.notes) {
		console.error(`::warning::programme-rollup: ${n}`);
	}

	if (process.argv.includes("--write")) {
		fs.writeFileSync(TARGET, splice(existing, generated));
		console.log(`wrote ${TARGET} — ${view.tally.proven} proven / ${view.tally.failing} failing / ${view.tally.never_run} never-run`);
	}

	for (const f of integrity) console.error(`::error::programme-rollup: ${f}`);
	if (integrity.length > 0) {
		console.error(`\nprogramme-rollup: ${integrity.length} integrity failure(s) — a cell is lying.`);
		process.exit(1);
	}

	if (!process.argv.includes("--write")) {
		const want = splice(existing, generated);
		if (want !== fs.readFileSync(TARGET, "utf8")) {
			console.error(`::error::programme-rollup: ${TARGET}'s generated half is STALE — run \`pnpm gen:programme\` and commit.`);
			process.exit(2);
		}
		console.log(`programme-rollup: ${TARGET} is in sync — ${view.tally.proven} proven / ${view.tally.failing} failing / ${view.tally.never_run} never-run`);
	}
}
