#################################
#IRSA for VPC-CNI addon for EKS #
#################################
# ── `ec2:DescribeSubnets`, which the module's generated vpc-cni policy does not grant. ──
#
# The VPC CNI's SUBNET DISCOVERY (ENABLE_SUBNET_DISCOVERY, on by default since v1.18) calls
# ec2:DescribeSubnets before it creates an ENI. The pinned iam module (5.34.0) predates that
# feature, so `attach_vpc_cni_policy` emits a policy without the action, while the addon below is
# `most_recent = true` and therefore always has the feature. A pinned policy against a floating
# addon: the skew only ever widens.
#
# The failure is silent until a node needs its SECOND ENI, and then it is total. Measured on a real
# EKS floor run, 2026-08-24 (cluster eks-ue1-local946c3d09-alethia-nl), from ipamd.log:
#
#   Failed to call ec2:DescribeSubnets: ... UnauthorizedOperation ... is not authorized to perform:
#   ec2:DescribeSubnets because no identity-based policy allows the ec2:DescribeSubnets action
#   Failed to increase pool size due to not able to allocate ENI ... Quit ENI creation attempt.
#   hasRoomForEni: currentENIs=1, maxENI=3, hasRoom=true
#
# There was room for two more ENIs and 4079 free IPs in the subnet; the CNI simply could not ask
# which subnet to use, and gave up rather than falling back. A t3.large's first ENI carries 12 IPs,
# one of which is the node's own — so the cluster hard-stops at ELEVEN pod IPs. ArgoCD's
# application-controller was the twelfth pod and sat in ContainerCreating with
# `failed to assign an IP address to container` until the run timed out.
#
# Granting the read is the fix AWS documents for subnet discovery
# (https://github.com/aws/amazon-vpc-cni-k8s/blob/master/docs/iam-policy.md — the CNI's own error
# message links it). The alternative, pinning ENABLE_SUBNET_DISCOVERY=false, keeps the missing
# permission and gives up a feature that matters precisely when a subnet fills up.
data "aws_iam_policy_document" "vpc_cni_subnet_discovery" {
  statement {
    sid       = "VpcCniSubnetDiscovery"
    effect    = "Allow"
    actions   = ["ec2:DescribeSubnets"]
    resources = ["*"] # DescribeSubnets is a list action; AWS does not support resource-level scoping on it
  }
}

resource "aws_iam_policy" "vpc_cni_subnet_discovery" {
  # `name_prefix`, not `name`, and without the cluster name in it — the same shape as the ALB
  # controller policy below. A fixed name would collide on a replace-before-destroy, and folding a
  # cluster name into an IAM name is the derived-length trap the repo has already paid for (#1905).
  # The cluster is identified in the description instead, where nothing has to fit.
  name_prefix = "AmazonEKS-VPC-CNI-SubnetDiscovery"
  description = "ec2:DescribeSubnets for the VPC CNI's subnet discovery on ${var.eks_cluster_name} — absent from the pinned iam module's generated policy."
  policy      = data.aws_iam_policy_document.vpc_cni_subnet_discovery.json
  tags        = var.eks_tags
}

module "vpc_cni_irsa" {
  source  = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts-eks"
  version = "5.34.0"

  role_name             = "AmazonEKS-VPC-CNI-${var.eks_cluster_name}"
  attach_vpc_cni_policy = true
  vpc_cni_enable_ipv6   = false
  vpc_cni_enable_ipv4   = true

  role_policy_arns = {
    subnet_discovery = aws_iam_policy.vpc_cni_subnet_discovery.arn
  }

  oidc_providers = {
    main = {
      provider_arn               = module.eks.oidc_provider_arn
      namespace_service_accounts = ["kube-system:aws-node"]
    }
  }
}

#################################
#IRSA for EBS-CSI addon for EKS #
#################################
module "irsa-ebs-csi" {
  source  = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts-eks"
  version = "5.34.0"

  create_role = true
  role_name   = "AmazonEKS-EBS-CSI-${var.eks_cluster_name}"
  role_policy_arns = {
    ebs_csi_policy = "arn:aws:iam::aws:policy/service-role/AmazonEBSCSIDriverPolicy"
  }
  oidc_providers = {
    main = {
      provider_arn               = module.eks.oidc_provider_arn
      namespace_service_accounts = ["kube-system:ebs-csi-controller-sa"]
    }
  }
}

