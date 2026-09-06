# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

# ---------------------------------------------------------------------------
# Talos image build (in-Terraform, via the Talos Image Factory), with a
# PERSISTENT PER-PROJECT SNAPSHOT CACHE (#3027).
#
# 1. Look for an already-built snapshot in this Hetzner project that matches the
#    exact image identity (see `talos_image_cache_key` below). A hit skips 2–4
#    entirely.
# 2. On a miss: create a schematic that bakes in the qemu-guest-agent extension
#    (needed on Hetzner so the VM reports its status / can be gracefully shut
#    down).
# 3. Ask the factory for the hcloud disk-image (raw.xz) URL per architecture.
# 4. Upload that raw.xz into Hetzner and snapshot it with the imager provider —
#    the resulting snapshot id is what the servers boot from — and stamp it with
#    the cache labels so the NEXT apply is a hit.
# ---------------------------------------------------------------------------

# ═══════════════════════════════════════════════════════════════════════════════════════════════
# THE CACHE — what it is keyed on, why it is never swept, and how it is invalidated.
# ═══════════════════════════════════════════════════════════════════════════════════════════════
#
# ── WHY. `imager_image` boots a rescue server, writes the Talos raw.xz into it and snapshots the
# disk, before any cluster exists. A successful build takes ~5m; it has blown a tofu `create`
# deadline twice — #2458 (2026-08-24) and the scheduled floor run 33080748841 (2026-08-27) — both
# with `failed to create snapshot: context deadline exceeded: remaining running actions: [...]`.
# "Remaining running actions" is Hetzner still working when the provider gave up: a deadline, not a
# rejection. Two blowouts against a ~5m median is not a thin tail, and losing this step loses the
# WHOLE run because nothing else has been built yet. #3028 raised the deadline to 25m, which buys
# time and removes nothing — a genuinely stuck build now burns 25m before failing.
#
# The snapshot is a PURE FUNCTION of its identity below. Nothing about it varies per cluster. It was
# rebuilt from scratch every apply only because `description` and the `cluster` label carried the
# cluster name, which made every run's image unique to that run. Caching it removes the 5–15m AND
# the flake from every Hetzner apply — the harness's and a customer's alike.
#
# ── THE IDENTITY (the cache key). FOUR dimensions, not the three #3027 names:
#
#   talos_version   the Talos release the factory builds
#   architecture    x86 / arm — different bytes, must never be interchanged
#   location        where the snapshot lives
#   schematic       WHICH EXTENSIONS ARE BAKED IN
#
# The fourth is the one it is dangerous to omit. The snapshot's content is (version × extensions),
# not version alone: adding, removing or renaming an entry in `talos_image_extensions` produces a
# DIFFERENT image at the same Talos version, and a cache keyed on version alone would serve the old
# bytes forever with nothing saying so. It is keyed on a hash of the REQUESTED extension list — a
# static configuration value — and deliberately NOT on the resolved `talos_image_factory_schematic`
# id, which is known-after-apply and therefore cannot appear in a `count`.
#
# ── WHY THE CACHE ENTRY IS UN-SWEEPABLE, AND HOW THAT IS KEPT SAFE. The hcloud account the nightly
# runs in is SHARED WITH PROD. `scripts/e2e/hcloud-cleanup.sh` guarantees a run cleans up after
# itself by deleting EVERY resource labelled `cluster=<name>` — images included, by name, in its own
# comment. So a cached snapshot must be deliberately invisible to that sweep, and it is made so by
# CONSTRUCTION rather than by an exception: a cache entry carries no `cluster` label at all, so no
# per-run selector can match it. Nothing was weakened to allow this — the sweeper still deletes
# everything it ever deleted.
#
# The mirror-image risk is that an un-swept resource is an un-noticed one. Three things close it:
#   · `scripts/e2e/hcloud-image-cache.sh` lists and prunes the cache, explicitly and on demand;
#   · `scripts/check-hetzner-image-cache.mjs` fails CI if this file's label and the two scripts'
#     skip/selector constants ever stop being the same string (the emitter-mirroring rule);
#   · `hcloud-cleanup.sh` REPORTS the cache entries it is skipping, by name, on every sweep — an
#     unswept type nobody mentions is indistinguishable from a swept one.
#
# ── INVALIDATION AND RETENTION — a decision, recorded here because it is not obvious.
#
# Cached snapshots are RETAINED INDEFINITELY and are never deleted automatically, by anything.
# A Talos version bump leaves the old image standing on purpose. Reasons, in order:
#
#   1. It costs about EUR 0.02/month per image (~1 GB of snapshot at EUR 0.0119/GB/month) against
#      5–15 minutes of critical-path wall clock per apply, on every Hetzner run of the parity
#      programme. Retention is a choice, not a cost problem.
#   2. Rolling `talos_version` BACK is an ordinary debugging move. An automatic sweep would make
#      every rollback pay the rebuild — and the rebuild is the flake.
#   3. An automatic, time-based delete in an account shared with prod is the exact blast-radius
#      shape this repo has been burned by. There is no cron, no TTL and no "older than N days"
#      rule anywhere in the sweep path.
#
# Reclaiming is therefore a deliberate, human-invoked operation:
#
#     scripts/e2e/hcloud-image-cache.sh                                  # list, read-only
#     scripts/e2e/hcloud-image-cache.sh --prune-superseded --yes-delete  # duplicates only
#     scripts/e2e/hcloud-image-cache.sh --prune-version v1.12.4 --yes-delete
#
# And a poisoned entry is invalidated WITHOUT deleting anything, by `talos_image_cache = "refresh"`:
# it rebuilds and stamps a newer entry, which wins the `most_recent` lookup from that apply onward.
# `talos_image_cache = "disabled"` restores the pre-#3027 behaviour exactly — a per-cluster image,
# `cluster`-labelled, reclaimed by the run's own teardown.
# ═══════════════════════════════════════════════════════════════════════════════════════════════

