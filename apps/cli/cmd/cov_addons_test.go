// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/huh"
	"github.com/spf13/cobra"
	"github.com/spf13/pflag"
)

// The addon/agent noun group of the CLI programme (#3710).
//
// Two things this file asserts are worth naming before the code:
//
//   - An add-on id is not just a lookup key. The runner renders one ArgoCD Application PER
//     catalog id, so an id the CLI "tidies" on the way through does not merely miss a row — on
//     enable it writes a different Application into a live cluster, and on disable it removes the
//     record for an add-on nobody named. The pass-through is asserted byte for byte, and the
//     resolver is asserted to make NO listing call when an id was given.
//   - A resolved target must be announced BEFORE the confirmation. "Disable this add-on?" is not
//     a question anyone can answer about a target the CLI picked silently.

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

// addonFakeLister is the add-on half of the API client, counting calls so a test can assert that
// a resolution made NO round trip.
type addonFakeLister struct {
	view  *api.ProjectAddons
	err   error
	calls int
	// project and env record what the resolver addressed, so a picker that listed the wrong
	// environment is a failure rather than a coincidence.
	project string
	env     string
}

func (f *addonFakeLister) GetProjectAddons(project, env string) (*api.ProjectAddons, error) {
	f.calls++
	f.project, f.env = project, env
	return f.view, f.err
}

// agentFakeLister is the agent half of the API client, counting calls for the same reason.
type agentFakeLister struct {
	agents []api.Agent
	err    error
	calls  int
}

func (f *agentFakeLister) ListAgents() ([]api.Agent, error) {
	f.calls++
	return f.agents, f.err
}

// addonTestView builds a ProjectAddons with three installed add-ons, each differing in the fields
// the picker label and the table render.
func addonTestView() *api.ProjectAddons {
	v1, v2 := "2.9.1", "1.22.0"
	synced, drifted := "Synced", "OutOfSync"
	healthy := "Healthy"
	at := "2026-03-09T15:04:05Z"
	return &api.ProjectAddons{
		Environment: "production",
		Addons: []api.Addon{
			{AddonID: "loki", Enabled: true, Mode: "managed", Version: &v1, Status: "READY", Sync: &synced, Health: &healthy, LastSyncedAt: &at},
			{AddonID: "cnpg", Enabled: true, Mode: "gitops", Version: &v2, Status: "READY", Sync: &drifted},
			{AddonID: "falco", Enabled: false, Mode: "managed", Status: "PENDING"},
		},
	}
}

// addonFormInteractive makes BOTH stdin and stdout look like terminals.
//
// authFormInteractive sets stdin alone, which is enough for requireInteractive but not for
// requireInteractiveForm — the picker draws on stdout, and #3696's group refuses to open a form
// it cannot render. Reusing the stdin-only helper here would take the refusal arm and every
// picker assertion below would be testing the refusal.
func addonFormInteractive(t *testing.T) {
	t.Helper()
	authFormInteractive(t)
	prevOut := stdoutIsTTY
	stdoutIsTTY = func() bool { return true }
	t.Cleanup(func() { stdoutIsTTY = prevOut })
}

// addonCaptureStderr runs fn with os.Stderr replaced by a pipe and returns what was written.
func addonCaptureStderr(t *testing.T, fn func()) string {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("pipe: %v", err)
	}
	prev := os.Stderr
	os.Stderr = w
	done := make(chan string, 1)
	go func() {
		var buf bytes.Buffer
		_, _ = io.Copy(&buf, r)
		done <- buf.String()
	}()
	fn()
	os.Stderr = prev
	_ = w.Close()
	out := <-done
	_ = r.Close()
	return out
}

// ---------------------------------------------------------------------------
// The add-on id is a lookup key AND an ArgoCD Application name
// ---------------------------------------------------------------------------

// TestAddonSelect_IdIsPassedThroughUntouched is the assertion that matters most in this file.
//
// The id addresses the project_addons row, and the runner names the ArgoCD Application after it.
// A resolver that trimmed, lower-cased, truncated or slugified one would silently act on a
// different Application in a live cluster. So: byte for byte, and no listing call is even made.
func TestAddonSelect_IdIsPassedThroughUntouched(t *testing.T) {
	addonFormInteractive(t)
	for _, id := range []string{
		"kube-prometheus-stack",
		"KubePrometheusStack", // mixed case is not "tidied" to lower
		"cnpg",
		"external-dns",
		"vault_2",
		"a", // a one-character id must not be padded or rejected
	} {
		t.Run(id, func(t *testing.T) {
			lister := &addonFakeLister{view: addonTestView()}
			ref, err := resolveAddonID(lister, []string{id}, "web", "production", addonDisablePrompt)
			if err != nil {
				t.Fatalf("resolveAddonID(%q): %v", id, err)
			}
			if ref.ID != id {
				t.Errorf("id = %q, want %q byte for byte — this string becomes an ArgoCD "+
					"Application name, so a normalised one acts on a different object", ref.ID, id)
			}
			if ref.Summary != "" {
				t.Errorf("Summary = %q; an id the caller typed must not be announced back at them", ref.Summary)
			}
			if lister.calls != 0 {
				t.Errorf("the control plane was listed %d time(s) for an id that was already given", lister.calls)
			}
		})
	}
}

