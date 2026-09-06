// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/spf13/cobra"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/spec"
)

// The field spec for the governance group — protection, promotion, classification, activity,
// alerts, channels, probes, fleet.
//
// A CLI command that takes a value renders that value FOUR times: as a flag or a positional, as a
// question in an interactive form, as a key on the wire, and as a row in the docs. Nothing made
// those four agree here, and they had already drifted:
//
//   - `channels create --type` advertised its types as "webhook, email, slack, pagerduty, …". The
//     ellipsis hid FIVE — rocketchat, discord, teams, mattermost, googlechat — so a user could
//     only discover more than half the product's chat integrations by reading the console.
//   - `alerts create --severity` took free text with a default of "warning" and no list at all.
//   - `channels verify`, `channels delete` and `alerts delete` each demanded an opaque id whose
//     only source was another command's table, and the docs stood an ellipsis in for it.
//
// This is the one place the group's fields are described. The forms READ their titles and
// descriptions from here rather than repeating them, so the form and the spec cannot disagree by
// construction; hyg_cli_govform_test.go checks the other two renderings — that the flag or
// positional named here exists on the real command, and that the docs page named here carries the
// same rows in the same order.
//
// It deliberately mirrors authFields (auth_fields.go) rather than generalising it. The general
// field-spec kit is #3661's; two groups describing their own fields the same way is what tells
// that lane what the shape should be.
// govField is spec.Field. The struct declared here was one of five near-identical copies across the
// noun groups, each carrying a comment naming #3661 as where they converge. This is that
// convergence; an ALIAS rather than a new type so every literal in this file and every call site
// elsewhere reads unchanged. What the columns mean is documented once, on spec.Field.
type govField = spec.Field

// Field keys. Constants rather than literals so a typo is a compile error and a rename reaches the
// form and the spec together. Prefixed by their command because this package already holds the
// auth group's keys and a bare `name` would be two different questions under one identifier.
const (
	fieldKeyGovProject = "project"
	fieldKeyGovEnv     = "env"
	fieldKeyGovLimit   = "limit"

	fieldKeyChannelName       = "channel-name"
	fieldKeyChannelType       = "channel-type"
	fieldKeyChannelRecipient  = "channel-recipient"
	fieldKeyChannelURL        = "channel-url"
	fieldKeyChannelSecret     = "channel-signing-secret"
	fieldKeyChannelRoutingKey = "channel-routing-key"
	fieldKeyChannelRef        = "channel-ref"

	fieldKeyAlertName     = "alert-name"
	fieldKeyAlertEvent    = "alert-event"
	fieldKeyAlertChannel  = "alert-channel"
	fieldKeyAlertSeverity = "alert-severity"
	fieldKeyAlertRef      = "alert-ref"

	fieldKeyPromotionRef = "promotion-ref"

	fieldKeyClassKind      = "class-kind"
	fieldKeyClassID        = "class-id"
	fieldKeyClassDimension = "class-dimension"
	fieldKeyClassValue     = "class-value"

	fieldKeyFleetProvider = "fleet-provider"
	fieldKeyFleetWarmMin  = "fleet-warm-min"
	fieldKeyFleetMax      = "fleet-max"
	fieldKeyFleetSlots    = "fleet-slots"
	fieldKeyFleetEnabled  = "fleet-enabled"
	fieldKeyFleetChannel  = "fleet-channel"
	fieldKeyFleetVersion  = "fleet-version"
)

// Docs pages, relative to the repository root.
const (
	docsProtectionPage     = "apps/docs/content/docs/cli/commands/protection.mdx"
	docsPromotionsPage     = "apps/docs/content/docs/cli/commands/promotions.mdx"
	docsProbesPage         = "apps/docs/content/docs/cli/commands/probes.mdx"
	docsNotificationsPage  = "apps/docs/content/docs/cli/commands/notifications.mdx"
	docsClassificationPage = "apps/docs/content/docs/cli/commands/classification.mdx"
	docsFleetPage          = "apps/docs/content/docs/cli/commands/billing.mdx"
)

