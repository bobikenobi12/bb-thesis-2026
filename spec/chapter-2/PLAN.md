# Thesis Plan: Chapter 2 - System Design

## Goal
To formally define the architecture of the "Grape" Hybrid Cloud Orchestration System, justifying the move from a traditional "Local CLI" or "Agent-Based" model to a "SaaS-Managed Remote Execution" model using Cross-Account IAM Roles and GitOps.

## Structure

### 2.1. Design Methodology
*   **Problem Statement:** The "Works on my machine" problem in infrastructure provisioning.
*   **Requirements:**
    *   Zero-Key Security (No long-term AWS keys stored).
    *   Auditable History (Who deployed what and when).
    *   GitOps Native (Git as the single source of truth).
    *   Developer Experience (Vercel-like simplicity).

### 2.2. Architectural Evolution (Alternatives Considered)
*   **Alternative 1: Local CLI Execution (The "Legacy" Approach)**
    *   *Description:* Developer runs Terraform locally.
    *   *Pros:* Simple, no backend needed.
    *   *Cons:* State locking issues, security risks (keys on laptop), no audit trail.
*   **Alternative 2: Long-Running Agent (The "Jenkins" Approach)**
    *   *Description:* User installs an agent in their cluster.
    *   *Pros:* Execution stays within user boundary.
    *   *Cons:* High maintenance for the user, "Chicken and Egg" bootstrapping problem.
*   **Selected Architecture: SaaS-Managed Remote Execution**
    *   *Description:* SaaS Worker assumes IAM Role to execute Terraform in ephemeral containers.
    *   *Justification:* Best balance of UX (zero setup) and Security (STS credentials).

### 2.3. High-Level Architecture
*   **Control Plane:** Next.js + Supabase. Handles Identity, State, and Webhooks.
*   **Execution Plane (The Worker Fleet):** Go-based workers. Stateless.
    *   *Isolation:* Each job runs in a sandboxed container.
*   **Data Plane (User AWS):**
    *   **Trust Relationship:** AWS OIDC Provider / Cross-Account Role.
    *   **Resources:** EKS, VPC, RDS managed by the Worker.

### 2.4. Key Design Patterns
*   **The "Bootstrapper" Pattern:** Using CloudFormation to bootstrap the initial trust relationship (Role ARN).
*   **The "Remote Runner" Pattern:** Decoupling the *intent* (Web UI click) from the *execution* (Terraform apply).
*   **GitOps Injection:** The SaaS platform does not just run Terraform; it *commits* the results (Infra Facts) to Git, forcing ArgoCD to take over. This creates a clear "Handoff" point.

### 2.5. Data Model Design
*   **Entities:** `Organization`, `Project` (`Configuration`), `Deployment`, `Log`.
*   **Schema Analysis:** Brief overview of how Supabase tables support this (referencing `configurations` and `deployments` tables).

### 2.6. Security Design
*   **Authentication:** OAuth (Git Providers).
*   **Authorization:** RBAC within the SaaS.
*   **Cloud Security:**
    *   AssumeRole with `ExternalID` (preventing Confused Deputy problem).
    *   Ephemeral Credentials (valid for 1 hour only).
    *   State Encryption (S3 Server-Side Encryption).

---
## Next Steps
1.  Draft content for Section 2.1 and 2.2.
2.  Create Mermaid diagrams for Section 2.3 (Architecture) and 2.4 (Flow).
3.  Refine the Security section (2.6) with specifics on `sts:AssumeRole`.
