// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"errors"
	"fmt"
	"os"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/charmbracelet/huh"
	"github.com/spf13/cobra"
)

// The "which job" resolver is what removes the copied id from the golden path, so these tests
// are written against the three sources of an id — the positional, --latest, and the picker —
// and against the refusals that keep them from silently disagreeing.

// jobsSelectLister is the fake behind the resolver. It records what the resolver asked the
// server for, because "did it filter" and "did it filter SERVER-SIDE with the right arguments"
// are different questions and only the second one is about the request.
type jobsSelectLister struct {
	jobs    []api.ProvisionJob
	total   int
	err     error
	calls   int
	gotStat string
	gotLim  int
	gotOff  int
	nilPage bool
}

func (f *jobsSelectLister) GetJobs(status string, limit, offset int) (*api.JobsPage, error) {
	f.calls++
	f.gotStat, f.gotLim, f.gotOff = status, limit, offset
	if f.err != nil {
		return nil, f.err
	}
	if f.nilPage {
		return nil, nil
	}
	total := f.total
	if total == 0 {
		total = len(f.jobs)
	}
	return &api.JobsPage{Jobs: f.jobs, Total: total, Limit: limit, Offset: offset}, nil
}

// jobsSelectSample is a page of jobs, newest first, spanning two projects and two types so
// every narrowing field has both a match and a non-match to distinguish.
func jobsSelectSample() []api.ProvisionJob {
	base := time.Date(2026, 3, 9, 12, 0, 0, 0, time.UTC)
	return []api.ProvisionJob{
		{ID: "job-newest", JobType: string(types.JobTypeDeploy), Status: "PROCESSING",
			ProjectID: "p-web-0001", ProjectName: "web", CreatedAt: base},
		{ID: "job-middle", JobType: string(types.JobTypePlan), Status: "SUCCESS",
			ProjectID: "p-web-0001", ProjectName: "web", CreatedAt: base.Add(-time.Hour)},
		{ID: "job-oldest", JobType: string(types.JobTypePlan), Status: "FAILED",
			ProjectID: "p-data-0002", ProjectName: "data-platform", CreatedAt: base.Add(-2 * time.Hour)},
	}
}

// jobsSelectInteractive makes stdin look like a terminal, so requireInteractive lets the picker
// arm. A headless `go test` process has no terminal and would otherwise take the refusal arm.
func jobsSelectInteractive(t *testing.T) {
	t.Helper()
	prevTTY, prevMode := stdinIsTTY, noInputMode
	stdinIsTTY = func() bool { return true }
	noInputMode = false
	t.Cleanup(func() { stdinIsTTY, noInputMode = prevTTY, prevMode })
}

// jobsSelectNoInput pins prompting off for the duration of a test.
func jobsSelectNoInput(t *testing.T) {
	t.Helper()
	prev := noInputMode
	noInputMode = true
	t.Cleanup(func() { noInputMode = prev })
}

// jobsSelectStubForm replaces the huh runner. It cannot answer the form — the value is written
// through a pointer the group owns — so it only decides whether the form errored, which is the
// abort/decline arm. selectors.go records the same measurement.
func jobsSelectStubForm(t *testing.T, err error) {
	t.Helper()
	prev := runHuhForm
	runHuhForm = func(...*huh.Group) error { return err }
	t.Cleanup(func() { runHuhForm = prev })
}

// setSelectorField sets one narrowing field by its spec entry, so a test can iterate the spec
// instead of naming the three struct members it happens to have today.
func setSelectorField(sel *jobSelector, f jobSelectorField, v string) {
	*f.Target(sel) = v
}

// TestJobsSelector_ExplicitIDNeedsNoRequest pins the cheapest path: an id on the command line is
// the answer, and the resolver must not spend a round trip confirming it.
func TestJobsSelector_ExplicitIDNeedsNoRequest(t *testing.T) {
	f := &jobsSelectLister{jobs: jobsSelectSample()}
	ref, err := resolveJob(f, []string{"8f3c"}, jobSelector{})
	if err != nil {
		t.Fatalf("resolveJob with an explicit id: %v", err)
	}
	if ref.ID != "8f3c" {
		t.Errorf("resolved id = %q, want the argument 8f3c", ref.ID)
	}
	if ref.Summary != "" {
		t.Errorf("summary = %q, want empty — the CLI did not choose this job", ref.Summary)
	}
	if f.calls != 0 {
		t.Errorf("the resolver made %d list requests for an id it was handed", f.calls)
	}
}

// TestJobsSelector_EmptyPositionalFallsThrough pins that `jobs logs ""` is not treated as an id.
// cobra allows an empty string through MaximumNArgs, and requesting job "" 404s with a message
// about the server rather than about the empty argument.
func TestJobsSelector_EmptyPositionalFallsThrough(t *testing.T) {
	jobsSelectNoInput(t)
	f := &jobsSelectLister{jobs: jobsSelectSample()}
	_, err := resolveJob(f, []string{""}, jobSelector{})
	if !errors.Is(err, errJobIDRequired) {
		t.Fatalf("err = %v, want errJobIDRequired", err)
	}
}

