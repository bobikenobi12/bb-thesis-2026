package types

import "time"

type ConfigurationSummary struct {
	ID string `json:"id"`
	// Name             string    `json:"name"`
	ProjectName       string    `json:"project_name"`
	EnvironmentStage  string    `json:"environment_stage"`
	ContainerPlatform string    `json:"container_platform"`
	CreatedAt         time.Time `json:"created_at"`
	UpdatedAt         time.Time `json:"updated_at"`
}

type Configuration struct {
	AwsAccountID            string    `json:"aws_account_id"`
	AwsRegion               string    `json:"aws_region"`
	ContainerPlatform       string    `json:"container_platform"`
	CreateVpc               *bool     `json:"create_vpc"`
	CreatedAt               time.Time `json:"created_at"`
	DbMaxCapacity           *int      `json:"db_max_capacity"`
	DbMinCapacity           *int      `json:"db_min_capacity"`
	Description             *string   `json:"description"`
	DnsDomainName           *string   `json:"dns_domain_name"`
	DnsHostedZone           *string   `json:"dns_hosted_zone"`
	DownloadCount           *int      `json:"download_count"`
	EksClusterAdmins        *string   `json:"eks_cluster_admins"`
	EnableCloudfrontWaf     *bool     `json:"enable_cloudfront_waf"`
	EnableDns               *bool     `json:"enable_dns"`
	EnableGitopsDestination *bool     `json:"enable_gitops_destination"`
	EnableKarpenter         *bool     `json:"enable_karpenter"`
	EnableRedis             *bool     `json:"enable_redis"`
	EnvironmentRepository   *string   `json:"environment_repository"`
	EnvironmentStage        string    `json:"environment_stage"`
	FullConfig              *string   `json:"full_config"`
	GitopsAppTemplate       *string   `json:"gitops_app_template"`
	GitopsAppToken          *string   `json:"gitops_app_token"`
	GitopsArgocdToken       *string   `json:"gitops_argocd_token"`
	GitopsDestinationsRepo  *string   `json:"gitops_destinations_repo"`
	GitopsRepository        *string   `json:"gitops_repository"`
	ID                      string    `json:"id"`
	LastDownloadedAt        *string   `json:"last_downloaded_at"`
	// Name                    string    `json:"name"`
	ProjectName            string    `json:"project_name"`
	RedisAllowedCidrBlocks *string   `json:"redis_allowed_cidr_blocks"`
	SesQueuesTopics        *string   `json:"ses_queues_topics"`
	Status                 *string   `json:"status"`
	TerraformVersion       string    `json:"terraform_version"`
	UpdatedAt              time.Time `json:"updated_at"`
	UserID                 string    `json:"user_id"`
	VpcCidr                *string   `json:"vpc_cidr"`
}
