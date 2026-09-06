# Memorystore for Valkey — the second cache engine.
#
# The canvas has offered redis|valkey on GCP the whole time and the provider read neither, so picking
# Valkey silently provisioned Redis (#1420). Valkey is not a flag on `google_redis_instance`: it is
# `google_memorystore_instance`, a cluster-shaped product sized by shards. Hence a second module and a
# second toggle, mutually exclusive with the Redis one.

module "memorystore_valkey" {
  source = "./modules/memorystore-valkey"
  count  = var.create_memorystore_valkey ? 1 : 0

  depends_on = [module.vpc_network]

  project_id   = var.project_id
  region       = local.gcp_region_key
  environment  = var.environment
  project_name = var.project_name

  engine_version = var.memorystore_valkey_engine_version
  node_type      = var.memorystore_valkey_node_type
  shard_count    = var.memorystore_valkey_shard_count
  replica_count  = var.memorystore_valkey_replica_count

  network_self_link = try(module.vpc_network[0].network_self_link, null) != null ? module.vpc_network[0].network_self_link : var.network_id

  labels = local.gcp_default_labels
}