// govFields is the spec. One entry per value a command in this group takes from a person, in the
// order the docs table and the form present them.
//
// `alethia classification dimensions`, `alethia channels list`, `alethia alerts list` and
// `alethia fleet list` have no entry because they take no value of their own — a deliberate
// absence, recorded in govFormLeafTakesInput so it cannot be an oversight.
var govFields = []govField{
	// ── protection ───────────────────────────────────────────────────────────────────────────
	{
		Command:     "alethia protection list",
		Key:         fieldKeyGovProject,
		Title:       "Project",
		Description: "Whose environments' promotion gates to read",
		Flag:        "project",
		Page:        docsProtectionPage,
	},

	// ── probes ───────────────────────────────────────────────────────────────────────────────
	{
		Command:     "alethia probes list",
		Key:         fieldKeyGovProject,
		Title:       "Project",
		Description: "Whose environments to report the latest cluster probe for",
		Flag:        "project",
		Page:        docsProbesPage,
	},

	// ── promotion ────────────────────────────────────────────────────────────────────────────
	{
		Command:     "alethia promotion list",
		Key:         fieldKeyGovProject,
		Title:       "Project",
		Description: "Whose promotions to list",
		Flag:        "project",
		Page:        docsPromotionsPage,
	},
	{
		Command:     "alethia promotion list",
		Key:         fieldKeyGovEnv,
		Title:       "Target environment",
		Description: "Show only promotions INTO this environment, by name, stage, or id",
		Flag:        "env",
		Page:        docsPromotionsPage,
	},
	{
		Command:     "alethia promotion get",
		Key:         fieldKeyGovProject,
		Title:       "Project",
		Description: "Which project the promotion belongs to",
		Flag:        "project",
		Page:        docsPromotionsPage,
	},
	{
		Command:     "alethia promotion get",
		Key:         fieldKeyPromotionRef,
		Title:       "Promotion",
		Description: "The promotion to open, by id or id prefix; omit it to choose from the list",
		Arg:         "[promotion]",
		Page:        docsPromotionsPage,
	},

	// ── activity ─────────────────────────────────────────────────────────────────────────────
	{
		Command:     "alethia activity",
		Key:         fieldKeyGovLimit,
		Title:       "Rows",
		Description: "How many entries to read back, newest first",
		Flag:        "limit",
		Page:        docsNotificationsPage,
	},

	// ── channels ─────────────────────────────────────────────────────────────────────────────
	{
		Command:     "alethia channels create",
		Key:         fieldKeyChannelName,
		Title:       "Name",
		Description: "What this destination is, so a list of channels is a list of destinations",
		Arg:         "[name]",
		Page:        docsNotificationsPage,
	},
	{
		Command:     "alethia channels create",
		Key:         fieldKeyChannelType,
		Title:       "Type",
		Description: "Which integration delivers it; it decides which destination is asked for next",
		Flag:        "type",
		Page:        docsNotificationsPage,
	},
	{
		Command:     "alethia channels create",
		Key:         fieldKeyChannelRecipient,
		Title:       "Recipients",
		Description: "Where an email channel delivers; repeat the flag, or separate them with commas",
		Flag:        "recipient",
		Page:        docsNotificationsPage,
	},
	{
		Command:     "alethia channels create",
		Key:         fieldKeyChannelURL,
		Title:       "Webhook URL",
		Description: "Where a webhook or chat channel posts; the endpoint is called before the channel is saved",
		Flag:        "url",
		Page:        docsNotificationsPage,
	},
	{
		Command:     "alethia channels create",
		Key:         fieldKeyChannelSecret,
		Title:       "Signing secret",
		Description: "Optional shared secret the receiver checks the delivery signature against",
		Flag:        "signing-secret",
		Page:        docsNotificationsPage,
	},
	{
		Command:     "alethia channels create",
		Key:         fieldKeyChannelRoutingKey,
		Title:       "Routing key",
		Description: "The PagerDuty Events API integration key the incident is raised against",
		Flag:        "routing-key",
		Page:        docsNotificationsPage,
	},
	{
		Command:     "alethia channels verify",
		Key:         fieldKeyChannelRef,
		Title:       "Channel",
		Description: "The channel to send a test event through, by name or id; omit it to choose from the list",
		Arg:         "[channel]",
		Page:        docsNotificationsPage,
	},
	{
		Command:     "alethia channels delete",
		Key:         fieldKeyChannelRef,
		Title:       "Channel",
		Description: "The channel to remove, by name or id; omit it to choose from the list",
		Arg:         "[channel]",
		Page:        docsNotificationsPage,
	},

	// ── alerts ───────────────────────────────────────────────────────────────────────────────
	{
		Command:     "alethia alerts create",
		Key:         fieldKeyAlertName,
		Title:       "Name",
		Description: "What this rule is for, so a list of rules is a list of intentions",
		Arg:         "[name]",
		Page:        docsNotificationsPage,
	},
	{
		Command:     "alethia alerts create",
		Key:         fieldKeyAlertEvent,
		Title:       "Event patterns",
		Description: "Which event keys fire it, e.g. system.job.failed or authz.*.denied",
		Flag:        "event",
		Page:        docsNotificationsPage,
	},
	{
		Command:     "alethia alerts create",
		Key:         fieldKeyAlertChannel,
		Title:       "Channels",
		Description: "Where it delivers, by channel name or id; omit them to choose from the list",
		Flag:        "channel",
		Page:        docsNotificationsPage,
	},
	{
		Command:     "alethia alerts create",
		Key:         fieldKeyAlertSeverity,
		Title:       "Severity",
		Description: "How loud the delivery is; one of the alert_severity values",
		Flag:        "severity",
		Page:        docsNotificationsPage,
	},
	{
		Command:     "alethia alerts delete",
		Key:         fieldKeyAlertRef,
		Title:       "Alert rule",
		Description: "The rule to remove, by name or id; omit it to choose from the list",
		Arg:         "[rule]",
		Page:        docsNotificationsPage,
	},

	// ── classification ───────────────────────────────────────────────────────────────────────
	{
		Command:     "alethia classification show",
		Key:         fieldKeyClassKind,
		Title:       "Resource kind",
		Description: "The record type being labelled, e.g. project_environment",
		Arg:         "<kind>",
		Page:        docsClassificationPage,
	},
	{
		Command:     "alethia classification show",
		Key:         fieldKeyClassID,
		Title:       "Resource id",
		Description: "The UUID of the resource whose labels to read",
		Arg:         "<id>",
		Page:        docsClassificationPage,
	},
	{
		Command:     "alethia classification assign",
		Key:         fieldKeyClassKind,
		Title:       "Resource kind",
		Description: "The record type being labelled, e.g. project_environment",
		Arg:         "<kind>",
		Page:        docsClassificationPage,
	},
	{
		Command:     "alethia classification assign",
		Key:         fieldKeyClassID,
		Title:       "Resource id",
		Description: "The UUID of the resource to label",
		Arg:         "<id>",
		Page:        docsClassificationPage,
	},
	{
		Command:     "alethia classification assign",
		Key:         fieldKeyClassDimension,
		Title:       "Dimension",
		Description: "Which axis to set, by its key; omit it to choose from the org's taxonomy",
		Arg:         "[dimension-key]",
		Page:        docsClassificationPage,
	},
	{
		Command:     "alethia classification assign",
		Key:         fieldKeyClassValue,
		Title:       "Value",
		Description: "The value slug to pin, from that dimension's allowed values",
		Arg:         "[value-slug]",
		Page:        docsClassificationPage,
	},
	{
		Command:     "alethia classification unassign",
		Key:         fieldKeyClassKind,
		Title:       "Resource kind",
		Description: "The record type being labelled, e.g. project_environment",
		Arg:         "<kind>",
		Page:        docsClassificationPage,
	},
	{
		Command:     "alethia classification unassign",
		Key:         fieldKeyClassID,
		Title:       "Resource id",
		Description: "The UUID of the resource to clear a value from",
		Arg:         "<id>",
		Page:        docsClassificationPage,
	},
	{
		Command:     "alethia classification unassign",
		Key:         fieldKeyClassValue,
		Title:       "Value",
		Description: "The value slug to clear; omit it to choose from what the resource actually carries",
		Arg:         "[value-slug]",
		Page:        docsClassificationPage,
	},

	// ── fleet ────────────────────────────────────────────────────────────────────────────────
	{
		Command:     "alethia fleet set",
		Key:         fieldKeyFleetProvider,
		Title:       "Provider",
		Description: "Which cloud's warm pool to configure; omit it to choose from the clouds Alethia supports",
		Arg:         "[provider]",
		Page:        docsFleetPage,
	},
	{
		Command:     "alethia fleet set",
		Key:         fieldKeyFleetWarmMin,
		Title:       "Warm floor",
		Description: "How many runners stay provisioned with no work to do",
		Flag:        "warm-min",
		Page:        docsFleetPage,
	},
	{
		Command:     "alethia fleet set",
		Key:         fieldKeyFleetMax,
		Title:       "Ceiling",
		Description: "The most instances the controller may ever run for this cloud",
		Flag:        "max",
		Page:        docsFleetPage,
	},
	{
		Command:     "alethia fleet set",
		Key:         fieldKeyFleetSlots,
		Title:       "Slots per runner",
		Description: "How many provisioning jobs one runner takes at once",
		Flag:        "slots",
		Page:        docsFleetPage,
	},
	{
		Command:     "alethia fleet set",
		Key:         fieldKeyFleetEnabled,
		Title:       "Enabled",
		Description: "Whether the controller provisions for this cloud at all; disabling drains it",
		Flag:        "enabled",
		Page:        docsFleetPage,
	},
	{
		Command:     "alethia fleet set",
		Key:         fieldKeyFleetChannel,
		Title:       "Release channel",
		Description: "A runner channel to track, e.g. stable; mutually exclusive with a pinned version",
		Flag:        "channel",
		Page:        docsFleetPage,
	},
	{
		Command:     "alethia fleet set",
		Key:         fieldKeyFleetVersion,
		Title:       "Pinned version",
		Description: "An exact runner version to hold this pool at; setting it clears the channel",
		Flag:        "version",
		Page:        docsFleetPage,
	},
}

