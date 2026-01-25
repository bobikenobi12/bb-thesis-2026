package cmd

import (
	"context"
	"fmt"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"text/template"

	"github.com/bobikenobi12/bb-thesis-2026/apps/cli/api"
	"github.com/bobikenobi12/bb-thesis-2026/apps/cli/aws"
	"github.com/bobikenobi12/bb-thesis-2026/apps/cli/helm"
	"github.com/bobikenobi12/bb-thesis-2026/apps/cli/internal/assets"
	"github.com/bobikenobi12/bb-thesis-2026/apps/cli/terraform"
	"github.com/bobikenobi12/bb-thesis-2026/apps/cli/utils"
	"github.com/charmbracelet/huh"
	"github.com/spf13/cobra"
)

var (
	projectName string
	environment string
	region      string
	vpcCidr     string
	selectedVpc string
)

var bootstrapCmd = &cobra.Command{
	Use:   "bootstrap",
	Short: "Bootstrap a new Trellis environment on AWS",
	Long: `Bootstrap transitions a raw AWS account into a managed Trellis environment.
It provisions the necessary base infrastructure (VPC, EKS) and installs the Tendril agent.`,
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			log.Fatalf("Authentication failed: %v", err)
		}

		ctx := context.Background()

		// Interactive Mode if project name is missing
		if projectName == "" {
			// Fetch existing VPCs to offer as choices
			fmt.Println("🔍 Fetching existing VPCs from your AWS account...")
			ec2Client, err := aws.NewEC2Client(ctx, region)
			var vpcOptions []huh.Option[string]
			vpcOptions = append(vpcOptions, huh.NewOption("Create New VPC", "new"))

			if err == nil {
				vpcs, _ := ec2Client.ListVPCs(ctx)
				for _, v := range vpcs {
					label := fmt.Sprintf("%s (%s) - %s", v.ID, v.CIDR, v.Name)
					if v.IsDefault {
						label += " [Default]"
					}
					vpcOptions = append(vpcOptions, huh.NewOption(label, v.ID))
				}
			}

			form := huh.NewForm(
				huh.NewGroup(
					huh.NewInput().
						Title("Project Name").
						Description("Enter a unique name for your project").
						Value(&projectName).
						Validate(func(str string) error {
							if len(str) < 3 {
								return fmt.Errorf("project name must be at least 3 characters")
							}
							return nil
						}),
					huh.NewSelect[string]().
						Title("Environment").
						Options(
							huh.NewOption("Development", "dev"),
							huh.NewOption("Staging", "staging"),
							huh.NewOption("Production", "prod"),
						).
						Value(&environment),
					huh.NewSelect[string]().
						Title("AWS Region").
						Options(
							huh.NewOption("Europe (Frankfurt)", "eu-central-1"),
							huh.NewOption("Europe (Ireland)", "eu-west-1"),
							huh.NewOption("US East (N. Virginia)", "us-east-1"),
							huh.NewOption("US West (Oregon)", "us-west-2"),
						).
						Value(&region),
					huh.NewSelect[string]().
						Title("VPC Selection").
						Description("Choose an existing VPC or create a new one").
						Options(vpcOptions...).
						Value(&selectedVpc),
				),
				huh.NewGroup(
					huh.NewInput().
						Title("VPC CIDR").
						Description("CIDR block for the new VPC").
						Value(&vpcCidr).
						Validate(func(str string) error {
							if str == "" {
								return fmt.Errorf("CIDR cannot be empty")
							}
							return nil
						}),
				).WithHideFunc(func() bool {
					return selectedVpc != "new"
				}),
			)

			err = form.Run()
			if err != nil {
				fmt.Println("Cancelled.")
				return
			}
		}

		if vpcCidr == "" {
			vpcCidr = "10.0.0.0/16"
		}

		fmt.Println("🚀 Bootstrapping Trellis Environment...")
		fmt.Printf("   Project: %s, Env: %s, Region: %s\n", projectName, environment, region)
		if selectedVpc == "new" {
			fmt.Printf("   VPC: Creating New (%s)\n", vpcCidr)
		} else {
			fmt.Printf("   VPC: Using Existing (%s)\n", selectedVpc)
		}
		
		        // 1. Prepare Workspace
		        home, err := os.UserHomeDir()
		        if err != nil {
		            log.Fatalf("Failed to get home directory: %v", err)
		        }
		        
		        workDir := filepath.Join(home, ".grape", "workspaces", fmt.Sprintf("%s-%s", projectName, environment))
		        if err := os.MkdirAll(workDir, 0755); err != nil {
		            log.Fatalf("Failed to create workspace directory: %v", err)
		        }
		
		        fmt.Printf("   📂 Workspace: %s\n", workDir)
		// 2. Extract Embedded Terraform Assets
		err = extractAssets(workDir)
		if err != nil {
			log.Fatalf("Failed to extract assets: %v", err)
		}

		// 3. Initialize Terraform
		tf, err := terraform.NewTF_CLI("1.7.4")
		if err != nil {
			log.Fatalf("Failed to initialize Terraform CLI: %v", err)
		}

		// 4. Terraform Init
		if err := tf.Init(workDir, "", false); err != nil {
			log.Fatalf("Terraform init failed: %v", err)
		}

		// 5. Create tfvars
		if err := createTfvars(workDir); err != nil {
			log.Fatalf("Failed to create tfvars: %v", err)
		}

		// 6. Terraform Apply
		fmt.Println("   ⚡ Provisioning Seed Infrastructure (this may take 15-20 mins)...")
		
		planFile := filepath.Join(workDir, "tfplan")
		if err := tf.Plan(workDir, "terraform.tfvars", planFile); err != nil {
			log.Fatalf("Terraform plan failed: %v", err)
		}

		if err := tf.Apply(workDir, planFile); err != nil {
			log.Fatalf("Terraform apply failed: %v", err)
		}

		// 7. Get Outputs
		outputs, err := tf.Output(workDir, "")
		if err != nil {
			log.Fatalf("Failed to get outputs: %v", err)
		}

		fmt.Println("   ✅ Infrastructure Provisioned Successfully!")
		clusterName := fmt.Sprintf("%v", outputs["cluster_name"])
		fmt.Printf("      Cluster: %s\n", clusterName)
		fmt.Printf("      Endpoint: %v\n", outputs["cluster_endpoint"])

		        // 8. Agent Registration
				fmt.Println("   🔐 Registering Agent with Trellis...")
				client := api.NewClient(token)
				
				finalVpcID := ""
				if selectedVpc != "new" {
					finalVpcID = selectedVpc
				}
				
				regResp, err := client.RegisterCluster(clusterName, finalVpcID, vpcCidr, region)
				if err != nil {
					log.Fatalf("Failed to register cluster: %v", err)
				}
		
				fmt.Printf("      Cluster ID: %s\n", regResp.ClusterID)
				
				// 9. Configure kubectl
				fmt.Println("   🔌 Configuring kubectl context...")
				updateKubeconfigCmd := fmt.Sprintf("aws eks update-kubeconfig --region %s --name %s", region, clusterName)
				if err := utils.ExecuteCommand(updateKubeconfigCmd, workDir, nil); err != nil {
					log.Fatalf("Failed to update kubeconfig: %v", err)
				}
		
				// 10. Install Tendril Agent via Helm
				fmt.Println("   📦 Installing Tendril Agent...")
				
				// Create values.yaml
				valuesContent := fmt.Sprintf(`config:
  clusterId: %q
  apiToken: %q
  supabaseUrl: %q
  supabaseKey: %q
  grapeApiOrigin: %q
`, regResp.ClusterID, regResp.AgentToken, os.Getenv("NEXT_PUBLIC_SUPABASE_URL"), os.Getenv("NEXT_PUBLIC_SUPABASE_ANON_KEY"), os.Getenv("GRAPE_WEB_ORIGIN"))
				
				valuesPath := filepath.Join(workDir, "tendril-values.yaml")
				if err := os.WriteFile(valuesPath, []byte(valuesContent), 0644); err != nil {
					log.Fatalf("Failed to write helm values: %v", err)
				}
		
				chartPath := filepath.Join(workDir, "helm/tendril")
				helmClient := helm.NewHelmCLI(false)
				
				// We need a dummy logger or real one for HelmCLI
				// Using a simple struct satisfying the interface would work, or just nil if it checks
				// Looking at HelmCLI code, it calls logger.Info directly.
				// I will create a simple logger adapter.
				logger := utils.NewLogger(nil, "bootstrap") // nil client means no API logging, just stdout
		
				if err := helmClient.UpgradeInstall("tendril", chartPath, "tendril-system", valuesPath, nil, "", logger); err != nil {
					log.Fatalf("Failed to install Tendril Agent: %v", err)
				}
		
				fmt.Println("   ✅ Tendril Agent Installed!")
				fmt.Println("   waiting for agent to come online...")
				// TODO: Poll for status
			},
		}
		
		func init() {
			rootCmd.AddCommand(bootstrapCmd)
		
			bootstrapCmd.Flags().StringVarP(&projectName, "project-name", "p", "", "Name of the project")
			bootstrapCmd.Flags().StringVarP(&environment, "environment", "e", "dev", "Environment name (e.g., dev, prod)")
			bootstrapCmd.Flags().StringVarP(&region, "region", "r", "eu-central-1", "AWS Region")
			bootstrapCmd.Flags().StringVar(&vpcCidr, "vpc-cidr", "10.0.0.0/16", "CIDR block for the new VPC")
		}
		
		func extractAssets(destDir string) error {
			fsys := assets.Assets
		
			// Map of source directory in embed -> destination directory relative to workspace
			dirs := map[string]string{
				"terraform/seed": ".",
				"helm/tendril":   "helm/tendril",
			}
		
			for srcRoot, destRel := range dirs {
				err := fs.WalkDir(fsys, srcRoot, func(path string, d fs.DirEntry, err error) error {
					if err != nil {
						return err
					}
		
					// Get path relative to the source root
					relPath, err := filepath.Rel(srcRoot, path)
					if err != nil {
						return err
					}
		
					if relPath == "." {
						return nil
					}
		
					// Construct destination path
					finalDest := filepath.Join(destDir, destRel, relPath)
		
					if d.IsDir() {
						return os.MkdirAll(finalDest, 0755)
					}
		
					data, err := fsys.ReadFile(path)
					if err != nil {
						return err
					}
					
					// Ensure parent directory exists
					if err := os.MkdirAll(filepath.Dir(finalDest), 0755); err != nil {
						return err
					}
		
					return os.WriteFile(finalDest, data, 0644)
				})
				if err != nil {
					return err
				}
			}
			return nil
		}		
		func createTfvars(dir string) error {
			tfvarsPath := filepath.Join(dir, "terraform.tfvars")
		
			tmplContent := `project_name = "{{.ProjectName}}"
environment  = "{{.Environment}}"
region       = "{{.Region}}"
vpc_cidr     = "{{.VpcCidr}}"
vpc_id       = "{{.VpcId}}"
`
			tmpl, err := template.New("tfvars").Parse(tmplContent)
			if err != nil {
				return err
			}
		
			f, err := os.Create(tfvarsPath)
			if err != nil {
				return err
			}
			defer f.Close()
		
			vpcID := ""
			if selectedVpc != "new" {
				vpcID = selectedVpc
			}
		
			data := struct {
				ProjectName string
				Environment string
				Region      string
				VpcCidr     string
				VpcId       string
			}{
				ProjectName: projectName,
				Environment: environment,
				Region:      region,
				VpcCidr:     vpcCidr,
				VpcId:       vpcID,
			}
		
			return tmpl.Execute(f, data)
		}
		
