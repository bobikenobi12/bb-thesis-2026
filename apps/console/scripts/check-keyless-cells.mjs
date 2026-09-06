// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Keyless-cell guard: the `keylessCells` table must agree with the code that implements the cells.
//
// `keylessCells` (packages/core/manifests/keyless.go) decides, per cloud × engine, whether a keyless
// database binding renders a proxy or fails closed. Turning a cell OFF is a claim — "one of this
// cell's legs is not built" — and that claim rots silently in both directions:
//
//   A · DEAD CELL     every leg shipped, the cell stayed `pending`. The binding fails closed citing
//                     lanes that are already merged, so a working capability is unreachable and reads
//                     as unbuilt. This is the state aws × mysql and gcp × mysql sat in after #1504,
//                     #1505, #1506 and #1507 each landed their half and none flipped the cell.
//   B · OVER-OPEN     a leg is missing, the cell is `live`. The pod renders cleanly and then cannot
//                     authenticate at runtime — precisely the lie the fail-closed table exists to
//                     prevent, and the most expensive way to discover it is in production.
//   C · UNREASONED    a non-live cell with no reason. Since #1510 the reason is USER-FACING copy on
//                     three surfaces — the canvas's disabled toggle, the deploy refusal, and the
//                     offer-parity matrix — so an empty one ships a gate that withholds a capability
//                     and declines to say why, which reads as a bug.
//
// `excluded` is deliberately exempt from A: it is a permanent product boundary, not debt, so legs
// existing for it proves nothing. Only `pending` makes a checkable claim about missing work.
//
// Nothing else catches either shape. check-offer-parity.mjs reads the TEMPLATES, so once the tofu
// side of a cell ships it reports `database:<engine>:iam_auth` as buildable and goes green while the
// renderer still refuses — the gap is between the templates and the RENDERER, which no guard compared.
//
// The legs checked here are the two that are uniformly derivable from source, and they are the two
// that were actually missing:
//
//   1. bootstrap SQL dialect — apps/runner/internal/agent/db_bootstrap.go. `postgresBootstrapSQL` and
//      `mysqlBootstrapSQL` each switch on provider; a `case "<cloud>"` is the dialect existing. Without
//      it the Job cannot create the app's login, so the proxy would authenticate as nobody.
//   2. bootstrap Job renderer — packages/core/manifests/bootstrap_job.go. `<cloud>BootstrapSpec` must
//      branch on `engineMySQL` to pass `--engine mysql` and run the mysql client; without that branch a
//      MySQL cell would apply Postgres SQL with psql against a MySQL server.
//
// It deliberately does NOT check the tofu IAM-auth flag. That leg is real but cloud-idiosyncratic —
// one RDS attribute covers both AWS engines, GCP needs the dotted key for Postgres and the UNDERSCORED
// one for MySQL, Azure gates on a computed `enable_mysql_entra` local — so verifying it means a
// hand-written marker per cell, which is the drift this guard exists to stop. Two derived legs that
// cannot rot beat three where one is a hand-list.
//
// Run from apps/console (`pnpm -C apps/console run check:keyless-cells`).

import { readFileSync } from "node:fs";

import { funcBody, neutralizeBracesInStrings, stripComments } from "./lib/go-source.mjs";
import { readKeylessCells } from "./lib/keyless-cells.mjs";

const ROOT = "../..";
const CELLS_SRC = `${ROOT}/packages/core/manifests/keyless.go`;
const JOB_SRC = `${ROOT}/packages/core/manifests/bootstrap_job.go`;
const SQL_SRC = `${ROOT}/apps/runner/internal/agent/db_bootstrap.go`;

// ── the declared side: the keylessCells table ───────────────────────────────────────

let declared;
try {
	declared = readKeylessCells(CELLS_SRC).cells;
} catch (err) {
	console.error(`✗ keyless cells — ${err.message}`);
	process.exit(1);
}

// ── the implemented side: derived from the two legs ─────────────────────────────────

const sqlSrc = stripComments(neutralizeBracesInStrings(readFileSync(SQL_SRC, "utf8")));
const jobSrc = stripComments(readFileSync(JOB_SRC, "utf8"));

/** Providers whose dialect exists for an engine — the `case "<cloud>":` labels in that engine's
 * bootstrap-SQL function. */
const dialectFor = (engine) => {
	const body = funcBody(sqlSrc, engine === "mysql" ? "mysqlBootstrapSQL" : "postgresBootstrapSQL");
	return new Set([...body.matchAll(/case\s+"([a-z]+)"\s*:/g)].map((m) => m[1]));
};
const dialects = { postgres: dialectFor("postgres"), mysql: dialectFor("mysql") };