#####################################
#IRSA for External Secrets Operator #
#####################################
module "iam_assumable_role_admin_secrets_operator" {
  source  = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts-eks"
  version = "5.34.0"

  create_role = true
  role_name   = "${var.eks_cluster_name}-secrets-operator"
  role_policy_arns = {
    eso_policy = aws_iam_policy.secrets_operator.arn
  }
  oidc_providers = {
    main = {
      provider_arn               = module.eks.oidc_provider_arn
      namespace_service_accounts = ["external-secrets-operator:external-secrets-operator-sa"]
    }
  }
}

#########################################
#IRSA for External DNS  +  cert-manager #
#########################################
# ONE Route53 role, TWO service accounts. cert-manager's DNS01 solver does exactly what
# external-dns does — write a TXT record into the project's hosted zone and delete it
# again — so it needs the same Route53 permission and no more. Minting a second role with
# the same policy would buy nothing but another identity to keep in step.
#
# The SECOND entry below is load-bearing, not cosmetic: an IRSA trust policy names the
# exact `<namespace>:<serviceaccount>` pairs allowed to assume the role. cert-manager runs
# as `cert-manager:cert-manager`, so WITHOUT this line the eks.amazonaws.com/role-arn
# annotation infra/templates/argocd/cert-manager.yaml puts on its ServiceAccount points at
# a role it may not assume, and every DNS01 challenge fails at AssumeRoleWithWebIdentity —
# an error that surfaces only on the Challenge resource, inside a certificate that just
# never issues. See InfraFacts.CertManagerSolver(), which gates the whole install on this
# role's ARN being present.
module "iam_assumable_role_external_dns" {
  source  = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts-eks"
  version = "5.34.0"

  create_role = true
  role_name   = "${var.eks_cluster_name}-external-dns"
  role_policy_arns = {
    external_dns_policy = aws_iam_policy.external_dns.arn
  }
  oidc_providers = {
    main = {
      provider_arn = module.eks.oidc_provider_arn
      # THREE service accounts on one role, for the reason the header above gives about the second.
      # `external-dns:addon-external-dns` is the MARKETPLACE add-on's KSA (apps/console/lib/addons/
      # catalog.ts, EXTERNAL_DNS_ADDON_SA). It is a distinct object from the rail's
      # `external-dns-sa` deliberately: both Applications live in the `external-dns` namespace and
      # naming one KSA would put two ArgoCD Applications on it. The policy it needs is the one
      # already attached, so a second role with an identical policy would be pure duplication.
      namespace_service_accounts = ["external-dns:external-dns-sa", "external-dns:addon-external-dns", "cert-manager:cert-manager"]
    }
  }
}

resource "aws_iam_policy" "external_dns" {
  name_prefix = "${var.eks_cluster_name}-external-dns-"
  description = "Route53 access for the project's external-dns hosted zone"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["route53:ChangeResourceRecordSets", "route53:ListResourceRecordSets"]
        Resource = var.external_dns_zone_id == "" ? "arn:aws:route53:::hostedzone/00000000" : "arn:aws:route53:::hostedzone/${var.external_dns_zone_id}"
      },
      {
        Effect   = "Allow"
        Action   = ["route53:GetChange", "route53:ListHostedZones", "route53:ListHostedZonesByName", "route53:ListTagsForResource"]
        Resource = "*"
      },
    ]
  })
}

# Least-privilege: read-only on the PROJECT'S secrets only (custom-secrets prefix + the
# RDS credential secrets the root passes in) — never Resource "*" over the whole account.
resource "aws_iam_policy" "secrets_operator" {
  name_prefix = "${var.eks_cluster_name}-secrets-operator-policy"
  description = "EKS external-secrets-operator  policy for cluster ${var.eks_cluster_name}"
  policy      = <<EOT
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Sid": "ReadProjectSecrets",
            "Effect": "Allow",
            "Action": [
                "secretsmanager:GetSecretValue",
                "secretsmanager:DescribeSecret"
            ],
            "Resource": ${jsonencode(var.secret_resource_arns)}
        },
        {
            "Sid": "KMSDecrypt",
            "Effect": "Allow",
            "Action": "kms:Decrypt",
            "Resource": ${jsonencode(var.secrets_kms_key_arns)}
        }
    ]
}
EOT
}

