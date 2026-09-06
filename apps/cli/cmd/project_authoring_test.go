// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"bytes"
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/spf13/cobra"
)

// --- project create ---

func sampleProject() *api.Project {
	return &api.Project{
		ID: "p1", ProjectName: "api", Slug: "api", Region: "eu-west-1",
		IacVersion: "1.11.4", CloudProvider: "aws",
		EnvironmentStage: "development", Status: "DRAFT",
	}
}

func TestRunProjectCreateTable(t *testing.T) {
	var buf bytes.Buffer
	f := &fakeClient{createdProj: sampleProject()}
	params := api.CreateProjectParams{ProjectName: "api", Region: "eu-west-1", CloudIdentityID: "ci1"}
	if err := runProjectCreate(f, &buf, "table", params); err != nil {
		t.Fatalf("runProjectCreate: %v", err)
	}
	if f.createdProjP.ProjectName != "api" || f.createdProjP.CloudIdentityID != "ci1" {
		t.Errorf("params not forwarded: %+v", f.createdProjP)
	}
	for _, want := range []string{"api", "AWS", "eu-west-1", "DRAFT", "p1"} {
		if !strings.Contains(buf.String(), want) {
			t.Errorf("create card missing %q:\n%s", want, buf.String())
		}
	}
}

func TestRunProjectCreateNoProvider(t *testing.T) {
	var buf bytes.Buffer
	p := sampleProject()
	p.CloudProvider = ""
	if err := runProjectCreate(&fakeClient{createdProj: p}, &buf, "table", api.CreateProjectParams{}); err != nil {
		t.Fatalf("runProjectCreate: %v", err)
	}
	// No provider renders the dash glyph, not "AWS".
	if strings.Contains(buf.String(), "AWS") {
		t.Errorf("unexpected provider: %s", buf.String())
	}
}

func TestRunProjectCreateJSON(t *testing.T) {
	var buf bytes.Buffer
	if err := runProjectCreate(&fakeClient{createdProj: sampleProject()}, &buf, "json", api.CreateProjectParams{}); err != nil {
		t.Fatalf("runProjectCreate json: %v", err)
	}
	var got api.Project
	if err := json.Unmarshal(buf.Bytes(), &got); err != nil {
		t.Fatalf("invalid json: %v\n%s", err, buf.String())
	}
	if got.ID != "p1" || got.Slug != "api" {
		t.Errorf("unexpected project json: %+v", got)
	}
}

func TestRunProjectCreateError(t *testing.T) {
	var buf bytes.Buffer
	if err := runProjectCreate(&fakeClient{err: errBoom}, &buf, "table", api.CreateProjectParams{}); err == nil {
		t.Error("expected error propagated")
	}
}

// --- project env ---

// Two environments on ONE Fabric, at different isolation rungs — the shape the table exists to
// show. The dedicated env carries no namespace, which is why Namespace is an optional column.
func sampleEnvironments() []api.Environment {
	region := "us-east-1"
	fabric := "prod"
	ns := "boutique-staging"
	return []api.Environment{
		{
			ID: "e1", Name: "development", Stage: "development", Status: "DRAFT",
			IsDefault: true, Region: nil,
			PlacementMode: "dedicated", Namespace: nil, Fabric: &fabric,
		},
		{
			ID: "e2", Name: "staging", Stage: "staging", Status: "ACTIVE",
			IsDefault: false, Region: &region,
			PlacementMode: "vcluster", Namespace: &ns, Fabric: &fabric,
		},
	}
}

