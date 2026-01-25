package git

import (
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/bobikenobi12/bb-thesis-2026/apps/cli/types"
	"github.com/bobikenobi12/bb-thesis-2026/apps/cli/utils"
	"github.com/flosch/pongo2/v6"
	gogit "github.com/go-git/go-git/v5"
	"github.com/go-git/go-git/v5/config"
	"github.com/go-git/go-git/v5/plumbing"
	"github.com/go-git/go-git/v5/plumbing/transport"
	"github.com/go-git/go-git/v5/plumbing/transport/ssh"
	"gopkg.in/yaml.v3"
)

// GIT represents a Git repository wrapper.
type GIT struct {
	RepoURL   string
	LocalPath string
	Repo      *gogit.Repository
	DryRun    bool
}

// NewGIT creates a new GIT wrapper.
func NewGIT(repoURL string, localPath string, dryRun bool) *GIT {
	return &GIT{
		RepoURL:   transformURLToSSH(repoURL),
		LocalPath: localPath,
		DryRun:    dryRun,
	}
}

// transformURLToSSH converts an HTTP/HTTPS URL to SSH format.
func transformURLToSSH(rawURL string) string {
	// If URL is already in SSH format, return as is.
	if strings.HasPrefix(rawURL, "git@") {
		return rawURL
	}

	u, err := url.Parse(rawURL)
	if err != nil {
		fmt.Printf("Warning: Failed to parse Git URL '%s': %v. Returning original URL.\n", rawURL, err)
		return rawURL
	}

	// Construct the SSH URL: git@host:path/to/repo.git
	sshURL := fmt.Sprintf("git@%s:%s", u.Host, strings.TrimPrefix(u.Path, "/"))

	// Ensure it ends with .git
	if !strings.HasSuffix(sshURL, ".git") {
		sshURL += ".git"
	}

	return sshURL
}

// getAuthMethod creates an SSH authentication method from the default SSH agent.
func getAuthMethod() (transport.AuthMethod, error) {
	auth, err := ssh.NewSSHAgentAuth("git")
	if err != nil {
		return nil, fmt.Errorf("failed to create SSH agent auth: %w", err)
	}
	return auth, nil
}

// Clone clones a repository or opens an existing one.
func (g *GIT) Clone(branch string, force bool) error {
	fmt.Printf("Cloning %s into %s...\n", g.RepoURL, g.LocalPath)

	if _, err := os.Stat(g.LocalPath); err == nil && !force && g.isCorrectRepo() {
		// Repository already exists and is correct, open it
		repo, err := gogit.PlainOpen(g.LocalPath)
		if err != nil {
			return fmt.Errorf("failed to open existing repository '%s': %w", g.LocalPath, err)
		}
		g.Repo = repo

		// Checkout branch if specified
		if branch != "" {
			w, err := g.Repo.Worktree()
			if err != nil {
				return fmt.Errorf("failed to get worktree: %w", err)
			}
			err = w.Checkout(&gogit.CheckoutOptions{
				Branch:  plumbing.NewBranchReferenceName(branch),
			})
			if err != nil {
				// If branch checkout fails, try to fetch it first
				fetchOptions := &gogit.FetchOptions{
					RemoteName: "origin",
					RefSpecs: []config.RefSpec{config.RefSpec(fmt.Sprintf("+refs/heads/%s:refs/remotes/origin/%s", branch, branch))},
					Auth:       nil,
				}
				auth, authErr := getAuthMethod()
				if authErr == nil {
					fetchOptions.Auth = auth
				}
				_ = g.Repo.Fetch(fetchOptions)

				err = w.Checkout(&gogit.CheckoutOptions{
					Branch:  plumbing.NewBranchReferenceName(branch),
				})
				if err != nil {
					return fmt.Errorf("failed to checkout branch '%s' after fetch attempt: %w", branch, err)
				}
			}
		}
		g.ResetAndRestoreChanges() // Discard local changes and untracked files
		return g.Pull()
	} else {
		// Remove existing directory if not correct repo or force is true
		_ = os.RemoveAll(g.LocalPath)
		_ = os.MkdirAll(g.LocalPath, 0755)

		auth, err := getAuthMethod()
		if err != nil {
			fmt.Printf("Warning: Could not get SSH auth method: %v. Attempting public clone.\n", err)
			// Proceed without auth for public repos
		}

		cloneOptions := &gogit.CloneOptions{
			URL:           g.RepoURL,
			ReferenceName: plumbing.NewBranchReferenceName(branch),
			SingleBranch:  true,
			Depth:         1,
			Progress:      os.Stdout,
			Auth:          auth,
		}

		if branch == "" {
			cloneOptions.ReferenceName = ""
			cloneOptions.SingleBranch = false
		}

		repo, err := gogit.PlainClone(g.LocalPath, false, cloneOptions)
		if err != nil {
			return fmt.Errorf("failed to clone repository '%s': %w", g.RepoURL, err)
		}
		g.Repo = repo
	}
	return nil
}

