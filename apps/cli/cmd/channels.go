// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/charmbracelet/huh"
	"github.com/spf13/cobra"
)

var channelsCmd = &cobra.Command{
	Use:     "channels",
	Aliases: []string{"channel"},
	Short:   "Manage notification channels",
	Long: `Notification channels are delivery destinations (webhook, email, Slack,
PagerDuty, and more) that alert rules fan out to. List, create, verify, and delete
the active organization's channels.

Commands that act on one channel take its NAME or its id — or nothing at all, and
ask on a terminal.`,
}

var channelsListCmd = &cobra.Command{
	Use:   "list",
	Short: "List notification channels",
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		client := api.NewClient(token)
		if interactiveTable(cmd) {
			var channels []api.Channel
			runSpinner("Fetching channels...", func() { channels, err = client.ListChannels() })
			if err != nil {
				failf("Failed to list channels: %v", err)
			}
			if len(channels) == 0 {
				ui.Muted("No notification channels found.")
				return
			}
			_ = ui.ShowTable(channelListColumns, channelRows(channels, ui.FormatTable), "channels")
			return
		}
		if err := runChannelsList(client, os.Stdout, outputFormat(cmd)); err != nil {
			failf("Failed to list channels: %v", err)
		}
	},
}

var channelListColumns = []string{"Name", "Type", "Verified", "Enabled", "ID"}

// channelRows projects channels into plain table rows.
func channelRows(channels []api.Channel, outFmt string) [][]string {
	rows := make([][]string, len(channels))
	for i, c := range channels {
		rows[i] = []string{c.Name, c.Type, ui.Cell(outFmt, ui.WireBool(c.IsVerified), ui.YesNo(c.IsVerified)), ui.Cell(outFmt, ui.WireBool(c.Enabled), ui.YesNo(c.Enabled)), c.ID}
	}
	return rows
}

// runChannelsList fetches and renders the channels (non-interactive path).
func runChannelsList(c apiClient, out io.Writer, format string) error {
	channels, err := c.ListChannels()
	if err != nil {
		return err
	}
	if len(channels) == 0 && format == ui.FormatTable {
		fmt.Fprintln(out, ui.MutedStyle.Render("No notification channels found."))
		return nil
	}
	return ui.Render(out, format, ui.TableSpec{
		Columns: channelListColumns,
		Rows:    channelRows(channels, format),
	}, channels)
}

// resolveChannel answers "which channel?" for `verify` and `delete`.
//
// It LISTS first, on every path including the one where an id was given. Two reasons, and the
// second is the one that matters:
//
//   - `delete` then names the channel it is about to remove ("Delete channel Ops Slack (slack)?")
//     instead of asking about "this channel". A destructive command that resolved its own target
//     must say what the target was.
//   - refusing an id that is not in the list is SOUND, not merely convenient. Both the list and
//     the delete are scoped to the active organization, so an id absent from the list is one this
//     caller could not have acted on anyway — the CLI is refusing only what the server would
//     certainly refuse, which is the bound the programme puts on client-side validation.
func resolveChannel(c apiClient, args []string) (govRef, error) {
	channels, err := c.ListChannels()
	if err != nil {
		return govRef{}, err
	}
	return resolveGovRef(channelSelect, govRefsFromChannels(channels), args)
}

var (
	channelType          string
	channelRecipients    []string
	channelURL           string
	channelSigningSecret string
	channelRoutingKey    string
)

var channelTypes = []string{"webhook", "email", "slack", "rocketchat", "discord", "teams", "mattermost", "googlechat", "pagerduty"}

var channelsCreateCmd = &cobra.Command{
	Use:   "create [name]",
	Short: "Create a notification channel",
	Long: `Create a notification channel. The destination depends on --type:
  email             one or more --recipient flags
  slack/webhook/... a --url (with optional --signing-secret)
  pagerduty         a --routing-key

Omit anything on a terminal and you are asked for it; every question has a flag,
so --no-input can still create any channel this form can.

The endpoint is verified before the channel is saved (a channel never exists
unverified).`,
	Args: cobra.MaximumNArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		draft, err := resolveChannelDraft(args)
		if err != nil {
			fail(err)
		}
		if err := runChannelsCreate(api.NewClient(token), os.Stdout, draft.Name, draft.Type, draft.config()); err != nil {
			failf("Failed to create channel: %v", err)
		}
	},
}

