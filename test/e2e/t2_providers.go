// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// T2 provider table — the de-hetznerized configuration seam for the real-cloud
// provisioning proof (BYOC A0.1). t2_provision_test.go is build-tagged `e2e_t2`; this
// file is deliberately UNTAGGED (like controlplane.go / argocd_assert.go) so:
//
//   - `go mod tidy` sees its dependencies and the untagged unit test compiles it, and
//   - the credential-detection / region-default / timeout-default / REQUIRE-decision /
//     CLUSTER_JSON-merge logic can be exercised by t2_providers_test.go WITHOUT a
//     cloud, a token, or the e2e_t2 tag.
//
// Each provider row declares which credential env vars must be present, a sane cheap
// default region, and per-provider default timeouts (managed control planes boot far
// slower than a Talos VM, so aws/gcp/azure/alibaba get longer cluster-ready + overall
// waits than hetzner). Env overrides always win over the row defaults so a slow account
// or a non-default region can be tuned from the workflow without a code change.
//
// Nothing here imports `testing`; the tagged test and the unit test drive it.
package e2e

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sort"
	"strings"
	"time"
)

// t2Provider is one row of the T2 provider table: everything the real-cloud proof needs
// to target a given cloud that is NOT the deploy spine itself (which reads the provider
// straight off the config snapshot).
type t2Provider struct {
	// name is the canonical provider key (matches infra/templates/project/<name> and the
	// snapshot `provider`).
	name string
	// defaultRegion is a cheap, generally-available region/zone used when neither
	// ALETHIA_E2E_REGION nor (for hetzner) the legacy ALETHIA_E2E_HCLOUD_REGION is set.
	defaultRegion string
	// clusterReadyTimeout is the runner's reachability-gate bound, passed verbatim as the
	// ALETHIA_CLUSTER_READY_TIMEOUT env string. A real managed control plane is much
	// slower to expose a reachable API than a Talos VM, hence the per-provider default.
	// Stored as a string (not time.Duration) so the hetzner default is bit-identical
	// ("8m", never "8m0s") to the value the current hard-coded path passes.
	clusterReadyTimeout string
	// waitTimeout bounds the test-side WaitTerminal poll for the job to go terminal
	// (image build + apply + spine + argo on real infra).
	waitTimeout time.Duration
	// teardownTimeout bounds the in-process t.Cleanup destroy. It is NOT part of the test
	// body's ctx — teardown runs after the body returns — but it IS inside the go-test
	// process deadline, which is why ResolveT2Budget reserves it in GoTimeout rather than
	// in Ctx.
	//
	// It was a flat 15m for every cloud, which is HETZNER's number: hetzner tears its 18
	// resources down in seconds, while aws/byo run 32909287152 passed every assertion and
	// was still recorded FAIL because an EKS cluster's NAT-gateway/VPC dependency chain had
	// an internet gateway `Still destroying... [13m30s elapsed]` when the ceiling hit (#2729).
	//
	// ── What this window has to be BIG ENOUGH FOR, which is not "a destroy that works". ──
	//
	// A window that expires does not merely leave resources behind — it takes the DIAGNOSIS with
	// it. terraform-exec cancels with SIGINT (packages/core/tofu: cmd.Cancel = Signal(os.Interrupt)),
	// so the only thing the teardown can report is `tofu destroy failed: signal: interrupt`, which
	// names no resource, no dependency and no cloud error. The destroy's OWN verdict — the named
	// `DependencyViolation` that says which ENI is still attached — is one the harness can only
	// receive by outliving the provider's per-resource delete ceilings.
	//
	// aws/floor run 33155063965 is the measurement. The window was 30m and it was spent, to the
	// second, like this:
	//
	//	  ~9m20s  workdir prep + `tofu init` + state pull + refresh of 130 resources + plan render
	//	 20m40s  the destroy apply, still running when the ctx cancelled:
	//	           eks_managed_node_group  destroyed after  8m11s
	//	           eks_cluster             destroyed after  4m1s
	//	           internet_gateway        Still destroying... 19m50s  (started ~50s into the apply)
	//	           subnet.public[0..2]     Still destroying... 17m0s   (started ~3m40s into it)
	//
	// The internet gateway and the subnets were inside the AWS provider's own 20m delete ceiling,
	// so the destroy was roughly THREE MINUTES from returning a named error of its own. 30m is
	// therefore not "nearly enough" — it is the one length that guarantees the least useful
	// outcome. 45m clears the observed ~33m-to-verdict with the same order of margin the other
	// rungs carry, and costs nothing on a destroy that finishes: this is a ceiling, not a dwell.
	teardownTimeout time.Duration
	// credsPresent reports whether this provider's credentials are wired into the
	// environment, and (when not) a human message naming exactly what to set. It is a
	// closure so each cloud's distinct credential shape (ambient AWS keys vs a GCP
	// key-file path vs the three ARM_* vars vs alibaba's key-or-OIDC pair) is expressed
	// directly. It reads os.Getenv, so unit tests drive it with t.Setenv.
	credsPresent func() (ok bool, missingMsg string)
}

