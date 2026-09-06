// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// The fixtures in testdata/ are the shared CLI wire contract: the console side
// validates them against the Zod contract (lib/validations/cli-contract.ts via
// cli-contract.test.ts), and the tests below strict-decode them into the Go
// structs the CLI uses. Together they make Go↔DB type drift a loud failure
// instead of silent zero-filling:
//
//   - DisallowUnknownFields catches ADDITIVE drift (the backend grew a field the
//     Go struct doesn't model — the decode errors on the unknown key).
//   - assertNoExtraStructKeys catches REMOVAL/RENAME drift (the Go struct has a
//     field the wire no longer carries — re-marshaling surfaces the orphan key).
//
// When the DB schema changes, the Zod contract changes, cli-contract.test.ts
// forces the fixture to be regenerated, and the regenerated fixture breaks these
// tests until the Go struct is brought back in sync.

// strictDecode unmarshals a fixture into v, rejecting any unknown JSON field.
func strictDecode(t *testing.T, file string, v any) {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", file))
	if err != nil {
		t.Fatalf("read fixture %s: %v", file, err)
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		t.Fatalf("%s drifted from its Go type (unknown/extra wire field): %v", file, err)
	}
}

// assertNoExtraStructKeys re-marshals the decoded struct and fails if it emits a
// top-level key the fixture does not contain — i.e. the Go struct still expects a
// field the wire dropped or renamed. Only runs on object fixtures.
func assertNoExtraStructKeys(t *testing.T, file string, v any) {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", file))
	if err != nil {
		t.Fatalf("read fixture %s: %v", file, err)
	}
	var wire map[string]json.RawMessage
	if err := json.Unmarshal(raw, &wire); err != nil {
		return // not a top-level object (skip)
	}
	out, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("re-marshal %s: %v", file, err)
	}
	var got map[string]json.RawMessage
	if err := json.Unmarshal(out, &got); err != nil {
		return
	}
	for k := range got {
		if _, ok := wire[k]; !ok {
			t.Errorf("%s: Go struct emits key %q absent from the wire fixture (field removed/renamed upstream?)", file, k)
		}
	}
}

func TestContract_Runners(t *testing.T) {
	var resp struct {
		Runners []Runner `json:"runners"`
	}
	strictDecode(t, "runners.json", &resp)
	if len(resp.Runners) != 1 {
		t.Fatalf("expected 1 runner, got %d", len(resp.Runners))
	}
	assertNoExtraStructKeys(t, "runners.json", struct {
		Runners []Runner `json:"runners"`
	}{resp.Runners})
}

func TestContract_ClustersPage(t *testing.T) {
	var page ClustersPage
	strictDecode(t, "clusters_page.json", &page)
	// Values are sampled deterministically, so assert structure only.
	if len(page.Clusters) != 1 {
		t.Fatalf("unexpected clusters page: %+v", page)
	}
}

func TestContract_ClusterDetail(t *testing.T) {
	var resp ClusterDetail
	strictDecode(t, "cluster_detail.json", &resp)
	assertNoExtraStructKeys(t, "cluster_detail.json", &resp)
}

func TestContract_CloudIdentities(t *testing.T) {
	var resp struct {
		CloudIdentities []CloudIdentity `json:"cloud_identities"`
	}
	strictDecode(t, "cloud_identities.json", &resp)
}

func TestContract_Job(t *testing.T) {
	var job ProvisionJob
	strictDecode(t, "job.json", &job)
	assertNoExtraStructKeys(t, "job.json", job)
}

func TestContract_JobsPage(t *testing.T) {
	var page JobsPage
	strictDecode(t, "jobs_page.json", &page)
	// Values are sampled deterministically (ints → 0), so assert structure only.
	if len(page.Jobs) != 1 {
		t.Fatalf("unexpected jobs page: %+v", page)
	}
}

func TestContract_JobResponse(t *testing.T) {
	var resp struct {
		Job ProvisionJob `json:"job"`
	}
	strictDecode(t, "job_response.json", &resp)
}

func TestContract_InitIdentity(t *testing.T) {
	var resp InitIdentityResponse
	strictDecode(t, "init_identity.json", &resp)
	assertNoExtraStructKeys(t, "init_identity.json", resp)
}

func TestContract_ConnectIdentity(t *testing.T) {
	var resp ConnectIdentityResponse
	strictDecode(t, "connect_identity.json", &resp)
	assertNoExtraStructKeys(t, "connect_identity.json", resp)
}

