package cmd

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/bobikenobi12/bb-thesis-2026/apps/cli/types"
	"github.com/golang-jwt/jwt/v5"
	"github.com/imroc/req/v3"
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

	// Check expiration
	claims := jwt.MapClaims{}
	_, _, err = jwt.NewParser().ParseUnverified(creds.AccessToken, claims)
	if err != nil {
		return "", fmt.Errorf("error parsing token: %w", err)
	}

	var exp int64
	switch v := claims["exp"].(type) {
	case float64:
		exp = int64(v)
	case json.Number:
		exp, _ = v.Int64()
	}

	// If expired (or expiring in < 1 minute), try to refresh
	if time.Unix(exp, 0).Before(time.Now().Add(1 * time.Minute)) {
		if creds.RefreshToken == "" {
			return "", fmt.Errorf("token expired and no refresh token found. Please run `grape login` again")
		}
		
		fmt.Println("Access token expired, refreshing...")
		newAccessToken, err := refreshAccessToken(creds.RefreshToken)
		if err != nil {
			return "", fmt.Errorf("failed to refresh token: %w. Please run `grape login` again", err)
		}

		creds.AccessToken = newAccessToken
		if err := saveCredentials(credsPath, creds); err != nil {
			return "", fmt.Errorf("failed to save new credentials: %w", err)
		}
		
		return newAccessToken, nil
	}

	return creds.AccessToken, nil
}

func refreshAccessToken(refreshToken string) (string, error) {
	webOrigin := os.Getenv("GRAPE_WEB_ORIGIN")
	if webOrigin == "" {
		webOrigin = "https://localhost:3000"
	}
	refreshURL := fmt.Sprintf("%s/api/auth/cli/refresh", webOrigin)

	client := req.C()
	var result struct {
		AccessToken string `json:"access_token"`
	}
	var errMsg struct {
		Error string `json:"error"`
	}

	resp, err := client.R().
		SetBody(map[string]string{"refresh_token": refreshToken}).
		SetSuccessResult(&result).
		SetErrorResult(&errMsg).
		Post(refreshURL)

	if err != nil {
		return "", err
	}

	if resp.IsErrorState() {
		return "", fmt.Errorf("server returned %d: %s", resp.StatusCode, errMsg.Error)
	}

	return result.AccessToken, nil
}

func saveCredentials(path string, creds types.ExchangeResponse) error {
	file, err := os.Create(path)
	if err != nil {
		return err
	}
	defer file.Close()

	encoder := json.NewEncoder(file)
	encoder.SetIndent("", "  ")
	return encoder.Encode(creds)
}