// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The read-back and prune paths in this package all shell out to `kubectl` through
// utils.ExecuteCommand / ExecuteCommandWithOutput (`bash -c "kubectl …"`). To exercise them
// deterministically — no cluster, no network — these tests put a recording `kubectl` stub first on
// PATH. The stub answers a canned stdout per matched argument substring and records every
// invocation, so a test can assert BOTH what the function parsed and which commands it issued.

// stubRule is one canned kubectl answer: when the joined argument string contains Match, the stub
// writes Stdout and exits with Exit.
//
// `Then` makes a rule ANSWER DIFFERENTLY on later matching calls: the first call gets
// Stdout/Exit, the Nth gets Then[N-2], and the last entry repeats forever. That is what lets a
// test drive a retry loop to its natural end — the CRD is NotFound, NotFound, then Established —
// instead of budgeting wall-clock and hoping the loop gets round twice before the deadline.
//
// The counter lives in a FILE, not a shell variable. The stub's answer is read through a command
// substitution, and `$( )` runs in a SUBSHELL: an incremented variable is discarded the moment it
// returns, so every call would read `1` and the sequence would never advance. This repository has
// already paid for that exact mistake once in a different stub.
type stubRule struct {
	Match  string
	Stdout string
	Exit   int
	Then   []stubAnswer
}

// stubAnswer is one later answer in a stubRule's sequence.
type stubAnswer struct {
	Stdout string
	Exit   int
}

// kubectlStub is a recording `kubectl` on PATH for the lifetime of one test.
type kubectlStub struct {
	dir          string
	logPath      string
	manifestPath string
}

// newKubectlStub installs a `kubectl` shim first on PATH. Rules are matched in order against the
// joined arguments; an unmatched call succeeds with empty stdout unless defaultExit is non-zero.
func newKubectlStub(t *testing.T, defaultExit int, rules ...stubRule) *kubectlStub {
	t.Helper()
	dir := t.TempDir()
	logPath := filepath.Join(dir, "calls.log")
	manifestPath := filepath.Join(dir, "applied.yaml")

	var b strings.Builder
	b.WriteString("#!/bin/sh\n")
	fmt.Fprintf(&b, "printf '%%s\\n' \"$*\" >> %s\n", shellSingleQuote(logPath))
	// Record the BYTES of every manifest applied through `-f <file>`. Asserting on argv proves an
	// apply happened; asserting on the file proves WHAT was applied — and for a path whose entire
	// job is to write the right credential into a Secret, those are different claims. The file is a
	// temp file the caller deletes on return, so it has to be captured here or not at all.
	fmt.Fprintf(&b, `prev=""
for a in "$@"; do
  if [ "$prev" = "-f" ] && [ -f "$a" ]; then cat "$a" >> %s; fi
  prev="$a"
done
`, shellSingleQuote(manifestPath))
	if len(rules) > 0 {
		b.WriteString("case \"$*\" in\n")
		for i, r := range rules {
			answers := append([]stubAnswer{{Stdout: r.Stdout, Exit: r.Exit}}, r.Then...)
			for j, a := range answers {
				body := filepath.Join(dir, fmt.Sprintf("stdout-%d-%d", i, j))
				if err := os.WriteFile(body, []byte(a.Stdout), 0o600); err != nil {
					t.Fatalf("write stub body: %v", err)
				}
			}
			if len(answers) == 1 {
				fmt.Fprintf(&b, "  *%s*) cat %s; exit %d;;\n",
					shellSingleQuote(r.Match), shellSingleQuote(filepath.Join(dir, fmt.Sprintf("stdout-%d-0", i))), r.Exit)
				continue
			}
			// Counter in a file, incremented BEFORE the answer is chosen, and clamped to the last
			// entry so the sequence ends by repeating rather than falling off into the default exit.
			counter := filepath.Join(dir, fmt.Sprintf("seq-%d", i))
			fmt.Fprintf(&b, "  *%s*)\n", shellSingleQuote(r.Match))
			fmt.Fprintf(&b, "    n=$(cat %s 2>/dev/null || echo 0); n=$((n+1)); printf '%%s' \"$n\" > %s\n",
				shellSingleQuote(counter), shellSingleQuote(counter))
			fmt.Fprintf(&b, "    if [ \"$n\" -gt %d ]; then n=%d; fi\n", len(answers), len(answers))
			fmt.Fprintf(&b, "    cat %s\"$((n-1))\"\n", shellSingleQuote(filepath.Join(dir, fmt.Sprintf("stdout-%d-", i))))
			fmt.Fprintf(&b, "    case \"$n\" in\n")
			for j, a := range answers {
				fmt.Fprintf(&b, "      %d) exit %d;;\n", j+1, a.Exit)
			}
			fmt.Fprintf(&b, "    esac\n")
			fmt.Fprintf(&b, "    ;;\n")
		}
		b.WriteString("esac\n")
	}
	fmt.Fprintf(&b, "exit %d\n", defaultExit)

	script := filepath.Join(dir, "kubectl")
	if err := os.WriteFile(script, []byte(b.String()), 0o755); err != nil {
		t.Fatalf("write kubectl stub: %v", err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	return &kubectlStub{dir: dir, logPath: logPath, manifestPath: manifestPath}
}

// calls returns every recorded kubectl invocation, in order.
func (s *kubectlStub) calls() []string {
	body, err := os.ReadFile(s.logPath)
	if err != nil {
		return nil
	}
	var out []string
	for _, ln := range strings.Split(strings.TrimRight(string(body), "\n"), "\n") {
		if ln != "" {
			out = append(out, ln)
		}
	}
	return out
}

// appliedManifests returns the concatenated bytes of every manifest applied through `kubectl -f`.
// Empty when nothing was applied — which a test asserting on content must distinguish from "the
// content is absent", since both would otherwise read as a passing Contains() check.
func (s *kubectlStub) appliedManifests() string {
	body, err := os.ReadFile(s.manifestPath)
	if err != nil {
		return ""
	}
	return string(body)
}

// calledWith reports whether any recorded invocation contains the given substring.
func (s *kubectlStub) calledWith(want string) bool {
	for _, c := range s.calls() {
		if strings.Contains(c, want) {
			return true
		}
	}
	return false
}

// shellSingleQuote wraps s in single quotes for safe embedding in the generated /bin/sh stub.
func shellSingleQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}
