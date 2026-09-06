// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The BYO (bring-your-own) WRITE commands: attach, detach and scan your own Helm charts and your own
// Terraform/OpenTofu source. Both surfaces were read-only from the CLI — you could see what was
// attached and never attach anything — so a repeatable or CI-driven flow had to stop at the console
// exactly where the customer's own code enters the picture.

package cmd

import (
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/spf13/cobra"
)

var (
	chartAttachRepo       string
	chartAttachPath       string
	chartAttachRef        string
	chartAttachNamespace  string
	chartAttachValuesFile string
	chartAttachSet        []string
	chartDetachYes        bool

	iacAttachRepo string
	iacAttachRef  string
	iacAttachPath string
	iacAttachVar  []string
	iacDetachYes  bool
)

// readChartValuesFile reads the raw Helm-values override, or returns "" when no file was named. The
// content is NOT parsed here: the server validates it as a YAML mapping through the same action the
// console uses, so a local pre-parse would be a second opinion that can disagree with the one that
// decides.
func readChartValuesFile(path string) (string, error) {
	if path == "" {
		return "", nil
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("read --values-file: %w", err)
	}
	return string(raw), nil
}

// --- charts ---

var chartAttachCmd = &cobra.Command{
	Use:   "attach [id]",
	Short: "Attach (or update) your own Helm chart in an environment",
	Args:  cobra.MaximumNArgs(1),
	Long: `Attaches a chart from your own repository — git or OCI — to one environment.

  git:  --repo https://github.com/acme/charts --chart-path charts/api
  OCI:  --repo oci://registry.example.com/acme/api

A git chart needs --chart-path; an OCI chart is named by the URL's last segment and does not.
The chart is not deployable until it has been scanned — "alethia chart scan" follows.

Omit a value on a terminal and you are asked for it, and the repository is CHOSEN from the ones
Alethia can already see rather than copied out of "alethia repo list". Every question has a flag,
so the same attach runs unattended; the run prints the flags that would have produced it.

Re-attaching the same id UPDATES it, so this is also how you move a chart to a new ref.

A PRIVATE repository needs no credential here. The runner fetches a short-lived token at job
time from your linked GitHub/GitLab account, scoped to the repositories this project declares.
Link that account once in the console; nothing is stored against the chart.`,
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		outFmt := outputFormat(cmd)
		mayAsk := interactiveTable(cmd)
		project, err := byoProject(cmd, token, mayAsk)
		if err != nil {
			fail(err)
		}
		env, _ := cmd.Flags().GetString("env")
		values, err := parseSetValues(chartAttachSet)
		if err != nil {
			fail(err)
		}
		valuesYAML, err := readChartValuesFile(chartAttachValuesFile)
		if err != nil {
			fail(err)
		}
		client := api.NewClient(token)
		p := api.AttachChartParams{
			Project: project, Env: env, ID: firstArg(args),
			RepoURL: chartAttachRepo, ChartPath: chartAttachPath, Ref: chartAttachRef,
			Namespace: chartAttachNamespace, ValuesYAML: valuesYAML,
			Values: values,
		}
		p, asked, err := askChartAttach(p, client.GetRepositories, mayAsk)
		if err != nil {
			fail(err)
		}
		if err := runChartAttach(client, os.Stdout, p); err != nil {
			failf("Failed to attach chart: %v", err)
		}
		printReplay(os.Stdout, outFmt, asked, chartAttachReplayArgs(p)...)
	},
}

// firstArg returns the single optional positional, or "".
//
// Every leaf in this group that took a mandatory id now takes an optional one, and each of them
// reached for args[0] behind an ExactArgs(1) that no longer holds.
func firstArg(args []string) string {
	if len(args) == 0 {
		return ""
	}
	return strings.TrimSpace(args[0])
}

