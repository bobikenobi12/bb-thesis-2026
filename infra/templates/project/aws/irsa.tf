# NOTE (#957): the roles below are CLUSTER-level IRSA, provisioned by tofu at Fabric creation and scoped
# to specific control-plane KSAs (e.g. default:alethia-app). A `namespace`-placement tenant does NOT get
# one of these — its per-namespace tenant identity is provisioned by the RUNNER via the IAM SDK at
# deploy time (packages/core/cloud/aws/tenant_identity.go: a zero-perm role trusting
# system:serviceaccount:<ns>:*), because the namespace-deploy path runs no tofu. GCP Workload-Identity /
# Azure federated per-namespace parity is the documented #1013 follow-up.

##########################
#IRSA for RDS IAM Auth   #
##########################
# The keyless app workload's identity (#722). Least-privilege on all THREE axes:
#   - scoped to the EXACT app KSA (default/alethia-app), not "*:*" — only that pod can assume it, so a
#     stray workload can't mint DB tokens (parity with the GCP/Azure per-KSA subject binding);
#   - rds-db:connect ONLY, and only as the `alethia_app` user (the bootstrap-created least-priv role),
#     not the former rds-db:* on dbuser:*/*. The unrelated SQS-FullAccess / KMS-PowerUser grants that
#     used to ride on this role are dropped — a keyless DB identity has no business holding them;
#   - scoped to THIS cluster's resource id, not the `dbuser:*` wildcard it used to carry (#1509).
#
# On the username segment: the IAM policy is what MAPS the pod's role onto a database user, so
# `/alethia_app` here and the DDL username the bootstrap Job creates
# (apps/runner/internal/agent/db_bootstrap.go, keylessBootstrapRole, #1506) must be identical — AWS
# matches it case-sensitively and a mismatch denies every connect SILENTLY. There is no guard pinning
# the two literals together; keep them in step by hand.
#
# On admin identity: AWS deliberately has NO separate admin identity here, unlike Azure's
# app-UAMI / admin-UAMI split. The bootstrap Job connects with the master password via its
# ExternalSecret, so there is nothing to scope — this role is the APP's identity only. That asymmetry
# is intentional; do not port Azure's machinery to close it.

locals {
  # The Aurora CLUSTER RESOURCE id ("cluster-XXXXXXXXXXXX"), NOT the cluster identifier/name: AWS
  # matches the rds-db:connect ARN on the resource id, so an identifier here produces a non-matching
  # ARN and denies every connect (#1504 exports it for exactly this).
  #
  # Unknown at plan time for a new cluster — that is fine, it resolves during apply and simply orders
  # the policy after the cluster. Empty only when no RDS cluster exists, which the precondition below
  # rejects rather than letting it degrade back into a wildcard.
  #
  # The null is collapsed on the NEXT line, not by a `try()` fallback around this one: try() rescues
  # ERRORS, and an absent module yields NULL here, not an error. A `try(…, "")` fallback therefore
  # never fired, and the null reached the policy's string template, which fails with "Invalid
  # template interpolation value" instead of the precondition's explanation.
  #
  # The probe replaced `one(module.rds_maindb[*]…)` (#3509): a splat reads the module AS A WHOLE,
  # and this local feeds an IAM policy the RDS module must not have to wait on. Probing one output
  # of one instance keeps the edge as fine as a bare index, and repeating the traversal outside the
  # `try()` keeps a renamed output a validation error.
  rds_iam_cluster_resource_id_raw = try(module.rds_maindb[0].rds_cluster_resource_id, null) != null ? module.rds_maindb[0].rds_cluster_resource_id : null
  rds_iam_cluster_resource_id     = local.rds_iam_cluster_resource_id_raw == null ? "" : local.rds_iam_cluster_resource_id_raw
}
module "rds_iam_auth" {

  source = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts-eks"
  # `provision_eks` is part of the count, not merely of the body: every IRSA role in this file is
  # federated to THIS cluster's OIDC provider (module.eks[0].oidc_provider_arn below), which does not
  # exist on a cluster-less shape. Without the term the module was still instantiated and indexed an
  # empty tuple — "Invalid index … module.eks is empty tuple" — so `provision_eks = false` could not
  # even PLAN (#1772). A role trusting a nonexistent OIDC provider is also useless if it were built.
  count   = var.rds_iam_irsa && var.provision_eks ? 1 : 0
  version = "5.34.0"

