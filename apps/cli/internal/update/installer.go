// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package update

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"
)

const (
	releaseDownloadBase = "https://github.com/alethialabs-io/alethia-cli/releases/download"
	dockerImageBase     = "ghcr.io/alethialabs-io/alethia"
	maxDownloadBytes    = 128 << 20
)

var stableVersion = regexp.MustCompile(`^v?[0-9]+\.[0-9]+\.[0-9]+$`)

type installMethod string

const (
	installHomebrew   installMethod = "homebrew"
	installScoop      installMethod = "scoop"
	installDeb        installMethod = "deb"
	installRPM        installMethod = "rpm"
	installAPK        installMethod = "apk"
	installDocker     installMethod = "docker"
	installStandalone installMethod = "standalone"
)

// ManualUpdateError reports an install channel that the CLI deliberately does not mutate.
type ManualUpdateError struct {
	Instruction string
}

// Error returns the manual update instruction.
func (e *ManualUpdateError) Error() string {
	return e.Instruction
}

// commandRunner isolates package-manager process execution for deterministic tests.
type commandRunner interface {
	LookPath(name string) (string, error)
	Output(ctx context.Context, name string, args ...string) ([]byte, error)
	Run(ctx context.Context, stdin io.Reader, stdout, stderr io.Writer, name string, args ...string) error
	Start(name string, args ...string) error
}

// execCommandRunner executes real local commands.
type execCommandRunner struct{}

// LookPath resolves a command using the process PATH.
func (execCommandRunner) LookPath(name string) (string, error) {
	return exec.LookPath(name)
}

// Output executes a command and captures stdout.
func (execCommandRunner) Output(ctx context.Context, name string, args ...string) ([]byte, error) {
	return exec.CommandContext(ctx, name, args...).Output()
}

// Run executes a command with the user's terminal streams attached.
func (execCommandRunner) Run(ctx context.Context, stdin io.Reader, stdout, stderr io.Writer, name string, args ...string) error {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Stdin = stdin
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	return cmd.Run()
}

// Start launches a detached helper process.
func (execCommandRunner) Start(name string, args ...string) error {
	return exec.Command(name, args...).Start()
}

// updater holds the platform seams needed to update one binary installation.
type updater struct {
	goos        string
	goarch      string
	executable  string
	container   bool
	runner      commandRunner
	client      *http.Client
	releaseBase string
	stdin       io.Reader
	stdout      io.Writer
	stderr      io.Writer
}

// Apply installs release when it is newer than current using the detected install channel.
func Apply(ctx context.Context, current string, release Release, stdout, stderr io.Writer) error {
	u, err := newUpdater(stdout, stderr)
	if err != nil {
		return err
	}
	return u.apply(ctx, current, release)
}

// newUpdater constructs the production updater from the running executable.
func newUpdater(stdout, stderr io.Writer) (*updater, error) {
	executable, err := os.Executable()
	if err != nil {
		return nil, fmt.Errorf("resolve the running alethia executable: %w", err)
	}
	if resolved, resolveErr := filepath.EvalSymlinks(executable); resolveErr == nil {
		executable = resolved
	}
	_, containerErr := os.Stat("/.dockerenv")
	return &updater{
		goos:        runtime.GOOS,
		goarch:      runtime.GOARCH,
		executable:  executable,
		container:   containerErr == nil || os.Getenv("container") != "",
		runner:      execCommandRunner{},
		client:      &http.Client{Timeout: 30 * time.Second},
		releaseBase: releaseDownloadBase,
		stdin:       os.Stdin,
		stdout:      stdout,
		stderr:      stderr,
	}, nil
}