// askChartAttach fills in whatever `chart attach` was not told, and reports whether it asked.
//
// Only MISSING values are asked for: a flag that was passed is never re-questioned, so a partly
// scripted invocation stays scripted for the parts it specified. `mayAsk` false leaves the params
// exactly as the flags set them, which is what makes the --no-input behaviour byte-identical to
// what it was before this form existed — runChartAttach still refuses the empty required ones and
// names them.
//
// --chart-path is asked for GIT repositories only, the rule this command's help has always stated:
// an OCI chart is named by its URL's last segment and a path there is ignored. That is a decision
// about which QUESTION to put, never a refusal — an OCI URL with a path still reaches the server,
// which owns that verdict.
//
// --values-file and --set are deliberately NOT asked. A filesystem path and a repeatable, JSON-typed
// key=value are poor single-line questions, and neither is required to attach a chart; both stay
// flags, and the replay line carries them when they were used.
func askChartAttach(p api.AttachChartParams, list repoLister, mayAsk bool) (api.AttachChartParams, bool, error) {
	if !mayAsk {
		return p, false, nil
	}
	asked := false
	if p.ID == "" {
		f := mustByoField("alethia chart attach", byoKeyChartID)
		v, err := askLine(f.Title, f.Description)
		if err != nil {
			return p, asked, err
		}
		p.ID, asked = v, true
	}
	if p.RepoURL == "" {
		f := mustByoField("alethia chart attach", byoKeyRepo)
		v, err := promptRepoURL(list, f)
		if err != nil {
			return p, asked, err
		}
		p.RepoURL, asked = strings.TrimSpace(v), true
	}
	if p.ChartPath == "" && !isOCIRepo(p.RepoURL) {
		f := mustByoField("alethia chart attach", byoKeyChartPath)
		v, err := askLine(f.Title, f.Description)
		if err != nil {
			return p, asked, err
		}
		p.ChartPath, asked = v, true
	}
	for _, q := range []struct {
		key string
		dst *string
	}{
		{byoKeyRef, &p.Ref},
		{byoKeyNamespace, &p.Namespace},
	} {
		if *q.dst != "" {
			continue
		}
		f := mustByoField("alethia chart attach", q.key)
		v, err := askLine(f.Title, f.Description)
		if err != nil {
			return p, asked, err
		}
		*q.dst, asked = v, true
	}
	return p, asked, nil
}

// isOCIRepo reports whether a repository reference is an OCI registry URL.
//
// Lower-cased before the compare because a scheme is case-insensitive and `OCI://` is the same
// registry. This decides which question to ask and nothing else; it is not a grammar the CLI
// enforces against the server's.
func isOCIRepo(repo string) bool {
	return strings.HasPrefix(strings.ToLower(strings.TrimSpace(repo)), "oci://")
}

// chartAttachReplayArgs renders the flags that reproduce an attach without the questions.
//
// It is built from the RESOLVED params rather than from the flags, which is what keeps "flags are a
// complete contract" honest rather than aspirational: a value the form can produce and the line
// cannot express would show up here as a missing flag.
func chartAttachReplayArgs(p api.AttachChartParams) []string {
	args := []string{"alethia", "chart", "attach"}
	if p.ID != "" {
		args = append(args, p.ID)
	}
	for _, kv := range [][2]string{
		{"--project", p.Project},
		{"--env", p.Env},
		{"--repo", p.RepoURL},
		{"--chart-path", p.ChartPath},
		{"--ref", p.Ref},
		{"--namespace", p.Namespace},
	} {
		if kv[1] != "" {
			args = append(args, kv[0], kv[1])
		}
	}
	// --values-file, not the YAML it held: the replay line is a command someone runs again, and the
	// file is what they would edit. --set is rendered per pair, the way it was typed.
	if chartAttachValuesFile != "" {
		args = append(args, "--values-file", chartAttachValuesFile)
	}
	for _, set := range chartAttachSet {
		args = append(args, "--set", set)
	}
	return args
}

// runChartAttach attaches the chart and confirms it, echoing the id the SERVER stored — it slugifies
// what you send, and the next command you run needs the stored one.
func runChartAttach(c apiClient, out io.Writer, p api.AttachChartParams) error {
	// Named separately, because the caller reading this is writing a script and "both are
	// required" does not say which one they left out. Both are refused LOCALLY only because the
	// server certainly refuses them too — the CLI adds no rule of its own about their shape.
	var missing []string
	if p.ID == "" {
		missing = append(missing, "a chart id (the positional argument)")
	}
	if p.RepoURL == "" {
		missing = append(missing, "--repo")
	}
	if len(missing) > 0 {
		verb := "is"
		if len(missing) > 1 {
			verb = "are"
		}
		return fmt.Errorf("%s %s required (omit them on a terminal and you are asked)",
			strings.Join(missing, " and "), verb)
	}
	res, err := c.AttachChart(p)
	if err != nil {
		return err
	}
	id := p.ID
	if res != nil && res.ID != "" {
		id = res.ID
	}
	fmt.Fprintln(out, ui.FormatSuccess(fmt.Sprintf("Attached chart %s%s", id, envSuffix(p.Env))))
	fmt.Fprintln(out, ui.MutedStyle.Render(fmt.Sprintf("Scan it before deploying: alethia chart scan %s", id)))
	return nil
}

