// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package ui

import (
	"fmt"
	"strings"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/ui/theme"
	"github.com/alethialabs-io/alethialabs/packages/core/format"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/charmbracelet/lipgloss"
)

// Alethia Labs is a strictly grayscale brand: zero chroma, dark-first. Meaning
// is carried by ink weight and glyph shape, never by hue. The palette below is
// a terminal projection of the OKLCH neutral ink ramp; AdaptiveColor keeps it
// legible on both dark (signature) and light terminals.

// --- Palette (grayscale ink ramp) ---
//
// These five were hand-typed AdaptiveColors claiming to be a projection of the
// ramp above. Exactly one of their ten hex values was a step of that ramp
// (#FAFAFA = gray-50); #808080, #B3B3B3, #A3A3A3, #3D3D3D, #757575, #595959 and
// #161616 are not steps of anything. The console's --text-tertiary is also ONE
// ink in both themes, and this file had two. They are now aliases of the
// generated projection (packages/core/types/brand_gen.go), derived from the stylesheet that
// owns them. Change a colour in packages/brand/src/tokens.css, regenerate, and
// both surfaces move together; there is nothing to re-type here.

var (
	// InkPrimary is the strongest foreground — headings, values, emphasis.
	InkPrimary = theme.InkPrimary
	// InkSecondary is standard body text.
	InkSecondary = theme.InkSecondary
	// InkMuted is secondary/labels/borders.
	InkMuted = theme.InkMuted
	// InkFaint is the dimmest readable ink — disabled, hints, rules.
	InkFaint = theme.InkFaint
	// InkInverse is foreground for text rendered on an inverted (ink) surface.
	InkInverse = theme.InkInverse
)

// --- Styles ---
//
// The semantic names are kept stable for call sites. Success and error share the
// same strong ink — they are distinguished by their glyph (✓ vs ✗), not color,
// per the brand's "status by shape, never hue" rule.

var (
	StrongStyle    = lipgloss.NewStyle().Foreground(InkPrimary).Bold(true)
	SuccessStyle   = lipgloss.NewStyle().Foreground(InkPrimary).Bold(true)
	ErrorStyle     = lipgloss.NewStyle().Foreground(InkPrimary).Bold(true)
	WarningStyle   = lipgloss.NewStyle().Foreground(InkSecondary)
	AccentStyle    = lipgloss.NewStyle().Foreground(InkPrimary).Bold(true)
	CyanStyle      = lipgloss.NewStyle().Foreground(InkPrimary).Bold(true)
	TextStyle      = lipgloss.NewStyle().Foreground(InkPrimary)
	SecondaryStyle = lipgloss.NewStyle().Foreground(InkSecondary)
	MutedStyle     = lipgloss.NewStyle().Foreground(InkMuted)
	FaintStyle     = lipgloss.NewStyle().Foreground(InkFaint)
	LinkStyle      = lipgloss.NewStyle().Foreground(InkPrimary).Underline(true)
	KeyStyle       = lipgloss.NewStyle().Foreground(InkMuted).Padding(0, 2, 0, 2)
	ValueStyle     = lipgloss.NewStyle().Foreground(InkPrimary)
	// EyebrowStyle renders the uppercase mono label device (tracked via Eyebrow).
	EyebrowStyle = lipgloss.NewStyle().Foreground(InkMuted)
	// MarkStyle renders the [·] brand mark.
	MarkStyle = lipgloss.NewStyle().Foreground(InkPrimary).Bold(true)
)

// --- Symbols ---
//
// Geometric, monochrome glyphs only — no colorful emoji. Status reads by fill and shape: solid
// (●) active, half (◐) in flight, hollow (○) idle, ✗ failed, and a spent point (·) for gone.
//
// THE FOUR STATUS GLYPHS ARE ALIASES OF THE GENERATED VOCABULARY (packages/core/types/vocab_gen.go),
// not literals. They were literals, decided here, against a console that decided them again in
// packages/ui/src/status-badge.tsx — and the two answers had drifted apart on seven measured
// cases. There is one table now and this file is not it. The dash is absent from that table
// deliberately: it is the empty-value sentinel below, and a status drawn as the dash cannot be
// told apart from a cell nobody could fill.

