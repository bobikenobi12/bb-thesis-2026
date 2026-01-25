package ui

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/lipgloss"
)

// RenderStepper returns a visual progress stepper string.
// steps: list of step names
// current: 0-based index of the current step
func RenderStepper(steps []string, current int) string {
	var (
		activeColor    = lipgloss.Color("86")  // Cyan
		inactiveColor  = lipgloss.Color("240") // Grey
		completedColor = lipgloss.Color("42")  // Green

		activeStyle    = lipgloss.NewStyle().Foreground(activeColor).Bold(true)
		inactiveStyle  = lipgloss.NewStyle().Foreground(inactiveColor)
		completedStyle = lipgloss.NewStyle().Foreground(completedColor)
	)

	var renderedSteps []string

	for i, step := range steps {
		var icon, label string
		
		if i < current {
			// Completed
			icon = "◆" // Solid diamond
			label = completedStyle.Render(step)
			icon = completedStyle.Render(icon)
		} else if i == current {
			// Current
			icon = "◈" // Diamond with dot
			label = activeStyle.Render(step)
			icon = activeStyle.Render(icon)
		} else {
			// Future
			icon = "◇" // Outline diamond
			label = inactiveStyle.Render(step)
			icon = inactiveStyle.Render(icon)
		}

		renderedSteps = append(renderedSteps, fmt.Sprintf("%s %s", icon, label))
	}

	// Join with a connector
	connector := inactiveStyle.Render(" ── ")
	return strings.Join(renderedSteps, connector)
}

// PrintStepper prints the rendered stepper to stdout.
func PrintStepper(steps []string, current int) {
	fmt.Println(RenderStepper(steps, current))
	fmt.Println()
}

