package terraform

import (
	"archive/zip"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"text/template"

	"github.com/bobikenobi12/bb-thesis-2026/apps/cli/types"
	"github.com/bobikenobi12/bb-thesis-2026/apps/cli/utils"
)

// TF_CLI represents the Terraform CLI wrapper.
type TF_CLI struct {
	Version    string
	binaryPath string
}

// NewTF_CLI creates a new Terraform CLI wrapper.
func NewTF_CLI(version string) (*TF_CLI, error) {
	cli := &TF_CLI{
		Version: version,
	}
	err := cli.ensureBinary()
	if err != nil {
		return nil, err
	}
	return cli, nil
}

// Init runs the terraform init command.
func (t *TF_CLI) Init(dir string, backendConfig string, updateInfra bool) error {
	fmt.Println("Initializing Terraform...")
	upgradeFlag := ""
	if updateInfra {
		upgradeFlag = " -upgrade"
	}

	cmd := fmt.Sprintf("%s init -reconfigure %s%s", t.binaryPath, backendConfig, upgradeFlag)
	return utils.ExecuteCommand(cmd, dir, []string{})
}

// Plan runs the terraform plan command.
func (t *TF_CLI) Plan(dir string, varFile string, planOutputFile string) error {
	fmt.Println("Running Terraform plan...")
	cmd := fmt.Sprintf("%s plan -var-file=%s -out=%s", t.binaryPath, varFile, planOutputFile)
	return utils.ExecuteCommand(cmd, dir, []string{})
}

// Apply runs the terraform apply command with a plan file.
func (t *TF_CLI) Apply(dir string, planFile string) error {
	fmt.Println("Applying Terraform plan...")
	cmd := fmt.Sprintf("%s apply -auto-approve %s", t.binaryPath, planFile)
	return utils.ExecuteCommand(cmd, dir, []string{})
}

// Destroy runs the terraform destroy command.
func (t *TF_CLI) Destroy(dir string, varFile string) error {
	fmt.Println("Running Terraform destroy...")
	cmd := fmt.Sprintf("%s destroy -auto-approve", t.binaryPath)
	if varFile != "" {
		cmd += fmt.Sprintf(" -var-file=%s", varFile)
	}
	return utils.ExecuteCommand(cmd, dir, []string{})
}

// Output retrieves Terraform outputs.
func (t *TF_CLI) Output(dir string, outputName string) (map[string]interface{}, error) {
	fmt.Println("Getting Terraform outputs...")
	cmd := fmt.Sprintf("%s output -json", t.binaryPath)
	rawOutput, err := utils.ExecuteCommandWithOutput(cmd, dir, []string{})
	if err != nil {
		return nil, fmt.Errorf("failed to get terraform output: %w", err)
	}

	var rawOutputs map[string]struct {
		Value interface{} `json:"value"`
	}
	if err := json.Unmarshal([]byte(rawOutput), &rawOutputs); err != nil {
		return nil, fmt.Errorf("failed to parse terraform output: %w", err)
	}

	outputs := make(map[string]interface{})
	for k, v := range rawOutputs {
		outputs[k] = v.Value
	}

	if outputName != "" {
		if val, ok := outputs[outputName]; ok {
			return map[string]interface{}{outputName: val}, nil
		}
		return nil, fmt.Errorf("output '%s' not found", outputName)
	}

	return outputs, nil
}

// GenerateBackendConfig creates a backend config string.
func (t *TF_CLI) GenerateBackendConfig(config *types.Configuration) (string, error) {
	bucketName := fmt.Sprintf("%s-%s-%s-idp-state", config.ProjectName, config.EnvironmentStage, config.AwsRegion)
	key := fmt.Sprintf("%s-%s-%s-terraform.tfstate", config.ProjectName, config.EnvironmentStage, config.AwsRegion)

	backendConfigArgs := []string{
		fmt.Sprintf("-backend-config=\"bucket=%s\"", bucketName),
		fmt.Sprintf("-backend-config=\"key=%s\"", key),
		fmt.Sprintf("-backend-config=\"region=%s\"", config.AwsRegion),
	}

	return strings.Join(backendConfigArgs, " "), nil
}

