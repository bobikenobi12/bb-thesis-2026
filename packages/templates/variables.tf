#########################################################################
##                     General Configuration Variables                 ##
#########################################################################

variable "aws_account_id" {
  type        = string
  description = "AWS account to deploy resources"
}

variable "region" {
  type        = string
  description = "AWS region to deploy to"
}

variable "environment" {
  type        = string
  description = "Environment in which the infrastructure is going to be deployed"
}

variable "project_name" {
  type        = string
  description = "Name of the project / client / product to be used in naming convention"
}

variable "rds_iam_irsa" {
  type        = bool
  description = "Enable creation of RDS IAM Policy"
  default     = false
}

variable "allow_long_names" {
  type        = string
  default     = true
  description = "Allows longer IAM role names without suffixes. Leave true for new clusters. Set to false for pre-existing clusters to avoid re-creation."
}

#########################################################################
##                   Networking Variables                              ##
#########################################################################
variable "provision_vpc" {
  type    = bool
  default = true
}

variable "vpc_cidr" {
  type        = string
  description = "CIDR of VPC to be used by Resale common resources"
  default     = ""
}

variable "vpc_id" {
  type        = string
  description = "External VPC ID"
  default     = ""
}

variable "vpc_private_subnet_ids" {
  description = "External VPC private subnet IDs"
  type        = list(string)
  default     = [""]
}

variable "vpc_public_subnet_ids" {
  description = "External VPC public subnet IDs"
  type        = list(string)
  default     = [""]
}

variable "vpc_private_route_table_ids" {
  description = "External VPC private route table IDs"
  type        = list(string)
  default     = [""]
}

variable "vpc_single_nat_gateway" {
  type        = bool
  default     = false
  description = "Wether to use just a single NAT gateway instead of a NAT GW per availability zone for HA and as recommended. This might be suitable for dev/test environments"
}

#########################################################################
##                   EKS Variables                              ##
#########################################################################


variable "provision_eks" {
  type    = bool
  default = true
}

variable "eks_cluster_version" {
  type        = string
  description = "Desired Kubernetes cluster version"
  default     = "1.29"
}