locals {
  # ── The single source of truth for the cache label. `scripts/e2e/hcloud-cleanup.sh` and
  #    `scripts/e2e/hcloud-image-cache.sh` carry the same string, and
  #    `scripts/check-hetzner-image-cache.mjs` fails CI when the three stop agreeing. Do not inline
  #    it anywhere below; the guard matches THIS assignment.
  talos_image_cache_label_key   = "alethia.io/cache"
  talos_image_cache_label_value = "talos-image"

  # The extension set REQUESTED from the Image Factory, and the third dimension of the cache key.
  # Feeds BOTH the extensions lookup below and the key, so the two can never describe different
  # images. Add an extension here and every cached entry is superseded, automatically.
  talos_image_extensions = ["siderolabs/qemu-guest-agent"]

  # sha256 is 64 hex chars; an hcloud label VALUE caps at 63. 32 hex chars is 128 bits — far more
  # than enough to separate a handful of extension sets, and it stays inside the grammar.
  talos_schematic_key = substr(sha256(jsonencode(local.talos_image_extensions)), 0, 32)

  # Hetzner snapshot architecture names are "arm" / "x86" (not arm64 / amd64). One mapping, used by
  # the resource, the label and the lookup filter alike.
  talos_hcloud_arch = {
    arm64 = "arm"
    amd64 = "x86"
  }

  # "enabled" (default) · "refresh" · "disabled" — see variables.tf.
  #   enabled   look the cache up; a hit skips the build; a miss builds AND stamps a cache entry.
  #   refresh   skip the lookup, always build, stamp a NEWER cache entry (the invalidation lever).
  #   disabled  skip the lookup, always build, stamp NO cache entry — pre-#3027 behaviour, and the
  #             only mode in which the image is `cluster`-labelled and swept by the run's teardown.
  talos_image_cache_lookup = var.talos_image_cache == "enabled"
  talos_image_cache_stamp  = var.talos_image_cache != "disabled"

  # The identity labels a cache entry carries. NOTE what is absent: `local.default_labels`, and with
  # it the `cluster` label the teardown sweep scopes on. That absence is the whole mechanism — see
  # the header. A cache entry belongs to the PROJECT, not to a cluster, so no cluster owns it and no
  # per-run selector can reach it.
  talos_image_cache_labels = {
    (local.talos_image_cache_label_key) = local.talos_image_cache_label_value
    "alethia.io/talos-version"          = var.talos_version
    "alethia.io/talos-location"         = var.region
    "alethia.io/talos-schematic"        = local.talos_schematic_key
    os                                  = "talos"
  }

  # Per-architecture labels + the matching selector. Built from ONE map so a selector can never ask
  # for a dimension the stamp does not write (which would be a cache that never hits) nor omit one
  # the stamp does write (which would be a cache that hits on the WRONG image).
  talos_image_cache_dims = {
    for arch, hcloud_arch in local.talos_hcloud_arch :
    arch => merge(local.talos_image_cache_labels, { "alethia.io/talos-arch" = hcloud_arch })
  }

  talos_image_cache_selector = {
    for arch, labels in local.talos_image_cache_dims :
    # `k==v` pairs, comma-separated = AND (Hetzner label-selector grammar). `sort(keys(...))` keeps
    # the string stable across plans so it never shows as a spurious diff.
    arch => join(",", [for k in sort(keys(labels)) : "${k}==${labels[k]}"])
  }

  # The label grammar hcloud enforces server-side, mirrored here so a bad value fails at PLAN with a
  # sentence naming the dimension, rather than at apply with an opaque 400 from the API.
  # (hcloud-go hcloud/labels.go valueRegexp: <=63 chars, alphanumeric at both ends.)
  talos_image_cache_bad_values = {
    for arch, labels in local.talos_image_cache_dims :
    arch => [for k, v in labels : "${k}=${v}" if !can(regex("^[a-zA-Z0-9]([-_.a-zA-Z0-9]{0,61}[a-zA-Z0-9])?$", v))]
  }
}

