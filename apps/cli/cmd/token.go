// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/charmbracelet/huh"
	"github.com/spf13/cobra"
)

// `alethia token` — manage the service-account tokens that let `alethia` run WITHOUT a browser.
//
// The device flow (`alethia login`) is the right experience at a terminal and an impossible one in
// a pipeline: it opens a browser and waits for a human. `--no-input` does not help — it suppresses
// prompts, it does not supply a credential. These commands mint the credential that does, and
// $ALETHIA_TOKEN is how a pipeline presents it.
var tokenCmd = &cobra.Command{
	Use:   "token",
	Short: "Manage service-account tokens for non-interactive use (CI, cron, pipelines)",
	Long: "Service-account tokens let `alethia` authenticate without a browser.\n\n" +
		"Mint one with `alethia token create`, put it in your pipeline's secret store, and set\n" +
		"$ALETHIA_TOKEN. The token acts as you, inside the organization it was minted for, and\n" +
		"can be revoked at any time — it stops working on the next request.",
}

var (
	tokenCreateName    string
	tokenCreateExpires int
)

var tokenListCmd = &cobra.Command{
	Use:   "list",
	Short: "List this organization's service-account tokens",
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		if err := runTokenList(api.NewClient(token), os.Stdout, outputFormat(cmd)); err != nil {
			failf("Failed to list tokens: %v", err)
		}
	},
}

// runTokenList is the testable half — the same client/writer/format shape runOrgList uses, so the
// cobra Run above stays thin glue and the behaviour is driven directly.
func runTokenList(c apiClient, out io.Writer, format string) error {
	tokens, err := c.ListServiceTokens()
	if err != nil {
		return err
	}
	if len(tokens) == 0 && format == ui.FormatTable {
		fmt.Fprintln(out, ui.MutedStyle.Render("No service tokens. Create one with `alethia token create --name ci`."))
		return nil
	}
	return ui.Render(out, format, ui.TableSpec{Columns: tokenListColumns, Rows: tokenRows(tokens, format)}, tokens)
}

var tokenListColumns = []string{"ID", "Name", "Prefix", "Created", "Expires", "Last used", "Status"}

func tokenRows(tokens []api.ServiceToken, outFmt string) [][]string {
	rows := make([][]string, 0, len(tokens))
	for _, t := range tokens {
		rows = append(rows, []string{
			t.ID,
			t.Name,
			t.TokenPrefix,
			ui.Cell(outFmt, t.CreatedAt, ui.StampOrDash(&t.CreatedAt)),
			ui.Cell(outFmt, ui.Wire(t.ExpiresAt), ui.StampOrNever(t.ExpiresAt)),
			ui.Cell(outFmt, ui.Wire(t.LastUsedAt), ui.StampOrNever(t.LastUsedAt)),
			tokenStatus(t),
		})
	}
	return rows
}

// tokenStatus collapses the three timestamps into the one word a reader wants.
//
// REVOKED WINS OVER EXPIRED. Both are inactive, but which came first is the fact an incident needs,
// and a token revoked in response to a leak must never be reported as having merely aged out.
func tokenStatus(t api.ServiceToken) string {
	if t.RevokedAt != nil && strings.TrimSpace(*t.RevokedAt) != "" {
		return "revoked"
	}
	if t.ExpiresAt != nil && strings.TrimSpace(*t.ExpiresAt) != "" {
		if exp, err := time.Parse(time.RFC3339, *t.ExpiresAt); err == nil && exp.Before(time.Now()) {
			return "expired"
		}
	}
	return "active"
}

var tokenCreateCmd = &cobra.Command{
	Use:   "create",
	Short: "Mint a service-account token (shown ONCE)",
	Long: "Mint a service-account token. Run it with no flags on a terminal and it asks for the\n" +
		"purpose and the lifetime; --name and --expires-in-days set the same two values without a\n" +
		"prompt, so --no-input never needs one.",
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		name, expires, err := promptTokenCreate(tokenCreateName, tokenCreateExpires)
		if err != nil {
			fail(err)
		}
		if err := runTokenCreate(api.NewClient(token), os.Stdout, os.Stderr, outputFormat(cmd), name, expires); err != nil {
			failf("%v", err)
		}
	},
}

// tokenExpiryOptions are the lifetimes the form offers, shortest-lived first
// after "never".
//
// Never is FIRST and is the default because it is the flag's default, and a form
// whose default disagrees with the flag's is two contracts wearing one name. It
// is not the recommendation — the description says so — but it is the answer a
// caller gets today when they pass no flag, and the form must not quietly change
// that for interactive users only.
var tokenExpiryOptions = []struct {
	Label string
	Days  int
}{
	{"Never expires", 0},
	{"30 days", 30},
	{"90 days", 90},
	{"365 days", 365},
}

