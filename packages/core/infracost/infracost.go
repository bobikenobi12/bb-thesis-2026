// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package infracost

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/utils"
)

// maxDownloadBytes bounds the Infracost release download so a stalled or oversized response can't
// exhaust memory (the tarball is ~20 MiB; 200 MiB is a generous ceiling).
const maxDownloadBytes = 200 << 20

const (
	// DefaultInfracostVersion is the Infracost CLI version the runtime fallback downloads when the
	// binary isn't already on PATH. Production bakes it into the runner image (Dockerfile.base's
	// ARG INFRACOST_VERSION) — this constant is the native/dev fallback and should match that ARG.
	//
	// SSOT: packages/core/compat/matrix.json → static_couplings[infracost].value. This const, the
	// Dockerfile ARG, and the matrix value must all agree; the compat couplings drift test asserts
	// it modulo a leading "v" — the matrix + ARG record bare "0.10.39", this const carries the "v"
	// (#1214).
	DefaultInfracostVersion = "v0.10.39"
	// InfracostVersionEnv overrides DefaultInfracostVersion (mirrors ALETHIA_IAC_VERSION for tofu).
	InfracostVersionEnv = "ALETHIA_INFRACOST_VERSION"
)

// ResolvedInfracostVersion returns ALETHIA_INFRACOST_VERSION when set, else DefaultInfracostVersion
// — a single config-driven source, never a hardcoded per-call literal.
func ResolvedInfracostVersion() string {
	if v := strings.TrimSpace(os.Getenv(InfracostVersionEnv)); v != "" {
		return v
	}
	return DefaultInfracostVersion
}

var (
	// httpGet carries a timeout so a stalled release download can never hang a provisioning job
	// forever (the default http.Get has no timeout). Overridden in tests.
	httpGet        = (&http.Client{Timeout: 5 * time.Minute}).Get
	executeCommand = utils.ExecuteCommand
	// binaryCacheDir is where the native/dev fallback caches the downloaded infracost binary. Rooted
	// in the OS temp dir (an absolute path), NOT the process cwd, so concurrent jobs that share a
	// working directory don't race the same "bin/" path (#952). Overridden in tests.
	binaryCacheDir = filepath.Join(os.TempDir(), "alethia-infracost")
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
	i.binaryPath = filepath.Join(binaryCacheDir, fmt.Sprintf("infracost_%s", i.Version))
	if _, err := os.Stat(i.binaryPath); err == nil {
		fmt.Printf("Infracost %s is already available.\n", i.Version)
		return nil
	}

	if err := os.MkdirAll(binaryCacheDir, 0755); err != nil {
		return fmt.Errorf("failed to create infracost cache directory: %w", err)
	}

	return i.download(binaryCacheDir)
}

func (i *InfracostCLI) download(binDir string) error {
	arch := runtime.GOARCH
	goos := runtime.GOOS

	downloadURL := fmt.Sprintf("https://github.com/infracost/infracost/releases/download/%s/infracost-%s-%s.tar.gz", i.Version, goos, arch)
	fmt.Printf("Downloading Infracost %s for %s-%s...\n", i.Version, goos, arch)

	tarBytes, err := fetchBounded(downloadURL, "infracost")
	if err != nil {
		return err
	}

	// Supply-chain: verify the published SHA256 before extracting + executing the binary. The runner
	// image bakes a checksum-verified copy; this guards the native/dev fallback download.
	if err := verifyInfracostChecksum(downloadURL, tarBytes); err != nil {
		return err
	}

	gzReader, err := gzip.NewReader(bytes.NewReader(tarBytes))
	if err != nil {
		return fmt.Errorf("failed to create gzip reader: %w", err)
	}
	defer gzReader.Close()

	tarReader := tar.NewReader(gzReader)
	// Extract to a unique temp file in the cache dir, then atomically rename into the versioned
	// path — so two jobs downloading at once never write the same file mid-flight (#952).
	dest := filepath.Join(binDir, fmt.Sprintf("infracost_%s", i.Version))
	tmpFile, err := os.CreateTemp(binDir, "infracost-dl-*")
	if err != nil {
		return fmt.Errorf("failed to create temp file for infracost binary: %w", err)
	}
	tmpName := tmpFile.Name()
	defer os.Remove(tmpName) // no-op once the rename below succeeds
	extracted := false
	for {
		header, err := tarReader.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			tmpFile.Close()
			return fmt.Errorf("failed to read tar header: %w", err)
		}
		if header.Typeflag == tar.TypeReg && strings.Contains(header.Name, "infracost") {
			if _, err := io.Copy(tmpFile, tarReader); err != nil {
				tmpFile.Close()
				return fmt.Errorf("failed to write infracost binary: %w", err)
			}
			extracted = true
			break
		}
	}
	tmpFile.Close()
	if !extracted {
		return fmt.Errorf("infracost binary not found in the downloaded archive")
	}

	if err := os.Chmod(tmpName, 0755); err != nil {
		return fmt.Errorf("failed to make infracost binary executable: %w", err)
	}
	if err := os.Rename(tmpName, dest); err != nil {
		return fmt.Errorf("failed to install infracost binary: %w", err)
	}
	i.binaryPath = dest

	fmt.Println("Infracost downloaded and verified successfully.")
	return nil
}

