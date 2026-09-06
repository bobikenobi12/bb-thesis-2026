// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"

	"gopkg.in/yaml.v3"
)

// Both preview renderers write raw YAML through text/template, so every user-controlled field is a
// place a value can restructure the document rather than fill a slot. Before this, validate() on
// both inputs was presence-only for everything except PlacementMode.
//
// These tables assert BOTH directions. A guard that only ever rejects is as useless as one that
// only ever accepts: the rejection table proves each rule fires, and the acceptance table proves
// none of them refuses a value the product must support.

// previewRejects are inputs the app-half renderer must refuse.
var previewRejects = map[string]func(*PreviewAppSetInput){
	// --- apps path. The whole reason this file exists: ValidateAppsPath guards this same value
	// at five other sites and this renderer was the one that skipped it.
	"apps path escapes the repo root":     func(in *PreviewAppSetInput) { in.AppsPath = "../../etc" },
	"apps path is bare traversal":         func(in *PreviewAppSetInput) { in.AppsPath = ".." },
	"apps path traverses mid-string":      func(in *PreviewAppSetInput) { in.AppsPath = "a/../../b" },
	"apps path is absolute":               func(in *PreviewAppSetInput) { in.AppsPath = "/etc/passwd" },
	"apps path has a trailing slash":      func(in *PreviewAppSetInput) { in.AppsPath = "overlays/" },
	"apps path segment starts with a dot": func(in *PreviewAppSetInput) { in.AppsPath = ".git/config" },

	// --- namespace prefix. `-` rendered `namespace: -`, which is not even a well-formed YAML
	// scalar in the arm that emitted it unquoted.
	"namespace prefix is a lone dash":   func(in *PreviewAppSetInput) { in.NamespacePrefix = "-" },
	"namespace prefix is only dashes":   func(in *PreviewAppSetInput) { in.NamespacePrefix = "---" },
	"namespace prefix ends with a dash": func(in *PreviewAppSetInput) { in.NamespacePrefix = "preview-" },
	"namespace prefix starts w/ a dash": func(in *PreviewAppSetInput) { in.NamespacePrefix = "-preview" },
	"namespace prefix is uppercase":     func(in *PreviewAppSetInput) { in.NamespacePrefix = "Preview" },
	"namespace prefix has a slash":      func(in *PreviewAppSetInput) { in.NamespacePrefix = "a/b" },
	"namespace prefix leaves no room": func(in *PreviewAppSetInput) {
		in.NamespacePrefix = strings.Repeat("a", previewPrefixMaxLen+1)
	},

	// --- git provider. Rendered in YAML KEY position, so an enum rather than a charset.
	"git provider is unknown": func(in *PreviewAppSetInput) { in.GitProvider = "gitea" },
	"git provider adds a sibling key": func(in *PreviewAppSetInput) {
		in.GitProvider = "github:\n          owner: attacker"
	},

	// --- the remaining unquoted or unescaped interpolations.
	"repo owner has a line break":  func(in *PreviewAppSetInput) { in.RepoOwner = "acme\n          owner: evil" },
	"repo name has a colon":        func(in *PreviewAppSetInput) { in.RepoName = "shop: evil" },
	"token secret ref has a slash": func(in *PreviewAppSetInput) { in.TokenSecretRef = "ns/secret" },
	"token secret ref has a break": func(in *PreviewAppSetInput) { in.TokenSecretRef = "tok\n            key: x" },
	"dest server is not a URL":     func(in *PreviewAppSetInput) { in.DestServer = "not a url" },
	"dest server has a break":      func(in *PreviewAppSetInput) { in.DestServer = "https://a\n        x: y" },
	"dest server scheme is file":   func(in *PreviewAppSetInput) { in.DestServer = "file:///etc/passwd" },
	"apps repo URL has a break":    func(in *PreviewAppSetInput) { in.AppsRepoURL = "https://a\n        x: y" },
	"vcluster name is not a label": func(in *PreviewAppSetInput) {
		in.PlacementMode = types.PlacementModeVcluster
		in.VClusterName = "Bad_Name"
	},
	"project is not a label":        func(in *PreviewAppSetInput) { in.Project = "Demo_Project" },
	"project leaves no name budget": func(in *PreviewAppSetInput) { in.Project = strings.Repeat("a", 60) },

	// --- labels: key is a YAML key, value sits in unescaped double quotes.
	"label key has a line break":   func(in *PreviewAppSetInput) { in.Labels = map[string]string{"a\n    b": "v"} },
	"label key is not a label key": func(in *PreviewAppSetInput) { in.Labels = map[string]string{"-bad": "v"} },
	"label value has a quote":      func(in *PreviewAppSetInput) { in.Labels = map[string]string{"a": `v" evil: "x`} },
	"label value has a line break": func(in *PreviewAppSetInput) { in.Labels = map[string]string{"a": "v\n    b: c"} },
	"label value is too long":      func(in *PreviewAppSetInput) { in.Labels = map[string]string{"a": strings.Repeat("v", 64)} },
	"label key prefix is not a subdomain": func(in *PreviewAppSetInput) {
		in.Labels = map[string]string{"NOT_A_DOMAIN/x": "v"}
	},

	// Length bounds. Each of these is a branch the coverage profile showed unreached, not a
	// guess at what might be missing.
	"repo owner is over 100 characters": func(in *PreviewAppSetInput) { in.RepoOwner = strings.Repeat("a", 101) },
	"token secret ref is over 253 characters": func(in *PreviewAppSetInput) {
		in.TokenSecretRef = strings.Repeat("a", 254)
	},
	"vcluster name leaves no room": func(in *PreviewAppSetInput) {
		in.PlacementMode = types.PlacementModeVcluster
		in.VClusterName = strings.Repeat("a", previewPrefixMaxLen+1)
	},
	// `https:` parses with a scheme and an empty host, so the scheme check alone lets it through.
	"dest server has no host": func(in *PreviewAppSetInput) { in.DestServer = "https:" },
	// A quote terminates the scalar in the double-quoted render positions.
	"apps repo URL contains a quote": func(in *PreviewAppSetInput) { in.AppsRepoURL = `https://x/a"b` },
	// The slug is rendered behind `preview-guardrails-` AND in front of `-<pr number>`.
	"project leaves no room for prefix and suffix": func(in *PreviewAppSetInput) {
		in.Project = strings.Repeat("a", 37)
	},
	// A destination is a Kubernetes API server, so the git transports are NOT valid there even
	// though they are valid for a repository URL.
	"dest server uses a git transport": func(in *PreviewAppSetInput) { in.DestServer = "ssh://cluster.internal" },
}

