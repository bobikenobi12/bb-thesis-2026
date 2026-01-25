package ui

import (
	"fmt"
	"strings"
	"time"

	"github.com/bobikenobi12/bb-thesis-2026/apps/cli/types"
	"github.com/charmbracelet/lipgloss"
)

// PrintConfiguration prints a formatted configuration summary.
func PrintConfiguration(config types.Configuration) {
	doc := strings.Builder{}

	// Styles
	var (
		headerStyle    = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("63")).Padding(1, 0)
		subHeaderStyle = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("240")).Padding(0, 0, 0, 2)
		keyStyle       = lipgloss.NewStyle().Foreground(lipgloss.Color("244")).Padding(0, 2, 0, 4)
		valueStyle     = lipgloss.NewStyle().Foreground(lipgloss.Color("255"))
	)

	// Helper function for key-value pairs
	kv := func(key string, value string) string {
		return keyStyle.Render(key) + valueStyle.Render(value)
	}
	kvBool := func(key string, value *bool) string {
		valStr := "Disabled"
		if value != nil && *value {
			valStr = "Enabled"
		}
		return kv(key, valStr)
	}
	kvInt := func(key string, value *int) string {
		valStr := "N/A"
		if value != nil {
			valStr = fmt.Sprintf("%d", *value)
		}
		return kv(key, valStr)
	}
	kvTime := func(key string, value time.Time) string {
		if value.IsZero() {
			return kv(key, "N/A")
		}
		return kv(key, value.Format("2006-01-02 15:04:05"))
	}

	// General Section
	doc.WriteString(headerStyle.Render("Configuration Details"))
	doc.WriteString("\n")
	doc.WriteString(kv("Project:", config.ProjectName))
	doc.WriteString("\n")
	doc.WriteString(kv("Environment:", config.EnvironmentStage))
	doc.WriteString("\n")
	doc.WriteString(kv("Container Platform:", config.ContainerPlatform))
	doc.WriteString("\n")
	if !config.UpdatedAt.IsZero() {
		doc.WriteString(kvTime("Last Updated:", config.UpdatedAt))
		doc.WriteString("\n\n")
	} else {
		doc.WriteString("\n")
	}

	// AWS Section
	doc.WriteString(subHeaderStyle.Render("AWS Configuration"))
	doc.WriteString("\n")
	doc.WriteString(kv("Account ID:", config.AwsAccountID))
	doc.WriteString("\n")
	doc.WriteString(kv("Region:", config.AwsRegion))
	doc.WriteString("\n\n")

	// Repositories
	doc.WriteString(subHeaderStyle.Render("Repositories"))
	doc.WriteString("\n")
	doc.WriteString(kv("Environment:", getRepoName(config.EnvGitRepo)))
	doc.WriteString("\n")
	doc.WriteString(kv("GitOps:", getRepoName(config.GitopsDestinationRepo)))
	if config.ApplicationsDestinationRepo != "" {
		doc.WriteString("\n")
		doc.WriteString(kv("Applications:", getRepoName(config.ApplicationsDestinationRepo)))
	}
	doc.WriteString("\n\n")

	// Network Section
	doc.WriteString(subHeaderStyle.Render("Network Configuration"))
	doc.WriteString("\n")
	doc.WriteString(kvBool("Create VPC:", config.CreateVpc))
	if config.CreateVpc != nil && *config.CreateVpc {
		doc.WriteString("\n")
		doc.WriteString(kv("VPC CIDR:", derefString(config.VpcCidr)))
	}
	doc.WriteString("\n")
	doc.WriteString(kvBool("Enable DNS:", config.EnableDns))
	if config.EnableDns != nil && *config.EnableDns {
		doc.WriteString("\n")
		doc.WriteString(kv("Hosted Zone:", derefString(config.DnsHostedZone)))
		doc.WriteString("\n")
		doc.WriteString(kv("Domain Name:", derefString(config.DnsDomainName)))
	}
	doc.WriteString("\n\n")

	// Database Section
	doc.WriteString(subHeaderStyle.Render("Database Configuration"))
	doc.WriteString("\n")
	doc.WriteString(kvInt("Min Capacity:", config.DbMinCapacity))
	doc.WriteString("\n")
	doc.WriteString(kvInt("Max Capacity:", config.DbMaxCapacity))
	doc.WriteString("\n\n")

	// Security Section
	doc.WriteString(subHeaderStyle.Render("Security"))
	doc.WriteString("\n")
	doc.WriteString(kvBool("CloudFront WAF:", config.EnableCloudfrontWaf))
	doc.WriteString("\n")
	doc.WriteString(kvBool("Redis:", config.EnableRedis))
	if config.EnableRedis != nil && *config.EnableRedis {
		doc.WriteString("\n")
		doc.WriteString(kv("Allowed CIDR Blocks:", derefString(config.RedisAllowedCidrBlocks)))
	}
	doc.WriteString("\n\n")

	// Advanced Section
	doc.WriteString(subHeaderStyle.Render("Advanced"))
	doc.WriteString("\n")
	doc.WriteString(kvBool("Karpenter Auto-Scaling:", config.EnableKarpenter))
	doc.WriteString("\n")
	doc.WriteString(kv("Terraform Version:", config.TerraformVersion))
	doc.WriteString("\n")

	fmt.Println(doc.String())
}

func getRepoName(url string) string {
	parts := strings.Split(url, "/")
	if len(parts) > 0 {
		return parts[len(parts)-1]
	}
	return url
}

func derefString(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
