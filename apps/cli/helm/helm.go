package helm

import (
	"fmt"
	"strings"
	"time"

	"github.com/bobikenobi12/bb-thesis-2026/apps/cli/utils"
)

type HelmCLI struct {
	DryRun bool
}

func NewHelmCLI(dryRun bool) *HelmCLI {
	return &HelmCLI{
		DryRun: dryRun,
	}
}

func (h *HelmCLI) UpgradeInstall(releaseName, chartDir, namespace, valuesFile string, env map[string]string, setJSON string, logger *utils.Logger) error {
	cmd := fmt.Sprintf("helm upgrade --install --create-namespace %s %s -n %s -f %s", releaseName, chartDir, namespace, valuesFile)

	if setJSON != "" {
		cmd += fmt.Sprintf(" --set-json '%s'", setJSON)
	}

	logger.Info("Running helm upgrade command", "helm")

	serverDryRunCmd := cmd + " --dry-run=server"
	templateCmd := strings.Replace(cmd, "upgrade --install", "template", 1)

	envList := make([]string, 0, len(env))
	for k, v := range env {
		envList = append(envList, fmt.Sprintf("%s=%s", strings.ToUpper(k), v))
	}

	// Retry logic
	maxRetries := 3
	var lastErr error

	for i := 0; i < maxRetries; i++ {
		if i > 0 {
			logger.Info(fmt.Sprintf("Retrying helm operation (attempt %d/%d)...", i+1, maxRetries), "helm")
			time.Sleep(5 * time.Second)
		}

		if h.DryRun {
			logger.Info("Performing server-side dry-run...", "helm")
			err := utils.ExecuteCommand(serverDryRunCmd, ".", envList)
			if err != nil {
				logger.Warn("Server-side dry-run failed. Falling back to helm template rendering...", "helm")
				err = utils.ExecuteCommand(templateCmd, ".", envList)
				if err != nil {
					lastErr = fmt.Errorf("helm template rendering failed: %w", err)
					continue // Retry loop doesn't make much sense for template rendering but keeping structure
				}
				logger.Info("Helm template rendering succeeded.", "helm")
				return nil
			} else {
				logger.Info("Server-side dry-run succeeded.", "helm")
				return nil
			}
		} else {
			logger.Info("Performing server-side dry-run before actual execution...", "helm")
			err := utils.ExecuteCommand(serverDryRunCmd, ".", envList)
			if err != nil {
				lastErr = fmt.Errorf("server-side dry-run failed: %w", err)
				logger.Warn(fmt.Sprintf("Dry-run failed: %v", err), "helm")
				continue // Retry
			}
			logger.Info("Server-side dry-run succeeded. Proceeding with actual command.", "helm")

			err = utils.ExecuteCommand(cmd, ".", envList)
			if err != nil {
				lastErr = fmt.Errorf("helm upgrade install failed: %w", err)
				logger.Warn(fmt.Sprintf("Install failed: %v", err), "helm")
				continue // Retry
			}
			
			return nil // Success
		}
	}

	return lastErr
}