// TestResolveAddonID_RefusesBeforeAnyCallWhenItCannotAsk covers both ways the picker is
// unavailable, and asserts the refusal costs no round trip.
//
// Both arms, because they are different conditions with different fixes: --no-input is a choice the
// caller made, and having nowhere to draw is not.
//
// "Nowhere to draw" means the stream a huh form actually draws on, which is NOT stdout. This arm
// used to stub stdoutIsTTY, and its reason was that `alethia addon disable -p web > out.txt` would
// otherwise paint the form's ANSI frames into the file. That reason no longer holds: forms and
// spinners now draw on ui.InteractiveOutput(), so a redirected stdout leaves them on the terminal
// where the person is. Refusing on stdout would now refuse a question it can perfectly well ask.
//
// The third case is the control for exactly that, and it is the one that would have caught this
// silently: with stdout redirected and the form stream still a terminal the picker must NOT
// short-circuit — it must get past the gate and do its round trip. Without it, re-pointing the stub
// above would look identical to deleting the arm.
func TestResolveAddonID_RefusesBeforeAnyCallWhenItCannotAsk(t *testing.T) {
	cases := []struct {
		name    string
		arrange func(t *testing.T)
		wantIn  string
	}{
		{"--no-input", func(t *testing.T) {
			addonFormInteractive(t)
			hygCliConfirmSetNoInput(t, true)
		}, errNoInput.Error()},
		{"the stream a form draws on is not a terminal", func(t *testing.T) {
			addonFormInteractive(t)
			withInteractiveOutputRedirected(t)
		}, errNoTTY.Error()},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			tc.arrange(t)
			lister := &addonFakeLister{view: addonTestView()}
			ref, err := resolveAddonID(lister, nil, "web", "production", addonDisablePrompt)
			if !errors.Is(err, errAddonIDRequired) {
				t.Fatalf("err = %v; want errAddonIDRequired", err)
			}
			if !strings.Contains(err.Error(), tc.wantIn) {
				t.Errorf("the refusal must say WHY it could not ask; got %q, want it to carry %q",
					err.Error(), tc.wantIn)
			}
			if ref.ID != "" {
				t.Errorf("id = %q; a refusal must not also resolve", ref.ID)
			}
			if lister.calls != 0 {
				t.Errorf("the control plane was called %d time(s) for a refusal whose answer does "+
					"not depend on it", lister.calls)
			}
		})
	}
}

// TestResolveAddonID_RedirectedStdoutStillAsks is the control for the arm above.
//
// stdout redirected, the form stream still a terminal: the picker must get PAST the gate. If it
// refuses here the gate has been re-pointed at the wrong stream, and the refusal arm above would
// still pass — which is what makes this the assertion that carries the change.
func TestResolveAddonID_RedirectedStdoutStillAsks(t *testing.T) {
	addonFormInteractive(t)
	prev := stdoutIsTTY
	stdoutIsTTY = func() bool { return false }
	t.Cleanup(func() { stdoutIsTTY = prev })

	lister := &addonFakeLister{view: addonTestView()}
	_, err := resolveAddonID(lister, nil, "web", "production", addonDisablePrompt)
	if errors.Is(err, errAddonIDRequired) {
		t.Fatalf("err = %v; a redirected stdout must no longer refuse — the form draws on "+
			"ui.InteractiveOutput(), which is still a terminal here", err)
	}
	if lister.calls != 1 {
		t.Errorf("the control plane was listed %d time(s); the picker must reach it to ask",
			lister.calls)
	}
}

// TestResolveAddonID_EmptyEnvironmentSaysWhatToDoNext pins the difference between the two
// commands' empty states.
//
// `disable` on an empty environment is finished. `enable` is not — the operator wanted to install
// something, and the catalog id for an add-on nobody has enabled yet is the ONE handoff this lane
// could not remove, because the CLI has no endpoint that enumerates the marketplace. Saying so is
// the difference between a dead end and a next step.
func TestResolveAddonID_EmptyEnvironmentSaysWhatToDoNext(t *testing.T) {
	addonFormInteractive(t)
	for _, tc := range []struct {
		name   string
		prompt addonPickPrompt
		want   []string
		absent []string
	}{
		{"enable", addonEnablePrompt, []string{"catalog id", "console"}, nil},
		{"disable", addonDisablePrompt, []string{"nothing to disable"}, []string{"console"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			lister := &addonFakeLister{view: &api.ProjectAddons{Environment: "production"}}
			_, err := resolveAddonID(lister, nil, "web", "production", tc.prompt)
			if err == nil {
				t.Fatal("an empty environment must be an error, not a picker over nothing")
			}
			for _, want := range tc.want {
				if !strings.Contains(err.Error(), want) {
					t.Errorf("message %q does not name %q", err.Error(), want)
				}
			}
			for _, absent := range tc.absent {
				if strings.Contains(err.Error(), absent) {
					t.Errorf("message %q sends the reader to %q, which is not the next step here",
						err.Error(), absent)
				}
			}
			if lister.calls != 1 {
				t.Errorf("GetProjectAddons called %d times, want exactly 1", lister.calls)
			}
			if lister.project != "web" || lister.env != "production" {
				t.Errorf("listed (%q, %q); the picker must address the environment the command was "+
					"pointed at", lister.project, lister.env)
			}
		})
	}
}

// TestResolveAddonID_PickerBindsTheChosenAddon drives the REAL huh Select the production code
// builds and reads back what the resolver returned.
//
// Two presses down and enter is the THIRD add-on. Asserting that specific id — rather than "not
// empty" — is what catches a Select bound to the label, or an option list built in one order and
// indexed in another. The picker's option VALUE is the index, and the mapping back to an id is
// the thing that has to be right.
func TestResolveAddonID_PickerBindsTheChosenAddon(t *testing.T) {
	addonFormInteractive(t)
	scripts := authFormAnswer(t, &authFormScript{
		keys: authFormKey(nil, tea.KeyDown, tea.KeyDown, tea.KeyEnter),
	})
	lister := &addonFakeLister{view: addonTestView()}

	ref, err := resolveAddonID(lister, nil, "web", "production", addonDisablePrompt)
	if err != nil {
		t.Fatalf("resolveAddonID: %v", err)
	}
	if !scripts[0].ran {
		t.Fatal("no picker was opened, so `addon disable` with no id still refuses on a terminal")
	}
	if ref.ID != "falco" {
		t.Errorf("id = %q, want \"falco\" — the third option after two presses down", ref.ID)
	}
	if !strings.Contains(ref.Summary, "falco") {
		t.Errorf("Summary = %q, want the chosen add-on's label so the caller can announce it", ref.Summary)
	}
}

