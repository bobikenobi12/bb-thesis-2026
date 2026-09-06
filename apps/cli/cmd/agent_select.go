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
	"github.com/charmbracelet/huh"
)

// Which agent identity? — the resolver behind `agent get`.
//
// `agent get <agent-id>` took the id as a REQUIRED positional and its docs page said the id comes
// "from `agent list`". That sentence is the handoff: a token a reader copies out of one command's
// output into the next, which is exactly what this programme is measured on removing.
//
//	positional   alethia agent get ag_01J8…    an id you already have
//	the picker   alethia agent get             the identities you can see, on a terminal
//
// An agent id is a LOOKUP KEY: `GET /cli/agents/<id>` addresses the record by it, so it is handed
// through byte for byte and no listing call is made when one was given. Nothing here resolves a
// PERSONA to an id, deliberately — personas are not unique, and a resolver that picked "the one
// whose persona matches" would silently read a different identity's mission and tool scope the
// day a second agent took the same persona.

// agentLister is the slice of the API client the resolver needs, satisfied by *api.Client.
type agentLister interface {
	ListAgents() ([]api.Agent, error)
}

// errAgentIDRequired is the refusal when no id was given and nothing may be prompted.
var errAgentIDRequired = errors.New(
	"no agent id given, and there is nowhere to ask (--no-input, or stdin/stdout is not a " +
		"terminal): pass the agent identity's id as the first argument",
)

// agentRef is a resolved agent identity: its id, plus the summary of how it was found. Summary is
// empty when the caller named the id.
type agentRef struct {
	ID      string
	Summary string
}

// resolveAgentID answers "which agent identity" from the positional argument or the picker.
func resolveAgentID(c agentLister, args []string) (agentRef, error) {
	if len(args) > 0 && args[0] != "" {
		return agentRef{ID: args[0]}, nil
	}
	if err := requireInteractiveForm(); err != nil {
		return agentRef{}, fmt.Errorf("%w (%s)", errAgentIDRequired, err)
	}
	agents, err := c.ListAgents()
	if err != nil {
		return agentRef{}, err
	}
	if len(agents) == 0 {
		return agentRef{}, errors.New(
			"no agent identities to choose from — create one in the console, then `alethia agent list` will show it")
	}
	return pickAgent(agents)
}

// pickAgent shows the interactive picker over the caller's agent identities.
//
// The option VALUE is the index, not the id: huh can only write back one of the values it was
// given, so there is no "the picker returned an id I do not recognise" branch to get wrong.
func pickAgent(agents []api.Agent) (agentRef, error) {
	options := make([]huh.Option[int], len(agents))
	for i, a := range agents {
		options[i] = huh.NewOption(agentOptionLabel(a), i)
	}
	chosen := 0
	if err := runHuhForm(
		huh.NewGroup(
			huh.NewSelect[int]().
				Title("Select Agent Identity").
				Description("Persona · memory namespace · id").
				Options(options...).
				Value(&chosen),
		),
	); err != nil {
		return agentRef{}, err
	}
	return agentRef{ID: agents[chosen].ID, Summary: agentOptionLabel(agents[chosen])}, nil
}

// agentOptionLabel renders one identity as a single line: "reviewer · mem/reviewer · ag_01J8Z9…".
//
// Through the same ui helpers `agent list` renders its cells with, so an identity reads the same
// in the picker as it does in the table.
func agentOptionLabel(a api.Agent) string {
	sep := " " + ui.SymbolBullet + " "
	return strings.Join([]string{
		ui.OrDash(a.Persona),
		ui.OrDash(a.MemoryNamespace),
		ui.TruncID(a.ID),
	}, sep)
}

// announceResolvedAgent names the identity the CLI chose, on STDERR — so `agent get -o json`
// still emits a document that parses.
func announceResolvedAgent(ref agentRef) {
	if ref.Summary == "" {
		return
	}
	fmt.Fprintln(os.Stderr, ui.MutedStyle.Render(ui.SymbolPoint+" reading "+ref.Summary))
}
