terraform {
  required_version = "~> 1.1"
  backend "http" {}



  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.81, < 6.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.0"
    }
  }
}

# default_tags fans the classification + sweep-handle tags out to EVERY taggable AWS resource
# (including ones not passed local.aws_default_tags, e.g. S3/DynamoDB/Route53/WAF), so a guarded
# sweeper can scope destroys to one environment. The three platform base tags sit on the merge RHS
# and WIN any key collision. Base keys are unnamespaced; classification keys are `alethia:`-scoped,
# so in practice they never collide — the RHS ordering is the belt-and-suspenders guarantee.
provider "aws" {
  region = var.region
  default_tags {
    tags = merge(var.classification_tags, {
      Environment = title(var.environment)
      Service     = var.project_name
      ManagedBy   = "opentofu"
    })
  }
}

# needed for WAF module
provider "aws" {
  alias  = "virginia"
  region = "us-east-1"
  default_tags {
    tags = merge(var.classification_tags, {
      Environment = title(var.environment)
      Service     = var.project_name
      ManagedBy   = "opentofu"
    })
  }
}

# The kubernetes/helm providers are declared for completeness but define no resources
# (ArgoCD + add-ons are installed post-apply by the runner via kubectl/helm). The former
# `exec { command = "aws" eks get-token }` auth block was removed as part of the CLI-free
# runner: no aws CLI is present in the image. If in-template k8s/helm resources are ever
# added, authenticate with `data.aws_eks_cluster_auth` (a token, no CLI) rather than exec.
#
# A provider block cannot take a `count`, so the cluster gate has to live in the expression
# (#1772). These two were the last unguarded `module.eks[0]` sites #1772 found, and they
# survived `provision_eks = false` only by accident: with zero `kubernetes_*`/`helm_*` resources
# or data sources in the root, tofu prunes an unused provider config and never evaluates its
# body. Add ONE such resource — even at `count = 0`, and `scripts/check-templates-plan-safe.sh`
# explicitly permits an offline `data "helm_template"` — and the "Invalid index … module.eks is
# empty tuple" plan crash comes straight back, in the one file with no test able to see it.
#
# The condition PROBES THE MODULE INSTANCE and is not a copy of `var.provision_eks`, which is what
# these lines carried until #3509. Both forms fix #1772; only the probe fixes #3351, where the
# variable is TRUE and the instance is absent from state, so a copied predicate walks straight into
# the empty tuple under `tofu plan -refresh-only`.
#
# A PROBE, not a bare `try()`: try() swallows every evaluation error, not just the empty-tuple one,
# so a future rename of `eks_cluster_endpoint` would silently point the provider at the fallback
# instead of failing loudly. Repeating the traversal outside the try() keeps a rename a validation
# error. Same reasoning, and the same shape, as `rds.tf`'s node-security-group guard, where the
# whole rule is argued. A provider block cannot take a `count`, but it takes an expression fine.
# `""` rather than `null`: the kubernetes provider rejects a null host as a type error.
#
# NOTE ON COVERAGE — these two lines are the one part of #1772 no test can see. Because the root
# declares zero `kubernetes_*`/`helm_*` resources, tofu prunes the unused provider config and
# never evaluates this body, so reverting this guard leaves the suite green. Measured with a
# throwaway `count = 0` kubernetes_namespace in the root: the UNGUARDED form then fails
# `a_clusterless_project_plans` with "Invalid index … module.eks is empty tuple" on these very
# lines, and the guarded form passes the cluster-less runs. (That probe also reds the
# `provision_eks = true` runs, because a mocked EKS endpoint is not a valid host — an artifact of
# the probe, not of this guard.) Do NOT "fix" the coverage gap with `mock_provider "kubernetes"`:
# a mock replaces the configuration wholesale so the body is never evaluated, which HIDES this
# bug class rather than catching it.
provider "kubernetes" {
  host                   = try(module.eks[0].eks_cluster_endpoint, null) != null ? module.eks[0].eks_cluster_endpoint : ""
  cluster_ca_certificate = try(module.eks[0].eks_cluster_certificate_authority_data, null) != null ? base64decode(module.eks[0].eks_cluster_certificate_authority_data) : ""
}

provider "helm" {
  kubernetes {
    host                   = try(module.eks[0].eks_cluster_endpoint, null) != null ? module.eks[0].eks_cluster_endpoint : ""
    cluster_ca_certificate = try(module.eks[0].eks_cluster_certificate_authority_data, null) != null ? base64decode(module.eks[0].eks_cluster_certificate_authority_data) : ""
  }
}

data "aws_caller_identity" "current" {}
