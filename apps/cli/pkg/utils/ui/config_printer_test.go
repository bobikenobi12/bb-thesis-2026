// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package ui

import (
	"bytes"
	"io"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// captureStdout runs fn with os.Stdout redirected to a pipe and returns what it
// printed. The ui print helpers write straight to stdout, so this is the only
// way to assert on them.
func captureStdout(t *testing.T, fn func()) string {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("os.Pipe: %v", err)
	}
	orig := os.Stdout
	os.Stdout = w
	done := make(chan string, 1)
	go func() {
		var buf bytes.Buffer
		_, _ = io.Copy(&buf, r)
		done <- buf.String()
	}()

	defer func() {
		os.Stdout = orig
	}()
	fn()
	if err := w.Close(); err != nil {
		t.Fatalf("close pipe: %v", err)
	}
	return <-done
}

// ptr returns a pointer to v, for the many optional Configuration fields.
func ptr[T any](v T) *T { return &v }

// fixedUpdatedAt is a frozen timestamp so the rendered output is deterministic.
var fixedUpdatedAt = time.Date(2026, 3, 4, 5, 6, 7, 0, time.UTC)

func TestPrintConfigurationFullyPopulated(t *testing.T) {
	config := types.Configuration{
		ProjectName:       "atlas",
		EnvironmentStage:  types.EnvironmentStage("production"),
		ContainerPlatform: "eks",
		CloudAccountID:    "123456789012",
		Region:            "eu-central-1",
		IacVersion:        "1.9.0",
		UpdatedAt:         fixedUpdatedAt,
		ProvisionNetwork:  ptr(true),
		CIDRBlock:         ptr("10.0.0.0/16"),
		DnsEnabled:        ptr(true),
		DnsZoneID:         ptr("Z123"),
		DnsDomainName:     ptr("atlas.example.com"),
		DbMinCapacity:     ptr(0.5),
		DbMaxCapacity:     ptr(4.0),
		HasCache:          ptr(true),
	}

	out := captureStdout(t, func() { PrintConfiguration(config) })

	for _, want := range []string{
		"Configuration Details",
		"atlas", "production", "eks",
		// #3659: `format.Date(DateTime)`, not the `2006-01-02 15:04:05` literal. Seconds go with it.
		"4 Mar 2026, 05:06",
		"123456789012", "eu-central-1",
		"Network CIDR:", "10.0.0.0/16",
		"DNS Zone:", "Z123",
		"Domain Name:", "atlas.example.com",
		"Min Capacity:", "Max Capacity:",
		"Cache:", "IaC Version:", "1.9.0",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("configuration output missing %q:\n%s", want, out)
		}
	}
	if strings.Count(out, "Enabled") != 3 {
		t.Errorf("expected three Enabled flags, got %d:\n%s", strings.Count(out, "Enabled"), out)
	}
	// A whole capacity renders without a decimal point; a fractional one keeps it.
	if !strings.Contains(out, "0.5") {
		t.Errorf("fractional capacity not rendered:\n%s", out)
	}
	if strings.Contains(out, "4.0") {
		t.Errorf("a whole capacity must render as an integer:\n%s", out)
	}
}

func TestPrintConfigurationOmitsOptionalSections(t *testing.T) {
	config := types.Configuration{
		ProjectName:      "minimal",
		ProvisionNetwork: ptr(false),
		DnsEnabled:       ptr(false),
		HasCache:         ptr(false),
	}

	out := captureStdout(t, func() { PrintConfiguration(config) })

	for _, unwanted := range []string{"Network CIDR:", "DNS Zone:", "Domain Name:", "Last Updated:"} {
		if strings.Contains(out, unwanted) {
			t.Errorf("output must not carry %q when the feature is off:\n%s", unwanted, out)
		}
	}
	if strings.Count(out, "Disabled") != 3 {
		t.Errorf("expected three Disabled flags, got %d:\n%s", strings.Count(out, "Disabled"), out)
	}
	// SymbolDash, not "N/A". This printer was the third spelling of "nothing to show" — the other two
	// were ui.SymbolDash everywhere else and a hardcoded em dash in token.go — so the same absence
	// rendered differently depending on which command you ran. One glyph now, and asserted through
	// the constant rather than a literal so the next change reaches both.
	if strings.Count(out, SymbolDash) != 2 {
		t.Errorf("both nil capacities must render the dash, got %d:\n%s", strings.Count(out, SymbolDash), out)
	}
}

func TestDerefString(t *testing.T) {
	tests := []struct {
		name string
		in   *string
		want string
	}{
		{name: "nil is empty", in: nil, want: ""},
		{name: "empty stays empty", in: ptr(""), want: ""},
		{name: "value is passed through", in: ptr("10.0.0.0/16"), want: "10.0.0.0/16"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := derefString(tt.in); got != tt.want {
				t.Errorf("derefString() = %q, want %q", got, tt.want)
			}
		})
	}
}
