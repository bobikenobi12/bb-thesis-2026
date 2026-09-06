// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/charmbracelet/huh"
	"github.com/spf13/cobra"
)

var alertsCmd = &cobra.Command{
	Use:     "alerts",
	Aliases: []string{"alert"},
	Short:   "Manage alert rules",
	Long: `Alert rules bind product events (event-key patterns like system.job.failed or
authz.*.denied) to notification channels. List, create, and delete the active
organization's rules. See delivery history with "alethia activity".

A rule's channels are named by CHANNEL NAME or id, and a rule itself by its name
or id — omit either on a terminal and you are asked which.`,
}

var alertsListCmd = &cobra.Command{
	Use:   "list",
	Short: "List alert rules",
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		client := api.NewClient(token)
		if interactiveTable(cmd) {
			var rules []api.AlertRule
			runSpinner("Fetching alert rules...", func() { rules, err = client.ListAlertRules() })
			if err != nil {
				failf("Failed to list alert rules: %v", err)
			}
			if len(rules) == 0 {
				ui.Muted("No alert rules found.")
				return
			}
			_ = ui.ShowTable(alertListColumns, alertRows(rules, ui.FormatTable), "alert rules")
			return
		}
		if err := runAlertsList(client, os.Stdout, outputFormat(cmd)); err != nil {
			failf("Failed to list alert rules: %v", err)
		}
	},
}

var alertListColumns = []string{"Name", "Severity", "Events", "Channels", "Enabled", "ID"}

// alertRows projects alert rules into plain table rows.
func alertRows(rules []api.AlertRule, outFmt string) [][]string {
	rows := make([][]string, len(rules))
	for i, r := range rules {
		rows[i] = []string{
			r.Name,
			r.Severity,
			strconv.Itoa(len(r.EventPatterns)),
			strconv.Itoa(len(r.ChannelIDs)),
			ui.Cell(outFmt, ui.WireBool(r.Enabled), ui.YesNo(r.Enabled)),
			r.ID,
		}
	}
	return rows
}

// runAlertsList fetches and renders the alert rules (non-interactive path).
func runAlertsList(c apiClient, out io.Writer, format string) error {
	rules, err := c.ListAlertRules()
	if err != nil {
		return err
	}
	if len(rules) == 0 && format == ui.FormatTable {
		fmt.Fprintln(out, ui.MutedStyle.Render("No alert rules found."))
		return nil
	}
	return ui.Render(out, format, ui.TableSpec{
		Columns: alertListColumns,
		Rows:    alertRows(rules, format),
	}, rules)
}

var (
	alertEventPatterns []string
	alertChannelRefs   []string
	alertSeverity      string
)

var alertsCreateCmd = &cobra.Command{
	Use:   "create [name]",
	Short: "Create an alert rule",
	Long: `Create an alert rule binding one or more event-key patterns to notification
channels. Repeat --event and --channel for multiple values.

--channel takes a channel's NAME as readily as its id, so a rule can be created
without first copying an id out of "alethia channels list". Omit any of the four
values on a terminal and you are asked for it.`,
	Args: cobra.MaximumNArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		client := api.NewClient(token)
		draft, err := resolveAlertDraft(client, cmd, args)
		if err != nil {
			fail(err)
		}
		if err := runAlertsCreate(client, os.Stdout, draft.Name, draft.Events, draft.ChannelIDs, draft.Severity); err != nil {
			failf("Failed to create alert rule: %v", err)
		}
	},
}

// alertDraft is one answered `alerts create` form. ChannelIDs are already RESOLVED — the flag
// takes names or ids and the form takes a selection, and both arrive here as the ids the API
// wants, so nothing downstream has to know which it was.
type alertDraft struct {
	Name       string
	Events     []string
	ChannelIDs []string
	Severity   string
}

// errAlertNameRequired, errAlertEventRequired and errAlertChannelRequired are the refusals when a
// value is missing and nothing may be asked.
//
// Three errors rather than one, because each names a different next action and the person reading
// it has already got the other two right. Before this, --event and --channel were
// MarkFlagRequired, which produced cobra's generic `required flag(s) "channel", "event" not set`
// with no hint that a channel may be named rather than copied.
var (
	errAlertNameRequired  = fmt.Errorf("an alert rule name is required — pass it as the argument, or run on a terminal to be asked")
	errAlertEventRequired = fmt.Errorf("at least one --event pattern is required (e.g. system.job.failed, authz.*.denied)")
)

// errAlertChannelRequired names the list command, because the person who has to supply a channel
// is exactly the person who may not know what channels exist.
var errAlertChannelRequired = fmt.Errorf(
	"at least one --channel is required — pass a channel name or id (see `alethia channels list`)")

