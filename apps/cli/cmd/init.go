// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"os"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/charmbracelet/huh"
	"github.com/spf13/cobra"
)

// initWebOrigin is `alethia init --web-origin`. The form asks exactly one thing,
// so exactly one flag answers it: the flags are a COMPLETE contract, and
// `alethia init --no-input --web-origin https://…` is the scripted equivalent of
// the guided run.
//
// Without it `init --no-input` silently kept whatever origin was already
// resolved. That is a reasonable default and a terrible contract — the one field
// the command exists to set was the one field a script could not set, so an
// unattended first run pointed at the hosted default no matter what it was told.
var initWebOrigin string

var initCmd = &cobra.Command{
	Use:   "init",
	Short: "Set up the CLI (control-plane URL) and log in",
	Long: `Guided one-time setup: choose the control-plane URL (the hosted
alethialabs.io by default, or a self-hosted / dev URL), persist it, then log in.

Pass --web-origin to supply the URL without the prompt; with --no-input and no
--web-origin the already-resolved origin is kept.`,
	Run: func(cmd *cobra.Command, args []string) {
		origin, err := promptWebOrigin(initWebOrigin)
		if err != nil {
			fail(err)
		}
		if err := runConfigSet(os.Stdout, "web-origin", origin); err != nil {
			fail(err)
		}
		fmt.Println()
		if err := performLoginFlow(); err != nil {
			fail(err)
		}
	},
}

// promptWebOrigin resolves the control-plane URL `init` should persist.
//
// Three arms, in precedence order, and the order is the point: an explicitly
// supplied --web-origin wins over everything (validated here so a typo is
// reported before the browser opens), --no-input keeps the already-resolved
// origin rather than guessing, and an interactive run edits the current value in
// a form that validates with the SAME normalizeWebOrigin `config set` gates on.
func promptWebOrigin(flagValue string) (string, error) {
	if flagValue != "" {
		return normalizeWebOrigin(flagValue)
	}
	current, _ := types.ResolveWebOrigin()
	if !canPromptForm() {
		return current, nil
	}
	origin := current
	if origin == "" {
		origin = types.DefaultWebOrigin
	}
	spec := mustAuthField("alethia init", fieldKeyWebOrigin)
	err := runHuhForm(
		huh.NewGroup(
			huh.NewInput().
				Title(spec.Title).
				Description(spec.Description).
				Value(&origin).
				Validate(func(s string) error { _, err := normalizeWebOrigin(s); return err }),
		),
	)
	if err != nil {
		return "", err
	}
	return origin, nil
}

func init() {
	initCmd.Flags().StringVar(&initWebOrigin, "web-origin", "",
		"Control-plane URL to persist (skips the prompt; required with --no-input to change it)")
	rootCmd.AddCommand(initCmd)
}