// isCorrectRepo checks if the local path contains the correct repository.
func (g *GIT) isCorrectRepo() bool {
	repo, err := gogit.PlainOpen(g.LocalPath)
	if err != nil {
		return false
	}

	remotes, err := repo.Remotes()
	if err != nil {
		return false
	}

	for _, r := range remotes {
		for _, u := range r.Config().URLs {
			if u == g.RepoURL {
				return true
			}
		}
	}
	return false
}

// Pull pulls the latest changes from the remote repository.
func (g *GIT) Pull() error {
	if g.Repo == nil {
		return fmt.Errorf("repository not initialized")
	}
	fmt.Printf("Pulling changes for %s...\n", g.RepoURL)

	w, err := g.Repo.Worktree()
	if err != nil {
		return fmt.Errorf("failed to get worktree: %w", err)
	}

	pullOptions := &gogit.PullOptions{
		RemoteName: "origin",
		Auth:       nil, // Auth method will be handled by getAuthMethod if needed
	}

	auth, err := getAuthMethod()
	if err == nil {
		pullOptions.Auth = auth
	}

	err = w.Pull(pullOptions)
	if err != nil && err != gogit.NoErrAlreadyUpToDate {
		if err == transport.ErrEmptyRemoteRepository {
			fmt.Printf("Remote repository %s is empty.\n", g.RepoURL)
			return nil
		}
		return fmt.Errorf("failed to pull changes: %w", err)
	}

	fmt.Println("Pulled latest changes.")
	return nil
}

// Push pushes local commits to the remote repository.
func (g *GIT) Push() error {
	if g.Repo == nil {
		return fmt.Errorf("repository not initialized")
	}

	if g.DryRun {
		fmt.Printf("Dry-run mode: Skipping actual push for %s.\n", g.RepoURL)
		return nil
	}

	fmt.Printf("Pushing changes to %s...\n", g.RepoURL)
	auth, err := getAuthMethod()
	if err != nil {
		return fmt.Errorf("failed to get SSH auth method for push: %w", err)
	}

	pushOptions := &gogit.PushOptions{
		RemoteName: "origin",
		Auth:       auth,
	}

	err = g.Repo.Push(pushOptions)
	if err != nil && err != gogit.NoErrAlreadyUpToDate {
		return fmt.Errorf("failed to push changes: %w", err)
	}

	fmt.Println("Pushed changes successfully.")
	return nil
}

// AddAndCommit stages all changes and commits them.
func (g *GIT) AddAndCommit(message string) error {
	if g.Repo == nil {
		return fmt.Errorf("repository not initialized")
	}

	if g.DryRun {
		fmt.Printf("Dry-run mode: Skipping commit for %s.\n", g.RepoURL)
		return nil
	}

	w, err := g.Repo.Worktree()
	if err != nil {
		return fmt.Errorf("failed to get worktree: %w", err)
	}

	// Add all changes
	_, err = w.Add(".")
	if err != nil {
		return fmt.Errorf("failed to add changes to git index: %w", err)
	}

	// Commit changes
	_, err = w.Commit(message, &gogit.CommitOptions{})
	if err != nil {
		return fmt.Errorf("failed to commit changes: %w", err)
	}

	fmt.Printf("Committed changes with message: '%s'\n", message)
	return nil
}

