# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

################################################################################
# The subnet plan
#
# Hoisted out of the module block so the derivation is a PURE function of var.vpc_cidr and can be
# asserted directly by `tofu test` (assert can read `local.`, and a module's arguments are not
# reachable from a test). See checks_network_subnet_plan.tftest.hcl.
################################################################################

locals {
  # ── Why the private subnets are 1/16 of the VPC ────────────────────────────────────────────────
  #
  # Under the AWS VPC CNI in its default (non prefix-delegation) mode EVERY POD TAKES A REAL
  # ADDRESS OUT OF THE NODE'S SUBNET. A node's appetite is therefore not "one IP" but
  # `max ENIs × IPv4 per ENI`, all of it drawn from the private subnet the node sits in, and the
  # CNI pre-allocates a whole spare ENI's worth ahead of demand (WARM_ENI_TARGET=1 by default), so
  # a node reaches a large fraction of its ceiling long before it is full.
  #
  #   instance type            ENIs × IPv4/ENI   addresses taken from the subnet, per node
  #   ----------------------   ---------------   -----------------------------------------
  #   m5a.4xlarge (the default
  #     of var.eks_instance_types)   8 × 30                240   (max pods 8×(30−1)+2 = 234)
  #   t3.large (the e2e floor)       3 × 12                 36   (max pods 3×(12−1)+2 =  35)
  #
  # AWS also reserves 5 addresses in every subnet, so usable = size − 5.
  #
  # This used to be `cidrsubnet(vpc, 10, {0,4,8})` — a /26 on a /16, 64 addresses, 59 usable. That
  # is smaller than ONE default node's ENI allocation, and it is what broke the aws nightly
  # (#1919): on a single t3.large the ArgoCD pods were handed 10.0.1.10 … 10.0.1.56 out of
  # 10.0.1.0/26 and the seventh got
  #   `plugin type="aws-cni" … failed (add): add cmd: failed to assign an IP address to container`.
  # The sizing was also inverted — the pod-bearing private subnets were a /26 while the database
  # subnets, which hold a handful of ENIs, were a /24.
  #
  # 1/16 of the VPC = a /20 on a /16 = 4096 addresses, 4091 usable:
  #   4091 / 240 ≈ 17 default m5a.4xlarge nodes per AZ  (≈ 51 across the three AZs, ~4 000 pods)
  #   4091 /  36 ≈ 113 t3.large nodes per AZ
  # A /24 (251 usable) — the widest that fits between the OLD netnums without moving the public
  # subnets — holds exactly ONE default node and is therefore not a fix, so the private subnets
  # move up into free space instead. Public and database keep their existing CIDRs BYTE-FOR-BYTE
  # (see the map below); only the private subnets are re-addressed.
  #
  # This also brings AWS into line with the other clouds, which already give the workload subnet a
  # /20: azure/modules/vnet (`cidrsubnet(vnet, 20 - prefix, 0..3)`) and alibaba/modules/network.
  # GCP and Hetzner are structurally exempt — GKE pods come from a SECONDARY alias range and the
  # Hetzner cluster runs an overlay `pod_cidr`, so neither draws pod IPs from the node subnet.
  #
  # ── The map, and the proof that nothing overlaps ───────────────────────────────────────────────
  #
  # Every subnet is written as a half-open interval in units of 1/1024 of the VPC. Expressed that
  # way the layout is a property of the (newbits, netnum) pairs ALONE, so non-overlap holds for any
  # vpc_cidr prefix length, not just /16 — an overlap here is silent and unrecoverable, so it is
  # proven rather than eyeballed. (checks_network_subnet_plan.tftest.hcl re-proves it in address
  # arithmetic on a real /16.)
  #
  #   list             cidrsubnet          span (VPC/1024)              on 10.0.0.0/16
  #   ---------------  ------------------  ---------------------------  --------------------------
  #   public   0,1,2   newbits 10, nn 12/16/20   [12,13) [16,17) [20,21)   10.0.3.0/26  .4.0/26  .5.0/26
  #   database 0,1,2   newbits  8, nn 24/25/26   [96,100)[100,104)[104,108) 10.0.24.0/24 .25.0/24 .26.0/24
  #   private  0,1,2   newbits  4, nn  2/ 3/ 4   [128,192)[192,256)[256,320) 10.0.32.0/20 .48.0/20 .64.0/20
  #   private  (was)   newbits 10, nn  0/ 4/ 8   [0,1)  [4,5)  [8,9)        10.0.0.0/26  .1.0/26  .2.0/26
  #
  #   max(public) = 21 < 96 = min(database);  max(database) = 108 < 128 = min(private).
  #   The three groups are pairwise disjoint. Free for future use: [0,12) (the vacated private
  #   footprint), [13,16), [17,20), [21,96), [108,128) and [320,1024).
  #
  # The PUBLIC subnets are deliberately left alone. They hold the NAT gateway(s) — one address
  # each — and any internet-facing ELB, which takes up to 8 addresses per subnet as it scales; 59
  # usable covers that with room. Widening them would replace the NAT gateways, changing the
  # Elastic IPs that customers put in third-party egress allow-lists, for no benefit.

  # `cidrsubnet` raises a hard function error on anything that is not a CIDR, and vpc_cidr is
  # legitimately "" when the customer brings their own VPC. Keep the derivation TOTAL by falling
  # back to the documented default shape — nothing consumes it when provision_vpc is false, and
  # terraform_data.vpc_cidr_carvable_guard (checks_network.tf) is what actually reports the bad
  # input, with a message an operator can act on instead of a raw cidrsubnet crash.
  vpc_cidr_prefix_length = can(cidrhost(var.vpc_cidr, 0)) ? tonumber(split("/", var.vpc_cidr)[1]) : 0

  # A VPC smaller than /18 cannot carry this plan: the public subnets are 1/1024 of the VPC, and
  # AWS's smallest subnet is a /28, so 1024 × 2^-28-relative → vpc prefix + 10 ≤ 28. Beyond /22 the
  # `cidrsubnet(vpc, 10, …)` call does not even evaluate (it would need a 33+ bit prefix).
  # Database needs prefix ≤ 20 and private prefix ≤ 24, so the public subnets are the binding
  # constraint at 18. At the floor the private subnets are still a /22 = 1024 addresses.
  vpc_cidr_is_carvable = local.vpc_cidr_prefix_length >= 8 && local.vpc_cidr_prefix_length <= 18

  vpc_cidr_for_subnet_plan = local.vpc_cidr_is_carvable ? var.vpc_cidr : "10.0.0.0/16"

  # The single declaration of the plan. Every CIDR below, and the disjointness guard in
  # checks_network.tf, is derived from THIS map — so an edit to a netnum cannot move a subnet
  # without also moving the span the guard checks.
  vpc_subnet_plan = {
    private  = { newbits = 4, netnums = [2, 3, 4] }
    public   = { newbits = 10, netnums = [12, 16, 20] }
    database = { newbits = 8, netnums = [24, 25, 26] }
  }

  vpc_private_subnet_cidrs  = [for nn in local.vpc_subnet_plan.private.netnums : cidrsubnet(local.vpc_cidr_for_subnet_plan, local.vpc_subnet_plan.private.newbits, nn)]
  vpc_public_subnet_cidrs   = [for nn in local.vpc_subnet_plan.public.netnums : cidrsubnet(local.vpc_cidr_for_subnet_plan, local.vpc_subnet_plan.public.newbits, nn)]
  vpc_database_subnet_cidrs = [for nn in local.vpc_subnet_plan.database.netnums : cidrsubnet(local.vpc_cidr_for_subnet_plan, local.vpc_subnet_plan.database.newbits, nn)]

  # The same plan as half-open intervals in units of 1/1024 of the VPC — the form in which
  # non-overlap is a property of the (newbits, netnum) pairs alone and therefore holds for EVERY
  # vpc_cidr prefix length. Every newbits here is ≤ 10, so each span is a whole number of units.
  vpc_subnet_plan_spans = flatten([
    for group, spec in local.vpc_subnet_plan : [
      for nn in spec.netnums : {
        name  = "${group}[${index(spec.netnums, nn)}]"
        start = nn * pow(2, 10 - spec.newbits)
        end   = (nn + 1) * pow(2, 10 - spec.newbits)
      }
    ]
  ])
}