##########################
#IRSA for ALB Controller #
##########################
module "iam_assumable_role_admin_aws_load_balancer_controller" {

  source  = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts-eks"
  version = "5.34.0"

  create_role = true
  role_name   = "aws-load-balancer-controller-${var.eks_cluster_name}"
  role_policy_arns = {
    alb_controller_policy = aws_iam_policy.aws_load_balancer_controller.arn
  }
  oidc_providers = {
    main = {
      provider_arn               = module.eks.oidc_provider_arn
      namespace_service_accounts = ["kube-system:aws-load-balancer-controller-sa"]
    }
  }
}

resource "aws_iam_policy" "aws_load_balancer_controller" {

  name_prefix = "aws-load-balancer-controller"
  description = "EKS aws-load-balancer-controller policy for cluster ${var.eks_cluster_name}"
  policy      = <<EOT
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Action": [
                "iam:CreateServiceLinkedRole"
            ],
            "Resource": "*",
            "Condition": {
                "StringEquals": {
                    "iam:AWSServiceName": "elasticloadbalancing.amazonaws.com"
                }
            }
        },
        {
            "Effect": "Allow",
            "Action": [
                "ec2:DescribeAccountAttributes",
                "ec2:DescribeAddresses",
                "ec2:DescribeAvailabilityZones",
                "ec2:DescribeInternetGateways",
                "ec2:DescribeVpcs",
                "ec2:DescribeVpcPeeringConnections",
                "ec2:DescribeSubnets",
                "ec2:DescribeSecurityGroups",
                "ec2:DescribeInstances",
                "ec2:DescribeNetworkInterfaces",
                "ec2:DescribeTags",
                "ec2:GetCoipPoolUsage",
                "ec2:DescribeCoipPools",
                "elasticloadbalancing:DescribeLoadBalancers",
                "elasticloadbalancing:DescribeLoadBalancerAttributes",
                "elasticloadbalancing:DescribeListeners",
                "elasticloadbalancing:DescribeListenerCertificates",
                "elasticloadbalancing:DescribeSSLPolicies",
                "elasticloadbalancing:DescribeRules",
                "elasticloadbalancing:DescribeTargetGroups",
                "elasticloadbalancing:DescribeTargetGroupAttributes",
                "elasticloadbalancing:DescribeTargetHealth",
                "elasticloadbalancing:DescribeTags"
            ],
            "Resource": "*"
        },
        {
            "Effect": "Allow",
            "Action": [
                "cognito-idp:DescribeUserPoolClient",
                "acm:ListCertificates",
                "acm:DescribeCertificate",
                "iam:ListServerCertificates",
                "iam:GetServerCertificate",
                "waf-regional:GetWebACL",
                "waf-regional:GetWebACLForResource",
                "waf-regional:AssociateWebACL",
                "waf-regional:DisassociateWebACL",
                "wafv2:GetWebACL",
                "wafv2:GetWebACLForResource",
                "wafv2:AssociateWebACL",
                "wafv2:DisassociateWebACL",
                "shield:GetSubscriptionState",
                "shield:DescribeProtection",
                "shield:CreateProtection",
                "shield:DeleteProtection"
            ],
            "Resource": "*"
        },
        {
            "Effect": "Allow",
            "Action": [
                "ec2:AuthorizeSecurityGroupIngress",
                "ec2:RevokeSecurityGroupIngress"
            ],
            "Resource": "*"
        },
        {
            "Effect": "Allow",
            "Action": [
                "ec2:CreateSecurityGroup"
            ],
            "Resource": "*"
        },
        {
            "Effect": "Allow",
            "Action": [
                "ec2:CreateTags"
            ],
            "Resource": "arn:aws:ec2:*:*:security-group/*",
            "Condition": {
                "StringEquals": {
                    "ec2:CreateAction": "CreateSecurityGroup"
                },
                "Null": {
                    "aws:RequestTag/elbv2.k8s.aws/cluster": "false"
                }
            }
        },
        {
            "Effect": "Allow",
            "Action": [
                "ec2:CreateTags",
                "ec2:DeleteTags"
            ],
            "Resource": "arn:aws:ec2:*:*:security-group/*",
            "Condition": {
                "Null": {
                    "aws:RequestTag/elbv2.k8s.aws/cluster": "true",
                    "aws:ResourceTag/elbv2.k8s.aws/cluster": "false"
                }
            }
        },
        {
            "Effect": "Allow",
            "Action": [
                "ec2:AuthorizeSecurityGroupIngress",
                "ec2:RevokeSecurityGroupIngress",
                "ec2:DeleteSecurityGroup"
            ],
            "Resource": "*",
            "Condition": {
                "Null": {
                    "aws:ResourceTag/elbv2.k8s.aws/cluster": "false"
                }
            }
        },
        {
            "Effect": "Allow",
            "Action": [
                "elasticloadbalancing:CreateLoadBalancer",
                "elasticloadbalancing:CreateTargetGroup"
            ],
            "Resource": "*",
            "Condition": {
                "Null": {
                    "aws:RequestTag/elbv2.k8s.aws/cluster": "false"
                }
            }
        },
        {
            "Effect": "Allow",
            "Action": [
                "elasticloadbalancing:CreateListener",
                "elasticloadbalancing:DeleteListener",
                "elasticloadbalancing:CreateRule",
                "elasticloadbalancing:DeleteRule"
            ],
            "Resource": "*"
        },
        {
            "Effect": "Allow",
            "Action": [
                "elasticloadbalancing:AddTags",
                "elasticloadbalancing:RemoveTags"
            ],
            "Resource": [
                "arn:aws:elasticloadbalancing:*:*:targetgroup/*/*",
                "arn:aws:elasticloadbalancing:*:*:loadbalancer/net/*/*",
                "arn:aws:elasticloadbalancing:*:*:loadbalancer/app/*/*"
            ],
            "Condition": {
                "Null": {
                    "aws:RequestTag/elbv2.k8s.aws/cluster": "true",
                    "aws:ResourceTag/elbv2.k8s.aws/cluster": "false"
                }
            }
        },
        {
            "Effect": "Allow",
            "Action": [
                "elasticloadbalancing:AddTags",
                "elasticloadbalancing:RemoveTags"
            ],
            "Resource": [
                "arn:aws:elasticloadbalancing:*:*:listener/net/*/*/*",
                "arn:aws:elasticloadbalancing:*:*:listener/app/*/*/*",
                "arn:aws:elasticloadbalancing:*:*:listener-rule/net/*/*/*",
                "arn:aws:elasticloadbalancing:*:*:listener-rule/app/*/*/*"
            ]
        },
        {
            "Effect": "Allow",
            "Action": [
                "elasticloadbalancing:ModifyLoadBalancerAttributes",
                "elasticloadbalancing:SetIpAddressType",
                "elasticloadbalancing:SetSecurityGroups",
                "elasticloadbalancing:SetSubnets",
                "elasticloadbalancing:DeleteLoadBalancer",
                "elasticloadbalancing:ModifyTargetGroup",
                "elasticloadbalancing:ModifyTargetGroupAttributes",
                "elasticloadbalancing:DeleteTargetGroup"
            ],
            "Resource": "*",
            "Condition": {
                "Null": {
                    "aws:ResourceTag/elbv2.k8s.aws/cluster": "false"
                }
            }
        },
        {
            "Effect": "Allow",
            "Action": [
                "elasticloadbalancing:AddTags"
            ],
            "Resource": [
                "arn:aws:elasticloadbalancing:*:*:targetgroup/*/*",
                "arn:aws:elasticloadbalancing:*:*:loadbalancer/net/*/*",
                "arn:aws:elasticloadbalancing:*:*:loadbalancer/app/*/*"
            ],
            "Condition": {
                "StringEquals": {
                    "elasticloadbalancing:CreateAction": [
                        "CreateTargetGroup",
                        "CreateLoadBalancer"
                    ]
                },
                "Null": {
                    "aws:RequestTag/elbv2.k8s.aws/cluster": "false"
                }
            }
        },
        {
            "Effect": "Allow",
            "Action": [
                "elasticloadbalancing:RegisterTargets",
                "elasticloadbalancing:DeregisterTargets"
            ],
            "Resource": "arn:aws:elasticloadbalancing:*:*:targetgroup/*/*"
        },
        {
            "Effect": "Allow",
            "Action": [
                "elasticloadbalancing:SetWebAcl",
                "elasticloadbalancing:ModifyListener",
                "elasticloadbalancing:AddListenerCertificates",
                "elasticloadbalancing:RemoveListenerCertificates",
                "elasticloadbalancing:ModifyRule"
            ],
            "Resource": "*"
        }
    ]
}
EOT
}
