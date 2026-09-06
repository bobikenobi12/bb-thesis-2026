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
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type fakeCommandRunner struct {
	paths   map[string]string
	outputs map[string][]byte
	errors  map[string]error
	runs    []string
	starts  []string
}

// commandKey serializes a command invocation for the fake runner.
func commandKey(name string, args ...string) string {
	return strings.Join(append([]string{name}, args...), " ")
}

// LookPath resolves commands declared by the test.
func (f *fakeCommandRunner) LookPath(name string) (string, error) {
	if path, ok := f.paths[name]; ok {
		return path, nil
	}
	return "", os.ErrNotExist
}

// Output returns the configured command output.
func (f *fakeCommandRunner) Output(_ context.Context, name string, args ...string) ([]byte, error) {
	key := commandKey(name, args...)
	if err := f.errors[key]; err != nil {
		return nil, err
	}
	if output, ok := f.outputs[key]; ok {
		return output, nil
	}
	return nil, os.ErrNotExist
}

// Run records a package-manager command.
func (f *fakeCommandRunner) Run(_ context.Context, _ io.Reader, _, _ io.Writer, name string, args ...string) error {
	key := commandKey(name, args...)
	f.runs = append(f.runs, key)
	return f.errors[key]
}

// Start records a deferred helper command.
func (f *fakeCommandRunner) Start(name string, args ...string) error {
	key := commandKey(name, args...)
	f.starts = append(f.starts, key)
	return f.errors[key]
}

// testUpdater creates a hermetic updater with no package managers installed.
func testUpdater(goos, goarch, executable string, runner *fakeCommandRunner) *updater {
	return &updater{
		goos:        goos,
		goarch:      goarch,
		executable:  executable,
		runner:      runner,
		client:      http.DefaultClient,
		releaseBase: releaseDownloadBase,
		stdin:       strings.NewReader(""),
		stdout:      io.Discard,
		stderr:      io.Discard,
	}
}

func TestArchiveAsset(t *testing.T) {
	cases := []struct {
		goos, goarch, want string
	}{
		{"darwin", "arm64", "alethia_Darwin_arm64.tar.gz"},
		{"darwin", "amd64", "alethia_Darwin_x86_64.tar.gz"},
		{"linux", "arm64", "alethia_Linux_arm64.tar.gz"},
		{"windows", "amd64", "alethia_Windows_x86_64.zip"},
	}
	for _, tc := range cases {
		got, err := archiveAsset(tc.goos, tc.goarch)
		if err != nil || got != tc.want {
			t.Errorf("archiveAsset(%s, %s) = %q, %v; want %q", tc.goos, tc.goarch, got, err, tc.want)
		}
	}
	if _, err := archiveAsset("plan9", "amd64"); err == nil {
		t.Fatal("unsupported OS should fail")
	}
	if _, err := archiveAsset("linux", "386"); err == nil {
		t.Fatal("unsupported architecture should fail")
	}
}

func TestDetectInstallMethod(t *testing.T) {
	ctx := context.Background()
	brew := &fakeCommandRunner{
		paths:   map[string]string{"brew": "/opt/homebrew/bin/brew"},
		outputs: map[string][]byte{"brew --prefix alethialabs-io/tap/alethia": []byte("/opt/homebrew/Cellar/alethia/1.2.0\n")},
		errors:  map[string]error{},
	}
	if got := testUpdater("darwin", "arm64", "/opt/homebrew/Cellar/alethia/1.2.0/bin/alethia", brew).detectInstallMethod(ctx); got != installHomebrew {
		t.Fatalf("Homebrew detection = %s", got)
	}

	scoop := &fakeCommandRunner{
		paths:   map[string]string{"scoop": `C:\scoop\shims\scoop.cmd`},
		outputs: map[string][]byte{"scoop which alethia": []byte(`C:\Users\Ada\scoop\apps\alethia\current\alethia.exe`)},
		errors:  map[string]error{},
	}
	if got := testUpdater("windows", "amd64", `c:\users\ada\scoop\apps\alethia\current\alethia.exe`, scoop).detectInstallMethod(ctx); got != installScoop {
		t.Fatalf("Scoop detection = %s", got)
	}

	dpkg := &fakeCommandRunner{
		paths:   map[string]string{"dpkg-query": "/usr/bin/dpkg-query"},
		outputs: map[string][]byte{"dpkg-query -S /usr/bin/alethia": []byte("alethia: /usr/bin/alethia")},
		errors:  map[string]error{},
	}
	if got := testUpdater("linux", "amd64", "/usr/bin/alethia", dpkg).detectInstallMethod(ctx); got != installDeb {
		t.Fatalf("Debian detection = %s", got)
	}

	container := testUpdater("linux", "amd64", "/usr/bin/alethia", &fakeCommandRunner{})
	container.container = true
	if got := container.detectInstallMethod(ctx); got != installDocker {
		t.Fatalf("Docker detection = %s", got)
	}
}