// t2ProviderTable is the source of truth for which clouds the T2 proof can target and
// how each is configured. Adding a cloud to the nightly is: add a row here + wire its
// secret + region into e2e-nightly.yml (per-cloud waves A1–A3). hetzner is the only row
// the nightly runs today.
var t2ProviderTable = map[string]t2Provider{
	// Talos on cheap Hetzner Cloud VMs — the fastest-BOOTING target. HCLOUD_TOKEN is the single
	// API token the hcloud/imager/talos providers authenticate from — for everything EXCEPT
	// Object Storage; see hetznerS3CredEnv.
	//
	// ── Why 40m and not the 25m this row carried until now. ──
	//
	// The boot is fast; the IMAGE BUILD in front of it is not, and it is the widest term in a
	// hetzner deploy. `imager_image` boots a rescue server, writes the Talos raw.xz into it and
	// snapshots the disk before any cluster exists (infra/templates/project/hetzner/image.tf).
	// Successful builds take ~5m, but the snapshot step is FLAKY AT ITS DEADLINE and has now blown
	// past a 15m tofu timeout twice — #2458 on 2026-08-24, and the scheduled floor run
	// 33080748841 on 2026-08-27, both with `failed to create snapshot: context deadline exceeded:
	// remaining running actions`. "Remaining running actions" is Hetzner still working when the
	// provider gave up.
	//
	// image.tf's create timeout goes to 25m in the same change, and this number has to CONTAIN it:
	// 25m image + ~8m cluster does not fit in 25m of deploy-wait, so raising one without the other
	// would just move where the run dies — which is exactly what image.tf's own comment warned
	// about ("if this ever starts biting at 15m, the deploy-wait is the number to revisit").
	//
	// This is a deadline change, not a fix. The durable fix landed separately as #3027: image.tf now
	// CACHES the snapshot per (talos_version × architecture × location × extension set), so a hit
	// skips the build entirely and the common case is a Hetzner deploy with no image build in front
	// of it at all.
	//
	// ── AND THIS NUMBER DOES NOT MOVE BECAUSE OF IT. ──
	//
	// The cache makes a build RARE; it does not make one FASTER. A miss — the first run on a new
	// talos_version, a new region, a changed extension set, or a project whose cache was pruned —
	// still pays the same 5–25m with the same flaky tail, and it is exactly the run that has no
	// prior evidence to lean on. Shrinking the wait because misses are rarer would make each
	// surviving miss likelier to die, on the one resource whose loss costs the whole run. So 40m
	// stays coupled to image.tf's 25m `create`, unchanged, for the same reason it was raised.
	"hetzner": {
		name:                "hetzner",
		defaultRegion:       "nbg1",
		clusterReadyTimeout: "8m",
		waitTimeout:         40 * time.Minute,
		teardownTimeout:     15 * time.Minute,
		credsPresent:        hetznerCredsPresent,
	},
	// AWS EKS. The workflow runs aws-actions/configure-aws-credentials (OIDC or static
	// keys) and sets ALETHIA_E2E_AWS_READY=1 to signal "creds are configured"; we
	// additionally sanity-check that at least one concrete credential handle
	// (AWS_ACCESS_KEY_ID or AWS_ROLE_ARN) is actually in the environment, so a missing
	// configure-step doesn't slip through as a green skip.
	"aws": {
		name: "aws",
		// us-east-1: the `alethia-e2e-nightly` role is region-LOCKED here (infra/aws-oidc
		// `e2e_region`), and eu-central-1/eu-west-1 are prod regions the role explicitly
		// forbids — so a default of anything but us-east-1 makes every AWS call AccessDenied.
		// The workflow also exports ALETHIA_E2E_REGION=us-east-1 for the nightly; this is the
		// local-run fallback.
		defaultRegion:       "us-east-1",
		clusterReadyTimeout: "15m",
		waitTimeout:         50 * time.Minute,
		teardownTimeout:     45 * time.Minute,
		credsPresent: func() (bool, string) {
			ready := t2Truthy(os.Getenv("ALETHIA_E2E_AWS_READY"))
			hasHandle := os.Getenv("AWS_ACCESS_KEY_ID") != "" || os.Getenv("AWS_ROLE_ARN") != ""
			return ready && hasHandle,
				"AWS credentials are not configured — set ALETHIA_E2E_AWS_READY=1 (after aws-actions/configure-aws-credentials) and ensure AWS_ACCESS_KEY_ID or AWS_ROLE_ARN is present"
		},
	},
	// GCP GKE. The gcloud/terraform providers read a service-account key file whose path
	// is GOOGLE_APPLICATION_CREDENTIALS. Region is a ZONAL location (europe-west3-a) so a
	// zonal GKE cluster + Cloud SQL are the cheapest shape.
	"gcp": {
		name:                "gcp",
		defaultRegion:       "europe-west3-a",
		clusterReadyTimeout: "15m",
		waitTimeout:         50 * time.Minute,
		teardownTimeout:     45 * time.Minute,
		credsPresent: func() (bool, string) {
			return t2AllEnvPresent([]string{"GOOGLE_APPLICATION_CREDENTIALS"}),
				"GOOGLE_APPLICATION_CREDENTIALS is unset (path to the GCP service-account key file)"
		},
	},
	// Azure AKS. The azurerm provider authenticates from the ARM_* service-principal /
	// federated-identity triple.
	"azure": {
		name: "azure",
		// westeurope, NOT germanywestcentral — the region cannot host the product's data services.
		//
		// The first azure full bar (32836351919) failed on two of them at once, and both are the
		// region rather than our configuration. Measured with `az`, per region:
		//
		//   az postgres flexible-server list-skus -l <region>  →  supportedServerVersions
		//     westeurope 8 · northeurope 8 · germanywestcentral 0 · eastus 0
		//
		// An empty supported-version list is exactly what the apply reported —
		// `ParameterOutOfRange: The value of the 'Version' should be in: []` — so no Postgres
		// version could ever have been correct there. Azure Managed Redis failed in the same run
		// with `InsufficientCapacity: retry using a different size or region`, which is the same
		// story told by a different service.
		//
		// A floor run never noticed because the floor provisions no database and no cache; only
		// the full bar reaches them. westeurope carries the same 10 vCPU regional quota (0 in use),
		// so nothing else about the shape changes.
		defaultRegion:       "westeurope",
		clusterReadyTimeout: "15m",
		waitTimeout:         50 * time.Minute,
		teardownTimeout:     45 * time.Minute,
		credsPresent: func() (bool, string) {
			return t2AllEnvPresent([]string{"ARM_CLIENT_ID", "ARM_TENANT_ID", "ARM_SUBSCRIPTION_ID"}),
				"Azure credentials are incomplete — set ARM_CLIENT_ID, ARM_TENANT_ID and ARM_SUBSCRIPTION_ID"
		},
	},
	// Alibaba Cloud ACK. Either a static AccessKey (ALICLOUD_ACCESS_KEY) OR the keyless
	// OIDC/RAM-role pair (ALICLOUD_OIDC_TOKEN_FILE + ALICLOUD_ROLE_ARN) satisfies it.
	"alibaba": {
		name:                "alibaba",
		defaultRegion:       "eu-central-1",
		clusterReadyTimeout: "15m",
		waitTimeout:         50 * time.Minute,
		teardownTimeout:     45 * time.Minute,
		credsPresent: func() (bool, string) {
			static := os.Getenv("ALICLOUD_ACCESS_KEY") != ""
			oidc := os.Getenv("ALICLOUD_OIDC_TOKEN_FILE") != "" && os.Getenv("ALICLOUD_ROLE_ARN") != ""
			return static || oidc,
				"Alibaba credentials are unset — set ALICLOUD_ACCESS_KEY, or the keyless pair ALICLOUD_OIDC_TOKEN_FILE + ALICLOUD_ROLE_ARN"
		},
	},
}

