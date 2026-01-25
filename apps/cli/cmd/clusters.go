package cmd

import "github.com/spf13/cobra"

// clustersCmd represents the clusters command
var clustersCmd = &cobra.Command{
	Use:   "clusters",
	Short: "Manage your Trellis clusters",
	Long:  `List and manage the Kubernetes clusters connected to your Trellis platform.`,
}

func init() {
	rootCmd.AddCommand(clustersCmd)
}
