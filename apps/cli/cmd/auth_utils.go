// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"crypto/rand"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/golang-jwt/jwt/v5"
	"github.com/imroc/req/v3"
)

// credentialsFileMode is the permission mode of the CLI credentials file. It holds the
// live access token, the 90-day refresh token and the raw git-provider OAuth token, so
// it is owner read/write only — never group- or world-readable. os.Create asks for 0666
// and leaves the result to the caller's umask (0644 under the common 022), which on a
// shared box, a CI runner or a container layer lets any other local uid read the bearer
// and act as the user. Matches utils.SecretFileMode and the 0600 the CLI already uses
// for its non-secret config and the update cache.
const credentialsFileMode os.FileMode = 0o600

// userCodeAlphabet is RFC 8628 §6.1's recommended character set — upper-case consonants,
// so it spells no words and carries no digits — minus L, which is read back as 1 as often
// as I and O are read back as 1 and 0. No 0/O, no 1/I/L, nothing a user can mistype.
const userCodeAlphabet = "BCDFGHJKMNPQRSTVWXZ"

// userCodeLength is how many alphabet characters a user_code carries (excluding the
// separator): 19^8 ≈ 1.7e10 combinations, short enough to read off a terminal.
const userCodeLength = 8

func getCredentialsPath() (string, error) {
	configDir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(configDir, "alethia", "credentials.json"), nil
}

func getAuthToken() (string, error) {
	return getAuthTokenInternal(true)
}

// ServiceTokenEnv is the environment variable a NON-INTERACTIVE caller sets instead of logging in.
//
// This is the whole mechanism behind "drive Alethia from your own CI". Before it, the only way in
// was the device flow — `alethia login` opens a browser and waits for a human to approve — which is
// the right experience at a terminal and an impossible one in a pipeline. `--no-input` did not help:
// it suppresses PROMPTS, it does not supply a credential, so a pipeline still failed with
// "authentication required. Please run `alethia login`".
const ServiceTokenEnv = "ALETHIA_TOKEN"

// serviceTokenFlag is the --token value, set by the root command's persistent flag. The flag WINS
// over the environment, matching every other tool's precedence: the more specific, more deliberate
// source is the one nearer the invocation.
var serviceTokenFlag string

// serviceToken returns the non-interactive credential, if one was supplied.
//
// Trimmed, because a token pasted into a CI secret picks up a trailing newline more often than not,
// and a credential that fails for an invisible reason is the worst kind to debug.
func serviceToken() string {
	if t := strings.TrimSpace(serviceTokenFlag); t != "" {
		return t
	}
	return strings.TrimSpace(os.Getenv(ServiceTokenEnv))
}

func getAuthTokenInternal(promptLogin bool) (string, error) {
	// A supplied token SHORT-CIRCUITS the whole credentials-file dance: no file is read, no refresh
	// is attempted, nothing is written to disk. That is the point — a CI runner has no home
	// directory worth persisting to, and a credential written to one is a credential left behind.
	//
	// It is checked FIRST so that setting it works even on a machine that happens to have a stale
	// credentials.json: an explicit credential must not be silently outranked by an implicit one.
	if t := serviceToken(); t != "" {
		return t, nil
	}

	credsPath, err := getCredentialsPath()
	if err != nil {
		return "", fmt.Errorf("error getting credentials path: %w", err)
	}

	needsLogin := false

	if _, err := os.Stat(credsPath); os.IsNotExist(err) {
		needsLogin = true
	} else {
		file, err := os.ReadFile(credsPath)
		if err != nil {
			return "", fmt.Errorf("error reading credentials file: %w", err)
		}

		var creds types.ExchangeResponse
		if err := json.Unmarshal(file, &creds); err != nil {
			needsLogin = true
		} else if creds.AccessToken == "" {
			needsLogin = true
		} else {
			// Check expiration
			claims := jwt.MapClaims{}
			_, _, err = jwt.NewParser().ParseUnverified(creds.AccessToken, claims)
			if err != nil {
				needsLogin = true
			} else {
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
						needsLogin = true
					} else {
						// STDERR, not stdout. This line is a diagnostic about the session, not
						// part of the answer the command was asked for: on stdout it lands INSIDE
						// `alethia jobs list -o json > jobs.json` whenever the stored token happens
						// to be in its last minute, and the file no longer parses. Which stream a
						// line goes to is the contract — the document on stdout, everything
						// transient on stderr, where a pipe and a `-o json` parse never see it.
						fmt.Fprintln(os.Stderr, "Access token expired, refreshing...")
						newAccessToken, err := refreshAccessToken(creds.RefreshToken)
						if err != nil {
							needsLogin = true
						} else {
							creds.AccessToken = newAccessToken
							if err := saveCredentials(credsPath, creds); err != nil {
								return "", fmt.Errorf("failed to save new credentials: %w", err)
							}
							return newAccessToken, nil
						}
					}
				} else {
					return creds.AccessToken, nil
				}
			}
		}
	}

	if needsLogin {
		// The interactive "log in now?" prompt + device flow is irreducible TUI
		// glue (see resolveLogin in login.go); keep it out of this token-state logic.
		return resolveLogin(credsPath, promptLogin)
	}

	return "", fmt.Errorf("unexpected authentication state")
}

func refreshAccessToken(refreshToken string) (string, error) {
	refreshURL := fmt.Sprintf("%s/api/auth/cli/refresh", WebOrigin())

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

	// Fail closed on a 2xx that carries no token. A captive-portal 200, a content-type
	// change or a schema drift would otherwise yield ("", nil) — and getAuthTokenInternal
	// would take its success branch, persist the empty token over the stored credential
	// and hand the caller an `Authorization: Bearer ` header.
	if result.AccessToken == "" {
		return "", fmt.Errorf("refresh succeeded (HTTP %d) but returned no access_token", resp.StatusCode)
	}

	return result.AccessToken, nil
}

// saveCredentials writes creds to path with owner-only (0600) permissions. It also
// tightens an already-existing looser file, so a credentials.json an older CLI created
// world-readable is repaired the first time a token refresh writes through here.
func saveCredentials(path string, creds types.ExchangeResponse) error {
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, credentialsFileMode)
	if err != nil {
		return err
	}
	defer file.Close()

	// O_CREATE applies the mode only to a file it actually creates. Best-effort chmod:
	// on a filesystem without POSIX modes the write is what matters.
	_ = file.Chmod(credentialsFileMode)

	encoder := json.NewEncoder(file)
	encoder.SetIndent("", "  ")
	return encoder.Encode(creds)
}

// newUserCode returns a fresh RFC 8628 user_code — eight characters from an unambiguous
// alphabet, hyphenated in the middle so it reads back cleanly ("BCDF-GHJK"). The CLI
// prints it next to the login URL and the browser shows the code it is about to approve,
// so a user handed a phished device-code link can see it is not the one their terminal
// printed and refuse.
//
// The modulo is very slightly biased (256 mod 19 ≠ 0). That is deliberate and harmless:
// the user_code is a value a human compares, not the credential — the device_code is
// still a 122-bit UUID, and the code is useless without it.
func newUserCode() string {
	buf := make([]byte, userCodeLength)
	// crypto/rand.Read never returns an error — it fills the buffer entirely or panics —
	// so there is no error arm to handle here.
	_, _ = rand.Read(buf)

	out := make([]byte, 0, userCodeLength+1)
	for i, b := range buf {
		if i == userCodeLength/2 {
			out = append(out, '-')
		}
		out = append(out, userCodeAlphabet[int(b)%len(userCodeAlphabet)])
	}
	return string(out)
}
