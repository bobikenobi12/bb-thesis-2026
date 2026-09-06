// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package types

type ProjectConfig struct {
	ID               string           `json:"id"`
	UserID           string           `json:"user_id"`
	ProjectName      string           `json:"project_name"`
	EnvironmentStage EnvironmentStage `json:"environment_stage"`
	Region           string           `json:"region"`
	IacVersion       string           `json:"iac_version"`
	CloudIdentityID  string           `json:"cloud_identity_id"`
	Provider         CloudProvider    `json:"provider"`

	// EnvironmentID is the target environment's stable UUID (distinct from the human
	// EnvironmentStage name). Emitted as the `alethia:environment-id` tag/label so a
	// guarded sweeper can scope destroys to exactly one environment's cloud resources.
	EnvironmentID string `json:"environment_id,omitempty"`

	// Placement (decoupled env-model, #836): where this Environment runs on its Fabric.
	// FabricID = the infra unit (control plane + network + shared add-ons + tofu state) this env
	// is placed onto; PlacementMode ∈ namespace|vcluster|dedicated; Namespace = the ArgoCD
	// destination namespace for namespace/vcluster placements (empty → derived from the env name).
	// The provisioner (#838) keys tofu state per-Fabric and sets the ArgoCD Application
	// destination from these. Empty PlacementMode is treated as `dedicated` (legacy env=cluster).
	FabricID      string        `json:"fabric_id,omitempty"`
	PlacementMode PlacementMode `json:"placement_mode,omitempty"`
	Namespace     string        `json:"namespace,omitempty"`

	// Classification is the frozen per-dimension classification captured onto the job's
	// config_snapshot by the console (B1.1): dimension key → sorted value slugs, with the
	// environment overriding the project per dimension. B1.2 turns it into per-cloud
	// resource tags/labels via cloud/tags.go. Empty for unclassified projects.
	Classification map[string][]string `json:"classification,omitempty"`

	Network       ProjectNetworkConfig       `json:"network"`
	Cluster       ProjectClusterConfig       `json:"cluster"`
	DNS           ProjectDNSConfig           `json:"dns"`
	Observability ProjectObservabilityConfig `json:"observability"`
	Repositories  ProjectRepositoriesConfig  `json:"repositories"`
	SourceRepos   []ProjectSourceRepoConfig  `json:"source_repos,omitempty"`

	Databases           []ProjectDatabaseConfig          `json:"databases"`
	Caches              []ProjectCacheConfig             `json:"caches"`
	Queues              []ProjectQueueConfig             `json:"queues"`
	Topics              []ProjectTopicConfig             `json:"topics"`
	NosqlTables         []ProjectNosqlConfig             `json:"nosql_tables"`
	Secrets             []ProjectSecretConfig            `json:"secrets"`
	ContainerRegistries []ProjectContainerRegistryConfig `json:"container_registries"`
	HelmRegistries      []ProjectHelmRegistryConfig      `json:"helm_registries,omitempty"`
	StorageBuckets      []ProjectStorageBucketConfig     `json:"storage_buckets"`

	// Services are first-class application workloads (the customer's own code) — the W1
	// north-star model. The runner turns each into k8s manifests (build/push in W2).
	Services []ProjectServiceConfig `json:"services"`

	// Marketplace add-ons — free OSS Helm charts (Grafana, Loki, …) resolved by the console
	// into install specs. The runner renders one ArgoCD Application per entry after the
	// cluster + ArgoCD are up. Empty for projects that enabled no add-ons.
	AddOns []AddOnInstall `json:"addons,omitempty"`

	// IacSource, when set, marks this project as BRING-YOUR-OWN IaC: the runner
	// provisions the customer's own OpenTofu root module (cloned at a pinned commit
	// from git) instead of a bundled Alethia template. It is the fail-closed
	// execution path for UNTRUSTED customer OpenTofu — the provisioner re-runs the
	// static iacsafety gate inline before any plan/apply. Nil for template-based
	// (canvas / catalog-composed) projects.
	IacSource *ProjectIacSourceConfig `json:"iac_source,omitempty"`

	GitAccessToken string `json:"git_access_token"`

	// Populated at runtime from CloudIdentity, not from snapshot
	CloudAccountID string `json:"-"`

	// Populated at runtime from the claim response (decrypted), not from snapshot.
	// Keyed lookups happen via ConnectorCredentialFor.
	ConnectorCredentials []ConnectorCredential `json:"-"`
}

