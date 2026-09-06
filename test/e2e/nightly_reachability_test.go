// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Guard: a T2 scenario that the nightly workflow never passes an env var for is DEAD CODE that
// looks alive. The harness compiles, its unit tests pass, the board says the scenario shipped — and
// it never runs, because nothing ever sets its enable flag.
//
// This is not hypothetical. #1341 shipped the vcluster-placement harness with no
// ALETHIA_E2E_VCLUSTER anywhere in e2e-nightly.yml, and the day-2 access layer had the same gap;
// both sat silently unexecuted. That is the worst failure mode a test suite has, because coverage
// looks like it grew.
//
// This file carries TWO guards, because the first one could not catch #1047. It scans the variables
// that harness files READ — and there, the file was never written at all:
// scripts/e2e/registry-e2e.sh invoked `-run TestT2XacctRegistry`, a function that existed in no
// file, so it recorded BLOCKED forever while the parity board reported the vehicle as shipped. A
// script that names a test nobody wrote is indistinguishable, from the outside, from a lane waiting
// on a maintainer. TestScriptRunTargetsResolveToRealTests closes that.
package e2e

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"testing"
)

var alethiaE2EVar = regexp.MustCompile(`ALETHIA_E2E_[A-Z0-9_]+`)

// stripLineComments removes `#`-to-end-of-line comments from YAML/shell source, so a variable merely
// DISCUSSED in prose cannot satisfy the reachability guard — only one that is actually wired.
//
// It is deliberately naive about `#` inside quotes: over-stripping can only ever make the guard
// STRICTER (a real setter would have to be restated outside a string), and strictness is the safe
// direction for a guard whose whole job is to refuse a claim. Under-stripping is the failure that
// matters, and it is the one this closes.
func stripLineComments(src string) string {
	lines := strings.Split(src, "\n")
	for i, ln := range lines {
		if idx := strings.Index(ln, "#"); idx >= 0 {
			lines[i] = ln[:idx]
		}
	}
	return strings.Join(lines, "\n")
}

// nightlyExemptEnv are the ALETHIA_E2E_* knobs the nightly is NOT expected to pass, each with the
// reason it is exempt. Anything else the harness reads must be referenced by e2e-nightly.yml.
//
// The allowlist is the point: excluding a var is a deliberate, reviewed act with a stated reason,
// not something that happens by forgetting. Adding a scenario means either wiring it into the
// nightly or writing down here why it can never run there.
var nightlyExemptEnv = map[string]string{
	"ALETHIA_E2E_T1_REQUIRE":              "T1 is hermetic (kind) and runs from ci.yml, not the nightly",
	"ALETHIA_E2E_T1_RUNNER_LOG":           "T1 only",
	"ALETHIA_E2E_T1_WAIT":                 "T1 only",
	"ALETHIA_E2E_T2_WAIT":                 "per-provider default resolved from the provider row; overridden only for local debugging",
	"ALETHIA_E2E_T2_TEARDOWN":             "per-provider default resolved from the provider row; overridden only for local debugging. Deliberately NOT a repo variable: ResolveT2Budget RESERVES this window in the go-timeout, so a value set on one side only would put the reservation and the destroy's own ceiling back out of step — which is the #2729 bug it was added to fix",
	"ALETHIA_E2E_ARGO_TIMEOUT":            "tuning knob with a sane default; overridden only for local debugging",
	"ALETHIA_E2E_B6_REQUIRE":              "the B6 promotion gate is its own build tag and its own workflow",
	"ALETHIA_E2E_A05_ENFORCE":             "A0.5 fidelity ramp: warn-only until the maintainer flips it, deliberately not wired yet",
	"ALETHIA_E2E_CLI_DEMO_ISSUER_TRUSTED": "the cli-demo connector beat needs an e2e console whose OIDC issuer the clouds actually trust; this one is started with NEXT_PUBLIC_APP_URL=http://localhost:3000 and no signing key, so the beat cannot COMPLETE in the nightly at any price. Deliberately NOT a repo variable: wiring it would make a paid connector dispatch reachable from CI before the identity it depends on exists. Set it by hand for a local run; wire it here when that console has a trusted issuer",
	"ALETHIA_E2E_A05_REAL_SNAPSHOT":       "A0.5 real-snapshot mode, enabled by hand during fidelity work",
	"ALETHIA_E2E_HCLOUD_REGION":           "legacy alias for ALETHIA_E2E_REGION, kept for back-compat only",
	"ALETHIA_E2E_DAY2_ACCESS_TIMEOUT":     "tuning knob for the day-2 layer; the layer's own enable var is wired",
	"ALETHIA_E2E_DAY2_OFFER_TIMEOUT":      "tuning knob bounding each day-2 plan; the layer's own enable var (ALETHIA_E2E_DAY2_OFFER) is wired",
	// Deliberately NOT wired, unlike every other keyless variable. The dwell must exceed the cloud
	// token's lifetime or the rotation assertion passes against a proxy that never rotates anything —
	// so its default (16m, past the 15m RDS-IAM TTL) IS the proof. Exposing it as a repo variable
	// would make weakening the strongest claim in the scenario a one-field edit that nothing reviews.
	// It stays a local-debugging override, and whatever dwell actually ran is recorded in the proof
	// bundle beside the verdict.
	"ALETHIA_E2E_KEYLESS_DB_DWELL": "the rotation dwell must exceed the cloud token TTL to prove anything, so its default is the proof — a local-debugging override, never a repo variable",
}

