# Current Features and Architecture Analysis

## 1. Executive Summary
The project is a **Hybrid Cloud Orchestration System** designed to streamline the provisioning and management of Kubernetes-based infrastructure (AWS EKS) and GitOps workflows (ArgoCD). It consists of two main components:
1.  **Grape CLI:** A Go-based command-line tool for developers/ops to interact with the platform.
2.  **Web Control Plane:** A Next.js application acting as the central dashboard, API, and state manager (backed by Supabase/PostgreSQL).

The system enforces a "Golden Path" for infrastructure by using opinionated Terraform templates and GitOps repositories.

## 2. Component Breakdown

### 2.1. Grape CLI (`apps/cli`)
The CLI is the primary entry point for users to bootstrap infrastructure.
**Tech Stack:** Go, Cobra (CLI framework), BubbleTea/Huh (TUI), Terraform (embedded/exec), Git (go-git).

**Key Features:**
*   **Authentication:**
    *   Implements **Device Flow** (OAuth 2.0 extension) to authenticate against the Web App.
    *   Commands: `grape login`, `grape logout`.
    *   Stores tokens locally in `~/.config/grape/credentials.json`.
    *   Auto-refresh logic for expired access tokens.
*   **Configuration Wizard:**
    *   Interactive TUI (Terminal User Interface) to gather project requirements:
        *   Project Name, Environment (dev/stage/prod), Region.
        *   Platform selection (Standard / AI Workloads).
        *   Git Provider selection (GitHub, GitLab, Bitbucket).
        *   Network settings (VPC CIDR, DNS, WAF).
        *   Database settings (Aurora Capacity).
    *   Command: `grape config create`.
*   **Deployment Orchestration:**
    *   **GitOps Bootstrapping:**
        *   Clones "Template Repositories" (Infra & GitOps).
        *   Renders templates (using Pongo2/Jinja2 syntax) with user configuration.
        *   Pushes generated code to new "Client Repositories" in the user's Git provider.
    *   **Infrastructure Provisioning:**
        *   Runs `terraform init`, `plan`, `apply` locally within the CLI.
        *   Uploads Terraform State to S3 (bootstrapped by the CLI).
    *   **Cost Estimation:**
        *   Integrates with **Infracost** to estimate cloud costs based on the Terraform plan.
    *   **Kubernetes Bootstrapping:**
        *   Uses `kubectl` and `helm` (embedded/exec) to install ArgoCD and the "App of Apps" pattern into the new EKS cluster.
    *   Command: `grape deploy <project_name>`.

### 2.2. Web Control Plane (`apps/web`)
The web application serves as the source of truth for configurations and deployments.
**Tech Stack:** Next.js (App Router), Supabase (PostgreSQL + Auth), TypeScript.

**Key Features:**
*   **API Layer:**
    *   `/api/auth`: Handles CLI device flow login.
    *   `/api/configurations`: CRUD for project configurations.
    *   `/api/deployments`: Records deployment attempts, status, logs, and outputs.
    *   `/api/repositories`: Proxy for Git provider operations (create repo).
*   **Data Model (PostgreSQL):**
    *   **`profiles`**: User identities linked to Supabase Auth.
    *   **`configurations`**: Stores infrastructure specs (Project Name, VPC settings, enabled features, git repo URLs).
    *   **`deployments`**: History of CLI runs. Links to a configuration. Tracks status (`pending`, `applied`, `failed`), IaC tool used, and resulting outputs (Terraform state file location, EKS endpoint).
    *   **`deployment_logs`**: Streaming logs from the CLI during deployment for audit/visibility.
    *   **`cli_logins`**: Temporary state for device code authentication flow.

### 2.3. Infrastructure Templates (`apps/cli/git/...`)
The system relies on "Golden Templates" to generate code.

*   **`template_repo` (Terraform):**
    *   Modular AWS infrastructure: VPC, EKS, RDS Aurora, Redis (ElastiCache), WAF, ECR, S3, IAM Roles (IRSA).
    *   Uses standard `terraform-aws-modules` plus custom internal modules (`itgix/tf-module-*`).
    *   Features: Karpenter (Auto-scaling), External DNS, External Secrets.
*   **`template_argo_repo` (GitOps/Helm):**
    *   **`infra-services`**: Helm chart defining core cluster services (ArgoCD, Ingress Controller, Metrics Server, Prometheus/Grafana, FluentBit, Tempo, Loki, Karpenter, Kyverno).
    *   **`applications`**: Pattern for deploying custom business applications (Demo Apps included).
    *   **`app-of-apps`**: ArgoCD Application pattern to manage the entire cluster state declaratively.

## 3. Workflow & Data Flow

1.  **Init:** User runs `grape login`. CLI polls Web API until user approves via browser. CLI receives Auth Token.
2.  **Config:** User runs `grape config create`. CLI prompts inputs -> Sends JSON payload to Web API -> Web API saves to `configurations` table.
3.  **Deploy:** User runs `grape deploy <project>`.
    *   CLI fetches config from Web API.
    *   CLI creates Git Repos (if missing) via Web API proxy.
    *   CLI clones templates -> Renders -> Pushes to Client Git Repos.
    *   CLI runs `terraform apply` -> Updates `deployments` status in Web API.
    *   CLI logs progress to Web API (`deployment_logs`).
    *   CLI installs ArgoCD on EKS.
    *   CLI configures ArgoCD to watch the new Client GitOps Repo.

## 4. Current Limitations / To-Do
*   **State Management:** Terraform runs locally on the CLI machine. State is stored in S3, but the *execution* is local. This makes "ClickOps" deployment from the Web UI impossible currently.
*   **Secrets:** Secrets seem to be generated/managed via Terraform but reliance on local CLI environment variables for initial bootstrapping (like Git Tokens) is heavy.
*   **Validation:** Limited validation logic in the CLI wizard beyond basic regex.
*   **Observability:** Logs are pushed to DB, but real-time streaming to the UI needs verification.