// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"net/http"
	"strings"
	"testing"
)

// The break-glass confirmation contract, driven against the DERIVED set.
//
// Until #3702 every ops verb was EXEMPT from the repo's `--yes` guard, and each exemption named
// the audited `--reason` or the two-person `--approval` as the stronger gate it carried instead.
// Both of those gate AUTHORITY — may you do this, and is it recorded. Neither gates INTENT. A
// scripted `ops force-release-lock $KEY --approval $ID --reason "$INCIDENT"` carried every gate the
// exemptions named and still fenced out a live writer without anyone being asked, and on a terminal
// the operator was never told which resource or what would happen to it.
//
// hyg_cli_confirm_test.go now covers the flag and the --no-input contract for these commands
// alongside every other destructive verb in the CLI. What is HERE is the part that is specific to
// break-glass and that the shared guard does not ask:
//
//   - the DECLINE arm of every one of them, which no shared test drives;
//   - that the confirmation names the RESOURCE and the CONSEQUENCE, because "Are you sure?" on a
//     state unlock is not a confirmation;
//   - that the read-only verbs carry NO --yes and are not gated, so break-glass diagnosis stays
//     one command;
//   - that the set is the catalog's mutating set, with nothing hand-listed.

// opsConfirmCase is one verb's fully-supplied invocation and the resource it acts on.
//
// A hand-written ARGS table is unavoidable — every command needs its own valid invocation and
// nothing can derive those. What is avoidable is the table also deciding the SET, and
// TestOpsConfirm_TableCoversTheDerivedMutatingSet is what stops it: the set comes from opsActions,
// and a verb missing from this table is a failure that names it.
type opsConfirmCase struct {
	args []string
	// resource is the string the confirmation's title must name. It is the id the operator
	// supplied, because a confirmation that does not name the target cannot be checked by the
	// person reading it.
	resource string
}

var opsConfirmCases = map[string]opsConfirmCase{
	"alethia ops retry-job":          {[]string{"ops", "retry-job", "job-alpha", "--reason", "incident-4711"}, "job-alpha"},
	"alethia ops cancel-job":         {[]string{"ops", "cancel-job", "job-alpha", "--reason", "incident-4711"}, "job-alpha"},
	"alethia ops unstick-env":        {[]string{"ops", "unstick-env", "env-alpha", "--from", "PROVISIONING", "--to", "FAILED", "--reason", "incident-4711"}, "env-alpha"},
	"alethia ops drain-runner":       {[]string{"ops", "drain-runner", "runner-alpha", "--reason", "incident-4711"}, "runner-alpha"},
	"alethia ops restart-runner":     {[]string{"ops", "restart-runner", "runner-alpha", "--reason", "incident-4711"}, "runner-alpha"},
	"alethia ops replay-webhook":     {[]string{"ops", "replay-webhook", "evt_1P9xKjLkdIwHu7ix", "--reason", "incident-4711"}, "evt_1P9xKjLkdIwHu7ix"},
	"alethia ops force-release-lock": {[]string{"ops", "force-release-lock", "projects/acme/prod.tfstate", "--approval", "appr-1", "--reason", "incident-4711"}, "projects/acme/prod.tfstate"},
	"alethia ops state-surgery":      {[]string{"ops", "state-surgery", "projects/acme/prod.tfstate", "--approval", "appr-1", "--note", "import-rds", "--reason", "incident-4711"}, "projects/acme/prod.tfstate"},
	"alethia ops orphan-clean":       {[]string{"ops", "orphan-clean", "--project", "project-alpha", "--approval", "appr-1", "--reason", "incident-4711"}, "project-alpha"},
}

// opsConfirmMutating returns the command paths of every mutating break-glass verb, from the
// catalog mirror.
func opsConfirmMutating() []string {
	var out []string
	for _, a := range opsActions {
		if !a.ReadOnly {
			out = append(out, a.Command)
		}
	}
	return out
}

