// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

type Client struct {
	baseURL    string
	authToken  string
	httpClient *http.Client
}

func NewClient(authToken string) *Client {
	// env > persisted config > hosted default (https://alethialabs.io), so the
	// hosted CLI needs no setup and self-host/dev override it once.
	webOrigin, _ := types.ResolveWebOrigin()
	return &Client{
		baseURL:   fmt.Sprintf("%s/api", webOrigin),
		authToken: authToken,
		httpClient: &http.Client{
			Timeout:       requestTimeout,
			CheckRedirect: refuseCrossOriginRedirect,
		},
	}
}

// requestTimeout bounds ONE control-plane round trip: dial, TLS handshake, request write, response
// header and body read are all inside http.Client.Timeout. Without it a control plane that accepts
// the TCP connection and then never answers — a half-open connection through a load balancer is the
// usual way — blocks the calling goroutine forever, and every `alethia` command, including the
// GetJob/GetJobLogs poll loops, hangs with no output and no way to bound the wait (#2045).
//
// A client Timeout rather than a context.Context on every verb, deliberately. apps/cli has ZERO
// context.Context in non-test code, and *Client is consumed through the 61-method apiClient
// interface in apps/cli/cmd/client.go with a ~430-line fake behind it, so ctx parameters would
// rewrite the interface, the fake and every call site — and every one of those call sites would
// pass context.Background(), so no caller would gain a cancellation it could actually use. If the
// CLI ever grows a root context the change is mechanical: thread it in and keep this as the ceiling.
//
// 60s is sized against the slowest LEGITIMATE call, not the median: ConnectProviderIdentity and
// VerifyProviderIdentity run a cloud health probe INLINE on the server. No env knob — same shape as
// acrExchangeTimeout in apps/runner/internal/agent/registry_token.go.
const requestTimeout = 60 * time.Second

// maxAPIRedirects bounds the chain even when every hop stays on the control plane's own origin.
const maxAPIRedirects = 3

// refuseCrossOriginRedirect stops a redirect that leaves the origin the request started on.
//
// Go strips Authorization, Www-Authenticate and Cookie when a redirect crosses to a different host,
// and NOTHING else. Every other header is copied verbatim — including `X-Provider-Token`, the user's
// GitHub/GitLab OAuth token attached by GetRepositories, and `X-Alethia-Org`, the tenancy boundary.
// So a 3xx from /api/cli/repositories/* handed a token that grants repo access on the user's behalf
// to a host that was never the control plane: an open redirect on the console, a self-hosted or dev
// ALETHIA_WEB_ORIGIN, or a MITM on a plain-http origin (#2024).
//
// Refusing the hop outright rather than stripping the two headers by name is deliberate, on two
// counts. A strip list is a denylist — it protects the secrets somebody remembered, and the next
// header added to this client is unprotected by default, which is exactly how this bug arose from
// Go's own (correct but partial) list. And a control-plane API call has no legitimate reason to end
// up on another origin at all: following one would also mean parsing a foreign host's JSON as if it
// were the control plane's answer.
//
// Same-origin redirects are still followed, so a trailing-slash or path normalisation on the
// console keeps working.
func refuseCrossOriginRedirect(req *http.Request, via []*http.Request) error {
	if len(via) >= maxAPIRedirects {
		return fmt.Errorf("stopped after %d redirects", maxAPIRedirects)
	}
	if origin, to := requestOrigin(via[0].URL), requestOrigin(req.URL); origin != to {
		return fmt.Errorf("refusing redirect from the control plane %q to %q: the request carries credentials that must not leave that origin", origin, to)
	}
	return nil
}

// requestOrigin renders scheme://host:port, with the scheme's default port made explicit so
// `https://example.com` and `https://example.com:443` are the same origin rather than a refusal on a
// spelling difference. The SCHEME is part of it: an https→http hop is a downgrade that would put the
// token on the wire in clear, and it is not the same origin.
func requestOrigin(u *url.URL) string {
	port := u.Port()
	if port == "" {
		switch u.Scheme {
		case "https":
			port = "443"
		case "http":
			port = "80"
		}
	}
	return strings.ToLower(u.Scheme) + "://" + strings.ToLower(u.Hostname()) + ":" + port
}

// --- Types ---

type Repository struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	FullName      string `json:"full_name"`
	URL           string `json:"url"`
	Private       bool   `json:"private"`
	DefaultBranch string `json:"default_branch"`
	Provider      string `json:"provider"`
}

type ConfigurationExport struct {
	Content  string `json:"content"`
	Filename string `json:"filename"`
	Format   string `json:"format"`
}

// ProvisionJob mirrors the `jobs` wire contract (see
// apps/console/lib/validations/cli-contract.ts → jobWire). Every column the
// backend returns has a field here; the list endpoint additionally populates
// ProjectName/RunnerName. Nullable columns arrive as JSON null, which Go decodes to
// the zero value, so scalar nullables stay as plain strings.
// SigningKey is one receipt-signing key the control plane vouches for (GET /api/cli/signing-keys).
// Public material only. Source is "org" for a key from the org's retained rotation history, or
// "platform" for the key the runner signs with when no customer key is in the signing path —
// which is every receipt today, so a verifier that ignored the platform entry would trust none of
// them. Provider and Status are empty on the platform entry, which has no org row behind it.
type SigningKey struct {
	KeyID     string `json:"key_id"`
	PublicKey string `json:"public_key"`
	Algorithm string `json:"algorithm"`
	Source    string `json:"source"`
	Provider  string `json:"provider"`
	Status    string `json:"status"`
	Active    bool   `json:"active"`
}

// SigningKeysResponse is the GET /api/cli/signing-keys envelope.
type SigningKeysResponse struct {
	SigningKeys []SigningKey `json:"signing_keys"`
}

type ProvisionJob struct {
	ID                string                  `json:"id"`
	UserID            string                  `json:"user_id"`
	OrgID             string                  `json:"org_id"`
	JobType           string                  `json:"job_type"`
	InitiatedBy       string                  `json:"initiated_by"`
	ProjectID         string                  `json:"project_id"`
	CloudIdentityID   string                  `json:"cloud_identity_id"`
	RunnerID          string                  `json:"runner_id"`
	AssignedRunnerID  string                  `json:"assigned_runner_id"`
	PlanJobID         string                  `json:"plan_job_id"`
	ConfigurationHash string                  `json:"configuration_hash"`
	Status            string                  `json:"status"`
	Priority          int                     `json:"priority"`
	Provider          string                  `json:"provider"`
	ErrorMessage      *string                 `json:"error_message"`
	ExecutionMetadata *map[string]interface{} `json:"execution_metadata"`
	ConfigSnapshot    map[string]interface{}  `json:"config_snapshot"`
	ClaimedAt         *time.Time              `json:"claimed_at"`
	StartedAt         *time.Time              `json:"started_at"`
	CompletedAt       *time.Time              `json:"completed_at"`
	CreatedAt         time.Time               `json:"created_at"`
	UpdatedAt         time.Time               `json:"updated_at"`
	// List-only display fields (GET /api/jobs); absent on the single-job GET.
	ProjectName string `json:"project_name,omitempty"`
	RunnerName  string `json:"runner_name,omitempty"`
}

// JobsPage is one page of GET /api/jobs.
//
// Page is the cursor vocabulary and the field to build on: it carries the next position, the
// served page size and whether Total is exact or a floor. Total/Limit/Offset are the pre-cursor
// wire the interactive pager still uses; Total and Limit are the same numbers as Page.Total and
// Page.Limit, echoed rather than counted twice, and Total is therefore CAPPED — read Page.Mode
// before rendering it as a precise count.
type JobsPage struct {
	Jobs   []ProvisionJob `json:"jobs"`
	Total  int            `json:"total"`
	Limit  int            `json:"limit"`
	Offset int            `json:"offset"`
	Page   PageInfo       `json:"page"`
}

type JobLog struct {
	ID         int       `json:"id"`
	JobID      string    `json:"job_id"`
	LogChunk   string    `json:"log_chunk"`
	StreamType string    `json:"stream_type"`
	CreatedAt  time.Time `json:"created_at"`
}

type Runner struct {
	ID                 string    `json:"id"`
	Name               string    `json:"name"`
	Operator           string    `json:"operator"`            // "managed" | "self"
	Provisioning       string    `json:"provisioning"`        // "deployed" | "registered" | "" (managed)
	SupportedProviders []string  `json:"supported_providers"` // null/empty = any cloud
	Status             string    `json:"status"`
	LastHeartbeat      string    `json:"last_heartbeat"`
	Version            string    `json:"version"`
	IsDefault          bool      `json:"is_default"`
	CreatedAt          time.Time `json:"created_at"`
}

// ClustersPage is one page of GET /api/cli/clusters. Mirrors cliClustersPageResponse.
//
// There are no Total/Limit/Offset twins beside Page, unlike JobsPage: that endpoint carries them
// because a shipped CLI walks it by offset, and this one never had them to keep.
type ClustersPage struct {
	Clusters []ClusterSummary `json:"clusters"`
	Page     PageInfo         `json:"page"`
}

type ClusterSummary struct {
	ID                   string   `json:"id"`
	ClusterName          string   `json:"cluster_name"`
	ClusterVersion       string   `json:"cluster_version"`
	InstanceTypes        []string `json:"instance_types"`
	NodeMinSize          int      `json:"node_min_size"`
	NodeMaxSize          int      `json:"node_max_size"`
	NodeDesiredSize      int      `json:"node_desired_size"`
	Status               string   `json:"status"`
	StatusMessage        string   `json:"status_message"`
	ArgocdURL            string   `json:"argocd_url"`
	EstimatedMonthlyCost *float64 `json:"estimated_monthly_cost"`
	CreatedAt            string   `json:"created_at"`
	UpdatedAt            string   `json:"updated_at"`
	ProjectName          string   `json:"project_name"`
	Environment          string   `json:"environment"`
	Region               string   `json:"region"`
}

// ClusterGitops is the compact ArgoCD/GitOps posture for a cluster's default environment,
// derived from the console Deploy-tab read model. Mirrors clusterGitops in cli-contract.ts.
type ClusterGitops struct {
	Mode             string  `json:"mode"`
	AppsRepo         *string `json:"apps_repo"`
	Revision         *string `json:"revision"`
	Total            int     `json:"total"`
	Synced           int     `json:"synced"`
	Healthy          int     `json:"healthy"`
	StatusAvailable  bool    `json:"status_available"`
	LastDeployFailed bool    `json:"last_deploy_failed"`
	FailedStep       *string `json:"failed_step"`
	FailureMessage   *string `json:"failure_message"`
}

// ClusterDetail is a single cluster plus its GitOps posture (GET /api/cli/clusters/:id).
// Mirrors cliClusterDetailResponse in cli-contract.ts.
type ClusterDetail struct {
	Cluster ClusterSummary `json:"cluster"`
	Gitops  *ClusterGitops `json:"gitops"`
}

type CloudIdentity struct {
	ID        string `json:"id"`
	Provider  string `json:"provider"`
	Label     string `json:"label"`
	CreatedAt string `json:"created_at"`
}

type DeployRunnerResponse struct {
	Runner struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	} `json:"runner"`
	Job struct {
		ID        string `json:"id"`
		Status    string `json:"status"`
		CreatedAt string `json:"created_at"`
	} `json:"job"`
}

type QueueJobParams struct {
	JobType          string
	ConfigurationID  string
	CloudIdentityID  string
	AssignedRunnerID string
	PlanJobID        string
	// EnvironmentID targets a specific environment of the project (the decoupled env-model,
	// #843). Empty → the server resolves the project's default environment (back-compat). The
	// server (#837) routes it through planProject/provisionProject/destroyProject.
	EnvironmentID  string
	ConfigSnapshot map[string]interface{}
}

// --- Helpers ---

// setAuthHeaders applies the bearer token and, when an organization is in scope, the
// X-Alethia-Org header. Routing every request through this keeps org context (the tenancy
// boundary) uniform across the API. The scope is the `--org` override when one was named,
// otherwise the CLI config's active organization — see resolveOrgScope in org_scope.go.
func (c *Client) setAuthHeaders(req *http.Request) {
	req.Header.Set("Authorization", "Bearer "+c.authToken)
	if org := resolveOrgScope(); org != "" {
		req.Header.Set("X-Alethia-Org", org)
	}
}

func (c *Client) getProviderToken() string {
	configDir, err := os.UserConfigDir()
	if err != nil {
		return ""
	}
	credsPath := filepath.Join(configDir, "alethia", "credentials.json")
	file, err := os.ReadFile(credsPath)
	if err != nil {
		return ""
	}
	var creds types.ExchangeResponse
	if err := json.Unmarshal(file, &creds); err != nil {
		return ""
	}
	return creds.ProviderToken
}

// APIError is a non-success answer from the control plane. It is returned by every verb helper, so
// a caller that needs to tell an expired token from a missing permission from a server fault can
// reach the status code with errors.As instead of matching on a message. Callers that add their own
// prefix wrap it with %w, so errors.As still reaches through.
type APIError struct {
	StatusCode int
	Message    string
}

// Error renders the failure. It NEVER renders empty: the control plane's own explanation when there
// is one, and the bare status code when the body carried nothing usable. Returning a non-nil error
// whose message is "" is what produced `failed to get runners: ` with no reason (#2046).
func (e *APIError) Error() string {
	if e.Message == "" {
		return fmt.Sprintf("request failed with status %d", e.StatusCode)
	}
	return fmt.Sprintf("%s (status %d)", e.Message, e.StatusCode)
}

// errorBodyLimit bounds how much of a failure body is read. The body is attacker- or
// proxy-controlled and nothing obliges it to be small — a fronting proxy can stream megabytes of
// HTML at a 502 — so it is read through an io.LimitReader, never whole.
const errorBodyLimit = 8 << 10

