// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"bytes"
	"errors"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
)

func TestRunRepoList(t *testing.T) {
	repos := []api.Repository{
		{ID: "1", Name: "app", FullName: "acme/app", URL: "https://github.com/acme/app", Private: true, DefaultBranch: "main", Provider: "github"},
		{ID: "2", Name: "site", FullName: "acme/site", URL: "https://github.com/acme/site", Private: false, DefaultBranch: "trunk", Provider: "github"},
	}
	c := &fakeClient{repos: repos}

	var buf bytes.Buffer
	if err := runRepoList(c, &buf, "table", "github"); err != nil {
		t.Fatalf("runRepoList: %v", err)
	}
	out := buf.String()
	for _, want := range []string{"acme/app", "private", "main", "acme/site", "public", "trunk"} {
		if !strings.Contains(out, want) {
			t.Errorf("table output missing %q:\n%s", want, out)
		}
	}
}

func TestRunRepoListJSON(t *testing.T) {
	c := &fakeClient{repos: []api.Repository{{FullName: "acme/app", URL: "u"}}}
	var buf bytes.Buffer
	if err := runRepoList(c, &buf, "json", "github"); err != nil {
		t.Fatalf("runRepoList json: %v", err)
	}
	if !strings.Contains(buf.String(), `"full_name": "acme/app"`) {
		t.Errorf("json output missing full_name:\n%s", buf.String())
	}
}

func TestRunRepoListEmpty(t *testing.T) {
	c := &fakeClient{repos: nil}
	var buf bytes.Buffer
	if err := runRepoList(c, &buf, "table", "gitlab"); err != nil {
		t.Fatalf("runRepoList empty: %v", err)
	}
	if !strings.Contains(buf.String(), "No gitlab repositories") {
		t.Errorf("expected empty notice, got: %q", buf.String())
	}
}

func TestRunRepoListError(t *testing.T) {
	c := &fakeClient{err: errors.New("boom")}
	var buf bytes.Buffer
	if err := runRepoList(c, &buf, "table", "github"); err == nil {
		t.Error("expected error to propagate")
	}
}

// repoRows falls back to the short name when a repo has no full name.
func TestRepoRowsFallbackName(t *testing.T) {
	rows := repoRows([]api.Repository{{Name: "solo", DefaultBranch: ""}}, ui.FormatTable)
	if rows[0][0] != "solo" {
		t.Errorf("expected fallback to short name, got %q", rows[0][0])
	}
}
