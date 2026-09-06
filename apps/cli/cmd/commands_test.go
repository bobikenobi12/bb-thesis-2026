// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"bytes"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// errBoom is a sentinel error for exercising error paths.
var errBoom = errors.New("boom")

// --- whoami ---

func newWhoAmI() *api.WhoAmI {
	me := &api.WhoAmI{}
	me.User.ID = "u1"
	me.User.Email = "ada@example.com"
	me.User.Name = "Ada"
	me.ActiveOrg = &api.OrgSummary{ID: "o1", Name: "Acme", Slug: "acme", Role: "owner", Plan: "team", IsActive: true}
	me.DefaultRunner = &struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}{ID: "r1", Name: "primary"}
	return me
}

func TestRunWhoamiTable(t *testing.T) {
	var buf bytes.Buffer
	if err := runWhoami(&fakeClient{whoami: newWhoAmI()}, &buf, "table"); err != nil {
		t.Fatalf("runWhoami: %v", err)
	}
	for _, want := range []string{"ada@example.com", "Acme", "owner", "team", "primary"} {
		if !strings.Contains(buf.String(), want) {
			t.Errorf("whoami table missing %q:\n%s", want, buf.String())
		}
	}
}

func TestRunWhoamiJSON(t *testing.T) {
	var buf bytes.Buffer
	if err := runWhoami(&fakeClient{whoami: newWhoAmI()}, &buf, "json"); err != nil {
		t.Fatalf("runWhoami json: %v", err)
	}
	var got api.WhoAmI
	if err := json.Unmarshal(buf.Bytes(), &got); err != nil {
		t.Fatalf("invalid json: %v\n%s", err, buf.String())
	}
	if got.ActiveOrg == nil || got.ActiveOrg.Name != "Acme" {
		t.Errorf("json missing active org: %s", buf.String())
	}
}

func TestRunWhoamiNoOrg(t *testing.T) {
	var buf bytes.Buffer
	me := &api.WhoAmI{}
	me.User.Email = "solo@example.com"
	if err := runWhoami(&fakeClient{whoami: me}, &buf, "table"); err != nil {
		t.Fatalf("runWhoami: %v", err)
	}
	if !strings.Contains(buf.String(), "solo@example.com") {
		t.Errorf("expected email present: %s", buf.String())
	}
}

func TestRunWhoamiError(t *testing.T) {
	var buf bytes.Buffer
	if err := runWhoami(&fakeClient{err: errBoom}, &buf, "table"); err == nil {
		t.Error("expected error propagated")
	}
}

// --- org ---

func sampleOrgs() []api.OrgSummary {
	return []api.OrgSummary{
		{ID: "o1", Name: "Acme", Slug: "acme", Role: "owner", Plan: "team", IsActive: true},
		{ID: "o2", Name: "Beta", Slug: "beta", Role: "member", Plan: "community"},
	}
}

func TestRunOrgList(t *testing.T) {
	var buf bytes.Buffer
	if err := runOrgList(&fakeClient{orgs: sampleOrgs()}, &buf, "table"); err != nil {
		t.Fatalf("runOrgList: %v", err)
	}
	for _, want := range []string{"Acme", "beta", "owner", "community"} {
		if !strings.Contains(buf.String(), want) {
			t.Errorf("org list missing %q:\n%s", want, buf.String())
		}
	}
}

func TestRunOrgListJSON(t *testing.T) {
	var buf bytes.Buffer
	if err := runOrgList(&fakeClient{orgs: sampleOrgs()}, &buf, "json"); err != nil {
		t.Fatalf("runOrgList json: %v", err)
	}
	var got []api.OrgSummary
	if err := json.Unmarshal(buf.Bytes(), &got); err != nil {
		t.Fatalf("invalid json: %v", err)
	}
	if len(got) != 2 {
		t.Errorf("expected 2 orgs, got %d", len(got))
	}
}

func TestRunOrgListEmpty(t *testing.T) {
	var buf bytes.Buffer
	if err := runOrgList(&fakeClient{orgs: nil}, &buf, "table"); err != nil {
		t.Fatalf("runOrgList empty: %v", err)
	}
	if !strings.Contains(buf.String(), "No organizations") {
		t.Errorf("expected empty notice: %s", buf.String())
	}
}