# ── THE LOOKUP, and the reason it is `hcloud_images` (PLURAL) rather than the `hcloud_image` #3027
#    names. This is the "an error reported as ABSENCE defeats the guard" line, and the two data
#    sources sit on opposite sides of it:
#
#   `data "hcloud_image"` (singular) resolves a zero-match selector through hcloudutil.GetOne, which
#   returns `diag.NewErrorDiagnostic("Resource not found", …)`. A cache MISS — the ordinary,
#   expected, first-ever-run state — would fail the plan. It cannot drive a `count` at all.
#
#   `data "hcloud_images"` (plural) calls `client.Image.AllWithOpts` and, on ANY api error (401 on a
#   rotated token, 429 on a throttle, a 5xx, an unparseable response), appends
#   `hcloudutil.APIErrorDiagnostics(err)` and RETURNS. It reaches an empty `images` list on exactly
#   one path: the API answered, successfully, with nothing. So for this data source
#
#       empty  ⟺  "Hetzner says there is no such image"
#       error  ⟺  "I could not tell"
#
#   and they are different outcomes rather than the same empty list. That is the property the whole
#   cache rests on: a blip cannot silently become a rebuild, because a blip is a failed plan.
#
# `with_status = ["available"]` keeps a snapshot that is still `creating`, or that failed, from ever
# being treated as a hit. (The provider exposes `status` as a FILTER only — it is not a field on the
# returned image — so this filter is the only place that distinction can be made, and the
# precondition below cannot re-assert it.)
data "hcloud_images" "talos_cache" {
  for_each = local.talos_image_cache_lookup ? {
    for arch, needed in { arm64 = local.need_arm64, amd64 = local.need_amd64 } : arch => arch if needed
  } : {}

  with_selector     = local.talos_image_cache_selector[each.key]
  with_architecture = [local.talos_hcloud_arch[each.key]]
  with_status       = ["available"]
  # created:desc — so images[0] is the newest matching entry. Two runs that raced the same miss both
  # stamp an entry; the newer one wins from then on and the older is what
  # `hcloud-image-cache.sh --prune-superseded` exists to reclaim.
  most_recent = true
}

# ── THE POSITIVE CONTROL. The paragraph above is a claim about the provider's source; this is the
#    measurement that holds even if that claim stops being true.
#
# An unfiltered image listing in ANY Hetzner project returns the public system images (debian-*,
# ubuntu-*, …). It is never legitimately empty. So "the cache selector matched nothing AND the
# unfiltered listing also matched nothing" is not a cache miss — it is a lookup that could not see,
# and the precondition below refuses to rebuild on it rather than quietly paying for a rebuild (or,
# worse, letting a future provider change turn every miss into a silent one).
#
# It runs only when the lookup runs: `disabled`/`refresh` ask the cache nothing, so there is nothing
# to be trustworthy about, and an operator who has disabled the cache must not be blocked by it.
data "hcloud_images" "cache_lookup_probe" {
  count       = local.talos_image_cache_lookup ? 1 : 0
  with_status = ["available"]
}

