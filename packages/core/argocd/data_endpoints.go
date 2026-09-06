// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"encoding/json"
	"fmt"
	"io"
	"sort"
	"strings"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/alethialabs-io/alethialabs/packages/core/utils"
)

// Endpoint + credential read-back for in-cluster data services (Hetzner's database/cache/queue,
// which deploy as ArgoCD Applications rather than managed cloud resources).
//
// Until now the console had NO endpoint for them at all — `deployments.ts` said so out loud:
// "Endpoint discovery is chart-specific and deferred". So a provisioned Hetzner Postgres showed no
// connection string, ever.
//
// The endpoints are READ BACK FROM THE CLUSTER, never derived. Every chart names its Services with
// its own `fullname` template — CNPG's `cluster` chart in particular does NOT simply name the
// Cluster after the release — so a derived string is a guess, and a wrong endpoint in the console is
// worse than no endpoint. We list the Services/Secrets ArgoCD's own instance label already puts on
// them, which is honest and cheap (it reuses the same kubectl posture as ReadAddOnHealth).
//
// CREDENTIALS ARE NEVER COPIED. We record a REFERENCE ("<namespace>/<secret-name>") exactly as the
// managed clouds record a Secrets-Manager ARN. Persisting the value would repeat the mistake #427
// fixed (the ArgoCD admin password in plaintext execution_metadata).

// DataEndpoint is the connection info for one in-cluster data service.
type DataEndpoint struct {
	// Endpoint is the in-cluster DNS name of the primary (read-write) Service.
	Endpoint string `json:"endpoint"`
	// Port is the primary Service's port.
	Port int `json:"port,omitempty"`
	// ReaderEndpoint is the read-only Service, when the chart ships one (CNPG `-ro`, Valkey
	// `-read`). Empty otherwise.
	ReaderEndpoint string `json:"reader_endpoint,omitempty"`
	// SecretRef is "<namespace>/<name>" of the Secret the chart minted for these credentials.
	// A REFERENCE — never the credential itself.
	SecretRef string `json:"secret_ref,omitempty"`
}

// dataServicePrefixes are the add-on id prefixes the console synthesizes for in-cluster data
// services (hetzner-services.ts): `db-<name>` / `cache-<name>` / `queue-<name>`.
var dataServicePrefixes = []string{"db-", "cache-", "queue-"}

// isDataServiceAddOn reports whether an add-on is one of the synthesized in-cluster data services
// (as opposed to a marketplace chart or an operator).
func isDataServiceAddOn(a types.AddOnInstall) bool {
	for _, p := range dataServicePrefixes {
		if strings.HasPrefix(a.ID, p) {
			return true
		}
	}
	return false
}

// svcList is the trimmed shape of `kubectl get svc -o json` we read.
type svcList struct {
	Items []struct {
		Metadata struct {
			Name      string `json:"name"`
			Namespace string `json:"namespace"`
		} `json:"metadata"`
		Spec struct {
			ClusterIP string `json:"clusterIP"`
			Ports     []struct {
				Port int    `json:"port"`
				Name string `json:"name"`
			} `json:"ports"`
		} `json:"spec"`
	} `json:"items"`
}

// secretList is the trimmed shape of `kubectl get secret -o json` we read.
type secretList struct {
	Items []struct {
		Metadata struct {
			Name      string `json:"name"`
			Namespace string `json:"namespace"`
		} `json:"metadata"`
		Type string `json:"type"`
	} `json:"items"`
}

// kubectlJSON runs a kubectl read and unmarshals its JSON. Read-only; stdout is captured (never
// echoed) so a Secret listing can't leak into the job log.
func kubectlJSON(cmd string, out interface{}, stderr io.Writer) error {
	var buf strings.Builder
	if err := utils.ExecuteCommand(cmd, ".", nil, &buf, stderr); err != nil {
		return err
	}
	return json.Unmarshal([]byte(buf.String()), out)
}

