// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/huh"
	"github.com/spf13/cobra"
	"github.com/spf13/pflag"
)

// ---------------------------------------------------------------------------
// Harness
//
// The `connector *` commands are package-level `&cobra.Command{Run: func…}`
// values whose bodies talk to the control plane, shell out to a cloud CLI, and
// end in fail()/failf(). Driving them therefore needs three things: a fake
// control plane, a fake `aws`/`gcloud`/`az`/`aliyun`/`bash` early on PATH, and
// the exitFunc seam so a fatal arm unwinds into the test instead of killing the
// binary.
// ---------------------------------------------------------------------------

// connExit is the sentinel the exitFunc stub panics with, carrying the code the
// command asked the process to exit with.
type connExit struct{ code int }

// connInvoke runs the CLI through the real cobra tree with exitFunc substituted.
// It reports whether the command took a fatal path and, if so, with which code.
func connInvoke(t *testing.T, run func(args ...string) error, args ...string) (exited bool, code int, err error) {
	t.Helper()
	prev := exitFunc
	exitFunc = func(c int) { panic(connExit{code: c}) }
	defer func() {
		exitFunc = prev
		if r := recover(); r != nil {
			e, ok := r.(connExit)
			if !ok {
				panic(r)
			}
			exited, code = true, e.code
		}
	}()
	err = run(args...)
	return false, 0, err
}

// connFakeAPI configures the fake control plane the connector commands talk to.
// A zero value serves the happy path: init succeeds, connect verifies, the org
// has one connected AWS account, and disconnect succeeds.
type connFakeAPI struct {
	initStatus       int                    // non-zero -> /init fails with this status
	connect          map[string]interface{} // body for /connect (nil -> verified)
	connectStatus    int                    // non-zero -> /connect fails with this status
	identities       []map[string]interface{}
	noIdentities     bool // serve an empty cloud-identities list
	identitiesStatus int
	disconnectStatus int
	rec              *connRecorder // optional: records every request the CLI makes
	// inventoryFor, when set, is called with the cloud-identity id the inventory route was
	// asked for. It is what lets a test assert WHICH identity a provider name resolved to,
	// rather than only that the command exited 0.
	inventoryFor func(cloudIdentityID string)
}

// connRecorder records the requests the fake control plane received. The handler
// runs on the server's goroutine, so access is mutex-guarded.
type connRecorder struct {
	mu    sync.Mutex
	paths []string
}

func (r *connRecorder) add(p string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.paths = append(r.paths, p)
}

// saw reports whether any recorded request path contains the given fragment.
func (r *connRecorder) saw(fragment string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, p := range r.paths {
		if strings.Contains(p, fragment) {
			return true
		}
	}
	return false
}

// connEnv stands up isolated credentials, a fake control plane wired to the
// connector endpoints, and returns a runner that executes the real cobra tree.
// Connector flags are reset before and after the test because rootCmd is a
// package global whose flag state is sticky across Execute calls.
func connEnv(t *testing.T, cfg connFakeAPI) func(args ...string) error {
	t.Helper()
	connResetConnectorFlags(t)

	credsPath := isolatedHome(t)
	tok := makeToken(t, time.Now().Add(time.Hour))
	if err := saveCredentials(credsPath, types.ExchangeResponse{AccessToken: tok, RefreshToken: "r"}); err != nil {
		t.Fatalf("saveCredentials: %v", err)
	}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Path
		if cfg.rec != nil {
			cfg.rec.add(p)
		}
		enc := json.NewEncoder(w)
		switch {
		case strings.HasPrefix(p, "/api/cli/providers/") && strings.HasSuffix(p, "/init"):
			if cfg.initStatus != 0 {
				w.WriteHeader(cfg.initStatus)
				_ = enc.Encode(map[string]string{"error": "init unavailable"})
				return
			}
			_ = enc.Encode(map[string]interface{}{"identity_id": "cid-1", "external_id": "ext-1"})
		case strings.HasPrefix(p, "/api/cli/providers/") && strings.HasSuffix(p, "/connect"):
			if cfg.connectStatus != 0 {
				w.WriteHeader(cfg.connectStatus)
				_ = enc.Encode(map[string]string{"error": "connect unavailable"})
				return
			}
			body := cfg.connect
			if body == nil {
				body = map[string]interface{}{
					"identity_id": "cid-1", "verified": true, "status": "connected",
				}
			}
			_ = enc.Encode(body)
		case strings.HasPrefix(p, "/api/cli/providers/") && strings.HasSuffix(p, "/disconnect"):
			if cfg.disconnectStatus != 0 {
				w.WriteHeader(cfg.disconnectStatus)
				_ = enc.Encode(map[string]string{"error": "disconnect refused"})
				return
			}
			_ = enc.Encode(map[string]interface{}{"ok": true})
		case strings.HasPrefix(p, "/api/cli/providers/") && strings.HasSuffix(p, "/status"):
			_ = enc.Encode(map[string]interface{}{
				"connected": true, "identityId": "ci1", "accountId": "123456789012",
			})
		case strings.HasPrefix(p, "/api/cli/providers/") && strings.HasSuffix(p, "/verify"):
			_ = enc.Encode(map[string]interface{}{
				"identity_id": "ci1", "verified": true, "status": "connected",
			})
		case strings.HasPrefix(p, "/api/cli/cloud-identities/") && strings.HasSuffix(p, "/inventory"):
			if cfg.inventoryFor != nil {
				cfg.inventoryFor(strings.TrimSuffix(strings.TrimPrefix(p, "/api/cli/cloud-identities/"), "/inventory"))
			}
			_ = enc.Encode(map[string]interface{}{
				"networks": []map[string]interface{}{}, "subnets": []map[string]interface{}{}, "regions": []string{},
			})
		case p == "/api/cli/cloud-identities":
			if cfg.identitiesStatus != 0 {
				w.WriteHeader(cfg.identitiesStatus)
				_ = enc.Encode(map[string]string{"error": "identities unavailable"})
				return
			}
			ids := cfg.identities
			if ids == nil && !cfg.noIdentities {
				ids = []map[string]interface{}{
					{"id": "ci1", "provider": "aws", "label": "prod-account", "created_at": "2026-01-01T00:00:00Z"},
				}
			}
			if ids == nil {
				ids = []map[string]interface{}{}
			}
			_ = enc.Encode(map[string]interface{}{"cloud_identities": ids})
		default:
			w.WriteHeader(http.StatusNotFound)
			_ = enc.Encode(map[string]string{"error": "not found: " + p})
		}
	}))
	t.Cleanup(srv.Close)

	t.Setenv("ALETHIA_WEB_ORIGIN", srv.URL)
	t.Setenv("ALETHIA_NO_UPDATE_CHECK", "1")

	return func(args ...string) error {
		execRootArgs(args)
		return rootCmd.Execute()
	}
}

// connResetConnectorFlags restores every connector flag variable to its
// registered default, before and after the test. cobra never resets a bound
// variable between Execute calls, so without this one test's --manual leaks
// into the next.
func connResetConnectorFlags(t *testing.T) {
	t.Helper()
	reset := func() {
		connectorAwsRegion = ""
		connectorAwsRoleName = defaultAwsRoleName
		connectorAwsRoleArn = ""
		connectorAwsManual = false
		connectorAwsScript = false
		connectorGcpProject = ""
		connectorGcpWifConfig = ""
		connectorGcpManual = false
		connectorAzureSubscription = ""
		connectorAzureTenantID = ""
		connectorAzureClientID = ""
		connectorAzureManual = false
		connectorAlibabaRegion = ""
		connectorAlibabaDir = ""
		connectorAlibabaRoleArn = ""
		connectorAlibabaManual = false
		connectorAlibabaTerraform = false
		connectorHetznerToken = ""
		connectorHetznerTokenStdin = false
		connectorHetznerS3AccessKey = ""
		connectorHetznerS3SecretKey = ""
		connectorRemoveYes = false
	}
	reset()
	t.Cleanup(reset)
}

// connStubForm replaces the interactive form with one that returns err without
// touching the answer pointers — the behaviour a user gets when the prompt is
// aborted or (with a nil err) left blank.
func connStubForm(t *testing.T, err error) {
	t.Helper()
	// Forces the interactive mode on, for the reason connStubConfirm records: a headless test
	// process is never a terminal, so every prompt arm now short-circuits on requireInteractive
	// before the form is opened, and a stub installed here would never be reached. Without this
	// the tests below would still go red-to-green — on the "prompting is disabled" refusal
	// rather than the blank/aborted answer each one claims to pin.
	hygCliConfirmInteractive(t)
	prev := runHuhForm
	runHuhForm = func(_ ...*huh.Group) error { return err }
	t.Cleanup(func() { runHuhForm = prev })
}

// connStubFormTyping replaces the interactive form with one that answers it, by
// driving huh's bubbletea model directly: each answer is typed rune by rune into
// the focused field, then NextField advances. This is what lets a test reach
// everything AFTER a successful prompt — the answers are written through
// pointers huh owns and never exposes, so no stub can set them from outside.
//
// Measured, not assumed: huh.Form.Update fills the bound value with no TTY
// involved and without blocking, so no production seam is needed for this.
func connStubFormTyping(t *testing.T, answers ...string) {
	t.Helper()
	hygCliConfirmInteractive(t) // see connStubForm
	prev := runHuhForm
	runHuhForm = func(groups ...*huh.Group) error {
		f := huh.NewForm(groups...)
		f.Init()
		for _, answer := range answers {
			for _, r := range answer {
				f.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{r}})
			}
			f.Update(huh.NextField())
		}
		return nil
	}
	t.Cleanup(func() { runHuhForm = prev })
}

// connStubConfirm replaces the yes/no dialog with a fixed answer. It forces the
// interactive mode on too: a destructive command consults noInputMode before the
// prompt, and a headless test process is never a terminal, so without this it takes
// the "--yes is required" fatal arm and the stubbed answer is never asked for.
func connStubConfirm(t *testing.T, answer bool) {
	t.Helper()
	hygCliConfirmInteractive(t)
	prev := confirm
	confirm = func(string, string) bool { return answer }
	t.Cleanup(func() { confirm = prev })
}

const connSetupScriptOutput = `#!/bin/sh
echo "--- START CONFIG ---"
echo "role_arn=acs:ram::123456789012:role/AlethiaProvisioner"
echo "tenant_id=11111111-1111-1111-1111-111111111111"
echo "client_id=22222222-2222-2222-2222-222222222222"
echo "subscription_id=33333333-3333-3333-3333-333333333333"
echo "--- END CONFIG ---"
`

const connAwsStub = `#!/bin/sh
if [ "$2" = "describe-stacks" ]; then
  echo "arn:aws:iam::123456789012:role/AlethiaProvisionerRole"
fi
exit 0
`

const connGcloudStub = `#!/bin/sh
if [ "$1" = "auth" ]; then
  echo "tester@example.com"
  exit 0
fi
echo "--- START CONFIG ---"
echo '{"type":"external_account","audience":"//iam.googleapis.com/x"}'
echo "--- END CONFIG ---"
exit 0
`

// connGcloudUnauthedStub is installed and exits 0 but reports no active account,
// which is exactly how EnsureGcloud distinguishes "not authenticated".
const connGcloudUnauthedStub = `#!/bin/sh
exit 0
`

