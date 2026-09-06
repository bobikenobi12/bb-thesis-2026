// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package spec

import (
	"strings"
	"testing"

	"github.com/spf13/cobra"
)

// probe is the spec every test below drives. It carries one field of each shape the kit has to
// render — a positional, a plain flag, a constrained flag with a default, a boolean, and a field
// with an env var and a manifest key — so a change that breaks one shape cannot pass by being
// invisible in the fixture.
func probe() Spec {
	return Spec{
		Command: "alethia probe run",
		Fields: []Field{
			{Command: "alethia probe run", Key: "name", Title: "Name", Description: "what to call it",
				Arg: "[name]", Required: true, ManifestKey: "name"},
			{Command: "alethia probe run", Key: "region", Title: "Region", Description: "where to run",
				Flag: "region", Required: true, EnvVar: "ALETHIA_PROBE_REGION", ManifestKey: "cloud.region"},
			{Command: "alethia probe run", Key: "stage", Title: "Stage", Description: "which stage",
				Flag: "stage", Default: "development", Options: "stages"},
			{Command: "alethia probe run", Key: "force", Title: "Force", Description: "skip the gate",
				Flag: "force", Shorthand: "f", Bool: true},
			{Command: "alethia probe run", Key: "note", Title: "Note", Description: "an optional note",
				Flag: "note", Usage: "an optional note (terse)", Docs: "an optional note (for the table)"},
		},
		Options: map[string][]string{"stages": {"development", "staging", "production"}},
	}
}

func bind(t *testing.T, s Spec, argv ...string) *Binder {
	t.Helper()
	cmd := &cobra.Command{Use: "run", RunE: func(*cobra.Command, []string) error { return nil }}
	b := RegisterFlags(cmd, s)
	cmd.SetArgs(argv)
	cmd.SetOut(nil)
	if err := cmd.Execute(); err != nil {
		t.Fatalf("execute %v: %v", argv, err)
	}
	return b
}

func TestSpecValidates(t *testing.T) {
	if err := probe().Validate(); err != nil {
		t.Fatalf("the probe spec must be valid: %v", err)
	}
}

// The Flag/Arg rule is the mechanical half of "flags are a complete contract". A field with neither
// is the defect that made `init --no-input` unable to do init's job, so it is the case worth pinning
// hardest.
func TestFieldValidateRefusesTheUnscriptableAndTheAmbiguous(t *testing.T) {
	base := Field{Command: "alethia x", Key: "k", Title: "T", Description: "d", Flag: "flag"}
	cases := map[string]struct {
		mutate func(*Field)
		want   string
	}{
		"neither flag nor arg": {func(f *Field) { f.Flag = "" }, "neither Flag nor Arg"},
		"both flag and arg":    {func(f *Field) { f.Arg = "[x]" }, "one field, one spelling"},
		"no command":           {func(f *Field) { f.Command = "" }, "no Command"},
		"no key":               {func(f *Field) { f.Key = "" }, "no Key"},
		"no title":             {func(f *Field) { f.Title = "" }, "no Title"},
		"no description":       {func(f *Field) { f.Description = "" }, "no Description"},
		"shorthand on a positional": {func(f *Field) {
			f.Flag, f.Arg, f.Shorthand = "", "[x]", "x"
		}, "Shorthand"},
		"long shorthand": {func(f *Field) { f.Shorthand = "ab" }, "more than one character"},
		"bool positional": {func(f *Field) {
			f.Flag, f.Arg, f.Bool = "", "[x]", true
		}, "Bool on a positional"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			f := base
			tc.mutate(&f)
			err := f.Validate()
			if err == nil {
				t.Fatalf("want a refusal naming %q, got none", tc.want)
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Errorf("refusal = %q, want it to name %q", err, tc.want)
			}
		})
	}
	if err := base.Validate(); err != nil {
		t.Errorf("the unmutated field must be valid, got %v", err)
	}
}