// Columns: Name(0) Stage(1) Placement(2) Namespace(3) Fabric(4) Status(5) Default(6) Region(7).
func TestEnvRows(t *testing.T) {
	rows := envRows(sampleEnvironments(), ui.FormatTable)
	if len(rows) != 2 {
		t.Fatalf("expected 2 rows, got %d", len(rows))
	}
	if got := len(rows[0]); got != len(envListColumns) {
		t.Fatalf("row has %d cells, header has %d — a table whose header and rows disagree "+
			"mislabels every value in it", got, len(envListColumns))
	}

	// Default env: dedicated, no namespace, brand marker, dash region.
	if rows[0][2] != "dedicated" || rows[0][3] != ui.SymbolDash || rows[0][4] != "prod" {
		t.Errorf("unexpected dedicated row placement cells: %+v", rows[0])
	}
	// Default(6) is ui.DefaultCell: the brand's `◆` on the one default row and an EMPTY cell on
	// every other. It was briefly ui.YesNo's `● / ·`, which put a glyph on every line and made
	// this the only table in the product to mark its default with something other than `◆`.
	// Region(7) is still a genuine ABSENCE and still the dash — that distinction is untouched.
	if rows[0][6] != ui.SymbolDefault || rows[0][7] != ui.SymbolDash {
		t.Errorf("unexpected default row: %+v", rows[0])
	}
	// Status(5) carries the glyph now, in the human format only. `runner list` and `clusters list`
	// have drawn one since #3694 and this table printed the bare shouting enum.
	if rows[0][5] != ui.StatusCell("DRAFT") {
		t.Errorf("default row status = %q, want the shared status cell %q", rows[0][5], ui.StatusCell("DRAFT"))
	}

	// Shared env: a vcluster placed on the SAME Fabric, with its destination namespace.
	if rows[1][2] != "vcluster" || rows[1][3] != "boutique-staging" || rows[1][4] != "prod" {
		t.Errorf("unexpected vcluster row placement cells: %+v", rows[1])
	}
	if rows[1][6] != "" || rows[1][7] != "us-east-1" {
		t.Errorf("unexpected named row: %+v", rows[1])
	}

	// The machine half of the Status cell: `-o csv` still carries the raw wire enum, because a
	// script parsing this column is the reason ui.Cell exists. A glyph in a csv field would be
	// the plain-text regression #4117 caught one command over, reintroduced here.
	csv := envRows(sampleEnvironments(), ui.FormatCSV)
	if csv[0][5] != "DRAFT" || csv[1][5] != "ACTIVE" {
		t.Errorf("csv status cells = %q/%q, want the raw enum values", csv[0][5], csv[1][5])
	}

	// The claim the table is FOR: both tiers name one Fabric, so only one cluster was bought.
	if rows[0][4] != rows[1][4] {
		t.Errorf("both environments should report the same Fabric, got %q and %q",
			rows[0][4], rows[1][4])
	}
}

func TestRunProjectEnvListTable(t *testing.T) {
	var buf bytes.Buffer
	f := &fakeClient{environments: sampleEnvironments()}
	if err := runProjectEnvList(f, &buf, "table", "api"); err != nil {
		t.Fatalf("runProjectEnvList: %v", err)
	}
	if f.envProject != "api" {
		t.Errorf("project not forwarded: %q", f.envProject)
	}
	for _, want := range []string{"development", "staging", "us-east-1"} {
		if !strings.Contains(buf.String(), want) {
			t.Errorf("env list missing %q:\n%s", want, buf.String())
		}
	}
}

func TestRunProjectEnvListJSON(t *testing.T) {
	var buf bytes.Buffer
	if err := runProjectEnvList(&fakeClient{environments: sampleEnvironments()}, &buf, "json", "api"); err != nil {
		t.Fatalf("json: %v", err)
	}
	var got []api.Environment
	if err := json.Unmarshal(buf.Bytes(), &got); err != nil {
		t.Fatalf("invalid json: %v", err)
	}
	if len(got) != 2 {
		t.Errorf("expected 2 envs, got %d", len(got))
	}
}

func TestRunProjectEnvListEmpty(t *testing.T) {
	var buf bytes.Buffer
	if err := runProjectEnvList(&fakeClient{environments: nil}, &buf, "table", "api"); err != nil {
		t.Fatalf("empty: %v", err)
	}
	if !strings.Contains(buf.String(), "No environments") {
		t.Errorf("expected empty notice: %s", buf.String())
	}
}

func TestRunProjectEnvListError(t *testing.T) {
	var buf bytes.Buffer
	if err := runProjectEnvList(&fakeClient{err: errBoom}, &buf, "table", "api"); err == nil {
		t.Error("expected error propagated")
	}
}

