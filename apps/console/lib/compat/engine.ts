// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The TS mirror of the pure compat engine (packages/core/compat/compat.go). It
// evaluates a proposed config against the generated matrix into a CompatReport
// with byte-for-byte the same verdict + control statuses the Go engine produces
// for the same subject (the contract-lock discipline). Pure + deterministic —
// no I/O, and no clock except `unwaived`'s default `now`, which callers may pass
// — so config-time UI and the apply gate share one truth.
//
// That claim is now CHECKED, by a fixture the Go side generates:
// apps/console/tests/lib/compat/engine-parity.test.ts against
// packages/core/compat/testdata/engine_parity.json. It was false in two places
// before anything checked it — see parseMinor's and covers' comments below.

import type {
	CompatAddOnRef,
	CompatComponentRef,
	CompatControlResult,
	CompatOverride,
	CompatReport,
	CompatStatus,
	CompatSubject,
	CompatSummary,
} from "@/types/compat.types";
import { MATRIX } from "./generated/matrix";
import type { ComponentRelease, K8sRange } from "./generated/matrix";
import { goTrimSpace } from "@/lib/validations/apps-path";

/**
 * Evaluate a proposed config against the embedded matrix, returning a structured
 * CompatReport. Mirrors compat.Evaluate: emits COMPAT-K8S-CLOUD-<PROVIDER>,
 * COMPAT-COMPONENT-<ID>, and COMPAT-ADDON-<ID> controls, and never reports a pass
 * on something the matrix has no data for (not_evaluable, honest).
 */
export function evaluate(subject: CompatSubject): CompatReport {
	const controls: CompatControlResult[] = [];
	for (const provider of subject.providers ?? []) {
		controls.push(evalK8sCloud(provider, subject.k8sVersion));
	}
	for (const c of subject.components ?? []) {
		controls.push(evalComponent(subject.k8sVersion, c));
	}
	for (const a of subject.addons ?? []) {
		controls.push(evalAddOn(subject.k8sVersion, a));
	}
	return finalize(controls);
}

/** Whether a blocking report should stop a real apply (only a hard fail blocks). */
export function isBlocking(report: CompatReport): boolean {
	return report.verdict === "fail";
}

/**
 * The IDs of controls that FAILED and are NOT covered by a valid override. A
 * non-empty result means the apply must stay blocked. Mirrors Report.Unwaived.
 */
export function unwaived(report: CompatReport, override?: CompatOverride | null, now: number = Date.now()): string[] {
	return report.controls
		.filter((c) => c.status === "fail" && !covers(override, c.id, now))
		.map((c) => c.id);
}

/**
 * Whether an override currently waives a control ID (false when expired).
 *
 * `now` is a parameter so this decision can be pinned in the cross-language parity fixture, and
 * so the "no clock" claim in this file's header is true of everything except the default.
 * Mirrors Go's `(*Override).CoversAt` (packages/core/compat/override.go).
 */
function covers(override: CompatOverride | null | undefined, id: string, now: number): boolean {
	if (!override) return false;
	if (override.expiry) {
		const expiry = parseRFC3339(override.expiry);
		// An expiry that cannot be READ does not waive. The previous form was
		// `new Date(expiry).getTime() < now`, and `new Date("garbage").getTime()` is NaN — every
		// comparison with NaN is false, so an unparseable expiry made the waiver valid FOREVER.
		// A fail-open in the check that decides whether a fail-closed apply gate may be passed.
		if (expiry === null || expiry < now) return false;
	}
	return override.controls.includes(id);
}

/**
 * `time.Parse(time.RFC3339, s)`, as closely as JS can express it.
 *
 * A bare NaN check is NOT enough, and this is the second half of the same fail-open. `new Date` is
 * far laxer than Go: it accepts a lowercase `t`/`z`, a missing zone, a space instead of the `T`, a
 * bare date, a bare year, an RFC1123 string, and hour 24 — SEVEN shapes Go's RFC3339 refuses. Each
 * one is a future-dated waiver the console would honour while the runner refuses the override
 * outright, which is the console being LOOSER: the dangerous direction, since the user is told the
 * waiver is in force and the apply is blocked anyway.
 *
 * Mirrors apps/runner's buildCompatOverride / buildVerifyOverride, which parse with
 * `time.RFC3339` and refuse the whole override when it fails. The divergent shapes are pinned in
 * packages/core/compat/testdata/engine_parity.json.
 *
 * @returns epoch milliseconds, or null when Go would not have parsed it.
 */
