// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"math/big"
	"sort"
	"strings"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/alethialabs-io/alethialabs/packages/core/utils"
	"golang.org/x/crypto/bcrypt"
)

// Pull credentials for an in-cluster Harbor registry (#2431).
//
// Hetzner has no registry product, so a canvas `registry` node becomes a Harbor release. The chart
// installs and nothing can pull from it: on every other cloud a project's own registry needs no
// imagePullSecret because the nodes authenticate to ECR / Artifact Registry / ACR with their own
// identity, and an in-cluster Harbor has no node identity.
//
// This file is the runner half. It seeds Harbor's admin password, then applies a one-shot Job that
// mints a project-scoped PULL robot from inside the cluster (`alethia harbor-bootstrap`) — inside,
// because Harbor's API answers only on the cluster network and the runner has no route to it.
//
// ── Everything here is applied with ApplyManifest, never committed to the apps repo ───────────
//
// The apps Application runs `automated: {prune: true, selfHeal: true}` with no `ignoreDifferences`
// (infra/templates/argocd/user-apps.yaml), so a Secret declared in git is healed back to its
// declared value. A minted credential committed there would be reverted by the very sync that
// minted it, and a hook that re-mints each reconcile would rotate Harbor's robot secret forever
// while no pod could pull. That hazard is already shipped on another path and is filed as #2435.
// registry_secrets.go states the rule this follows: "deliberately NO ArgoCD tracking metadata: no
// Application owns it, so nothing syncs it away."

const (
	// harborAdminSecretKey is the data key Harbor's chart reads the admin password from. It pairs
	// with `existingSecretAdminPasswordKey` in the rendered values — the two must agree or the chart
	// silently falls back to its default password.
	harborAdminSecretKey = "HARBOR_ADMIN_PASSWORD"
	// harborAdminPasswordBytes is the entropy of the generated admin password before encoding.
	harborAdminPasswordBytes = 32
	// harborRegistryUsername is the chart's published registry username. The htpasswd line and
	// Harbor core must name the same user or the internal registry rejects every request.
	harborRegistryUsername = "harbor_registry_user"
	// harborBootstrapSAName is the ServiceAccount the bootstrap Job runs as.
	harborBootstrapSAName = "alethia-harbor-bootstrap"
)

var harborCredentialKeys = []string{
	harborAdminSecretKey,
	"secretKey",
	"secret",
	"CSRF_KEY",
	"JOBSERVICE_SECRET",
	"REGISTRY_HTTP_SECRET",
	"REGISTRY_PASSWD",
	"REGISTRY_HTPASSWD",
	"tls.key",
}

// harborCarriedRegistryOffers maps a cloud to the in-cluster component that honours the `registry`
// kind's switches there. Hetzner only, and that is the whole point: every other cloud builds a real
// registry resource in OpenTofu, so the switches ride tfvars and the carrier rule can see them.
//
// Harbor honours BOTH natively, which is why they are carried rather than excluded:
//   - immutable_tags        → a project immutable-tag rule (POST /projects/{name}/immutabletagrules)
//   - vulnerability_scanning → the project's `auto_scan` metadata, served by the Trivy the chart
//     already installs (hetznerRegistryValues sizes its volume)
//
// The offer-parity guard RE-READS this map to validate the carried_in_cluster entries in
// infra/offer-exclusions.yaml, so dropping a cloud here makes those entries go stale rather than
// leaving a silent claim behind. It must stay a top-level map[string]… literal for that to work.
var harborCarriedRegistryOffers = map[string]string{
	"hetzner": "harbor",
}

// HarborRegistry is one in-cluster registry the runner must credential.
type HarborRegistry struct {
	// Name is the canvas `registry` node's name.
	Name string
	// Namespace is where the Harbor release lives (the console's NS.registry).
	Namespace string
	// Host is the in-cluster registry host — the SAME string hetznerRegistryHost() produced for the
	// chart's externalURL and that the Talos containerd mirror trusts. All three must agree: a
	// dockerconfigjson keyed on a host the kubelet does not pull from is not an error anywhere, it
	// is simply never matched, and the pull fails looking exactly like a bad password.
	Host string
	// PullSecretName / PullSecretNamespace locate the dockerconfigjson app pods reference.
	PullSecretName      string
	PullSecretNamespace string
	// ImmutableTags and VulnerabilityScanning are the canvas switches. Harbor honours both through
	// its API rather than through any tfvar, which is why the offer-parity guard records them as
	// carried_in_cluster — see harborCarriedRegistryOffers.
	ImmutableTags         bool
	VulnerabilityScanning bool
}

