// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package ui

import (
	"fmt"
	"strings"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/format"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/charmbracelet/lipgloss"
)

var (
	subHeaderStyle = lipgloss.NewStyle().Bold(true).Foreground(InkMuted).Padding(0, 0, 0, 2)
	printKeyStyle  = lipgloss.NewStyle().Foreground(InkMuted).Padding(0, 2, 0, 4)
)

func PrintConfiguration(config types.Configuration) {
	doc := strings.Builder{}

	kv := func(key string, value string) string {
		return printKeyStyle.Render(key) + ValueStyle.Render(value)
	}
	kvBool := func(key string, value *bool) string {
		valStr := "Disabled"
		if value != nil && *value {
			valStr = "Enabled"
		}
		return kv(key, valStr)
	}
	kvNum := func(key string, value *float64) string {
		valStr := SymbolDash
		if value != nil {
			if *value == float64(int(*value)) {
				valStr = fmt.Sprintf("%d", int(*value))
			} else {
				valStr = fmt.Sprintf("%.1f", *value)
			}
		}
		return kv(key, valStr)
	}
	// The layout literal was `2006-01-02 15:04:05` — one of five copies of it across the CLI, and
	// a sixth date spelling against the console's. `format.Date(DateTime)` is the one absolute
	// layout; UTC and not the host zone, so the same config does not print two different times on
	// two machines. Seconds are dropped with it, which is the point: `alethia config show` is read,
	// not diffed, and a second-precision stamp in a detail pane is noise.
	kvTime := func(key string, value time.Time) string {
		if value.IsZero() {
			return kv(key, SymbolDash)
		}
		return kv(key, format.Date(value, format.DateTime, time.UTC))
	}

	doc.WriteString(AccentStyle.Render("  Configuration Details"))
	doc.WriteString("\n\n")
	doc.WriteString(kv("Project:", config.ProjectName))
	doc.WriteString("\n")
	doc.WriteString(kv("Environment:", string(config.EnvironmentStage)))
	doc.WriteString("\n")
	doc.WriteString(kv("Container Platform:", config.ContainerPlatform))
	doc.WriteString("\n")
	if !config.UpdatedAt.IsZero() {
		doc.WriteString(kvTime("Last Updated:", config.UpdatedAt))
		doc.WriteString("\n\n")
	} else {
		doc.WriteString("\n")
	}

	doc.WriteString(subHeaderStyle.Render("Cloud"))
	doc.WriteString("\n")
	doc.WriteString(kv("Account ID:", config.CloudAccountID))
	doc.WriteString("\n")
	doc.WriteString(kv("Region:", config.Region))
	doc.WriteString("\n\n")

	doc.WriteString(subHeaderStyle.Render("Network Configuration"))
	doc.WriteString("\n")
	doc.WriteString(kvBool("Provision Network:", config.ProvisionNetwork))
	if config.ProvisionNetwork != nil && *config.ProvisionNetwork {
		doc.WriteString("\n")
		doc.WriteString(kv("Network CIDR:", derefString(config.CIDRBlock)))
	}
	doc.WriteString("\n")
	doc.WriteString(kvBool("Enable DNS:", config.DnsEnabled))
	if config.DnsEnabled != nil && *config.DnsEnabled {
		doc.WriteString("\n")
		doc.WriteString(kv("DNS Zone:", derefString(config.DnsZoneID)))
		doc.WriteString("\n")
		doc.WriteString(kv("Domain Name:", derefString(config.DnsDomainName)))
	}
	doc.WriteString("\n\n")

	doc.WriteString(subHeaderStyle.Render("Database Configuration"))
	doc.WriteString("\n")
	doc.WriteString(kvNum("Min Capacity:", config.DbMinCapacity))
	doc.WriteString("\n")
	doc.WriteString(kvNum("Max Capacity:", config.DbMaxCapacity))
	doc.WriteString("\n\n")

	doc.WriteString(subHeaderStyle.Render("Services"))
	doc.WriteString("\n")
	doc.WriteString(kvBool("Cache:", config.HasCache))
	doc.WriteString("\n\n")

	doc.WriteString(subHeaderStyle.Render("Advanced"))
	doc.WriteString("\n")
	doc.WriteString(kv("IaC Version:", config.IacVersion))
	doc.WriteString("\n")

	fmt.Println(doc.String())
}

func derefString(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
