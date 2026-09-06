// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"os"
	"strings"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/charmbracelet/huh"
	"github.com/spf13/cobra"
)

var configCmd = &cobra.Command{
	Use:   "config",
	Short: "Show or edit CLI configuration",
	Long: `Show the resolved CLI configuration — the control-plane URL and its source
(env / config / default), the active organization context, and the on-disk
credentials and config file locations. Use 'config set'/'config get' to edit.`,
	Run: func(cmd *cobra.Command, args []string) {
		credsPath, _ := getCredentialsPath()
		cfgPath, _ := types.CliConfigPath()
		origin, source := types.ResolveWebOrigin()
		if err := runConfigShow(
			os.Stdout, outputFormat(cmd),
			origin, source, types.LoadCliConfig(), credsPath, cfgPath,
		); err != nil {
			fail(err)
		}
	},
}

var configSetCmd = &cobra.Command{
	Use:   "set [key] [value]",
	Short: "Set a config value",
	Long: `Persist a config value.

Run it with no arguments on a terminal to pick the key from a list and edit the
current value in place. The arguments are the complete non-interactive contract:
anything the form can ask, ` + "`set <key> <value>`" + ` can supply, so --no-input never
needs a prompt.`,
	Args: cobra.MaximumNArgs(2),
	Run: func(cmd *cobra.Command, args []string) {
		key, value := "", ""
		if len(args) > 0 {
			key = args[0]
		}
		if len(args) > 1 {
			value = args[1]
		}
		key, value, err := promptConfigSet(key, value)
		if err != nil {
			fail(err)
		}
		if err := runConfigSet(os.Stdout, key, value); err != nil {
			fail(err)
		}
	},
}

var configGetCmd = &cobra.Command{
	Use:   "get [key]",
	Short: "Get a config value",
	Args:  cobra.MaximumNArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		key := ""
		if len(args) > 0 {
			key = args[0]
		}
		if err := runConfigGet(os.Stdout, outputFormat(cmd), key); err != nil {
			fail(err)
		}
	},
}

var configClearContextCmd = &cobra.Command{
	Use:   "clear-context",
	Short: "Clear the active organization context",
	Run: func(cmd *cobra.Command, args []string) {
		cfg := types.LoadCliConfig()
		cfg.ActiveOrgID, cfg.ActiveOrgName, cfg.ActiveOrgSlug = "", "", ""
		if err := types.SaveCliConfig(cfg); err != nil {
			failf("Failed to clear context: %v", err)
		}
		ui.Success("Active organization context cleared.")
	},
}

var configExportCmd = &cobra.Command{
	Use:   "export [project]",
	Short: "Export a project's configuration to stdout or a file",
	Long: `Export a project's resolved configuration. By default the configuration
content is written to stdout; pass --out to write it to a file, or -o json to get
the export envelope (content + filename + format).`,
	Args: cobra.MaximumNArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		project := ""
		if len(args) > 0 {
			project = args[0]
		} else {
			project, err = selectProject(token)
			if err != nil {
				fail(err)
			}
		}
		contentFormat, _ := cmd.Flags().GetString("format")
		outFile, _ := cmd.Flags().GetString("out")
		if err := runConfigExport(
			api.NewClient(token), os.Stdout, outputFormat(cmd), project, contentFormat, outFile,
		); err != nil {
			failf("Failed to export configuration: %v", err)
		}
	},
}

// runConfigExport exports a project's configuration. It writes the raw content to
// a file (--out), emits the full export envelope as json (-o json), or prints the
// raw content to out (the default).
func runConfigExport(c apiClient, out io.Writer, displayFormat, projectName, contentFormat, outFile string) error {
	export, err := c.ExportConfiguration(projectName, contentFormat)
	if err != nil {
		return err
	}
	if outFile != "" {
		if err := os.WriteFile(outFile, []byte(export.Content), 0o644); err != nil {
			return fmt.Errorf("failed to write %s: %w", outFile, err)
		}
		fmt.Fprintln(out, ui.FormatSuccess(fmt.Sprintf("Wrote %s (%s)", outFile, export.Format)))
		return nil
	}
	if displayFormat == ui.FormatJSON {
		enc := json.NewEncoder(out)
		enc.SetIndent("", "  ")
		return enc.Encode(export)
	}
	fmt.Fprint(out, export.Content)
	if !strings.HasSuffix(export.Content, "\n") {
		fmt.Fprintln(out)
	}
	return nil
}

// configView is the json projection of the CLI config.
type configView struct {
	WebOrigin       string `json:"web_origin"`
	WebOriginSource string `json:"web_origin_source"`
	ActiveOrgName   string `json:"active_org_name"`
	ActiveOrgID     string `json:"active_org_id"`
	CredentialsPath string `json:"credentials_path"`
	ConfigPath      string `json:"config_path"`
}

