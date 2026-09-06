// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"fmt"
	"net/url"
	"regexp"
	"slices"
	"strings"
)

// Shape guards for the two preview renderers.
//
// WHY THIS FILE EXISTS. Both preview templates are Go text/template writing RAW YAML — not a YAML
// marshaller, not html/template — so every interpolated value lands in the document as typed, and
// several land UNQUOTED: `namespace: [[ .NamespacePrefix ]]`, `server: [[ .DestServer ]]`,
// `secretName: [[ .TokenSecretRef ]]`, the label keys, and `[[ .GitProvider ]]:` which is itself a
// YAML KEY. Until now `validate()` on both inputs was presence-only for all of them, with
// PlacementMode the single value that was actually checked.
//
// The sharpest instance was `AppsPath`. `ValidateAppsPath` is applied at five production sites —
// namespace_tenant.go, vcluster_app.go and three in the provisioner — and the preview renderer was
// the one place that skipped it, while rendering the value into `source.path`. The console-side
// rule for the preview lane (apps/console/lib/validations/preview.ts) is also looser than the
// shared one and lets `../../etc` through, so nothing anywhere refused it.
//
// Neither renderer has a production caller yet — both say so ("Still an unused seam pending runner
// wiring") and the preview config never enters buildConfigSnapshot, so nothing reaches a cluster
// today. That is exactly why this is the right moment: the guards go in before the wiring, not
// after, and the cost of getting them wrong is currently zero.
//
// The rules REFUSE rather than normalise, matching ValidateAppsPath's stated contract: silently
// rewriting a value here would produce a manifest whose destination does not match what the user
// asked for, and the failure would surface as an ArgoCD error naming neither cause.

// previewPrefixMaxLen bounds a namespace prefix so the rendered namespace still fits.
//
// The namespace arm renders `<prefix>-{{ .number }}`, where ArgoCD substitutes the PR number, so
// the prefix cannot use the whole 63-character label budget. Eight characters are reserved for a
// hyphen plus a seven-digit PR number — comfortably past any real repository, and a bound that is
// stated rather than discovered when a namespace creation fails.
const previewPrefixMaxLen = dns1123LabelMaxLen - previewNumberSuffixLen

// previewNumberSuffixLen is what `-{{ .number }}` costs: a hyphen plus a seven-digit PR number,
// comfortably past any real repository.
const previewNumberSuffixLen = 8

// previewLongestNamePrefix is the longest literal a project slug is rendered behind. The two
// renderers between them emit `preview-<p>`, `preview-apps-<p>` and `preview-guardrails-<p>`, and
// the last is 19 characters — an earlier bound reserved for `preview-apps-` (13) and so let a
// 50-character slug through, which RenderPreviewGuardrails then emitted as a 69-character name.
const previewLongestNamePrefix = len("preview-guardrails-")

// A Kubernetes label VALUE: at most 63 characters, alphanumeric at both ends, with '-', '_' and
// '.' allowed inside. Empty is also legal, which the caller handles separately.
var k8sLabelValue = regexp.MustCompile(`^[A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?$`)

// A Kubernetes label KEY's name segment — the part after an optional `prefix/`. Same shape as a
// value, and likewise capped at 63.
var k8sLabelName = regexp.MustCompile(`^[A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?$`)

// A DNS-1123 SUBDOMAIN: dot-separated DNS-1123 labels. Kubernetes object names (a Secret, for
// instance) use this rather than the single-label rule.
var dns1123Subdomain = regexp.MustCompile(`^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$`)

const dns1123SubdomainMaxLen = 253

// previewGitProviders is the closed set the PR generator understands.
//
// This is not merely an input-hygiene check. `[[ .GitProvider ]]` is rendered in YAML KEY position
// (`        [[ .GitProvider ]]:`), so a value carrying a newline and further indentation would add
// sibling keys to the generator block rather than name one. An enum removes that whole class,
// which a charset check would not.
var previewGitProviders = map[string]bool{"github": true, "gitlab": true, "bitbucket": true}

// validatePreviewProject checks a project slug used in object names and the AppProject reference.
func validatePreviewProject(what, project string) error {
	p := strings.TrimSpace(project)
	if p == "" {
		return fmt.Errorf("%s: project is required", what)
	}
	// The slug is rendered behind a prefix AND in front of `-{{ .number }}`, on both halves. The
	// budget has to cover the worst of each: `preview-guardrails-<slug>-<7 digits>`. Reserving for
	// only the prefix accepted values that blow the very limit the error message names.
	if budget := dns1123LabelMaxLen - previewLongestNamePrefix - previewNumberSuffixLen; len(p) > budget {
		return fmt.Errorf("%s: project %q is %d characters; at most %d, so `preview-guardrails-%s-<pr number>` still fits Kubernetes' %d-character limit",
			what, p, len(p), budget, p, dns1123LabelMaxLen)
	}
	if !dns1123Label.MatchString(p) {
		return fmt.Errorf("%s: project %q is not a valid DNS-1123 label (lowercase alphanumerics and '-', starting and ending alphanumeric)", what, p)
	}
	return nil
}

