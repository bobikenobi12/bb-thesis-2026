# Cluster-admin grants — DOCUMENTED EXCLUSION (#2005), by this template's own invariants, not by
# GCP. The provider has two in-template mechanisms (`google_project_iam_member` with
# `roles/container.clusterAdmin`; `kubernetes_cluster_role_binding` — hashicorp/kubernetes is in
# the lockfile), and an earlier CUSTOMIZABILITY-PARITY line that called the binding "granted
# outside the template via IAM" as if the cloud forced it was wrong to. Both paths are refused by
# NAMED invariants instead: project IAM needs resourcemanager.projects.setIamPolicy, the
# owner-equivalent permission #300 deliberately stripped from the provisioner (the two #722
# bindings that tried 403'd on every apply — see app-db-identity.tf's ADOPTION note); and an
# in-tofu kubernetes_* resource breaks the runner's `tofu plan -out` path, which
# scripts/check-templates-plan-safe.sh gates (the provider below is wired from this cluster's own
# known-after-apply endpoint). So GKE cluster-admin grants live where the adopted service accounts
# already live — the customer's own IAM (connector bootstrap) or the runner's post-apply path. If
# either invariant moves, this exclusion goes stale loudly rather than silently.
module "gke" {
  source = "./modules/gke"
  count  = var.provision_gke ? 1 : 0

  # The IAM binding is a HARD dependency, not an ordering preference: GKE performs the envelope
  # encryption as its own service agent, and a cluster create against a key it cannot yet use fails
  # outright. Without this, whether the cluster comes up depends on which resource tofu happens to
  # finish first (#2004).
  depends_on = [module.vpc_network, google_kms_crypto_key_iam_member.gke_secrets]

  secrets_kms_key_id = local.gke_secrets_encryption ? one(google_kms_crypto_key.gke_secrets[*].id) : ""

  project_id  = var.project_id
  region      = var.region
  environment = var.environment

  cluster_name     = local.gke_name
  node_pool_name   = local.gke_node_pool_name
  cluster_version  = var.gke_cluster_version
  enable_autopilot = var.gke_enable_autopilot

  network_name          = try(module.vpc_network[0].network_name, null) != null ? module.vpc_network[0].network_name : one(data.google_compute_network.existing[*].name)
  subnet_name           = try(module.vpc_network[0].private_subnet_name, null) != null ? module.vpc_network[0].private_subnet_name : one(data.google_compute_subnetwork.existing[*].name)
  pod_ip_range_name     = try(module.vpc_network[0].pod_ip_range_name, null) != null ? module.vpc_network[0].pod_ip_range_name : local.existing_pods_range_name
  service_ip_range_name = try(module.vpc_network[0].service_ip_range_name, null) != null ? module.vpc_network[0].service_ip_range_name : local.existing_services_range_name

  machine_types     = var.gke_instance_types
  node_min_size     = var.gke_node_min_size
  node_max_size     = var.gke_node_max_size
  node_desired_size = var.gke_node_desired_size
  disk_size_gb      = var.gke_disk_size_gb
  disk_type         = var.gke_disk_type

  # Boot-disk performance (aws parity: eks_volume_iops). Both null by default; the module renders no
  # `boot_disk` block at all in that case, so the default plan is unchanged.
  volume_iops       = var.gke_volume_iops
  volume_throughput = var.gke_volume_throughput

  # Interruptible capacity (aws parity: eks_ng_capacity_type). gke_spot and gke_preemptible were
  # BOTH declared and read by nothing before this line — gke_spot at `default = true`, so the
  # template claimed Spot for every node pool it has ever built. Its default is flipped to false in
  # the same commit (variables.tf) precisely so that wiring it changes nothing that already exists.
  spot        = var.gke_spot
  preemptible = var.gke_preemptible

  master_authorized_cidr_blocks = var.gke_master_authorized_cidr_blocks

  labels = local.gcp_default_labels
}