// TestResolveAddonID_ListerErrorPropagates: a transport failure must not be reported as "no
// add-ons installed", which reads as a finished environment.
func TestResolveAddonID_ListerErrorPropagates(t *testing.T) {
	addonFormInteractive(t)
	lister := &addonFakeLister{err: errors.New("boom")}
	_, err := resolveAddonID(lister, nil, "web", "", addonDisablePrompt)
	if err == nil || !strings.Contains(err.Error(), "boom") {
		t.Fatalf("err = %v; want the transport error to reach the caller", err)
	}
}

// TestAddonOptionLabel_RendersThroughTheSharedSentinel pins that the picker and the table agree
// about "nothing to show" — the defect #3696 was about, one directory down.
func TestAddonOptionLabel_RendersThroughTheSharedSentinel(t *testing.T) {
	got := addonOptionLabel(api.Addon{AddonID: "falco"})
	if !strings.HasPrefix(got, "falco") {
		t.Errorf("label %q must lead with the add-on id", got)
	}
	if n := strings.Count(got, ui.SymbolDash); n != 3 {
		t.Errorf("label %q renders %d empty-value sentinels, want 3 (mode, version, sync) — a "+
			"local dash or an empty cell is how the sentinel got three spellings", got, n)
	}
	full := addonOptionLabel(addonTestView().Addons[0])
	for _, want := range []string{"loki", "managed", "2.9.1", "Synced"} {
		if !strings.Contains(full, want) {
			t.Errorf("label %q is missing %q", full, want)
		}
	}
}

// ---------------------------------------------------------------------------
// --mode: the vocabulary comes from the generated enum
// ---------------------------------------------------------------------------

// TestAddonModeValues_AreTheGeneratedEnum pins that the CLI's vocabulary IS the drizzle enum's
// mirror and not a list typed beside it.
//
// The comparison is against types.AllAddonModes — the generated file, diff-gated in CI against
// lib/db/schema/enums.ts — so a mode added to the schema, generated, and then not adopted here
// fails. A count floor would pass with every value replaced by a wrong one, so this asserts the
// terms.
func TestAddonModeValues_AreTheGeneratedEnum(t *testing.T) {
	got := addonModeValues()
	if len(got) == 0 || len(types.AllAddonModes) == 0 {
		t.Fatal("the generated addon_mode enum is empty — every assertion below is vacuous")
	}
	if len(got) != len(types.AllAddonModes) {
		t.Fatalf("addonModeValues has %d values, the generated enum has %d", len(got), len(types.AllAddonModes))
	}
	for i, want := range types.AllAddonModes {
		if got[i] != string(want) {
			t.Errorf("addonModeValues[%d] = %q, want %q (schema order)", i, got[i], want)
		}
	}
	// The other direction: the flag's help must SAY WHAT EACH MODE DOES.
	//
	// This asserted `strings.Contains(usage, m)` and could not fail. The usage string is built as
	// `"Delivery mode (" + strings.Join(addonModeValues(), ", ") + "): …"`, so every value in `got`
	// is in it BY CONSTRUCTION — the assertion re-derived its expectation from the thing it was
	// checking, and a third mode added to the schema joined the list, joined the assertion, and
	// passed. Measured, not reasoned: adding `AddonModeFlux` to the generated enum leaves this
	// whole test green with `flux` offered and explained by nobody.
	//
	// What actually decays is the HAND-WRITTEN half after the colon, and that is what is asserted
	// here — over the segment past the generated list, so the tautology cannot creep back by
	// widening the haystack.
	usage := addonEnableCmd.Flags().Lookup("mode").Usage
	listed := "(" + strings.Join(got, ", ") + ")"
	at := strings.Index(usage, listed)
	if at < 0 {
		t.Fatalf("--mode help %q no longer offers the enum's list %q; the assertion below is "+
			"about the OTHER half and would be measuring the whole string", usage, listed)
	}
	explained := usage[at+len(listed):]
	for _, m := range got {
		if !strings.Contains(explained, m+" =") {
			t.Errorf("--mode help does not say what %q DOES — %q explains only %q. A mode added to "+
				"the schema joins the generated list for free; the sentence a person reads is "+
				"typed by hand and is what stops covering.", m, usage, explained)
		}
	}
}

