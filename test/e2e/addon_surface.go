// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package e2e

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// The FULL add-on surface.
//
// The provisioning tiers seed ONE lean add-on by default (reloader — see seedAddOns), which is
// enough to give the ArgoCD health assertion teeth but is nowhere near the maintainer's
// FULLY-TESTED bar: "every single add-on we have available" must install and converge.
//
// AllCatalogAddOns loads all 18, from the GENERATED per-cloud fixture
// `fixtures/addon_catalog.<cloud>.json` — which
// is produced from apps/console/lib/addons/catalog.ts (the SSOT) via the real `resolveAddOnInstall`
// (`pnpm -C apps/console run export:addon-catalog`), and kept honest by catalog-export.test.ts, which reds CI
// if the fixture drifts from the catalog. Re-typing the chart coordinates here in Go would have gone
// stale the first time someone bumped a chart — and the drift would only have surfaced as a red
// nightly against a real cloud.
//
// Opt-in via ALETHIA_E2E_ALL_ADDONS=1: the full surface pulls ~18 charts (several heavy —
// kube-prometheus-stack, harbor, minio, vault, loki, tempo, velero) and needs a node sized for them,
// so the default lean tier stays fast and cheap. The nightly real-apply run turns it on.

// AllAddOnsEnabled reports whether this run should seed the FULL add-on surface.
func AllAddOnsEnabled() bool {
	return os.Getenv("ALETHIA_E2E_ALL_ADDONS") == "1"
}

// addonCatalogFixture is the generated all-add-ons fixture FOR THIS RUN'S CLOUD (see the package
// comment).
//
// Per-cloud because some knobs are only correct relative to the target. external-dns is the measured
// case: its `provider` knob defaults to `cloudflare`, so the single cloud-agnostic fixture this
// replaced installed external-dns pointed at Cloudflare on every cloud, with no Cloudflare token. It
// could not converge and never could — so the 18-chart cell was testing the fixture, not the chart
// (#2717 class (c)).
//
// The cloud is resolved the SAME way the rest of the harness resolves it — `ALETHIA_E2E_PROVIDER`,
// defaulting to hetzner (t2_provision_test.go). A second, differently-defaulted answer to "which
// cloud is this" is exactly how two files come to disagree; the pure tests read the hetzner fixture,
// which is fine because they assert structure rather than provider knobs.
func addonCatalogFixture() (string, error) {
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		return "", fmt.Errorf("cannot locate the e2e package directory")
	}
	cloud := t2Env(envE2EProvider, "hetzner")
	return filepath.Join(filepath.Dir(thisFile), "fixtures", "addon_catalog."+cloud+".json"), nil
}

// AllCatalogAddOns returns every marketplace add-on as the runner-facing install spec the console
// would emit. Fail-closed: a missing/empty/short fixture is an ERROR, never a silent fallback to a
// smaller set — a full-surface run that quietly installed 1 add-on and reported green would be the
// exact vacuous proof the FULLY-TESTED bar exists to prevent.
func AllCatalogAddOns() ([]types.AddOnInstall, error) {
	path, err := addonCatalogFixture()
	if err != nil {
		return nil, err
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read add-on catalog fixture: %w (regenerate: pnpm -C apps/console run export:addon-catalog)", err)
	}
	var addons []types.AddOnInstall
	if err := json.Unmarshal(raw, &addons); err != nil {
		return nil, fmt.Errorf("parse add-on catalog fixture: %w", err)
	}
	if len(addons) < expectedCatalogSize {
		return nil, fmt.Errorf(
			"add-on catalog fixture holds %d add-ons, expected %d — the full-surface run would be vacuous (regenerate: pnpm -C apps/console run export:addon-catalog)",
			len(addons), expectedCatalogSize,
		)
	}
	for i, a := range addons {
		if a.ID == "" || a.ChartRepo == "" || a.Chart == "" || a.Version == "" {
			return nil, fmt.Errorf("add-on catalog fixture entry %d is incomplete: %+v", i, a)
		}
	}
	return applyAddOnDebugOverrides(addons), nil
}

// envAddOnDebugValues opts one or more add-ons into extra diagnostic logging for a single run.
const envAddOnDebugValues = "ALETHIA_E2E_ADDON_DEBUG"

