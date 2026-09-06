// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"regexp"
	"sort"
	"strings"

	"github.com/alethialabs-io/alethialabs/packages/core/names"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/alethialabs-io/alethialabs/packages/core/utils"
)

// Add-on secret Secrets (W4.5 #640): a `secret`-typed marketplace knob never rides the
// Application manifest — the console resolves it to a SecretRef (name/namespace/keys, no
// values) and the runner seeds the actual k8s Secret here, pre-sync, from values fetched
// over the authenticated job channel. The Secret carries the marketplace labels so prune
// can find it, but deliberately NO ArgoCD tracking metadata — no Application owns it, so
// no sync ever prunes or overwrites it.

// addonSecretLabelKey marks a runner-seeded add-on secret with its owning add-on id, so
// PruneAddOnSecrets can delete the Secret of a disabled add-on wherever it lives.
const addonSecretLabelKey = "alethia.io/addon-secret"

// k8sNameRe is the RFC-1123 DNS-label charset kubernetes enforces on names/namespaces.
// The SecretRef fields interpolate into a YAML manifest and kubectl commands, and they
// arrive via the DB-persisted config snapshot — validating here keeps a tampered snapshot
// (or a future catalog bug) from injecting YAML documents or shell into the runner.
//
// The grammar is names.NamespacePattern, generated from apps/console/lib/validations/names.ts
// (#3665) — the same one the console validates against, so the two cannot come to disagree about
// what a name may be.
var k8sNameRe = names.NamespacePattern

// secretKeyRe is the k8s Secret data-key charset (alphanumerics, '-', '_', '.').
var secretKeyRe = regexp.MustCompile(`^[A-Za-z0-9._-]+$`)

// validSecretRef rejects a SecretRef whose identifiers could not have come from the
// console's own resolver (fail-closed on snapshot tampering / catalog mistakes).
func validSecretRef(ref types.AddOnSecretRef, addonID string) bool {
	if !k8sNameRe.MatchString(ref.SecretName) || !k8sNameRe.MatchString(ref.Namespace) ||
		!k8sNameRe.MatchString(addonID) {
		return false
	}
	for _, k := range ref.Keys {
		if !secretKeyRe.MatchString(k) {
			return false
		}
	}
	// StaticData keys interpolate into the manifest exactly like Keys do (#644).
	for k := range ref.StaticData {
		if !secretKeyRe.MatchString(k) {
			return false
		}
	}
	return true
}

// addonSecretManifest renders the namespace + Secret pair for one add-on. The namespace is
// included (like externalDNSSecretManifest) because the Secret must exist BEFORE the
// Application's first sync creates the namespace via CreateNamespace=true.
func addonSecretManifest(ref types.AddOnSecretRef, addonID string, data map[string]string) string {
	b64 := base64.StdEncoding.EncodeToString
	keys := make([]string, 0, len(data))
	for k := range data {
		keys = append(keys, k)
	}
	sort.Strings(keys) // deterministic render (testable, diff-stable)
	var b strings.Builder
	fmt.Fprintf(&b, `apiVersion: v1
kind: Namespace
metadata:
  name: %s
---
apiVersion: v1
kind: Secret
metadata:
  name: %s
  namespace: %s
  labels:
    alethia.io/managed-by: addon-marketplace
    %s: %s
data:
`, ref.Namespace, ref.SecretName, ref.Namespace, addonSecretLabelKey, addonID)
	for _, k := range keys {
		fmt.Fprintf(&b, "  %s: %s\n", k, b64([]byte(data[k])))
	}
	return b.String()
}