// runConfigShow renders the resolved CLI configuration as a Field/Value view
// (table/csv) or a json object, annotating the web-origin with its source.
func runConfigShow(out io.Writer, format, webOrigin string, source types.WebOriginSource, cfg types.CliConfig, credsPath, cfgPath string) error {
	view := configView{
		WebOrigin:       webOrigin,
		WebOriginSource: string(source),
		ActiveOrgName:   cfg.ActiveOrgName,
		ActiveOrgID:     cfg.ActiveOrgID,
		CredentialsPath: credsPath,
		ConfigPath:      cfgPath,
	}
	rows := [][]string{
		{"web origin", fmt.Sprintf("%s (%s)", webOrigin, source)},
		{"active org", ui.OrDash(cfg.ActiveOrgName)},
		{"active org id", ui.OrDash(cfg.ActiveOrgID)},
		{"credentials", credsPath},
		{"config", cfgPath},
	}
	return ui.RenderCard(out, format, "alethia · config", rows, view)
}

// configField is ONE key of the CLI's on-disk configuration — what it is called,
// what it means, and how it is read and written.
//
// One spec, four renderings: `config get` reads through it, `config set` writes
// through it, `config set`'s interactive form builds its picker and its validator
// from it, and the "Config keys" table in
// apps/docs/content/docs/cli/configuration.mdx carries the same rows. The docs
// half is not a convention — TestHygCliAuthForm_ConfigKeyDocsTableMirrorsTheSpec
// fails if the table and this slice disagree in either direction.
//
// Before this there were four hand-written lists and they already disagreed.
// `config set` accepted `web-origin`; `config get` accepted `web-origin` and
// `active-org`; each error message spelled its own "supported:" list; and the
// docs page named a third set. A reader who ran `alethia config set active-org
// acme` — a key `config get` had just told them existed — was answered "unknown
// config key", with no hint that `alethia org switch` is what writes it.
type configField struct {
	// Key is the canonical spelling, and the one the docs table carries.
	Key string
	// Aliases are additional accepted spellings. The underscore forms exist
	// because the on-disk JSON uses them and people type what they have read.
	Aliases []string
	// Summary is the one sentence that appears in the form's description AND in
	// the docs table. One sentence, one owner.
	Summary string
	// Normalize validates and canonicalizes a candidate value. It is the form's
	// live validator and the `config set` gate — the same function, so a value the
	// form accepted can never be refused a moment later. nil for a read-only key.
	Normalize func(string) (string, error)
	// Apply writes a normalized value into the config. nil for a read-only key.
	Apply func(cfg *types.CliConfig, normalized string)
	// SetVia names the command that writes a READ-ONLY key. A key that can be read
	// and not written needs to say what does write it; "unknown key" would be a
	// lie, and silence would be worse.
	SetVia string
	// Read returns the key's current value, RAW — no placeholder for an empty one.
	// `config get` feeds it to json and csv as well as to the table, so a `—` here
	// would be a presentation glyph a script has to test for; the table branch of
	// runConfigGet applies ui.OrDash instead.
	//
	// It takes an origin as well as the stored config because `web-origin`'s value
	// can come from the environment, which is not in the file — and the two callers
	// mean different origins on purpose. `config get` passes the RESOLVED one
	// (what commands actually talk to); `config set`'s form passes the STORED one,
	// because the form seeds what the write is about to replace.
	Read func(cfg types.CliConfig, origin string) string
}

// settable reports whether `config set` may write this key.
func (f configField) settable() bool { return f.Normalize != nil && f.Apply != nil }

// configFields is the spec. Order is the order the docs table and the `get all`
// output use.
var configFields = []configField{
	{
		Key:       "web-origin",
		Aliases:   []string{"web_origin"},
		Summary:   "The control-plane URL the CLI talks to (hosted, self-hosted or dev).",
		Normalize: normalizeWebOrigin,
		Apply:     func(cfg *types.CliConfig, v string) { cfg.WebOrigin = v },
		Read:      func(_ types.CliConfig, origin string) string { return origin },
	},
	{
		Key:     "active-org",
		Aliases: []string{"active_org"},
		Summary: "The organization every request is scoped to, sent as X-Alethia-Org.",
		// Deliberately read-only. Setting it by name would have to resolve the name
		// to an id and a slug — which is a server round-trip, i.e. `org switch`. A
		// `config set active-org` that wrote only the name would leave the id stale
		// and every request scoped to the PREVIOUS organization.
		SetVia: "alethia org switch",
		Read:   func(cfg types.CliConfig, _ string) string { return cfg.ActiveOrgName },
	},
}