func TestContract_JobLogs(t *testing.T) {
	var resp struct {
		Logs []JobLog `json:"logs"`
	}
	strictDecode(t, "job_logs.json", &resp)
}

func TestContract_Repositories(t *testing.T) {
	var resp struct {
		Repositories []Repository `json:"repositories"`
	}
	strictDecode(t, "repositories.json", &resp)
}

func TestContract_ProviderStatus(t *testing.T) {
	var status ProviderStatus
	strictDecode(t, "provider_status.json", &status)
	assertNoExtraStructKeys(t, "provider_status.json", status)
}

func TestContract_DeployRunner(t *testing.T) {
	var resp DeployRunnerResponse
	strictDecode(t, "deploy_runner.json", &resp)
	assertNoExtraStructKeys(t, "deploy_runner.json", resp)
}

func TestContract_WhoAmI(t *testing.T) {
	var me WhoAmI
	strictDecode(t, "whoami.json", &me)
	assertNoExtraStructKeys(t, "whoami.json", me)
}

func TestContract_Orgs(t *testing.T) {
	var resp struct {
		Orgs []OrgSummary `json:"orgs"`
	}
	strictDecode(t, "orgs.json", &resp)
	if len(resp.Orgs) != 1 {
		t.Fatalf("expected 1 org, got %d", len(resp.Orgs))
	}
	assertNoExtraStructKeys(t, "orgs.json", resp)
}

func TestContract_Members(t *testing.T) {
	var resp struct {
		Members []Member `json:"members"`
	}
	strictDecode(t, "members.json", &resp)
	if len(resp.Members) != 1 {
		t.Fatalf("expected 1 member, got %d", len(resp.Members))
	}
	assertNoExtraStructKeys(t, "members.json", resp)
}

func TestContract_Teams(t *testing.T) {
	var resp struct {
		Teams []Team `json:"teams"`
	}
	strictDecode(t, "teams.json", &resp)
	if len(resp.Teams) != 1 {
		t.Fatalf("expected 1 team, got %d", len(resp.Teams))
	}
	assertNoExtraStructKeys(t, "teams.json", resp)
}

func TestContract_Channels(t *testing.T) {
	var resp struct {
		Channels []Channel `json:"channels"`
	}
	strictDecode(t, "channels.json", &resp)
	if len(resp.Channels) != 1 {
		t.Fatalf("expected 1 channel, got %d", len(resp.Channels))
	}
	assertNoExtraStructKeys(t, "channels.json", resp)
}

func TestContract_Channel(t *testing.T) {
	var resp struct {
		Channel Channel `json:"channel"`
	}
	strictDecode(t, "channel.json", &resp)
	assertNoExtraStructKeys(t, "channel.json", resp)
}

func TestContract_AlertRules(t *testing.T) {
	var resp struct {
		AlertRules []AlertRule `json:"alert_rules"`
	}
	strictDecode(t, "alert_rules.json", &resp)
	if len(resp.AlertRules) != 1 {
		t.Fatalf("expected 1 alert rule, got %d", len(resp.AlertRules))
	}
	assertNoExtraStructKeys(t, "alert_rules.json", resp)
}

func TestContract_AlertRule(t *testing.T) {
	var resp struct {
		AlertRule AlertRule `json:"alert_rule"`
	}
	strictDecode(t, "alert_rule.json", &resp)
	assertNoExtraStructKeys(t, "alert_rule.json", resp)
}

func TestContract_Activity(t *testing.T) {
	var resp struct {
		Activity []ActivityEntry `json:"activity"`
	}
	strictDecode(t, "activity.json", &resp)
	if len(resp.Activity) != 1 {
		t.Fatalf("expected 1 activity entry, got %d", len(resp.Activity))
	}
	assertNoExtraStructKeys(t, "activity.json", resp)
}

func TestContract_Roles(t *testing.T) {
	var resp struct {
		Roles []Role `json:"roles"`
	}
	strictDecode(t, "roles.json", &resp)
	if len(resp.Roles) != 1 {
		t.Fatalf("expected 1 role, got %d", len(resp.Roles))
	}
	assertNoExtraStructKeys(t, "roles.json", resp)
}

func TestContract_Role(t *testing.T) {
	var resp struct {
		Role Role `json:"role"`
	}
	strictDecode(t, "role.json", &resp)
	assertNoExtraStructKeys(t, "role.json", resp)
}

func TestContract_Grants(t *testing.T) {
	var resp struct {
		Grants []Grant `json:"grants"`
	}
	strictDecode(t, "grants.json", &resp)
	if len(resp.Grants) != 1 {
		t.Fatalf("expected 1 grant, got %d", len(resp.Grants))
	}
	assertNoExtraStructKeys(t, "grants.json", resp)
}