// validatePreviewGitProvider checks the SCM key of the PR generator block.
func validatePreviewGitProvider(what, provider string) error {
	p := strings.TrimSpace(provider)
	if p == "" {
		return fmt.Errorf("%s: git provider is required", what)
	}
	if !previewGitProviders[p] {
		return fmt.Errorf("%s: git provider %q is not one of github, gitlab, bitbucket", what, p)
	}
	return nil
}

// validatePreviewRepoRef checks an owner or repository name.
//
// Deliberately narrower than any single forge's rule: this is the intersection that every one of
// GitHub, GitLab and Bitbucket accepts, and it contains no YAML metacharacter. A forge-specific
// grammar would be a second opinion about a name the forge itself decides.
func validatePreviewRepoRef(what, field, ref string) error {
	r := strings.TrimSpace(ref)
	if r == "" {
		return fmt.Errorf("%s: %s is required", what, field)
	}
	if len(r) > 100 {
		return fmt.Errorf("%s: %s %q is longer than 100 characters", what, field, r)
	}
	for _, c := range r {
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9':
		case c == '-', c == '_', c == '.':
		default:
			return fmt.Errorf("%s: %s %q may contain only letters, digits, '-', '_' and '.'", what, field, r)
		}
	}
	return nil
}

// validatePreviewNamespacePrefix checks a namespace prefix.
//
// The prefix must be a valid namespace ON ITS OWN, because the vcluster arm renders it alone
// (`namespace: [[ .NamespacePrefix ]]`), and short enough that `<prefix>-<pr number>` is still a
// valid label, because the namespace arm appends one.
//
// The old console rule was `^[a-z0-9-]+$`, described in its own message as "a DNS-1123 label
// prefix" while accepting `-`, `--` and `a-`. A lone `-` rendered `namespace: -`, which is not
// even a well-formed YAML scalar in the unquoted arm.
func validatePreviewNamespacePrefix(what, prefix string) error {
	p := strings.TrimSpace(prefix)
	if p == "" {
		// Empty is legal: both renderers default it to "preview".
		return nil
	}
	if len(p) > previewPrefixMaxLen {
		return fmt.Errorf("%s: namespace prefix %q is %d characters; at most %d, so `<prefix>-<pr number>` still fits Kubernetes' %d-character limit",
			what, p, len(p), previewPrefixMaxLen, dns1123LabelMaxLen)
	}
	if !dns1123Label.MatchString(p) {
		return fmt.Errorf("%s: namespace prefix %q is not a valid DNS-1123 label (lowercase alphanumerics and '-', starting and ending alphanumeric)", what, p)
	}
	return nil
}

// validatePreviewSecretRef checks an ArgoCD Secret name. Empty is legal — the PR generator then
// polls anonymously.
func validatePreviewSecretRef(what, ref string) error {
	r := strings.TrimSpace(ref)
	if r == "" {
		return nil
	}
	if len(r) > dns1123SubdomainMaxLen {
		return fmt.Errorf("%s: token secret name %q is longer than %d characters", what, r, dns1123SubdomainMaxLen)
	}
	if !dns1123Subdomain.MatchString(r) {
		return fmt.Errorf("%s: token secret name %q is not a valid Kubernetes object name", what, r)
	}
	return nil
}

// validatePreviewClusterName checks an ArgoCD registered cluster name.
func validatePreviewClusterName(what, name string) error {
	n := strings.TrimSpace(name)
	if n == "" {
		return fmt.Errorf("%s: vcluster placement requires a vcluster name", what)
	}
	// Rendered as `name: '<vcluster>-{{ .number }}'`, so the same eight-character allowance
	// applies as for a namespace prefix.
	if len(n) > previewPrefixMaxLen {
		return fmt.Errorf("%s: vcluster name %q is %d characters; at most %d, so `<name>-<pr number>` still fits",
			what, n, len(n), previewPrefixMaxLen)
	}
	if !dns1123Label.MatchString(n) {
		return fmt.Errorf("%s: vcluster name %q is not a valid DNS-1123 label", what, n)
	}
	return nil
}

// gitRemoteSchemes are the transports ArgoCD can clone a repository over.
var gitRemoteSchemes = []string{"https", "ssh", "git", "http"}

// scpStyleRemote matches `user@host:path` — git's scp-like syntax, which carries no scheme.
// Anchored and deliberately narrow: no whitespace, no quote, and a non-empty path.
var scpStyleRemote = regexp.MustCompile(`^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[A-Za-z0-9._/~-]+$`)

// apiServerSchemes are the transports a Kubernetes API server is reachable over.
//
// Deliberately NOT the git set. An earlier cut of this file used one validator for both and so
// accepted `ssh://` and `git://` for a destination API server — schemes that cannot name one, and
// which ArgoCD would fail on later with an error naming neither cause. A single "is it a URL"
// helper across two different KINDS of URL is how a permissive union gets built by accident.
var apiServerSchemes = []string{"https", "http"}

