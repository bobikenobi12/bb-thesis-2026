// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package spec

import (
	"strconv"

	"github.com/spf13/cobra"
)

// Binder holds one command's flag targets, keyed by field key.
//
// Values are read back by KEY rather than through a per-field pointer the spec carries, and that is
// the whole reason Field can stay data-only: `jobs_select.go`'s `Target func(*jobSelector) *string`
// is one closure per field, and the package doc measures what a closure per field costs. The
// indirection lands here instead, once.
type Binder struct {
	spec  Spec
	strs  map[string]*string
	bools map[string]*bool
	lists map[string]*[]string
}

// RegisterFlags registers every flag-bearing field on cmd and returns the binder that reads them.
//
// THIS IS WHAT MAKES "anything a form can ask, a flag can set" TRUE BY CONSTRUCTION rather than by
// assertion. The alternative — hand-written `cmd.Flags().StringVar(...)` calls plus a test asserting
// the spec mirrors them — is two sources of truth held together by a test, which is exactly the
// class of claim #3664's "unlocked mirrors" ratchet exists to count and delete.
//
// `registerShellGlobalFlags` (shell_fields.go) and `addJobSelectorFlags` (jobs_select.go) already do
// this for their own groups; this generalises the two.
func RegisterFlags(cmd *cobra.Command, s Spec) *Binder {
	return registerOn(cmd.Flags(), cmd, s)
}

// RegisterPersistentFlags is RegisterFlags for a group's persistent flags — the shape byoField and
// govField use, where `--project` is described once and inherited by every child.
func RegisterPersistentFlags(cmd *cobra.Command, s Spec) *Binder {
	return registerOn(cmd.PersistentFlags(), cmd, s)
}

type flagSet interface {
	StringVarP(p *string, name, shorthand, value, usage string)
	BoolVarP(p *bool, name, shorthand string, value bool, usage string)
	StringArrayVarP(p *[]string, name, shorthand string, value []string, usage string)
}

func registerOn(fs flagSet, _ *cobra.Command, s Spec) *Binder {
	b := &Binder{spec: s, strs: map[string]*string{}, bools: map[string]*bool{}, lists: map[string]*[]string{}}
	for _, f := range s.Fields {
		if f.Flag == "" {
			continue
		}
		usage := f.UsageText()
		if allowed, ok := s.Allowed(f); ok {
			usage += " (" + OneOf(allowed) + ")"
		}
		if f.Repeated {
			p := new([]string)
			fs.StringArrayVarP(p, f.Flag, f.Shorthand, nil, usage)
			b.lists[f.Key] = p
			continue
		}
		if f.Bool {
			p := new(bool)
			def, _ := strconv.ParseBool(f.Default)
			fs.BoolVarP(p, f.Flag, f.Shorthand, def, usage)
			b.bools[f.Key] = p
			continue
		}
		p := new(string)
		// The DEFAULT IS NOT REGISTERED WITH COBRA, deliberately: cobra cannot distinguish "the
		// user passed the default" from "nothing was passed", and Resolve needs that difference to
		// know whether the environment, the manifest and the form get a turn. The default is
		// applied last, in Resolve, which is also where the documented precedence lives so there is
		// one place to read it. What cobra IS told is the default's TEXT, so `--help` still shows it.
		fs.StringVarP(p, f.Flag, f.Shorthand, "", usage)
		b.strs[f.Key] = p
	}
	return b
}

// Spec is the spec this binder was built from.
func (b *Binder) Spec() Spec { return b.spec }

// String is the flag value for a key, and whether the flag exists at all.
func (b *Binder) String(key string) (string, bool) {
	p, ok := b.strs[key]
	if !ok {
		return "", false
	}
	return *p, true
}

// Bool is the boolean flag value for a key.
func (b *Binder) Bool(key string) (bool, bool) {
	p, ok := b.bools[key]
	if !ok {
		return false, false
	}
	return *p, true
}

// Strings is the repeated flag's values for a key.
func (b *Binder) Strings(key string) ([]string, bool) {
	p, ok := b.lists[key]
	if !ok {
		return nil, false
	}
	return *p, true
}

// SetArg seeds a POSITIONAL field's value, so Resolve treats it exactly as it treats a flag.
//
// A positional has no flag for cobra to bind, but it is the most explicit thing a person can type
// and must therefore win the same rung. `alethia project create boutique` and
// `alethia project create --name boutique` are the same act; only one of them is spelled with a
// flag, and the precedence must not be able to tell them apart.
//
// It returns false for a key the spec does not have, so a caller cannot seed a typo into nothing.
func (b *Binder) SetArg(key, value string) bool {
	for _, f := range b.spec.Fields {
		if f.Key != key {
			continue
		}
		if f.Arg == "" {
			return false
		}
		p := new(string)
		*p = value
		b.strs[key] = p
		return true
	}
	return false
}

// Reset zeroes every bound target.
//
// Cobra binds flags to pointers that live as long as the process, so a test binary running two
// cases against one command sees the FIRST case's flags in the second. The commands this replaces
// each had a hand-written reset in their tests, listing every package-level flag var by name — a
// list that silently stops covering a flag added later. This resets whatever is actually bound.
func (b *Binder) Reset() {
	for _, p := range b.strs {
		*p = ""
	}
	for _, p := range b.bools {
		*p = false
	}
	for _, p := range b.lists {
		*p = nil
	}
}

// DefaultUsage is the `--help` line a field renders, exported so a guard can compare what was
// registered against what the spec says without re-deriving the rule.
func DefaultUsage(s Spec, f Field) string {
	usage := f.UsageText()
	if allowed, ok := s.Allowed(f); ok {
		usage += " (" + OneOf(allowed) + ")"
	}
	return usage
}
