// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Unit proofs for the keyless refresher/mint subcommands and the placement seams that only
// ran in-cluster: the fail-closed flag contracts of registry-token / helm-repo-token /
// db-token / db-bootstrap, the kubectl `--patch-file` hygiene (the token must reach a 0600
// file, never argv), the Talos kubeconfig mint's SSRF + wiring guards, and the kube-conn /
// namespace-identity resolvers' fail-closed defaults.
package agent

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// ── subcommand flag contracts ────────────────────────────────────────────────────────────

// TestRunRegistryToken_FailsClosed locks every startup refusal of the pull-secret refresher:
// a half-specified invocation must die at startup, never mint against a wrong target.
func TestRunRegistryToken_FailsClosed(t *testing.T) {
	cases := []struct {
		name string
		args []string
		want string
	}{
		{"no secret", []string{"--provider", "aws", "--registry-host", "r.example.test"}, "--secret and --registry-host are required"},
		{"no host", []string{"--provider", "aws", "--secret", "app-pull"}, "--secret and --registry-host are required"},
		{"aws without region", []string{"--provider", "aws", "--secret", "app-pull", "--registry-host", "r.example.test"}, "--region is required"},
		{"unknown provider", []string{"--provider", "oracle", "--secret", "app-pull", "--registry-host", "r.example.test"}, "unsupported provider"},
		{"empty provider", []string{"--secret", "app-pull", "--registry-host", "r.example.test"}, "unsupported provider"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := RunRegistryToken(context.Background(), tc.args)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, want one containing %q", err, tc.want)
			}
		})
	}
}

// TestRunHelmRepoToken_FailsClosed locks the OCI chart-repo refresher's startup contract:
// private ECR needs both a region and a cross-account role before anything is minted.
func TestRunHelmRepoToken_FailsClosed(t *testing.T) {
	cases := []struct {
		name string
		args []string
		want string
	}{
		{"no secret", []string{"--region", "eu-west-1"}, "--secret is required"},
		{"private without region", []string{"--secret", "repo-helm-abc"}, "--region is required for private ECR"},
		{"private without role", []string{"--secret", "repo-helm-abc", "--region", "eu-west-1"}, "--target-role-arn is required"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := RunHelmRepoToken(context.Background(), tc.args)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, want one containing %q", err, tc.want)
			}
		})
	}
}

// TestRunDBToken_FailsClosed locks the sidecar's startup contract: no output path, an
// unknown cloud, or a half-specified AWS invocation must all refuse before any mint.
func TestRunDBToken_FailsClosed(t *testing.T) {
	cases := []struct {
		name string
		args []string
		want string
	}{
		{"no out", []string{"--provider", "azure"}, "--out is required"},
		{"unknown provider", []string{"--provider", "gcp", "--out", "/tmp/x"}, "unsupported provider"},
		{"aws without host", []string{"--provider", "aws", "--out", "/tmp/x", "--region", "eu-west-1", "--user", "app"}, "--host, --region and --user are required"},
		{"aws without region", []string{"--provider", "aws", "--out", "/tmp/x", "--host", "db.test", "--user", "app"}, "--host, --region and --user are required"},
		{"aws without user", []string{"--provider", "aws", "--out", "/tmp/x", "--host", "db.test", "--region", "eu-west-1"}, "--host, --region and --user are required"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := RunDBToken(context.Background(), tc.args)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, want one containing %q", err, tc.want)
			}
		})
	}
}

