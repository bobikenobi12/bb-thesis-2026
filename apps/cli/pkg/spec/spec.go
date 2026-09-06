// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Package spec is the CLI's field-spec kit: one declaration of what a command takes from a person,
// rendered four ways — as flags, as an interactive form, as manifest keys, and as a docs table.
//
// # Why the package exists
//
// A command that takes a value renders that value four times, and nothing made the four agree. They
// were hand-written lists that had already drifted: `alethia init` asked for a control-plane URL no
// flag could supply, so `init --no-input` could not do the one thing init exists for. Five noun
// groups then each grew their own near-identical `*Field` struct — authField, byoField, govField,
// opsField, orgField, field-for-field the same but for one column each — and every one of them
// carries a comment naming this package as where they converge.
//
// # The invariant
//
// FLAGS ARE A COMPLETE CONTRACT: anything a form can ask, a flag can set. That is what makes
// `--no-input` work everywhere rather than in the commands somebody remembered. It is not a
// convention here, it is checked — see Field.Validate and Spec.Validate.
//
// # Field carries DATA, never behaviour, and that is a measured decision
//
// Go's cover tool instruments function bodies, including func literals inside package-level `var`
// initializers — which is why scripts/go-coverage.sh parses the profile and never `go tool cover
// -func`. Measured on apps/cli/cmd at c070c4f29, seven fields added as a package-level literal:
//
//	data-only          6472 statements, 6420 covered — IDENTICAL to the baseline
//	with two closures  6486 statements, 6420 covered — +14, one per closure, none covered
//
// One statement per closure. Extrapolated across ~110 commands with a Validate and an Options each,
// a behaviour-carrying spec would add on the order of 1,500 uncovered statements against `cmd`'s ~52
// of ratchet headroom. A data-only one adds none, at any scale.
//
// So validation and option sets are declared as VALUES — the name of an allowed-values set — and
// resolved by functions in this package, which live in one place and are tested once. The fallback
// #3661 named, moving specs to a `pkg/spec/catalog` package to keep them out of `cmd`'s denominator,
// is not needed: a data-only spec is free wherever it lives, so specs stay beside the commands they
// describe, where a reader looking at the command can see them.
package spec

import (
	"fmt"
	"sort"
	"strings"
)

// Field is one value a command takes from a person, declared once.
//
// Every member is data. See the package doc for why that is load-bearing rather than stylistic.
type Field struct {
	// Command is the cobra command path this field belongs to, e.g. "alethia project create".
	// It may name a GROUP ("alethia byo") for a persistent flag described once for its children.
	Command string

	// Key identifies the field inside its command. Never shown to anyone; it is how a form, a
	// resolver and a test ask for one field without matching on a display string.
	Key string

	// Title is the form's question AND the docs table's "Field" cell.
	Title string

	// Description is the form's helper line, the flag's usage, and the docs table's "What it is"
	// cell. One sentence, no trailing period — a form renders it beneath the title.
	Description string

	// Usage overrides Description for `--help` alone, and Docs overrides it for the docs table
	// alone. Both are empty in almost every field: they exist because the shell group's global
	// flags genuinely need a terser line at a `--help` prompt than in a reference table, and
	// collapsing that distinction would have made one of the two worse. Read them through
	// UsageText and DocsText, never directly.
	Usage string
	Docs  string

	// Flag is the long flag that supplies this value without a form; Arg is the positional
	// placeholder as it appears in the command's Use string. EXACTLY ONE is set — Validate
	// refuses both and neither, because a field with neither cannot be scripted and a field with
	// both has two spellings a reader has to choose between.
	Flag string
	Arg  string

	// Shorthand is the one-letter flag, without its dash. Empty for most.
	Shorthand string

	// Default is the value used when nothing else resolves. It is the LAST source, after the
	// prompt — see Resolve.
	Default string

	// Bool marks a flag that takes no value. Its Default, if set, must parse as a bool.
	Bool bool

	// Repeated marks a flag that may be given more than once and collects its values, e.g.
	// `--env prod:production --env dev:development`. Read through Binder.Strings, never String.
	//
	// A repeated field has no single value, so it does not take part in the env/manifest/default
	// rungs of Resolve — a list assembled from four sources is a merge with no stated rule, and
	// there is no call for one. It is a flag or it is the form.
	Repeated bool

	// Required marks a field that must resolve to something. Under --no-input an unresolved
	// required field is an error naming EVERY missing flag, not the first.
	Required bool

	// Selector is the readable alternative to an opaque id — "name", "label", "email". It is what
	// the refusal message offers when a form cannot run, and what the docs table names beside the
	// id form. Empty when the field is not an id.
	Selector string

	// Options names an allowed-values set, resolved through a Spec's Options map. A NAME and not a
	// func: see the package doc.
	Options string

	// ManifestKey is this field's key in `alethia.yaml`, dotted for nesting ("cloud.region").
	// Empty when the field has no manifest form — a one-shot confirmation, say.
	ManifestKey string

	// EnvVar is the environment variable that supplies this value, e.g. "ALETHIA_REGION".
	EnvVar string

	// Page is the docs file, relative to the repository root, whose fieldspec table carries this
	// row. Pages carries the rest when one field is documented on several — a global flag is.
	Page  string
	Pages []string
}

