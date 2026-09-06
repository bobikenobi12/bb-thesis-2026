// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/spf13/cobra"
)

var (
	designApplyFile   string
	designApplyDryRun bool
	designApplyStage  bool
	// designApplyYes is the --yes opt-in. It is NOT a blanket "this command is destructive"
	// switch: see designApplyGate below for when it is consulted at all.
	designApplyYes bool
)

var projectDesignCmd = &cobra.Command{
	Use:   "design",
	Short: "Apply a whole environment design document",
	Long: `The declarative counterpart to "project component add".

The imperative commands are what you narrate one step at a time; a design document is what a
repository commits and CI replays. Both write the same tables.

  alethia config export -p shop > shop.json      # the document, as it is now
  alethia project design apply -f shop.json --dry-run
  alethia project design apply -f shop.json

An apply that only adds or updates runs unprompted, so CI can replay a document. One whose
plan REMOVES a component confirms first, and needs --yes under --no-input.`,
}

var projectDesignApplyCmd = &cobra.Command{
	Use:   "apply",
	Short: "Apply a design document to an environment",
	Long: `Apply a design document to one environment.

The gate is on the PLAN, not the invocation: an apply that only adds or updates runs
unprompted — a design document is what a repository commits and CI replays — while one whose
plan removes a component confirms first, and requires --yes with prompting disabled.`,
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		project, err := projectFromFlag(cmd, token)
		if err != nil {
			fail(err)
		}
		env, _ := cmd.Flags().GetString("env")
		file := designApplyFile
		if file == "" && promptsEnabled() {
			if file, err = promptDesignFile(); err != nil {
				fail(err)
			}
		}
		doc, err := readDesignDocument(file, os.Stdin)
		if err != nil {
			fail(err)
		}
		if designApplyDryRun && designApplyStage {
			failf("--dry-run and --stage are mutually exclusive: one writes nothing, the other writes to the review tray")
		}
		params := api.ApplyDesignParams{
			Project: project, Env: env, Document: doc,
			DryRun: designApplyDryRun, Stage: designApplyStage,
		}
		client := api.NewClient(token)

		// The gate runs only for a REAL apply. `--dry-run` writes nothing and `--stage` writes
		// to the review tray, where a person sees the removals before they take effect; a
		// confirmation in front of either would be asking about something that has not
		// happened yet and is not about to.
		if !designApplyDryRun && !designApplyStage {
			gate, err := designApplyGate(client, os.Stdout, params, designApplyYes)
			if err != nil {
				fail(err)
			}
			if gate == designApplyDeclined {
				return
			}
		}

		if err := runDesignApply(client, os.Stdout, params); err != nil {
			failf("Failed to apply the design: %v", err)
		}
	},
}

// ── the delete gate ─────────────────────────────────────────────────────────────────────
//
// MAINTAINER RULING: confirm only when the apply would DELETE.
//
// Both flat rules are defensible-looking and wrong in different directions. No gate at all
// leaves the one irreversible thing this command does — a kind the document omits is a kind
// the environment loses — happening silently. A gate on every apply breaks the workflow the
// command exists for: a design document is what a repository commits and CI replays, and a
// pipeline that adds a cache does not need a human in it.
//
// So the gate is on the PLAN, not on the invocation. What the caller typed does not decide
// it; what the apply would do decides it.
//
// That requires knowing the plan before writing, which the apply response cannot give — it
// arrives after the write. So a real apply issues its own `--dry-run` first and reads the
// changes off that. One extra round trip on a real apply, and in exchange the prompt can
// NAME what is about to go rather than asking in the abstract.
//
// The window between the preflight and the apply is real: another writer could change the
// environment in between, and then the apply deletes something the preflight did not report.
// It is the same window `--dry-run` then apply already had, and closing it needs a
// server-side plan token this endpoint does not have. Not pretended away — the preflight
// narrows the window from "whenever you last looked" to "milliseconds", which is the
// improvement actually available here.

// designApplyGate is the decision a real apply makes before it writes.
type designApplyGateResult int

const (
	// designApplyProceed: the plan removes nothing, or the caller confirmed.
	designApplyProceed designApplyGateResult = iota
	// designApplyDeclined: a person was asked and said no. A quiet no-op, not an error.
	designApplyDeclined
)