// ResetAndRestoreChanges discards local changes and untracked files.
func (g *GIT) ResetAndRestoreChanges() error {
	if g.Repo == nil {
		return fmt.Errorf("repository not initialized")
	}

	w, err := g.Repo.Worktree()
	if err != nil {
		return fmt.Errorf("failed to get worktree: %w", err)
	}

	// Discard all changes in the working directory and staging area
	err = w.Reset(&gogit.ResetOptions{
		Mode: gogit.HardReset,
	})
	if err != nil {
		return fmt.Errorf("failed to reset worktree: %w", err)
	}

	// Clean untracked files and directories
	err = w.Clean(&gogit.CleanOptions{
		Dir: true, // Clean untracked directories
	})
	if err != nil {
		return fmt.Errorf("failed to clean worktree: %w", err)
	}

	fmt.Println("Reset staged and restored all changes.")
	return nil
}

// IsDirty checks if the repository has uncommitted changes or untracked files.
func (g *GIT) IsDirty() (bool, error) {
	if g.Repo == nil {
		return false, fmt.Errorf("repository not initialized")
	}
	w, err := g.Repo.Worktree()
	if err != nil {
		return false, fmt.Errorf("failed to get worktree: %w", err)
	}

	s, err := w.Status()
	if err != nil {
		return false, fmt.Errorf("failed to get worktree status: %w", err)
	}

	return !s.IsClean(), nil
}

// FileExists checks if a file exists within the local repository path.
func (g *GIT) FileExists(relativePath string) bool {
	fullPath := filepath.Join(g.LocalPath, relativePath)
	_, err := os.Stat(fullPath)
	return !os.IsNotExist(err)
}

// CopyFiles copies files from source to destination, ignoring specified files.
func (g *GIT) CopyFiles(src, dst string, ignoreFiles []string) error {
	return filepath.Walk(src, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}

		relPath, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}

		// Check if the file/directory should be ignored
		for _, ignore := range ignoreFiles {
			if relPath == ignore || strings.HasPrefix(relPath, ignore+"/") {
				if info.IsDir() {
					return filepath.SkipDir
				} else {
					return nil
				}
			}
		}

		destPath := filepath.Join(dst, relPath)

		if info.IsDir() {
			return os.MkdirAll(destPath, info.Mode())
		}

		srcFile, err := os.Open(path)
		if err != nil {
			return err
		}
		defer srcFile.Close()

		dstFile, err := os.Create(destPath)
		if err != nil {
			return err
		}
		defer dstFile.Close()

		_, err = io.Copy(dstFile, srcFile)
		return err
	})
}

// ClearRepoContents removes all files and directories (except .git) from the local repository path.
func (g *GIT) ClearRepoContents() error {
	// Ensure the local path exists and is a directory
	if info, err := os.Stat(g.LocalPath); os.IsNotExist(err) || !info.IsDir() {
		return fmt.Errorf("local path %s does not exist or is not a directory", g.LocalPath)
	}

	dirEntries, err := os.ReadDir(g.LocalPath)
	if err != nil {
		return fmt.Errorf("failed to read local repository directory: %w", err)
	}

	for _, entry := range dirEntries {
		if entry.Name() != ".git" {
			itemPath := filepath.Join(g.LocalPath, entry.Name())
			if err := os.RemoveAll(itemPath); err != nil {
				return fmt.Errorf("failed to remove %s: %w", itemPath, err)
			}
		}
	}
	return nil
}

