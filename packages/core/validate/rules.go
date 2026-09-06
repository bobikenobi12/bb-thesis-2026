// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package validate

import (
	"net"
	"strings"

	"github.com/alethialabs-io/alethialabs/packages/core/argocd"
)

// The registries. A generated Step names a rule; this file is the ONLY place a name becomes
// behaviour. Nothing in a spec — committed or fetched — can add an entry here, which is what makes
// "nothing in a schema is ever executed" true rather than aspirational.
//
// Every entry is a rule the console evaluates as a `.refine()` / `.transform()` closure and this
// package evaluates independently. testdata/validation-cases.json holds the two to the same answers
// over named cases; conformance_test.go runs it. Adding a rule here without adding it to the
// generator's declaration table leaves it unreferenced — TestNoOrphanRuleImplementations says so.

var predicates = map[string]Predicate{
	// The apps-repo subpath grammar. The AUTHORITY is argocd.ValidateAppsPath, which is what
	// actually runs before the path is rendered into an ArgoCD Application — this rule delegates to
	// it rather than restating it, so there is no third copy of the grammar to keep in step.
	"apps_path": func(v string, _ *int) bool {
		return argocd.ValidateAppsPath(v) == nil
	},

	// The reserved platform tfvar namespace. Mirrors provisioner.byoReservedVarPrefix, which is
	// CASE-SENSITIVE: `strings.HasPrefix(k, "alethia_")`. A case-INSENSITIVE mirror here would
	// refuse `Alethia_project_id`, which the runner passes through as an ordinary customer
	// variable — the CLI would then reject input the server accepts.
	//
	// The generated step carries SeverityReject, and which surface that mirrors matters. The RUNNER
	// drops the key with a warning rather than failing — but the CLI never reaches the runner: it
	// posts to /api/cli/projects/{id}/byo-iac, and as of #3670 that endpoint refuses a reserved key
	// with a 400. So the server the CLI actually talks to does certainly reject it, and warning
	// instead would send the user through a request that dies.
	"not_reserved_tfvar_key": func(v string, _ *int) bool {
		return !strings.HasPrefix(v, reservedTfvarPrefix)
	},

	// The per-cloud network floor. Mirrors cloud.validateNetworkCIDR: the cloud's template carves
	// its subnets with cidrsubnet(), so a network narrower than the floor plans clean and dies
	// mid-apply. `arg` is that cloud's floor; with no argument the rule ABSTAINS rather than pick
	// one, because picking the tightest floor would refuse a /22 that Hetzner accepts.
	"network_cidr_max_prefix": func(v string, arg *int) bool {
		if arg == nil {
			return true
		}
		// An unset network is explicitly valid, not merely absent: validateNetworkCIDR's own first
		// line is `if cidr == "" { return nil }`, and every project that predates the field stores
		// exactly this. Both empty cases are in the conformance table.
		if v == "" {
			return true
		}
		_, ipnet, err := net.ParseCIDR(v)
		if err != nil || ipnet.IP.To4() == nil {
			return false
		}
		ones, _ := ipnet.Mask.Size()
		return ones <= *arg
	},
}

var transforms = map[string]Transform{
	// strings.TrimSpace — the unicode.IsSpace set. The console's `goTrimSpace` reproduces exactly
	// this set rather than calling String.prototype.trim(), because the two disagree at the edges:
	// JS trims U+FEFF and Go does not, Go trims U+0085 and JS does not. Both edges are named cases
	// in the conformance table.
	"go_trim_space": strings.TrimSpace,

	// String.prototype.trim() — the OTHER set, because `iacVarKeySchema` calls zod's `.trim()` and
	// the console therefore judges (and stores) the JS-trimmed key.
	//
	// This has to cross over, and the first version of this PR got it wrong: the trim was declared
	// `not-shared` on the reasoning that the runner only ever sees the already-normalised key. True
	// of the runner, irrelevant to the CLI — the CLI judges what the USER typed, before anything is
	// stored. With no trim on this side, `Check(iac_var_key, " region")` failed the pattern while
	// the console accepted the same input and stored "region": the CLI refusing what the server
	// accepts, which is the one direction the invariant forbids.
	//
	// The two sets are near mirror images, and the conformance table pins both crossings: U+FEFF is
	// a JS space and not a Go one, U+0085 is a Go space and not a JS one.
	"js_trim": func(v string) string { return strings.Trim(v, jsSpaceCutset) },
}

// jsSpaceCutset is ECMA-262's WhiteSpace ∪ LineTerminator: TAB, LF, VT, FF, CR, SP, NBSP, U+1680,
// U+2000–U+200A, U+2028, U+2029, U+202F, U+205F, U+3000 and U+FEFF (ZWNBSP).
//
// U+0085 (NEL) is deliberately ABSENT — it is `unicode.IsSpace` but not JS WhiteSpace, and that
// asymmetry is the whole reason this cannot just call strings.TrimSpace.
const jsSpaceCutset = "\t\n\v\f\r \u00a0\u1680" +
	"\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a" +
	"\u2028\u2029\u202f\u205f\u3000\ufeff"

// reservedTfvarPrefix is stated here rather than imported because provisioner.byoReservedVarPrefix
// is unexported. TestReservedTfvarPrefixMatchesTheProvisioner reads the provisioner's source and
// fails if the two ever part company, so this is a mirror that something checks — not a constant
// somebody has to remember.
const reservedTfvarPrefix = "alethia_"