  assume_role_condition_test = "StringEquals"
  create_role                = true
  role_name                  = "rds-iam-auth-${local.eks_name}"
  role_policy_arns = {
    rds_iam_auth_policy = one(aws_iam_policy.rds_iam_auth[*].arn)
  }
  oidc_providers = {
    main = {
      provider_arn               = try(module.eks[0].oidc_provider_arn, null) != null ? module.eks[0].oidc_provider_arn : ""
      namespace_service_accounts = ["default:alethia-app"]
    }
  }
}



resource "aws_iam_policy" "rds_iam_auth" {
  # Same count as the module that consumes it (below). Without this the policy was created
  # UNCONDITIONALLY while its only consumer was gated on rds_iam_irsa — so on every shape that does not
  # ask for the app's RDS-IAM identity (the default, and every e2e floor run) tofu still rendered an
  # rds-db:connect ARN for a cluster that does not exist. That is what reds the AWS nightly at PLAN
  # time, before a single resource is created.
  #
  # The `provision_eks` term is the same bug in its second form (#1772): the module below dropped out
  # on a cluster-less shape, and a policy whose only consumer is gone is an ORPHAN IAM policy that
  # nothing detaches. Both counts must stay byte-identical.
  count = var.rds_iam_irsa && var.provision_eks ? 1 : 0

  name_prefix = "rds_iam_auth"
  description = "Policy for the keyless app ServiceAccount allowing RDS IAM connect as alethia_app for cluster ${local.eks_name}"
  policy      = <<EOT
{
    "Statement": [
        {
            "Action": [
                "rds-db:connect"
            ],
            "Effect": "Allow",
            "Resource": "arn:aws:rds-db:${var.region}:${var.aws_account_id}:dbuser:${local.rds_iam_cluster_resource_id}/alethia_app",
            "Sid": "AllowRDSiamAccess"
        }
    ],
    "Version": "2012-10-17"
}
EOT

  lifecycle {
    # Fail closed rather than degrade. With no RDS cluster there is no resource id to scope to, and the
    # ARN would render as `dbuser:/alethia_app` — a malformed resource that grants nothing but reports
    # a healthy apply, so the breakage would only surface as a runtime auth failure. Both operands are
    # plain variables, so this is decided at PLAN time. (`check` blocks only warn; a precondition
    # blocks — see terraform_data.rds_engine_shape_guard / compat_k8s_guard for the same pairing.)
    precondition {
      condition     = !var.rds_iam_irsa || var.create_rds
      error_message = "RDS-IAM-IRSA-001: rds_iam_irsa is on but create_rds is false, so there is no cluster resource id to scope rds-db:connect to. Apply blocked fail-closed — enabling the app's RDS-IAM identity without an RDS cluster would either grant nothing or require the dbuser:* wildcard this policy exists to avoid."
    }
  }
}


##########################
#IRSA for Alethia agent   #
##########################
module "irsa_alethia_agent" {

  source = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts-eks"
  # No cluster, no OIDC provider to federate to — see the note on module.rds_iam_auth (#1772).
  count   = var.provision_eks ? 1 : 0
  version = "5.34.0"

  assume_role_condition_test = "StringLike"
  create_role                = true
  role_name                  = "irsa-alethia-${local.eks_name}"
  role_policy_arns = {
    alethia_agent_policy = one(aws_iam_policy.irsa_alethia_agent[*].arn)
  }
  oidc_providers = {
    main = {
      provider_arn               = try(module.eks[0].oidc_provider_arn, null) != null ? module.eks[0].oidc_provider_arn : ""
      namespace_service_accounts = ["*:*"]
    }
  }
}

