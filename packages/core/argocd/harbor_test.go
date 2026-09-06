// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"context"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"golang.org/x/crypto/bcrypt"
	"gopkg.in/yaml.v3"
)

func hetznerRegistryProject(names ...string) *types.ProjectConfig {
	pc := &types.ProjectConfig{Provider: "hetzner"}
	for _, n := range names {
		pc.ContainerRegistries = append(pc.ContainerRegistries, types.ProjectContainerRegistryConfig{Name: n})
	}
	return pc
}

// THE invariant that fails silently. The dockerconfigjson is keyed on a host; if that host is not
// the one the kubelet pulls from, the entry is simply never matched — no error anywhere, and the
// pull fails looking exactly like a wrong password. Three places must agree: the chart's externalURL
// (console), this Host, and the Talos containerd mirror.
func TestHetznerRegistryHostMatchesTheConsoleContract(t *testing.T) {
	regs := HetznerRegistries(hetznerRegistryProject("app-images"))
	if len(regs) != 1 {
		t.Fatalf("derived %d registries, want 1", len(regs))
	}
	const want = "registry-app-images.registries.svc.cluster.local"
	if regs[0].Host != want {
		t.Fatalf("Host = %q, want %q — this must equal hetznerRegistryHost() in "+
			"apps/console/lib/cloud-providers/hetzner-services.ts, which also produced the chart's externalURL", regs[0].Host, want)
	}
}

// The generated fixture is produced by the REAL console mapper, so reading the host back out of it
// is a check against the actual TS contract rather than against a string retyped in Go.
func TestHetznerRegistryHostAgreesWithTheGeneratedFixture(t *testing.T) {
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate this file")
	}
	path := filepath.Join(filepath.Dir(thisFile), "..", "..", "..", "test", "e2e", "fixtures", "hetzner_data_services.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		// FATAL, NOT SKIP, for the reason stated on the queue twin in rabbitmq_test.go: these are
		// the only checks that the Go and TS halves of a name contract agree, and a skip is a green
		// run that checked nothing. Both sites here, because a hardening applied to one copy of
		// this pattern and not the other is how the registry path kept diverging in the first place.
		t.Fatalf("generated fixture not readable at %s (%v) — this test is the only check that the "+
			"Go and TS halves of this contract agree", path, err)
	}
	var fx struct {
		ChartedNotOffered []struct {
			ID     string         `json:"id"`
			Values map[string]any `json:"values"`
		} `json:"chartedNotOffered"`
		AddOns []struct {
			ID     string         `json:"id"`
			Values map[string]any `json:"values"`
		} `json:"addons"`
	}
	if err := json.Unmarshal(raw, &fx); err != nil {
		t.Fatalf("parse fixture: %v", err)
	}
	specs := append(fx.ChartedNotOffered, fx.AddOns...)
	var values map[string]any
	for _, s := range specs {
		if strings.HasPrefix(s.ID, "registry-") {
			values = s.Values
		}
	}
	if values == nil {
		t.Fatal("the fixture carries no registry spec")
	}
	externalURL, _ := fixtureLeaf(values, "externalURL")
	if externalURL == "" {
		t.Fatal("the fixture carries no registry spec with an externalURL")
	}
	reg := HetznerRegistries(hetznerRegistryProject("app-images"))[0]
	if externalURL != "http://"+reg.Host {
		t.Errorf("chart externalURL %q disagrees with the pull host %q — Harbor bakes externalURL into "+
			"the tokens it issues, so a mismatch authenticates and then 401s on every pull", externalURL, reg.Host)
	}

	// The chart must read EVERY credential from the Secret the runner seeds. Where it does not, it
	// falls back to a value goharbor publishes in its own values.yaml — `Harbor12345` for the admin
	// password (#2430), `not-a-secure-key` for the data-encryption key and `harbor_registry_password`
	// for the internal registry credential (#3299).
	//
	// Neither add-on ratchet can see this: both only run `helm template`, and pointing the chart at
	// an existingSecret is exactly what makes it STOP rendering the key — which is what turns those
	// guards green. So the correspondence between the console's knobs and the runner's key names is
	// checked HERE or nowhere, and hetzner-services.ts says so: "a mismatch is silent".
	//
	// The two groups are enumerated rather than derived from the spelling, because the spelling
	// lies: `existingSecretSecretKey` names a SECRET (the one holding `secretKey`), while
	// `existingSecretAdminPasswordKey` names a KEY.
	for _, path := range [][]string{
		{"existingSecretAdminPassword"},
		{"existingSecretSecretKey"},
		{"core", "existingSecret"},
		{"core", "existingXsrfSecret"},
		{"core", "secretName"},
		{"jobservice", "existingSecret"},
		{"registry", "existingSecret"},
		{"registry", "credentials", "existingSecret"},
	} {
		got, ok := fixtureLeaf(values, path...)
		if !ok {
			t.Errorf("the chart does not set %s, so Harbor falls back to its published default",
				strings.Join(path, "."))
			continue
		}
		if got != reg.AdminSecretName() {
			t.Errorf("chart %s = %q, runner seeds Secret %q",
				strings.Join(path, "."), got, reg.AdminSecretName())
		}
	}

	declared := map[string]bool{}
	for _, key := range harborCredentialKeys {
		declared[key] = true
	}
	for _, path := range [][]string{
		{"existingSecretAdminPasswordKey"},
		{"core", "existingXsrfSecretKey"},
		{"jobservice", "existingSecretKey"},
		{"registry", "existingSecretKey"},
	} {
		got, ok := fixtureLeaf(values, path...)
		if !ok {
			t.Errorf("the chart does not set %s", strings.Join(path, "."))
			continue
		}
		if !declared[got] {
			t.Errorf("chart %s reads key %q, which the runner never mints — the chart would find it "+
				"absent and fall back to its published default", strings.Join(path, "."), got)
		}
	}
	if adminKey, _ := fixtureLeaf(values, "existingSecretAdminPasswordKey"); adminKey != harborAdminSecretKey {
		t.Errorf("chart existingSecretAdminPasswordKey = %q, runner writes key %q", adminKey, harborAdminSecretKey)
	}
}