variable "cluster_endpoint_public_access_cidrs" {
  description = "CIDRs with access to the EKS cluster. Restricted to customer and ITGix"
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "cluster_log_retention_in_days" {
  type        = number
  description = "Cluster log retention in days"
  default     = 14
}

variable "addons_versions" {
  type = object({
    kube_proxy = string
    vpc_cni    = string
    coredns    = string
    ebs_csi    = string
  })
}

variable "eks_kms_key_users" {
  description = "A list of IAM ARNs for [key users](https://docs.aws.amazon.com/kms/latest/developerguide/key-policy-default.html#key-policy-default-allow-users)"
  type        = list(string)
  default     = []
}

variable "eks_cluster_admins" {
  type = list(
    object({
      username = string
      path     = optional(string, "/users/")
    })
  )
  default = []
}

variable "eks_access_entries" {
  type        = any
  description = "Map of access entries to add to the cluster"
  default     = {}
}

################################################################################
# Node group defaults
################################################################################

variable "eks_ami_type" {
  description = "Default AMI type for the EKS worker nodes"
  type        = string
  default     = "BOTTLEROCKET_x86_64"
}

variable "eks_disk_size" {
  description = "Disk size of the root volume attached to the EKS worker nodes"
  type        = number
  default     = 50
}

variable "eks_instance_types" {
  description = "EC2 instance types for the EKS worker nodes"
  type        = list(string)
  default     = ["m5a.4xlarge"]
}

variable "eks_volume_type" {
  description = "Type of the root EBS volume attached to the EKS worker nodes"
  type        = string
  default     = "gp3"
}

variable "eks_volume_iops" {
  description = "Number of IOPs on the root EBS volumes"
  type        = number
  default     = 3000
}

variable "eks_ng_min_size" {
  description = "Minimum number of the worker nodes in the node group"
  type        = number
  default     = 2
}

variable "eks_ng_max_size" {
  description = "Maximum number of the worker nodes in the node group"
  type        = number
  default     = 5
}

variable "eks_ng_desired_size" {
  description = "Desired number of the worker nodes in the node group"
  type        = number
  default     = 2
}

variable "eks_ng_capacity_type" {
  description = "capacity type for node group nodes"
  type        = string
  default     = "SPOT"
}

#########################################################################
##                   RDS Variables                                     ##
#########################################################################
variable "create_rds" {
  type        = bool
  description = "If a new RDS and Proxy needs to be created"
  default     = false
}
variable "rds_config" {
  description = "Configuration for RDS resources"
  type = object({
    engine         = string
    engine_version = string
    engine_mode    = string
    cluster_family = string
    cluster_size   = number
    db_port        = number
    db_name        = string
  })
  default = ({
    engine         = "aurora-postgresql"
    engine_version = "14.5"
    engine_mode    = "provisioned"
    cluster_family = "aurora-postgresql14"
    cluster_size   = 1
    db_port        = 5432
    db_name        = ""
  })
}
variable "rds_scaling_config" {
  description = "The minimum and maximum number of Aurora capacity units (ACUs) for a DB instance"
  type = object({
    min_capacity = number
    max_capacity = number
  })
  default = ({
    min_capacity = 0.5
    max_capacity = 2.0
    }
  )
}
variable "rds_default_username" {
  type        = string
  description = "DB username"
  default     = "postgres"
}
variable "rds_iam_auth_enabled" {
  type        = bool
  description = "Specifies whether or mappings of AWS Identity and Access Management (IAM) accounts to database accounts is enabled"
  default     = false
}
variable "rds_logs_exports" {
  type        = list(string)
  description = "List of log types to export to cloudwatch. Aurora MySQL: audit, error, general, slowquery. Aurora PostgreSQL: postgresql"
  default     = ["postgresql"]
}

variable "rds_allowed_cidr_blocks" {
  type        = list(string)
  default     = []
  description = "List of CIDRs to be allowed to connect to the DB instance"
}

variable "rds_extra_credentials" {
  description = "Database extra credentials"
  type = object({
    username = string
    password = optional(string)
    database = string
  })
  default = {
    username = "demouser"
    database = "demodb"
  }
}
variable "rds_instance_type" {
  description = "Instance type - can be changed to db.t2.small for a non-serverless db"
  type        = string
  default     = "db.serverless"
}
#variable "bucket_to_export_name" {
#  type        = string
#  description = "Variable to set the name of the bucket in the policy to export data from the database to S3"
#  default     = ""
#}
#
#variable "enable_rds_s3_exports" {
#  type        = bool
#  description = "If a the s3 exports needs to be enabled"
#  default     = false
#}

variable "rds_backup_retention_period" {
  type        = number
  default     = 5
  description = "Number of days to retain backups for"
}

variable "rds_cluster_parameters" {
  type = list(object({
    name         = string
    value        = string
    apply_method = string
  }))
  default = []
}
#########################################################################
##                   SQS Variables                                     ##
#########################################################################

variable "sqs_username" {
  type        = string
  default     = ""
  description = "If not empty, created IAM User for usage with SQS for a more granular access"
}
variable "sqs_iam_role_name" {
  type        = string
  default     = ""
  description = "If not empty, created IAM Role for usage with SQS for a more granular access"
}
variable "sqs_queues" {
  type = map(any)
}
variable "sns_topics" {
  type = map(any)
}
variable "provision_sqs" {
  type        = string
  default     = false
  description = "Enables creation of SQS/SNS resources"
}

#########################################################################
##                   WAF Variables                                     ##
#########################################################################
variable "application_waf_enabled" {
  type        = bool
  description = "Specifies whether WAF should be provisioned"
  default     = false
}
variable "cloudfront_waf_enabled" {
  type        = bool
  description = "Specifies whether cloudfront for the WAF should be provisioned"
  default     = false
}
variable "waf_default_action" {
  type        = string
  default     = "allow"
  description = "allow or block - default action of WAF when a request hasn't matched any rules"
}
variable "waf_geo_location_block_enforce" {
  type        = string
  default     = "block"
  description = "allow or block - action to take on geo location list of countries"
}
variable "waf_webacl_cloudwatch_enabled" {}
variable "waf_sampled_requests_enabled" {}
variable "waf_logging_enabled" {}
variable "waf_country_codes_match" {}
variable "waf_log_retention_days" {}
variable "aws_managed_waf_rule_groups" {
  type = list(any)
  default = [
    {
      name                    = "AWSManagedRulesAdminProtectionRuleSet"
      priority                = 1
      action                  = "none" # count (stop enforcing rule group) or none (let the rule group decide what action to take, i.e. enforcing)
      rules_override_to_count = []
    }
  ]
}

variable "custom_managed_waf_rule_groups" {
  type = list(object({
    name                    = string
    priority                = number
    action                  = string
    rule_group_arn          = string
    rules_override_to_count = list(string)
  }))
  default = []
}

variable "custom_waf_rules" {
  description = "List of custom WAF rules to include in the rule group"
  type = list(object({
    name                = string
    priority            = number
    action              = string # "allow", "block", or "count"
    comparison_operator = string # e.g. "GT"
    size                = number # e.g. 15728640 (15MB)
    transform           = optional(string, "NONE")
  }))
  default = []
}


#########################################################################
##                   ECR Variables                                     ##
#########################################################################

variable "provision_ecr" {
  type    = bool
  default = false
}

variable "resources_tags" {
  description = "A map of tags to add to all resources"
  type        = map(string)
  default     = {}
}

variable "ecr_repository_type" {
  description = "The type of repository to create. Either `public` or `private`"
  type        = string
  default     = "private"
}

variable "ecr_names_map" {
  type        = map(string)
  default     = {}
  description = "Map of repositories to create. Example: { r1 = \"myfirstrepo\", r2 = \"mysecondrepo\" }"
}

variable "ecr_repository_image_tag_mutability" {
  description = "The tag mutability setting for the repository. Must be one of: `MUTABLE` or `IMMUTABLE`. Defaults to `IMMUTABLE`"
  type        = string
  default     = "IMMUTABLE"
}

variable "ecr_repository_encryption_type" {
  description = "The encryption type for the repository. Must be one of: `KMS` or `AES256`. Defaults to `AES256`"
  type        = string
  default     = "AES256"
}

variable "ecr_repository_image_scan_on_push" {
  description = "Indicates whether images are scanned after being pushed to the repository (`true`) or not scanned (`false`)"
  type        = bool
  default     = true
}

variable "ecr_repository_read_access_arns" {
  description = "The ARNs of the IAM users/roles that have read access to the repository"
  type        = list(string)
  default     = []
}

variable "ecr_repository_read_write_access_arns" {
  description = "The ARNs of the IAM users/roles that have read/write access to the repository"
  type        = list(string)
  default     = []
}

variable "ecr_manage_registry_scanning_configuration" {
  description = "Determines whether the registry scanning configuration will be managed"
  type        = bool
  default     = false
}

variable "ecr_registry_scan_type" {
  description = "the scanning type to set for the registry. Can be either `ENHANCED` or `BASIC`"
  type        = string
  default     = "BASIC"
}

variable "ecr_registry_scan_rules" {
  description = "One or multiple blocks specifying scanning rules to determine which repository filters are used and at what frequency scanning will occur"
  type        = any
  default     = []
}

variable "ecr_create_lifecycle_policy" {
  description = "Determines whether a lifecycle policy will be created"
  type        = bool
  default     = true
}

#########################################################################
##                   Elasticache Redis cluster                         ##
#########################################################################
variable "create_elasticache_redis" {
  type        = bool
  description = "If a new Elasticache Redis instance needs to be created"
}

variable "redis_cluster_size" {
  type        = number
  description = "Number of nodes in cluster. Ignored when redis_cluster_mode_enabled == true"
}

variable "redis_cluster_mode_enabled" {
  type        = bool
  description = "Flag to enable/disable cluster mode"
}

variable "redis_instance_type" {
  type        = string
  description = "Elastic cache instance type"
}

variable "redis_engine_version" {
  type        = string
  description = "Redis engine version"
}

variable "redis_family" {
  type        = string
  description = "Redis family"
}

variable "redis_allowed_cidr_blocks" {
  type        = list(any)
  description = "List of CIDRs allowed on Redis security group rules"
}

variable "redis_allowed_security_group_ids" {
  type        = list(string)
  description = <<-EOT
    A list of IDs of Security Groups to allow access to the security group created by this module on Redis port.
  EOT
}

variable "redis_multi_az_enabled" {
  type        = bool
  description = "Flag to enable/disable Multiple AZs"
  default     = true
}

## Elasticache Redis - Logging variables

variable "redis_cloudwatch_logs_enabled" {
  type        = bool
  description = "Indicates whether you want to enable or disable streaming broker logs to Cloudwatch Logs."
}

variable "redis_automatic_failover_enabled" {
  type        = bool
  description = "Automatic failover (Not available for T1/T2 instances)"
  default     = true
}

#########################################################################
##                   Elasticache Valkey                                ##
#########################################################################

variable "create_elasticache_valkey" {
  type    = bool
  default = false
}

variable "valkey_snapshot_time" {
  type    = string
  default = "05:00"
}

variable "valkey_engine_version" {
  type    = string
  default = "7"
}

variable "valkey_data_storage_max" {
  type    = number
  default = 2
}

variable "valkey_ecpu_per_second_max" {
  type    = number
  default = 1000
}

variable "valkey_create_valkey_user_and_secret" {
  type    = bool
  default = true
}

#########################################################################
##             AWS Certificate manager valid certificate               ##
#########################################################################
variable "acm_certificate_enable" {
  type        = bool
  description = "Generate a validated acm cert"
  default     = false
}
variable "dns_hosted_zone" {
  type        = string
  description = "Managed R53 Zone ID"
  default     = "Z2INQZ6AA9H9SI"
}
variable "dns_main_domain" {
  type        = string
  description = "Domain Managed under the R53 Zone"
  default     = "itgix.eu"
}

################################################################################
# Karpenter
################################################################################


variable "enable_karpenter" {
  type    = bool
  default = false
}

variable "ec2_spot_service_role" {
  type        = bool
  default     = false
  description = "Configure EC2 spot service role provisioning."
}

################################################################################
# Custom Secrets Variables - ITGix tf-module-awssm-passgen
################################################################################


variable "custom_secrets" {
  description = "List of custom secrets to create"
  type = list(object({
    secret_name      = string
    length           = optional(number)
    special          = optional(bool)
    override_special = optional(string)
    keepers          = optional(map(string))
    manual           = optional(bool, false)
    value            = optional(string)
  }))
}

variable "custom_secret_keepers" {
  description = "Map of keepers for the secrets"
  type        = map(map(string))
  default     = {}
}
#########################################################################
##           DynamoDB - Table Configuration Variables                  ##
#########################################################################

variable "ddb_create" {
  type        = bool
  description = "If a DynomoDB table needs to be created"
  default     = false

}

variable "ddb_global_create" {
  type        = bool
  description = "If a DynomoDB global table needs to be created"
  default     = false

}

variable "ddb_table_configuration" {
  type = list(object({
    table_name_suffix = string
    hash_key          = string
    range_key         = string
    hash_key_type     = string
    range_key_type    = string
    enable_autoscaler = optional(bool, false)
    dynamodb_attributes = optional(list(object({
      name = string
      type = string
    })), [])
    global_secondary_index_map = optional(list(object({
      hash_key           = string
      name               = string
      projection_type    = string
      range_key          = string
      non_key_attributes = optional(list(string), [])
      read_capacity      = optional(number, 0)
      write_capacity     = optional(number, 0)
    })), [])
    local_secondary_index_map = optional(list(object({
      name               = string
      projection_type    = string
      range_key          = string
      non_key_attributes = optional(list(string), [])
    })), [])
    replicas                      = optional(list(string), [])
    tags_enabled                  = optional(bool, true)
    billing_mode                  = optional(string, "PAY_PER_REQUEST")
    enable_point_in_time_recovery = optional(bool, false)
    ttl_enabled                   = optional(bool, false)
    ttl_attribute                 = optional(string, "")
    deletion_protection_enabled   = optional(bool, true)
  }))
  description = "List of objects to pass to the module for the creation of the table."
}

variable "ddb_global_table_configuration" {
  type = list(object({
    table_type        = optional(string, "regional")
    table_name_suffix = string
    hash_key          = string
    range_key         = string
    hash_key_type     = string
    range_key_type    = string
    enable_autoscaler = optional(bool, false)
    dynamodb_attributes = optional(list(object({
      name = string
      type = string
    })), [])
    global_secondary_index_map = optional(list(object({
      hash_key           = string
      name               = string
      projection_type    = string
      range_key          = string
      non_key_attributes = optional(list(string), [])
      read_capacity      = optional(number, 0)
      write_capacity     = optional(number, 0)
    })), [])
    local_secondary_index_map = optional(list(object({
      name               = string
      projection_type    = string
      range_key          = string
      non_key_attributes = optional(list(string), [])
    })), [])
    replicas                      = optional(list(string), [])
    tags_enabled                  = optional(bool, true)
    billing_mode                  = optional(string, "PAY_PER_REQUEST")
    enable_point_in_time_recovery = optional(bool, false)
    ttl_enabled                   = optional(bool, false)
    ttl_attribute                 = optional(string, "")
    deletion_protection_enabled   = optional(bool, true)
  }))
  description = "List of objects to pass to the module for the creation of the global table."
}
#########################################################################
##           S3 - Bucket Configuration Variables                       ##
#########################################################################

variable "s3_create" {
  type        = bool
  description = "Creation of a S3 bucket"
  default     = false

}


variable "bucket_configuration" {
  type = list(object({
    bucket_name_suffix      = string
    acl_type                = string
    create_s3_user          = bool
    versioning_enabled      = bool
    sse_algorithm           = string
    store_access_key_in_ssm = bool
    logging_bucket_name     = optional(string)
    block_public_acls       = optional(bool)
    block_public_policy     = optional(bool)
    ignore_public_acls      = optional(bool)
    restrict_public_buckets = optional(bool)
    cors_configuration = list(object({
      allowed_headers = list(string)
      allowed_methods = list(string)
      allowed_origins = list(string)
      expose_headers  = list(string)
      max_age_seconds = number
    }))
    privileged_principal_arns    = optional(list(map(list(string))))
    privileged_principal_actions = optional(list(string))
  }))
  description = "Values needed for the creation of a new S3 bucket. For the value of the argument 'bucket_name_prefix' it should be a value that has the service name and the purpose of that bucket."
  default = [{
    bucket_name_suffix      = "bkt"
    acl_type                = "log-delivery-write"
    create_s3_user          = false
    versioning_enabled      = true
    sse_algorithm           = "AES256"
    store_access_key_in_ssm = true
    block_public_acls       = true
    block_public_policy     = true
    ignore_public_acls      = true
    restrict_public_buckets = true
    cors_configuration      = []
  }]
}

variable "custom_terraform_vars" {
  type        = any
  default     = {}
  description = "Object of custom values that can be used for extra terraform files outside of the template"
}
