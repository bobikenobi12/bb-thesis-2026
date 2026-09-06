// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"sort"
	"strings"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/charmbracelet/huh"
	"github.com/spf13/cobra"
)

const (
	// connectorBaseURL hosts the public copies of the setup artifacts used by
	// the guided-manual fallbacks (provisioned by infra/connector-assets).
	connectorBaseURL     = "https://alethia-connector-assets.s3.eu-west-1.amazonaws.com"
	gcpCloudShellURL     = "https://shell.cloud.google.com/cloudshell/open?shellonly=true&show=terminal"
	azureCloudShellURL   = "https://shell.azure.com"
	alibabaCloudShellURL = "https://shell.aliyun.com"
	awsCloudShellURL     = "https://console.aws.amazon.com/cloudshell/home"
)

var connectorCmd = &cobra.Command{
	Use:   "connector",
	Short: "Connect cloud provider accounts (AWS, GCP, Azure, Alibaba, Hetzner)",
	Long: `Manage cloud provider connections.

Connecting a cloud account lets Alethia provision infrastructure into it using
short-lived, keyless credentials: AWS cross-account roles, GCP Workload Identity
Federation, Azure federated identity, and Alibaba RAM AssumeRoleWithOIDC. No
long-lived secrets are stored.

Hetzner is the exception, and the exception is the cloud's, not Alethia's: Hetzner
Cloud offers no OIDC or role-assumption mechanism, so it authenticates with a scoped
API token. The token is encrypted at rest server-side and never returned.`,
}

func init() {
	rootCmd.AddCommand(connectorCmd)
}

// initProviderIdentity creates (or reuses) the user's pending identity for a
// provider, with a spinner.
func initProviderIdentity(apiClient *api.Client, provider string) (*api.InitIdentityResponse, error) {
	var resp *api.InitIdentityResponse
	var err error
	runSpinner("Initializing connection...", func() {
		resp, err = apiClient.InitProviderIdentity(provider)
	})
	return resp, err
}

// finalizeConnection submits the captured credentials and reports the verdict. The
// server verifies the identity INLINE (a synchronous health probe) and returns the
// result directly — there is no CONNECTION_TEST job to wait for.
func finalizeConnection(
	apiClient *api.Client,
	provider, identityID string,
	creds map[string]interface{},
) error {
	var resp *api.ConnectIdentityResponse
	var err error
	runSpinner("Submitting credentials & running connection test...", func() {
		resp, err = apiClient.ConnectProviderIdentity(provider, identityID, creds)
	})
	if err != nil {
		return err
	}

	if !resp.Verified {
		if resp.Error != "" {
			return fmt.Errorf("connection test failed (%s): %s", resp.Status, resp.Error)
		}
		return fmt.Errorf("connection test failed (%s)", resp.Status)
	}

	if resp.Status == "degraded" && len(resp.MissingPermissions) > 0 {
		ui.Warning(fmt.Sprintf(
			"Connected, but missing some provisioning permissions: %s",
			strings.Join(resp.MissingPermissions, ", "),
		))
		return nil
	}
	ui.Success("Connection verified")
	return nil
}

// isCloudProviderSlug reports whether ref names a cloud provider.
//
// The set is types.AllCloudProviders — the GENERATED mirror of the `cloud_provider` Postgres
// enum, diff-gated against lib/db/schema/enums.ts. A hand-written list here would stop
// covering silently the moment a seventh cloud is added, and the failure would be invisible:
// `alethia cloud inventory <newcloud>` would fall through and be sent to the server as an
// identity id, which reads as "that account does not exist".
func isCloudProviderSlug(ref string) bool {
	for _, p := range types.AllCloudProviders {
		if string(p) == ref {
			return true
		}
	}
	return false
}