// TestJobsSelector_IDAndLatestIsRefused pins the contradiction: both name a job, so obeying
// either one silently would make the other a lie.
func TestJobsSelector_IDAndLatestIsRefused(t *testing.T) {
	f := &jobsSelectLister{jobs: jobsSelectSample()}
	_, err := resolveJob(f, []string{"8f3c"}, jobSelector{latest: true})
	if err == nil {
		t.Fatal("an explicit id together with --latest was accepted")
	}
	if !strings.Contains(err.Error(), "--latest") || !strings.Contains(err.Error(), "8f3c") {
		t.Errorf("error %q names neither the flag nor the id", err)
	}
	if f.calls != 0 {
		t.Errorf("the resolver made %d requests before refusing", f.calls)
	}
}

// TestJobsSelector_IDWithNarrowingIsRefused walks the SPEC rather than a list of flags typed
// here: a field added to jobSelectorFields is covered the day it is added. `jobs logs <id>
// --type DEPLOY` against a PLAN job would otherwise print the PLAN's logs and look filtered.
func TestJobsSelector_IDWithNarrowingIsRefused(t *testing.T) {
	if len(jobSelectorFields) == 0 {
		t.Fatal("jobSelectorFields is empty — this test would pass by covering nothing")
	}
	for _, field := range jobSelectorFields {
		t.Run(field.Flag, func(t *testing.T) {
			var sel jobSelector
			setSelectorField(&sel, field, "anything")
			f := &jobsSelectLister{jobs: jobsSelectSample()}
			_, err := resolveJob(f, []string{"8f3c"}, sel)
			if err == nil {
				t.Fatalf("an explicit id together with --%s was accepted", field.Flag)
			}
			if !strings.Contains(err.Error(), field.Flag) {
				t.Errorf("error %q does not name --%s", err, field.Flag)
			}
		})
	}
}

// TestJobsSelector_NoInputWithoutLatestIsRefusedBeforeTheRequest pins the scripted refusal. The
// answer cannot depend on what the server holds, so asking it would only make the error slower.
func TestJobsSelector_NoInputWithoutLatestIsRefusedBeforeTheRequest(t *testing.T) {
	jobsSelectNoInput(t)
	f := &jobsSelectLister{jobs: jobsSelectSample()}
	_, err := resolveJob(f, nil, jobSelector{})
	if !errors.Is(err, errJobIDRequired) {
		t.Fatalf("err = %v, want errJobIDRequired", err)
	}
	if f.calls != 0 {
		t.Errorf("the resolver made %d requests before refusing", f.calls)
	}
	// The flag list is DERIVED from the spec and compared against the rendered message, so a
	// narrowing field added to the spec and forgotten in this sentence is a failure.
	wants := append([]string{"--latest"}, jobSelectorFlagNames()...)
	if len(wants) < 2 {
		t.Fatal("the spec contributed no narrowing flags — this assertion covered nothing")
	}
	for _, want := range wants {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("the refusal does not tell the reader about %s: %q", want, err)
		}
	}
}

// TestJobsSelector_LatestWorksUnderNoInput is the handoff removal itself: a script with no
// terminal resolves a job without any id ever having been copied out of another command.
func TestJobsSelector_LatestWorksUnderNoInput(t *testing.T) {
	jobsSelectNoInput(t)
	f := &jobsSelectLister{jobs: jobsSelectSample()}
	ref, err := resolveJob(f, nil, jobSelector{latest: true})
	if err != nil {
		t.Fatalf("resolveJob --latest under --no-input: %v", err)
	}
	if ref.ID != "job-newest" {
		t.Errorf("--latest resolved %q, want job-newest (the server orders created_at DESC)", ref.ID)
	}
	if ref.Summary == "" {
		t.Error("--latest returned no summary — a job the CLI chose must be nameable to the reader")
	}
}

// TestJobsSelector_RequestCarriesTheServerSideFilter pins what actually goes on the wire:
// --status is the one narrowing the endpoint understands, upper-cased, with the page size.
func TestJobsSelector_RequestCarriesTheServerSideFilter(t *testing.T) {
	f := &jobsSelectLister{jobs: jobsSelectSample()}
	jobsSelectNoInput(t)
	if _, err := resolveJob(f, nil, jobSelector{latest: true, status: "success"}); err != nil {
		t.Fatalf("resolveJob: %v", err)
	}
	if f.gotStat != "SUCCESS" {
		t.Errorf("GetJobs got status %q, want SUCCESS (upper-cased for the enum column)", f.gotStat)
	}
	if f.gotLim != jobSelectorPageSize {
		t.Errorf("GetJobs got limit %d, want jobSelectorPageSize (%d)", f.gotLim, jobSelectorPageSize)
	}
	if f.gotOff != 0 {
		t.Errorf("GetJobs got offset %d, want 0 — the resolver reads the newest page only", f.gotOff)
	}
}

