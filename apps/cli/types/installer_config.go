package types

type InstallerConfig struct {
	ProjectName string `yaml:"project_name"`
	Region      string `yaml:"region"`
	Environment string `yaml:"environment"`
	AwsAccountID string `yaml:"aws_account_id"`
	TerraformVer string `yaml:"terraform_ver"`
	EnvTemplateRepo string `yaml:"env_template_repo"`
	EnvTemplateRepoBranch string `yaml:"env_template_repo_branch"`
	EnvGitRepo string `yaml:"env_git_repo"`
	GitopsTemplateRepo string `yaml:"gitops_template_repo"`
	GitopsTemplateRepoBranch string `yaml:"gitops_template_repo_branch"`
	GitopsDestinationRepo string `yaml:"gitops_destination_repo"`
	ApplicationsTemplateRepo string `yaml:"applications_template_repo"`
	ApplicationsTemplateRepoBranch string `yaml:"applications_template_repo_branch"`
	ApplicationsDestinationRepo string `yaml:"applications_destination_repo"`
}