// OverrideTfvars creates the terraform.tfvars file.
func (t *TF_CLI) OverrideTfvars(dir string, config *types.Configuration) (string, error) {
	tfvarsPath := filepath.Join(dir, "terraform.tfvars")

	tmpl, err := template.New("tfvars").Parse(`
project_name = "{{.ProjectName}}"
region = "{{.AwsRegion}}"
environment = "{{.EnvironmentStage}}"
aws_account_id = "{{.AwsAccountID}}"
`)
	if err != nil {
		return "", fmt.Errorf("failed to parse tfvars template: %w", err)
	}

	f, err := os.Create(tfvarsPath)
	if err != nil {
		return "", fmt.Errorf("failed to create tfvars file: %w", err)
	}
	defer f.Close()

	err = tmpl.Execute(f, config)
	if err != nil {
		return "", fmt.Errorf("failed to execute tfvars template: %w", err)
	}

	return tfvarsPath, nil
}

func (t *TF_CLI) ensureBinary() error {
	// 1. Check if terraform is in the system PATH
	if path, err := exec.LookPath("terraform"); err == nil {
		// Found system terraform.
		t.binaryPath = path
		return nil
	}

	// 2. Fallback: Managed version in ~/.grape/bin
	home, err := os.UserHomeDir()
	if err != nil {
		return fmt.Errorf("failed to get home directory: %w", err)
	}

	binDir := filepath.Join(home, ".grape", "bin")
	t.binaryPath = filepath.Join(binDir, fmt.Sprintf("terraform_%s", t.Version))
	
	if _, err := os.Stat(t.binaryPath); err == nil {
		return nil
	}

	if err := os.MkdirAll(binDir, 0755); err != nil {
		return fmt.Errorf("failed to create managed bin directory: %w", err)
	}

	return t.download(binDir)
}

func (t *TF_CLI) download(binDir string) error {
	arch := runtime.GOARCH
	goos := runtime.GOOS

	url := fmt.Sprintf("https://releases.hashicorp.com/terraform/%s/terraform_%s_%s_%s.zip", t.Version, t.Version, goos, arch)
	fmt.Printf("Downloading Terraform v%s for %s/%s...\n", t.Version, goos, arch)

	resp, err := http.Get(url)
	if err != nil {
		return fmt.Errorf("failed to download terraform: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("failed to download terraform: status code %d", resp.StatusCode)
	}

	zipPath := filepath.Join(binDir, fmt.Sprintf("terraform_%s.zip", t.Version))
	out, err := os.Create(zipPath)
	if err != nil {
		return fmt.Errorf("failed to create zip file: %w", err)
	}
	defer out.Close()

	_, err = io.Copy(out, resp.Body)
	if err != nil {
		return fmt.Errorf("failed to write zip file: %w", err)
	}

	// Unzip
	r, err := zip.OpenReader(zipPath)
	if err != nil {
		return fmt.Errorf("failed to open zip file: %w", err)
	}
	defer r.Close()

	for _, f := range r.File {
		if f.Name == "terraform" {
			rc, err := f.Open()
			if err != nil {
				return fmt.Errorf("failed to open terraform binary in zip: %w", err)
			}
			defer rc.Close()

			// Create a temporary file
			tmpFile, err := os.CreateTemp(binDir, "terraform-")
			if err != nil {
				return fmt.Errorf("failed to create temporary file for terraform binary: %w", err)
			}

			_, err = io.Copy(tmpFile, rc)
			if err != nil {
				tmpFile.Close()
				return fmt.Errorf("failed to write terraform binary: %w", err)
			}
			tmpFile.Close()

			// Rename the temporary file to the final destination
			if err := os.Rename(tmpFile.Name(), t.binaryPath); err != nil {
				return fmt.Errorf("failed to rename terraform binary: %w", err)
			}

			break
		}
	}

	// Make executable
	if err := os.Chmod(t.binaryPath, 0755); err != nil {
		return fmt.Errorf("failed to make terraform binary executable: %w", err)
	}

	// Clean up zip file
	if err := os.Remove(zipPath); err != nil {
		fmt.Printf("Warning: failed to remove zip file %s: %v\n", zipPath, err)
	}

	fmt.Println("Terraform downloaded successfully.")
	return nil
}