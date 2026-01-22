module "eks" {
  source = "git::git@github.com:itgix/tf-module-eks.git?ref=v1.1.2"
  count  = var.provision_eks ? 1 : 0

  providers = {
    aws = aws
  }

  aws_region  = var.region
  environment = var.environment

  eks_cluster_version = var.eks_cluster_version
  eks_cluster_name    = local.eks_name

  cluster_admins = var.eks_cluster_admins
  access_entries = var.eks_access_entries

  cluster_endpoint_public_access_cidrs = var.cluster_endpoint_public_access_cidrs

  cluster_log_retention_in_days = var.cluster_log_retention_in_days
  addons_versions               = var.addons_versions

  vpc_id                   = var.provision_vpc ? module.common_vpc[0].vpc_id : var.vpc_id
  subnet_ids               = var.provision_vpc ? module.common_vpc[0].private_subnets : var.vpc_private_subnet_ids
  control_plane_subnet_ids = var.provision_vpc ? module.common_vpc[0].public_subnets : var.vpc_public_subnet_ids


  eks_ami_type       = var.eks_ami_type
  eks_disk_size      = var.eks_disk_size
  eks_instance_types = var.eks_instance_types
  eks_volume_type    = var.eks_volume_type
  eks_volume_iops    = var.eks_volume_iops

  eks_ng_min_size      = var.eks_ng_min_size
  eks_ng_max_size      = var.eks_ng_max_size
  eks_ng_desired_size  = var.eks_ng_desired_size
  eks_ng_capacity_type = var.eks_ng_capacity_type

  eks_tags = local.aws_default_tags

  kms_key_users        = var.eks_kms_key_users
  secrets_kms_key_arns = length(local.secrets_kms_key_arns) > 0 ? local.secrets_kms_key_arns : ["*"]

  allow_long_names = var.allow_long_names
}