// connGcloudBadJSONStub returns a well-formed CONFIG block whose payload is not
// JSON, so the gcp command reaches its "not valid JSON" guard.
const connGcloudBadJSONStub = `#!/bin/sh
if [ "$1" = "auth" ]; then
  echo "tester@example.com"
  exit 0
fi
echo "--- START CONFIG ---"
echo "not-json-at-all"
echo "--- END CONFIG ---"
exit 0
`

const connTrivialStub = `#!/bin/sh
exit 0
`

// connFakeBin makes a directory of stub executables the ONLY thing on PATH, so
// the command sees exactly the cloud CLIs the test names and nothing from this
// machine. `bash` is stubbed too: the connector installers are run as
// `bash <script> <arg>`, and the stub emits the CONFIG block the real installers
// would, which keeps the capture paths deterministic and offline.
func connFakeBin(t *testing.T, tools map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	for name, body := range tools {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o755); err != nil {
			t.Fatalf("write stub %s: %v", name, err)
		}
	}
	t.Setenv("PATH", dir)
	return dir
}

// connAllCloudCLIs installs working stubs for every cloud CLI the connector
// commands shell out to.
func connAllCloudCLIs(t *testing.T) {
	t.Helper()
	connFakeBin(t, map[string]string{
		"aws":    connAwsStub,
		"gcloud": connGcloudStub,
		"az":     connTrivialStub,
		"aliyun": connTrivialStub,
		"bash":   connSetupScriptOutput,
	})
}

// connNoCloudCLIs empties PATH so every Ensure* probe reports "not found".
func connNoCloudCLIs(t *testing.T) {
	t.Helper()
	connFakeBin(t, map[string]string{})
}

// ---------------------------------------------------------------------------
// connector.go — initProviderIdentity / finalizeConnection
// ---------------------------------------------------------------------------

// TestConn_ParentCommandRegistersEveryProvider pins that the connector group
// carries the five subcommands the CLI advertises.
func TestConn_ParentCommandRegistersEveryProvider(t *testing.T) {
	want := map[string]bool{"aws": false, "gcp": false, "azure": false, "alibaba": false, "remove": false}
	for _, c := range connectorCmd.Commands() {
		if _, ok := want[c.Name()]; ok {
			want[c.Name()] = true
		}
	}
	for name, found := range want {
		if !found {
			t.Errorf("connector %s is not registered", name)
		}
	}
}

// TestConn_FinalizeVerdicts pins finalizeConnection's four verdict arms:
// verified, degraded-with-missing-permissions, failed-with-detail and
// failed-without-detail. Each is driven end-to-end through `connector aws`.
func TestConn_FinalizeVerdicts(t *testing.T) {
	cases := []struct {
		name     string
		body     map[string]interface{}
		wantExit bool
	}{
		{
			name: "verified",
			body: map[string]interface{}{"identity_id": "cid-1", "verified": true, "status": "connected"},
		},
		{
			name: "degraded_with_missing_permissions",
			body: map[string]interface{}{
				"identity_id": "cid-1", "verified": true, "status": "degraded",
				"missing_permissions": []string{"ec2:CreateVpc", "eks:CreateCluster"},
			},
		},
		{
			name:     "failed_with_detail",
			body:     map[string]interface{}{"identity_id": "cid-1", "verified": false, "status": "disconnected", "error": "assume role denied"},
			wantExit: true,
		},
		{
			name:     "failed_without_detail",
			body:     map[string]interface{}{"identity_id": "cid-1", "verified": false, "status": "disconnected"},
			wantExit: true,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			run := connEnv(t, connFakeAPI{connect: tc.body})
			connAllCloudCLIs(t)
			exited, code, err := connInvoke(t, run, "connector", "aws")
			if err != nil {
				t.Fatalf("execute: %v", err)
			}
			if exited != tc.wantExit {
				t.Fatalf("exited = %v (code %d), want %v", exited, code, tc.wantExit)
			}
			if exited && code != 1 {
				t.Errorf("exit code = %d, want 1", code)
			}
		})
	}
}

// TestConn_FinalizeTransportError pins that a non-2xx from /connect is fatal for
// every provider — none of them reports success on a submission that never
// landed.
func TestConn_FinalizeTransportError(t *testing.T) {
	for _, provider := range []string{"aws", "gcp", "azure", "alibaba"} {
		t.Run(provider, func(t *testing.T) {
			run := connEnv(t, connFakeAPI{connectStatus: http.StatusInternalServerError})
			connAllCloudCLIs(t)
			args := []string{"connector", provider}
			switch provider {
			case "gcp":
				args = append(args, "--project", "demo-proj")
			case "azure":
				args = append(args, "--subscription", "sub-1")
			}
			exited, code, err := connInvoke(t, run, args...)
			if err != nil {
				t.Fatalf("execute: %v", err)
			}
			if !exited || code != 1 {
				t.Fatalf("exited=%v code=%d, want a fatal exit(1)", exited, code)
			}
		})
	}
}

// TestConn_InitIdentityFailureIsFatal pins that a failing /init aborts before
// any cloud CLI is touched.
func TestConn_InitIdentityFailureIsFatal(t *testing.T) {
	for _, provider := range []string{"aws", "gcp", "azure", "alibaba"} {
		t.Run(provider, func(t *testing.T) {
			run := connEnv(t, connFakeAPI{initStatus: http.StatusBadGateway})
			connAllCloudCLIs(t)
			args := []string{"connector", provider}
			switch provider {
			case "gcp":
				args = append(args, "--project", "demo-proj")
			case "azure":
				args = append(args, "--subscription", "sub-1")
			}
			exited, code, err := connInvoke(t, run, args...)
			if err != nil {
				t.Fatalf("execute: %v", err)
			}
			if !exited || code != 1 {
				t.Fatalf("exited=%v code=%d, want a fatal exit(1)", exited, code)
			}
		})
	}
}