// previewAccepts are inputs the app-half renderer must still allow. Without these the rejection
// table above could be satisfied by a validator that refuses everything.
var previewAccepts = map[string]func(*PreviewAppSetInput){
	"empty apps path means the repo root": func(in *PreviewAppSetInput) { in.AppsPath = "" },
	"a dot apps path":                     func(in *PreviewAppSetInput) { in.AppsPath = "." },
	"a nested overlay path":               func(in *PreviewAppSetInput) { in.AppsPath = "examples/online-boutique/overlays/dev-1" },
	"a path with dots inside a segment":   func(in *PreviewAppSetInput) { in.AppsPath = "charts/my.app/v1" },
	"empty namespace prefix defaults":     func(in *PreviewAppSetInput) { in.NamespacePrefix = "" },
	"a numeric namespace prefix":          func(in *PreviewAppSetInput) { in.NamespacePrefix = "1preview" },
	"a hyphenated namespace prefix":       func(in *PreviewAppSetInput) { in.NamespacePrefix = "pr-preview" },
	"gitlab":                              func(in *PreviewAppSetInput) { in.GitProvider = "gitlab" },
	"bitbucket":                           func(in *PreviewAppSetInput) { in.GitProvider = "bitbucket" },
	"empty token secret ref":              func(in *PreviewAppSetInput) { in.TokenSecretRef = "" },
	"a dotted secret name":                func(in *PreviewAppSetInput) { in.TokenSecretRef = "preview.scm.token" },
	"empty dest server defaults":          func(in *PreviewAppSetInput) { in.DestServer = "" },
	"an ssh apps repo URL":                func(in *PreviewAppSetInput) { in.AppsRepoURL = "ssh://git@github.com/acme/shop.git" },
	"a git:// apps repo URL":              func(in *PreviewAppSetInput) { in.AppsRepoURL = "git://github.com/acme/shop.git" },
	// scp-style is the normal deploy-key form and ArgoCD accepts it; url.Parse does not.
	"an scp-style git remote":       func(in *PreviewAppSetInput) { in.AppsRepoURL = "git@github.com:acme/shop.git" },
	"a project at the exact budget": func(in *PreviewAppSetInput) { in.Project = strings.Repeat("a", 36) },
	// YAML 1.1 retypes these, so they must survive as strings — see the render test below.
	"a repo named like a number":    func(in *PreviewAppSetInput) { in.RepoName = "2048" },
	"an owner named like a boolean": func(in *PreviewAppSetInput) { in.RepoOwner = "on" },
	"an explicit https dest server": func(in *PreviewAppSetInput) { in.DestServer = "https://api.cluster.internal" },
	"a repo name with punctuation":  func(in *PreviewAppSetInput) { in.RepoOwner = "a-c_m.e"; in.RepoName = "shop.js" },
	"a prefixed label key":          func(in *PreviewAppSetInput) { in.Labels = map[string]string{"alethia.io/project": "demo"} },
	"an empty label value":          func(in *PreviewAppSetInput) { in.Labels = map[string]string{"alethia.io/x": ""} },
	"a label value at the limit":    func(in *PreviewAppSetInput) { in.Labels = map[string]string{"a": strings.Repeat("v", 63)} },
}