func TestMatchOrg(t *testing.T) {
	orgs := sampleOrgs()
	if got := matchOrg(orgs, "o2"); got == nil || got.ID != "o2" {
		t.Errorf("match by id failed")
	}
	if got := matchOrg(orgs, "beta"); got == nil || got.ID != "o2" {
		t.Errorf("match by slug failed")
	}
	if got := matchOrg(orgs, "Acme"); got == nil || got.ID != "o1" {
		t.Errorf("match by name failed")
	}
	if got := matchOrg(orgs, "nope"); got != nil {
		t.Errorf("expected no match")
	}
}

func TestRunOrgSwitchPersists(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	t.Setenv("XDG_CONFIG_HOME", dir)
	prev := noInputMode
	noInputMode = false
	defer func() { noInputMode = prev }()

	var buf bytes.Buffer
	if err := runOrgSwitch(&fakeClient{orgs: sampleOrgs()}, &buf, "beta"); err != nil {
		t.Fatalf("runOrgSwitch: %v", err)
	}
	cfg := types.LoadCliConfig()
	if cfg.ActiveOrgID != "o2" || cfg.ActiveOrgSlug != "beta" {
		t.Errorf("active org not persisted: %+v", cfg)
	}
	if !strings.Contains(buf.String(), "Beta") {
		t.Errorf("expected confirmation: %s", buf.String())
	}
}

func TestRunOrgSwitchUnknownTarget(t *testing.T) {
	var buf bytes.Buffer
	if err := runOrgSwitch(&fakeClient{orgs: sampleOrgs()}, &buf, "ghost"); err == nil {
		t.Error("expected error for unknown org")
	}
}

func TestRunOrgSwitchNoOrgs(t *testing.T) {
	var buf bytes.Buffer
	if err := runOrgSwitch(&fakeClient{orgs: nil}, &buf, "x"); err == nil {
		t.Error("expected error when no orgs")
	}
}

// --- members ---

func TestRunMembersList(t *testing.T) {
	var buf bytes.Buffer
	members := []api.Member{
		{ID: "m1", UserID: "u1", Email: "a@x.com", Name: "A", Role: "owner", Status: "active"},
		{ID: "m2", UserID: "u2", Email: "b@x.com", Name: "B", Role: "member", Status: "active"},
	}
	if err := runMembersList(&fakeClient{members: members}, &buf, "table", "o1"); err != nil {
		t.Fatalf("runMembersList: %v", err)
	}
	for _, want := range []string{"a@x.com", "b@x.com", "owner", "active"} {
		if !strings.Contains(buf.String(), want) {
			t.Errorf("members missing %q:\n%s", want, buf.String())
		}
	}
}

func TestRunMembersListEmpty(t *testing.T) {
	var buf bytes.Buffer
	if err := runMembersList(&fakeClient{members: nil}, &buf, "table", "o1"); err != nil {
		t.Fatalf("runMembersList empty: %v", err)
	}
	if !strings.Contains(buf.String(), "No members") {
		t.Errorf("expected empty notice")
	}
}

func TestRunMembersAdd(t *testing.T) {
	var buf bytes.Buffer
	f := &fakeClient{}
	if err := runMembersAdd(f, &buf, "o1", "new@x.com", "member"); err != nil {
		t.Fatalf("runMembersAdd: %v", err)
	}
	if f.invitedEmail != "new@x.com" || f.invitedRole != "member" {
		t.Errorf("invite args not recorded: %q %q", f.invitedEmail, f.invitedRole)
	}
	if !strings.Contains(buf.String(), "new@x.com") {
		t.Errorf("expected confirmation: %s", buf.String())
	}
}

func TestRunMembersRemove(t *testing.T) {
	var buf bytes.Buffer
	f := &fakeClient{}
	if err := runMembersRemove(f, &buf, "o1", "m9"); err != nil {
		t.Fatalf("runMembersRemove: %v", err)
	}
	if f.removedMember != "m9" {
		t.Errorf("remove arg not recorded: %q", f.removedMember)
	}
}

// --- teams ---

func TestRunTeamsList(t *testing.T) {
	var buf bytes.Buffer
	teams := []api.Team{{ID: "t1", Name: "Platform", MemberCount: 3}}
	if err := runTeamsList(&fakeClient{teams: teams}, &buf, "table", "o1"); err != nil {
		t.Fatalf("runTeamsList: %v", err)
	}
	if !strings.Contains(buf.String(), "Platform") || !strings.Contains(buf.String(), "3") {
		t.Errorf("teams output: %s", buf.String())
	}
}