// TestCanonicalAddonMode_FoldsCaseAndRefusesByName covers the three arms: unset, a value the enum
// holds under any case, and a value it does not.
func TestCanonicalAddonMode_FoldsCaseAndRefusesByName(t *testing.T) {
	for _, tc := range []struct {
		in      string
		want    string
		wantErr bool
	}{
		{"", "", false},
		{"managed", "managed", false},
		{"MANAGED", "managed", false},
		{"GitOps", "gitops", false},
		{"gitops", "gitops", false},
		{"helm", "", true},
		{"manage", "", true}, // a prefix is not a match
	} {
		t.Run(tc.in, func(t *testing.T) {
			got, err := canonicalAddonMode(tc.in)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("canonicalAddonMode(%q) = %q, want a refusal", tc.in, got)
				}
				if !strings.Contains(err.Error(), tc.in) {
					t.Errorf("the refusal must quote what was passed; got %v", err)
				}
				for _, m := range addonModeValues() {
					if !strings.Contains(err.Error(), m) {
						t.Errorf("the refusal must list every allowed value; %v omits %q", err, m)
					}
				}
				if got != "" {
					t.Errorf("a refusal returned %q as well as an error", got)
				}
				return
			}
			if err != nil {
				t.Fatalf("canonicalAddonMode(%q): %v", tc.in, err)
			}
			if got != tc.want {
				t.Errorf("canonicalAddonMode(%q) = %q, want %q — the value sent must be one the "+
					"enum contains, never the caller's spelling", tc.in, got, tc.want)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

// TestAddonRows_EveryColumnHasACellAndSyncIsOneOfThem.
//
// The Sync assertion is the point. `sync` and `last_synced_at` came over the wire from the day
// the endpoint was written and the table rendered neither, so an add-on ArgoCD had never applied
// showed a Status and a Health and looked installed.
func TestAddonRows_EveryColumnHasACellAndSyncIsOneOfThem(t *testing.T) {
	sync := indexOf(addonColumns, "Sync")
	last := indexOf(addonColumns, "Last synced")
	if sync < 0 || last < 0 {
		t.Fatalf("addonColumns %v has no Sync/Last synced column — the signal an operator reads "+
			"first is not rendered", addonColumns)
	}
	rows := addonRows(addonTestView().Addons, ui.FormatTable)
	if len(rows) != 3 {
		t.Fatalf("addonRows produced %d rows for 3 add-ons", len(rows))
	}
	for i, row := range rows {
		if len(row) != len(addonColumns) {
			t.Fatalf("row %d has %d cells for %d columns — a header and its cells that disagree "+
				"put every value under the wrong heading", i, len(row), len(addonColumns))
		}
	}
	if rows[1][sync] != "OutOfSync" {
		t.Errorf("row 1 Sync = %q, want %q", rows[1][sync], "OutOfSync")
	}
	// "never" and not the dash: an add-on that has never synced is a different statement from one
	// whose timestamp we failed to read, and it is the one that explains a stuck Application.
	if rows[2][last] != "never" {
		t.Errorf("an add-on with no last_synced_at renders %q, want \"never\"", rows[2][last])
	}
	if rows[0][sync] != "Synced" {
		t.Errorf("row 0 Sync = %q, want %q", rows[0][sync], "Synced")
	}
}

// TestRunAddonList_TableCarriesTheSyncSignal drives the rendered output, not just the row
// builder: a column added to addonColumns and dropped by the renderer would still pass above.
func TestRunAddonList_TableCarriesTheSyncSignal(t *testing.T) {
	c := &fakeClient{addons: addonTestView()}
	var buf bytes.Buffer
	if err := runAddonList(c, &buf, ui.FormatTable, "web", "production"); err != nil {
		t.Fatalf("runAddonList: %v", err)
	}
	out := buf.String()
	for _, want := range []string{"Sync", "OutOfSync", "never"} {
		if !strings.Contains(out, want) {
			t.Errorf("rendered table is missing %q:\n%s", want, out)
		}
	}
}

// indexOf returns the position of s in xs, or -1.
func indexOf(xs []string, s string) int {
	for i, x := range xs {
		if x == s {
			return i
		}
	}
	return -1
}

// ---------------------------------------------------------------------------
// Announcing what the CLI chose
// ---------------------------------------------------------------------------

// TestAnnounceResolvedAddon_OnlyWhenTheCLIChose_AndOnStderr.
//
// Stderr, because `addon list -o json | jq` and `addon disable -o json` are things people run: a
// diagnostic on stdout lands inside the document and breaks the parse. Silent for a named id,
// because describing an id back at the person who typed it is noise.
func TestAnnounceResolvedAddon_OnlyWhenTheCLIChose_AndOnStderr(t *testing.T) {
	resolved := addonRef{ID: "falco", Summary: "falco · managed · — · —"}
	got := addonCaptureStderr(t, func() { announceResolvedAddon(resolved, "disabling") })
	if !strings.Contains(got, "falco") || !strings.Contains(got, "disabling") {
		t.Errorf("stderr = %q, want the verb and the resolved add-on", got)
	}

	quiet := addonCaptureStderr(t, func() { announceResolvedAddon(addonRef{ID: "falco"}, "disabling") })
	if strings.TrimSpace(quiet) != "" {
		t.Errorf("stderr = %q; an id the caller typed must not be echoed back", quiet)
	}

	agentLine := addonCaptureStderr(t, func() {
		announceResolvedAgent(agentRef{ID: "ag-1", Summary: "reviewer · mem/one · ag-1"})
	})
	if !strings.Contains(agentLine, "reviewer") {
		t.Errorf("agent stderr = %q, want the resolved identity", agentLine)
	}
	agentQuiet := addonCaptureStderr(t, func() { announceResolvedAgent(agentRef{ID: "ag-1"}) })
	if strings.TrimSpace(agentQuiet) != "" {
		t.Errorf("agent stderr = %q; a named id must not be echoed back", agentQuiet)
	}
}

// ---------------------------------------------------------------------------
// The agent group
// ---------------------------------------------------------------------------

// TestAgentSelect_IdIsPassedThroughUntouched: `GET /cli/agents/<id>` addresses the record by the
// id, so it goes through byte for byte and no listing call is made.
func TestAgentSelect_IdIsPassedThroughUntouched(t *testing.T) {
	addonFormInteractive(t)
	for _, id := range []string{"ag_01J8Z9QK3F", "AG-Mixed-Case", "9f8b1c2d-3e4f-5a6b-7c8d-9e0f1a2b3c4d"} {
		t.Run(id, func(t *testing.T) {
			lister := &agentFakeLister{agents: []api.Agent{{ID: "other"}}}
			ref, err := resolveAgentID(lister, []string{id})
			if err != nil {
				t.Fatalf("resolveAgentID(%q): %v", id, err)
			}
			if ref.ID != id {
				t.Errorf("id = %q, want %q byte for byte", ref.ID, id)
			}
			if lister.calls != 0 {
				t.Errorf("the control plane was listed %d time(s) for an id already given", lister.calls)
			}
		})
	}
}

// TestResolveAgentID_RefusesBeforeAnyCallWhenItCannotAsk.
func TestResolveAgentID_RefusesBeforeAnyCallWhenItCannotAsk(t *testing.T) {
	addonFormInteractive(t)
	hygCliConfirmSetNoInput(t, true)
	lister := &agentFakeLister{agents: []api.Agent{{ID: "ag-1"}}}
	ref, err := resolveAgentID(lister, nil)
	if !errors.Is(err, errAgentIDRequired) {
		t.Fatalf("err = %v; want errAgentIDRequired", err)
	}
	if ref.ID != "" || lister.calls != 0 {
		t.Errorf("refusal returned id %q after %d call(s); want neither", ref.ID, lister.calls)
	}
}

// TestResolveAgentID_PickerBindsTheChosenIdentity drives the real Select: one press down is the
// SECOND identity, and asserting that id is what catches a Select bound to the label.
func TestResolveAgentID_PickerBindsTheChosenIdentity(t *testing.T) {
	addonFormInteractive(t)
	scripts := authFormAnswer(t, &authFormScript{keys: authFormKey(nil, tea.KeyDown, tea.KeyEnter)})
	lister := &agentFakeLister{agents: []api.Agent{
		{ID: "ag-1", Persona: "provisioner", MemoryNamespace: "mem/one"},
		{ID: "ag-2", Persona: "reviewer", MemoryNamespace: "mem/two"},
	}}
	ref, err := resolveAgentID(lister, nil)
	if err != nil {
		t.Fatalf("resolveAgentID: %v", err)
	}
	if !scripts[0].ran {
		t.Fatal("no picker was opened, so `agent get` with no id still refuses on a terminal")
	}
	if ref.ID != "ag-2" {
		t.Errorf("id = %q, want \"ag-2\" — the second option after one press down", ref.ID)
	}
	if !strings.Contains(ref.Summary, "reviewer") {
		t.Errorf("Summary = %q, want the chosen identity's label", ref.Summary)
	}
}

// TestResolveAgentID_NoIdentitiesIsAnError: a picker over nothing is not a question.
func TestResolveAgentID_NoIdentitiesIsAnError(t *testing.T) {
	addonFormInteractive(t)
	_, err := resolveAgentID(&agentFakeLister{}, nil)
	if err == nil || !strings.Contains(err.Error(), "no agent identities") {
		t.Fatalf("err = %v; want an error naming the empty list", err)
	}
}

// TestRunAgentGet_CardCarriesProjectAndCreated pins the two fields that arrived over the wire and
// were rendered nowhere. An identity scoped to a project answers a different question from an
// org-wide one, and it was visible only under -o json.
func TestRunAgentGet_CardCarriesProjectAndCreated(t *testing.T) {
	proj := "p-42"
	c := &fakeClient{agent: &api.Agent{
		ID: "ag-1", Persona: "provisioner", Mission: "keep infra healthy",
		ToolScope: []string{"plan"}, MemoryNamespace: "mem/one", ProjectID: &proj,
		CreatedAt: "2026-03-09T15:04:05Z", Version: 3,
	}}
	var buf bytes.Buffer
	if err := runAgentGet(c, &buf, ui.FormatTable, "ag-1"); err != nil {
		t.Fatalf("runAgentGet: %v", err)
	}
	out := buf.String()
	for _, want := range []string{"project", "p-42", "created"} {
		if !strings.Contains(out, want) {
			t.Errorf("card is missing %q:\n%s", want, out)
		}
	}

	// An org-wide identity renders the shared sentinel, not an empty cell that reads as a
	// rendering bug.
	c2 := &fakeClient{agent: &api.Agent{ID: "ag-2", Persona: "reviewer", MemoryNamespace: "mem/two"}}
	var buf2 bytes.Buffer
	if err := runAgentGet(c2, &buf2, ui.FormatTable, "ag-2"); err != nil {
		t.Fatalf("runAgentGet: %v", err)
	}
	if !strings.Contains(buf2.String(), ui.SymbolDash) {
		t.Errorf("an identity with no project must render the shared dash:\n%s", buf2.String())
	}
}

// ---------------------------------------------------------------------------
// The commands, end to end
// ---------------------------------------------------------------------------

// TestAddonGroup_NoLeafDemandsACopiedId is the handoff assertion, derived rather than typed.
//
// Every leaf in the addon and agent groups that takes an id positionally must ACCEPT ZERO
// arguments — that is what "the id has another source" means at the cobra level. A leaf that goes
// back to cobra.ExactArgs(1) is a command whose only way in is a token copied out of another
// command's output, which is the thing this programme is measured on removing.
func TestAddonGroup_NoLeafDemandsACopiedId(t *testing.T) {
	checked := 0
	for _, root := range []*cobra.Command{addonCmd, agentCmd} {
		for _, leaf := range walkLeaves(root) {
			checked++
			if err := leaf.ValidateArgs(nil); err != nil {
				t.Errorf("%s refuses to run with no arguments (%v) — an id it can only be given "+
					"is an id somebody has to copy", leaf.CommandPath(), err)
			}
		}
	}
	if checked < 5 {
		t.Fatalf("walked only %d leaves across the addon and agent groups; there are 5 "+
			"(list/enable/disable, list/get), so this walk is not seeing the tree", checked)
	}
}

// addonServe stands up a control plane that actually holds add-ons, over the credentials and
// exit-trap hygCliConfirmEnv already arranges.
//
// hygCliConfirmEnv's own handler answers `{"ok": true}` to everything, which decodes to a
// ProjectAddons with ZERO add-ons — so a picker driven against it takes the empty-environment arm
// and the ordering assertion below would pass while never reaching the confirmation. Serving a
// real view is what makes the resolution happen.
func addonServe(t *testing.T) (*hygCliConfirmServer, *addonBodies, func(args ...string) int) {
	t.Helper()
	rec, run := hygCliConfirmEnv(t)
	bodies := &addonBodies{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rec.record(r)
		if r.Method != http.MethodGet {
			raw, _ := io.ReadAll(r.Body)
			bodies.add(r.Method, string(raw))
		}
		enc := json.NewEncoder(w)
		if r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/addons") {
			_ = enc.Encode(addonTestView())
			return
		}
		_ = enc.Encode(map[string]interface{}{"ok": true})
	}))
	t.Cleanup(srv.Close)
	t.Setenv("ALETHIA_WEB_ORIGIN", srv.URL)
	return rec, bodies, run
}

