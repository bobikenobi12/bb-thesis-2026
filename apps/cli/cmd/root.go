// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"

	"github.com/alethialabs-io/alethialabs/apps/cli/internal/update"
	"github.com/alethialabs-io/alethialabs/apps/cli/internal/version"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/spf13/cobra"
)

const (
	websiteURL                 = "https://alethialabs.io"
	docsURL                    = "https://alethialabs.io/docs"
	skipUpdateNoticeAnnotation = "alethia.io/skip-update-notice"
)

func init() {
	rootCmd.Version = version.Version
	// The four flags every command in the tree inherits, registered from the ONE place they are
	// described. Their usage strings, their defaults and the rows the docs tables carry for them
	// all come from shellFields — see shell_fields.go for why a global is the value most likely to
	// drift, and hyg_cli_shellform_test.go for what holds the renderings together.
	registerShellGlobalFlags(rootCmd)
}

var rootCmd = &cobra.Command{
	Use:   "alethia",
	Short: "alethia — multi-cloud Kubernetes control plane, from the terminal",
	Long: `alethia is the command-line interface to the Alethia control plane.
Configure infrastructure visually, then plan, deploy, and tear it down across
AWS, GCP, and Azure from the terminal.`,
	// Resolves the input mode (--no-input / non-TTY stdin) and the org scope (--org) before any
	// subcommand runs, so the interactive selectors know whether prompting is allowed and every
	// request the command makes names the same organization.
	//
	// This is the ONLY PersistentPreRun in the tree, and that is load-bearing rather than
	// incidental: cobra runs the nearest one and no others, so a subcommand growing its own would
	// silently stop resolving both. hyg_cli_orgscope_test.go asserts it.
	PersistentPreRun: func(cmd *cobra.Command, args []string) {
		resolveInputMode(cmd)
		applyOrgScope()
	},
	// Runs after any subcommand that doesn't override it — surfaces the upgrade
	// notice once per day without ever blocking the command.
	PersistentPostRun: func(cmd *cobra.Command, args []string) {
		if cmd.Annotations != nil && cmd.Annotations[skipUpdateNoticeAnnotation] == "true" {
			return
		}
		update.CheckAndNotify(version.Version, WebOrigin())
	},
	Run: func(cmd *cobra.Command, args []string) {
		printBanner()
		fmt.Println()
		cmd.Help()
	},
}

// printBanner renders the grayscale Alethia lockup shown for a bare `alethia`.
func printBanner() {
	ver := version.Version

	fmt.Println()
	fmt.Printf("  %s %s   %s\n",
		ui.RenderMark(),
		ui.StrongStyle.Render("alethia"),
		ui.Eyebrow("control plane"),
	)
	fmt.Printf("  %s\n", ui.SecondaryStyle.Render("Configure infrastructure visually. Deploy from the terminal."))
	fmt.Println()

	row := func(label, value string) {
		fmt.Printf("  %s  %s\n", ui.MutedStyle.Render(fmt.Sprintf("%-9s", label)), value)
	}
	row("version", ui.TextStyle.Render(ver))
	row("website", ui.LinkStyle.Render(websiteURL))
	row("docs", ui.LinkStyle.Render(docsURL))
}

// WebOrigin returns the Alethia control-plane URL, resolved as
// ALETHIA_WEB_ORIGIN env > persisted config > the hosted default. Prod needs no
// setup; self-host/dev override it via `alethia config set web-origin` or the env.
func WebOrigin() string {
	origin, _ := types.ResolveWebOrigin()
	return origin
}

func Execute() {
	if err := rootCmd.Execute(); err != nil {
		fail(err)
	}
}