// hetznerS3CredEnv is the SECOND Hetzner credential pair — the one that is not the Cloud API token.
// Hetzner Object Storage is S3-compatible and has NO API to mint keys: the customer generates them by
// hand in the console, and the runner exports them under these names for the aminueza/minio provider
// (packages/core/cloud/hetzner_provider.go emits hetzner_s3_access_key / _secret_key from exactly
// these, and omits the tfvars entirely when they are absent).
var hetznerS3CredEnv = []string{"HETZNER_S3_ACCESS_KEY", "HETZNER_S3_SECRET_KEY"}

// hetznerCredsPresent is the hetzner row's credential gate, and it is DIMENSION-AWARE.
//
// The floor run needs HCLOUD_TOKEN and nothing else. A FULL-BAR run also provisions the `bucket`
// kind, which on Hetzner is a real Object Storage bucket driven through the minio provider — and
// that provider authenticates from a credential pair HCLOUD_TOKEN cannot stand in for. Nothing
// checked for it: the gate cleared on HCLOUD_TOKEN alone, the tfvars were silently omitted, and the
// leg died at the bucket after a full cluster had been provisioned. Pre-spend was available the
// whole time — this seam runs before anything is created.
//
// WHY THIS IS A HARD REQUIREMENT AND NOT A "SKIP THE BUCKET CELL" ESCAPE. The alternative shape was
// to let a full-bar run proceed without the keys and mark `bucket` unproven in the verdict. That
// re-creates the exact defect this whole surface was built to remove: a run that reports success
// while one of the eleven kinds was never proven, with the caveat living in a log line nobody reads
// a week later. The max-config table has no "unproven" verdict for a kind the cloud genuinely
// carries — CarriedByTofu means a real apply MUST leave the resource in state — so there is no
// honest place to record it. A missing prerequisite is a prerequisite failure: under
// ALETHIA_E2E_T2_REQUIRE (the nightly) this HARD-FAILS before any spend, and off CI it skips the
// whole run exactly as a missing HCLOUD_TOKEN already does. No path exists where a hetzner full bar
// reports green having never proven `bucket`.
func hetznerCredsPresent() (bool, string) {
	if !t2AllEnvPresent([]string{"HCLOUD_TOKEN"}) {
		return false, "HCLOUD_TOKEN is unset (the hetzner API token from repo secrets)"
	}
	// Only the max-config dimension seeds storage_buckets; a floor run emits an empty `buckets` list
	// and never exercises the minio provider, so requiring the pair there would gate the cheap
	// nightly on a credential it does not use.
	if MaxConfigEnabled() && !t2AllEnvPresent(hetznerS3CredEnv) {
		return false, "hetzner full-bar (ALETHIA_E2E_MAX_CONFIG=1) provisions the `bucket` kind through " +
			"Hetzner Object Storage, which authenticates from a SEPARATE key pair — set HETZNER_S3_ACCESS_KEY " +
			"and HETZNER_S3_SECRET_KEY (generated by hand in the Hetzner console; there is no API to mint them, " +
			"and HCLOUD_TOKEN does not work for S3). Without them the apply provisions a whole cluster and then " +
			"fails at the bucket, and the `bucket` kind cannot be proven — so this is refused BEFORE any spend."
	}
	return true, ""
}

// t2LookupProvider returns the provider row for name, or ok=false for an unknown
// provider (the caller HARD-FAILS — this replaces the old `provider != "hetzner"`
// fatal).
func t2LookupProvider(name string) (t2Provider, bool) {
	p, ok := t2ProviderTable[name]
	return p, ok
}

// t2ProviderNames lists the table's provider keys, sorted.
//
// Derived rather than hand-typed so a cloud cannot join the harness without joining everything
// keyed on the cloud list. TestA05FixtureExistsForEveryProvider is the first consumer: adding a
// sixth provider here now reds until its config-snapshot fixture is generated, instead of leaving
// A0.5 to fail at load time on a real, billable run.
func t2ProviderNames() []string {
	keys := make([]string, 0, len(t2ProviderTable))
	for k := range t2ProviderTable {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// t2SupportedProviders lists the table's provider keys (sorted) for error messages.
func t2SupportedProviders() string {
	return strings.Join(t2ProviderNames(), ", ")
}

// t2AllEnvPresent reports whether every named env var is non-empty (after trimming).
func t2AllEnvPresent(keys []string) bool {
	for _, k := range keys {
		if strings.TrimSpace(os.Getenv(k)) == "" {
			return false
		}
	}
	return true
}

// resolveT2Region resolves the target region/zone for a provider: the generalized
// ALETHIA_E2E_REGION wins, then (hetzner only, for back-compat) the legacy
// ALETHIA_E2E_HCLOUD_REGION, then the row default. The legacy name is intentionally NOT
// honored for the other clouds — only hetzner ever used it.
func resolveT2Region(p t2Provider) string {
	if v := strings.TrimSpace(os.Getenv("ALETHIA_E2E_REGION")); v != "" {
		return v
	}
	if p.name == "hetzner" {
		if v := strings.TrimSpace(os.Getenv("ALETHIA_E2E_HCLOUD_REGION")); v != "" {
			return v
		}
	}
	return p.defaultRegion
}

// resolveT2ClusterReadyTimeout is the runner's reachability-gate timeout string: the
// ALETHIA_CLUSTER_READY_TIMEOUT override when set, else the provider row default.
func resolveT2ClusterReadyTimeout(p t2Provider) string {
	if v := strings.TrimSpace(os.Getenv("ALETHIA_CLUSTER_READY_TIMEOUT")); v != "" {
		return v
	}
	return p.clusterReadyTimeout
}

// resolveT2WaitTimeout bounds how long the test waits for the job to finish: the
// ALETHIA_E2E_T2_WAIT override (a Go duration) when parseable, else the provider row
// default.
func resolveT2WaitTimeout(p t2Provider) time.Duration {
	if v := strings.TrimSpace(os.Getenv("ALETHIA_E2E_T2_WAIT")); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			return d
		}
	}
	return p.waitTimeout
}