var chartDetachCmd = &cobra.Command{
	Use:   "detach [id]",
	Short: "Detach your own Helm chart from an environment",
	Args:  cobra.MaximumNArgs(1),
	Long: `Detaches one of your own Helm charts from an environment. Its workloads leave the cluster
on the next sync.

The id is optional: omit it on a terminal and the environment's attached charts are offered, so
nothing has to be copied out of "alethia chart list". The confirmation always NAMES the chart it
resolved to — a prompt about "this chart" is not a prompt anyone can answer when they did not type
an id. Scripts pass the id and --yes.`,
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		project, err := byoProject(cmd, token, interactiveTable(cmd))
		if err != nil {
			fail(err)
		}
		env, _ := cmd.Flags().GetString("env")
		client := api.NewClient(token)
		id, err := resolveChartID(client, firstArg(args), project, env, interactiveTable(cmd), byoKeyChartID, "alethia chart detach")
		if err != nil {
			fail(err)
		}
		// The chart is resolved BEFORE the confirmation so the question can name it. It is also why
		// the picker is not itself the confirmation: choosing which chart and agreeing to destroy it
		// are two answers, and a select that doubles as consent has no way to say no.
		if !confirmDestructive(chartDetachYes, fmt.Sprintf("Detach chart %s%s?", id, envSuffix(env)),
			"Its workloads are removed from the cluster on the next sync.") {
			return
		}
		if err := runChartDetach(client, os.Stdout, project, env, id); err != nil {
			failf("Failed to detach chart: %v", err)
		}
	},
}

// resolveChartID answers "which chart" from the positional argument or the environment's own list.
//
// An id on the command line is passed through BYTE FOR BYTE and no listing call is made for it: an
// id is a lookup key, and resolving one against a list would let a listing failure block a command
// that had already been told its answer.
//
// `mayAsk` false with no id is a refusal that names the argument, not a picker that cannot draw.
func resolveChartID(c apiClient, id, project, env string, mayAsk bool, key, command string) (string, error) {
	if id != "" {
		return id, nil
	}
	if !mayAsk {
		return "", fmt.Errorf("a chart id is required (pass it as the argument; on a terminal you are offered the attached charts)")
	}
	f := mustByoField(command, key)
	return promptChartID(func() (*api.ProjectByoCharts, error) {
		return c.GetProjectByoCharts(project, env)
	}, f, env)
}

// runChartDetach detaches the chart and confirms it.
func runChartDetach(c apiClient, out io.Writer, project, env, id string) error {
	if id == "" {
		return fmt.Errorf("a chart id is required")
	}
	if err := c.DetachChart(project, env, id); err != nil {
		return err
	}
	fmt.Fprintln(out, ui.FormatSuccess(fmt.Sprintf("Detached chart %s%s", id, envSuffix(env))))
	return nil
}

var chartScanCmd = &cobra.Command{
	Use:   "scan [id]",
	Short: "Scan an attached chart so it can be deployed",
	Args:  cobra.MaximumNArgs(1),
	Long: `Queues a scan of an attached chart. The scan renders it and records the verdict the
plan-time gate reads, so an unscanned chart is refused at deploy.

The id is optional: omit it on a terminal and the environment's attached charts are offered.

Re-scan whenever the chart's repository moves. Follow the queued scan with
"alethia jobs logs --latest --follow".`,
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		project, err := byoProject(cmd, token, interactiveTable(cmd))
		if err != nil {
			fail(err)
		}
		env, _ := cmd.Flags().GetString("env")
		client := api.NewClient(token)
		id, err := resolveChartID(client, firstArg(args), project, env, interactiveTable(cmd), byoKeyChartID, "alethia chart scan")
		if err != nil {
			fail(err)
		}
		if err := runChartScan(client, os.Stdout, project, env, id); err != nil {
			failf("Failed to scan chart: %v", err)
		}
	},
}

// runChartScan queues the scan and prints the job to follow.
func runChartScan(c apiClient, out io.Writer, project, env, id string) error {
	if id == "" {
		return fmt.Errorf("a chart id is required")
	}
	res, err := c.ScanChart(project, env, id)
	if err != nil {
		return err
	}
	printScanQueued(out, "chart "+id, env, res)
	return nil
}

// --- IaC ---