locals {
  talos_cache_matches = {
    for arch in keys(local.talos_hcloud_arch) :
    arch => contains(keys(data.hcloud_images.talos_cache), arch) ? data.hcloud_images.talos_cache[arch].images : []
  }

  talos_image_cache_hit = {
    for arch, matches in local.talos_cache_matches : arch => length(matches) > 0
  }

  # The chosen entry per architecture (newest first, `most_recent`), or null.
  talos_cache_image = {
    for arch, matches in local.talos_cache_matches : arch => length(matches) > 0 ? matches[0] : null
  }

  # Did the lookup run at all, and could it see anything? Both are needed by the precondition: a
  # lookup that never ran cannot be untrustworthy.
  talos_cache_lookup_ran = local.talos_image_cache_lookup && (local.need_arm64 || local.need_amd64)
  # Written as a CONDITIONAL, not `local.talos_image_cache_lookup && …[0]…`: Terraform's conditional
  # evaluates only the selected branch, and `&&` gives no such guarantee — so the `&&` form can
  # index a zero-length list when the lookup is off. Same reason the `contains(keys(…))` guard above
  # is a conditional rather than a boolean AND.
  talos_cache_probe_saw_none = length(data.hcloud_images.cache_lookup_probe) > 0 ? length(data.hcloud_images.cache_lookup_probe[0].images) == 0 : false

  # An architecture is BUILT when it is needed and the cache did not answer for it.
  talos_image_build = {
    for arch, needed in { arm64 = local.need_arm64, amd64 = local.need_amd64 } :
    arch => needed && !local.talos_image_cache_hit[arch]
  }
}

# Pin the exact qemu-guest-agent extension ref for the requested Talos version. `filters.names` is
# `local.talos_image_extensions` — the same list the cache key hashes, so a change to the requested
# set moves the key and supersedes every cached entry in one edit.
data "talos_image_factory_extensions_versions" "this" {
  talos_version = var.talos_version
  filters = {
    names = local.talos_image_extensions
  }
}

resource "talos_image_factory_schematic" "this" {
  schematic = yamlencode({
    customization = {
      systemExtensions = {
        officialExtensions = data.talos_image_factory_extensions_versions.this.extensions_info.*.name
      }
    }
  })
}

# Factory URLs for the hcloud platform, one per architecture we actually BUILD. Gated on the build
# decision rather than on `need_*`: a cache hit should not cost a factory round-trip either.
data "talos_image_factory_urls" "arm64" {
  count         = local.talos_image_build.arm64 ? 1 : 0
  talos_version = var.talos_version
  schematic_id  = talos_image_factory_schematic.this.id
  platform      = "hcloud"
  architecture  = "arm64"
}

data "talos_image_factory_urls" "amd64" {
  count         = local.talos_image_build.amd64 ? 1 : 0
  talos_version = var.talos_version
  schematic_id  = talos_image_factory_schematic.this.id
  platform      = "hcloud"
  architecture  = "amd64"
}