/** Does <cloud>BootstrapSpec render this engine? Postgres is the default path every spec takes, so
 * only MySQL needs an explicit branch. An absent spec func fails both. */
function jobRenders(cloud, engine) {
	const body = funcBody(jobSrc, `${cloud}BootstrapSpec`);
	if (body === "") return false;
	return engine === "mysql" ? body.includes("engineMySQL") : true;
}

/** The legs a cell needs, each with the source that proves it. */
const legsOf = (cloud, engine) => [
	{ name: "bootstrap SQL dialect", ok: dialects[engine]?.has(cloud) ?? false, src: `${SQL_SRC} (${engine}BootstrapSQL, case "${cloud}")` },
	{ name: "bootstrap Job renderer", ok: jobRenders(cloud, engine), src: `${JOB_SRC} (${cloud}BootstrapSpec)` },
];

// ── adjudicate ──────────────────────────────────────────────────────────────────────

const findings = [];
for (const cell of declared) {
	const legs = legsOf(cell.cloud, cell.engine);
	const missing = legs.filter((l) => !l.ok);

	// A cell that is not live must say why. The reason is not an internal note — it is the sentence
	// the canvas prints on the disabled toggle and the deploy prints when it refuses, so an empty one
	// ships a gate with nothing behind it.
	if (cell.state !== "live" && cell.reason.trim() === "") {
		findings.push({
			shape: "unreasoned-cell",
			cell,
			detail: `the cell is "${cell.state}" with no reason — the canvas would disable the toggle and say nothing, and the deploy would refuse with an empty message.`,
		});
	}
	if (cell.state === "live" && cell.reason.trim() !== "") {
		findings.push({
			shape: "reasoned-live-cell",
			cell,
			detail: `the cell is live but carries a reason — a reason is what a REFUSAL says, so this one is never read and will rot.`,
		});
	}

	// `pending` is the only state that can be DEAD: it claims a leg is missing, and that claim is
	// checkable. `excluded` is a permanent product boundary — alibaba has no data-plane token login
	// however many legs we build — so legs existing there proves nothing and must not fail the guard.
	if (cell.state === "pending" && missing.length === 0) {
		findings.push({
			shape: "dead-cell",
			cell,
			detail: `every leg is implemented, but the cell is still pending — the binding fails closed on a capability that is built.\n      proof: ${legs.map((l) => l.src).join("\n             ")}`,
		});
	}
	if (cell.state === "live" && missing.length > 0) {
		findings.push({
			shape: "over-open",
			cell,
			detail: `the cell is live, but ${missing.length} leg(s) are missing — it renders a proxy that cannot authenticate.\n      missing: ${missing.map((l) => `${l.name} → ${l.src}`).join("\n               ")}`,
		});
	}
}

const count = (state) => declared.filter((c) => c.state === state).length;
if (findings.length === 0) {
	console.log(
		`✓ keyless cells — ${declared.length} cloud × engine cell(s): ${count("live")} live, ` +
			`${count("pending")} pending, ${count("excluded")} excluded, each agreeing with its bootstrap ` +
			`SQL dialect and Job renderer, and each non-live cell carrying the reason the canvas shows.`,
	);
	process.exit(0);
}

console.error(`\n✗ keyless cells — ${findings.length} cell(s) disagree with the code that implements them:\n`);
for (const f of findings) {
	console.error(`  [${f.shape}] ${f.cell.cloud} × ${f.cell.engine}`);
	console.error(`      ${f.detail}`);
}
console.error(`
The table in packages/core/manifests/keyless.go is a claim about what is built. Make it true:
  · [dead-cell]        flip the cell to {state: cellLive} — the legs it was waiting for have landed.
                       Update the matching row in keyless_test.go so it asserts a rendered proxy on
                       the engine's port.
  · [over-open]        build the missing leg, or set the cell back to cellPending with a reason naming
                       the lane. A cell that renders without its legs authenticates as nobody, and only
                       a real apply finds out.
  · [unreasoned-cell]  write the reason in the product's voice — it is user-facing copy on three
                       surfaces (canvas toggle, deploy error, offer-parity matrix), not a TODO.
  · [reasoned-live-cell] drop the reason; a live cell never refuses, so nothing would ever print it.

Then run \`pnpm -C apps/console run gen:keyless-cells\` — the TypeScript mirror the canvas reads is generated
from this table, and CI diff-checks it.
`);
process.exit(1);
