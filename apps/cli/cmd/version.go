// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"

	"github.com/alethialabs-io/alethialabs/apps/cli/internal/update"
	"github.com/alethialabs-io/alethialabs/apps/cli/internal/version"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/spf13/cobra"
)

var versionCmd = &cobra.Command{
	Use:         "version",
	Short:       "Print the alethia CLI version",
	Annotations: map[string]string{skipUpdateNoticeAnnotation: "true"},
	Run: func(cmd *cobra.Command, args []string) {
		fmt.Printf("alethia v%s\n", version.Version)
		if version.Version == "" || version.Version == "dev" {
			return
		}
		latest := ""
		if release, err := update.FetchLatest(WebOrigin()); err == nil {
			latest = release.Version
		} else if cached, ok := update.CachedLatest(); ok {
			latest = cached
		}
		if update.IsNewer(latest, version.Version) {
			ui.Muted(fmt.Sprintf("latest: v%s", latest))
		}
	},
}

func init() {
	rootCmd.AddCommand(versionCmd)
}