# ── `timeouts` on the image build, because its default is not generous enough. ──
#
# THIS IS A DEADLINE, NOT A FIX — the fix is the cache above, and these numbers are what a MISS
# still costs. They stay: a miss is a real, first-of-its-kind build with the same flaky tail it
# always had, it is now rare rather than universal, and shrinking the deadline because misses are
# rarer would make each one likelier to die.
#
# It DID start biting at 15m, so the deploy-wait is the number that moved with it: `t2_providers.go`
# holds hetzner's deploy-wait at 40m, because 25m of image plus a cluster that needs ~8m does not
# fit in 25m of wait, and raising one alone only moves where the run dies. These two numbers are
# never changed independently.
#
# `delete` is bounded too: the provider tears its own rescue server down, and an unbounded delete on
# the failure path is how the scaffolding gets left behind billing (#2463).
#
# ── `lifecycle.ignore_changes = [labels, description]`, and why it is load-bearing. ──
#
# An EXISTING cluster provisioned before #3027 holds an `imager_image` in state whose labels carry
# `cluster=<name>` and whose description carries the cluster name. Without this, that cluster's very
# next apply would see both arguments change — and if the imager provider cannot update a snapshot's
# labels in place, that is a REPLACEMENT: the flaky 5–15m rebuild, on every existing cluster, caused
# by the change that exists to remove it. Ignoring them means an old image keeps its old labels (so
# it stays the per-cluster image it always was, swept as before) while every NEW build is stamped as
# a cache entry at creation. The cache fills by natural turnover instead of by a migration.
#
# One consequence, stated because it is a DELETE and deletes deserve to be written down: once some
# other cluster in the same project has stamped a cache entry, an existing pre-#3027 cluster's next
# apply is a cache HIT, its `count` drops to 0, and tofu removes that cluster's own per-cluster
# snapshot. Nothing reboots — `hcloud_server` carries `ignore_changes = [image]` (servers.tf) and
# Talos has long since installed itself to disk — and the snapshot being removed is by then dead
# weight superseded by the cache entry. It is a reclaim, not a loss.
resource "imager_image" "arm64" {
  count        = local.talos_image_build.arm64 ? 1 : 0
  image_url    = one(data.talos_image_factory_urls.arm64[*].urls).disk_image
  architecture = "arm"
  location     = var.region
  description = local.talos_image_cache_stamp ? (
    "alethia-talos-${var.talos_version}-arm64-${local.talos_schematic_key}"
  ) : "${local.cluster_name}-talos-${var.talos_version}-arm64"
  # A cache entry carries the identity labels and NO `cluster` label — that absence is what makes it
  # un-sweepable. `disabled` restores the pre-#3027 labels exactly, including `cluster`.
  labels = local.talos_image_cache_stamp ? local.talos_image_cache_dims.arm64 : merge(local.default_labels, { os = "talos" })

  timeouts {
    create = "25m"
    delete = "10m"
  }

  lifecycle {
    ignore_changes = [labels, description]
  }
}

resource "imager_image" "amd64" {
  count        = local.talos_image_build.amd64 ? 1 : 0
  image_url    = one(data.talos_image_factory_urls.amd64[*].urls).disk_image
  architecture = "x86"
  location     = var.region
  description = local.talos_image_cache_stamp ? (
    "alethia-talos-${var.talos_version}-amd64-${local.talos_schematic_key}"
  ) : "${local.cluster_name}-talos-${var.talos_version}-amd64"
  labels = local.talos_image_cache_stamp ? local.talos_image_cache_dims.amd64 : merge(local.default_labels, { os = "talos" })

  timeouts {
    create = "25m"
    delete = "10m"
  }

  lifecycle {
    ignore_changes = [labels, description]
  }
}

locals {
  # A cache HIT resolves to the snapshot id Hetzner reported; a miss, to the one just built.
  # `tostring` because the data source exposes the id as a number and `hcloud_server.image` is a
  # string — an untyped concat here would fail late, on the server rather than on the image.
  image_id_arm64 = local.need_arm64 ? (
    local.talos_image_cache_hit.arm64 ? tostring(local.talos_cache_image.arm64.id) : one(imager_image.arm64[*].image_id)
  ) : ""
  image_id_amd64 = local.need_amd64 ? (
    local.talos_image_cache_hit.amd64 ? tostring(local.talos_cache_image.amd64.id) : one(imager_image.amd64[*].image_id)
  ) : ""
}

