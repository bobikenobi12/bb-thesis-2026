// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"io"
	"os"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/spf13/cobra"
)

var promotionCmd = &cobra.Command{
	Use:     "promotion",
	Aliases: []string{"promotions", "promo"},
	Short:   "Inspect environment promotions",
	Long: `A promotion moves a source environment's proven design into a target environment,
gated by that environment's protection rules. List a project's promotions or show one in detail
(status, approval tally, and approval slots).

A promotion is named by its id or an unambiguous id prefix — or by nothing at all, and you are
asked which of the project's promotions to open.`,
}

var promotionListCmd = &cobra.Command{
	Use:   "list",
	Short: "List a project's promotions",
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		project, err := projectFromFlag(cmd, token)
		if err != nil {
			fail(err)
		}
		env, _ := cmd.Flags().GetString("env")
		client := api.NewClient(token)
		if interactiveTable(cmd) {
			var promos []api.Promotion
			runSpinner("Fetching promotions...", func() {
				promos, err = client.GetProjectPromotions(project, env)
			})
			if err != nil {
				failf("Failed to list promotions: %v", err)
			}
			if len(promos) == 0 {
				ui.Muted("No promotions yet.")
				return
			}
			_ = ui.ShowTable(promotionColumns, promotionListRows(promos, ui.FormatTable), "promotions")
			return
		}
		if err := runPromotionList(client, os.Stdout, outputFormat(cmd), project, env); err != nil {
			failf("Failed to list promotions: %v", err)
		}
	},
}

var promotionColumns = []string{"ID", "Source", "Target", "Status", "Created"}

// promotionListRows projects promotions into plain table cells.
func promotionListRows(promos []api.Promotion, outFmt string) [][]string {
	rows := make([][]string, len(promos))
	for i, p := range promos {
		// The Created cell echoed the wire's RFC3339 — `2026-03-09T15:04:05Z` in a column a person
		// reads, while the console showed `9 Mar 2026, 15:04` for the same instant. Handed to this
		// lane by the governance lane (#3703), which was right to wait: `ui.Stamp` did not exist yet.
		//
		// The Status cell echoed the raw enum — `PENDING_APPROVAL`, shouting, with no glyph — while
		// every other list in the CLI and the whole console drew the same statuses as a dot and a
		// word. It goes through ui.StatusCell now, which is #3660 case 7: a promotion status is an
		// ordinary word in the one vocabulary and needed no special case, only a renderer.
		//
		// Through ui.Cell, because this cell PARSED: a script reading `-o csv` got `SUCCEEDED`, and
		// #3659's floor is that improving a table for a reader must not take that away. The other
		// four status tables were never machine-readable, which is why they pass StatusCell
		// directly and #4033 owns deciding all of them together.
		rows[i] = []string{p.ID, p.Source, p.Target,
			ui.Cell(outFmt, p.Status, ui.StatusCell(p.Status)),
			ui.Cell(outFmt, p.CreatedAt, ui.Stamp(p.CreatedAt))}
	}
	return rows
}

// runPromotionList fetches and renders a project's promotions (non-interactive path).
func runPromotionList(c apiClient, out io.Writer, format, project, env string) error {
	promos, err := c.GetProjectPromotions(project, env)
	if err != nil {
		return err
	}
	if len(promos) == 0 && format == ui.FormatTable {
		fmt.Fprintln(out, ui.MutedStyle.Render("No promotions yet."))
		return nil
	}
	return ui.Render(out, format, ui.TableSpec{
		Columns: promotionColumns,
		Rows:    promotionListRows(promos, format),
	}, promos)
}

var promotionGetCmd = &cobra.Command{
	Use:   "get [promotion]",
	Short: "Show a promotion's status and approval slots",
	Long: `Show one promotion in detail. Name it by its id or an unambiguous id prefix; omit it on
a terminal and you are asked which of the project's promotions to open.`,
	Args: cobra.MaximumNArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		project, err := projectFromFlag(cmd, token)
		if err != nil {
			fail(err)
		}
		client := api.NewClient(token)
		env, _ := cmd.Flags().GetString("env")
		ref, err := resolvePromotion(client, project, env, args)
		if err != nil {
			fail(err)
		}
		if err := runPromotionGet(client, os.Stdout, outputFormat(cmd), project, ref.ID); err != nil {
			failf("Failed to get promotion: %v", err)
		}
	},
}

// resolvePromotion answers "which promotion?" from an id, an id prefix, or the picker.
//
// It reuses the LIST endpoint the `promotion list` command already calls, and honours the same
// --env narrowing, so `promotion get --env production` opens a picker over exactly the rows
// `promotion list --env production` just printed. A picker that showed a different set from the
// list beside it would be a second opinion about what the project contains.
//
// A promotion has no name, so the only thing a reader could previously have passed was a UUID
// copied out of that list by eye — the handoff `promotions.mdx` stood an ellipsis in for.
func resolvePromotion(c apiClient, project, env string, args []string) (govRef, error) {
	promos, err := c.GetProjectPromotions(project, env)
	if err != nil {
		return govRef{}, err
	}
	return resolveGovRef(promotionSelect, govRefsFromPromotions(promos), args)
}

