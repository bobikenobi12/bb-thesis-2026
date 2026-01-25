package cmd

import (
	"fmt"
	"os"
	"sort"

	"github.com/bobikenobi12/bb-thesis-2026/apps/cli/api"
	"github.com/charmbracelet/bubbles/table"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/dustin/go-humanize"
	"github.com/spf13/cobra"
	"golang.org/x/term"
)

var clustersListCmd = &cobra.Command{
	Use:   "list",
	Short: "List all connected clusters",
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fmt.Println(err)
			os.Exit(1)
		}

		client := api.NewClient(token)
		clusters, err := client.GetClusters()
		if err != nil {
			fmt.Printf("Error fetching clusters: %v\n", err)
			os.Exit(1)
		}

		if len(clusters) == 0 {
			fmt.Println("No clusters found.")
			return
		}

		width, height, err := term.GetSize(int(os.Stdout.Fd()))
		if err != nil {
			height = 20 // Default height
		}
		tableHeight := int(float64(height) * 0.8)

		columns := []table.Column{
			{Title: "Name", Width: width / 4},
			{Title: "Status", Width: width / 6},
			{Title: "Last Heartbeat", Width: width / 4},
			{Title: "Created At", Width: width / 4},
		}

		rows := createClusterRows(clusters)

		t := table.New(
			table.WithColumns(columns),
			table.WithRows(rows),
			table.WithFocused(true),
			table.WithHeight(tableHeight),
		)

		s := table.DefaultStyles()
		s.Header = lipgloss.NewStyle().
			Foreground(lipgloss.Color("252")).
			BorderStyle(lipgloss.ThickBorder()).
			BorderBottom(true).
			Bold(true).
			Padding(0, 1)

		s.Selected = lipgloss.NewStyle().
			Background(lipgloss.Color("#008080")).
			Foreground(lipgloss.Color("#FFFFFF")).
			Bold(false)

		t.SetStyles(s)

		m := clusterListModel{table: t, clusters: clusters, sortAsc: false}
		if _, err := tea.NewProgram(m).Run(); err != nil {
			fmt.Println("Error running program:", err)
			os.Exit(1)
		}
	},
}

type clusterListModel struct {
	table    table.Model
	clusters []api.Cluster
	sortAsc  bool
}

func (m clusterListModel) Init() tea.Cmd { return nil }

func (m clusterListModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	var cmd tea.Cmd
	switch msg := msg.(type) {
	case tea.KeyMsg:
		switch msg.String() {
		case "q", "ctrl+c":
			return m, tea.Quit
		case "s":
			m.sortAsc = !m.sortAsc
			sort.Slice(m.clusters, func(i, j int) bool {
				if m.sortAsc {
					return m.clusters[i].Name < m.clusters[j].Name
				}
				return m.clusters[i].Name > m.clusters[j].Name
			})
			m.table.SetRows(createClusterRows(m.clusters))
			return m, nil
		}
	}
	m.table, cmd = m.table.Update(msg)
	return m, cmd
}

func (m clusterListModel) View() string {
	status := fmt.Sprintf("Showing %d clusters | Press 'q' to quit | 'j/k' or arrows to navigate | 's' to sort by Name", len(m.table.Rows()))
	statusStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("240")).Padding(0, 1)
	baseStyle := lipgloss.NewStyle(). 
		BorderStyle(lipgloss.RoundedBorder()).
		BorderForeground(lipgloss.Color("240"))
	return baseStyle.Render(m.table.View()) + "\n" + statusStyle.Render(status)
}

func createClusterRows(clusters []api.Cluster) []table.Row {
	var rows []table.Row
	for _, c := range clusters {
		status := c.Status
		if status == "ONLINE" {
			status = "🟢 ONLINE"
		} else if status == "OFFLINE" {
			status = "🔴 OFFLINE"
		} else {
			status = "🟡 " + status
		}

		rows = append(rows, table.Row{
			c.Name,
			status,
			humanize.Time(c.LastHeartbeat),
			c.CreatedAt.Format("2006-01-02 15:04"),
		})
	}
	return rows
}

func init() {
	clustersCmd.AddCommand(clustersListCmd)
}
