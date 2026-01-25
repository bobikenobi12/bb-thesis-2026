package infracost

import (
	"archive/tar"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/bobikenobi12/bb-thesis-2026/apps/cli/utils"
)

// InfracostCLI represents the Infracost CLI wrapper.
type InfracostCLI struct {
	Version    string
	binaryPath string
	apiKey     string
}

// NewInfracostCLI creates a new Infracost CLI wrapper.
func NewInfracostCLI(version string, apiKey string) *InfracostCLI {
	return &InfracostCLI{
		Version: version,
		apiKey:  apiKey,
	}
}

// CheckToken verifies if the Infracost API token is set.
func (i *InfracostCLI) CheckToken() bool {
	if i.apiKey == "" {
		fmt.Println("Warning: Infracost token not provided. Skipping cost estimation.")
		fmt.Println("To include Infracost, set the INFRACOST_API_KEY environment variable.")
		return false
	}
	return true
}

// ensureBinary checks if the Infracost binary exists and downloads it if not.
func (i *InfracostCLI) ensureBinary() error {
	binDir := "bin"
	absBinDir, err := filepath.Abs(binDir)
	if err != nil {
		return fmt.Errorf("failed to get absolute path for bin directory: %w", err)
	}

	i.binaryPath = filepath.Join(absBinDir, fmt.Sprintf("infracost_%s", i.Version))
	if _, err := os.Stat(i.binaryPath); err == nil {
		fmt.Printf("Infracost %s is already available.\n", i.Version)
		return nil
	}

	// Create bin directory if it doesn't exist
	if err := os.MkdirAll(absBinDir, 0755); err != nil {
		return fmt.Errorf("failed to create bin directory: %w", err)
	}

	return i.download(absBinDir)
}

func (i *InfracostCLI) download(binDir string) error {
	arch := runtime.GOARCH
	goos := runtime.GOOS

	downloadURL := fmt.Sprintf("https://github.com/infracost/infracost/releases/download/%s/infracost-%s-%s.tar.gz", i.Version, goos, arch)
	fmt.Printf("Downloading Infracost %s for %s-%s...\n", i.Version, goos, arch)

	resp, err := http.Get(downloadURL)
	if err != nil {
		return fmt.Errorf("failed to download infracost: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("failed to download infracost: status code %d", resp.StatusCode)
	}

	tarFile := filepath.Join(binDir, fmt.Sprintf("infracost_%s.tar.gz", i.Version))
	out, err := os.Create(tarFile)
	if err != nil {
		return fmt.Errorf("failed to create tar file: %w", err)
	}
	defer out.Close()

	_, err = io.Copy(out, resp.Body)
	if err != nil {
		return fmt.Errorf("failed to write tar file: %w", err)
	}

	// Extract the tar.gz file
	f, err := os.Open(tarFile)
	if err != nil {
		return fmt.Errorf("failed to open tar file: %w", err)
	}
	defer f.Close()

	gzReader, err := gzip.NewReader(f)
	if err != nil {
		return fmt.Errorf("failed to create gzip reader: %w", err)
	}
	defer gzReader.Close()

	tarReader := tar.NewReader(gzReader)

	for {
		header, err := tarReader.Next()
		if err == io.EOF {
			break // End of archive
		}
		if err != nil {
			return fmt.Errorf("failed to read tar header: %w", err)
		}

		if header.Typeflag == tar.TypeReg && strings.Contains(header.Name, "infracost") {
			outPath := filepath.Join(binDir, "infracost")
			outFile, err := os.Create(outPath)
			if err != nil {
				return fmt.Errorf("failed to create infracost binary: %w", err)
			}
			defer outFile.Close()

			_, err = io.Copy(outFile, tarReader)
			if err != nil {
				return fmt.Errorf("failed to write infracost binary: %w", err)
			}

			i.binaryPath = outPath // Update binaryPath to the extracted path
			break
		}
	}

	// Make executable
	if err := os.Chmod(i.binaryPath, 0755); err != nil {
		return fmt.Errorf("failed to make infracost binary executable: %w", err)
	}

	// Clean up tar.gz file
	if err := os.Remove(tarFile); err != nil {
		fmt.Printf("Warning: failed to remove tar.gz file %s: %v\n", tarFile, err)
	}

	fmt.Println("Infracost downloaded and extracted successfully.")
	return nil
}

// RunInfracost executes infracost breakdown and output commands.
func (i *InfracostCLI) RunInfracost(terraformPlanFile string, env []string) error {
	if !i.CheckToken() {
		return nil // Skip if token is not set
	}

	fmt.Println("Running Infracost cost estimation...")

	// Ensure binary is available
	if err := i.ensureBinary(); err != nil {
		return fmt.Errorf("failed to ensure infracost binary: %w", err)
	}

	// Define file paths for JSON and table output
	tempDir := "temp"
	if err := os.MkdirAll(tempDir, 0755); err != nil {
		return fmt.Errorf("failed to create temp directory: %w", err)
	}
	breakdownJSONPath := filepath.Join(tempDir, "infracost_breakdown.json")
	breakdownTablePath := filepath.Join(tempDir, "infracost_breakdown_table.txt")

	// Run Infracost breakdown command
	breakdownCmd := fmt.Sprintf("%s breakdown --path %s --format json --out-file %s", i.binaryPath, terraformPlanFile, breakdownJSONPath)
	err := utils.ExecuteCommand(breakdownCmd, ".", env) // Run in current dir
	if err != nil {
		fmt.Printf("Warning: Failed to run Infracost breakdown: %v\n", err)
		return nil // Don't exit, just warn and continue
	}

	// Convert JSON breakdown to a table format
	outputCmd := fmt.Sprintf("%s output --format table --path %s --out-file %s", i.binaryPath, breakdownJSONPath, breakdownTablePath)
	err = utils.ExecuteCommand(outputCmd, ".", env) // Run in current dir
	if err != nil {
		fmt.Printf("Warning: Failed to convert Infracost JSON to table format: %v\n", err)
		return nil // Don't exit, just warn and continue
	}

	// Load and log summary cost information from JSON breakdown
	func() {
		jsonFile, err := os.Open(breakdownJSONPath)
		if err != nil {
			fmt.Printf("Warning: Failed to open Infracost breakdown JSON file: %v\n", err)
			return
		}
		defer jsonFile.Close()

		byteValue, _ := io.ReadAll(jsonFile)
		var breakdownData map[string]interface{}
		if err := json.Unmarshal(byteValue, &breakdownData); err != nil {
			fmt.Printf("Warning: Failed to parse Infracost breakdown JSON: %v\n", err)
			return
		}

		totalMonthlyCost := "N/A"
		if cost, ok := breakdownData["totalMonthlyCost"]; ok {
			totalMonthlyCost = fmt.Sprintf("%.2f", cost)
		}

		diffTotalMonthlyCost := "N/A"
		if diff, ok := breakdownData["diffTotalMonthlyCost"]; ok {
			diffTotalMonthlyCost = fmt.Sprintf("%.2f", diff)
		}

		fmt.Printf("Cost Summary - Total Monthly Cost: $%s, Diff Monthly Cost: $%s\n", totalMonthlyCost, diffTotalMonthlyCost)
	}()

	fmt.Printf("For detailed cost breakdown, see the table format in %s\n", breakdownTablePath)
	return nil
}
