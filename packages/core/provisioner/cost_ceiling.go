// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"fmt"

	"github.com/alethialabs-io/alethialabs/packages/core/format"
	"github.com/alethialabs-io/alethialabs/packages/core/infracost"
)

// costCeilingCurrency is the currency BOTH sides of this comparison are denominated in.
//
// It is not a guess and it is not configurable here: the ceiling arrives as
// DeployParams.CostCeilingMonthlyUSD, read from ALETHIA_COST_CEILING_MONTHLY_USD, and the estimate
// it is compared against is infracost's `totalMonthlyCost`, which this repo never asks for in any
// other currency (nothing sets INFRACOST_CURRENCY, and CostBreakdown.Currency — parsed at
// infracost/types.go:8 — has no production reader). Naming the currency is what makes that standing
// assumption visible: the day the estimate is priced in something else, this constant is the line
// that has to change, rather than a `$` welded into a sentence.
const costCeilingCurrency = "USD"

// costCeilingBlock is the fail-closed cost guard for the real-apply path. When a
// non-zero monthly-USD ceiling is configured, a real apply must not proceed if the
// Infracost estimate exceeds it — or if no estimate could be produced at all: a ceiling
// was requested but we can't price the plan, so we REFUSE rather than let an unpriced
// plan through (mirrors gateRequiresReport's "no verdict is not a pass" ethos).
//
// A ceiling of 0 (or negative) DISABLES the guard — the default, so every existing caller
// (and every real customer apply) is unaffected. It is opt-in per deploy via
// DeployParams.CostCeilingMonthlyUSD, wired from ALETHIA_COST_CEILING_MONTHLY_USD in the
// runner; enabling it therefore requires a working INFRACOST_API_KEY (else the "no estimate"
// branch fail-closes).
//
// Returns (blocked, human-readable message). The caller returns the message as an error and
// emits the gate-blocked metric. Pure + side-effect-free so it can be table-tested offline.
func costCeilingBlock(cb *infracost.CostBreakdown, ceilingUSD float64) (bool, string) {
	if ceilingUSD <= 0 {
		return false, "" // guard disabled (default)
	}
	if cb == nil || cb.Summary == nil {
		return true, fmt.Sprintf(
			"cost ceiling BLOCKED apply: a %s ceiling is set but no Infracost estimate could be "+
				"produced (is INFRACOST_API_KEY set and did `infracost breakdown` succeed?) — refusing to "+
				"apply an unpriced plan", format.MonthlyRate(ceilingUSD, format.Exact, costCeilingCurrency))
	}
	if cb.Summary.TotalMonthly > ceilingUSD {
		// format.Exact, not Estimate: a ceiling and the figure that breached it are both exact
		// numbers the operator has to act on, and Estimate would render a $0.40 breach of a $0.30
		// ceiling as `<$1/mo exceeds the <$1/mo ceiling`. Both operands are strictly positive here
		// (the guard returned above for ceilingUSD <= 0, and TotalMonthly is greater still), so
		// MonthlyRate's negative-clamp gap cannot reach this line.
		return true, fmt.Sprintf(
			"cost ceiling BLOCKED apply: estimated %s exceeds the %s ceiling — shrink the plan "+
				"(cheaper node shape / single NAT / fewer resources) or raise the ceiling",
			format.MonthlyRate(cb.Summary.TotalMonthly, format.Exact, costCeilingCurrency),
			format.MonthlyRate(ceilingUSD, format.Exact, costCeilingCurrency))
	}
	return false, ""
}