// ProjectIacSourceConfig pins the customer's own OpenTofu root module for a
// bring-your-own IaC deploy. The console emits it on the config snapshot (C1); the
// runner clones RepoURL at the EXACT CommitSHA (not just Ref — a ref can move after
// the safety scan, TOCTOU), resolves Path inside the clone (traversal-guarded), and
// provisions that directory. VarValues are the customer's own tfvars, constrained to
// scalar string/number/bool at the write step (no nested objects/injection).
type ProjectIacSourceConfig struct {
	// RepoURL is the git repository holding the module (https or ssh form).
	RepoURL string `json:"repo_url"`
	// Ref is the branch or tag the customer selected (used for the clone; the
	// CommitSHA below is what is actually checked out).
	Ref string `json:"ref"`
	// Path is the module directory relative to the repo root ("" / "." = root).
	Path string `json:"path"`
	// CommitSHA is the pinned full commit that was scanned and approved. The deploy
	// MUST check this out (never the moving Ref) so plan/apply run the exact bytes
	// the safety gate vetted.
	CommitSHA string `json:"commit_sha"`
	// VarValues are the customer-supplied tofu variable values. Genuinely arbitrary
	// customer JSON, so map[string]any is acceptable here — but each value is coerced
	// to string/number/bool at the tfvar-write step; anything else is rejected.
	VarValues map[string]any `json:"var_values"`
}

// ConnectorCredential carries a decrypted api_key credential for a pluggable
// connector, attached to the job at claim time (never stored in config_snapshot).
type ConnectorCredential struct {
	Category    string            `json:"category"`
	Slug        string            `json:"slug"`
	Credentials map[string]string `json:"credentials"`
}

// ConnectorCredentialFor returns the decrypted credential fields for a given
// (category, slug), or nil if none was attached.
func (c *ProjectConfig) ConnectorCredentialFor(category, slug string) map[string]string {
	for _, cc := range c.ConnectorCredentials {
		if cc.Category == category && cc.Slug == slug {
			return cc.Credentials
		}
	}
	return nil
}

// Placement is the resolved cloud placement of a single resource ("versatile
// model"). It is embedded in every component config so each resource can name its
// own cloud independently of the project's primary one. Empty fields mean "inherit the
// project's primary placement" — buildConfigSnapshot resolves them to concrete values
// before they reach the runner. CloudProvider is intentionally NOT named "provider":
// several components already carry a pluggable connector slug under json:"provider"
// (cloudflare/vault/…), which is an orthogonal concern from the cloud account.
type Placement struct {
	CloudProvider   CloudProvider `json:"cloud_provider"`
	CloudIdentityID string        `json:"cloud_identity_id"`
	Region          string        `json:"region"`
}

type ProjectNetworkConfig struct {
	Placement
	ProvisionNetwork bool   `json:"provision_network"`
	CIDRBlock        string `json:"cidr_block"`
	NetworkID        string `json:"network_id"`
	SingleNatGateway bool   `json:"single_nat_gateway"`
	// SubnetIDs is the user's explicit brownfield subnet selection (native subnet ids
	// from cloud inventory). Empty means auto-discover the VPC's subnets — today's
	// behaviour — so it is backward compatible. Emitted onto the config snapshot only
	// when non-empty; consumed per-cloud in ProviderTfvars (gcp/azure/alibaba) and in
	// deploy.go's AWS brownfield subnet classification (#1352).
	SubnetIDs []string `json:"subnet_ids,omitempty"`
	// AllowedCidrBlocks are EXTRA source ranges permitted to reach resources in this
	// network, on top of whatever the template already allows. The canvas and the CLI
	// have collected it since the network inspector shipped; nothing modelled it, so
	// `json.Unmarshal` dropped it here and a user could type an allow-list, save it, and
	// be shown a setting that changed nothing (#1987).
	//
	// ADDITIVE by definition — "extra networks permitted", never "only these". Empty (the
	// default) therefore means no extra rules and is bit-for-bit behaviour-preserving,
	// which is also what keeps it from locking the external runner out of a cluster it
	// still has to provision.
	AllowedCidrBlocks []string `json:"allowed_cidr_blocks,omitempty"`
}

// NodeSize is a cloud-indifferent node capability; the catalog resolver maps it to the
// nearest concrete per-provider instance type at provision time.
type NodeSize struct {
	VCPU     float64 `json:"vcpu"`
	MemoryGB float64 `json:"memory_gb"`
}

