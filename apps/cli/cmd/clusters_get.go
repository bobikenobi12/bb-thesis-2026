// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/format"
	"github.com/charmbracelet/huh"
	"github.com/spf13/cobra"
)

// The ArgoCD admin password is never stored by Alethia (it would be plaintext in the
// control-plane DB); it is retrieved on demand from the cluster's initial-admin secret.
// The console surfaces this same command — the CLI mirrors it so access is keyless from
// either surface.
const argocdAdminPasswordCmd = "kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d"

var clusterGetCmd = &cobra.Command{
	Use:   "get [selector]",
	Short: "Get a project's cluster, including ArgoCD access",
	Long: `Show a single project's cluster: status, node sizing, region, cost, and its
ArgoCD (cluster-side GitOps) endpoint plus the command to retrieve the admin password.

The selector matches by project name, cluster name, or id. Omit it at a terminal and the CLI
asks which cluster; pass it (or --no-input) and nothing is asked. A selector that names no
cluster is an error, not an empty screen.`,
	Args: cobra.MaximumNArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		var query string
		if len(args) == 1 {
			query = args[0]
		}

		token, err := getAuthToken()
		if err != nil {
			fail(err)
			return
		}

		apiClient := api.NewClient(token)
		var clusters []api.ClusterSummary
		runSpinner("Fetching clusters...", func() {
			clusters, err = apiClient.GetClusters()
		})
		if err != nil {
			failf("Failed to fetch clusters: %v", err)
			return
		}

		c, err := resolveCluster(clusters, query)
		if err != nil {
			fail(err)
			return
		}

		// Best-effort GitOps posture — legibility, not fail-closed: if the detail read
		// fails we still render the cluster (without the GitOps line).
		var gitops *api.ClusterGitops
		if detail, derr := apiClient.GetCluster(c.ID); derr == nil && detail != nil {
			gitops = detail.Gitops
		}

		if err := renderCluster(os.Stdout, outputFormat(cmd), c, gitops); err != nil {
			fail(err)
		}
	},
}

// errNoClusters is the answer when the org has no clusters at all.
//
// It is a different statement from "your selector matched nothing", and it has a different next
// step — provision a project environment, rather than re-type a name — so it is a different error.
var errNoClusters = errors.New("no clusters found — create a project with a cluster through Alethia")

// clusterLabel is the one human name for a cluster: its project, and the environment when the
// project has more than the default one.
//
// One rule, one place. The card title, the picker options and the candidate list in an error all
// call it, so a cluster cannot be called two things by two parts of the same command.
func clusterLabel(c api.ClusterSummary) string {
	if c.Environment == "" {
		return c.ProjectName
	}
	return c.ProjectName + " (" + c.Environment + ")"
}

// clusterSelector is the value from a cluster that the selector grammar accepts AND that names
// exactly one cluster: the cluster name, falling back to the id when the name is empty.
//
// clusterLabel is deliberately NOT that value. It renders `web (production)`, which reads well and
// matches nothing — clusterMatches compares against the project name, the cluster name and the id
// only. An error that offered labels alone answered "which one did you mean?" with the one set of
// strings guaranteed to fail on the next attempt.
func clusterSelector(c api.ClusterSummary) string {
	if c.ClusterName != "" {
		return c.ClusterName
	}
	return c.ID
}

// clusterChoices renders the candidates an error has to list: the human label, then in brackets
// the value to re-run with. Both halves earn their place — the label is how the reader recognises
// the cluster they meant, the selector is what the command will actually take.
func clusterChoices(clusters []api.ClusterSummary) string {
	choices := make([]string, len(clusters))
	for i := range clusters {
		choices[i] = clusterLabel(clusters[i]) + " [" + clusterSelector(clusters[i]) + "]"
	}
	return strings.Join(choices, ", ")
}