// TestScenarioEnablesReachTheNightly fails when the harness reads an ALETHIA_E2E_* variable that
// e2e-nightly.yml never sets and that is not explicitly exempted above.
//
// Being REFERENCED is all this asserts — every scenario is wired as `${{ vars.X }}`, so an unset
// repo variable still means a clean skip. The guard separates "a maintainer chose not to enable
// this" from "no maintainer CAN enable this", which is the bug it exists to catch.
func TestScenarioEnablesReachTheNightly(t *testing.T) {
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	dir := filepath.Dir(thisFile)

	// The SETTERS. A var counts as reachable if the workflow sets it, or if the dimension fidelity
	// table does — since #2356 the workflow delegates the per-dimension env to
	// scripts/e2e/resolve-dimension.sh (`--fidelity`) and appends its output to $GITHUB_ENV, so the
	// table is a genuine setter and scanning only the workflow would report a wired var as dead.
	setters := []string{
		filepath.Join(dir, "..", "..", ".github", "workflows", "e2e-nightly.yml"),
		filepath.Join(dir, "..", "..", "scripts", "e2e", "resolve-dimension.sh"),
	}
	inWorkflow := map[string]bool{}
	for _, p := range setters {
		src, rerr := os.ReadFile(p)
		if rerr != nil {
			t.Fatalf("read %s: %v", filepath.Base(p), rerr)
		}
		// COMMENTS DO NOT COUNT. This used to match the raw file, so a var merely NAMED in a comment
		// satisfied the guard — and #2356 moved the real `ALETHIA_E2E_SOAK` wiring out of the
		// workflow into the fidelity table while leaving a comment behind explaining the move. The
		// guard stayed green for the wrong reason: prose, not wiring. A guard a comment can satisfy
		// is a guard that has stopped asking its question.
		//
		// Scope, stated honestly: this asks "is the var wired ANYWHERE a setter could set it", not
		// "does every dimension emit the right value". The second question belongs to
		// `resolve-dimension.sh --self-test`, which asserts the table's per-dimension output directly
		// (delete the floor's `ALETHIA_E2E_SOAK=off` and five of its checks fail). Two guards, two
		// questions — this one would still pass on a var named only in that script's own test
		// assertions, and that is acceptable precisely because the other guard covers the emit.
		for _, v := range alethiaE2EVar.FindAllString(stripLineComments(string(src)), -1) {
			inWorkflow[v] = true
		}
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read harness dir: %v", err)
	}
	used := map[string]string{} // var -> the file that reads it
	for _, e := range entries {
		name := e.Name()
		if !strings.HasSuffix(name, ".go") {
			continue
		}
		// This guard's own allowlist mentions every exempt var; scanning it would be circular.
		if name == filepath.Base(thisFile) {
			continue
		}
		src, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			t.Fatalf("read %s: %v", name, err)
		}
		for _, v := range alethiaE2EVar.FindAllString(string(src), -1) {
			if _, seen := used[v]; !seen {
				used[v] = name
			}
		}
	}

	var unreachable []string
	for v, file := range used {
		if inWorkflow[v] {
			continue
		}
		if _, exempt := nightlyExemptEnv[v]; exempt {
			continue
		}
		unreachable = append(unreachable, v+" (read by "+file+")")
	}
	sort.Strings(unreachable)
	if len(unreachable) > 0 {
		t.Fatalf("these ALETHIA_E2E_* variables are read by the T2 harness but NEVER set by "+
			".github/workflows/e2e-nightly.yml, so the code that reads them can never run in the nightly:\n  %s\n\n"+
			"Either add them to the T2 step's env block (as `${{ vars.X }}`, which keeps them off until a "+
			"maintainer opts in) or add them to nightlyExemptEnv with the reason they can never run there.",
			strings.Join(unreachable, "\n  "))
	}

	// Guard the guard: a stale exemption means a var was renamed or deleted and the allowlist kept a
	// dead entry, which would quietly re-open the hole for the NEXT var with that name.
	for v := range nightlyExemptEnv {
		if _, stillUsed := used[v]; !stillUsed {
			t.Errorf("nightlyExemptEnv has a stale entry %q — no harness file reads it any more; remove it", v)
		}
	}
}

