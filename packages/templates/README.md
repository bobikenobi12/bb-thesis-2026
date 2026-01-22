# Terraform Infrastructure Deployment

This is the standard template for the cloud infrastructure of **ITGix ADP - Application Development Container Platform**.  
It's meant to be used with the **idp-installer** bootstrapping script.

Variables can be passed via the main YAML configuration file of **idp-installer**, and they will override the provided defaults in the `variable-template` directory.

---


## Requirements

| Name | Version |
|------|---------|
| <a name="requirement_terraform"></a> [terraform](#requirement\_terraform) | ~> 1.1 |
| <a name="requirement_aws"></a> [aws](#requirement\_aws) | >= 4.49 |
| <a name="requirement_random"></a> [random](#requirement\_random) | ~> 3.0 |

## Providers

| Name | Version |
|------|---------|
| <a name="provider_aws"></a> [aws](#provider\_aws) | >= 4.49 |

## Modules

| Name | Source | Version |
|------|--------|---------|
| <a name="module_acm"></a> [acm](#module\_acm) | git::git@github.com:itgix/tf-module-acm.git | v1.0.1 |
| <a name="module_common_vpc"></a> [common\_vpc](#module\_common\_vpc) | terraform-aws-modules/vpc/aws | ~> 5.5.1 |
| <a name="module_custom_secrets_password_module"></a> [custom\_secrets\_password\_module](#module\_custom\_secrets\_password\_module) | git@github.com:itgix/tf-module-awssm-passgen.git | v1.0.0 |
| <a name="module_dynamodb"></a> [dynamodb](#module\_dynamodb) | git@github.com:itgix/tf-module-dynamodb.git | n/a |
| <a name="module_ecr"></a> [ecr](#module\_ecr) | git::git@github.com:itgix/tf-module-ecr.git | v1.0.0 |
| <a name="module_eks"></a> [eks](#module\_eks) | git::git@github.com:itgix/tf-module-eks.git | v1.0.0 |
| <a name="module_elasticache"></a> [elasticache](#module\_elasticache) | git::git@github.com:itgix/tf-module-redis.git | v1.0.0 |
| <a name="module_global_dynamodb"></a> [global\_dynamodb](#module\_global\_dynamodb) | git@github.com:itgix/tf-module-dynamodb.git | n/a |
| <a name="module_irsa_fluentbit_cloudwatch"></a> [irsa\_fluentbit\_cloudwatch](#module\_irsa\_fluentbit\_cloudwatch) | terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts-eks | 5.34.0 |
| <a name="module_irsa_itgix_adp_agent"></a> [irsa\_itgix\_adp\_agent](#module\_irsa\_itgix\_adp\_agent) | terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts-eks | 5.34.0 |
| <a name="module_irsa_karpenter"></a> [irsa\_karpenter](#module\_irsa\_karpenter) | terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts-eks | 5.34.0 |
| <a name="module_karpenter"></a> [karpenter](#module\_karpenter) | terraform-aws-modules/eks/aws//modules/karpenter | 19.21.0 |
| <a name="module_rds_iam_auth"></a> [rds\_iam\_auth](#module\_rds\_iam\_auth) | terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts-eks | 5.34.0 |
| <a name="module_rds_maindb"></a> [rds\_maindb](#module\_rds\_maindb) | git::git@github.com:itgix/tf-module-rds.git | v1.0.1 |
| <a name="module_sqs_dev"></a> [sqs\_dev](#module\_sqs\_dev) | git::git@github.com:itgix/tf-module-sqs-sns.git | v1.0.0 |
| <a name="module_wafv2_application"></a> [wafv2\_application](#module\_wafv2\_application) | git::git@github.com:itgix/tf-module-wafv2.git | v1 |
| <a name="module_wafv2_cloudfront"></a> [wafv2\_cloudfront](#module\_wafv2\_cloudfront) | git::git@github.com:itgix/tf-module-wafv2.git | v1 |

## Resources

| Name | Type |
|------|------|
| [aws_iam_policy.irsa_itgix_adp_agent](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/iam_policy) | resource |
| [aws_iam_policy.irsa_karpenter](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/iam_policy) | resource |
| [aws_iam_policy.rds_iam_auth](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/iam_policy) | resource |
| [aws_iam_service_linked_role.spot](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/iam_service_linked_role) | resource |
| [aws_vpc_endpoint.s3_gateway](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/vpc_endpoint) | resource |
| [aws_availability_zones.available](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/data-sources/availability_zones) | data source |
| [aws_caller_identity.current](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/data-sources/caller_identity) | data source |

## Inputs

| Name | Description | Type | Default | Required |
|------|-------------|------|---------|:--------:|
| <a name="input_acm_certificate_enable"></a> [acm\_certificate\_enable](#input\_acm\_certificate\_enable) | Generate a validated acm cert | `bool` | `false` | no |
| <a name="input_addons_versions"></a> [addons\_versions](#input\_addons\_versions) | n/a | <pre>object({<br>    kube_proxy = string<br>    vpc_cni    = string<br>    coredns    = string<br>    ebs_csi    = string<br>  })</pre> | n/a | yes |
| <a name="input_application_waf_enabled"></a> [application\_waf\_enabled](#input\_application\_waf\_enabled) | Specifies whether WAF should be provisioned | `bool` | `false` | no |
| <a name="input_aws_account_id"></a> [aws\_account\_id](#input\_aws\_account\_id) | AWS account to deploy resources | `string` | n/a | yes |
| <a name="input_aws_managed_waf_rule_groups"></a> [aws\_managed\_waf\_rule\_groups](#input\_aws\_managed\_waf\_rule\_groups) | n/a | `list(any)` | <pre>[<br>  {<br>    "action": "none",<br>    "name": "AWSManagedRulesAdminProtectionRuleSet",<br>    "priority": 1,<br>    "rules_override_to_count": []<br>  }<br>]</pre> | no |
| <a name="input_cloudfront_waf_enabled"></a> [cloudfront\_waf\_enabled](#input\_cloudfront\_waf\_enabled) | Specifies whether cloudfront for the WAF should be provisioned | `bool` | `false` | no |
| <a name="input_cluster_endpoint_public_access_cidrs"></a> [cluster\_endpoint\_public\_access\_cidrs](#input\_cluster\_endpoint\_public\_access\_cidrs) | CIDRs with access to the EKS cluster. Restricted to customer and ITGix | `list(string)` | <pre>[<br>  "0.0.0.0/0"<br>]</pre> | no |
| <a name="input_cluster_log_retention_in_days"></a> [cluster\_log\_retention\_in\_days](#input\_cluster\_log\_retention\_in\_days) | Cluster log retention in days | `number` | `14` | no |
| <a name="input_create_elasticache_redis"></a> [create\_elasticache\_redis](#input\_create\_elasticache\_redis) | If a new Elasticache Redis instance needs to be created | `bool` | n/a | yes |
| <a name="input_create_rds"></a> [create\_rds](#input\_create\_rds) | If a new RDS and Proxy needs to be created | `bool` | `false` | no |
| <a name="input_custom_secret_keepers"></a> [custom\_secret\_keepers](#input\_custom\_secret\_keepers) | Map of keepers for the secrets | `map(map(string))` | `{}` | no |
| <a name="input_custom_secrets"></a> [custom\_secrets](#input\_custom\_secrets) | List of custom secrets to create | <pre>list(object({<br>    secret_name      = string<br>    length           = optional(number)<br>    special          = optional(bool)<br>    override_special = optional(string)<br>    keepers          = optional(map(string))<br>    manual           = optional(bool, false)<br>  }))</pre> | n/a | yes |
| <a name="input_ddb_create"></a> [ddb\_create](#input\_ddb\_create) | If a DynomoDB table needs to be created | `bool` | `false` | no |
| <a name="input_ddb_global_create"></a> [ddb\_global\_create](#input\_ddb\_global\_create) | If a DynomoDB global table needs to be created | `bool` | `false` | no |
| <a name="input_ddb_global_table_configuration"></a> [ddb\_global\_table\_configuration](#input\_ddb\_global\_table\_configuration) | List of objects to pass to the module for the creation of the global table. | <pre>list(object({<br>    table_type        = optional(string, "regional")<br>    table_name_suffix = string<br>    hash_key          = string<br>    range_key         = string<br>    hash_key_type     = string<br>    range_key_type    = string<br>    enable_autoscaler = optional(bool, false)<br>    dynamodb_attributes = optional(list(object({<br>      name = string<br>      type = string<br>    })), [])<br>    global_secondary_index_map = optional(list(object({<br>      hash_key           = string<br>      name               = string<br>      projection_type    = string<br>      range_key          = string<br>      non_key_attributes = optional(list(string), [])<br>      read_capacity      = optional(number, 0)<br>      write_capacity     = optional(number, 0)<br>    })), [])<br>    local_secondary_index_map = optional(list(object({<br>      name               = string<br>      projection_type    = string<br>      range_key          = string<br>      non_key_attributes = optional(list(string), [])<br>    })), [])<br>    replicas                      = optional(list(string), [])<br>    tags_enabled                  = optional(bool, true)<br>    billing_mode                  = optional(string, "PAY_PER_REQUEST")<br>    enable_point_in_time_recovery = optional(bool, false)<br>    ttl_enabled                   = optional(bool, false)<br>    ttl_attribute                 = optional(string, "")<br>    deletion_protection_enabled   = optional(bool, true)<br>  }))</pre> | n/a | yes |
| <a name="input_ddb_table_configuration"></a> [ddb\_table\_configuration](#input\_ddb\_table\_configuration) | List of objects to pass to the module for the creation of the table. | <pre>list(object({<br>    table_name_suffix = string<br>    hash_key          = string<br>    range_key         = string<br>    hash_key_type     = string<br>    range_key_type    = string<br>    enable_autoscaler = optional(bool, false)<br>    dynamodb_attributes = optional(list(object({<br>      name = string<br>      type = string<br>    })), [])<br>    global_secondary_index_map = optional(list(object({<br>      hash_key           = string<br>      name               = string<br>      projection_type    = string<br>      range_key          = string<br>      non_key_attributes = optional(list(string), [])<br>      read_capacity      = optional(number, 0)<br>      write_capacity     = optional(number, 0)<br>    })), [])<br>    local_secondary_index_map = optional(list(object({<br>      name               = string<br>      projection_type    = string<br>      range_key          = string<br>      non_key_attributes = optional(list(string), [])<br>    })), [])<br>    replicas                      = optional(list(string), [])<br>    tags_enabled                  = optional(bool, true)<br>    billing_mode                  = optional(string, "PAY_PER_REQUEST")<br>    enable_point_in_time_recovery = optional(bool, false)<br>    ttl_enabled                   = optional(bool, false)<br>    ttl_attribute                 = optional(string, "")<br>    deletion_protection_enabled   = optional(bool, true)<br>  }))</pre> | n/a | yes |
| <a name="input_dns_hosted_zone"></a> [dns\_hosted\_zone](#input\_dns\_hosted\_zone) | Managed R53 Zone ID | `string` | `"Z2INQZ6AA9H9SI"` | no |
| <a name="input_dns_main_domain"></a> [dns\_main\_domain](#input\_dns\_main\_domain) | Domain Managed under the R53 Zone | `string` | `"itgix.eu"` | no |
| <a name="input_ec2_spot_service_role"></a> [ec2\_spot\_service\_role](#input\_ec2\_spot\_service\_role) | Configure EC2 spot service role provisioning. | `bool` | `false` | no |
| <a name="input_ecr_create_lifecycle_policy"></a> [ecr\_create\_lifecycle\_policy](#input\_ecr\_create\_lifecycle\_policy) | Determines whether a lifecycle policy will be created | `bool` | `true` | no |
| <a name="input_ecr_manage_registry_scanning_configuration"></a> [ecr\_manage\_registry\_scanning\_configuration](#input\_ecr\_manage\_registry\_scanning\_configuration) | Determines whether the registry scanning configuration will be managed | `bool` | `false` | no |
| <a name="input_ecr_registry_scan_rules"></a> [ecr\_registry\_scan\_rules](#input\_ecr\_registry\_scan\_rules) | One or multiple blocks specifying scanning rules to determine which repository filters are used and at what frequency scanning will occur | `any` | `[]` | no |
| <a name="input_ecr_registry_scan_type"></a> [ecr\_registry\_scan\_type](#input\_ecr\_registry\_scan\_type) | the scanning type to set for the registry. Can be either `ENHANCED` or `BASIC` | `string` | `"BASIC"` | no |
| <a name="input_ecr_repository_encryption_type"></a> [ecr\_repository\_encryption\_type](#input\_ecr\_repository\_encryption\_type) | The encryption type for the repository. Must be one of: `KMS` or `AES256`. Defaults to `AES256` | `string` | `"AES256"` | no |
| <a name="input_ecr_repository_image_scan_on_push"></a> [ecr\_repository\_image\_scan\_on\_push](#input\_ecr\_repository\_image\_scan\_on\_push) | Indicates whether images are scanned after being pushed to the repository (`true`) or not scanned (`false`) | `bool` | `true` | no |
| <a name="input_ecr_repository_image_tag_mutability"></a> [ecr\_repository\_image\_tag\_mutability](#input\_ecr\_repository\_image\_tag\_mutability) | The tag mutability setting for the repository. Must be one of: `MUTABLE` or `IMMUTABLE`. Defaults to `IMMUTABLE` | `string` | `"IMMUTABLE"` | no |
| <a name="input_ecr_repository_name"></a> [ecr\_repository\_name](#input\_ecr\_repository\_name) | The name of the repository | `string` | `""` | no |
| <a name="input_ecr_repository_read_access_arns"></a> [ecr\_repository\_read\_access\_arns](#input\_ecr\_repository\_read\_access\_arns) | The ARNs of the IAM users/roles that have read access to the repository | `list(string)` | `[]` | no |
| <a name="input_ecr_repository_read_write_access_arns"></a> [ecr\_repository\_read\_write\_access\_arns](#input\_ecr\_repository\_read\_write\_access\_arns) | The ARNs of the IAM users/roles that have read/write access to the repository | `list(string)` | `[]` | no |
| <a name="input_ecr_repository_type"></a> [ecr\_repository\_type](#input\_ecr\_repository\_type) | The type of repository to create. Either `public` or `private` | `string` | `"private"` | no |
| <a name="input_eks_ami_type"></a> [eks\_ami\_type](#input\_eks\_ami\_type) | Default AMI type for the EKS worker nodes | `string` | `"AL2_x86_64"` | no |
| <a name="input_eks_aws_auth_roles"></a> [eks\_aws\_auth\_roles](#input\_eks\_aws\_auth\_roles) | n/a | <pre>list(object({<br>    rolearn  = string<br>    username = string<br>    groups   = list(string)<br>  }))</pre> | `[]` | no |
| <a name="input_eks_aws_auth_users"></a> [eks\_aws\_auth\_users](#input\_eks\_aws\_auth\_users) | n/a | <pre>list(object({<br>    username = string<br>    groups   = list(string)<br>  }))</pre> | `[]` | no |
| <a name="input_eks_aws_users_path"></a> [eks\_aws\_users\_path](#input\_eks\_aws\_users\_path) | The organizational path of the user used for building the arn , by default it's just / | `string` | `"/"` | no |
| <a name="input_eks_cluster_version"></a> [eks\_cluster\_version](#input\_eks\_cluster\_version) | Desired Kubernetes cluster version | `string` | `"1.29"` | no |
| <a name="input_eks_disk_size"></a> [eks\_disk\_size](#input\_eks\_disk\_size) | Disk size of the root volume attached to the EKS worker nodes | `number` | `50` | no |
| <a name="input_eks_instance_types"></a> [eks\_instance\_types](#input\_eks\_instance\_types) | EC2 instance types for the EKS worker nodes | `list(string)` | <pre>[<br>  "m5a.4xlarge"<br>]</pre> | no |
| <a name="input_eks_kms_key_users"></a> [eks\_kms\_key\_users](#input\_eks\_kms\_key\_users) | A list of IAM ARNs for [key users](https://docs.aws.amazon.com/kms/latest/developerguide/key-policy-default.html#key-policy-default-allow-users) | `list(string)` | `[]` | no |
| <a name="input_eks_ng_capacity_type"></a> [eks\_ng\_capacity\_type](#input\_eks\_ng\_capacity\_type) | capacity type for node group nodes | `string` | `"SPOT"` | no |
| <a name="input_eks_ng_desired_size"></a> [eks\_ng\_desired\_size](#input\_eks\_ng\_desired\_size) | Desired number of the worker nodes in the node group | `number` | `2` | no |
| <a name="input_eks_ng_max_size"></a> [eks\_ng\_max\_size](#input\_eks\_ng\_max\_size) | Maximum number of the worker nodes in the node group | `number` | `5` | no |
| <a name="input_eks_ng_min_size"></a> [eks\_ng\_min\_size](#input\_eks\_ng\_min\_size) | Minimum number of the worker nodes in the node group | `number` | `2` | no |
| <a name="input_eks_volume_iops"></a> [eks\_volume\_iops](#input\_eks\_volume\_iops) | Number of IOPs on the root EBS volumes | `number` | `3000` | no |
| <a name="input_eks_volume_type"></a> [eks\_volume\_type](#input\_eks\_volume\_type) | Type of the root EBS volume attached to the EKS worker nodes | `string` | `"gp3"` | no |
| <a name="input_enable_karpenter"></a> [enable\_karpenter](#input\_enable\_karpenter) | n/a | `bool` | `false` | no |
| <a name="input_environment"></a> [environment](#input\_environment) | Environment in which the infrastructure is going to be deployed | `string` | n/a | yes |
| <a name="input_project_name"></a> [project\_name](#input\_project\_name) | Name of the project / client / product to be used in naming convention | `string` | n/a | yes |
| <a name="input_provision_ecr"></a> [provision\_ecr](#input\_provision\_ecr) | n/a | `bool` | `false` | no |
| <a name="input_provision_eks"></a> [provision\_eks](#input\_provision\_eks) | n/a | `bool` | `true` | no |
| <a name="input_provision_sqs"></a> [provision\_sqs](#input\_provision\_sqs) | Enables creation of SQS/SNS resources | `string` | `false` | no |
| <a name="input_provision_vpc"></a> [provision\_vpc](#input\_provision\_vpc) | ######################################################################## #                   Networking Variables                              ## ######################################################################## | `bool` | `true` | no |
| <a name="input_rds_allowed_cidr_blocks"></a> [rds\_allowed\_cidr\_blocks](#input\_rds\_allowed\_cidr\_blocks) | List of CIDRs to be allowed to connect to the DB instance | `list(string)` | `[]` | no |
| <a name="input_rds_config"></a> [rds\_config](#input\_rds\_config) | Configuration for RDS resources | <pre>object({<br>    engine         = string<br>    engine_version = string<br>    engine_mode    = string<br>    cluster_family = string<br>    cluster_size   = number<br>    db_port        = number<br>    db_name        = string<br>  })</pre> | <pre>{<br>  "cluster_family": "aurora-postgresql14",<br>  "cluster_size": 1,<br>  "db_name": "",<br>  "db_port": 5432,<br>  "engine": "aurora-postgresql",<br>  "engine_mode": "provisioned",<br>  "engine_version": "14.5"<br>}</pre> | no |
| <a name="input_rds_default_username"></a> [rds\_default\_username](#input\_rds\_default\_username) | DB username | `string` | `"postgres"` | no |
| <a name="input_rds_extra_credentials"></a> [rds\_extra\_credentials](#input\_rds\_extra\_credentials) | Database extra credentials | <pre>object({<br>    username = string<br>    password = optional(string)<br>    database = string<br>  })</pre> | <pre>{<br>  "database": "demodb",<br>  "username": "demouser"<br>}</pre> | no |
| <a name="input_rds_iam_auth_enabled"></a> [rds\_iam\_auth\_enabled](#input\_rds\_iam\_auth\_enabled) | Specifies whether or mappings of AWS Identity and Access Management (IAM) accounts to database accounts is enabled | `bool` | `false` | no |
| <a name="input_rds_iam_irsa"></a> [rds\_iam\_irsa](#input\_rds\_iam\_irsa) | Enable creation of RDS IAM Policy | `bool` | `false` | no |
| <a name="input_rds_logs_exports"></a> [rds\_logs\_exports](#input\_rds\_logs\_exports) | List of log types to export to cloudwatch. Aurora MySQL: audit, error, general, slowquery. Aurora PostgreSQL: postgresql | `list(string)` | <pre>[<br>  "postgresql"<br>]</pre> | no |
| <a name="input_rds_scaling_config"></a> [rds\_scaling\_config](#input\_rds\_scaling\_config) | The minimum and maximum number of Aurora capacity units (ACUs) for a DB instance | <pre>object({<br>    min_capacity = number<br>    max_capacity = number<br>  })</pre> | <pre>{<br>  "max_capacity": 2,<br>  "min_capacity": 0.5<br>}</pre> | no |
| <a name="input_redis_allowed_cidr_blocks"></a> [redis\_allowed\_cidr\_blocks](#input\_redis\_allowed\_cidr\_blocks) | List of CIDRs allowed on Redis security group rules | `list(any)` | n/a | yes |
| <a name="input_redis_allowed_security_group_ids"></a> [redis\_allowed\_security\_group\_ids](#input\_redis\_allowed\_security\_group\_ids) | A list of IDs of Security Groups to allow access to the security group created by this module on Redis port. | `list(string)` | n/a | yes |
| <a name="input_redis_automatic_failover_enabled"></a> [redis\_automatic\_failover\_enabled](#input\_redis\_automatic\_failover\_enabled) | Automatic failover (Not available for T1/T2 instances) | `bool` | `true` | no |
| <a name="input_redis_cloudwatch_logs_enabled"></a> [redis\_cloudwatch\_logs\_enabled](#input\_redis\_cloudwatch\_logs\_enabled) | Indicates whether you want to enable or disable streaming broker logs to Cloudwatch Logs. | `bool` | n/a | yes |
| <a name="input_redis_cluster_mode_enabled"></a> [redis\_cluster\_mode\_enabled](#input\_redis\_cluster\_mode\_enabled) | Flag to enable/disable cluster mode | `bool` | n/a | yes |
| <a name="input_redis_cluster_size"></a> [redis\_cluster\_size](#input\_redis\_cluster\_size) | Number of nodes in cluster. Ignored when redis\_cluster\_mode\_enabled == true | `number` | n/a | yes |
| <a name="input_redis_engine_version"></a> [redis\_engine\_version](#input\_redis\_engine\_version) | Redis engine version | `string` | n/a | yes |
| <a name="input_redis_family"></a> [redis\_family](#input\_redis\_family) | Redis family | `string` | n/a | yes |
| <a name="input_redis_instance_type"></a> [redis\_instance\_type](#input\_redis\_instance\_type) | Elastic cache instance type | `string` | n/a | yes |
| <a name="input_redis_multi_az_enabled"></a> [redis\_multi\_az\_enabled](#input\_redis\_multi\_az\_enabled) | Flag to enable/disable Multiple AZs | `bool` | `true` | no |
| <a name="input_region"></a> [region](#input\_region) | AWS region to deploy to | `string` | n/a | yes |
| <a name="input_resources_tags"></a> [resources\_tags](#input\_resources\_tags) | A map of tags to add to all resources | `map(string)` | `{}` | no |
| <a name="input_sns_topics"></a> [sns\_topics](#input\_sns\_topics) | n/a | `map(any)` | n/a | yes |
| <a name="input_sqs_iam_role_name"></a> [sqs\_iam\_role\_name](#input\_sqs\_iam\_role\_name) | If not empty, created IAM Role for usage with SQS for a more granular access | `string` | `""` | no |
| <a name="input_sqs_queues"></a> [sqs\_queues](#input\_sqs\_queues) | n/a | `map(any)` | n/a | yes |
| <a name="input_sqs_username"></a> [sqs\_username](#input\_sqs\_username) | If not empty, created IAM User for usage with SQS for a more granular access | `string` | `""` | no |
| <a name="input_vpc_cidr"></a> [vpc\_cidr](#input\_vpc\_cidr) | CIDR of VPC to be used by Resale common resources | `string` | `""` | no |
| <a name="input_vpc_id"></a> [vpc\_id](#input\_vpc\_id) | External VPC ID | `string` | `""` | no |
| <a name="input_vpc_private_route_table_ids"></a> [vpc\_private\_route\_table\_ids](#input\_vpc\_private\_route\_table\_ids) | External VPC private route table IDs | `list(string)` | <pre>[<br>  ""<br>]</pre> | no |
| <a name="input_vpc_private_subnet_ids"></a> [vpc\_private\_subnet\_ids](#input\_vpc\_private\_subnet\_ids) | External VPC private subnet IDs | `list(string)` | <pre>[<br>  ""<br>]</pre> | no |
| <a name="input_vpc_public_subnet_ids"></a> [vpc\_public\_subnet\_ids](#input\_vpc\_public\_subnet\_ids) | External VPC public subnet IDs | `list(string)` | <pre>[<br>  ""<br>]</pre> | no |
| <a name="input_vpc_single_nat_gateway"></a> [vpc\_single\_nat\_gateway](#input\_vpc\_single\_nat\_gateway) | Wether to use just a single NAT gateway instead of a NAT GW per availability zone for HA and as recommended. This might be suitable for dev/test environments | `bool` | `false` | no |
| <a name="input_waf_country_codes_match"></a> [waf\_country\_codes\_match](#input\_waf\_country\_codes\_match) | n/a | `any` | n/a | yes |
| <a name="input_waf_default_action"></a> [waf\_default\_action](#input\_waf\_default\_action) | allow or block - default action of WAF when a request hasn't matched any rules | `string` | `"allow"` | no |
| <a name="input_waf_geo_location_block_enforce"></a> [waf\_geo\_location\_block\_enforce](#input\_waf\_geo\_location\_block\_enforce) | allow or block - action to take on geo location list of countries | `string` | `"block"` | no |
| <a name="input_waf_log_retention_days"></a> [waf\_log\_retention\_days](#input\_waf\_log\_retention\_days) | n/a | `any` | n/a | yes |
| <a name="input_waf_logging_enabled"></a> [waf\_logging\_enabled](#input\_waf\_logging\_enabled) | n/a | `any` | n/a | yes |
| <a name="input_waf_sampled_requests_enabled"></a> [waf\_sampled\_requests\_enabled](#input\_waf\_sampled\_requests\_enabled) | n/a | `any` | n/a | yes |
| <a name="input_waf_webacl_cloudwatch_enabled"></a> [waf\_webacl\_cloudwatch\_enabled](#input\_waf\_webacl\_cloudwatch\_enabled) | n/a | `any` | n/a | yes |

## Outputs

| Name | Description |
|------|-------------|
| <a name="output_az1"></a> [az1](#output\_az1) | n/a |
| <a name="output_az2"></a> [az2](#output\_az2) | n/a |
| <a name="output_az3"></a> [az3](#output\_az3) | n/a |
| <a name="output_custom_secret_arns"></a> [custom\_secret\_arns](#output\_custom\_secret\_arns) | n/a |
| <a name="output_custom_secret_names"></a> [custom\_secret\_names](#output\_custom\_secret\_names) | n/a |
| <a name="output_custom_secret_values"></a> [custom\_secret\_values](#output\_custom\_secret\_values) | n/a |
| <a name="output_custom_secret_versions"></a> [custom\_secret\_versions](#output\_custom\_secret\_versions) | n/a |
| <a name="output_ecr_repository_arn"></a> [ecr\_repository\_arn](#output\_ecr\_repository\_arn) | Full ARN of the repository |
| <a name="output_ecr_repository_name"></a> [ecr\_repository\_name](#output\_ecr\_repository\_name) | Name of the repository |
| <a name="output_ecr_repository_registry_id"></a> [ecr\_repository\_registry\_id](#output\_ecr\_repository\_registry\_id) | The registry ID where the repository was created |
| <a name="output_ecr_repository_url"></a> [ecr\_repository\_url](#output\_ecr\_repository\_url) | The URL of the repository (in the form `aws_account_id.dkr.ecr.region.amazonaws.com/repositoryName`) |
| <a name="output_eks_cluster_arn"></a> [eks\_cluster\_arn](#output\_eks\_cluster\_arn) | n/a |
| <a name="output_eks_cluster_endpoint"></a> [eks\_cluster\_endpoint](#output\_eks\_cluster\_endpoint) | n/a |
| <a name="output_eks_cluster_name"></a> [eks\_cluster\_name](#output\_eks\_cluster\_name) | n/a |
| <a name="output_eks_irsa_external_dns_arn"></a> [eks\_irsa\_external\_dns\_arn](#output\_eks\_irsa\_external\_dns\_arn) | n/a |
| <a name="output_fluentbit_sa_role_arn"></a> [fluentbit\_sa\_role\_arn](#output\_fluentbit\_sa\_role\_arn) | IAM Role ARN for Fluent Bit Service Account |
| <a name="output_irsa_rds_role_arn"></a> [irsa\_rds\_role\_arn](#output\_irsa\_rds\_role\_arn) | ARN of the IAM Role for access to rds database |
| <a name="output_karpenter_queue_name"></a> [karpenter\_queue\_name](#output\_karpenter\_queue\_name) | Interruption queue name for karpenter |
| <a name="output_karpenter_sa_role"></a> [karpenter\_sa\_role](#output\_karpenter\_sa\_role) | IRSA role for karpenter SA |
| <a name="output_node_iam_role_name"></a> [node\_iam\_role\_name](#output\_node\_iam\_role\_name) | n/a |
| <a name="output_node_security_group"></a> [node\_security\_group](#output\_node\_security\_group) | n/a |
| <a name="output_rds_cluster_arn"></a> [rds\_cluster\_arn](#output\_rds\_cluster\_arn) | The RDS Cluster ARN |
| <a name="output_rds_cluster_endpoint"></a> [rds\_cluster\_endpoint](#output\_rds\_cluster\_endpoint) | RDS Cluster endpoint |
| <a name="output_rds_cluster_identifier"></a> [rds\_cluster\_identifier](#output\_rds\_cluster\_identifier) | The RDS Cluster Identifier |
| <a name="output_rds_credentials_kms_key_arn"></a> [rds\_credentials\_kms\_key\_arn](#output\_rds\_credentials\_kms\_key\_arn) | RDS Credentials kms key arn |
| <a name="output_rds_extra_credentials_secret_arn"></a> [rds\_extra\_credentials\_secret\_arn](#output\_rds\_extra\_credentials\_secret\_arn) | RDS Extra Credentials Secret ARN |
| <a name="output_rds_extra_credentials_secret_name"></a> [rds\_extra\_credentials\_secret\_name](#output\_rds\_extra\_credentials\_secret\_name) | RDS Extra Credentials Secret Name |
| <a name="output_rds_iam_auth_irsa_arn"></a> [rds\_iam\_auth\_irsa\_arn](#output\_rds\_iam\_auth\_irsa\_arn) | n/a |
| <a name="output_rds_master_credentials_secret_arn"></a> [rds\_master\_credentials\_secret\_arn](#output\_rds\_master\_credentials\_secret\_arn) | RDS Master Credentials Secret ARN |
| <a name="output_rds_master_credentials_secret_name"></a> [rds\_master\_credentials\_secret\_name](#output\_rds\_master\_credentials\_secret\_name) | RDS Master Credentials Secret Name |
| <a name="output_redis_primary_endpoint_address"></a> [redis\_primary\_endpoint\_address](#output\_redis\_primary\_endpoint\_address) | Redis primary or configuration endpoint, whichever is appropriate for the given cluster mode |
| <a name="output_redis_reader_endpoint_address"></a> [redis\_reader\_endpoint\_address](#output\_redis\_reader\_endpoint\_address) | The address of the endpoint for the reader node in the replication group, if the cluster mode is disabled. |
| <a name="output_subnet1"></a> [subnet1](#output\_subnet1) | n/a |
| <a name="output_subnet2"></a> [subnet2](#output\_subnet2) | n/a |
| <a name="output_subnet3"></a> [subnet3](#output\_subnet3) | n/a |
| <a name="output_waf_webacl_arn"></a> [waf\_webacl\_arn](#output\_waf\_webacl\_arn) | RDS Credentials kms key arn |