// clusterMatches returns EVERY cluster a selector names: the exact matches on project name,
// cluster name or id when there are any, and otherwise the project-name substring matches.
//
// It returns a set rather than the first hit because a selector is genuinely ambiguous in the
// ordinary case: one project with a production and a staging environment has two clusters and the
// same project name on both. The previous matcher returned whichever came back first from the API,
// so `alethia cluster get web` showed a cluster the user did not choose and never said so.
//
// An empty selector matches NOTHING rather than everything — absent input is the "ask me" signal,
// and treating it as a wildcard would make `alethia cluster get ""` silently show an arbitrary
// cluster.
func clusterMatches(clusters []api.ClusterSummary, query string) []api.ClusterSummary {
	q := strings.ToLower(strings.TrimSpace(query))
	if q == "" {
		return nil
	}
	var exact, partial []api.ClusterSummary
	for _, c := range clusters {
		switch {
		case strings.ToLower(c.ProjectName) == q ||
			strings.ToLower(c.ClusterName) == q ||
			strings.ToLower(c.ID) == q:
			exact = append(exact, c)
		case strings.Contains(strings.ToLower(c.ProjectName), q):
			partial = append(partial, c)
		}
	}
	if len(exact) > 0 {
		return exact
	}
	return partial
}

// resolveCluster decides WHICH cluster `cluster get` shows, asking when it cannot know.
//
// Every arm returns either a cluster or an error. What this replaced printed a muted "No cluster
// found for project: x" and returned — so `alethia cluster get typo` exited 0 having shown
// nothing, and a script could not tell a typo from a cluster that is fine.
func resolveCluster(clusters []api.ClusterSummary, query string) (*api.ClusterSummary, error) {
	if len(clusters) == 0 {
		return nil, errNoClusters
	}
	if strings.TrimSpace(query) == "" {
		return pickCluster(clusters, "Which cluster?")
	}

	matches := clusterMatches(clusters, query)
	switch len(matches) {
	case 0:
		return nil, fmt.Errorf("no cluster matches %q — have: %s", query, clusterChoices(clusters))
	case 1:
		return &matches[0], nil
	}

	// Ambiguous. With prompting off the only safe answer is to refuse and name the candidates:
	// picking one would be picking FOR the caller, which is the defect above wearing a new hat.
	if !canPromptForm() {
		return nil, fmt.Errorf(
			"%q matches %d clusters (%s) — re-run with one of the bracketed names or ids",
			query, len(matches), clusterChoices(matches),
		)
	}
	return pickCluster(matches, fmt.Sprintf("Which %q cluster?", query))
}

// pickCluster asks which cluster, from the candidates it is given.
//
// The selection is an INDEX, not an id, and it starts at 0. Both halves of that are deliberate:
// at a terminal the first option is pre-selected, so a single cluster needs one keystroke rather
// than a hunt; and every value huh can write is a valid index, so there is no "selected something
// that is not in the list" arm to leave unreachable and untested. huh writes the answer through a
// pointer no test stub can reach, so a stubbed form yields the default — which is a real cluster.
func pickCluster(clusters []api.ClusterSummary, title string) (*api.ClusterSummary, error) {
	// Form, not table: the gate is requireInteractiveForm, which also requires a terminal on the
	// stream a form draws on — STDERR, not stdout (ui.InteractiveOutput records the measurement).
	// `alethia cluster get 2> err.log` from an interactive shell has a TTY stdin and no screen to
	// draw on, so the frames land in the log and the command waits for a keystroke nobody sees.
	if err := requireInteractiveForm(); err != nil {
		return nil, err
	}

	options := make([]huh.Option[int], len(clusters))
	for i := range clusters {
		label := ui.PlainGlyph(clusters[i].Status) + " " + clusterLabel(clusters[i])
		if clusters[i].ClusterName != "" {
			label += " " + ui.SymbolBullet + " " + clusters[i].ClusterName
		}
		options[i] = huh.NewOption(label, i)
	}

	chosen := 0
	if err := runHuhForm(
		huh.NewGroup(
			huh.NewSelect[int]().
				Title(title).
				Description("Matched by project name, cluster name or id").
				Options(options...).
				Value(&chosen),
		),
	); err != nil {
		return nil, err
	}
	return &clusters[chosen], nil
}

// renderCluster writes a single cluster to out: a bordered KV card for table format,
// the typed object for json, Field/Value rows for csv.
// The parameter is `outFormat`, not `format`: this file imports packages/core/format, and a
// parameter of that name shadows the package for the whole body.
func renderCluster(out io.Writer, outFormat string, c *api.ClusterSummary, g *api.ClusterGitops) error {
	// json/csv emit the cluster fields inline plus the gitops object; table gets the card.
	record := any(c)
	if g != nil {
		record = struct {
			*api.ClusterSummary
			Gitops *api.ClusterGitops `json:"gitops"`
		}{c, g}
	}
	return ui.RenderCard(out, outFormat, clusterLabel(*c), clusterFieldRows(c, g, outFormat), record)
}

