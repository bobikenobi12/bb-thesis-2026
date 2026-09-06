// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Cross-language parity for the compat engine — the TS half.
//
// engine.ts describes itself as producing "byte-for-byte the same verdict + control statuses the
// Go engine produces for the same subject (the contract-lock discipline)". Nothing checked that,
// and it was false in two places, both sitting on a fail-closed gate:
//
//   1. parseMinor used `Number()` + `Number.isInteger`, Go uses `strconv.Atoi`. `Number("")` is 0
//      and `Number.isInteger(0)` is true, so "1.", ".5", "1. 35", "1.0x10" and "1.1e2" were
//      JUDGED here and `not_evaluable` in the Go apply gate — the console showed a pass or a fail
//      where the gate refused to decide.
//   2. `new Date("garbage").getTime()` is NaN and `NaN < now` is false, so an unparseable expiry
//      made a waiver valid FOREVER. A fail-open in the check that decides whether a fail-closed
//      apply gate may be passed.
//
// GO IS THE AUTHORITY and the fixture is generated there, because compat.Evaluate is what runs
// inside provisioner/deploy.go between plan and apply and Report.Unwaived is what decides whether
// the apply proceeds. This suite proves the console reaches the same answers.
//
// Regenerate the fixture (Go side):
//   cd packages/core && UPDATE_FIXTURES=1 go test ./compat/ -run TestEngineParityFixture

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { evaluate, unwaived } from "@/lib/compat/engine";
import type { CompatControlResult, CompatOverride, CompatReport, CompatSubject } from "@/types/compat.types";

const __dirname = dirname(fileURLToPath(import.meta.url));
// apps/console/tests/lib/compat → repo root is five levels up.
const FIXTURE = join(__dirname, "../../../../../packages/core/compat/testdata/engine_parity.json");

/** One control's id and status — the slice the two engines must agree on. */
interface ParityControl {
	id: string;
	status: string;
}

interface ParityRef {
	id: string;
	version?: string;
}

interface ParityEvalCase {
	id: string;
	/** Go's json tags, so the fixture reads the same on both sides. */
	subject: { providers?: string[]; k8s_version?: string; components?: ParityRef[]; addons?: ParityRef[] };
	want: ParityControl[];
}

interface ParityWaiverCase {
	id: string;
	controls: string[];
	/** Raw, because the point is what each language does with one it cannot parse. */
	expiry: string;
	/** Whether Go accepts this expiry at the JSON boundary. */
	decodes: boolean;
	now: string;
	failing_controls: string[];
	want: string[];
}

interface ParityFile {
	version: number;
	evaluate: ParityEvalCase[];
	waiver: ParityWaiverCase[];
}

function str(v: unknown, what: string): string {
	if (typeof v !== "string") throw new TypeError(`${what} is not a string`);
	return v;
}

function strArray(v: unknown, what: string): string[] {
	if (!Array.isArray(v)) throw new TypeError(`${what} is not an array`);
	return v.map((x, i) => str(x, `${what}[${i}]`));
}

function refArray(v: unknown, what: string): ParityRef[] {
	if (!Array.isArray(v)) throw new TypeError(`${what} is not an array`);
	return v.map((x, i) => {
		if (x === null || typeof x !== "object") throw new TypeError(`${what}[${i}] is not an object`);
		const r: Record<string, unknown> = { ...x };
		return {
			id: str(r.id, `${what}[${i}].id`),
			version: r.version === undefined ? undefined : str(r.version, `${what}[${i}].version`),
		};
	});
}