// TestRunDBBootstrap_FlagGuards covers the CLI half of the bootstrap emitter: the friendly
// per-engine guards, and the --out path the PreSync Job's init container actually uses.
func TestRunDBBootstrap_FlagGuards(t *testing.T) {
	refuse := []struct {
		name string
		args []string
		want string
	}{
		{"no db", []string{"--provider", "aws"}, "--db is required"},
		{"azure mysql without client id", []string{"--provider", "azure", "--engine", "mysql", "--db", "appdb"}, "requires --app-client-id"},
		{"gcp mysql without app user", []string{"--provider", "gcp", "--engine", "mysql", "--db", "appdb"}, "requires --app-user"},
		{"mysql without provider", []string{"--engine", "mysql", "--db", "appdb"}, "requires --provider aws|azure|gcp"},
	}
	for _, tc := range refuse {
		t.Run(tc.name, func(t *testing.T) {
			err := RunDBBootstrap(context.Background(), tc.args)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, want one containing %q", err, tc.want)
			}
		})
	}

	out := filepath.Join(t.TempDir(), "bootstrap.sql")
	if err := RunDBBootstrap(context.Background(), []string{
		"--provider", "aws", "--engine", "mysql", "--db", "appdb", "--out", out,
	}); err != nil {
		t.Fatalf("RunDBBootstrap: %v", err)
	}
	sql, err := os.ReadFile(out)
	if err != nil {
		t.Fatalf("read emitted SQL: %v", err)
	}
	if !strings.Contains(string(sql), keylessBootstrapRole) {
		t.Errorf("emitted SQL must name the shared least-priv role %q:\n%s", keylessBootstrapRole, sql)
	}
	if strings.Contains(string(sql), "GRANT ALL") || strings.Contains(string(sql), "*.*") {
		t.Errorf("emitted SQL must stay least-privilege:\n%s", sql)
	}
}

// TestRunKubeToken_UnsupportedProviders covers the exec-credential plugin's fail-closed
// dispatch for a provider it does not serve and for ACK (which by design has no exec token).
func TestRunKubeToken_UnsupportedProviders(t *testing.T) {
	if err := RunKubeToken(context.Background(), []string{"--provider", "hetzner"}); err == nil ||
		!strings.Contains(err.Error(), "unsupported provider") {
		t.Fatalf("err = %v, want the unsupported-provider refusal", err)
	}
	if err := RunKubeToken(context.Background(), []string{"--provider", "alibaba"}); err == nil ||
		!strings.Contains(err.Error(), "kube-token is not used for alibaba") {
		t.Fatalf("err = %v, want the by-design ACK refusal", err)
	}
}

// ── kubectl patch hygiene ────────────────────────────────────────────────────────────────