func TestRunTeamsCreate(t *testing.T) {
	var buf bytes.Buffer
	f := &fakeClient{}
	if err := runTeamsCreate(f, &buf, "o1", "SRE"); err != nil {
		t.Fatalf("runTeamsCreate: %v", err)
	}
	if f.createdName != "SRE" {
		t.Errorf("create arg not recorded: %q", f.createdName)
	}
	if !strings.Contains(buf.String(), "SRE") {
		t.Errorf("expected confirmation: %s", buf.String())
	}
}

func TestRunTeamsDelete(t *testing.T) {
	var buf bytes.Buffer
	f := &fakeClient{}
	if err := runTeamsDelete(f, &buf, "o1", "t9"); err != nil {
		t.Fatalf("runTeamsDelete: %v", err)
	}
	if f.deletedTeam != "t9" {
		t.Errorf("delete arg not recorded: %q", f.deletedTeam)
	}
}

// --- channels ---

func TestRunChannelsList(t *testing.T) {
	var buf bytes.Buffer
	channels := []api.Channel{
		{ID: "c1", Name: "ops", Type: "slack", IsVerified: true, Enabled: true},
		{ID: "c2", Name: "oncall", Type: "pagerduty", IsVerified: false, Enabled: false},
	}
	if err := runChannelsList(&fakeClient{channels: channels}, &buf, "table"); err != nil {
		t.Fatalf("runChannelsList: %v", err)
	}
	for _, want := range []string{"ops", "slack", "oncall", "pagerduty"} {
		if !strings.Contains(buf.String(), want) {
			t.Errorf("channels missing %q:\n%s", want, buf.String())
		}
	}
}

func TestRunChannelsListJSON(t *testing.T) {
	var buf bytes.Buffer
	channels := []api.Channel{{ID: "c1", Name: "ops", Type: "slack"}}
	if err := runChannelsList(&fakeClient{channels: channels}, &buf, "json"); err != nil {
		t.Fatalf("runChannelsList json: %v", err)
	}
	var got []api.Channel
	if err := json.Unmarshal(buf.Bytes(), &got); err != nil {
		t.Fatalf("invalid json: %v", err)
	}
	if len(got) != 1 || got[0].Name != "ops" {
		t.Errorf("unexpected channels: %+v", got)
	}
}

func TestRunChannelsListEmpty(t *testing.T) {
	var buf bytes.Buffer
	if err := runChannelsList(&fakeClient{channels: nil}, &buf, "table"); err != nil {
		t.Fatalf("runChannelsList empty: %v", err)
	}
	if !strings.Contains(buf.String(), "No notification channels") {
		t.Errorf("expected empty notice: %s", buf.String())
	}
}

func TestRunChannelsCreate(t *testing.T) {
	var buf bytes.Buffer
	f := &fakeClient{}
	cfg := map[string]interface{}{"url": "https://hooks.example.com"}
	if err := runChannelsCreate(f, &buf, "ops", "slack", cfg); err != nil {
		t.Fatalf("runChannelsCreate: %v", err)
	}
	if f.createdName != "ops" || f.createdChType != "slack" {
		t.Errorf("create args not recorded: %q %q", f.createdName, f.createdChType)
	}
	if f.createdChCfg["url"] != "https://hooks.example.com" {
		t.Errorf("config not forwarded: %+v", f.createdChCfg)
	}
	if !strings.Contains(buf.String(), "ops") {
		t.Errorf("expected confirmation: %s", buf.String())
	}
}

func TestRunChannelsVerify(t *testing.T) {
	var buf bytes.Buffer
	f := &fakeClient{}
	if err := runChannelsVerify(f, &buf, "c9"); err != nil {
		t.Fatalf("runChannelsVerify: %v", err)
	}
	if f.verifiedChID != "c9" {
		t.Errorf("verify arg not recorded: %q", f.verifiedChID)
	}
	if !strings.Contains(buf.String(), "Verified") {
		t.Errorf("expected confirmation: %s", buf.String())
	}
}

func TestRunChannelsDelete(t *testing.T) {
	var buf bytes.Buffer
	f := &fakeClient{}
	if err := runChannelsDelete(f, &buf, "c9"); err != nil {
		t.Fatalf("runChannelsDelete: %v", err)
	}
	if f.deletedChannel != "c9" {
		t.Errorf("delete arg not recorded: %q", f.deletedChannel)
	}
}