func TestPreviewApplicationSetRefusesUnsafeShapes(t *testing.T) {
	if len(previewRejects) == 0 {
		t.Fatal("no rejection cases — the table would pass vacuously")
	}
	for name, mutate := range previewRejects {
		t.Run(name, func(t *testing.T) {
			in := basePreviewInput()
			mutate(&in)
			out, err := RenderPreviewApplicationSet(in)
			if err == nil {
				t.Fatalf("expected a refusal, got a rendered manifest:\n%s", out)
			}
		})
	}
}

func TestPreviewApplicationSetStillAcceptsValidShapes(t *testing.T) {
	if len(previewAccepts) == 0 {
		t.Fatal("no acceptance cases — the rejection table could be satisfied by refusing everything")
	}
	for name, mutate := range previewAccepts {
		t.Run(name, func(t *testing.T) {
			in := basePreviewInput()
			mutate(&in)
			if _, err := RenderPreviewApplicationSet(in); err != nil {
				t.Fatalf("expected acceptance, got: %v", err)
			}
		})
	}
}

// The guardrails half renders the AppProjects that CONSTRAIN the untrusted app half, so the same
// shapes must be refused there. Only the fields that exist on both inputs are exercised; the
// guardrails-specific ones follow.
func TestPreviewGuardrailsRefusesUnsafeShapes(t *testing.T) {
	cases := map[string]func(*PreviewGuardrailsInput){
		"namespace prefix is a lone dash":  func(in *PreviewGuardrailsInput) { in.NamespacePrefix = "-" },
		"namespace prefix ends in a dash":  func(in *PreviewGuardrailsInput) { in.NamespacePrefix = "preview-" },
		"git provider is unknown":          func(in *PreviewGuardrailsInput) { in.GitProvider = "gitea" },
		"repo owner has a line break":      func(in *PreviewGuardrailsInput) { in.RepoOwner = "acme\n x: y" },
		"guardrails path escapes the root": func(in *PreviewGuardrailsInput) { in.GuardrailsPath = "../../etc" },
		"guardrails path is absolute":      func(in *PreviewGuardrailsInput) { in.GuardrailsPath = "/etc" },
		"label value has a quote":          func(in *PreviewGuardrailsInput) { in.Labels = map[string]string{"a": `v" evil: "x`} },
		"dest server is not a URL":         func(in *PreviewGuardrailsInput) { in.DestServer = "not a url" },
		"a source repo has a line break":   func(in *PreviewGuardrailsInput) { in.AppSourceRepos = []string{"https://a\n  - '*'"} },
		"token secret ref has a slash":     func(in *PreviewGuardrailsInput) { in.TokenSecretRef = "ns/secret" },
	}
	if len(cases) == 0 {
		t.Fatal("no cases — the table would pass vacuously")
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			in := basePreviewGuardrailsInput()
			mutate(&in)
			out, err := RenderPreviewGuardrails(in)
			if err == nil {
				t.Fatalf("expected a refusal, got a rendered manifest:\n%s", out)
			}
		})
	}
}