// designApplyGate decides whether a real apply may proceed, by asking the server what the
// apply would do and gating on the DELETE subset of the answer.
//
// FAILS CLOSED when the preflight cannot be read. A preflight that errors leaves us unable to
// say the apply is non-destructive, and the safe reading of "unknown" for an irreversible
// operation is "treat it as one" — with --yes as the escape hatch, so a caller who knows what
// they are doing is never stuck. This is the one place the gate consults something other than
// the plan, and it says so in the error.
func designApplyGate(c apiClient, out io.Writer, p api.ApplyDesignParams, yes bool) (designApplyGateResult, error) {
	preflight := p
	preflight.DryRun = true
	preflight.Stage = false

	res, err := c.ApplyDesign(preflight)
	if err != nil || res == nil {
		if yes {
			return designApplyProceed, nil
		}
		return designApplyDeclined, errDesignPreflightUnreadable(err)
	}

	deletes := designDeletions(res.Changes)
	if len(deletes) == 0 {
		// The ruling's main case: an add-only or update-only apply runs unprompted, which is
		// what CI replay needs. Nothing is printed here either — a pipeline log that gains a
		// paragraph per run is its own kind of regression.
		return designApplyProceed, nil
	}

	fmt.Fprintf(out, "This apply would DELETE %d component(s)%s:\n", len(deletes), envSuffix(p.Env))
	printDesignChanges(out, deletes)

	// Checked BEFORE confirmDestructive so the refusal can say why --yes is needed here. The
	// shared error names the contract; this one names the reason, which is what a pipeline
	// author has to understand before adding the flag.
	if !canPromptForm() && !yes {
		return designApplyDeclined, errDesignApplyWouldDelete(deletes)
	}
	if !confirmDestructive(yes, "Apply a design that REMOVES components?",
		describeDeletions(deletes)+" Other environments keep theirs; the cloud resources go on the next plan + apply.") {
		return designApplyDeclined, nil
	}
	return designApplyProceed, nil
}

// designNonRemovingActions is the CLOSED set of actions that leave every component standing.
//
// It mirrors `apps/console/lib/config-diff.ts`'s `type Op = "CREATE" | "UPDATE" | "DELETE"`, whose
// rows the design-apply route passes to `DesignChange.Action` verbatim. Two of the three are safe,
// so the safe set is what this names — and `api.DesignChange.Action` is a bare Go `string` against
// that closed TS union, which is why a drift here is a judgement call rather than a compile error.
var designNonRemovingActions = map[string]struct{}{"CREATE": {}, "UPDATE": {}}

// designDeletions returns the changes that REMOVE a component.
//
// IT ASKS WHICH ACTIONS ARE SAFE, NOT WHICH ONE IS "DELETE", and the direction is the whole point.
// An exact `EqualFold(action, "DELETE")` reads every other spelling as non-destructive, so a
// server that started sending `REMOVE`, `DELETE_ORPHAN` or `DETACH` — or one that sent an empty
// action because something upstream broke — would apply removals with no confirmation at all. The
// caller already fails CLOSED when it cannot read the preflight; failing OPEN on an action it does
// not recognise made the two halves of one gate disagree.
//
// The asymmetry of the two errors is what settles it. An unrecognised action costs at most a
// confirmation nobody needed, or — under --no-input — a refusal that NAMES the plan and the flag.
// The other direction costs a component, silently. So an action outside the safe set is a removal.
//
// Case-insensitive and trimmed on the safe side too, so a server that starts sending "create" is
// still recognised as safe rather than turning every add-only apply into a prompt.
func designDeletions(changes []api.DesignChange) []api.DesignChange {
	var out []api.DesignChange
	for _, ch := range changes {
		if _, safe := designNonRemovingActions[strings.ToUpper(strings.TrimSpace(ch.Action))]; !safe {
			out = append(out, ch)
		}
	}
	return out
}

// describeDeletions names what is about to go, for the confirmation.
func describeDeletions(deletes []api.DesignChange) string {
	names := make([]string, 0, len(deletes))
	for _, ch := range deletes {
		n := ch.Kind
		if ch.Name != nil && *ch.Name != "" {
			n += " " + *ch.Name
		}
		names = append(names, n)
	}
	return "Removes " + strings.Join(names, ", ") + " from this environment."
}

// errDesignApplyWouldDelete is the scripted refusal.
//
// It names --yes AND why the flag is required for THIS apply, because those are two different
// facts and a pipeline author needs the second one. Reading only "this command is destructive,
// pass --yes" leads to adding the flag permanently, which converts every future replay of that
// pipeline into one that may remove components — the opposite of what the ruling is for.
func errDesignApplyWouldDelete(deletes []api.DesignChange) error {
	return fmt.Errorf(
		"this apply would DELETE %d component(s) and interactive prompts are disabled "+
			"(--no-input, or stdin is not a terminal): pass --yes to confirm.\n"+
			"  --yes is required because THIS PLAN removes components, not because `design apply` "+
			"is destructive in general — an apply that only adds or updates runs unprompted. So "+
			"leaving --yes on a pipeline permanently opts every later replay of it into removing "+
			"components too; the usual fix is a document that still declares what you meant to keep",
		len(deletes))
}

// errDesignPreflightUnreadable is the fail-closed refusal.
func errDesignPreflightUnreadable(cause error) error {
	return fmt.Errorf(
		"could not check what this apply would change, so it is refused rather than run blind: %w.\n"+
			"  An apply can remove components, and this command only prompts when the plan says it "+
			"will — with the plan unreadable there is no way to tell. Re-run with --dry-run to see "+
			"the error directly, or pass --yes to apply without the check",
		cause)
}

