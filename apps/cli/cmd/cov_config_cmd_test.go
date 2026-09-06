// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The `alethia config` verbs driven through the real cobra tree.
//
// The subject is the command surface: the resolved-config card, get and set for each supported key,
// clearing the active-org context, the three export destinations, and what each does when the write
// fails. config_test.go holds the same package's pure functions and config_export_test.go the
// export projection; this file is the one that executes the commands.

// TestMisc_ConfigSurface pins the config verbs: the resolved-config card, get for each
// supported key, a validated set, and clearing the active-org context.
func TestMisc_ConfigSurface(t *testing.T) {
	run := miscEnv(t, miscFull)
	cases := [][]string{
		{"config", "--output", "table"},
		{"config", "--output", "json"},
		{"config", "--output", "csv"},
		{"config", "get"},
		{"config", "get", "web-origin"},
		{"config", "get", "active-org"},
		{"config", "set", "web-origin", "https://alethia.example.com/"},
		{"config", "clear-context"},
	}
	for _, args := range cases {
		t.Run(strings.Join(args, "_"), func(t *testing.T) {
			full := args
			if !strings.Contains(strings.Join(args, " "), "--output") {
				full = append(append([]string{}, args...), "--output", "table")
			}
			if err := run(append(full, "--no-input")...); err != nil {
				t.Errorf("%v: %v", args, err)
			}
		})
	}
}

// TestMisc_ConfigRejectsUnknownKeys pins that an unrecognised config key is a hard error
// on both get and set, rather than silently doing nothing.
func TestMisc_ConfigRejectsUnknownKeys(t *testing.T) {
	run := miscTrapExit(t, miscEnv(t, miscFull))
	if !run("config", "get", "nope", "--output", "table", "--no-input") {
		t.Error("config get: expected the fatal path for an unknown key")
	}
	if !run("config", "set", "nope", "x", "--output", "table", "--no-input") {
		t.Error("config set: expected the fatal path for an unknown key")
	}
	if !run("config", "set", "web-origin", "not-a-url", "--output", "table", "--no-input") {
		t.Error("config set: expected the fatal path for an invalid origin")
	}
}

// TestMisc_ConfigExport pins the three export destinations: raw content on stdout, the
// envelope as json, and a file written by --out.
func TestMisc_ConfigExport(t *testing.T) {
	run := miscEnv(t, miscFull)
	if err := run("config", "export", "web", "--output", "table", "--no-input"); err != nil {
		t.Fatalf("config export raw: %v", err)
	}
	if err := run("config", "export", "web", "--output", "json", "--no-input"); err != nil {
		t.Fatalf("config export json: %v", err)
	}
	out := t.TempDir() + "/export.yaml"
	if err := run("config", "export", "web", "--out", out, "--output", "table", "--no-input"); err != nil {
		t.Fatalf("config export --out: %v", err)
	}
	if _, err := os.Stat(out); err != nil {
		t.Errorf("--out did not write the file: %v", err)
	}
}

// TestMisc_ConfigExportNeedsAProject pins that omitting the project falls back to the
// interactive picker, which refuses under --no-input rather than exporting the wrong
// project.
func TestMisc_ConfigExportNeedsAProject(t *testing.T) {
	run := miscTrapExit(t, miscEnv(t, miscFull))
	if !run("config", "export", "--out", "", "--output", "table", "--no-input") {
		t.Error("expected the fatal path when no project is given and prompts are disabled")
	}
}

// TestMisc_ConfigExportPickerRunsInteractively pins that with a TTY the same command
// reaches the project picker (which cannot complete headlessly, so the command exits).
func TestMisc_ConfigExportPickerRunsInteractively(t *testing.T) {
	miscTTY(t)
	run := miscTrapExit(t, miscEnv(t, miscFull))
	if !run("config", "export", "--out", "", "--output", "table", "--no-input=false") {
		t.Error("expected the fatal path when the picker cannot be answered")
	}
}

// TestMisc_ConfigExportFailureIsFatal pins that an export the control plane refuses exits
// non-zero, rather than writing an empty file or an empty stdout.
func TestMisc_ConfigExportFailureIsFatal(t *testing.T) {
	exits := miscFatalRunner(miscAdminEnv(t, miscAdminOpts{failOn: "/api/cli/"}))
	if !exits("config", "export", "web", "--output", "json") {
		t.Error("expected a refused export to be fatal")
	}
}

// TestMisc_ConfigExportToAnUnwritablePathIsFatal pins that a --out the CLI cannot write is
// reported, instead of the export silently going nowhere.
func TestMisc_ConfigExportToAnUnwritablePathIsFatal(t *testing.T) {
	exits := miscFatalRunner(miscAdminEnv(t, miscAdminOpts{}))
	dest := filepath.Join(t.TempDir(), "no-such-dir", "export.yaml")
	if !exits("config", "export", "web", "--out", dest, "--output", "table") {
		t.Error("expected an unwritable --out to be fatal")
	}
}

// TestMisc_ConfigWritesReportAFailedSave pins that `config set` and `config clear-context`
// report a config file they could not persist. Both are the only place the CLI's own state
// is written, so a silent failure would leave the user with stale settings.
func TestMisc_ConfigWritesReportAFailedSave(t *testing.T) {
	// A regular file where the config DIRECTORY should be: MkdirAll then fails.
	blocked := filepath.Join(t.TempDir(), "not-a-dir")
	if err := os.WriteFile(blocked, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", blocked)
	t.Setenv("XDG_CONFIG_HOME", blocked)
	t.Setenv("ALETHIA_NO_UPDATE_CHECK", "1")

	exits := miscTrapExit(t, func(args ...string) error {
		miscResetNoInput()
		execRootArgs(args)
		return rootCmd.Execute()
	})
	for _, args := range [][]string{
		{"config", "set", "web-origin", "https://cp.example.com"},
		{"config", "clear-context"},
	} {
		if !exits(append(args, "--output", "table")...) {
			t.Errorf("%v: expected an unwritable config to be fatal", args)
		}
	}
}