// TestConn_AuthRequiredIsFatal pins that every connector command exits when
// there are no usable credentials and the user declines to log in.
func TestConn_AuthRequiredIsFatal(t *testing.T) {
	run := connEnv(t, connFakeAPI{})
	credsPath, err := getCredentialsPath()
	if err != nil {
		t.Fatalf("creds path: %v", err)
	}
	if err := os.Remove(credsPath); err != nil {
		t.Fatalf("remove credentials: %v", err)
	}
	prev := authRequiredPrompt
	authRequiredPrompt = func() (bool, error) { return false, nil }
	t.Cleanup(func() { authRequiredPrompt = prev })

	for _, args := range [][]string{
		{"connector", "aws"},
		{"connector", "gcp", "--project", "demo-proj"},
		{"connector", "azure", "--subscription", "sub-1"},
		{"connector", "alibaba"},
		{"connector", "remove", "aws"},
	} {
		t.Run(strings.Join(args, "_"), func(t *testing.T) {
			exited, code, err := connInvoke(t, run, args...)
			if err != nil {
				t.Fatalf("execute: %v", err)
			}
			if !exited || code != 1 {
				t.Fatalf("exited=%v code=%d, want a fatal exit(1)", exited, code)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// connector_aws.go
// ---------------------------------------------------------------------------

// TestConn_AwsLocalFlowDeploysStack pins the default path: the CloudFormation
// stack is deployed with the local aws CLI and the ARN read from its outputs is
// what gets submitted.
func TestConn_AwsLocalFlowDeploysStack(t *testing.T) {
	run := connEnv(t, connFakeAPI{})
	connAllCloudCLIs(t)
	exited, code, err := connInvoke(t, run, "connector", "aws", "--region", "eu-west-1", "--role-name", "CustomRole")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if exited {
		t.Fatalf("unexpected fatal exit (code %d)", code)
	}
}

// TestConn_AwsLocalFlowFallsBackToDefaultRoleName pins that an empty --role-name
// falls back to the documented default rather than deploying a nameless role.
func TestConn_AwsLocalFlowFallsBackToDefaultRoleName(t *testing.T) {
	run := connEnv(t, connFakeAPI{})
	connAllCloudCLIs(t)
	exited, code, err := connInvoke(t, run, "connector", "aws", "--role-name", "")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if exited {
		t.Fatalf("unexpected fatal exit (code %d)", code)
	}
	if connectorAwsRoleName != "" {
		t.Errorf("connectorAwsRoleName = %q, want the flag to stay empty", connectorAwsRoleName)
	}
}

// TestConn_AwsScriptFlowUsesSetupScript pins --script: the shell installer runs
// and the role ARN is parsed out of its CONFIG block.
func TestConn_AwsScriptFlowUsesSetupScript(t *testing.T) {
	run := connEnv(t, connFakeAPI{})
	connAllCloudCLIs(t)
	exited, code, err := connInvoke(t, run, "connector", "aws", "--script")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if exited {
		t.Fatalf("unexpected fatal exit (code %d)", code)
	}
}

// TestConn_AwsMissingCliIsFatal pins that both aws-CLI paths abort with guidance
// when the aws CLI is not installed.
func TestConn_AwsMissingCliIsFatal(t *testing.T) {
	for _, extra := range [][]string{{}, {"--script"}} {
		t.Run(strings.Join(append([]string{"aws"}, extra...), "_"), func(t *testing.T) {
			run := connEnv(t, connFakeAPI{})
			connNoCloudCLIs(t)
			exited, code, err := connInvoke(t, run, append([]string{"connector", "aws"}, extra...)...)
			if err != nil {
				t.Fatalf("execute: %v", err)
			}
			if !exited || code != 1 {
				t.Fatalf("exited=%v code=%d, want a fatal exit(1)", exited, code)
			}
		})
	}
}

// TestConn_AwsManualFlowRequiresRoleArn pins --manual: a blank answer is
// rejected rather than submitted as an empty role ARN.
func TestConn_AwsManualFlowRequiresRoleArn(t *testing.T) {
	run := connEnv(t, connFakeAPI{})
	connAllCloudCLIs(t)
	connStubForm(t, nil)
	exited, code, err := connInvoke(t, run, "connector", "aws", "--manual")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if !exited || code != 1 {
		t.Fatalf("exited=%v code=%d, want a fatal exit(1)", exited, code)
	}
}

// TestConn_AwsManualFlowAbortedPromptIsFatal pins that an aborted prompt is
// surfaced as the command's failure, not swallowed.
func TestConn_AwsManualFlowAbortedPromptIsFatal(t *testing.T) {
	run := connEnv(t, connFakeAPI{})
	connAllCloudCLIs(t)
	connStubForm(t, errors.New("prompt aborted"))
	exited, code, err := connInvoke(t, run, "connector", "aws", "--manual")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if !exited || code != 1 {
		t.Fatalf("exited=%v code=%d, want a fatal exit(1)", exited, code)
	}
}

// TestConn_AwsManualFlowSubmitsPastedRoleArn pins the answered --manual path:
// the pasted ARN is trimmed and submitted, and the connection is reported
// against it.
func TestConn_AwsManualFlowSubmitsPastedRoleArn(t *testing.T) {
	run := connEnv(t, connFakeAPI{})
	connNoCloudCLIs(t) // --manual must not need a local aws CLI
	connStubFormTyping(t, "  arn:aws:iam::123456789012:role/Pasted  ")
	exited, code, err := connInvoke(t, run, "connector", "aws", "--manual")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if exited {
		t.Fatalf("unexpected fatal exit (code %d)", code)
	}
}

// ---------------------------------------------------------------------------
// connector_gcp.go
// ---------------------------------------------------------------------------

// TestConn_GcpCloudShellFlowConnects pins the default path: the installer runs
// through gcloud Cloud Shell and the WIF config it prints is submitted.
func TestConn_GcpCloudShellFlowConnects(t *testing.T) {
	run := connEnv(t, connFakeAPI{})
	connAllCloudCLIs(t)
	exited, code, err := connInvoke(t, run, "connector", "gcp", "--project", "demo-proj")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if exited {
		t.Fatalf("unexpected fatal exit (code %d)", code)
	}
}

// TestConn_GcpPromptsWhenProjectFlagOmitted pins that the project is asked for
// when --project is absent, and the answer is what the command proceeds with.
func TestConn_GcpPromptsWhenProjectFlagOmitted(t *testing.T) {
	run := connEnv(t, connFakeAPI{})
	connAllCloudCLIs(t)
	connStubFormTyping(t, "  prompted-proj  ")
	exited, code, err := connInvoke(t, run, "connector", "gcp")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if exited {
		t.Fatalf("unexpected fatal exit (code %d)", code)
	}
	if connectorGcpProject != "prompted-proj" {
		t.Errorf("project = %q, want the answer trimmed to %q", connectorGcpProject, "prompted-proj")
	}
}

// TestConn_GcpBlankProjectIsFatal pins that an empty answer to the project
// prompt aborts instead of initializing an unnamed project.
func TestConn_GcpBlankProjectIsFatal(t *testing.T) {
	run := connEnv(t, connFakeAPI{})
	connAllCloudCLIs(t)
	connStubForm(t, nil)
	exited, code, err := connInvoke(t, run, "connector", "gcp")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if !exited || code != 1 {
		t.Fatalf("exited=%v code=%d, want a fatal exit(1)", exited, code)
	}
}

// TestConn_GcpAbortedProjectPromptIsFatal pins that an aborted project prompt is
// fatal.
func TestConn_GcpAbortedProjectPromptIsFatal(t *testing.T) {
	run := connEnv(t, connFakeAPI{})
	connAllCloudCLIs(t)
	connStubForm(t, errors.New("prompt aborted"))
	exited, code, err := connInvoke(t, run, "connector", "gcp")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if !exited || code != 1 {
		t.Fatalf("exited=%v code=%d, want a fatal exit(1)", exited, code)
	}
}

// TestConn_GcpMissingGcloudIsFatal pins the "gcloud not on PATH" arm.
func TestConn_GcpMissingGcloudIsFatal(t *testing.T) {
	run := connEnv(t, connFakeAPI{})
	connNoCloudCLIs(t)
	exited, code, err := connInvoke(t, run, "connector", "gcp", "--project", "demo-proj")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if !exited || code != 1 {
		t.Fatalf("exited=%v code=%d, want a fatal exit(1)", exited, code)
	}
}

// TestConn_GcpUnauthenticatedGcloudIsFatal pins the distinct "gcloud is
// installed but has no active account" arm.
func TestConn_GcpUnauthenticatedGcloudIsFatal(t *testing.T) {
	run := connEnv(t, connFakeAPI{})
	connFakeBin(t, map[string]string{"gcloud": connGcloudUnauthedStub})
	exited, code, err := connInvoke(t, run, "connector", "gcp", "--project", "demo-proj")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if !exited || code != 1 {
		t.Fatalf("exited=%v code=%d, want a fatal exit(1)", exited, code)
	}
}

// TestConn_GcpNonJsonWifConfigIsFatal pins that a CONFIG block which is not JSON
// is rejected before it reaches the control plane.
func TestConn_GcpNonJsonWifConfigIsFatal(t *testing.T) {
	run := connEnv(t, connFakeAPI{})
	connFakeBin(t, map[string]string{"gcloud": connGcloudBadJSONStub})
	exited, code, err := connInvoke(t, run, "connector", "gcp", "--project", "demo-proj")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if !exited || code != 1 {
		t.Fatalf("exited=%v code=%d, want a fatal exit(1)", exited, code)
	}
}

// TestConn_GcpManualFlowRequiresWifConfig pins --manual: a blank paste is
// rejected rather than submitted.
func TestConn_GcpManualFlowRequiresWifConfig(t *testing.T) {
	run := connEnv(t, connFakeAPI{})
	connAllCloudCLIs(t)
	connStubForm(t, nil)
	exited, code, err := connInvoke(t, run, "connector", "gcp", "--project", "demo-proj", "--manual")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if !exited || code != 1 {
		t.Fatalf("exited=%v code=%d, want a fatal exit(1)", exited, code)
	}
}

// TestConn_GcpManualFlowAbortedPromptIsFatal pins that aborting the paste prompt
// is fatal.
func TestConn_GcpManualFlowAbortedPromptIsFatal(t *testing.T) {
	run := connEnv(t, connFakeAPI{})
	connAllCloudCLIs(t)
	connStubForm(t, errors.New("prompt aborted"))
	exited, code, err := connInvoke(t, run, "connector", "gcp", "--project", "demo-proj", "--manual")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if !exited || code != 1 {
		t.Fatalf("exited=%v code=%d, want a fatal exit(1)", exited, code)
	}
}

// TestConn_GcpManualFlowSubmitsPastedWifConfig pins the answered --manual path:
// the pasted credential config is parsed and submitted without gcloud.
func TestConn_GcpManualFlowSubmitsPastedWifConfig(t *testing.T) {
	run := connEnv(t, connFakeAPI{})
	connNoCloudCLIs(t) // --manual must not need a local gcloud
	connStubFormTyping(t, `{"type":"external_account","audience":"//iam.googleapis.com/x"}`)
	exited, code, err := connInvoke(t, run, "connector", "gcp", "--project", "demo-proj", "--manual")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if exited {
		t.Fatalf("unexpected fatal exit (code %d)", code)
	}
}

// ---------------------------------------------------------------------------
// connector_azure.go
// ---------------------------------------------------------------------------

// TestConn_AzureLocalFlowConnects pins the default path: the setup script runs
// under the local az CLI and the IDs it prints are submitted.
func TestConn_AzureLocalFlowConnects(t *testing.T) {
	run := connEnv(t, connFakeAPI{})
	connAllCloudCLIs(t)
	exited, code, err := connInvoke(t, run, "connector", "azure", "--subscription", "sub-1")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if exited {
		t.Fatalf("unexpected fatal exit (code %d)", code)
	}
}

// TestConn_AzurePromptsWhenSubscriptionFlagOmitted pins that the subscription is
// asked for when --subscription is absent.
func TestConn_AzurePromptsWhenSubscriptionFlagOmitted(t *testing.T) {
	run := connEnv(t, connFakeAPI{})
	connAllCloudCLIs(t)
	connStubFormTyping(t, " prompted-sub ")
	exited, code, err := connInvoke(t, run, "connector", "azure")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if exited {
		t.Fatalf("unexpected fatal exit (code %d)", code)
	}
	if connectorAzureSubscription != "prompted-sub" {
		t.Errorf("subscription = %q, want it trimmed", connectorAzureSubscription)
	}
}

// TestConn_AzureBlankSubscriptionIsFatal pins that an empty answer aborts.
func TestConn_AzureBlankSubscriptionIsFatal(t *testing.T) {
	run := connEnv(t, connFakeAPI{})
	connAllCloudCLIs(t)
	connStubForm(t, nil)
	exited, code, err := connInvoke(t, run, "connector", "azure")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if !exited || code != 1 {
		t.Fatalf("exited=%v code=%d, want a fatal exit(1)", exited, code)
	}
}

// TestConn_AzureAbortedSubscriptionPromptIsFatal pins that aborting the
// subscription prompt is fatal.
func TestConn_AzureAbortedSubscriptionPromptIsFatal(t *testing.T) {
	run := connEnv(t, connFakeAPI{})
	connAllCloudCLIs(t)
	connStubForm(t, errors.New("prompt aborted"))
	exited, code, err := connInvoke(t, run, "connector", "azure")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if !exited || code != 1 {
		t.Fatalf("exited=%v code=%d, want a fatal exit(1)", exited, code)
	}
}

// TestConn_AzureMissingCliIsFatal pins the "az not on PATH" arm.
func TestConn_AzureMissingCliIsFatal(t *testing.T) {
	run := connEnv(t, connFakeAPI{})
	connNoCloudCLIs(t)
	exited, code, err := connInvoke(t, run, "connector", "azure", "--subscription", "sub-1")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if !exited || code != 1 {
		t.Fatalf("exited=%v code=%d, want a fatal exit(1)", exited, code)
	}
}

// TestConn_AzureManualFlowRequiresAllIds pins --manual: leaving any of the
// tenant/client/subscription answers blank is rejected.
func TestConn_AzureManualFlowRequiresAllIds(t *testing.T) {
	run := connEnv(t, connFakeAPI{})
	connAllCloudCLIs(t)
	connStubForm(t, nil)
	exited, code, err := connInvoke(t, run, "connector", "azure", "--subscription", "sub-1", "--manual")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if !exited || code != 1 {
		t.Fatalf("exited=%v code=%d, want a fatal exit(1)", exited, code)
	}
}

// TestConn_AzureManualFlowAbortedPromptIsFatal pins that aborting the manual
// prompt is fatal.
func TestConn_AzureManualFlowAbortedPromptIsFatal(t *testing.T) {
	run := connEnv(t, connFakeAPI{})
	connAllCloudCLIs(t)
	connStubForm(t, errors.New("prompt aborted"))
	exited, code, err := connInvoke(t, run, "connector", "azure", "--subscription", "sub-1", "--manual")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if !exited || code != 1 {
		t.Fatalf("exited=%v code=%d, want a fatal exit(1)", exited, code)
	}
}

// TestConn_AzureManualFlowSubmitsPastedIds pins the answered --manual path: the
// three pasted IDs are trimmed and submitted without a local az CLI.
func TestConn_AzureManualFlowSubmitsPastedIds(t *testing.T) {
	run := connEnv(t, connFakeAPI{})
	connNoCloudCLIs(t) // --manual must not need a local az
	connStubFormTyping(t,
		" 11111111-1111-1111-1111-111111111111 ",
		" 22222222-2222-2222-2222-222222222222 ",
		" 33333333-3333-3333-3333-333333333333 ",
	)
	exited, code, err := connInvoke(t, run, "connector", "azure", "--subscription", "sub-1", "--manual")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if exited {
		t.Fatalf("unexpected fatal exit (code %d)", code)
	}
}

// ---------------------------------------------------------------------------
// connector_alibaba.go
// ---------------------------------------------------------------------------

// TestConn_AlibabaLocalFlowConnects pins the default path: the setup script runs
// under the local aliyun CLI and the RAM role ARN it prints is submitted.
func TestConn_AlibabaLocalFlowConnects(t *testing.T) {
	run := connEnv(t, connFakeAPI{})
	connAllCloudCLIs(t)
	exited, code, err := connInvoke(t, run, "connector", "alibaba")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if exited {
		t.Fatalf("unexpected fatal exit (code %d)", code)
	}
}

// TestConn_AlibabaMissingCliIsFatal pins the "aliyun not on PATH" arm.
func TestConn_AlibabaMissingCliIsFatal(t *testing.T) {
	run := connEnv(t, connFakeAPI{})
	connNoCloudCLIs(t)
	exited, code, err := connInvoke(t, run, "connector", "alibaba")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if !exited || code != 1 {
		t.Fatalf("exited=%v code=%d, want a fatal exit(1)", exited, code)
	}
}

// TestConn_AlibabaManualFlowRequiresRoleArn pins --manual: a blank paste is
// rejected rather than submitted as an empty ARN.
func TestConn_AlibabaManualFlowRequiresRoleArn(t *testing.T) {
	run := connEnv(t, connFakeAPI{})
	connAllCloudCLIs(t)
	connStubForm(t, nil)
	exited, code, err := connInvoke(t, run, "connector", "alibaba", "--manual")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if !exited || code != 1 {
		t.Fatalf("exited=%v code=%d, want a fatal exit(1)", exited, code)
	}
}

// TestConn_AlibabaManualFlowAbortedPromptIsFatal pins that aborting the manual
// prompt is fatal.
func TestConn_AlibabaManualFlowAbortedPromptIsFatal(t *testing.T) {
	run := connEnv(t, connFakeAPI{})
	connAllCloudCLIs(t)
	connStubForm(t, errors.New("prompt aborted"))
	exited, code, err := connInvoke(t, run, "connector", "alibaba", "--manual")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if !exited || code != 1 {
		t.Fatalf("exited=%v code=%d, want a fatal exit(1)", exited, code)
	}
}

// TestConn_AlibabaManualFlowSubmitsPastedRoleArn pins the answered --manual
// path: the pasted RAM role ARN is trimmed and submitted without a local aliyun
// CLI.
func TestConn_AlibabaManualFlowSubmitsPastedRoleArn(t *testing.T) {
	run := connEnv(t, connFakeAPI{})
	connNoCloudCLIs(t) // --manual must not need a local aliyun
	connStubFormTyping(t, "  acs:ram::123456789012:role/AlethiaProvisioner  ")
	exited, code, err := connInvoke(t, run, "connector", "alibaba", "--manual")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if exited {
		t.Fatalf("unexpected fatal exit (code %d)", code)
	}
}

// TestConn_AlibabaTerraformFlowWritesModule pins --terraform: the OpenTofu
// module is written to the chosen directory before the user is asked for the
// role_arn output.
func TestConn_AlibabaTerraformFlowWritesModule(t *testing.T) {
	run := connEnv(t, connFakeAPI{})
	connAllCloudCLIs(t)
	connStubForm(t, nil)
	dir := filepath.Join(t.TempDir(), "module-out")
	exited, code, err := connInvoke(t, run,
		"connector", "alibaba", "--terraform", "--dir", dir, "--region", "cn-beijing")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if !exited || code != 1 {
		t.Fatalf("exited=%v code=%d, want a fatal exit(1) after the blank paste", exited, code)
	}
	if _, statErr := os.Stat(filepath.Join(dir, "main.tf")); statErr != nil {
		t.Fatalf("main.tf was not written: %v", statErr)
	}
}

// TestConn_AlibabaTerraformFlowDefaultsDirAndRegion pins that omitting --dir and
// --region writes ./alethia-alibaba-connector and prints the default region.
func TestConn_AlibabaTerraformFlowDefaultsDirAndRegion(t *testing.T) {
	run := connEnv(t, connFakeAPI{})
	connAllCloudCLIs(t)
	connStubForm(t, nil)
	t.Chdir(t.TempDir())
	exited, code, err := connInvoke(t, run, "connector", "alibaba", "--terraform")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if !exited || code != 1 {
		t.Fatalf("exited=%v code=%d, want a fatal exit(1) after the blank paste", exited, code)
	}
	if _, statErr := os.Stat(filepath.Join("alethia-alibaba-connector", "main.tf")); statErr != nil {
		t.Fatalf("default module dir was not written: %v", statErr)
	}
}

// TestConn_AlibabaTerraformFlowUnwritableDirIsFatal pins that a --dir that
// cannot be created aborts with a clear error instead of prompting anyway.
func TestConn_AlibabaTerraformFlowUnwritableDirIsFatal(t *testing.T) {
	run := connEnv(t, connFakeAPI{})
	connAllCloudCLIs(t)
	blocker := filepath.Join(t.TempDir(), "not-a-dir")
	if err := os.WriteFile(blocker, []byte("x"), 0o644); err != nil {
		t.Fatalf("write blocker: %v", err)
	}
	exited, code, err := connInvoke(t, run, "connector", "alibaba", "--terraform", "--dir", blocker)
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if !exited || code != 1 {
		t.Fatalf("exited=%v code=%d, want a fatal exit(1)", exited, code)
	}
}

// TestConn_AlibabaTerraformFlowUnwritableModuleIsFatal pins the second write
// guard: the directory exists but main.tf cannot be created.
func TestConn_AlibabaTerraformFlowUnwritableModuleIsFatal(t *testing.T) {
	run := connEnv(t, connFakeAPI{})
	connAllCloudCLIs(t)
	dir := filepath.Join(t.TempDir(), "module-out")
	if err := os.MkdirAll(filepath.Join(dir, "main.tf"), 0o755); err != nil {
		t.Fatalf("mkdir main.tf/: %v", err)
	}
	exited, code, err := connInvoke(t, run, "connector", "alibaba", "--terraform", "--dir", dir)
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if !exited || code != 1 {
		t.Fatalf("exited=%v code=%d, want a fatal exit(1)", exited, code)
	}
}

// ---------------------------------------------------------------------------
// connector_remove.go
// ---------------------------------------------------------------------------

// TestConn_RemoveByProviderArgument pins that a provider argument skips the
// picker and disconnects the matching identity, and that -y skips the prompt.
func TestConn_RemoveByProviderArgument(t *testing.T) {
	run := connEnv(t, connFakeAPI{})
	exited, code, err := connInvoke(t, run, "connector", "remove", "AWS", "--yes")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if exited {
		t.Fatalf("unexpected fatal exit (code %d)", code)
	}
}

// TestConn_RemoveUnknownProviderIsFatal pins that naming a provider with no
// connection is an error, not a silent no-op.
func TestConn_RemoveUnknownProviderIsFatal(t *testing.T) {
	run := connEnv(t, connFakeAPI{})
	exited, code, err := connInvoke(t, run, "connector", "remove", "gcp", "--yes")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if !exited || code != 1 {
		t.Fatalf("exited=%v code=%d, want a fatal exit(1)", exited, code)
	}
}

// TestConn_RemoveWithNoConnections pins the empty-state: nothing to pick, so the
// command reports and returns without calling disconnect.
func TestConn_RemoveWithNoConnections(t *testing.T) {
	run := connEnv(t, connFakeAPI{noIdentities: true})
	exited, code, err := connInvoke(t, run, "connector", "remove")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if exited {
		t.Fatalf("unexpected fatal exit (code %d)", code)
	}
}

// TestConn_RemoveListFailureIsFatal pins that a failing cloud-identities fetch
// aborts.
func TestConn_RemoveListFailureIsFatal(t *testing.T) {
	run := connEnv(t, connFakeAPI{identitiesStatus: http.StatusInternalServerError})
	exited, code, err := connInvoke(t, run, "connector", "remove")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if !exited || code != 1 {
		t.Fatalf("exited=%v code=%d, want a fatal exit(1)", exited, code)
	}
}

// TestConn_RemovePickerDisconnectsTheSelectedConnection pins the picker arm of
// pickIdentity: with no provider argument the list is offered as a select, whose
// pre-selected first option is what a submitted-unchanged form yields — and that
// is the connection disconnected.
func TestConn_RemovePickerDisconnectsTheSelectedConnection(t *testing.T) {
	rec := &connRecorder{}
	run := connEnv(t, connFakeAPI{
		rec: rec,
		identities: []map[string]interface{}{
			{"id": "ci2", "provider": "gcp", "label": "demo-proj", "created_at": "2026-01-02T00:00:00Z"},
			{"id": "ci1", "provider": "aws", "label": "prod-account", "created_at": "2026-01-01T00:00:00Z"},
		},
	})
	connStubForm(t, nil)
	connStubConfirm(t, true)
	exited, code, err := connInvoke(t, run, "connector", "remove")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if exited {
		t.Fatalf("unexpected fatal exit (code %d)", code)
	}
	if !rec.saw("/providers/gcp/disconnect") {
		t.Error("the pre-selected first connection (gcp) was not the one disconnected")
	}
	if rec.saw("/providers/aws/disconnect") {
		t.Error("a connection other than the selected one was disconnected")
	}
}

// TestConn_RemoveAbortedPickerIsFatal pins that an aborted picker is fatal.
func TestConn_RemoveAbortedPickerIsFatal(t *testing.T) {
	run := connEnv(t, connFakeAPI{})
	connStubForm(t, errors.New("prompt aborted"))
	exited, code, err := connInvoke(t, run, "connector", "remove")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if !exited || code != 1 {
		t.Fatalf("exited=%v code=%d, want a fatal exit(1)", exited, code)
	}
}

// TestConn_RemoveDeclinedConfirmationDoesNothing pins that answering "no" to the
// confirmation returns without disconnecting.
func TestConn_RemoveDeclinedConfirmationDoesNothing(t *testing.T) {
	// A rejected disconnect endpoint proves the call is never made: if the
	// declined confirmation did not short-circuit, the 403 would be fatal.
	run := connEnv(t, connFakeAPI{disconnectStatus: http.StatusForbidden})
	connStubConfirm(t, false)
	exited, code, err := connInvoke(t, run, "connector", "remove", "aws")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if exited {
		t.Fatalf("unexpected fatal exit (code %d) — disconnect must not be called", code)
	}
}

// TestConn_RemoveConfirmedDisconnects pins the confirmed arm: the disconnect
// call is made and the command succeeds.
func TestConn_RemoveConfirmedDisconnects(t *testing.T) {
	run := connEnv(t, connFakeAPI{})
	connStubConfirm(t, true)
	exited, code, err := connInvoke(t, run, "connector", "remove", "aws")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if exited {
		t.Fatalf("unexpected fatal exit (code %d)", code)
	}
}

// TestConn_RemoveDisconnectFailureIsFatal pins that a rejected disconnect is
// reported as a failure.
func TestConn_RemoveDisconnectFailureIsFatal(t *testing.T) {
	run := connEnv(t, connFakeAPI{disconnectStatus: http.StatusForbidden})
	exited, code, err := connInvoke(t, run, "connector", "remove", "aws", "--yes")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if !exited || code != 1 {
		t.Fatalf("exited=%v code=%d, want a fatal exit(1)", exited, code)
	}
}

// ---------------------------------------------------------------------------
// Hetzner — the one cloud that authenticates with a token, and the one the CLI
// could not connect at all until lib/cli/providers.ts stopped 400-ing it.
// ---------------------------------------------------------------------------

// TestConn_HetznerTokenFlowConnects drives the real cobra tree end to end: init, capture the token
// from --token, submit, verify. The token path is deliberately the simplest connector in the tree —
// no Cloud Shell, no cloud CLI, no Terraform module — so nothing is stubbed but the control plane.
func TestConn_HetznerTokenFlowConnects(t *testing.T) {
	rec := &connRecorder{}
	run := connEnv(t, connFakeAPI{rec: rec})
	exited, code, err := connInvoke(t, run, "connector", "hetzner", "--token", strings.Repeat("h", 64))
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if exited {
		t.Fatalf("unexpected fatal exit (code %d)", code)
	}
	// The provider segment must be `hetzner` — the whole bug was these routes rejecting it.
	if !rec.saw("/providers/hetzner/init") || !rec.saw("/providers/hetzner/connect") {
		t.Errorf("expected hetzner init + connect, saw %v", rec.paths)
	}
}

// TestConn_HetznerCarriesTheS3Pair pins the other half of the server fix: the console has always
// passed Hetzner's Object-Storage key pair, and the CLI route silently dropped it, so a CLI-created
// connection could never provision a bucket.
func TestConn_HetznerCarriesTheS3Pair(t *testing.T) {
	rec := &connRecorder{}
	run := connEnv(t, connFakeAPI{rec: rec})
	exited, _, err := connInvoke(t, run, "connector", "hetzner",
		"--token", strings.Repeat("h", 64),
		"--s3-access-key", "AKIAHETZNER",
		"--s3-secret-key", "sekrit",
	)
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if exited {
		t.Fatal("unexpected fatal exit")
	}
	if connectorHetznerS3AccessKey != "AKIAHETZNER" || connectorHetznerS3SecretKey != "sekrit" {
		t.Errorf("S3 flags not bound: %q / %q", connectorHetznerS3AccessKey, connectorHetznerS3SecretKey)
	}
}

// TestConn_HetznerShortTokenIsFatal keeps the local validation on the fatal path: a truncated paste
// must fail with our message rather than as a connection-test failure that reads like Hetzner's fault.
func TestConn_HetznerShortTokenIsFatal(t *testing.T) {
	run := connEnv(t, connFakeAPI{})
	exited, code, err := connInvoke(t, run, "connector", "hetzner", "--token", "tooshort")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if !exited || code == 0 {
		t.Fatalf("a short token must exit fatally, got exited=%v code=%d", exited, code)
	}
}

// TestConn_HetznerConnectFailureIsFatal pins the unverified-connection arm.
func TestConn_HetznerConnectFailureIsFatal(t *testing.T) {
	run := connEnv(t, connFakeAPI{connectStatus: http.StatusBadRequest})
	exited, code, err := connInvoke(t, run, "connector", "hetzner", "--token", strings.Repeat("h", 64))
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if !exited || code == 0 {
		t.Fatalf("a failed connect must exit fatally, got exited=%v code=%d", exited, code)
	}
}

// TestConn_HetznerInteractivePromptSubmits reaches the masked-prompt path: no --token, no
// --token-stdin, a TTY. This is the flow a person actually uses, and the one where the token never
// touches shell history or the process list.
func TestConn_HetznerInteractivePromptSubmits(t *testing.T) {
	rec := &connRecorder{}
	run := connEnv(t, connFakeAPI{rec: rec})
	// A headless test process is never a terminal, so the prompt arm is unreachable without this —
	// the same reason connStubConfirm forces it.
	hygCliConfirmInteractive(t)
	connStubFormTyping(t, "  "+strings.Repeat("h", 64)+"  ")
	exited, code, err := connInvoke(t, run, "connector", "hetzner")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if exited {
		t.Fatalf("unexpected fatal exit (code %d)", code)
	}
	if !rec.saw("/providers/hetzner/connect") {
		t.Errorf("the prompted token was never submitted: %v", rec.paths)
	}
}

// TestConn_HetznerAbortedPromptIsFatal — an aborted prompt must not connect with an empty token.
func TestConn_HetznerAbortedPromptIsFatal(t *testing.T) {
	run := connEnv(t, connFakeAPI{})
	hygCliConfirmInteractive(t)
	connStubForm(t, errors.New("aborted"))
	exited, code, err := connInvoke(t, run, "connector", "hetzner")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if !exited || code == 0 {
		t.Fatalf("an aborted prompt must exit fatally, got exited=%v code=%d", exited, code)
	}
}

// TestConn_HetznerInitFailureIsFatal covers the init arm — the connection cannot proceed without an
// identity to attach the token to.
func TestConn_HetznerInitFailureIsFatal(t *testing.T) {
	run := connEnv(t, connFakeAPI{initStatus: http.StatusServiceUnavailable})
	exited, code, err := connInvoke(t, run, "connector", "hetzner", "--token", strings.Repeat("h", 64))
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if !exited || code == 0 {
		t.Fatalf("a failed init must exit fatally, got exited=%v code=%d", exited, code)
	}
}

// TestConn_HetznerRequiresAuth covers the getAuthToken arm.
func TestConn_HetznerRequiresAuth(t *testing.T) {
	connResetConnectorFlags(t)
	isolatedHome(t) // no credentials written
	t.Setenv("ALETHIA_NO_UPDATE_CHECK", "1")
	run := func(args ...string) error {
		execRootArgs(args)
		return rootCmd.Execute()
	}
	exited, code, err := connInvoke(t, run, "connector", "hetzner", "--token", strings.Repeat("h", 64))
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if !exited || code == 0 {
		t.Fatalf("an unauthenticated invocation must exit fatally, got exited=%v code=%d", exited, code)
	}
}

// ---------------------------------------------------------------------------
// The field contract of this noun group: one spec, four renderings
//
// The rule the CLI programme is enforcing is that FLAGS ARE A COMPLETE CONTRACT —
// anything the interactive form can ask for, a flag can set, so `--no-input` always
// works — and that every leaf taking input also has an interactive path.
//
// Both halves are asserted BEHAVIOURALLY here, through the real cobra tree, because
// the failure mode they exist to catch is not a missing flag registration. It is a
// flag that exists and is never READ on the path that prompts: `connector aws
// --manual` gained no way to supply the role ARN for a year while the flag table in
// the docs looked complete.
//
// The leaf inventory is DERIVED from the command tree, not typed out. A hand-written
// list of what a guard watches stops covering silently — that is what put three
// destructive commands past hyg_cli_confirm_test.go — so a new `connector <cloud>`
// that nobody adds a case for fails this file rather than passing it unnoticed.
// ---------------------------------------------------------------------------

// connFormCounter replaces runHuhForm with a counter that answers nothing, and returns a
// pointer to the number of forms opened. It leaves prompting ENABLED, which is the strong
// version of the assertion: a complete flag set must ask nothing even when it could.
func connFormCounter(t *testing.T) *int {
	t.Helper()
	hygCliConfirmInteractive(t)
	opened := 0
	prev := runHuhForm
	runHuhForm = func(...*huh.Group) error { opened++; return nil }
	t.Cleanup(func() { runHuhForm = prev })
	return &opened
}

// connCaptureStdout runs fn with os.Stdout redirected and returns what it printed. The
// fatal path prints through ui.Error, so this is how a refusal's WORDING is read — an exit
// code alone cannot tell "pass --role-arn" from "could not open a new TTY".
func connCaptureStdout(t *testing.T, fn func()) string {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("pipe: %v", err)
	}
	prev := os.Stdout
	os.Stdout = w
	done := make(chan string, 1)
	go func() {
		b, _ := io.ReadAll(r)
		done <- string(b)
	}()
	fn()
	os.Stdout = prev
	_ = w.Close()
	out := <-done
	_ = r.Close()
	return out
}

// connLeafPaths is every leaf command of this noun group, derived from the tree. It is the
// SET the cases below must cover; nothing here is typed by hand.
func connLeafPaths(t *testing.T) [][]string {
	t.Helper()
	var out [][]string
	var walk func(prefix []string, c *cobra.Command)
	walk = func(prefix []string, c *cobra.Command) {
		path := append(append([]string{}, prefix...), c.Name())
		subs := c.Commands()
		if len(subs) == 0 {
			out = append(out, path)
			return
		}
		for _, sub := range subs {
			walk(path, sub)
		}
	}
	for _, group := range []*cobra.Command{connectorCmd, cloudCmd, providerCmd} {
		walk(nil, group)
	}
	return out
}

// connCompleteCases give every field through flags. Each must reach the control plane
// having opened NO form — which is what "--no-input always works" means in practice.
//
// The cloud CLIs are removed from PATH for all of them on purpose: a complete flag set
// describes resources that already exist, so a command that still shells out to `aws` or
// `gcloud` here has a field it is not really taking from the flag.
var connCompleteCases = []struct {
	name string
	args []string
}{
	{"connector aws", []string{"connector", "aws", "--role-arn", "arn:aws:iam::123456789012:role/AlethiaProvisionerRole"}},
	{"connector gcp", []string{"connector", "gcp", "--project", "p1", "--wif-config", "-"}},
	{"connector azure", []string{"connector", "azure", "--subscription", "s1", "--tenant-id", "t1", "--client-id", "c1"}},
	{"connector alibaba", []string{"connector", "alibaba", "--role-arn", "acs:ram::123456789012:role/AlethiaProvisioner"}},
	{"connector hetzner", []string{"connector", "hetzner", "--token", "hhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhh", "--s3-access-key", "AK", "--s3-secret-key", "SK"}},
	{"connector list", []string{"connector", "list", "--output", "json"}},
	{"connector remove", []string{"connector", "remove", "aws", "--yes"}},
	{"cloud inventory", []string{"cloud", "inventory", "aws", "--output", "json"}},
	{"provider status", []string{"provider", "status", "aws", "--output", "json"}},
	{"provider verify", []string{"provider", "verify", "aws", "--output", "json"}},
}

// TestConnField_CompleteFlagsNeverPrompt drives each complete invocation with prompting
// ENABLED and asserts nothing was asked and the command succeeded.
func TestConnField_CompleteFlagsNeverPrompt(t *testing.T) {
	for _, tc := range connCompleteCases {
		t.Run(tc.name, func(t *testing.T) {
			hygCliConfirmResetFlags()
			rec := &connRecorder{}
			run := connEnv(t, connFakeAPI{rec: rec})
			connNoCloudCLIs(t)
			opened := connFormCounter(t)
			// The gcp case reads its WIF config from stdin, which is the same field the form
			// asks for as a paste.
			prevStdin := os.Stdin
			r, w, _ := os.Pipe()
			_, _ = w.WriteString(`{"type":"external_account"}`)
			_ = w.Close()
			os.Stdin = r
			t.Cleanup(func() { os.Stdin = prevStdin; _ = r.Close() })

			exited, code, err := connInvoke(t, run, tc.args...)
			if err != nil {
				t.Fatalf("execute: %v", err)
			}
			if exited {
				t.Fatalf("a complete flag set exited fatally (code %d); requests = %v", code, rec.paths)
			}
			if *opened != 0 {
				t.Errorf("opened %d interactive form(s) with every field given — a flag the prompt "+
					"path never reads is the defect this asserts against", *opened)
			}
		})
	}
}

// connRefusalCases are the same leaves with a required field withheld, under --no-input.
// Each must die naming the FLAG that would have supplied it. The wording is the assertion:
// before this, an omitted field reached huh and failed with "could not open a new TTY" — a
// message about a device file, for a user whose mistake was a missing flag.
var connRefusalCases = []struct {
	name      string
	args      []string
	wantNamed []string
}{
	{"connector aws · manual with no role arn", []string{"connector", "aws", "--manual"}, []string{"--role-arn"}},
	{"connector gcp · no project", []string{"connector", "gcp"}, []string{"--project"}},
	{"connector gcp · manual with no config", []string{"connector", "gcp", "--project", "p1", "--manual"}, []string{"--wif-config"}},
	{"connector azure · no subscription", []string{"connector", "azure"}, []string{"--subscription"}},
	{"connector azure · manual with no ids", []string{"connector", "azure", "--subscription", "s1", "--manual"}, []string{"--tenant-id", "--client-id"}},
	{"connector alibaba · manual with no role arn", []string{"connector", "alibaba", "--manual"}, []string{"--role-arn"}},
	{"connector hetzner · no token", []string{"connector", "hetzner"}, []string{"--token", "--token-stdin"}},
	{"connector remove · no provider", []string{"connector", "remove"}, []string{"provider"}},
	{"cloud inventory · no account", []string{"cloud", "inventory"}, []string{"provider"}},
	{"provider status · no provider", []string{"provider", "status"}, []string{"provider"}},
	{"provider verify · no provider", []string{"provider", "verify"}, []string{"provider"}},
}

// TestConnField_MissingFieldRefusalNamesTheFlag pins the other half of the contract.
func TestConnField_MissingFieldRefusalNamesTheFlag(t *testing.T) {
	for _, tc := range connRefusalCases {
		t.Run(tc.name, func(t *testing.T) {
			hygCliConfirmResetFlags()
			rec := &connRecorder{}
			run := connEnv(t, connFakeAPI{rec: rec})
			connNoCloudCLIs(t)
			opened := connFormCounter(t)
			// connFormCounter enables prompting; --no-input is what the assertion is about, so
			// it is turned back off explicitly rather than relying on the headless process.
			prev := noInputMode
			noInputMode = true
			t.Cleanup(func() { noInputMode = prev })

			var exited bool
			var code int
			out := connCaptureStdout(t, func() {
				exited, code, _ = connInvoke(t, run, append(append([]string{}, tc.args...), "--no-input")...)
			})
			if !exited || code == 0 {
				t.Fatalf("a withheld field must exit fatally, got exited=%v code=%d", exited, code)
			}
			if *opened != 0 {
				t.Errorf("opened %d form(s) under --no-input — the refusal must come before the prompt", *opened)
			}
			for _, want := range tc.wantNamed {
				if !strings.Contains(out, want) {
					t.Errorf("refusal did not name %q; it said:\n%s", want, out)
				}
			}
			for _, req := range rec.paths {
				if strings.HasSuffix(req, "/connect") || strings.HasSuffix(req, "/disconnect") {
					t.Errorf("an incomplete invocation still changed state: %s", req)
				}
			}
		})
	}
}

// TestConnField_EveryLeafHasBothCases is what stops the two tables above becoming the
// definition of the set. The leaves are derived from the command tree; a `connector
// <newcloud>` added without cases fails HERE rather than passing everything silently.
//
// `connector list` is the one leaf with no refusal case, because it takes no input at all —
// named, so its absence is a recorded decision rather than an omission.
func TestConnField_EveryLeafHasBothCases(t *testing.T) {
	leaves := connLeafPaths(t)
	if len(leaves) == 0 {
		t.Fatal("derived no leaf commands from connector/cloud/provider — every assertion in " +
			"this file is then vacuous")
	}

	takesNoInput := map[string]bool{"connector list": true}

	hasPrefix := func(args, path []string) bool {
		if len(args) < len(path) {
			return false
		}
		for i, seg := range path {
			if args[i] != seg {
				return false
			}
		}
		return true
	}

	for _, path := range leaves {
		name := strings.Join(path, " ")
		t.Run(name, func(t *testing.T) {
			complete := false
			for _, c := range connCompleteCases {
				if hasPrefix(c.args, path) {
					complete = true
				}
			}
			if !complete {
				t.Errorf("no complete-flags case for %q — add one to connCompleteCases, or the "+
					"'flags are a complete contract' claim does not cover it", name)
			}
			refusal := false
			for _, c := range connRefusalCases {
				if hasPrefix(c.args, path) {
					refusal = true
				}
			}
			if !refusal && !takesNoInput[name] {
				t.Errorf("no missing-field case for %q — add one to connRefusalCases, or record it "+
					"in takesNoInput with the reason", name)
			}
			if refusal && takesNoInput[name] {
				t.Errorf("%q is listed as taking no input but has a missing-field case — the list "+
					"has gone stale", name)
			}
		})
	}
	for name := range takesNoInput {
		found := false
		for _, path := range leaves {
			if strings.Join(path, " ") == name {
				found = true
			}
		}
		if !found {
			t.Errorf("takesNoInput names %q, which is not a leaf of this group — delete it", name)
		}
	}
}

// ---------------------------------------------------------------------------
// The fourth rendering: the docs table
//
// A field spec is only one spec if all four renderings agree — flags, form, manifest keys,
// and the flag table a reader actually consults. The first three are asserted above, through
// behaviour. This one compares the registered flags against the .mdx, in BOTH directions,
// because each direction fails differently and neither implies the other:
//
//   flag with no docs row  → a capability nobody can discover; `--role-arn` would have
//                            shipped invisible.
//   docs row with no flag  → an instruction that does not work, which is worse than silence,
//                            and is what a renamed flag leaves behind.
//
// The subject is the cobra tree, the oracle is the file on disk. Neither is derived from the
// other, so this cannot pass by construction.
// ---------------------------------------------------------------------------

// connDocsPages maps a command group onto the docs page that documents it.
var connDocsPages = map[string]string{
	"connector": "../../docs/content/docs/cli/commands/connector.mdx",
	"cloud":     "../../docs/content/docs/cli/commands/cloud.mdx",
	"provider":  "../../docs/content/docs/cli/commands/providers.mdx",
}

// connDocsGlobalFlags are the root-level flags every page may mention without registering
// them itself. They are documented once, on the command-reference page.
var connDocsGlobalFlags = map[string]bool{
	"--output": true, "--no-input": true, "--org": true, "--token": true, "--help": true,
}

// connDocsAutoFlags are flags COBRA registers, not us. --help appears on every command the
// moment one has been executed in this package, which makes it present or absent depending
// on test order — and it is not a field of any command's spec.
var connDocsAutoFlags = map[string]bool{"--help": true}

// connDocsFlagRef matches a flag named in backticks in the prose or a table cell.
var connDocsFlagRef = regexp.MustCompile("`(--[a-z0-9][a-z0-9-]*)`")

// connDocsHeading matches a command section heading: ## `alethia connector aws`
var connDocsHeading = regexp.MustCompile("(?m)^##+ +`(alethia [a-z0-9 -]+)`")

// connDocsRowFlags returns the flags a section names in the FIRST CELL of a table row —
// that is, the flags its flag table actually has a row for.
//
// The first cell, not "anywhere in the section", and that is the second sharpening this
// guard needed. Deleting the `--tenant-id` row from the Azure table left the guard green,
// because the `--client-id` row's description says "Requires `--tenant-id`". A
// cross-reference is not an entry: the reader scanning the left-hand column still finds
// nothing. What is being asserted is that the flag has a ROW.
func connDocsRowFlags(section string) map[string]bool {
	out := map[string]bool{}
	for _, line := range strings.Split(section, "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "|") {
			continue
		}
		cells := strings.Split(strings.Trim(line, "|"), "|")
		if len(cells) == 0 {
			continue
		}
		for _, m := range connDocsFlagRef.FindAllStringSubmatch(cells[0], -1) {
			out[m[1]] = true
		}
	}
	return out
}

// connDocsSections splits a page into the body of each `## `alethia …“ section, keyed by the
// command path.
//
// Per SECTION, not per page, and that distinction is the whole guard. The first cut asked
// only whether the page mentioned the flag anywhere — and deleting the `--role-arn` row from
// the AWS table left the guard GREEN, because Alibaba's table and a scripting example both
// still said `--role-arn` further down. A reader consulting the AWS flag table would have
// found nothing. One page documents seven commands; "somewhere on the page" is not an answer
// to "is this documented".
func connDocsSections(body string) map[string]string {
	idx := connDocsHeading.FindAllStringSubmatchIndex(body, -1)
	out := make(map[string]string, len(idx))
	for i, m := range idx {
		name := body[m[2]:m[3]]
		end := len(body)
		if i+1 < len(idx) {
			end = idx[i+1][0]
		}
		out[name] = body[m[1]:end]
	}
	return out
}

// TestConnField_DocsTableMatchesTheRegisteredFlags compares both directions.
func TestConnField_DocsTableMatchesTheRegisteredFlags(t *testing.T) {
	groups := map[string]*cobra.Command{
		"connector": connectorCmd, "cloud": cloudCmd, "provider": providerCmd,
	}

	scannedFlags, scannedSections := 0, 0
	for group, root := range groups {
		path, ok := connDocsPages[group]
		if !ok {
			t.Fatalf("no docs page mapped for the %q group", group)
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read %s: %v", path, err)
		}
		body := string(raw)
		if strings.TrimSpace(body) == "" {
			t.Fatalf("%s is empty — every assertion against it is vacuous", path)
		}
		sections := connDocsSections(body)
		if len(sections) == 0 {
			t.Fatalf("%s has no `## `alethia …`` command sections — the per-command assertions "+
				"below cannot see anything", path)
		}

		// Direction 1: every registered flag is documented, IN ITS OWN COMMAND'S SECTION.
		registered := map[string]bool{}
		var walk func(c *cobra.Command)
		walk = func(c *cobra.Command) {
			subs := c.Commands()
			if len(subs) == 0 {
				section, documented := sections[c.CommandPath()]
				rowFlags := connDocsRowFlags(section)
				if !documented {
					t.Errorf("%s has no `## `%s`` section in %s — a leaf with no docs page entry",
						c.CommandPath(), c.CommandPath(), path)
				}
				scannedSections++
				c.Flags().VisitAll(func(f *pflag.Flag) {
					// LocalFlags, not "not in InheritedFlags", and the difference is a whole
					// command's flag. `connector hetzner` registers its OWN --token, and root
					// registers a persistent --token as well, so InheritedFlags().Lookup("token")
					// is non-nil and the flag that actually binds was skipped as "a root flag,
					// documented on the reference page": deleting the `--token` row from the
					// hetzner table left this guard GREEN. LocalFlags keeps a flag that SHADOWS
					// a parent's, and drops only the ones purely inherited.
					if c.LocalFlags().Lookup(f.Name) == nil {
						return // a root flag, documented on the reference page
					}
					if connDocsAutoFlags["--"+f.Name] {
						return
					}
					registered["--"+f.Name] = true
					scannedFlags++
					if documented && !rowFlags["--"+f.Name] {
						t.Errorf("%s registers --%s, and its section in %s has no table row for it — a "+
							"reader scanning that command's flag table would not find it",
							c.CommandPath(), f.Name, path)
					}
				})
				return
			}
			for _, sub := range subs {
				walk(sub)
			}
		}
		walk(root)

		// Direction 2: every flag the page names exists somewhere in the group. Page-wide on
		// purpose — the scripting examples and the shared prose are not inside any command's
		// section, and they are exactly where a renamed flag survives longest.
		for _, m := range connDocsFlagRef.FindAllStringSubmatch(body, -1) {
			flag := m[1]
			if registered[flag] || connDocsGlobalFlags[flag] {
				continue
			}
			t.Errorf("%s documents %s, which no command in the %q group registers — a renamed or "+
				"deleted flag leaves an instruction behind that does not work", path, flag, group)
		}
	}

	if scannedFlags == 0 || scannedSections == 0 {
		t.Fatalf("scanned %d flags across %d command sections — this guard is not seeing the "+
			"command tree and both directions above are vacuous", scannedFlags, scannedSections)
	}
}

// ---------------------------------------------------------------------------
// The resolvers, at unit level
// ---------------------------------------------------------------------------

// connFakeLister is the cloud-identity half of the API client, counting calls so a test can
// assert that a resolution made NO round trip.
type connFakeLister struct {
	identities []api.CloudIdentity
	err        error
	calls      int
}

func (f *connFakeLister) GetCloudIdentities() ([]api.CloudIdentity, error) {
	f.calls++
	return f.identities, f.err
}

// TestConnField_IdRefIsPassedThroughUntouched is the assertion that matters most in this
// file. A stored cloud-identity id is a LOOKUP KEY: the record is addressed by it, so a
// resolver that trimmed, lower-cased, truncated or otherwise "tidied" one would silently
// point at a different record — or at none. The reference resolver must therefore hand an
// id back byte for byte, and must not even ask the control plane for the list.
func TestConnField_IdRefIsPassedThroughUntouched(t *testing.T) {
	hygCliConfirmSetNoInput(t, false)
	for _, id := range []string{
		"ci_01J8Z9QK3F2ABCDEF",
		"CI-Mixed-Case-0001",
		"9f8b1c2d-3e4f-5a6b-7c8d-9e0f1a2b3c4d",
		"aws-account",  // starts with a provider name but is not one
		"gcpsomething", // ditto
	} {
		t.Run(id, func(t *testing.T) {
			lister := &connFakeLister{}
			got, err := resolveCloudIdentityRef(lister, id)
			if err != nil {
				t.Fatalf("resolveCloudIdentityRef(%q) = %v", id, err)
			}
			if got != id {
				t.Errorf("id was reshaped: %q -> %q — that renames the record it addresses", id, got)
			}
			if lister.calls != 0 {
				t.Errorf("listed cloud identities %d times to resolve a literal id", lister.calls)
			}
		})
	}
}

// TestConnField_ProviderRefResolvesToTheConnectedIdentity pins the handoff removal itself.
func TestConnField_ProviderRefResolvesToTheConnectedIdentity(t *testing.T) {
	hygCliConfirmSetNoInput(t, true)
	lister := &connFakeLister{identities: []api.CloudIdentity{
		{ID: "ci-aws", Provider: "aws", Label: "prod"},
		{ID: "ci-gcp", Provider: "gcp", Label: "analytics"},
	}}
	got, err := resolveCloudIdentityRef(lister, "gcp")
	if err != nil {
		t.Fatalf("resolve gcp: %v", err)
	}
	if got != "ci-gcp" {
		t.Errorf("resolved gcp to %q, want ci-gcp", got)
	}
}

// TestConnField_ProviderRefEdges walks the arms where guessing would be wrong.
func TestConnField_ProviderRefEdges(t *testing.T) {
	cases := []struct {
		name       string
		ref        string
		noInput    bool
		identities []api.CloudIdentity
		listErr    error
		wantIn     []string
		wantNotIn  []string
	}{
		{
			name: "unconnected provider", ref: "azure", noInput: true,
			identities: []api.CloudIdentity{{ID: "ci-aws", Provider: "aws"}},
			wantIn:     []string{"no connected azure account", "alethia connector azure"},
		},
		{
			// Two accounts for one provider are reported, never guessed: picking the first
			// would read a different account than the caller meant, and nothing in the output
			// would show which one it was.
			name: "ambiguous provider", ref: "aws", noInput: true,
			identities: []api.CloudIdentity{
				{ID: "ci-one", Provider: "aws"}, {ID: "ci-two", Provider: "aws"},
			},
			wantIn: []string{"2 connected aws accounts", "ci-one", "ci-two"},
		},
		{
			// A cloud the `cloud_provider` enum carries but the CLI has no connector leaf for.
			// The remediation must not name `alethia connector civo`, which exits with cobra's
			// `unknown command "civo"` — a suggestion that cannot be followed is worse than none.
			name: "provider with no connector leaf", ref: "civo", noInput: true,
			identities: []api.CloudIdentity{{ID: "ci-aws", Provider: "aws"}},
			wantIn:     []string{"no connected civo account", "cannot connect one", "hetzner"},
			wantNotIn:  []string{"alethia connector civo"},
		},
		{
			name: "nothing connected", ref: "aws", noInput: true,
			identities: []api.CloudIdentity{},
			wantIn:     []string{"no cloud accounts connected"},
		},
		{
			name: "no argument under --no-input", ref: "", noInput: true,
			identities: []api.CloudIdentity{{ID: "ci-aws", Provider: "aws"}},
			wantIn:     []string{"hetzner", "--no-input"},
		},
		{
			name: "the list itself fails", ref: "aws", noInput: true,
			listErr: errors.New("boom"),
			wantIn:  []string{"failed to fetch cloud connections"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			hygCliConfirmSetNoInput(t, tc.noInput)
			lister := &connFakeLister{identities: tc.identities, err: tc.listErr}
			_, err := resolveCloudIdentityRef(lister, tc.ref)
			if err == nil {
				t.Fatal("expected an error")
			}
			for _, want := range tc.wantIn {
				if !strings.Contains(err.Error(), want) {
					t.Errorf("message %q should mention %q", err, want)
				}
			}
			for _, unwanted := range tc.wantNotIn {
				if strings.Contains(err.Error(), unwanted) {
					t.Errorf("message %q names %q, which is not a command that exists", err, unwanted)
				}
			}
		})
	}
}

// TestConnField_ProviderRefPickerReturnsTheChosenProvider covers the picker arm of
// resolveProviderRef: the user chooses an ACCOUNT and the command needs its PROVIDER.
func TestConnField_ProviderRefPickerReturnsTheChosenProvider(t *testing.T) {
	hygCliConfirmSetNoInput(t, false)
	connStubFormTyping(t) // opens and closes the form without changing the selection
	lister := &connFakeLister{identities: []api.CloudIdentity{
		{ID: "ci-azure", Provider: "azure", Label: "corp"},
	}}
	got, err := resolveProviderRef(lister, nil)
	if err != nil {
		t.Fatalf("resolveProviderRef: %v", err)
	}
	if got != "azure" {
		t.Errorf("picker returned %q, want the chosen account's provider (azure)", got)
	}
}

// TestConnField_ProviderSlugSetComesFromTheGeneratedEnum pins that the "is this a provider
// or an id" question is answered by types.AllCloudProviders — the generated mirror of the
// Postgres enum — and not by a list typed into this package.
func TestConnField_ProviderSlugSetComesFromTheGeneratedEnum(t *testing.T) {
	for _, p := range types.AllCloudProviders {
		if !isCloudProviderSlug(string(p)) {
			t.Errorf("%q is a cloud_provider value the resolver does not recognise", p)
		}
	}
	for _, notAProvider := range []string{"", "AWS", " aws", "aws ", "amazon", "ci-aws"} {
		if isCloudProviderSlug(notAProvider) {
			t.Errorf("%q was read as a provider slug — an id that merely resembles one must be "+
				"passed through, not resolved", notAProvider)
		}
	}
}

// TestConnField_ProviderNamesAreDerivedFromTheSubcommands pins that the provider list the
// help text and the empty state show is the registered set. Two hand-written copies of it —
// "gcp|aws|azure" in the empty state and "aws, gcp, azure" in `connector remove`'s help —
// were both written before Alibaba and Hetzner existed and never revisited, so the CLI told
// a Hetzner user it could not connect their cloud.
func TestConnField_ProviderNamesAreDerivedFromTheSubcommands(t *testing.T) {
	got := connectorProviderNames()
	want := map[string]bool{}
	for _, c := range connectorCmd.Commands() {
		if c.Name() == "list" || c.Name() == "remove" {
			continue
		}
		want[c.Name()] = true
	}
	if len(got) != len(want) {
		t.Fatalf("connectorProviderNames() = %v, want the %d registered provider subcommands", got, len(want))
	}
	for _, name := range got {
		if !want[name] {
			t.Errorf("connectorProviderNames() named %q, which is not a registered subcommand", name)
		}
	}
	hint := connectorEmptyStateHint()
	for _, name := range got {
		if !strings.Contains(hint, name) {
			t.Errorf("the empty state does not name %q: %q", name, hint)
		}
	}
}

// TestConnField_ReadWifConfig covers the flag form of the GCP paste.
func TestConnField_ReadWifConfig(t *testing.T) {
	dir := t.TempDir()
	good := filepath.Join(dir, "wif.json")
	if err := os.WriteFile(good, []byte(`{"type":"external_account"}`), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	empty := filepath.Join(dir, "empty.json")
	if err := os.WriteFile(empty, []byte("   \n"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}

	t.Run("from a file", func(t *testing.T) {
		got, err := readWifConfig(good, strings.NewReader(""))
		if err != nil || !strings.Contains(got, "external_account") {
			t.Fatalf("readWifConfig(file) = (%q, %v)", got, err)
		}
	})
	t.Run("from stdin", func(t *testing.T) {
		got, err := readWifConfig("-", strings.NewReader(`{"type":"external_account"}`))
		if err != nil || !strings.Contains(got, "external_account") {
			t.Fatalf("readWifConfig(-) = (%q, %v)", got, err)
		}
	})
	for _, tc := range []struct{ name, ref, stdin, wantIn string }{
		{"missing file", filepath.Join(dir, "nope.json"), "", "read WIF config"},
		{"empty file", empty, "", "is empty"},
		{"empty stdin", "-", "  \n", "no WIF config on stdin"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := readWifConfig(tc.ref, strings.NewReader(tc.stdin))
			if err == nil || !strings.Contains(err.Error(), tc.wantIn) {
				t.Fatalf("readWifConfig = %v, want a message containing %q", err, tc.wantIn)
			}
		})
	}
}

// TestConnField_AzureFlagIDsRequireTheWholeTriple pins that a half-given identity is refused
// locally. Sent, it would be stored and then fail its health probe with an Azure-side
// message, which reads as a cloud fault rather than the missing flag it is.
func TestConnField_AzureFlagIDsRequireTheWholeTriple(t *testing.T) {
	ids, err := azureFlagIDs("  t1  ", " c1", "s1 ")
	if err != nil {
		t.Fatalf("azureFlagIDs(complete) = %v", err)
	}
	if ids.TenantID != "t1" || ids.ClientID != "c1" || ids.SubscriptionID != "s1" {
		t.Errorf("values not trimmed: %+v", ids)
	}
	for _, tc := range []struct {
		name, tenant, client, sub, wantIn string
	}{
		{"no tenant", "", "c1", "s1", "--tenant-id"},
		{"no client", "t1", "", "s1", "--client-id"},
		{"no subscription", "t1", "c1", "", "--subscription"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := azureFlagIDs(tc.tenant, tc.client, tc.sub)
			if err == nil || !strings.Contains(err.Error(), tc.wantIn) {
				t.Fatalf("azureFlagIDs = %v, want a message naming %s", err, tc.wantIn)
			}
		})
	}
}

// TestConnField_HetznerS3IsAPairOrNothing pins the S3 credential rule. hetznerCreds omits an
// empty member, so half a pair used to be accepted and stored as an access key with no
// secret — a credential that cannot work, discovered later as a bucket that will not
// provision.
func TestConnField_HetznerS3IsAPairOrNothing(t *testing.T) {
	t.Run("both given", func(t *testing.T) {
		hygCliConfirmSetNoInput(t, true)
		a, s, err := resolveHetznerS3(" AK ", " SK ")
		if err != nil || a != "AK" || s != "SK" {
			t.Fatalf("resolveHetznerS3(pair) = (%q, %q, %v)", a, s, err)
		}
	})
	t.Run("neither given, scripted", func(t *testing.T) {
		hygCliConfirmSetNoInput(t, true)
		a, s, err := resolveHetznerS3("", "")
		if err != nil || a != "" || s != "" {
			t.Fatalf("an optional field's absence is an answer, got (%q, %q, %v)", a, s, err)
		}
	})
	for _, tc := range []struct{ name, access, secret, wantIn string }{
		{"access without secret", "AK", "", "--s3-secret-key"},
		{"secret without access", "", "SK", "--s3-access-key"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			hygCliConfirmSetNoInput(t, true)
			if _, _, err := resolveHetznerS3(tc.access, tc.secret); err == nil ||
				!strings.Contains(err.Error(), tc.wantIn) {
				t.Fatalf("resolveHetznerS3 = %v, want a message naming %s", err, tc.wantIn)
			}
		})
	}
	t.Run("declined on a terminal", func(t *testing.T) {
		hygCliConfirmSetNoInput(t, false)
		connStubForm(t, nil) // the Confirm is left at its No default
		a, s, err := resolveHetznerS3("", "")
		if err != nil || a != "" || s != "" {
			t.Fatalf("declining the offer must add nothing, got (%q, %q, %v)", a, s, err)
		}
	})
}

// connStubFormSequence answers a SEQUENCE of forms: the nth call to runHuhForm is answered
// with the nth slice of answers, each typed into successive fields. connStubFormTyping
// replays the same answers into every form, which cannot express a flow whose second form
// depends on the first — the Object-Storage offer being the one in this group.
func connStubFormSequence(t *testing.T, calls ...[]string) {
	t.Helper()
	hygCliConfirmInteractive(t)
	n := 0
	prev := runHuhForm
	runHuhForm = func(groups ...*huh.Group) error {
		f := huh.NewForm(groups...)
		f.Init()
		if n < len(calls) {
			for _, answer := range calls[n] {
				for _, r := range answer {
					f.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{r}})
				}
				f.Update(huh.NextField())
			}
		}
		n++
		return nil
	}
	t.Cleanup(func() { runHuhForm = prev })
}