// resolveAlertDraft fills a draft from the flags, then asks for whatever is still missing.
//
// The channel list is fetched UNCONDITIONALLY and used for both jobs the channels need —
// resolving the names a --channel flag carried, and populating the multi-select. One fetch, on
// every path: fetching only on the paths that "need" it would put a condition between the flag
// half and the form half of the same field, and every rule this command can create names at
// least one channel anyway.
//
// The severity is read through Changed rather than through its value. The flag carries a default
// of "warning", so `draft.Severity == ""` is never true and a form gated on it would silently
// never ask — the field would be in the spec, in the docs, and unreachable. Changed distinguishes
// "the caller chose warning" from "nobody said", which is the actual question.
func resolveAlertDraft(c apiClient, cmd *cobra.Command, args []string) (alertDraft, error) {
	draft := alertDraft{
		Name:   strings.TrimSpace(alertName(args)),
		Events: alertEventPatterns,
	}
	// THE MATCHED VALUE, NOT THE TYPED ONE. This read
	// `draft.Severity = strings.TrimSpace(alertSeverity)` followed by a validator that returned
	// only an error, so `--severity Critical` passed a case-insensitive gate and then posted
	// "Critical" to a case-SENSITIVE `z.enum(alertSeverity.enumValues)`. The server's answer is a
	// bare "Invalid request body" naming no field — which is the exact outcome the validator was
	// added to prevent. #3825.
	//
	// `canonicalOneOf` rather than a local `validAlertSeverity`: it is the same helper the
	// `grants` and `channels` groups moved onto in #3910, and this was the last of the three
	// spellings of "fold case then post the caller's" that #3825 measured.
	//
	// THAT IS NOT THE SAME AS "the package now has one helper". `canonicalAddonMode`
	// (`addon_select.go:196`) is a fourth, hand-rolled, with its own `EqualFold` loop and its own
	// message. It is not a defect — it returns the canonical value, which is the property that
	// matters, and it carries an empty-string arm `canonicalOneOf` does not have — but it is a
	// second implementation of one rule, and a claim that this call site closed the class would be
	// false while it stands. Converging it is a separate change with its own call sites to check.
	//
	// Client-side validation is SOUND here rather than merely helpful — severity is a Postgres
	// enum, so a value outside the set is certainly refused by the server. That is the bound the
	// programme puts on the CLI's validation (reject only what the server would certainly reject),
	// and the payoff is a refusal that names the legal values instead of surfacing a 400.
	severityGiven := cmd.Flags().Changed("severity")
	if severityGiven {
		canonical, err := canonicalOneOf("severity", strings.TrimSpace(alertSeverity), alertSeverityNames())
		if err != nil {
			return draft, err
		}
		draft.Severity = canonical
	}

	channels, err := c.ListChannels()
	if err != nil {
		return draft, err
	}
	refs := govRefsFromChannels(channels)

	// Resolve every --channel the caller named, before asking anything: a typo'd channel is worth
	// reporting straight away rather than after a form.
	for _, raw := range alertChannelRefs {
		ref, err := resolveGovRef(channelSelect, refs, []string{raw})
		if err != nil {
			return draft, err
		}
		draft.ChannelIDs = append(draft.ChannelIDs, ref.ID)
	}

	if draft.complete() && severityGiven {
		return draft, nil
	}
	if err := requireInteractiveForm(); err != nil {
		if !draft.complete() {
			return draft, draft.missingErr()
		}
		// Complete but for the severity, which has a default. Scripted, the default IS the
		// answer — refusing here would break every existing `alerts create` that never passed
		// --severity.
		draft.Severity = alertSeverity
		return draft, nil
	}
	return askAlertDraft(draft, refs)
}

// alertName reads the name positional, which is optional.
func alertName(args []string) string {
	if len(args) > 0 {
		return args[0]
	}
	return ""
}

// complete reports whether the draft can be sent without asking anything. Severity is NOT part of
// it: the flag carries a default, so an unanswered severity is a decision the product already
// made, not a missing value.
func (d alertDraft) complete() bool {
	return strings.TrimSpace(d.Name) != "" && len(d.Events) > 0 && len(d.ChannelIDs) > 0
}

// missingErr names the first value the draft is missing.
func (d alertDraft) missingErr() error {
	if strings.TrimSpace(d.Name) == "" {
		return errAlertNameRequired
	}
	if len(d.Events) == 0 {
		return errAlertEventRequired
	}
	return errAlertChannelRequired
}