const (
	// SymbolSuccess is the MESSAGE tick — ui.Success, ui.FormatSuccess, ui.GateGlyph. It is not a
	// status glyph and no tier draws it, which is why it stays a literal here.
	SymbolSuccess = "✓"
	// SymbolError is the failed tier's glyph, under the name the message helpers already used. One
	// rune, one owner: ui.Error and a FAILED row are the same statement about the same thing.
	SymbolError   = types.StatusGlyphFailed
	SymbolOnline  = types.StatusGlyphActive
	SymbolOffline = types.StatusGlyphIdle
	SymbolPending = types.StatusGlyphPending
	SymbolDefault = "◆"
	// SymbolDash IS format.Dash — one definition, in `packages/core`, because that is the half
	// the runner and the console-facing formatter can both see and `packages/core` cannot import
	// `apps/cli`. It was an independent `"—"` literal until #3659, which is the defect: two
	// definitions of one glyph that a change reaches only one of.
	//
	// #3659 ruled that this name should be DELETED rather than pointed at the shared value, and
	// that is still the right end state — one thing deserves one name. It is not done here because
	// deleting it forces an edit to nine command files this unit's `scope:` does not own, one of
	// which (`org_select.go`) a different lane is editing right now, and a mega-commit across
	// another lane's files is the exact tangle the board's disjoint scopes exist to prevent. The
	// DRIFT is closed today; the RENAME is owed, and each noun group can pay it in its own lane
	// without coordinating with anyone.
	SymbolDash = format.Dash
	// SymbolBullet is the SEPARATOR between the segments of a picker label ("● web · prod · abc123").
	// It is not an alias of any status glyph: a separator and a status are two meanings, and tying
	// them together would make a change to either move the other.
	//
	// IT USED TO BE THE SAME RUNE AS THE DISABLED TIER, and that was not a harmless coincidence.
	// opsPickProjectID builds its label as `PlainGlyph(status) + name + SymbolBullet + …`, so a
	// DESTROYED project rendered as `· my-project · prod · a1b2c3d4` — the leading glyph
	// indistinguishable from a separator, the label reading as though it opened on an empty field.
	// The disabled tier is `◌` for that reason (the separator is the older and wider convention;
	// the tier is what moved), and TestStatusGlyphsAreDisjointFromSymbols holds the two
	// vocabularies apart. The generator can only see collisions BETWEEN TIERS — this half of the
	// question lives here, where the non-status runes are.
	SymbolBullet = "·"
	SymbolArrow  = "→"
	SymbolPoint  = "▸"
)

// Mark is the Alethia bracketed-point brand mark.
const Mark = "[·]"

// --- Brand helpers ---

// RenderMark returns the [·] mark in strong ink.
func RenderMark() string {
	return MarkStyle.Render(Mark)
}

// Eyebrow renders an uppercase, letter-spaced mono label — the brand's eyebrow
// device (e.g. "CONTROL PLANE").
func Eyebrow(label string) string {
	// theme.Track is the projection of --tracking-eyebrow: the grid cannot give
	// you 0.16 of a cell, so the device spends a whole one. Same output as the
	// literal " " join it replaces — the point is that the separator now has one
	// owner, which is the token.
	return EyebrowStyle.Render(theme.Track(strings.ToUpper(label)))
}

// --- Message Helpers ---

func Success(msg string) {
	fmt.Printf("\n%s\n", SuccessStyle.Render(SymbolSuccess+" "+msg))
}

func Error(msg string) {
	fmt.Printf("\n%s\n", ErrorStyle.Render(SymbolError+" "+msg))
}

func Warning(msg string) {
	fmt.Printf("\n%s\n", WarningStyle.Render(SymbolPoint+" "+msg))
}

func Info(msg string) {
	fmt.Println(TextStyle.Render(msg))
}

func Muted(msg string) {
	fmt.Println(MutedStyle.Render(msg))
}

func JobQueued(jobType, jobID string) {
	fmt.Printf("\n%s\n", SuccessStyle.Render(fmt.Sprintf("%s Queued %s job (ID: %s)", SymbolSuccess, jobType, jobID)))
	fmt.Printf("Monitor with: alethia jobs logs %s --follow\n", jobID)
}

func FormatSuccess(msg string) string {
	return SuccessStyle.Render(SymbolSuccess + " " + msg)
}

func FormatError(msg string) string {
	return ErrorStyle.Render(SymbolError + " " + msg)
}

