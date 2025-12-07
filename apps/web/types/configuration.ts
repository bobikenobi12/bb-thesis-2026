export interface S3BucketConfiguration {
	acl_type: string;
	block_public_acls: boolean;
	block_public_policy: boolean;
	bucket_name_suffix: string;
	cors_configuration: unknown[];
	create_s3_user: boolean;
	ignore_public_acls: boolean;
	restrict_public_buckets: boolean;
	sse_algorithm: string;
	store_access_key_in_ssm: boolean;
	versioning_enabled: boolean;
}

export interface CustomSecret {
	secret_name: string;
	length: number;
	special: boolean;
}

export interface DatabaseConfig {
	min_capacity?: number;
	max_capacity?: number;
	rds_scaling_config?: boolean | null;
}

export interface NetworkConfig {
	allowed_cidr_block?: string[];
	redis_allowed_cidr_blocks?: string[];
	vpc_private_subnet_ids?: string[];
	vpc_public_subnet_ids?: string[];
	vpc_private_route_table_ids?: string[];
	vpc_cidr?: string;
	create_vpc?: boolean;
}

export interface GitOpsConfig {
	gitops_template_branch?: string;
	gitops_argocd_token?: string;
	gitops_destination_repo?: string;
	environment_repo?: string;
	gitops_repo?: string;
}

export interface EKSConfig {
	eks_cluster_admins?: string[];
	terraform_version?: string;
	aws_region?: string;
}

export interface DNSConfig {
	dns_hosted_zone?: string;
	dns_domain_name?: string;
	enable_dns?: boolean;
}

export interface SecurityConfig {
	enable_cloudfront_waf?: boolean;
	enable_redis?: boolean;
	enable_karpenter?: boolean;
}

// Raw form data interface (before processing)
export interface RawConfigData {
	// Project basics
	project_name?: string;
	environment_stage?: string;
	aws_account_id?: string;
	terraform_version?: string;
	aws_region?: string;

	// Container platform
	container_platform?: string;

	// Repository settings
	environment_repo?: string;
	gitops_repo?: string;
	gitops_argocd_token?: string;
	gitops_template_branch?: string;
	gitops_destination_repo?: string;

	// Network settings (as strings from form)
	vpc_cidr?: string;
	create_vpc?: string;
	allowed_cidr_block?: string;
	redis_allowed_cidr_blocks?: string;
	vpc_private_subnet_ids?: string;
	vpc_public_subnet_ids?: string;
	vpc_private_route_table_ids?: string;

	// DNS settings
	dns_hosted_zone?: string;
	dns_domain_name?: string;
	enable_dns?: string;

	// Database settings
	min_capacity?: string;
	max_capacity?: string;
	rds_scaling_config?: string;

	// EKS settings
	eks_cluster_admins?: string;

	// Security settings
	enable_cloudfront_waf?: string;
	enable_redis?: string;
	enable_karpenter?: string;

	// SES settings
	ses_queues_topics?: string;

	[key: string]: string | undefined;
}

// Processed configuration data interface (after conversion and nesting)
export interface ProcessedConfigData {
	// Project basics
	project_name?: string;
	environment_stage?: string;
	aws_account_id?: string;
	terraform_version?: string;
	aws_region?: string;

	// Container platform
	container_platform?: string;

	// Repository settings
	environment_repo?: string;
	gitops_repo?: string;
	gitops_argocd_token?: string;
	gitops_template_branch?: string;
	gitops_destination_repo?: string;

	// Network settings (processed)
	vpc_cidr?: string;
	create_vpc?: boolean;
	allowed_cidr_block?: string[];
	redis_allowed_cidr_blocks?: string[];
	vpc_private_subnet_ids?: string[];
	vpc_public_subnet_ids?: string[];
	vpc_private_route_table_ids?: string[];

	// DNS settings
	dns_hosted_zone?: string;
	dns_domain_name?: string;
	enable_dns?: boolean;

	// Database settings
	min_capacity?: number;
	max_capacity?: number;
	rds_scaling_config?: boolean | null;

	// EKS settings
	eks_cluster_admins?: string[];

	// Security settings
	enable_cloudfront_waf?: boolean;
	enable_redis?: boolean;
	enable_karpenter?: boolean;

	// SES settings
	ses_queues_topics?: unknown;

	// GitOps template additions
	s3_create?: boolean;
	bucket_configuration?: S3BucketConfiguration[];
	custom_secrets?: CustomSecret[];

	// Nested structure after processing
	[key: string]: unknown;
}

export type ConfigValue =
	| string
	| number
	| boolean
	| string[]
	| unknown[]
	| null
	| undefined;

export type ConfigurationFormData = RawConfigData;

export interface DatabaseConfiguration {
	id: string;
	user_id: string;
	name: string;
	description?: string;
	project_name: string;
	environment_stage: string;
	aws_account_id: string;
	terraform_version: string;
	aws_region: string;
	container_platform: string;
	environment_repository?: string;
	gitops_repository?: string;
	gitops_argocd_token?: string;
	enable_gitops_destination: boolean;
	gitops_app_template?: string;
	gitops_destinations_repo?: string;
	gitops_app_token?: string;
	create_vpc: boolean;
	vpc_cidr?: string;
	enable_dns: boolean;
	dns_hosted_zone?: string;
	dns_domain_name?: string;
	db_min_capacity?: number;
	db_max_capacity?: number;
	eks_cluster_admins?: string;
	ses_queues_topics?: string;
	enable_cloudfront_waf: boolean;
	enable_redis: boolean;
	redis_allowed_cidr_blocks?: string;
	enable_karpenter: boolean;
	full_config?: Record<string, unknown>;
	created_at: string;
	updated_at: string;
	last_downloaded_at?: string;
	download_count: number;
	status: "draft" | "completed" | "archived";
}

export interface ConfigurationStats {
	total: number;
	draft: number;
	completed: number;
	archived: number;
	recentCount: number;
}

export interface Repository {
	id: string;
	name: string;
	full_name: string;
	url: string;
	private: boolean;
	default_branch: string;
	provider: "github" | "gitlab" | "bitbucket";
}

export interface LinkedAccount {
	provider: "github" | "gitlab" | "bitbucket";
	username: string;
	avatar_url?: string;
	linked_at: string;
	has_token: boolean;
}