// UsageText is the line `--help` shows.
func (f Field) UsageText() string {
	if f.Usage != "" {
		return f.Usage
	}
	return f.Description
}

// DocsText is the "What it is" cell.
func (f Field) DocsText() string {
	if f.Docs != "" {
		return f.Docs
	}
	return f.Description
}

// Token is the docs table's "Set without the form" cell: the flag or the positional, in backticks.
//
// It is the rendering the existing per-group guards already assert, so a converted group's docs
// table is byte-identical to the one it had.
func (f Field) Token() string {
	if f.Flag != "" {
		return "`--" + f.Flag + "`"
	}
	return "`" + f.Arg + "`"
}

// AllPages is every docs page this field's row belongs on.
func (f Field) AllPages() []string {
	var out []string
	if f.Page != "" {
		out = append(out, f.Page)
	}
	out = append(out, f.Pages...)
	return out
}

// Validate reports what is structurally wrong with one field.
//
// The Flag/Arg rule is the one that matters: it is the mechanical half of "flags are a complete
// contract". A field with neither cannot be set without a form, which is precisely the defect that
// made `init --no-input` unable to do init's job.
func (f Field) Validate() error {
	switch {
	case f.Command == "":
		return fmt.Errorf("field %q: no Command", f.Key)
	case f.Key == "":
		return fmt.Errorf("field on %q: no Key", f.Command)
	case f.Title == "":
		return fmt.Errorf("%s/%s: no Title — it is the form's question and the docs cell", f.Command, f.Key)
	case f.Description == "" && f.Docs == "":
		return fmt.Errorf("%s/%s: no Description", f.Command, f.Key)
	case f.Flag == "" && f.Arg == "":
		return fmt.Errorf("%s/%s: neither Flag nor Arg — a form could ask for this and nothing could "+
			"script it, which is the whole defect this kit exists to make impossible", f.Command, f.Key)
	case f.Flag != "" && f.Arg != "":
		return fmt.Errorf("%s/%s: both Flag %q and Arg %q — one field, one spelling", f.Command, f.Key, f.Flag, f.Arg)
	case f.Shorthand != "" && f.Flag == "":
		return fmt.Errorf("%s/%s: Shorthand %q on a positional", f.Command, f.Key, f.Shorthand)
	case len(f.Shorthand) > 1:
		return fmt.Errorf("%s/%s: Shorthand %q is more than one character", f.Command, f.Key, f.Shorthand)
	case f.Bool && f.Arg != "":
		return fmt.Errorf("%s/%s: Bool on a positional", f.Command, f.Key)
	case f.Repeated && f.Arg != "":
		return fmt.Errorf("%s/%s: Repeated on a positional", f.Command, f.Key)
	case f.Repeated && f.Bool:
		return fmt.Errorf("%s/%s: both Repeated and Bool", f.Command, f.Key)
	}
	return nil
}

