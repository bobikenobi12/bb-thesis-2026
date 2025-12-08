package cmd

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/bobikenobi12/bb-thesis-2026/apps/cli/types"
)

func getCredentialsPath() (string, error) {
	configDir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(configDir, "grape", "credentials.json"), nil
}

func getAuthToken() (string, error) {
	credsPath, err := getCredentialsPath()
	if err != nil {
		return "", fmt.Errorf("error getting credentials path: %w", err)
	}

	if _, err := os.Stat(credsPath); os.IsNotExist(err) {
		return "", fmt.Errorf("you are not logged in. Please run `grape login`")
	}

	file, err := os.ReadFile(credsPath)
	if err != nil {
		return "", fmt.Errorf("error reading credentials file: %w", err)
	}

	var creds types.ExchangeResponse
	if err := json.Unmarshal(file, &creds); err != nil {
		return "", fmt.Errorf("error parsing credentials file: %w", err)
	}

	if creds.AccessToken == "" {
		return "", fmt.Errorf("invalid credentials file. Please run `grape login` again")
	}

	return creds.AccessToken, nil
}