// resolveT2TeardownTimeout bounds the in-process destroy for one provider, with an
// ALETHIA_E2E_T2_TEARDOWN override for a laptop run.
//
// ResolveT2Budget (which RESERVES the window in the process deadline) and the t.Cleanup that
// SPENDS it both call this, so the deadline can never reserve a different number than the
// destroy is actually given. Two sources for one quantity is how #2729 arose in the first place.
//
// There is deliberately no fallback for a zero value: a provider row that forgets the field
// would get an already-expired context and fail its destroy instantly, so
// TestT2ProviderTableTeardownBudgets fails the build instead — before any spend.
func resolveT2TeardownTimeout(p t2Provider) time.Duration {
	if v := strings.TrimSpace(os.Getenv("ALETHIA_E2E_T2_TEARDOWN")); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			return d
		}
	}
	return p.teardownTimeout
}

// t2RequireIsHard reports whether a missing prerequisite must HARD-FAIL rather than
// skip. The nightly sets ALETHIA_E2E_T2_REQUIRE=1 so a broken CI environment can never
// masquerade as a green skip; a dev laptop leaves it unset and skips cleanly.
func t2RequireIsHard() bool {
	return t2Truthy(os.Getenv("ALETHIA_E2E_T2_REQUIRE"))
}

// t2MergeClusterJSON merges ALETHIA_E2E_CLUSTER_JSON — a JSON object — into the seeded
// config snapshot's `cluster` block (ProjectClusterConfig: instance_types,
// node_desired_size, node_disk_size_gb, provider_config.enable_karpenter, …) so each
// cloud's workflow can pin its cheapest node shape WITHOUT editing template defaults.
// Absent/blank env ⇒ no-op (the template defaults stand). Malformed JSON, or JSON that
// is not an object, ⇒ a LOUD error (never silently ignored) so a typo in the workflow
// fails the run instead of quietly provisioning the wrong shape.
func t2MergeClusterJSON(snapshot map[string]any) error {
	raw := strings.TrimSpace(os.Getenv("ALETHIA_E2E_CLUSTER_JSON"))
	if raw == "" {
		return nil
	}
	var overrides map[string]any
	if err := json.Unmarshal([]byte(raw), &overrides); err != nil {
		return fmt.Errorf("ALETHIA_E2E_CLUSTER_JSON must be a JSON object: %w", err)
	}
	cluster, _ := snapshot["cluster"].(map[string]any)
	if cluster == nil {
		cluster = map[string]any{}
	}
	for k, v := range overrides {
		cluster[k] = v
	}
	snapshot["cluster"] = cluster
	return nil
}

// t2MergeNetworkJSON merges ALETHIA_E2E_NETWORK_JSON — a JSON object — into the seeded
// config snapshot's `network` block (ProjectNetworkConfig: single_nat_gateway, …), the
// sibling of t2MergeClusterJSON for network-tier knobs the `cluster` block can't carry.
// AWS uses it to fold `single_nat_gateway:true` into the FULL snapshot only (one NAT vs
// one-per-AZ ≈ halves the run's NAT cost) without editing the template default or the
// A0.5 fidelity base. Absent/blank env ⇒ no-op. Malformed / non-object JSON ⇒ a LOUD error
// (a workflow typo fails the run rather than silently provisioning the wrong network shape).
func t2MergeNetworkJSON(snapshot map[string]any) error {
	raw := strings.TrimSpace(os.Getenv("ALETHIA_E2E_NETWORK_JSON"))
	if raw == "" {
		return nil
	}
	var overrides map[string]any
	if err := json.Unmarshal([]byte(raw), &overrides); err != nil {
		return fmt.Errorf("ALETHIA_E2E_NETWORK_JSON must be a JSON object: %w", err)
	}
	network, _ := snapshot["network"].(map[string]any)
	if network == nil {
		network = map[string]any{}
	}
	for k, v := range overrides {
		network[k] = v
	}
	snapshot["network"] = network
	return nil
}

// t2MergeAzureAdminGroup wires the Entra admin-group OBJECT ID that authorizes the runner's
// short-lived AAD token on a FRESH AKS cluster at create time (BYOC A2.2 self-admin) into the
// snapshot's cluster.provider_config.aks_admin_group_object_ids — but ONLY for the azure provider
// and ONLY when ALETHIA_E2E_AZURE_ADMIN_GROUP_OBJECT_ID is set. AKS AAD-integrated RBAC renders
// only when the admin-group list is non-empty; on the managed default (empty) the runner's token
// 401s the new API server (the EKS/GKE "runner never authorized" gap, on Azure). The object id is
// environment-specific — it is the group the infra/azure-e2e stack outputs (with the e2e service
// principal as a member) — so it is supplied at RUNTIME here, never committed. azure_provider.go's
// resolveAKSAdminGroupObjectIDs maps this list through to the aks_admin_group_object_ids tfvar,
// unioned with any cluster_admins. Runs AFTER t2MergeClusterJSON so it APPENDS to (deduped, never
// clobbers) an object id already supplied via ALETHIA_E2E_CLUSTER_JSON. Absent env / non-azure ⇒
// no-op; a blank-after-trim value is ignored.
func t2MergeAzureAdminGroup(snapshot map[string]any, provider string) {
	if provider != "azure" {
		return
	}
	oid := strings.TrimSpace(os.Getenv("ALETHIA_E2E_AZURE_ADMIN_GROUP_OBJECT_ID"))
	if oid == "" {
		return
	}
	cluster, _ := snapshot["cluster"].(map[string]any)
	if cluster == nil {
		cluster = map[string]any{}
	}
	pc, _ := cluster["provider_config"].(map[string]any)
	if pc == nil {
		pc = map[string]any{}
	}
	existing, _ := pc["aks_admin_group_object_ids"].([]any)
	seen := map[string]struct{}{}
	out := make([]any, 0, len(existing)+1)
	for _, v := range existing {
		s, ok := v.(string)
		if !ok || s == "" {
			continue
		}
		if _, dup := seen[s]; dup {
			continue
		}
		seen[s] = struct{}{}
		out = append(out, s)
	}
	if _, dup := seen[oid]; !dup {
		out = append(out, oid)
	}
	pc["aks_admin_group_object_ids"] = out
	cluster["provider_config"] = pc
	snapshot["cluster"] = cluster
}

