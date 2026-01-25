package state

import (
	"fmt"
	"os"
	"path/filepath"
	"reflect"

	"github.com/bobikenobi12/bb-thesis-2026/apps/cli/types"
	"github.com/bobikenobi12/bb-thesis-2026/apps/cli/utils"
	"gopkg.in/yaml.v3"
)

type State struct {
	SensitiveVars []string
}

func NewState() *State {
	return &State{
		SensitiveVars: []string{"applications_argo_access_token", "gitops_argo_access_token"},
	}
}

func (s *State) SaveInfraFacts(config *types.Configuration, outputs map[string]interface{}, dryRun bool, logger *utils.Logger) error {
	logger.Info("Saving infra-facts.yaml", "state")
	toYAML := make(map[string]interface{})

	// Include variables from the config
	v := reflect.ValueOf(*config)
	t := v.Type()

	for i := 0; i < v.NumField(); i++ {
		// Use the json tag as key if available
		key := t.Field(i).Tag.Get("json")
		if key == "" {
			key = t.Field(i).Name
		}

		// Filter sensitive vars
		isSensitive := false
		for _, sv := range s.SensitiveVars {
			if key == sv {
				isSensitive = true
				break
			}
		}

		if isSensitive {
			continue
		}

		val := v.Field(i).Interface()
		switch val.(type) {
		case float64, string, int, bool:
			toYAML[key] = val
		}
	}

	// Include terraform outputs
	if outputs != nil && len(outputs) > 0 {
		logger.Info("Including terraform outputs.", "state")
		for key, output := range outputs {
			// Terraform outputs usually come as a map with "value" key
			if m, ok := output.(map[string]interface{}); ok {
				if val, ok := m["value"]; ok {
					toYAML[key] = val
				} else {
					toYAML[key] = output
				}
			} else {
				toYAML[key] = output
			}
		}
	} else {
		if dryRun {
			logger.Warn("No Terraform outputs found. This is expected in dry-run mode.", "state")
		} else {
			return fmt.Errorf("no Terraform outputs found in non-dry-run mode")
		}
	}

	finalMap := map[string]interface{}{
		"infra-services": toYAML,
	}

	yamlData, err := yaml.Marshal(finalMap)
	if err != nil {
		return fmt.Errorf("failed to marshal state to YAML: %w", err)
	}

	tempDir := "temp"
	if err := os.MkdirAll(tempDir, 0755); err != nil {
		return fmt.Errorf("failed to create temp directory: %w", err)
	}

	outputPath := filepath.Join(tempDir, "infra-facts.yaml")
	if err := os.WriteFile(outputPath, yamlData, 0644); err != nil {
		return fmt.Errorf("failed to write infra-facts.yaml: %w", err)
	}

	logger.Info(fmt.Sprintf("Saved infra-facts.yaml to %s", outputPath), "state")
	return nil
}