// Bootstrap bootstraps the infrastructure-as-code repository.
func (g *GIT) Bootstrap(templateRepo *GIT, repoFilesMap map[string]string, updateRepo bool, logger *utils.Logger) error {
	logger.Info(fmt.Sprintf("Bootstrapping infrastructure-as-code git repository into %s...", g.LocalPath), "git")
	changes := false
	ignoreFiles := []string{".git", "variable-template"}

	if !g.FileExists("main.tf") {
		logger.Info("Initial infrastructure repo bootstrap", "git")
		if err := g.ClearRepoContents(); err != nil {
			return err
		}
		if err := g.CopyFiles(templateRepo.LocalPath, g.LocalPath, ignoreFiles); err != nil {
			return err
		}
		changes = true
	} else if updateRepo {
		logger.Info("Updating repo due to update flag", "git")
		if err := g.CopyFiles(templateRepo.LocalPath, g.LocalPath, ignoreFiles); err != nil {
			return err
		}
		changes = true
	} else {
		logger.Warn("main.tf file exists and will not overwrite!", "git")
	}

	for varFileSrc, varFileDst := range repoFilesMap {
		fullVarFileDstPath := filepath.Join(g.LocalPath, varFileDst)
		if !g.FileExists(varFileDst) || updateRepo {
			if err := os.MkdirAll(filepath.Dir(fullVarFileDstPath), 0755); err != nil {
				return err
			}
			srcPath := filepath.Join(templateRepo.LocalPath, varFileSrc)
			if err := g.copyFile(srcPath, fullVarFileDstPath); err != nil {
				return err
			}
			changes = true
		} else {
			logger.Warn(fmt.Sprintf("%s file exists and will not overwrite it!", varFileDst), "git")
		}
	}

	dirty, err := g.IsDirty()
	if err != nil {
		return err
	}
	if dirty {
		changes = true
	}

	if changes {
		if err := g.AddAndCommit("idp-installer: auto-committing changes"); err != nil {
			return err
		}
		return g.Push()
	}

	logger.Info("No changes found in client tf repository", "git")
	return nil
}