func TestRunChannelsListError(t *testing.T) {
	var buf bytes.Buffer
	if err := runChannelsList(&fakeClient{err: errBoom}, &buf, "table"); err == nil {
		t.Error("expected error propagated")
	}
}

// --- alerts ---

func TestRunAlertsList(t *testing.T) {
	var buf bytes.Buffer
	rules := []api.AlertRule{
		{ID: "a1", Name: "failures", Severity: "critical", EventPatterns: []string{"system.job.failed", "system.job.started"}, ChannelIDs: []string{"c1"}, Enabled: true},
	}
	if err := runAlertsList(&fakeClient{alertRules: rules}, &buf, "table"); err != nil {
		t.Fatalf("runAlertsList: %v", err)
	}
	// Events render as a count (2), not the joined patterns.
	for _, want := range []string{"failures", "critical", "2"} {
		if !strings.Contains(buf.String(), want) {
			t.Errorf("alerts missing %q:\n%s", want, buf.String())
		}
	}
	if strings.Contains(buf.String(), "system.job.failed") {
		t.Errorf("Events column should be a count, not the joined patterns:\n%s", buf.String())
	}
}

func TestRunAlertsListEmpty(t *testing.T) {
	var buf bytes.Buffer
	if err := runAlertsList(&fakeClient{alertRules: nil}, &buf, "table"); err != nil {
		t.Fatalf("runAlertsList empty: %v", err)
	}
	if !strings.Contains(buf.String(), "No alert rules") {
		t.Errorf("expected empty notice: %s", buf.String())
	}
}

func TestRunAlertsCreate(t *testing.T) {
	var buf bytes.Buffer
	f := &fakeClient{}
	if err := runAlertsCreate(f, &buf, "failures", []string{"system.job.failed"}, []string{"c1"}, "critical"); err != nil {
		t.Fatalf("runAlertsCreate: %v", err)
	}
	if f.createdRuleN != "failures" || f.createdRuleSev != "critical" {
		t.Errorf("create args not recorded: %q %q", f.createdRuleN, f.createdRuleSev)
	}
	if len(f.createdRulePat) != 1 || f.createdRulePat[0] != "system.job.failed" {
		t.Errorf("patterns not forwarded: %+v", f.createdRulePat)
	}
	if len(f.createdRuleCh) != 1 || f.createdRuleCh[0] != "c1" {
		t.Errorf("channels not forwarded: %+v", f.createdRuleCh)
	}
	if !strings.Contains(buf.String(), "failures") {
		t.Errorf("expected confirmation: %s", buf.String())
	}
}

func TestRunAlertsDelete(t *testing.T) {
	var buf bytes.Buffer
	f := &fakeClient{}
	if err := runAlertsDelete(f, &buf, "a9"); err != nil {
		t.Fatalf("runAlertsDelete: %v", err)
	}
	if f.deletedRule != "a9" {
		t.Errorf("delete arg not recorded: %q", f.deletedRule)
	}
}

// --- activity ---

func TestRunActivity(t *testing.T) {
	var buf bytes.Buffer
	entries := []api.ActivityEntry{
		{ID: "1", ActorID: "u1", ActorEmail: "ada@x.com", Action: "deploy", ResourceType: "project", Decision: true, Ts: "2026-01-01T00:00:00Z"},
		{ID: "2", ActorID: "u2", Action: "destroy", ResourceType: "runner", Decision: false, Ts: "2026-01-01T00:00:00Z"},
	}
	f := &fakeClient{activity: entries}
	if err := runActivity(f, &buf, "table", 25); err != nil {
		t.Fatalf("runActivity: %v", err)
	}
	if f.activityLimit != 25 {
		t.Errorf("limit not forwarded: %d", f.activityLimit)
	}
	for _, want := range []string{"ada@x.com", "deploy", "allow", "u2", "deny"} {
		if !strings.Contains(buf.String(), want) {
			t.Errorf("activity missing %q:\n%s", want, buf.String())
		}
	}
}