// EnsureAddOnSecrets seeds the per-add-on k8s Secrets for every add-on that declares a
// SecretRef and has fetched values (keyed by add-on id → field key → plaintext). Idempotent:
// kubectl apply refreshes a rotated value on every deploy. Best-effort per add-on — one bad
// secret must not fail an otherwise-healthy cluster (the chart surfaces the missing Secret
// as a sync error on ITS Application); a missing fetched value is reported, never invented.
// Values never touch the returned error strings or the log (only names/keys do).
func EnsureAddOnSecrets(addons []types.AddOnInstall, fetched map[string]map[string]string, stdout, stderr io.Writer) {
	for i := range addons {
		ref := addons[i].SecretRef
		if ref == nil || ref.SecretName == "" || ref.Namespace == "" {
			continue
		}
		if !validSecretRef(*ref, addons[i].ID) {
			fmt.Fprintf(stderr, "Warning: add-on %s carries an invalid secret ref — refusing to render it\n", addons[i].ID)
			continue
		}
		values := fetched[addons[i].ID]
		data := map[string]string{}
		// Paired NON-secret constants first (#644: the admin username a chart reads from
		// the same Secret as the password) — a fetched secret value wins on collision.
		for k, v := range ref.StaticData {
			if v != "" {
				data[k] = v
			}
		}
		var missing []string
		for _, key := range ref.Keys {
			if v, ok := values[key]; ok && v != "" {
				data[key] = v
			} else {
				missing = append(missing, key)
			}
		}
		if len(missing) > 0 {
			fmt.Fprintf(stderr, "Warning: add-on %s secret %s is missing value(s) for key(s) %s — the chart will report the gap\n",
				addons[i].ID, ref.SecretName, strings.Join(missing, ", "))
		}
		if len(data) == 0 {
			continue
		}
		fmt.Fprintf(stdout, "Seeding add-on secret %s/%s (%d key(s))...\n", ref.Namespace, ref.SecretName, len(data))
		if err := ApplyManifest(addonSecretManifest(*ref, addons[i].ID, data), stdout, stderr); err != nil {
			fmt.Fprintf(stderr, "Warning: failed to seed add-on secret %s/%s: %v\n", ref.Namespace, ref.SecretName, err)
		}
	}
}

// PruneAddOnSecrets deletes the runner-seeded Secrets of add-ons that are no longer enabled
// (mirrors PruneManagedAddOns' desired-set model, but lists across ALL namespaces — a
// disabled add-on's namespace is no longer in the config). Best-effort + idempotent.
func PruneAddOnSecrets(desiredAddonIDs []string, stdout, stderr io.Writer) {
	desired := make(map[string]struct{}, len(desiredAddonIDs))
	for _, id := range desiredAddonIDs {
		desired[id] = struct{}{}
	}
	raw, err := utils.ExecuteCommandWithOutput(
		fmt.Sprintf("kubectl get secrets -A -l alethia.io/managed-by=addon-marketplace,%s -o json", addonSecretLabelKey),
		".",
		nil,
	)
	if err != nil {
		fmt.Fprintf(stderr, "Warning: could not list add-on secrets to prune: %v\n", err)
		return
	}
	var list struct {
		Items []struct {
			Metadata struct {
				Name      string            `json:"name"`
				Namespace string            `json:"namespace"`
				Labels    map[string]string `json:"labels"`
			} `json:"metadata"`
		} `json:"items"`
	}
	if err := json.Unmarshal([]byte(raw), &list); err != nil {
		fmt.Fprintf(stderr, "Warning: could not parse add-on secret list to prune: %v\n", err)
		return
	}
	for _, item := range list.Items {
		id := item.Metadata.Labels[addonSecretLabelKey]
		if _, keep := desired[id]; keep {
			continue
		}
		// The name/namespace interpolate into a kubectl command; the API server already
		// constrains them to DNS labels, but fail closed on anything that isn't one.
		if !k8sNameRe.MatchString(item.Metadata.Name) || !k8sNameRe.MatchString(item.Metadata.Namespace) {
			fmt.Fprintf(stderr, "Warning: skipping prune of oddly-named secret %q/%q\n", item.Metadata.Namespace, item.Metadata.Name)
			continue
		}
		fmt.Fprintf(stdout, "Pruning disabled add-on's secret: %s/%s\n", item.Metadata.Namespace, item.Metadata.Name)
		cmd := fmt.Sprintf("kubectl delete secret -n %s %s --ignore-not-found=true",
			item.Metadata.Namespace, item.Metadata.Name)
		if delErr := utils.ExecuteCommand(cmd, ".", nil, stdout, stderr); delErr != nil {
			fmt.Fprintf(stderr, "Warning: failed to prune add-on secret %s/%s: %v\n",
				item.Metadata.Namespace, item.Metadata.Name, delErr)
		}
	}
}