// yamlDQBreakers are the characters that restructure a YAML DOUBLE-QUOTED scalar from the inside.
//
// The backslash belongs here and was missing. In a double-quoted scalar `\` is the ESCAPE
// character, so it is exactly as document-restructuring as the quote it escapes: a trailing
// `https://git.example.com/bundle\` renders as `- "https://git.example.com/bundle\"`, the closing
// quote is consumed as an escape, and the scalar runs on into the following lines — swallowing the
// `destinations:` block that pins the untrusted project. A non-trailing `\q` fails differently and
// just as fatally ("found unknown escape character"). `url.Parse` accepts both.
//
// Line breaks are NOT listed for values that have been through url.Parse — it already refuses every
// ASCII control byte — but ARE listed here because this constant is also used on paths that have
// not. Over-listing costs nothing; under-listing cost the backslash.
const yamlDQBreakers = "\n\r\"'\\"

// validatePreviewURL checks a URL rendered into a YAML double-quoted scalar, against the schemes
// valid for that FIELD. Empty is legal when the caller documents a default; the caller decides.
//
// "rendered unquoted" was this comment's first claim and it was half true: `repoURL:` really was a
// bare plain scalar in both templates while everything else in the pass got quoted. That is fixed
// at the render sites rather than here, because a plain scalar cannot be made safe by a character
// class — `net/url.Parse` rejects only ASCII CONTROL bytes (`b < 0x20 || b == 0x7f`), so SPACE
// (0x20) and `#` both survive it, and `repoURL: https://git.example.com/a: b` restructures the
// mapping while `repoURL: https://h/a #x` silently truncates to a comment.
func validatePreviewURL(what, field, raw string, allowed []string) error {
	u := strings.TrimSpace(raw)
	if u == "" {
		return nil
	}
	// scp-style remotes (`git@github.com:acme/shop.git`) are the normal form for deploy-key access
	// and ArgoCD accepts them, but url.Parse refuses them outright ("first path segment in URL
	// cannot contain colon") — so a scheme list alone silently outlawed a configuration that
	// works. Refuse only what is KNOWN broken.
	if scpStyleRemote.MatchString(u) && slices.Contains(allowed, "ssh") {
		if strings.ContainsAny(u, yamlDQBreakers) {
			return fmt.Errorf("%s: %s %q contains a character that would break the YAML scalar it is rendered into", what, field, u)
		}
		return nil
	}
	parsed, err := url.Parse(u)
	if err != nil {
		return fmt.Errorf("%s: %s %q is not a valid URL: %w", what, field, u, err)
	}
	if !slices.Contains(allowed, parsed.Scheme) {
		return fmt.Errorf("%s: %s %q must use %s (got %q)", what, field, u, strings.Join(allowed, ", "), parsed.Scheme)
	}
	// `https:`, `https://` and `https:///path` all parse with a scheme and no host, and a URL is
	// rendered unquoted, so a hostless value would emit a bare `repoURL: https:` into the document.
	if parsed.Host == "" {
		return fmt.Errorf("%s: %s %q has no host", what, field, u)
	}
	// GuardrailsRepoURL is rendered INSIDE double quotes (`sourceRepos: - "[[ . ]]"`), and
	// url.Parse happily accepts these in a path — so they would restructure the scalar and break
	// the whole AppProject document. validatePreviewLabels already refuses them for the same reason.
	if strings.ContainsAny(u, yamlDQBreakers) {
		return fmt.Errorf("%s: %s %q contains a character that would break the YAML scalar it is rendered into", what, field, u)
	}
	// NO explicit line-break check here, deliberately. net/url.Parse already refuses any ASCII
	// control character — "\n", "\r" and "\t" all return an error above — so a check for them
	// after a successful parse cannot fire. Verified rather than assumed. Adding one back would
	// be a branch no test can reach, which is how a guard grows code that only looks careful.
	return nil
}

// validatePreviewLabels checks the common labels stamped onto the ApplicationSet and every
// generated Application. Keys are rendered in YAML KEY position and values inside double quotes
// with no escaping, so both halves are checked to Kubernetes' own rules.
func validatePreviewLabels(what string, labels map[string]string) error {
	for k, v := range labels {
		name := k
		if slash := strings.Index(k, "/"); slash >= 0 {
			prefix, rest := k[:slash], k[slash+1:]
			if prefix == "" || len(prefix) > dns1123SubdomainMaxLen || !dns1123Subdomain.MatchString(prefix) {
				return fmt.Errorf("%s: label key %q has an invalid prefix (want a DNS-1123 subdomain before '/')", what, k)
			}
			name = rest
		}
		if name == "" || len(name) > dns1123LabelMaxLen || !k8sLabelName.MatchString(name) {
			return fmt.Errorf("%s: label key %q is not a valid Kubernetes label key", what, k)
		}
		if v != "" && (len(v) > dns1123LabelMaxLen || !k8sLabelValue.MatchString(v)) {
			return fmt.Errorf("%s: label %q has an invalid value %q (at most %d characters, alphanumeric at both ends)", what, k, v, dns1123LabelMaxLen)
		}
	}
	return nil
}
