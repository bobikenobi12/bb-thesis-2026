package cmd

import (
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/bobikenobi12/bb-thesis-2026/apps/cli/types"
	"github.com/charmbracelet/lipgloss"
	"github.com/imroc/req/v3"
	"github.com/pkg/browser"
	"github.com/spf13/cobra"
	"github.com/AlecAivazis/survey/v2"
)

var openInBrowser bool

var getCmd = &cobra.Command{
	Use:   "get [project_name]",
	Short: "Get a specific configuration by project name",
	Args:  cobra.ExactArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		projectName := args[0]

		token, err := getAuthToken()
		if err != nil {
			fmt.Println(err)
			os.Exit(1)
		}

		webOrigin := os.Getenv("GRAPE_WEB_ORIGIN")
		if webOrigin == "" {
			webOrigin = "https://localhost:3000"
		}
		getURL := fmt.Sprintf("%s/api/cli/configurations/by-project-name/%s", webOrigin, projectName)

		client := req.C()
		var result struct {
			Configuration types.Configuration `json:"configuration"`
		}
		var errMsg struct {
			Error string `json:"error"`
		}

		resp, err := client.R().
			SetBearerAuthToken(token).
			SetSuccessResult(&result).
			SetErrorResult(&errMsg).
			Get(getURL)

		if err != nil {
			fmt.Printf("Error connecting to server: %v\n", err)
			os.Exit(1)
		}

		if resp.IsErrorState() {
			fmt.Printf("Error fetching configuration (HTTP %d): %s\n", resp.StatusCode, errMsg.Error)
			os.Exit(1)
		}

		if result.Configuration.ID == "" {
			fmt.Printf("No configuration found for project: %s\n", projectName)
			return
		}

		printConfiguration(result.Configuration)

		if !openInBrowser {
			prompt := &survey.Confirm{
				Message: "Open in browser?",
			}
			survey.AskOne(prompt, &openInBrowser)
		}

		if openInBrowser {
			url := fmt.Sprintf("%s/dashboard/configurations?highlight=%s", webOrigin, result.Configuration.ID)
			fmt.Printf("Opening in browser: %s\n", url)
			if err := browser.OpenURL(url); err != nil {
				fmt.Printf("Error opening browser: %v\n", err)
			}
		}
	},
}

func init() {
	configCmd.AddCommand(getCmd)
	getCmd.Flags().BoolVarP(&openInBrowser, "open", "o", false, "Open the configuration in the web browser")
}
func printConfiguration(config types.Configuration) {
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
		return kv(key, value.Format("2006-01-02 15:04:05"))
	}

	// General Section
	doc.WriteString(headerStyle.Render("Configuration Details"))
	doc.WriteString("\n")
	// doc.WriteString(kv("Name:", config.Name))
	// doc.WriteString("\n")
	doc.WriteString(kv("Project:", config.ProjectName))
	doc.WriteString("\n")
	doc.WriteString(kv("Environment:", config.EnvironmentStage))
	doc.WriteString("\n")
	doc.WriteString(kv("Container Platform:", config.ContainerPlatform))
	doc.WriteString("\n")
	doc.WriteString(kvTime("Last Updated:", config.UpdatedAt))
	doc.WriteString("\n\n")

	// AWS Section
	doc.WriteString(subHeaderStyle.Render("AWS Configuration"))
	doc.WriteString("\n")
	doc.WriteString(kv("Account ID:", config.AwsAccountID))
	doc.WriteString("\n")
	doc.WriteString(kv("Region:", config.AwsRegion))
	doc.WriteString("\n\n")

	// Network Section
	doc.WriteString(subHeaderStyle.Render("Network Configuration"))
	doc.WriteString("\n")
	doc.WriteString(kvBool("Create VPC:", config.CreateVpc))
	if config.CreateVpc != nil && *config.CreateVpc {
		doc.WriteString("\n")
		doc.WriteString(kv("VPC CIDR:", *config.VpcCidr))
	}
	doc.WriteString("\n")
	doc.WriteString(kvBool("Enable DNS:", config.EnableDns))
	if config.EnableDns != nil && *config.EnableDns {
		doc.WriteString("\n")
		doc.WriteString(kv("Hosted Zone:", *config.DnsHostedZone))
		doc.WriteString("\n")
		doc.WriteString(kv("Domain Name:", *config.DnsDomainName))
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
		doc.WriteString(kv("Allowed CIDR Blocks:", *config.RedisAllowedCidrBlocks))
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