type ProjectClusterConfig struct {
	Placement
	ClusterVersion string `json:"cluster_version"`
	// Provisioned cluster name (populated on the snapshot after the first deploy). Lets a
	// day-2 job (drift inspection) acquire kubeconfig standalone via ConfigureKubeconfig.
	ClusterName string `json:"cluster_name"`
	// Concrete provider SKUs (legacy / explicit override). When empty, NodeSize resolves.
	InstanceTypes []string `json:"instance_types"`
	// Cloud-indifferent node capability (preferred); resolved to InstanceTypes per provider.
	NodeSize        *NodeSize      `json:"node_size"`
	NodeMinSize     int            `json:"node_min_size"`
	NodeMaxSize     int            `json:"node_max_size"`
	NodeDesiredSize int            `json:"node_desired_size"`
	NodeDiskSizeGB  *int           `json:"node_disk_size_gb"`
	ClusterAdmins   []any          `json:"cluster_admins"`
	ProviderConfig  map[string]any `json:"provider_config"`
}

type ProjectDNSConfig struct {
	Placement
	Enabled bool `json:"enabled"`
	// Pluggable provider slug (connectors.slug); "" / "native" = cloud-native DNS.
	Provider   string `json:"provider"`
	ZoneID     string `json:"zone_id"`
	DomainName string `json:"domain_name"`
	// ManagedCertificate / WafEnabled are the canvas's own two DNS switches. Each cloud
	// fronts them with a differently-named tfvar (acm_certificate_enable, cloud_armor_enabled,
	// azure_waf_enabled, …), so the per-cloud provider ORs the typed field into the local it
	// already derives from ProviderConfig — the JSONB key stays the per-cloud override and the
	// typed field is the product's answer. Both are `omitempty`: absent-when-false keeps the
	// byte-locked config-snapshot fixtures green.
	//
	// WafEnabled is spelled Waf, not WAF, on purpose: check-offer-parity's carrier trace derives
	// the field name from the offer key (`waf_enabled` → `WafEnabled`), and a Go-idiomatic
	// WAFEnabled would make the trace find nothing and silently report the switch as dropped.
	ManagedCertificate bool           `json:"managed_certificate,omitempty"`
	WafEnabled         bool           `json:"waf_enabled,omitempty"`
	ProviderConfig     map[string]any `json:"provider_config"`
}

// ProjectObservabilityConfig — pluggable-only component (no cloud-native default).
type ProjectObservabilityConfig struct {
	Placement
	Enabled        bool           `json:"enabled"`
	Provider       string         `json:"provider"`
	ProviderConfig map[string]any `json:"provider_config"`
}

type ProjectRepositoriesConfig struct {
	AppsDestinationRepo string `json:"apps_destination_repo"`
	// AppsPath is the subpath within AppsDestinationRepo that a PLACED environment's ArgoCD
	// Application syncs — the per-tier Kustomize overlay ("overlays/dev") that makes a placed
	// environment deliver its own tier instead of the whole repository.
	//
	// EMPTY MEANS THE REPOSITORY ROOT: unset renders `path: '.'`, byte-identical to every deploy
	// that predates this field, so no existing tenant's Application moves.
	//
	// IT APPLIES ON ALL THREE PLACEMENT MODES, `dedicated` included. This comment used to say the
	// dedicated path ignored it, and that was true of the defect rather than of the field: the
	// value was read only by the namespace and vcluster paths, so a dedicated environment
	// delivered the repo root no matter what it declared. infra/templates/argocd/user-apps.yaml
	// renders `path` from this value with no placement branch.
	//
	// Naming a path also turns overlay DISCOVERY off — user-apps-overlays.yaml renders only when
	// this is empty, because a glob anchored at the repo root would adopt the very overlays the
	// named path is placing, and both Applications would claim the same Deployments with
	// selfHeal: true. So the two are alternatives, not layers: an explicit path, or discovery.
	AppsPath string `json:"apps_path,omitempty"`
}

// ProjectSourceRepoConfig is a scanned source repo (1:N) + its detected services,
// carried in the config snapshot so the runner can generate app manifests at deploy
// time (the "generate" apps path).
type ProjectSourceRepoConfig struct {
	RepoURL  string            `json:"repo_url"`
	Ref      string            `json:"ref,omitempty"`
	ScanPath string            `json:"scan_path,omitempty"`
	Services []DetectedService `json:"services,omitempty"`
}

