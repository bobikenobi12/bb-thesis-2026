// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package spec

import (
	"fmt"
	"sort"
	"strings"
)

// Origin records WHERE a resolved value came from. It is what lets a command print the replay line
// — the `alethia project create --region … --env …` a form's answers are equivalent to — without
// re-deriving which values the person typed and which were already there.
type Origin int

const (
	FromUnset Origin = iota
	FromFlag
	FromEnv
	FromManifest
	FromPrompt
	FromDefault
)

// String names the origin the way a refusal or a replay line refers to it.
func (o Origin) String() string {
	switch o {
	case FromUnset:
		return "unset"
	case FromFlag:
		return "flag"
	case FromEnv:
		return "environment"
	case FromManifest:
		return "manifest"
	case FromPrompt:
		return "form"
	case FromDefault:
		return "default"
	default:
		return "unset"
	}
}

// Sources are the places a value can come from, other than the flags the Binder already holds.
//
// They are ONE set per resolve call rather than one per field — the shape the coverage measurement
// in the package doc requires. A nil member is simply a source that has nothing to say: a nil Prompt
// is what `--no-input` looks like from in here, which is why the non-interactive path needs no
// separate branch to test.
type Sources struct {
	// Env looks up an environment variable. Usually os.LookupEnv.
	Env func(name string) (string, bool)

	// Manifest looks up a dotted key in `alethia.yaml`. Nil until #3662 lands the reader; a nil
	// Manifest resolves nothing and skips a rung, it does not error.
	Manifest func(key string) (string, bool)

	// Prompt asks a person. NIL WHEN PROMPTING IS UNAVAILABLE — `--no-input`, a pipe, a redirected
	// stderr. Callers pass canPromptForm()'s answer, so this package never grows a second predicate
	// beside output.go's, which a hygiene guard forbids anyway.
	Prompt func(f Field) (string, error)
}

// Values is the outcome of a resolve: every field's value and where it came from.
type Values struct {
	spec    Spec
	values  map[string]string
	origins map[string]Origin
}

// Get is a resolved value.
func (v Values) Get(key string) string { return v.values[key] }

// Origin is where a resolved value came from.
func (v Values) Origin(key string) Origin { return v.origins[key] }

// Asked reports whether any value came from the form — the condition a replay line is printed under.
func (v Values) Asked() bool {
	for _, o := range v.origins {
		if o == FromPrompt {
			return true
		}
	}
	return false
}

// MissingError is the refusal when required fields cannot be resolved and nothing can ask.
//
// IT NAMES EVERY MISSING FIELD, NOT THE FIRST. A CLI that refuses one flag at a time turns one
// mistake into as many round trips as there are missing values, and the person cannot see how far
// they are from a command that runs. This is the whole reason it is a type and not a plain error.
type MissingError struct {
	Command string
	Fields  []Field
}

func (e *MissingError) Error() string {
	tokens := make([]string, len(e.Fields))
	for i, f := range e.Fields {
		if f.Flag != "" {
			tokens[i] = "--" + f.Flag
		} else {
			tokens[i] = f.Arg
		}
	}
	sort.Strings(tokens)
	noun := "value"
	if len(tokens) > 1 {
		noun = "values"
	}
	var b strings.Builder
	fmt.Fprintf(&b, "%s needs %d more %s and cannot ask for %s (--no-input, or stdin is not a terminal): %s",
		e.Command, len(tokens), noun, pronounFor(len(tokens)), strings.Join(tokens, " "))
	for _, f := range e.Fields {
		fmt.Fprintf(&b, "\n  %-24s %s", tokenOf(f), f.Description)
		if f.Selector != "" {
			fmt.Fprintf(&b, " (or give the %s)", f.Selector)
		}
	}
	return b.String()
}

func pronounFor(n int) string {
	if n > 1 {
		return "them"
	}
	return "it"
}

func tokenOf(f Field) string {
	if f.Flag != "" {
		return "--" + f.Flag
	}
	return f.Arg
}

// Resolve walks every field through the sources in the ruled order and returns what it found.
//
// # The precedence, and why it is this way round
//
//	flag  >  environment  >  manifest  >  form  >  default
//
// An explicit flag always wins: it is the most deliberate thing anyone did. The environment beats
// the manifest because `ALETHIA_REGION=… alethia apply` is a person overriding a checked-in file on
// purpose for one run, and the file is still there afterwards; the other order would make the
// override silently do nothing, which is the worse failure of the two.
//
// THE FORM COMES BEFORE THE DEFAULT, which is the rung most easily got wrong. A default that
// resolved first would mean a form never asks about any field that has one — and the fields with
// defaults are exactly the ones worth offering, because a default is a guess the person may want to
// correct. So the form asks for what is still unset, and the default catches what the form did not
// supply (including every field when there is no form at all).
//
// A prompt that returns an empty string is a DECLINED question, not an answer: the field falls
// through to its default, and to the missing-field refusal if it is required and has none.
func Resolve(b *Binder, src Sources) (Values, error) {
	s := b.Spec()
	v := Values{spec: s, values: map[string]string{}, origins: map[string]Origin{}}
	var missing []Field

	for _, f := range s.Fields {
		// A repeated flag has no single value and no merge rule across sources — see Field.Repeated.
		// Its values are read straight off the Binder by the command that owns them.
		if f.Repeated {
			if got, ok := b.Strings(f.Key); ok && len(got) > 0 {
				v.origins[f.Key] = FromFlag
			} else if f.Required && src.Prompt == nil {
				missing = append(missing, f)
			}
			continue
		}
		if f.Bool {
			if got, ok := b.Bool(f.Key); ok && got {
				v.values[f.Key], v.origins[f.Key] = "true", FromFlag
			}
			continue
		}

		if got, ok := b.String(f.Key); ok && got != "" {
			if err := s.CheckValue(f, got); err != nil {
				return v, err
			}
			v.values[f.Key], v.origins[f.Key] = got, FromFlag
			continue
		}
		if src.Env != nil && f.EnvVar != "" {
			if got, ok := src.Env(f.EnvVar); ok && got != "" {
				if err := s.CheckValue(f, got); err != nil {
					return v, fmt.Errorf("%s: %w", f.EnvVar, err)
				}
				v.values[f.Key], v.origins[f.Key] = got, FromEnv
				continue
			}
		}
		if src.Manifest != nil && f.ManifestKey != "" {
			if got, ok := src.Manifest(f.ManifestKey); ok && got != "" {
				if err := s.CheckValue(f, got); err != nil {
					return v, fmt.Errorf("%s: %w", f.ManifestKey, err)
				}
				v.values[f.Key], v.origins[f.Key] = got, FromManifest
				continue
			}
		}
		if src.Prompt != nil {
			got, err := src.Prompt(f)
			if err != nil {
				return v, err
			}
			if got != "" {
				if err := s.CheckValue(f, got); err != nil {
					return v, err
				}
				v.values[f.Key], v.origins[f.Key] = got, FromPrompt
				continue
			}
		}
		if f.Default != "" {
			v.values[f.Key], v.origins[f.Key] = f.Default, FromDefault
			continue
		}
		if f.Required {
			missing = append(missing, f)
		}
	}

	if len(missing) > 0 {
		return v, &MissingError{Command: s.Command, Fields: missing}
	}
	return v, nil
}