// TestJobsSelector_EachNarrowingFieldSelects walks the spec and proves every field both KEEPS
// its match and DROPS its non-match. A field whose Match always returns true would pass a
// "found something" assertion; it cannot pass this one.
func TestJobsSelector_EachNarrowingFieldSelects(t *testing.T) {
	cases := map[string]struct {
		value  string
		wantID string
	}{
		"type":    {value: "PLAN", wantID: "job-middle"},
		"status":  {value: "FAILED", wantID: "job-oldest"},
		"project": {value: "data-platform", wantID: "job-oldest"},
	}
	if len(cases) != len(jobSelectorFields) {
		t.Fatalf("the spec has %d fields and this test names %d — add the missing case",
			len(jobSelectorFields), len(cases))
	}
	jobsSelectNoInput(t)
	for _, field := range jobSelectorFields {
		c, ok := cases[field.Flag]
		if !ok {
			t.Fatalf("no case for spec field --%s", field.Flag)
		}
		t.Run(field.Flag, func(t *testing.T) {
			sel := jobSelector{latest: true}
			setSelectorField(&sel, field, c.value)
			// The fake is not the server, so it hands back the whole page whatever it was asked
			// for. Every field is therefore decided by the client-side pass here — including
			// --status, which in production is narrowed twice. Double-narrowing is deliberate:
			// it means the fake cannot make a filter look like it works when only the server
			// was doing it.
			f := &jobsSelectLister{jobs: jobsSelectSample()}
			ref, err := resolveJob(f, nil, sel)
			if err != nil {
				t.Fatalf("resolveJob --%s %s: %v", field.Flag, c.value, err)
			}
			if ref.ID != c.wantID {
				t.Errorf("--%s %s resolved %q, want %q", field.Flag, c.value, ref.ID, c.wantID)
			}
		})
	}
}

// TestJobsSelector_ProjectMatchesNameOrIDPrefix pins both halves of the project field. The name
// is what a person types; the id prefix is what `jobs list` shows when the join found no name.
func TestJobsSelector_ProjectMatchesNameOrIDPrefix(t *testing.T) {
	jobsSelectNoInput(t)
	for _, value := range []string{"WEB", "p-web"} {
		t.Run(value, func(t *testing.T) {
			f := &jobsSelectLister{jobs: jobsSelectSample()}
			ref, err := resolveJob(f, nil, jobSelector{latest: true, project: value})
			if err != nil {
				t.Fatalf("resolveJob --project %s: %v", value, err)
			}
			if ref.ID != "job-newest" {
				t.Errorf("--project %s resolved %q, want job-newest", value, ref.ID)
			}
		})
	}
	f := &jobsSelectLister{jobs: jobsSelectSample()}
	if _, err := resolveJob(f, nil, jobSelector{latest: true, project: "eb"}); err == nil {
		t.Error("--project eb matched p-web-0001 — the id rule is a PREFIX, not a substring")
	}
}

// TestJobsSelector_ClosedVocabularyIsRefused walks the spec's closed sets. A value outside the
// generated enum matches no row by construction, so refusing it cannot hide a job that exists —
// while the server's answer to a typo is an empty page that reads as "you have no jobs".
func TestJobsSelector_ClosedVocabularyIsRefused(t *testing.T) {
	closed := 0
	for _, field := range jobSelectorFields {
		if field.Allowed == nil {
			continue
		}
		closed++
		t.Run(field.Flag, func(t *testing.T) {
			if len(field.Allowed()) == 0 {
				t.Fatal("the allowed set is empty — the generated enum did not reach this field")
			}
			var sel jobSelector
			setSelectorField(&sel, field, "NOT_A_REAL_VALUE")
			sel.latest = true
			f := &jobsSelectLister{jobs: jobsSelectSample()}
			_, err := resolveJob(f, nil, sel)
			if err == nil {
				t.Fatalf("--%s NOT_A_REAL_VALUE was accepted", field.Flag)
			}
			for _, want := range append([]string{"--" + field.Flag}, field.Allowed()[0]) {
				if !strings.Contains(err.Error(), want) {
					t.Errorf("error %q does not mention %q", err, want)
				}
			}
			if f.calls != 0 {
				t.Errorf("the resolver made %d requests for a value it could refuse offline", f.calls)
			}
		})
	}
	if closed == 0 {
		t.Fatal("no spec field declares a closed vocabulary — this test covered nothing")
	}
}

