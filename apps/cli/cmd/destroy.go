package cmd

import (
	"fmt"
	"log"
	"os"
	"path/filepath"

	"github.com/bobikenobi12/bb-thesis-2026/apps/cli/terraform"
	"github.com/charmbracelet/huh"
	"github.com/spf13/cobra"
)

var destroyCmd = &cobra.Command{
	Use:   "destroy",
	Short: "Destroy a bootstrapped environment",
	Long:  `Destroy removes all resources associated with a specific project and environment.`,
	Run: func(cmd *cobra.Command, args []string) {
		// Interactive Mode if project name is missing
		if projectName == "" {
			form := huh.NewForm(
				huh.NewGroup(
					huh.NewInput().
						Title("Project Name").
						Description("Enter the name of the project to destroy").
						Value(&projectName),
					huh.NewSelect[string]().
							Title("Environment").
							Options(
							huh.NewOption("Development", "dev"),
							huh.NewOption("Staging", "staging"),
							huh.NewOption("Production", "prod"),
						).
						Value(&environment),
				),
			)

			err := form.Run()
			if err != nil {
				fmt.Println("Cancelled.")
				return
			}
		}

		// Confirm destruction
		var confirm bool
		confirmForm := huh.NewForm(
			huh.NewGroup(
				huh.NewConfirm().
					Title(fmt.Sprintf("Are you sure you want to destroy %s-%s?", projectName, environment)).
					Description("This action cannot be undone.").
					Value(&confirm),
			),
		)
		if err := confirmForm.Run(); err != nil || !confirm {
			fmt.Println("Operation cancelled.")
			return
		}

		home, err := os.UserHomeDir()
		if err != nil {
			log.Fatalf("Failed to get home directory: %v", err)
		}

		workDir := filepath.Join(home, ".grape", "workspaces", fmt.Sprintf("%s-%s", projectName, environment))
		if _, err := os.Stat(workDir); os.IsNotExist(err) {
			log.Fatalf("Workspace directory not found: %s", workDir)
		}

		fmt.Printf("🔥 Destroying environment %s-%s...\n", projectName, environment)

		// Initialize Terraform
		tf, err := terraform.NewTF_CLI("1.7.4")
		if err != nil {
			log.Fatalf("Failed to initialize Terraform CLI: %v", err)
		}

		// Run Destroy
		// We assume terraform.tfvars already exists in the workspace from bootstrap
		if err := tf.Destroy(workDir, "terraform.tfvars"); err != nil {
			log.Fatalf("Terraform destroy failed: %v", err)
		}

		// Optional: Remove workspace directory
		// fmt.Println("Removing workspace directory...")
		// os.RemoveAll(workDir)

		fmt.Println("✅ Environment destroyed successfully!")
	},
}

func init() {
	rootCmd.AddCommand(destroyCmd)
	destroyCmd.Flags().StringVarP(&projectName, "project-name", "p", "", "Name of the project")
	destroyCmd.Flags().StringVarP(&environment, "environment", "e", "dev", "Environment name (e.g., dev, prod)")
}
