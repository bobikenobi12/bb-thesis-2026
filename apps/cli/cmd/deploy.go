package cmd

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/AlecAivazis/survey/v2"
	"github.com/bobikenobi12/bb-thesis-2026/apps/cli/api"
	"github.com/bobikenobi12/bb-thesis-2026/apps/cli/aws"
	"github.com/bobikenobi12/bb-thesis-2026/apps/cli/git"
	"github.com/bobikenobi12/bb-thesis-2026/apps/cli/helm"
	"github.com/bobikenobi12/bb-thesis-2026/apps/cli/infracost"
	"github.com/bobikenobi12/bb-thesis-2026/apps/cli/k8s"
	"github.com/bobikenobi12/bb-thesis-2026/apps/cli/state"
	"github.com/bobikenobi12/bb-thesis-2026/apps/cli/terraform"
	"github.com/bobikenobi12/bb-thesis-2026/apps/cli/utils"
	"github.com/spf13/cobra"
)

var (
	dryRun                bool
	createStateBucketOnly bool
	updateInfra           bool
	updateGitOps          bool
	updateAll             bool
	updateInfraFactsOnly  bool
	infracostToken        string
	awsProfile            string
)

var deployCmd = &cobra.Command{
	Use:   "deploy [project_name]",
	Short: "Deploy a project's infrastructure",
	Args:  cobra.ExactArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		projectName := args[0]
		
		token, err := getAuthToken()
		if err != nil {
			fmt.Printf("Error getting auth token: %v\n", err)
			os.Exit(1)
		}
		apiClient := api.NewClient(token)

		config, err := apiClient.GetConfiguration(projectName)
		if err != nil {
			fmt.Printf("Error fetching configuration for project '%s': %v\n", projectName, err)
			os.Exit(1)
		}

		deployment, err := apiClient.CreateDeployment(config.ID, fmt.Sprintf("Deployment for %s", projectName), "terraform", config.TerraformVersion)
		if err != nil {
			fmt.Printf("Error creating deployment record: %v\n", err)
			os.Exit(1)
		}

		logger := utils.NewLogger(apiClient, deployment.ID)
		logger.Info(fmt.Sprintf("Starting deployment for project: %s", projectName), "")
		
		defer func() {
			if r := recover(); r != nil {
				logger.Error(fmt.Sprintf("Deployment failed with a panic: %v", r), "cleanup")
				apiClient.UpdateDeploymentStatus(deployment.ID, "failed", fmt.Sprintf("%v", r))
			}
		}()

		if dryRun {
			logger.Info("Running in dry-run mode", "setup")
		}

		if createStateBucketOnly {
			logger.Info("Only creating state bucket", "s3")
			bucketName := fmt.Sprintf("%s-%s-%s-idp-state", config.ProjectName, config.EnvironmentStage, config.AwsRegion)

			s3Client, err := aws.NewS3Client(context.Background(), config.AwsRegion)
			if err != nil {
				logger.Error(fmt.Sprintf("Error creating S3 client: %v", err), "s3")
				os.Exit(1)
			}

			err = s3Client.CreateS3BucketIfNotExists(context.Background(), bucketName, config.AwsRegion, dryRun)
			if err != nil {
				logger.Error(fmt.Sprintf("Error creating S3 bucket: %v", err), "s3")
				os.Exit(1)
			}
			apiClient.UpdateDeploymentStatus(deployment.ID, "completed", "")
			return
		}

		// Git repo cloning
		logger.Info("Cloning template repositories...", "git")
		argoTemplateRepo := git.NewGIT(config.GitopsTemplateRepo, "git/template_argo_repo", dryRun)
		handleRepoCloning(argoTemplateRepo, config.GitopsTemplateRepoBranch, true, apiClient, logger)

		envTemplateRepo := git.NewGIT(config.EnvTemplateRepo, "git/template_repo", dryRun)
		handleRepoCloning(envTemplateRepo, config.EnvTemplateRepoBranch, true, apiClient, logger)

		var applicationsTemplateRepo *git.GIT
		if config.ApplicationsTemplateRepo != "" {
			applicationsTemplateRepo = git.NewGIT(config.ApplicationsTemplateRepo, "git/template_applications_repo", dryRun)
			handleRepoCloning(applicationsTemplateRepo, config.ApplicationsTemplateRepoBranch, true, apiClient, logger)
		}

		logger.Info("Cloning client repositories...", "git")
		argoClientRepo := git.NewGIT(config.GitopsDestinationRepo, "git/client_argo_repo", dryRun)
		handleRepoCloning(argoClientRepo, "", false, apiClient, logger)

		envClientRepo := git.NewGIT(config.EnvGitRepo, "git/client_repo", dryRun)
		handleRepoCloning(envClientRepo, "", false, apiClient, logger)

		var applicationsClientRepo *git.GIT
		if config.ApplicationsDestinationRepo != "" {
			applicationsClientRepo = git.NewGIT(config.ApplicationsDestinationRepo, "git/client_applications_repo", dryRun)
			handleRepoCloning(applicationsClientRepo, "", false, apiClient, logger)
		}

		tf, err := terraform.NewTF_CLI(config.TerraformVersion)
		if err != nil {
			logger.Error(fmt.Sprintf("Error initializing Terraform: %v", err), "terraform")
			os.Exit(1)
		}

		tfDir, err := filepath.Abs(envClientRepo.LocalPath)
		if err != nil {
			logger.Error(fmt.Sprintf("Error getting absolute path for terraform directory: %v", err), "terraform")
			os.Exit(1)
		}

		repoFilesMap := map[string]string{
			"variable-template/terraform.tfvars": "terraform.tfvars",
			"backends/backend.tfvars":            "backend.tfvars",
		}

		err = envClientRepo.Bootstrap(envTemplateRepo, repoFilesMap, updateInfra || updateAll, logger)
		if err != nil {
			logger.Error(fmt.Sprintf("Error bootstrapping infrastructure repo: %v", err), "git")
			apiClient.UpdateDeploymentStatus(deployment.ID, "failed", err.Error())
			os.Exit(1)
		}

		backendConfig, err := tf.GenerateBackendConfig(config)
		if err != nil {
			logger.Error(fmt.Sprintf("Error generating backend config: %v", err), "terraform")
			os.Exit(1)
		}

		varFile, err := tf.OverrideTfvars(tfDir, config)
		if err != nil {
			logger.Error(fmt.Sprintf("Error overriding tfvars: %v", err), "terraform")
			os.Exit(1)
		}

		planFile, err := filepath.Abs(filepath.Join(tfDir, "terraform.plan.out"))
		if err != nil {
			logger.Error(fmt.Sprintf("Error getting absolute path for plan file: %v", err), "terraform")
			os.Exit(1)
		}

		defer func() {
			if err := os.Remove(planFile); err != nil && !os.IsNotExist(err) {
				logger.Warn(fmt.Sprintf("Failed to remove plan file %s: %v", planFile, err), "cleanup")
			}
		}()

		err = tf.Init(tfDir, backendConfig, updateInfra)
		if err != nil {
			logger.Error(fmt.Sprintf("Error running terraform init: %v", err), "terraform-init")
			apiClient.UpdateDeploymentStatus(deployment.ID, "failed", err.Error())
			os.Exit(1)
		}

		err = tf.Plan(tfDir, varFile, planFile)
		if err != nil {
			logger.Error(fmt.Sprintf("Error running terraform plan: %v", err), "terraform-plan")
			apiClient.UpdateDeploymentStatus(deployment.ID, "failed", err.Error())
			os.Exit(1)
		}

		var infracostEnv []string
		if infracostToken != "" {
			infracostEnv = append(infracostEnv, "INFRACOST_API_KEY="+infracostToken)
		}
		infracostCLI := infracost.NewInfracostCLI("v0.10.39", infracostToken)
		if err := infracostCLI.RunInfracost(planFile, infracostEnv); err != nil {
			logger.Warn(fmt.Sprintf("Infracost analysis failed: %v", err), "infracost")
		}

		if !dryRun {
			logger.Info("Applying Terraform changes...", "terraform-apply")
			err = tf.Apply(tfDir, planFile)
			if err != nil {
				logger.Error(fmt.Sprintf("Error running terraform apply: %v", err), "terraform-apply")
				apiClient.UpdateDeploymentStatus(deployment.ID, "failed", err.Error())
				os.Exit(1)
			}
		} else {
			logger.Info("Dry-run mode: Skipping terraform apply.", "terraform-apply")
		}

		outputs, err := tf.Output(tfDir, "")
		if err != nil {
			logger.Error(fmt.Sprintf("Error retrieving terraform outputs: %v", err), "terraform-output")
			apiClient.UpdateDeploymentStatus(deployment.ID, "failed", err.Error())
			os.Exit(1)
		}

		logger.Info(fmt.Sprintf("Terraform Outputs: %+v", outputs), "terraform-output")

		s := state.NewState()
		err = s.SaveInfraFacts(config, outputs, dryRun, logger)
		if err != nil {
			logger.Error(fmt.Sprintf("Error saving infra-facts: %v", err), "state")
			apiClient.UpdateDeploymentStatus(deployment.ID, "failed", err.Error())
			os.Exit(1)
		}

		err = argoClientRepo.BootstrapArgo(config, argoTemplateRepo, "temp/infra-facts.yaml", updateGitOps || updateAll, updateInfraFactsOnly, logger)
		if err != nil {
			logger.Error(fmt.Sprintf("Error bootstrapping Argo repo: %v", err), "git")
			apiClient.UpdateDeploymentStatus(deployment.ID, "failed", err.Error())
			os.Exit(1)
		}

		if applicationsClientRepo != nil && applicationsTemplateRepo != nil {
			err = applicationsClientRepo.BootstrapAppRepo(config, applicationsTemplateRepo, "temp/infra-facts.yaml", updateGitOps || updateAll, updateInfraFactsOnly, logger)
			if err != nil {
				logger.Error(fmt.Sprintf("Error bootstrapping applications repo: %v", err), "git")
				apiClient.UpdateDeploymentStatus(deployment.ID, "failed", err.Error())
				os.Exit(1)
			}
		}

		if updateInfraFactsOnly {
			logger.Info("Exiting due to --update-infra-facts-only", "done")
			apiClient.UpdateDeploymentStatus(deployment.ID, "completed", "")
			return
		}

		// K8s context and Helm/K8s operations
		var clusterName string
		if val, ok := outputs["eks_cluster_name"]; ok {
			if m, ok := val.(map[string]interface{}); ok {
				if v, ok := m["value"].(string); ok {
					clusterName = v
				}
			}
		}

		if clusterName == "" {
			if dryRun {
				logger.Warn("No EKS cluster name found in outputs. Skipping K8s steps (expected in dry-run).", "k8s")
			} else {
				logger.Error("EKS cluster name not found in outputs. Cannot proceed with K8s steps.", "k8s")
				apiClient.UpdateDeploymentStatus(deployment.ID, "failed", "EKS cluster name not found in outputs")
				os.Exit(1)
			}
		} else {
			k8sCLI, err := k8s.NewK8sCLI(awsProfile, config.AwsRegion, dryRun)
			if err != nil {
				logger.Error(fmt.Sprintf("Error initializing K8s CLI: %v", err), "k8s")
				os.Exit(1)
			}

			err = k8sCLI.GetContext(clusterName, logger)
			if err != nil {
				logger.Error(fmt.Sprintf("Error getting K8s context: %v", err), "k8s")
				os.Exit(1)
			}

			helmCLI := helm.NewHelmCLI(dryRun)
			argocdValuesPath := filepath.Join(argoClientRepo.LocalPath, "helm/argo-cd/values", config.EnvironmentStage, config.AwsRegion, "values.yaml")

			var gitopsArgocdToken string
			if config.GitopsArgocdToken != nil {
				gitopsArgocdToken = *config.GitopsArgocdToken
			}

			argocdRepositories := []map[string]string{
				{
					"username": "argocd",
					"password": gitopsArgocdToken,
					"repoUrl":  config.GitopsDestinationRepo,
				},
			}

			if config.ApplicationsTemplateRepo != "" {
				var gitopsAppToken string
				if config.GitopsAppToken != nil {
					gitopsAppToken = *config.GitopsAppToken
				}
				argocdRepositories = append(argocdRepositories, map[string]string{
					"username": "argocd",
					"password": gitopsAppToken,
					"repoUrl":  config.ApplicationsDestinationRepo,
				})
			}

			repoJSON, _ := json.Marshal(argocdRepositories)
			setJSON := fmt.Sprintf("argocdRepositories=%s", string(repoJSON))

			env := map[string]string{
				"AWS_PROFILE": awsProfile,
				"KUBECONFIG":  "temp/kubeconfig",
			}

			err = helmCLI.UpgradeInstall("argocd", filepath.Join(argoClientRepo.LocalPath, "helm/argo-cd"), "argocd", argocdValuesPath, env, setJSON, logger)
			if err != nil {
				logger.Error(fmt.Sprintf("Error installing ArgoCD: %v", err), "helm")
				apiClient.UpdateDeploymentStatus(deployment.ID, "failed", err.Error())
				os.Exit(1)
			}

			logger.Info("Applying ArgoCD manifests...", "k8s")
			err = k8sCLI.Apply("argocd", filepath.Join(argoClientRepo.LocalPath, "manifests/argocd/app-of-app.yaml"), env, logger)
			if err != nil {
				logger.Error(fmt.Sprintf("Error applying app-of-app manifest: %v", err), "k8s")
			}

			infraSvcManifest := filepath.Join(argoClientRepo.LocalPath, "manifests/applications/infra-app-stages", config.EnvironmentStage, config.AwsRegion, "infra-services.yaml")
			err = k8sCLI.Apply("argocd", infraSvcManifest, env, logger)
			if err != nil {
				logger.Error(fmt.Sprintf("Error applying infra-services manifest: %v", err), "k8s")
			}

			if config.ApplicationsTemplateRepo != "" {
				err = k8sCLI.Apply("argocd", filepath.Join(applicationsClientRepo.LocalPath, "manifests/argocd/app-of-app.yaml"), env, logger)
				if err != nil {
					logger.Error(fmt.Sprintf("Error applying applications app-of-app manifest: %v", err), "k8s")
				}

				appsSvcManifest := filepath.Join(applicationsClientRepo.LocalPath, "manifests/applications/applications-app-stages", config.EnvironmentStage, config.AwsRegion, "applications.yaml")
				err = k8sCLI.Apply("argocd", appsSvcManifest, env, logger)
				if err != nil {
					logger.Error(fmt.Sprintf("Error applying applications manifest: %v", err), "k8s")
				}
			}
		}

		apiClient.UpdateDeploymentStatus(deployment.ID, "completed", "")
		logger.Info("Deployment completed successfully.", "done")
	},
}

