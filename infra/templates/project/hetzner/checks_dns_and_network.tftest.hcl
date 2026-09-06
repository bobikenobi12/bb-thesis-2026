# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Proof that the canvas's DNS and network switches actually MOVE the Hetzner plan (#1816) — and
# the first *.tftest.hcl this cloud has ever had, so `Infra - Project Templates` stops printing
# "no *.tftest.hcl for hetzner — skipping" and starts running something.
#
# WHY A TEST AND NOT A GREEN GUARD. check-offer-parity proves the switch reaches a tfvar and that
# some resource argument reads that name. It cannot prove the argument implements the feature the
# canvas label promises, and it cannot tell a switch that works from one hardcoded ON — both read
# identically. So every assertion below is PAIRED: the same fact is asserted with the switch on
# and with it off, and the two answers must differ. A test that only asserted the enabled case
# would pass against a template that ignored the variable entirely.
#
# Providers are mocked and nothing is created, so this needs no credentials and runs on any PR.

mock_provider "hcloud" {
  # The existing-network path derives the ENTIRE topology from this range — the node subnet, every
  # server's private IP, the firewall's intra-cluster rules and Cilium's native-routing CIDR. A
  # generated mock string would make `cidrsubnet()` fail at plan, and, more importantly, a range
  # that happened to equal var.network_cidr would let the brownfield assertions below pass for a
  # template that still read the variable. 10.20/16 is deliberately NOT the 10.0/16 default.
  #
  # Only `ip_range` is defaulted: `id` is a CONFIGURABLE argument on this data source, and tofu
  # refuses to mock a field the configuration sets ("overriding configuration values is not
  # allowed") — which is right, and means the id assertions below read the real wiring.
  mock_data "hcloud_network" {
    defaults = {
      ip_range = "10.20.0.0/16"
    }
  }

  # hcloud types every resource's `id` as a STRING and then takes it back as a NUMBER wherever one
  # resource references another (`network_id`, `firewall_ids`, `public_net.ipv4`). tofu converts —
  # and a generated mock id ("72oy3AZL") is not convertible, so the plan fails on the mock rather
  # than on anything under test. Pin numeric-looking ids for every id that is referenced onward.
  mock_resource "hcloud_network" {
    defaults = { id = "4141" }
  }
  mock_resource "hcloud_firewall" {
    defaults = { id = "4142" }
  }
  mock_resource "hcloud_primary_ip" {
    defaults = { id = "4143" }
  }
}

mock_provider "talos" {}
mock_provider "imager" {}
mock_provider "minio" {}

# `helm` is deliberately NOT mocked. checks_data.tf / csi.tf assert real properties of the rendered
# manifests (the CSI driver, the default StorageClass, HCLOUD_VOLUME_EXTRA_LABELS). Mocking it hands
# those guards empty strings and they fail on every run — for the mock, not for the template.
#
# THAT TRADE HAS A PRICE, AND IT IS NOT "offline". This comment used to call `data "helm_template"`
# an offline renderer. "Offline" is true of the CLUSTER — these render with no kubeconfig and
# resolve at plan time, which is what cilium.tf and csi.tf mean by it — and false of the NETWORK.
# Three of them (cilium.tf:40, cilium.tf:111, csi.tf:38) carry
# `repository = "https://charts.hetzner.cloud"` or `https://helm.cilium.io`, a data source is
# evaluated at plan, and so every `tofu test` on this cloud fetches an index.yaml and a chart
# tarball live from a third party. hetzner is the ONLY cloud that does this: no other project
# template declares a `helm_template` at all (aws/main.tf and gcp/main.tf only mention one in
# prose). That is exactly the distribution of the flake it causes.
#
# On 2026-08-28 a TCP reset from charts.hetzner.cloud failed `check (hetzner)` on the staging→main
# promotion PR #3117, reading as a template defect while the same commit passed on every other
# cloud. `.github/workflows/infra-templates.yml` now retries a network-shaped failure and refuses
# to call it a test failure; a genuine assertion failure still fails on the first attempt, and the
# shapes it will retry are in scripts/ci/chart-fetch-network-errors.txt, shared with the add-on
# chart render check so the two cannot drift apart on what counts as a flake.
#
# Making these renders hermetic is #2489 — and NOT #2754, which this note used to name. #2754 is
# the same class on a different job (the add-on chart render check) and was closed by a PR that
# only ever touched this one, so for a while the tree routed a reader to a closed issue for the
# durable fix. Nothing about the trade above changes; only where to go next.

