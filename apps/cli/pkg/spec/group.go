// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package spec

import (
	"fmt"
	"sort"
	"strings"
)

// Group is one noun group's whole field table: several commands' fields in one slice, addressed by
// (Command, Key).
//
// This is the shape the five per-group tables already have — authFields, byoFields, govFields,
// opsFields, orgFields are each a flat slice spanning a group's commands, read through a
// `must<Group>Field(command, key)` accessor. Group is that accessor, once, so converting a group is
// a type alias and a two-line change rather than a rewrite of its call sites.
//
// A Group is not a Spec: a Spec is ONE command's fields, which is what a form asks and a docs table
// lists. SpecFor projects one out.
type Group struct {
	// Name is the group, for refusals: "auth", "byo", "governance".
	Name string

	// Source is the file the table is declared in, e.g. "auth_fields.go".
	//
	// It is in the PANIC MESSAGE, and that is not decoration: a miss is a programming error found
	// by a test run, and the person reading it needs to know which of the group tables to open. The
	// five accessors this type replaces each named their own file, and their tests assert it — so
	// dropping it would have made the shared kit worse than the five copies it converged.
	Source string

	// Fields spans the group's commands.
	Fields []Field

	// Options is shared across the group's commands, because an enum does not change meaning
	// between two commands in one noun group.
	Options map[string][]string
}

// Find returns one field by command path and key.
func (g Group) Find(command, key string) (Field, bool) {
	for _, f := range g.Fields {
		if f.Command == command && f.Key == key {
			return f, true
		}
	}
	return Field{}, false
}

// Must returns one field by command path and key, and panics when there is none.
//
// It panics for the same reason Spec.MustField does: every caller is a package-level command
// definition or an init(), so a missing key must fail the test binary on its first run rather than
// reach a user as an empty flag description. This replaces the five identical must*Field accessors.
func (g Group) Must(command, key string) Field {
	f, ok := g.Find(command, key)
	if !ok {
		where := g.Source
		if where == "" {
			where = g.Name + " field spec"
		}
		panic(fmt.Sprintf("no %s field %q on %q — see the field table in %s", g.Name, key, command, where))
	}
	return f
}

// Usage is the flag-help line for one field, the shape byoFlagUsage already has.
func (g Group) Usage(command, key string) string {
	return g.Must(command, key).UsageText()
}

// SpecFor projects one command's Spec out of the group.
//
// Fields keep their order within the group, which is the order the group's table declares them and
// therefore the order its docs table already renders.
func (g Group) SpecFor(command string) Spec {
	s := Spec{Command: command, Options: g.Options}
	for _, f := range g.Fields {
		if f.Command == command {
			s.Fields = append(s.Fields, f)
		}
	}
	return s
}

// Commands is every command path the group describes, sorted.
func (g Group) Commands() []string {
	seen := map[string]bool{}
	var out []string
	for _, f := range g.Fields {
		if !seen[f.Command] {
			seen[f.Command] = true
			out = append(out, f.Command)
		}
	}
	sort.Strings(out)
	return out
}

// Pages is every docs page the group's fields render onto, sorted.
func (g Group) Pages() []string {
	seen := map[string]bool{}
	var out []string
	for _, f := range g.Fields {
		for _, p := range f.AllPages() {
			if !seen[p] {
				seen[p] = true
				out = append(out, p)
			}
		}
	}
	sort.Strings(out)
	return out
}

// Validate checks every field, plus the invariants that only exist across a group: a duplicate
// (command, key), and a flag spelled two ways on one command.
//
// It deliberately does NOT refuse the same flag name on two DIFFERENT commands — `--project` on
// twenty commands is the point of a group table, not a collision.
func (g Group) Validate() error {
	seen, flags := map[string]bool{}, map[string]bool{}
	for _, f := range g.Fields {
		if err := f.Validate(); err != nil {
			return err
		}
		id := f.Command + "\x00" + f.Key
		if seen[id] {
			return fmt.Errorf("%s (%s): duplicate %q on %q", g.Name, g.Source, f.Key, f.Command)
		}
		seen[id] = true
		if f.Flag != "" {
			fid := f.Command + "\x00--" + f.Flag
			if flags[fid] {
				return fmt.Errorf("%s (%s): --%s declared twice on %q", g.Name, g.Source, f.Flag, f.Command)
			}
			flags[fid] = true
		}
		if f.Options != "" {
			if _, ok := g.Options[f.Options]; !ok {
				return fmt.Errorf("%s (%s): %s/%s names Options %q with no values",
					g.Name, g.Source, f.Command, f.Key, f.Options)
			}
		}
	}
	return nil
}

// LeafCommands is every command path in the group that is not a prefix of another.
//
// A group table may describe a GROUP path — "alethia byo" carrying the persistent `--project` its
// children inherit — and a guard asking "does this command exist and take this flag?" has to tell
// the two apart. Reported here rather than re-derived per group, which is where byoGroupOf and
// authGroupCommands each grew their own answer.
func (g Group) LeafCommands() []string {
	all := g.Commands()
	var out []string
	for _, c := range all {
		isPrefix := false
		for _, other := range all {
			if other != c && strings.HasPrefix(other, c+" ") {
				isPrefix = true
				break
			}
		}
		if !isPrefix {
			out = append(out, c)
		}
	}
	return out
}