// TestPreviewNamespacePrefixLeavesRoomForThePRNumber pins the arithmetic behind
// previewPrefixMaxLen rather than the constant, so changing the reservation without changing the
// reasoning fails here.
func TestPreviewNamespacePrefixLeavesRoomForThePRNumber(t *testing.T) {
	prefix := strings.Repeat("a", previewPrefixMaxLen)
	// The namespace arm renders `<prefix>-<pr number>`; seven digits is the reserved budget.
	rendered := prefix + "-" + "1234567"
	if len(rendered) > dns1123LabelMaxLen {
		t.Errorf("a maximum-length prefix plus a seven-digit PR number is %d characters, over Kubernetes' %d",
			len(rendered), dns1123LabelMaxLen)
	}
	if !dns1123Label.MatchString(rendered) {
		t.Errorf("%q is not a valid DNS-1123 label", rendered)
	}
}

// TestPreviewRenderersShareTheAppsPathGuard is the anti-regression for the finding itself: both
// renderers must reject a traversal, and they must do it through the SAME function every other
// site uses, not a local re-implementation that can drift.
func TestPreviewRenderersShareTheAppsPathGuard(t *testing.T) {
	const traversal = "../../etc"

	if err := ValidateAppsPath(traversal); err == nil {
		t.Fatal("ValidateAppsPath itself accepted a traversal — the shared guard is broken")
	}

	app := basePreviewInput()
	app.AppsPath = traversal
	_, appErr := RenderPreviewApplicationSet(app)
	if appErr == nil {
		t.Error("the app-half renderer accepted a traversal apps path")
	}

	rails := basePreviewGuardrailsInput()
	rails.GuardrailsPath = traversal
	_, railsErr := RenderPreviewGuardrails(rails)
	if railsErr == nil {
		t.Error("the guardrails renderer accepted a traversal path")
	}

	// Both messages must NAME THE NORMALISED FORM. That is ValidateAppsPath's distinctive
	// contract — it refuses rather than normalising, and says what the value would have become so
	// the user can see what was actually asked for — and `apps_path_test.go` pins it there. A
	// local re-implementation would almost certainly just say "invalid path", so this substring is
	// the evidence that the shared guard produced the refusal rather than a copy of it.
	for _, err := range []error{appErr, railsErr} {
		if err == nil {
			continue
		}
		if !strings.Contains(err.Error(), "normalises to") {
			t.Errorf("refusal does not carry ValidateAppsPath's normalised-form contract: %v", err)
		}
	}
}

