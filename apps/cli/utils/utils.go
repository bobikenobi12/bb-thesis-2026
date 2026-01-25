package utils

import (
	"bufio"
	"bytes"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"

	"github.com/bobikenobi12/bb-thesis-2026/apps/cli/api"
)

// Logger provides logging to both the console and the API.
type Logger struct {
	apiClient    *api.Client
	deploymentID string
}

// NewLogger creates a new Logger.
func NewLogger(apiClient *api.Client, deploymentID string) *Logger {
	return &Logger{
		apiClient:    apiClient,
		deploymentID: deploymentID,
	}
}

// Info logs an informational message.
func (l *Logger) Info(message, step string) {
	fmt.Println(message)
	if l.apiClient != nil {
		l.apiClient.SendLog(l.deploymentID, api.LogEntry{Message: message, Level: "info", Step: step})
	}
}

// Warn logs a warning message.
func (l *Logger) Warn(message, step string) {
	fmt.Printf("Warning: %s\n", message)
	if l.apiClient != nil {
		l.apiClient.SendLog(l.deploymentID, api.LogEntry{Message: message, Level: "warn", Step: step})
	}
}

// Error logs an error message.
func (l *Logger) Error(message, step string) {
	fmt.Printf("Error: %s\n", message)
	if l.apiClient != nil {
		l.apiClient.SendLog(l.deploymentID, api.LogEntry{Message: message, Level: "error", Step: step})
	}
}

func ExecuteCommand(command string, dir string, env []string) error {
	cmd := exec.Command("bash", "-c", command)
	cmd.Dir = dir
	cmd.Env = os.Environ() // Start with current environment
	cmd.Env = append(cmd.Env, env...) // Add custom environment variables

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return fmt.Errorf("error creating stdout pipe: %w", err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return fmt.Errorf("error creating stderr pipe: %w", err)
	}

	if err := cmd.Start(); err != nil {
		return fmt.Errorf("error starting command: %w", err)
	}

	var stdoutBuf, stderrBuf bytes.Buffer
	stdoutPipe := io.TeeReader(stdout, &stdoutBuf)
	stderrPipe := io.TeeReader(stderr, &stderrBuf)

	go func() {
		scanner := bufio.NewScanner(stdoutPipe)
		for scanner.Scan() {
			fmt.Println(scanner.Text())
		}
	}()

	go func() {
		scanner := bufio.NewScanner(stderrPipe)
		for scanner.Scan() {
			fmt.Println(scanner.Text())
		}
	}()

	if err := cmd.Wait(); err != nil {
		return fmt.Errorf("command returned non-zero exit code: %w, stderr: %s", err, strings.TrimSpace(stderrBuf.String()))
	}

	return nil
}

func ExecuteCommandWithOutput(command string, dir string, env []string) (string, error) {
	cmd := exec.Command("bash", "-c", command)
	cmd.Dir = dir
	cmd.Env = os.Environ() // Start with current environment
	cmd.Env = append(cmd.Env, env...) // Add custom environment variables

	var stdoutBuf, stderrBuf bytes.Buffer
	cmd.Stdout = &stdoutBuf
	cmd.Stderr = &stderrBuf

	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("command failed: %w, stderr: %s", err, stderrBuf.String())
	}

	return stdoutBuf.String(), nil
}