resource "aws_iam_policy" "irsa_alethia_agent" {
  # Same count as the role that consumes it (above) — a policy outliving its only consumer is an
  # orphan nothing detaches. Same pairing as aws_iam_policy.rds_iam_auth (#1772).
  count = var.provision_eks ? 1 : 0

  name_prefix = "irsa_alethia_agent"
  description = "Policy for ServiceAccounts allowing calls to AWS metering API for cluster ${local.eks_name}"
  policy      = <<EOT
{
    "Statement": [
        {
            "Action": [
                "aws-marketplace:RegisterUsage",
                "aws-marketplace:MeterUsage"
            ],
            "Effect": "Allow",
            "Resource": "*"
        }
    ],
    "Version": "2012-10-17"
}
EOT
}

#############################################
#IRSA for fluent-bit access to cloudwatch   #
#############################################
module "irsa_fluentbit_cloudwatch" {

  source = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts-eks"
  # No cluster, no OIDC provider to federate to — see the note on module.rds_iam_auth (#1772).
  count   = var.provision_eks ? 1 : 0
  version = "5.34.0"

  assume_role_condition_test = "StringLike"
  create_role                = true
  role_name                  = "irsa-fluentbit-cloudwatch-${local.eks_name}"
  role_policy_arns = {
    aws_managed_policy = "arn:aws:iam::aws:policy/service-role/AWSAppSyncPushToCloudWatchLogs"
  }
  oidc_providers = {
    main = {
      provider_arn               = try(module.eks[0].oidc_provider_arn, null) != null ? module.eks[0].oidc_provider_arn : ""
      namespace_service_accounts = ["fluent-bit:fluent-bit"]
    }
  }
}

#############################################
#IRSA for Karpenter                         #
#############################################
resource "aws_iam_policy" "irsa_karpenter" {
  # Same count as the role that consumes it (below) — an orphan otherwise (#1772). Deliberately NOT
  # also gated on enable_karpenter: that would change what an existing cluster has already applied,
  # which is a separate decision from making a cluster-less shape plan.
  count = var.provision_eks ? 1 : 0

  name_prefix = "irsa_karpenter"
  description = "Policy for Karpenter ServiceAccounts for cluster ${local.eks_name}"
  policy      = <<EOT
{
    "Statement": [
        {
            "Action": [
                "pricing:GetProducts",
                "ec2:DescribeSubnets",
                "ec2:DescribeSpotPriceHistory",
                "ec2:DescribeSecurityGroups",
                "ec2:DescribeLaunchTemplates",
                "ec2:DescribeInstances",
                "ec2:DescribeInstanceTypes",
                "ec2:DescribeInstanceTypeOfferings",
                "ec2:DescribeImages",
                "ec2:DescribeAvailabilityZones",
                "ec2:CreateTags",
                "ec2:CreateLaunchTemplate",
                "ec2:CreateFleet"
            ],
            "Effect": "Allow",
            "Resource": "*"
        },
        {
            "Action": [
                "ec2:TerminateInstances",
                "ec2:DeleteLaunchTemplate"
            ],
            "Condition": {
                "StringEquals": {
                    "ec2:ResourceTag/karpenter.sh/discovery": "${local.eks_name}"
                }
            },
            "Effect": "Allow",
            "Resource": "*"
        },
        {
            "Action": "ec2:RunInstances",
            "Condition": {
                "StringEquals": {
                    "ec2:ResourceTag/karpenter.sh/discovery": "${local.eks_name}"
                }
            },
            "Effect": "Allow",
            "Resource": "arn:aws:ec2:*:${var.aws_account_id}:launch-template/*"
        },
        {
            "Action": "ec2:RunInstances",
            "Effect": "Allow",
            "Resource": [
                "arn:aws:ec2:*::snapshot/*",
                "arn:aws:ec2:*::image/*",
                "arn:aws:ec2:*:*:volume/*",
                "arn:aws:ec2:*:*:subnet/*",
                "arn:aws:ec2:*:*:spot-instances-request/*",
                "arn:aws:ec2:*:*:security-group/*",
                "arn:aws:ec2:*:*:network-interface/*",
                "arn:aws:ec2:*:*:instance/*"
            ]
        },
        {
            "Action": "ssm:GetParameter",
            "Effect": "Allow",
            "Resource": "arn:aws:ssm:*:*:parameter/aws/service/*"
        },
        {
            "Action": "eks:DescribeCluster",
            "Effect": "Allow",
            "Resource": "arn:aws:eks:*:${var.aws_account_id}:cluster/${local.eks_name}"
        },
        {
            "Action": "iam:PassRole",
            "Effect": "Allow",
            "Resource": "arn:aws:iam::${var.aws_account_id}:role/${local.eks_name}-*"
        },
        {
            "Action": [
                "sqs:ReceiveMessage",
                "sqs:GetQueueUrl",
                "sqs:GetQueueAttributes",
                "sqs:DeleteMessage"
            ],
            "Effect": "Allow",
            "Resource": "arn:aws:sqs:${var.region}:${var.aws_account_id}:queue-${var.region}-${var.environment}-karpenter"
        },
        {
            "Action": [
                "iam:TagInstanceProfile",
                "iam:RemoveRoleFromInstanceProfile",
                "iam:GetInstanceProfile",
                "iam:DeleteInstanceProfile",
                "iam:CreateInstanceProfile",
                "iam:ListInstanceProfiles",
                "iam:AddRoleToInstanceProfile"
            ],
            "Effect": "Allow",
            "Resource": "*"
        }
    ],
    "Version": "2012-10-17"
}
EOT
}