// channelDraft is one answered `channels create` form: the same four values whether they arrived
// as flags or as answers.
//
// One struct rather than the six package-level flag variables read directly, because the form
// writes into it too — and a form that wrote back into the flag globals would leave `--type`
// "changed" for every later command in the same process, which is exactly the leak
// hyg_cli_confirm_test.go has to clean up around `--yes`.
type channelDraft struct {
	Name          string
	Type          string
	Recipients    []string
	URL           string
	SigningSecret string
	RoutingKey    string
}

// config assembles the create payload's `config` bag, translating the CLI's flags into the wire
// shape. Only the keys the chosen type uses are sent.
func (d channelDraft) config() map[string]interface{} {
	config := map[string]interface{}{}
	if len(d.Recipients) > 0 {
		config["recipients"] = d.Recipients
	}
	if d.URL != "" {
		config["url"] = d.URL
	}
	if d.SigningSecret != "" {
		config["signing_secret"] = d.SigningSecret
	}
	if d.RoutingKey != "" {
		config["routing_key"] = d.RoutingKey
	}
	return config
}

// channelDestination classifies a channel type by the destination it needs.
//
// It is derived from the type, not asked separately, so the form cannot present a webhook URL
// question for a PagerDuty channel — the mismatch the old flag-only surface allowed, and which the
// server answered with a validation error after the user had typed everything.
type channelDestination int

const (
	// channelDestEmail takes recipients.
	channelDestEmail channelDestination = iota
	// channelDestRoutingKey takes a PagerDuty Events API routing key.
	channelDestRoutingKey
	// channelDestURL takes a webhook URL. The default: every chat integration Alethia ships
	// (Slack, Discord, Teams, Mattermost, Rocket.Chat, Google Chat) and the generic webhook
	// deliver to a URL, so a NEW chat type added to the enum gets the right question without
	// anyone editing this switch.
	channelDestURL
)

// destinationFor returns the destination a channel type needs.
func destinationFor(channelType string) channelDestination {
	switch strings.ToLower(strings.TrimSpace(channelType)) {
	case "email":
		return channelDestEmail
	case "pagerduty":
		return channelDestRoutingKey
	default:
		return channelDestURL
	}
}

// errChannelTypeRequired is the refusal when no --type was given and nothing may be asked.
var errChannelTypeRequired = fmt.Errorf(
	"--type is required (%s) — with --no-input there is nowhere to ask",
	strings.Join(channelTypeNames(), ", "))

// errChannelNameRequired is the refusal when no name was given and nothing may be asked.
var errChannelNameRequired = fmt.Errorf(
	"a channel name is required — pass it as the argument, or run on a terminal to be asked")

// resolveChannelDraft fills a draft from the flags, then asks for whatever is still missing.
//
// The order is deliberate: the TYPE is settled before the destination question, because the type
// is what decides which destination question there is.
func resolveChannelDraft(args []string) (channelDraft, error) {
	draft := channelDraft{
		Type:          channelType,
		Recipients:    channelRecipients,
		URL:           channelURL,
		SigningSecret: channelSigningSecret,
		RoutingKey:    channelRoutingKey,
	}
	if len(args) > 0 && strings.TrimSpace(args[0]) != "" {
		draft.Name = strings.TrimSpace(args[0])
	}

	if draft.complete() {
		return draft, nil
	}
	if err := requireInteractiveForm(); err != nil {
		// The specific missing value, not a generic "interactive input required". A caller who
		// passed a --type and forgot the --url should be told about the url.
		if strings.TrimSpace(draft.Name) == "" {
			return draft, errChannelNameRequired
		}
		if strings.TrimSpace(draft.Type) == "" {
			return draft, errChannelTypeRequired
		}
		return draft, draft.missingDestinationErr()
	}
	return askChannelDraft(draft)
}

// complete reports whether the draft can be sent without asking anything: a name, a type, and the
// destination that type needs.
func (d channelDraft) complete() bool {
	if strings.TrimSpace(d.Name) == "" || strings.TrimSpace(d.Type) == "" {
		return false
	}
	return d.hasDestination()
}

