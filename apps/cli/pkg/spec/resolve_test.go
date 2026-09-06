// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package spec

import (
	"errors"
	"strings"
	"testing"
)

func envOf(m map[string]string) func(string) (string, bool) {
	return func(k string) (string, bool) { v, ok := m[k]; return v, ok }
}

// answers builds a Prompt that returns a canned answer per field key, and records what it was asked.
func answers(m map[string]string, asked *[]string) func(Field) (string, error) {
	return func(f Field) (string, error) {
		*asked = append(*asked, f.Key)
		return m[f.Key], nil
	}
}

// The ruled precedence: flag > env > manifest > form > default. Every rung is asserted by putting a
// DIFFERENT value in every source at once, so a resolver that skipped a rung would return a value
// this test can name rather than an indistinguishable one.
func TestResolveFollowsTheRuledPrecedence(t *testing.T) {
	all := Sources{
		Env:      envOf(map[string]string{"ALETHIA_PROBE_REGION": "from-env"}),
		Manifest: func(k string) (string, bool) { return "from-manifest", true },
		// Key-aware because `stage` is constrained: a blanket "from-form" would be refused by
		// CheckValue and the test would fail for a reason that is not the precedence.
		Prompt: func(f Field) (string, error) {
			if f.Key == "stage" {
				return "staging", nil
			}
			return "from-form", nil
		},
	}

	t.Run("a flag beats everything", func(t *testing.T) {
		b := bind(t, probe(), "--region", "from-flag")
		v, err := Resolve(b, all)
		if err != nil {
			t.Fatalf("resolve: %v", err)
		}
		if got := v.Get("region"); got != "from-flag" {
			t.Errorf("region = %q, want the flag", got)
		}
		if got := v.Origin("region"); got != FromFlag {
			t.Errorf("origin = %v, want the flag", got)
		}
	})

	t.Run("the environment beats the manifest", func(t *testing.T) {
		b := bind(t, probe())
		v, err := Resolve(b, all)
		if err != nil {
			t.Fatalf("resolve: %v", err)
		}
		// A person exporting a variable is overriding a checked-in file on purpose for one run.
		// The other order makes that override silently do nothing.
		if got := v.Get("region"); got != "from-env" {
			t.Errorf("region = %q, want the environment", got)
		}
		if got := v.Origin("region"); got != FromEnv {
			t.Errorf("origin = %v, want the environment", got)
		}
	})

	t.Run("the manifest beats the form", func(t *testing.T) {
		b := bind(t, probe())
		v, err := Resolve(b, Sources{Manifest: all.Manifest, Prompt: all.Prompt})
		if err != nil {
			t.Fatalf("resolve: %v", err)
		}
		if got := v.Get("region"); got != "from-manifest" {
			t.Errorf("region = %q, want the manifest", got)
		}
	})

	t.Run("the form beats the DEFAULT, which is the rung most easily got wrong", func(t *testing.T) {
		var asked []string
		b := bind(t, probe())
		v, err := Resolve(b, Sources{Prompt: answers(map[string]string{
			"name": "web", "region": "eu-central-1", "stage": "production",
		}, &asked)})
		if err != nil {
			t.Fatalf("resolve: %v", err)
		}
		// `stage` has a default. A default resolving first would mean the form never asks about any
		// field that has one — and those are exactly the fields worth offering, because a default
		// is a guess the person may want to correct.
		if got := v.Get("stage"); got != "production" {
			t.Errorf("stage = %q, want the form's answer, not the default %q", got, "development")
		}
		if got := v.Origin("stage"); got != FromPrompt {
			t.Errorf("origin = %v, want the form", got)
		}
		if !contains(asked, "stage") {
			t.Errorf("the form was never asked about `stage`; it asked %v", asked)
		}
	})

	t.Run("the default catches what nothing else supplied", func(t *testing.T) {
		b := bind(t, probe(), "--region", "r")
		v, err := Resolve(b, Sources{Prompt: func(f Field) (string, error) { return "", nil }})
		if err == nil {
			t.Fatal("name is required and was declined; want a refusal")
		}
		if got := v.Get("stage"); got != "development" {
			t.Errorf("stage = %q, want the default", got)
		}
		if got := v.Origin("stage"); got != FromDefault {
			t.Errorf("origin = %v, want the default", got)
		}
	})
}

// A declined question is not an answer: it falls through, rather than storing "".
func TestResolveTreatsAnEmptyPromptAnswerAsDeclined(t *testing.T) {
	b := bind(t, probe(), "--region", "r")
	v, err := Resolve(b, Sources{Prompt: func(f Field) (string, error) {
		if f.Key == "name" {
			return "web", nil
		}
		return "", nil
	}})
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if got := v.Get("stage"); got != "development" {
		t.Errorf("a declined question must fall through to the default, got %q", got)
	}
}