// TestJobsSelector_ClosedVocabularyAcceptsEveryGeneratedValue is the other direction: every
// value the drizzle enum defines must pass. A hand-typed allow-list that fell behind the enum
// would refuse a real job type and this is what catches it.
func TestJobsSelector_ClosedVocabularyAcceptsEveryGeneratedValue(t *testing.T) {
	jobsSelectNoInput(t)
	for _, field := range jobSelectorFields {
		if field.Allowed == nil {
			continue
		}
		for _, v := range field.Allowed() {
			var sel jobSelector
			setSelectorField(&sel, field, v)
			if err := sel.validate(); err != nil {
				t.Errorf("--%s %s is a generated enum value and was refused: %v", field.Flag, v, err)
			}
			var lower jobSelector
			setSelectorField(&lower, field, strings.ToLower(v))
			if err := lower.validate(); err != nil {
				t.Errorf("--%s %s (lower case) was refused: %v", field.Flag, strings.ToLower(v), err)
			}
		}
	}
}

// TestJobsSelector_NoMatchNamesTheNarrowing pins the empty answer. "no jobs" and "no jobs LIKE
// THAT" send a reader to different places.
func TestJobsSelector_NoMatchNamesTheNarrowing(t *testing.T) {
	jobsSelectNoInput(t)
	f := &jobsSelectLister{jobs: jobsSelectSample()}
	_, err := resolveJob(f, nil, jobSelector{latest: true, project: "nonesuch"})
	if err == nil {
		t.Fatal("a narrowing that matched nothing resolved a job")
	}
	if !strings.Contains(err.Error(), "project nonesuch") {
		t.Errorf("error %q does not say WHICH narrowing found nothing", err)
	}

	empty := &jobsSelectLister{}
	_, err = resolveJob(empty, nil, jobSelector{latest: true})
	if err == nil {
		t.Fatal("an empty page resolved a job")
	}
	if strings.Contains(err.Error(), "with ") {
		t.Errorf("an unnarrowed empty page invented a narrowing: %q", err)
	}
}

// TestJobsSelector_FetchFailureIsReported pins that a broken list is an error and not an empty
// list — "no jobs matched" for a 500 would be the wrong sentence entirely.
func TestJobsSelector_FetchFailureIsReported(t *testing.T) {
	jobsSelectNoInput(t)
	boom := errors.New("control plane unavailable")
	f := &jobsSelectLister{err: boom}
	_, err := resolveJob(f, nil, jobSelector{latest: true})
	if !errors.Is(err, boom) {
		t.Fatalf("err = %v, want it to wrap the transport error", err)
	}
}

// TestJobsSelector_NilPageIsNotACrash pins the shape a client can legally return: no error and
// no page. Dereferencing it would panic in the middle of an operator's terminal.
func TestJobsSelector_NilPageIsNotACrash(t *testing.T) {
	jobsSelectNoInput(t)
	f := &jobsSelectLister{nilPage: true}
	if _, err := resolveJob(f, nil, jobSelector{latest: true}); err == nil {
		t.Fatal("a nil page resolved a job")
	}
}

// TestJobsSelector_PickerDefaultsToTheNewest covers the interactive arm. A stub cannot answer
// the form — huh owns the pointer — so what is proved here is the default the form opens on and
// that the chosen job comes back with its summary.
func TestJobsSelector_PickerDefaultsToTheNewest(t *testing.T) {
	jobsSelectInteractive(t)
	jobsSelectStubForm(t, nil)
	f := &jobsSelectLister{jobs: jobsSelectSample()}
	ref, err := resolveJob(f, nil, jobSelector{})
	if err != nil {
		t.Fatalf("resolveJob through the picker: %v", err)
	}
	if ref.ID != "job-newest" {
		t.Errorf("the picker opened on %q, want job-newest", ref.ID)
	}
	if !strings.Contains(ref.Summary, "Deploy") {
		t.Errorf("summary %q does not describe the chosen job", ref.Summary)
	}
	if f.calls != 1 {
		t.Errorf("the picker made %d list requests, want exactly 1", f.calls)
	}
}

// TestJobsSelector_PickerAbortIsAnError pins Ctrl-C: an aborted picker must not fall through to
// "the newest job", which is exactly the job a user aborting is trying not to touch.
func TestJobsSelector_PickerAbortIsAnError(t *testing.T) {
	jobsSelectInteractive(t)
	jobsSelectStubForm(t, errors.New("user aborted"))
	f := &jobsSelectLister{jobs: jobsSelectSample()}
	if _, err := resolveJob(f, nil, jobSelector{}); err == nil {
		t.Fatal("an aborted picker resolved a job")
	}
}

