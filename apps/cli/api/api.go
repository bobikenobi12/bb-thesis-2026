package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/bobikenobi12/bb-thesis-2026/apps/cli/types"
)

// Client represents the API client.
type Client struct {
	baseURL    string
	authToken  string
	httpClient *http.Client
}

// NewClient creates a new API client.
func NewClient(authToken string) *Client {
	webOrigin := os.Getenv("GRAPE_WEB_ORIGIN")
	if webOrigin == "" {
		webOrigin = "https://localhost:3000" // Default to localhost for development
	}
	return &Client{
		baseURL:    fmt.Sprintf("%s/api", webOrigin),
		authToken:  authToken,
		httpClient: &http.Client{},
	}
}

// Repository represents the structure of a repository for the API.
type Repository struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	FullName      string `json:"full_name"`
	URL           string `json:"url"`
	Private       bool   `json:"private"`
	DefaultBranch string `json:"default_branch"`
	Provider      string `json:"provider"`
}

// Deployment represents the structure of a deployment for the API.
type Deployment struct {
	ID               string    `json:"id"`
	ConfigurationID  string    `json:"configuration_id"`
	Name             string    `json:"name"`
	Status           string    `json:"status"`
	IacTool          string    `json:"iac_tool"`
	TerraformVersion string    `json:"terraform_version,omitempty"`
	CreatedAt        time.Time `json:"created_at"`
}

// LogEntry represents the structure of a log entry for the API.
type LogEntry struct {
	Message string `json:"message"`
	Level   string `json:"level"`
	Step    string `json:"step,omitempty"`
}

