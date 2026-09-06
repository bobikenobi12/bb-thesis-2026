// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"bytes"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// cnpgSvcJSON is a CloudNativePG-shaped Service list: a headless peer-discovery Service, the
// read-only `-ro` Service, and the read-write `-rw` Service clients actually connect to.
const cnpgSvcJSON = `{"items":[
 {"metadata":{"name":"pg-headless","namespace":"data"},"spec":{"clusterIP":"None","ports":[{"port":5432}]}},
 {"metadata":{"name":"pg-ro","namespace":"data"},"spec":{"clusterIP":"10.0.0.2","ports":[{"port":5432}]}},
 {"metadata":{"name":"pg-rw","namespace":"data"},"spec":{"clusterIP":"10.0.0.3","ports":[{"port":5432}]}}
]}`

// cnpgSecretJSON pairs the Helm release Secret (never a credential) with CNPG's `-app` credential.
const cnpgSecretJSON = `{"items":[
 {"metadata":{"name":"sh.helm.release.v1.pg.v1","namespace":"data"},"type":"helm.sh/release.v1"},
 {"metadata":{"name":"pg-app","namespace":"data"},"type":"kubernetes.io/basic-auth"}
]}`

// TestReadDataEndpoints covers the in-cluster data-service read-back end to end: which add-ons it
// looks at, which Service becomes the primary, and that only a credential REFERENCE is recorded.
func TestReadDataEndpoints(t *testing.T) {
	tests := []struct {
		name       string
		addons     []types.AddOnInstall
		svcJSON    string
		svcExit    int
		secretJSON string
		want       map[string]DataEndpoint
		wantWarn   string
	}{
		{
			name: "a gitops-mode add-on and a marketplace chart are both skipped",
			addons: []types.AddOnInstall{
				{ID: "db-primary", Mode: "gitops", Namespace: "data"},
				{ID: "kube-prometheus-stack", Mode: "managed", Namespace: "obs"},
			},
			want: map[string]DataEndpoint{},
		},
		{
			name:       "CNPG: the -rw Service wins, -ro is the reader, the -app Secret is referenced",
			addons:     []types.AddOnInstall{{ID: "db-primary", Mode: "managed", Namespace: "data"}},
			svcJSON:    cnpgSvcJSON,
			secretJSON: cnpgSecretJSON,
			want: map[string]DataEndpoint{
				"db-primary": {
					Endpoint:       "pg-rw.data.svc.cluster.local",
					Port:           5432,
					ReaderEndpoint: "pg-ro.data.svc.cluster.local",
					SecretRef:      "data/pg-app",
				},
			},
		},
		{
			name:   "a single-Service chart (Valkey/RabbitMQ shape) with no credential Secret",
			addons: []types.AddOnInstall{{ID: "cache-main", Mode: "managed", Namespace: "cache"}},
			svcJSON: `{"items":[
			 {"metadata":{"name":"valkey","namespace":"cache"},"spec":{"clusterIP":"10.0.0.9","ports":[{"port":6379}]}},
			 {"metadata":{"name":"valkey-read","namespace":"cache"},"spec":{"clusterIP":"10.0.0.10","ports":[{"port":6379}]}}
			]}`,
			secretJSON: `{"items":[]}`,
			want: map[string]DataEndpoint{
				"cache-main": {
					Endpoint:       "valkey.cache.svc.cluster.local",
					Port:           6379,
					ReaderEndpoint: "valkey-read.cache.svc.cluster.local",
				},
			},
		},
		{
			name:     "no Service at all is omitted, never guessed",
			addons:   []types.AddOnInstall{{ID: "queue-jobs", Mode: "managed", Namespace: "mq"}},
			svcJSON:  `{"items":[]}`,
			want:     map[string]DataEndpoint{},
			wantWarn: "no Service found for data service queue-jobs",
		},
		{
			name:     "only headless Services means no client endpoint",
			addons:   []types.AddOnInstall{{ID: "db-primary", Mode: "managed", Namespace: "data"}},
			svcJSON:  `{"items":[{"metadata":{"name":"pg-headless","namespace":"data"},"spec":{"clusterIP":"None"}}]}`,
			want:     map[string]DataEndpoint{},
			wantWarn: "no Service found for data service db-primary",
		},
		{
			name:     "a kubectl failure is best-effort, not a deploy failure",
			addons:   []types.AddOnInstall{{ID: "db-primary", Mode: "managed", Namespace: "data"}},
			svcExit:  1,
			want:     map[string]DataEndpoint{},
			wantWarn: "no Service found for data service db-primary",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			// The secret rule is scoped to the CHART-MINTED selector: readSecretRef asks the
			// runner-seeded one first, and a bare "get secret" rule would answer that instead —
			// leaving every case in this table (CNPG's `-app`, the single-Service shape, the
			// no-credential case) proving itself on a branch it was not written for.
			newKubectlStub(t, 0,
				stubRule{Match: "get svc", Stdout: tc.svcJSON, Exit: tc.svcExit},
				stubRule{Match: "alethia.io/addon-secret=", Stdout: `{"items":[]}`},
				stubRule{Match: "app.kubernetes.io/instance=", Stdout: tc.secretJSON},
			)
			var stdout, stderr bytes.Buffer
			got := ReadDataEndpoints(tc.addons, &stdout, &stderr)

			if len(got) != len(tc.want) {
				t.Fatalf("ReadDataEndpoints() = %#v, want %#v", got, tc.want)
			}
			for id, want := range tc.want {
				if got[id] != want {
					t.Errorf("endpoint %q = %#v, want %#v", id, got[id], want)
				}
			}
			if tc.wantWarn != "" && !strings.Contains(stderr.String(), tc.wantWarn) {
				t.Errorf("stderr = %q, want it to contain %q", stderr.String(), tc.wantWarn)
			}
		})
	}
}

