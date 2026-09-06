// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"sort"
	"strings"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/runners"
	"github.com/charmbracelet/huh"
	"github.com/spf13/cobra"
)

var runnerCmd = &cobra.Command{
	Use:   "runner",
	Short: "Manage runners",
	Long: `Runners execute infrastructure jobs.

Use the subcommands to list, deploy, register, destroy, or remove runners.`,
}

func init() {
	rootCmd.AddCommand(runnerCmd)
}

// runnerLister is the slice of the API client the runner-group resolvers need — kept small so
// resolution is unit-testable with a fake (the concrete *api.Client satisfies it), and so the
// group needs no edit to the shared apiClient interface.
type runnerLister interface {
	GetRunners() ([]api.Runner, error)
}

// resolveRunnerRef maps a runner reference — its NAME or its id — to the id the API wants.
// An empty ref returns empty, so the caller's own "then ask" arm runs.
//
// This is the handoff removal for the group. Every runner command used to take an opaque id a
// reader had to copy out of `alethia runner list`, which is the manual step this programme
// exists to delete; a name is what the operator already knows.
//
// An id is never RESHAPED — the value returned is the listed runner's own `ID` field, byte for
// byte — and both failure modes are loud:
//
//   - no match lists the names that do exist, so a typo is a correction and not a server 404;
//   - two matches is a hard error naming both ids. Nothing stops two runners sharing a name,
//     and the callers of this function DESTROY and REMOVE what it returns. Choosing the first
//     match would tear down a plausible, wrong runner and report success.
//
// flag names the flag being resolved, because the same resolver serves `--runner` and
// `--assigned-runner` and "runner %q not found" alone does not say which one was wrong.
func resolveRunnerRef(c runnerLister, flag, ref string) (string, error) {
	if ref == "" {
		return "", nil
	}
	list, err := c.GetRunners()
	if err != nil {
		return "", fmt.Errorf("resolve %s %q: %w", flag, ref, err)
	}
	var matches []api.Runner
	for _, r := range list {
		if r.ID == ref {
			return r.ID, nil
		}
		if r.Name == ref {
			matches = append(matches, r)
		}
	}
	switch len(matches) {
	case 1:
		return matches[0].ID, nil
	case 0:
		return "", fmt.Errorf("%s: no runner named %q (have: %s)", flag, ref, knownRunnerNames(list))
	default:
		ids := make([]string, len(matches))
		for i, m := range matches {
			ids[i] = m.ID
		}
		sort.Strings(ids)
		return "", fmt.Errorf(
			"%s: runner name %q is ambiguous — %d runners share it (%s). Pass the id instead",
			flag, ref, len(matches), strings.Join(ids, ", "))
	}
}

// knownRunnerNames renders the runner names a resolution failure should offer, sorted and
// de-duplicated so a name shared by two runners is offered once.
func knownRunnerNames(list []api.Runner) string {
	seen := map[string]bool{}
	names := make([]string, 0, len(list))
	for _, r := range list {
		if r.Name == "" || seen[r.Name] {
			continue
		}
		seen[r.Name] = true
		names = append(names, r.Name)
	}
	if len(names) == 0 {
		return "none — deploy one with `alethia runner deploy`, or register one with `alethia runner register`"
	}
	sort.Strings(names)
	return strings.Join(names, ", ")
}

// runnerIDFrom resolves the runner a command acts on from the PAIR of inputs that name it.
//
// TWO inputs for one field, which needs its reason stated — the same reason jobProjectFlags
// records for `--project` / `--project-id`. The id form is what these commands have always
// taken and scripts pass it; removing it for a tidier surface would break them. The ref form
// is the one a person uses, takes the name, and is what the docs now show.
//
// Passing both is an ERROR and not a precedence rule. They name the same field, so a caller who
// set both either believes one is being ignored or has an unnoticed leak from a wrapper script —
// and the command they are calling is `destroy`. Silently preferring one would let the wrong
// belief survive until it had torn down the other runner.
func runnerIDFrom(c runnerLister, ref, id, refFlag, idFlag string) (string, error) {
	if ref != "" && id != "" {
		return "", fmt.Errorf("%s and %s both name the runner: pass one (%s takes the name or the id)",
			refFlag, idFlag, refFlag)
	}
	if ref != "" {
		return resolveRunnerRef(c, refFlag, ref)
	}
	return id, nil
}