// hasDestination reports whether the draft carries the destination its type needs.
func (d channelDraft) hasDestination() bool {
	switch destinationFor(d.Type) {
	case channelDestEmail:
		return len(d.Recipients) > 0
	case channelDestRoutingKey:
		return strings.TrimSpace(d.RoutingKey) != ""
	case channelDestURL:
		return strings.TrimSpace(d.URL) != ""
	}
	// Unreachable: destinationFor returns one of the three. Named rather than left to `default`
	// so `exhaustive` fails when a fourth destination is added instead of silently routing it to
	// the URL arm — a new destination reported as "needs --url" is the wrong refusal.
	return strings.TrimSpace(d.URL) != ""
}

// missingDestinationErr names the flag this type needs, rather than listing all three.
func (d channelDraft) missingDestinationErr() error {
	switch destinationFor(d.Type) {
	case channelDestEmail:
		return fmt.Errorf("an %s channel needs at least one --recipient", d.Type)
	case channelDestRoutingKey:
		return fmt.Errorf("a %s channel needs --routing-key", d.Type)
	case channelDestURL:
		return fmt.Errorf("a %s channel needs --url", d.Type)
	}
	return fmt.Errorf("a %s channel needs --url", d.Type)
}

// askChannelDraft opens the create form for whatever the flags did not supply.
//
// TWO forms, not one, and the split is load-bearing: huh builds a group's fields when the group is
// built, so a single form cannot decide which destination question to show based on a type the
// user has not chosen yet. The type is settled first; the destination question is then the one
// question that type has.
func askChannelDraft(draft channelDraft) (channelDraft, error) {
	var fields []huh.Field
	if strings.TrimSpace(draft.Name) == "" {
		f := mustGovField("alethia channels create", fieldKeyChannelName)
		fields = append(fields, huh.NewInput().
			Title(f.Title).Description(f.Description).Value(&draft.Name))
	}
	if strings.TrimSpace(draft.Type) == "" {
		f := mustGovField("alethia channels create", fieldKeyChannelType)
		options := make([]huh.Option[string], len(channelTypeNames()))
		for i, name := range channelTypeNames() {
			options[i] = huh.NewOption(name, name)
		}
		fields = append(fields, huh.NewSelect[string]().
			Title(f.Title).Description(f.Description).Options(options...).Value(&draft.Type))
	}
	if len(fields) > 0 {
		if err := runHuhForm(huh.NewGroup(fields...)); err != nil {
			return draft, err
		}
	}

	if draft.hasDestination() {
		return draft, nil
	}
	return askChannelDestination(draft)
}

// askChannelDestination asks the one destination question the chosen type has.
func askChannelDestination(draft channelDraft) (channelDraft, error) {
	switch destinationFor(draft.Type) {
	case channelDestEmail:
		f := mustGovField("alethia channels create", fieldKeyChannelRecipient)
		var joined string
		if err := runHuhForm(huh.NewGroup(huh.NewInput().
			Title(f.Title).Description(f.Description).Value(&joined))); err != nil {
			return draft, err
		}
		draft.Recipients = splitList(joined)
	case channelDestRoutingKey:
		f := mustGovField("alethia channels create", fieldKeyChannelRoutingKey)
		if err := runHuhForm(huh.NewGroup(huh.NewInput().
			Title(f.Title).Description(f.Description).Value(&draft.RoutingKey))); err != nil {
			return draft, err
		}
	case channelDestURL:
		f := mustGovField("alethia channels create", fieldKeyChannelURL)
		if err := runHuhForm(huh.NewGroup(huh.NewInput().
			Title(f.Title).Description(f.Description).Value(&draft.URL))); err != nil {
			return draft, err
		}
	}
	return draft, nil
}

// splitList parses a comma- or space-separated answer into its entries, dropping the empties a
// trailing separator leaves behind.
//
// One place, because a form that asks for "one or more" of anything gets an answer in whatever
// separator the person reached for. `strings.Split` alone yields a trailing "" for "a@b.com," —
// which reaches the server as an empty recipient and fails the create with a message about a
// value the user cannot see in what they typed.
func splitList(raw string) []string {
	parts := strings.FieldsFunc(raw, func(r rune) bool {
		return r == ',' || r == ' ' || r == '\t' || r == '\n' || r == ';'
	})
	var out []string
	for _, p := range parts {
		if v := strings.TrimSpace(p); v != "" {
			out = append(out, v)
		}
	}
	return out
}