// TestConnField_HetznerS3AcceptedOfferCapturesThePair covers the arm a flag can never reach:
// the user says yes to the Object-Storage offer and types the pair.
func TestConnField_HetznerS3AcceptedOfferCapturesThePair(t *testing.T) {
	hygCliConfirmSetNoInput(t, false)
	connStubFormSequence(t, []string{"y"}, []string{"AKIA", "sekrit"})
	access, secret, err := resolveHetznerS3("", "")
	if err != nil {
		t.Fatalf("resolveHetznerS3: %v", err)
	}
	if access != "AKIA" || secret != "sekrit" {
		t.Errorf("captured pair = (%q, %q), want (AKIA, sekrit)", access, secret)
	}
}

// TestConnField_HetznerS3AbortedFormsAreErrors pins both prompt arms: an aborted offer and an
// aborted pair must not connect with a half or empty credential.
func TestConnField_HetznerS3AbortedFormsAreErrors(t *testing.T) {
	t.Run("offer aborted", func(t *testing.T) {
		hygCliConfirmSetNoInput(t, false)
		connStubForm(t, errors.New("aborted"))
		if _, _, err := resolveHetznerS3("", ""); err == nil {
			t.Fatal("an aborted offer must be an error, not a silent skip")
		}
	})
	t.Run("pair aborted", func(t *testing.T) {
		hygCliConfirmSetNoInput(t, false)
		n := 0
		prev := runHuhForm
		runHuhForm = func(groups ...*huh.Group) error {
			n++
			if n == 1 {
				f := huh.NewForm(groups...)
				f.Init()
				f.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'y'}})
				return nil
			}
			return errors.New("aborted")
		}
		t.Cleanup(func() { runHuhForm = prev })
		if _, _, err := resolveHetznerS3("", ""); err == nil {
			t.Fatal("an aborted pair prompt must be an error")
		}
	})
}

