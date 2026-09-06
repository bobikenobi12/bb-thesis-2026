// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Where the broker-password reconciliation sits in RunDeployV2 is part of its correctness, and
// nothing else can see it.
//
// THE BOUND THAT IS REAL: it must run AFTER `WaitAddOnsHealthy`. It execs into a Ready broker pod,
// and before the wait none is Ready on the deploy that creates a queue and few are on one that
// restarts it — so the reconciliation would skip on every run and defer the repair forever, while
// reporting "no broker yet" each time, which reads like an environmental hiccup rather than a
// placement bug. Moving that call up compiles, gofmts, lints and leaves every other test in this
// package green, so it is asserted structurally, in the idiom argocd_preflight_order_test.go
// established.
//
// THE BOUND THAT IS NOT, recorded because the first version of this file asserted it and a review
// showed the premise was false: `ReadDataEndpoints` does NOT publish the Secret's contents.
// `readSecretRef` returns `"<namespace>/<name>"` and its own doc says it never reads or returns the
// Secret's data — the password is resolved later, at binding-resolution time, from whatever the
// Secret holds then. So converging after the endpoint read would publish an identical reference and
// change nothing about which password an application ends up using. The assertion is gone rather
// than restated: a guard whose failure message asserts something that cannot happen is worse than
// no guard, because it costs the next person a real investigation to disbelieve it.

package provisioner

import (
	"go/ast"
	"go/parser"
	"go/token"
	"testing"
)

func TestQueuePasswordConvergesAfterTheAddOnHealthWait(t *testing.T) {
	const file = "deploy.go"
	fset := token.NewFileSet()
	parsed, err := parser.ParseFile(fset, file, nil, 0)
	if err != nil {
		// A guard that cannot read its subject has found NOTHING, not "nothing wrong".
		t.Fatalf("could not parse %s, so this guard proved nothing: %v", file, err)
	}

	var fn *ast.FuncDecl
	for _, decl := range parsed.Decls {
		if d, ok := decl.(*ast.FuncDecl); ok && d.Name.Name == "RunDeployV2" && d.Recv == nil {
			fn = d
			break
		}
	}
	if fn == nil || fn.Body == nil {
		t.Fatalf("RunDeployV2 was not found in %s — this guard proved nothing", file)
	}

	// Walk the whole body, so a call nested in an `if` or a closure is located rather than skipped.
	const notFound = -1
	wait, converge := notFound, notFound
	ast.Inspect(fn.Body, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		switch f := call.Fun.(type) {
		case *ast.SelectorExpr: // argocd.WaitAddOnsHealthy(...)
			if pkg, isIdent := f.X.(*ast.Ident); isIdent && pkg.Name == "argocd" && f.Sel.Name == "WaitAddOnsHealthy" {
				wait = int(call.Pos())
			}
		case *ast.Ident: // convergeInClusterQueuePasswords(...)
			if f.Name == "convergeInClusterQueuePasswords" {
				converge = int(call.Pos())
			}
		}
		return true
	})

	// EACH SUBJECT IS CHECKED FOR SEPARATELY. A renamed or deleted call would otherwise leave its
	// position at notFound, and `notFound < anything` makes the ordering assertion pass — a guard
	// reporting green over a subject that is no longer there.
	for _, s := range []struct {
		name string
		pos  int
	}{
		{"argocd.WaitAddOnsHealthy", wait},
		{"convergeInClusterQueuePasswords", converge},
	} {
		if s.pos == notFound {
			t.Fatalf("%s is not called in RunDeployV2 — this guard proved nothing about the ordering", s.name)
		}
	}

	if converge < wait {
		t.Errorf("convergeInClusterQueuePasswords runs BEFORE argocd.WaitAddOnsHealthy: no broker is " +
			"Ready yet, so it would skip on every deploy and never repair a pre-#3304 queue")
	}
}