func TestRunActivityEmpty(t *testing.T) {
	var buf bytes.Buffer
	if err := runActivity(&fakeClient{activity: nil}, &buf, "table", 0); err != nil {
		t.Fatalf("runActivity empty: %v", err)
	}
	if !strings.Contains(buf.String(), "No activity") {
		t.Errorf("expected empty notice: %s", buf.String())
	}
}

func TestRunActivityError(t *testing.T) {
	var buf bytes.Buffer
	if err := runActivity(&fakeClient{err: errBoom}, &buf, "table", 0); err == nil {
		t.Error("expected error propagated")
	}
}

// --- roles ---

func sampleRoles() []api.Role {
	return []api.Role{
		{ID: "r1", Name: "owner", IsBuiltin: true, PermissionKeys: []string{"org:view", "org:edit"}},
		{ID: "r2", Name: "deployers", IsBuiltin: false, PermissionKeys: []string{"project:deploy"}},
	}
}

func TestRunRolesList(t *testing.T) {
	var buf bytes.Buffer
	if err := runRolesList(&fakeClient{roles: sampleRoles()}, &buf, "table"); err != nil {
		t.Fatalf("runRolesList: %v", err)
	}
	// "●" and not ui.SymbolDefault: the Builtin column is ui.YesNo, which stopped answering with
	// the "this is the default one" badge when #3660 put booleans on the status vocabulary.
	for _, want := range []string{"owner", "deployers", "●", "2"} {
		if !strings.Contains(buf.String(), want) {
			t.Errorf("roles missing %q:\n%s", want, buf.String())
		}
	}
}

func TestRunRolesListJSON(t *testing.T) {
	var buf bytes.Buffer
	if err := runRolesList(&fakeClient{roles: sampleRoles()}, &buf, "json"); err != nil {
		t.Fatalf("runRolesList json: %v", err)
	}
	var got []api.Role
	if err := json.Unmarshal(buf.Bytes(), &got); err != nil {
		t.Fatalf("invalid json: %v", err)
	}
	if len(got) != 2 || got[0].Name != "owner" {
		t.Errorf("unexpected roles: %+v", got)
	}
}

func TestRunRolesListEmpty(t *testing.T) {
	var buf bytes.Buffer
	if err := runRolesList(&fakeClient{roles: nil}, &buf, "table"); err != nil {
		t.Fatalf("runRolesList empty: %v", err)
	}
	if !strings.Contains(buf.String(), "No roles") {
		t.Errorf("expected empty notice: %s", buf.String())
	}
}

func TestRunRolesListError(t *testing.T) {
	var buf bytes.Buffer
	if err := runRolesList(&fakeClient{err: errBoom}, &buf, "table"); err == nil {
		t.Error("expected error propagated")
	}
}

func TestRunRolesCreate(t *testing.T) {
	var buf bytes.Buffer
	f := &fakeClient{}
	if err := runRolesCreate(f, &buf, "deployers", []string{"project:deploy"}); err != nil {
		t.Fatalf("runRolesCreate: %v", err)
	}
	if f.createdRoleN != "deployers" || len(f.createdRoleKey) != 1 || f.createdRoleKey[0] != "project:deploy" {
		t.Errorf("create args not recorded: %q %+v", f.createdRoleN, f.createdRoleKey)
	}
	if !strings.Contains(buf.String(), "deployers") {
		t.Errorf("expected confirmation: %s", buf.String())
	}
}

func TestRunRolesDelete(t *testing.T) {
	var buf bytes.Buffer
	f := &fakeClient{}
	if err := runRolesDelete(f, &buf, "r9"); err != nil {
		t.Fatalf("runRolesDelete: %v", err)
	}
	if f.deletedRole != "r9" {
		t.Errorf("delete arg not recorded: %q", f.deletedRole)
	}
}

// --- grants ---

func sampleGrants() []api.Grant {
	return []api.Grant{
		{ID: "g1", PrincipalType: "user", PrincipalID: "u1", Effect: "allow", Role: "deployers", ResourceType: "project", ResourceID: "p1"},
		{ID: "g2", PrincipalType: "team", PrincipalID: "t1", Effect: "deny", PermissionKey: "project:destroy", ResourceType: "org"},
	}
}

func TestRunGrantsList(t *testing.T) {
	var buf bytes.Buffer
	if err := runGrantsList(&fakeClient{grants: sampleGrants()}, &buf, "table"); err != nil {
		t.Fatalf("runGrantsList: %v", err)
	}
	for _, want := range []string{"user u1", "deployers", "project (p1)", "deny", "project:destroy", "team t1"} {
		if !strings.Contains(buf.String(), want) {
			t.Errorf("grants missing %q:\n%s", want, buf.String())
		}
	}
}