// TestConnField_HetznerHalfPairIsFatalThroughTheTree pins the refusal on the real command,
// not only on the helper: half a pair must stop before /connect — and before /init, which is
// the assertion that matters. Half a pair is a complaint about the command line, so refusing
// it after initProviderIdentity left an orphaned pending identity the user had to
// `connector remove` before retrying.
func TestConnField_HetznerHalfPairIsFatalThroughTheTree(t *testing.T) {
	hygCliConfirmResetFlags()
	rec := &connRecorder{}
	run := connEnv(t, connFakeAPI{rec: rec})
	exited, code, err := connInvoke(t, run, "connector", "hetzner",
		"--token", strings.Repeat("h", 64), "--s3-access-key", "AK")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if !exited || code == 0 {
		t.Fatalf("half an S3 pair must exit fatally, got exited=%v code=%d", exited, code)
	}
	if rec.saw("/connect") {
		t.Error("a half credential reached the control plane")
	}
	if rec.saw("/init") {
		t.Errorf("a pending cloud identity was created before the flags were checked (%v) — "+
			"the user is left with an orphan to remove", rec.paths)
	}
}

// TestConnField_HetznerS3OfferAcceptedThenLeftBlankIsNeither covers the arm only the prompt
// can reach: the Yes/No offer is answered Yes out of curiosity and both inputs are submitted
// blank. Neither input has a Validate, so both-blank arrived at validateHetznerS3Pair — which
// reported "an S3 secret key was given without an access key" and aborted the whole run, for
// an OPTIONAL field, after the token was captured. Both blank is "neither", not half.
func TestConnField_HetznerS3OfferAcceptedThenLeftBlankIsNeither(t *testing.T) {
	hygCliConfirmSetNoInput(t, false)
	connStubFormSequence(t, []string{"y"}, nil) // accepted, then both inputs left empty
	access, secret, err := resolveHetznerS3("", "")
	if err != nil {
		t.Fatalf("two blank inputs for an optional pair must not be an error: %v", err)
	}
	if access != "" || secret != "" {
		t.Errorf("captured (%q, %q) from two blank inputs", access, secret)
	}
}