// AdminSecretName is the Secret holding this registry's Harbor admin password.
func (h HarborRegistry) AdminSecretName() string { return "harbor-" + h.Name + "-admin" }

// BootstrapJobName is the one-shot Job that mints the robot.
func (h HarborRegistry) BootstrapJobName() string { return "harbor-" + h.Name + "-bootstrap" }

// valid reports whether every interpolated name is a safe RFC-1123 label. Fail-closed: these reach a
// kubectl command line and a rendered manifest.
func (h HarborRegistry) valid() bool {
	return k8sNameRe.MatchString(h.Name) &&
		k8sNameRe.MatchString(h.Namespace) &&
		k8sNameRe.MatchString(h.PullSecretName) &&
		k8sNameRe.MatchString(h.PullSecretNamespace) &&
		h.Host != "" && !strings.ContainsAny(h.Host, " \t\n\"'`$")
}

// EnsureHarborSecret creates or completes Harbor's credential Secret without rotating existing keys.
//
// Alethia GENERATES this password — there is no user-entered credential for a `registry` node, and
// the #640 add-on secret rail only carries values fetched from the database. Without it the chart
// falls back to its published default (`harborAdminPassword: "Harbor12345"`), which is what #2430
// shipped.
//
// It is created once and then read, never rewritten. Rotating it on every deploy would change the
// password Alethia authenticates with while Harbor's own database still holds the previous one — an
// immediate lockout. The cluster is therefore the store of record for this credential, which also
// keeps it out of Postgres entirely: it is generated in memory, applied, and forgotten.
//
// ON AN ALREADY-DEPLOYED REGISTRY NODE THIS IS A MIGRATION, NOT A COMPLETION. Before #3299 the CHART
// was the store of record for every key but the admin password, so an existing node is running on
// harbor's published defaults. Filling them here moves secretKey off `not-a-secure-key`, and
// secretKey is what harbor encrypts stored credentials with — a replication endpoint configured
// before the upgrade keeps a secret that can no longer be decrypted and must be re-entered. There is
// no way to avoid that and also stop shipping a published key; what there is no excuse for is not
// saying so.
func EnsureHarborSecret(reg HarborRegistry, stdout, stderr io.Writer) error {
	if !reg.valid() {
		return fmt.Errorf("refusing to seed a Harbor credential secret for invalid registry %q/%q", reg.Namespace, reg.Name)
	}
	name := reg.AdminSecretName()
	// --ignore-not-found makes absence an empty successful response while preserving real kubectl
	// failures. Treating every read error as "absent" would overwrite credentials during an outage.
	raw, err := utils.ExecuteCommandWithOutput(
		fmt.Sprintf("kubectl get secret %s -n %s -o json --ignore-not-found", name, reg.Namespace),
		".", nil,
	)
	if err != nil {
		return fmt.Errorf("read Harbor credential secret %s/%s: %w", reg.Namespace, name, err)
	}
	data := map[string]string{}
	if strings.TrimSpace(raw) != "" {
		var existing struct {
			Data map[string]string `json:"data"`
		}
		if err := json.Unmarshal([]byte(raw), &existing); err != nil {
			return fmt.Errorf("decode Harbor credential secret %s/%s: %w", reg.Namespace, name, err)
		}
		for key, value := range existing.Data {
			data[key] = value
		}
	}

	missing, err := completeHarborCredentials(data)
	if err != nil {
		return fmt.Errorf("complete Harbor credential secret %s/%s: %w", reg.Namespace, name, err)
	}
	if !missing {
		fmt.Fprintf(stdout, "Harbor credential secret %s/%s is complete; leaving it in place\n", reg.Namespace, name)
		return nil
	}
	fmt.Fprintf(stdout, "Seeding missing Harbor credentials in %s/%s...\n", reg.Namespace, name)
	// Credentials ride a 0600 temporary manifest into kubectl, never argv or logs.
	return ApplyManifest(harborSecretManifest(reg.Namespace, name, data), stdout, stderr)
}