// goTestRunTarget matches a `go test … -run <target>` invocation, quoted or bare. Both forms occur in
// scripts/e2e/*.sh, and both have to be seen: registry-e2e.sh quoted its phantom target while
// provisioning-e2e.sh writes its real one bare.
var goTestRunTarget = regexp.MustCompile(`-run\s+"([^"]+)"|-run\s+([^\s"'\\]+)`)

// scriptRunTargetSkipDirs are trees that hold no first-party Go and are expensive to walk.
var scriptRunTargetSkipDirs = map[string]bool{
	".git": true, "node_modules": true, ".next": true, ".turbo": true,
	"dist": true, "build": true, "vendor": true, "coverage": true,
}

// TestScriptRunTargetsResolveToRealTests fails when a scripts/e2e/*.sh runner names a Go test
// function that does not exist anywhere in the repository.
//
// TestScenarioEnablesReachTheNightly (above) is structurally incapable of catching this. It scans the
// ALETHIA_E2E_* variables read by harness files that EXIST; when the harness was never written there
// is no file to scan, so the hole is invisible to it. That is precisely what happened in #1047:
// registry-e2e.sh ran `-run "TestT2XacctRegistry"` for months, `go test` matched no test, the script
// classified the empty run as BLOCKED — the same verdict a real quota block produces — and
// docs/testing/xacct-registry-parity.md went on naming the harness as the vehicle.
//
// The check is deliberately about EXISTENCE, not about wiring. A test that exists but is gated off is
// a maintainer's choice; a test that does not exist is a script that can never pass.
func TestScriptRunTargetsResolveToRealTests(t *testing.T) {
	root := repoRootFromThisFile(t)

	scripts, err := filepath.Glob(filepath.Join(root, "scripts", "e2e", "*.sh"))
	if err != nil {
		t.Fatalf("glob scripts/e2e: %v", err)
	}
	if len(scripts) == 0 {
		t.Fatal("no scripts/e2e/*.sh found — this guard would pass vacuously, which is the failure mode it exists to prevent")
	}

	// target -> the script(s) that name it.
	named := map[string][]string{}
	for _, path := range scripts {
		src, rerr := os.ReadFile(path)
		if rerr != nil {
			t.Fatalf("read %s: %v", path, rerr)
		}
		for _, m := range goTestRunTarget.FindAllStringSubmatch(string(src), -1) {
			raw := m[1]
			if raw == "" {
				raw = m[2]
			}
			for _, name := range runTargetNames(raw) {
				base := filepath.Base(path)
				if !contains(named[name], base) {
					named[name] = append(named[name], base)
				}
			}
		}
	}
	if len(named) == 0 {
		t.Fatal("no `-run` targets found in scripts/e2e/*.sh — the matcher stopped matching, so this guard is silently inert")
	}

	declared := map[string]bool{}
	fset := token.NewFileSet()
	walkErr := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil // an unreadable tree is not this guard's business
		}
		if d.IsDir() {
			if scriptRunTargetSkipDirs[d.Name()] {
				return fs.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(d.Name(), "_test.go") {
			return nil
		}
		// PARSED, not matched, for the same reason as the scenario guard below: `^func (Test\w*)\s*\(`
		// also matches a line inside a raw string literal or a block comment, and here that error
		// runs the PERMISSIVE way — a test name that exists only in prose joins `declared`, and a
		// script naming a function nobody wrote then resolves. That is the green-on-blindness
		// direction, on the guard whose whole subject is #1047: registry-e2e.sh ran
		// `-run "TestT2XacctRegistry"` for months against a function that existed in no file.
		//
		// Only the top-level declarations are read, so this does not walk each tree; measured at
		// well under a second across the repository. `parser.ParseFile` needs no build tags and gets
		// none: whether the function EXISTS is the question, and every one of these harnesses is
		// tag-gated.
		f, perr := parser.ParseFile(fset, path, nil, parser.SkipObjectResolution)
		if perr != nil {
			// Reported rather than skipped. A test file that does not parse is one whose functions
			// this guard cannot see, and passing over it silently is how the guard reports green on
			// exactly what it excluded.
			return fmt.Errorf("parse %s: %w", path, perr)
		}
		for _, decl := range f.Decls {
			fn, isFunc := decl.(*ast.FuncDecl)
			if isFunc && fn.Recv == nil && strings.HasPrefix(fn.Name.Name, "Test") {
				declared[fn.Name.Name] = true
			}
		}
		return nil
	})
	if walkErr != nil {
		t.Fatalf("walk repository: %v", walkErr)
	}
	if len(declared) == 0 {
		t.Fatal("no Go test functions found in the repository — the declaration matcher is broken, so every target would look unresolved")
	}

	var unresolved []string
	for name, from := range named {
		if declared[name] {
			continue
		}
		sort.Strings(from)
		unresolved = append(unresolved, name+" (named by "+strings.Join(from, ", ")+")")
	}
	sort.Strings(unresolved)
	if len(unresolved) > 0 {
		t.Fatalf("these `-run` targets are invoked by scripts/e2e/*.sh but exist in NO Go test file, so those scripts can never run anything:\n  %s\n\n"+
			"Either write the test, or point the script at the test that actually drives the scenario "+
			"(the layered T2 scenarios all run inside TestT2RealCloudProvisioning). A script naming a test "+
			"nobody wrote records BLOCKED forever, which reads exactly like a lane waiting on a maintainer.",
			strings.Join(unresolved, "\n  "))
	}
}