// --no-input is a NIL Prompt. There is no second predicate in this package, because output.go owns
// the only one and a hygiene guard forbids a rival.
func TestResolveWithNoFormNamesEVERYMissingFlagNotTheFirst(t *testing.T) {
	b := bind(t, probe())
	_, err := Resolve(b, Sources{})
	if err == nil {
		t.Fatal("two required fields are unresolved; want a refusal")
	}
	var missing *MissingError
	if !errors.As(err, &missing) {
		t.Fatalf("want a *MissingError, got %T", err)
	}
	if len(missing.Fields) != 2 {
		t.Fatalf("named %d fields, want both", len(missing.Fields))
	}
	msg := err.Error()
	for _, want := range []string{"[name]", "--region", "alethia probe run", "2 more values"} {
		if !strings.Contains(msg, want) {
			t.Errorf("the refusal does not mention %q:\n%s", want, msg)
		}
	}
	// One mistake must not become as many round trips as there are missing values.
	if strings.Count(msg, "what to call it") != 1 || strings.Count(msg, "where to run") != 1 {
		t.Errorf("every missing field needs its description exactly once:\n%s", msg)
	}
}

func TestMissingErrorReadsForOneField(t *testing.T) {
	e := &MissingError{Command: "alethia x", Fields: []Field{
		{Key: "id", Flag: "id", Description: "which one", Selector: "name"},
	}}
	msg := e.Error()
	for _, want := range []string{"1 more value", "ask for it", "--id", "or give the name"} {
		if !strings.Contains(msg, want) {
			t.Errorf("refusal does not mention %q:\n%s", want, msg)
		}
	}
}

// A value outside the allowed set is refused whatever source it came from. Each arm is driven
// separately: a resolver that validated the flag alone would pass a single-source test, and the
// env/manifest/form arms are exactly the ones no command exercises by hand.
func TestResolveRefusesAValueOutsideTheAllowedSetFromEverySource(t *testing.T) {
	// `stage` is the constrained field; give it an env var and a manifest key for this test.
	staged := func() Spec {
		s := probe()
		for i := range s.Fields {
			if s.Fields[i].Key == "stage" {
				s.Fields[i].EnvVar = "ALETHIA_PROBE_STAGE"
				s.Fields[i].ManifestKey = "stage.key"
			}
		}
		return s
	}

	for name, tc := range map[string]struct {
		src  Sources
		want string
	}{
		"flag": {Sources{}, "invalid --stage"},
		"env": {Sources{Env: envOf(map[string]string{"ALETHIA_PROBE_STAGE": "nonsense"})},
			"ALETHIA_PROBE_STAGE"},
		"manifest": {Sources{Manifest: func(k string) (string, bool) { return "nonsense", k == "stage.key" }},
			"stage.key"},
		"form": {Sources{Prompt: func(f Field) (string, error) {
			if f.Key == "stage" {
				return "nonsense", nil
			}
			return "x", nil
		}}, "invalid --stage"},
	} {
		t.Run(name, func(t *testing.T) {
			argv := []string{}
			if name == "flag" {
				argv = []string{"--stage", "nonsense"}
			}
			b := bind(t, staged(), argv...)
			_, err := Resolve(b, tc.src)
			if err == nil {
				t.Fatalf("a value outside the set arriving by %s must be refused", name)
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Errorf("refusal = %q, want it to name %q so a reader knows WHERE the bad value came from", err, tc.want)
			}
		})
	}
}

func TestResolvePropagatesAPromptFailure(t *testing.T) {
	boom := errors.New("the terminal went away")
	b := bind(t, probe())
	if _, err := Resolve(b, Sources{Prompt: func(Field) (string, error) { return "", boom }}); !errors.Is(err, boom) {
		t.Errorf("a prompt failure must surface, got %v", err)
	}
}

func TestBoolFlagAndAskedAndOrigins(t *testing.T) {
	b := bind(t, probe(), "--force")
	v, err := Resolve(b, Sources{Prompt: func(f Field) (string, error) {
		if f.Key == "stage" {
			return "staging", nil
		}
		return "x", nil
	}})
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if got := v.Get("force"); got != "true" {
		t.Errorf("force = %q, want %q", got, "true")
	}
	if !v.Asked() {
		t.Error("Asked() must report true when any value came from the form — it is what a replay line is printed under")
	}

	quiet := bind(t, probe(), "--region", "r")
	qv, err := Resolve(quiet, Sources{Prompt: func(f Field) (string, error) {
		if f.Key == "name" {
			return "web", nil
		}
		return "", nil
	}})
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if qv.Origin("region") != FromFlag {
		t.Errorf("region origin = %v", qv.Origin("region"))
	}
	if qv.Origin("missing-key") != FromUnset {
		t.Errorf("an unknown key must report FromUnset, got %v", qv.Origin("missing-key"))
	}
}

func TestOriginNames(t *testing.T) {
	for o, want := range map[Origin]string{
		FromUnset: "unset", FromFlag: "flag", FromEnv: "environment",
		FromManifest: "manifest", FromPrompt: "form", FromDefault: "default",
	} {
		if got := o.String(); got != want {
			t.Errorf("Origin(%d).String() = %q, want %q", o, got, want)
		}
	}
	if got := Origin(99).String(); got != "unset" {
		t.Errorf("an unknown origin = %q, want the unset fallback", got)
	}
}

func contains(haystack []string, needle string) bool {
	for _, h := range haystack {
		if h == needle {
			return true
		}
	}
	return false
}