// TestJobOptionLabel_CarriesEveryColumnTheTableShows pins the picker line against the table it
// mirrors: a job must not read one way in `jobs list` and another in the picker.
func TestJobOptionLabel_CarriesEveryColumnTheTableShows(t *testing.T) {
	j := jobsSelectSample()[0]
	label := jobOptionLabel(j)
	for _, want := range []string{"Deploy", "PROCESSING", "web"} {
		if !strings.Contains(label, want) {
			t.Errorf("label %q is missing %q", label, want)
		}
	}
	// Through the shared helper, so this cannot pass by re-implementing the truncation.
	if !strings.Contains(label, ui.TruncID("job-newest")) {
		t.Errorf("label %q does not carry the truncated id", label)
	}

	// The list join found no project NAME but the job carries an id: the truncated id, the same
	// fallback `jobs list` shows in that column, so the picker and the table never disagree.
	unnamed := jobOptionLabel(api.ProvisionJob{
		ID: "job-x", JobType: string(types.JobTypePlan), Status: "QUEUED", ProjectID: "p-web-0001",
	})
	if !strings.Contains(unnamed, ui.TruncID("p-web-0001")) {
		t.Errorf("label %q does not fall back to the truncated project id", unnamed)
	}
	if strings.Contains(unnamed, "—") {
		t.Errorf("label %q used the dash for a job that has a project id", unnamed)
	}

	// No project name and no project id: the dash, the same sentinel the table uses.
	bare := jobOptionLabel(api.ProvisionJob{ID: "x", JobType: "MYSTERY_TYPE", Status: "QUEUED"})
	if !strings.Contains(bare, "—") {
		t.Errorf("label %q for a project-less job does not use the dash sentinel", bare)
	}
	if !strings.Contains(bare, "MYSTERY_TYPE") {
		t.Errorf("label %q dropped an unlabelled job type instead of showing it raw", bare)
	}
}

// TestJobsSelector_SpecIsRenderedOnEveryJobCommand is the first half of the "one spec, four
// renderings" claim: the flags are read back off the REAL cobra commands, not off the spec, so
// a field added to the spec and not wired reaches this test as a failure.
func TestJobsSelector_SpecIsRenderedOnEveryJobCommand(t *testing.T) {
	commands := map[string]*cobra.Command{
		"get":    jobsGetCmd,
		"logs":   jobsLogsCmd,
		"cancel": jobsCancelCmd,
	}
	for name, cmd := range commands {
		t.Run(name, func(t *testing.T) {
			if cmd.Flags().Lookup("latest") == nil {
				t.Errorf("`jobs %s` has no --latest, so it cannot be driven with --no-input", name)
			}
			for _, field := range jobSelectorFields {
				f := cmd.Flags().Lookup(field.Flag)
				if f == nil {
					t.Errorf("`jobs %s` has no --%s", name, field.Flag)
					continue
				}
				if field.Allowed != nil {
					for _, v := range field.Allowed() {
						if !strings.Contains(f.Usage, v) {
							t.Errorf("`jobs %s --%s` help does not list %q — it is not derived from the enum",
								name, field.Flag, v)
						}
					}
				}
			}
			if cmd.Args == nil {
				t.Fatalf("`jobs %s` declares no Args validator", name)
			}
			if err := cmd.Args(cmd, nil); err != nil {
				t.Errorf("`jobs %s` still requires a positional id: %v", name, err)
			}
			if err := cmd.Args(cmd, []string{"a", "b"}); err == nil {
				t.Errorf("`jobs %s` accepted two positional ids", name)
			}
		})
	}
}

// jobsDocsPath is the group's docs page, resolved from this package.
const jobsDocsPath = "../../../apps/docs/content/docs/cli/commands/jobs.mdx"

// jobsDocsFlagRow matches the first cell of a markdown table row that names a flag.
var jobsDocsFlagRow = regexp.MustCompile(`(?m)^\|\s*` + "`" + `(--[a-z-]+)` + "`")

// TestJobsSelector_DocsTableMatchesTheSpec is the second half. The docs are a SEPARATE artifact
// — nothing generates them — so this reads the shipped MDX and compares the flags it documents
// against the flags the spec produces, in both directions. A field added to the spec and not
// documented fails; a flag documented that no longer exists fails.
func TestJobsSelector_DocsTableMatchesTheSpec(t *testing.T) {
	raw, err := os.ReadFile(jobsDocsPath)
	if err != nil {
		t.Fatalf("the jobs docs page must ship with the jobs commands: %v", err)
	}
	const heading = "## Choosing the job"
	start := strings.Index(string(raw), heading)
	if start < 0 {
		t.Fatalf("%s has no %q section — this test would otherwise pass by finding no rows", jobsDocsPath, heading)
	}
	section := string(raw)[start+len(heading):]
	if next := strings.Index(section, "\n## "); next >= 0 {
		section = section[:next]
	}

	documented := map[string]bool{}
	for _, m := range jobsDocsFlagRow.FindAllStringSubmatch(section, -1) {
		documented[m[1]] = true
	}
	if len(documented) == 0 {
		t.Fatalf("the %q section documents no flags — vacuous", heading)
	}

	want := map[string]bool{"--latest": true}
	for _, f := range jobSelectorFields {
		want["--"+f.Flag] = true
	}
	for flag := range want {
		if !documented[flag] {
			t.Errorf("%s is part of the selector spec and is not in the %q table", flag, heading)
		}
	}
	for flag := range documented {
		if !want[flag] {
			t.Errorf("%s is documented in the %q table and is not part of the selector spec", flag, heading)
		}
	}
}