// runnerDeployIdentityID resolves the cloud account a deploy targets, from the same pair shape:
// a LABEL-or-id ref, or the raw id form scripts already pass.
//
// The ref form is narrowed to the clouds a runner can actually be built into — the same
// narrowing selectRunnerDeployCloudIdentity applies to the picker. A flag path that skipped it
// would make the two halves of one field disagree: the picker cannot offer a GCP account and
// the flag would have accepted one, so the refusal would arrive from the server instead of from
// the command line that is already wrong. The raw id form is passed through unresolved, exactly
// as `--project-id` is, and stays the server's to reject.
func runnerDeployIdentityID(c cloudIdentityLister, ref, id string) (string, error) {
	if ref != "" && id != "" {
		return "", fmt.Errorf(
			"--cloud-account and --cloud-identity-id both name the cloud account: pass one " +
				"(--cloud-account takes the label or the id)")
	}
	if ref == "" {
		return id, nil
	}
	identities, err := c.GetCloudIdentities()
	if err != nil {
		return "", fmt.Errorf("resolve --cloud-account %q: %w", ref, err)
	}
	deployable := runners.FilterDeployable(identities)
	var matches []api.CloudIdentity
	for _, cid := range deployable {
		if cid.ID == ref {
			return cid.ID, nil
		}
		if cid.Label == ref {
			matches = append(matches, cid)
		}
	}
	switch len(matches) {
	case 1:
		return matches[0].ID, nil
	case 0:
		// Naming the two lists separately is the whole value of the message: "you have no such
		// account" and "you have that account and a runner cannot be built into it" have
		// different next steps, and only the second one points at `runner register`.
		for _, cid := range identities {
			if cid.ID == ref || cid.Label == ref {
				return "", fmt.Errorf("cloud account %q: %s", ref, runners.UnsupportedMessage(cid.Provider))
			}
		}
		return "", fmt.Errorf("cloud account %q not found (deployable: %s)",
			ref, knownDeployableLabels(deployable))
	default:
		ids := make([]string, len(matches))
		for i, m := range matches {
			ids[i] = m.ID
		}
		sort.Strings(ids)
		return "", fmt.Errorf(
			"cloud account label %q is ambiguous — %d accounts share it (%s). Pass the id instead",
			ref, len(matches), strings.Join(ids, ", "))
	}
}

// knownDeployableLabels renders the labels a deploy can actually target.
func knownDeployableLabels(identities []api.CloudIdentity) string {
	if len(identities) == 0 {
		return fmt.Sprintf("none — a deployed runner needs %s, so use `alethia runner register` instead",
			runners.DeployProvidersLabel())
	}
	labels := make([]string, 0, len(identities))
	for _, id := range identities {
		labels = append(labels, id.Label)
	}
	sort.Strings(labels)
	return strings.Join(labels, ", ")
}

// runnerAskOrDefault fills one optional free-text field: it asks on a terminal, and under
// --no-input takes the default WITHOUT opening a form.
//
// The second half is the fix. `runner deploy --no-input` reached huh for the name and the
// region even though both have a default, and huh answered `could not open a new TTY` — so a
// command whose every field had a default could not be scripted at all. Taking the default is
// what pressing Enter through the form already does, so the two paths now agree; the default is
// announced rather than applied silently, because a region chosen for you is a region you must
// be able to see in a CI log.
func runnerAskOrDefault(target *string, title, description, def string) error {
	if *target != "" {
		return nil
	}
	if !canPromptForm() {
		*target = def
		ui.Muted(fmt.Sprintf("%s: %s (default)", title, def))
		return nil
	}
	if err := runHuhForm(
		huh.NewGroup(
			huh.NewInput().
				Title(title).
				Description(description).
				Value(target).
				Placeholder(def),
		),
	); err != nil {
		return err
	}
	if *target == "" {
		*target = def
	}
	return nil
}