function parseRFC3339(raw: string): number | null {
	// Uppercase T and Z only, a full date, a full time, and a mandatory zone — Go's layout is
	// "2006-01-02T15:04:05Z07:00" and it is not case-insensitive.
	// `time.Parse(time.RFC3339, …)` is NOT the strict fast path. format.go tries `parseRFC3339`
	// and, on failure, falls through to the general parser with layout "2006-01-02T15:04:05Z07:00"
	// — which is laxer in two specific places, both measured against go1.26.6:
	//
	//   `stdHour` reads getnum(value, false)  → ONE OR TWO digits, so `T9:00:00Z` parses;
	//   the fraction branch tests commaOrPeriod → `00:00:00,5Z` parses.
	//
	// Minute, second, month and day stay fixed-width (getnum(…, true)) and `T`/`Z` stay
	// case-sensitive, so the laxness is exactly those two and no further. Being STRICTER than the
	// gate is not safe here just because it is the cautious direction: the console would report a
	// control still blocking while the apply it is describing goes through, which is the same
	// disagreement as the loose direction with the operator misled instead of the machine.
	const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{1,2}):(\d{2}):(\d{2})([.,]\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(raw);
	if (!m) return null;

	const [, y, mo, d, h, mi, sec, frac, sign, offH, offM] = m;
	const year = Number(y);
	const month = Number(mo);
	const day = Number(d);

	// The shape is right; the COMPONENTS still have to be real. `2026-13-45T00:00:00Z` matches the
	// pattern, and JS would roll it over into 2027 rather than rejecting it, where Go range-checks.
	//
	// This is arithmetic, NOT a Date round-trip. The round-trip it replaces ran only for `Z`-suffixed
	// values, so an impossible day carrying a numeric offset (`2099-02-30T00:00:00+02:00`) skipped
	// both guards and was rolled forward to March 1st — accepted here, `day out of range` in Go.
	if (month < 1 || month > 12) return null;
	if (day < 1 || day > daysInMonth(year, month)) return null;
	// Go rejects hour 24; JS accepts it as midnight the next day. Leap seconds are not supported
	// by Go's parser either, so 60 is out of range for the seconds field as well.
	if (Number(h) > 23 || Number(mi) > 59 || Number(sec) > 59) return null;

	// The offset's own ranges, mirrored from Go rather than delegated to `Date.parse`, whose rules
	// are NOT Go's: `Date.parse` returns NaN for `+24:00` and `+02:60`, both of which Go accepts.
	// Go's time/format.go range-checks `hr > 24` and `mm > 60` — and its own comment explains the
	// off-by-one is deliberate: "such that it is valid to have a time zone offset of exactly
	// 24:00:00". Measured against go1.26.6, not read off the spec.
	let offsetMinutes = 0;
	if (sign !== undefined) {
		const oh = Number(offH);
		const om = Number(offM);
		if (oh > 24 || om > 60) return null;
		offsetMinutes = (oh * 60 + om) * (sign === "-" ? -1 : 1);
	}

	// Sub-millisecond precision is lost — JS epoch ms cannot carry Go's nanoseconds. The truncation
	// moves an expiry EARLIER, so the console can only ever call a waiver expired a fraction of a
	// millisecond before the runner does. That is the console being stricter, which is the safe
	// direction: it never claims a waiver is in force that the apply gate has already dropped.
	const ms = frac === undefined ? 0 : Math.floor(Number(`0.${frac.slice(1)}`) * 1000);
	return Date.UTC(year, month - 1, day, Number(h), Number(mi), Number(sec), ms) - offsetMinutes * 60_000;
}