func handleRepoCloning(g *git.GIT, branch string, force bool, apiClient *api.Client, logger *utils.Logger) {
	err := g.Clone(branch, force)
	if err != nil {
		if strings.Contains(err.Error(), "repository not found") || strings.Contains(err.Error(), "remote repository is empty") {
			createRepo := false
			prompt := &survey.Confirm{
				Message: fmt.Sprintf("Repository %s not found or is empty. Do you want to create it?", g.RepoURL),
			}
			survey.AskOne(prompt, &createRepo)

			if createRepo {
				repoURL, _ := url.Parse(g.RepoURL)
				repoParts := strings.Split(strings.TrimSuffix(repoURL.Path, ".git"), "/")
				repoName := repoParts[len(repoParts)-1]
				
				var provider string
				if strings.Contains(repoURL.Host, "github.com") {
					provider = "github"
				} else if strings.Contains(repoURL.Host, "gitlab.com") {
					provider = "gitlab"
				} else if strings.Contains(repoURL.Host, "bitbucket.org") {
					provider = "bitbucket"
				} else {
					logger.Error(fmt.Sprintf("Unknown Git provider for repository: %s", g.RepoURL), "git")
					os.Exit(1)
				}

				_, err = apiClient.CreateRepository(provider, repoName, "", "")
				if err != nil {
					logger.Error(fmt.Sprintf("Error creating repository: %v", err), "git")
					os.Exit(1)
				}
				logger.Info("Repository created successfully. Retrying clone...", "git")
				handleRepoCloning(g, branch, force, apiClient, logger) // Retry cloning
			} else {
				logger.Info("Aborting.", "git")
				os.Exit(1)
			}
		}
	} else {
		logger.Error(fmt.Sprintf("Error cloning repo %s: %v", g.RepoURL, err), "git")
		os.Exit(1)
	}
}

func init() {
	rootCmd.AddCommand(deployCmd)
	deployCmd.Flags().BoolVar(&dryRun, "dry-run", false, "Run in dry-run mode without making actual changes")
	deployCmd.Flags().BoolVar(&createStateBucketOnly, "create-state-bucket-only", false, "Only create the state bucket if it does not exist, then exit.")
	deployCmd.Flags().BoolVar(&updateInfra, "update-infra", false, "Update (overwrite) infrastructure (terraform) repository")
	deployCmd.Flags().BoolVar(&updateGitOps, "update-gitops", false, "Update (overwrite) GitOps (argocd) repositories")
	deployCmd.Flags().BoolVar(&updateAll, "update-all", false, "Update both infrastructure and GitOps repositories")
	deployCmd.Flags().BoolVar(&updateInfraFactsOnly, "update-infra-facts-only", false, "Update only the infra-facts.yaml in the repositories")
	deployCmd.Flags().StringVar(&infracostToken, "infracost-token", "", "Infracost API token")
	deployCmd.Flags().StringVar(&awsProfile, "aws-profile", "default", "AWS profile to use")
}