// t2ClusterKindPrefix maps a managed cloud to the resource-kind prefix its template's
// `locals.tf` stamps on the cluster name (`eks-…`/`gke-…`/`aks-…`). Talos/ACK are absent
// because they name the cluster bare `<project>-<env>` (no kind prefix) — see
// t2ValidateClusterName.
var t2ClusterKindPrefix = map[string]string{
	"aws":   "eks-",
	"gcp":   "gke-",
	"azure": "aks-",
}

// t2ValidateClusterName asserts the provider-reported `cluster_name` is the cluster THIS
// run provisioned (proving the post-apply spine ran AND that we are looking at our own,
// uniquely-named cluster — never a stale one). Naming differs per template `locals.tf`:
//
//   - hetzner / alibaba: exactly `<project>-<env>` (also the label the runner stamps).
//   - aws / gcp / azure: `<kind>-<regionShort>-<env>-<project>` (e.g.
//     `eks-ue1-<env>-<project>`). The region-short prefix is template-internal and NOT
//     uniqueness-bearing; replicating the 40-row region maps here would just drift from
//     the templates. So we assert the two parts that ARE meaningful and non-vacuous: the
//     resource-kind prefix (proves the right kind of cluster) AND the `-<env>-<project>`
//     suffix (env is `<run_id>-<attempt>`, globally unique per run — proves it is OUR
//     cluster). This is exact enough to fail a stale/misnamed cluster, without coupling
//     the harness to the region map.
func t2ValidateClusterName(provider, project, env, got string) error {
	if strings.TrimSpace(got) == "" {
		return fmt.Errorf("cluster_name is empty — the post-apply spine was SKIPPED")
	}
	if prefix, ok := t2ClusterKindPrefix[provider]; ok {
		suffix := "-" + env + "-" + project
		if !strings.HasPrefix(got, prefix) || !strings.HasSuffix(got, suffix) {
			return fmt.Errorf("cluster_name = %q, want %s<regionShort>%s (template locals.tf naming)", got, prefix, suffix)
		}
		return nil
	}
	// Talos (hetzner) + ACK (alibaba): bare `<project>-<env>`, an exact match.
	if want := project + "-" + env; got != want {
		return fmt.Errorf("cluster_name = %q, want %q", got, want)
	}
	return nil
}

// t2CostShapeRequired is the set of clouds whose TEMPLATE default node shape is expensive
// (or unverified) enough that a real e2e run MUST pin a cheapest-shape override rather than
// inherit it — e.g. AWS defaults to m5a.4xlarge×2 SPOT (16 vCPU each, ~$0.30/run) if
// ALETHIA_E2E_CLUSTER_JSON is absent. Hetzner is exempt: its default (cpx22 ×1) is a proven
// cents/run shape (see the HZ-DEFAULTS work). The nightly always injects a per-provider shape;
// this guard makes a missing one a HARD FAIL so a workflow typo or a bare local managed run can
// never silently burn large nodes.
var t2CostShapeRequired = map[string]bool{
	"aws":     true,
	"gcp":     true,
	"azure":   true,
	"alibaba": true,
}

// t2RequireCostShape enforces the cost-shape override for the expensive-default clouds: under
// ALETHIA_E2E_T2_REQUIRE (the nightly) a managed run with no ALETHIA_E2E_CLUSTER_JSON is a HARD
// FAIL. Off CI (REQUIRE unset) it only warns — a local dev spinning a managed cluster on their
// own account is trusted to size it, but is nudged. Returns (fatal bool, msg string).
func t2RequireCostShape(provider string) (fatal bool, msg string) {
	if !t2CostShapeRequired[provider] {
		return false, ""
	}
	if strings.TrimSpace(os.Getenv("ALETHIA_E2E_CLUSTER_JSON")) != "" {
		return false, ""
	}
	msg = fmt.Sprintf("provider %q has an expensive template default node shape but ALETHIA_E2E_CLUSTER_JSON is unset — refusing to provision the default (e.g. AWS m5a.4xlarge×2). Pin a cheapest shape (small instance ×1, single NAT, min disk).", provider)
	return t2RequireIsHard(), msg
}

// Heavy-surface node floor: the FULL surface (all 18 add-ons — 7 of them heavy: kube-prometheus-stack,
// loki, tempo, vault, harbor, minio, velero — plus the 11 kinds' controllers/CSI) will not schedule on
// the cheapest single small node. These are the minimums below which pods sit Pending and the run
// wastes ~20 min of apply before failing. Deliberately conservative — enough to fit the heavy set, not
// a production sizing. Sized against fixtures/cluster_json.heavy.aws.json.
//
// ⚠️ THESE NUMBERS LIVE HERE AND NOWHERE ELSE. .github/workflows/e2e-nightly.yml used to restate
// them in prose ("≥ 3 nodes / 12 vCPU / 48 GB") one line above the claim that "guard and workflow
// cannot drift" — and then heavyMinVCPUByCloud lowered azure's floor to 6 and the prose kept telling
// a maintainer to build a 12-vCPU shape that azure's 10-vCPU quota makes impossible. What genuinely
// cannot drift is the FIXTURE PATH (both sides name test/e2e/fixtures/cluster_json.heavy.<cloud>.json);
// the numbers must be read from here, and every failure message below prints the actual shortfall.
const (
	heavyMinNodes = 3
	heavyMinVCPU  = 12.0 // total across the pool (desired_size × per-node vCPU); see heavyMinVCPUFor
	heavyMinMemGB = 48.0 // total across the pool
)