func TestRunProjectEnvAdd(t *testing.T) {
	var buf bytes.Buffer
	f := &fakeClient{}
	if err := runProjectEnvAdd(f, &buf, api.AddEnvironmentParams{Project: "api", Name: "staging", Stage: "staging", Region: "us-east-1"}); err != nil {
		t.Fatalf("runProjectEnvAdd: %v", err)
	}
	if f.addedEnvName != "staging" || f.addedEnvStage != "staging" || f.addedEnvRegion != "us-east-1" {
		t.Errorf("args not recorded: %+v", f)
	}
	if !strings.Contains(buf.String(), "Added environment staging") {
		t.Errorf("expected success line: %s", buf.String())
	}
}

func TestRunProjectEnvAddError(t *testing.T) {
	var buf bytes.Buffer
	if err := runProjectEnvAdd(&fakeClient{err: errBoom}, &buf, api.AddEnvironmentParams{Project: "api", Name: "x", Stage: "development"}); err == nil {
		t.Error("expected error propagated")
	}
}

// --- component kinds ---

func TestRunComponentKinds(t *testing.T) {
	var buf bytes.Buffer
	if err := runComponentKinds(&buf, "table"); err != nil {
		t.Fatalf("runComponentKinds: %v", err)
	}
	for _, want := range []string{"network", "singleton", "databases", "multi"} {
		if !strings.Contains(buf.String(), want) {
			t.Errorf("kinds missing %q:\n%s", want, buf.String())
		}
	}
}

func TestKindRowsCardinality(t *testing.T) {
	rows := kindRows()
	if len(rows) != len(componentKinds) {
		t.Fatalf("expected %d rows, got %d", len(componentKinds), len(rows))
	}
	for _, r := range rows {
		want := "multi"
		if singletonKinds[r[0]] {
			want = "singleton"
		}
		if r[1] != want {
			t.Errorf("kind %s: got cardinality %q want %q", r[0], r[1], want)
		}
	}
}

// --- component list ---

func sampleComponents() []api.Component {
	ci := "ci-9"
	return []api.Component{
		{ID: "c1", Kind: "network", Name: "network", Status: "ACTIVE", CloudIdentityID: nil, Config: map[string]interface{}{"cidr_block": "10.0.0.0/16"}},
		{ID: "c2", Kind: "databases", Name: "main", Status: "", CloudIdentityID: &ci, Config: map[string]interface{}{"engine": "postgres"}},
	}
}

func TestComponentRows(t *testing.T) {
	rows := componentRows(sampleComponents(), ui.FormatTable)
	if rows[0][3] != ui.SymbolDash {
		t.Errorf("inherited identity should be dash: %+v", rows[0])
	}
	if rows[0][2] != "ACTIVE" {
		t.Errorf("unexpected status: %+v", rows[0])
	}
	if rows[1][3] != "ci-9" {
		t.Errorf("explicit identity not shown: %+v", rows[1])
	}
	if rows[1][2] != ui.SymbolDash {
		t.Errorf("empty status should be dash: %+v", rows[1])
	}
}

func TestRunComponentListTable(t *testing.T) {
	var buf bytes.Buffer
	f := &fakeClient{components: sampleComponents()}
	if err := runComponentList(f, &buf, "table", "api", "databases", "prod"); err != nil {
		t.Fatalf("runComponentList: %v", err)
	}
	if f.listCompProj != "api" || f.listCompKind != "databases" || f.listCompEnv != "prod" {
		t.Errorf("filters not forwarded: %+v", f)
	}
	for _, want := range []string{"network", "databases", "main"} {
		if !strings.Contains(buf.String(), want) {
			t.Errorf("component list missing %q:\n%s", want, buf.String())
		}
	}
}

func TestRunComponentListJSON(t *testing.T) {
	var buf bytes.Buffer
	if err := runComponentList(&fakeClient{components: sampleComponents()}, &buf, "json", "api", "", ""); err != nil {
		t.Fatalf("json: %v", err)
	}
	var got []api.Component
	if err := json.Unmarshal(buf.Bytes(), &got); err != nil {
		t.Fatalf("invalid json: %v", err)
	}
	if len(got) != 2 || got[1].Config["engine"] != "postgres" {
		t.Errorf("unexpected components json: %+v", got)
	}
}