var iacAttachCmd = &cobra.Command{
	Use:   "attach",
	Short: "Attach your own Terraform/OpenTofu source to an environment",
	Long: `Attaches a git repository holding your own Terraform/OpenTofu to one environment.

  alethia iac attach -p shop -e dev --repo https://github.com/acme/infra --path iac/drift/aws

Omit a value on a terminal and you are asked for it, and the repository is CHOSEN from the ones
Alethia can already see rather than copied out of "alethia repo list". Every question has a flag,
so the same attach runs unattended; the run prints the flags that would have produced it.

An environment holds at most ONE source, so re-attaching replaces it. --var sets scalar tfvars
(string, number or bool only — never a secret; the server refuses anything nested).

The source is not deployable until scanned: run "alethia iac scan" next.

A PRIVATE repository needs no credential here. The runner fetches a short-lived token at job
time from your linked GitHub/GitLab account, scoped to the repositories this project declares.
Link that account once in the console; nothing is stored against the source.`,
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		outFmt := outputFormat(cmd)
		mayAsk := interactiveTable(cmd)
		project, err := byoProject(cmd, token, mayAsk)
		if err != nil {
			fail(err)
		}
		env, _ := cmd.Flags().GetString("env")
		vars, err := parseSetValues(iacAttachVar)
		if err != nil {
			fail(err)
		}
		client := api.NewClient(token)
		p := api.AttachIacParams{
			Project: project, Env: env, RepoURL: iacAttachRepo, Ref: iacAttachRef,
			Path: iacAttachPath, VarValues: vars,
		}
		p, asked, err := askIacAttach(p, client.GetRepositories, mayAsk)
		if err != nil {
			fail(err)
		}
		if err := runIacAttach(client, os.Stdout, p); err != nil {
			failf("Failed to attach IaC source: %v", err)
		}
		printReplay(os.Stdout, outFmt, asked, iacAttachReplayArgs(p)...)
	},
}

// askIacAttach fills in whatever `iac attach` was not told, and reports whether it asked.
//
// The same three rules as askChartAttach: only missing values are asked for, `mayAsk` false leaves
// the params exactly as the flags set them, and --var is not asked because a repeatable scalar
// key=value is a poor single-line question and is never required to attach a source.
//
// --path is asked with an EMPTY answer allowed, and that emptiness is meaningful: it is the
// repository root, which is what an unset --path has always meant. The question exists so a reader
// learns the field is there, not to make it mandatory.
func askIacAttach(p api.AttachIacParams, list repoLister, mayAsk bool) (api.AttachIacParams, bool, error) {
	if !mayAsk {
		return p, false, nil
	}
	asked := false
	if p.RepoURL == "" {
		f := mustByoField("alethia iac attach", byoKeyRepo)
		v, err := promptRepoURL(list, f)
		if err != nil {
			return p, asked, err
		}
		p.RepoURL, asked = strings.TrimSpace(v), true
	}
	for _, q := range []struct {
		key string
		dst *string
	}{
		{byoKeyPath, &p.Path},
		{byoKeyRef, &p.Ref},
	} {
		if *q.dst != "" {
			continue
		}
		f := mustByoField("alethia iac attach", q.key)
		v, err := askLine(f.Title, f.Description)
		if err != nil {
			return p, asked, err
		}
		*q.dst, asked = v, true
	}
	return p, asked, nil
}

// iacAttachReplayArgs renders the flags that reproduce an attach without the questions.
func iacAttachReplayArgs(p api.AttachIacParams) []string {
	args := []string{"alethia", "iac", "attach"}
	for _, kv := range [][2]string{
		{"--project", p.Project},
		{"--env", p.Env},
		{"--repo", p.RepoURL},
		{"--path", p.Path},
		{"--ref", p.Ref},
	} {
		if kv[1] != "" {
			args = append(args, kv[0], kv[1])
		}
	}
	for _, v := range iacAttachVar {
		args = append(args, "--var", v)
	}
	return args
}

// runIacAttach attaches the source and confirms it.
func runIacAttach(c apiClient, out io.Writer, p api.AttachIacParams) error {
	if p.RepoURL == "" {
		return fmt.Errorf("--repo is required")
	}
	if _, err := c.AttachIac(p); err != nil {
		return err
	}
	fmt.Fprintln(out, ui.FormatSuccess(fmt.Sprintf("Attached IaC source %s%s", p.RepoURL, envSuffix(p.Env))))
	fmt.Fprintln(out, ui.MutedStyle.Render("Scan it before deploying: alethia iac scan"))
	return nil
}