// A `queue` node's RabbitMQ mints NOTHING any more (#3304): the chart reads its password and
// erlang cookie from a Secret the runner seeded, so it renders no Secret and nothing carries
// ArgoCD's release label. Before the second lookup, the console showed a queue endpoint with no
// credential reference at all — not an error anywhere, just an endpoint nobody can connect with.
func TestReadDataEndpointsFindsARunnerSeededCredential(t *testing.T) {
	const svcJSON = `{"items":[
	 {"metadata":{"name":"queue-jobs-rabbitmq-headless","namespace":"queues"},"spec":{"clusterIP":"None","ports":[{"port":5672}]}},
	 {"metadata":{"name":"queue-jobs-rabbitmq","namespace":"queues"},"spec":{"clusterIP":"10.0.0.7","ports":[{"port":5672}]}}
	]}`
	stub := newKubectlStub(t, 0,
		stubRule{Match: "get svc", Stdout: svcJSON},
		// The chart's own release label finds nothing — that is the whole point of the fix.
		stubRule{Match: "app.kubernetes.io/instance=", Stdout: `{"items":[]}`},
		stubRule{
			Match:  "alethia.io/addon-secret=queue-jobs",
			Stdout: `{"items":[{"metadata":{"name":"rabbitmq-jobs-credentials","namespace":"queues"},"type":"Opaque"}]}`,
		},
	)

	var stdout, stderr bytes.Buffer
	got := ReadDataEndpoints(
		[]types.AddOnInstall{{ID: "queue-jobs", Mode: "managed", Namespace: "queues"}},
		&stdout, &stderr,
	)
	want := DataEndpoint{
		Endpoint:  "queue-jobs-rabbitmq.queues.svc.cluster.local",
		Port:      5672,
		SecretRef: "queues/rabbitmq-jobs-credentials",
	}
	if got["queue-jobs"] != want {
		t.Fatalf("endpoint = %#v, want %#v", got["queue-jobs"], want)
	}
	if !stub.calledWith("alethia.io/addon-secret=queue-jobs") {
		t.Errorf("never asked for the runner-seeded Secret; calls = %v", stub.calls())
	}
}

// The runner's Secret is asked for FIRST, and that order is what a cluster deployed before #3304
// depends on: the chart's old Secret is annotated `helm.sh/resource-policy: keep`, so it is still
// there — carrying the credentials the pods no longer read. Asking the release label first would
// hand the console that stale one, which is worse than the empty reference this replaced.
func TestReadSecretRefPrefersTheRunnerSeededSecretOverAStaleChartOne(t *testing.T) {
	newKubectlStub(t, 0,
		stubRule{
			Match:  "alethia.io/addon-secret=queue-jobs",
			Stdout: `{"items":[{"metadata":{"name":"rabbitmq-jobs-credentials","namespace":"queues"},"type":"Opaque"}]}`,
		},
		stubRule{
			Match:  "app.kubernetes.io/instance=",
			Stdout: `{"items":[{"metadata":{"name":"addon-queue-jobs-rabbitmq","namespace":"queues"},"type":"Opaque"}]}`,
		},
	)
	var stderr bytes.Buffer
	if got := readSecretRef("addon-queue-jobs", "queues", "queue-jobs", &stderr); got != "queues/rabbitmq-jobs-credentials" {
		t.Errorf("readSecretRef = %q, want the runner-seeded queues/rabbitmq-jobs-credentials", got)
	}
}

// And a chart that DOES mint its own credential is still found — the runner lookup is an added
// source, not a replacement. Without this, the change would silently drop CNPG's and Valkey's
// references while every queue test stayed green.
func TestReadSecretRefStillFindsAChartMintedCredential(t *testing.T) {
	newKubectlStub(t, 0,
		stubRule{Match: "alethia.io/addon-secret=", Stdout: `{"items":[]}`},
		stubRule{
			Match:  "app.kubernetes.io/instance=addon-db-primary",
			Stdout: `{"items":[{"metadata":{"name":"pg-app","namespace":"data"},"type":"kubernetes.io/basic-auth"}]}`,
		},
	)
	var stderr bytes.Buffer
	if got := readSecretRef("addon-db-primary", "data", "db-primary", &stderr); got != "data/pg-app" {
		t.Errorf("readSecretRef = %q, want data/pg-app", got)
	}
}

// The add-on id reaches the second lookup straight from the config snapshot, so it is checked
// before it interpolates into a kubectl command line — the same rule readOneEndpoint applies to the
// release and namespace it is handed.
func TestReadSecretRefRefusesAnUnsafeAddOnID(t *testing.T) {
	stub := newKubectlStub(t, 0, stubRule{Match: "get secret", Stdout: `{"items":[]}`})
	var stderr bytes.Buffer
	for _, id := range []string{"queue-jobs; rm -rf /", "queue-jobs$(id)", "Queue-Jobs", ""} {
		if got := readSecretRef("addon-queue-jobs", "queues", id, &stderr); got != "" {
			t.Errorf("readSecretRef with add-on id %q = %q, want empty", id, got)
		}
	}
	for _, c := range stub.calls() {
		if strings.Contains(c, "rm -rf") || strings.Contains(c, "$(id)") {
			t.Errorf("an unsafe add-on id reached a kubectl command line: %q", c)
		}
	}
}
