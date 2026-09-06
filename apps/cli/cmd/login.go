// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"time"

	"github.com/alethialabs-io/alethialabs/apps/cli/internal/version"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/charmbracelet/bubbles/spinner"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/huh"
	"github.com/charmbracelet/lipgloss"
	"github.com/google/uuid"
	"github.com/imroc/req/v3"
	"github.com/pkg/browser"
	"github.com/spf13/cobra"
)

// --- Preferences for UI ---

type cliPreferences struct {
	HideLoginWarning bool `json:"hide_login_warning"`
}

// The device-login flow talks to three things a test cannot have: a TTY, a desktop
// browser, and a control plane. These four variables are the seams that let the flow
// run headlessly. Each default is exactly the call it replaced, so production
// behaviour is unchanged.
var (
	// authRequiredPrompt asks whether to log in now (opens a TTY form).
	authRequiredPrompt = ui.AuthRequiredPrompt
	// openBrowser launches the system browser at the device-login URL.
	openBrowser = browser.OpenURL
	// loginProgramOptions is nil in production, so tea.NewProgram is called exactly as
	// before; tests pass WithInput(nil)/WithOutput to keep the program off the terminal.
	loginProgramOptions []tea.ProgramOption
	// loginPollInterval is how long pollForToken waits between "pending" (404) polls.
	loginPollInterval = 2 * time.Second
	// loginPollThrottleInterval is the back-off pollForToken uses when the control plane
	// answers 429. A throttle is not a rejection, so the poll keeps waiting — just slower.
	loginPollThrottleInterval = 10 * time.Second
	// loginPollTimeout bounds the WHOLE device-flow poll. req's SetTimeout is a PER-REQUEST
	// timeout, so without a deadline the 404="pending" arm retries forever whenever the
	// browser half is never completed — a headless CI box, a broken browser.OpenURL, a
	// closed tab — and `alethia login` has to be killed.
	loginPollTimeout = 10 * time.Minute
	// loginRequestTimeout bounds a single exchange request.
	loginRequestTimeout = 120 * time.Second
	// loginStartTimeout bounds the one registration call. Short on purpose: registration
	// is best-effort and the login continues without it, so a control plane that is slow
	// to answer must not hold the user at a blank terminal before the URL is even printed.
	loginStartTimeout = 15 * time.Second
)

// deviceAccessDenied is RFC 8628 §3.5's terminal error code for a request the user
// refused. It is a WIRE value shared with the console — `DEVICE_ACCESS_DENIED` in
// apps/console/lib/auth/cli-device-code.ts writes it and this compares against it.
// Spelt differently on either side, the poll falls through to its generic
// "authentication failed (HTTP 403)" arm and the user is told nothing about why.
const deviceAccessDenied = "access_denied"

// deviceClientName is what this client calls itself when registering a login request.
// The console shows it on the consent screen as a CLAIM about who is asking, so it is a
// plain product name rather than anything the reader could mistake for an assertion the
// control plane is making.
const deviceClientName = "alethia-cli"

// deviceUserAgent describes this build to the control plane, which stores it and renders
// it on the consent screen. The OS/arch pair is the part that does work: "the terminal on
// this laptop" and "a device on another continent" look identical without it, and RFC
// 8628's threat model is a phished link.
func deviceUserAgent() string {
	v := version.Version
	if v == "" {
		v = "dev"
	}
	return fmt.Sprintf("%s/%s (%s; %s)", deviceClientName, v, runtime.GOOS, runtime.GOARCH)
}

// registerDeviceRequest tells the control plane about this login BEFORE the browser opens.
//
// Two things did not exist until it did. The user_code was minted here, printed here and
// put in the link, and the console only ever checked its SHAPE — so the code on the consent
// screen carried no server-verified meaning and could not be compared against anything.
// And nothing was known about the requester, so the screen could say no more than "A device
// is asking to sign in to your account" while approval hands over an access token, a 90-day
// refresh token and the raw OAuth token of the first linked git provider.
//
// The caller treats a failure as a WARNING, not a stop: a new CLI must still be able to log
// in to a control plane that predates this route. What is lost when it fails is the detail
// on the consent screen, not the ability to sign in — so the failure is reported and the
// flow continues.
func registerDeviceRequest(startURL, deviceCode, userCode string) error {
	var errMsg struct {
		Error string `json:"error"`
	}
	resp, err := req.C().SetTimeout(loginStartTimeout).R().
		SetHeader("User-Agent", deviceUserAgent()).
		SetBody(map[string]string{
			"device_code":    deviceCode,
			"user_code":      userCode,
			"client_name":    deviceClientName,
			"client_version": version.Version,
		}).
		SetErrorResult(&errMsg).
		Post(startURL)
	if err != nil {
		return fmt.Errorf("could not reach the control plane: %w", err)
	}
	if resp.IsErrorState() {
		return fmt.Errorf("control plane returned %d: %s", resp.StatusCode, errMsg.Error)
	}
	return nil
}