// ReadDataEndpoints reads the in-cluster connection endpoint + credential REFERENCE for each
// synthesized data-service add-on, keyed by add-on id (`db-primary`, `cache-main`, …).
//
// Best-effort: a service that can't be read is simply omitted (the console then shows no endpoint,
// which is the honest state) — it never fails the deploy.
func ReadDataEndpoints(addons []types.AddOnInstall, stdout, stderr io.Writer) map[string]DataEndpoint {
	out := map[string]DataEndpoint{}
	for _, a := range addons {
		if a.Mode != "managed" || !isDataServiceAddOn(a) {
			continue
		}
		// ArgoCD names the Helm release after the Application, so the chart's standard
		// `app.kubernetes.io/instance` label carries it. That label is what we match on — not a
		// guessed chart fullname.
		release := AddOnAppName(a.ID)
		// Fail closed on identifiers that could not have come from the console's own resolver, for
		// the reason addon_secrets.go states beside k8sNameRe: they arrive via the DB-persisted
		// config snapshot, and they interpolate into a kubectl command string that
		// utils.ExecuteCommand runs through `bash -c`. Every sibling in this package already checks
		// this; data_endpoints.go was the one path that did not (#2020).
		//
		// Reported distinctly from "no Service found" below. Both end in the console showing no
		// endpoint, but the causes are nothing alike — one is a chart that has not settled yet, the
		// other is a snapshot that should never have reached the runner, and an operator reading
		// "no Service found" for the latter would go looking in entirely the wrong place.
		if !k8sNameRe.MatchString(a.Namespace) || !k8sNameRe.MatchString(release) {
			fmt.Fprintf(stderr, "Warning: refusing to read data service %s — namespace %q / release %q is not a valid kubernetes name; skipping\n", a.ID, a.Namespace, release)
			continue
		}
		ep, ok := readOneEndpoint(release, a.Namespace, a.ID, stderr)
		if !ok {
			fmt.Fprintf(stderr, "Warning: no Service found for data service %s (namespace %s) — the console will show no endpoint\n", a.ID, a.Namespace)
			continue
		}
		out[a.ID] = ep
		fmt.Fprintf(stdout, "  %s → %s:%d\n", a.ID, ep.Endpoint, ep.Port)
	}
	return out
}

// readOneEndpoint finds the primary (and, when present, reader) Service for one release, plus the
// Secret the chart minted for it.
func readOneEndpoint(release, namespace, addonID string, stderr io.Writer) (DataEndpoint, bool) {
	// Restated rather than left to the caller: this builds a shell command, and the one thing a
	// shell-command builder must not do is trust that somebody upstream checked. ReadDataEndpoints
	// already refuses these, so this only fires for a future caller.
	if !k8sNameRe.MatchString(release) || !k8sNameRe.MatchString(namespace) {
		return DataEndpoint{}, false
	}
	var svcs svcList
	cmd := fmt.Sprintf(
		"kubectl get svc -n %s -l app.kubernetes.io/instance=%s -o json",
		namespace, release,
	)
	if err := kubectlJSON(cmd, &svcs, stderr); err != nil || len(svcs.Items) == 0 {
		return DataEndpoint{}, false
	}

	type cand struct {
		name string
		port int
	}
	var primary, reader cand
	for _, s := range svcs.Items {
		name := s.Metadata.Name
		// Headless services (clusterIP: None) are for peer discovery, not clients.
		if s.Spec.ClusterIP == "None" || strings.HasSuffix(name, "-headless") {
			continue
		}
		port := 0
		if len(s.Spec.Ports) > 0 {
			port = s.Spec.Ports[0].Port
		}
		switch {
		// CNPG: <cluster>-ro | Valkey: <release>-valkey-read
		case strings.HasSuffix(name, "-ro"), strings.HasSuffix(name, "-read"):
			reader = cand{name, port}
		// CNPG's read-write Service is the one clients use; prefer it explicitly.
		case strings.HasSuffix(name, "-rw"):
			primary = cand{name, port}
		default:
			// First non-headless, non-reader service wins (Valkey/RabbitMQ ship exactly one).
			if primary.name == "" {
				primary = cand{name, port}
			}
		}
	}
	if primary.name == "" {
		return DataEndpoint{}, false
	}

	ep := DataEndpoint{
		Endpoint: fmt.Sprintf("%s.%s.svc.cluster.local", primary.name, namespace),
		Port:     primary.port,
	}
	if reader.name != "" {
		ep.ReaderEndpoint = fmt.Sprintf("%s.%s.svc.cluster.local", reader.name, namespace)
	}
	ep.SecretRef = readSecretRef(release, namespace, addonID, stderr)
	return ep, true
}

