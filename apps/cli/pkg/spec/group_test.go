// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package spec

import (
	"strings"
	"testing"
)

// probeGroup mirrors the shape the five noun-group tables have: several commands in one slice, plus
// a GROUP path carrying a persistent flag its children inherit.
func probeGroup() Group {
	return Group{
		Name: "probe",
		Fields: []Field{
			{Command: "alethia probe", Key: "project", Title: "Project", Description: "which project",
				Flag: "project", Shorthand: "p", Page: "docs/probe.mdx"},
			{Command: "alethia probe run", Key: "name", Title: "Name", Description: "what to call it",
				Arg: "[name]", Page: "docs/probe.mdx"},
			{Command: "alethia probe run", Key: "stage", Title: "Stage", Description: "which stage",
				Flag: "stage", Options: "stages", Page: "docs/probe.mdx"},
			{Command: "alethia probe list", Key: "limit", Title: "Rows", Description: "how many",
				Flag: "limit", Page: "docs/probe-list.mdx", Pages: []string{"docs/shared.mdx"}},
		},
		Options: map[string][]string{"stages": {"development", "production"}},
	}
}

func TestGroupValidates(t *testing.T) {
	if err := probeGroup().Validate(); err != nil {
		t.Fatalf("the probe group must be valid: %v", err)
	}
}

func TestGroupMustFindsAndPanics(t *testing.T) {
	g := probeGroup()
	if f := g.Must("alethia probe run", "name"); f.Title != "Name" {
		t.Errorf("Must returned %+v", f)
	}
	if _, ok := g.Find("alethia probe run", "nope"); ok {
		t.Error("Find must report a missing key")
	}
	// The same key on a DIFFERENT command must not match — that is the whole point of addressing
	// by (Command, Key) rather than by key alone.
	if _, ok := g.Find("alethia probe list", "name"); ok {
		t.Error("Find matched a key belonging to another command")
	}
	defer func() {
		r := recover()
		if r == nil {
			t.Fatal("Must must panic on a missing field")
		}
		if !strings.Contains(r.(string), "probe") {
			t.Errorf("panic = %v, want it to name the group", r)
		}
	}()
	g.Must("alethia probe run", "nope")
}

func TestGroupUsageReadsOffTheSpec(t *testing.T) {
	if got := probeGroup().Usage("alethia probe", "project"); got != "which project" {
		t.Errorf("Usage = %q", got)
	}
}

func TestSpecForProjectsOneCommand(t *testing.T) {
	s := probeGroup().SpecFor("alethia probe run")
	if len(s.Fields) != 2 {
		t.Fatalf("got %d fields, want only the two on that command", len(s.Fields))
	}
	if strings.Join(s.Keys(), ",") != "name,stage" {
		t.Errorf("Keys = %v, want group order preserved", s.Keys())
	}
	// The group's Options must ride along, or a projected spec cannot validate its own values.
	if err := s.Validate(); err != nil {
		t.Errorf("a projected spec must be valid on its own: %v", err)
	}
	if allowed, ok := s.Allowed(s.MustField("stage")); !ok || len(allowed) != 2 {
		t.Errorf("the projected spec lost its Options: %v %v", allowed, ok)
	}
	if got := probeGroup().SpecFor("alethia probe nothing"); len(got.Fields) != 0 {
		t.Errorf("a command with no fields projected %d", len(got.Fields))
	}
}

func TestGroupCommandsAndPagesAndLeaves(t *testing.T) {
	g := probeGroup()
	if got := strings.Join(g.Commands(), ","); got != "alethia probe,alethia probe list,alethia probe run" {
		t.Errorf("Commands = %q, want them sorted and deduplicated", got)
	}
	if got := strings.Join(g.Pages(), ","); got != "docs/probe-list.mdx,docs/probe.mdx,docs/shared.mdx" {
		t.Errorf("Pages = %q — it must collect Pages as well as Page", got)
	}
	// "alethia probe" is a GROUP path: it carries the persistent flag its children inherit, and a
	// guard asking "does this leaf take this flag?" must not treat it as a leaf.
	if got := strings.Join(g.LeafCommands(), ","); got != "alethia probe list,alethia probe run" {
		t.Errorf("LeafCommands = %q, want the group path excluded", got)
	}
}

func TestGroupValidateCatchesTheAcrossFieldFaults(t *testing.T) {
	dup := probeGroup()
	dup.Fields = append(dup.Fields, Field{Command: "alethia probe run", Key: "name",
		Title: "T", Description: "d", Flag: "other"})
	if err := dup.Validate(); err == nil || !strings.Contains(err.Error(), "duplicate") {
		t.Errorf("duplicate (command,key): got %v", err)
	}

	dupFlag := probeGroup()
	dupFlag.Fields = append(dupFlag.Fields, Field{Command: "alethia probe run", Key: "other",
		Title: "T", Description: "d", Flag: "stage"})
	if err := dupFlag.Validate(); err == nil || !strings.Contains(err.Error(), "declared twice") {
		t.Errorf("a flag spelled twice on one command: got %v", err)
	}

	// The SAME flag on two different commands is the point of a group table, not a collision.
	shared := probeGroup()
	shared.Fields = append(shared.Fields, Field{Command: "alethia probe list", Key: "stage",
		Title: "T", Description: "d", Flag: "stage", Options: "stages"})
	if err := shared.Validate(); err != nil {
		t.Errorf("--stage on two commands must be allowed: %v", err)
	}

	orphan := probeGroup()
	orphan.Options = nil
	if err := orphan.Validate(); err == nil || !strings.Contains(err.Error(), "no values") {
		t.Errorf("orphan Options name: got %v", err)
	}

	bad := probeGroup()
	bad.Fields[0].Flag = ""
	if err := bad.Validate(); err == nil || !strings.Contains(err.Error(), "neither Flag nor Arg") {
		t.Errorf("a field's own invariants must be checked too: got %v", err)
	}
}