// TestJobsSelector_DocsCarryNoCopiedJobID is the handoff gate for this group's page. A
// `<job-id>` placeholder in a command line is a token the reader has to copy out of a previous
// command's output, and removing those is what the CLI programme is measured on.
func TestJobsSelector_DocsCarryNoCopiedJobID(t *testing.T) {
	raw, err := os.ReadFile(jobsDocsPath)
	if err != nil {
		t.Fatalf("reading %s: %v", jobsDocsPath, err)
	}
	lines := strings.Split(string(raw), "\n")
	seen := 0
	for i, line := range lines {
		if !strings.Contains(line, "alethia ") {
			continue
		}
		seen++
		for _, placeholder := range []string{"<job_id>", "<job-id>", "<id>", "<plan-job-id>", "<apply-job-id>"} {
			if strings.Contains(line, placeholder) {
				t.Errorf("%s:%d hands the reader a %s to copy: %s", jobsDocsPath, i+1, placeholder, strings.TrimSpace(line))
			}
		}
	}
	if seen == 0 {
		t.Fatalf("%s shows no `alethia` command lines — this test covered nothing", jobsDocsPath)
	}
}

// TestJobsSelector_LabelsAndStatusesComeFromTheGeneratedEnums keeps the two vocabulary
// projections honest against the drizzle SSOT: every generated value is offered, and nothing is
// offered that the enum does not define.
func TestJobsSelector_LabelsAndStatusesComeFromTheGeneratedEnums(t *testing.T) {
	if len(types.AllJobTypes) == 0 || len(types.AllJobStatuses) == 0 {
		t.Fatal("the generated enums are empty — this test covered nothing")
	}
	if got, want := len(jobTypeValues()), len(types.AllJobTypes); got != want {
		t.Errorf("jobTypeValues has %d entries, the enum has %d", got, want)
	}
	if got, want := len(jobStatusValues()), len(types.AllJobStatuses); got != want {
		t.Errorf("jobStatusValues has %d entries, the enum has %d", got, want)
	}
	for _, s := range types.AllJobStatuses {
		if !containsFold(jobStatusValues(), string(s)) {
			t.Errorf("provision_job_status %q is missing from jobStatusValues", s)
		}
	}
	for _, jt := range types.AllJobTypes {
		if !containsFold(jobTypeValues(), string(jt)) {
			t.Errorf("provision_job_type %q is missing from jobTypeValues", jt)
		}
	}
}

// TestContainsFold pins the case-insensitive membership the vocabulary checks rest on.
func TestContainsFold(t *testing.T) {
	vals := []string{"QUEUED", "SUCCESS"}
	for _, v := range []string{"QUEUED", "success", "Success"} {
		if !containsFold(vals, v) {
			t.Errorf("containsFold(%v, %q) = false", vals, v)
		}
	}
	for _, v := range []string{"", "SUCCES", "SUCCESSS"} {
		if containsFold(vals, v) {
			t.Errorf("containsFold(%v, %q) = true", vals, v)
		}
	}
}

// TestCancelJobWarning pins that a job the CLI resolved is named in the confirmation, and that a
// job the user named is not described back at them.
func TestCancelJobWarning(t *testing.T) {
	handed := cancelJobWarning(jobRef{ID: "8f3c"})
	if strings.Contains(handed, "\n") {
		t.Errorf("an id the user typed got a resolution line: %q", handed)
	}
	if !strings.Contains(handed, "between two states") {
		t.Errorf("the consequence is missing from %q", handed)
	}
	resolved := cancelJobWarning(jobRef{ID: "8f3c", Summary: "Deploy · PROCESSING · web"})
	if !strings.Contains(resolved, "Deploy · PROCESSING · web") {
		t.Errorf("a --latest confirmation does not say which job: %q", resolved)
	}
	if !strings.Contains(resolved, "between two states") {
		t.Errorf("the consequence was dropped from %q", resolved)
	}
}