// stubKubectl puts a fake `kubectl` first on PATH that records its argv and the contents of
// the file named by --patch-file, then returns the recorder.
func stubKubectl(t *testing.T) (argvPath, patchCopyPath string) {
	t.Helper()
	dir := t.TempDir()
	argvPath = filepath.Join(dir, "argv.txt")
	patchCopyPath = filepath.Join(dir, "patch.json")
	script := "#!/bin/sh\n" +
		"printf '%s\\n' \"$@\" > " + argvPath + "\n" +
		"prev=''\n" +
		"for a in \"$@\"; do\n" +
		"  if [ \"$prev\" = \"--patch-file\" ]; then cp \"$a\" " + patchCopyPath + "; fi\n" +
		"  prev=\"$a\"\n" +
		"done\n" +
		"exit 0\n"
	if err := os.WriteFile(filepath.Join(dir, "kubectl"), []byte(script), 0o755); err != nil {
		t.Fatalf("write stub kubectl: %v", err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	return argvPath, patchCopyPath
}

// TestPatchPullSecret_TokenNeverOnArgv proves the pull-secret patcher's core hygiene rule:
// the dockerconfigjson reaches kubectl through a --patch-file, never on the command line
// (which /proc makes world-readable), and the patch carries the payload base64'd.
func TestPatchPullSecret_TokenNeverOnArgv(t *testing.T) {
	argvPath, patchPath := stubKubectl(t)
	dcj := dockerConfigJSON("123.dkr.ecr.eu-west-1.amazonaws.com", "AWS", "super-secret-ecr-token")

	if err := patchPullSecret(context.Background(), "acme", "acme-pull", dcj); err != nil {
		t.Fatalf("patchPullSecret: %v", err)
	}

	argv, err := os.ReadFile(argvPath)
	if err != nil {
		t.Fatalf("read argv: %v", err)
	}
	if strings.Contains(string(argv), "super-secret-ecr-token") {
		t.Fatalf("the token reached kubectl's argv:\n%s", argv)
	}
	for _, want := range []string{"patch", "secret", "acme-pull", "acme", "--patch-file"} {
		if !strings.Contains(string(argv), want) {
			t.Errorf("argv is missing %q:\n%s", want, argv)
		}
	}
	patch, err := os.ReadFile(patchPath)
	if err != nil {
		t.Fatalf("read patch file: %v", err)
	}
	if strings.Contains(string(patch), "super-secret-ecr-token") {
		t.Errorf("the patch must carry the payload base64'd, not in plaintext:\n%s", patch)
	}
	var decoded map[string]map[string]string
	if err := json.Unmarshal(patch, &decoded); err != nil {
		t.Fatalf("patch is not the expected strategic-merge JSON: %v", err)
	}
	if decoded["data"][".dockerconfigjson"] == "" {
		t.Errorf("patch does not set .dockerconfigjson: %s", patch)
	}
}

// TestPatchHelmRepoSecret_TokenNeverOnArgv is the ArgoCD repo-cred twin: the rotating
// username/password reach kubectl only through the patch file, base64'd.
func TestPatchHelmRepoSecret_TokenNeverOnArgv(t *testing.T) {
	argvPath, patchPath := stubKubectl(t)

	if err := patchHelmRepoSecret(context.Background(), "argocd", "repo-helm-abc", "AWS", "super-secret-helm-token"); err != nil {
		t.Fatalf("patchHelmRepoSecret: %v", err)
	}

	argv, err := os.ReadFile(argvPath)
	if err != nil {
		t.Fatalf("read argv: %v", err)
	}
	if strings.Contains(string(argv), "super-secret-helm-token") {
		t.Fatalf("the token reached kubectl's argv:\n%s", argv)
	}
	if !strings.Contains(string(argv), "argocd") || !strings.Contains(string(argv), "repo-helm-abc") {
		t.Errorf("argv must address the argocd repo-cred Secret:\n%s", argv)
	}
	patch, err := os.ReadFile(patchPath)
	if err != nil {
		t.Fatalf("read patch file: %v", err)
	}
	if strings.Contains(string(patch), "super-secret-helm-token") {
		t.Errorf("the patch must carry the password base64'd:\n%s", patch)
	}
	var decoded map[string]map[string]string
	if err := json.Unmarshal(patch, &decoded); err != nil {
		t.Fatalf("patch is not the expected strategic-merge JSON: %v", err)
	}
	if decoded["data"]["username"] == "" || decoded["data"]["password"] == "" {
		t.Errorf("patch must set both credentials: %s", patch)
	}
}

// TestPatchPullSecret_SurfacesKubectlFailure covers the error path: a non-zero kubectl is
// reported with its stderr, not swallowed into a silently-stale pull secret.
func TestPatchPullSecret_SurfacesKubectlFailure(t *testing.T) {
	dir := t.TempDir()
	script := "#!/bin/sh\necho 'Error from server (Forbidden)' 1>&2\nexit 1\n"
	if err := os.WriteFile(filepath.Join(dir, "kubectl"), []byte(script), 0o755); err != nil {
		t.Fatalf("write stub kubectl: %v", err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))

	err := patchPullSecret(context.Background(), "acme", "acme-pull", "{}")
	if err == nil || !strings.Contains(err.Error(), "kubectl patch failed") {
		t.Fatalf("err = %v, want the kubectl failure", err)
	}
	if !strings.Contains(err.Error(), "Forbidden") {
		t.Errorf("err = %v, want kubectl's stderr surfaced", err)
	}
}

// ── talos placement mint ─────────────────────────────────────────────────────────────────

// TestMintTalosKubeconfig_FailsClosed proves the mint refuses before dialing on every
// unusable talosconfig — including the SSRF-guarded loopback/link-local endpoints.
func TestMintTalosKubeconfig_FailsClosed(t *testing.T) {
	cases := []struct {
		name string
		yaml string
		want string
	}{
		{"empty", "   \n", "the Fabric has no persisted admin credential"},
		{"unparseable", "\tnot: [yaml", "parse talosconfig"},
		{"loopback endpoint", "context: fabric\ncontexts:\n  fabric:\n    endpoints:\n      - 127.0.0.1\n", "SSRF guard"},
		{"metadata endpoint", "context: fabric\ncontexts:\n  fabric:\n    endpoints:\n      - 169.254.169.254:50000\n", "SSRF guard"},
		{"no endpoints", "context: fabric\ncontexts:\n  fabric:\n    endpoints: []\n", "carries no endpoints"},
		{"missing active context", "context: other\ncontexts:\n  fabric:\n    endpoints:\n      - 203.0.113.9\n", "no active context"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			kubeconfig, err := MintTalosKubeconfig(context.Background(), tc.yaml)
			if kubeconfig != nil {
				t.Fatalf("a kubeconfig was returned for %s", tc.name)
			}
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, want one containing %q", err, tc.want)
			}
		})
	}
}

