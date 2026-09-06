// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"strings"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/charmbracelet/huh"
)

// Which one? — the one answer for every governance command that acts on a single listed record.
//
// Four commands in this group took an opaque id as a REQUIRED positional, and the only place to
// get that id was the output of a different command. `notifications.mdx` documented all four as
// `alethia channels verify 3f1c…`, `alethia channels delete 3f1c…`, `alethia alerts delete a1b2…`
// — an ellipsis standing in for a token the reader has to copy out of a table by eye. That copied
// token is the HANDOFF the CLI programme exists to remove (#3612): it is the thing that makes a
// documented sequence un-runnable and a demo un-scriptable.
//
// The four are the SAME QUESTION — "which of the records this group lists?" — so they get one
// answer rather than four near-copies. Writing the fourth copy is how `orDash` ended up defined in
// eight files, one directory over.
//
// Three sources, and they are three renderings of one spec:
//
//	the picker       alethia channels delete                a list to choose from, on a terminal
//	a name           alethia channels delete "Ops Slack"    what the operator actually calls it
//	an id or prefix  alethia channels delete 3f1c8a2b        the token a script already holds
//
// The flag contract stays COMPLETE: anything the picker can choose, the positional can name, so
// `--no-input` is never a dead end. It is a positional rather than a flag because it is the
// command's subject, which is the shape `connector remove [provider]` and `cluster get [selector]`
// already use.

// govRef is one selectable governance record: what the API is called with, what a person calls it,
// and the one line the picker shows.
//
// Name is EMPTY for a record that genuinely has none — a promotion is identified by its endpoints
// and its time, never by a name — and the matcher below treats that absence as "cannot be matched
// by name" rather than as an empty name that anything could match.
type govRef struct {
	ID    string
	Name  string
	Label string
}

// govSelectSpec describes one "which record?" question: the noun for its messages, the picker's
// wording, and the command that lists the candidates.
//
// ListCmd is not decoration. Every refusal below ends by naming it, because the person reading
// "no channel matches" needs the one command that would show them what there is, and the failure
// mode this whole file addresses is a user who cannot find a token.
type govSelectSpec struct {
	Noun    string
	Title   string
	Desc    string
	ListCmd string
}

// govMatchTier ranks how strongly a query matched, so an exact hit always beats a prefix.
//
// The tiers are resolved STRONGEST-FIRST and independently: the query is matched against every
// record at tier 1, and only if nothing matched is tier 2 tried. Scoring all tiers together and
// taking the best would give the same answer here, but it would make an exact id that is also
// another record's name prefix report as ambiguous, and "your exact id is ambiguous" is not a
// sentence an operator can act on.
type govMatchTier int

const (
	govMatchExactID govMatchTier = iota
	govMatchExactName
	govMatchPrefix
)

// govMatches returns the records matching query at one tier.
//
// Case-insensitive at every tier. Ids are UUIDs and names are typed by hand, so a shell that
// lower-cased a token, or an operator who typed `ops slack` for `Ops Slack`, is not a different
// record — and there is no naming scheme in this product where two records differ only by case.
func govMatches(refs []govRef, query string, tier govMatchTier) []govRef {
	var out []govRef
	q := strings.ToLower(strings.TrimSpace(query))
	for _, r := range refs {
		id, name := strings.ToLower(r.ID), strings.ToLower(r.Name)
		var hit bool
		switch tier {
		case govMatchExactID:
			hit = id != "" && id == q
		case govMatchExactName:
			hit = name != "" && name == q
		case govMatchPrefix:
			hit = (id != "" && strings.HasPrefix(id, q)) ||
				(name != "" && strings.HasPrefix(name, q))
		}
		if hit {
			out = append(out, r)
		}
	}
	return out
}

// govCandidateList renders the ambiguous candidates for an error message: their labels, one per
// line, indented.
//
// The LABELS rather than the ids, because the person who wrote an ambiguous query is choosing
// between records, not between tokens — and the label is what the picker would have shown them.
func govCandidateList(refs []govRef) string {
	lines := make([]string, len(refs))
	for i, r := range refs {
		lines[i] = "  " + r.Label
	}
	return strings.Join(lines, "\n")
}

// resolveGovRef answers "which record?" from an optional positional argument or the picker.
//
// An EMPTY candidate list is answered before anything else and without opening a picker: a form
// with no options is a form that cannot be answered, and huh renders it as an empty box the user
// must escape out of. The message names the list command instead.
func resolveGovRef(spec govSelectSpec, refs []govRef, args []string) (govRef, error) {
	query := ""
	if len(args) > 0 {
		query = strings.TrimSpace(args[0])
	}

	if len(refs) == 0 {
		return govRef{}, fmt.Errorf("no %s exists in this organization — run `%s` to check",
			spec.Noun, spec.ListCmd)
	}

	if query == "" {
		if err := requireInteractiveForm(); err != nil {
			return govRef{}, fmt.Errorf(
				"no %s given, and there is nowhere to ask: pass the %s's name or id as the argument (see `%s`) (%w)",
				spec.Noun, spec.Noun, spec.ListCmd, err)
		}
		return pickGovRef(spec, refs)
	}

	for _, tier := range []govMatchTier{govMatchExactID, govMatchExactName, govMatchPrefix} {
		hits := govMatches(refs, query, tier)
		switch len(hits) {
		case 0:
			continue
		case 1:
			return hits[0], nil
		default:
			return govRef{}, fmt.Errorf("%q matches %d %ss — name one exactly:\n%s",
				query, len(hits), spec.Noun, govCandidateList(hits))
		}
	}
	return govRef{}, fmt.Errorf("no %s matches %q — run `%s` to see what there is",
		spec.Noun, query, spec.ListCmd)
}