// fixtureLeaf walks a nested Helm values map to a string leaf.
func fixtureLeaf(values map[string]any, path ...string) (string, bool) {
	var cur any = values
	for _, step := range path {
		m, ok := cur.(map[string]any)
		if !ok {
			return "", false
		}
		cur, ok = m[step]
		if !ok {
			return "", false
		}
	}
	s, ok := cur.(string)
	return s, ok
}

func TestHetznerRegistriesOnlyOnHetzner(t *testing.T) {
	for _, provider := range []string{"aws", "gcp", "azure", "alibaba"} {
		pc := hetznerRegistryProject("app-images")
		pc.Provider = types.CloudProvider(provider)
		if got := HetznerRegistries(pc); len(got) != 0 {
			t.Errorf("%s derived %d in-cluster registries — every other cloud provisions a real one "+
				"whose nodes authenticate with their own identity", provider, len(got))
		}
	}
	if got := HetznerRegistries(nil); got != nil {
		t.Errorf("a nil project derived %v", got)
	}
}

func TestHetznerRegistriesSkipsAnUnsafeName(t *testing.T) {
	pc := hetznerRegistryProject("app-images", "Bad Name", "", "ok")
	got := HetznerRegistries(pc)
	names := make([]string, 0, len(got))
	for _, r := range got {
		names = append(names, r.Name)
	}
	// These names interpolate into a kubectl command line and a rendered manifest, so anything that
	// is not an RFC-1123 label is dropped rather than escaped.
	if len(got) != 2 || names[0] != "app-images" || names[1] != "ok" {
		t.Fatalf("derived %v, want only the two safe names", names)
	}
}

func TestHarborBootstrapJobIsLeastPrivilege(t *testing.T) {
	reg := HetznerRegistries(hetznerRegistryProject("app-images"))[0]
	y, err := HarborBootstrapJobManifest(reg, "ghcr.io/alethialabs/runner:abc123")
	if err != nil {
		t.Fatalf("render: %v", err)
	}

	// `get` + `patch` on exactly one named Secret. `list`/`watch` cannot be name-scoped, so granting
	// either would expose every Secret in the namespace; `create` cannot be name-scoped either, which
	// is why the Secret is pre-seeded by the runner instead.
	if !strings.Contains(y, `resourceNames: ["registry-app-images-pull"]`) {
		t.Error("the Role is not scoped to a single resourceName")
	}
	if !strings.Contains(y, `verbs: ["get", "patch"]`) {
		t.Error("the Role's verbs are not exactly get+patch")
	}
	for _, forbidden := range []string{`"list"`, `"watch"`, `"create"`, `"delete"`, `"*"`} {
		if strings.Contains(y, "verbs: [") && strings.Contains(strings.SplitN(y, "verbs: [", 2)[1][:40], forbidden) {
			t.Errorf("the Role grants %s", forbidden)
		}
	}
	if strings.Contains(y, "ClusterRole") {
		t.Error("the bootstrap Job binds a ClusterRole — it must be namespace-scoped")
	}
}

