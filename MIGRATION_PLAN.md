# Migration Plan: From Python CLI to Go CLI with Charm

This document outlines the plan to migrate the existing Python-based `idp-installer` to a Go-based CLI application, leveraging the Charm ecosystem for a more sophisticated and user-friendly experience. The new CLI will also integrate with Supabase for configuration management and feature a secure, web-based authentication flow.

## 1. Project Structure

The Go project will follow a standard layout to ensure maintainability and scalability:

```
/idp-installer-go
├──/cmd
│  └──/idp-installer    # Main application entry point
│     └── main.go
├──/internal
│  ├──/agent            # Main business logic orchestrating the installation
│  ├──/auth             # Handles the web-based authentication flow
│  ├──/backend          # Supabase client and data fetching logic
│  ├──/cli              # Bubble Tea UI components and views
│  ├──/config           # Configuration loading and management (from file & Supabase)
│  ├──/git              # Git repository management
│  ├──/helm             # Helm chart management
│  ├──/k8s              # Kubernetes client and operations
│  ├──/platform         # AWS, and other cloud provider interactions
│  ├──/state            # State management for the installation process
│  └──/terraform        # Terraform command execution and parsing
├──/pkg
│  └──/api              # API definitions for Supabase interactions
├──go.mod
├──go.sum
└──README.md
```

## 2. Core Functionality Migration

The existing Python modules will be mapped to Go packages. Here's a breakdown of the migration strategy for each module:

| Python Module | Go Package/Library | Description |
|---|---|---|
| `arg_parser.py` | `cobra` | The `cobra` library will be used for command-line argument parsing and command structure. |
| `aws.py` | `aws-sdk-go-v2` | The official AWS SDK for Go will be used for all interactions with AWS services like S3 and EKS. |
| `config.py` | `viper` | `viper` will be used to read and manage the YAML configuration files. |
| `git_utils.py` | `go-git` | The `go-git` library will be used for cloning and managing git repositories. |
| `helm.py` | `helm.sh/helm/v3/pkg/action` | The official Helm Go client will be used to install and manage Helm charts. |
| `k8s.py` | `k8s.io/client-go` | The official Kubernetes Go client will be used for all interactions with the Kubernetes API. |
| `terraform.py`| `go-tfexec` | HashiCorp's official `go-tfexec` library will be used to execute Terraform commands. |
| `logs.py` | `charm/log` | We'll use Charm's logging library for beautiful and structured logging in the CLI. |
| `state.py` | `internal/state` | A custom package will be created to manage the state of the installation, potentially using a local file or Supabase. |

## 3. Charm CLI Integration

We will use the Charm ecosystem to create a modern and interactive CLI:

*   **`Bubble Tea`**: The core of our UI. We will use it to build a stateful, responsive, and interactive interface. The CLI will have different "views" for different stages of the installation process (e.g., configuration, plan, apply, logs).
*   **`Lipgloss`**: For styling the UI with colors, borders, and layouts.
*   **`Bubbles`**: A collection of ready-to-use Bubble Tea components like spinners, text inputs, and progress bars.
*   **`Glamour`**: To render Markdown in the CLI, which can be used for displaying help text or reports.

The main view could be a dashboard that shows the status of each step: Git repository cloning, Terraform plan, Terraform apply, Helm deployments, etc. Each step could have its own detailed view with logs.

## 4. Authentication Flow

The authentication will be handled via a web flow to provide a secure and user-friendly experience.

1.  **`idp-installer login`**: The user runs this command in the CLI.
2.  **Device Authorization Grant Flow**: The CLI will initiate a device authorization grant flow with your authentication provider (e.g., Auth0, Okta, or a custom Supabase solution).
3.  **Display URL and Code**: The CLI will display a URL and a user code.
4.  **User Authentication**: The user opens the URL in their browser, logs in, and enters the code to authorize the device.
5.  **Token Exchange**: The CLI will poll the authentication provider for an access token.
6.  **Store Token**: Once the user has authorized the device, the CLI will receive an access token and store it securely on the local machine (e.g., in the system keychain).

This flow is more secure than storing credentials in plain text and provides a better user experience.

## 5. Supabase Integration

Supabase will be used as a backend for the CLI:

*   **Configuration Storage**: Users can store their configuration files in a Supabase database. The CLI will be able to fetch these configurations.
*   **`idp-installer config list`**: This command will list all the configurations for the authenticated user.
*   **`idp-installer config get <config-name>`**: This command will fetch a specific configuration and use it for the installation.
*   **Real-time Logs**: We can use Supabase's real-time capabilities to stream logs from the installation process to a web frontend.

The CLI will use the `supabase-go` library to interact with the Supabase API.

## 6. Real-time Logging

We will implement real-time logging for both the CLI and a potential Next.js web frontend.

*   **CLI Logging**: The `charm/log` library will be used to display logs in the CLI. We can have a dedicated "logs" view in our Bubble Tea application that streams logs from the different components (Terraform, Helm, etc.).
*   **Web Frontend Logging**:
    1.  The Go CLI will be able to stream logs to a websocket.
    2.  This websocket could be a Supabase Realtime channel.
    3.  A Next.js frontend can connect to this channel and display the logs in real-time.

This will allow users to monitor the installation process from both the CLI and a web browser.

## 7. Recommended Go Libraries

*   **CLI**:
    *   `github.com/charmbracelet/bubbletea`
    *   `github.com/charmbracelet/lipgloss`
    *   `github.com/charmbracelet/bubbles`
    *   `github.com/charmbracelet/glamour`
    *   `github.com/charmbracelet/log`
    *   `github.com/spf13/cobra`
*   **Cloud & DevOps**:
    *   `github.com/aws/aws-sdk-go-v2`
    *   `k8s.io/client-go`
    *   `helm.sh/helm/v3`
    *   `github.com/hashicorp/go-tfexec`
    *   `github.com/go-git/go-git/v5`
*   **Backend & Config**:
    *   `github.com/supabase-community/supabase-go`
    *   `github.com/spf13/viper`
*   **Authentication**:
    *   `golang.org/x/oauth2`

## 8. Development Roadmap

1.  **Phase 1: Core Functionality**
    *   Set up the project structure and basic CLI with Cobra.
    *   Implement the core logic for interacting with Git, Terraform, Helm, and Kubernetes.
    *   Replicate the existing `idp-installer` functionality without the interactive UI.
2.  **Phase 2: Charm CLI Integration**
    *   Integrate Bubble Tea and create the interactive UI.
    *   Build the different views for the installation process.
    *   Style the UI with Lipgloss.
3.  **Phase 3: Authentication and Supabase Integration**
    *   Implement the web-based authentication flow.
    *   Integrate with Supabase to fetch and manage configurations.
4.  **Phase 4: Real-time Logging**
    *   Implement real-time logging in the CLI.
    *   Set up the websocket for streaming logs to a web frontend.

This plan provides a comprehensive overview of the migration process. By leveraging Go and the Charm ecosystem, we can create a powerful, user-friendly, and maintainable CLI application.