// readSecretRef returns "<namespace>/<name>" of the credential Secret for this release — a
// REFERENCE only. Never reads or returns the Secret's data.
//
// TWO SOURCES, because there are two ways a data service's credential comes to exist:
//
//  1. THE RUNNER MINTED IT (a `queue` node's RabbitMQ, #3304). A chart that generates a credential
//     per render is permanently OutOfSync, so those charts are pointed at a Secret the runner
//     seeds instead — and the chart then renders NO Secret at all. Before this lookup existed the
//     console silently showed a queue with no credential reference: not an error anywhere, just an
//     endpoint the operator cannot connect with.
//  2. THE CHART MINTED IT (CNPG's "<cluster>-app", Valkey's). It carries the chart's own
//     `app.kubernetes.io/instance` label, so ArgoCD's release label finds it.
//
// THE RUNNER'S ANSWER WINS, and the order is load-bearing rather than arbitrary. A cluster that
// deployed before #3304 still holds the chart's old Secret — it is annotated
// `helm.sh/resource-policy: keep`, so it outlives the render that stopped producing it — and that
// Secret is no longer what the pods read. Asking the release label first would keep pointing the
// console at it.
//
// The runner's lookup deliberately matches `alethia.io/addon-secret` and NOT the ArgoCD release
// label. Stamping the release label onto a runner-seeded Secret would make the Application own a
// resource its manifest does not contain, and `prune: true` deletes exactly that — the fix would
// take the credential away on the first reconcile.
func readSecretRef(release, namespace, addonID string, stderr io.Writer) string {
	// Same restatement as readOneEndpoint, same reason.
	if !k8sNameRe.MatchString(release) || !k8sNameRe.MatchString(namespace) {
		return ""
	}
	// An add-on id interpolates into the same command string, and this one reaches here straight
	// from the config snapshot rather than through AddOnAppName — so it is checked, not trusted. An
	// unusable id skips this source; it never skips the one below.
	if addonID != "" && k8sNameRe.MatchString(addonID) {
		if ref := secretRefBySelector(fmt.Sprintf("%s=%s", addonSecretLabelKey, addonID), namespace, stderr); ref != "" {
			return ref
		}
	}
	return secretRefBySelector(fmt.Sprintf("app.kubernetes.io/instance=%s", release), namespace, stderr)
}

// secretRefBySelector lists the Secrets in one namespace matching one label selector and returns
// "<namespace>/<name>" for the credential among them, or "" when there is none.
func secretRefBySelector(selector, namespace string, stderr io.Writer) string {
	var secrets secretList
	cmd := fmt.Sprintf("kubectl get secret -n %s -l %s -o json", namespace, selector)
	if err := kubectlJSON(cmd, &secrets, stderr); err != nil {
		return ""
	}
	var names []string
	for _, s := range secrets.Items {
		// CNPG mints "<cluster>-app" (basic-auth: username/password/uri) — the one an application
		// connects with. Helm's own release secrets (type helm.sh/release.v1) are not credentials.
		if s.Type == "helm.sh/release.v1" {
			continue
		}
		names = append(names, s.Metadata.Name)
	}
	if len(names) == 0 {
		return ""
	}
	sort.Strings(names)
	// Prefer an "-app" secret (CNPG's application credential) when present.
	for _, n := range names {
		if strings.HasSuffix(n, "-app") {
			return namespace + "/" + n
		}
	}
	return namespace + "/" + names[0]
}