type ProjectDatabaseConfig struct {
	Placement
	Name string `json:"name"`
	// Concrete provider engine (legacy / explicit). When empty, EngineFamily resolves it.
	Engine string `json:"engine"`
	// Cloud-indifferent engine family ("postgres" | "mysql"); resolved per provider.
	EngineFamily        string   `json:"engine_family"`
	EngineVersion       string   `json:"engine_version"`
	InstanceClass       string   `json:"instance_class"`
	MinCapacity         *float64 `json:"min_capacity"`
	MaxCapacity         *float64 `json:"max_capacity"`
	Port                *int     `json:"port"`
	BackupRetentionDays *int     `json:"backup_retention_days"`
	IamAuth             *bool    `json:"iam_auth"`
	// ProviderConfig carries per-cloud database knobs the typed fields above do not model,
	// merged into tfvars by name (mergeProviderConfig). Each provider RESERVES its own
	// IAM-auth flag, so keyless can never be switched on from here for a cloud × engine cell
	// the canvas did not offer — that would walk around both the offer-parity guard (#1508)
	// and the visibleWhen gate (#1510).
	ProviderConfig map[string]any `json:"provider_config"`
}

type ProjectCacheConfig struct {
	Placement
	Name          string      `json:"name"`
	Engine        CacheEngine `json:"engine"`
	EngineVersion string      `json:"engine_version"`
	// Concrete provider SKU (legacy / explicit). When empty, MemoryGB resolves it.
	NodeType string `json:"node_type"`
	// Cloud-indifferent size (preferred); resolved to the nearest provider SKU.
	MemoryGB      float64 `json:"memory_gb"`
	NumCacheNodes *int    `json:"num_cache_nodes"`
	MultiAz       *bool   `json:"multi_az"`
	// Extra networks permitted to reach the cache (the cluster always can).
	// Collected by the inspector's cache-network section and the CLI; without
	// this field json.Unmarshal dropped the value on every cloud and the cache
	// was provisioned with the template's default access rules only (#1981).
	AllowedCidrBlocks []string `json:"allowed_cidr_blocks"`
}

type ProjectQueueConfig struct {
	Placement
	Name              string         `json:"name"`
	Ordered           *bool          `json:"ordered"`
	VisibilityTimeout *int           `json:"visibility_timeout"`
	MessageRetention  *int           `json:"message_retention"`
	ProviderConfig    map[string]any `json:"provider_config"`
}

type ProjectTopicConfig struct {
	Placement
	Name          string              `json:"name"`
	Subscriptions []TopicSubscription `json:"subscriptions"`
}

type TopicSubscription struct {
	Protocol TopicSubscriptionProtocol `json:"protocol"`
	Endpoint string                    `json:"endpoint"`
}

type ProjectNosqlConfig struct {
	Placement
	Name                string            `json:"name"`
	PartitionKey        string            `json:"partition_key"`
	PartitionKeyType    NosqlKeyType      `json:"partition_key_type"`
	SortKey             string            `json:"sort_key"`
	SortKeyType         NosqlKeyType      `json:"sort_key_type"`
	TableType           NosqlTableType    `json:"table_type"`
	CapacityMode        NosqlCapacityMode `json:"capacity_mode"`
	PointInTimeRecovery bool              `json:"point_in_time_recovery"`
	// Replica regions for a global table. Collected by the inspector's
	// nosql-replication section and the CLI; without this field json.Unmarshal
	// dropped the value and a global table got the template's default replica
	// set, not the regions the user chose (#1982).
	GlobalReplicas []string `json:"global_replicas"`
}

type ProjectSecretConfig struct {
	Placement
	Name         string `json:"name"`
	Generate     bool   `json:"generate"`
	Length       int    `json:"length"`
	SpecialChars bool   `json:"special_chars"`
	// Pluggable provider slug (connectors.slug); "" / "native" = cloud-native store.
	Provider       string         `json:"provider"`
	ProviderConfig map[string]any `json:"provider_config"`
}

