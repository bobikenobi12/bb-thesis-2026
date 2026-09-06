// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Package validate is the Go half of the shared validation contract (#3670).
//
// A zod schema in the console mixes two kinds of rule: DECLARATIVE ones a JSON Schema can carry
// (a length bound, a pattern, an enum) and ARBITRARY CLOSURES it cannot (`.refine`, `.superRefine`,
// `.transform`, `.trim`). `z.toJSONSchema` drops the second kind SILENTLY — measured, not assumed:
// `z.toJSONSchema(z.string().min(1).refine(f))` returns `{"type":"string","minLength":1}` with no
// trace that `f` ever existed. Projecting a schema through it and shipping the result would hand the
// CLI validation that LOOKS shared while half of it is missing.
//
// So the split is made visible instead. apps/console/scripts/gen-go-validation.ts walks the real
// schema, classifies every node, and REFUSES TO GENERATE unless each unprojectable node is
// explicitly disposed of. `spec_gen.go` (this package) and `testdata/validation-cases.json` are what
// it writes.
//
// # The invariant
//
//	The CLI may only ever reject what the server would certainly reject.
//
// Drift may make the CLI too permissive — the server catches that on apply — but it must never make
// the CLI refuse valid input. Three consequences are load-bearing here and are each tested:
//
//   - A step naming a rule this package does not implement is SKIPPED at runtime, not treated as a
//     failure. Fail-closed is the wrong default for a client-side pre-check: it would refuse input
//     the server accepts. The build is what fails instead — TestEverySpecRuleResolves.
//   - A rule the server merely WARNS about (or silently drops) carries SeverityWarn, so the CLI
//     never turns a server-side drop into a client-side refusal.
//   - Nothing in a spec is ever executed. A Step names a rule; this package owns the fixed registry
//     of implementations. A spec fetched from a server can therefore add data but never behaviour.
package validate

import (
	"fmt"
	"regexp"
	"sync"
)

// Severity says what a violated step means to the caller.
type Severity string

const (
	// SeverityReject marks a step the server would certainly reject. The CLI may refuse the input.
	SeverityReject Severity = "reject"
	// SeverityWarn marks a step whose server-side disposition is NOT rejection — the value is
	// dropped, ignored, or normalised away. The CLI must surface it and carry on.
	SeverityWarn Severity = "warn"
)

// StepKind enumerates the step shapes this package can evaluate. A generated spec carrying any
// other kind is skipped by Check (see the invariant) and named by UnresolvedRules, which
// TestEverySpecRuleResolves runs over every shipped spec.
type StepKind string

const (
	// StepMinLength / StepMaxLength bound the value's length in RUNES, not bytes — the console
	// counts UTF-16 code units and Go would otherwise disagree on any non-BMP input.
	StepMinLength StepKind = "min_length"
	StepMaxLength StepKind = "max_length"
	// StepPattern is an RE2-compatible regular expression projected from a zod `.regex()`.
	StepPattern StepKind = "pattern"
	// StepRule names a predicate in this package's registry — the "table" disposition. Both sides
	// implement it independently and testdata/validation-cases.json holds them to the same answers.
	StepRule StepKind = "rule"
	// StepTransform names a value rewrite in this package's registry. It runs BEFORE the steps that
	// follow it, exactly as the zod pipe orders it.
	StepTransform StepKind = "transform"
)

// Step is one ordered element of a spec. Only the fields its Kind uses are populated; the rest are
// zero. Pointers mark "absent" for the numeric fields so a legitimate 0 bound is distinguishable
// from an unset one.
type Step struct {
	Kind     StepKind `json:"kind"`
	Severity Severity `json:"severity"`
	// Message is what the CLI shows. It is the console's own message wherever the console has one,
	// so the two surfaces say the same words about the same input.
	Message string `json:"message,omitempty"`

	Length  *int   `json:"length,omitempty"`  // StepMinLength / StepMaxLength
	Pattern string `json:"pattern,omitempty"` // StepPattern

	Rule string `json:"rule,omitempty"` // StepRule / StepTransform
	// RuleArg is the single integer argument a parameterised rule takes (the per-cloud CIDR floor
	// is the only one today). A rule that takes no argument leaves it nil.
	RuleArg *int `json:"ruleArg,omitempty"`
}

// UnsharedRule records a rule that one surface applies and the other deliberately does NOT. It
// carries no behaviour: it exists so a reader of spec_gen.go — and `alethia ... --explain` — can see
// that the split was a decision with a reason, not an omission.
//
// This is the second of the generator's two escape routes for a rule JSON Schema cannot carry. The
// first is the conformance table. There is no third, and no default.
type UnsharedRule struct {
	Rule string `json:"rule"`
	Why  string `json:"why"`
}

// Spec is one field's shared validation contract.
type Spec struct {
	ID string `json:"id"`
	// Why the field is shared at all — carried through from the generator's registry.
	Why string `json:"why"`
	// Optional and Nullable both WIDEN, so they are safe to project: they can only make the CLI
	// accept more. `Accepts` is what reads them — `Check` takes a value that is present by
	// construction and has nothing to say about an absent one.
	Optional bool `json:"optional"`
	Nullable bool `json:"nullable"`

	Steps    []Step         `json:"steps"`
	Unshared []UnsharedRule `json:"unshared,omitempty"`
}

// Finding is one violated step.
type Finding struct {
	SpecID   string
	Kind     StepKind
	Rule     string
	Severity Severity
	Message  string
}

// Rejected reports whether any finding is severe enough to refuse the input.
func Rejected(findings []Finding) bool {
	for _, f := range findings {
		if f.Severity == SeverityReject {
			return true
		}
	}
	return false
}

