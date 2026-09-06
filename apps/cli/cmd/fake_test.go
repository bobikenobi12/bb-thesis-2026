// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// fakeClient is an in-memory apiClient for unit tests: each field is the value a
// method returns, and the *Err fields force the error path. Mutating calls record
// their arguments so tests can assert what was sent.
type fakeClient struct {
	whoami   *api.WhoAmI
	orgs     []api.OrgSummary
	members  []api.Member
	teams    []api.Team
	runners  []api.Runner
	clusters []api.ClusterSummary
	// Service-account tokens (non-interactive auth). The three recorded fields are what the
	// assertions read back: a mint that dropped the name or the expiry would otherwise look fine.
	serviceTokens      []api.ServiceToken
	createdToken       *api.CreatedServiceToken
	createdTokenName   string
	createdTokenExpiry int
	revokedTokenID     string
	configs            []types.ConfigurationSummary
	jobsPage           *api.JobsPage
	job                *api.ProvisionJob
	signingKeys        []api.SigningKey
	// signingKeysErr is separate from err: verify-receipt's whole degradation story is a job
	// fetch that SUCCEEDS while the trusted-key set does not, so the two must fail independently.
	signingKeysErr error
	invite         *api.Invitation
	createdTeam    *api.Team
	channels       []api.Channel
	createdChan    *api.Channel
	verifiedCh     *api.Channel
	alertRules     []api.AlertRule
	createdRule    *api.AlertRule
	activity       []api.ActivityEntry
	roles          []api.Role
	createdRole    *api.Role
	grants         []api.Grant
	createdGr      *api.Grant
	ssoProvs       []api.SsoProvider
	ssoProv        *api.SsoProvider
	billing        *api.Billing
	usage          *api.Usage
	fleetPools     []api.FleetPool
	updatedPool    *api.FleetPool
	createdProj    *api.Project
	environments   []api.Environment
	createdEnv     *api.Environment
	components     []api.Component
	createdComp    *api.Component
	classDims      []api.ClassificationDimension
	classAssigns   []api.ClassificationAssignment
	configExport   *api.ConfigurationExport
	repos          []api.Repository
	providerStat   *api.ProviderStatus
	verifyResult   *api.ConnectIdentityResponse
	drift          *api.DriftPosture
	cost           *api.EnvironmentCost
	protection     []api.ProtectionRule
	probes         []api.ProbeState
	addons         *api.ProjectAddons
	byoCharts      *api.ProjectByoCharts
	iacSource      *api.IacSource
	promotions     []api.Promotion
	promotion      *api.PromotionDetail
	staged         *api.StagedChanges
	cloudInv       *api.CloudInventory
	orgSettings    *api.OrgSettings
	agents         []api.Agent
	agent          *api.Agent

	// recorded classification calls
	assignedKind    string
	assignedID      string
	assignedDim     string
	assignedValue   string
	unassignedKind  string
	unassignedID    string
	unassignedValue string

	err error // returned by every method when non-nil

	// recorded calls
	invitedEmail   string
	invitedRole    string
	removedMember  string
	createdName    string
	deletedTeam    string
	createdChType  string
	createdChCfg   map[string]interface{}
	deletedChannel string
	verifiedChID   string
	createdRuleN   string
	createdRulePat []string
	createdRuleCh  []string
	createdRuleSev string
	deletedRule    string
	activityLimit  int
	// The promotion list call's arguments. `promotion get`'s picker narrows by the SAME --env the
	// list command uses, and a picker showing a different set from the list beside it is a second
	// opinion about what the project contains — so the narrowing has to be observable.
	promoProject      string
	promoEnv          string
	createdRoleN      string
	createdRoleKey    []string
	deletedRole       string
	addedGrant        api.AddGrantParams
	removedGrant      string
	ssoGetID          string
	setPoolProv       string
	setPoolUpdate     api.FleetPoolUpdate
	createdProjP      api.CreateProjectParams
	envProject        string
	addedEnvName      string
	addedEnvStage     string
	addedEnvRegion    string
	addedEnvParams    api.AddEnvironmentParams
	listCompProj      string
	listCompKind      string
	listCompEnv       string
	addCompProj       string
	addCompKind       string
	addCompName       string
	addCompEnv        string
	addCompFields     map[string]interface{}
	rmCompProj        string
	rmCompKind        string
	rmCompName        string
	rmCompEnv         string
	attachedChart     api.AttachChartParams
	attachedIac       api.AttachIacParams
	byoDetached       []string
	byoScanned        []string
	scanResult        *api.ByoScanResult
	attachResult      *api.ByoAttachResult
	enabledAddon      api.EnableAddonParams
	disabledAddonProj string
	disabledAddonEnv  string
	disabledAddonID   string
	regRunnerName     string
	regRunnerIdentity string
	registration      *api.RunnerRegistration
	appliedDesign     api.ApplyDesignParams
	designResult      *api.DesignApplyResult
}