// addonBodies records the payload of every mutating request, so a test can assert WHICH add-on a
// command acted on rather than only that it acted.
type addonBodies struct {
	mu   sync.Mutex
	sent []string
}

func (b *addonBodies) add(method, body string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.sent = append(b.sent, method+" "+body)
}

func (b *addonBodies) all() []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]string{}, b.sent...)
}

// TestAddonDisable_AnnouncesTheResolvedTargetBeforeConfirming.
//
// The ORDER is the assertion. A destructive command that resolved its own target and asks
// "Disable this add-on?" without saying which one is asking a question nobody can answer; one that
// announces AFTER the confirmation has already acted on an unnamed target. Both orderings print
// the same two lines, so nothing short of comparing their POSITIONS tells them apart — the confirm
// stub writes a marker to the same stream, and the announcement must come before it.
func TestAddonDisable_AnnouncesTheResolvedTargetBeforeConfirming(t *testing.T) {
	rec, _, run := addonServe(t)
	addonFormInteractive(t)
	// Enter with no movement takes the first option: "loki".
	scripts := authFormAnswer(t, &authFormScript{keys: authFormKey(nil, tea.KeyEnter)})

	const marker = "<<CONFIRM-ASKED>>"
	asked := 0
	prev := confirm
	confirm = func(string, string) bool {
		asked++
		fmt.Fprintln(os.Stderr, marker)
		return false // declined: the ordering is what is under test, not the deletion
	}
	t.Cleanup(func() { confirm = prev })

	var code int
	out := addonCaptureStderr(t, func() { code = run("addon", "disable", "--project", "p1") })

	if !scripts[0].ran {
		t.Fatal("no picker was opened, so the command never resolved a target and the ordering " +
			"assertion is vacuous")
	}
	if asked != 1 {
		t.Fatalf("the confirmation was reached %d times, want exactly 1 — the assertion below is "+
			"vacuous otherwise", asked)
	}
	if code != 0 {
		t.Errorf("exit code = %d, want 0 — a declined confirmation is not an error", code)
	}
	announced := strings.Index(out, "loki")
	confirmed := strings.Index(out, marker)
	if announced < 0 {
		t.Fatalf("the resolved add-on was never announced on stderr:\n%s", out)
	}
	if confirmed < 0 || announced > confirmed {
		t.Errorf("the resolved add-on was announced at %d and the confirmation asked at %d — the "+
			"target must be named BEFORE the question about it:\n%s", announced, confirmed, out)
	}
	if muts := rec.mutations(); len(muts) > 0 {
		t.Errorf("a declined confirmation still changed state: %v", muts)
	}
}