// pickGovRef shows the picker over already-fetched records.
//
// The option VALUE is the INDEX, not the id: the answer then needs no lookup, and there is no
// "the picker returned something I do not recognise" branch to write, test, or get wrong. huh can
// only write back one of the values it was given, and every index it was given is in range. This
// is the same reason pickJob does it, and the two must not disagree about it.
func pickGovRef(spec govSelectSpec, refs []govRef) (govRef, error) {
	options := make([]huh.Option[int], len(refs))
	for i, r := range refs {
		options[i] = huh.NewOption(r.Label, i)
	}
	chosen := 0
	if err := runHuhForm(
		huh.NewGroup(
			huh.NewSelect[int]().
				Title(spec.Title).
				Description(spec.Desc).
				Options(options...).
				Value(&chosen),
		),
	); err != nil {
		return govRef{}, err
	}
	return refs[chosen], nil
}

// govBullet joins the parts of a picker label with the shared bullet, dropping the parts that are
// empty so a record missing one field does not render a bullet with nothing on either side.
func govBullet(parts ...string) string {
	var kept []string
	for _, p := range parts {
		if strings.TrimSpace(p) != "" {
			kept = append(kept, p)
		}
	}
	return strings.Join(kept, " "+ui.SymbolBullet+" ")
}

// ── The three record kinds ────────────────────────────────────────────────────────────────────
//
// Each converter renders its label out of the same fields its `list` table shows, so a record
// reads the same in the picker as it does in the list the operator just ran. A picker that
// described a channel differently from `channels list` would be a third rendering of one record.

// channelSelect is the "which channel?" question.
var channelSelect = govSelectSpec{
	Noun:    "channel",
	Title:   "Select Channel",
	Desc:    "Notification destinations in this organization",
	ListCmd: "alethia channels list",
}

// govRefsFromChannels renders channels as selectable records.
func govRefsFromChannels(channels []api.Channel) []govRef {
	refs := make([]govRef, len(channels))
	for i, c := range channels {
		verified := "unverified"
		if c.IsVerified {
			verified = "verified"
		}
		refs[i] = govRef{
			ID:    c.ID,
			Name:  c.Name,
			Label: govBullet(c.Name, c.Type, verified, ui.TruncID(c.ID)),
		}
	}
	return refs
}

// alertRuleSelect is the "which alert rule?" question.
var alertRuleSelect = govSelectSpec{
	Noun:    "alert rule",
	Title:   "Select Alert Rule",
	Desc:    "Rules routing events to channels in this organization",
	ListCmd: "alethia alerts list",
}

// govRefsFromAlertRules renders alert rules as selectable records.
func govRefsFromAlertRules(rules []api.AlertRule) []govRef {
	refs := make([]govRef, len(rules))
	for i, r := range rules {
		refs[i] = govRef{
			ID:   r.ID,
			Name: r.Name,
			Label: govBullet(
				r.Name,
				r.Severity,
				fmt.Sprintf("%d event(s)", len(r.EventPatterns)),
				fmt.Sprintf("%d channel(s)", len(r.ChannelIDs)),
				ui.TruncID(r.ID),
			),
		}
	}
	return refs
}

// promotionSelect is the "which promotion?" question.
//
// A promotion has no name, so Name is left empty in every ref below and the matcher's name tier
// simply never fires for this kind. That is a deliberate absence rather than an oversight: filling
// Name with, say, "dev → prod" would make `promotion get "dev → prod"` resolve to whichever of a
// project's twenty dev-to-prod promotions happened to be listed, or — once there are two —
// nothing at all.
var promotionSelect = govSelectSpec{
	Noun:    "promotion",
	Title:   "Select Promotion",
	Desc:    "This project's promotions, newest first",
	ListCmd: "alethia promotion list",
}

// govRefsFromPromotions renders promotions as selectable records.
func govRefsFromPromotions(promos []api.Promotion) []govRef {
	refs := make([]govRef, len(promos))
	for i, p := range promos {
		refs[i] = govRef{
			ID: p.ID,
			Label: govBullet(
				p.Source+" "+ui.SymbolArrow+" "+p.Target,
				p.Status,
				ui.RelativeTime(p.CreatedAt),
				ui.TruncID(p.ID),
			),
		}
	}
	return refs
}
