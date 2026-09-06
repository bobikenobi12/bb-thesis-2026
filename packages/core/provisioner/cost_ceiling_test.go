// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/infracost"
)

// TestCostCeilingBlock covers the opt-in fail-closed cost guard: disabled by a zero/negative
// ceiling, fail-closed when a ceiling is set but no estimate exists, blocking above the
// ceiling, and allowing at/below it.
func TestCostCeilingBlock(t *testing.T) {
	cb := func(monthly float64) *infracost.CostBreakdown {
		return &infracost.CostBreakdown{Summary: &infracost.CostSummary{TotalMonthly: monthly}}
	}

	tests := []struct {
		name        string
		cb          *infracost.CostBreakdown
		ceiling     float64
		wantBlocked bool
		wantMsgHas  string
	}{
		{name: "disabled zero ceiling ignores a huge estimate", cb: cb(9999), ceiling: 0, wantBlocked: false},
		{name: "disabled negative ceiling", cb: cb(9999), ceiling: -1, wantBlocked: false},
		{name: "nil breakdown fail-closed", cb: nil, ceiling: 300, wantBlocked: true, wantMsgHas: "no Infracost estimate"},
		{name: "nil summary fail-closed", cb: &infracost.CostBreakdown{}, ceiling: 300, wantBlocked: true, wantMsgHas: "no Infracost estimate"},
		{name: "over ceiling blocks", cb: cb(350.5), ceiling: 300, wantBlocked: true, wantMsgHas: "exceeds"},
		{name: "at ceiling allows", cb: cb(300), ceiling: 300, wantBlocked: false},
		{name: "under ceiling allows", cb: cb(180.25), ceiling: 300, wantBlocked: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			blocked, msg := costCeilingBlock(tt.cb, tt.ceiling)
			if blocked != tt.wantBlocked {
				t.Fatalf("costCeilingBlock() blocked = %v, want %v (msg=%q)", blocked, tt.wantBlocked, msg)
			}
			if !blocked && msg != "" {
				t.Errorf("not blocked but got a non-empty message: %q", msg)
			}
			if tt.wantMsgHas != "" && !strings.Contains(msg, tt.wantMsgHas) {
				t.Errorf("message %q does not contain %q", msg, tt.wantMsgHas)
			}
		})
	}
}

// TestCostCeilingBlockRendersMoneyTheWayTheConsoleDoes pins the money rendering in both blocking
// messages, which is the whole user-facing half of this guard: the operator reads these two numbers
// against each other and against the billing page, and before this they were `$%.2f` — a hardcoded
// glyph and Go's half-to-EVEN rounding, which is not the rounding the console does.
//
// Three properties are asserted, and each one fails on a different mutation:
//
//   - GROUPING. `$1,234.50/mo`, not `$1234.50/mo`. This is what a revert to `$%.2f` breaks first,
//     and it is the only difference visible at the values a real ceiling is set to.
//   - ROUNDING. 0.125 is `$0.13`, because JavaScript rounds half away from zero and the console is
//     JavaScript. `fmt.Sprintf("%.2f", 0.125)` gives `0.12`. The value is exactly representable in
//     binary, so this is a decision about rounding rules, not float noise.
//   - REGISTER. format.Exact, never format.Estimate: Estimate rounds to whole units and would
//     render a $0.50 estimate breaching a $0.13 ceiling as `<$1/mo exceeds the <$1/mo ceiling` —
//     one sentence in which the two numbers being compared are identical and neither is the number.
//
// The currency is pinned by the `$` in every expectation: costCeilingCurrency is USD, and swapping
// it renders `€` or a trailing ISO code instead.
func TestCostCeilingBlockRendersMoneyTheWayTheConsoleDoes(t *testing.T) {
	cb := func(monthly float64) *infracost.CostBreakdown {
		return &infracost.CostBreakdown{Summary: &infracost.CostSummary{TotalMonthly: monthly}}
	}

	tests := []struct {
		name    string
		cb      *infracost.CostBreakdown
		ceiling float64
		want    []string
		notWant []string
	}{
		{
			name:    "a four-figure ceiling is grouped",
			cb:      cb(2500.5),
			ceiling: 1234.5,
			want:    []string{"estimated $2,500.50/mo exceeds the $1,234.50/mo ceiling"},
			notWant: []string{"$2500.50", "$1234.50"},
		},
		{
			name:    "the unpriced-plan message renders the ceiling too",
			cb:      nil,
			ceiling: 1234.5,
			want:    []string{"a $1,234.50/mo ceiling is set but no Infracost estimate"},
			notWant: []string{"$1234.50"},
		},
		{
			name:    "a half-cent rounds away from zero, the way the console rounds",
			cb:      cb(0.5),
			ceiling: 0.125,
			want:    []string{"estimated $0.50/mo exceeds the $0.13/mo ceiling"},
			// `$0.12` is Go's half-to-even answer; `<$1` is what format.Estimate would render
			// BOTH of these numbers as, collapsing the comparison the sentence exists to make.
			notWant: []string{"$0.12", "<$1"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			blocked, msg := costCeilingBlock(tt.cb, tt.ceiling)
			if !blocked {
				t.Fatalf("costCeilingBlock(%v) did not block; message = %q", tt.ceiling, msg)
			}
			for _, w := range tt.want {
				if !strings.Contains(msg, w) {
					t.Errorf("message %q does not contain %q", msg, w)
				}
			}
			for _, n := range tt.notWant {
				if strings.Contains(msg, n) {
					t.Errorf("message %q still contains %q", msg, n)
				}
			}
		})
	}
}