/** Days in a (1-based) month, Gregorian leap rule — so February 30th is refused, not rolled. */
function daysInMonth(year: number, month: number): number {
	if (month === 2) {
		const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
		return leap ? 29 : 28;
	}
	return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/** Checks that the cluster Kubernetes minor is offered by the cloud. */
function evalK8sCloud(provider: string, k8s: string | undefined): CompatControlResult {
	const c: CompatControlResult = {
		id: `COMPAT-K8S-CLOUD-${provider.toUpperCase()}`,
		title: `Kubernetes availability on ${provider}`,
		severity: "high",
		status: "not_evaluable",
	};
	const cloud = MATRIX.k8s_cloud[provider];
	if (!cloud || cloud.supported.length === 0) {
		c.coverage = `no supported Kubernetes versions recorded for cloud "${provider}"`;
		return c;
	}
	const kv = parseMinor(k8s);
	if (!kv) {
		c.coverage = "cluster Kubernetes version is unset or unparseable";
		return c;
	}
	if (cloud.supported.some((sv) => minorEquals(parseMinor(sv), kv))) {
		c.status = "pass";
		return c;
	}
	c.status = "fail";
	c.findings = [
		{
			address: `${provider}/k8s@${k8s}`,
			message: `Kubernetes ${k8s} is not offered by ${provider} (supported: ${cloud.supported.join(", ")})`,
		},
	];
	return c;
}

/** Checks the cluster Kubernetes minor against a component version's window. */
function evalComponent(k8s: string | undefined, ref: CompatComponentRef): CompatControlResult {
	const c: CompatControlResult = {
		id: `COMPAT-COMPONENT-${ref.id.toUpperCase()}`,
		title: `${ref.id} ${ref.version} ↔ Kubernetes`,
		severity: "high",
		status: "not_evaluable",
	};
	const rel = findRelease(ref.id, ref.version);
	if (!rel) {
		c.coverage = `no compatibility data recorded for ${ref.id} ${ref.version}`;
		return c;
	}
	applyRangeResult(c, k8s, rel.k8s_min, rel.k8s_max, `${ref.id}@${ref.version}`);
	return c;
}

/** Checks the cluster Kubernetes minor against an add-on chart's window. Exported so the canvas
 * compat surfaces (#1222) judge one add-on through the SAME code the report does, rather than
 * reimplementing range math in a component. */
export function evalAddOn(k8s: string | undefined, ref: CompatAddOnRef): CompatControlResult {
	const c: CompatControlResult = {
		id: `COMPAT-ADDON-${ref.id.toUpperCase()}`,
		title: `add-on ${ref.id} ↔ Kubernetes`,
		severity: "medium",
		status: "not_evaluable",
	};
	const rng: K8sRange | undefined = MATRIX.addon_k8s[ref.id];
	if (!rng) {
		c.coverage = `add-on "${ref.id}" is not in the compatibility matrix`;
		return c;
	}
	applyRangeResult(c, k8s, rng.k8s_min, rng.k8s_max, ref.id);
	return c;
}

/** Writes a range-check outcome onto a control (finding on fail, coverage on not_evaluable). */
function applyRangeResult(
	c: CompatControlResult,
	k8s: string | undefined,
	min: string,
	max: string,
	address: string,
): void {
	const { status, detail } = checkK8sRange(k8s, min, max);
	c.status = status;
	if (status === "fail") {
		c.findings = [
			{ address, message: `requires Kubernetes ${rangeLabel(min, max)}, cluster is ${k8s}` },
		];
	} else if (status === "not_evaluable") {
		c.coverage = detail;
	}
}

/**
 * The status of a cluster Kubernetes minor against a [min, max] window. Both
 * bounds empty means no window is recorded (not_evaluable, never a pass); an empty
 * single bound is unbounded on that side.
 */
function checkK8sRange(
	k8s: string | undefined,
	min: string,
	max: string,
): { status: CompatStatus; detail: string } {
	if (!min && !max) {
		return { status: "not_evaluable", detail: "no Kubernetes compatibility range recorded" };
	}
	const kv = parseMinor(k8s);
	if (!kv) {
		return { status: "not_evaluable", detail: "cluster Kubernetes version is unset or unparseable" };
	}
	if (min) {
		const mn = parseMinor(min);
		if (!mn) return { status: "not_evaluable", detail: `recorded lower bound "${min}" is unparseable` };
		if (cmpMinor(kv, mn) < 0) return { status: "fail", detail: "" };
	}
	if (max) {
		const mx = parseMinor(max);
		if (!mx) return { status: "not_evaluable", detail: `recorded upper bound "${max}" is unparseable` };
		if (cmpMinor(kv, mx) > 0) return { status: "fail", detail: "" };
	}
	return { status: "pass", detail: "" };
}

/** Renders a [min, max] window for a human message ("1.33+", "≤1.32", "1.34–1.36"). Exported: it is
 * exactly the string a compat chip should show. */
export function rangeLabel(min: string, max: string): string {
	if (min && max) return `${min}–${max}`;
	if (min) return `${min}+`;
	if (max) return `≤${max}`;
	return "any";
}

/** A parsed (major, minor) Kubernetes version; patch is ignored. */
type Minor = { major: number; minor: number };

/** Parses "1.35" / "1.35.6" / "v1.35" into its (major, minor), ignoring patch + leading "v". */
function parseMinor(v: string | undefined): Minor | null {
	if (!v) return null;
	// Trim, strip a leading "v", trim AGAIN — mirroring Go's
	// TrimSpace(TrimPrefix(TrimSpace(v), "v")), so "v 1.35" parses on both sides.
	//
	// goTrimSpace, NOT `.trim()`. The two whitespace sets differ at the edges and the difference is
	// live in both directions: JS strips U+FEFF (ZWNBSP), which `unicode.IsSpace` does not, so
	// "\uFEFF1.35" was JUDGED here and `not_evaluable` at the apply gate; Go strips U+0085 (NEL),
	// which JS does not, so "\u00851.35" was the reverse. Mirroring the parse while using a
	// different trim leaves the divergence sitting one character upstream of the part that agrees.
	const trimmed = goTrimSpace(goTrimSpace(v).replace(/^v/, ""));
	const parts = trimmed.split(".");
	if (parts.length < 2) return null;
	const major = atoi(parts[0]);
	const minor = atoi(parts[1]);
	if (major === null || minor === null) return null;
	return { major, minor };
}

/**
 * Go's `strconv.Atoi`, exactly — an optional sign then decimal digits, and nothing else.
 *
 * This replaced `Number()` + `Number.isInteger`, which was far laxer than Atoi and made this
 * engine disagree with the apply gate on malformed input. `Number("")` is 0 and
 * `Number.isInteger(0)` is true, so `"1."` parsed as {1, 0}; `Number` also accepts surrounding
 * whitespace, `0x` and exponent forms. The result was that `"1."`, `".5"`, `"1. 35"`, `"1.0x10"`
 * and `"1.1e2"` were JUDGED here — shown to the user as a pass or a fail — while
 * packages/core/compat returned `not_evaluable` and the apply gate refused to decide. The two
 * ends of a fail-closed gate must agree about what they cannot read.
 *
 * The int64 bound is Atoi's, and it is checked on the DIGIT STRING rather than on a number: a
 * double cannot represent the boundary, and BigInt literals need an ES2020 target the console
 * does not use. Comparing equal-length digit strings lexicographically IS numeric comparison, so
 * the accept/reject decision matches Go for every input, not only for those a double holds
 * exactly. The returned number loses precision above 2^53, which is irrelevant here — nothing
 * that large is a version, and what the fixture pins is which side accepts.
 */
function atoi(s: string | undefined): number | null {
	if (s === undefined || !/^[+-]?\d+$/.test(s)) return null;
	// Two's complement: the negative range extends one further than the positive.
	const limit = s.startsWith("-") ? "9223372036854775808" : "9223372036854775807";
	const digits = s.replace(/^[+-]/, "").replace(/^0+(?=\d)/, "");
	if (digits.length > limit.length || (digits.length === limit.length && digits > limit)) return null;
	return Number(s);
}

function minorEquals(a: Minor | null, b: Minor): boolean {
	return a !== null && a.major === b.major && a.minor === b.minor;
}

/** Orders two parsed minors: -1 if a<b, 0 if equal, 1 if a>b. */
function cmpMinor(a: Minor, b: Minor): number {
	if (a.major !== b.major) return a.major < b.major ? -1 : 1;
	if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
	return 0;
}

/**
 * Tallies the summary and computes the verdict by precedence
 * fail > warn > not_evaluable > pass (an empty report is not_evaluable).
 */
function finalize(controls: CompatControlResult[]): CompatReport {
	const summary: CompatSummary = { pass: 0, fail: 0, warn: 0, not_evaluable: 0 };
	for (const c of controls) {
		if (c.status === "pass") summary.pass++;
		else if (c.status === "fail") summary.fail++;
		else if (c.status === "warn") summary.warn++;
		else summary.not_evaluable++;
	}
	let verdict: CompatStatus;
	if (summary.fail > 0) verdict = "fail";
	else if (summary.warn > 0) verdict = "warn";
	else if (summary.not_evaluable > 0) verdict = "not_evaluable";
	else if (summary.pass > 0) verdict = "pass";
	else verdict = "not_evaluable";
	return { verdict, catalog_version: MATRIX.catalog_version, controls, summary };
}

/** Finds a component's recorded release by version. */
function findRelease(componentId: string, version: string): ComponentRelease | undefined {
	return MATRIX.components
		.find((c) => c.id === componentId)
		?.versions.find((r) => r.version === version);
}