func TestRunComponentListEmpty(t *testing.T) {
	var buf bytes.Buffer
	if err := runComponentList(&fakeClient{components: nil}, &buf, "table", "api", "", ""); err != nil {
		t.Fatalf("empty: %v", err)
	}
	if !strings.Contains(buf.String(), "No components") {
		t.Errorf("expected empty notice: %s", buf.String())
	}
}

func TestRunComponentListError(t *testing.T) {
	var buf bytes.Buffer
	if err := runComponentList(&fakeClient{err: errBoom}, &buf, "table", "api", "", ""); err == nil {
		t.Error("expected error propagated")
	}
}

// --- component add ---

func TestParseSetValues(t *testing.T) {
	fields, err := parseSetValues([]string{
		"engine=postgres",
		"port=5432",
		"iam_auth=true",
		"instance_types=[\"t3.medium\",\"t3.large\"]",
	})
	if err != nil {
		t.Fatalf("parseSetValues: %v", err)
	}
	if fields["engine"] != "postgres" {
		t.Errorf("string coercion wrong: %#v", fields["engine"])
	}
	if v, ok := fields["port"].(float64); !ok || v != 5432 {
		t.Errorf("number coercion wrong: %#v", fields["port"])
	}
	if v, ok := fields["iam_auth"].(bool); !ok || !v {
		t.Errorf("bool coercion wrong: %#v", fields["iam_auth"])
	}
	arr, ok := fields["instance_types"].([]interface{})
	if !ok || len(arr) != 2 || arr[0] != "t3.medium" {
		t.Errorf("array coercion wrong: %#v", fields["instance_types"])
	}
}

func TestParseSetValuesInvalid(t *testing.T) {
	if _, err := parseSetValues([]string{"noequalsign"}); err == nil {
		t.Error("expected error for malformed --set")
	}
	if _, err := parseSetValues([]string{"=value"}); err == nil {
		t.Error("expected error for empty key")
	}
}

func TestCoerceSetValue(t *testing.T) {
	if v := coerceSetValue("plain"); v != "plain" {
		t.Errorf("plain string: %#v", v)
	}
	if v := coerceSetValue("null"); v != nil {
		t.Errorf("null: %#v", v)
	}
	if v, ok := coerceSetValue("false").(bool); !ok || v {
		t.Errorf("false: %#v", coerceSetValue("false"))
	}
}

// A JSON-quoted value must decode to its CONTENT, not to the six characters that were typed.
//
// Quoting is the only way to give a string field a value that also parses as a number:
// `--set cluster_version=1.35` coerces to the number 1.35 and the server refuses it, so the
// documented answer is `--set 'cluster_version="1.35"'`. That form used to fall through to the
// raw text and store `"1.35"` WITH the quote marks — length 6, never equal to `1.35` — which
// surfaced far downstream as a compatibility gate calling the version "unset or unparseable".
//
// The axis under test is the VALUE's shape, not the key: a quoted numeric-looking string, a
// quoted ordinary word, and the unquoted forms that must keep their existing types.
func TestCoerceSetValueUnwrapsQuotedStrings(t *testing.T) {
	for _, c := range []struct {
		name string
		raw  string
		want string
	}{
		{"quoted numeric-looking version", `"1.35"`, "1.35"},
		{"quoted version with patch", `"1.33.12"`, "1.33.12"},
		{"quoted ordinary word", `"postgres"`, "postgres"},
		{"quoted string with a space", `"eu central"`, "eu central"},
	} {
		t.Run(c.name, func(t *testing.T) {
			v := coerceSetValue(c.raw)
			s, ok := v.(string)
			if !ok {
				t.Fatalf("coerceSetValue(%s) = %#v, want a string", c.raw, v)
			}
			if s != c.want {
				t.Errorf("coerceSetValue(%s) = %q (len %d), want %q", c.raw, s, len(s), c.want)
			}
		})
	}

	// The other direction: unquoted values must keep the types they already had, or this fix
	// would silently turn every number and bool into text.
	if v, ok := coerceSetValue("1.35").(float64); !ok || v != 1.35 {
		t.Errorf("unquoted 1.35 must stay a number, got %#v", coerceSetValue("1.35"))
	}
	if v, ok := coerceSetValue("true").(bool); !ok || !v {
		t.Errorf("unquoted true must stay a bool, got %#v", coerceSetValue("true"))
	}
	if v, ok := coerceSetValue(`["cx33"]`).([]interface{}); !ok || len(v) != 1 || v[0] != "cx33" {
		t.Errorf(`["cx33"] must stay an array, got %#v`, coerceSetValue(`["cx33"]`))
	}
	// Unquoted text is not JSON at all, so it still comes back as the literal it was typed as.
	if v := coerceSetValue("postgres"); v != "postgres" {
		t.Errorf("bare word must stay literal, got %#v", v)
	}
}