func TestRunGrantsListEmpty(t *testing.T) {
	var buf bytes.Buffer
	if err := runGrantsList(&fakeClient{grants: nil}, &buf, "table"); err != nil {
		t.Fatalf("runGrantsList empty: %v", err)
	}
	if !strings.Contains(buf.String(), "No access grants") {
		t.Errorf("expected empty notice: %s", buf.String())
	}
}

func TestRunGrantsListError(t *testing.T) {
	var buf bytes.Buffer
	if err := runGrantsList(&fakeClient{err: errBoom}, &buf, "table"); err == nil {
		t.Error("expected error propagated")
	}
}

func TestRunGrantsAdd(t *testing.T) {
	var buf bytes.Buffer
	f := &fakeClient{}
	params := api.AddGrantParams{PrincipalType: "user", PrincipalID: "u1", Effect: "allow", PermissionKey: "project:deploy", ResourceType: "org"}
	if err := runGrantsAdd(f, &buf, params); err != nil {
		t.Fatalf("runGrantsAdd: %v", err)
	}
	if f.addedGrant.PrincipalID != "u1" || f.addedGrant.PermissionKey != "project:deploy" {
		t.Errorf("add args not recorded: %+v", f.addedGrant)
	}
	if !strings.Contains(buf.String(), "project:deploy") {
		t.Errorf("expected confirmation: %s", buf.String())
	}
}

func TestRunGrantsAddRole(t *testing.T) {
	var buf bytes.Buffer
	f := &fakeClient{createdGr: &api.Grant{ID: "g9", Effect: "allow", Role: "deployers", ResourceType: "org"}}
	params := api.AddGrantParams{PrincipalType: "team", PrincipalID: "t1", Effect: "allow", RoleID: "r2", ResourceType: "org"}
	if err := runGrantsAdd(f, &buf, params); err != nil {
		t.Fatalf("runGrantsAdd role: %v", err)
	}
	if !strings.Contains(buf.String(), "deployers") {
		t.Errorf("expected role name in confirmation: %s", buf.String())
	}
}

func TestRunGrantsRemove(t *testing.T) {
	var buf bytes.Buffer
	f := &fakeClient{}
	if err := runGrantsRemove(f, &buf, "g9"); err != nil {
		t.Fatalf("runGrantsRemove: %v", err)
	}
	if f.removedGrant != "g9" {
		t.Errorf("remove arg not recorded: %q", f.removedGrant)
	}
}

// --- sso ---

func sampleSso() []api.SsoProvider {
	return []api.SsoProvider{
		{ID: "s1", ProviderType: "oidc", Domain: "acme.com", Issuer: "https://idp.acme.com", Enabled: true},
		{ID: "s2", ProviderType: "saml", Domain: "beta.com", Issuer: "https://idp.beta.com", Enabled: false},
	}
}

func TestRunSsoList(t *testing.T) {
	var buf bytes.Buffer
	if err := runSsoList(&fakeClient{ssoProvs: sampleSso()}, &buf, "table"); err != nil {
		t.Fatalf("runSsoList: %v", err)
	}
	for _, want := range []string{"oidc", "acme.com", "saml", "beta.com"} {
		if !strings.Contains(buf.String(), want) {
			t.Errorf("sso missing %q:\n%s", want, buf.String())
		}
	}
}

func TestRunSsoListEmpty(t *testing.T) {
	var buf bytes.Buffer
	if err := runSsoList(&fakeClient{ssoProvs: nil}, &buf, "table"); err != nil {
		t.Fatalf("runSsoList empty: %v", err)
	}
	if !strings.Contains(buf.String(), "No SSO providers") {
		t.Errorf("expected empty notice: %s", buf.String())
	}
}

func TestRunSsoListError(t *testing.T) {
	var buf bytes.Buffer
	if err := runSsoList(&fakeClient{err: errBoom}, &buf, "table"); err == nil {
		t.Error("expected error propagated")
	}
}