module "common_vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 5.5.1"
  count   = var.provision_vpc ? 1 : 0

  name = local.vpc_name
  cidr = var.vpc_cidr
  # Exactly three AZs, derived statically from the region (a/b/c). The subnet lists below are
  # hardcoded to three, so the AZ count MUST be three — and the module's NAT/subnet `count`s are
  # `length(azs)`, which must be known at PLAN time. Sourcing azs from
  # `data.aws_availability_zones` (see local.azs) — that data source is unknown at plan under the
  # runner's assume-role provider, which broke `tofu plan -out` (the T2 aws nightly, #551).
  azs                    = local.azs
  enable_dns_hostnames   = true
  enable_dns_support     = true
  enable_ipv6            = false
  enable_nat_gateway     = true
  single_nat_gateway     = var.vpc_single_nat_gateway
  one_nat_gateway_per_az = !var.vpc_single_nat_gateway

  ## Subnets — derived above, in local.vpc_*_subnet_cidrs, where the budget is argued and tested.
  private_subnets                                 = local.vpc_private_subnet_cidrs
  public_subnets                                  = local.vpc_public_subnet_cidrs
  database_subnets                                = local.vpc_database_subnet_cidrs
  database_subnet_assign_ipv6_address_on_creation = false
  map_public_ip_on_launch                         = false

  public_subnet_tags = {
    "kubernetes.io/role/elb"                  = 1
    "kubernetes.io/cluster/${local.eks_name}" = "shared"
  }

  private_subnet_tags = {
    "kubernetes.io/role/internal-elb"         = 1
    "kubernetes.io/cluster/${local.eks_name}" = "shared"
  }

  create_database_subnet_route_table = true

  tags = local.aws_default_tags

}

resource "aws_vpc_endpoint" "s3_gateway" {
  count = var.provision_vpc ? 1 : 0

  vpc_id            = try(module.common_vpc[0].vpc_id, null) != null ? module.common_vpc[0].vpc_id : var.vpc_id
  service_name      = "com.amazonaws.${var.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = try(module.common_vpc[0].private_route_table_ids, null) != null ? module.common_vpc[0].private_route_table_ids : var.vpc_private_route_table_ids
  tags              = merge(local.aws_default_tags, { Name = "${local.vpc_s3_endpoint_name}" })
}