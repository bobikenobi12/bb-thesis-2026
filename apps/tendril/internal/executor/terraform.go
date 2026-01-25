package executor

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"

	"github.com/bobikenobi12/bb-thesis-2026/apps/tendril/internal/logger"
	"github.com/bobikenobi12/bb-thesis-2026/apps/tendril/internal/types"
	"github.com/supabase-community/supabase-go"
)

type TerraformExecutor struct {
	ProvisionID string
	Config      json.RawMessage
	ConfigHash  string
	Client      *supabase.Client
}

type configWrapper struct {
	TemplateSource struct {
		Repo    string `json:"repo"`
		Version string `json:"version"`
	} `json:"template_source"`
	TerraformVars map[string]interface{} `json:"terraform_vars"`
}

func NewTerraformExecutor(provisionID string, config json.RawMessage, configHash string, client *supabase.Client) *TerraformExecutor {
	return &TerraformExecutor{
		ProvisionID: provisionID,
		Config:      config,
		ConfigHash:  configHash,
		Client:      client,
	}
}

func (e *TerraformExecutor) Execute() error {
	// 1. Security Check: Verify Integrity
	if e.ConfigHash != "" {
		hasher := sha256.New()
		hasher.Write(e.Config)
		calculatedHash := hex.EncodeToString(hasher.Sum(nil))
		
		if calculatedHash != e.ConfigHash {
			return fmt.Errorf("security violation: configuration hash mismatch. Expected %s, got %s", e.ConfigHash, calculatedHash)
		}
	}

	// 2. Parse Configuration
	var wrapper configWrapper
	if err := json.Unmarshal(e.Config, &wrapper); err != nil {
		return fmt.Errorf("failed to parse config snapshot: %w", err)
	}

	// 3. Prepare Workspace
	ws, err := NewWorkspace(e.ProvisionID)
	if err != nil {
		return err
	}
	defer ws.Cleanup()

	// 4. Setup Templates (Git Clone & Checkout)
	if err := ws.Setup(wrapper.TemplateSource.Repo, wrapper.TemplateSource.Version); err != nil {
		return err
	}

	// 5. Write Variables
	tfVarsJSON, err := json.MarshalIndent(wrapper.TerraformVars, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal tfvars: %w", err)
	}

	if err := ws.WriteTFVars(tfVarsJSON); err != nil {
		return err
	}

	workDir := ws.GetWorkingDir()

	// 6. Run Terraform Init
	if err := e.runCommand(workDir, "terraform", "init", "-no-color"); err != nil {
		return fmt.Errorf("terraform init failed: %w", err)
	}

	// 7. Run Terraform Apply
	if err := e.runCommand(workDir, "terraform", "apply", "-auto-approve", "-no-color"); err != nil {
		return fmt.Errorf("terraform apply failed: %w", err)
	}

	return nil
}

func (e *TerraformExecutor) runCommand(dir string, name string, args ...string) error {
	cmd := exec.Command(name, args...)
	cmd.Dir = dir

	// Setup Log Streamers
	stdoutStream := logger.NewLogStreamer(e.Client, e.ProvisionID, types.StreamStdout)
	defer stdoutStream.Close()
	
	stderrStream := logger.NewLogStreamer(e.Client, e.ProvisionID, types.StreamStderr)
	defer stderrStream.Close()

	cmd.Stdout = stdoutStream
	cmd.Stderr = stderrStream

	// Log command start
	startMsg := fmt.Sprintf("Running command: %s %s\n", name, strings.Join(args, " "))
	stdoutStream.Write([]byte(startMsg))

	if err := cmd.Run(); err != nil {
		// Log error
		errMsg := fmt.Sprintf("\nCommand failed: %v\n", err)
		stderrStream.Write([]byte(errMsg))
		return err
	}

	return nil
}
