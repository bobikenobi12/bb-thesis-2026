// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"errors"
	"fmt"
	"os"
	"strings"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/charmbracelet/huh"
)

// Which add-on? — the one spec behind `addon enable` and `addon disable`.
//
// Both took the catalog id as a REQUIRED positional, and both told the reader where to get one:
// "see `alethia addon list`". That sentence IS the handoff this programme exists to remove — a
// token the operator reads out of one command's output and pastes into the next.
//
// The id now has two sources, and they are two renderings of one spec:
//
//	positional   alethia addon disable loki -p web     an id you already have
//	the picker   alethia addon disable -p web          the env's add-ons, on a terminal
//
// There is deliberately no `--latest` here, unlike the jobs group. Add-ons are not ordered in
// time; "the most recent add-on" is not a thing an operator means, and inventing one would give
// `--yes` a target nobody named.
//
// ── AN ADD-ON ID IS A LOOKUP KEY, AND MORE ──────────────────────────────────────────────────────
//
// A catalog id addresses the `project_addons` row byte for byte, and it also becomes the name of
// the ArgoCD Application the runner renders for it. So a resolver that trimmed, lower-cased,
// slugified or otherwise "tidied" one would not merely miss a row: on the enable path it would
// write a DIFFERENT Application into the cluster, and on the disable path it would delete the row
// for an add-on the operator did not name. It is passed through untouched, and no listing call is
// even made when it was given.

// addonLister is the slice of the API client the resolver needs — small enough that the
// resolution logic is unit-testable against a fake, and satisfied by the concrete *api.Client.
type addonLister interface {
	GetProjectAddons(project, env string) (*api.ProjectAddons, error)
}

// addonRef is a resolved add-on: its id, plus the one-line summary of how it was found.
//
// Summary is EMPTY when the id came from the command line, and set when the CLI chose it. Callers
// use that difference: `addon disable` prints what it resolved to BEFORE it asks to confirm,
// because "Disable this add-on?" is not a question anyone can answer about a target they did not
// name.
type addonRef struct {
	ID      string
	Summary string
}

// addonPickPrompt is one command's rendering of the picker: what it asks, and what it says when
// the environment holds nothing to pick.
//
// The empty case gets its own sentence per command because the next step genuinely differs.
// `disable` on an empty environment is finished — there is nothing to take away. `enable` is not:
// the operator wanted to install something, and the id for a NOT-yet-installed add-on comes from
// the marketplace in the console, which is the one handoff this lane cannot remove (the CLI has
// no catalog endpoint to enumerate — see the docs page and #3710's report).
type addonPickPrompt struct {
	// Title heads the picker.
	Title string
	// Description is the picker's subtitle.
	Description string
	// Empty is what to say when the environment has no add-ons installed.
	Empty string
	// Verb prefixes the resolution line: "disabling", "reconfiguring".
	Verb string
}

// errAddonIDRequired is the refusal when no id was given and nothing may be prompted.
//
// Failing here rather than after the fetch is deliberate: the answer does not depend on what the
// control plane holds, so asking it would only slow the error down.
var errAddonIDRequired = errors.New(
	"no add-on id given, and there is nowhere to ask (--no-input, or stdin/stdout is not a " +
		"terminal): pass the add-on's catalog id as the first argument",
)

// resolveAddonID answers "which add-on" from the positional argument or the picker.
//
// project and env address the environment the picker lists; they are ignored on the positional
// path, which makes no call at all.
func resolveAddonID(c addonLister, args []string, project, env string, p addonPickPrompt) (addonRef, error) {
	if len(args) > 0 && args[0] != "" {
		return addonRef{ID: args[0]}, nil
	}
	if err := requireInteractiveForm(); err != nil {
		return addonRef{}, fmt.Errorf("%w (%s)", errAddonIDRequired, err)
	}
	view, err := c.GetProjectAddons(project, env)
	if err != nil {
		return addonRef{}, err
	}
	var installed []api.Addon
	if view != nil {
		installed = view.Addons
	}
	if len(installed) == 0 {
		return addonRef{}, errors.New(p.Empty)
	}
	return pickAddon(installed, p)
}

