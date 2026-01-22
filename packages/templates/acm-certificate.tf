module "acm" {
  count  = var.acm_certificate_enable ? 1 : 0
  source = "git::git@github.com:itgix/tf-module-acm.git?ref=v1.0.1"
  # Configured for wildcard certificate
  domain_name = "*.${var.dns_main_domain}"
  r53_zone_id = var.dns_hosted_zone
}