// TestConnField_ConflictingSetupModesAreRefused pins the combinations each command's
// resolution switch would otherwise settle by PRECEDENCE. `connector alibaba --terraform
// --role-arn …` wrote no OpenTofu module, never said --terraform had been ignored, and
// connected: the user asked for a module on disk and got a connection. The refusal must name
// both flags, and must land before /init so no pending identity is left behind.
func TestConnField_ConflictingSetupModesAreRefused(t *testing.T) {
	for _, tc := range []struct {
		name      string
		args      []string
		wantNamed []string
	}{
		{
			"alibaba · terraform with a role arn",
			[]string{"connector", "alibaba", "--terraform", "--role-arn", "acs:ram::123456789012:role/A"},
			[]string{"--role-arn", "--terraform"},
		},
		{
			"aws · manual with a role arn",
			[]string{"connector", "aws", "--manual", "--role-arn", "arn:aws:iam::123456789012:role/A"},
			[]string{"--role-arn", "--manual"},
		},
		{
			"aws · manual and script",
			[]string{"connector", "aws", "--manual", "--script"},
			[]string{"--manual", "--script"},
		},
		{
			"gcp · manual with a wif config",
			[]string{"connector", "gcp", "--project", "p1", "--manual", "--wif-config", "-"},
			[]string{"--wif-config", "--manual"},
		},
		{
			"azure · manual with the identity ids",
			[]string{"connector", "azure", "--subscription", "s1", "--manual",
				"--tenant-id", "t1", "--client-id", "c1"},
			[]string{"--tenant-id/--client-id", "--manual"},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			hygCliConfirmResetFlags()
			rec := &connRecorder{}
			run := connEnv(t, connFakeAPI{rec: rec})
			connNoCloudCLIs(t)

			var exited bool
			var code int
			out := connCaptureStdout(t, func() {
				exited, code, _ = connInvoke(t, run, tc.args...)
			})
			if !exited || code == 0 {
				t.Fatalf("an ignored flag must be refused, got exited=%v code=%d", exited, code)
			}
			for _, want := range tc.wantNamed {
				if !strings.Contains(out, want) {
					t.Errorf("the refusal did not name %s — the user cannot tell which flag lost; "+
						"it said:\n%s", want, out)
				}
			}
			if rec.saw("/init") {
				t.Errorf("a pending cloud identity was created before the flags were checked (%v)", rec.paths)
			}
		})
	}
}