func TestContract_Grant(t *testing.T) {
	var resp struct {
		Grant Grant `json:"grant"`
	}
	strictDecode(t, "grant.json", &resp)
	assertNoExtraStructKeys(t, "grant.json", resp)
}

func TestContract_SsoProviders(t *testing.T) {
	var resp struct {
		SsoProviders []SsoProvider `json:"sso_providers"`
	}
	strictDecode(t, "sso_providers.json", &resp)
	if len(resp.SsoProviders) != 1 {
		t.Fatalf("expected 1 sso provider, got %d", len(resp.SsoProviders))
	}
	assertNoExtraStructKeys(t, "sso_providers.json", resp)
}

func TestContract_SsoProvider(t *testing.T) {
	var resp struct {
		SsoProvider SsoProvider `json:"sso_provider"`
	}
	strictDecode(t, "sso_provider.json", &resp)
	assertNoExtraStructKeys(t, "sso_provider.json", resp)
}

func TestContract_Billing(t *testing.T) {
	var resp struct {
		Billing Billing `json:"billing"`
	}
	strictDecode(t, "billing.json", &resp)
	assertNoExtraStructKeys(t, "billing.json", resp)
}

func TestContract_Usage(t *testing.T) {
	var resp struct {
		Usage Usage `json:"usage"`
	}
	strictDecode(t, "usage.json", &resp)
	assertNoExtraStructKeys(t, "usage.json", resp)
}

func TestContract_FleetPools(t *testing.T) {
	var resp struct {
		Pools []FleetPool `json:"pools"`
	}
	strictDecode(t, "fleet_pools.json", &resp)
	if len(resp.Pools) != 1 {
		t.Fatalf("expected 1 fleet pool, got %d", len(resp.Pools))
	}
	assertNoExtraStructKeys(t, "fleet_pools.json", resp)
}

func TestContract_FleetPool(t *testing.T) {
	var resp struct {
		Pool FleetPool `json:"pool"`
	}
	strictDecode(t, "fleet_pool.json", &resp)
	assertNoExtraStructKeys(t, "fleet_pool.json", resp)
}

func TestContract_Project(t *testing.T) {
	var resp struct {
		Project Project `json:"project"`
	}
	strictDecode(t, "project.json", &resp)
	assertNoExtraStructKeys(t, "project.json", resp)
}

func TestContract_Environments(t *testing.T) {
	var resp struct {
		Environments []Environment `json:"environments"`
		Page         PageInfo      `json:"page"`
	}
	strictDecode(t, "environments.json", &resp)
	if len(resp.Environments) != 1 {
		t.Fatalf("expected 1 environment, got %d", len(resp.Environments))
	}
	assertNoExtraStructKeys(t, "environments.json", resp)
}

func TestContract_Environment(t *testing.T) {
	var resp struct {
		Environment Environment `json:"environment"`
	}
	strictDecode(t, "environment.json", &resp)
	assertNoExtraStructKeys(t, "environment.json", resp)
}

func TestContract_Components(t *testing.T) {
	var resp struct {
		Components []Component `json:"components"`
		Page       PageInfo    `json:"page"`
	}
	strictDecode(t, "components.json", &resp)
	if len(resp.Components) != 1 {
		t.Fatalf("expected 1 component, got %d", len(resp.Components))
	}
	assertNoExtraStructKeys(t, "components.json", resp)
}

func TestContract_Component(t *testing.T) {
	var resp struct {
		Component Component `json:"component"`
	}
	strictDecode(t, "component.json", &resp)
	assertNoExtraStructKeys(t, "component.json", resp)
}

func TestContract_SigningKeys(t *testing.T) {
	var resp SigningKeysResponse
	strictDecode(t, "signing_keys.json", &resp)
	if len(resp.SigningKeys) != 2 {
		t.Fatalf("expected 2 signing keys, got %d", len(resp.SigningKeys))
	}
	// The platform entry is the one that matters: today's receipts are platform-signed, so a
	// wire that carried only org keys would leave `alethia verify receipt` unable to vouch for
	// any receipt in existence. Its provider/status arrive as JSON null and must land as empty
	// strings, not as a decode failure.
	platform := resp.SigningKeys[1]
	if platform.Source != "platform" {
		t.Fatalf("expected the second key to be the platform key, got source %q", platform.Source)
	}
	if platform.Provider != "" || platform.Status != "" {
		t.Errorf("null provider/status must decode to empty, got %q/%q", platform.Provider, platform.Status)
	}
	assertNoExtraStructKeys(t, "signing_keys.json", resp)
}

