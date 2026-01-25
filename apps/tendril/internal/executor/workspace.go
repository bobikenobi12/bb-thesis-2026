package executor

import (
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
)

type Workspace struct {
	ID      string
	BaseDir string
}

func NewWorkspace(provisionID string) (*Workspace, error) {
	// Create a temp directory for this provision job
	baseDir := filepath.Join(os.TempDir(), "tendril", provisionID)
	
	if err := os.MkdirAll(baseDir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create workspace directory: %w", err)
	}

	return &Workspace{
		ID:      provisionID,
		BaseDir: baseDir,
	}, nil
}

func (w *Workspace) Setup(repoURL string, version string) error {
	if repoURL == "" {
		return fmt.Errorf("template repository URL is required")
	}

	// 1. Clone the repository
	log.Printf("[%s] Cloning templates from %s...", w.ID, repoURL)
	
	// We clone into a 'templates' subdirectory
	templateDir := filepath.Join(w.BaseDir, "templates")
	
	cmd := exec.Command("git", "clone", repoURL, templateDir)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("git clone failed: %s: %w", string(output), err)
	}
	
	// 2. Checkout specific version if provided
	if version != "" {
		log.Printf("[%s] Checking out template version: %s", w.ID, version)
		checkoutCmd := exec.Command("git", "checkout", version)
		checkoutCmd.Dir = templateDir
		if out, err := checkoutCmd.CombinedOutput(); err != nil {
			return fmt.Errorf("git checkout failed: %s: %w", string(out), err)
		}
	} else {
		log.Printf("[%s] Warning: No version provided. Using default branch (latest).", w.ID)
	}
	
	log.Printf("[%s] Templates prepared successfully.", w.ID)
	return nil
}

func (w *Workspace) WriteTFVars(content []byte) error {
	filePath := filepath.Join(w.BaseDir, "templates", "terraform.tfvars.json")
	// We use .json so we can just dump the raw JSON from the DB without complex HCL conversion logic
	
	if err := os.WriteFile(filePath, content, 0644); err != nil {
		return fmt.Errorf("failed to write terraform.tfvars.json: %w", err)
	}
	
	return nil
}

func (w *Workspace) Cleanup() {
	if err := os.RemoveAll(w.BaseDir); err != nil {
		log.Printf("[%s] Warning: Failed to cleanup workspace: %v", w.ID, err)
	}
}

func (w *Workspace) GetWorkingDir() string {
	return filepath.Join(w.BaseDir, "templates")
}