// The admin password must reach the Job as a mounted FILE. argv is world-readable through /proc and
// env is visible in `kubectl describe pod`; a credential in either is a credential in the job log of
// whoever debugs the pod next.
func TestHarborBootstrapJobTakesTheAdminPasswordAsAFile(t *testing.T) {
	reg := HetznerRegistries(hetznerRegistryProject("app-images"))[0]
	y, err := HarborBootstrapJobManifest(reg, "runner:v1")
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	if !strings.Contains(y, "--admin-password-file=/harbor-admin/"+harborAdminSecretKey) {
		t.Error("the admin password is not passed as a mounted file")
	}
	if !strings.Contains(y, "secretName: "+reg.AdminSecretName()) {
		t.Errorf("the Job does not mount %s", reg.AdminSecretName())
	}
	// No env-sourced credential anywhere.
	if strings.Contains(y, "secretKeyRef") || strings.Contains(y, "HARBOR_ADMIN_PASSWORD=") {
		t.Error("a credential reaches the container through env rather than a file")
	}
}

func TestHarborBootstrapJobPassesTheSameHostTwice(t *testing.T) {
	reg := HetznerRegistries(hetznerRegistryProject("app-images"))[0]
	y, err := HarborBootstrapJobManifest(reg, "runner:v1")
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	// The API base and the dockerconfigjson host are the same string on purpose: Harbor bakes
	// externalURL into its tokens, so an API reached by one name and a credential keyed on another
	// authenticates and then fails at pull.
	if !strings.Contains(y, "--api-base=http://"+reg.Host) || !strings.Contains(y, "--registry-host="+reg.Host) {
		t.Errorf("the Job does not pass %q as both the API base and the registry host", reg.Host)
	}
}

func TestHarborBootstrapJobRefusesInvalidInput(t *testing.T) {
	good := HetznerRegistries(hetznerRegistryProject("app-images"))[0]
	if _, err := HarborBootstrapJobManifest(good, ""); err == nil {
		t.Error("rendered a Job with no runner image")
	}
	bad := good
	bad.Host = "registry-app-images.registries.svc.cluster.local\nfoo: bar"
	if _, err := HarborBootstrapJobManifest(bad, "runner:v1"); err == nil {
		t.Error("rendered a Job with a host that would inject YAML")
	}
}

func TestHarborSecretManifestCarriesEveryCredentialWithoutPlaintext(t *testing.T) {
	data := map[string]string{}
	for _, key := range harborCredentialKeys {
		data[key] = base64.StdEncoding.EncodeToString([]byte("hunter2-" + key))
	}
	y := harborSecretManifest("registries", "harbor-app-images-admin", data)
	for _, key := range harborCredentialKeys {
		if !strings.Contains(y, "  "+key+": ") {
			t.Errorf("the Secret does not carry %s", key)
		}
	}
	if strings.Contains(y, "hunter2") {
		t.Error("a credential appears in plaintext in the manifest")
	}
}

func TestHarborAdminPasswordSatisfiesHarborsComplexityRule(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 20; i++ {
		pw, err := harborAdminPassword()
		if err != nil {
			t.Fatalf("generate: %v", err)
		}
		if len(pw) < 8 || len(pw) > 128 {
			t.Fatalf("password length %d is outside Harbor's 8-128 rule", len(pw))
		}
		var upper, lower, digit bool
		for _, r := range pw {
			switch {
			case r >= 'A' && r <= 'Z':
				upper = true
			case r >= 'a' && r <= 'z':
				lower = true
			case r >= '0' && r <= '9':
				digit = true
			}
		}
		if !upper || !lower || !digit {
			t.Fatalf("password %q misses a required class (upper=%v lower=%v digit=%v) — Harbor would refuse to start", pw, upper, lower, digit)
		}
		if seen[pw] {
			t.Fatal("generated a duplicate password")
		}
		seen[pw] = true
	}
}