// CreateRepository creates a new repository.
func (c *Client) CreateRepository(provider, name, workspace, projectKey string) (*Repository, error) {
	if provider != "github" && provider != "gitlab" && provider != "bitbucket" {
		return nil, fmt.Errorf("unsupported git provider: %s", provider)
	}

	endpoint := fmt.Sprintf("%s/repositories/%s", c.baseURL, provider)
	payload := map[string]string{
		"name": name,
	}

	if provider == "bitbucket" {
		payload["workspace"] = workspace
		payload["projectKey"] = projectKey
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal request body: %w", err)
	}

	req, err := http.NewRequest("POST", endpoint, bytes.NewBuffer(body))
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", fmt.Sprintf("Bearer %s", c.authToken))

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to send request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusCreated {
		var errorResp struct {
			Error string `json:"error"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&errorResp); err != nil {
			return nil, fmt.Errorf("failed to create repository: status code %d", resp.StatusCode)
		}
		return nil, fmt.Errorf("failed to create repository: %s", errorResp.Error)
	}

	var successResp struct {
		Repository *Repository `json:"repository"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&successResp); err != nil {
		return nil, fmt.Errorf("failed to decode successful response: %w", err)
	}

	return successResp.Repository, nil
}

// GetRepositories fetches repositories for a given provider.
func (c *Client) GetRepositories(provider string) ([]Repository, error) {
	endpoint := fmt.Sprintf("%s/cli/repositories/%s", c.baseURL, provider)
	req, err := http.NewRequest("GET", endpoint, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Authorization", fmt.Sprintf("Bearer %s", c.authToken))

	// Attempt to get provider token if available
	if providerToken := c.getProviderToken(); providerToken != "" {
		req.Header.Set("X-Provider-Token", providerToken)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to send request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		var errorResp struct {
			Error string `json:"error"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&errorResp); err != nil {
			return nil, fmt.Errorf("failed to get repositories: status code %d", resp.StatusCode)
		}
		return nil, fmt.Errorf("failed to get repositories: %s", errorResp.Error)
	}

	var successResp struct {
		Repositories []Repository `json:"repositories"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&successResp); err != nil {
		return nil, fmt.Errorf("failed to decode successful response: %w", err)
	}

	return successResp.Repositories, nil
}

func (c *Client) getProviderToken() string {
	configDir, err := os.UserConfigDir()
	if err != nil {
		return ""
	}
	credsPath := filepath.Join(configDir, "grape", "credentials.json")
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

// GetConfiguration fetches a configuration by project name.
func (c *Client) GetConfiguration(projectName string) (*types.Configuration, error) {
	endpoint := fmt.Sprintf("%s/cli/configurations/by-project-name/%s", c.baseURL, projectName)
	req, err := http.NewRequest("GET", endpoint, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Authorization", fmt.Sprintf("Bearer %s", c.authToken))

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to send request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		var errorResp struct {
			Error string `json:"error"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&errorResp); err != nil {
			return nil, fmt.Errorf("failed to get configuration: status code %d", resp.StatusCode)
		}
		return nil, fmt.Errorf("failed to get configuration: %s", errorResp.Error)
	}

	var successResp struct {
		Configuration *types.Configuration `json:"configuration"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&successResp); err != nil {
		return nil, fmt.Errorf("failed to decode successful response: %w", err)
	}

	return successResp.Configuration, nil
}

// CreateConfiguration creates a new configuration.
func (c *Client) CreateConfiguration(config types.Configuration) (*types.Configuration, error) {
	endpoint := fmt.Sprintf("%s/configurations", c.baseURL)
	body, err := json.Marshal(config)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal request body: %w", err)
	}

	req, err := http.NewRequest("POST", endpoint, bytes.NewBuffer(body))
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", fmt.Sprintf("Bearer %s", c.authToken))

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to send request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusCreated {
		var errorResp struct {
			Error string `json:"error"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&errorResp); err != nil {
			return nil, fmt.Errorf("failed to create configuration: status code %d", resp.StatusCode)
		}
		return nil, fmt.Errorf("failed to create configuration: %s", errorResp.Error)
	}

	var successResp struct {
		Configuration *types.Configuration `json:"configuration"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&successResp); err != nil {
		return nil, fmt.Errorf("failed to decode successful response: %w", err)
	}

	return successResp.Configuration, nil
}

// CreateDeployment creates a new deployment record.
func (c *Client) CreateDeployment(configID, name, iacTool, tfVersion string) (*Deployment, error) {
	endpoint := fmt.Sprintf("%s/deployments", c.baseURL)
	payload := map[string]string{
		"configuration_id":  configID,
		"name":              name,
		"iac_tool":          iacTool,
		"terraform_version": tfVersion,
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal request body: %w", err)
	}

	req, err := http.NewRequest("POST", endpoint, bytes.NewBuffer(body))
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", fmt.Sprintf("Bearer %s", c.authToken))

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to send request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusCreated {
		var errorResp struct {
			Error string `json:"error"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&errorResp); err != nil {
			return nil, fmt.Errorf("failed to create deployment: status code %d", resp.StatusCode)
		}
		return nil, fmt.Errorf("failed to create deployment: %s", errorResp.Error)
	}

	var successResp struct {
		Deployment *Deployment `json:"deployment"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&successResp); err != nil {
		return nil, fmt.Errorf("failed to decode successful response: %w", err)
	}

	return successResp.Deployment, nil
}

// UpdateDeploymentStatus updates the status of a deployment.
func (c *Client) UpdateDeploymentStatus(deploymentID, status, errorMessage string) error {
	endpoint := fmt.Sprintf("%s/deployments/%s", c.baseURL, deploymentID)
	payload := map[string]string{
		"status": status,
	}
	if errorMessage != "" {
		payload["error_message"] = errorMessage
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("failed to marshal request body: %w", err)
	}

	req, err := http.NewRequest("PUT", endpoint, bytes.NewBuffer(body))
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", fmt.Sprintf("Bearer %s", c.authToken))

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("failed to send request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		var errorResp struct {
			Error string `json:"error"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&errorResp); err != nil {
			return fmt.Errorf("failed to update deployment status: status code %d", resp.StatusCode)
		}
		return fmt.Errorf("failed to update deployment status: %s", errorResp.Error)
	}

	return nil
}

// Cluster represents a cluster.
type Cluster struct {
	ID            string                 `json:"id"`
	Name          string                 `json:"name"`
	Status        string                 `json:"status"`
	LastHeartbeat time.Time              `json:"last_heartbeat"`
	CreatedAt     time.Time              `json:"created_at"`
	Metadata      map[string]interface{} `json:"metadata"`
}

// GetClusters fetches the list of clusters.
func (c *Client) GetClusters() ([]Cluster, error) {
	endpoint := fmt.Sprintf("%s/cli/clusters", c.baseURL)
	req, err := http.NewRequest("GET", endpoint, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Authorization", fmt.Sprintf("Bearer %s", c.authToken))

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to send request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		var errorResp struct {
			Error string `json:"error"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&errorResp); err != nil {
			return nil, fmt.Errorf("failed to get clusters: status code %d", resp.StatusCode)
		}
		return nil, fmt.Errorf("failed to get clusters: %s", errorResp.Error)
	}

	var successResp struct {
		Clusters []Cluster `json:"clusters"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&successResp); err != nil {
		return nil, fmt.Errorf("failed to decode successful response: %w", err)
	}

	return successResp.Clusters, nil
}

// ClusterRegistrationResponse represents the response from registering a cluster.
type ClusterRegistrationResponse struct {
	ClusterID  string `json:"cluster_id"`
	AgentToken string `json:"agent_token"`
}

// RegisterCluster registers a new cluster.
func (c *Client) RegisterCluster(name, vpcID, vpcCidr, region string) (*ClusterRegistrationResponse, error) {
	endpoint := fmt.Sprintf("%s/cli/clusters", c.baseURL)
	payload := map[string]string{
		"name":     name,
		"vpc_id":   vpcID,
		"vpc_cidr": vpcCidr,
		"region":   region,
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal request body: %w", err)
	}

	req, err := http.NewRequest("POST", endpoint, bytes.NewBuffer(body))
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", fmt.Sprintf("Bearer %s", c.authToken))

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to send request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusOK {
		var errorResp struct {
			Error string `json:"error"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&errorResp); err != nil {
			return nil, fmt.Errorf("failed to register cluster: status code %d", resp.StatusCode)
		}
		return nil, fmt.Errorf("failed to register cluster: %s", errorResp.Error)
	}

	var successResp ClusterRegistrationResponse
	if err := json.NewDecoder(resp.Body).Decode(&successResp); err != nil {
		return nil, fmt.Errorf("failed to decode successful response: %w", err)
	}

	return &successResp, nil
}

// SendLog sends a log entry to the server.
func (c *Client) SendLog(deploymentID string, log LogEntry) error {
	endpoint := fmt.Sprintf("%s/deployments/%s/logs", c.baseURL, deploymentID)
	body, err := json.Marshal(log)
	if err != nil {
		return fmt.Errorf("failed to marshal log entry: %w", err)
	}

	req, err := http.NewRequest("POST", endpoint, bytes.NewBuffer(body))
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", fmt.Sprintf("Bearer %s", c.authToken))

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("failed to send log: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusCreated {
		return fmt.Errorf("failed to send log: status code %d", resp.StatusCode)
	}

	return nil
}