// runTargetNames normalizes a `-run` argument into the concrete test names it addresses.
//
// `-run` takes a regular expression: alternations select several tests, `/` separates subtest levels,
// and `^`/`$` anchor. Only the top-level name matters here, and anything carrying shell interpolation
// or genuine regex metacharacters is skipped rather than guessed at — a false accusation from this
// guard would be worse than a miss, because the next person would learn to ignore it.
func runTargetNames(raw string) []string {
	var out []string
	for _, part := range strings.Split(raw, "|") {
		name := strings.TrimSpace(part)
		name = strings.TrimPrefix(name, "^")
		name, _, _ = strings.Cut(name, "/") // subtest path — only the top-level func exists in source
		name = strings.TrimSuffix(name, "$")
		if name == "" || !strings.HasPrefix(name, "Test") {
			continue
		}
		// A shell variable or any regex metacharacter left over: not a literal test name.
		if strings.ContainsAny(name, `$*+?.()[]{}\`) {
			continue
		}
		out = append(out, name)
	}
	return out
}

// contains reports whether s is already in list.
func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

// TestScenarioApplyToSnapshotIsCalled is the third guard in this file, and it closes the gap the
// first two structurally cannot see.
//
// The existing guards ask "is the enable VARIABLE wired?" and "does the script name a REAL test?".
// #1773 satisfied both and still could not pass: ALETHIA_E2E_ACM_CERT was wired in e2e-nightly.yml,
// acmCertConfig.decide() turned the layer on, the provision test logged "ACM certificate ENABLED",
// and runT2AcmCert then asserted a certificate that nothing had ever asked the template to build.
// acmCertConfig.applyToSnapshot existed, was unit-tested, carried a comment saying "this assignment
// is what the floor path uses" — and was called from no production path at all.
//
// Run 32838291742 is the record: the plan carried no aws_acm_certificate, `route53_zone_id = ""`,
// and the verdict read `no aws_acm_certificate_validation in state`. A scenario that ASSERTS without
// CONFIGURING cannot go green, and no amount of retrying moves it.
//
// So: every scenario type that DEFINES an applyToSnapshot must have it CALLED from the one function
// that assembles the deploy snapshot. The check is a source grep for the same reason the guards
// above are — it has to hold about the code as written, not about a code path a test happened to
// take.
func TestScenarioApplyToSnapshotIsCalled(t *testing.T) {
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	dir := filepath.Dir(thisFile)
	self := filepath.Base(thisFile)

	// PARSE, DO NOT MATCH. Every question below used to be a regex over the file's text, and every
	// one of them was wrong at least once; scanScenarioWiring answers them from the syntax tree. The
	// argument for each is in that function's header.
	fset := token.NewFileSet()
	files := map[string]*ast.File{}
	err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(path, ".go") {
			return err
		}
		base := filepath.Base(path)
		// SKIP THIS FILE. The first version did not, and it self-satisfied: the literal
		// `"func t2DeploySnapshot("` appears in this very file, so the guard nominated ITSELF as the
		// assembler and then matched its own prose. Parsing makes a MENTION harmless, so this is no
		// longer load-bearing for that — but this file's fixtures below declare their own
		// t2DeploySnapshot inside string literals, and more to the point a guard that scans itself is
		// answering a question about the wrong program.
		if base == self {
			return nil
		}
		// BUILD TAGS ARE DELIBERATELY IGNORED, which parsing gives for free: the harness lives behind
		// `//go:build e2e_t2` and the question is whether the wiring EXISTS, not whether this build
		// includes it. `go vet` skipping a tagged file is a mistake this repo has already made.
		f, parseErr := parser.ParseFile(fset, path, nil, parser.SkipObjectResolution)
		if parseErr != nil {
			// Not skipped. A file this guard cannot read is a file whose scenarios it cannot see, and
			// silently passing over it is the exact green-on-blindness failure the guard exists to
			// catch — pointed at itself.
			return fmt.Errorf("parse %s: %w", base, parseErr)
		}
		files[base] = f
		return nil
	})
	if err != nil {
		t.Fatalf("walk %s: %v", dir, err)
	}

	w := scanScenarioWiring(files)
	defined, called, paramOf := w.defined, w.called, w.paramOf
	if w.dupFile != "" {
		// Two files declaring it is not a thing to resolve by last-write-wins; that is how a stray
		// file could silently blank the signature and produce several wrong diagnoses at once.
		t.Fatalf("%s is declared in both %s and %s — this guard cannot tell which assembles the snapshot",
			scenarioAssemblerName, w.assemblerFile, w.dupFile)
	}

	if len(defined) == 0 {
		t.Fatal("found no applyToSnapshot definitions at all — this guard is scanning the wrong tree " +
			"and would pass over any number of unwired scenarios")
	}
	if w.assemblerFile == "" {
		t.Fatal("found no t2DeploySnapshot declaration — either it was renamed or this guard stopped " +
			"finding it; both make every result below meaningless, so this fails rather than passes")
	}
	if len(called) == 0 {
		t.Fatal("found no applyToSnapshot CALLS inside t2DeploySnapshot — either every scenario is " +
			"unwired or the scan is broken; both make this guard vacuous, so it fails rather than passes")
	}

	for typeName, file := range defined {
		v, isParam := paramOf[typeName]
		if !isParam {
			t.Errorf("%s defines applyToSnapshot (%s) but is not even a parameter of t2DeploySnapshot — "+
				"the scenario cannot reach a real deploy snapshot at all. That is #1773: "+
				"ALETHIA_E2E_ACM_CERT was wired, decide() said yes, the run logged ENABLED, and the "+
				"plan carried no certificate because acmCertConfig was never passed in.", typeName, file)
			continue
		}
		if !called[v] {
			t.Errorf("%s (%s) is passed to t2DeploySnapshot as %q but %s.applyToSnapshot is never "+
				"called there — the scenario can turn ON, log that it is enabled, and then assert "+
				"against a snapshot it never configured. Call it AFTER MaxConfigSnapshot.",
				typeName, file, v, v)
		}
	}
}