// Spec is every field one command takes.
type Spec struct {
	// Command is the cobra path, e.g. "alethia project create".
	Command string

	// Fields are in the order a form asks them and the docs table lists them. The order is part of
	// the spec: it is what makes the generated table stable across runs.
	Fields []Field

	// Options resolves a Field.Options name to its allowed values. It is one map per spec rather
	// than a closure per field — the shape the coverage measurement in the package doc requires.
	// A name with no entry is a Validate failure, not a silent "anything goes".
	Options map[string][]string
}

// Field returns the field with the given key.
func (s Spec) Field(key string) (Field, bool) {
	for _, f := range s.Fields {
		if f.Key == key {
			return f, true
		}
	}
	return Field{}, false
}

// MustField returns the field with the given key and panics when there is none.
//
// It panics rather than returning an error because every caller is a package-level command
// definition or an init(): a missing key is a programming error that must fail the test binary on
// the first run, not surface as an empty flag description in front of a user. This mirrors the
// must*Field accessors it replaces.
func (s Spec) MustField(key string) Field {
	f, ok := s.Field(key)
	if !ok {
		panic(fmt.Sprintf("spec %q: no field %q", s.Command, key))
	}
	return f
}

// Keys is every field key, in spec order.
func (s Spec) Keys() []string {
	out := make([]string, len(s.Fields))
	for i, f := range s.Fields {
		out[i] = f.Key
	}
	return out
}

// Validate reports what is wrong with a whole spec: any field's own invariants, plus the ones that
// only exist between fields — a duplicate key, a duplicate flag, an Options name with no values.
func (s Spec) Validate() error {
	if s.Command == "" {
		return fmt.Errorf("spec has no Command")
	}
	if len(s.Fields) == 0 {
		return fmt.Errorf("spec %q has no fields — an empty spec renders an empty form, an empty "+
			"docs table and no flags, and every one of those reads as a feature", s.Command)
	}
	keys, flags := map[string]bool{}, map[string]bool{}
	for _, f := range s.Fields {
		if err := f.Validate(); err != nil {
			return err
		}
		if keys[f.Key] {
			return fmt.Errorf("spec %q: duplicate key %q", s.Command, f.Key)
		}
		keys[f.Key] = true
		if f.Flag != "" {
			if flags[f.Flag] {
				return fmt.Errorf("spec %q: duplicate flag --%s", s.Command, f.Flag)
			}
			flags[f.Flag] = true
		}
		if f.Options != "" {
			if _, ok := s.Options[f.Options]; !ok {
				return fmt.Errorf("%s/%s: Options %q has no values in the spec's Options map — an "+
					"unresolvable name would validate nothing while looking like it validated something",
					s.Command, f.Key, f.Options)
			}
		}
	}
	return nil
}

// Allowed returns the values a field may take, and whether it is constrained at all.
func (s Spec) Allowed(f Field) ([]string, bool) {
	if f.Options == "" {
		return nil, false
	}
	v, ok := s.Options[f.Options]
	return v, ok
}

// CheckValue reports whether a value is one the field allows.
//
// THE CLI'S VALIDATION IS A PROVABLE SUBSET of the server's: it may only ever reject what the server
// would certainly reject (PROGRAMME.md §5). So an UNCONSTRAINED field accepts anything and an
// unresolvable Options name is a Validate error rather than a refusal here — drift may make this too
// permissive, which the server catches, and must never make it too strict.
func (s Spec) CheckValue(f Field, value string) error {
	allowed, ok := s.Allowed(f)
	if !ok || value == "" {
		return nil
	}
	for _, a := range allowed {
		if a == value {
			return nil
		}
	}
	return fmt.Errorf("invalid --%s %q (want %s)", f.Flag, value, OneOf(allowed))
}

// OneOf renders an allowed-values list the way the CLI's refusals already read.
func OneOf(values []string) string {
	sorted := append([]string(nil), values...)
	sort.Strings(sorted)
	return strings.Join(sorted, " | ")
}