// TestNewTalosKubeconfigMinter proves the provisioner seam: no persisted talosconfig ⇒ nil
// (the placement then fails closed in mintClusterOutputs), and a present-but-unsafe one
// still refuses rather than returning a partial kubeconfig.
func TestNewTalosKubeconfigMinter(t *testing.T) {
	if got := newTalosKubeconfigMinter("  "); got != nil {
		t.Fatal("an empty talosconfig must yield a nil minter so the placement fails closed")
	}
	mint := newTalosKubeconfigMinter("context: fabric\ncontexts:\n  fabric:\n    endpoints:\n      - 127.0.0.1\n")
	if mint == nil {
		t.Fatal("a present talosconfig must yield a minter")
	}
	kubeconfig, err := mint(context.Background(), &types.ProjectConfig{}, "fabric-cluster")
	if kubeconfig != "" {
		t.Errorf("kubeconfig = %q, want empty on refusal", kubeconfig)
	}
	if err == nil || !strings.Contains(err.Error(), "SSRF guard") {
		t.Fatalf("err = %v, want the SSRF refusal", err)
	}
}

// TestIsTalosPlacementMode locks which placement modes must re-mint from the persisted
// talosconfig (namespace/vcluster) versus the dedicated apply that emits its own.
func TestIsTalosPlacementMode(t *testing.T) {
	cases := map[types.PlacementMode]bool{
		types.PlacementModeNamespace: true,
		types.PlacementModeVcluster:  true,
		types.PlacementModeDedicated: false,
		types.PlacementMode(""):      false,
	}
	for mode, want := range cases {
		if got := isTalosPlacementMode(mode); got != want {
			t.Errorf("isTalosPlacementMode(%q) = %v, want %v", mode, got, want)
		}
	}
}

// TestTalosOutputString covers both tofu output shapes the write-back tolerates plus the
// misses that must yield "" rather than a partial credential.
func TestTalosOutputString(t *testing.T) {
	outputs := map[string]interface{}{
		"talosconfig":   map[string]interface{}{"value": "context: fabric"},
		"bare":          "plain-string",
		"wrong-wrapped": map[string]interface{}{"value": 42},
		"wrong-type":    7,
	}
	cases := map[string]string{
		"talosconfig":   "context: fabric",
		"bare":          "plain-string",
		"wrong-wrapped": "",
		"wrong-type":    "",
		"absent":        "",
	}
	for key, want := range cases {
		if got := talosOutputString(outputs, key); got != want {
			t.Errorf("talosOutputString(%q) = %q, want %q", key, got, want)
		}
	}
}

// ── placement resolvers ──────────────────────────────────────────────────────────────────