// The two identifiers this guard is about, named once. They are the harness's contract with the
// nightly: a scenario type gets an applyToSnapshot method, and the assembler calls it.
const (
	scenarioMethodName    = "applyToSnapshot"
	scenarioAssemblerName = "t2DeploySnapshot"
)

// ── the scanning half, in go/ast rather than in regexes ───────────────────────────────────────────
//
// WHY THE REGEXES WENT. Four defects were fixed in #2581 and a fifth in #2599, and all five are the
// same shape — a regex that does not describe Go:
//
//   · `func \(([a-z]) (\w+)\) applyToSnapshot\(` missed `func (cfg X)` and `func (c *X)`. Both are
//     idiomatic, no reviewer would flag either, and both silently dropped a scenario out of the
//     `defined` set — so the guard reported GREEN on a completely unwired scenario, which is #1773.
//   · `([a-zA-Z0-9_]+) ([a-zA-Z0-9_]+)(?:,|\))` could never resolve the LAST parameter, because the
//     captured signature had no closing paren for the `\)` branch to reach. The end of the parameter
//     list is exactly where the next scenario gets appended, as acmCert was.
//   · `strings.Contains(text, "func t2DeploySnapshot(")` nominated any file that merely MENTIONED
//     the name — including this guard's own source, which made it exempt every scenario forever.
//   · `stripGoComments` treated `//` and `/*` inside string literals as comments, so a glob like
//     `"**/*.go"` could delete a real definition out from under the matcher.
//
// Each was fixed by making a pattern more careful, and the next one would have been fixed the same
// way. The failure mode never changed: the guard reports green on a scenario it failed to SEE, which
// is the exact defect it exists to catch.
//
// go/parser answers all four exactly. A receiver is `FuncDecl.Recv`, in every form there is. A
// parameter list is `FuncType.Params`, last entry included, grouped names included. A declaration is
// a `FuncDecl` and never a mention. And comments and string literals are already distinguished by
// the tokeniser, so `stripGoComments` — a small parser, hand-written in front of a hand-written
// matcher — disappears entirely rather than getting another fix.
//
// ONE THING GOT STRICTER RATHER THAN JUST EXACTER. "Calls only count from the assembler" used to be
// a FILE-level approximation: every `x.applyToSnapshot(` anywhere in the file that declared
// t2DeploySnapshot counted. Now only calls inside that function's own body do. A call from a
// neighbouring helper in the same file no longer exempts a scenario from the wiring it is supposed
// to have.

