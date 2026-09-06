// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package table

import (
	"errors"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/api"
	bubblesTable "github.com/charmbracelet/bubbles/table"
	tea "github.com/charmbracelet/bubbletea"
)

// TestModelPagesRequery remembers every cursor requested by n,n,p,p.
func TestModelPagesRequery(t *testing.T) {
	var cursors []string
	fetch := func(cursor string) (Page, error) {
		cursors = append(cursors, cursor)
		return Page{Rows: []bubblesTable.Row{{cursor}}, Info: api.PageInfo{Mode: api.PageModeExact, Total: 3, NextCursor: map[string]string{"": "one", "one": "two"}[cursor]}}, nil
	}
	model := New([]bubblesTable.Column{{Title: "ID", Width: 8}}, Page{Rows: []bubblesTable.Row{{"first"}}, Info: api.PageInfo{Mode: api.PageModeExact, Total: 3, NextCursor: "one"}}, "jobs", fetch)
	for _, key := range []string{"n", "n", "p", "p"} {
		updated, cmd := model.Update(keyMessage(key))
		model = updated.(Model)
		if cmd == nil {
			t.Fatalf("key %q returned no fetch command", key)
		}
		updated, _ = model.Update(cmd())
		model = updated.(Model)
	}
	if strings.Join(cursors, ",") != "one,two,one," {
		t.Fatalf("fetch cursors = %v, want [one,two,one,]", cursors)
	}
	if model.page != 1 || len(model.cursors) != 1 {
		t.Fatalf("final page/history = %d/%d, want 1/1", model.page, len(model.cursors))
	}
}

// TestModelFooterDistinguishesCappedTotals proves a floor is rendered with a plus sign.
func TestModelFooterDistinguishesCappedTotals(t *testing.T) {
	model := New(nil, Page{Info: api.PageInfo{Mode: api.PageModeCapped, Total: 1000, NextCursor: "next"}}, "jobs", nil)
	footer := model.footer()
	if !strings.Contains(footer, "1000+ jobs · page 1") {
		t.Fatalf("footer = %q, want capped count and page", footer)
	}
	if strings.Contains(footer, "of") {
		t.Fatalf("footer invents a denominator: %q", footer)
	}
	exhausted := New(nil, Page{Info: api.PageInfo{Mode: api.PageModeExact, Total: 7}}, "jobs", nil)
	if strings.Contains(exhausted.footer(), "page") {
		t.Fatalf("single exhausted page advertises a pager: %q", exhausted.footer())
	}
}

// TestModelErrorClearsLoadingAndRetries proves failures are visible and retryable.
func TestModelErrorClearsLoadingAndRetries(t *testing.T) {
	calls := 0
	fetch := func(string) (Page, error) {
		calls++
		return Page{}, errors.New("unavailable")
	}
	model := New(nil, Page{Info: api.PageInfo{Mode: api.PageModeExact, Total: 1}}, "jobs", fetch)
	updated, _ := model.Update(PageErrMsg{Err: errors.New("unavailable")})
	model = updated.(Model)
	if model.loading {
		t.Fatal("error message left model loading")
	}
	if !strings.Contains(model.View(), "r: retry") {
		t.Fatalf("error view = %q, want retry hint", model.View())
	}
	updated, cmd := model.Update(keyMessage("r"))
	model = updated.(Model)
	if !model.loading || cmd == nil {
		t.Fatal("retry did not enter loading or return a command")
	}
	updated, _ = model.Update(cmd())
	model = updated.(Model)
	if model.err == nil || calls != 1 {
		t.Fatalf("retry result err/calls = %v/%d, want error/1", model.err, calls)
	}
}

// TestModelFocusUsesBrackets proves focus survives without relying on terminal colour.
func TestModelFocusUsesBrackets(t *testing.T) {
	model := New([]bubblesTable.Column{{Title: "ID", Width: 20}}, Page{Rows: []bubblesTable.Row{{"job-1"}}, Info: api.PageInfo{Mode: api.PageModeExact, Total: 1}}, "jobs", nil)
	if !strings.Contains(model.View(), "[ job-1 ]") {
		t.Fatalf("view = %q, want bracketed focused row", model.View())
	}
}

// keyMessage makes a Bubble Tea rune key for model tests.
func keyMessage(key string) tea.KeyMsg {
	return tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(key)}
}