// completeHarborCredentials fills only absent keys and preserves every existing encoded value.
func completeHarborCredentials(data map[string]string) (bool, error) {
	passwordPresent := data["REGISTRY_PASSWD"] != ""
	htpasswdPresent := data["REGISTRY_HTPASSWD"] != ""
	if passwordPresent != htpasswdPresent {
		return false, fmt.Errorf("only one of REGISTRY_PASSWD and REGISTRY_HTPASSWD exists; refusing to rotate or invent a mismatched pair")
	}
	changed := false
	add := func(key string, generate func() (string, error)) error {
		if data[key] != "" {
			return nil
		}
		value, err := generate()
		if err != nil {
			return fmt.Errorf("generate Harbor %s: %w", key, err)
		}
		data[key] = base64.StdEncoding.EncodeToString([]byte(value))
		changed = true
		return nil
	}
	if err := add(harborAdminSecretKey, harborAdminPassword); err != nil {
		return false, err
	}
	if err := add("secretKey", func() (string, error) { return harborRandomCredential(12) }); err != nil {
		return false, err
	}
	for _, key := range []string{"secret", "CSRF_KEY", "JOBSERVICE_SECRET", "REGISTRY_HTTP_SECRET"} {
		if err := add(key, func() (string, error) { return harborRandomCredential(24) }); err != nil {
			return false, err
		}
	}
	if err := add("tls.key", harborRSAPrivateKey); err != nil {
		return false, err
	}
	if !passwordPresent {
		password, err := harborRandomCredential(24)
		if err != nil {
			return false, fmt.Errorf("generate Harbor registry password: %w", err)
		}
		hash, err := bcrypt.GenerateFromPassword([]byte(password), 10)
		if err != nil {
			return false, fmt.Errorf("hash Harbor registry password: %w", err)
		}
		data["REGISTRY_PASSWD"] = base64.StdEncoding.EncodeToString([]byte(password))
		data["REGISTRY_HTPASSWD"] = base64.StdEncoding.EncodeToString([]byte(harborRegistryUsername + ":" + string(hash)))
		changed = true
	}
	return changed, nil
}

// harborRandReader is the entropy source, swappable so the failure path is testable. A password
// generated from a failed reader must never be emitted: silently falling back to something weaker is
// how a "random" credential becomes guessable, and nothing downstream would notice.
var harborRandReader io.Reader = rand.Reader

// harborAdminPassword generates a password satisfying Harbor's complexity rule (8-128 chars with
// upper, lower and a digit). base64 of 32 random bytes gives 43 chars of mixed case and digits; the
// suffix guarantees one of each so a fluke all-letter encoding cannot be rejected at install time —
// a failure that would only surface as a Harbor pod refusing to start.
func harborAdminPassword() (string, error) {
	buf := make([]byte, harborAdminPasswordBytes)
	if _, err := io.ReadFull(harborRandReader, buf); err != nil {
		return "", err
	}
	n, err := rand.Int(harborRandReader, big.NewInt(10))
	if err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf) + fmt.Sprintf("aZ%d", n.Int64()), nil
}

// harborRandomCredential returns a URL-safe credential with the requested entropy.
func harborRandomCredential(bytes int) (string, error) {
	buf := make([]byte, bytes)
	if _, err := io.ReadFull(harborRandReader, buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

// harborRSAPrivateKey returns the PKCS#1 key Harbor core uses to sign registry tokens.
//
// The KEY ONLY, deliberately — there is no `tls.crt` here and adding one would be cargo cult. The
// chart mounts `core.secretName` at `subPath: tls.key` (harbor 1.15.1, templates/core/core-dpl.yaml),
// and a subPath mount reads exactly one key, so the certificate half is never opened; harbor's own
// core-secret.yaml writes both halves only when `core.secretName` is UNSET. In 1.15.1 the registry
// authenticates with htpasswd rather than a token bundle, so nothing else needs the cert to verify
// core's signatures either. The marketplace add-on mints key-only for the same reason —
// apps/console/lib/addons/secrets.ts.
//
// Rotating this key invalidates every auth token the registry has ever issued, which is why
// completeHarborCredentials only ever fills it when ABSENT.
func harborRSAPrivateKey() (string, error) {
	key, err := rsa.GenerateKey(harborRandReader, 2048)
	if err != nil {
		return "", err
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)})), nil
}