// pickAddon shows the interactive picker over the environment's installed add-ons.
//
// The option VALUE is the index rather than the add-on id, so the answer needs no lookup and
// there is no "the picker returned an id I do not recognise" branch to write, test, or get
// wrong. huh can only write back one of the values it was given, and every index it was given is
// in range.
func pickAddon(addons []api.Addon, p addonPickPrompt) (addonRef, error) {
	options := make([]huh.Option[int], len(addons))
	for i, a := range addons {
		options[i] = huh.NewOption(addonOptionLabel(a), i)
	}
	chosen := 0
	if err := runHuhForm(
		huh.NewGroup(
			huh.NewSelect[int]().
				Title(p.Title).
				Description(p.Description).
				Options(options...).
				Value(&chosen),
		),
	); err != nil {
		return addonRef{}, err
	}
	return addonRef{ID: addons[chosen].AddonID, Summary: addonOptionLabel(addons[chosen])}, nil
}

// addonOptionLabel renders one installed add-on as a single line:
// "loki · managed · 2.9.1 · Synced".
//
// Through the same ui helpers `addon list` renders its cells with, so an add-on reads the same in
// the picker as it does in the table — including the empty-value sentinel, which is the thing
// that had three spellings before #3696.
func addonOptionLabel(a api.Addon) string {
	sep := " " + ui.SymbolBullet + " "
	return strings.Join([]string{
		a.AddonID,
		ui.OrDash(a.Mode),
		ui.StrOrDash(a.Version),
		ui.StrOrDash(a.Sync),
	}, sep)
}

// announceResolvedAddon tells the reader which add-on the CLI chose, on STDERR.
//
// Stderr and not stdout, for the reason the jobs group records: the command's output is the
// document, and a line about which add-on it came from is a diagnostic. On stdout it would land
// inside a `-o json` payload and break the parse.
//
// Nothing is announced when the caller named the add-on — describing an id back at the person who
// typed it is noise, and it is the resolved case that needs saying.
func announceResolvedAddon(ref addonRef, verb string) {
	if ref.Summary == "" {
		return
	}
	fmt.Fprintln(os.Stderr, ui.MutedStyle.Render(ui.SymbolPoint+" "+verb+" "+ref.Summary))
}

// addonModeValues is every addon_mode, from the generated enum mirror.
//
// From `packages/core/types` and not a literal pair here: `addon_mode` is a drizzle enum, the
// server validates `mode` with `z.enum(addonMode.enumValues)`, and a hand-written copy in the CLI
// is a list that stops agreeing without anything saying so. A mode added to the schema reaches
// this validation, the flag help and the refusal message with nobody editing a list.
func addonModeValues() []string {
	out := make([]string, len(types.AllAddonModes))
	for i, m := range types.AllAddonModes {
		out[i] = string(m)
	}
	return out
}

// canonicalAddonMode maps a --mode value onto the enum value the wire takes, or refuses it by
// name.
//
// Two things at once, deliberately. The REFUSAL is the epic's "provable subset" rule: the CLI may
// only reject what the server would CERTAINLY reject, and a value outside `addon_mode` cannot be
// stored by anyone — so refusing it here hides nothing, while the server's answer to a typo is a
// 400 that has already cost a round trip.
//
// The CANONICALISATION is the other half. `--mode MANAGED` is refused by `z.enum(["managed",
// "gitops"])` for a difference in case alone, which is a 400 an operator has to read carefully to
// understand. Folding it to the enum's own spelling can only turn a certain refusal into the
// request they meant; it can never construct a value the server would not have taken, because the
// value sent is always one the enum contains.
func canonicalAddonMode(mode string) (string, error) {
	if mode == "" {
		return "", nil
	}
	allowed := addonModeValues()
	for _, m := range allowed {
		if strings.EqualFold(m, mode) {
			return m, nil
		}
	}
	return "", fmt.Errorf("--mode %q is not a delivery mode (want one of: %s)",
		mode, strings.Join(allowed, ", "))
}