// TestAddonDisable_PickerTargetsWhatItResolved is the other half: the id the picker chose is the
// id the DELETE carries.
//
// A command that announced "falco" and removed "loki" would satisfy the ordering test above, and
// would be the worse defect — so the assertion is the BODY, and it names both: the add-on that
// must be there and the one that must not.
func TestAddonDisable_PickerTargetsWhatItResolved(t *testing.T) {
	_, bodies, run := addonServe(t)
	addonFormInteractive(t)
	// Two presses down: "falco", the third add-on — not the first, which a resolver that dropped
	// the picker's answer and took options[0] would also produce.
	authFormAnswer(t, &authFormScript{keys: authFormKey(nil, tea.KeyDown, tea.KeyDown, tea.KeyEnter)})
	prev := confirm
	confirm = func(string, string) bool { return true }
	t.Cleanup(func() { confirm = prev })

	if code := run("addon", "disable", "--project", "p1"); code != 0 {
		t.Fatalf("exit code = %d, want 0", code)
	}
	sent := bodies.all()
	deletes := 0
	for _, req := range sent {
		if !strings.HasPrefix(req, http.MethodDelete+" ") {
			continue
		}
		deletes++
		if !strings.Contains(req, `"addon_id":"falco"`) && !strings.Contains(req, `"addon_id": "falco"`) {
			t.Errorf("the DELETE carries %q, want the add-on the picker resolved (falco)", req)
		}
		if strings.Contains(req, "loki") {
			t.Errorf("the DELETE names loki, which is options[0] — the picker's answer was dropped: %q", req)
		}
	}
	if deletes != 1 {
		t.Fatalf("saw %d DELETE requests, want exactly 1; sent = %v", deletes, sent)
	}
}