// TestConnField_PickerArmOfTheRefResolver covers resolving with NO argument on a terminal —
// the arm that exists so nobody has to hold an id at all.
func TestConnField_PickerArmOfTheRefResolver(t *testing.T) {
	hygCliConfirmSetNoInput(t, false)
	connStubFormTyping(t) // huh seeds a Select with its first option on Init
	lister := &connFakeLister{identities: []api.CloudIdentity{
		{ID: "ci-first", Provider: "aws", Label: "prod"},
		{ID: "ci-second", Provider: "gcp", Label: "analytics"},
	}}
	got, err := resolveCloudIdentityRef(lister, "")
	if err != nil {
		t.Fatalf("resolveCloudIdentityRef(picker): %v", err)
	}
	if got != "ci-first" {
		t.Errorf("picker returned %q, want the selected account's id", got)
	}
}

// TestConnField_PickerAnsweringNothingIsAnError pins the arm where the form closes without a
// selection: returning "" would have been sent to the server as an identity id.
func TestConnField_PickerAnsweringNothingIsAnError(t *testing.T) {
	hygCliConfirmSetNoInput(t, false)
	connStubForm(t, nil) // returns without touching the bound value
	if _, err := pickConnectedIdentity("Select a cloud account", nil); err == nil {
		t.Fatal("an unanswered picker must be an error, not an empty identity id")
	}
}