/** Narrow the Go-written fixture without letting an `any` escape or using a cast. */
function loadFixture(): ParityFile {
	const parsed: unknown = JSON.parse(readFileSync(FIXTURE, "utf8"));
	if (parsed === null || typeof parsed !== "object") throw new TypeError("fixture is not an object");
	const doc: Record<string, unknown> = { ...parsed };

	if (typeof doc.version !== "number") throw new TypeError("fixture has no numeric version");
	if (!Array.isArray(doc.evaluate)) throw new TypeError("fixture has no evaluate array");
	if (!Array.isArray(doc.waiver)) throw new TypeError("fixture has no waiver array");

	const evaluateCases: ParityEvalCase[] = doc.evaluate.map((raw, i) => {
		if (raw === null || typeof raw !== "object") throw new TypeError(`evaluate[${i}] is not an object`);
		const c: Record<string, unknown> = { ...raw };
		const subjRaw = c.subject;
		if (subjRaw === null || typeof subjRaw !== "object") throw new TypeError(`evaluate[${i}].subject missing`);
		const subj: Record<string, unknown> = { ...subjRaw };
		if (!Array.isArray(c.want)) throw new TypeError(`evaluate[${i}].want is not an array`);

		// REFUSE an unknown subject field rather than dropping it. The loader used to build the
		// subject from a fixed pair of keys, so adding `components` to the fixture would have been
		// silently ignored here — and the case would then fail as a bogus ENGINE mismatch, sending
		// the next reader after a disagreement that does not exist. A loader that quietly narrows
		// its input is the same defect class as a guard that quietly narrows its matcher.
		const known = new Set(["providers", "k8s_version", "components", "addons"]);
		const unknown = Object.keys(subj).filter((k) => !known.has(k));
		if (unknown.length > 0) {
			throw new TypeError(
				`evaluate[${i}] (${String(c.id)}) has subject field(s) this loader does not carry: ` +
					`${unknown.join(", ")}. Add them to toSubject() — leaving them out makes the case fail ` +
					`as an engine mismatch when the engines actually agree.`,
			);
		}

		return {
			id: str(c.id, `evaluate[${i}].id`),
			subject: {
				providers: subj.providers === undefined ? undefined : strArray(subj.providers, "providers"),
				k8s_version: subj.k8s_version === undefined ? undefined : str(subj.k8s_version, "k8s_version"),
				components: subj.components === undefined ? undefined : refArray(subj.components, "components"),
				addons: subj.addons === undefined ? undefined : refArray(subj.addons, "addons"),
			},
			want: c.want.map((w, j) => {
				if (w === null || typeof w !== "object") throw new TypeError(`evaluate[${i}].want[${j}] is not an object`);
				const ctl: Record<string, unknown> = { ...w };
				return { id: str(ctl.id, "want.id"), status: str(ctl.status, "want.status") };
			}),
		};
	});

	const waiverCases: ParityWaiverCase[] = doc.waiver.map((raw, i) => {
		if (raw === null || typeof raw !== "object") throw new TypeError(`waiver[${i}] is not an object`);
		const c: Record<string, unknown> = { ...raw };
		if (typeof c.decodes !== "boolean") throw new TypeError(`waiver[${i}].decodes is not a boolean`);
		return {
			id: str(c.id, `waiver[${i}].id`),
			controls: strArray(c.controls, `waiver[${i}].controls`),
			expiry: str(c.expiry, `waiver[${i}].expiry`),
			decodes: c.decodes,
			now: str(c.now, `waiver[${i}].now`),
			failing_controls: strArray(c.failing_controls, `waiver[${i}].failing_controls`),
			want: strArray(c.want, `waiver[${i}].want`),
		};
	});

	return { version: doc.version, evaluate: evaluateCases, waiver: waiverCases };
}

const fixture = loadFixture();

/** The Go fixture's snake_case subject, as the TS engine's camelCase one. */
function toSubject(s: ParityEvalCase["subject"]): CompatSubject {
	return {
		providers: s.providers,
		k8sVersion: s.k8s_version,
		// Go's ComponentRef.Version is a plain string; the TS type requires it, so an absent
		// version becomes "" rather than undefined — which is what Go would have sent.
		components: s.components?.map((r) => ({ id: r.id, version: r.version ?? "" })),
		addons: s.addons?.map((r) => ({ id: r.id, version: r.version })),
	};
}

/** A minimal report standing in for one whose listed controls have failed. */
function failingReport(ids: string[]): CompatReport {
	const controls: CompatControlResult[] = ids.map((id) => ({
		id,
		title: id,
		severity: "high",
		status: "fail",
	}));
	return {
		verdict: "fail",
		catalog_version: "parity",
		controls,
		summary: { pass: 0, fail: controls.length, warn: 0, not_evaluable: 0 },
	};
}