func TestRunComponentAdd(t *testing.T) {
	var buf bytes.Buffer
	f := &fakeClient{}
	fields := map[string]interface{}{"engine": "postgres"}
	if err := runComponentAdd(f, &buf, "api", "databases", "main", "", fields); err != nil {
		t.Fatalf("runComponentAdd: %v", err)
	}
	if f.addCompKind != "databases" || f.addCompName != "main" {
		t.Errorf("args not recorded: %+v", f)
	}
	if !reflect.DeepEqual(f.addCompFields, fields) {
		t.Errorf("fields not forwarded: %+v", f.addCompFields)
	}
	if !strings.Contains(buf.String(), "Added databases component") {
		t.Errorf("expected success line: %s", buf.String())
	}
}

func TestRunComponentAddMissingKind(t *testing.T) {
	var buf bytes.Buffer
	if err := runComponentAdd(&fakeClient{}, &buf, "api", "", "", "", nil); err == nil {
		t.Error("expected error when kind is empty")
	}
}

func TestRunComponentAddError(t *testing.T) {
	var buf bytes.Buffer
	if err := runComponentAdd(&fakeClient{err: errBoom}, &buf, "api", "databases", "main", "", nil); err == nil {
		t.Error("expected error propagated")
	}
}

// --- component remove ---

func TestRunComponentRemoveSingleton(t *testing.T) {
	var buf bytes.Buffer
	f := &fakeClient{}
	// A name is passed but must be cleared for a singleton kind.
	if err := runComponentRemove(f, &buf, "api", "network", "ignored", ""); err != nil {
		t.Fatalf("runComponentRemove: %v", err)
	}
	if f.rmCompName != "" {
		t.Errorf("singleton name should be cleared, got %q", f.rmCompName)
	}
	if f.rmCompKind != "network" {
		t.Errorf("kind not forwarded: %q", f.rmCompKind)
	}
}

func TestRunComponentRemoveNamed(t *testing.T) {
	var buf bytes.Buffer
	f := &fakeClient{}
	if err := runComponentRemove(f, &buf, "api", "databases", "main", ""); err != nil {
		t.Fatalf("runComponentRemove: %v", err)
	}
	if f.rmCompName != "main" {
		t.Errorf("named component name should be kept, got %q", f.rmCompName)
	}
	if !strings.Contains(buf.String(), "Component removed") {
		t.Errorf("expected success line: %s", buf.String())
	}
}

func TestRunComponentRemoveError(t *testing.T) {
	var buf bytes.Buffer
	if err := runComponentRemove(&fakeClient{err: errBoom}, &buf, "api", "databases", "main", ""); err == nil {
		t.Error("expected error propagated")
	}
}

// --- currentProject ---

func TestCurrentProject(t *testing.T) {
	c := &cobra.Command{Use: "x"}
	c.Flags().String("project", "", "")
	if _, err := currentProject(c); err == nil {
		t.Error("expected error when --project unset")
	}
	if err := c.Flags().Set("project", "api"); err != nil {
		t.Fatalf("set flag: %v", err)
	}
	got, err := currentProject(c)
	if err != nil || got != "api" {
		t.Errorf("currentProject = %q, %v", got, err)
	}
}

// --- per-environment component authoring (the two-tier demo) ---