type ProjectContainerRegistryConfig struct {
	Placement
	Name string `json:"name"`
	// Pluggable provider slug (connectors.slug); "" / "native" = cloud-native registry.
	Provider string `json:"provider"`
	// Cross-cloud registry switches — typed fields rather than ProviderConfig keys since #1811.
	// They are shown on all four managed clouds, so they were cross-cloud settings misfiled as
	// provider knobs; and the offer-parity carrier probe can only follow a TYPED field, so a value
	// read out of ProviderConfig is indistinguishable from a value nobody reads at all.
	//
	// POINTERS, deliberately. Every template already defaults to the SAFE setting (ECR:
	// IMMUTABLE + scan-on-push), so "absent" has to mean "leave the template default alone"
	// rather than "false" — decoding a missing field as false would downgrade every repository a
	// live project already has. The console column defaults to true, so a real row always carries
	// a value and only a hand-written snapshot can be silent.
	ImmutableTags         *bool `json:"immutable_tags"`
	VulnerabilityScanning *bool `json:"vulnerability_scanning"`

	ProviderConfig map[string]any `json:"provider_config"`
}

// There is deliberately NO `func (r ProjectContainerRegistryConfig) Immutable() bool` wrapper here,
// tempting as it is: every provider spells `r.ImmutableTags == nil || *r.ImmutableTags` out. The
// offer-parity carrier probe decides that a switch is carried by finding a literal `.ImmutableTags`
// in a function inside packages/core/cloud that is reachable from that cloud's ProviderTfvars. A
// wrapper here moves the only read into packages/core/types, which the probe does not index — so
// every cloud using it would score "carries nothing" while working perfectly, the baseline entry
// could never be deleted, and the build would stay green either way. A wrapper in the cloud package
// is no better: it makes the emit a scalar aggregator, which the probe reads as a ROOT tfvar named
// after the attribute. Four lines of repetition buy a measurement that means something.

// ProjectHelmRegistryConfig selects a connected private Helm/OCI chart-repo connector
// (connectors.slug in the helm_registry category) for a project. Unlike a container registry (a
// dockerconfigjson imagePullSecret for image pulls), its downstream artifact is an ArgoCD
// repository-credential Secret ArgoCD matches to an add-on/BYO Application by chart-repo URL, so a
// private OCI/HTTPS chart pull authenticates. ProviderConfig carries the non-secret repo URL/host;
// the credential fields arrive out-of-band via ConnectorCredentialFor("helm_registry", Provider).
type ProjectHelmRegistryConfig struct {
	Placement
	Name string `json:"name"`
	// Pluggable provider slug (connectors.slug); the helm_registry category has no cloud-native form.
	Provider       string         `json:"provider"`
	ProviderConfig map[string]any `json:"provider_config"`
}

type ProjectStorageBucketConfig struct {
	Placement
	Name              string         `json:"name"`
	Versioning        bool           `json:"versioning"`
	EncryptionEnabled bool           `json:"encryption_enabled"`
	PublicAccess      bool           `json:"public_access"`
	CorsOrigins       []string       `json:"cors_origins"`
	ProviderConfig    map[string]any `json:"provider_config"`
}

// ProjectServiceConfig is a first-class application workload (W1) — the customer's own code,
// run as a Deployment/Job/CronJob/StatefulSet. The runner renders it to k8s manifests; image
// build/push (from Source when Kind=="repo") is W2, infra-binding is W3.
type ProjectServiceConfig struct {
	Placement
	Name   string               `json:"name"`
	Type   ServiceWorkloadType  `json:"type"` // deployment | job | cronjob | statefulset
	Source ProjectServiceSource `json:"source"`
	Build  *ProjectServiceBuild `json:"build,omitempty"`
	Env    []ServiceEnvVar      `json:"env"`
	// Bindings are the W3 edges to backing resources (service→database/cache/queue/secret) and
	// the env each injects. The runner resolves each to the provisioned resource's endpoint
	// (tofu output) / credentials (ExternalSecret → k8s Secret) at deploy time.
	Bindings  []ServiceBinding  `json:"bindings"`
	Ports     []ServicePort     `json:"ports"`
	Replicas  int               `json:"replicas"`
	Resources *ServiceResources `json:"resources,omitempty"`
	Probe     *ServiceProbe     `json:"probe,omitempty"`
	// ResolvedImage is the W2 build's write-back slot — the pushed image digest URI
	// (e.g. "<acct>.dkr.ecr.<region>.amazonaws.com/<repo>@sha256:…") persisted from a BUILD
	// job's result. Distinct from Source (the user's input); empty until a build has run.
	// The manifest renderer substitutes it for the workload image (retiring ":latest").
	ResolvedImage string `json:"resolved_image,omitempty"`
}

