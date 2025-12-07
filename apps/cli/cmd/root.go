package cmd

import (
	"fmt"
	"os"

	"github.com/spf13/cobra"
)

var rootCmd = &cobra.Command{
	Use:   "grape",
	Short: "grape is a CLI for managing your infrastructure",
	Run: func(cmd *cobra.Command, args []string) {
		fmt.Println("Welcome to grape CLI!")
	},
}

func Execute() {
	if err := rootCmd.Execute(); err != nil {
		fmt.Println(err)
		os.Exit(1)
	}
}