// resolveCloudIdentityRef turns the optional `[provider|cloud-identity-id]` argument of a
// read command into the identity id to operate on.
//
// This is the handoff removal. `alethia cloud inventory` used to take a bare
// `<cloud-identity-id>` — an opaque token a reader had to copy out of another command's
// output, which is exactly the class of manual step this programme exists to delete. It now
// takes a provider name, or nothing at all and shows a picker.
//
// An id is NEVER reshaped. A stored cloud-identity id is a lookup key: a resolver that
// trimmed, lower-cased or re-formatted one would rename a live record's address. So only a
// value that IS a provider slug is resolved; everything else is passed through byte for
// byte, and no request is made to list identities at all.
func resolveCloudIdentityRef(lister cloudIdentityLister, ref string) (string, error) {
	if ref != "" && !isCloudProviderSlug(ref) {
		return ref, nil
	}

	if ref == "" {
		if err := requireInteractiveForm(); err != nil {
			return "", fmt.Errorf(
				"no cloud account given: pass a provider (%s) or a cloud-identity id as the argument (%w)",
				strings.Join(connectorProviderNames(), ", "), err,
			)
		}
	}

	var identities []api.CloudIdentity
	var err error
	runSpinner("Fetching cloud connections...", func() {
		identities, err = lister.GetCloudIdentities()
	})
	if err != nil {
		return "", fmt.Errorf("failed to fetch cloud connections: %w", err)
	}
	if len(identities) == 0 {
		return "", fmt.Errorf("no cloud accounts connected — run `alethia connector` first")
	}

	if ref != "" {
		matches := make([]api.CloudIdentity, 0, 1)
		for _, id := range identities {
			if id.Provider == ref {
				matches = append(matches, id)
			}
		}
		switch len(matches) {
		case 0:
			// The slug set and the remediation come from two different lists on purpose:
			// isCloudProviderSlug is the generated `cloud_provider` enum (so a cloud the schema
			// knows is never mistaken for an identity id), while `alethia connector` only has
			// leaves for the clouds the CLI can actually connect. Naming the leaf without
			// checking it exists promised `alethia connector civo`, which exits with cobra's
			// `unknown command "civo"`.
			if !connectorHasProvider(ref) {
				return "", fmt.Errorf(
					"no connected %s account found, and the CLI cannot connect one — `alethia connector` covers %s",
					ref, strings.Join(connectorProviderNames(), ", "),
				)
			}
			return "", fmt.Errorf("no connected %s account found — run `alethia connector %s` first", ref, ref)
		case 1:
			return matches[0].ID, nil
		default:
			// Ambiguity is reported, never guessed. Picking the first would silently read a
			// different account than the one the user meant, and the two differ by nothing the
			// output shows.
			ids := make([]string, len(matches))
			for i, m := range matches {
				ids[i] = m.ID
			}
			return "", fmt.Errorf(
				"%d connected %s accounts — pass the cloud-identity id instead (%s)",
				len(matches), ref, strings.Join(ids, ", "),
			)
		}
	}

	return pickConnectedIdentity("Select a cloud account", identities)
}

// pickConnectedIdentity shows the picker over already-fetched connections and returns the
// chosen identity id. The title is the caller's, because "Select a cloud account" and
// "Select a connection to REMOVE" are not the same question to answer.
func pickConnectedIdentity(title string, identities []api.CloudIdentity) (string, error) {
	options := make([]huh.Option[string], len(identities))
	for i, id := range identities {
		options[i] = huh.NewOption(
			fmt.Sprintf("%s — %s", strings.ToUpper(id.Provider), id.Label),
			id.ID,
		)
	}
	var chosen string
	if err := runHuhForm(huh.NewGroup(
		huh.NewSelect[string]().
			Title(title).
			Options(options...).
			Value(&chosen),
	)); err != nil {
		return "", err
	}
	if chosen == "" {
		return "", fmt.Errorf("no cloud account selected")
	}
	return chosen, nil
}

// connectorProviderNames lists the providers `alethia connector` can connect, derived from
// the registered subcommands rather than typed out — a second hand-written copy of the list
// is how the parent command's help and its subcommands drift apart.
func connectorProviderNames() []string {
	names := make([]string, 0, len(connectorCmd.Commands()))
	for _, c := range connectorCmd.Commands() {
		switch c.Name() {
		case "list", "remove":
			continue
		}
		names = append(names, c.Name())
	}
	sort.Strings(names)
	return names
}

// connectorHasProvider reports whether `alethia connector <name>` is a REGISTERED leaf, which
// is a narrower question than "is this a cloud provider": the `cloud_provider` enum carries
// clouds the CLI has no connector for.
func connectorHasProvider(name string) bool {
	for _, n := range connectorProviderNames() {
		if n == name {
			return true
		}
	}
	return false
}

// modeFlag pairs a setup-mode flag's name with whether this invocation gave it.
type modeFlag struct {
	name string
	on   bool
}

// refuseMultipleModes refuses more than one setup mode on a single command line.
//
// Every connector resolves its setup with a switch, and a switch settles a combination by
// PRECEDENCE rather than by refusing it: `connector alibaba --terraform --role-arn acs:…` wrote
// no OpenTofu module, said nothing about having ignored --terraform, and connected. The user
// asked for a module on disk and got a connection. An ignored flag is the same class of defect
// as a missing one, so the combination is named and refused — before anything is created
// server-side, since the flags alone show the mistake.
func refuseMultipleModes(modes ...modeFlag) error {
	given := make([]string, 0, len(modes))
	for _, m := range modes {
		if m.on {
			given = append(given, m.name)
		}
	}
	if len(given) < 2 {
		return nil
	}
	return fmt.Errorf(
		"%s cannot be combined — each asks for a different setup, so pass one of them",
		strings.Join(given, ", "),
	)
}