// jobsCancelSample is a page whose NEWEST job is terminal and whose second job is the one still
// running. It is the shape the cancel scope exists for: "the most recent job" and "the job a
// cancel could act on" are different jobs.
func jobsCancelSample() []api.ProvisionJob {
	base := time.Date(2026, 3, 9, 12, 0, 0, 0, time.UTC)
	return []api.ProvisionJob{
		{ID: "job-plan-done", JobType: string(types.JobTypePlan), Status: string(types.JobStatusSuccess),
			ProjectID: "p-web-0001", ProjectName: "web", CreatedAt: base},
		{ID: "job-deploy-running", JobType: string(types.JobTypeDeploy), Status: string(types.JobStatusProcessing),
			ProjectID: "p-web-0001", ProjectName: "web", CreatedAt: base.Add(-time.Minute)},
	}
}

// TestCancellableJobScope_IsASubsetOfTheEnum pins the scope against the generated vocabulary in
// both directions: every status it names must exist, and it must leave some out. A scope that
// had silently grown to the whole enum would narrow nothing and every test below would still
// pass by accident.
func TestCancellableJobScope_IsASubsetOfTheEnum(t *testing.T) {
	if len(cancellableJobScope.Values) == 0 {
		t.Fatal("the cancellable scope is empty — cancel would resolve to no job at all")
	}
	for _, s := range cancellableJobScope.Values {
		if !containsFold(jobStatusValues(), s) {
			t.Errorf("%q is not a provision_job_status", s)
		}
	}
	if len(cancellableJobScope.Values) >= len(jobStatusValues()) {
		t.Errorf("the scope names %d of %d statuses — it excludes nothing",
			len(cancellableJobScope.Values), len(jobStatusValues()))
	}
	// The terminal statuses are the ones the control plane refuses, so naming one here would
	// re-open the defect this scope closes.
	for _, terminal := range []types.JobStatus{types.JobStatusSuccess, types.JobStatusFailed, types.JobStatusCancelled} {
		if containsFold(cancellableJobScope.Values, string(terminal)) {
			t.Errorf("%s is terminal and the control plane refuses to cancel it", terminal)
		}
	}
}

// TestJobScope_FieldLookupPanicsOnAnUnknownFlag pins the failure branch of the scope's field
// lookup. A nil field would make jobScope.keeps admit every job and jobScope.applies never fire —
// a scope that silently narrows nothing, which is the shape of every guard in this repo that
// reported green. It is a programming error, so it is a panic, at package init, where no test run
// can miss it.
func TestJobScope_FieldLookupPanicsOnAnUnknownFlag(t *testing.T) {
	defer func() {
		r := recover()
		if r == nil {
			t.Fatal("an unknown flag name returned quietly — a nil field is a scope that keeps every job")
		}
		if !strings.Contains(fmt.Sprint(r), "--since") {
			t.Errorf("the panic %v does not name the flag that could not be resolved", r)
		}
	}()
	_ = jobSelectorFieldByFlag("since")
}

// TestJobScope_DescribeIsUnchangedForCancel pins the message the generalisation had to preserve.
// Widening jobStatusScope into jobScope moved the word "job" from describe() into the Noun; a
// literal here is what makes that a decision rather than something that quietly drifted.
func TestJobScope_DescribeIsUnchangedForCancel(t *testing.T) {
	const want = "cancellable job (QUEUED, CLAIMED, PROCESSING)"
	if got := cancellableJobScope.describe(); got != want {
		t.Errorf("cancel scope describes itself as %q, want %q", got, want)
	}
}

// TestJobsSelector_CancelScopeSkipsTheTerminalNewest is the defect itself: unscoped, `--latest`
// takes the PLAN that finished a second ago; scoped, it takes the deploy that is still running.
// Both halves are asserted, so a scope that stopped applying could not pass by resolving "a job".
func TestJobsSelector_CancelScopeSkipsTheTerminalNewest(t *testing.T) {
	jobsSelectNoInput(t)

	unscoped := &jobsSelectLister{jobs: jobsCancelSample()}
	ref, err := resolveJob(unscoped, nil, jobSelector{latest: true})
	if err != nil {
		t.Fatalf("unscoped resolveJob: %v", err)
	}
	if ref.ID != "job-plan-done" {
		t.Fatalf("unscoped --latest resolved %q, want job-plan-done — the fixture no longer poses the problem", ref.ID)
	}

	scoped := &jobsSelectLister{jobs: jobsCancelSample()}
	ref, err = resolveJobIn(scoped, nil, jobSelector{latest: true}, cancellableJobScope)
	if err != nil {
		t.Fatalf("cancel-scoped resolveJob: %v", err)
	}
	if ref.ID != "job-deploy-running" {
		t.Errorf("cancel --latest resolved %q, want job-deploy-running — the newest job the server would accept", ref.ID)
	}
}