// promptTokenCreate fills in the token's purpose and lifetime from the
// interactive form when --name was not supplied.
//
// --name is the trigger, not "any missing flag": --expires-in-days has a real
// default (0, never), so a caller who passed only a name has answered every
// question and must not be asked again. A caller who passed neither has answered
// none, and the required one is the name.
//
// A package variable for the reason seams.go records — see promptConfigSet.
var promptTokenCreate = func(name string, expiresInDays int) (string, int, error) {
	if strings.TrimSpace(name) != "" || !canPromptForm() {
		// Nothing to ask, or nothing that could answer. runTokenCreate reports the
		// missing --name; it holds that rule already and this must not grow a second
		// copy of it.
		return name, expiresInDays, nil
	}

	opts := make([]huh.Option[int], 0, len(tokenExpiryOptions)+1)
	known := false
	for _, o := range tokenExpiryOptions {
		opts = append(opts, huh.NewOption(o.Label, o.Days))
		if o.Days == expiresInDays {
			known = true
		}
	}
	// A --expires-in-days the presets do not carry must still be selectable, or the
	// form would silently discard a value the caller explicitly passed.
	if !known {
		opts = append(opts, huh.NewOption(fmt.Sprintf("%d days (--expires-in-days)", expiresInDays), expiresInDays))
	}

	nameSpec := mustAuthField("alethia token create", fieldKeyName)
	expirySpec := mustAuthField("alethia token create", fieldKeyExpires)
	days := expiresInDays
	err := runHuhForm(huh.NewGroup(
		huh.NewInput().
			Title(nameSpec.Title).
			Description(nameSpec.Description).
			Placeholder("github-actions").
			Value(&name).
			Validate(func(s string) error {
				if strings.TrimSpace(s) == "" {
					return errors.New("a name is required")
				}
				return nil
			}),
		huh.NewSelect[int]().
			Title(expirySpec.Title).
			Description(expirySpec.Description).
			Options(opts...).
			Value(&days),
	))
	if err != nil {
		return "", 0, err
	}
	return name, days, nil
}

// runTokenCreate mints one and surfaces it exactly once.
//
// THE VALUE GOES TO `out`, EVERYTHING ELSE TO `errOut`. That split is the feature: it makes
// `alethia token create --name ci | gh secret set ALETHIA_TOKEN` do the right thing, so nobody has
// to select a credential out of a decorated block by eye.
func runTokenCreate(c apiClient, out, errOut io.Writer, format, name string, expiresInDays int) error {
	name = strings.TrimSpace(name)
	if name == "" {
		return errors.New("--name is required: a list of tokens should be a list of PURPOSES, not of prefixes")
	}
	created, err := c.CreateServiceToken(name, expiresInDays)
	if err != nil {
		return fmt.Errorf("failed to create token: %w", err)
	}
	if format != ui.FormatTable {
		// The caller is a program; the plain value is what it needs.
		return ui.Render(out, format, ui.TableSpec{
			Columns: []string{"ID", "Name", "Prefix", "Token"},
			Rows:    [][]string{{created.ID, created.Name, created.TokenPrefix, created.Token}},
		}, created)
	}
	fmt.Fprintln(errOut)
	fmt.Fprintln(errOut, ui.MutedStyle.Render(created.Warning))
	// The metadata goes through the SAME card `alethia config` and `alethia whoami`
	// use. It was a hand-rolled key/value block with its own two-space gutter, which
	// is how one product came to render a single record three different ways
	// depending on which command you had run.
	//
	// `record` is nil on purpose: this branch is only ever the table format (the
	// machine formats return above), and RenderCard reads the record only for json.
	cardErr := ui.RenderCard(errOut, ui.FormatTable, "alethia · token created", [][]string{
		{"id", created.ID},
		{"name", created.Name},
		{"prefix", created.TokenPrefix},
		{"expires", ui.StampOrNever(created.ExpiresAt)},
	}, nil)
	// The credential is written BEFORE the card's error is reported. The token exists
	// server-side by now, the server keeps only its hash, and this is the one moment it
	// is ever shown — so returning on a failed write to `errOut` would cost the user the
	// value itself and leave them to revoke and mint again. `alethia token create --name
	// ci > token.txt 2>&-` is enough to hit it. The decoration is what may be lost here,
	// never the product.
	fmt.Fprintln(out, created.Token)
	if cardErr != nil {
		return cardErr
	}
	fmt.Fprintln(errOut)
	fmt.Fprintln(errOut, ui.MutedStyle.Render("Use it with:  export ALETHIA_TOKEN=…   (or --token)"))
	return nil
}