// TestPathWithinResolvesPackageManagerSymlinks covers Homebrew's opt-to-Cellar layout.
func TestPathWithinResolvesPackageManagerSymlinks(t *testing.T) {
	root := t.TempDir()
	cellar := filepath.Join(root, "Cellar", "alethia", "1.2.3")
	if err := os.MkdirAll(filepath.Join(cellar, "bin"), 0o755); err != nil {
		t.Fatal(err)
	}
	executable := filepath.Join(cellar, "bin", "alethia")
	if err := os.WriteFile(executable, []byte("binary"), 0o755); err != nil {
		t.Fatal(err)
	}
	opt := filepath.Join(root, "opt")
	if err := os.MkdirAll(opt, 0o755); err != nil {
		t.Fatal(err)
	}
	formulaPrefix := filepath.Join(opt, "alethia")
	if err := os.Symlink(cellar, formulaPrefix); err != nil {
		t.Fatal(err)
	}
	if !pathWithin(executable, formulaPrefix) {
		t.Fatal("resolved Cellar executable was not recognized inside the Homebrew opt prefix")
	}
}

func TestApplyHomebrewRunsNativeUpdateAndVerifies(t *testing.T) {
	runner := &fakeCommandRunner{
		paths: map[string]string{"brew": "/opt/homebrew/bin/brew"},
		outputs: map[string][]byte{
			"brew --prefix alethialabs-io/tap/alethia":               []byte("/opt/homebrew/Cellar/alethia/1.0.0\n"),
			"/opt/homebrew/Cellar/alethia/1.0.0/bin/alethia version": []byte("alethia v1.1.0\n"),
		},
		errors: map[string]error{},
	}
	var out bytes.Buffer
	u := testUpdater("darwin", "arm64", "/opt/homebrew/Cellar/alethia/1.0.0/bin/alethia", runner)
	u.stdout = &out
	if err := u.apply(context.Background(), "1.0.0", Release{Version: "1.1.0"}); err != nil {
		t.Fatalf("apply: %v", err)
	}
	want := []string{"brew update", "brew upgrade alethialabs-io/tap/alethia"}
	if strings.Join(runner.runs, "|") != strings.Join(want, "|") {
		t.Fatalf("commands = %v, want %v", runner.runs, want)
	}
	if !strings.Contains(out.String(), "Updated alethia to v1.1.0") {
		t.Fatalf("missing success output: %s", out.String())
	}
}

func TestApplyAlreadyCurrentDoesNotRunInstaller(t *testing.T) {
	runner := &fakeCommandRunner{paths: map[string]string{}, outputs: map[string][]byte{}, errors: map[string]error{}}
	var out bytes.Buffer
	u := testUpdater("linux", "amd64", "/tmp/alethia", runner)
	u.stdout = &out
	if err := u.apply(context.Background(), "1.2.0", Release{Version: "1.2.0"}); err != nil {
		t.Fatalf("apply: %v", err)
	}
	if len(runner.runs) != 0 || !strings.Contains(out.String(), "already up to date") {
		t.Fatalf("unexpected result: runs=%v out=%q", runner.runs, out.String())
	}
}

func TestManualInstructions(t *testing.T) {
	runner := &fakeCommandRunner{paths: map[string]string{}, outputs: map[string][]byte{}, errors: map[string]error{}}
	u := testUpdater("linux", "arm64", "/usr/bin/alethia", runner)
	for _, method := range []installMethod{installDeb, installRPM, installAPK, installDocker} {
		err := u.manualInstruction(method, "1.2.3")
		var manual *ManualUpdateError
		if !errors.As(err, &manual) || !strings.Contains(manual.Instruction, "1.2.3") {
			t.Errorf("%s instruction = %v", method, err)
		}
	}
}

func TestManualUpdateErrorAndPlatformHelpers(t *testing.T) {
	manual := &ManualUpdateError{Instruction: "use package manager"}
	if manual.Error() != manual.Instruction {
		t.Fatalf("manual error = %q, want instruction", manual.Error())
	}
	if !samePath("windows", `C:\Alethia\alethia.exe`, `c:\alethia\ALETHIA.EXE`) {
		t.Fatal("Windows paths should compare case-insensitively")
	}
	if samePath("linux", "/usr/bin/alethia", "/usr/local/bin/alethia") {
		t.Fatal("different Unix paths must not compare equal")
	}
	if got := testUpdater("linux", "amd64", "/usr/bin/alethia", &fakeCommandRunner{}).nonWritableInstruction(); got == nil {
		t.Fatal("non-writable installs must return a manual instruction")
	}
}

func TestApplyRejectsInvalidReleaseBeforeInstall(t *testing.T) {
	err := Apply(context.Background(), "1.0.0", Release{Version: "not-a-version"}, io.Discard, io.Discard)
	if err == nil || !strings.Contains(err.Error(), "invalid CLI version") {
		t.Fatalf("expected invalid release error, got %v", err)
	}
}