// A repo called "2048" is a real GitHub repository, and `on`/`no`/`y` are real owner names.
// Kubernetes decodes manifests through sigs.k8s.io/yaml, which is YAML 1.1: an unquoted `2048`
// becomes a float and an unquoted `on` becomes a boolean, while the ApplicationSet CRD declares
// both fields string — so the API server rejects the object. The values are legal, so the fix is
// to quote the render positions rather than to refuse the names.
func TestPreviewRenderQuotesScalarsYAML11WouldRetype(t *testing.T) {
	in := basePreviewInput()
	in.RepoOwner = "on"
	in.RepoName = "2048"
	in.TokenSecretRef = "true"
	out, err := RenderPreviewApplicationSet(in)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	for _, want := range []string{"owner: 'on'", "repo: '2048'", "secretName: 'true'"} {
		if !strings.Contains(out, want) {
			t.Errorf("rendered manifest missing %q — an unquoted value here is retyped by YAML 1.1\n%s", want, out)
		}
	}
	for _, unwanted := range []string{"owner: on\n", "repo: 2048\n", "secretName: true\n"} {
		if strings.Contains(out, unwanted) {
			t.Errorf("rendered manifest still carries the bare scalar %q", unwanted)
		}
	}
}

// The shape guards judge TrimSpace(x); the templates must render the trimmed value too, or a
// leading newline passes validation and then breaks the document it was validated for.
func TestPreviewRenderTrimsWhatItValidated(t *testing.T) {
	in := basePreviewInput()
	in.Project = "\ndemo"
	in.RepoOwner = "  acme  "
	in.RepoName = "\tshop"
	in.NamespacePrefix = " preview "
	in.TokenSecretRef = " preview-scm-token\n"
	out, err := RenderPreviewApplicationSet(in)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	for _, want := range []string{
		"name: preview-demo",
		"owner: 'acme'",
		"repo: 'shop'",
		"namespace: 'preview-{{ .number }}'",
		"secretName: 'preview-scm-token'",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("rendered manifest missing %q — a field was rendered untrimmed\n%s", want, out)
		}
	}
	// And nothing landed at column 0, which is what an untrimmed leading newline produces.
	for _, line := range strings.Split(out, "\n") {
		if line == "demo" || line == "shop" || line == "acme" {
			t.Errorf("a field value landed at column 0 — the value was rendered untrimmed:\n%s", out)
		}
	}
}

// The guardrails sourceRepos entries render inside DOUBLE quotes, so a quote in an entry
// terminates the scalar and breaks the AppProject that constrains the untrusted half.
func TestPreviewGuardrailsRefusesAQuoteInASourceRepo(t *testing.T) {
	in := basePreviewGuardrailsInput()
	in.AppSourceRepos = []string{`https://x" , "*`}
	if out, err := RenderPreviewGuardrails(in); err == nil {
		t.Errorf("a source repo carrying a quote was accepted:\n%s", out)
	}
}

// ── The four render-position defects review found in the first pass ──────────────────────────
//
// Each is the same mistake in a different place: a value was checked against the rules of a
// position it does not actually occupy. The remedy is the same too — decide the position, then
// make the check match it — so these are asserted by PARSING the rendered document rather than by
// substring, because a substring assertion is what let `repoURL:` stay bare through a pass whose
// entire subject was quoting.