func TestRenderSsoProviderTable(t *testing.T) {
	var buf bytes.Buffer
	p := &api.SsoProvider{ID: "s1", ProviderType: "oidc", Domain: "acme.com", Issuer: "https://idp.acme.com", Enabled: true}
	if err := renderSsoProvider(&buf, "table", p); err != nil {
		t.Fatalf("renderSsoProvider table: %v", err)
	}
	for _, want := range []string{"s1", "oidc", "acme.com", "https://idp.acme.com"} {
		if !strings.Contains(buf.String(), want) {
			t.Errorf("sso card missing %q:\n%s", want, buf.String())
		}
	}
}

func TestRenderSsoProviderJSON(t *testing.T) {
	var buf bytes.Buffer
	p := &api.SsoProvider{ID: "s1", ProviderType: "saml", Domain: "acme.com"}
	if err := renderSsoProvider(&buf, "json", p); err != nil {
		t.Fatalf("renderSsoProvider json: %v", err)
	}
	var got api.SsoProvider
	if err := json.Unmarshal(buf.Bytes(), &got); err != nil {
		t.Fatalf("invalid json: %v", err)
	}
	if got.ID != "s1" || got.ProviderType != "saml" {
		t.Errorf("unexpected provider: %+v", got)
	}
}

func TestYesNo(t *testing.T) {
	// `◆ / —` until #3660. The "no" arm was the EMPTY-VALUE SENTINEL, so a channel that is switched
	// off and one whose `enabled` field never arrived printed the same cell; a boolean now borrows
	// the two tiers that already mean present-and-active and present-and-inert.
	if ui.YesNo(true) != "●" {
		t.Errorf("ui.YesNo(true) = %q, want the active dot", ui.YesNo(true))
	}
	if ui.YesNo(false) != "◌" {
		t.Errorf("ui.YesNo(false) = %q, want the disabled tier's dotted outline", ui.YesNo(false))
	}
	if ui.YesNo(false) == ui.SymbolDash {
		t.Error("ui.YesNo(false) is the empty-value sentinel — 'no' and 'we could not read this' must not be one cell")
	}
}

// --- config ---

func TestRunConfigShow(t *testing.T) {
	var buf bytes.Buffer
	cfg := types.CliConfig{ActiveOrgID: "o1", ActiveOrgName: "Acme", ActiveOrgSlug: "acme"}
	if err := runConfigShow(&buf, "table", "https://app.example.com", types.WebOriginFromConfig, cfg, "/creds.json", "/config.json"); err != nil {
		t.Fatalf("runConfigShow: %v", err)
	}
	for _, want := range []string{"https://app.example.com", "Acme", "/creds.json", "/config.json"} {
		if !strings.Contains(buf.String(), want) {
			t.Errorf("config missing %q:\n%s", want, buf.String())
		}
	}
}

func TestRunConfigShowJSON(t *testing.T) {
	var buf bytes.Buffer
	if err := runConfigShow(&buf, "json", "https://app", types.WebOriginFromDefault, types.CliConfig{}, "/c", "/cfg"); err != nil {
		t.Fatalf("runConfigShow json: %v", err)
	}
	var v configView
	if err := json.Unmarshal(buf.Bytes(), &v); err != nil {
		t.Fatalf("invalid json: %v", err)
	}
	if v.WebOrigin != "https://app" {
		t.Errorf("unexpected: %+v", v)
	}
}

func TestOrDash(t *testing.T) {
	if ui.OrDash("x") != "x" {
		t.Errorf("orDash passthrough failed")
	}
	if ui.OrDash("") != ui.SymbolDash {
		t.Errorf("orDash empty should yield the dash glyph, got %q", ui.OrDash(""))
	}
}

// --- render helpers (list commands) ---

func TestRenderProjects(t *testing.T) {
	var buf bytes.Buffer
	cost := 42.0
	configs := []types.ConfigurationSummary{
		{ProjectName: "web", EnvironmentStage: "production", CloudProvider: "aws", Region: "eu-west-1", Status: "ACTIVE", EstimatedMonthlyCost: &cost, UpdatedAt: time.Now()},
	}
	if err := renderProjects(&buf, "table", configs); err != nil {
		t.Fatalf("renderProjects: %v", err)
	}
	// `$42.00/mo`, not `$42/mo`: #3659 moved this cell onto format.MonthlyRate, whose Estimate
	// register keeps the minor units above one unit. The old `%.0f` was the half-to-even defect.
	for _, want := range []string{"web", "production", "AWS", "eu-west-1", "$42.00/mo"} {
		if !strings.Contains(buf.String(), want) {
			t.Errorf("projects missing %q:\n%s", want, buf.String())
		}
	}
}