// TestComponentEnvIsThreadedThrough is the CLI half of the change that made a two-environment
// project buildable from the terminal. `--env` used to exist on `list` alone, labelled "(reserved)",
// and the server discarded it — so every component the CLI authored landed in the project's default
// environment and a dev/staging pair pointing at different overlays was unexpressable.
func TestComponentEnvIsThreadedThrough(t *testing.T) {
	t.Run("add forwards the environment", func(t *testing.T) {
		var buf bytes.Buffer
		f := &fakeClient{}
		if err := runComponentAdd(f, &buf, "api", "repositories", "", "staging", map[string]interface{}{"apps_path": "overlays/staging"}); err != nil {
			t.Fatalf("runComponentAdd: %v", err)
		}
		if f.addCompEnv != "staging" {
			t.Errorf("env not forwarded: %q", f.addCompEnv)
		}
		// The environment belongs in the confirmation: authoring the same kind into the wrong tier is
		// otherwise silent, and the next thing to read it is a deploy.
		if !strings.Contains(buf.String(), "in staging") {
			t.Errorf("confirmation omits the environment: %q", buf.String())
		}
	})

	t.Run("remove forwards the environment", func(t *testing.T) {
		var buf bytes.Buffer
		f := &fakeClient{}
		if err := runComponentRemove(f, &buf, "api", "cluster", "", "dev"); err != nil {
			t.Fatalf("runComponentRemove: %v", err)
		}
		if f.rmCompEnv != "dev" {
			t.Errorf("env not forwarded: %q", f.rmCompEnv)
		}
		if !strings.Contains(buf.String(), "in dev") {
			t.Errorf("confirmation omits the environment: %q", buf.String())
		}
	})

	t.Run("list forwards the environment", func(t *testing.T) {
		var buf bytes.Buffer
		f := &fakeClient{components: sampleComponents()}
		if err := runComponentList(f, &buf, "json", "api", "", "dev"); err != nil {
			t.Fatalf("runComponentList: %v", err)
		}
		if f.listCompEnv != "dev" {
			t.Errorf("env not forwarded: %q", f.listCompEnv)
		}
	})

	// An empty environment must stay empty all the way to the client, because that is what selects
	// the server's default-environment path. Substituting anything here would silently retarget every
	// existing single-environment script.
	t.Run("empty stays empty", func(t *testing.T) {
		var buf bytes.Buffer
		f := &fakeClient{}
		if err := runComponentAdd(f, &buf, "api", "cluster", "", "", nil); err != nil {
			t.Fatalf("runComponentAdd: %v", err)
		}
		if f.addCompEnv != "" {
			t.Errorf("empty env became %q", f.addCompEnv)
		}
		if strings.Contains(buf.String(), " in ") {
			t.Errorf("confirmation invented an environment: %q", buf.String())
		}
	})
}

// --- placement (#844 from the terminal) ---

// TestParseEnvMatrix pins the parser that turns `--env name:stage[:mode[:namespace]]` into the
// environment matrix. The matrix is what makes a two-tier project cost ONE cluster: without it the
// server keeps the legacy shape and every environment the CLI creates comes out `dedicated`.
func TestParseEnvMatrix(t *testing.T) {
	t.Run("no flags means no matrix", func(t *testing.T) {
		got, err := parseEnvMatrix(nil)
		if err != nil || got != nil {
			t.Fatalf("want (nil, nil) so the server keeps its legacy shape, got (%#v, %v)", got, err)
		}
	})

	t.Run("the enterprise-demo shape", func(t *testing.T) {
		got, err := parseEnvMatrix([]string{
			"prod:production",
			"dev:development:namespace:boutique-dev",
			"staging:staging:vcluster",
		})
		if err != nil {
			t.Fatalf("parseEnvMatrix: %v", err)
		}
		want := []api.EnvironmentSpec{
			// First entry OWNS the Fabric, so it defaults to dedicated and is the default env.
			{Name: "prod", Stage: "production", PlacementMode: "dedicated", IsDefault: true},
			{Name: "dev", Stage: "development", PlacementMode: "namespace", Namespace: "boutique-dev"},
			{Name: "staging", Stage: "staging", PlacementMode: "vcluster"},
		}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("matrix mismatch:\n got %#v\nwant %#v", got, want)
		}
	})

	t.Run("a later entry defaults to the cheap rung", func(t *testing.T) {
		got, err := parseEnvMatrix([]string{"prod:production", "preview:development"})
		if err != nil {
			t.Fatalf("parseEnvMatrix: %v", err)
		}
		if got[1].PlacementMode != "namespace" {
			t.Errorf("second entry should default to namespace, got %q", got[1].PlacementMode)
		}
		if got[1].IsDefault {
			t.Error("only the first entry may be the default")
		}
	})

	t.Run("an explicit mode overrides the positional default", func(t *testing.T) {
		got, err := parseEnvMatrix([]string{"prod:production:namespace"})
		if err != nil {
			t.Fatalf("parseEnvMatrix: %v", err)
		}
		if got[0].PlacementMode != "namespace" {
			t.Errorf("explicit mode ignored: %q", got[0].PlacementMode)
		}
	})

	for _, bad := range []struct{ name, in string }{
		{"no stage", "prod"},
		{"empty name", ":production"},
		{"empty stage", "prod:"},
		{"too many segments", "a:b:c:d:e"},
	} {
		t.Run("rejects "+bad.name, func(t *testing.T) {
			if _, err := parseEnvMatrix([]string{bad.in}); err == nil {
				t.Errorf("parseEnvMatrix(%q) should error", bad.in)
			}
		})
	}

	t.Run("rejects a duplicate name", func(t *testing.T) {
		if _, err := parseEnvMatrix([]string{"dev:development", "dev:staging"}); err == nil {
			t.Error("a duplicate environment name must be rejected here, not by a unique violation")
		}
	})
}