func (f *fakeClient) Whoami() (*api.WhoAmI, error)                   { return f.whoami, f.err }
func (f *fakeClient) ListOrgs() ([]api.OrgSummary, error)            { return f.orgs, f.err }
func (f *fakeClient) ListMembers(orgID string) ([]api.Member, error) { return f.members, f.err }

func (f *fakeClient) InviteMember(orgID, email, role string) (*api.Invitation, error) {
	f.invitedEmail, f.invitedRole = email, role
	if f.err != nil {
		return nil, f.err
	}
	if f.invite != nil {
		return f.invite, nil
	}
	return &api.Invitation{ID: "inv1", Email: email, Role: role, Status: "pending"}, nil
}

func (f *fakeClient) RemoveMember(orgID, memberID string) error {
	f.removedMember = memberID
	return f.err
}

func (f *fakeClient) ListTeams(orgID string) ([]api.Team, error) { return f.teams, f.err }

func (f *fakeClient) CreateTeam(orgID, name string) (*api.Team, error) {
	f.createdName = name
	if f.err != nil {
		return nil, f.err
	}
	if f.createdTeam != nil {
		return f.createdTeam, nil
	}
	return &api.Team{ID: "team1", Name: name}, nil
}

func (f *fakeClient) DeleteTeam(orgID, teamID string) error {
	f.deletedTeam = teamID
	return f.err
}

func (f *fakeClient) GetRunners() ([]api.Runner, error) { return f.runners, f.err }

func (f *fakeClient) RegisterRunner(name, cloudIdentityID string) (*api.RunnerRegistration, error) {
	f.regRunnerName, f.regRunnerIdentity = name, cloudIdentityID
	if f.err != nil {
		return nil, f.err
	}
	if f.registration != nil {
		return f.registration, nil
	}
	return &api.RunnerRegistration{
		Runner:      api.Runner{ID: "run1", Name: name, Operator: "self", Provisioning: "registered"},
		RunnerToken: "tok-abc123",
	}, nil
}

func (f *fakeClient) ApplyDesign(p api.ApplyDesignParams) (*api.DesignApplyResult, error) {
	f.appliedDesign = p
	if f.err != nil {
		return nil, f.err
	}
	if f.designResult != nil {
		return f.designResult, nil
	}
	mode := "applied"
	if p.DryRun {
		mode = "dry-run"
	} else if p.Stage {
		mode = "staged"
	}
	return &api.DesignApplyResult{OK: true, Mode: mode}, nil
}
func (f *fakeClient) GetClusters() ([]api.ClusterSummary, error) { return f.clusters, f.err }
func (f *fakeClient) GetConfigurations() ([]types.ConfigurationSummary, error) {
	return f.configs, f.err
}

func (f *fakeClient) ExportConfiguration(projectName, format string) (*api.ConfigurationExport, error) {
	return f.configExport, f.err
}

func (f *fakeClient) GetRepositories(provider string) ([]api.Repository, error) {
	return f.repos, f.err
}

func (f *fakeClient) ListServiceTokens() ([]api.ServiceToken, error) {
	return f.serviceTokens, f.err
}

func (f *fakeClient) CreateServiceToken(name string, expiresInDays int) (*api.CreatedServiceToken, error) {
	f.createdTokenName, f.createdTokenExpiry = name, expiresInDays
	return f.createdToken, f.err
}

