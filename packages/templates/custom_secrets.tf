module "custom_secrets_password_module" {
  source = "git@github.com:itgix/tf-module-awssm-passgen.git?ref=v1.0.1"

  custom_secrets = var.custom_secrets

  secret_name_prefix = "${local.aws_regions_short[var.region]}-${var.environment}-${var.project_name}-"
  secret_keepers     = var.custom_secret_keepers
}
