# Architecture Design Document: ADP Remote Provisioning System

**Version:** 1.0  
**Status:** Draft  
**Context:** Monorepo (Next.js, Go, Terraform)

## 1. Executive Summary
The Application Development Platform (ADP) acts as a centralized control plane for managing distributed infrastructure. It utilizes a GitOps-adjacent, Pull-Based Architecture where a central server (Next.js + Supabase) manages configuration state, while autonomous agents ("Tendril Agents") running inside customer environments (AWS EKS) poll for instructions, execute Infrastructure-as-Code (IaC), and stream telemetry back to the user in real-time.

## 2. High-Level Topology
The system is divided into two distinct security zones: the Control Plane (Trellis) and the Data Plane (User's Remote Environment).

### 2.1 Core Components

#### The Portal (Control Plane - Trellis)
*   **Stack:** Next.js (Web), Supabase (Auth/DB/Realtime).
*   **Role:** Configuration builder, authentication provider, and deployment dashboard.
*   **Responsibility:** Persists user intents (Configs) and Deployment requests to the database.

#### The Database (Message Broker)
*   **Stack:** PostgreSQL (Supabase).
*   **Role:** Acts as the asynchronous message queue and state store.
*   **Responsibility:** Stores the "Target State" and creates a decoupling layer between the Web UI and the Remote Machines.

#### Tendril Agent (Remote Execution Plane)
*   **Stack:** Go (compiled binary/container).
*   **Location:** Running inside the user's AWS VPC (e.g., as a Kubernetes Deployment in EKS).
*   **Role:** The "Runner." It has no public ingress ports. It only makes outbound connections.
*   **Responsibility:** Polling for jobs, pulling Terraform templates, executing terraform/infracost, and pushing logs.

## 3. Communication Protocol (The "Thin Part")
To ensure security and simplify networking (avoiding complex ingress/VPNs into user clusters), the system uses a Pull-Based Command & Control (C2) Pattern.

### 3.1 The Job Queue Mechanism
Direct HTTP calls from Server to Agent are forbidden. Communication occurs exclusively via Database State.

*   **Command Channel (Server -> Agent):**
    The Agent maintains a long-polling loop (or utilizes Supabase Realtime cursors) monitoring the `deployments` table for rows matching its `cluster_id` with status `QUEUED`.

*   **Feedback Channel (Agent -> Server):**
    The Agent writes execution streams (stdout/stderr) into the `deployment_logs` table. The Frontend subscribes to this table via WebSocket (Supabase Realtime) to render the "Matrix-style" scrolling logs.

### 3.2 Database Schema Interface
The "Protocol" is defined by the database schema:

| Table | Column | Description |
| :--- | :--- | :--- |
| `clusters` | `id`, `user_id`, `api_key_hash` | Registers a remote machine/EKS cluster. |
| `deployments` | `id`, `cluster_id`, `config_snapshot`, `status` | The Queue. Status transitions: `QUEUED` → `PROCESSING` → `SUCCESS/FAIL`. |
| `deployment_logs` | `id`, `deployment_id`, `log_chunk`, `ts` | Append-only log storage for live streaming. |

## 4. Workflows

### 4.1 Phase 1: Bootstrapping (The "Handshake")
Before a user can deploy, the Remote Machine must be provisioned and authorized.

1.  **Infrastructure Provisioning:**
    *   User authenticates via Grape CLI or Web to AWS.
    *   Trellis provisions the EKS cluster (using Terraform).
2.  **Agent Installation:**
    *   Trellis generates a Machine Token (JWT or API Key) tied to a specific `cluster_id` in Supabase.
    *   Trellis installs the `tendril-agent` Helm chart onto the new cluster.
    *   The Machine Token is injected as a Kubernetes Secret (`TENDRIL_AGENT_TOKEN`).
3.  **Verification:**
    *   The Agent starts up, reads the token, and connects to Supabase.
    *   It updates the `clusters` table setting status: `'ONLINE'`.

### 4.2 Phase 2: Deployment Execution
This is the core loop where the "Interesting Part" happens.

1.  **Trigger (Frontend):**
    *   User clicks "Deploy".
    *   Frontend serializes the current configuration and inserts a row into `deployments` (status: `QUEUED`).
    *   Frontend subscribes to `deployment_logs` for this new ID.
2.  **Pickup (Tendril Agent):**
    *   Agent detects the new job via Polling/Realtime.
    *   Agent performs an atomic update: `UPDATE deployments SET status = 'PROCESSING' WHERE id = $1`.
3.  **Preparation (Remote Machine):**
    *   Agent downloads the `config_snapshot` JSON.
    *   **Template Resolution:** The Agent container image includes the `@packages/templates/**` (built during CI/CD). Alternatively, it performs a sparse checkout of the templates from the monorepo using an embedded read-only Git token.
4.  **Execution (Terraform/Infracost):**
    *   Agent runs `infracost breakdown --path .` and uploads metrics.
    *   Agent runs `terraform apply`.
5.  **Log Streaming:**
    *   The Go exec package captures pipes. A background goroutine buffers lines and performs batch `INSERT`s into `deployment_logs` every 500ms (to prevent rate limiting).
6.  **Completion:**
    *   On exit code 0: Update `deployments` to `SUCCESS`.
    *   On error: Update `deployments` to `FAILED` and upload the final error message.

## 5. Security Architecture

### 5.1 Authentication
*   **User Auth:** Standard Supabase Auth (Email/GitHub) for the Trellis Web Portal.
*   **Machine Auth:** The Agent does not act as the User. It acts as a Service Account. It possesses a persistent token scoped only to read its own jobs and write its own logs. It cannot access other users' data (enforced via Postgres Row Level Security - RLS).

### 5.2 Isolation
Since the execution happens on the User's infrastructure, the Trellis Server is protected from malicious code execution.
The Agent requires Least Privilege IAM roles in AWS to provision the requested resources, but no access to the ADP monorepo source code beyond the templates.
