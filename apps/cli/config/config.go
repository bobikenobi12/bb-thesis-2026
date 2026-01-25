package config

import (
	"fmt"
	"os"

	"github.com/bobikenobi12/bb-thesis-2026/apps/cli/types"
	"gopkg.in/yaml.v3"
)

func LoadInstallerConfig(filePath string) (*types.InstallerConfig, error) {
	if filePath == "" {
		return nil, fmt.Errorf("config file path cannot be empty")
	}

	buf, err := os.ReadFile(filePath)
	if err != nil {
		return nil, fmt.Errorf("error reading config file: %w", err)
	}

	var config types.InstallerConfig
	err = yaml.Unmarshal(buf, &config)
	if err != nil {
		return nil, fmt.Errorf("error parsing config file: %w", err)
	}

	return &config, nil
}