// resolveLogin handles the "not authenticated" branch of getAuthTokenInternal:
// it errors fast when prompting is disabled or when the confirm has no terminal to
// draw on, otherwise offers an interactive "log in now?" prompt, runs the device
// flow, and returns the fresh token. This is irreducible interactive glue, kept out
// of the unit-tested token-state logic.
func resolveLogin(credsPath string, promptLogin bool) (string, error) {
	if !promptLogin {
		return "", fmt.Errorf("authentication required. Please run `alethia login`")
	}

	// A confirm that cannot be SEEN cannot be answered. getAuthToken hardcodes
	// promptLogin=true, so before this gate the "log in now?" form was the one huh widget
	// in the CLI with no stream check at all: with stdin a terminal and the form's stream
	// redirected — `alethia … 2> log` — the ANSI frames went into the log and the process
	// then blocked on a keystroke against a terminal showing nothing. The user sees a hang.
	//
	// requireInteractiveForm is the refusing predicate the rest of the package already
	// uses before opening a form, and its errors say WHICH condition failed (errNoInput
	// for --no-input, errNoTTY for a redirected stream) — so wrap rather than replace,
	// while saying the same thing the promptLogin=false arm above says.
	if err := requireInteractiveForm(); err != nil {
		return "", fmt.Errorf("authentication required. Please run `alethia login`: %w", err)
	}

	confirmLogin, err := authRequiredPrompt()
	if err != nil || !confirmLogin {
		return "", fmt.Errorf("authentication required. Please run `alethia login`")
	}

	if err := performLoginFlow(); err != nil {
		return "", err
	}

	// Read credentials again after successful login.
	file, err := os.ReadFile(credsPath)
	if err != nil {
		return "", fmt.Errorf("error reading credentials file after login: %w", err)
	}

	var creds types.ExchangeResponse
	if err := json.Unmarshal(file, &creds); err != nil {
		return "", fmt.Errorf("error parsing credentials file after login: %w", err)
	}

	return creds.AccessToken, nil
}

func getPreferencesPath() (string, error) {
	configDir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(configDir, "alethia", "preferences.json"), nil
}

func loadPreferences() cliPreferences {
	var prefs cliPreferences
	path, err := getPreferencesPath()
	if err == nil {
		data, err := os.ReadFile(path)
		if err == nil {
			_ = json.Unmarshal(data, &prefs)
		}
	}
	return prefs
}

func savePreferences(prefs cliPreferences) {
	path, err := getPreferencesPath()
	if err == nil {
		_ = os.MkdirAll(filepath.Dir(path), 0755)
		data, _ := json.MarshalIndent(prefs, "", "  ")
		_ = os.WriteFile(path, data, 0644)
	}
}

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
	s.Style = ui.SpinnerStyle
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
		return ui.FormatSuccess(fmt.Sprintf("Welcome, %s! You are now authenticated.", m.userEmail)) + "\n"
	}
	if m.err != nil {
		return ui.FormatError(fmt.Sprintf("Error: %v", m.err)) + "\n"
	}
	return ""
}

// --- Polling and Token Handling ---