func (f *fakeClient) RevokeServiceToken(id string) error {
	f.revokedTokenID = id
	return f.err
}

func (f *fakeClient) GetProviderStatus(provider string) (*api.ProviderStatus, error) {
	return f.providerStat, f.err
}

func (f *fakeClient) VerifyProviderIdentity(provider, identityID string) (*api.ConnectIdentityResponse, error) {
	return f.verifyResult, f.err
}
func (f *fakeClient) GetJobs(status string, limit, offset int) (*api.JobsPage, error) {
	return f.jobsPage, f.err
}
func (f *fakeClient) GetJob(jobID string) (*api.ProvisionJob, error) { return f.job, f.err }

func (f *fakeClient) GetSigningKeys() ([]api.SigningKey, error) {
	return f.signingKeys, f.signingKeysErr
}

func (f *fakeClient) ListChannels() ([]api.Channel, error) { return f.channels, f.err }

func (f *fakeClient) CreateChannel(name, channelType string, config map[string]interface{}) (*api.Channel, error) {
	f.createdName, f.createdChType, f.createdChCfg = name, channelType, config
	if f.err != nil {
		return nil, f.err
	}
	if f.createdChan != nil {
		return f.createdChan, nil
	}
	return &api.Channel{ID: "ch1", Name: name, Type: channelType, IsVerified: true}, nil
}

func (f *fakeClient) DeleteChannel(channelID string) error {
	f.deletedChannel = channelID
	return f.err
}

func (f *fakeClient) VerifyChannel(channelID string) (*api.Channel, error) {
	f.verifiedChID = channelID
	if f.err != nil {
		return nil, f.err
	}
	if f.verifiedCh != nil {
		return f.verifiedCh, nil
	}
	return &api.Channel{ID: channelID, Name: "ops", IsVerified: true}, nil
}

func (f *fakeClient) ListAlertRules() ([]api.AlertRule, error) { return f.alertRules, f.err }

func (f *fakeClient) CreateAlertRule(name string, eventPatterns, channelIDs []string, severity string) (*api.AlertRule, error) {
	f.createdRuleN, f.createdRulePat, f.createdRuleCh, f.createdRuleSev = name, eventPatterns, channelIDs, severity
	if f.err != nil {
		return nil, f.err
	}
	if f.createdRule != nil {
		return f.createdRule, nil
	}
	return &api.AlertRule{ID: "rule1", Name: name, Severity: severity, EventPatterns: eventPatterns, ChannelIDs: channelIDs}, nil
}

func (f *fakeClient) DeleteAlertRule(ruleID string) error {
	f.deletedRule = ruleID
	return f.err
}

func (f *fakeClient) ListActivity(limit int) ([]api.ActivityEntry, error) {
	f.activityLimit = limit
	return f.activity, f.err
}

func (f *fakeClient) ListRoles() ([]api.Role, error) { return f.roles, f.err }

func (f *fakeClient) CreateRole(name string, permissionKeys []string) (*api.Role, error) {
	f.createdRoleN, f.createdRoleKey = name, permissionKeys
	if f.err != nil {
		return nil, f.err
	}
	if f.createdRole != nil {
		return f.createdRole, nil
	}
	return &api.Role{ID: "role1", Name: name, PermissionKeys: permissionKeys}, nil
}

func (f *fakeClient) DeleteRole(roleID string) error {
	f.deletedRole = roleID
	return f.err
}

func (f *fakeClient) ListClassificationDimensions() ([]api.ClassificationDimension, error) {
	return f.classDims, f.err
}

func (f *fakeClient) GetResourceClassifications(kind, id string) ([]api.ClassificationAssignment, error) {
	return f.classAssigns, f.err
}

func (f *fakeClient) AssignClassification(kind, id, dimensionKey, valueSlug string) ([]api.ClassificationAssignment, error) {
	f.assignedKind, f.assignedID = kind, id
	f.assignedDim, f.assignedValue = dimensionKey, valueSlug
	return f.classAssigns, f.err
}