// scenarioWiring is what the applyToSnapshot guard needs to know about the harness, extracted from
// the syntax tree rather than from the text.
type scenarioWiring struct {
	// defined maps a scenario TYPE name to the file that gives it an applyToSnapshot method.
	defined map[string]string
	// paramOf maps a scenario type name to the parameter name t2DeploySnapshot receives it as.
	// `t2ArgoRepos` arrives as `repos` and `secretsXacctConfig` as `xacct`, so this cannot be
	// guessed from string similarity — a guard that guesses either cries wolf or gets loosened
	// until it catches nothing.
	paramOf map[string]string
	// called is the set of parameter names on which applyToSnapshot is called INSIDE the assembler.
	called map[string]bool
	// assemblerFile is the file declaring t2DeploySnapshot; empty when none was found.
	assemblerFile string
	// dupFile is a second file declaring it. Two declarations is not a thing to resolve by
	// last-write-wins — that is how a stray file could silently blank the signature and produce
	// several wrong diagnoses at once.
	dupFile string
}

// baseTypeName reduces a type expression to the identifier a scenario is known by: `*T` → `T`,
// `pkg.T` → `T`, `T[X]` → `T`. Anything with no identifier at its root (a func type, a map, a
// channel) is not a scenario type and yields "".
func baseTypeName(e ast.Expr) string {
	switch t := e.(type) {
	case *ast.Ident:
		return t.Name
	case *ast.StarExpr:
		return baseTypeName(t.X)
	case *ast.SelectorExpr:
		return t.Sel.Name
	case *ast.IndexExpr: // a generic instantiation, T[X]
		return baseTypeName(t.X)
	case *ast.IndexListExpr: // T[X, Y]
		return baseTypeName(t.X)
	default:
		return ""
	}
}

// scanScenarioWiring reads the parsed harness. Keyed by file BASE NAME so the assertions can name
// the file, and so the test below can drive it with fixtures instead of a directory.
func scanScenarioWiring(files map[string]*ast.File) *scenarioWiring {
	w := &scenarioWiring{
		defined: map[string]string{},
		paramOf: map[string]string{},
		called:  map[string]bool{},
	}
	// Sorted, so a duplicate-declaration diagnosis names the same two files every run rather than
	// whichever the map handed back first.
	names := make([]string, 0, len(files))
	for name := range files {
		names = append(names, name)
	}
	sort.Strings(names)

	for _, base := range names {
		file := files[base]
		for _, decl := range file.Decls {
			fn, isFunc := decl.(*ast.FuncDecl)
			if !isFunc {
				continue
			}
			// A METHOD named applyToSnapshot. Recv carries the receiver in every form Go allows —
			// value or pointer, named anything or nothing — so there is no pattern to get wrong.
			if fn.Recv != nil && len(fn.Recv.List) == 1 && fn.Name.Name == scenarioMethodName {
				if typeName := baseTypeName(fn.Recv.List[0].Type); typeName != "" {
					w.defined[typeName] = base
				}
				continue
			}
			if fn.Recv != nil || fn.Name.Name != scenarioAssemblerName {
				continue
			}
			// The assembler's DECLARATION. A FuncDecl is never a mention, so the guard can no longer
			// nominate a file — its own included — for talking about the function.
			if w.assemblerFile != "" && w.assemblerFile != base {
				w.dupFile = base
				continue
			}
			w.assemblerFile = base
			if fn.Type.Params != nil {
				for _, field := range fn.Type.Params.List {
					typeName := baseTypeName(field.Type)
					if typeName == "" {
						continue
					}
					// `for _, name := range field.Names` covers BOTH the grouped form
					// (`a, b scenarioConfig`) and the last parameter, which the regex could not
					// reach at all. An unnamed parameter has no Names and is simply not a binding.
					for _, name := range field.Names {
						w.paramOf[typeName] = name.Name
					}
				}
			}
			// Calls inside the assembler's OWN BODY, which is the stricter half: a call from a
			// neighbouring helper in the same file used to count and no longer does.
			if fn.Body != nil {
				ast.Inspect(fn.Body, func(n ast.Node) bool {
					call, isCall := n.(*ast.CallExpr)
					if !isCall {
						return true
					}
					sel, isSel := call.Fun.(*ast.SelectorExpr)
					if !isSel || sel.Sel.Name != scenarioMethodName {
						return true
					}
					if recv, isIdent := sel.X.(*ast.Ident); isIdent {
						w.called[recv.Name] = true
					}
					return true
				})
			}
		}
	}
	return w
}