func TestContract_Drift(t *testing.T) {
	var resp DriftPosture
	strictDecode(t, "drift.json", &resp)
	if len(resp.Details) != 1 {
		t.Fatalf("expected 1 drift detail, got %d", len(resp.Details))
	}
	assertNoExtraStructKeys(t, "drift.json", resp)
}

func TestContract_Cost(t *testing.T) {
	var resp EnvironmentCost
	strictDecode(t, "cost.json", &resp)
	if len(resp.Resources) != 1 {
		t.Fatalf("expected 1 cost resource, got %d", len(resp.Resources))
	}
	assertNoExtraStructKeys(t, "cost.json", resp)
}

func TestContract_Protection(t *testing.T) {
	var resp struct {
		Rules []ProtectionRule `json:"rules"`
	}
	strictDecode(t, "protection.json", &resp)
	if len(resp.Rules) != 1 {
		t.Fatalf("expected 1 protection rule, got %d", len(resp.Rules))
	}
	assertNoExtraStructKeys(t, "protection.json", resp)
}

func TestContract_Probes(t *testing.T) {
	var resp struct {
		Probes []ProbeState `json:"probes"`
	}
	strictDecode(t, "probes.json", &resp)
	if len(resp.Probes) != 1 {
		t.Fatalf("expected 1 probe state, got %d", len(resp.Probes))
	}
	assertNoExtraStructKeys(t, "probes.json", resp)
}

func TestContract_Addons(t *testing.T) {
	var resp ProjectAddonsPage
	strictDecode(t, "addons.json", &resp)
	if len(resp.Addons) != 1 {
		t.Fatalf("expected 1 add-on, got %d", len(resp.Addons))
	}
	assertNoExtraStructKeys(t, "addons.json", resp)
}

func TestContract_ByoCharts(t *testing.T) {
	var resp ProjectByoChartsPage
	strictDecode(t, "byo_charts.json", &resp)
	if len(resp.Charts) != 1 {
		t.Fatalf("expected 1 chart, got %d", len(resp.Charts))
	}
	assertNoExtraStructKeys(t, "byo_charts.json", resp)
}

func TestContract_IacSource(t *testing.T) {
	var resp struct {
		Source *IacSource `json:"source"`
	}
	strictDecode(t, "iac_source.json", &resp)
	if resp.Source == nil {
		t.Fatal("expected a non-null source in the fixture")
	}
	assertNoExtraStructKeys(t, "iac_source.json", resp)
}

func TestContract_Promotions(t *testing.T) {
	var resp struct {
		Promotions []Promotion `json:"promotions"`
		Page       PageInfo    `json:"page"`
	}
	strictDecode(t, "promotions.json", &resp)
	if len(resp.Promotions) != 1 {
		t.Fatalf("expected 1 promotion, got %d", len(resp.Promotions))
	}
	assertNoExtraStructKeys(t, "promotions.json", resp)
}

func TestContract_Promotion(t *testing.T) {
	var resp struct {
		Promotion PromotionDetail `json:"promotion"`
	}
	strictDecode(t, "promotion.json", &resp)
	if len(resp.Promotion.Approvals) != 1 {
		t.Fatalf("expected 1 approval slot, got %d", len(resp.Promotion.Approvals))
	}
	assertNoExtraStructKeys(t, "promotion.json", resp)
}

func TestContract_StagedChanges(t *testing.T) {
	var resp StagedChangesPage
	strictDecode(t, "staged_changes.json", &resp)
	if len(resp.Changes) != 1 {
		t.Fatalf("expected 1 staged change, got %d", len(resp.Changes))
	}
	assertNoExtraStructKeys(t, "staged_changes.json", resp)
}

func TestContract_CloudInventory(t *testing.T) {
	var resp CloudInventory
	strictDecode(t, "cloud_inventory.json", &resp)
	if len(resp.Networks) != 1 || len(resp.Subnets) != 1 {
		t.Fatalf("expected 1 network + 1 subnet, got %d/%d", len(resp.Networks), len(resp.Subnets))
	}
	assertNoExtraStructKeys(t, "cloud_inventory.json", resp)
}

func TestContract_OrgSettings(t *testing.T) {
	var resp struct {
		Settings *OrgSettings `json:"settings"`
	}
	strictDecode(t, "org_settings.json", &resp)
	if resp.Settings == nil {
		t.Fatal("expected non-null settings in the fixture")
	}
	assertNoExtraStructKeys(t, "org_settings.json", resp)
}