module "irsa_karpenter" {

  source = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts-eks"
  # No cluster, no OIDC provider to federate to — see the note on module.rds_iam_auth (#1772).
  count   = var.provision_eks ? 1 : 0
  version = "5.34.0"

  assume_role_condition_test = "StringEquals"
  create_role                = true
  role_name                  = "KarpenterIRSA-${local.eks_name}"
  role_policy_arns = {
    alethia_agent_policy = one(aws_iam_policy.irsa_karpenter[*].arn)
  }
  oidc_providers = {
    main = {
      provider_arn               = try(module.eks[0].oidc_provider_arn, null) != null ? module.eks[0].oidc_provider_arn : ""
      namespace_service_accounts = ["${local.karpenter_namespace}:karpenter"]
    }
  }
}

##########################
#IRSA for AI Bedrock   #
##########################
module "irsa_ai_bedrock" {

  source = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts-eks"
  # No cluster, no OIDC provider to federate to — see the note on module.rds_iam_auth (#1772).
  count   = var.provision_eks ? 1 : 0
  version = "5.34.0"

  assume_role_condition_test = "StringLike"
  create_role                = true
  role_name                  = "ai-bedrock-${local.eks_name}"
  role_policy_arns = {
    aws_managed_policy            = "arn:aws:iam::aws:policy/AmazonBedrockFullAccess",
    irsa_ai_bedrock_custom_policy = one(aws_iam_policy.irsa_ai_bedrock_custom[*].arn)
    irsa_ai_bedrock_s3_policy     = one(aws_iam_policy.irsa_ai_bedrock_s3[*].arn)

  }
  oidc_providers = {
    main = {
      provider_arn               = try(module.eks[0].oidc_provider_arn, null) != null ? module.eks[0].oidc_provider_arn : ""
      namespace_service_accounts = ["*:*"]
    }
  }
}
resource "aws_iam_policy" "irsa_ai_bedrock_custom" {
  # Same count as the role that consumes it (above) — an orphan otherwise (#1772).
  count = var.provision_eks ? 1 : 0

  name_prefix = "irsa_ai_bedrock_custom"
  description = "Policy for ServiceAccounts allowing invoking bedrock model"
  policy      = <<EOT
  {
    "Statement": [
        {
             "Action": [
                "bedrock:InvokeModel",
                "bedrock:InvokeModelWithResponseStream"
            ],
            "Effect": "Allow",
            "Resource": "arn:aws:bedrock:${var.region}:${var.aws_account_id}:*/*"
        }
    ],
    "Version": "2012-10-17"
  }
 EOT
}
resource "aws_iam_policy" "irsa_ai_bedrock_s3" {
  # Same count as the role that consumes it (above) — an orphan otherwise (#1772).
  count = var.provision_eks ? 1 : 0

  name_prefix = "irsa_ai_bedrock_s3"
  description = "Policy for ServiceAccounts allowing S3 bucket access"
  policy      = <<EOT
  {
    "Statement": [
		{
			"Effect": "Allow",
			"Action": [
				"s3:ListBucket"
			],
			"Resource": "arn:aws:s3:::*"
		},
		{
			"Effect": "Allow",
			"Action": [
				"s3:GetObject",
				"s3:PutObject"
			],
			"Resource": "arn:aws:s3:::*/*"
		}
	],
    "Version": "2012-10-17"
  }
 EOT  

}
#############################################
#IRSA for in-cluster image builds (W2)      #
#############################################
# The kaniko build Job's ServiceAccount assumes this role to push built service images into
# the project's ECR repositories — keyless (no registry credentials ever minted or mounted).
# The SA coordinates are a fixed contract with the BUILD job renderer (packages/core/build):
# namespace "alethia-build", ServiceAccount "kaniko-builder".
locals {
  ecr_build_namespace       = "alethia-build"
  ecr_build_service_account = "kaniko-builder"
}