// The questions the retired regexes were asked, put to the extractor instead. Every one of these is
// a defect that actually shipped, so they are ported rather than dropped: a rewrite that quietly
// stops asking is how a fixed bug comes back.
func parseWiringFixture(t *testing.T, src string) *scenarioWiring {
	t.Helper()
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, "fixture.go", src, parser.SkipObjectResolution)
	if err != nil {
		t.Fatalf("fixture does not parse: %v", err)
	}
	return scanScenarioWiring(map[string]*ast.File{"fixture.go": file})
}

// #2581's first defect. `func (cfg X)` and `func (c *X)` are idiomatic Go no reviewer would flag,
// and the original pattern — a single-letter VALUE receiver — matched neither, dropping the
// scenario out of `defined` entirely so the guard reported green on an unwired one.
func TestScenarioDefinerReadsEveryReceiverForm(t *testing.T) {
	for _, recv := range []string{
		"c acmCertConfig",
		"cfg acmCertConfig",
		"c *acmCertConfig",
		"cfg *acmCertConfig",
		"acmCertConfig",   // an unnamed receiver is legal and still defines the method
		"_ acmCertConfig", // and so is a blank one
	} {
		src := "package e2e\nfunc (" + recv + ") applyToSnapshot(s *snap) {}\n"
		w := parseWiringFixture(t, src)
		if _, ok := w.defined["acmCertConfig"]; !ok {
			t.Errorf("receiver %q: acmCertConfig not recorded as defining applyToSnapshot", recv)
		}
	}
}

// #2581's third defect. The assembler used to be nominated by `strings.Contains` on its own name,
// so any file MENTIONING it — this guard's own source above all — became the assembler, and the
// calls "found" there exempted scenarios forever.
func TestScenarioAssemblerIsADeclarationAndNeverAMention(t *testing.T) {
	w := parseWiringFixture(t, `package e2e

// t2DeploySnapshot assembles the snapshot; this sentence is not a declaration.
const doc = "func t2DeploySnapshot(cfg acmCertConfig) {"

func notTheAssembler() { _ = "t2DeploySnapshot" }
`)
	if w.assemblerFile != "" {
		t.Errorf("a mention in a comment and a string literal nominated %q as the assembler", w.assemblerFile)
	}
	if len(w.paramOf) != 0 {
		t.Errorf("parameters were read out of prose: %v", w.paramOf)
	}
}

// #2581's second defect, and the one with a name attached: the LAST parameter could never be
// resolved, and the end of the parameter list is exactly where the next scenario gets appended —
// as acmCert was.
func TestScenarioParamsResolveIncludingTheLast(t *testing.T) {
	w := parseWiringFixture(t, `package e2e

func t2DeploySnapshot(repos t2ArgoRepos, xacct secretsXacctConfig, cert acmCertConfig) (*snap, error) {
	return nil, nil
}
`)
	for typeName, want := range map[string]string{
		"t2ArgoRepos":        "repos",
		"secretsXacctConfig": "xacct",
		"acmCertConfig":      "cert", // the last one
	} {
		if got := w.paramOf[typeName]; got != want {
			t.Errorf("%s resolved to %q, want %q", typeName, got, want)
		}
	}
}