// errorSnippetRunes bounds the body snippet rendered into the message, in runes rather than bytes so
// a truncation cannot split a UTF-8 sequence.
const errorSnippetRunes = 200

// responseError builds the error for a non-success response. It takes the first non-empty of the
// `error`, `message` and `error_description` keys — a Next.js route handler emits `message`, an
// OAuth-shaped answer emits `error_description`, and only Alethia's own handlers emit `error` — and
// falls back to a bounded, whitespace-collapsed snippet of the body when none of them yields text.
// The status code is always carried, so 401, 403 and 500 stay distinguishable.
func responseError(resp *http.Response) *APIError {
	body, _ := io.ReadAll(io.LimitReader(resp.Body, errorBodyLimit))
	apiErr := &APIError{StatusCode: resp.StatusCode}

	var fields struct {
		Error            string `json:"error"`
		Message          string `json:"message"`
		ErrorDescription string `json:"error_description"`
	}
	if err := json.Unmarshal(body, &fields); err == nil {
		for _, candidate := range []string{fields.Error, fields.Message, fields.ErrorDescription} {
			if text := strings.TrimSpace(candidate); text != "" {
				apiErr.Message = text
				return apiErr
			}
		}
	}

	apiErr.Message = bodySnippet(body)
	return apiErr
}

// bodySnippet collapses every run of whitespace to a single space and truncates, so an HTML error
// page or a stack trace becomes one readable line instead of screenfuls. An empty body yields "",
// which APIError.Error renders as the bare status.
func bodySnippet(body []byte) string {
	text := strings.Join(strings.Fields(string(body)), " ")
	if runes := []rune(text); len(runes) > errorSnippetRunes {
		text = string(runes[:errorSnippetRunes]) + "…"
	}
	return text
}

func (c *Client) doGet(endpoint string, result interface{}) error {
	req, err := http.NewRequest("GET", endpoint, nil)
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}
	c.setAuthHeaders(req)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("failed to send request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return responseError(resp)
	}

	return json.NewDecoder(resp.Body).Decode(result)
}

func (c *Client) doPost(endpoint string, payload interface{}, result interface{}) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("failed to marshal request body: %w", err)
	}

	req, err := http.NewRequest("POST", endpoint, bytes.NewBuffer(body))
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	c.setAuthHeaders(req)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("failed to send request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		return responseError(resp)
	}

	if result != nil {
		return json.NewDecoder(resp.Body).Decode(result)
	}
	return nil
}

func (c *Client) doPut(endpoint string, payload interface{}, result interface{}) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("failed to marshal request body: %w", err)
	}

	req, err := http.NewRequest("PUT", endpoint, bytes.NewBuffer(body))
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	c.setAuthHeaders(req)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("failed to send request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		return responseError(resp)
	}

	if result != nil {
		return json.NewDecoder(resp.Body).Decode(result)
	}
	return nil
}

func (c *Client) doDelete(endpoint string) error {
	req, err := http.NewRequest("DELETE", endpoint, nil)
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}
	c.setAuthHeaders(req)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("failed to send request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return responseError(resp)
	}
	return nil
}

// doDeleteWithBody is doDelete for the routes that identify WHAT to delete in the body rather than
// the path — a collection endpoint like .../byo-charts or .../addons, where the chart/add-on id is
// a field and not a segment. A DELETE carrying a body is legal and is what the console's own action
// shape implies here.
func (c *Client) doDeleteWithBody(endpoint string, payload interface{}) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("failed to encode request: %w", err)
	}
	req, err := http.NewRequest("DELETE", endpoint, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}
	c.setAuthHeaders(req)
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("failed to send request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return responseError(resp)
	}
	return nil
}

// --- Repositories ---