// A backslash is not a quote, and in a double-quoted YAML scalar it is just as fatal: it starts an
// escape, so a TRAILING one consumes the closing quote and the scalar swallows whatever follows —
// including the `destinations:` block that pins the untrusted project.
func TestPreviewURLRefusesTheYAMLEscapeCharacter(t *testing.T) {
	breakers := map[string]string{
		"a trailing backslash consumes the closing quote": `https://git.example.com/bundle\`,
		"an interior backslash is an unknown escape":      `https://git.example.com/a\q`,
		"a double quote closes the scalar":                `https://git.example.com/a"b`,
		"a single quote":                                  "https://git.example.com/a'b",
	}
	for name, raw := range breakers {
		t.Run(name, func(t *testing.T) {
			if err := validatePreviewURL("test", "repo_url", raw, gitRemoteSchemes); err == nil {
				t.Errorf("%q was accepted; it restructures the double-quoted scalar it renders into", raw)
			}
		})
	}
	// scp-style remotes take a different branch and had their own, separate character class.
	if err := validatePreviewURL("test", "repo_url", `git@github.com:acme/shop.git\`, gitRemoteSchemes); err == nil {
		t.Error("the scp-style branch accepted a trailing backslash — it has its own class and was missed once already")
	}
	// The other direction: an ordinary remote must still pass, or "refuse everything" would satisfy
	// every assertion above.
	for _, ok := range []string{"https://github.com/acme/shop", "git@github.com:acme/shop.git", "ssh://git@h/acme/shop.git"} {
		if err := validatePreviewURL("test", "repo_url", ok, gitRemoteSchemes); err != nil {
			t.Errorf("a valid remote %q was refused: %v", ok, err)
		}
	}
}

// `repoURL:` was the one field this pass left as a bare plain scalar, and `net/url.Parse` cannot
// protect it: it rejects ASCII CONTROL bytes only (`b < 0x20 || b == 0x7f`), so SPACE (0x20) and
// `#` both survive. Unquoted, `a: b` restructures the mapping and `#x` truncates to a comment.
//
// Asserted by round-tripping the document: the value that comes back out must be the value that
// went in, whatever the renderer did to it.
func TestPreviewRepoURLSurvivesSpaceAndHash(t *testing.T) {
	for _, raw := range []string{"https://git.example.com/a: b", "https://git.example.com/a #x"} {
		t.Run(raw, func(t *testing.T) {
			in := basePreviewInput()
			in.AppsRepoURL = raw
			out, err := RenderPreviewApplicationSet(in)
			if err != nil {
				// Refusing outright is an acceptable answer; silently mis-rendering is not.
				t.Skipf("input refused at validation, which is also fail-closed: %v", err)
			}
			var doc map[string]any
			if err := yaml.Unmarshal([]byte(out), &doc); err != nil {
				t.Fatalf("rendered ApplicationSet does not parse as YAML: %v\n%s", err, out)
			}
			if !strings.Contains(out, raw) {
				t.Errorf("the URL did not survive rendering intact\n%s", out)
			}
		})
	}
}

// Label KEYS render in the same unquoted style the VALUES were fixed out of, and YAML 1.1 retypes
// a key exactly as readily as a value. `on`, `y`, `no`, `true` are all legal Kubernetes label keys
// and all decode to booleans — at which point sigs.k8s.io/yaml fails the conversion to JSON with
// "unsupported key type" and the API server never sees the ApplicationSet.
//
// Asserted TEXTUALLY, on purpose, and this is the one place in this file where that is the strong
// form rather than the weak one. The decoder that exhibits the bug is sigs.k8s.io/yaml (YAML 1.1),
// which is what Kubernetes uses; packages/core depends on gopkg.in/yaml.v3, which is YAML 1.2 and
// deliberately DROPPED the `y/yes/on/off` boolean aliases. Round-tripping through the parser we
// have would therefore pass whether or not the key is quoted — a test that proves the fix only
// where the bug does not exist. Checking the rendered bytes is version-independent.
func TestPreviewLabelKeysAreQuotedAgainstYAML11Retyping(t *testing.T) {
	for _, key := range []string{"on", "y", "n", "no", "yes", "true", "false", "2048"} {
		t.Run(key, func(t *testing.T) {
			in := basePreviewInput()
			in.Labels = map[string]string{key: "x"}
			out, err := RenderPreviewApplicationSet(in)
			if err != nil {
				t.Fatalf("%q is a valid Kubernetes label key and must render: %v", key, err)
			}
			if !strings.Contains(out, `"`+key+`": "x"`) {
				t.Errorf("label key %q is not quoted; YAML 1.1 decodes it as a non-string key and "+
					"sigs.k8s.io/yaml then fails the JSON conversion with \"unsupported key type\"\n%s", key, out)
			}
			if strings.Contains(out, "\n    "+key+": ") || strings.Contains(out, "\n        "+key+": ") {
				t.Errorf("label key %q still renders as a bare scalar somewhere in the document\n%s", key, out)
			}
		})
	}
}