// mustGovField returns the spec for one field.
//
// It panics on a miss, and that is the right failure: both arguments are constants in this
// package, so a miss is a programming error, and the alternative — a zero govField — is a form
// that opens with an empty title and an empty description and asks the user for something
// unnamed. TestHygCliGovForm_EveryFormFieldResolves drives every lookup the forms make, so an
// unresolvable key cannot ship.
func mustGovField(command, key string) govField {
	return governanceGroup().Must(command, key)
}

// governanceGroup wraps the governance group's table in the shared kit, so the lookup, the flag
// registration and the docs rendering are the ones every other group uses rather than five copies
// of each.
func governanceGroup() spec.Group {
	return spec.Group{Name: "governance", Source: "governance_fields.go", Fields: govFields}
}

// govGroupRoots are the top-level commands this noun group owns. Used to derive the group's leaves
// from the live command tree, so a new subcommand joins the guards without anyone remembering to
// add it.
var govGroupRoots = []string{
	"protection", "promotion", "classification", "activity", "alerts", "channels", "probes", "fleet",
}

// govGroupCommands returns every RUNNABLE command under govGroupRoots.
//
// Derived from the tree rather than listed, for the reason hyg_cli_render_test.go records at
// length: a hand-written list of what a guard watches stops covering silently. "Runnable", not
// "leaf" — `alethia activity` is a top-level command with a Run and no subcommands, so a
// leaf-only walk that descended into children would see nothing for it at all.
func govGroupCommands(root *cobra.Command) []*cobra.Command {
	inGroup := map[string]bool{}
	for _, r := range govGroupRoots {
		inGroup[r] = true
	}
	var out []*cobra.Command
	for _, top := range root.Commands() {
		if !inGroup[top.Name()] {
			continue
		}
		var walk func(c *cobra.Command)
		walk = func(c *cobra.Command) {
			if c.Run != nil || c.RunE != nil {
				out = append(out, c)
			}
			for _, child := range c.Commands() {
				walk(child)
			}
		}
		walk(top)
	}
	return out
}