// lookupConfigField resolves a user-typed key to its spec, honouring aliases and
// case. Returns nil for an unknown key.
func lookupConfigField(key string) *configField {
	k := strings.ToLower(strings.TrimSpace(key))
	for i := range configFields {
		if configFields[i].Key == k {
			return &configFields[i]
		}
		for _, a := range configFields[i].Aliases {
			if a == k {
				return &configFields[i]
			}
		}
	}
	return nil
}

// configKeyList renders the canonical key names for an error message. settableOnly
// narrows it to the keys `config set` can write, so the two error messages cannot
// drift apart the way the hand-written ones did.
func configKeyList(settableOnly bool) string {
	names := make([]string, 0, len(configFields))
	for _, f := range configFields {
		if settableOnly && !f.settable() {
			continue
		}
		names = append(names, f.Key)
	}
	return strings.Join(names, ", ")
}

// runConfigSet validates and persists a single config key.
func runConfigSet(out io.Writer, key, value string) error {
	f := lookupConfigField(key)
	if f == nil {
		return fmt.Errorf("unknown config key %q (supported: %s)", key, configKeyList(false))
	}
	if !f.settable() {
		return fmt.Errorf("config key %q is read-only — set it with `%s`", f.Key, f.SetVia)
	}
	normalized, err := f.Normalize(value)
	if err != nil {
		return err
	}
	cfg := types.LoadCliConfig()
	f.Apply(&cfg, normalized)
	if err := types.SaveCliConfig(cfg); err != nil {
		return fmt.Errorf("failed to save config: %w", err)
	}
	fmt.Fprintln(out, ui.FormatSuccess(f.Key+" set to "+normalized))
	// The persisted value is not necessarily the EFFECTIVE one: $ALETHIA_WEB_ORIGIN
	// outranks the config file, so without this line `config set web-origin` reports
	// success and every subsequent command still talks to the environment's origin.
	if resolved, source := types.ResolveWebOrigin(); f.Key == "web-origin" &&
		source == types.WebOriginFromEnv && resolved != normalized {
		fmt.Fprintln(out, ui.MutedStyle.Render(fmt.Sprintf(
			"Note: $ALETHIA_WEB_ORIGIN is set to %s and outranks the config file, so commands still use it.",
			resolved)))
	}
	return nil
}

// runConfigGet prints one or all config values.
//
// The table format prints the BARE value and nothing else, because
// `$(alethia config get web-origin)` is the whole point of the command; json and
// csv render key/value pairs for a caller that wants them labelled. Before this
// the -o flag was accepted and silently ignored on every `config get`.
//
// ui.OrDash is applied HERE, in the table branches only. It is a placeholder for a
// person reading a column, and json and csv are read by programs: an unset key has
// to arrive as "" so an emptiness test answers "unset", rather than as an em dash
// that is non-empty and then flows into whatever the script feeds next.
func runConfigGet(out io.Writer, format, key string) error {
	cfg := types.LoadCliConfig()
	origin, _ := types.ResolveWebOrigin()

	if k := strings.ToLower(strings.TrimSpace(key)); k == "" || k == "all" {
		rows := make([][]string, 0, len(configFields))
		record := make(map[string]string, len(configFields))
		for _, f := range configFields {
			v := f.Read(cfg, origin)
			rows = append(rows, []string{f.Key, v})
			record[f.Key] = v
		}
		if format == "" || format == ui.FormatTable {
			for _, r := range rows {
				fmt.Fprintf(out, "%s: %s\n", r[0], ui.OrDash(r[1]))
			}
			return nil
		}
		return ui.Render(out, format, ui.TableSpec{Columns: []string{"Key", "Value"}, Rows: rows}, record)
	}

	f := lookupConfigField(key)
	if f == nil {
		return fmt.Errorf("unknown config key %q (supported: %s)", key, configKeyList(false))
	}
	v := f.Read(cfg, origin)
	if format == "" || format == ui.FormatTable {
		fmt.Fprintln(out, ui.OrDash(v))
		return nil
	}
	return ui.Render(out, format,
		ui.TableSpec{Columns: []string{"Key", "Value"}, Rows: [][]string{{f.Key, v}}},
		map[string]string{f.Key: v})
}