// --- Status Helpers ---
//
// ONE status renderer, over one generated vocabulary. There were three: `StatusDot` (styled
// glyph), `PlainStatusDot` (unstyled glyph) and `formatJobStatus` in cmd/job_wait.go (styled
// text, no glyph at all), each with its own switch over its own set of words. `PlainStatusDot`
// knew nine uppercase words against the console's 28 lower-cased ones, so six pgEnums that shout
// on the wire fell through its default arm, and `clusters_list.go` derived the glyph and the
// label from differently-cased inputs IN THE SAME EXPRESSION.
//
// Nothing here decides anything any more. The word → tier map and the tier → glyph table are
// both generated from packages/ui/src/status-badge.tsx (see packages/core/types/vocab_gen.go);
// what stays on this side is the INK, because a lipgloss style is not something the console has
// an opinion about.

// statusInk is the terminal weight each tier is drawn in.
//
// It is exhaustive over types.AllStatusTiers, and TestStatusInkCoversEveryTier holds it there by
// reading that generated slice rather than a list typed here — a tier added to the console must
// get an ink or fail the build, which is the same refusal the generator makes for a glyph.
//
// `active` and `failed` share StrongStyle on purpose: the palette carries no hue, so the pair is
// separated by shape (● vs ✗) exactly as the brand requires. `disabled` is the faintest readable
// ink because a destroyed thing should recede without vanishing.
var statusInk = map[types.StatusTier]lipgloss.Style{
	types.StatusTierActive:   StrongStyle,
	types.StatusTierPending:  SecondaryStyle,
	types.StatusTierIdle:     MutedStyle,
	types.StatusTierFailed:   StrongStyle,
	types.StatusTierDisabled: FaintStyle,
	types.StatusTierLive:     StrongStyle,
}

// PlainGlyph returns the unstyled glyph for a status of any casing — safe inside bubbles/huh
// widgets and table cells, where ANSI codes break column width calculation.
//
// Replaces PlainStatusDot. Two behaviours changed and both were defects: the lookup now FOLDS
// CASE, so a lower-case pgEnum value gets its real glyph instead of the default arm, and
// DESTROYED is `·` rather than the em dash it shared with "we could not fill this cell".
func PlainGlyph(status string) string {
	return types.StatusGlyphOf(status)
}

// Status renders a status the way a person reads it: the glyph, a space, the word in lower case,
// all in its tier's ink.
//
// This is StatusCell in the tier's ink, deliberately built from that one function rather than
// beside it — a styled renderer that agreed with the table cell on ACTIVE and not on DESTROYED
// would be the drift this unit exists to end, one line apart.
//
// It replaces StatusDot AND cmd/job_wait.go's formatJobStatus, which rendered the status TEXT in
// one of five styles and no glyph. Three of those five styles resolve to the same bold strong
// ink in a grayscale palette, so `job wait` printed SUCCESS and FAILED identically — a status
// distinguished by nothing at all. Shape carries it now.
func Status(status string) string {
	return statusInk[types.StatusTierOf(status)].Render(StatusCell(status))
}

// StatusVerbatim renders a status for a PLAIN-TEXT LINE rather than a table cell: the glyph, a
// space, and the status EXACTLY AS THE WIRE SPELLED IT, in its tier's ink.
//
// A STATED DECISION, not a variant somebody liked better. `Status` is StatusCell in ink and
// StatusCell lower-cases, for a reason that holds in a table and does not hold here — a column of
// capitals reads as a column of alarms, one closing line does not. The two callers are
// `jobs logs --follow` and `job wait`, and NEITHER has a machine format: `--follow` has no `-o`
// at all, so its last line IS the machine contract. Routing them through the table cell silently
// changed `--- Job SUCCESS ---` to `--- Job ● success ---` and broke every `grep -q SUCCESS` in
// somebody's CI script. Keeping the wire's own casing keeps that grep and gains the glyph, which
// is why this exists rather than the two commands simply reverting to a bare status echo.
//
// It is built from PlainGlyph and statusInk, the same two pieces Status is built from, so it
// cannot come to a different answer about what a word means — only about how it is spelled.
func StatusVerbatim(status string) string {
	return statusInk[types.StatusTierOf(status)].Render(PlainGlyph(status) + " " + status)
}

func DefaultBadge() string {
	return FaintStyle.Render(" " + SymbolDefault)
}