// clusterFieldRows returns the present-only key/value fields of a cluster, ending with
// the ArgoCD access block + GitOps posture when the cluster is provisioned.
func clusterFieldRows(c *api.ClusterSummary, g *api.ClusterGitops, outFmt string) [][]string {
	rows := [][]string{
		{"Status", ui.Cell(outFmt, c.Status, ui.StatusCell(c.Status))},
	}
	if c.StatusMessage != "" {
		rows = append(rows, []string{"Message", c.StatusMessage})
	}
	if c.ClusterName != "" {
		rows = append(rows, []string{"Cluster", c.ClusterName})
	}
	if c.ClusterVersion != "" {
		rows = append(rows, []string{"Version", ui.Cell(outFmt, c.ClusterVersion, "K8s "+c.ClusterVersion)})
	}
	if c.Region != "" {
		rows = append(rows, []string{"Region", c.Region})
	}
	rows = append(rows, []string{"Nodes", fmt.Sprintf("%d / %d / %d  (min/desired/max)", c.NodeMinSize, c.NodeDesiredSize, c.NodeMaxSize)})
	if c.EstimatedMonthlyCost != nil {
		rows = append(rows, []string{"Est. cost", clusterCost(*c.EstimatedMonthlyCost)})
	}

	// ArgoCD — the cluster-side GitOps CD, installed on every provisioned cluster. The URL
	// only materialises where a managed ingress exists (AWS ALB+ACM today); elsewhere access
	// is via port-forward. The admin password is retrieved on demand (never stored).
	if c.ClusterName != "" {
		if c.ArgocdURL != "" {
			rows = append(rows, []string{"ArgoCD", c.ArgocdURL})
		} else {
			rows = append(rows, []string{"ArgoCD", "installed — port-forward (no managed ingress on this cloud yet)"})
		}
		rows = append(rows, []string{"ArgoCD admin", argocdAdminPasswordCmd})
		if g != nil {
			rows = append(rows, gitopsRows(g)...)
		}
	}
	return rows
}

// clusterCost renders an estimated monthly cost the way the console's billing surfaces do.
//
// It is `format.MonthlyRate`, not a Sprintf, and the difference is money. `fmt.Sprintf("$%.0f/mo",
// 12.5)` renders `$12` — Go's %f rounds half to EVEN — while the console shows `$12.50`, so the
// terminal and the billing page disagreed about the same figure. `format.MonthlyRate` is held to
// the conformance table in packages/format/conformance/format-cases.json, which the console's
// `formatMonthlyRate` generates and is tested against; agreeing with it IS agreeing with the
// console.
//
// The `estimate` register, because that is what the console passes for the same number
// (`formatMonthlyRate(counts.data.estimatedMonthlyCost)` defaults to it) and because a projection
// under a dollar must read `<$1/mo` rather than round to a figure that looks like free.
func clusterCost(amount float64) string {
	return format.MonthlyRate(amount, format.Estimate, clusterCostCurrency)
}

// gitopsRows renders the compact GitOps posture: a failure banner, an "unknown" note when
// no trustworthy snapshot exists, or a synced/healthy summary with the deployed revision.
func gitopsRows(g *api.ClusterGitops) [][]string {
	var line string
	switch {
	case g.LastDeployFailed && g.FailedStep != nil && *g.FailedStep != "":
		line = "failed at " + *g.FailedStep
		if g.FailureMessage != nil && *g.FailureMessage != "" {
			line += " — " + *g.FailureMessage
		}
	case !g.StatusAvailable:
		line = "unknown (no snapshot yet)"
	default:
		line = fmt.Sprintf("%d/%d synced · %d/%d healthy", g.Synced, g.Total, g.Healthy, g.Total)
		if g.Revision != nil && *g.Revision != "" {
			rev := *g.Revision
			if len(rev) > 7 {
				rev = rev[:7]
			}
			line += " · rev " + rev
		}
	}
	rows := [][]string{{"GitOps", line}}
	if g.AppsRepo != nil && *g.AppsRepo != "" {
		rows = append(rows, []string{"Apps repo", *g.AppsRepo})
	}
	return rows
}

func init() {
	clusterCmd.AddCommand(clusterGetCmd)
}