// ── the closed sets ───────────────────────────────────────────────────────────────────────────
//
// Both come from packages/core/types, which is generated from the drizzle enum SSOT. Through the
// generated slices and not a literal list here, because a hand-written list of a finite known set
// stops covering silently: `--type`'s help text was such a list, it named four of the nine
// channel types, and it ended in an ellipsis that told the reader nothing about the other five.
//
// Both slices are also what the forms offer and what the validators accept, so a channel type
// added to the schema reaches the flag help, the picker and the refusal message together.

// channelTypeNames is every alert_channel_type value, in schema order.
func channelTypeNames() []string {
	out := make([]string, len(types.AllAlertChannelTypes))
	for i, t := range types.AllAlertChannelTypes {
		out[i] = string(t)
	}
	return out
}

// alertSeverityNames is every alert_severity value, in schema order.
func alertSeverityNames() []string {
	out := make([]string, len(types.AllAlertSeveritys))
	for i, s := range types.AllAlertSeveritys {
		out[i] = string(s)
	}
	return out
}

// cloudProviderNames is every cloud_provider value, in schema order.
func cloudProviderNames() []string {
	out := make([]string, len(types.AllCloudProviders))
	for i, p := range types.AllCloudProviders {
		out[i] = string(p)
	}
	return out
}
