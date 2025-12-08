package cmd

import (
	"fmt"

	"github.com/spf13/cobra"
)

var configCmd = &cobra.Command{
	Use:   "config",
	Short: "Manage configurations",
	Run: func(cmd *cobra.Command, args []string) {
		fmt.Println("Use `grape config list` or `grape config get <name>`")
	},
}

func init() {
	rootCmd.AddCommand(configCmd)
}