// runChannelsCreate creates a channel and confirms it.
func runChannelsCreate(c apiClient, out io.Writer, name, channelType string, config map[string]interface{}) error {
	canonical, err := canonicalOneOf("type", channelType, channelTypes)
	if err != nil {
		return err
	}
	ch, err := c.CreateChannel(name, canonical, config)
	if err != nil {
		return err
	}
	if ch == nil {
		return fmt.Errorf("the control plane accepted the channel but returned no record of it")
	}
	fmt.Fprintln(out, ui.FormatSuccess(fmt.Sprintf("Created %s channel %s (%s)", ch.Type, ch.Name, ch.ID)))
	return nil
}

var channelsVerifyCmd = &cobra.Command{
	Use:   "verify [channel]",
	Short: "Send a test event through a channel and mark it verified",
	Long: `Send a synthetic event through a channel and mark it verified. Name the channel by its
name or its id; omit it on a terminal and you are asked which.`,
	Args: cobra.MaximumNArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		client := api.NewClient(token)
		ref, err := resolveChannel(client, args)
		if err != nil {
			fail(err)
		}
		if err := runChannelsVerify(client, os.Stdout, ref.ID); err != nil {
			failf("Failed to verify channel: %v", err)
		}
	},
}

// runChannelsVerify verifies a channel and confirms it.
//
// The nil check is not defensive padding. VerifyChannel decodes `{"channel": …}` out of a 200 and
// returns a POINTER, so a success response that carries no channel object — a partial deploy, a
// proxy that rewrote the body, a server that changed the envelope key — yields (nil, nil), and the
// confirmation line below dereferenced it. That was a panic with a Go stack trace where the honest
// answer is "the control plane said yes and did not say what it verified". Found by driving the
// command against a fake control plane whose envelope had no channel key.
func runChannelsVerify(c apiClient, out io.Writer, id string) error {
	ch, err := c.VerifyChannel(id)
	if err != nil {
		return err
	}
	if ch == nil {
		return fmt.Errorf("the control plane accepted the verification but returned no channel")
	}
	fmt.Fprintln(out, ui.FormatSuccess("Verified channel "+ch.Name))
	return nil
}

// channelsDeleteYes is the --yes opt-in: skip the confirmation prompt (and make the
// command usable with --no-input).
var channelsDeleteYes bool

var channelsDeleteCmd = &cobra.Command{
	Use:   "delete [channel]",
	Short: "Delete a notification channel",
	Long: `Delete a notification channel. Name it by its name or its id; omit it on a terminal
and you are asked which. Scripted, pass the name or id together with --yes.`,
	Args: cobra.MaximumNArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		client := api.NewClient(token)
		ref, err := resolveChannel(client, args)
		if err != nil {
			fail(err)
		}
		if !confirmDestructive(
			channelsDeleteYes,
			"Delete "+ref.Label+"?",
			"Alert rules bound to it will lose this destination. This cannot be undone.",
		) {
			return
		}
		if err := runChannelsDelete(client, os.Stdout, ref.ID); err != nil {
			failf("Failed to delete channel: %v", err)
		}
	},
}

// runChannelsDelete deletes a channel and confirms it.
func runChannelsDelete(c apiClient, out io.Writer, id string) error {
	if err := c.DeleteChannel(id); err != nil {
		return err
	}
	fmt.Fprintln(out, ui.FormatSuccess("Channel deleted"))
	return nil
}

func init() {
	addYesFlag(channelsDeleteCmd, &channelsDeleteYes)
	channelsCreateCmd.Flags().StringVar(&channelType, "type", "",
		"Channel type ("+strings.Join(channelTypeNames(), ", ")+")")
	channelsCreateCmd.Flags().StringArrayVar(&channelRecipients, "recipient", nil, "Email recipient (repeatable; email channels)")
	channelsCreateCmd.Flags().StringVar(&channelURL, "url", "", "Destination webhook URL (slack/webhook/…)")
	channelsCreateCmd.Flags().StringVar(&channelSigningSecret, "signing-secret", "", "Optional webhook signing secret")
	channelsCreateCmd.Flags().StringVar(&channelRoutingKey, "routing-key", "", "PagerDuty Events API routing key")

	channelsCmd.AddCommand(channelsListCmd)
	channelsCmd.AddCommand(channelsCreateCmd)
	channelsCmd.AddCommand(channelsVerifyCmd)
	channelsCmd.AddCommand(channelsDeleteCmd)
	rootCmd.AddCommand(channelsCmd)
}