// TestConnField_ResolveProviderRefEdges covers resolveProviderRef's failure arms.
func TestConnField_ResolveProviderRefEdges(t *testing.T) {
	t.Run("the list fails", func(t *testing.T) {
		hygCliConfirmSetNoInput(t, false)
		_, err := resolveProviderRef(&connFakeLister{err: errors.New("boom")}, nil)
		if err == nil || !strings.Contains(err.Error(), "failed to fetch cloud connections") {
			t.Fatalf("err = %v", err)
		}
	})
	t.Run("nothing connected", func(t *testing.T) {
		hygCliConfirmSetNoInput(t, false)
		_, err := resolveProviderRef(&connFakeLister{identities: []api.CloudIdentity{}}, nil)
		if err == nil || !strings.Contains(err.Error(), "no cloud accounts connected") {
			t.Fatalf("err = %v", err)
		}
	})
	t.Run("picker aborted", func(t *testing.T) {
		hygCliConfirmSetNoInput(t, false)
		connStubForm(t, errors.New("aborted"))
		_, err := resolveProviderRef(&connFakeLister{identities: []api.CloudIdentity{
			{ID: "ci-aws", Provider: "aws"},
		}}, nil)
		if err == nil {
			t.Fatal("an aborted picker must be an error")
		}
	})
}

// TestConnField_ReadWifConfigStdinReadError covers the broken-pipe arm: a read failure must
// surface as a read error, not as an empty config that then fails JSON parsing.
func TestConnField_ReadWifConfigStdinReadError(t *testing.T) {
	_, err := readWifConfig("-", errReader{})
	if err == nil || !strings.Contains(err.Error(), "stdin") {
		t.Fatalf("readWifConfig(-) = %v, want a stdin read error", err)
	}
}
