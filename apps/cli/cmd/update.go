// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"context"
	"fmt"
	"io"
	"os"

	"github.com/alethialabs-io/alethialabs/apps/cli/internal/update"
	"github.com/alethialabs-io/alethialabs/apps/cli/internal/version"
	"github.com/spf13/cobra"
)

var updateCmd = &cobra.Command{
	Use:         "update",
	Short:       "Update the alethia CLI",
	Args:        cobra.NoArgs,
	Annotations: map[string]string{skipUpdateNoticeAnnotation: "true"},
	Run: func(cmd *cobra.Command, args []string) {
		if err := runUpdate(cmd.Context(), os.Stdout, os.Stderr, version.Version, WebOrigin()); err != nil {
			fail(err)
		}
	},
}

// runUpdate checks the canonical release API and updates through the detected install channel.
func runUpdate(ctx context.Context, stdout, stderr io.Writer, current, origin string) error {
	if current == "" || current == "dev" {
		return fmt.Errorf("development builds cannot update themselves")
	}
	release, err := update.FetchLatest(origin)
	if err != nil {
		return fmt.Errorf("check the latest alethia release: %w", err)
	}
	return update.Apply(ctx, current, *release, stdout, stderr)
}

func init() {
	rootCmd.AddCommand(updateCmd)
}