func TestContract_Agents(t *testing.T) {
	var resp struct {
		Agents []Agent `json:"agents"`
	}
	strictDecode(t, "agents.json", &resp)
	if len(resp.Agents) != 1 {
		t.Fatalf("expected 1 agent, got %d", len(resp.Agents))
	}
	assertNoExtraStructKeys(t, "agents.json", resp)
}

func TestContract_Agent(t *testing.T) {
	var resp struct {
		Agent Agent `json:"agent"`
	}
	strictDecode(t, "agent.json", &resp)
	assertNoExtraStructKeys(t, "agent.json", resp)
}

func TestContract_ClassificationDimensions(t *testing.T) {
	var resp struct {
		Dimensions []ClassificationDimension `json:"dimensions"`
	}
	strictDecode(t, "classification_dimensions.json", &resp)
	if len(resp.Dimensions) != 1 {
		t.Fatalf("expected 1 dimension, got %d", len(resp.Dimensions))
	}
	assertNoExtraStructKeys(t, "classification_dimensions.json", resp)
}

func TestContract_ClassificationAssignments(t *testing.T) {
	var resp struct {
		Assignments []ClassificationAssignment `json:"assignments"`
	}
	strictDecode(t, "classification_assignments.json", &resp)
	if len(resp.Assignments) != 1 {
		t.Fatalf("expected 1 assignment, got %d", len(resp.Assignments))
	}
	assertNoExtraStructKeys(t, "classification_assignments.json", resp)
}

// TestContract_ByoAttach pins the attach response. The id is the point: the server SLUGIFIES what the
// caller sent, and a caller that wants to scan or detach afterwards needs the stored id rather than
// the one it guessed.
func TestContract_ByoAttach(t *testing.T) {
	var resp ByoAttachResult
	strictDecode(t, "byo_attach.json", &resp)
	assertNoExtraStructKeys(t, "byo_attach.json", resp)
	if !resp.OK || resp.ID == "" {
		t.Errorf("both fields must decode, got %+v", resp)
	}
}

// TestContract_ByoScan pins the scan response — the job id is what makes an asynchronous scan
// followable instead of something a script has to poll blind.
func TestContract_ByoScan(t *testing.T) {
	var resp ByoScanResult
	strictDecode(t, "byo_scan.json", &resp)
	assertNoExtraStructKeys(t, "byo_scan.json", resp)
	if !resp.OK || resp.JobID == "" {
		t.Errorf("both fields must decode, got %+v", resp)
	}
}

// TestContract_RunnerRegistration pins the register response. The token is the only field the CLI
// must not lose — it is returned once and only its SHA-256 is stored — so it is asserted present
// rather than merely decodable.
func TestContract_RunnerRegistration(t *testing.T) {
	var resp RunnerRegistration
	strictDecode(t, "runner_registration.json", &resp)
	assertNoExtraStructKeys(t, "runner_registration.json", resp)
	if resp.RunnerToken == "" {
		t.Error("runner_token must decode — it is returned once and cannot be re-read")
	}
	// Deliberately NOT asserting operator/provisioning values here. The fixture is GENERATED from the
	// Zod contract (scripts/gen-cli-fixtures.ts) and takes the first value of each enum, so asserting
	// "self"/"registered" would be asserting a property of the generator's output rather than of the
	// contract. What this file locks is the SHAPE; the values a register actually produces are pinned
	// by the route and by TestRegisterRunner.
	if resp.Runner.ID == "" || resp.Runner.Name == "" {
		t.Errorf("the runner must decode, got %+v", resp.Runner)
	}
}

// TestContract_DesignApply pins the apply response. `mode` is asserted as one of the three known
// values, not merely present: reading a "dry-run" as an "applied" is the one misinterpretation that
// matters here, because it would tell a caller their change went live when nothing was written.
func TestContract_DesignApply(t *testing.T) {
	var resp DesignApplyResult
	strictDecode(t, "design_apply.json", &resp)
	assertNoExtraStructKeys(t, "design_apply.json", resp)
	switch resp.Mode {
	case "applied", "staged", "dry-run":
	default:
		t.Errorf("mode %q is not one of applied|staged|dry-run", resp.Mode)
	}
	if len(resp.Changes) == 0 {
		t.Fatal("the fixture must carry a change row so the row shape is pinned too")
	}
	if resp.Changes[0].Name == nil {
		t.Error("the fixture's row should carry a name so the pointer field is exercised")
	}
}