func TestCompleteHarborCredentialsMintsTheFullChartContract(t *testing.T) {
	existingAdmin := base64.StdEncoding.EncodeToString([]byte("keep-this-admin"))
	data := map[string]string{harborAdminSecretKey: existingAdmin}
	changed, err := completeHarborCredentials(data)
	if err != nil {
		t.Fatalf("complete credentials: %v", err)
	}
	if !changed {
		t.Fatal("an admin-only legacy Secret was reported complete")
	}
	if data[harborAdminSecretKey] != existingAdmin {
		t.Fatal("rotated the existing admin password")
	}
	decoded := map[string]string{}
	for _, key := range harborCredentialKeys {
		raw, err := base64.StdEncoding.DecodeString(data[key])
		if err != nil || len(raw) == 0 {
			t.Fatalf("%s is not a non-empty base64 value: %v", key, err)
		}
		decoded[key] = string(raw)
	}
	if len(decoded["secretKey"]) != 16 {
		t.Fatalf("secretKey length = %d, want Harbor's exact 16", len(decoded["secretKey"]))
	}
	block, _ := pem.Decode([]byte(decoded["tls.key"]))
	if block == nil {
		t.Fatal("tls.key is not PEM")
	}
	if _, err := x509.ParsePKCS1PrivateKey(block.Bytes); err != nil {
		t.Fatalf("tls.key is not a PKCS#1 RSA private key: %v", err)
	}
	wantPrefix := harborRegistryUsername + ":"
	if !strings.HasPrefix(decoded["REGISTRY_HTPASSWD"], wantPrefix) {
		t.Fatalf("REGISTRY_HTPASSWD does not name %s", harborRegistryUsername)
	}
	hash := strings.TrimPrefix(decoded["REGISTRY_HTPASSWD"], wantPrefix)
	if err := bcrypt.CompareHashAndPassword([]byte(hash), []byte(decoded["REGISTRY_PASSWD"])); err != nil {
		t.Fatalf("REGISTRY_HTPASSWD is not the bcrypt of REGISTRY_PASSWD: %v", err)
	}
}

// ── the runner-side orchestration, against a stubbed kubectl ───────────────────────────────────

// A complete credential set is created ONCE and never rewritten. Re-applying would rotate Harbor's
// internal credentials while its database still holds the previous values.
func TestEnsureHarborSecretLeavesACompleteSecretAlone(t *testing.T) {
	data := map[string]string{}
	for _, key := range harborCredentialKeys {
		data[key] = base64.StdEncoding.EncodeToString([]byte("existing-" + key))
	}
	raw, err := json.Marshal(map[string]any{"data": data})
	if err != nil {
		t.Fatal(err)
	}
	stub := newKubectlStub(t, 0, stubRule{Match: "get secret", Stdout: string(raw)})
	reg := HetznerRegistries(hetznerRegistryProject("app-images"))[0]

	var out strings.Builder
	if err := EnsureHarborSecret(reg, &out, io.Discard); err != nil {
		t.Fatalf("EnsureHarborSecret: %v", err)
	}
	for _, c := range stub.calls() {
		if strings.Contains(c, "apply") {
			t.Fatalf("re-applied the complete credential secret: %q", c)
		}
	}
	if !strings.Contains(out.String(), "is complete") {
		t.Errorf("did not report the complete secret: %q", out.String())
	}
}

func TestEnsureHarborSecretSeedsEveryKeyWhenAbsent(t *testing.T) {
	stub := newKubectlStub(t, 0)
	reg := HetznerRegistries(hetznerRegistryProject("app-images"))[0]

	if err := EnsureHarborSecret(reg, io.Discard, io.Discard); err != nil {
		t.Fatalf("EnsureHarborSecret: %v", err)
	}
	applied := false
	for _, c := range stub.calls() {
		if strings.Contains(c, "apply") {
			applied = true
		}
		// The password must never reach a command line.
		if strings.Contains(c, "HARBOR_ADMIN_PASSWORD=") {
			t.Errorf("a password reached argv: %q", c)
		}
	}
	if !applied {
		t.Fatalf("never applied the credential secret; calls = %v", stub.calls())
	}
}