// promptDesignFile asks for the document's path when -f was not passed.
//
// A path is the one thing this command cannot default: a design document is a file somebody
// wrote, and there is no sensible guess. Asking is still better than refusing, because the
// caller who forgot the flag is on a terminal and has the path in their head.
func promptDesignFile() (string, error) {
	if err := requireInteractiveForm(); err != nil {
		return "", err
	}
	return askLine("Design document",
		"Path to the document, or - to read stdin. `alethia config export` emits this shape")
}

// readDesignDocument reads the document from a file, or from stdin when the path is "-". It checks the
// bytes are JSON but does NOT validate the SHAPE: the server validates that with the console form's own
// schema, and a second opinion here could disagree with the one that decides.
func readDesignDocument(path string, stdin io.Reader) (json.RawMessage, error) {
	if path == "" {
		return nil, fmt.Errorf("-f is required (a path, or - for stdin)")
	}
	var raw []byte
	var err error
	if path == "-" {
		raw, err = io.ReadAll(stdin)
	} else {
		raw, err = os.ReadFile(path)
	}
	if err != nil {
		return nil, fmt.Errorf("read the design document: %w", err)
	}
	if !json.Valid(raw) {
		return nil, fmt.Errorf("%s is not valid JSON — `alethia config export` emits the shape this expects", path)
	}
	return json.RawMessage(raw), nil
}

// runDesignApply applies the document and reports what happened. On a dry run it prints the plan, which
// is the whole point of the mode: nothing was written, so the rows ARE the output.
func runDesignApply(c apiClient, out io.Writer, p api.ApplyDesignParams) error {
	if len(p.Document) == 0 {
		return fmt.Errorf("the design document is empty")
	}
	res, err := c.ApplyDesign(p)
	if err != nil {
		return err
	}
	if res == nil {
		return fmt.Errorf("the server returned no result")
	}

	switch res.Mode {
	case "dry-run":
		if len(res.Changes) == 0 {
			fmt.Fprintln(out, ui.FormatSuccess("No changes — the environment already matches this document"))
			return nil
		}
		fmt.Fprintf(out, "%d change(s) would be made%s:\n", len(res.Changes), envSuffix(p.Env))
		printDesignChanges(out, res.Changes)
		fmt.Fprintln(out, ui.MutedStyle.Render("Nothing was written. Re-run without --dry-run to apply."))
	case "staged":
		fmt.Fprintln(out, ui.FormatSuccess("Staged the design"+envSuffix(p.Env)))
		fmt.Fprintln(out, ui.MutedStyle.Render("Review and apply it from the staged-changes tray."))
	default:
		fmt.Fprintln(out, ui.FormatSuccess("Applied the design"+envSuffix(p.Env)))
		// The changes it MADE, not only the ones a dry run would have made.
		//
		// An apply is the one mode that can DELETE a component — a kind the document omits is
		// a kind the environment loses — and until this printed them, the only way to find out
		// was to have run --dry-run first and trusted that nothing moved in between.
		//
		// Still printed now that designApplyGate exists, and for a different reason: the gate
		// reports the PLAN, this reports the OUTCOME, and the window between them is exactly
		// what neither can close on its own. A deletion that appears here and not in the gate's
		// list is the drift that window allows, and it is only visible because both are printed.
		printDesignChanges(out, res.Changes)
		fmt.Fprintln(out, ui.MutedStyle.Render("It reaches the cloud on the next plan + apply."))
	}
	return nil
}

// printDesignChanges writes one row per component change, in the order the server reported.
func printDesignChanges(out io.Writer, changes []api.DesignChange) {
	for _, ch := range changes {
		name := ""
		if ch.Name != nil && *ch.Name != "" {
			name = " " + *ch.Name
		}
		fmt.Fprintf(out, "  %-7s %s%s\n", ch.Action, ch.Kind, name)
	}
}

func init() {
	projectDesignApplyCmd.Flags().StringVarP(&designApplyFile, "file", "f", "", "Design document path, or - for stdin (asked for on a terminal when omitted)")
	projectDesignApplyCmd.Flags().BoolVar(&designApplyDryRun, "dry-run", false, "Print the changes that would be made and write nothing")
	projectDesignApplyCmd.Flags().BoolVar(&designApplyStage, "stage", false, "Stage the change for review instead of applying it")
	// The standard opt-in spelling, so this reads like every other command that can destroy —
	// even though, unlike them, it is consulted only when the PLAN removes something.
	addYesFlag(projectDesignApplyCmd, &designApplyYes)
	projectDesignCmd.PersistentFlags().StringP("project", "p", "", "Project name or id")
	projectDesignCmd.PersistentFlags().StringP("env", "e", "", "Environment name, stage, or id (default: the project's default environment)")
	projectDesignCmd.AddCommand(projectDesignApplyCmd)
	projectCmd.AddCommand(projectDesignCmd)
}