// TestKubeConnResolver_FailsClosedOnUnwiredProvider proves the defence-in-depth default:
// a provider with no output-free resolver returns an error, never an empty connection that
// would silently produce an unusable kubeconfig.
func TestKubeConnResolver_FailsClosedOnUnwiredProvider(t *testing.T) {
	resolve := newKubeConnResolver()
	for _, provider := range []string{"hetzner", "aws", "alibaba", ""} {
		endpoint, ca, err := resolve(context.Background(), provider, &types.ProjectConfig{}, "fabric")
		if err == nil {
			t.Errorf("provider %q: expected a refusal, got endpoint=%q", provider, endpoint)
		}
		if endpoint != "" || ca != "" {
			t.Errorf("provider %q: partial connection returned (%q, %q)", provider, endpoint, ca)
		}
	}
}

// TestNamespaceIdentityProvisioner_FailsClosedOnUnwiredProvider is the identity twin: an
// unactivated cloud must refuse rather than hand back an empty identity handle.
func TestNamespaceIdentityProvisioner_FailsClosedOnUnwiredProvider(t *testing.T) {
	provision := newNamespaceIdentityProvisioner()
	for _, provider := range []string{"hetzner", "aws", "alibaba", ""} {
		handle, err := provision(context.Background(), provider, &types.ProjectConfig{}, "fabric", "team-a")
		if err == nil {
			t.Errorf("provider %q: expected a refusal, got handle=%q", provider, handle)
		}
		if handle != "" {
			t.Errorf("provider %q: partial handle %q returned", provider, handle)
		}
	}
}

// ── talosconfig job channel ──────────────────────────────────────────────────────────────

// TestFetchAndPutFabricTalosconfig drives both halves of the authenticated talosconfig
// channel against a stub console: the runner headers, the absent-config ("" not an error)
// contract, and the write-back's JSON body.
func TestFetchAndPutFabricTalosconfig(t *testing.T) {
	var putBody string
	var sawRunnerHeaders bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawRunnerHeaders = r.Header.Get("X-Runner-ID") == "runner-1" && r.Header.Get("X-Runner-Token") == "tok"
		switch {
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/job-present/talosconfig"):
			_, _ = w.Write([]byte(`{"talosconfig":"context: fabric"}`))
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/job-absent/talosconfig"):
			_, _ = w.Write([]byte(`{"talosconfig":null}`))
		case r.Method == http.MethodPut:
			b := make([]byte, r.ContentLength)
			_, _ = r.Body.Read(b)
			putBody = string(b)
			w.WriteHeader(http.StatusOK)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()

	c := NewRunnerAPIClient(srv.URL, "runner-1", "tok")

	got, err := c.FetchFabricTalosconfig("job-present")
	if err != nil || got != "context: fabric" {
		t.Fatalf("FetchFabricTalosconfig = (%q, %v), want the persisted config", got, err)
	}
	if !sawRunnerHeaders {
		t.Error("the talosconfig fetch must carry the runner identity headers")
	}

	got, err = c.FetchFabricTalosconfig("job-absent")
	if err != nil || got != "" {
		t.Fatalf("a Fabric with no talosconfig must yield (\"\", nil), got (%q, %v)", got, err)
	}

	if _, err := c.FetchFabricTalosconfig("job-missing"); err == nil {
		t.Error("a non-200 must be an error")
	}

	if err := c.PutFabricTalosconfig("job-present", "context: fabric"); err != nil {
		t.Fatalf("PutFabricTalosconfig: %v", err)
	}
	if !strings.Contains(putBody, "context: fabric") {
		t.Errorf("PUT body = %q, want the talosconfig", putBody)
	}
}

// ── small seams ──────────────────────────────────────────────────────────────────────────

// TestBuildCompatOverride mirrors buildVerifyOverride's contract for the version-compat
// gate: no waiver / no controls ⇒ nil (the gate stays fail-closed), otherwise the recorded
// controls, reason, author and RFC3339 expiry.
func TestBuildCompatOverride(t *testing.T) {
	if got, _ := buildCompatOverride(nil); got != nil {
		t.Error("a nil payload must yield no override")
	}
	if got, _ := buildCompatOverride(map[string]any{"reason": "x"}); got != nil {
		t.Error("a payload with no controls must yield no override")
	}
	if got, _ := buildCompatOverride(map[string]any{"controls": []any{"", 7}}); got != nil {
		t.Error("a payload whose controls coerce to nothing must yield no override")
	}

	ov, _ := buildCompatOverride(map[string]any{
		"controls": []any{"COMPAT-COMPONENT-ARGOCD", "COMPAT-K8S"},
		"reason":   "vendor lag",
		"by":       "secops@acme",
		"expiry":   "2026-09-01T00:00:00Z",
	})
	if ov == nil {
		t.Fatal("a complete waiver must produce an override")
	}
	if len(ov.Controls) != 2 || ov.Controls[0] != "COMPAT-COMPONENT-ARGOCD" {
		t.Errorf("controls = %v", ov.Controls)
	}
	if ov.Reason != "vendor lag" || ov.By != "secops@acme" {
		t.Errorf("reason/by = %q/%q", ov.Reason, ov.By)
	}
	want := time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)
	if !ov.Expiry.Equal(want) {
		t.Errorf("expiry = %v, want %v", ov.Expiry, want)
	}

	single, _ := buildCompatOverride(map[string]any{"controls": "COMPAT-K8S"})
	if single == nil || len(single.Controls) != 1 {
		t.Errorf("a single control string must coerce to one control, got %+v", single)
	}
}

