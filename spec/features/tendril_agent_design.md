# Tendril Agent & Provisioning Architecture

## 1. Overview
This document defines the architecture for **Tendril**, the Go-based agent running inside the user's infrastructure (Data Plane). It connects to **Trellis** (Control Plane) to receive and execute infrastructure provisioning jobs.

**Key Terminology Change:**
-   Old: `deployments`
-   New: `provisions` (Reflects the infrastructure provisioning nature of the tasks).

## 2. Database Schema (Supabase/PostgreSQL)

The communication between Trellis and Tendril is mediated by secure PostgreSQL functions (RPCs) to bypass Row Level Security (RLS) for the agent while maintaining strict authentication via token hashes.

### 2.1. Secure RPC Functions (`SECURITY DEFINER`)
-   **`agent_heartbeat(p_cluster_id, p_token_hash)`**: Updates the cluster status to `ONLINE` and sets `last_heartbeat`.
-   **`fetch_next_provision(p_cluster_id, p_token_hash)`**: Securely retrieves the next `QUEUED` job.
-   **`update_provision_status(p_cluster_id, p_token_hash, p_provision_id, p_status, p_error_message)`**: Updates the lifecycle of a job.
-   **`insert_provision_log(p_cluster_id, p_token_hash, p_provision_id, p_log_chunk, p_stream_type)`**: Authenticated log streaming.

---

## 3. Tendril Agent Architecture (Go)

### 3.1. Core Components
1.  **Poller Service (`internal/agent/poller.go`):**
    -   **Security:** Hashes the `TENDRIL_API_TOKEN` using **SHA-256** locally.
    -   **Heartbeat:** Calls `agent_heartbeat` RPC every 30s using the `anon` key.
    -   **Job Loop:** Calls `fetch_next_provision` RPC every 5s.

2.  **Job Executor (`internal/executor/terraform.go`):**
    -   **Workspace:** Isolates runs in `/tmp/tendril/$JOB_ID`.
    -   **Dynamic Fetching:** Clones templates and checks out specific versions from `config_snapshot`.

3.  **Log Streamer (`internal/logger/streamer.go`):**
    -   **Secure Streaming:** Uses `insert_provision_log` RPC to ensure logs are only accepted from verified agents.
    -   **Performance:** Chunks logs every 500ms or 10KB and uploads asynchronously.

---

## 4. Real-time Frontend Visualization
The **Trellis Dashboard** (`apps/web`) provides live feedback of agent health:
-   **Real-time Updates:** Uses Supabase Realtime (`postgres_changes`) on the `clusters` table.
-   **Client Component:** `ClusterList.tsx` manages the subscription and ensures the "Pulse" (last heartbeat) updates instantly without page refreshes.

### 3.2. Directory Structure

```
apps/
  tendril/
    cmd/
      tendril/
        main.go        # Entrypoint & Env Var Loading
    internal/
      agent/
        poller.go      # Heartbeat & Job Polling Logic
      executor/
        terraform.go   # Terraform Command Execution
        workspace.go   # Git Cloning & File Generation
      logger/
        streamer.go    # Buffer & Async Log Streaming
      types/
        models.go      # Go Structs for DB Schema
```

## 4. Execution Flow (Detailed)

1.  **Boot:** Agent starts, reads `TENDRIL_CLUSTER_ID`, `TENDRIL_API_TOKEN`, `SUPABASE_URL`, and `SUPABASE_KEY` from environment variables.
2.  **Connect:** Initializes a Supabase client with custom headers (`X-Agent-Token`, `X-Cluster-ID`) for security auditing.
3.  **Loop:**
    -   `SELECT * FROM provisions WHERE cluster_id = $ID AND status = 'QUEUED' ORDER BY created_at ASC LIMIT 1`.
4.  **Execute(Job):**
    -   **ACK:** `UPDATE provisions SET status='PROCESSING', started_at=NOW()`.
    -   **Prepare:**
        -   `mkdir /tmp/tendril/$JOB_ID`
        -   `git clone $REPO /tmp/tendril/$JOB_ID/templates`
        -   `git checkout $VERSION`
        -   Render `terraform_vars` -> `terraform.tfvars.json`.
    -   **Run:**
        -   Exec `terraform init`. Stream logs.
        -   Exec `terraform apply -auto-approve`. Stream logs.
    -   **Finish:**
        -   Update status to `SUCCESS` or `FAILED` and set `completed_at`.

## 5. Security & Isolation
-   **IRSA:** Uses AWS Identity Roles for Service Accounts to grant the agent permissions to manage AWS resources without static keys.
-   **Multi-Arch Support:** Docker images are built for both `linux/amd64` and `linux/arm64` using `buildx` to support diverse EKS node types (e.g., Graviton).
-   **Integrity:** Optional `configuration_hash` verification ensures the job payload hasn't been tampered with.

## 6. Bootstrapping Strategy (Grape CLI)

To bridge the gap between "No Cloud" and "Managed Cloud", the **Grape CLI** (`apps/cli`) will handle the initial seed via the `bootstrap` command.

### `grape bootstrap` Flow:
1.  **Authentication Check:** Ensures the user has a valid Cloud Identity (Cross-Account Role) configured via the Web UI.
2.  **Infrastructure Seeding (Local Terraform):**
    -   The CLI will utilize the same public repository (`adp-tf-envtempl-standard`) or a specific subset of it suitable for bootstrapping.
    -   It will run Terraform **locally** on the user's machine to provision:
        -   VPC (if not exists)
        -   EKS Cluster (Control Plane + Node Group)
        -   IAM OIDC Provider
3.  **Agent Installation (Helm):**
    -   Once EKS is `ACTIVE`, the CLI configures `kubectl`.
    -   It generates a new `cluster_id` and `token` via the Trellis API.
    -   It installs the `tendril` Helm chart, injecting the token as a Secret.
4.  **Handover:**
    -   The CLI waits for the Agent to send a heartbeat (`ONLINE` status).
    -   Once online, the CLI exits, and all future updates are handled by the Agent via the **Provisions** queue.