// harborSecretManifest renders the namespace and complete base64-encoded credential map.
func harborSecretManifest(namespace, name string, data map[string]string) string {
	var entries strings.Builder
	keys := make([]string, 0, len(data))
	for key := range data {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		// QUOTED. These are base64 strings, and base64's alphabet includes digits — so a value that
		// happens to be all digits parses as a YAML int, and an empty one as null. Either makes
		// `kubectl apply` reject the Secret outright, permanently: credentialInClusterRegistries only
		// WARNS on that failure, so the registry would silently never be credentialed. We only ever
		// generate values that are safe bare, but this map also carries through whatever keys an
		// existing Secret already had, and those we do not control.
		fmt.Fprintf(&entries, "  %s: %q\n", key, data[key])
	}
	return fmt.Sprintf(`apiVersion: v1
kind: Namespace
metadata:
  name: %s
---
apiVersion: v1
kind: Secret
metadata:
  name: %s
  namespace: %s
type: Opaque
data:
%s`, namespace, name, namespace, entries.String())
}

// HarborBootstrapJobManifest renders the one-shot mint Job, its ServiceAccount, and a Role scoped to
// the single Secret it may touch.
//
// The RBAC is `get` + `patch` on exactly one resourceName — no `list`, no `watch` (which cannot be
// name-scoped and would expose every Secret in the namespace), and no `create` (which cannot be
// name-scoped either, which is why EnsureRegistryPullSecret pre-seeds the Secret from the runner
// instead of letting the Job create it).
//
// Honest scope note: on a dedicated cluster the apps-repo writer already has broad authority through
// ArgoCD, so this Role is defence-in-depth rather than a containment boundary. It is still worth
// having — it bounds what a compromise of THIS pod reaches — but it should not be described as
// isolating a hostile tenant.
func HarborBootstrapJobManifest(reg HarborRegistry, runnerImage string) (string, error) {
	if !reg.valid() {
		return "", fmt.Errorf("refusing to render a Harbor bootstrap Job for invalid registry %q/%q", reg.Namespace, reg.Name)
	}
	if runnerImage == "" {
		return "", fmt.Errorf("refusing to render a Harbor bootstrap Job with no runner image")
	}
	return fmt.Sprintf(`apiVersion: v1
kind: ServiceAccount
metadata:
  name: %[1]s
  namespace: %[2]s
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: %[1]s
  namespace: %[3]s
rules:
  - apiGroups: [""]
    resources: ["secrets"]
    resourceNames: ["%[4]s"]
    verbs: ["get", "patch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: %[1]s
  namespace: %[3]s
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: %[1]s
subjects:
  - kind: ServiceAccount
    name: %[1]s
    namespace: %[2]s
---
apiVersion: batch/v1
kind: Job
metadata:
  name: %[5]s
  namespace: %[2]s
spec:
  backoffLimit: 4
  ttlSecondsAfterFinished: 600
  template:
    spec:
      serviceAccountName: %[1]s
      restartPolicy: Never
      securityContext:
        runAsNonRoot: true
        runAsUser: 65532
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: harbor-bootstrap
          image: %[6]s
          args:
            - harbor-bootstrap
            - --api-base=http://%[7]s
            - --registry-host=%[7]s
            - --project=%[8]s
            - --robot=alethia-pull
            - --immutable-tags=%[11]t
            - --vulnerability-scanning=%[12]t
            - --secret-name=%[4]s
            - --secret-namespace=%[3]s
            - --admin-password-file=/harbor-admin/%[9]s
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: ["ALL"]
          volumeMounts:
            - name: harbor-admin
              mountPath: /harbor-admin
              readOnly: true
            - name: tmp
              mountPath: /tmp
      volumes:
        - name: harbor-admin
          secret:
            secretName: %[10]s
            # PROJECT ONE KEY. This Secret used to hold exactly the admin password; it now holds the
            # whole Harbor credential set, including tls.key — the RSA key Harbor core signs registry
            # auth tokens with. Mounting it whole would put that key on the bootstrap pod's
            # filesystem, where anything able to read the pod could forge registry tokens, and the
            # Job reads only --admin-password-file. Widening a mount is the kind of privilege change
            # that arrives as a side effect of an unrelated fix, which is exactly how this one did.
            items:
              - key: %[9]s
                path: %[9]s
        - name: tmp
          emptyDir: {}
`,
		harborBootstrapSAName,     // 1
		reg.Namespace,             // 2
		reg.PullSecretNamespace,   // 3
		reg.PullSecretName,        // 4
		reg.BootstrapJobName(),    // 5
		runnerImage,               // 6
		reg.Host,                  // 7
		reg.Name,                  // 8
		harborAdminSecretKey,      // 9
		reg.AdminSecretName(),     // 10
		reg.ImmutableTags,         // 11
		reg.VulnerabilityScanning, // 12
	), nil
}