// fetchBounded GETs url and returns up to maxDownloadBytes of the body, erroring on a transport
// failure or a non-200 status.
func fetchBounded(url, what string) ([]byte, error) {
	resp, err := httpGet(url)
	if err != nil {
		return nil, fmt.Errorf("failed to download %s: %w", what, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("failed to download %s: status code %d", what, resp.StatusCode)
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, maxDownloadBytes))
	if err != nil {
		return nil, fmt.Errorf("failed to read %s: %w", what, err)
	}
	return b, nil
}

// verifyInfracostChecksum fetches the release's per-asset "<url>.sha256" and checks it against the
// downloaded tarball (Infracost publishes "infracost-<os>-<arch>.tar.gz.sha256" per asset).
func verifyInfracostChecksum(downloadURL string, tarBytes []byte) error {
	sumBytes, err := fetchBounded(downloadURL+".sha256", "infracost checksum")
	if err != nil {
		return err
	}
	fields := strings.Fields(string(sumBytes))
	if len(fields) == 0 {
		return fmt.Errorf("infracost checksum file was empty")
	}
	got := fmt.Sprintf("%x", sha256.Sum256(tarBytes))
	if !strings.EqualFold(fields[0], got) {
		return fmt.Errorf("infracost checksum mismatch: got %s, want %s", got, fields[0])
	}
	return nil
}

// RunInfracost executes infracost breakdown and returns structured cost data.
// Also writes the JSON and table files to temp/ for backward compatibility.
func (i *InfracostCLI) RunInfracost(planFile string, env []string) (*CostBreakdown, error) {
	if !i.CheckToken() {
		return nil, nil
	}

	fmt.Println("Running Infracost cost estimation...")

	if err := i.ensureBinary(); err != nil {
		return nil, fmt.Errorf("failed to ensure infracost binary: %w", err)
	}

	// A per-invocation temp dir (not the cwd-relative "temp"), so concurrent jobs sharing a working
	// directory can't clobber each other's breakdown output (#952).
	tempDir, err := os.MkdirTemp("", "alethia-infracost-*")
	if err != nil {
		return nil, fmt.Errorf("failed to create temp directory: %w", err)
	}
	defer os.RemoveAll(tempDir)
	breakdownJSONPath := filepath.Join(tempDir, "infracost_breakdown.json")

	// binaryPath, planFile and breakdownJSONPath are interpolated into a `bash -c` command string;
	// shell-quote each so a path containing shell metacharacters can't inject (command-injection
	// guard, #944). planFile is caller-supplied, so this is the value that matters most.
	breakdownCmd := fmt.Sprintf("%s breakdown --path %s --format json --out-file %s",
		utils.ShellQuote(i.binaryPath), utils.ShellQuote(planFile), utils.ShellQuote(breakdownJSONPath))
	if err := executeCommand(breakdownCmd, ".", env, nil, nil); err != nil {
		return nil, fmt.Errorf("infracost breakdown failed: %w", err)
	}

	data, err := os.ReadFile(breakdownJSONPath)
	if err != nil {
		return nil, fmt.Errorf("failed to read infracost output: %w", err)
	}

	breakdown, err := ParseCostBreakdown(data)
	if err != nil {
		return nil, err
	}

	if breakdown.Summary != nil {
		// DELIBERATELY NOT migrated to packages/core/format — #3768.
		//
		// DiffMonthly is a DELTA and is negative whenever a plan makes the estimate cheaper.
		// format.MonthlyRate takes an ABSOLUTE cost: it treats `<= 0` as one case and clamps it to
		// zero in both registers, so a $40/mo saving would render `$0.00/mo` — a real result
		// silently replaced by the one that reads as "no change". There is no credit register in
		// `format` to reach for instead; giving one a shape is a product decision (a `-$40.00/mo`?
		// a `$40.00/mo saved`?) and that is what #3768 tracks.
		//
		// Migrating only Monthly and leaving Diff hand-rolled is worse than leaving both: it puts a
		// grouped, JS-rounded number beside an ungrouped, half-to-even one INSIDE ONE SENTENCE,
		// where the two are read against each other. So both stay as they are until #3768 lands,
		// and this comment is what makes that a decision rather than a site nobody noticed.
		//
		// The `$` is likewise a standing USD assumption, not a rendering choice: breakdown.Currency
		// is parsed (types.go) but nothing configures infracost's currency and nothing reads the
		// field, and provisioner's ceiling compares Summary.TotalMonthly straight against a
		// ALETHIA_COST_CEILING_MONTHLY_USD figure.
		fmt.Printf("Cost Summary — Monthly: $%.2f, Diff: $%.2f (%d resources with cost, %d free)\n",
			breakdown.Summary.TotalMonthly,
			breakdown.Summary.DiffMonthly,
			breakdown.Summary.ResourcesWithCost,
			breakdown.Summary.ResourcesFree,
		)
	}

	return breakdown, nil
}
