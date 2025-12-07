package cmd

import (
	"fmt"
	"os"

	"github.com/spf13/cobra"
)

var logoutCmd = &cobra.Command{
	Use:   "logout",
	Short: "Log out from the platform",
	Run: func(cmd *cobra.Command, args []string) {
		credsPath, err := getCredentialsPath()
		if err != nil {
			fmt.Printf("Error getting credentials path: %v\n", err)
			os.Exit(1)
		}

		if _, err := os.Stat(credsPath); os.IsNotExist(err) {
			fmt.Println("You are not currently logged in.")
			return
		}

		if err := os.Remove(credsPath); err != nil {
			fmt.Printf("Error logging out: %v\n", err)
			os.Exit(1)
		}

		fmt.Println("Successfully logged out.")
	},
}

func init() {
	rootCmd.AddCommand(logoutCmd)
}