// TestOpsConfirm_TableCoversTheDerivedMutatingSet closes the hole one level below the arms: a verb
// with no case here would have its decline arm driven by nothing, and its confirmation could be
// deleted with this file still green.
func TestOpsConfirm_TableCoversTheDerivedMutatingSet(t *testing.T) {
	mutating := opsConfirmMutating()
	if len(mutating) == 0 {
		t.Fatal("the catalog reports no mutating actions — every assertion in this file is vacuous")
	}
	covered := map[string]bool{}
	for path := range opsConfirmCases {
		covered[path] = true
	}
	for _, path := range mutating {
		if !covered[path] {
			t.Errorf("%s mutates and has no entry in opsConfirmCases.\n"+
				"      Nothing drives its decline arm, so removing its confirmation would leave this "+
				"file green with the --yes flag still registered.", path)
		}
	}
	for path := range opsConfirmCases {
		found := false
		for _, m := range mutating {
			if m == path {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("opsConfirmCases names %q, which the catalog does not classify as mutating — "+
				"it is gone, renamed, or now read-only", path)
		}
	}
	// Both directions matched above, so the counts agree; this names the number so a set that
	// silently halves is visible in the failure rather than only in a diff.
	if len(opsConfirmCases) != len(mutating) {
		t.Errorf("%d cases for %d mutating verbs", len(opsConfirmCases), len(mutating))
	}
}

// TestOpsConfirm_DeclineChangesNothing is the arm no shared guard drives.
//
// A break-glass verb that asks "are you sure?" and proceeds when told no is a worse failure than
// one that never asked, because the operator has been given a reason to believe they were heard.
// It asserts BOTH halves: exit 0 (a declined prompt is a choice, not an error) and that NOTHING
// reached the break-glass endpoints — not even the session, which is itself an audit row.
func TestOpsConfirm_DeclineChangesNothing(t *testing.T) {
	for path, tc := range opsConfirmCases {
		t.Run(path, func(t *testing.T) {
			s, _, run := opsFormEnv(t)
			opsFormInteractive(t)
			prev := confirm
			confirm = func(string, string) bool { return false }
			t.Cleanup(func() { confirm = prev })

			if got := run(tc.args...); got != 0 {
				t.Fatalf("exit code = %d, want 0 — a declined prompt is a choice, not an error", got)
			}
			if s.sawAny("/api/breakglass") {
				t.Errorf("%s was declined and still reached the break-glass endpoints: %v\n"+
					"      The confirmation must gate the session and the action, not decorate them.",
					path, s.all())
			}
		})
	}
}

// TestOpsConfirm_AcceptActs is the other half of the same seam. A confirmation wired in front of a
// call that then never happens would satisfy the test above perfectly.
func TestOpsConfirm_AcceptActs(t *testing.T) {
	for path, tc := range opsConfirmCases {
		t.Run(path, func(t *testing.T) {
			s, executed, run := opsFormEnv(t)
			opsFormInteractive(t)
			prev := confirm
			confirm = func(string, string) bool { return true }
			t.Cleanup(func() { confirm = prev })

			if got := run(tc.args...); got != 0 {
				t.Fatalf("exit code = %d, want 0", got)
			}
			if !s.saw(http.MethodPost, "/api/breakglass/execute") {
				t.Errorf("%s was confirmed and sent NO action — the verb is gated into doing nothing: %v",
					path, s.all())
			}
			action, _ := opsActionFor(path)
			if executed.Action != action.Action {
				t.Errorf("%s dispatched %q, want %q", path, executed.Action, action.Action)
			}
			// The typed-confirm is what the server checks the resource id against. A mutating
			// action that omits it is refused, and until this pass it was a bare boolean argument
			// at every call site.
			if executed.ResourceID != "" && executed.Confirm != executed.ResourceID {
				t.Errorf("%s sent confirm=%q for resource %q — the typed-confirm must echo the id",
					path, executed.Confirm, executed.ResourceID)
			}
		})
	}
}

// TestOpsConfirm_NamesTheResourceAndTheConsequence is the wording rule, and it is the reason the
// group has its own confirm file at all.
//
// "Are you sure?" on a state unlock is not a confirmation. The title must name the resource the
// operator supplied, and the description must say what happens and how far it reaches.
func TestOpsConfirm_NamesTheResourceAndTheConsequence(t *testing.T) {
	for path, tc := range opsConfirmCases {
		t.Run(path, func(t *testing.T) {
			_, _, run := opsFormEnv(t)
			opsFormInteractive(t)

			var title, description string
			asked := false
			prev := confirm
			confirm = func(ti, d string) bool {
				title, description, asked = ti, d, true
				return false
			}
			t.Cleanup(func() { confirm = prev })

			if got := run(tc.args...); got != 0 {
				t.Fatalf("exit code = %d, want 0", got)
			}
			if !asked {
				t.Fatalf("%s never asked — every assertion below would be vacuous", path)
			}
			if !strings.Contains(title, tc.resource) {
				t.Errorf("%s asks %q, which does not name the resource %q.\n"+
					"      A confirmation the operator cannot check against what they typed is a "+
					"keystroke, not a decision.", path, title, tc.resource)
			}
			action, _ := opsActionFor(path)
			if !strings.Contains(description, action.Blast) {
				t.Errorf("%s describes the act as %q, which does not say how far it reaches (blast: %s)",
					path, description, action.Blast)
			}
			// A consequence is a sentence, not a label. The shortest real one in the group is
			// forty-odd characters; the bound is deliberately far below that so it fails on
			// "Are you sure?" and on an empty string rather than policing prose.
			if len(description) < 30 {
				t.Errorf("%s describes the act as %q — too short to say what will happen", path, description)
			}
			if action.RequiresApproval && !strings.Contains(description, "two-person") {
				t.Errorf("%s is a two-person action and its confirmation does not say so: %q", path, description)
			}
		})
	}
}

// TestOpsConfirm_ReadOnlyVerbsAreNotGated is the other side of the rule. Diagnosis must stay one
// command: a confirmation in front of `inspect-job` would buy nothing and cost a keystroke at the
// worst possible moment.
//
// It also pins the absence of the flag, so a --yes added to a read-only verb — where it would be
// registered, accepted and read by nobody — is a failure rather than harmless clutter.
func TestOpsConfirm_ReadOnlyVerbsAreNotGated(t *testing.T) {
	readOnly := map[string][]string{
		"alethia ops inspect-job":   {"ops", "inspect-job", "job-alpha", "--reason", "incident-4711", "--no-input"},
		"alethia ops orphan-detect": {"ops", "orphan-detect", "--project", "project-alpha", "--reason", "incident-4711", "--no-input"},
	}
	// Derived cross-check: the read-only set is the catalog's, so a verb that becomes read-only
	// without gaining a case here is reported rather than silently untested.
	for _, a := range opsActions {
		if !a.ReadOnly {
			continue
		}
		if _, ok := readOnly[a.Command]; !ok {
			t.Errorf("%s is read-only in the catalog and has no case here", a.Command)
		}
	}

	for path, args := range readOnly {
		t.Run(path, func(t *testing.T) {
			s, _, run := opsFormEnv(t)
			cmd, _, err := rootCmd.Find(opsCommandPath(path))
			if err != nil {
				t.Fatalf("find %s: %v", path, err)
			}
			if f := cmd.Flags().Lookup("yes"); f != nil {
				t.Errorf("%s carries a --yes flag; it changes nothing, so the flag would be "+
					"registered, accepted and read by nobody", path)
			}
			prev := confirm
			confirm = func(string, string) bool {
				t.Errorf("%s asked for a confirmation; it is read-only", path)
				return false
			}
			t.Cleanup(func() { confirm = prev })

			if got := run(args...); got != 0 {
				t.Fatalf("exit code = %d, want 0 — a read-only break-glass verb must work unattended", got)
			}
			if !s.saw(http.MethodPost, "/api/breakglass/execute") {
				t.Errorf("%s did not reach the control plane: %v", path, s.all())
			}
		})
	}
}

// TestOpsConfirm_ReadOnlyVerbsSendNoTypedConfirm pins the other half of ReadOnly: the server
// requires the typed confirmation for a mutating action and not for a read, and the catalog mirror
// is what decides which. A read that sent one would be harmless; a MUTATION that did not would be
// refused, which is why the two arms are asserted separately rather than inferred from one another.
func TestOpsConfirm_ReadOnlyVerbsSendNoTypedConfirm(t *testing.T) {
	_, executed, run := opsFormEnv(t)
	if got := run("ops", "inspect-job", "job-alpha", "--reason", "incident-4711", "--no-input"); got != 0 {
		t.Fatalf("exit code = %d, want 0", got)
	}
	if executed.ResourceID != "job-alpha" {
		t.Fatalf("resource id = %q, want job-alpha", executed.ResourceID)
	}
	if executed.Confirm != "" {
		t.Errorf("a read-only action sent confirm=%q; the typed-confirm belongs to the mutating ones",
			executed.Confirm)
	}
}