func TestRenderProjectsEmpty(t *testing.T) {
	var buf bytes.Buffer
	if err := renderProjects(&buf, "table", nil); err != nil {
		t.Fatalf("renderProjects empty: %v", err)
	}
	if !strings.Contains(buf.String(), "No projects") {
		t.Errorf("expected empty notice")
	}
}

func TestRenderRunners(t *testing.T) {
	var buf bytes.Buffer
	runners := []api.Runner{
		{Name: "r1", Operator: "managed", Status: "ONLINE", Version: "1.2.3", IsDefault: true, LastHeartbeat: "now"},
		{Name: "r2", Operator: "self", Provisioning: "registered", Status: "OFFLINE"},
	}
	if err := renderRunners(&buf, "table", runners); err != nil {
		t.Fatalf("renderRunners: %v", err)
	}
	for _, want := range []string{"r1", "managed", "self·registered", "online"} {
		if !strings.Contains(buf.String(), want) {
			t.Errorf("runners missing %q:\n%s", want, buf.String())
		}
	}
}

func TestRenderClusters(t *testing.T) {
	var buf bytes.Buffer
	clusters := []api.ClusterSummary{
		{ClusterName: "prod", ClusterVersion: "1.30", Status: "ACTIVE", NodeMinSize: 1, NodeDesiredSize: 2, NodeMaxSize: 5, Region: "eu", ProjectName: "web", Environment: "production"},
	}
	if err := renderClusters(&buf, "table", clusters); err != nil {
		t.Fatalf("renderClusters: %v", err)
	}
	for _, want := range []string{"prod", "1.30", "web (production)", "1/2/5"} {
		if !strings.Contains(buf.String(), want) {
			t.Errorf("clusters missing %q:\n%s", want, buf.String())
		}
	}
}

func TestRenderCloudIdentities(t *testing.T) {
	var buf bytes.Buffer
	ids := []api.CloudIdentity{{Provider: "aws", Label: "prod-account", CreatedAt: ""}}
	if err := renderCloudIdentities(&buf, "table", ids); err != nil {
		t.Fatalf("renderCloudIdentities: %v", err)
	}
	if !strings.Contains(buf.String(), "AWS") || !strings.Contains(buf.String(), "prod-account") {
		t.Errorf("identities output: %s", buf.String())
	}
}

func TestRenderJobs(t *testing.T) {
	var buf bytes.Buffer
	jobs := []api.ProvisionJob{
		{JobType: "PLAN", Status: "SUCCESS", ProjectName: "web", RunnerName: "r1", CreatedAt: time.Now()},
	}
	if err := renderJobs(&buf, "table", jobs); err != nil {
		t.Fatalf("renderJobs: %v", err)
	}
	for _, want := range []string{"Plan", "SUCCESS", "web", "r1"} {
		if !strings.Contains(buf.String(), want) {
			t.Errorf("jobs missing %q:\n%s", want, buf.String())
		}
	}
}

func TestRenderJobJSON(t *testing.T) {
	var buf bytes.Buffer
	job := &api.ProvisionJob{ID: "j1", JobType: "DEPLOY", Status: "PROCESSING", CreatedAt: time.Now()}
	if err := renderJob(&buf, "json", job); err != nil {
		t.Fatalf("renderJob json: %v", err)
	}
	var got api.ProvisionJob
	if err := json.Unmarshal(buf.Bytes(), &got); err != nil {
		t.Fatalf("invalid json: %v", err)
	}
	if got.ID != "j1" {
		t.Errorf("unexpected job: %+v", got)
	}
}

func TestRenderJobTable(t *testing.T) {
	var buf bytes.Buffer
	msg := "boom"
	job := &api.ProvisionJob{ID: "j1", JobType: "DEPLOY", Status: "FAILED", CreatedAt: time.Now(), ErrorMessage: &msg}
	if err := renderJob(&buf, "table", job); err != nil {
		t.Fatalf("renderJob table: %v", err)
	}
	for _, want := range []string{"j1", "DEPLOY", "FAILED", "boom"} {
		if !strings.Contains(buf.String(), want) {
			t.Errorf("job table missing %q:\n%s", want, buf.String())
		}
	}
}