// heavyMinVCPUByCloud lowers the total-vCPU floor for a cloud whose own QUOTA makes the default
// unreachable. It exists for exactly one cloud, and the reason is worth stating in place rather than
// discovering on a main-gated run:
//
// The e2e Azure subscription has a **10 vCPU** Total Regional quota. The AKS module renders ONE pool
// (infra/templates/project/azure/modules/aks/main.tf: `default_node_pool` with vm_size =
// machine_types[0], node_count = node_desired_size; the `extra` pool only renders for a second
// machine type), so total vCPU at create is desired × per-node vCPU with nothing hidden. 3 nodes ×
// 4 vCPU = 12 > 10, and the shipped Standard_D4s_v5 ×3 fixture therefore FAILED on quota before it
// provisioned anything. With heavyMinNodes=3 AND heavyMinVCPU=12 the floor is structurally
// unreachable on Azure: there is no SKU combination that satisfies both inside 10 vCPU.
//
// What actually decides whether the heavy set schedules is MEMORY and node count; the 12-vCPU number
// was reverse-derived from the AWS fixture, not measured. So Azure gets an explicit 6 (the memory
// family: Standard_E2s_v5 ×3 = 6 vCPU / 48 GiB, catalog-valid, inside quota) rather than the
// alternative of omitting node_size from the fixture — which would silently drop the guard to
// node-count-only and make it toothless, the failure mode this whole file exists to avoid.
// ⚠️ The ESv5 family carries its OWN per-family quota; a Students subscription can hold it at 0 even
// with 10 Total Regional. If it is 0, Azure has no feasible full-bar shape and must become an
// explicit documented exclusion, not a quietly failing leg.
var heavyMinVCPUByCloud = map[string]float64{"azure": 6.0}

// heavyMinVCPUFor returns the total-vCPU floor for a cloud — the default unless that cloud has a
// documented quota override.
func heavyMinVCPUFor(provider string) float64 {
	if v, ok := heavyMinVCPUByCloud[provider]; ok {
		return v
	}
	return heavyMinVCPU
}

// t2RequireMaxConfigNodeShape fails fast, BEFORE any provisioning, when the full heavy surface
// (ALETHIA_E2E_MAX_CONFIG=1 AND ALETHIA_E2E_ALL_ADDONS=1) is requested but the resolved cluster shape
// is too small to schedule it. Reads the `cluster` block AFTER the ALETHIA_E2E_CLUSTER_JSON merge, so
// it validates exactly what will provision. When the shape declares a cloud-indifferent node_size
// (vcpu/memory_gb) it enforces a total-capacity floor; otherwise it enforces the node-count floor and
// requires concrete instance_types (a heavy run on a small single node is the mistake this catches —
// e.g. forgetting to swap the cheapest cost-shape for the heavy profile). The vCPU floor is per-cloud
// (heavyMinVCPUFor); the memory and node floors are not.
// Off CI it warns; under ALETHIA_E2E_T2_REQUIRE it is a HARD FAIL. Returns (fatal, msg) mirroring
// t2RequireCostShape.
//
// EITHER FLAG ARMS IT, not both. It used to return early unless BOTH were on, which made it a no-op
// on exactly the runs that needed it most: the `maxconfig` and `addons` dimensions each turn on ONE
// flag, and each asserts a surface the cheapest floor pool cannot schedule (18 charts, or 11 kinds'
// controllers). So the one guard written to catch "heavy surface, floor-sized cluster" was silent
// for both of them — a guard whose "nothing found" branch was indistinguishable from "nothing
// wrong". The node/capacity floors below are the heavy profile's, and either surface needs it.
func t2RequireMaxConfigNodeShape(provider string, snapshot map[string]any) (fatal bool, msg string) {
	if !(AllAddOnsEnabled() || MaxConfigEnabled()) {
		return false, ""
	}
	// Name what is actually on, so the failure tells the operator which dimension they dispatched
	// rather than a fixed phrase describing a combination they may not have asked for.
	want := "max-config + all-add-ons"
	switch {
	case MaxConfigEnabled() && !AllAddOnsEnabled():
		want = "max-config"
	case AllAddOnsEnabled() && !MaxConfigEnabled():
		want = "all-add-ons"
	}
	heavyFixture := fmt.Sprintf("fixtures/cluster_json.heavy.%s.json", provider)
	cluster, _ := snapshot["cluster"].(map[string]any)
	if cluster == nil {
		return t2RequireIsHard(), fmt.Sprintf("%s requested but the snapshot has no cluster block — set a heavy ALETHIA_E2E_CLUSTER_JSON (see %s)", want, heavyFixture)
	}
	desired, _ := t2Num(cluster["node_desired_size"])
	if int(desired) < heavyMinNodes {
		return t2RequireIsHard(), fmt.Sprintf(
			"%s needs >= %d nodes for the 7 heavy charts + 11 kinds' controllers, but cluster.node_desired_size=%v — pin the heavy profile (%s) via ALETHIA_E2E_CLUSTER_JSON",
			want, heavyMinNodes, cluster["node_desired_size"], heavyFixture)
	}
	minVCPU := heavyMinVCPUFor(provider)
	if ns, ok := cluster["node_size"].(map[string]any); ok {
		vcpu, _ := t2Num(ns["vcpu"])
		mem, _ := t2Num(ns["memory_gb"])
		totalVCPU := vcpu * desired
		totalMem := mem * desired
		if totalVCPU < minVCPU || totalMem < heavyMinMemGB {
			return t2RequireIsHard(), fmt.Sprintf(
				"heavy surface on %s needs >= %.0f total vCPU and >= %.0f GB across the pool; node_size %.0fvCPU/%.0fGB × %d = %.0fvCPU/%.0fGB — size up the heavy profile (%s)",
				provider, minVCPU, heavyMinMemGB, vcpu, mem, int(desired), totalVCPU, totalMem, heavyFixture)
		}
		return false, ""
	}
	if types, ok := cluster["instance_types"].([]any); !ok || len(types) == 0 {
		return t2RequireIsHard(), "heavy surface needs an explicit instance_types (or node_size) big enough for the heavy charts — the template's cheapest default won't schedule them"
	}
	return false, ""
}