// A shape the regex never handled at all, rather than handled wrongly. Grouped parameters are
// ordinary Go, and a scenario appended into a group would have been invisible.
func TestScenarioParamsResolveGroupedAndPointerForms(t *testing.T) {
	w := parseWiringFixture(t, `package e2e

func t2DeploySnapshot(a, b scenarioCfg, c *ptrCfg) {}
`)
	// Both names bind the same type; recording either proves the group was walked. The guard only
	// needs one of them to exist, and asserting a specific winner would pin an arbitrary choice.
	if got := w.paramOf["scenarioCfg"]; got != "a" && got != "b" {
		t.Errorf("grouped parameters not resolved: %q", got)
	}
	if got := w.paramOf["ptrCfg"]; got != "c" {
		t.Errorf("pointer parameter resolved to %q, want \"c\"", got)
	}
}

// #2599's defect, retired rather than fixed again. `stripGoComments` was a hand-written comment
// stripper in front of a hand-written matcher — a small parser, written twice, badly — and it read
// `//` and `/*` INSIDE string literals as the start of a comment. The tokeniser has always known
// the difference, so the whole function is gone and this asserts why it can be.
func TestCallsInCommentsAndStringsDoNotCount(t *testing.T) {
	w := parseWiringFixture(t, `package e2e

func (c acmCertConfig) applyToSnapshot(s *snap) {}

func t2DeploySnapshot(cert acmCertConfig) {
	// cert.applyToSnapshot(s) — described, not called
	_ = "cert.applyToSnapshot(s)"
	_ = `+"`cert.applyToSnapshot(s)`"+`
	/* cert.applyToSnapshot(s) */
	_ = "a glob like **/*.go used to break the stripper"
}
`)
	if w.called["cert"] {
		t.Error("a call written in a comment or a string literal counted as a call")
	}
	if _, ok := w.defined["acmCertConfig"]; !ok {
		t.Error("the real definition was lost — the string literal containing */ broke the scan")
	}
}

// The half that got STRICTER rather than merely exacter. "Calls only count from the assembler" was
// a file-level approximation: any call anywhere in the file that declared t2DeploySnapshot counted,
// so a neighbouring helper could exempt a scenario from the wiring it is supposed to have.
func TestOnlyCallsInsideTheAssemblerCount(t *testing.T) {
	w := parseWiringFixture(t, `package e2e

func (c acmCertConfig) applyToSnapshot(s *snap) {}

func someHelper(cert acmCertConfig, s *snap) { cert.applyToSnapshot(s) }

func t2DeploySnapshot(cert acmCertConfig) {}
`)
	if w.called["cert"] {
		t.Error("a call from a neighbouring function in the same file counted as assembler wiring")
	}
}

// baseTypeName's branches, because an extractor's unexercised branch is exactly where a scenario
// goes missing — which is the whole failure mode this guard exists to prevent, one level down.
func TestBaseTypeNameReducesEveryFormAScenarioCanTake(t *testing.T) {
	for src, want := range map[string]string{
		"package e2e\nfunc (c acmCertConfig) applyToSnapshot() {}\n":     "acmCertConfig",
		"package e2e\nfunc (c *acmCertConfig) applyToSnapshot() {}\n":    "acmCertConfig",
		"package e2e\nfunc (c acmCertConfig[T]) applyToSnapshot() {}\n":  "acmCertConfig",
		"package e2e\nfunc (c *acmCertConfig[T]) applyToSnapshot() {}\n": "acmCertConfig",
	} {
		w := parseWiringFixture(t, src)
		if _, ok := w.defined[want]; !ok {
			t.Errorf("%q did not reduce to %q; got %v", src, want, w.defined)
		}
	}

	// A receiver with no identifier at its root is not a scenario type, and must not be recorded as
	// an empty-string key — a "" entry would be reported as a scenario nobody can find.
	w := parseWiringFixture(t, "package e2e\ntype fn func()\nfunc (c fn) applyToSnapshot() {}\n")
	if _, bad := w.defined[""]; bad {
		t.Error("an unresolvable receiver was recorded under the empty type name")
	}
}

func TestCallsInsideTheAssemblerAreFound(t *testing.T) {
	w := parseWiringFixture(t, `package e2e

func (c acmCertConfig) applyToSnapshot(s *snap) {}

func t2DeploySnapshot(cert acmCertConfig) {
	if true {
		for range []int{1} {
			cert.applyToSnapshot(nil)
		}
	}
}
`)
	if !w.called["cert"] {
		t.Error("a call nested inside the assembler's body was not found — Inspect must walk the whole body")
	}
}