var approvalColumns = []string{"Status", "Approver", "Role", "Decided"}

// approvalRows projects a promotion's approval slots into plain table cells.
func approvalRows(approvals []api.PromotionApproval, outFmt string) [][]string {
	rows := make([][]string, len(approvals))
	for i, a := range approvals {
		// StampOrDash, not StrOrDash: `decided_at` is a TIMESTAMP, and passing it through the string
		// helper printed the wire form while dashing correctly. The dash rule is the same; the
		// rendering was the accident.
		// approval_status is `pending | approved | rejected`, and until #4117 the vocabulary had a
		// word for only the first: the other two fell to the idle fallback and drew ○, whose own
		// documented meaning is "present, reachable, and not doing anything". On the one table an
		// operator reads to find out who is holding a promotion up, that is not a missing signal
		// but a wrong one — every row a hollow dot, and `approved` and `rejected` identical.
		//
		// The five words are in STATUS_TIER now (approved → active, rejected/blocked → failed,
		// pending_approval/pending_plan → pending; see RULINGS in status-vocab.ts for why each),
		// so both surfaces resolve them the same way and neither has to special-case a promotion.
		rows[i] = []string{ui.Cell(outFmt, a.Status, ui.StatusCell(a.Status)),
			ui.Cell(outFmt, ui.Wire(a.Name), ui.StrOrDash(a.Name)),
			ui.Cell(outFmt, ui.Wire(a.RequiredRole), ui.StrOrDash(a.RequiredRole)),
			ui.Cell(outFmt, ui.Wire(a.DecidedAt), ui.StampOrDash(a.DecidedAt))}
	}
	return rows
}

// runPromotionGet fetches and renders one promotion. json emits the whole detail; table renders a
// summary card followed by the approval slots.
func runPromotionGet(c apiClient, out io.Writer, format, project, promotionID string) error {
	p, err := c.GetPromotion(project, promotionID)
	if err != nil {
		return err
	}
	if format == ui.FormatJSON {
		return ui.Render(out, format, ui.TableSpec{}, p)
	}
	rows := [][]string{{"id", p.ID}}
	// `prod → staging` welds two fields into one cell with a GLYPH between them, and RenderCard
	// hands these rows straight to Render's CSV branch. A script cannot split on U+2192 without
	// knowing to look for it, so the machine form is the two fields it was always made of.
	//
	// The `approvals` row below is deliberately NOT split the same way: `2/3` carries no glyph and
	// no humanisation, so it is a composite rather than a rendering, and changing it belongs to
	// whoever decides that a card may not hold one — not here.
	if format == ui.FormatCSV {
		rows = append(rows, []string{"source", p.Source}, []string{"target", p.Target})
	} else {
		rows = append(rows, []string{"promotion", fmt.Sprintf("%s %s %s", p.Source, ui.SymbolArrow, p.Target)})
	}
	rows = append(rows,
		[]string{"status", ui.Cell(format, p.Status, ui.StatusCell(p.Status))},
		[]string{"approvals", fmt.Sprintf("%d/%d", p.Approved, p.Required)},
		[]string{"initiator", ui.Cell(format, ui.Wire(p.Initiator), ui.StrOrDash(p.Initiator))},
		[]string{"created", ui.Cell(format, p.CreatedAt, ui.Stamp(p.CreatedAt))},
	)
	if p.ErrorMessage != nil && *p.ErrorMessage != "" {
		rows = append(rows, []string{"error", *p.ErrorMessage})
	}
	if err := ui.RenderCard(out, format, "alethia · promotion", rows, p); err != nil {
		return err
	}
	if format == ui.FormatTable && len(p.Approvals) > 0 {
		fmt.Fprintln(out)
		_ = ui.Render(out, format, ui.TableSpec{
			Columns: approvalColumns,
			Rows:    approvalRows(p.Approvals, format),
		}, p.Approvals)
	}
	return nil
}

func init() {
	promotionCmd.PersistentFlags().StringP("project", "p", "",
		mustGovField("alethia promotion list", fieldKeyGovProject).Description+" (name or id)")
	promotionCmd.PersistentFlags().StringP("env", "e", "",
		mustGovField("alethia promotion list", fieldKeyGovEnv).Description)
	promotionCmd.AddCommand(promotionListCmd)
	promotionCmd.AddCommand(promotionGetCmd)
	rootCmd.AddCommand(promotionCmd)
}