// ProjectServiceSource is the flattened form of the TS discriminated union
// ({kind:"repo",repo_url,path} | {kind:"image",image}) — Kind selects which fields apply.
type ProjectServiceSource struct {
	Kind    string `json:"kind"` // "repo" | "image"
	RepoURL string `json:"repo_url,omitempty"`
	Path    string `json:"path,omitempty"`
	Image   string `json:"image,omitempty"`
}

// ProjectServiceBuild is the build config when Source.Kind == "repo".
type ProjectServiceBuild struct {
	Dockerfile string `json:"dockerfile,omitempty"`
	Context    string `json:"context,omitempty"`
}

// ServiceEnvVar is a plain environment variable (secret env-from is W4).
type ServiceEnvVar struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

// ServiceBinding is a service's declared edge to a backing resource (referenced by {Kind, Name} —
// the config join key) plus the env its connection facets inject. Non-secret facets
// (endpoint/port) resolve to templated values from the resource's tofu outputs; credential facets
// resolve keylessly via an ExternalSecret (ESO ClusterSecretStore) → k8s Secret → secretKeyRef.
type ServiceBinding struct {
	Target ServiceBindingTarget      `json:"target"`
	Inject []ServiceBindingInjection `json:"inject"`
}

// ServiceBindingTarget references the backing resource by kind + name.
//
// A FIRST-CLASS target (an Alethia-provisioned database/cache/queue) has Address == "" and
// nil OutputKeys: its facets resolve from the platform template's known output keys
// (manifests.endpointOutputKey). A BYO-IaC target — a resource in a customer-authored tofu
// module — sets Address (its Terraform address, the universal join key) and OutputKeys,
// because the module's outputs follow the CUSTOMER's naming, which no platform key map can
// know (#687). Address != "" is the discriminator.
type ServiceBindingTarget struct {
	Kind ServiceBindingKind `json:"kind"`
	Name string             `json:"name"`
	// Address is the bound resource's Terraform address (e.g.
	// "module.db.aws_db_instance.main"). Set only for a BYO-IaC target; "" for first-class.
	Address string `json:"address,omitempty"`
	// OutputKeys maps a facet to the customer module's tofu OUTPUT NAME that carries it
	// (chosen at bind time from IacScanReport.outputs). Set only for a BYO-IaC target; nil for
	// first-class. An absent/empty key for a facet means "no declared output" — the facet is
	// resolved fail-closed (reported unsatisfiable, never guessed). See manifests.resolveBindings.
	OutputKeys *ServiceBindingOutputKeys `json:"output_keys,omitempty"`
}

// ServiceBindingOutputKeys names the customer module's tofu outputs a BYO-IaC binding
// resolves its facets against. Every field optional — an absent key makes that facet
// unsatisfiable (fail-closed), never guessed.
type ServiceBindingOutputKeys struct {
	// Endpoint is the output holding the resource's connection endpoint/host.
	Endpoint string `json:"endpoint,omitempty"`
	// Port is the output holding the resource's port; when empty the kind's conventional
	// defaultPort is used (matching the first-class path).
	Port string `json:"port,omitempty"`
	// CredentialSecret is the output holding the name/ARN of the cloud secret-store secret
	// that carries the resource's master credentials — the ExternalSecret RemoteKey. Empty
	// means no keyless credential path (the module exported no such secret): credential
	// facets are then unsatisfiable, and no secretKeyRef is emitted.
	CredentialSecret string `json:"credential_secret,omitempty"`
}

// ServiceBindingInjection maps one workload env var to one facet of the bound resource.
type ServiceBindingInjection struct {
	Env  string              `json:"env"`
	From ServiceBindingFacet `json:"from"`
}

// ServicePort is a container port the workload exposes.
type ServicePort struct {
	Name          string `json:"name,omitempty"`
	ContainerPort int    `json:"container_port"`
	Protocol      string `json:"protocol,omitempty"`
}

// ServiceResourceQuantities are Kubernetes quantity strings (e.g. "100m" / "128Mi").
type ServiceResourceQuantities struct {
	CPU    string `json:"cpu"`
	Memory string `json:"memory"`
}

// ServiceResources holds the workload's compute requests + limits.
type ServiceResources struct {
	Requests ServiceResourceQuantities `json:"requests"`
	Limits   ServiceResourceQuantities `json:"limits"`
}

// ServiceProbe is a readiness/liveness probe.
type ServiceProbe struct {
	Type string `json:"type"` // "http" | "tcp"
	Path string `json:"path,omitempty"`
	Port int    `json:"port"`
}
