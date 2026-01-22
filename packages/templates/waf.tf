module "wafv2_application" {
  source                         = "git::git@github.com:itgix/tf-module-wafv2.git?ref=v4"
  waf_enabled                    = var.application_waf_enabled
  project                        = var.project_name
  env                            = var.environment
  aws_region                     = var.region
  pid                            = var.project_name
  web_acl_scope                  = "REGIONAL"
  waf_attachment_type            = "application"                      # appended to WebACL and Log Group name
  waf_default_action             = var.waf_default_action             # allow or block - default action if a request doesn't match any rule
  waf_geo_location_block_enforce = var.waf_geo_location_block_enforce # allow or block
  web_acl_cloudwatch_enabled     = var.waf_webacl_cloudwatch_enabled
  sampled_requests_enabled       = var.waf_sampled_requests_enabled
  aws_waf_logging_enabled        = var.application_waf_enabled ? var.waf_logging_enabled : false
  waf_log_retention_days         = var.waf_log_retention_days
  country_codes_match            = var.waf_country_codes_match     # list of countries to be blocked by WAF
  aws_managed_waf_rule_groups    = var.aws_managed_waf_rule_groups # list of AWS managed security rules to be enabled
  custom_managed_waf_rule_groups = var.custom_managed_waf_rule_groups # list of custom managed security rules to be enabled
  custom_waf_rules               = var.custom_waf_rules
  cloudfront_true                = false
  application_true               = true
}

module "wafv2_cloudfront" {
  source      = "git::git@github.com:itgix/tf-module-wafv2.git?ref=v4"
  waf_enabled = var.cloudfront_waf_enabled

  providers = {
    aws = aws.virginia
  }

  project                     = var.project_name
  env                         = var.environment
  aws_region                  = var.region
  pid                         = var.project_name
  web_acl_scope               = "CLOUDFRONT"
  waf_attachment_type         = "cloudfront" # appended to WebACL and Log Group name
  web_acl_cloudwatch_enabled  = var.waf_webacl_cloudwatch_enabled
  sampled_requests_enabled    = var.waf_sampled_requests_enabled
  aws_waf_logging_enabled     = var.cloudfront_waf_enabled ? var.waf_logging_enabled : false
  waf_log_retention_days      = var.waf_log_retention_days
  country_codes_match         = var.waf_country_codes_match     # list of countries to be blocked by WAF
  aws_managed_waf_rule_groups = var.aws_managed_waf_rule_groups # list of AWS managed security rules to be enabled
  custom_managed_waf_rule_groups = var.custom_managed_waf_rule_groups # list of custom managed security rules to be enabled
  custom_waf_rules               = var.custom_waf_rules
  cloudfront_true                = true
  application_true               = false
}