// ── Fabric-demo node floor (#845) ────────────────────────────────────────────────────────────────
//
// The fabric demo is the OTHER heavy scenario, and until now it was the only one with no shape guard
// and no shape override: the heavy fixture was swapped in by e2e-nightly.yml ONLY on full-bar, and
// t2RequireMaxConfigNodeShape above was a no-op unless BOTH heavy dimensions were on (both since
// fixed — the shape now follows the resolved dimension, and either flag arms the guard). So setting
// ALETHIA_E2E_FABRIC_DEMO on its own ran the demo on the CHEAPEST floor shape — one e2-small (2 GiB)
// on gcp — where it cannot schedule, cannot recover, and burns the whole 165-minute cap on four
// clouds before saying so. That is ~11 hours of billed cluster time to discover a node size.
//
// Unlike the heavy floor's 12 vCPU (reverse-derived from the AWS fixture, as the comment above
// admits), these numbers are MEASURED from the workload the scenario actually places:
//
//	github.com/alethialabs-io/alethia-examples base/kubernetes-manifests.yaml is Online Boutique —
//	12 Deployments whose `requests` sum to 1.57 vCPU / 1.34 GiB per copy. overlays/staging patches
//	frontend to replicas: 2, which adds 0.10 vCPU / 64 MiB, so a staging copy is 1.67 / 1.40.
//
// The scenario places the overlays as namespaces AND re-places the vcluster tier a THIRD time inside
// the vcluster — whose pods schedule on the HOST, so they are not free (t2_fabric_demo.go: tiers from
// fabricDemoDefaultOverlays, plus fabricDemoDefaultVClusterTier). With the default two tiers:
//
//	dev 1.57 + staging 1.67 + staging-in-vcluster 1.67 = 4.91 vCPU / 4.14 GiB of workload requests
//
// fabricDemoPlatform* is what shares the node with it: ArgoCD (already installed by the base
// scenario), the vcluster control plane, the platform rail (cert-manager / metrics-server / ingress),
// and per-node kube overhead. Deliberately generous — the cost of over-reserving is a slightly bigger
// node, and the cost of under-reserving is the 11-hour failure this guard exists to prevent.
const (
	fabricDemoPerCopyVCPU   = 1.7 // one boutique copy, staging's replica bump included, rounded up
	fabricDemoPerCopyMemGB  = 1.5
	fabricDemoPlatformVCPU  = 1.8 // ArgoCD + vcluster control plane + platform rail + kube overhead
	fabricDemoPlatformMemGB = 3.0
	fabricDemoMinNodes      = 2 // one node cannot be drained/rescheduled around; also pod-per-node room
)

// fabricDemoNodeFloor returns the total pool capacity the demo needs for tierCount overlay tiers.
// copies is tierCount+1 because ONE tier is placed a second time inside the vcluster — so the floor
// scales with the configured overlays rather than being pinned to today's two.
func fabricDemoNodeFloor(tierCount int) (vcpu, memGB float64) {
	copies := float64(tierCount + 1)
	return copies*fabricDemoPerCopyVCPU + fabricDemoPlatformVCPU,
		copies*fabricDemoPerCopyMemGB + fabricDemoPlatformMemGB
}

// t2RequireFabricDemoNodeShape fails fast, BEFORE any provisioning, when the fabric demo is requested
// on a pool too small to schedule it. Mirrors t2RequireMaxConfigNodeShape's contract exactly: reads
// the `cluster` block AFTER the ALETHIA_E2E_CLUSTER_JSON merge so it judges what will actually
// provision, returns (fatal, msg), hard-fails only under ALETHIA_E2E_T2_REQUIRE, and prints the real
// shortfall rather than restating a floor that could drift.
//
// A full-bar run needs no special case: the heavy profile is larger than the demo floor on every
// cloud, so the same total-capacity comparison simply passes.
//
// tierCount comes from the caller's already-parsed tiers, so a misconfigured
// ALETHIA_E2E_FABRIC_DEMO_OVERLAYS fails in fabricDemoTiers (which is fail-closed on zero) rather
// than being silently sized here.
func t2RequireFabricDemoNodeShape(provider string, snapshot map[string]any, tierCount int) (fatal bool, msg string) {
	if !fabricDemoEnabled() {
		return false, ""
	}
	demoFixture := fmt.Sprintf("fixtures/cluster_json.demo.%s.json", provider)
	minVCPU, minMemGB := fabricDemoNodeFloor(tierCount)

	cluster, _ := snapshot["cluster"].(map[string]any)
	if cluster == nil {
		return t2RequireIsHard(), fmt.Sprintf(
			"fabric demo requested but the snapshot has no cluster block — pin the demo profile (%s) via ALETHIA_E2E_CLUSTER_JSON", demoFixture)
	}
	desired, _ := t2Num(cluster["node_desired_size"])
	if int(desired) < fabricDemoMinNodes {
		return t2RequireIsHard(), fmt.Sprintf(
			"fabric demo needs >= %d nodes (%d overlay tiers + 1 vcluster re-placement = %d boutique copies), but cluster.node_desired_size=%v — pin the demo profile (%s) via ALETHIA_E2E_CLUSTER_JSON",
			fabricDemoMinNodes, tierCount, tierCount+1, cluster["node_desired_size"], demoFixture)
	}
	ns, ok := cluster["node_size"].(map[string]any)
	if !ok {
		// No declared capacity means the floor cannot be enforced at all, and the default floor shape
		// declares none — which is exactly how this scenario came to run on an e2-small. Refuse rather
		// than degrade to a node count, the toothless-guard failure mode t2_providers.go exists to avoid.
		return t2RequireIsHard(), fmt.Sprintf(
			"fabric demo needs a cluster shape declaring node_size {vcpu, memory_gb} so the >= %.1f vCPU / %.1f GB floor can be enforced before any spend — the nightly's cheapest floor shape declares none, and on that shape the boutique overlays sit Pending until the job cap kills the run. Pin the demo profile (%s) via ALETHIA_E2E_CLUSTER_JSON",
			minVCPU, minMemGB, demoFixture)
	}
	vcpu, _ := t2Num(ns["vcpu"])
	mem, _ := t2Num(ns["memory_gb"])
	totalVCPU, totalMem := vcpu*desired, mem*desired
	if totalVCPU < minVCPU || totalMem < minMemGB {
		return t2RequireIsHard(), fmt.Sprintf(
			"fabric demo on %s needs >= %.1f total vCPU and >= %.1f GB across the pool (%d boutique copies at ~%.1f vCPU / %.1f GB each, plus ArgoCD + the vcluster control plane + the platform rail); node_size %.0fvCPU/%.0fGB × %d = %.0fvCPU/%.0fGB — size up the demo profile (%s)",
			provider, minVCPU, minMemGB, tierCount+1, fabricDemoPerCopyVCPU, fabricDemoPerCopyMemGB,
			vcpu, mem, int(desired), totalVCPU, totalMem, demoFixture)
	}
	return false, ""
}