func (f *fakeClient) UnassignClassification(kind, id, valueSlug string) error {
	f.unassignedKind, f.unassignedID, f.unassignedValue = kind, id, valueSlug
	return f.err
}

func (f *fakeClient) ListGrants() ([]api.Grant, error) { return f.grants, f.err }

func (f *fakeClient) AddGrant(params api.AddGrantParams) (*api.Grant, error) {
	f.addedGrant = params
	if f.err != nil {
		return nil, f.err
	}
	if f.createdGr != nil {
		return f.createdGr, nil
	}
	return &api.Grant{
		ID: "grant1", PrincipalType: params.PrincipalType, PrincipalID: params.PrincipalID,
		Effect: params.Effect, PermissionKey: params.PermissionKey, ResourceType: params.ResourceType,
	}, nil
}

func (f *fakeClient) RemoveGrant(grantID string) error {
	f.removedGrant = grantID
	return f.err
}

func (f *fakeClient) ListSsoProviders() ([]api.SsoProvider, error) { return f.ssoProvs, f.err }

func (f *fakeClient) GetSsoProvider(id string) (*api.SsoProvider, error) {
	f.ssoGetID = id
	if f.err != nil {
		return nil, f.err
	}
	if f.ssoProv != nil {
		return f.ssoProv, nil
	}
	return &api.SsoProvider{ID: id, ProviderType: "oidc", Domain: "acme.com"}, nil
}

func (f *fakeClient) GetBilling() (*api.Billing, error) { return f.billing, f.err }
func (f *fakeClient) GetUsage() (*api.Usage, error)     { return f.usage, f.err }

func (f *fakeClient) ListFleetPools() ([]api.FleetPool, error) { return f.fleetPools, f.err }

func (f *fakeClient) SetFleetPool(provider string, update api.FleetPoolUpdate) (*api.FleetPool, error) {
	f.setPoolProv, f.setPoolUpdate = provider, update
	if f.err != nil {
		return nil, f.err
	}
	if f.updatedPool != nil {
		return f.updatedPool, nil
	}
	return &api.FleetPool{Provider: provider, Enabled: true}, nil
}

func (f *fakeClient) CreateProject(params api.CreateProjectParams) (*api.Project, error) {
	f.createdProjP = params
	if f.err != nil {
		return nil, f.err
	}
	if f.createdProj != nil {
		return f.createdProj, nil
	}
	return &api.Project{ID: "proj1", ProjectName: params.ProjectName, Region: params.Region, Status: "DRAFT"}, nil
}

func (f *fakeClient) ListEnvironments(project string) ([]api.Environment, error) {
	f.envProject = project
	return f.environments, f.err
}

func (f *fakeClient) AddEnvironment(params api.AddEnvironmentParams) (*api.Environment, error) {
	f.envProject, f.addedEnvName, f.addedEnvStage, f.addedEnvRegion = params.Project, params.Name, params.Stage, params.Region
	f.addedEnvParams = params
	if f.err != nil {
		return nil, f.err
	}
	if f.createdEnv != nil {
		return f.createdEnv, nil
	}
	return &api.Environment{ID: "env1", Name: params.Name, Stage: params.Stage, Status: "DRAFT"}, nil
}

func (f *fakeClient) ListComponents(project, kind, env string) ([]api.Component, error) {
	f.listCompProj, f.listCompKind, f.listCompEnv = project, kind, env
	return f.components, f.err
}

func (f *fakeClient) AddComponent(project, kind, name, env string, fields map[string]interface{}) (*api.Component, error) {
	f.addCompProj, f.addCompKind, f.addCompName, f.addCompEnv, f.addCompFields = project, kind, name, env, fields
	if f.err != nil {
		return nil, f.err
	}
	if f.createdComp != nil {
		return f.createdComp, nil
	}
	return &api.Component{ID: "comp1", Kind: kind, Name: name, Status: "PENDING"}, nil
}

func (f *fakeClient) RemoveComponent(project, kind, name, env string) error {
	f.rmCompProj, f.rmCompKind, f.rmCompName, f.rmCompEnv = project, kind, name, env
	return f.err
}

