package agent

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"time"

	"github.com/bobikenobi12/bb-thesis-2026/apps/tendril/internal/executor"
	"github.com/bobikenobi12/bb-thesis-2026/apps/tendril/internal/types"
	"github.com/supabase-community/supabase-go"
)

type Poller struct {
	ClusterID string
	ApiToken  string
	Client    *supabase.Client
}

// NewPoller accepts a pre-configured Supabase client (Dependency Injection)
func NewPoller(clusterID string, apiToken string, client *supabase.Client) *Poller {
	return &Poller{
		ClusterID: clusterID,
		ApiToken:  apiToken,
		Client:    client,
	}
}

func (p *Poller) StartHeartbeat(interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	// Send one immediately on startup
	if err := p.sendHeartbeat(); err != nil {
		log.Printf("Error sending initial heartbeat: %v", err)
	} else {
		log.Println("Initial heartbeat sent successfully")
	}

	for range ticker.C {
		if err := p.sendHeartbeat(); err != nil {
			log.Printf("Error sending heartbeat: %v", err)
		} else {
			log.Println("Heartbeat pulse sent successfully")
		}
	}
}

func (p *Poller) sendHeartbeat() error {
	tokenHash := p.hashToken()

	payload := map[string]interface{}{
		"p_cluster_id": p.ClusterID,
		"p_token_hash": tokenHash,
	}

	// We use the string-returning Rpc from supabase-go
	resp := p.Client.Rpc("agent_heartbeat", "", payload)
	
	if len(resp) > 0 && resp[0] == '{' && (contains(resp, "error") || contains(resp, "code")) {
		return fmt.Errorf("heartbeat rpc error: %s", resp)
	}

	return nil
}

func (p *Poller) StartJobLoop(interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	log.Println("Started Job Polling Loop...")

	for range ticker.C {
		job, err := p.fetchNextJob()
		if err != nil {
			log.Printf("Error fetching job: %v", err)
			continue
		}

		if job != nil {
			log.Printf("Found job: %s. Starting execution...", job.ID)

			// Mark as PROCESSING
			if err := p.updateJobStatus(job.ID, types.StatusProcessing, ""); err != nil {
				log.Printf("Failed to mark job as processing: %v", err)
				continue
			}

			// Trigger Executor
			exec := executor.NewTerraformExecutor(job.ID, job.ConfigSnapshot, job.ConfigurationHash, p.Client)
			err := exec.Execute()

			if err != nil {
				log.Printf("Job %s execution failed: %v", job.ID, err)
				if updateErr := p.updateJobStatus(job.ID, types.StatusFailed, err.Error()); updateErr != nil {
					log.Printf("Failed to update job status to FAILED: %v", updateErr)
				}
			} else {
				log.Printf("Job %s execution completed successfully.", job.ID)
				if updateErr := p.updateJobStatus(job.ID, types.StatusSuccess, ""); updateErr != nil {
					log.Printf("Failed to update job status to SUCCESS: %v", updateErr)
				}
			}
		}
	}
}

func (p *Poller) fetchNextJob() (*types.Provision, error) {
	tokenHash := p.hashToken()

	payload := map[string]interface{}{
		"p_cluster_id": p.ClusterID,
		"p_token_hash": tokenHash,
	}

	resp := p.Client.Rpc("fetch_next_provision", "", payload)
	
	if len(resp) == 0 || resp == "[]" {
		return nil, nil
	}

	if resp[0] == '{' && (contains(resp, "error") || contains(resp, "code")) {
		return nil, fmt.Errorf("fetch job rpc error: %s", resp)
	}

	var provisions []types.Provision
	if err := json.Unmarshal([]byte(resp), &provisions); err != nil {
		return nil, fmt.Errorf("failed to unmarshal provisions: %w (raw: %s)", err, resp)
	}

	if len(provisions) == 0 {
		return nil, nil
	}

	return &provisions[0], nil
}

func (p *Poller) updateJobStatus(provisionID string, status types.ProvisionStatus, msg string) error {
	tokenHash := p.hashToken()

	payload := map[string]interface{}{
		"p_cluster_id":    p.ClusterID,
		"p_token_hash":     tokenHash,
		"p_provision_id":   provisionID,
		"p_status":         string(status),
		"p_error_message": msg,
	}

	resp := p.Client.Rpc("update_provision_status", "", payload)
	
	if len(resp) > 0 && resp[0] == '{' && (contains(resp, "error") || contains(resp, "code")) {
		return fmt.Errorf("update status rpc error: %s", resp)
	}

	return nil
}

func (p *Poller) hashToken() string {
	hasher := sha256.New()
	hasher.Write([]byte(p.ApiToken))
	return hex.EncodeToString(hasher.Sum(nil))
}

func contains(s, substr string) bool {
	for i := 0; i < len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}
