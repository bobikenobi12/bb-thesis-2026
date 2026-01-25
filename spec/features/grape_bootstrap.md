# Grape CLI Bootstrap Command

## 1. Objective
The `grape bootstrap` command is the entry point for new users. It transitions a raw AWS account into a managed "Trellis" environment by provisioning the necessary base infrastructure and installing the "Tendril" agent.

## 2. Command Flow

### 2.1. Pre-flight Checks
*   **Authentication:** Verify the user is logged into the Grape CLI (`grape login` must have been run).
*   **AWS Credentials:** Verify `~/.aws/credentials` or environment variables are present and have `AdministratorAccess` (or sufficient permissions).
*   **Trellis API Connectivity:** Ensure the CLI can talk to the Trellis (Supabase) API.

### 2.2. Configuration (Wizard)
Interactive prompt (using `charmbracelet/huh`) to gather/confirm parameters:
*   **Project Name:** (e.g., "acme-corp")
*   **Environment:** (e.g., "dev", "prod")
*   **Region:** (e.g., "us-east-1", "eu-central-1")
*   **VPC Selection:** Choose between "Create New VPC" or select an existing VPC from the AWS account.
*   **VPC CIDR:** (Only asked if creating a new VPC, Default: `10.0.0.0/16`)

### 2.3. Infrastructure Seeding (Local Terraform)
The CLI utilizes an **embedded** Terraform configuration (bundled in the binary) to provision the "Seed" infrastructure.

#### 2.3.1. Architectural Decision: Client-Side Bootstrapping
For the MVP, we explicitly chose to run the bootstrap process on the user's machine (CLI) rather than the SaaS server.
*   **The "Compute" Problem:** Provisioning an EKS cluster takes 15-20 minutes. Running this on a standard HTTP handler (Serverless/Next.js) would timeout.
*   **Complexity Avoidance:** Moving this to the server would require a robust Background Job System (e.g., Temporal/Redis+Workers) to handle long-running stateful processes.
*   **Cost & Stability:** Leveraging the user's local machine avoids SaaS compute costs for the heavy lifting and provides immediate feedback in the terminal without complex WebSocket streaming for the initial setup.
*   **Future Roadmap:** A "Pro" experience might move this to a server-side worker fleet later.

*   **Resources Provisioned:**
    *   **VPC:** Public/Private subnets, IGW, NAT Gateway (or reuse existing).
    *   **EKS Cluster:** Control plane, Node Group (min size).
    *   **OIDC Provider:** For IRSA (IAM Roles for Service Accounts).

### 2.4. Agent Registration
1.  CLI calls Trellis API: `POST /rest/v1/clusters`
2.  Response: `cluster_id` and `agent_token`.

### 2.5. Agent Installation (Helm)
1.  Configure local `kubectl` context to the new EKS cluster.
2.  Install the Tendril Helm Chart (fetched from `oci://ghcr.io/itgix/charts/tendril`).
3.  **Values Injection:**
    *   `env.TENDRIL_CLUSTER_ID`: `<cluster_id>`
    *   `env.TENDRIL_API_TOKEN`: `<agent_token>`
    *   `env.SUPABASE_URL`: `...`
    *   `env.SUPABASE_KEY`: `...`

### 2.6. Verification
1.  CLI polls `GET /rest/v1/clusters?id=eq.<cluster_id>` waiting for `status = 'ONLINE'`.
2.  Once ONLINE, success message is displayed.

## 3. Implementation Plan

### 3.1. Embedded Assets
Use `embed` package in Go to bundle:
*   `assets/terraform/seed/`: Minimal Terraform for VPC+EKS.
*   `assets/helm/tendril/`: The Tendril Helm Chart.
*   **Note:** Must use `//go:embed all:path` to ensure hidden files like `_helpers.tpl` are included.

### 3.2. Go Packages
*   `apps/cli/grape/cmd/bootstrap.go`: The Cobra command.
*   `apps/cli/grape/internal/aws`: AWS SDK wrappers (sts get-caller-identity).
*   `apps/cli/grape/internal/terraform`: Local Terraform runner (wrapping `exec`).
*   `apps/cli/grape/internal/helm`: Local Helm runner.
*   `apps/cli/grape/internal/trellis`: Client for Trellis API.

## 4. Security
*   **Sensitive Data:** The `agent_token` is a sensitive secret. It is passed directly to the Helm install command (which creates a K8s Secret) and **never stored** on the user's disk.