// t2Num coerces a snapshot/JSON numeric (JSON numbers decode as float64; ints appear when set in Go)
// to float64. Returns false for absent/non-numeric.
func t2Num(v any) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case float32:
		return float64(n), true
	case int:
		return float64(n), true
	case int64:
		return float64(n), true
	}
	return 0, false
}

// t2Truthy reports whether an env value reads as an affirmative flag.
func t2Truthy(v string) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "1", "true", "yes", "on":
		return true
	}
	return false
}

// t2Env returns the trimmed value of key, or def when unset/blank.
func t2Env(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
}

// t2AmbientAccountID mirrors the runner's resolveAmbientAccountID for the IN-PROCESS teardown
// path: teardownT2Cluster calls provisioner.RunDestroy directly (not via the runner binary), so
// it must reconstruct the SAME account/project/subscription the deploy used — otherwise the
// destroy's ProviderTfvars emit an empty project_id/account and the teardown fails (leaving the
// cluster to the workflow's belt-and-suspenders sweeper). Reads the same ambient env vars the
// self-operator runner authenticates from. Untagged + here so t2_providers_test can drive it
// without a cloud. Returns "" for account-less providers (hetzner/alibaba-at-tofu-layer).
func t2AmbientAccountID(provider string) string {
	switch provider {
	case "gcp":
		for _, k := range []string{"GOOGLE_PROJECT", "GOOGLE_CLOUD_PROJECT", "GCLOUD_PROJECT", "CLOUDSDK_CORE_PROJECT"} {
			if v := strings.TrimSpace(os.Getenv(k)); v != "" {
				return v
			}
		}
	case "azure":
		return strings.TrimSpace(os.Getenv("ARM_SUBSCRIPTION_ID"))
	case "aws":
		return strings.TrimSpace(os.Getenv("AWS_ACCOUNT_ID"))
	}
	return ""
}

// t2SweeperName maps a provider to the cleanup script the WORKFLOW runs as the teardown
// guarantee, for use in messages.
//
// It exists because the in-test teardown failure line hardcoded `hcloud-cleanup` and printed it on
// every cloud — so an aws run whose destroy was interrupted told the reader to look at hetzner's
// sweeper. The workflow's own per-provider `case` was always correct; only the message lied, and
// only to someone already diagnosing a failure, which is the worst moment to be misdirected.
//
// The names are a TABLE, not a formatting rule. `scripts/e2e/` holds alibaba-, aws-, azure-,
// gcp- and hcloud-cleanup.sh: hetzner's is named after the API (hcloud), not the provider, so
// deriving `<provider>-cleanup.sh` would print `hetzner-cleanup.sh` — a file that does not exist.
// Replacing one wrong filename with a different wrong filename is not a fix.
//
// An unknown provider gets a name that is obviously not a path, rather than a plausible guess: a
// reader who is already diagnosing a failed teardown must not be sent to a script that might
// exist for some other cloud.
var t2SweeperScripts = map[string]string{
	"hetzner": "hcloud-cleanup.sh",
	"aws":     "aws-cleanup.sh",
	"gcp":     "gcp-cleanup.sh",
	"azure":   "azure-cleanup.sh",
	"alibaba": "alibaba-cleanup.sh",
}

func t2SweeperName(provider string) string {
	if s, ok := t2SweeperScripts[strings.TrimSpace(provider)]; ok {
		return s
	}
	return fmt.Sprintf("(no sweeper mapped for provider %q)", provider)
}

// t2TeardownFailureLine renders what the t.Cleanup destroy prints when it did not succeed.
//
// There are TWO failures wearing one message, and the difference is the whole diagnosis:
//
//	the destroy REPORTED   → tofu reached a verdict; derr names the resource and the cloud error
//	the WINDOW expired     → tofu reached no verdict at all
//
// The second is invisible in derr. terraform-exec cancels its child with SIGINT rather than SIGKILL
// (packages/core/tofu sets cmd.Cancel = Signal(os.Interrupt)), so a window that runs out produces
// exactly `tofu destroy failed: signal: interrupt` — a sentence with no resource, no dependency and
// no cloud error in it. aws/floor run 33155063965 printed that line and it was read, twice, as a
// destroy that errored; it was a destroy that was still working, ~3m short of its own answer.
//
// So the ctx's own error is what decides the wording, not the text of derr: a destroy killed at the
// deadline is reported AS a deadline, with the window that expired, the knob that widens it and the
// sweeper that still cleans up. Pure and untagged so it is proven on every PR without a cloud.
func t2TeardownFailureLine(provider string, window time.Duration, ctxErr, derr error) string {
	sweeper := t2SweeperName(provider)
	if errors.Is(ctxErr, context.DeadlineExceeded) {
		return fmt.Sprintf(
			"teardown WINDOW EXPIRED after %s — the destroy was interrupted mid-flight and never "+
				"reported a verdict of its own, so %q names nothing. Widen it with "+
				"ALETHIA_E2E_T2_TEARDOWN, or raise this cloud's teardownTimeout in t2ProviderTable "+
				"(and the workflow caps that reserve it). The %s sweeper is the guarantee that the "+
				"cloud is left clean; it is NOT a substitute for the destroy's own error.",
			window, derr, sweeper)
	}
	return fmt.Sprintf("teardown RunDestroy failed (workflow %s is the guarantee): %v", sweeper, derr)
}