resource "aws_iam_policy" "irsa_ecr_build" {
  # `provision_ecr` alone was NOT this policy's predicate: its only consumer is the IRSA role below,
  # which additionally needs a cluster OIDC provider. On `provision_ecr = true, provision_eks = false`
  # the role dropped out and the policy did not — an orphan nothing detaches (#1772). Both counts
  # must stay byte-identical.
  count = var.provision_ecr && var.provision_eks ? 1 : 0

  name_prefix = "irsa_ecr_build"
  description = "ECR push for the in-cluster build ServiceAccount of cluster ${local.eks_name}"
  policy      = <<EOT
{
    "Statement": [
        {
            "Action": [
                "ecr:GetAuthorizationToken"
            ],
            "Effect": "Allow",
            "Resource": "*",
            "Sid": "EcrLogin"
        },
        {
            "Action": [
                "ecr:BatchCheckLayerAvailability",
                "ecr:BatchGetImage",
                "ecr:GetDownloadUrlForLayer",
                "ecr:InitiateLayerUpload",
                "ecr:UploadLayerPart",
                "ecr:CompleteLayerUpload",
                "ecr:PutImage"
            ],
            "Effect": "Allow",
            "Resource": "arn:aws:ecr:${var.region}:${var.aws_account_id}:repository/${var.project_name}-*",
            "Sid": "EcrPushProjectRepos"
        }
    ],
    "Version": "2012-10-17"
}
EOT
}

module "irsa_ecr_build" {

  source = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts-eks"
  # `provision_ecr` was the WRONG flag on its own: this role federates to the cluster's OIDC provider,
  # so it exploded on `provision_ecr = true, provision_eks = false` (#1772). The kaniko builder has
  # nowhere to run without a cluster anyway.
  count   = var.provision_ecr && var.provision_eks ? 1 : 0
  version = "5.34.0"

  assume_role_condition_test = "StringEquals"
  create_role                = true
  role_name                  = "ecr-build-${local.eks_name}"
  role_policy_arns = {
    ecr_build_policy = one(aws_iam_policy.irsa_ecr_build[*].arn)
  }
  oidc_providers = {
    main = {
      provider_arn               = try(module.eks[0].oidc_provider_arn, null) != null ? module.eks[0].oidc_provider_arn : ""
      namespace_service_accounts = ["${local.ecr_build_namespace}:${local.ecr_build_service_account}"]
    }
  }
}

##########################
#IRSA for S3 bucket   #
##########################
module "s3_bucket_irsa_role" {

  source = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts-eks"
  # No cluster, no OIDC provider to federate to — see the note on module.rds_iam_auth (#1772).
  count   = var.provision_eks ? 1 : 0
  version = "5.34.0"

  assume_role_condition_test = "StringLike"
  create_role                = true
  role_name                  = "s3-bucket-${local.eks_name}"
  role_policy_arns = {
    aws_managed_policy = "arn:aws:iam::aws:policy/AmazonS3FullAccess"
  }
  oidc_providers = {
    main = {
      provider_arn               = try(module.eks[0].oidc_provider_arn, null) != null ? module.eks[0].oidc_provider_arn : ""
      namespace_service_accounts = ["*:*"]
    }
  }
}