func TestSpecValidateRefusesTheBetweenFieldFaults(t *testing.T) {
	dup := probe()
	dup.Fields = append(dup.Fields, Field{Command: "alethia probe run", Key: "region",
		Title: "T", Description: "d", Flag: "other"})
	if err := dup.Validate(); err == nil || !strings.Contains(err.Error(), "duplicate key") {
		t.Errorf("duplicate key: got %v", err)
	}

	dupFlag := probe()
	dupFlag.Fields = append(dupFlag.Fields, Field{Command: "alethia probe run", Key: "other",
		Title: "T", Description: "d", Flag: "region"})
	if err := dupFlag.Validate(); err == nil || !strings.Contains(err.Error(), "duplicate flag") {
		t.Errorf("duplicate flag: got %v", err)
	}

	// An Options name with no values would validate nothing while LOOKING like it validated
	// something — the shape of a guard that reports green.
	orphan := probe()
	orphan.Options = nil
	if err := orphan.Validate(); err == nil || !strings.Contains(err.Error(), "no values") {
		t.Errorf("orphan Options name: got %v", err)
	}

	empty := Spec{Command: "alethia x"}
	if err := empty.Validate(); err == nil || !strings.Contains(err.Error(), "no fields") {
		t.Errorf("empty spec: got %v", err)
	}
	if err := (Spec{}).Validate(); err == nil || !strings.Contains(err.Error(), "no Command") {
		t.Errorf("spec with no command: got %v", err)
	}
}

func TestFieldRenderingsFallBackToDescription(t *testing.T) {
	s := probe()
	region := s.MustField("region")
	if got := region.UsageText(); got != "where to run" {
		t.Errorf("UsageText = %q, want the Description", got)
	}
	if got := region.DocsText(); got != "where to run" {
		t.Errorf("DocsText = %q, want the Description", got)
	}
	// The one field that overrides both: the two renderings must differ, or the override columns
	// are carrying nothing and should be deleted rather than left as decoration.
	note := s.MustField("note")
	if note.UsageText() == note.DocsText() {
		t.Errorf("the override field renders the same text twice (%q) — Usage and Docs buy nothing", note.UsageText())
	}
	if got := note.UsageText(); got != "an optional note (terse)" {
		t.Errorf("UsageText = %q, want the Usage override", got)
	}
	if got := note.DocsText(); got != "an optional note (for the table)" {
		t.Errorf("DocsText = %q, want the Docs override", got)
	}
	if got := region.Token(); got != "`--region`" {
		t.Errorf("Token(flag) = %q", got)
	}
	if got := s.MustField("name").Token(); got != "`[name]`" {
		t.Errorf("Token(positional) = %q", got)
	}
}

func TestMustFieldPanicsOnAKeyThatIsNotThere(t *testing.T) {
	defer func() {
		r := recover()
		if r == nil {
			t.Fatal("MustField must panic — every caller is a package-level definition, and an " +
				"absent key would otherwise surface as an empty flag description in front of a user")
		}
		if !strings.Contains(r.(string), "nope") {
			t.Errorf("panic = %v, want it to name the missing key", r)
		}
	}()
	probe().MustField("nope")
}

func TestKeysAndAllowed(t *testing.T) {
	s := probe()
	want := []string{"name", "region", "stage", "force", "note"}
	got := s.Keys()
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("Keys() = %v, want spec order %v", got, want)
	}
	if _, ok := s.Allowed(s.MustField("region")); ok {
		t.Errorf("an unconstrained field must report no allowed set")
	}
	allowed, ok := s.Allowed(s.MustField("stage"))
	if !ok || len(allowed) != 3 {
		t.Errorf("Allowed(stage) = %v, %v", allowed, ok)
	}
	if got := OneOf([]string{"c", "a", "b"}); got != "a | b | c" {
		t.Errorf("OneOf = %q, want it sorted", got)
	}
}

// The CLI's validation is a PROVABLE SUBSET of the server's: too permissive is caught by the server,
// too strict is a command nobody can run. So the unconstrained and empty cases must pass.
func TestCheckValueOnlyRefusesWhatItKnowsIsWrong(t *testing.T) {
	s := probe()
	stage, region := s.MustField("stage"), s.MustField("region")
	if err := s.CheckValue(stage, "production"); err != nil {
		t.Errorf("an allowed value was refused: %v", err)
	}
	if err := s.CheckValue(stage, "nonsense"); err == nil {
		t.Error("a value outside the set must be refused")
	} else if !strings.Contains(err.Error(), "development | production | staging") {
		t.Errorf("the refusal must list the alternatives, got %q", err)
	}
	if err := s.CheckValue(region, "anything at all"); err != nil {
		t.Errorf("an UNCONSTRAINED field must accept anything — being too strict is the one "+
			"direction the server cannot catch: %v", err)
	}
	if err := s.CheckValue(stage, ""); err != nil {
		t.Errorf("an empty value is unresolved, not invalid: %v", err)
	}
}