// applyAddOnDebugOverrides turns on per-add-on debug logging that MUST NOT ship in the catalog.
//
// #2866 is the case this exists for. falco crash-loops on Talos with
//
//	Opening 'syscall' source with modern BPF probe.
//	An error occurred in an event source, forcing termination...
//	Error: Initialization issues during scap_init
//
// and that is the LAST thing it says. #2895 raised the crash-loop dump to 400 lines with
// `--previous` on the theory that the sub-errors were being truncated; the hetzner/addons run on
// 2026-08-27 (33059349873) then showed the entire init sequence with nothing after scap_init at
// all. The detail is not truncated — it is not emitted. scap lives in falco's `libs` layer, whose
// logger is off by default.
//
// WHY NOT JUST SET IT IN THE CATALOG. The pinned falco chart's own values say of `libs_logger`:
// "It is not recommended for production use." The catalog is what a CUSTOMER installs, so turning
// debug logging on there to serve one investigation would ship it to every customer's cluster
// forever. This is a run-scoped override instead: unset changes nothing, and setting it is a
// deliberate act recorded in a repo variable.
//
// Deliberately a small fixed TABLE rather than free-form YAML from the environment. A run whose
// add-on values can be rewritten arbitrarily from a variable is a run that can no longer be said to
// have proven the catalog — the whole point of seeding from the generated fixture is that the e2e
// installs what ships. Each entry here is one named, reviewable diagnostic.
func applyAddOnDebugOverrides(addons []types.AddOnInstall) []types.AddOnInstall {
	want := map[string]bool{}
	for _, id := range strings.Split(os.Getenv(envAddOnDebugValues), ",") {
		if t := strings.TrimSpace(id); t != "" {
			want[t] = true
		}
	}
	if len(want) == 0 {
		return addons
	}
	for i := range addons {
		if !want[addons[i].ID] {
			continue
		}
		switch addons[i].ID {
		case "falco":
			// falco.libs_logger — the layer scap_init reports from (#2866).
			mergeAddOnValues(&addons[i], map[string]interface{}{
				"falco": map[string]interface{}{
					"libs_logger": map[string]interface{}{"enabled": true, "severity": "debug"},
				},
			})
		}
	}
	return addons
}

// mergeAddOnValues merges one level of override into an install's Values, creating the map when the
// spec carries none. Shallow ON PURPOSE at the top level and recursive below it, so an override for
// `falco.libs_logger` cannot drop the `falco.json_output` the catalog already set.
func mergeAddOnValues(a *types.AddOnInstall, over map[string]interface{}) {
	if a.Values == nil {
		a.Values = map[string]interface{}{}
	}
	a.Values = deepMergeValues(a.Values, over)
}

// deepMergeValues merges src into dst, recursing into nested maps. Returns dst.
func deepMergeValues(dst, src map[string]interface{}) map[string]interface{} {
	for k, v := range src {
		sub, isMap := v.(map[string]interface{})
		if !isMap {
			dst[k] = v
			continue
		}
		existing, ok := dst[k].(map[string]interface{})
		if !ok {
			existing = map[string]interface{}{}
		}
		dst[k] = deepMergeValues(existing, sub)
	}
	return dst
}

// CatalogAddOn returns ONE add-on's install spec from the same generated fixture AllCatalogAddOns
// reads — the runner-facing shape the console's `resolveAddOnInstall` actually emits, knob defaults
// already merged.
//
// It exists so the LEAN tier stops restating what the generated artifact already holds. The lean
// seed used to be a hand-written literal (chart coordinates plus `Values: map[string]interface{}{}`),
// and on 2026-07-16 #643 gave reloader real knob defaults: catalog.ts, addon_catalog.<cloud>.json and
// t2_config_snapshot.hetzner.json were all regenerated, the Go literal was not, and it emitted empty
// values for ~3 weeks while claiming in its own doc comment to emit "the exact camelCase shape the
// console's resolveAddOnInstall emits". Deriving makes that drift class UNREPRESENTABLE rather than
// merely detectable — the same bargain the full surface already took.
//
// Fail-closed for the same reason AllCatalogAddOns is: an unknown id returns an error rather than a
// zero-valued spec, because a silently empty add-on is a provisioning run that installs nothing and
// reports green.
func CatalogAddOn(id string) (types.AddOnInstall, error) {
	addons, err := AllCatalogAddOns()
	if err != nil {
		return types.AddOnInstall{}, err
	}
	for _, a := range addons {
		if a.ID == id {
			return a, nil
		}
	}
	return types.AddOnInstall{}, fmt.Errorf(
		"add-on %q is not in the catalog fixture (regenerate: pnpm -C apps/console run export:addon-catalog)", id)
}

// expectedCatalogSize mirrors the console's B0.3 SSOT count guard (ADDON_CATALOG.length === 18).
// A fixture with fewer entries means the export is stale or partial — fail rather than under-test.
//
// 19 → 18 when cert-manager moved to the PLATFORM rail (infra/templates/argocd/cert-manager.yaml).
// It is no longer a marketplace chart this run installs; it ships from the deploy itself, and its
// ArgoCD Application is asserted through the infra-service decision instead (infraServiceArgoApps).
const expectedCatalogSize = 18

// SeedAddOnsForSurface returns the add-ons a provisioning tier should seed: the full catalog when
// ALETHIA_E2E_ALL_ADDONS=1, else the lean single seed (fast default).
func SeedAddOnsForSurface(lean []types.AddOnInstall) ([]types.AddOnInstall, error) {
	if !AllAddOnsEnabled() {
		return lean, nil
	}
	return AllCatalogAddOns()
}