func TestEnvSuffix(t *testing.T) {
	if got := envSuffix(""); got != "" {
		t.Errorf(`envSuffix("") = %q, want ""`, got)
	}
	if got := envSuffix("prod"); got != " in prod" {
		t.Errorf(`envSuffix("prod") = %q`, got)
	}
}

func TestCurrentComponentEnv(t *testing.T) {
	cmd := &cobra.Command{}
	// No such flag registered → empty, never a panic.
	if got := currentComponentEnv(cmd); got != "" {
		t.Errorf("missing flag should yield empty, got %q", got)
	}
	cmd.Flags().String("env", "", "")
	if got := currentComponentEnv(cmd); got != "" {
		t.Errorf("unset flag should yield empty, got %q", got)
	}
	if err := cmd.Flags().Set("env", "  staging  "); err != nil {
		t.Fatalf("set: %v", err)
	}
	if got := currentComponentEnv(cmd); got != "staging" {
		t.Errorf("expected trimmed %q, got %q", "staging", got)
	}
}

// TestProjectEnvAddCarriesPlacement is the other half: `project env add` used to send no placement at
// all, and project_environments.placement_mode DEFAULTS to `dedicated` — so adding an environment
// silently provisioned a whole new cluster with its own state key.
func TestProjectEnvAddCarriesPlacement(t *testing.T) {
	var buf bytes.Buffer
	f := &fakeClient{}
	params := api.AddEnvironmentParams{
		Project:   "shop",
		Name:      "staging",
		Stage:     "staging",
		Placement: "vcluster",
		Fabric:    "shared",
		Namespace: "boutique-staging",
		Lifecycle: "persistent",
	}
	if err := runProjectEnvAdd(f, &buf, params); err != nil {
		t.Fatalf("runProjectEnvAdd: %v", err)
	}
	if !reflect.DeepEqual(f.addedEnvParams, params) {
		t.Errorf("placement fields dropped:\n got %#v\nwant %#v", f.addedEnvParams, params)
	}
	// The placement is the field with a cost, so it belongs in the confirmation.
	if !strings.Contains(buf.String(), "vcluster placement") {
		t.Errorf("confirmation omits the placement: %q", buf.String())
	}
}

// And when no placement is passed the confirmation must name the server's default rather than an
// empty string — a caller reading "( , placement)" learns nothing about what they just bought.
func TestProjectEnvAddNamesTheDefaultPlacement(t *testing.T) {
	var buf bytes.Buffer
	if err := runProjectEnvAdd(&fakeClient{}, &buf, api.AddEnvironmentParams{Project: "p", Name: "e"}); err != nil {
		t.Fatalf("runProjectEnvAdd: %v", err)
	}
	if !strings.Contains(buf.String(), "namespace placement") {
		t.Errorf("confirmation should name the default placement: %q", buf.String())
	}
}