var iacDetachCmd = &cobra.Command{
	Use:   "detach",
	Short: "Detach the environment's Terraform/OpenTofu source",
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		project, err := byoProject(cmd, token, interactiveTable(cmd))
		if err != nil {
			fail(err)
		}
		env, _ := cmd.Flags().GetString("env")
		if !confirmDestructive(iacDetachYes, "Detach the IaC source"+envSuffix(env)+"?",
			"Alethia stops managing what it created. Resources it applied are NOT destroyed — run a destroy first if that is what you want.") {
			return
		}
		if err := runIacDetach(api.NewClient(token), os.Stdout, project, env); err != nil {
			failf("Failed to detach IaC source: %v", err)
		}
	},
}

// runIacDetach detaches the source and confirms it.
func runIacDetach(c apiClient, out io.Writer, project, env string) error {
	if err := c.DetachIac(project, env); err != nil {
		return err
	}
	fmt.Fprintln(out, ui.FormatSuccess("Detached the IaC source"+envSuffix(env)))
	return nil
}

var iacScanCmd = &cobra.Command{
	Use:   "scan",
	Short: "Scan the environment's IaC source so it can be deployed",
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		project, err := byoProject(cmd, token, interactiveTable(cmd))
		if err != nil {
			fail(err)
		}
		env, _ := cmd.Flags().GetString("env")
		if err := runIacScan(api.NewClient(token), os.Stdout, project, env); err != nil {
			failf("Failed to scan IaC source: %v", err)
		}
	},
}

// runIacScan queues the scan and prints the job to follow.
func runIacScan(c apiClient, out io.Writer, project, env string) error {
	res, err := c.ScanIac(project, env)
	if err != nil {
		return err
	}
	printScanQueued(out, "IaC source", env, res)
	return nil
}

// printScanQueued reports a queued scan and the command that follows it. A scan is asynchronous, so
// the job id is the useful part of the output — without it a caller has to go looking.
func printScanQueued(out io.Writer, what, env string, res *api.ByoScanResult) {
	fmt.Fprintln(out, ui.FormatSuccess(fmt.Sprintf("Queued a scan of the %s%s", what, envSuffix(env))))
	if res != nil && res.JobID != "" {
		fmt.Fprintf(out, "Job ID: %s\n", res.JobID)
	}
	// The follow-up names NO id. It used to be `alethia jobs logs <the id we just printed> --follow`,
	// which is a token the reader has to carry from one command to the next by hand — and the jobs
	// group has since grown `--latest`, which resolves the same job without one. The id itself stays
	// printed: a script that wants to poll a SPECIFIC job still needs it, and `--latest` is a
	// convenience for the terminal, not a substitute for a handle.
	fmt.Fprintln(out, ui.MutedStyle.Render("Follow it: alethia jobs logs --latest --follow"))
}

func init() {
	chartAttachCmd.Flags().StringVar(&chartAttachRepo, "repo", "", byoFlagUsage("alethia chart attach", byoKeyRepo))
	chartAttachCmd.Flags().StringVar(&chartAttachPath, "chart-path", "", byoFlagUsage("alethia chart attach", byoKeyChartPath))
	chartAttachCmd.Flags().StringVar(&chartAttachRef, "ref", "", byoFlagUsage("alethia chart attach", byoKeyRef))
	chartAttachCmd.Flags().StringVar(&chartAttachNamespace, "namespace", "", byoFlagUsage("alethia chart attach", byoKeyNamespace))
	chartAttachCmd.Flags().StringVar(&chartAttachValuesFile, "values-file", "", byoFlagUsage("alethia chart attach", byoKeyValuesFile))
	chartAttachCmd.Flags().StringArrayVar(&chartAttachSet, "set", nil, byoFlagUsage("alethia chart attach", byoKeySet))
	addYesFlag(chartDetachCmd, &chartDetachYes)
	chartCmd.AddCommand(chartAttachCmd, chartDetachCmd, chartScanCmd)

	iacAttachCmd.Flags().StringVar(&iacAttachRepo, "repo", "", byoFlagUsage("alethia iac attach", byoKeyRepo))
	iacAttachCmd.Flags().StringVar(&iacAttachRef, "ref", "", byoFlagUsage("alethia iac attach", byoKeyRef))
	iacAttachCmd.Flags().StringVar(&iacAttachPath, "path", "", byoFlagUsage("alethia iac attach", byoKeyPath))
	iacAttachCmd.Flags().StringArrayVar(&iacAttachVar, "var", nil, byoFlagUsage("alethia iac attach", byoKeyVar))
	addYesFlag(iacDetachCmd, &iacDetachYes)
	iacCmd.AddCommand(iacAttachCmd, iacDetachCmd, iacScanCmd)
}