// apply validates the target release and dispatches to its installation method.
func (u *updater) apply(ctx context.Context, current string, release Release) error {
	if !stableVersion.MatchString(release.Version) {
		return fmt.Errorf("control plane returned invalid CLI version %q", release.Version)
	}
	if !IsNewer(release.Version, current) {
		_, err := fmt.Fprintf(u.stdout, "alethia v%s is already up to date.\n", strings.TrimPrefix(current, "v"))
		return err
	}

	method := u.detectInstallMethod(ctx)
	_, _ = fmt.Fprintf(u.stdout, "Updating alethia %s → %s (%s)…\n", current, release.Version, method)
	switch method {
	case installHomebrew:
		if err := u.run(ctx, "brew", "update"); err != nil {
			return fmt.Errorf("brew update: %w", err)
		}
		if err := u.run(ctx, "brew", "upgrade", "alethialabs-io/tap/alethia"); err != nil {
			return fmt.Errorf("brew upgrade alethia: %w", err)
		}
	case installScoop:
		if err := u.run(ctx, "scoop", "update", "alethia"); err != nil {
			return fmt.Errorf("scoop update alethia: %w", err)
		}
	case installDeb, installRPM, installAPK, installDocker:
		return u.manualInstruction(method, release.Version)
	case installStandalone:
		deferred, err := u.replaceStandalone(ctx, release.Version)
		if err != nil {
			return err
		}
		if deferred {
			_, err = fmt.Fprintf(u.stdout, "alethia v%s will finish installing when this process exits.\n", strings.TrimPrefix(release.Version, "v"))
			return err
		}
	}

	if err := u.verifyVersion(ctx, release.Version); err != nil {
		return err
	}
	_, err := fmt.Fprintf(u.stdout, "Updated alethia to v%s.\n", strings.TrimPrefix(release.Version, "v"))
	return err
}

// run executes a package-manager command with the current terminal attached.
func (u *updater) run(ctx context.Context, name string, args ...string) error {
	return u.runner.Run(ctx, u.stdin, u.stdout, u.stderr, name, args...)
}