// ---------------------------------------------------------------------------
// The docs pages move with the group
// ---------------------------------------------------------------------------

// addonDocsPages maps each group in this lane to its page.
var addonDocsPages = map[string]string{
	"addon": "../../docs/content/docs/cli/commands/addons.mdx",
	"agent": "../../docs/content/docs/cli/commands/agents.mdx",
}

// TestAddonAgentDocs_FlagTablesMatchTheRegisteredFlags compares both directions, per command
// section.
//
// It reuses connDocsSections/connDocsRowFlags rather than copying them — a third rendering of
// "which flags does this section's table have a row for" is the defect this whole programme is
// about. It differs from the connector lane's guard in one way that matters here: the addon
// group's --project/--env are PERSISTENT flags on the group root, so they are inherited by every
// leaf and LocalFlags cannot see them. They are still fields of every command in the group, the
// page documents them per command, and a guard that skipped them would go green on their deletion.
func TestAddonAgentDocs_FlagTablesMatchTheRegisteredFlags(t *testing.T) {
	groups := map[string]*cobra.Command{"addon": addonCmd, "agent": agentCmd}

	scannedFlags, scannedSections := 0, 0
	for group, root := range groups {
		path, ok := addonDocsPages[group]
		if !ok {
			t.Fatalf("no docs page mapped for the %q group", group)
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read %s: %v — this guard's verdict depends on the page, so an unreadable "+
				"one is a failure and never a skip", path, err)
		}
		body := string(raw)
		sections := connDocsSections(body)
		if len(sections) == 0 {
			t.Fatalf("%s has no `## `alethia …`` command sections — every per-command assertion "+
				"below is vacuous", path)
		}

		// The group's own persistent flags are fields of every leaf, whatever LocalFlags says.
		var groupFlags []string
		root.PersistentFlags().VisitAll(func(f *pflag.Flag) { groupFlags = append(groupFlags, "--"+f.Name) })

		registered := map[string]bool{}
		for _, f := range groupFlags {
			registered[f] = true
		}
		for _, leaf := range walkLeaves(root) {
			section, documented := sections[leaf.CommandPath()]
			if !documented {
				t.Errorf("%s has no `## `%s`` section in %s", leaf.CommandPath(), leaf.CommandPath(), path)
				continue
			}
			scannedSections++
			rows := connDocsRowFlags(section)
			want := append([]string{}, groupFlags...)
			leaf.Flags().VisitAll(func(f *pflag.Flag) {
				if leaf.LocalFlags().Lookup(f.Name) == nil || connDocsAutoFlags["--"+f.Name] {
					return
				}
				want = append(want, "--"+f.Name)
			})
			for _, flag := range want {
				registered[flag] = true
				scannedFlags++
				if !rows[flag] {
					t.Errorf("%s takes %s, and its section in %s has no table ROW for it — a reader "+
						"scanning that command's flag table would not find it", leaf.CommandPath(), flag, path)
				}
			}
		}

		// The other direction, page-wide: the prose and the callouts are where a renamed flag
		// survives longest, and they sit inside no command's section.
		for _, m := range connDocsFlagRef.FindAllStringSubmatch(body, -1) {
			flag := m[1]
			if registered[flag] || connDocsGlobalFlags[flag] {
				continue
			}
			t.Errorf("%s documents %s, which no command in the %q group takes — a renamed or "+
				"deleted flag leaves an instruction behind that does not work", path, flag, group)
		}
	}

	if scannedFlags == 0 || scannedSections == 0 {
		t.Fatalf("scanned %d flags across %d command sections — this guard is not seeing the "+
			"command tree and both directions above are vacuous", scannedFlags, scannedSections)
	}
}

// addonDocsArgCells returns the first cell of every table row on a page, plus every fenced
// `alethia …` example — the two places a command's ARGUMENT notation is written.
//
// Scoped, not page-wide, and the scoping is the correction that made this guard true rather than
// merely red. `<agent-id>` also appears in "Backing call: `GET /cli/agents/<agent-id>`", which is
// an API PATH: the id genuinely is required there, and asserting over the raw page failed on a
// line that was correct. A guard that has to be silenced by rewording a true sentence is a guard
// matching a rendering instead of the thing.
func addonDocsArgCells(body string) []string {
	var out []string
	fenced := false
	for _, line := range strings.Split(body, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "```") {
			fenced = !fenced
			continue
		}
		if fenced {
			if strings.HasPrefix(trimmed, "alethia ") {
				out = append(out, trimmed)
			}
			continue
		}
		if strings.HasPrefix(trimmed, "|") {
			cells := strings.Split(strings.Trim(trimmed, "|"), "|")
			if len(cells) > 0 {
				out = append(out, cells[0])
			}
		}
	}
	return out
}