// askAlertDraft opens the create form for whatever the flags did not supply.
//
// The channel question is a MULTI-select bound to indices into refs, for the reason pickGovRef
// gives: huh can only write back values it was given, so every index that comes back is in range
// and there is no unknown-id branch to get wrong.
func askAlertDraft(draft alertDraft, refs []govRef) (alertDraft, error) {
	var fields []huh.Field
	if strings.TrimSpace(draft.Name) == "" {
		f := mustGovField("alethia alerts create", fieldKeyAlertName)
		fields = append(fields, huh.NewInput().
			Title(f.Title).Description(f.Description).Value(&draft.Name))
	}

	var events string
	if len(draft.Events) == 0 {
		f := mustGovField("alethia alerts create", fieldKeyAlertEvent)
		fields = append(fields, huh.NewInput().
			Title(f.Title).Description(f.Description).Value(&events))
	}

	var chosen []int
	if len(draft.ChannelIDs) == 0 {
		if len(refs) == 0 {
			// A multi-select with no options is a box the user has to escape out of, and the
			// rule could not be created anyway: the server requires at least one channel.
			return draft, fmt.Errorf(
				"no notification channel exists to route this rule to — create one first with `alethia channels create`")
		}
		f := mustGovField("alethia alerts create", fieldKeyAlertChannel)
		options := make([]huh.Option[int], len(refs))
		for i, r := range refs {
			options[i] = huh.NewOption(r.Label, i)
		}
		fields = append(fields, huh.NewMultiSelect[int]().
			Title(f.Title).Description(f.Description).Options(options...).Value(&chosen))
	}

	if strings.TrimSpace(draft.Severity) == "" {
		f := mustGovField("alethia alerts create", fieldKeyAlertSeverity)
		names := alertSeverityNames()
		options := make([]huh.Option[string], len(names))
		for i, name := range names {
			options[i] = huh.NewOption(name, name)
		}
		fields = append(fields, huh.NewSelect[string]().
			Title(f.Title).Description(f.Description).Options(options...).Value(&draft.Severity))
	}

	if len(fields) > 0 {
		if err := runHuhForm(huh.NewGroup(fields...)); err != nil {
			return draft, err
		}
	}

	if events != "" {
		draft.Events = splitList(events)
	}
	for _, i := range chosen {
		draft.ChannelIDs = append(draft.ChannelIDs, refs[i].ID)
	}
	if strings.TrimSpace(draft.Severity) == "" {
		// The form was not shown the severity question (the caller passed --severity), or it came
		// back empty. Either way the flag's default is the product's answer, and sending "" would
		// be rejected by the alert_severity enum.
		draft.Severity = alertSeverity
	}
	if !draft.complete() {
		return draft, draft.missingErr()
	}
	return draft, nil
}

// runAlertsCreate creates an alert rule and confirms it.
func runAlertsCreate(c apiClient, out io.Writer, name string, eventPatterns, channelIDs []string, severity string) error {
	rule, err := c.CreateAlertRule(name, eventPatterns, channelIDs, severity)
	if err != nil {
		return err
	}
	// A 200 whose body carries no rule object yields (nil, nil) — see runChannelsVerify for the
	// reasoning. Reporting it beats dereferencing it.
	if rule == nil {
		return fmt.Errorf("the control plane accepted the rule but returned no record of it")
	}
	fmt.Fprintln(out, ui.FormatSuccess(fmt.Sprintf("Created alert rule %s (%s)", rule.Name, rule.ID)))
	return nil
}

// alertsDeleteYes is the --yes opt-in: skip the confirmation prompt (and make the
// command usable with --no-input).
var alertsDeleteYes bool

var alertsDeleteCmd = &cobra.Command{
	Use:   "delete [rule]",
	Short: "Delete an alert rule",
	Long: `Delete an alert rule. Name it by its name or its id; omit it on a terminal and you are
asked which. Scripted, pass the name or id together with --yes.`,
	Args: cobra.MaximumNArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		client := api.NewClient(token)
		ref, err := resolveAlertRule(client, args)
		if err != nil {
			fail(err)
		}
		if !confirmDestructive(
			alertsDeleteYes,
			"Delete "+ref.Label+"?",
			"Matching events will no longer be routed. This cannot be undone.",
		) {
			return
		}
		if err := runAlertsDelete(client, os.Stdout, ref.ID); err != nil {
			failf("Failed to delete alert rule: %v", err)
		}
	},
}

// resolveAlertRule answers "which alert rule?" for `delete`. It lists first for the reason
// resolveChannel records: the confirmation must be able to name what it is about to remove.
func resolveAlertRule(c apiClient, args []string) (govRef, error) {
	rules, err := c.ListAlertRules()
	if err != nil {
		return govRef{}, err
	}
	return resolveGovRef(alertRuleSelect, govRefsFromAlertRules(rules), args)
}

// runAlertsDelete deletes an alert rule and confirms it.
func runAlertsDelete(c apiClient, out io.Writer, id string) error {
	if err := c.DeleteAlertRule(id); err != nil {
		return err
	}
	fmt.Fprintln(out, ui.FormatSuccess("Alert rule deleted"))
	return nil
}

func init() {
	addYesFlag(alertsDeleteCmd, &alertsDeleteYes)
	alertsCreateCmd.Flags().StringArrayVar(&alertEventPatterns, "event", nil, "Event-key pattern (repeatable, e.g. system.job.failed)")
	alertsCreateCmd.Flags().StringArrayVar(&alertChannelRefs, "channel", nil, "Channel to route to, by name or id (repeatable)")
	alertsCreateCmd.Flags().StringVar(&alertSeverity, "severity", "warning",
		"Severity ("+strings.Join(alertSeverityNames(), ", ")+")")

	alertsCmd.AddCommand(alertsListCmd)
	alertsCmd.AddCommand(alertsCreateCmd)
	alertsCmd.AddCommand(alertsDeleteCmd)
	rootCmd.AddCommand(alertsCmd)
}