// detectInstallMethod identifies package-manager ownership before considering self-replacement.
func (u *updater) detectInstallMethod(ctx context.Context) installMethod {
	if u.container {
		return installDocker
	}
	if u.goos == "darwin" || u.goos == "linux" {
		if prefix, ok := u.commandPrefix(ctx, "brew", "--prefix", "alethialabs-io/tap/alethia"); ok && pathWithin(u.executable, prefix) {
			return installHomebrew
		}
	}
	if u.goos == "windows" {
		normalized := strings.ToLower(strings.ReplaceAll(u.executable, `\`, "/"))
		if _, err := u.runner.LookPath("scoop"); err == nil && strings.Contains(normalized, "/scoop/apps/alethia/") {
			return installScoop
		}
		if path, ok := u.commandPrefix(ctx, "scoop", "which", "alethia"); ok && samePath(u.goos, u.executable, path) {
			return installScoop
		}
	}
	if u.goos == "linux" {
		if u.ownsPackage(ctx, "dpkg-query", "-S", u.executable) {
			return installDeb
		}
		if u.ownsPackage(ctx, "rpm", "-qf", u.executable) {
			return installRPM
		}
		if u.ownsPackage(ctx, "apk", "info", "--who-owns", u.executable) {
			return installAPK
		}
	}
	return installStandalone
}

// commandPrefix captures a package manager's installation path when available.
func (u *updater) commandPrefix(ctx context.Context, name string, args ...string) (string, bool) {
	if _, err := u.runner.LookPath(name); err != nil {
		return "", false
	}
	out, err := u.runner.Output(ctx, name, args...)
	if err != nil {
		return "", false
	}
	return strings.TrimSpace(string(out)), true
}

// ownsPackage reports whether a package-manager ownership query succeeds.
func (u *updater) ownsPackage(ctx context.Context, name string, args ...string) bool {
	if _, err := u.runner.LookPath(name); err != nil {
		return false
	}
	_, err := u.runner.Output(ctx, name, args...)
	return err == nil
}

// replaceStandalone downloads, verifies, and atomically stages a standalone binary.
func (u *updater) replaceStandalone(ctx context.Context, version string) (bool, error) {
	asset, err := archiveAsset(u.goos, u.goarch)
	if err != nil {
		return false, err
	}
	tag := "v" + strings.TrimPrefix(version, "v")
	base := strings.TrimRight(u.releaseBase, "/") + "/" + tag
	archive, err := u.fetch(ctx, base+"/"+asset)
	if err != nil {
		return false, fmt.Errorf("download %s: %w", asset, err)
	}
	checksums, err := u.fetch(ctx, base+"/checksums.txt")
	if err != nil {
		return false, fmt.Errorf("download checksums.txt: %w", err)
	}
	if err := verifyChecksum(asset, archive, checksums); err != nil {
		return false, err
	}
	binary, err := extractBinary(asset, archive, u.goos)
	if err != nil {
		return false, err
	}

	tmp, err := os.CreateTemp(filepath.Dir(u.executable), ".alethia-update-*")
	if err != nil {
		return false, u.nonWritableInstruction()
	}
	tmpPath := tmp.Name()
	removeTemp := true
	defer func() {
		if removeTemp {
			_ = os.Remove(tmpPath)
		}
	}()
	if err := tmp.Chmod(0o755); err != nil {
		_ = tmp.Close()
		return false, fmt.Errorf("prepare replacement binary: %w", err)
	}
	if _, err := tmp.Write(binary); err != nil {
		_ = tmp.Close()
		return false, fmt.Errorf("write replacement binary: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return false, fmt.Errorf("sync replacement binary: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return false, fmt.Errorf("close replacement binary: %w", err)
	}

	if u.goos == "windows" {
		script := `Wait-Process -Id ([int]$args[0]); Move-Item -Force -LiteralPath $args[1] -Destination $args[2]`
		if err := u.runner.Start("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script, strconv.Itoa(os.Getpid()), tmpPath, u.executable); err != nil {
			return false, fmt.Errorf("schedule Windows replacement: %w", err)
		}
		removeTemp = false
		return true, nil
	}
	if err := os.Rename(tmpPath, u.executable); err != nil {
		if errors.Is(err, os.ErrPermission) {
			return false, u.nonWritableInstruction()
		}
		return false, fmt.Errorf("replace %s: %w", u.executable, err)
	}
	return false, nil
}

// fetch downloads one bounded release artifact.
func (u *updater) fetch(ctx context.Context, url string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := u.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("status %d", resp.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxDownloadBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > maxDownloadBytes {
		return nil, fmt.Errorf("download exceeds %d bytes", maxDownloadBytes)
	}
	return data, nil
}

// verifyVersion confirms the installed command now reports the canonical version.
func (u *updater) verifyVersion(ctx context.Context, expected string) error {
	out, err := u.runner.Output(ctx, u.executable, "version")
	if err != nil {
		return fmt.Errorf("verify updated alethia: %w", err)
	}
	got := strings.TrimSpace(string(out))
	want := "v" + strings.TrimPrefix(expected, "v")
	if !strings.Contains(got, want) {
		return fmt.Errorf("update completed but %s reports %q instead of %s", u.executable, got, want)
	}
	return nil
}

// manualInstruction returns the native command for a channel the CLI cannot safely mutate.
func (u *updater) manualInstruction(method installMethod, version string) error {
	v := strings.TrimPrefix(version, "v")
	arch := u.goarch
	if arch == "amd64" {
		arch = "amd64"
	}
	base := releaseDownloadBase + "/v" + v
	var instruction string
	switch method {
	case installDeb:
		name := fmt.Sprintf("alethia_%s_linux_%s.deb", v, arch)
		instruction = fmt.Sprintf("Debian package installs are updated through dpkg: download %s/%s, then run `sudo dpkg -i %s`", base, name, name)
	case installRPM:
		name := fmt.Sprintf("alethia_%s_linux_%s.rpm", v, arch)
		instruction = fmt.Sprintf("RPM installs are updated through rpm: download %s/%s, then run `sudo rpm -U %s`", base, name, name)
	case installAPK:
		name := fmt.Sprintf("alethia_%s_linux_%s.apk", v, arch)
		instruction = fmt.Sprintf("Alpine package installs are updated through apk: download %s/%s, then run `sudo apk add --allow-untrusted %s`", base, name, name)
	case installDocker:
		instruction = fmt.Sprintf("Docker images are updated on the host: run `docker pull %s:%s` and recreate the container", dockerImageBase, v)
	case installHomebrew, installScoop, installStandalone:
		instruction = "this Alethia installation must be updated by its package manager"
	default:
		instruction = "this Alethia installation must be updated by its package manager"
	}
	return &ManualUpdateError{Instruction: instruction}
}

// nonWritableInstruction explains how to update without silently elevating privileges.
func (u *updater) nonWritableInstruction() error {
	dir := filepath.Dir(u.executable)
	if u.goos == "windows" {
		return &ManualUpdateError{Instruction: fmt.Sprintf("%s is not writable; open an Administrator PowerShell, set `$env:ALETHIA_INSTALL_DIR=%q`, then run `irm https://get.alethialabs.io/install.ps1 | iex`", u.executable, dir)}
	}
	return &ManualUpdateError{Instruction: fmt.Sprintf("%s is not writable and alethia will not elevate itself; run `curl -fsSL https://get.alethialabs.io | sudo env ALETHIA_INSTALL_DIR=%q sh`", u.executable, dir)}
}

// archiveAsset returns the exact GoReleaser archive name for a platform.
func archiveAsset(goos, goarch string) (string, error) {
	arch := goarch
	if goarch == "amd64" {
		arch = "x86_64"
	}
	var platform string
	switch goos {
	case "darwin":
		platform = "Darwin"
	case "linux":
		platform = "Linux"
	case "windows":
		platform = "Windows"
	default:
		return "", fmt.Errorf("unsupported operating system %q", goos)
	}
	if arch != "x86_64" && arch != "arm64" {
		return "", fmt.Errorf("unsupported architecture %q", goarch)
	}
	ext := ".tar.gz"
	if goos == "windows" {
		ext = ".zip"
	}
	return fmt.Sprintf("alethia_%s_%s%s", platform, arch, ext), nil
}

// verifyChecksum authenticates an archive against the release checksum manifest.
func verifyChecksum(asset string, archive, manifest []byte) error {
	var expected string
	for _, line := range strings.Split(string(manifest), "\n") {
		fields := strings.Fields(line)
		if len(fields) == 2 && strings.TrimPrefix(fields[1], "*") == asset {
			expected = fields[0]
			break
		}
	}
	if expected == "" {
		return fmt.Errorf("checksums.txt has no entry for %s", asset)
	}
	if _, err := hex.DecodeString(expected); err != nil || len(expected) != sha256.Size*2 {
		return fmt.Errorf("checksums.txt contains an invalid SHA-256 for %s", asset)
	}
	actual := sha256.Sum256(archive)
	if !strings.EqualFold(expected, hex.EncodeToString(actual[:])) {
		return fmt.Errorf("checksum mismatch for %s", asset)
	}
	return nil
}

// extractBinary reads only the expected executable from a verified release archive.
func extractBinary(asset string, archive []byte, goos string) ([]byte, error) {
	name := "alethia"
	if goos == "windows" {
		name += ".exe"
		r, err := zip.NewReader(bytes.NewReader(archive), int64(len(archive)))
		if err != nil {
			return nil, fmt.Errorf("open %s: %w", asset, err)
		}
		for _, file := range r.File {
			if filepath.Base(file.Name) != name || file.FileInfo().IsDir() {
				continue
			}
			reader, err := file.Open()
			if err != nil {
				return nil, err
			}
			data, readErr := io.ReadAll(io.LimitReader(reader, maxDownloadBytes+1))
			closeErr := reader.Close()
			if readErr != nil {
				return nil, readErr
			}
			if closeErr != nil {
				return nil, closeErr
			}
			if len(data) > maxDownloadBytes {
				return nil, fmt.Errorf("extracted binary exceeds %d bytes", maxDownloadBytes)
			}
			return data, nil
		}
		return nil, fmt.Errorf("%s does not contain %s", asset, name)
	}

	gz, err := gzip.NewReader(bytes.NewReader(archive))
	if err != nil {
		return nil, fmt.Errorf("open %s: %w", asset, err)
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	for {
		header, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("read %s: %w", asset, err)
		}
		if filepath.Base(header.Name) == name && header.Typeflag == tar.TypeReg {
			data, err := io.ReadAll(io.LimitReader(tr, maxDownloadBytes+1))
			if err != nil {
				return nil, err
			}
			if len(data) > maxDownloadBytes {
				return nil, fmt.Errorf("extracted binary exceeds %d bytes", maxDownloadBytes)
			}
			return data, nil
		}
	}
	return nil, fmt.Errorf("%s does not contain %s", asset, name)
}

// pathWithin reports whether path resolves inside prefix.
func pathWithin(path, prefix string) bool {
	if resolved, err := filepath.EvalSymlinks(path); err == nil {
		path = resolved
	}
	if resolved, err := filepath.EvalSymlinks(prefix); err == nil {
		prefix = resolved
	}
	rel, err := filepath.Rel(filepath.Clean(prefix), filepath.Clean(path))
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

// samePath compares command paths using platform-appropriate case handling.
func samePath(goos, a, b string) bool {
	a, b = filepath.Clean(a), filepath.Clean(b)
	if goos == "windows" {
		return strings.EqualFold(a, b)
	}
	return a == b
}
