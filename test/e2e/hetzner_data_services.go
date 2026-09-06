// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package e2e

// Hetzner's IN-CLUSTER data services — the half of the max-config surface no cloud IaC carries.
//
// Hetzner is compute-only: a `database`/`cache`/`queue` component there is not a managed cloud
// resource but an in-cluster Helm chart (CloudNativePG / Valkey / RabbitMQ) that the console
// synthesizes and the runner installs as an ArgoCD Application. That is what the max-config table's
// `CarriedInCluster` verdict asserts — the named Application reaching Healthy+Synced.
//
// THE DEFECT THIS FILE CLOSES. The runner renders an Application only for an add-on that RIDES THE
// DEPLOY SNAPSHOT (packages/core/provisioner/deploy.go → AllAddOnNames → execution_metadata
// .addon_status → DeriveExpectedArgoApps). The harness seeded add-ons from the marketplace catalog
// alone (seedAddOns/AllCatalogAddOns), which can never hold these: they are synthesized per
// component, not chosen from a marketplace. So the three cells asserted an Application that could
// not exist, t2_provision_test.go t.Fatal'd on `Missing`, and a Hetzner full-bar run was RED BY
// CONSTRUCTION — recorded in the table as an inherent blocker, which it was not.
//
// It is not hand-mirrored, and that is the whole point: apps/console/lib/cloud-providers/
// hetzner-services.ts owns the chart coordinates, namespaces, sync-waves, the CNPG CRD gate and two
// value schemas that have each broken in production once (bitnami/valkey deleted from its index;
// bitnami/rabbitmq's image relocated to a 404). A Go copy of that list would have gone stale the
// first time someone bumped a chart, and the drift would only surface as a red nightly against a
// real cloud. So the specs come from a GENERATED fixture on the same rail addon_catalog.<cloud>.json uses:
//
//	SSOT          apps/console/lib/cloud-providers/hetzner-services.ts
//	generator     pnpm -C apps/console run export:hetzner-data-services
//	              (apps/console/scripts/export-hetzner-data-services.mts)
//	fixture       test/e2e/fixtures/hetzner_data_services.json
//	drift guard   apps/console/tests/lib/cloud-providers/hetzner-data-services-export.test.ts (CI)
//	read-back     TestHetznerDataServiceFixtureMatchesTheMaxConfigSurface (free, every PR)
//
// The fixture also carries the COMPONENTS it was generated from, so the Go read-back can compare
// them with the real MaxConfigProjectConfig("hetzner") instead of trusting that two lists were kept
// in step by hand.

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// hetznerDataServiceComponents are the component rows the fixture was generated from — the input
// half of the generated artifact, read back against the real max-config surface.
type hetznerDataServiceComponents struct {
	Databases []struct {
		Name          string `json:"name"`
		EngineFamily  string `json:"engine_family"`
		EngineVersion string `json:"engine_version"`
	} `json:"databases"`
	Caches []struct {
		Name          string `json:"name"`
		NumCacheNodes int    `json:"num_cache_nodes"`
	} `json:"caches"`
	Queues []struct {
		Name string `json:"name"`
	} `json:"queues"`
	Registries []struct {
		Name string `json:"name"`
	} `json:"registries"`
	Secrets []struct {
		Name string `json:"name"`
	} `json:"secrets"`
	Topics []struct {
		Name string `json:"name"`
	} `json:"topics"`
	NosqlTables []struct {
		Name string `json:"name"`
	} `json:"nosqlTables"`
}

// hetznerDataServiceFixture is the generated artifact: what was mapped, and what it mapped to.
type hetznerDataServiceFixture struct {
	Components hetznerDataServiceComponents `json:"components"`
	AddOns     []types.AddOnInstall         `json:"addons"`
}

// hetznerDataServicesRegenerate is the one command that fixes every failure in this file. Repeated
// in each error because these are read from a nightly's logs, where the surrounding doc comment is
// not.
const hetznerDataServicesRegenerate = "regenerate: pnpm -C apps/console run export:hetzner-data-services"

// hetznerDataServicesFixturePath locates the generated fixture beside this package.
func hetznerDataServicesFixturePath() (string, error) {
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		return "", fmt.Errorf("cannot locate the e2e package directory")
	}
	return filepath.Join(filepath.Dir(thisFile), "fixtures", "hetzner_data_services.json"), nil
}