// TestAddonAgentDocs_PagesDoNotSendTheReaderBackForAnId.
//
// The pages used to say the id comes "from `agent list`" and "see `addon list`". That sentence is
// the handoff in prose: even with the picker shipped, a page that still instructs the reader to
// copy a token teaches the workflow the code no longer requires.
//
// Two subjects, each checked where it lives. The PROSE instruction is looked for page-wide. The
// ARGUMENT NOTATION is looked for only in argument tables and runnable examples — a required
// positional is written `<name>` in this docs tree and an optional one `[name]`, so the
// angle-bracket form for an id cobra now accepts zero of is a page describing a command that no
// longer exists.
func TestAddonAgentDocs_PagesDoNotSendTheReaderBackForAnId(t *testing.T) {
	checked, cells := 0, 0
	for group, path := range addonDocsPages {
		raw, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read %s: %v", path, err)
		}
		body := string(raw)
		checked++
		for _, stale := range []string{"from `agent list`", "see `addon list`"} {
			if strings.Contains(body, stale) {
				t.Errorf("%s (%s) still carries %q — the id has another source now, and a page that "+
					"tells the reader to copy one teaches the workflow this lane removed",
					path, group, stale)
			}
		}
		for _, cell := range addonDocsArgCells(body) {
			cells++
			for _, stale := range []string{"<addon-id>", "<agent-id>", "<addon_id>", "<agent_id>"} {
				if strings.Contains(cell, stale) {
					t.Errorf("%s writes %q in %q — the angle brackets mean a REQUIRED positional, "+
						"and the command accepts zero arguments now", path, stale, strings.TrimSpace(cell))
				}
			}
		}
		if !strings.Contains(body, "stderr") {
			t.Errorf("%s does not say the resolved id is printed on stderr, which is what makes "+
				"`-o json` safe to pipe", path)
		}
	}
	if checked != 2 {
		t.Fatalf("checked %d pages, want 2 — the map is not being read", checked)
	}
	if cells < 10 {
		t.Fatalf("scanned only %d argument cells and examples across both pages — the extraction "+
			"is not seeing the tables, so the notation assertion is vacuous", cells)
	}
}

// TestAddonDocs_RecordTheOneHandoffThatRemains.
//
// Honesty about the boundary is part of the pass. The CLI has no endpoint that enumerates the
// marketplace catalog, so `addon enable` can offer only what is installed and a FIRST install
// still needs an id from the console. A page that quietly omitted that would read as if the
// picker covered every case, and the operator would conclude the command was broken.
func TestAddonDocs_RecordTheOneHandoffThatRemains(t *testing.T) {
	raw, err := os.ReadFile(addonDocsPages["addon"])
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	body := string(raw)
	for _, want := range []string{"catalog", "console"} {
		if !strings.Contains(body, want) {
			t.Errorf("addons.mdx does not name %q — the remaining handoff must be stated, not "+
				"discovered", want)
		}
	}
}

// TestAddonEnable_RefusesABadModeBeforeAnyRequest.
//
// Before the fetch and before the picker, both of which cost the operator something: a round trip
// they wait for, or a question they answer for nothing.
func TestAddonEnable_RefusesABadModeBeforeAnyRequest(t *testing.T) {
	s, run := hygCliConfirmEnv(t)
	if code := run("addon", "enable", "loki", "--project", "p1", "--mode", "helm", "--no-input"); code != 1 {
		t.Errorf("exit code = %d, want 1 for a --mode outside the enum", code)
	}
	if len(s.requests) != 0 {
		t.Errorf("a refused --mode still reached the control plane: %v", s.requests)
	}
}

// TestAddonEnable_SendsTheCanonicalMode pins the other half: a folded value is accepted and the
// wire gets the enum's own spelling.
func TestAddonEnable_SendsTheCanonicalMode(t *testing.T) {
	s, bodies, run := addonServe(t)
	if code := run("addon", "enable", "loki", "--project", "p1", "--mode", "GITOPS", "--no-input"); code != 0 {
		t.Fatalf("exit code = %d, want 0 — the enum holds this value under another case", code)
	}
	if !s.saw(http.MethodPost, "/api/cli/projects/p1/addons") {
		t.Errorf("the enable never reached the control plane; requests = %v", s.requests)
	}
	posts := bodies.all()
	if len(posts) == 0 || !strings.Contains(posts[0], `"mode":"gitops"`) {
		t.Errorf("the enable sent a non-canonical mode payload: %v", posts)
	}
}

// TestPickers_PropagateAnAbandonedForm covers the arm a script can never reach and a person hits
// by pressing ctrl-c: the form errors, and the resolver must return that rather than the first
// option.
//
// Returning options[0] on an abandoned picker is the specific way this goes wrong, and on
// `addon disable` it would resolve a destructive command's target from a prompt the operator
// explicitly walked away from.
func TestPickers_PropagateAnAbandonedForm(t *testing.T) {
	addonFormInteractive(t)
	boom := errors.New("user aborted")
	prev := runHuhForm
	runHuhForm = func(...*huh.Group) error { return boom }
	t.Cleanup(func() { runHuhForm = prev })

	ref, err := resolveAddonID(&addonFakeLister{view: addonTestView()}, nil, "web", "", addonDisablePrompt)
	if !errors.Is(err, boom) {
		t.Errorf("resolveAddonID err = %v, want the form's error", err)
	}
	if ref.ID != "" {
		t.Errorf("an abandoned picker resolved %q; a target nobody chose must not be acted on", ref.ID)
	}

	aref, err := resolveAgentID(&agentFakeLister{agents: []api.Agent{{ID: "ag-1"}, {ID: "ag-2"}}}, nil)
	if !errors.Is(err, boom) {
		t.Errorf("resolveAgentID err = %v, want the form's error", err)
	}
	if aref.ID != "" {
		t.Errorf("an abandoned picker resolved %q", aref.ID)
	}
}

// TestResolveAgentID_ListerErrorPropagates: a transport failure must not be reported as "no agent
// identities", which reads as an empty tenancy.
func TestResolveAgentID_ListerErrorPropagates(t *testing.T) {
	addonFormInteractive(t)
	_, err := resolveAgentID(&agentFakeLister{err: errors.New("boom")}, nil)
	if err == nil || !strings.Contains(err.Error(), "boom") {
		t.Fatalf("err = %v; want the transport error to reach the caller", err)
	}
}