// TestNamespaceManifest checks the build namespace the BUILD handler applies is a valid,
// alethia-labelled Namespace naming exactly the requested namespace.
func TestNamespaceManifest(t *testing.T) {
	m := namespaceManifest("alethia-build")
	for _, want := range []string{"kind: Namespace", "name: alethia-build", "app.kubernetes.io/managed-by: alethia"} {
		if !strings.Contains(m, want) {
			t.Errorf("manifest is missing %q:\n%s", want, m)
		}
	}
}

// TestExtractOutputStr covers the tofu string-output reader on the wrapped, bare, wrong-type
// and absent shapes.
func TestExtractOutputStr(t *testing.T) {
	outputs := map[string]interface{}{
		"wrapped": map[string]interface{}{"value": "alethia-build:kaniko-builder"},
		"bare":    "plain",
		"number":  map[string]interface{}{"value": 42},
	}
	cases := map[string]string{
		"wrapped": "alethia-build:kaniko-builder",
		"bare":    "plain",
		"number":  "",
		"absent":  "",
	}
	for key, want := range cases {
		if got := extractOutputStr(outputs, key); got != want {
			t.Errorf("extractOutputStr(%q) = %q, want %q", key, got, want)
		}
	}
}

// TestSentryEnvironment covers the deployment-tag resolution and its production default.
func TestSentryEnvironment(t *testing.T) {
	t.Setenv("SENTRY_ENVIRONMENT", "  staging  ")
	if got := sentryEnvironment(); got != "staging" {
		t.Errorf("sentryEnvironment() = %q, want \"staging\"", got)
	}
	t.Setenv("SENTRY_ENVIRONMENT", "   ")
	if got := sentryEnvironment(); got != "production" {
		t.Errorf("sentryEnvironment() = %q, want the production default", got)
	}
}

// TestSleepCtx proves the interruptible sleep returns immediately on cancellation instead
// of holding the reconnect backoff through a shutdown.
func TestSleepCtx(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	start := time.Now()
	sleepCtx(ctx, 5*time.Second)
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("sleepCtx blocked for %v on a cancelled context", elapsed)
	}

	start = time.Now()
	sleepCtx(context.Background(), 20*time.Millisecond)
	if elapsed := time.Since(start); elapsed < 10*time.Millisecond {
		t.Fatalf("sleepCtx returned after %v, want it to wait out the duration", elapsed)
	}
}