describe("compat engine cross-language parity", () => {
	// Vacuity. A fixture that failed to load, or loaded empty, must not read as agreement.
	it("loaded a fixture with cases in both halves", () => {
		expect(fixture.evaluate.length).toBeGreaterThan(0);
		expect(fixture.waiver.length).toBeGreaterThan(0);
	});

	it("still exercises the divergence it was written for", () => {
		// NAMED, not counted. These floors were the same inert guard the Go half already replaced:
		// the fixture carries ten not_evaluable evaluate verdicts of which only five come from the
		// malformed-version divergence, so all five could be deleted and `>= 5` would still be
		// cleared by `no-minor-component`, `empty-version`, `not-a-number-at-all`, the BOM case and
		// `beyond-int53`. The waiver half was worse: thirteen against a floor of three. Deleting
		// every case this suite exists to protect left it green, under a message saying those cases
		// are the reason it exists.
		//
		// Deliberately duplicated from packages/core/compat/engine_parity_test.go rather than
		// generated into the fixture: this is the TS side asserting, in its own words, what it
		// requires of a file Go writes. A generated list would be regenerated by the same command
		// that removed the case.
		const REQUIRED_NOT_EVALUABLE = [
			"evaluate/k8s/TRAILING-DOT-IS-NOT-A-VERSION",
			"evaluate/k8s/LEADING-DOT-IS-NOT-A-VERSION",
			"evaluate/k8s/INNER-SPACE-IS-NOT-A-VERSION",
			"evaluate/k8s/HEX-IS-NOT-A-VERSION",
			"evaluate/k8s/EXPONENT-IS-NOT-A-VERSION",
			"evaluate/k8s/beyond-int53-is-not-a-version",
			"evaluate/k8s/BOM-IS-NOT-TRIMMED-BY-GO",
		];
		const REQUIRED_UNDECODABLE = [
			"waiver/UNPARSEABLE-EXPIRY-DOES-NOT-WAIVE",
			"waiver/A-NUMBER-IS-NOT-A-TIMESTAMP",
			"waiver/LOWERCASE-T-AND-Z-IS-NOT-RFC3339",
			"waiver/A-MISSING-ZONE-IS-NOT-RFC3339",
			"waiver/HOUR-24-IS-NOT-RFC3339",
			"waiver/IMPOSSIBLE-DAY-WITH-AN-OFFSET-IS-NOT-RFC3339",
			"waiver/OFFSET-HOUR-25-IS-NOT-RFC3339",
			"waiver/OFFSET-MINUTE-99-IS-NOT-RFC3339",
			"waiver/ONE-DIGIT-MINUTE-IS-NOT-RFC3339",
		];

		const notEvaluableIds = new Set(
			fixture.evaluate.filter((c) => c.want.some((w) => w.status === "not_evaluable")).map((c) => c.id),
		);
		for (const id of REQUIRED_NOT_EVALUABLE) {
			expect(
				notEvaluableIds.has(id),
				`${id} is missing, or no longer reaches not_evaluable — it is one of the malformed-version cases this suite exists for`,
			).toBe(true);
		}
		const undecodableIds = new Set(fixture.waiver.filter((c) => !c.decodes).map((c) => c.id));
		for (const id of REQUIRED_UNDECODABLE) {
			expect(
				undecodableIds.has(id),
				`${id} is missing, or the fixture now records its expiry as decodable — it is one of the shapes the fail-open rode in on`,
			).toBe(true);
		}
		// And the fail-open itself can never be the recorded answer.
		for (const c of fixture.waiver.filter((w) => !w.decodes)) {
			expect(c.want.length, `${c.id} waived a control on an expiry Go cannot decode — that IS the fail-open`).toBeGreaterThan(0);
		}
	});

	describe("evaluate", () => {
		for (const c of fixture.evaluate) {
			it(c.id, () => {
				const report = evaluate(toSubject(c.subject));
				const got = report.controls.map((ctl) => ({ id: ctl.id, status: ctl.status }));
				expect(got).toEqual(c.want);
			});
		}
	});

	describe("waiver", () => {
		for (const c of fixture.waiver) {
			it(c.id, () => {
				const now = new Date(c.now).getTime();
				expect(Number.isNaN(now), `${c.id}: the fixture's own "now" must be parseable`).toBe(false);

				// The override is built from the RAW expiry, exactly as it would arrive from the
				// database or an API body. Go's answer for one it cannot decode is reached by
				// refusing the Override entirely; TS has no decode step, so it has to reach the
				// same answer by treating an unreadable expiry as expired.
				const override: CompatOverride = {
					controls: c.controls,
					...(c.expiry === "" ? {} : { expiry: c.expiry }),
				};
				expect(unwaived(failingReport(c.failing_controls), override, now)).toEqual(c.want);
			});
		}
	});
});