variables {
  project_name = "acme"
  environment  = "dev"
  region       = "fsn1"
  # The mocked providers do not expose images. Keep these network-focused plans on the
  # pre-cache path; cache behavior is covered by the dedicated shell self-test and static guard.
  talos_image_cache = "disabled"
}

################################################################################
# network:provision_network
################################################################################

# The default, and the shape every Hetzner cluster already in the field has: Alethia owns the
# network. Half of a pair — on its own it would also pass for a template that ignored the switch.
run "network_is_created_when_provision_network_is_true" {
  command = plan

  variables {
    provision_network = true
  }

  assert {
    condition     = length(hcloud_network.this) == 1
    error_message = "provision_network = true must plan exactly one hcloud_network, got ${length(hcloud_network.this)}."
  }

  assert {
    condition     = length(data.hcloud_network.existing) == 0
    error_message = "provision_network = true must not read an existing network."
  }

  # The topology comes from the variable on this path.
  assert {
    condition     = local.network_ip_range == "10.0.0.0/16"
    error_message = "Greenfield must route var.network_cidr, got ${local.network_ip_range}."
  }

  assert {
    condition     = hcloud_network_subnet.nodes.ip_range == "10.0.0.0/24"
    error_message = "The node subnet must be carved from var.network_cidr, got ${hcloud_network_subnet.nodes.ip_range}."
  }
}

# The other half. The distinguishing assertion is not "a data source appeared" — it is that the
# subnet, and therefore every private IP and firewall rule, is now carved out of the EXISTING
# network's 10.20/16 while var.network_cidr is still 10.0/16. A template that merely counted the
# network resource to zero and kept deriving from the variable would fail here.
run "existing_network_is_attached_when_provision_network_is_false" {
  command = plan

  variables {
    provision_network = false
    network_id        = "4242"
    # Cilium native routing requires pods and services to sit inside the network that actually
    # resolved. On this path that is the mocked 10.20/16, not var.network_cidr.
    pod_cidr     = "10.20.128.0/17"
    service_cidr = "10.20.96.0/19"
  }

  assert {
    condition     = length(hcloud_network.this) == 0
    error_message = "provision_network = false must create NO network; it planned ${length(hcloud_network.this)}."
  }

  assert {
    condition     = length(data.hcloud_network.existing) == 1
    error_message = "provision_network = false must resolve the existing network."
  }

  assert {
    condition     = local.network_ip_range == "10.20.0.0/16"
    error_message = "Brownfield must route the EXISTING network's ip_range, got ${local.network_ip_range} (var.network_cidr is 10.0.0.0/16 — reading the variable here is the bug)."
  }

  assert {
    condition     = hcloud_network_subnet.nodes.ip_range == "10.20.0.0/24"
    error_message = "The node subnet must be carved from the existing network's range, got ${hcloud_network_subnet.nodes.ip_range}."
  }

  # A numeric network_id is handed to the data source's `id`, not its `name`.
  assert {
    condition     = local.existing_network_is_id
    error_message = "A numeric network_id must resolve by id."
  }
}

