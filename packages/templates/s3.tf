module "s3_bucket" {
  count = var.s3_create ? 1 : 0
  source  = "git::git@github.com:itgix/tf-module-s3.git?ref=v1.1.9"
  

  region          = var.region
  environment     = var.environment
  project_name    = var.project_name

  # s3 bucket configuration
  bucket_configuration = var.bucket_configuration 
  

}