var tokenRevokeCmd = &cobra.Command{
	Use:   "revoke [id]",
	Short: "Revoke a service-account token",
	Long: "Revoke a service-account token. Omit the id on a terminal to pick from the live tokens;\n" +
		"pass it to revoke without a prompt.\n\n" +
		"There is no --yes. Revocation is a SAFETY action and its asymmetry runs the other way:\n" +
		"revoking a token you did not mean to costs one `token create`, while failing to revoke a\n" +
		"leaked one costs the organization. A confirmation here fails the incident-response pipeline\n" +
		"and leaves the credential live.",
	Args: cobra.MaximumNArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		client := api.NewClient(token)
		id := ""
		if len(args) > 0 {
			// Trimmed, and a blank argument counts as ABSENT. `alethia token revoke
			// "$TOKEN_ID"` with the variable unset would otherwise send
			// `DELETE /api/cli/tokens/` — a request naming nothing, answered with a 404
			// that reads as "that token does not exist" rather than "you passed nothing".
			id = strings.TrimSpace(args[0])
		}
		if id == "" {
			// The handoff this removes: before it, `token revoke` could only be reached
			// by running `token list` and copying an opaque id out of its output by eye.
			if id, err = selectServiceToken(client); err != nil {
				fail(err)
			}
		}
		if err := runTokenRevoke(client, os.Stdout, id); err != nil {
			failf("Failed to revoke token: %v", err)
		}
	},
}

// selectServiceToken shows the picker `token revoke` uses when no id was given.
//
// Already-revoked tokens are left out: revoking one again is a no-op, and the
// list a person scans in an incident should carry only the credentials that are
// still live. Expired ones stay — an expiry can be wrong, and a reader revoking
// on purpose should not have to reason about whether the clock agrees with them.
//
// A package variable for the reason seams.go records — see promptConfigSet.
var selectServiceToken = func(c apiClient) (string, error) {
	if err := requireInteractiveForm(); err != nil {
		return "", err
	}
	var tokens []api.ServiceToken
	var err error
	runSpinner("Fetching service tokens...", func() {
		tokens, err = c.ListServiceTokens()
	})
	if err != nil {
		return "", err
	}

	opts := make([]huh.Option[string], 0, len(tokens))
	for _, t := range tokens {
		if tokenStatus(t) == "revoked" {
			continue
		}
		opts = append(opts, huh.NewOption(fmt.Sprintf("%s (%s) · %s · last used %s",
			t.Name, t.TokenPrefix, tokenStatus(t), ui.StampOrNever(t.LastUsedAt)), t.ID))
	}
	if len(opts) == 0 {
		// Two different situations, and they are NOT worth two messages: either way
		// there is nothing to revoke, and the next step is the same.
		return "", errors.New("no live service tokens to revoke — `alethia token list` shows what exists")
	}

	spec := mustAuthField("alethia token revoke", fieldKeyTokenID)
	id := opts[0].Value
	if err := runHuhForm(huh.NewGroup(
		huh.NewSelect[string]().
			Title(spec.Title).
			Description(spec.Description).
			Options(opts...).
			Value(&id),
	)); err != nil {
		return "", err
	}
	return id, nil
}

// runTokenRevoke revokes one by id. It takes effect on the token's very next request, because
// `resolveServiceToken` filters on `revoked_at` inside the lookup query itself.
func runTokenRevoke(c apiClient, out io.Writer, id string) error {
	if err := c.RevokeServiceToken(id); err != nil {
		return err
	}
	fmt.Fprintln(out, ui.MutedStyle.Render(fmt.Sprintf("Revoked %s — it stops working on its next request.", id)))
	return nil
}

func init() {
	tokenCreateCmd.Flags().StringVar(&tokenCreateName, "name", "", "What this token is for (required)")
	tokenCreateCmd.Flags().IntVar(&tokenCreateExpires, "expires-in-days", 0,
		"Days until the token expires. 0 (the default) never expires — a deliberate choice, not an oversight.")
	tokenCmd.AddCommand(tokenListCmd, tokenCreateCmd, tokenRevokeCmd)
	rootCmd.AddCommand(tokenCmd)
}