// loadHetznerDataServiceFixture reads and validates the generated fixture. Fail-closed in the same
// shape AllCatalogAddOns is: a missing, unparseable or under-populated fixture is an ERROR, never a
// silent fallback to "no in-cluster charts" — which would put the run straight back into the failure
// this file exists to close, except reporting green up to the point the kinds were asserted.
func loadHetznerDataServiceFixture() (hetznerDataServiceFixture, error) {
	var fx hetznerDataServiceFixture
	path, err := hetznerDataServicesFixturePath()
	if err != nil {
		return fx, err
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return fx, fmt.Errorf("read hetzner data-service fixture: %w (%s)", err, hetznerDataServicesRegenerate)
	}
	if err := json.Unmarshal(raw, &fx); err != nil {
		return fx, fmt.Errorf("parse hetzner data-service fixture: %w (%s)", err, hetznerDataServicesRegenerate)
	}
	if len(fx.Components.Databases) == 0 || len(fx.Components.Caches) == 0 ||
		len(fx.Components.Queues) == 0 || len(fx.Components.Registries) == 0 ||
		len(fx.Components.Secrets) == 0 || len(fx.Components.Topics) == 0 ||
		len(fx.Components.NosqlTables) == 0 {
		return hetznerDataServiceFixture{}, fmt.Errorf(
			"hetzner data-service fixture declares %d database(s), %d cache(s), %d queue(s), %d registry/ies, %d secret(s), %d topic(s), %d nosql table(s) — all SEVEN kinds are CarriedInCluster on hetzner, so a missing one makes that kind unprovable (%s)",
			len(fx.Components.Databases), len(fx.Components.Caches), len(fx.Components.Queues),
			len(fx.Components.Registries), len(fx.Components.Secrets), len(fx.Components.Topics),
			len(fx.Components.NosqlTables), hetznerDataServicesRegenerate)
	}
	// One Application per component, plus the CNPG operator that owns the Cluster CRD. Derived from
	// the components rather than written down: a hard-coded total has to be edited by hand every
	// time a kind joins the in-cluster set, and the edit is invisible until a real Hetzner run.
	//
	// `secret` is the exception and must not be counted per component: every secret node on a
	// project is one KV v2 entry in the SAME Vault, so N secrets still render ONE release. Counting
	// it per node would pass today (the surface declares exactly one) and start failing the moment a
	// second secret is added — for a fixture that was perfectly correct.
	vaultSpecs := 0
	if len(fx.Components.Secrets) > 0 {
		vaultSpecs = 1
	}
	// scylla-operator is the SECOND operator, counted the same way the CNPG one is: once, when any
	// nosql node exists, because it owns the ScyllaCluster CRD every nosql Application depends on.
	scyllaOperatorSpecs := 0
	if len(fx.Components.NosqlTables) > 0 {
		scyllaOperatorSpecs = 1
	}
	wantSpecs := len(fx.Components.Databases) + len(fx.Components.Caches) +
		len(fx.Components.Queues) + len(fx.Components.Registries) +
		len(fx.Components.Topics) + len(fx.Components.NosqlTables) +
		vaultSpecs + scyllaOperatorSpecs + 1
	if len(fx.AddOns) != wantSpecs {
		return hetznerDataServiceFixture{}, fmt.Errorf(
			"hetzner data-service fixture holds %d install spec(s), expected %d (one per component, one Vault for all secrets, + the cnpg-operator and the scylla-operator) — the fixture is stale or partial (%s)",
			len(fx.AddOns), wantSpecs, hetznerDataServicesRegenerate)
	}
	for i, a := range fx.AddOns {
		if a.ID == "" || a.ChartRepo == "" || a.Chart == "" || a.Version == "" || a.Namespace == "" {
			return hetznerDataServiceFixture{}, fmt.Errorf(
				"hetzner data-service fixture entry %d is incomplete: %+v (%s)", i, a, hetznerDataServicesRegenerate)
		}
	}
	return fx, nil
}

// HetznerDataServiceAddOns returns the in-cluster install specs a Hetzner max-config deploy must
// carry — the CNPG operator plus one Application per database/cache/queue component — in the exact
// runner-facing shape the console's buildConfigSnapshot appends for a Hetzner project.
func HetznerDataServiceAddOns() ([]types.AddOnInstall, error) {
	fx, err := loadHetznerDataServiceFixture()
	if err != nil {
		return nil, err
	}
	return fx.AddOns, nil
}