// hetznerRegistryNamespace mirrors the console's NS.registry (hetzner-services.ts). Duplicated
// rather than imported because Go cannot read the TS mapper, and asserted against the generated
// fixture by test so it cannot drift silently.
const hetznerRegistryNamespace = "registries"

// HetznerRegistries derives the in-cluster registries a deploy must credential.
//
// Hetzner only. Every other cloud provisions a real registry whose nodes authenticate with their own
// identity, so there is nothing to seed and nothing to mint — returning a non-empty list there would
// create Jobs against a Harbor that does not exist.
func HetznerRegistries(vc *types.ProjectConfig) []HarborRegistry {
	// The predicate the offer-parity guard re-reads is the SAME thing that gates the code, so the
	// two cannot disagree: drop a cloud from the map and both the derivation and the recorded
	// carried_in_cluster entry stop being true together.
	if vc == nil || harborCarriedRegistryOffers[string(vc.Provider)] == "" {
		return nil
	}
	out := make([]HarborRegistry, 0, len(vc.ContainerRegistries))
	for _, r := range vc.ContainerRegistries {
		if r.Name == "" {
			continue
		}
		reg := HarborRegistry{
			Name:      r.Name,
			Namespace: hetznerRegistryNamespace,
			// NULL means "not chosen", which is off — a switch nobody set must not silently enable
			// a scan schedule or a tag lock on the customer's registry.
			ImmutableTags:         r.ImmutableTags != nil && *r.ImmutableTags,
			VulnerabilityScanning: r.VulnerabilityScanning != nil && *r.VulnerabilityScanning,
			// MUST equal hetznerRegistryHost() in the console, which also produced the chart's
			// externalURL, and the Talos containerd mirror entry. A test pins the shape.
			Host:                fmt.Sprintf("registry-%s.%s.svc.cluster.local", r.Name, hetznerRegistryNamespace),
			PullSecretName:      fmt.Sprintf("registry-%s-pull", r.Name),
			PullSecretNamespace: appNamespaceForPullSecret,
		}
		if !reg.valid() {
			continue
		}
		out = append(out, reg)
	}
	return out
}

// appNamespaceForPullSecret is where app pods reference the imagePullSecret from. It matches the
// namespace generateAppManifests renders services into.
const appNamespaceForPullSecret = "default"

// EnsureHarborPullCredentials runs the whole sequence for one in-cluster registry:
// seed the admin password, pre-create the pull Secret, then apply the mint Job.
//
// Ordering is load-bearing. The pull Secret is created FIRST so the Job's Role can be scoped to a
// single resourceName with `get` + `patch` — RBAC cannot name-scope `create`, so a Job that created
// its own Secret would need namespace-wide create authority.
func EnsureHarborPullCredentials(ctx context.Context, reg HarborRegistry, runnerImage string, stdout, stderr io.Writer) error {
	if err := EnsureHarborSecret(reg, stdout, stderr); err != nil {
		return err
	}
	// An EMPTY placeholder, seeded on the rail that carries no ArgoCD tracking metadata — so nothing
	// heals it back once the Job writes the real credential into it (#2435).
	if err := EnsureRegistryPullSecret(reg.PullSecretName, reg.PullSecretNamespace, `{"auths":{}}`, stdout, stderr); err != nil {
		return fmt.Errorf("pre-seed the pull secret: %w", err)
	}
	job, err := HarborBootstrapJobManifest(reg, runnerImage)
	if err != nil {
		return err
	}
	// Re-applying replaces a completed Job's spec; delete first so a re-deploy actually re-runs the
	// verify step rather than failing on an immutable field.
	_ = utils.ExecuteCommand(
		fmt.Sprintf("kubectl delete job %s -n %s --ignore-not-found", reg.BootstrapJobName(), reg.Namespace),
		".", nil, io.Discard, io.Discard,
	)
	fmt.Fprintf(stdout, "Applying Harbor bootstrap Job for registry %s...\n", reg.Name)
	_ = ctx
	return ApplyManifest(job, stdout, stderr)
}