// BootstrapArgo bootstraps the GitOps repository with infrastructure services.
func (g *GIT) BootstrapArgo(config *types.Configuration, argoTemplateRepo *GIT, infraFactsPath string, updateRepo bool, updateInfraFacts bool, logger *utils.Logger) error {
	logger.Info(fmt.Sprintf("Bootstrapping git-ops repository with infrastructure services into %s...", g.LocalPath), "git")
	changes := false
	ignoreFiles := []string{".git", "infra-services-argo-app.yaml"}

	if !g.FileExists("helm") {
		logger.Info("Initial argocd repo bootstrap", "git")
		if err := g.ClearRepoContents(); err != nil {
			return err
		}
		if err := g.CopyFiles(argoTemplateRepo.LocalPath, g.LocalPath, ignoreFiles); err != nil {
			return err
		}
		changes = true
	} else if updateRepo {
		logger.Info("Updating repo due to update flag", "git")
		if err := g.CopyFiles(argoTemplateRepo.LocalPath, g.LocalPath, ignoreFiles); err != nil {
			return err
		}
		changes = true
	} else {
		logger.Warn("helm/ directory exists and will not overwrite it!", "git")
	}

	helmChartsPath := filepath.Join(argoTemplateRepo.LocalPath, "helm")
	entries, err := os.ReadDir(helmChartsPath)
	if err != nil {
		return err
	}

	var allCharts []string
	for _, entry := range entries {
		if entry.IsDir() {
			allCharts = append(allCharts, entry.Name())
		}
	}

	var chartsFiltered []string
	for _, chart := range allCharts {
		if chart != "argo-cd" {
			chartsFiltered = append(chartsFiltered, chart)
		}
	}

	logger.Info(fmt.Sprintf("Distributing infra-facts as values files for charts: %v", chartsFiltered), "git")

	for _, chartDir := range chartsFiltered {
		valuesDst := filepath.Join(g.LocalPath, "helm", chartDir, "values", config.EnvironmentStage, config.AwsRegion)
		var valuesSrc string

		if chartDir == "infra-services" {
			valuesSrc = infraFactsPath
			valuesDst = filepath.Join(valuesDst, "infra-facts.yaml")
		} else {
			valuesSrc = filepath.Join(argoTemplateRepo.LocalPath, "helm", chartDir, "values.yaml")
			valuesDst = filepath.Join(valuesDst, "values.yaml")
		}

		if valuesSrc == infraFactsPath {
			data, err := os.ReadFile(valuesSrc)
			if err != nil {
				return err
			}
			var infraFacts map[string]interface{}
			if err := yaml.Unmarshal(data, &infraFacts); err != nil {
				return err
			}

			infraServices, ok := infraFacts["infra-services"].(map[string]interface{})
			if !ok {
				logger.Warn(fmt.Sprintf("Sanity check not passed. %s does not contain infra-services. Skipping.", valuesSrc), "git")
				continue
			}

			eksClusterName, _ := infraServices["eks_cluster_name"].(string)
			if len(eksClusterName) == 0 {
				logger.Warn(fmt.Sprintf("Sanity check not passed. %s does not contain eks_cluster_name. Skipping.", valuesSrc), "git")
				continue
			}
		}

		forceUpdateInfraFacts := valuesSrc == infraFactsPath && (updateInfraFacts || updateRepo)

		if forceUpdateInfraFacts || !g.fileExistsAbs(valuesDst) {
			if err := os.MkdirAll(filepath.Dir(valuesDst), 0755); err != nil {
				return err
			}
			if err := g.copyFile(valuesSrc, valuesDst); err != nil {
				return err
			}
			logger.Info(fmt.Sprintf("Copying values files to %s", valuesDst), "git")
			changes = true
		} else {
			logger.Warn(fmt.Sprintf("%s file exists and will not overwrite it!", valuesDst), "git")
		}
	}

	// ArgoCD custom values
	argocdHelmChartValuesPath := filepath.Join(g.LocalPath, "helm", "argo-cd", "values", config.EnvironmentStage, config.AwsRegion, "values.yaml")
	argocdUIDNS := fmt.Sprintf("%s-%s-argocd-%s.%s", config.ProjectName, config.AwsRegion, config.EnvironmentStage, config.DnsDomainName)
	argocdValuesData := map[string]interface{}{
		"server": map[string]interface{}{
			"ingress": map[string]interface{}{
				"annotations": map[string]interface{}{
					"external-dns.alpha.kubernetes.io/hostname": argocdUIDNS,
				},
				"hosts": []string{argocdUIDNS},
			},
		},
	}

	if updateRepo || !g.fileExistsAbs(argocdHelmChartValuesPath) {
		if err := os.MkdirAll(filepath.Dir(argocdHelmChartValuesPath), 0755); err != nil {
			return err
		}
		data, err := yaml.Marshal(argocdValuesData)
		if err != nil {
			return err
		}
		if err := os.WriteFile(argocdHelmChartValuesPath, data, 0644); err != nil {
			return err
		}
		changes = true
		logger.Info(fmt.Sprintf("Copying values files to %s", argocdHelmChartValuesPath), "git")
	} else {
		logger.Warn(fmt.Sprintf("%s file exists and will not overwrite it!", argocdHelmChartValuesPath), "git")
	}

	// Infra-services argo app
	logger.Info("Generating infra-services argo app", "git")
	infraServicesArgoAppPathSrc := filepath.Join(argoTemplateRepo.LocalPath, "infra-services-argo-app.yaml")
	infraServicesArgoAppPathDst := filepath.Join(g.LocalPath, "manifests", "applications", "infra-app-stages", config.EnvironmentStage, config.AwsRegion, "infra-services.yaml")

	renderContext := map[string]interface{}{
		"environment":             config.EnvironmentStage,
		"region":                  config.AwsRegion,
		"gitops_destination_repo": config.GitopsDestinationRepo,
	}

	if updateRepo || !g.fileExistsAbs(infraServicesArgoAppPathDst) {
		if err := g.renderTemplate(infraServicesArgoAppPathSrc, infraServicesArgoAppPathDst, renderContext); err != nil {
			return err
		}
		changes = true
		logger.Info(fmt.Sprintf("Copying infra-services argo app in %s", infraServicesArgoAppPathDst), "git")
	} else {
		logger.Warn(fmt.Sprintf("%s file exists and will not overwrite it!", infraServicesArgoAppPathDst), "git")
	}

	// Manifests Jinja2 templating
	logger.Info("Jinja2 templating manifests", "git")
	manifestsSrc := filepath.Join(argoTemplateRepo.LocalPath, "manifests")
	manifestsDst := filepath.Join(g.LocalPath, "manifests")

	err = filepath.Walk(manifestsSrc, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() {
			return nil
		}
		if strings.HasSuffix(path, ".yaml") || strings.HasSuffix(path, ".yml") {
			relPath, _ := filepath.Rel(manifestsSrc, path)
			yamlFileDst := filepath.Join(manifestsDst, relPath)

			if updateRepo || !g.fileExistsAbs(yamlFileDst) || g.containsPlaceholders(yamlFileDst) {
				if err := g.renderTemplate(path, yamlFileDst, renderContext); err != nil {
					return err
				}
				changes = true
				logger.Info(fmt.Sprintf("Jinja2 rendered: %s", yamlFileDst), "git")
			} else {
				logger.Warn(fmt.Sprintf("%s file exists and will not overwrite it!", yamlFileDst), "git")
			}
		}
		return nil
	})
	if err != nil {
		return err
	}

	dirty, err := g.IsDirty()
	if err != nil {
		return err
	}
	if dirty {
		changes = true
	}

	if changes {
		if err := g.AddAndCommit("idp-installer: auto-committing changes"); err != nil {
			return err
		}
		return g.Push()
	}

	logger.Info("No changes found in client argo repository", "git")
	return nil
}

