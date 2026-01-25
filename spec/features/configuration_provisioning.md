# Configuration Provisioning & Agent Execution Plan

## 1. Objective
Enable the **Tendril Agent** to autonomously pick up infrastructure configurations defined in the **Trellis Web UI**, apply them to the target Kubernetes/AWS environment using Terraform, and stream real-time logs back to the user.

## 2. Architecture Recap
*   **Source of Truth:** `provisions` table in Supabase.
*   **Worker:** Tendril Agent (Go) running in the user's cluster.
*   **Feedback:** `provision_logs` table streaming `stdout`/`stderr`.
*   **Templates:** Dynamic fetch from [adp-tf-envtempl-standard](https://github.com/bobikenobi12/adp-tf-envtempl-standard).

## 3. Configuration Snapshot Schema
The `config_snapshot` JSONB field in the `provisions` table is the contract between the UI and the Agent. It must map directly to the input variables required by the Terraform templates.

### 3.1. Structure
```json
{
  "template_source": {
    "repo": "https://github.com/bobikenobi12/adp-tf-envtempl-standard",
    "version": "v1.2.0"
  },
  "terraform_vars": {
    "project_name": "acme",
    "environment": "prod",
    "region": "eu-central-1",
    "vpc_cidr": "10.0.0.0/16",
    "enable_karpenter": true,
    "node_groups": [
      {
        "name": "general",
        "instance_types": ["t3.medium"],
        "min_size": 2,
        "max_size": 5
      }
    ]
  },
  "meta": {
    "triggered_by": "user-uuid",
    "reason": "Scale up node groups"
  }
}
```

## 4. Implementation Steps

### Phase 1: Tendril Agent Implementation (Go) - [COMPLETED]
The agent logic is located in `apps/tendril`.

#### 4.1. Poller Service (`internal/agent/poller.go`) - [COMPLETED]
*   **Mechanism:** Periodic direct RPC polling (`fetch_next_provision`).
*   **Security:** SHA-256 token hashing local to the agent.
*   **Fix:** Resolved PostgREST error by avoiding table embedding and using dedicated Postgres functions.

#### 4.3. Log Streamer (`internal/logger/streamer.go`) - [COMPLETED]
*   **Transport:** Secure RPC (`insert_provision_log`) using the `anon` key.
*   **Buffering:** Optimal 500ms / 10KB threshold for real-time responsiveness.

### Phase 2: Web UI & API Layer - [IN PROGRESS]

#### 4.3. Real-time Logs UI - [COMPLETED]
*   **Component:** `ClusterList.tsx` (and upcoming `ProvisionLogViewer.tsx`).
*   **Subscription:**
    *   `supabase.channel('realtime:clusters').on('postgres_changes', ...)` for heartbeat pulses.
    *   Dynamic state management ensures the dashboard UI stays synced with the agent's actual status.

## 5. Risk & Mitigation
*   **Risk:** Terraform state locking.
    *   *Mitigation:* The templates use S3 backend. The Agent must be configured with AWS credentials (IRSA) that have access to the state bucket.
*   **Risk:** Agent crash during apply.
    *   *Mitigation:* On restart, Agent checks for 'PROCESSING' jobs. If found, marks them as 'FAILED' (or 'UNKNOWN') because the process context is lost. Manual intervention required.
*   **Risk:** Token rotation.
    *   *Mitigation:* The Agent uses the long-lived `agent_token` (mapped to `TENDRIL_API_TOKEN`). If compromised, user must regenerate in UI and update Agent via Helm upgrade.

## 6. Definition of Done
1.  User clicks "Deploy" in Web UI.
2.  Row appears in `provisions` table.
3.  Tendril Agent picks up the job (status -> PROCESSING).
4.  Terraform runs successfully on the cluster.
5.  Logs appear in Web UI in real-time.
6.  Job status updates to SUCCESS.