# ── THE GATE. `check` blocks WARN; these must FAIL, so they are preconditions.
#
# A `check` block's failed assertion is a warning that a runner log buries, and the two conditions
# below are the ones that must never be shrugged off: reusing the wrong bytes, and treating a lookup
# that could not see as a lookup that saw nothing. Both are evaluated at PLAN — the data sources
# above are read at plan, so nothing has been created, and nothing has been paid for, when this
# refuses.
resource "terraform_data" "talos_image_cache" {
  # Tracked so the gate re-plans (and therefore re-evaluates) whenever any cache fact moves.
  input = jsonencode({
    mode      = var.talos_image_cache
    selectors = local.talos_image_cache_selector
    hits      = local.talos_image_cache_hit
    builds    = local.talos_image_build
  })

  lifecycle {
    # 1. "ABSENT" MUST NOT BE "COULD NOT TELL". If the cache selector matched nothing AND an
    #    unfiltered listing of the same project also matched nothing, the lookup did not see an
    #    empty cache — it did not see. Refuse, loudly, rather than pay for a rebuild on a lie (or
    #    let a future provider change convert every blip into a silent full rebuild).
    precondition {
      condition = !local.talos_cache_lookup_ran || !local.talos_cache_probe_saw_none
      error_message = join(" ", [
        "The Talos image-cache lookup could not see this Hetzner project: an UNFILTERED image listing",
        "returned zero images, which never happens for a project that can read the public system images.",
        "So a cache miss here is not evidence that no cached snapshot exists — it is evidence that the",
        "lookup did not answer, and rebuilding on it would be a 5-15m build (and its deadline flake)",
        "bought with a wrong belief. Check HCLOUD_TOKEN's validity and scope. To proceed anyway, and",
        "accept an unconditional rebuild, set talos_image_cache = \"disabled\".",
      ])
    }

    # 2. A HIT MUST BE THE IMAGE WE ASKED FOR. The selector is Hetzner's answer; this is ours. Every
    #    key/value the stamp writes is re-asserted against the labels the chosen image actually
    #    carries, plus its architecture — so a selector that silently stopped filtering (a provider
    #    change, an API change, a typo that made the join produce a weaker string) fails here
    #    instead of booting a cluster from an arm64 snapshot, or from last year's Talos.
    #
    #    `status` is deliberately absent: the provider exposes it as a filter only, never as a field
    #    on the returned image, so `with_status = ["available"]` on the lookup is the only place that
    #    can be asserted and this precondition must not pretend otherwise.
    precondition {
      #    Written as a comprehension over `slice(matches, 0, min(1, length(matches)))` rather than
      #    as `hit ? …check… : true`: the inner loop then runs ZERO times on a miss, so there is no
      #    null to dereference and no reliance on the conditional operator declining to evaluate the
      #    untaken branch. That reliance is cheap to avoid and the CI note in infra-templates.yml
      #    records that `tofu test` runs hetzner on a DIFFERENT engine (1.9.4) from the one that
      #    plans it — evaluation semantics are not something to assume across two of them.
      condition = alltrue(flatten([
        for arch, matches in local.talos_cache_matches : [
          for img in slice(matches, 0, min(1, length(matches))) : (
            alltrue([for k, v in local.talos_image_cache_dims[arch] : lookup(img.labels, k, null) == v])
            && img.architecture == local.talos_hcloud_arch[arch]
          )
        ]
      ]))
      error_message = join(" ", [
        "A cached Talos snapshot was returned that does NOT carry every label the cache key asks for,",
        "or whose architecture disagrees with the one requested. The selector and the stamp have come",
        "apart, and booting a cluster from this image would run the wrong Talos version, the wrong",
        "extension set, or the wrong CPU architecture. Refusing. Inspect the account with",
        "`scripts/e2e/hcloud-image-cache.sh`, and rebuild with talos_image_cache = \"refresh\".",
      ])
    }

    # 3. EVERY CACHE LABEL VALUE IS ONE HCLOUD WILL ACCEPT. hcloud caps a label value at 63
    #    characters and requires alphanumeric ends. A `talos_version` or `region` that breaks the
    #    grammar would otherwise surface as an opaque 400 from the snapshot call, at the END of a
    #    build that has already been paid for.
    precondition {
      condition = alltrue([for arch, bad in local.talos_image_cache_bad_values : length(bad) == 0])
      error_message = join(" ", [
        "A Talos image-cache label value is outside the grammar hcloud accepts (max 63 characters,",
        "alphanumeric at both ends, dashes/underscores/dots between). Offending pairs:",
        jsonencode(local.talos_image_cache_bad_values),
      ])
    }

    # 4. EVERY NEEDED ARCHITECTURE RESOLVED TO AN ID. Cheap, and it is what turns a future refactor
    #    of the hit/build branches from a cluster that boots off `image = ""` into a failed plan.
    precondition {
      condition     = (!local.need_arm64 || local.image_id_arm64 != "") && (!local.need_amd64 || local.image_id_amd64 != "")
      error_message = "A required Talos snapshot id resolved to an empty string — neither a cache hit nor a build produced an image for an architecture this cluster needs."
    }
  }
}