# A name rather than an id must resolve too — the field is free text in the console and hcloud's
# data source accepts either, on different arguments.
run "an_existing_network_named_by_name_resolves_by_name" {
  command = plan

  variables {
    provision_network = false
    network_id        = "shared-prod-net"
    pod_cidr          = "10.20.128.0/17"
    service_cidr      = "10.20.96.0/19"
  }

  assert {
    condition     = !local.existing_network_is_id
    error_message = "A non-numeric network_id must resolve by name, not be coerced to a number."
  }

  assert {
    condition     = local.network_ip_range == "10.20.0.0/16"
    error_message = "A network named by name must still route its own ip_range, got ${local.network_ip_range}."
  }
}

# The fail-closed half. `check` blocks only warn, so without the precondition this would build a
# cluster whose datapath is derived from an unresolvable network.
run "an_existing_network_with_no_id_blocks_the_plan" {
  command = plan

  variables {
    provision_network = false
    network_id        = ""
    # Consistent with the resolved range, so the ONLY thing that can fail here is the missing id.
    # Leaving the 10.0/16 defaults would also trip the CIDR-topology check and the failure being
    # asserted would be ambiguous.
    pod_cidr     = "10.20.128.0/17"
    service_cidr = "10.20.96.0/19"
  }

  expect_failures = [
    check.existing_network_id_present,
    terraform_data.byo_network_guard,
  ]
}

# THE RUN THAT MATCHES WHAT THE PRODUCT ACTUALLY SENDS, and the one this file was missing.
#
# Every brownfield run above hands over pod_cidr and service_cidr by hand. Nothing in the product
# does: the canvas hides the CIDR field when you attach an existing network, and the Go provider
# leaves both unset on that path precisely because `network_cidr` is not the network in use. So the
# real request arrives with neither, and the template has to derive them from the range that
# resolved. It used to derive them from var.network_cidr instead, which meant the ONE case a user
# could actually produce was the one that hit the fail-closed guard below.
run "a_brownfield_plan_with_no_cidrs_derives_them_from_the_resolved_network" {
  command = plan

  variables {
    provision_network = false
    network_id        = "4242"
    # Deliberately absent: pod_cidr and service_cidr. var.network_cidr stays 10.0.0.0/16 and the
    # mocked existing network is 10.20.0.0/16, so anything derived from the variable lands outside.
  }

  assert {
    condition     = local.pod_cidr == "10.20.128.0/17"
    error_message = "The pod CIDR must be derived from the RESOLVED network (10.20.0.0/16), got ${local.pod_cidr} — deriving from var.network_cidr is the bug."
  }

  assert {
    condition     = local.service_cidr == "10.20.96.0/19"
    error_message = "The service CIDR must be derived from the RESOLVED network, got ${local.service_cidr}."
  }

  # The invariants the guard exists to protect, now satisfied by construction rather than by luck.
  assert {
    condition     = local.pods_services_in_super && local.cidrs_distinct
    error_message = "Derived pod/service CIDRs must sit inside the resolved network and stay disjoint from the node subnet (${hcloud_network_subnet.nodes.ip_range})."
  }

  # And they really reach the cluster, not just the locals: this is the patch Talos is handed, and
  # Cilium's native-routing CIDR is set from the same local.
  assert {
    condition     = local.cluster_patch.cluster.network.podSubnets[0] == "10.20.128.0/17"
    error_message = "Talos must be configured with the derived pod subnet, got ${jsonencode(local.cluster_patch.cluster.network.podSubnets)}."
  }

  assert {
    condition     = local.cluster_patch.cluster.network.serviceSubnets[0] == "10.20.96.0/19"
    error_message = "Talos must be configured with the derived service subnet, got ${jsonencode(local.cluster_patch.cluster.network.serviceSubnets)}."
  }
}

# The greenfield path keeps deriving from network_cidr, because there the network IS the one we are
# about to create. Asserted so the brownfield fix cannot quietly change what an existing cluster
# plans — these are the values every Hetzner cluster built so far already has.
run "a_greenfield_plan_with_no_cidrs_keeps_the_network_cidr_split" {
  command = plan

  variables {
    provision_network = true
    network_cidr      = "10.0.0.0/16"
  }

  assert {
    condition     = local.pod_cidr == "10.0.128.0/17" && local.service_cidr == "10.0.96.0/19"
    error_message = "Greenfield must keep the network_cidr split every existing cluster has: got ${local.pod_cidr} / ${local.service_cidr}."
  }
}

