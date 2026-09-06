// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/apps/cli/internal/version"
)

// #3847 introduced these two, and they are the package's only statements that no test reaches.
//
// They are worth covering rather than excusing, but the reason to write this file NOW is narrower
// and worth recording: #3847 took `cmd` UNDER its committed coverage floor — by 0.0012 percentage
// points, with both sides displaying "99.16%", because the ratchet compares the integers by
// cross-multiplication and not the rendered percentage. It measured green on the branch and red as
// merged, so the branch's own gate could not see it. Two statements is the whole of the debt.
//
// The alternative was to lower the floor. Fixing the coverage keeps the ratchet where it is, which
// is the point of having one.

// TestMustShellField_PanicsOnAMissWithAUsableMessage drives the panic arm of mustShellField.
//
// The function's own doc says a miss is a programming error — both arguments are package constants
// — and that the alternative, returning a zero shellField, would register a flag with an empty
// name. That reasoning is only worth anything if the panic actually fires, so this asserts it does,
// and that the message names BOTH halves of the lookup plus where to fix it. A panic that says
// "not found" and nothing else costs the reader the search this message saves.
func TestMustShellField_PanicsOnAMissWithAUsableMessage(t *testing.T) {
	defer func() {
		r := recover()
		if r == nil {
			t.Fatal("mustShellField returned for a key that does not exist; a zero shellField " +
				"would register a flag with an empty name, which is why this must panic")
		}
		msg, ok := r.(string)
		if !ok {
			t.Fatalf("panic value = %#v; want the formatted string", r)
		}
		for _, want := range []string{"no-such-key", "alethia no-such-command", "shell_fields.go"} {
			if !strings.Contains(msg, want) {
				t.Errorf("panic message %q does not name %q — it should say what was looked up "+
					"and where the table is", msg, want)
			}
		}
	}()
	_ = mustShellField("alethia no-such-command", "no-such-key")
}

// TestMustShellField_FindsARealFieldOnTheRightCommand is the control for the panic above.
//
// Without it, a mustShellField that panicked unconditionally would pass the test above — the
// assertion would be satisfied for the wrong reason. It also pins that the match is on BOTH
// Command and Key: the same key on a different command must still miss.
func TestMustShellField_FindsARealFieldOnTheRightCommand(t *testing.T) {
	if len(shellFields) == 0 {
		t.Fatal("shellFields is empty, so every assertion in this file is vacuous")
	}
	want := shellFields[0]
	got := mustShellField(want.Command, want.Key)
	if got.Command != want.Command || got.Key != want.Key {
		t.Fatalf("mustShellField(%q,%q) = {%q,%q}", want.Command, want.Key, got.Command, got.Key)
	}

	defer func() {
		if recover() == nil {
			t.Error("the same key on a different command resolved; the lookup must match BOTH")
		}
	}()
	_ = mustShellField("alethia definitely-not-a-command", want.Key)
}

// TestVersion_TheUpdateNoticePathRuns drives `alethia version` with a REAL version string.
//
// The existing arm runs `version` and asserts only that it does not error. `version.Version` is
// "dev" in a test binary, and the command returns immediately on that — so everything after the
// first line, the whole update-notice path, has never executed. A shipped command's second half
// was untested because the fixture never gave it a version to compare.
//
// This sets one, so the fetch/cache/compare arms run. It asserts the build line rather than the
// notice: whether a newer release exists depends on the fake control plane and on an on-disk
// cache, and pinning "no notice" would pass for the wrong reason on a machine that happens to
// have one cached. What must hold is that asking for a real version still prints that version.
func TestVersion_TheUpdateNoticePathRuns(t *testing.T) {
	prev := version.Version
	version.Version = "1.2.3"
	t.Cleanup(func() { version.Version = prev })

	run := miscAdminEnv(t, miscAdminOpts{})
	out := connCaptureStdout(t, func() {
		if err := run("version"); err != nil {
			t.Errorf("version: %v", err)
		}
	})
	if !strings.Contains(out, "alethia v1.2.3") {
		t.Errorf("version printed %q; want it to carry the build it was given", out)
	}
}