// BootstrapAppRepo bootstraps the custom applications repository.
func (g *GIT) BootstrapAppRepo(config *types.Configuration, appTemplateRepo *GIT, applicationsFactsPath string, updateRepo bool, updateInfraFacts bool, logger *utils.Logger) error {
	logger.Info(fmt.Sprintf("Bootstrapping git-ops repository with custom applications into %s...", g.LocalPath), "git")
	changes := false
	ignoreFiles := []string{".git", "applications-argo-app.yaml"}

	if !g.FileExists("helm") {
		logger.Info("Initial applications repo bootstrap", "git")
		if err := g.ClearRepoContents(); err != nil {
			return err
		}
		if err := g.CopyFiles(appTemplateRepo.LocalPath, g.LocalPath, ignoreFiles); err != nil {
			return err
		}
		changes = true
	} else if updateRepo {
		logger.Info("Updating repo due to update flag", "git")
		if err := g.CopyFiles(appTemplateRepo.LocalPath, g.LocalPath, ignoreFiles); err != nil {
			return err
		}
		changes = true
	} else {
		logger.Warn("helm/ directory exists and will not overwrite it!", "git")
	}

	helmChartsPath := filepath.Join(appTemplateRepo.LocalPath, "helm")
	entries, err := os.ReadDir(helmChartsPath)
	if err != nil {
		return err
	}

	var allCharts []string
	for _, entry := range entries {
		if entry.IsDir() {
			allCharts = append(allCharts, entry.Name())
		}
	}

	logger.Info(fmt.Sprintf("Distributing infra-facts as values files for charts: %v", allCharts), "git")

	for _, chartDir := range allCharts {
		valuesDst := filepath.Join(g.LocalPath, "helm", chartDir, "values", config.EnvironmentStage, config.AwsRegion)
		var valuesSrc string

		if chartDir == "applications" {
			valuesSrc = applicationsFactsPath
			valuesDst = filepath.Join(valuesDst, "infra-facts.yaml")
		} else {
			valuesSrc = filepath.Join(appTemplateRepo.LocalPath, "helm", chartDir, "values.yaml")
			valuesDst = filepath.Join(valuesDst, "values.yaml")
		}

		if valuesSrc == applicationsFactsPath {
			data, err := os.ReadFile(valuesSrc)
			if err != nil {
				return err
			}
			var infraFacts map[string]interface{}
			if err := yaml.Unmarshal(data, &infraFacts); err != nil {
				return err
			}

			infraServices, ok := infraFacts["infra-services"].(map[string]interface{})
			if !ok {
				logger.Warn(fmt.Sprintf("Sanity check not passed. %s does not contain infra-services. Skipping.", valuesSrc), "git")
				continue
			}

			eksClusterName, _ := infraServices["eks_cluster_name"].(string)
			if len(eksClusterName) == 0 {
				logger.Warn(fmt.Sprintf("Sanity check not passed. %s does not contain eks_cluster_name. Skipping.", valuesSrc), "git")
				continue
			}
		}

		forceUpdateInfraFacts := valuesSrc == applicationsFactsPath && (updateInfraFacts || updateRepo)

		if forceUpdateInfraFacts || !g.fileExistsAbs(valuesDst) {
			if err := os.MkdirAll(filepath.Dir(valuesDst), 0755); err != nil {
				return err
			}
			if err := g.copyFile(valuesSrc, valuesDst); err != nil {
				return err
			}
			logger.Info(fmt.Sprintf("Copying values files to %s", valuesDst), "git")
			changes = true
		} else {
			logger.Warn(fmt.Sprintf("%s file exists and will not overwrite it!", valuesDst), "git")
		}
	}

	// Applications argo app
	logger.Info("Generating applications argo app", "git")
	applicationsArgoAppPathSrc := filepath.Join(appTemplateRepo.LocalPath, "applications-argo-app.yaml")
	applicationsArgoAppPathDst := filepath.Join(g.LocalPath, "manifests", "applications", "applications-app-stages", config.EnvironmentStage, config.AwsRegion, "applications.yaml")

	renderContext := map[string]interface{}{
		"environment":                   config.EnvironmentStage,
		"region":                        config.AwsRegion,
		"applications_destination_repo": config.ApplicationsDestinationRepo,
	}

	if updateRepo || !g.fileExistsAbs(applicationsArgoAppPathDst) {
		if err := g.renderTemplate(applicationsArgoAppPathSrc, applicationsArgoAppPathDst, renderContext); err != nil {
			return err
		}
		changes = true
		logger.Info(fmt.Sprintf("Copying applications argo app in %s", applicationsArgoAppPathDst), "git")
	} else {
		logger.Warn(fmt.Sprintf("%s file exists and will not overwrite it!", applicationsArgoAppPathDst), "git")
	}

	// Manifests Jinja2 templating
	logger.Info("Jinja2 templating manifests", "git")
	manifestsSrc := filepath.Join(appTemplateRepo.LocalPath, "manifests")
	manifestsDst := filepath.Join(g.LocalPath, "manifests")

	err = filepath.Walk(manifestsSrc, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() {
			return nil
		}
		if strings.HasSuffix(path, ".yaml") || strings.HasSuffix(path, ".yml") {
			relPath, _ := filepath.Rel(manifestsSrc, path)
			yamlFileDst := filepath.Join(manifestsDst, relPath)

			if updateRepo || !g.fileExistsAbs(yamlFileDst) || g.containsPlaceholders(yamlFileDst) {
				if err := g.renderTemplate(path, yamlFileDst, renderContext); err != nil {
					return err
				}
				changes = true
				logger.Info(fmt.Sprintf("Jinja2 rendered: %s", yamlFileDst), "git")
			} else {
				logger.Warn(fmt.Sprintf("%s file exists and will not overwrite it!", yamlFileDst), "git")
			}
		}
		return nil
	})
	if err != nil {
		return err
	}

	dirty, err := g.IsDirty()
	if err != nil {
		return err
	}
	if dirty {
		changes = true
	}

	if changes {
		if err := g.AddAndCommit("idp-installer: auto-committing changes"); err != nil {
			return err
		}
		return g.Push()
	}

	logger.Info("No changes found in client applications repository", "git")
	return nil
}

func (g *GIT) copyFile(src, dst string) error {
	srcFile, err := os.Open(src)
	if err != nil {
		return err
	}
	defer srcFile.Close()

	dstFile, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer dstFile.Close()

	_, err = io.Copy(dstFile, srcFile)
	return err
}

func (g *GIT) fileExistsAbs(path string) bool {
	_, err := os.Stat(path)
	return !os.IsNotExist(err)
}

func (g *GIT) containsPlaceholders(path string) bool {
	data, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	return strings.Contains(string(data), "{{")
}

func (g *GIT) renderTemplate(srcPath string, dstPath string, context map[string]interface{}) error {
	tpl, err := pongo2.FromFile(srcPath)
	if err != nil {
		return fmt.Errorf("failed to load template %s: %w", srcPath, err)
	}

	out, err := tpl.Execute(pongo2.Context(context))
	if err != nil {
		return fmt.Errorf("failed to execute template %s: %w", srcPath, err)
	}

	if err := os.MkdirAll(filepath.Dir(dstPath), 0755); err != nil {
		return fmt.Errorf("failed to create directory for %s: %w", dstPath, err)
	}

	return os.WriteFile(dstPath, []byte(out), 0644)
}

