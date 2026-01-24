package cmd

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/bobikenobi12/bb-thesis-2026/apps/cli/types"
	"github.com/charmbracelet/bubbles/spinner"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/google/uuid"
	"github.com/imroc/req/v3"
	"github.com/pkg/browser"
	"github.com/spf13/cobra"
)

// --- Bubble Tea Model ---

type model struct {
	spinner   spinner.Model
	loading   bool
	done      bool
	err       error
	userEmail string
}

func initialModel() model {
	s := spinner.New()
	s.Spinner = spinner.Dot
	return model{
		spinner: s,
		loading: true,
	}
}

func (m model) Init() tea.Cmd {
	return m.spinner.Tick
}

type authSuccessMsg struct{ response *types.ExchangeResponse }
type authErrorMsg struct{ err error }

func (m model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.KeyMsg:
		if msg.Type == tea.KeyCtrlC || msg.Type == tea.KeyEsc {
			return m, tea.Quit
		}
	case authSuccessMsg:
		m.loading = false
		m.done = true
		m.userEmail = msg.response.UserEmail
		saveTokens(msg.response)
		return m, tea.Quit
	case authErrorMsg:
		m.loading = false
		m.err = msg.err
		return m, tea.Quit
	default:
		var cmd tea.Cmd
		m.spinner, cmd = m.spinner.Update(msg)
		return m, cmd
	}
	return m, nil
}

func (m model) View() string {
	if m.loading {
		return fmt.Sprintf("%s Waiting for authentication in the browser...", m.spinner.View())
	}
	if m.done {
		return fmt.Sprintf("✓ Welcome, %s! You are now authenticated.\n", m.userEmail)
	}
	if m.err != nil {
		return fmt.Sprintf("✗ Error: %v\n", m.err)
	}
	return ""
}

// --- Polling and Token Handling ---

func pollForToken(deviceCode, exchangeURL string) tea.Cmd {
	return func() tea.Msg {
		client := req.C().SetTimeout(120 * time.Second) // Overall timeout for the polling
		for {
			var result types.ExchangeResponse
			var errMsg struct {
				Error string `json:"error"`
			}
			resp, err := client.R().
				SetBody(map[string]string{"device_code": deviceCode}).
				SetSuccessResult(&result).
				SetErrorResult(&errMsg).
				Post(exchangeURL)

			if err != nil {
				return authErrorMsg{err: fmt.Errorf("failed to connect to server: %w", err)}
			}

			if resp.IsSuccessState() {
				return authSuccessMsg{response: &result}
			}

			if resp.StatusCode != 404 { // 404 is our "pending" state, any other error is fatal
				return authErrorMsg{err: fmt.Errorf("authentication failed (HTTP %d): %s", resp.StatusCode, errMsg.Error)}
			}

			// If it's a 404, just wait and try again
			time.Sleep(2 * time.Second)
		}
	}
}



func saveTokens(tokens *types.ExchangeResponse) {
	credsPath, err := getCredentialsPath()
	if err != nil {
		fmt.Printf("Error getting credentials path: %v\n", err)
		os.Exit(1)
	}

	if err := os.MkdirAll(filepath.Dir(credsPath), 0755); err != nil {
		fmt.Printf("Error creating config directory: %v\n", err)
		os.Exit(1)
	}

	file, err := os.Create(credsPath)
	if err != nil {
		fmt.Printf("Error creating credentials file: %v\n", err)
		os.Exit(1)
	}
	defer file.Close()

	encoder := json.NewEncoder(file)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(tokens); err != nil {
		fmt.Printf("Error writing tokens to file: %v\n", err)
		os.Exit(1)
	}
}

// --- Cobra Command ---

var forceLogin bool

var loginCmd = &cobra.Command{
	Use:   "login",
	Short: "Authenticate with the platform",
	Run: func(cmd *cobra.Command, args []string) {
		// 1. Check if already authenticated (unless forced)
		if !forceLogin {
			if _, err := getAuthToken(); err == nil {
				// We need to fetch the email for display purposes since getAuthToken returns only the token
				credsPath, _ := getCredentialsPath()
				file, _ := os.ReadFile(credsPath)
				var creds types.ExchangeResponse
				json.Unmarshal(file, &creds)
				
				fmt.Printf("You are already logged in as: %s\n", creds.UserEmail)
				fmt.Println("Use --force to log in again.")
				return
			}
		}

		// 2. Proceed with login flow
		deviceCode := uuid.New().String()
		webOrigin := os.Getenv("GRAPE_WEB_ORIGIN")
		if webOrigin == "" {
			webOrigin = "https://localhost:3000"
		}
		loginURL := fmt.Sprintf("%s/cli/login?device_code=%s", webOrigin, deviceCode)
		exchangeURL := fmt.Sprintf("%s/api/auth/cli/exchange", webOrigin)

		fmt.Println("Please open the following URL in your browser to log in:")
		fmt.Println(loginURL)

		if err := browser.OpenURL(loginURL); err != nil {
			fmt.Printf("\nCould not open browser automatically. Please open the link manually.\n")
		}

		p := tea.NewProgram(initialModel())
		go func() {
			// This is a bit of a hack to ensure the Bubble Tea UI has time to render before polling starts
			time.Sleep(100 * time.Millisecond)
			p.Send(pollForToken(deviceCode, exchangeURL)())
		}()

		if _, err := p.Run(); err != nil {
			fmt.Printf("An error occurred: %v\n", err)
			os.Exit(1)
		}
	},
}

func init() {
	rootCmd.AddCommand(loginCmd)
	loginCmd.Flags().BoolVarP(&forceLogin, "force", "f", false, "Force re-authentication")
}