func (f *fakeClient) GetProjectDrift(project, env string) (*api.DriftPosture, error) {
	return f.drift, f.err
}

func (f *fakeClient) GetEnvironmentCost(project, env string) (*api.EnvironmentCost, error) {
	return f.cost, f.err
}

func (f *fakeClient) GetProjectProtection(project string) ([]api.ProtectionRule, error) {
	return f.protection, f.err
}

func (f *fakeClient) GetProjectProbes(project string) ([]api.ProbeState, error) {
	return f.probes, f.err
}

func (f *fakeClient) GetProjectAddons(project, env string) (*api.ProjectAddons, error) {
	return f.addons, f.err
}

func (f *fakeClient) AttachChart(p api.AttachChartParams) (*api.ByoAttachResult, error) {
	f.attachedChart = p
	if f.err != nil {
		return nil, f.err
	}
	if f.attachResult != nil {
		return f.attachResult, nil
	}
	return &api.ByoAttachResult{OK: true, ID: p.ID}, nil
}

func (f *fakeClient) DetachChart(project, env, id string) error {
	f.byoDetached = append(f.byoDetached, "chart:"+project+":"+env+":"+id)
	return f.err
}

func (f *fakeClient) ScanChart(project, env, id string) (*api.ByoScanResult, error) {
	f.byoScanned = append(f.byoScanned, "chart:"+project+":"+env+":"+id)
	if f.err != nil {
		return nil, f.err
	}
	if f.scanResult != nil {
		return f.scanResult, nil
	}
	return &api.ByoScanResult{OK: true, JobID: "job-1"}, nil
}

func (f *fakeClient) AttachIac(p api.AttachIacParams) (*api.ByoAttachResult, error) {
	f.attachedIac = p
	if f.err != nil {
		return nil, f.err
	}
	return &api.ByoAttachResult{OK: true, ID: "iac-1"}, nil
}

func (f *fakeClient) DetachIac(project, env string) error {
	f.byoDetached = append(f.byoDetached, "iac:"+project+":"+env)
	return f.err
}

func (f *fakeClient) ScanIac(project, env string) (*api.ByoScanResult, error) {
	f.byoScanned = append(f.byoScanned, "iac:"+project+":"+env)
	if f.err != nil {
		return nil, f.err
	}
	if f.scanResult != nil {
		return f.scanResult, nil
	}
	return &api.ByoScanResult{OK: true, JobID: "job-2"}, nil
}

func (f *fakeClient) EnableAddon(p api.EnableAddonParams) error {
	f.enabledAddon = p
	return f.err
}

func (f *fakeClient) DisableAddon(project, env, addonID string) error {
	f.disabledAddonProj, f.disabledAddonEnv, f.disabledAddonID = project, env, addonID
	return f.err
}

func (f *fakeClient) GetProjectByoCharts(project, env string) (*api.ProjectByoCharts, error) {
	return f.byoCharts, f.err
}

func (f *fakeClient) GetProjectIacSource(project, env string) (*api.IacSource, error) {
	return f.iacSource, f.err
}

func (f *fakeClient) GetProjectPromotions(project, env string) ([]api.Promotion, error) {
	f.promoProject, f.promoEnv = project, env
	return f.promotions, f.err
}

func (f *fakeClient) GetPromotion(project, promotionID string) (*api.PromotionDetail, error) {
	return f.promotion, f.err
}

func (f *fakeClient) GetProjectStagedChanges(project, env string) (*api.StagedChanges, error) {
	return f.staged, f.err
}

func (f *fakeClient) GetCloudInventory(cloudIdentityID string) (*api.CloudInventory, error) {
	return f.cloudInv, f.err
}

func (f *fakeClient) GetOrgSettings() (*api.OrgSettings, error) {
	return f.orgSettings, f.err
}

func (f *fakeClient) ListAgents() ([]api.Agent, error) {
	return f.agents, f.err
}

func (f *fakeClient) GetAgent(id string) (*api.Agent, error) {
	return f.agent, f.err
}

var _ apiClient = (*fakeClient)(nil)