// pollForToken polls the exchange endpoint until the browser half of the device flow is
// approved, the control plane returns a terminal status, or loginPollTimeout elapses. The
// client timeout is per-request; the deadline below is the overall budget.
func pollForToken(deviceCode, exchangeURL string) tea.Cmd {
	return func() tea.Msg {
		client := req.C().SetTimeout(loginRequestTimeout) // Per-request timeout
		deadline := time.Now().Add(loginPollTimeout)
		for {
			var result types.ExchangeResponse
			var errMsg struct {
				Error       string `json:"error"`
				Description string `json:"error_description"`
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

			// Terminal, and the ONLY arm that reports a decision a person made. The refusal
			// used to reach nothing: "This isn't me" set browser-local state and the server
			// was never told, so this loop kept polling to its own ten-minute timeout and
			// the terminal — which in the phishing case is the ATTACKER's — learned nothing
			// either way. Matched on the RFC 8628 error code and not on the 403 alone, so an
			// unrelated forbidden still falls through to the generic arm below rather than
			// being reported to the user as a refusal that never happened.
			if resp.StatusCode == http.StatusForbidden && errMsg.Error == deviceAccessDenied {
				detail := errMsg.Description
				if detail == "" {
					detail = "The sign-in was refused in the browser."
				}
				return authErrorMsg{err: fmt.Errorf(
					"%s Nothing was shared and no token was issued (%s)",
					detail, deviceAccessDenied)}
			}

			if resp.StatusCode == http.StatusGone {
				// Terminal: the device code expired or was already redeemed. Retrying can
				// never succeed, so say what happened instead of spinning.
				return authErrorMsg{err: fmt.Errorf(
					"this login code has expired or was already used — run `alethia login` again (HTTP 410): %s",
					errMsg.Error)}
			}

			// 404 is our "pending" state and 429 means the control plane is throttling the
			// poll, not rejecting the login — both keep waiting, 429 with a longer back-off.
			// Any other status is fatal.
			wait := loginPollInterval
			if resp.StatusCode == http.StatusTooManyRequests {
				wait = loginPollThrottleInterval
			} else if resp.StatusCode != http.StatusNotFound {
				return authErrorMsg{err: fmt.Errorf("authentication failed (HTTP %d): %s", resp.StatusCode, errMsg.Error)}
			}

			if time.Until(deadline) <= wait {
				return authErrorMsg{err: fmt.Errorf(
					"timed out after %s waiting for the login to be approved in the browser", loginPollTimeout)}
			}
			time.Sleep(wait)
		}
	}
}

func saveTokens(tokens *types.ExchangeResponse) {
	credsPath, err := getCredentialsPath()
	if err != nil {
		failf("Error getting credentials path: %v", err)
	}

	if err := os.MkdirAll(filepath.Dir(credsPath), 0755); err != nil {
		failf("Error creating config directory: %v", err)
	}

	// 0600: this file holds the live access token, the 90-day refresh token and the raw
	// git-provider OAuth token. os.Create would ask for 0666 and let the umask decide.
	file, err := os.OpenFile(credsPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, credentialsFileMode)
	if err != nil {
		failf("Error creating credentials file: %v", err)
	}
	defer file.Close()

	// O_CREATE applies the mode only to a file it actually creates; tighten an existing
	// credentials.json an older CLI left world-readable. Best-effort (see saveCredentials).
	_ = file.Chmod(credentialsFileMode)

	encoder := json.NewEncoder(file)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(tokens); err != nil {
		failf("Error writing tokens to file: %v", err)
	}
}

// --- Login Flow Implementation ---

func performLoginFlow() error {
	prefs := loadPreferences()

	if !prefs.HideLoginWarning {
		infoBox := lipgloss.NewStyle().Foreground(ui.InkPrimary).Border(lipgloss.RoundedBorder()).Padding(1, 2).BorderForeground(ui.InkMuted)

		msg := fmt.Sprintf("To use the Alethia CLI, you must have an account on the Alethia.\nIf you don't have one, register at:\n%s", ui.LinkStyle.Render(WebOrigin()+"/auth/signin"))
		fmt.Println(infoBox.Render(msg))
		fmt.Println()

		var hideWarning bool
		err := runHuhForm(
			huh.NewGroup(
				huh.NewConfirm().
					Title("Hide this message in the future?").
					Value(&hideWarning),
			),
		)

		if err == nil && hideWarning {
			prefs.HideLoginWarning = true
			savePreferences(prefs)
		}
		fmt.Println()
	}

	deviceCode := uuid.New().String()
	// RFC 8628 user_code: the browser shows the code it is about to approve and the user
	// compares it against this line. Without it a phished /cli/login link binds the
	// victim's account to the attacker's device code with nothing to compare against.
	// The alphabet is URL-safe, so it needs no escaping.
	userCode := newUserCode()
	origin := WebOrigin()
	loginURL := fmt.Sprintf("%s/cli/login?device_code=%s&user_code=%s", origin, deviceCode, userCode)
	exchangeURL := fmt.Sprintf("%s/api/auth/cli/exchange", origin)
	startURL := fmt.Sprintf("%s/api/auth/cli/start", origin)

	// Register BEFORE the URL is printed, so the consent screen the user is about to open
	// already has something to name. Best-effort: a control plane that predates this route
	// answers 404 and the login still works, it just shows less.
	//
	// The failure is REPORTED rather than swallowed. Silently degrading would leave the
	// user comparing a code and reading a requester line with no way to know that neither
	// was checked against anything.
	if err := registerDeviceRequest(startURL, deviceCode, userCode); err != nil {
		fmt.Fprintf(os.Stderr,
			"Warning: could not register this login with the control plane (%v).\n"+
				"The browser will show fewer details about this request.\n\n", err)
	}

	fmt.Println(ui.CyanStyle.Render("Please open the following URL in your browser to log in:"))
	fmt.Println(loginURL)
	fmt.Println()
	fmt.Println(ui.TextStyle.Render("Approve the login only if the browser shows this code:"))
	fmt.Println(ui.CyanStyle.Render(userCode))

	if err := openBrowser(loginURL); err != nil {
		fmt.Printf("\nCould not open browser automatically. Please open the link manually.\n")
	}

	p := tea.NewProgram(initialModel(), loginProgramOptions...)
	go func() {
		// This is a bit of a hack to ensure the Bubble Tea UI has time to render before polling starts
		time.Sleep(100 * time.Millisecond)
		p.Send(pollForToken(deviceCode, exchangeURL)())
	}()

	if _, err := p.Run(); err != nil {
		return fmt.Errorf("an error occurred during login: %w", err)
	}
	return nil
}

// --- Cobra Command ---

var (
	forceLogin     bool
	loginWebOrigin string
)

// `alethia login` takes no interactive field, and that is a decision rather than
// an omission.
//
// Every OTHER leaf in this group that needs a value asks for it. Login needs
// none: it works with zero input, and the one value it CAN carry — the
// control-plane URL — is a once-per-machine setting, not a per-login question.
// Asking for it on every sign-in would put a form in front of the single most
// frequent command in the product to collect an answer that almost never
// changes. `alethia init` is the guided form for that value; `--web-origin`
// below is the flag, so the contract stays complete either way.
var loginCmd = &cobra.Command{
	Use:   "login",
	Short: "Authenticate with the platform",
	Long: `Authenticate with the Alethia control plane through the browser device-code flow.

Needs no input: it prints a URL and a code, opens the browser, and waits. Use
'alethia init' for the guided first-run setup that picks a control-plane URL
first, or 'alethia token create' for a credential a pipeline can use.`,
	Run: func(cmd *cobra.Command, args []string) {
		// 0. Persist a control-plane URL passed for this login (self-host/dev).
		if loginWebOrigin != "" {
			if err := runConfigSet(os.Stdout, "web-origin", loginWebOrigin); err != nil {
				fail(err)
			}
		}

		// 1. Check if already authenticated (unless forced)
		if !forceLogin {
			if _, err := getAuthTokenInternal(false); err == nil {
				// We need to fetch the email for display purposes since getAuthToken returns only the token
				credsPath, _ := getCredentialsPath()
				file, _ := os.ReadFile(credsPath)
				var creds types.ExchangeResponse
				_ = json.Unmarshal(file, &creds)

				fmt.Println(ui.TextStyle.Render(fmt.Sprintf("You are already logged in as: %s", ui.CyanStyle.Render(creds.UserEmail))))
				fmt.Println(ui.TextStyle.Render("Use --force to log in again."))
				return
			}
		}

		// 2. Proceed with login flow
		if err := performLoginFlow(); err != nil {
			fail(err)
		}
	},
}

func init() {
	rootCmd.AddCommand(loginCmd)
	loginCmd.Flags().BoolVarP(&forceLogin, "force", "f", false, "Force re-authentication")
	loginCmd.Flags().StringVar(&loginWebOrigin, "web-origin", "", "Control-plane URL to use & persist (self-host/dev)")
}
