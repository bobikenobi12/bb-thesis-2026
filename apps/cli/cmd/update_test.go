// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRunUpdateRejectsDevelopmentBuild(t *testing.T) {
	err := runUpdate(context.Background(), &bytes.Buffer{}, &bytes.Buffer{}, "dev", "https://example.invalid")
	if err == nil || !strings.Contains(err.Error(), "development builds") {
		t.Fatalf("expected development-build error, got %v", err)
	}
}

func TestRunUpdateReportsCurrentVersionWithoutInstalling(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/releases/cli" {
			t.Errorf("unexpected path %s", r.URL.Path)
		}
		_, _ = w.Write([]byte(`{"version":"1.2.3","github_release_url":"https://example.com/release","min_supported_version":null}`))
	}))
	defer server.Close()

	var out bytes.Buffer
	if err := runUpdate(context.Background(), &out, &bytes.Buffer{}, "1.2.3", server.URL); err != nil {
		t.Fatalf("runUpdate: %v", err)
	}
	if !strings.Contains(out.String(), "already up to date") {
		t.Fatalf("unexpected output: %q", out.String())
	}
}

func TestRunUpdateRejectsInvalidReleasePayload(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"version":"not-a-version"}`))
	}))
	defer server.Close()
	if err := runUpdate(context.Background(), &bytes.Buffer{}, &bytes.Buffer{}, "1.0.0", server.URL); err == nil || !strings.Contains(err.Error(), "invalid CLI version") {
		t.Fatalf("expected invalid release error, got %v", err)
	}
}

func TestRunUpdateReportsReleaseLookupFailure(t *testing.T) {
	if err := runUpdate(context.Background(), &bytes.Buffer{}, &bytes.Buffer{}, "1.0.0", "https://example.invalid"); err == nil || !strings.Contains(err.Error(), "check the latest alethia release") {
		t.Fatalf("expected release lookup error, got %v", err)
	}
}

func TestUpdateCommandIsRegistered(t *testing.T) {
	command, _, err := rootCmd.Find([]string{"update"})
	if err != nil || command != updateCmd {
		t.Fatalf("update command not registered: command=%v err=%v", command, err)
	}
	if updateCmd.Args == nil || updateCmd.Annotations[skipUpdateNoticeAnnotation] != "true" {
		t.Fatal("update command must reject arguments and suppress the stale-process notice")
	}
}