// TestJobsSelector_CancelScopeYieldsToAnExplicitStatus pins the escape hatch. A status the
// operator typed is theirs: answering "no such job" for one they can see in `jobs list` would be
// the CLI lying about the server's contents rather than reporting its refusal.
func TestJobsSelector_CancelScopeYieldsToAnExplicitStatus(t *testing.T) {
	jobsSelectNoInput(t)
	f := &jobsSelectLister{jobs: jobsCancelSample()}
	ref, err := resolveJobIn(f, nil, jobSelector{latest: true, status: "SUCCESS"}, cancellableJobScope)
	if err != nil {
		t.Fatalf("resolveJobIn --status SUCCESS: %v", err)
	}
	if ref.ID != "job-plan-done" {
		t.Errorf("--status SUCCESS resolved %q, want job-plan-done — the scope overrode an explicit status", ref.ID)
	}
}

// TestJobsSelector_CancelScopeNamesItselfWhenNothingMatches pins the empty answer. "no job" would
// be false — there are jobs, none of them cancellable — and sends the reader looking for a job
// that is right there in `jobs list`.
func TestJobsSelector_CancelScopeNamesItselfWhenNothingMatches(t *testing.T) {
	jobsSelectNoInput(t)
	terminalOnly := []api.ProvisionJob{{
		ID: "job-plan-done", JobType: string(types.JobTypePlan), Status: string(types.JobStatusSuccess),
		ProjectID: "p-web-0001", ProjectName: "web", CreatedAt: time.Date(2026, 3, 9, 12, 0, 0, 0, time.UTC),
	}}
	f := &jobsSelectLister{jobs: terminalOnly}
	_, err := resolveJobIn(f, nil, jobSelector{latest: true}, cancellableJobScope)
	if err == nil {
		t.Fatal("a page of terminal jobs resolved a cancel target")
	}
	for _, want := range append([]string{cancellableJobScope.Noun}, cancellableJobScope.Values...) {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("the refusal %q does not name %q", err, want)
		}
	}
}

// TestJobsCancel_ResolvesInsideTheCancellableScope reads the wiring back off the real command, so
// a `cancel` that went back to the unscoped resolver fails here rather than in an operator's
// terminal. The scope lives in the Long help too, because a flag's behaviour that only the source
// states is one an operator cannot check.
func TestJobsCancel_ResolvesInsideTheCancellableScope(t *testing.T) {
	for _, want := range cancellableJobScope.Values {
		if !strings.Contains(jobsCancelCmd.Long, want) {
			t.Errorf("`jobs cancel --help` does not say that %s is in the set --latest considers", want)
		}
	}
	if !strings.Contains(jobsCancelCmd.Long, "stderr") {
		t.Error("`jobs cancel --help` does not name the stream the resolved job is announced on")
	}
	if strings.Contains(jobsCancelCmd.Long, "stdout") {
		t.Error("`jobs cancel --help` says stdout; announceResolvedJob writes to stderr")
	}
}

// jobsDocsCapsToken matches a SHOUTED word, which is how the docs render an enum value.
var jobsDocsCapsToken = regexp.MustCompile(`[A-Z][A-Z_]{2,}`)

// TestJobsSelector_DocsRenderTheStatusVocabularyOnce guards the one rendering of
// provision_job_status the docs are allowed to hand-write.
//
// The flag table above is checked by name only, so a hand-listed vocabulary in it was the one
// projection of the enum that nothing covered: add a status to `enums.ts` and `--help`,
// `validate()` and the refusal message all pick it up from `jobStatusValues()` while the docs go
// on listing six. This asserts the page enumerates the statuses in exactly one place and that the
// place names every generated value — every other mention must point at it.
func TestJobsSelector_DocsRenderTheStatusVocabularyOnce(t *testing.T) {
	raw, err := os.ReadFile(jobsDocsPath)
	if err != nil {
		t.Fatalf("reading %s: %v", jobsDocsPath, err)
	}
	statuses := jobStatusValues()
	if len(statuses) < 2 {
		t.Fatal("the generated enum has fewer than two statuses — this test would cover nothing")
	}

	enumerating := 0
	for i, line := range strings.Split(string(raw), "\n") {
		named := map[string]bool{}
		for _, tok := range jobsDocsCapsToken.FindAllString(line, -1) {
			if containsFold(statuses, tok) {
				named[strings.ToUpper(tok)] = true
			}
		}
		// One status is prose — "sets the job status to CANCELLED", a sample row. Two or more is
		// a vocabulary, and a vocabulary is what stops covering the enum silently.
		if len(named) < 2 {
			continue
		}
		enumerating++
		if len(named) != len(statuses) {
			t.Errorf("%s:%d enumerates %d of the %d provision_job_status values: %s",
				jobsDocsPath, i+1, len(named), len(statuses), strings.TrimSpace(line))
		}
	}
	if enumerating == 0 {
		t.Fatalf("%s enumerates the statuses nowhere — the reader is never told what they are", jobsDocsPath)
	}
	if enumerating != 1 {
		t.Errorf("%s enumerates provision_job_status on %d lines — a second hand-written copy is one the enum can outgrow silently; point it at the lifecycle instead",
			jobsDocsPath, enumerating)
	}
}