# The second, quieter half of the same gate. A resolvable network whose range does not contain the
# pod/service CIDRs produces a cluster that comes up Ready and then fails the datapath — the exact
# outcome recorded on a real hel1 provision.
#
# Reaching it now takes an EXPLICIT out-of-range override, which is the point of the derivation
# above: the guard went from catching the ordinary case to catching the deliberate one.
run "an_existing_network_that_does_not_contain_the_pod_cidrs_blocks_the_plan" {
  command = plan

  variables {
    provision_network = false
    network_id        = "4242"
    # Explicitly named, inside var.network_cidr and outside the existing network's 10.20/16.
    pod_cidr     = "10.0.128.0/17"
    service_cidr = "10.0.96.0/19"
  }

  expect_failures = [
    check.pods_services_within_network,
    terraform_data.byo_network_guard,
  ]
}

################################################################################
# dns:enabled
################################################################################

# OFF is the default and must build nothing. Stated first because it is the state every existing
# Hetzner project is in, and a regression here would create a zone nobody asked for.
run "no_dns_zone_when_dns_is_off" {
  command = plan

  variables {
    cloud_dns_enabled = false
    dns_main_domain   = "example.com"
  }

  assert {
    condition     = length(hcloud_zone.this) == 0
    error_message = "DNS off must plan no hcloud_zone, got ${length(hcloud_zone.this)}."
  }
}

# ON creates the zone. Before #1816 a DNS component on Hetzner built nothing at all, so this is
# the assertion the whole cell rests on — and it pins the ARGUMENTS, not just the count, because
# a zone with the wrong name or mode is a different feature than the one the canvas promises.
run "dns_zone_is_created_when_dns_is_on" {
  command = plan

  variables {
    cloud_dns_enabled = true
    # A trailing dot is legal in the canvas and illegal in hcloud's zone name.
    dns_main_domain = "example.com."
    dns_zone_ttl    = 1800
  }

  assert {
    condition     = length(hcloud_zone.this) == 1
    error_message = "DNS on must plan exactly one hcloud_zone, got ${length(hcloud_zone.this)}."
  }

  assert {
    condition     = hcloud_zone.this[0].name == "example.com"
    error_message = "The zone name must be the apex domain with any trailing dot trimmed, got ${hcloud_zone.this[0].name}."
  }

  assert {
    condition     = hcloud_zone.this[0].mode == "primary"
    error_message = "Alethia owns the zone it creates, so it must be primary, got ${hcloud_zone.this[0].mode}."
  }

  assert {
    condition     = hcloud_zone.this[0].ttl == 1800
    error_message = "dns_zone_ttl must reach the zone, got ${hcloud_zone.this[0].ttl}."
  }
}

# A project that delegates DNS to a pluggable connector must NOT also get a native zone — the
# same `dns_provider == "native"` gate the other four clouds apply.
run "no_native_zone_when_dns_is_delegated_to_a_connector" {
  command = plan

  variables {
    cloud_dns_enabled = true
    dns_main_domain   = "example.com"
    dns_provider      = "cloudflare"
  }

  assert {
    condition     = length(hcloud_zone.this) == 0
    error_message = "A pluggable DNS provider must suppress the native zone, got ${length(hcloud_zone.this)}."
  }
}

# Fail-closed: an empty domain is a 4xx from the Hetzner API DEEP inside apply, after the network,
# the servers and the Talos bootstrap already exist.
run "dns_on_without_a_domain_blocks_the_plan" {
  command = plan

  variables {
    cloud_dns_enabled = true
    dns_main_domain   = ""
  }

  expect_failures = [
    check.dns_domain_present_when_enabled,
    terraform_data.dns_zone_guard,
  ]
}