// Predicate is a table-shared rule's Go implementation. `arg` is Step.RuleArg, nil when the rule
// takes none; a rule that needs an argument and is handed nil must report OK (abstain) rather than
// guess a bound.
type Predicate func(v string, arg *int) bool

// Transform is a table-shared value rewrite's Go implementation.
type Transform func(v string) string

// Lookup returns the named predicate/transform. Both return ok=false for an unknown name; every
// caller must then SKIP the step rather than fail it — see the package invariant.
func LookupPredicate(name string) (Predicate, bool) { p, ok := predicates[name]; return p, ok }
func LookupTransform(name string) (Transform, bool) { t, ok := transforms[name]; return t, ok }

// patternCache compiles each projected pattern once. A pattern that does not compile under RE2 is
// cached as nil and its step is SKIPPED — a pattern the CLI cannot read must not become a refusal.
var (
	patternMu    sync.Mutex
	patternCache = map[string]*regexp.Regexp{}
)

func compiled(pattern string) *regexp.Regexp {
	patternMu.Lock()
	defer patternMu.Unlock()
	if re, seen := patternCache[pattern]; seen {
		return re
	}
	re, err := regexp.Compile(pattern)
	if err != nil {
		re = nil
	}
	patternCache[pattern] = re
	return re
}

// Check evaluates `value` against `spec` and returns every violated step, in step order.
//
// It returns findings, never an error: a spec this build cannot fully evaluate produces FEWER
// findings, which is the permissive direction the invariant requires. UnresolvedRules is how a
// caller (and TestEverySpecRuleResolves) learns that happened.
func Check(spec Spec, value string) []Finding {
	var findings []Finding
	v := value
	for _, step := range spec.Steps {
		ok, evaluated := evalStep(step, &v)
		if !evaluated || ok {
			continue
		}
		findings = append(findings, Finding{
			SpecID:   spec.ID,
			Kind:     step.Kind,
			Rule:     step.Rule,
			Severity: step.Severity,
			Message:  step.Message,
		})
	}
	return findings
}

// evalStep runs one step. It reports (passed, evaluated); evaluated=false means this build could
// not judge the step, which Check treats as a pass.
//
// `v` is a pointer because StepTransform rewrites the value every later step sees — the zod pipe
// orders `.transform()` before the checks that follow it, and a Go side that validated the
// UNTRIMMED value would refuse input the server trims and accepts.
func evalStep(step Step, v *string) (bool, bool) {
	switch step.Kind {
	case StepMinLength:
		if step.Length == nil {
			return true, false
		}
		return len([]rune(*v)) >= *step.Length, true
	case StepMaxLength:
		if step.Length == nil {
			return true, false
		}
		return len([]rune(*v)) <= *step.Length, true
	case StepPattern:
		re := compiled(step.Pattern)
		if re == nil {
			return true, false
		}
		return re.MatchString(*v), true
	case StepRule:
		p, ok := LookupPredicate(step.Rule)
		if !ok {
			return true, false
		}
		return p(*v, step.RuleArg), true
	case StepTransform:
		t, ok := LookupTransform(step.Rule)
		if !ok {
			return true, false
		}
		*v = t(*v)
		return true, true
	default:
		return true, false
	}
}

// UnresolvedRules lists the rule names a spec references that this build does not implement, and
// the step kinds it does not know. It is the seam a test uses to fail the BUILD for something Check
// deliberately tolerates at runtime.
func UnresolvedRules(spec Spec) []string {
	var missing []string
	for i, step := range spec.Steps {
		switch step.Kind {
		case StepRule:
			if _, ok := LookupPredicate(step.Rule); !ok {
				missing = append(missing, fmt.Sprintf("%s.steps[%d]: no predicate %q", spec.ID, i, step.Rule))
			}
		case StepTransform:
			if _, ok := LookupTransform(step.Rule); !ok {
				missing = append(missing, fmt.Sprintf("%s.steps[%d]: no transform %q", spec.ID, i, step.Rule))
			}
		case StepMinLength, StepMaxLength:
			if step.Length == nil {
				missing = append(missing, fmt.Sprintf("%s.steps[%d]: %s with no length", spec.ID, i, step.Kind))
			}
		case StepPattern:
			if compiled(step.Pattern) == nil {
				missing = append(missing, fmt.Sprintf("%s.steps[%d]: pattern %q does not compile under RE2", spec.ID, i, step.Pattern))
			}
		default:
			missing = append(missing, fmt.Sprintf("%s.steps[%d]: unknown step kind %q", spec.ID, i, step.Kind))
		}
	}
	return missing
}

// Accepts evaluates a value that may be ABSENT — a flag the user did not pass, a JSON key that is
// not there. nil means absent.
//
// zod's `.optional()` / `.nullable()` are the only things that say an absent value is allowed, and
// they are the only wrappers this generator projects, so an absent value on a spec carrying neither
// is a real refusal rather than a gap. The two are folded together on purpose: a CLI flag is either
// given or not, and there is no third state for `null` to occupy — treating either wrapper as
// permission is the widening direction, which the invariant allows.
func Accepts(spec Spec, value *string) []Finding {
	if value == nil {
		if spec.Optional || spec.Nullable {
			return nil
		}
		return []Finding{{
			SpecID:   spec.ID,
			Severity: SeverityReject,
			Message:  "is required",
		}}
	}
	return Check(spec, *value)
}

// Get returns the compiled-in spec for an id. The CLI compiles its specs in so `alethia project
// create` validates a field offline; a fetched spec is a later, separate concern (#3671).
func Get(id string) (Spec, bool) {
	s, ok := Specs[id]
	return s, ok
}