func TestStandaloneUpdateVerifiesChecksumAndReplacesBinary(t *testing.T) {
	dir := t.TempDir()
	executable := filepath.Join(dir, "alethia")
	if err := os.WriteFile(executable, []byte("old"), 0o755); err != nil {
		t.Fatal(err)
	}
	archive := tarArchive(t, "alethia", []byte("new-binary"))
	asset := "alethia_Linux_x86_64.tar.gz"
	manifest := checksumManifest(asset, archive)
	server := releaseServer(asset, archive, manifest)
	defer server.Close()
	runner := &fakeCommandRunner{
		paths: map[string]string{},
		outputs: map[string][]byte{
			commandKey(executable, "version"): []byte("alethia v1.1.0\n"),
		},
		errors: map[string]error{},
	}
	u := testUpdater("linux", "amd64", executable, runner)
	u.releaseBase = server.URL
	u.client = server.Client()
	if err := u.apply(context.Background(), "1.0.0", Release{Version: "1.1.0"}); err != nil {
		t.Fatalf("apply: %v", err)
	}
	got, err := os.ReadFile(executable)
	if err != nil || string(got) != "new-binary" {
		t.Fatalf("replacement = %q, %v", got, err)
	}
}

func TestStandaloneUpdateRefusesChecksumMismatch(t *testing.T) {
	dir := t.TempDir()
	executable := filepath.Join(dir, "alethia")
	if err := os.WriteFile(executable, []byte("old"), 0o755); err != nil {
		t.Fatal(err)
	}
	archive := tarArchive(t, "alethia", []byte("new-binary"))
	asset := "alethia_Linux_x86_64.tar.gz"
	server := releaseServer(asset, archive, []byte(strings.Repeat("0", 64)+"  "+asset+"\n"))
	defer server.Close()
	u := testUpdater("linux", "amd64", executable, &fakeCommandRunner{paths: map[string]string{}, outputs: map[string][]byte{}, errors: map[string]error{}})
	u.releaseBase = server.URL
	u.client = server.Client()
	if err := u.apply(context.Background(), "1.0.0", Release{Version: "1.1.0"}); err == nil || !strings.Contains(err.Error(), "checksum mismatch") {
		t.Fatalf("expected checksum mismatch, got %v", err)
	}
	got, _ := os.ReadFile(executable)
	if string(got) != "old" {
		t.Fatalf("binary changed after mismatch: %q", got)
	}
}

func TestWindowsStandaloneStagesDeferredReplacement(t *testing.T) {
	dir := t.TempDir()
	executable := filepath.Join(dir, "alethia.exe")
	if err := os.WriteFile(executable, []byte("old"), 0o755); err != nil {
		t.Fatal(err)
	}
	archive := zipArchive(t, "alethia.exe", []byte("new-binary"))
	asset := "alethia_Windows_x86_64.zip"
	server := releaseServer(asset, archive, checksumManifest(asset, archive))
	defer server.Close()
	runner := &fakeCommandRunner{paths: map[string]string{}, outputs: map[string][]byte{}, errors: map[string]error{}}
	u := testUpdater("windows", "amd64", executable, runner)
	u.releaseBase = server.URL
	u.client = server.Client()
	if err := u.apply(context.Background(), "1.0.0", Release{Version: "1.1.0"}); err != nil {
		t.Fatalf("apply: %v", err)
	}
	if len(runner.starts) != 1 || !strings.HasPrefix(runner.starts[0], "powershell.exe ") {
		t.Fatalf("deferred commands = %v", runner.starts)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	staged := false
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".alethia-update-") {
			staged = true
		}
	}
	if !staged {
		t.Fatal("Windows replacement was deleted before the deferred helper could install it")
	}
}

// tarArchive builds a minimal GoReleaser-shaped tarball.
func tarArchive(t *testing.T, name string, content []byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	if err := tw.WriteHeader(&tar.Header{Name: name, Mode: 0o755, Size: int64(len(content)), Typeflag: tar.TypeReg}); err != nil {
		t.Fatal(err)
	}
	if _, err := tw.Write(content); err != nil {
		t.Fatal(err)
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// zipArchive builds a minimal Windows release archive.
func zipArchive(t *testing.T, name string, content []byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	w, err := zw.Create(name)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write(content); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// checksumManifest returns the release checksum line for an archive.
func checksumManifest(asset string, archive []byte) []byte {
	hash := sha256.Sum256(archive)
	return []byte(fmt.Sprintf("%x  %s\n", hash, asset))
}

// releaseServer serves one archive and its checksum manifest under any tag path.
func releaseServer(asset string, archive, manifest []byte) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch filepath.Base(r.URL.Path) {
		case asset:
			_, _ = w.Write(archive)
		case "checksums.txt":
			_, _ = w.Write(manifest)
		default:
			http.NotFound(w, r)
		}
	}))
}