// promptConfigSet fills in a missing key or value from the interactive form, and
// returns what `config set` should act on.
//
// It is a package variable for the reason seams.go records: stubbing runHuhForm
// stops the prompt blocking, but no stub can answer through a pointer the huh
// group owns, so the ANSWERED branch is otherwise unreachable from a test.
//
// With prompting disabled it does not guess. `config set` with a missing argument
// under --no-input is a scripting mistake, and the error names the shape that
// works rather than silently writing a default.
var promptConfigSet = func(key, value string) (string, string, error) {
	if key != "" && value != "" {
		return key, value, nil
	}
	if !canPromptForm() {
		return "", "", fmt.Errorf(
			"config set needs a key and a value when prompts are disabled: alethia config set <%s> <value>",
			configKeyList(true))
	}

	if key == "" {
		opts := make([]huh.Option[string], 0, len(configFields))
		for _, f := range configFields {
			if !f.settable() {
				continue
			}
			opts = append(opts, huh.NewOption(f.Key+" — "+f.Summary, f.Key))
		}
		if len(opts) == 0 {
			// Unreachable while any key is settable, and a real answer if that ever
			// stops being true — an empty picker would otherwise render as a form with
			// nothing in it.
			return "", "", fmt.Errorf("no config key can be set from the CLI")
		}
		spec := mustAuthField("alethia config set", fieldKeyConfigKey)
		key = opts[0].Value
		if err := runHuhForm(huh.NewGroup(
			huh.NewSelect[string]().
				Title(spec.Title).
				Description(spec.Description).
				Options(opts...).
				Value(&key),
		)); err != nil {
			return "", "", err
		}
	}

	f := lookupConfigField(key)
	if f == nil {
		return "", "", fmt.Errorf("unknown config key %q (supported: %s)", key, configKeyList(false))
	}
	if !f.settable() {
		return "", "", fmt.Errorf("config key %q is read-only — set it with `%s`", f.Key, f.SetVia)
	}
	if value == "" {
		// Seeded with the STORED value so the form is an edit, not a re-type, and
		// validated by the SAME function `config set` gates on — a value the form
		// accepted can never be refused a moment later.
		//
		// Stored, not RESOLVED: `config set` writes the file, and $ALETHIA_WEB_ORIGIN
		// outranks the file, so seeding from types.ResolveWebOrigin() would put the
		// environment's origin in the box and a bare Enter would persist it OVER the
		// self-hosted origin in config.json that the user never touched. The note
		// runConfigSet prints would not save them either: after such a write the
		// resolved and stored values agree, so the one line that would have warned them
		// is exactly the line the overwrite suppresses.
		cfg := types.LoadCliConfig()
		storedOrigin := cfg.WebOrigin
		if storedOrigin == "" {
			// Nothing written yet. The hosted default is what the CLI is already using,
			// so it keeps the form an edit rather than an empty box.
			storedOrigin = types.DefaultWebOrigin
		}
		value = f.Read(cfg, storedOrigin)
		// The helper line is the CHOSEN KEY's summary, not the field's — see the
		// exception named on authField.Description. "The new value" would tell a
		// reader nothing they did not know from the title. When the environment
		// outranks what this form writes, it says so, because the box is then showing
		// a value that is not the one commands are using.
		description := f.Summary
		if resolved, source := types.ResolveWebOrigin(); f.Key == "web-origin" &&
			source == types.WebOriginFromEnv && resolved != value {
			description += fmt.Sprintf(
				" ($ALETHIA_WEB_ORIGIN is %s and outranks the file, so this edits what is stored, not what commands use.)",
				resolved)
		}
		spec := mustAuthField("alethia config set", fieldKeyValue)
		if err := runHuhForm(huh.NewGroup(
			huh.NewInput().
				Title(spec.Title + " · " + f.Key).
				Description(description).
				Value(&value).
				Validate(func(s string) error { _, err := f.Normalize(s); return err }),
		)); err != nil {
			return "", "", err
		}
	}
	return f.Key, value, nil
}

// normalizeWebOrigin validates a control-plane URL and returns it without a
// trailing slash. It requires an http/https scheme and a host.
func normalizeWebOrigin(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return "", fmt.Errorf("invalid web-origin %q (want e.g. https://alethialabs.io)", raw)
	}
	return strings.TrimRight(raw, "/"), nil
}

// saveActiveOrg persists the chosen org as the active CLI context, preserving the
// rest of the config (e.g. web-origin).
func saveActiveOrg(o api.OrgSummary) error {
	cfg := types.LoadCliConfig()
	cfg.ActiveOrgID = o.ID
	cfg.ActiveOrgName = o.Name
	cfg.ActiveOrgSlug = o.Slug
	return types.SaveCliConfig(cfg)
}

func init() {
	configExportCmd.Flags().String("format", "json", "Configuration content format")
	configExportCmd.Flags().String("out", "", "Write the configuration to this file instead of stdout")
	configCmd.AddCommand(configSetCmd)
	configCmd.AddCommand(configGetCmd)
	configCmd.AddCommand(configClearContextCmd)
	configCmd.AddCommand(configExportCmd)
	rootCmd.AddCommand(configCmd)
}