func TestEnsureHarborSecretRefusesAnUnsafeRegistry(t *testing.T) {
	newKubectlStub(t, 0)
	bad := HarborRegistry{Name: "Bad Name", Namespace: "registries", Host: "h", PullSecretName: "p", PullSecretNamespace: "default"}
	if err := EnsureHarborSecret(bad, io.Discard, io.Discard); err == nil {
		t.Error("seeded a secret for a registry whose name is not an RFC-1123 label")
	}
}

func TestEnsureHarborSecretCompletesLegacyAdminOnlySecretWithoutRotatingIt(t *testing.T) {
	admin := base64.StdEncoding.EncodeToString([]byte("existing-admin"))
	raw := `{"data":{"HARBOR_ADMIN_PASSWORD":"` + admin + `"}}`
	stub := newKubectlStub(t, 0, stubRule{Match: "get secret", Stdout: raw})
	reg := HetznerRegistries(hetznerRegistryProject("app-images"))[0]

	if err := EnsureHarborSecret(reg, io.Discard, io.Discard); err != nil {
		t.Fatalf("EnsureHarborSecret: %v", err)
	}
	if !stub.calledWith("apply -f") {
		t.Fatal("did not complete the legacy admin-only Secret")
	}
}

// REGISTRY_PASSWD and its bcrypt REGISTRY_HTPASSWD line are one credential in two encodings: the
// registry authenticates against the hash, Harbor core presents the plaintext. Half a pair cannot be
// completed — inventing the missing half would either rotate a live password or write a hash of a
// password nothing holds — so it fails closed. BOTH directions are tested: a guard that only ever
// sees one arrangement of its inputs is a guard for one arrangement.
func TestEnsureHarborSecretRejectsHalfARegistryPasswordPair(t *testing.T) {
	for _, tc := range []struct {
		name string
		data string
	}{
		{"plaintext without its hash", `{"data":{"REGISTRY_PASSWD":"cGFzc3dvcmQ="}}`},
		{"hash without its plaintext", `{"data":{"REGISTRY_HTPASSWD":"dXNlcjpoYXNo"}}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			stub := newKubectlStub(t, 0, stubRule{Match: "get secret", Stdout: tc.data})
			reg := HetznerRegistries(hetznerRegistryProject("app-images"))[0]

			err := EnsureHarborSecret(reg, io.Discard, io.Discard)
			if err == nil || !strings.Contains(err.Error(), "only one of REGISTRY_PASSWD") {
				t.Fatalf("error = %v, want fail-closed pair error", err)
			}
			if stub.calledWith("apply") {
				t.Fatalf("applied a mismatched credential pair; calls = %v", stub.calls())
			}
		})
	}
}

// The pull Secret is pre-created by the RUNNER so the Job's Role can be scoped to a single
// resourceName: RBAC cannot name-scope `create`, so a Job that created its own Secret would need
// namespace-wide create authority.
func TestEnsureHarborPullCredentialsSeedsTheSecretBeforeTheJob(t *testing.T) {
	stub := newKubectlStub(t, 0)
	reg := HetznerRegistries(hetznerRegistryProject("app-images"))[0]

	if err := EnsureHarborPullCredentials(context.Background(), reg, "runner:v1", io.Discard, io.Discard); err != nil {
		t.Fatalf("EnsureHarborPullCredentials: %v", err)
	}
	calls := stub.calls()
	deleteAt, applyCount := -1, 0
	for i, c := range calls {
		if strings.Contains(c, "delete job") {
			deleteAt = i
		}
		if strings.Contains(c, "apply") {
			applyCount++
		}
	}
	// admin secret + pull secret + the Job.
	if applyCount < 3 {
		t.Errorf("applied %d manifests, want at least 3 (admin secret, pull secret, Job); calls = %v", applyCount, calls)
	}
	// The stale Job is removed first: re-applying a completed Job fails on immutable fields, so
	// without this a re-deploy silently never re-runs the verify step.
	if deleteAt == -1 {
		t.Error("never deleted the previous bootstrap Job — a re-deploy would not re-run it")
	}
}

func TestEnsureHarborPullCredentialsRefusesWithNoRunnerImage(t *testing.T) {
	newKubectlStub(t, 0)
	reg := HetznerRegistries(hetznerRegistryProject("app-images"))[0]
	if err := EnsureHarborPullCredentials(context.Background(), reg, "", io.Discard, io.Discard); err == nil {
		t.Error("rendered and applied a Job with no runner image")
	}
}

func TestEnsureHarborSecretReportsAnApplyFailure(t *testing.T) {
	// absent, then `kubectl apply` fails — the caller must see it rather than proceed to a Job that
	// would authenticate with nothing.
	newKubectlStub(t, 0, stubRule{Match: "apply", Exit: 1})
	reg := HetznerRegistries(hetznerRegistryProject("app-images"))[0]
	if err := EnsureHarborSecret(reg, io.Discard, io.Discard); err == nil {
		t.Error("a failed apply was reported as success")
	}
}

func TestEnsureHarborPullCredentialsStopsIfTheAdminSecretFails(t *testing.T) {
	newKubectlStub(t, 0, stubRule{Match: "apply", Exit: 1})
	reg := HetznerRegistries(hetznerRegistryProject("app-images"))[0]
	if err := EnsureHarborPullCredentials(context.Background(), reg, "runner:v1", io.Discard, io.Discard); err == nil {
		t.Error("continued to the Job after the admin secret failed")
	}
}

func TestEnsureHarborPullCredentialsRefusesAnUnsafeRegistry(t *testing.T) {
	newKubectlStub(t, 0)
	bad := HarborRegistry{Name: "app images", Namespace: "registries", Host: "h", PullSecretName: "p", PullSecretNamespace: "default"}
	if err := EnsureHarborPullCredentials(context.Background(), bad, "runner:v1", io.Discard, io.Discard); err == nil {
		t.Error("accepted a registry whose name is not an RFC-1123 label")
	}
}

// A password generated from a failed entropy source must never be emitted. Falling back to
// something weaker is how a "random" credential becomes guessable, and nothing downstream notices.
func TestHarborAdminPasswordFailsRatherThanWeakensOnEntropyFailure(t *testing.T) {
	prev := harborRandReader
	t.Cleanup(func() { harborRandReader = prev })
	harborRandReader = failingReader{}

	if _, err := harborAdminPassword(); err == nil {
		t.Fatal("generated a password from a failed entropy source")
	}
}

type failingReader struct{}

func (failingReader) Read([]byte) (int, error) { return 0, errors.New("no entropy") }

func TestEnsureHarborSecretSurfacesAnEntropyFailure(t *testing.T) {
	newKubectlStub(t, 0)
	prev := harborRandReader
	t.Cleanup(func() { harborRandReader = prev })
	harborRandReader = failingReader{}

	reg := HetznerRegistries(hetznerRegistryProject("app-images"))[0]
	err := EnsureHarborSecret(reg, io.Discard, io.Discard)
	if err == nil || !strings.Contains(err.Error(), "generate Harbor HARBOR_ADMIN_PASSWORD") {
		t.Fatalf("error = %v, want a generation failure", err)
	}
}

// harborCredentialKeys is the list the CHART reads through its `existingSecret*` knobs, and
// completeHarborCredentials re-spells the same names inline because each key has its own generator.
// Two copies of one list drift, and the drift is silent: every assertion above iterates the copy in
// this file, so a key added to production and forgotten here would be tested by nothing. This pins
// them to each other in BOTH directions — a production key missing from the list fails, and a list
// entry production stopped minting fails too.
func TestHarborCredentialKeysMirrorsWhatIsMinted(t *testing.T) {
	data := map[string]string{}
	if _, err := completeHarborCredentials(data); err != nil {
		t.Fatalf("completeHarborCredentials: %v", err)
	}
	declared := map[string]bool{}
	for _, key := range harborCredentialKeys {
		declared[key] = true
	}
	for key := range data {
		if !declared[key] {
			t.Errorf("completeHarborCredentials mints %q, which harborCredentialKeys does not declare", key)
		}
	}
	for _, key := range harborCredentialKeys {
		if data[key] == "" {
			t.Errorf("harborCredentialKeys declares %q, which completeHarborCredentials does not mint", key)
		}
	}
}

// A kubectl that FAILS must never be read as "the Secret is absent". `--ignore-not-found` makes a
// genuine absence an empty SUCCESS, so every error left here is a real one — an API-server blip, a
// lost token, a throttled request. Treating those as absence would re-seed over live credentials
// while Harbor's database still holds the previous ones, which is the lockout EnsureHarborSecret
// exists to avoid. The assertion that carries the invariant is the second one: returning an error is
// not enough, nothing may be applied.
func TestEnsureHarborSecretRefusesToSeedWhenTheReadFails(t *testing.T) {
	stub := newKubectlStub(t, 0, stubRule{Match: "get secret", Exit: 1})
	reg := HetznerRegistries(hetznerRegistryProject("app-images"))[0]

	err := EnsureHarborSecret(reg, io.Discard, io.Discard)
	if err == nil || !strings.Contains(err.Error(), "read Harbor credential secret") {
		t.Fatalf("error = %v, want a read failure", err)
	}
	if stub.calledWith("apply") {
		t.Fatalf("overwrote credentials after a failed read; calls = %v", stub.calls())
	}
}

// Same invariant, one step further in: the read SUCCEEDED but the payload is not a Secret. Anything
// other than a hard stop here would apply a credential map built from a document we could not read.
func TestEnsureHarborSecretRefusesToSeedOnAnUndecodableSecret(t *testing.T) {
	stub := newKubectlStub(t, 0, stubRule{Match: "get secret", Stdout: "not json"})
	reg := HetznerRegistries(hetznerRegistryProject("app-images"))[0]

	err := EnsureHarborSecret(reg, io.Discard, io.Discard)
	if err == nil || !strings.Contains(err.Error(), "decode Harbor credential secret") {
		t.Fatalf("error = %v, want a decode failure", err)
	}
	if stub.calledWith("apply") {
		t.Fatalf("applied a credential map built from an unreadable Secret; calls = %v", stub.calls())
	}
}

// The bootstrap Job must receive ONE key, not the whole credential set.
//
// This Secret used to hold exactly the admin password, so mounting it whole was mounting one
// credential. It now holds nine, including tls.key — the RSA key Harbor core signs registry auth
// tokens with. Anything able to read that pod's filesystem could forge tokens. The widening would
// have arrived as a silent side effect of a fix aimed at something else, which is the shape worth
// having a test for.
func TestHarborBootstrapJobMountsOnlyTheAdminPassword(t *testing.T) {
	reg := HetznerRegistries(hetznerRegistryProject("app-images"))[0]
	y, err := HarborBootstrapJobManifest(reg, "runner:latest")
	if err != nil {
		t.Fatalf("HarborBootstrapJobManifest: %v", err)
	}

	var projected []string
	for _, doc := range strings.Split(y, "\n---") {
		var m struct {
			Spec struct {
				Template struct {
					Spec struct {
						Volumes []struct {
							Name   string `yaml:"name"`
							Secret *struct {
								SecretName string `yaml:"secretName"`
								Items      []struct {
									Key string `yaml:"key"`
								} `yaml:"items"`
							} `yaml:"secret"`
						} `yaml:"volumes"`
					} `yaml:"spec"`
				} `yaml:"template"`
			} `yaml:"spec"`
		}
		if err := yaml.Unmarshal([]byte(doc), &m); err != nil {
			continue
		}
		for _, v := range m.Spec.Template.Spec.Volumes {
			if v.Secret == nil || v.Secret.SecretName != reg.AdminSecretName() {
				continue
			}
			if len(v.Secret.Items) == 0 {
				t.Fatalf("volume %q mounts the credential Secret %q WHOLE — the bootstrap pod would hold "+
					"tls.key, secretKey and REGISTRY_PASSWD, and it reads only the admin password",
					v.Name, v.Secret.SecretName)
			}
			for _, it := range v.Secret.Items {
				projected = append(projected, it.Key)
			}
		}
	}
	if len(projected) == 0 {
		t.Fatal("found no volume projecting the credential Secret — this guard would pass vacuously")
	}
	if len(projected) != 1 || projected[0] != harborAdminSecretKey {
		t.Errorf("the bootstrap Job is given keys %v, want exactly [%s]", projected, harborAdminSecretKey)
	}
}

// Every value must survive a YAML round-trip AS A STRING.
//
// base64's alphabet includes digits, so a value that happens to be all digits parses as a YAML int
// and an empty one as null. Either makes `kubectl apply` reject the Secret outright — permanently,
// because the shape never changes — and credentialInClusterRegistries only WARNS on that failure, so
// the registry would silently never be credentialed. The generated values are safe bare; the ones
// carried through from an existing Secret are not ours to choose.
func TestHarborSecretManifestSurvivesHostileExistingValues(t *testing.T) {
	data := map[string]string{
		harborAdminSecretKey: base64.StdEncoding.EncodeToString([]byte("fine")),
		"ALL_DIGITS":         "12345678",
		"EMPTY":              "",
		"YAML_TRUE":          "true",
		"LEADING_ZERO":       "0123",
	}
	y := harborSecretManifest("registries", "harbor-app-images-admin", data)

	var got struct {
		Data map[string]string `yaml:"data"`
	}
	found := false
	for _, doc := range strings.Split(y, "\n---") {
		var probe struct {
			Kind string            `yaml:"kind"`
			Data map[string]string `yaml:"data"`
		}
		if err := yaml.Unmarshal([]byte(doc), &probe); err != nil {
			t.Fatalf("the rendered manifest is not valid YAML, so kubectl would reject it: %v", err)
		}
		if probe.Kind == "Secret" {
			got.Data, found = probe.Data, true
		}
	}
	if !found {
		t.Fatal("no Secret document in the rendered manifest")
	}
	for key, want := range data {
		if got.Data[key] != want {
			t.Errorf("key %s round-tripped as %q, want %q — a value YAML retyped is a Secret kubectl refuses",
				key, got.Data[key], want)
		}
	}
}

// The htpasswd line names a user, and Harbor core must authenticate as THAT user or the internal
// registry 401s every request while every pod reports Ready.
//
// The console now STATES the username rather than inheriting the chart's default, so this test can
// be unconditional — and it has to be. The first version returned green when the fixture carried no
// username at all, which is the same "nothing found is not nothing wrong" vacuity this file guards
// against two tests up: the absent username WAS the finding, so the guard passed on exactly the
// state it existed to reject.
func TestHetznerRegistryUsernameAgreesWithTheRunner(t *testing.T) {
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate this file")
	}
	path := filepath.Join(filepath.Dir(thisFile), "..", "..", "..", "test", "e2e", "fixtures", "hetzner_data_services.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		// FATAL, NOT SKIP, for the reason stated on the queue twin in rabbitmq_test.go: these are
		// the only checks that the Go and TS halves of a name contract agree, and a skip is a green
		// run that checked nothing. Both sites here, because a hardening applied to one copy of
		// this pattern and not the other is how the registry path kept diverging in the first place.
		t.Fatalf("generated fixture not readable at %s (%v) — this test is the only check that the "+
			"Go and TS halves of this contract agree", path, err)
	}
	var fx struct {
		ChartedNotOffered []struct {
			ID     string         `json:"id"`
			Values map[string]any `json:"values"`
		} `json:"chartedNotOffered"`
		AddOns []struct {
			ID     string         `json:"id"`
			Values map[string]any `json:"values"`
		} `json:"addons"`
	}
	if err := json.Unmarshal(raw, &fx); err != nil {
		t.Fatalf("parse fixture: %v", err)
	}
	var values map[string]any
	for _, s := range append(fx.ChartedNotOffered, fx.AddOns...) {
		if strings.HasPrefix(s.ID, "registry-") {
			values = s.Values
		}
	}
	if values == nil {
		t.Fatal("the fixture carries no registry spec")
	}
	got, set := fixtureLeaf(values, "registry", "credentials", "username")
	if !set {
		t.Fatalf("the chart is told no username, so harbor's default governs and agrees with the runner's "+
			"%q only by coincidence — an upstream rename would 401 every core->registry request with every "+
			"pod Ready", harborRegistryUsername)
	}
	if got != harborRegistryUsername {
		t.Errorf("the chart authenticates as %q but the runner hashes %q into REGISTRY_HTPASSWD — "+
			"core would 401 on every request to the internal registry with all pods Ready",
			got, harborRegistryUsername)
	}
}