func (c *Client) GetRepositories(provider string) ([]Repository, error) {
	endpoint := fmt.Sprintf("%s/cli/repositories/%s", c.baseURL, url.PathEscape(provider))

	req, err := http.NewRequest("GET", endpoint, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}
	c.setAuthHeaders(req)
	if providerToken := c.getProviderToken(); providerToken != "" {
		req.Header.Set("X-Provider-Token", providerToken)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to send request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("failed to get repositories: %w", responseError(resp))
	}

	var successResp struct {
		Repositories []Repository `json:"repositories"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&successResp); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	return successResp.Repositories, nil
}

// --- Configurations (Projects) ---

func (c *Client) GetConfigurations() ([]types.ConfigurationSummary, error) {
	endpoint := fmt.Sprintf("%s/cli/configurations", c.baseURL)
	var successResp struct {
		Configurations []types.ConfigurationSummary `json:"configurations"`
	}
	if err := c.doGet(endpoint, &successResp); err != nil {
		return nil, fmt.Errorf("failed to get configurations: %w", err)
	}
	return successResp.Configurations, nil
}

func (c *Client) GetConfiguration(projectName string) (*types.Configuration, error) {
	var successResp struct {
		Configuration *types.Configuration `json:"configuration"`
	}
	endpoint := fmt.Sprintf("%s/cli/configurations/by-project-name/%s", c.baseURL, url.PathEscape(projectName))
	if err := c.doGet(endpoint, &successResp); err != nil {
		return nil, fmt.Errorf("failed to get configuration: %w", err)
	}
	return successResp.Configuration, nil
}

func (c *Client) ExportConfiguration(projectName, format string) (*ConfigurationExport, error) {
	// json, not legacy-yaml. The old default named a format with NO producer anywhere — the route it
	// asked for did not exist either, so this call 404'd for its whole life.
	if format == "" {
		format = "json"
	}
	endpoint := fmt.Sprintf(
		"%s/cli/configurations/by-project-name/%s/export?format=%s",
		c.baseURL, url.PathEscape(projectName), url.QueryEscape(format),
	)
	var export ConfigurationExport
	if err := c.doGet(endpoint, &export); err != nil {
		return nil, fmt.Errorf("failed to export configuration: %w", err)
	}
	return &export, nil
}

// --- Jobs ---

func (c *Client) QueueJobWithParams(params QueueJobParams) (*ProvisionJob, error) {
	endpoint := fmt.Sprintf("%s/jobs", c.baseURL)
	payload := map[string]interface{}{
		"job_type": params.JobType,
	}
	if params.ConfigurationID != "" {
		payload["configuration_id"] = params.ConfigurationID
	}
	if params.CloudIdentityID != "" {
		payload["cloud_identity_id"] = params.CloudIdentityID
	}
	if params.AssignedRunnerID != "" {
		payload["assigned_runner_id"] = params.AssignedRunnerID
	}
	if params.PlanJobID != "" {
		payload["plan_job_id"] = params.PlanJobID
	}
	if params.EnvironmentID != "" {
		payload["environment_id"] = params.EnvironmentID
	}
	if params.ConfigSnapshot != nil {
		payload["config_snapshot"] = params.ConfigSnapshot
	}

	var successResp struct {
		Job *ProvisionJob `json:"job"`
	}
	if err := c.doPost(endpoint, payload, &successResp); err != nil {
		return nil, fmt.Errorf("failed to queue job: %w", err)
	}
	return successResp.Job, nil
}

func (c *Client) GetJobs(status string, limit, offset int) (*JobsPage, error) {
	endpoint := fmt.Sprintf("%s/jobs", c.baseURL)
	params := url.Values{}
	if status != "" {
		params.Set("status", status)
	}
	if limit > 0 {
		params.Set("limit", fmt.Sprintf("%d", limit))
	}
	if offset > 0 {
		params.Set("offset", fmt.Sprintf("%d", offset))
	}
	if len(params) > 0 {
		endpoint = fmt.Sprintf("%s?%s", endpoint, params.Encode())
	}

	var page JobsPage
	if err := c.doGet(endpoint, &page); err != nil {
		return nil, fmt.Errorf("failed to get jobs: %w", err)
	}
	return &page, nil
}

func (c *Client) GetJob(jobID string) (*ProvisionJob, error) {
	endpoint := fmt.Sprintf("%s/cli/jobs/%s", c.baseURL, url.PathEscape(jobID))
	var job ProvisionJob
	if err := c.doGet(endpoint, &job); err != nil {
		return nil, fmt.Errorf("failed to get job: %w", err)
	}
	return &job, nil
}

// GetSigningKeys fetches the trusted-key set evidence receipts are verified against (#2331):
// the org's retained key_id→public_key history plus the platform key the runner signs with.
// Public key material only — the control plane never puts private or custody material on this
// wire.
func (c *Client) GetSigningKeys() ([]SigningKey, error) {
	endpoint := fmt.Sprintf("%s/cli/signing-keys", c.baseURL)
	var resp SigningKeysResponse
	if err := c.doGet(endpoint, &resp); err != nil {
		return nil, fmt.Errorf("failed to get signing keys: %w", err)
	}
	return resp.SigningKeys, nil
}

func (c *Client) GetJobLogs(jobID string, afterID int) ([]JobLog, error) {
	endpoint := fmt.Sprintf("%s/cli/jobs/%s/logs", c.baseURL, url.PathEscape(jobID))
	if afterID > 0 {
		endpoint = fmt.Sprintf("%s?after=%d", endpoint, afterID)
	}

	var successResp struct {
		Logs []JobLog `json:"logs"`
	}
	if err := c.doGet(endpoint, &successResp); err != nil {
		return nil, fmt.Errorf("failed to get job logs: %w", err)
	}
	return successResp.Logs, nil
}

func (c *Client) CancelJob(jobID string) error {
	endpoint := fmt.Sprintf("%s/cli/jobs/%s/cancel", c.baseURL, url.PathEscape(jobID))
	return c.doPost(endpoint, nil, nil)
}

// --- Runners ---

func (c *Client) GetRunners() ([]Runner, error) {
	endpoint := fmt.Sprintf("%s/cli/runners", c.baseURL)
	var successResp struct {
		Runners []Runner `json:"runners"`
	}
	if err := c.doGet(endpoint, &successResp); err != nil {
		return nil, fmt.Errorf("failed to get runners: %w", err)
	}
	return successResp.Runners, nil
}

func (c *Client) RemoveRunner(runnerID string) error {
	endpoint := fmt.Sprintf("%s/cli/runners/%s", c.baseURL, url.PathEscape(runnerID))
	if err := c.doDelete(endpoint); err != nil {
		return fmt.Errorf("failed to remove runner: %w", err)
	}
	return nil
}

// RunnerRegistration is the response to RegisterRunner: the created runner plus its bearer token.
// The token is returned ONCE — only its SHA-256 is stored — so a caller that discards it must
// register a new runner.
type RunnerRegistration struct {
	Runner      Runner `json:"runner"`
	RunnerToken string `json:"runner_token"`
}

// RegisterRunner registers a SELF-OPERATED runner the caller will run themselves, and returns its
// token. Unlike DeployRunner nothing is provisioned, which is what makes it the answer for a cloud
// other than AWS: DeployRunner renders infra/templates/runner/, and that directory has one cloud in
// it. An empty cloudIdentityID leaves the runner unbound to a cloud account.
func (c *Client) RegisterRunner(name, cloudIdentityID string) (*RunnerRegistration, error) {
	endpoint := fmt.Sprintf("%s/cli/runners/register", c.baseURL)
	payload := map[string]interface{}{"name": name}
	if cloudIdentityID != "" {
		payload["cloud_identity_id"] = cloudIdentityID
	}
	var resp RunnerRegistration
	if err := c.doPost(endpoint, payload, &resp); err != nil {
		return nil, fmt.Errorf("failed to register runner: %w", err)
	}
	return &resp, nil
}

func (c *Client) DeployRunner(name, cloudIdentityID, region, assignedRunnerID string) (*DeployRunnerResponse, error) {
	endpoint := fmt.Sprintf("%s/cli/runners/deploy", c.baseURL)
	payload := map[string]string{
		"name":              name,
		"cloud_identity_id": cloudIdentityID,
		"region":            region,
	}
	if assignedRunnerID != "" {
		payload["assigned_runner_id"] = assignedRunnerID
	}

	var resp DeployRunnerResponse
	if err := c.doPost(endpoint, payload, &resp); err != nil {
		return nil, fmt.Errorf("failed to deploy runner: %w", err)
	}
	return &resp, nil
}

// --- Clusters (Project Clusters) ---

// GetClustersPage fetches ONE page of the org's clusters.
//
// Prefer GetClusters unless you are rendering a pager: a page is a window, and a caller that
// reads Clusters and stops has silently truncated the collection at the server's default page
// size. That is the failure this method's existence makes explicit rather than accidental.
func (c *Client) GetClustersPage(opts PageOpts) (*ClustersPage, error) {
	endpoint := fmt.Sprintf("%s/cli/clusters", c.baseURL)
	params := url.Values{}
	opts.Apply(params)
	if len(params) > 0 {
		endpoint = fmt.Sprintf("%s?%s", endpoint, params.Encode())
	}
	var page ClustersPage
	if err := c.doGet(endpoint, &page); err != nil {
		return nil, fmt.Errorf("failed to get clusters: %w", err)
	}
	// A server older than #3672 answers with no `page` object at all, which decodes to the ZERO
	// PageInfo — Mode "", Limit 0, Total 0. That is a third mode the vocabulary does not define,
	// and it is not merely undefined but WRONG for a caller rendering a pager: Total 0 beside a
	// non-empty Clusters slice, and IsCapped() false for a reason it never established. The old
	// response is a complete, exact, single page of everything, so it is described as one.
	// GetClusters is unaffected either way — NextCursor stays empty, so the walk still terminates
	// in one request.
	if page.Page.Mode == "" {
		page.Page = PageInfo{
			Mode:  PageModeExact,
			Limit: len(page.Clusters),
			Total: len(page.Clusters),
		}
	}
	return &page, nil
}

// GetClusters returns EVERY cluster the org has, walking the cursor to exhaustion.
//
// The endpoint used to return the whole collection in one response and now returns a page
// (#3672). Every caller here — `cluster list`, and `cluster get`'s selector match — means "all of
// them", so the walk lives at this seam rather than in each command: a command that walked for
// itself would be a second implementation of the three termination bugs AllPages documents, and a
// command that did not walk would print a plausible, short list with no error.
//
// A page whose response carries no `page` object at all has an empty NextCursor either way — so
// this also does the right thing against a server older than the conversion, in one request.
// GetClustersPage additionally rewrites that absent page into an exact single page, so the pager
// case is not left holding a mode the vocabulary does not define.
func (c *Client) GetClusters() ([]ClusterSummary, error) {
	return AllPages(func(cursor string) ([]ClusterSummary, PageInfo, error) {
		page, err := c.GetClustersPage(PageOpts{Cursor: cursor})
		if err != nil {
			return nil, PageInfo{}, err
		}
		return page.Clusters, page.Page, nil
	})
}

// GetCluster fetches a single cluster by its id, plus its compact ArgoCD/GitOps posture.
func (c *Client) GetCluster(id string) (*ClusterDetail, error) {
	endpoint := fmt.Sprintf("%s/cli/clusters/%s", c.baseURL, url.PathEscape(id))
	var detail ClusterDetail
	if err := c.doGet(endpoint, &detail); err != nil {
		return nil, fmt.Errorf("failed to get cluster: %w", err)
	}
	return &detail, nil
}

// --- Legacy (used by core/utils) ---

type LogEntry struct {
	Message string `json:"message"`
	Level   string `json:"level"`
	Step    string `json:"step,omitempty"`
}

func (c *Client) SendLog(deploymentID string, log LogEntry) error {
	endpoint := fmt.Sprintf("%s/deployments/%s/logs", c.baseURL, url.PathEscape(deploymentID))
	return c.doPost(endpoint, log, nil)
}

type BootstrapJob struct {
	ID           string    `json:"id"`
	Status       string    `json:"status"`
	ErrorMessage *string   `json:"error_message,omitempty"`
	CreatedAt    time.Time `json:"created_at"`
}

func (c *Client) CreateBootstrapJob() (*BootstrapJob, error) {
	endpoint := fmt.Sprintf("%s/cli/bootstrap-jobs", c.baseURL)
	payload := map[string]string{}
	var successResp struct {
		Job *BootstrapJob `json:"job"`
	}
	if err := c.doPost(endpoint, payload, &successResp); err != nil {
		return nil, fmt.Errorf("failed to create bootstrap job: %w", err)
	}
	return successResp.Job, nil
}

func (c *Client) UpdateBootstrapJobStatus(jobID, status, errorMessage string) error {
	endpoint := fmt.Sprintf("%s/cli/bootstrap-jobs/%s", c.baseURL, url.PathEscape(jobID))
	payload := map[string]string{"status": status}
	if errorMessage != "" {
		payload["error_message"] = errorMessage
	}
	body, _ := json.Marshal(payload)
	req, err := http.NewRequest("PUT", endpoint, bytes.NewBuffer(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	c.setAuthHeaders(req)
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("failed to update bootstrap job: status %d", resp.StatusCode)
	}
	return nil
}

type ClusterRegistrationResponse struct {
	ClusterID  string `json:"cluster_id"`
	AgentToken string `json:"agent_token"`
}

func (c *Client) RegisterCluster(name, vpcID, vpcCidr, region string) (*ClusterRegistrationResponse, error) {
	endpoint := fmt.Sprintf("%s/cli/clusters", c.baseURL)
	payload := map[string]string{
		"name": name, "vpc_id": vpcID, "vpc_cidr": vpcCidr,
		"region": region,
	}
	var resp ClusterRegistrationResponse
	if err := c.doPost(endpoint, payload, &resp); err != nil {
		return nil, fmt.Errorf("failed to register cluster: %w", err)
	}
	return &resp, nil
}

func (c *Client) UnregisterCluster(id, name string) error {
	endpoint := fmt.Sprintf("%s/cli/clusters", c.baseURL)
	req, err := http.NewRequest("DELETE", endpoint, nil)
	if err != nil {
		return err
	}
	q := req.URL.Query()
	if id != "" {
		q.Add("id", id)
	}
	if name != "" {
		q.Add("name", name)
	}
	req.URL.RawQuery = q.Encode()
	c.setAuthHeaders(req)
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("failed to unregister cluster: status %d", resp.StatusCode)
	}
	return nil
}

func (c *Client) SendBootstrapLog(jobID string, logChunk string, streamType string) error {
	endpoint := fmt.Sprintf("%s/cli/bootstrap-jobs/%s/logs", c.baseURL, url.PathEscape(jobID))
	payload := map[string]string{
		"log_chunk":   logChunk,
		"stream_type": streamType,
	}
	return c.doPost(endpoint, payload, nil)
}

// --- Cloud Identities ---

func (c *Client) GetCloudIdentities() ([]CloudIdentity, error) {
	endpoint := fmt.Sprintf("%s/cli/cloud-identities", c.baseURL)
	var successResp struct {
		CloudIdentities []CloudIdentity `json:"cloud_identities"`
	}
	if err := c.doGet(endpoint, &successResp); err != nil {
		return nil, fmt.Errorf("failed to get cloud identities: %w", err)
	}
	return successResp.CloudIdentities, nil
}

// --- Cloud Provider Connections ---

type InitIdentityResponse struct {
	IdentityID string `json:"identity_id"`
	ExternalID string `json:"external_id"`
}

// ConnectIdentityResponse is the SYNCHRONOUS result of submitting credentials — the
// server runs the health probe inline and returns the verdict directly (there is no
// CONNECTION_TEST job anymore). Mirrors connectIdentityWire in cli-contract.ts.
type ConnectIdentityResponse struct {
	IdentityID         string   `json:"identity_id"`
	Verified           bool     `json:"verified"`
	Status             string   `json:"status"` // connected | degraded | disconnected
	Error              string   `json:"error"`
	MissingPermissions []string `json:"missing_permissions"`
}

type ProviderStatus struct {
	Connected  bool   `json:"connected"`
	IdentityID string `json:"identityId"`
	// AWS
	AccountID  string `json:"accountId"`
	RoleArn    string `json:"roleArn"`
	ExternalID string `json:"externalId"`
	// GCP
	ProjectID           string `json:"projectId"`
	ServiceAccountEmail string `json:"serviceAccountEmail"`
	// Azure
	TenantID       string `json:"tenantId"`
	ClientID       string `json:"clientId"`
	SubscriptionID string `json:"subscriptionId"`
}

// InitProviderIdentity gets or creates the pending identity for a provider.
// For AWS, the response includes the external_id to embed in the trust policy.
func (c *Client) InitProviderIdentity(provider string) (*InitIdentityResponse, error) {
	endpoint := fmt.Sprintf("%s/cli/providers/%s/init", c.baseURL, url.PathEscape(provider))
	var resp InitIdentityResponse
	if err := c.doPost(endpoint, map[string]interface{}{}, &resp); err != nil {
		return nil, fmt.Errorf("failed to initialize %s connection: %w", provider, err)
	}
	return &resp, nil
}

// ConnectProviderIdentity submits the captured credentials; the server verifies the
// identity INLINE (a synchronous health probe) and returns the verdict directly — no
// job to poll. The credentials map shape is provider-specific:
//   - aws:   {"role_arn": "..."}
//   - gcp:   {"wif_config": {...}}
//   - azure: {"tenant_id": "...", "client_id": "...", "subscription_id": "..."}
func (c *Client) ConnectProviderIdentity(provider, identityID string, credentials map[string]interface{}) (*ConnectIdentityResponse, error) {
	endpoint := fmt.Sprintf("%s/cli/providers/%s/connect", c.baseURL, url.PathEscape(provider))
	payload := map[string]interface{}{
		"identity_id": identityID,
		"credentials": credentials,
	}
	var resp ConnectIdentityResponse
	if err := c.doPost(endpoint, payload, &resp); err != nil {
		return nil, fmt.Errorf("failed to submit %s credentials: %w", provider, err)
	}
	return &resp, nil
}

// DisconnectProviderIdentity resets a provider identity to its pending state.
func (c *Client) DisconnectProviderIdentity(provider, identityID string) error {
	endpoint := fmt.Sprintf("%s/cli/providers/%s/disconnect", c.baseURL, url.PathEscape(provider))
	payload := map[string]interface{}{"identity_id": identityID}
	if err := c.doPost(endpoint, payload, nil); err != nil {
		return fmt.Errorf("failed to disconnect %s: %w", provider, err)
	}
	return nil
}

// GetProviderStatus returns the verified connection status for a provider.
func (c *Client) GetProviderStatus(provider string) (*ProviderStatus, error) {
	endpoint := fmt.Sprintf("%s/cli/providers/%s/status", c.baseURL, url.PathEscape(provider))
	var resp ProviderStatus
	if err := c.doGet(endpoint, &resp); err != nil {
		return nil, fmt.Errorf("failed to get %s status: %w", provider, err)
	}
	return &resp, nil
}

// VerifyProviderIdentity re-runs the server-side health probe against a saved
// cloud identity (auth + provisioning-capability check) and returns the verdict.
// The server verifies INLINE — there is no job to poll. The identityID is the
// connected identity (see GetProviderStatus.IdentityID).
func (c *Client) VerifyProviderIdentity(provider, identityID string) (*ConnectIdentityResponse, error) {
	endpoint := fmt.Sprintf("%s/cli/providers/%s/verify", c.baseURL, url.PathEscape(provider))
	payload := map[string]interface{}{"identity_id": identityID}
	var resp ConnectIdentityResponse
	if err := c.doPost(endpoint, payload, &resp); err != nil {
		return nil, fmt.Errorf("failed to verify %s connection: %w", provider, err)
	}
	return &resp, nil
}

// --- Identity & Organizations ---
//
// These mirror the wire contract in apps/console/lib/validations/cli-contract.ts
// (whoamiWire, orgWire, memberWire, teamWire). The active org is selected with
// `alethia org switch`, persisted in the CLI config, and sent as X-Alethia-Org.

// OrgSummary is an organization the caller belongs to, with the caller's role and
// the org's billing plan. `IsActive` marks the org the CLI is currently scoped to.
type OrgSummary struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Slug     string `json:"slug"`
	Role     string `json:"role"`
	Plan     string `json:"plan"`
	IsActive bool   `json:"is_active"`
}

// WhoAmI is the resolved CLI identity: the authenticated user, the active org
// context, and the org's default runner (if any).
type WhoAmI struct {
	User struct {
		ID    string `json:"id"`
		Email string `json:"email"`
		Name  string `json:"name"`
	} `json:"user"`
	ActiveOrg     *OrgSummary `json:"active_org"`
	DefaultRunner *struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	} `json:"default_runner"`
}

// Member is a member of an organization.
type Member struct {
	ID     string `json:"id"`
	UserID string `json:"user_id"`
	Email  string `json:"email"`
	Name   string `json:"name"`
	Role   string `json:"role"`
	Status string `json:"status"`
}

// Invitation is a pending invitation created by InviteMember.
type Invitation struct {
	ID     string `json:"id"`
	Email  string `json:"email"`
	Role   string `json:"role"`
	Status string `json:"status"`
}

// Team is an organization team.
type Team struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	MemberCount int    `json:"member_count"`
}

// Whoami resolves the authenticated user and active org context.
func (c *Client) Whoami() (*WhoAmI, error) {
	endpoint := fmt.Sprintf("%s/cli/whoami", c.baseURL)
	var resp WhoAmI
	if err := c.doGet(endpoint, &resp); err != nil {
		return nil, fmt.Errorf("failed to resolve identity: %w", err)
	}
	return &resp, nil
}

// ListOrgs returns the organizations the caller belongs to.
func (c *Client) ListOrgs() ([]OrgSummary, error) {
	endpoint := fmt.Sprintf("%s/cli/orgs", c.baseURL)
	var successResp struct {
		Orgs []OrgSummary `json:"orgs"`
	}
	if err := c.doGet(endpoint, &successResp); err != nil {
		return nil, fmt.Errorf("failed to list organizations: %w", err)
	}
	return successResp.Orgs, nil
}

// ListMembers returns the members of an organization.
func (c *Client) ListMembers(orgID string) ([]Member, error) {
	endpoint := fmt.Sprintf("%s/cli/orgs/%s/members", c.baseURL, url.PathEscape(orgID))
	var successResp struct {
		Members []Member `json:"members"`
	}
	if err := c.doGet(endpoint, &successResp); err != nil {
		return nil, fmt.Errorf("failed to list members: %w", err)
	}
	return successResp.Members, nil
}

// InviteMember invites an email to the organization with the given role.
func (c *Client) InviteMember(orgID, email, role string) (*Invitation, error) {
	endpoint := fmt.Sprintf("%s/cli/orgs/%s/members", c.baseURL, url.PathEscape(orgID))
	payload := map[string]string{"email": email, "role": role}
	var successResp struct {
		Invitation *Invitation `json:"invitation"`
	}
	if err := c.doPost(endpoint, payload, &successResp); err != nil {
		return nil, fmt.Errorf("failed to invite member: %w", err)
	}
	return successResp.Invitation, nil
}

// RemoveMember removes a member from the organization.
func (c *Client) RemoveMember(orgID, memberID string) error {
	endpoint := fmt.Sprintf("%s/cli/orgs/%s/members/%s", c.baseURL, url.PathEscape(orgID), url.PathEscape(memberID))
	if err := c.doDelete(endpoint); err != nil {
		return fmt.Errorf("failed to remove member: %w", err)
	}
	return nil
}

// ListTeams returns the teams of an organization.
func (c *Client) ListTeams(orgID string) ([]Team, error) {
	endpoint := fmt.Sprintf("%s/cli/orgs/%s/teams", c.baseURL, url.PathEscape(orgID))
	var successResp struct {
		Teams []Team `json:"teams"`
	}
	if err := c.doGet(endpoint, &successResp); err != nil {
		return nil, fmt.Errorf("failed to list teams: %w", err)
	}
	return successResp.Teams, nil
}

// CreateTeam creates a team in the organization.
func (c *Client) CreateTeam(orgID, name string) (*Team, error) {
	endpoint := fmt.Sprintf("%s/cli/orgs/%s/teams", c.baseURL, url.PathEscape(orgID))
	payload := map[string]string{"name": name}
	var successResp struct {
		Team *Team `json:"team"`
	}
	if err := c.doPost(endpoint, payload, &successResp); err != nil {
		return nil, fmt.Errorf("failed to create team: %w", err)
	}
	return successResp.Team, nil
}

// DeleteTeam deletes a team from the organization.
func (c *Client) DeleteTeam(orgID, teamID string) error {
	endpoint := fmt.Sprintf("%s/cli/orgs/%s/teams/%s", c.baseURL, url.PathEscape(orgID), url.PathEscape(teamID))
	if err := c.doDelete(endpoint); err != nil {
		return fmt.Errorf("failed to delete team: %w", err)
	}
	return nil
}

// --- Notifications: Channels, Alert rules, Activity ---
//
// These mirror the wire contract in apps/console/lib/validations/cli-contract.ts
// (channelWire, alertRuleWire, activityWire). Channel secrets (webhook/Slack URLs,
// PagerDuty routing keys) are AES-encrypted server-side and never returned — only
// HasSecret / Recipients surface. All are scoped to the active org.

// Channel is a notification delivery destination (webhook, email, Slack, …). The
// encrypted secret envelope is never on the wire; HasSecret reports its presence.
type Channel struct {
	ID             string   `json:"id"`
	Type           string   `json:"type"`
	Name           string   `json:"name"`
	Enabled        bool     `json:"enabled"`
	IsVerified     bool     `json:"is_verified"`
	Recipients     []string `json:"recipients"`
	HasSecret      bool     `json:"has_secret"`
	LastVerifiedAt string   `json:"last_verified_at"`
	CreatedAt      string   `json:"created_at"`
}

// AlertRule binds a set of event-key patterns to notification channels.
type AlertRule struct {
	ID              string   `json:"id"`
	Name            string   `json:"name"`
	Description     string   `json:"description"`
	EventPatterns   []string `json:"event_patterns"`
	Severity        string   `json:"severity"`
	ThrottleSeconds int      `json:"throttle_seconds"`
	Enabled         bool     `json:"enabled"`
	ChannelIDs      []string `json:"channel_ids"`
	CreatedAt       string   `json:"created_at"`
}

// ActivityEntry is one row of the PDP-written delivery/activity log.
type ActivityEntry struct {
	ID           string `json:"id"`
	ActorID      string `json:"actor_id"`
	ActorName    string `json:"actor_name"`
	ActorEmail   string `json:"actor_email"`
	Action       string `json:"action"`
	ResourceType string `json:"resource_type"`
	ResourceID   string `json:"resource_id"`
	Decision     bool   `json:"decision"`
	Reason       string `json:"reason"`
	Ts           string `json:"ts"`
}

// ListChannels returns the active org's notification channels.
func (c *Client) ListChannels() ([]Channel, error) {
	endpoint := fmt.Sprintf("%s/cli/channels", c.baseURL)
	var successResp struct {
		Channels []Channel `json:"channels"`
	}
	if err := c.doGet(endpoint, &successResp); err != nil {
		return nil, fmt.Errorf("failed to list channels: %w", err)
	}
	return successResp.Channels, nil
}

// CreateChannel creates a notification channel. `config` carries the email
// recipients and/or the transport destination (url / signing_secret / routing_key).
func (c *Client) CreateChannel(name, channelType string, config map[string]interface{}) (*Channel, error) {
	endpoint := fmt.Sprintf("%s/cli/channels", c.baseURL)
	payload := map[string]interface{}{"name": name, "type": channelType, "config": config}
	var successResp struct {
		Channel *Channel `json:"channel"`
	}
	if err := c.doPost(endpoint, payload, &successResp); err != nil {
		return nil, fmt.Errorf("failed to create channel: %w", err)
	}
	return successResp.Channel, nil
}

// DeleteChannel deletes a notification channel.
func (c *Client) DeleteChannel(channelID string) error {
	endpoint := fmt.Sprintf("%s/cli/channels/%s", c.baseURL, url.PathEscape(channelID))
	if err := c.doDelete(endpoint); err != nil {
		return fmt.Errorf("failed to delete channel: %w", err)
	}
	return nil
}

// VerifyChannel sends a synthetic test event through the channel and returns the
// (now verified) channel.
func (c *Client) VerifyChannel(channelID string) (*Channel, error) {
	endpoint := fmt.Sprintf("%s/cli/channels/%s/verify", c.baseURL, url.PathEscape(channelID))
	var successResp struct {
		Channel *Channel `json:"channel"`
	}
	if err := c.doPost(endpoint, map[string]interface{}{}, &successResp); err != nil {
		return nil, fmt.Errorf("failed to verify channel: %w", err)
	}
	return successResp.Channel, nil
}

// ListAlertRules returns the active org's alert rules with their bound channel ids.
func (c *Client) ListAlertRules() ([]AlertRule, error) {
	endpoint := fmt.Sprintf("%s/cli/alerts", c.baseURL)
	var successResp struct {
		AlertRules []AlertRule `json:"alert_rules"`
	}
	if err := c.doGet(endpoint, &successResp); err != nil {
		return nil, fmt.Errorf("failed to list alert rules: %w", err)
	}
	return successResp.AlertRules, nil
}

// CreateAlertRule creates an alert rule binding event patterns to channels.
func (c *Client) CreateAlertRule(name string, eventPatterns, channelIDs []string, severity string) (*AlertRule, error) {
	endpoint := fmt.Sprintf("%s/cli/alerts", c.baseURL)
	payload := map[string]interface{}{
		"name":           name,
		"event_patterns": eventPatterns,
		"channel_ids":    channelIDs,
		"severity":       severity,
	}
	var successResp struct {
		AlertRule *AlertRule `json:"alert_rule"`
	}
	if err := c.doPost(endpoint, payload, &successResp); err != nil {
		return nil, fmt.Errorf("failed to create alert rule: %w", err)
	}
	return successResp.AlertRule, nil
}

// DeleteAlertRule deletes an alert rule.
func (c *Client) DeleteAlertRule(ruleID string) error {
	endpoint := fmt.Sprintf("%s/cli/alerts/%s", c.baseURL, url.PathEscape(ruleID))
	if err := c.doDelete(endpoint); err != nil {
		return fmt.Errorf("failed to delete alert rule: %w", err)
	}
	return nil
}

// ListActivity returns the active org's delivery/activity log, newest first.
// A limit <= 0 lets the server apply its default page size.
func (c *Client) ListActivity(limit int) ([]ActivityEntry, error) {
	endpoint := fmt.Sprintf("%s/cli/activity", c.baseURL)
	if limit > 0 {
		endpoint = fmt.Sprintf("%s?limit=%d", endpoint, limit)
	}
	var successResp struct {
		Activity []ActivityEntry `json:"activity"`
	}
	if err := c.doGet(endpoint, &successResp); err != nil {
		return nil, fmt.Errorf("failed to list activity: %w", err)
	}
	return successResp.Activity, nil
}

// --- RBAC: Roles, Grants, SSO ---
//
// These mirror the wire contract in apps/console/lib/validations/cli-contract.ts
// (roleWire, grantWire, ssoProviderWire). Roles are the four built-in templates plus
// the org's custom roles; grants bind a principal (user/team) to a role OR a single
// permission at a resource scope, allow or deny; SSO providers are read-only (registered
// via Better Auth's sso plugin). All are scoped to the active org and PDP-gated.

// Role is a permission bundle: a built-in template (IsBuiltin) or a custom org role.
// PermissionKeys are its `resource:action` keys (every key for the owner template).
type Role struct {
	ID             string   `json:"id"`
	Name           string   `json:"name"`
	Description    string   `json:"description"`
	IsBuiltin      bool     `json:"is_builtin"`
	PermissionKeys []string `json:"permission_keys"`
}

// Grant binds a principal to a role XOR a single permission at a resource scope, as an
// allow or explicit deny. Role is the bound role's name (empty for a permission grant);
// PermissionKey is the bound permission (empty for a role grant); ResourceID empty =
// org-wide.
type Grant struct {
	ID            string `json:"id"`
	PrincipalType string `json:"principal_type"`
	PrincipalID   string `json:"principal_id"`
	Effect        string `json:"effect"`
	Role          string `json:"role"`
	PermissionKey string `json:"permission_key"`
	ResourceType  string `json:"resource_type"`
	ResourceID    string `json:"resource_id"`
}

// SsoProvider is a configured SSO identity provider (read-only). Secrets/config JSON
// are never on the wire; Enabled reports whether its domain is verified.
type SsoProvider struct {
	ID           string `json:"id"`
	ProviderType string `json:"provider_type"`
	Domain       string `json:"domain"`
	Issuer       string `json:"issuer"`
	Enabled      bool   `json:"enabled"`
}

// AddGrantParams is the payload for AddGrant. Provide exactly one of RoleID or
// PermissionKey; leave ResourceID empty for an org-wide grant.
type AddGrantParams struct {
	PrincipalType string
	PrincipalID   string
	Effect        string
	RoleID        string
	PermissionKey string
	ResourceType  string
	ResourceID    string
}

// ListRoles returns the active org's roles: the built-in templates plus custom roles.
func (c *Client) ListRoles() ([]Role, error) {
	endpoint := fmt.Sprintf("%s/cli/roles", c.baseURL)
	var successResp struct {
		Roles []Role `json:"roles"`
	}
	if err := c.doGet(endpoint, &successResp); err != nil {
		return nil, fmt.Errorf("failed to list roles: %w", err)
	}
	return successResp.Roles, nil
}

// CreateRole creates a custom role with the given permission keys.
func (c *Client) CreateRole(name string, permissionKeys []string) (*Role, error) {
	endpoint := fmt.Sprintf("%s/cli/roles", c.baseURL)
	if permissionKeys == nil {
		permissionKeys = []string{}
	}
	payload := map[string]interface{}{"name": name, "permission_keys": permissionKeys}
	var successResp struct {
		Role *Role `json:"role"`
	}
	if err := c.doPost(endpoint, payload, &successResp); err != nil {
		return nil, fmt.Errorf("failed to create role: %w", err)
	}
	return successResp.Role, nil
}

// DeleteRole deletes a custom role.
func (c *Client) DeleteRole(roleID string) error {
	endpoint := fmt.Sprintf("%s/cli/roles/%s", c.baseURL, url.PathEscape(roleID))
	if err := c.doDelete(endpoint); err != nil {
		return fmt.Errorf("failed to delete role: %w", err)
	}
	return nil
}

// ClassificationValue is one allowed value on a dimension.
type ClassificationValue struct {
	ID    string `json:"id"`
	Value string `json:"value"`
	Label string `json:"label"`
}

// ClassificationDimension is a classification axis with its values and resource-kind scope.
type ClassificationDimension struct {
	ID          string                `json:"id"`
	Key         string                `json:"key"`
	Label       string                `json:"label"`
	Description string                `json:"description"`
	Multi       bool                  `json:"multi"`
	AppliesTo   []string              `json:"applies_to"`
	Values      []ClassificationValue `json:"values"`
}

// ClassificationAssignment is a value assigned to a resource.
type ClassificationAssignment struct {
	DimensionKey   string `json:"dimension_key"`
	DimensionLabel string `json:"dimension_label"`
	Value          string `json:"value"`
	ValueLabel     string `json:"value_label"`
}

// ListClassificationDimensions returns the org's classification taxonomy.
func (c *Client) ListClassificationDimensions() ([]ClassificationDimension, error) {
	endpoint := fmt.Sprintf("%s/cli/classification/dimensions", c.baseURL)
	var resp struct {
		Dimensions []ClassificationDimension `json:"dimensions"`
	}
	if err := c.doGet(endpoint, &resp); err != nil {
		return nil, fmt.Errorf("failed to list classification dimensions: %w", err)
	}
	return resp.Dimensions, nil
}

// GetResourceClassifications returns the values assigned to a resource.
func (c *Client) GetResourceClassifications(kind, id string) ([]ClassificationAssignment, error) {
	endpoint := fmt.Sprintf("%s/cli/classification/assignments?kind=%s&id=%s",
		c.baseURL, url.QueryEscape(kind), url.QueryEscape(id))
	var resp struct {
		Assignments []ClassificationAssignment `json:"assignments"`
	}
	if err := c.doGet(endpoint, &resp); err != nil {
		return nil, fmt.Errorf("failed to get classifications: %w", err)
	}
	return resp.Assignments, nil
}

// AssignClassification pins a value (by dimension key + value slug) to a resource and returns
// the resource's updated assignments.
func (c *Client) AssignClassification(kind, id, dimensionKey, valueSlug string) ([]ClassificationAssignment, error) {
	endpoint := fmt.Sprintf("%s/cli/classification/assignments", c.baseURL)
	payload := map[string]interface{}{
		"kind":          kind,
		"id":            id,
		"dimension_key": dimensionKey,
		"value_slug":    valueSlug,
	}
	var resp struct {
		Assignments []ClassificationAssignment `json:"assignments"`
	}
	if err := c.doPost(endpoint, payload, &resp); err != nil {
		return nil, fmt.Errorf("failed to assign classification: %w", err)
	}
	return resp.Assignments, nil
}

// UnassignClassification clears a value (by slug) from a resource.
func (c *Client) UnassignClassification(kind, id, valueSlug string) error {
	endpoint := fmt.Sprintf("%s/cli/classification/assignments?kind=%s&id=%s&value_slug=%s",
		c.baseURL, url.QueryEscape(kind), url.QueryEscape(id), url.QueryEscape(valueSlug))
	if err := c.doDelete(endpoint); err != nil {
		return fmt.Errorf("failed to unassign classification: %w", err)
	}
	return nil
}

// ListGrants returns the active org's access grants.
func (c *Client) ListGrants() ([]Grant, error) {
	endpoint := fmt.Sprintf("%s/cli/grants", c.baseURL)
	var successResp struct {
		Grants []Grant `json:"grants"`
	}
	if err := c.doGet(endpoint, &successResp); err != nil {
		return nil, fmt.Errorf("failed to list grants: %w", err)
	}
	return successResp.Grants, nil
}

// AddGrant assigns an access grant. Empty optional fields are omitted from the payload
// so the server applies its defaults (effect=allow, resource_type=org).
func (c *Client) AddGrant(params AddGrantParams) (*Grant, error) {
	endpoint := fmt.Sprintf("%s/cli/grants", c.baseURL)
	payload := map[string]interface{}{
		"principal_type": params.PrincipalType,
		"principal_id":   params.PrincipalID,
	}
	if params.Effect != "" {
		payload["effect"] = params.Effect
	}
	if params.RoleID != "" {
		payload["role_id"] = params.RoleID
	}
	if params.PermissionKey != "" {
		payload["permission_key"] = params.PermissionKey
	}
	if params.ResourceType != "" {
		payload["resource_type"] = params.ResourceType
	}
	if params.ResourceID != "" {
		payload["resource_id"] = params.ResourceID
	}
	var successResp struct {
		Grant *Grant `json:"grant"`
	}
	if err := c.doPost(endpoint, payload, &successResp); err != nil {
		return nil, fmt.Errorf("failed to add grant: %w", err)
	}
	return successResp.Grant, nil
}

// RemoveGrant revokes an access grant.
func (c *Client) RemoveGrant(grantID string) error {
	endpoint := fmt.Sprintf("%s/cli/grants/%s", c.baseURL, url.PathEscape(grantID))
	if err := c.doDelete(endpoint); err != nil {
		return fmt.Errorf("failed to remove grant: %w", err)
	}
	return nil
}

// ListSsoProviders returns the active org's configured SSO identity providers.
func (c *Client) ListSsoProviders() ([]SsoProvider, error) {
	endpoint := fmt.Sprintf("%s/cli/sso", c.baseURL)
	var successResp struct {
		SsoProviders []SsoProvider `json:"sso_providers"`
	}
	if err := c.doGet(endpoint, &successResp); err != nil {
		return nil, fmt.Errorf("failed to list SSO providers: %w", err)
	}
	return successResp.SsoProviders, nil
}

// GetSsoProvider returns a single SSO identity provider by id.
func (c *Client) GetSsoProvider(id string) (*SsoProvider, error) {
	endpoint := fmt.Sprintf("%s/cli/sso/%s", c.baseURL, url.PathEscape(id))
	var successResp struct {
		SsoProvider *SsoProvider `json:"sso_provider"`
	}
	if err := c.doGet(endpoint, &successResp); err != nil {
		return nil, fmt.Errorf("failed to get SSO provider: %w", err)
	}
	return successResp.SsoProvider, nil
}

// --- Billing, Usage & Managed fleet ---
//
// These mirror the wire contract in apps/console/lib/validations/cli-contract.ts
// (billingWire, usageWire, fleetPoolWire). Billing + usage are read-only org-scoped
// roll-ups (no Stripe customer ids / amounts on the wire). Fleet pools are GLOBAL
// platform-operator config (no org_id): readable by owner/admin/viewer and editable by
// owner/admin (the `fleet` PDP resource), and only on self-managed deployments — hosted
// tenants get an empty list and an edit is refused.

// Billing is the active org's billing state. Seats is nil on flat tiers / no subscription;
// the timestamp fields are empty strings when absent.
type Billing struct {
	Plan                 string `json:"plan"`
	Status               string `json:"status"`
	Seats                *int   `json:"seats"`
	StripeSubscriptionID string `json:"stripe_subscription_id"`
	TrialEndsAt          string `json:"trial_ends_at"`
	CurrentPeriodEnd     string `json:"current_period_end"`
}

// Usage is the active org's current usage counters.
type Usage struct {
	SeatsUsed        int `json:"seats_used"`
	SeatsCap         int `json:"seats_cap"`
	RunnerMinutes    int `json:"runner_minutes"`
	Projects         int `json:"projects"`
	AICreditsUsed    int `json:"ai_credits_used"`
	AICreditsGranted int `json:"ai_credits_granted"`
}

// FleetPool is one managed warm pool (one per provider). Channel/Version are empty when
// unset (a pinned version and a release channel are mutually exclusive).
type FleetPool struct {
	Provider       string   `json:"provider"`
	WarmMin        int      `json:"warm_min"`
	Max            int      `json:"max"`
	SlotsPerRunner int      `json:"slots_per_runner"`
	Locations      []string `json:"locations"`
	Surge          int      `json:"surge"`
	Buffer         int      `json:"buffer"`
	Channel        string   `json:"channel"`
	Version        string   `json:"version"`
	Enabled        bool     `json:"enabled"`
}

// FleetPoolUpdate is the payload for SetFleetPool. Only set fields are sent (the rest keep
// their stored value); Enabled is a pointer so "leave unchanged" is distinct from "disable".
type FleetPoolUpdate struct {
	WarmMin        *int
	Max            *int
	SlotsPerRunner *int
	Enabled        *bool
	Channel        *string
	Version        *string
}

// GetBilling returns the active org's billing state.
func (c *Client) GetBilling() (*Billing, error) {
	endpoint := fmt.Sprintf("%s/cli/billing", c.baseURL)
	var successResp struct {
		Billing *Billing `json:"billing"`
	}
	if err := c.doGet(endpoint, &successResp); err != nil {
		return nil, fmt.Errorf("failed to get billing: %w", err)
	}
	return successResp.Billing, nil
}

// GetUsage returns the active org's current usage counters.
func (c *Client) GetUsage() (*Usage, error) {
	endpoint := fmt.Sprintf("%s/cli/usage", c.baseURL)
	var successResp struct {
		Usage *Usage `json:"usage"`
	}
	if err := c.doGet(endpoint, &successResp); err != nil {
		return nil, fmt.Errorf("failed to get usage: %w", err)
	}
	return successResp.Usage, nil
}

// ListFleetPools returns the managed fleet's warm pools (empty on hosted deployments).
func (c *Client) ListFleetPools() ([]FleetPool, error) {
	endpoint := fmt.Sprintf("%s/cli/fleet", c.baseURL)
	var successResp struct {
		Pools []FleetPool `json:"pools"`
	}
	if err := c.doGet(endpoint, &successResp); err != nil {
		return nil, fmt.Errorf("failed to list fleet pools: %w", err)
	}
	return successResp.Pools, nil
}

// SetFleetPool updates the warm pool for a provider. Only the non-nil fields of the update
// are sent, so unspecified config keeps its stored value.
func (c *Client) SetFleetPool(provider string, update FleetPoolUpdate) (*FleetPool, error) {
	endpoint := fmt.Sprintf("%s/cli/fleet/%s", c.baseURL, url.PathEscape(provider))
	payload := map[string]interface{}{}
	if update.WarmMin != nil {
		payload["warm_min"] = *update.WarmMin
	}
	if update.Max != nil {
		payload["max"] = *update.Max
	}
	if update.SlotsPerRunner != nil {
		payload["slots_per_runner"] = *update.SlotsPerRunner
	}
	if update.Enabled != nil {
		payload["enabled"] = *update.Enabled
	}
	if update.Channel != nil {
		payload["channel"] = *update.Channel
	}
	if update.Version != nil {
		payload["version"] = *update.Version
	}
	var successResp struct {
		Pool *FleetPool `json:"pool"`
	}
	if err := c.doPut(endpoint, payload, &successResp); err != nil {
		return nil, fmt.Errorf("failed to update fleet pool: %w", err)
	}
	return successResp.Pool, nil
}

// --- Project authoring: projects, environments, components ---
//
// These mirror the wire contract in apps/console/lib/validations/cli-contract.ts
// (projectWire, environmentWire, componentWire). They ADD write (authoring) verbs on
// top of the read-only configurations endpoints: create a project, manage its
// environments, and CRUD its component resources. The project is addressed by id OR
// name; everything is scoped to the active org and PDP-gated. Components share ONE
// struct across all kinds — the kind-specific fields live in the open Config map.

// Project is a project as returned by project authoring (create). CloudIdentityID is nil
// when the project has no cloud account linked; EstimatedMonthlyCost is nil until costed.
type Project struct {
	ID                   string    `json:"id"`
	ProjectName          string    `json:"project_name"`
	Slug                 string    `json:"slug"`
	Region               string    `json:"region"`
	IacVersion           string    `json:"iac_version"`
	CloudIdentityID      *string   `json:"cloud_identity_id"`
	CloudProvider        string    `json:"cloud_provider"`
	EnvironmentStage     string    `json:"environment_stage"`
	Status               string    `json:"status"`
	EstimatedMonthlyCost *float64  `json:"estimated_monthly_cost"`
	CreatedAt            time.Time `json:"created_at"`
	UpdatedAt            time.Time `json:"updated_at"`
}

// Environment is one of a project's deployment targets. Region is nil when it inherits
// the project's region; IsDefault marks the project's anchor environment.
type Environment struct {
	ID        string  `json:"id"`
	Name      string  `json:"name"`
	Stage     string  `json:"stage"`
	Status    string  `json:"status"`
	IsDefault bool    `json:"is_default"`
	Region    *string `json:"region"`
	// PlacementMode is the isolation rung — dedicated / vcluster / namespace. Namespace and
	// Fabric are pointers because a dedicated environment has no destination namespace, and a
	// Fabric may not exist yet.
	PlacementMode string  `json:"placement_mode"`
	Namespace     *string `json:"namespace"`
	Fabric        *string `json:"fabric"`
}

// Component is one project component, uniform across every kind. Config holds the
// kind-specific columns (shapes vary by kind), so a single struct decodes them all.
// CloudIdentityID is nil when the component inherits the project's primary identity.
type Component struct {
	ID              string                 `json:"id"`
	Kind            string                 `json:"kind"`
	Name            string                 `json:"name"`
	Status          string                 `json:"status"`
	CloudIdentityID *string                `json:"cloud_identity_id"`
	Config          map[string]interface{} `json:"config"`
}

// CreateProjectParams is the payload for CreateProject. CloudIdentityID/Stage are
// optional (the server defaults the stage to "development" and leaves the project
// unlinked when no identity is given).
type CreateProjectParams struct {
	ProjectName     string
	Region          string
	CloudIdentityID string
	Stage           string
	IacVersion      string
	// Placement of the default environment onto its first Fabric. Empty ⇒ the server's default
	// (`dedicated`, which is right for a first environment: it owns the Fabric it provisions).
	Placement string
	// The full environment MATRIX. When set, the server fans it out into a Fabric per `dedicated`
	// environment plus ONE shared Fabric for the `namespace`/`vcluster` ones — which is the difference
	// between a two-tier project costing two clusters and costing one.
	Environments []EnvironmentSpec
}

// EnvironmentSpec is one row of the environment matrix: an environment and how it is PLACED onto a
// Fabric. Mirrors the console placement selector's own shape, and the server validates it with the
// console form's own schema, so the CLI cannot express a matrix the front door would reject.
type EnvironmentSpec struct {
	Name          string `json:"name"`
	Stage         string `json:"stage"`
	PlacementMode string `json:"placement_mode"`
	// Optional: the ArgoCD destination namespace for a shared placement. Empty ⇒ derived from Name.
	Namespace string `json:"namespace,omitempty"`
	// Optional: `persistent` (default) or `ephemeral`.
	Lifecycle string `json:"lifecycle,omitempty"`
	IsDefault bool   `json:"is_default,omitempty"`
}

// CreateProject creates a new project and returns it.
func (c *Client) CreateProject(params CreateProjectParams) (*Project, error) {
	endpoint := fmt.Sprintf("%s/cli/projects", c.baseURL)
	payload := map[string]interface{}{
		"project_name": params.ProjectName,
		"region":       params.Region,
	}
	if params.CloudIdentityID != "" {
		payload["cloud_identity_id"] = params.CloudIdentityID
	}
	if params.Stage != "" {
		payload["stage"] = params.Stage
	}
	if params.IacVersion != "" {
		payload["iac_version"] = params.IacVersion
	}
	if params.Placement != "" {
		payload["placement_mode"] = params.Placement
	}
	if len(params.Environments) > 0 {
		payload["environments"] = params.Environments
	}
	var successResp struct {
		Project *Project `json:"project"`
	}
	if err := c.doPost(endpoint, payload, &successResp); err != nil {
		return nil, fmt.Errorf("failed to create project: %w", err)
	}
	return successResp.Project, nil
}

// ListEnvironments returns a project's environments (default first).
func (c *Client) ListEnvironments(project string) ([]Environment, error) {
	return AllPages(func(cursor string) ([]Environment, PageInfo, error) {
		page, err := c.getProjectEnvironmentsPage(project, cursor)
		if err != nil {
			return nil, PageInfo{}, err
		}
		return page.Environments, page.Page, nil
	})
}

func (c *Client) getProjectEnvironmentsPage(project, cursor string) (*struct {
	Environments []Environment `json:"environments"`
	Page         PageInfo      `json:"page"`
}, error) {
	endpoint := fmt.Sprintf("%s/cli/projects/%s/environments", c.baseURL, url.PathEscape(project))
	params := url.Values{}
	PageOpts{Cursor: cursor}.Apply(params)
	if len(params) > 0 {
		endpoint = fmt.Sprintf("%s?%s", endpoint, params.Encode())
	}
	var page struct {
		Environments []Environment `json:"environments"`
		Page         PageInfo      `json:"page"`
	}
	if err := c.doGet(endpoint, &page); err != nil {
		return nil, fmt.Errorf("failed to list environments: %w", err)
	}
	return &page, nil
}

// AddEnvironmentParams is the payload for AddEnvironment. A struct rather than positional arguments
// because placement turned this into seven fields, and seven bare strings at a call site is where a
// stage silently ends up in the region.
type AddEnvironmentParams struct {
	Project string
	Name    string
	Stage   string
	Region  string
	// Placement onto a Fabric. Empty ⇒ the server's default for an ADDED environment, `namespace` —
	// the cheap rung. Passing `dedicated` is what buys a whole new cluster, and it should be the word
	// you typed rather than the one you got.
	Placement string
	// The Fabric to place onto, by name. Empty ⇒ the Fabric the project's default environment is on.
	// Ignored for `dedicated`, which owns a new Fabric.
	Fabric string
	// ArgoCD destination namespace for a shared placement. Empty ⇒ derived from Name.
	Namespace string
	// `persistent` (default) or `ephemeral`.
	Lifecycle string
}

// AddEnvironment adds an environment to a project. An empty region inherits the project's.
func (c *Client) AddEnvironment(params AddEnvironmentParams) (*Environment, error) {
	endpoint := fmt.Sprintf("%s/cli/projects/%s/environments", c.baseURL, url.PathEscape(params.Project))
	payload := map[string]interface{}{"name": params.Name}
	if params.Stage != "" {
		payload["stage"] = params.Stage
	}
	if params.Region != "" {
		payload["region"] = params.Region
	}
	if params.Placement != "" {
		payload["placement_mode"] = params.Placement
	}
	if params.Fabric != "" {
		payload["fabric"] = params.Fabric
	}
	if params.Namespace != "" {
		payload["namespace"] = params.Namespace
	}
	if params.Lifecycle != "" {
		payload["lifecycle"] = params.Lifecycle
	}
	var successResp struct {
		Environment *Environment `json:"environment"`
	}
	if err := c.doPost(endpoint, payload, &successResp); err != nil {
		return nil, fmt.Errorf("failed to add environment: %w", err)
	}
	return successResp.Environment, nil
}

// ListComponents returns every component in a project. An empty kind/env lists all of them;
// otherwise the listing is filtered server-side. The signature stays source-compatible while
// the implementation walks the server's cursor pages to exhaustion.
func (c *Client) ListComponents(project, kind, env string) ([]Component, error) {
	return AllPages(func(cursor string) ([]Component, PageInfo, error) {
		page, err := c.getProjectComponentsPage(project, kind, env, cursor)
		if err != nil {
			return nil, PageInfo{}, err
		}
		return page.Components, page.Page, nil
	})
}

// getProjectComponentsPage fetches one server page while preserving the component filters on
// every cursor request. A server predating component paging omits Page, whose zero value naturally
// describes one exhausted response to AllPages.
func (c *Client) getProjectComponentsPage(project, kind, env, cursor string) (*struct {
	Components []Component `json:"components"`
	Page       PageInfo    `json:"page"`
}, error) {
	endpoint := fmt.Sprintf("%s/cli/projects/%s/components", c.baseURL, url.PathEscape(project))
	params := url.Values{}
	if kind != "" {
		params.Set("kind", kind)
	}
	if env != "" {
		params.Set("env", env)
	}
	PageOpts{Cursor: cursor}.Apply(params)
	if len(params) > 0 {
		endpoint = fmt.Sprintf("%s?%s", endpoint, params.Encode())
	}
	var successResp struct {
		Components []Component `json:"components"`
		Page       PageInfo    `json:"page"`
	}
	if err := c.doGet(endpoint, &successResp); err != nil {
		return nil, fmt.Errorf("failed to list components: %w", err)
	}
	return &successResp, nil
}

// AddComponent creates a component of `kind` on a project. `name` is ignored for singleton
// kinds; `fields` are validated server-side against the kind's drizzle-zod insert schema.
func (c *Client) AddComponent(project, kind, name, env string, fields map[string]interface{}) (*Component, error) {
	endpoint := withEnvParam(fmt.Sprintf("%s/cli/projects/%s/components/%s", c.baseURL, url.PathEscape(project), url.PathEscape(kind)), env)
	if fields == nil {
		fields = map[string]interface{}{}
	}
	payload := map[string]interface{}{"fields": fields}
	if name != "" {
		payload["name"] = name
	}
	var successResp struct {
		Component *Component `json:"component"`
	}
	if err := c.doPost(endpoint, payload, &successResp); err != nil {
		return nil, fmt.Errorf("failed to add component: %w", err)
	}
	return successResp.Component, nil
}

// RemoveComponent deletes a component of `kind` from a project. `name` is ignored for
// singleton kinds (which have at most one row per project).
func (c *Client) RemoveComponent(project, kind, name, env string) error {
	endpoint := fmt.Sprintf("%s/cli/projects/%s/components/%s", c.baseURL, url.PathEscape(project), url.PathEscape(kind))
	if name != "" {
		endpoint = fmt.Sprintf("%s/%s", endpoint, url.PathEscape(name))
	}
	if err := c.doDelete(withEnvParam(endpoint, env)); err != nil {
		return fmt.Errorf("failed to remove component: %w", err)
	}
	return nil
}

// withEnvParam appends `?env=<env>` when env is non-empty, leaving the URL untouched otherwise so a
// caller that names no environment keeps hitting the server's default-environment path byte for byte.
// url.Values.Encode escapes the value, so an environment name is safe to pass through verbatim.
func withEnvParam(endpoint, env string) string {
	if strings.TrimSpace(env) == "" {
		return endpoint
	}
	params := url.Values{}
	params.Set("env", env)
	return fmt.Sprintf("%s?%s", endpoint, params.Encode())
}

// DesignChange is one component the apply created, updated or deleted — or, on a dry run, would.
type DesignChange struct {
	Kind   string  `json:"kind"`
	Name   *string `json:"name"`
	Action string  `json:"action"`
}

// DesignApplyResult reports what an apply DID. Mode is an enum rather than two booleans so a caller
// cannot read a plan as an apply: "dry-run" wrote nothing, "staged" went to the review tray, "applied"
// went live.
type DesignApplyResult struct {
	OK      bool           `json:"ok"`
	Mode    string         `json:"mode"`
	Changes []DesignChange `json:"changes"`
}

// ApplyDesignParams is the payload for ApplyDesign. Document is the whole design document, passed
// through verbatim — the server validates it with the console form's own schema, so the CLI does not
// need to know its shape and cannot drift from it.
type ApplyDesignParams struct {
	Project  string
	Env      string
	Document json.RawMessage
	DryRun   bool
	Stage    bool
}

// ApplyDesign applies (or plans, or stages) a whole environment design document.
func (c *Client) ApplyDesign(p ApplyDesignParams) (*DesignApplyResult, error) {
	endpoint := withEnvParam(fmt.Sprintf("%s/cli/projects/%s/design", c.baseURL, url.PathEscape(p.Project)), p.Env)
	sep := "?"
	if strings.Contains(endpoint, "?") {
		sep = "&"
	}
	if p.DryRun {
		endpoint += sep + "dry_run=1"
		sep = "&"
	}
	if p.Stage {
		endpoint += sep + "stage=1"
	}
	var resp DesignApplyResult
	if err := c.doPost(endpoint, p.Document, &resp); err != nil {
		return nil, fmt.Errorf("failed to apply design: %w", err)
	}
	return &resp, nil
}

// --- Drift ---

// DriftDetail is a single drifted resource in a DriftPosture (mirrors the console DriftDetail).
type DriftDetail struct {
	Address string `json:"address"`
	Type    string `json:"type"`
	Kind    string `json:"kind"`
}

// DriftPosture is the latest day-2 drift posture of a project environment
// (GET /api/cli/projects/:id/drift). Evaluated is false when no DETECT_DRIFT job has run yet —
// an honest "not proven" rather than a false in-sync.
type DriftPosture struct {
	Evaluated   bool          `json:"evaluated"`
	InSync      bool          `json:"in_sync"`
	Drifted     int           `json:"drifted"`
	ScannedAt   *string       `json:"scanned_at"`
	Environment *string       `json:"environment"`
	Details     []DriftDetail `json:"details"`
}

// GetProjectDrift returns the latest drift posture for a project, optionally scoped to one
// environment (by name, stage, or id).
func (c *Client) GetProjectDrift(project, env string) (*DriftPosture, error) {
	endpoint := fmt.Sprintf("%s/cli/projects/%s/drift", c.baseURL, url.PathEscape(project))
	if env != "" {
		endpoint = fmt.Sprintf("%s?env=%s", endpoint, url.QueryEscape(env))
	}
	var resp DriftPosture
	if err := c.doGet(endpoint, &resp); err != nil {
		return nil, fmt.Errorf("failed to get drift: %w", err)
	}
	return &resp, nil
}

// --- Cost ---

// CostResourceLine is one priced resource in an EnvironmentCost (mirrors CostResourceLine).
type CostResourceLine struct {
	Address      string  `json:"address"`
	ResourceType string  `json:"resource_type"`
	MonthlyCost  float64 `json:"monthly_cost"`
}

// EnvironmentCost is the latest priced picture of a project environment
// (GET /api/cli/projects/:id/cost). Priced is false when no plan has ever priced it.
type EnvironmentCost struct {
	Priced       bool               `json:"priced"`
	TotalMonthly *float64           `json:"total_monthly"`
	Currency     string             `json:"currency"`
	CapturedAt   *string            `json:"captured_at"`
	PlanJobID    *string            `json:"plan_job_id"`
	Environment  *string            `json:"environment"`
	Resources    []CostResourceLine `json:"resources"`
}

// GetEnvironmentCost returns the latest cost for a project environment (the default environment
// when env is empty; otherwise the environment addressed by name, stage, or id).
func (c *Client) GetEnvironmentCost(project, env string) (*EnvironmentCost, error) {
	endpoint := fmt.Sprintf("%s/cli/projects/%s/cost", c.baseURL, url.PathEscape(project))
	if env != "" {
		endpoint = fmt.Sprintf("%s?env=%s", endpoint, url.QueryEscape(env))
	}
	var resp EnvironmentCost
	if err := c.doGet(endpoint, &resp); err != nil {
		return nil, fmt.Errorf("failed to get cost: %w", err)
	}
	return &resp, nil
}

// --- Protection ---

// ProtectionRule is one environment's promotion protection gates (mirrors ProtectionSummary).
type ProtectionRule struct {
	EnvironmentID      string   `json:"environment_id"`
	Environment        string   `json:"environment"`
	RequirePredecessor bool     `json:"require_predecessor"`
	RequireVerifyPass  bool     `json:"require_verify_pass"`
	RequireApproval    bool     `json:"require_approval"`
	MinCount           *int     `json:"min_count"`
	SoakMinutes        *int     `json:"soak_minutes"`
	CostDeltaThreshold *float64 `json:"cost_delta_threshold"`
}

// GetProjectProtection returns each environment's promotion protection rules for a project.
func (c *Client) GetProjectProtection(project string) ([]ProtectionRule, error) {
	endpoint := fmt.Sprintf("%s/cli/projects/%s/protection", c.baseURL, url.PathEscape(project))
	var resp struct {
		Rules []ProtectionRule `json:"rules"`
	}
	if err := c.doGet(endpoint, &resp); err != nil {
		return nil, fmt.Errorf("failed to get protection rules: %w", err)
	}
	return resp.Rules, nil
}

// --- Probes ---

// ProbeState is one environment's latest cluster-alive probe (mirrors the console ProbeState).
// Reachable is nil when the environment has never been probed.
type ProbeState struct {
	EnvironmentID string  `json:"environment_id"`
	Environment   string  `json:"environment"`
	Reachable     *bool   `json:"reachable"`
	Message       *string `json:"message"`
	ProbedAt      *string `json:"probed_at"`
}

// GetProjectProbes returns each environment's latest cluster-alive probe state for a project.
func (c *Client) GetProjectProbes(project string) ([]ProbeState, error) {
	endpoint := fmt.Sprintf("%s/cli/projects/%s/probes", c.baseURL, url.PathEscape(project))
	var resp struct {
		Probes []ProbeState `json:"probes"`
	}
	if err := c.doGet(endpoint, &resp); err != nil {
		return nil, fmt.Errorf("failed to get probes: %w", err)
	}
	return resp.Probes, nil
}

// --- Add-ons ---

// Addon is one installed catalog add-on in an environment.
type Addon struct {
	AddonID      string  `json:"addon_id"`
	Enabled      bool    `json:"enabled"`
	Mode         string  `json:"mode"`
	Version      *string `json:"version"`
	Namespace    *string `json:"namespace"`
	Status       string  `json:"status"`
	Health       *string `json:"health"`
	Sync         *string `json:"sync"`
	LastSyncedAt *string `json:"last_synced_at"`
}

// ProjectAddons is the installed catalog add-ons for one environment.
type ProjectAddons struct {
	Environment string  `json:"environment"`
	Addons      []Addon `json:"addons"`
}

type ProjectAddonsPage struct {
	Environment string   `json:"environment"`
	Addons      []Addon  `json:"addons"`
	Page        PageInfo `json:"page"`
}

// GetProjectAddons returns the catalog add-ons installed in a project environment (the default
// environment when env is empty; otherwise the environment addressed by name, stage, or id).
func (c *Client) GetProjectAddons(project, env string) (*ProjectAddons, error) {
	var out *ProjectAddons
	_, err := AllPages(func(cursor string) ([]Addon, PageInfo, error) {
		page, err := c.getProjectAddonsPage(project, env, cursor)
		if err != nil {
			return nil, PageInfo{}, err
		}
		if out == nil {
			out = &ProjectAddons{Environment: page.Environment}
		}
		out.Addons = append(out.Addons, page.Addons...)
		return page.Addons, page.Page, nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

func (c *Client) getProjectAddonsPage(project, env, cursor string) (*ProjectAddonsPage, error) {
	endpoint := withEnvParam(
		fmt.Sprintf("%s/cli/projects/%s/addons", c.baseURL, url.PathEscape(project)),
		env,
	)
	params := url.Values{}
	PageOpts{Cursor: cursor}.Apply(params)
	if len(params) > 0 {
		sep := "?"
		if strings.Contains(endpoint, "?") {
			sep = "&"
		}
		endpoint = fmt.Sprintf("%s%s%s", endpoint, sep, params.Encode())
	}
	var page ProjectAddonsPage
	if err := c.doGet(endpoint, &page); err != nil {
		return nil, fmt.Errorf("failed to get add-ons: %w", err)
	}
	return &page, nil
}

// EnableAddonParams is the payload for EnableAddon. Values is the add-on's own knob map, validated
// server-side by that add-on's configSchema — the definition that owns them — rather than by a
// second schema in the CLI that would drift from the catalog.
type EnableAddonParams struct {
	Project    string
	Env        string
	AddonID    string
	Mode       string
	Values     map[string]interface{}
	ValuesYAML string
}

// EnableAddon enables (or reconfigures) a catalog add-on in an environment. An empty Env targets the
// project's default environment.
func (c *Client) EnableAddon(p EnableAddonParams) error {
	endpoint := withEnvParam(fmt.Sprintf("%s/cli/projects/%s/addons", c.baseURL, url.PathEscape(p.Project)), p.Env)
	payload := map[string]interface{}{"addon_id": p.AddonID}
	if p.Mode != "" {
		payload["mode"] = p.Mode
	}
	if len(p.Values) > 0 {
		payload["values"] = p.Values
	}
	if p.ValuesYAML != "" {
		payload["values_yaml"] = p.ValuesYAML
	}
	var resp struct {
		OK bool `json:"ok"`
	}
	if err := c.doPost(endpoint, payload, &resp); err != nil {
		return fmt.Errorf("failed to enable add-on: %w", err)
	}
	return nil
}

// DisableAddon disables a catalog add-on in an environment.
func (c *Client) DisableAddon(project, env, addonID string) error {
	endpoint := withEnvParam(fmt.Sprintf("%s/cli/projects/%s/addons", c.baseURL, url.PathEscape(project)), env)
	if err := c.doDeleteWithBody(endpoint, map[string]interface{}{"addon_id": addonID}); err != nil {
		return fmt.Errorf("failed to disable add-on: %w", err)
	}
	return nil
}

// --- BYO charts ---

// AttachChartParams is the payload for AttachChart. Field validity — the repo-URL shape, the
// git-chart-needs-a-path rule, the YAML-mapping check — is decided server-side by the same schema the
// console form uses, so this struct carries the values and makes no rules of its own.
type AttachChartParams struct {
	Project    string
	Env        string
	ID         string
	RepoURL    string
	ChartPath  string
	Ref        string
	Namespace  string
	ValuesYAML string
	GitCredID  string
	Values     map[string]interface{}
}

// ByoAttachResult is the resolved id of an attached chart or IaC source. Returned because the server
// SLUGIFIES what you send, and a caller that wants to scan or detach it afterwards needs the id the
// server actually stored rather than the one it guessed.
type ByoAttachResult struct {
	OK bool   `json:"ok"`
	ID string `json:"id"`
}

// ByoScanResult is a queued scan job. The id is what makes the scan followable with
// `alethia jobs logs -f` — a scan is asynchronous, and a bare ok would leave a script polling blind.
type ByoScanResult struct {
	OK    bool   `json:"ok"`
	JobID string `json:"job_id"`
}

// AttachChart attaches (or updates) a BYO Helm chart in an environment.
func (c *Client) AttachChart(p AttachChartParams) (*ByoAttachResult, error) {
	endpoint := withEnvParam(fmt.Sprintf("%s/cli/projects/%s/byo-charts", c.baseURL, url.PathEscape(p.Project)), p.Env)
	payload := map[string]interface{}{"id": p.ID, "repo_url": p.RepoURL}
	for k, v := range map[string]string{
		"chart_path":        p.ChartPath,
		"ref":               p.Ref,
		"namespace":         p.Namespace,
		"values_yaml":       p.ValuesYAML,
		"git_credential_id": p.GitCredID,
	} {
		if v != "" {
			payload[k] = v
		}
	}
	if len(p.Values) > 0 {
		payload["values"] = p.Values
	}
	var resp ByoAttachResult
	if err := c.doPost(endpoint, payload, &resp); err != nil {
		return nil, fmt.Errorf("failed to attach chart: %w", err)
	}
	return &resp, nil
}

// DetachChart removes a BYO Helm chart from an environment.
func (c *Client) DetachChart(project, env, id string) error {
	endpoint := withEnvParam(fmt.Sprintf("%s/cli/projects/%s/byo-charts", c.baseURL, url.PathEscape(project)), env)
	if err := c.doDeleteWithBody(endpoint, map[string]interface{}{"id": id}); err != nil {
		return fmt.Errorf("failed to detach chart: %w", err)
	}
	return nil
}

// ScanChart queues a scan of an attached BYO Helm chart and returns the job to follow.
func (c *Client) ScanChart(project, env, id string) (*ByoScanResult, error) {
	endpoint := withEnvParam(fmt.Sprintf("%s/cli/projects/%s/byo-charts/scan", c.baseURL, url.PathEscape(project)), env)
	var resp ByoScanResult
	if err := c.doPost(endpoint, map[string]interface{}{"id": id}, &resp); err != nil {
		return nil, fmt.Errorf("failed to scan chart: %w", err)
	}
	return &resp, nil
}

// AttachIacParams is the payload for AttachIac. VarValues is scalar-only (string/number/bool) — the
// server refuses a nested object or an array, because tfvars are not a place for structure and never
// a place for secrets.
type AttachIacParams struct {
	Project   string
	Env       string
	RepoURL   string
	Ref       string
	Path      string
	GitCredID string
	VarValues map[string]interface{}
}

// AttachIac attaches the environment's BYO Terraform/OpenTofu source.
func (c *Client) AttachIac(p AttachIacParams) (*ByoAttachResult, error) {
	endpoint := withEnvParam(fmt.Sprintf("%s/cli/projects/%s/byo-iac", c.baseURL, url.PathEscape(p.Project)), p.Env)
	payload := map[string]interface{}{"repo_url": p.RepoURL}
	for k, v := range map[string]string{
		"ref":               p.Ref,
		"path":              p.Path,
		"git_credential_id": p.GitCredID,
	} {
		if v != "" {
			payload[k] = v
		}
	}
	if len(p.VarValues) > 0 {
		payload["var_values"] = p.VarValues
	}
	var resp ByoAttachResult
	if err := c.doPost(endpoint, payload, &resp); err != nil {
		return nil, fmt.Errorf("failed to attach IaC source: %w", err)
	}
	return &resp, nil
}

// DetachIac removes the environment's BYO IaC source. The environment is the whole address — it holds
// at most one source — so there is nothing else to identify.
func (c *Client) DetachIac(project, env string) error {
	endpoint := withEnvParam(fmt.Sprintf("%s/cli/projects/%s/byo-iac", c.baseURL, url.PathEscape(project)), env)
	if err := c.doDelete(endpoint); err != nil {
		return fmt.Errorf("failed to detach IaC source: %w", err)
	}
	return nil
}

// ScanIac queues a scan of the environment's BYO IaC source and returns the job to follow.
func (c *Client) ScanIac(project, env string) (*ByoScanResult, error) {
	endpoint := withEnvParam(fmt.Sprintf("%s/cli/projects/%s/byo-iac/scan", c.baseURL, url.PathEscape(project)), env)
	var resp ByoScanResult
	if err := c.doPost(endpoint, map[string]interface{}{}, &resp); err != nil {
		return nil, fmt.Errorf("failed to scan IaC source: %w", err)
	}
	return &resp, nil
}

// ByoChart is one attached BYO Helm chart in an environment (scan status only, not the report).
type ByoChart struct {
	ID         string  `json:"id"`
	RepoURL    string  `json:"repo_url"`
	ChartPath  string  `json:"chart_path"`
	Ref        string  `json:"ref"`
	Namespace  string  `json:"namespace"`
	Status     string  `json:"status"`
	Health     *string `json:"health"`
	Sync       *string `json:"sync"`
	ScanStatus string  `json:"scan_status"`
	ScannedAt  *string `json:"scanned_at"`
}

// ProjectByoCharts is the BYO Helm charts attached to one environment.
type ProjectByoCharts struct {
	Environment string     `json:"environment"`
	Charts      []ByoChart `json:"charts"`
}

type ProjectByoChartsPage struct {
	Environment string     `json:"environment"`
	Charts      []ByoChart `json:"charts"`
	Page        PageInfo   `json:"page"`
}

// GetProjectByoCharts returns the BYO Helm charts attached to a project environment.
func (c *Client) GetProjectByoCharts(project, env string) (*ProjectByoCharts, error) {
	var out *ProjectByoCharts
	_, err := AllPages(func(cursor string) ([]ByoChart, PageInfo, error) {
		page, err := c.getProjectByoChartsPage(project, env, cursor)
		if err != nil {
			return nil, PageInfo{}, err
		}
		if out == nil {
			out = &ProjectByoCharts{Environment: page.Environment}
		}
		out.Charts = append(out.Charts, page.Charts...)
		return page.Charts, page.Page, nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

func (c *Client) getProjectByoChartsPage(project, env, cursor string) (*ProjectByoChartsPage, error) {
	endpoint := withEnvParam(
		fmt.Sprintf("%s/cli/projects/%s/byo-charts", c.baseURL, url.PathEscape(project)),
		env,
	)
	params := url.Values{}
	PageOpts{Cursor: cursor}.Apply(params)
	if len(params) > 0 {
		sep := "?"
		if strings.Contains(endpoint, "?") {
			sep = "&"
		}
		endpoint = fmt.Sprintf("%s%s%s", endpoint, sep, params.Encode())
	}
	var page ProjectByoChartsPage
	if err := c.doGet(endpoint, &page); err != nil {
		return nil, fmt.Errorf("failed to get BYO charts: %w", err)
	}
	return &page, nil
}

// --- BYO IaC ---

// IacSource is the customer's BYO Terraform/OpenTofu source attached to an environment (scan
// status only, not the report).
type IacSource struct {
	ID                string  `json:"id"`
	Environment       string  `json:"environment"`
	Name              string  `json:"name"`
	RepoURL           string  `json:"repo_url"`
	Ref               *string `json:"ref"`
	Path              string  `json:"path"`
	CommitSha         *string `json:"commit_sha"`
	DeployedCommitSha *string `json:"deployed_commit_sha"`
	Enabled           bool    `json:"enabled"`
	ScanStatus        string  `json:"scan_status"`
	ScannedAt         *string `json:"scanned_at"`
	Status            string  `json:"status"`
	StatusMessage     *string `json:"status_message"`
}

// GetProjectIacSource returns the BYO IaC source attached to a project environment, or nil when
// none is attached.
func (c *Client) GetProjectIacSource(project, env string) (*IacSource, error) {
	endpoint := fmt.Sprintf("%s/cli/projects/%s/byo-iac", c.baseURL, url.PathEscape(project))
	if env != "" {
		endpoint = fmt.Sprintf("%s?env=%s", endpoint, url.QueryEscape(env))
	}
	var resp struct {
		Source *IacSource `json:"source"`
	}
	if err := c.doGet(endpoint, &resp); err != nil {
		return nil, fmt.Errorf("failed to get IaC source: %w", err)
	}
	return resp.Source, nil
}

// --- Promotions ---

// Promotion is one environment promotion (source → target), as listed.
type Promotion struct {
	ID           string  `json:"id"`
	Source       string  `json:"source"`
	Target       string  `json:"target"`
	Status       string  `json:"status"`
	ErrorMessage *string `json:"error_message"`
	CreatedAt    string  `json:"created_at"`
	CompletedAt  *string `json:"completed_at"`
}

// GetProjectPromotions returns a project's promotions, optionally scoped to one target
// environment (by name, stage, or id).
func (c *Client) GetProjectPromotions(project, env string) ([]Promotion, error) {
	return AllPages(func(cursor string) ([]Promotion, PageInfo, error) {
		page, err := c.getProjectPromotionsPage(project, env, cursor)
		if err != nil {
			return nil, PageInfo{}, err
		}
		return page.Promotions, page.Page, nil
	})
}

func (c *Client) getProjectPromotionsPage(project, env, cursor string) (*struct {
	Promotions []Promotion `json:"promotions"`
	Page       PageInfo    `json:"page"`
}, error) {
	endpoint := withEnvParam(
		fmt.Sprintf("%s/cli/projects/%s/promotions", c.baseURL, url.PathEscape(project)),
		env,
	)
	params := url.Values{}
	PageOpts{Cursor: cursor}.Apply(params)
	if len(params) > 0 {
		sep := "?"
		if strings.Contains(endpoint, "?") {
			sep = "&"
		}
		endpoint = fmt.Sprintf("%s%s%s", endpoint, sep, params.Encode())
	}
	var page struct {
		Promotions []Promotion `json:"promotions"`
		Page       PageInfo    `json:"page"`
	}
	if err := c.doGet(endpoint, &page); err != nil {
		return nil, fmt.Errorf("failed to get promotions: %w", err)
	}
	return &page, nil
}

// PromotionApproval is one approval slot on a promotion.
type PromotionApproval struct {
	ID           string  `json:"id"`
	Status       string  `json:"status"`
	Name         *string `json:"name"`
	RequiredRole *string `json:"required_role"`
	Comment      *string `json:"comment"`
	DecidedAt    *string `json:"decided_at"`
}

// PromotionDetail is a promotion with its approval slots (gate detail + config diff are
// console-only).
type PromotionDetail struct {
	ID           string              `json:"id"`
	Source       string              `json:"source"`
	Target       string              `json:"target"`
	Status       string              `json:"status"`
	Initiator    *string             `json:"initiator"`
	ErrorMessage *string             `json:"error_message"`
	Approved     int                 `json:"approved"`
	Required     int                 `json:"required"`
	Approvals    []PromotionApproval `json:"approvals"`
	CreatedAt    string              `json:"created_at"`
	CompletedAt  *string             `json:"completed_at"`
}

// GetPromotion returns one promotion (scoped to the project) with its approval slots.
func (c *Client) GetPromotion(project, promotionID string) (*PromotionDetail, error) {
	endpoint := fmt.Sprintf(
		"%s/cli/projects/%s/promotions/%s",
		c.baseURL, url.PathEscape(project), url.PathEscape(promotionID),
	)
	var resp struct {
		Promotion PromotionDetail `json:"promotion"`
	}
	if err := c.doGet(endpoint, &resp); err != nil {
		return nil, fmt.Errorf("failed to get promotion: %w", err)
	}
	return &resp.Promotion, nil
}

// --- Staged changes ---

// StagedChange is one pending canvas change on an environment.
type StagedChange struct {
	ComponentType string  `json:"component_type"`
	Op            string  `json:"op"`
	ComponentID   *string `json:"component_id"`
	CreatedAt     string  `json:"created_at"`
}

// StagedChanges is an environment's durable staged (pending) canvas changes.
type StagedChanges struct {
	Environment string         `json:"environment"`
	Changes     []StagedChange `json:"changes"`
}

type StagedChangesPage struct {
	Environment string         `json:"environment"`
	Changes     []StagedChange `json:"changes"`
	Page        PageInfo       `json:"page"`
}

// GetProjectStagedChanges returns an environment's staged changes (the default environment when
// env is empty; otherwise the environment addressed by name, stage, or id).
func (c *Client) GetProjectStagedChanges(project, env string) (*StagedChanges, error) {
	var out *StagedChanges
	_, err := AllPages(func(cursor string) ([]StagedChange, PageInfo, error) {
		page, err := c.getProjectStagedChangesPage(project, env, cursor)
		if err != nil {
			return nil, PageInfo{}, err
		}
		if out == nil {
			out = &StagedChanges{Environment: page.Environment}
		}
		out.Changes = append(out.Changes, page.Changes...)
		return page.Changes, page.Page, nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

func (c *Client) getProjectStagedChangesPage(project, env, cursor string) (*StagedChangesPage, error) {
	endpoint := withEnvParam(
		fmt.Sprintf("%s/cli/projects/%s/staged", c.baseURL, url.PathEscape(project)),
		env,
	)
	params := url.Values{}
	PageOpts{Cursor: cursor}.Apply(params)
	if len(params) > 0 {
		sep := "?"
		if strings.Contains(endpoint, "?") {
			sep = "&"
		}
		endpoint = fmt.Sprintf("%s%s%s", endpoint, sep, params.Encode())
	}
	var page StagedChangesPage
	if err := c.doGet(endpoint, &page); err != nil {
		return nil, fmt.Errorf("failed to get staged changes: %w", err)
	}
	return &page, nil
}

// --- Cloud inventory ---

// CloudNetwork is one discovered network in a cloud identity's inventory.
type CloudNetwork struct {
	NativeID  string  `json:"native_id"`
	Name      *string `json:"name"`
	Region    *string `json:"region"`
	Provider  string  `json:"provider"`
	CidrBlock *string `json:"cidr_block"`
	IsDefault bool    `json:"is_default"`
}

// CloudSubnet is one discovered subnet in a cloud identity's inventory.
type CloudSubnet struct {
	NativeID         string  `json:"native_id"`
	Name             *string `json:"name"`
	Region           *string `json:"region"`
	AvailabilityZone *string `json:"availability_zone"`
	CidrBlock        *string `json:"cidr_block"`
	IsPublic         bool    `json:"is_public"`
}

// CloudInventory is the discovered networking + regions for a cloud identity.
type CloudInventory struct {
	Networks []CloudNetwork `json:"networks"`
	Subnets  []CloudSubnet  `json:"subnets"`
	Regions  []string       `json:"regions"`
}

// GetCloudInventory returns the discovered networking inventory for a connected cloud identity.
func (c *Client) GetCloudInventory(cloudIdentityID string) (*CloudInventory, error) {
	endpoint := fmt.Sprintf("%s/cli/cloud-identities/%s/inventory", c.baseURL, url.PathEscape(cloudIdentityID))
	var resp CloudInventory
	if err := c.doGet(endpoint, &resp); err != nil {
		return nil, fmt.Errorf("failed to get cloud inventory: %w", err)
	}
	return &resp, nil
}

// --- Org settings ---

// OrgSettings is the active organization's general settings.
type OrgSettings struct {
	Name             string  `json:"name"`
	Slug             string  `json:"slug"`
	Description      string  `json:"description"`
	Logo             *string `json:"logo"`
	Region           string  `json:"region"`
	DefaultEnv       string  `json:"default_env"`
	TerraformVersion string  `json:"terraform_version"`
}

// GetOrgSettings returns the active org's general settings, or nil in community (personal) mode.
func (c *Client) GetOrgSettings() (*OrgSettings, error) {
	endpoint := fmt.Sprintf("%s/cli/org-settings", c.baseURL)
	var resp struct {
		Settings *OrgSettings `json:"settings"`
	}
	if err := c.doGet(endpoint, &resp); err != nil {
		return nil, fmt.Errorf("failed to get org settings: %w", err)
	}
	return resp.Settings, nil
}

// --- Agents ---

// Agent is a machine/agent identity (persona) the caller owns.
type Agent struct {
	ID              string   `json:"id"`
	Persona         string   `json:"persona"`
	Mission         string   `json:"mission"`
	ToolScope       []string `json:"tool_scope"`
	MemoryNamespace string   `json:"memory_namespace"`
	ProjectID       *string  `json:"project_id"`
	Version         int      `json:"version"`
	CreatedAt       string   `json:"created_at"`
	UpdatedAt       string   `json:"updated_at"`
}

// ListAgents returns the caller's agent identities.
func (c *Client) ListAgents() ([]Agent, error) {
	endpoint := fmt.Sprintf("%s/cli/agents", c.baseURL)
	var resp struct {
		Agents []Agent `json:"agents"`
	}
	if err := c.doGet(endpoint, &resp); err != nil {
		return nil, fmt.Errorf("failed to list agents: %w", err)
	}
	return resp.Agents, nil
}

// GetAgent returns one agent identity by id, scoped to the caller's tenancy.
func (c *Client) GetAgent(id string) (*Agent, error) {
	endpoint := fmt.Sprintf("%s/cli/agents/%s", c.baseURL, url.PathEscape(id))
	var resp struct {
		Agent Agent `json:"agent"`
	}
	if err := c.doGet(endpoint, &resp); err != nil {
		return nil, fmt.Errorf("failed to get agent: %w", err)
	}
	return &resp.Agent, nil
}

// --- Break-glass (privileged incident recovery) ---
//
// These hit the audited /api/breakglass/* endpoints behind the ALETHIA_BREAKGLASS_ENABLED +
// BREAKGLASS_OPERATORS gate, using the SAME bearer token as the rest of the CLI. The endpoints are
// cross-tenant and RLS-bypassing, so they do NOT go through the /api/cli namespace — the operator
// allowlist (not org membership) is the wall.

// BreakglassActionInput is the small, explicit per-action input the backend records + validates.
type BreakglassActionInput struct {
	ExpectedFrom   []string `json:"expectedFrom,omitempty"`
	To             string   `json:"to,omitempty"`
	StateKey       string   `json:"stateKey,omitempty"`
	FleetReason    string   `json:"fleetReason,omitempty"`
	ProjectID      string   `json:"projectId,omitempty"`
	EnvironmentID  string   `json:"environmentId,omitempty"`
	SurgeryNote    string   `json:"surgeryNote,omitempty"`
	SuppressEmails *bool    `json:"suppressEmails,omitempty"`
}

// BreakglassSession is a newly-opened time-boxed operator session.
type BreakglassSession struct {
	SessionID string `json:"sessionId"`
	ExpiresAt string `json:"expiresAt"`
	Operator  string `json:"operator"`
}

// BreakglassApproval is a minted two-person approval token.
type BreakglassApproval struct {
	ApprovalID string `json:"approvalId"`
	Action     string `json:"action"`
	ResourceID string `json:"resourceId"`
	ExpiresAt  string `json:"expiresAt"`
	Approver   string `json:"approver"`
	Note       string `json:"note"`
}

// BreakglassResult is the outcome of an executed break-glass action.
type BreakglassResult struct {
	OK     bool            `json:"ok"`
	Detail string          `json:"detail"`
	Data   json.RawMessage `json:"data"`
}

// BreakglassExecuteParams is the body for POST /api/breakglass/execute.
type BreakglassExecuteParams struct {
	SessionID  string                 `json:"sessionId"`
	Action     string                 `json:"action"`
	ResourceID string                 `json:"resourceId,omitempty"`
	Confirm    string                 `json:"confirm,omitempty"`
	Reason     string                 `json:"reason"`
	ApprovalID string                 `json:"approvalId,omitempty"`
	Input      *BreakglassActionInput `json:"input,omitempty"`
}

// OpenBreakglassSession opens a time-boxed break-glass session.
func (c *Client) OpenBreakglassSession(reason string) (*BreakglassSession, error) {
	endpoint := fmt.Sprintf("%s/breakglass/session", c.baseURL)
	var out BreakglassSession
	if err := c.doPost(endpoint, map[string]string{"reason": reason}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// MintBreakglassApproval mints a two-person approval token (called by the SECOND operator).
func (c *Client) MintBreakglassApproval(action, resourceID, reason string, input *BreakglassActionInput) (*BreakglassApproval, error) {
	endpoint := fmt.Sprintf("%s/breakglass/approval", c.baseURL)
	payload := map[string]interface{}{"action": action, "resourceId": resourceID, "reason": reason}
	if input != nil {
		payload["input"] = input
	}
	var out BreakglassApproval
	if err := c.doPost(endpoint, payload, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// ExecuteBreakglass runs one audited break-glass action.
func (c *Client) ExecuteBreakglass(params BreakglassExecuteParams) (*BreakglassResult, error) {
	endpoint := fmt.Sprintf("%s/breakglass/execute", c.baseURL)
	var out BreakglassResult
	if err := c.doPost(endpoint, params, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// ── CLI service-account tokens (non-interactive authentication) ──

// ServiceToken is one token as the console reports it. There is deliberately NO field for the
// token value: the plaintext exists once, in the CreateServiceToken response, and nothing on the
// server can read it back. A field here would imply otherwise.
type ServiceToken struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	TokenPrefix string  `json:"token_prefix"`
	CreatedAt   string  `json:"created_at"`
	ExpiresAt   *string `json:"expires_at"`
	LastUsedAt  *string `json:"last_used_at"`
	RevokedAt   *string `json:"revoked_at"`
}

// CreatedServiceToken is the mint response — the ONLY time Token carries a value.
type CreatedServiceToken struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	TokenPrefix string  `json:"token_prefix"`
	ExpiresAt   *string `json:"expires_at"`
	Token       string  `json:"token"`
	Warning     string  `json:"warning"`
}

// ListServiceTokens returns the active org's service-account tokens, revoked ones included — a
// revoked token that vanishes from the list takes its audit trail with it.
func (c *Client) ListServiceTokens() ([]ServiceToken, error) {
	endpoint := fmt.Sprintf("%s/cli/tokens", c.baseURL)
	var successResp struct {
		Tokens []ServiceToken `json:"tokens"`
	}
	if err := c.doGet(endpoint, &successResp); err != nil {
		return nil, fmt.Errorf("failed to list service tokens: %w", err)
	}
	return successResp.Tokens, nil
}

// CreateServiceToken mints one. The caller MUST surface the returned Token immediately; it is not
// stored and cannot be retrieved again.
func (c *Client) CreateServiceToken(name string, expiresInDays int) (*CreatedServiceToken, error) {
	endpoint := fmt.Sprintf("%s/cli/tokens", c.baseURL)
	payload := map[string]interface{}{"name": name}
	if expiresInDays > 0 {
		payload["expires_in_days"] = expiresInDays
	}
	var created CreatedServiceToken
	if err := c.doPost(endpoint, payload, &created); err != nil {
		return nil, fmt.Errorf("failed to create service token: %w", err)
	}
	return &created, nil
}

// RevokeServiceToken revokes one by id. It takes effect on the very next request the token makes.
func (c *Client) RevokeServiceToken(id string) error {
	endpoint := fmt.Sprintf("%s/cli/tokens/%s", c.baseURL, url.PathEscape(id))
	if err := c.doDelete(endpoint); err != nil {
		return fmt.Errorf("failed to revoke service token: %w", err)
	}
	return nil
}
