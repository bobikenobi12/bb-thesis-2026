package types

import (
	"encoding/json"
	"time"
)

type Cluster struct {
	ID             string    `json:"id"`
	UserID         string    `json:"user_id"`
	Name           string    `json:"name"`
	Status         string    `json:"status"`
	LastHeartbeat  time.Time `json:"last_heartbeat"`
	AgentTokenHash string    `json:"agent_token_hash"`
	CreatedAt      time.Time `json:"created_at"`
}

type ProvisionStatus string

const (
	StatusQueued     ProvisionStatus = "QUEUED"
	StatusProcessing ProvisionStatus = "PROCESSING"
	StatusSuccess    ProvisionStatus = "SUCCESS"
	StatusFailed     ProvisionStatus = "FAILED"
	StatusCancelled  ProvisionStatus = "CANCELLED"
)

type Provision struct {
	ID                string          `json:"id"`
	ClusterID         string          `json:"cluster_id"`
	ConfigSnapshot    json.RawMessage `json:"config_snapshot"`
	ConfigurationHash string          `json:"configuration_hash"`
	Status            ProvisionStatus `json:"status"`
	CreatedAt         time.Time       `json:"created_at"`
	StartedAt         *time.Time      `json:"started_at,omitempty"`
	CompletedAt       *time.Time      `json:"completed_at,omitempty"`
	ErrorMessage      *string         `json:"error_message,omitempty"`
	ExecutionMetadata json.RawMessage `json:"execution_metadata,omitempty"`
}

type StreamType string

const (
	StreamStdout StreamType = "STDOUT"
	StreamStderr StreamType = "STDERR"
	StreamSystem StreamType = "SYSTEM"
)

type ProvisionLog struct {
	ID          int64      `json:"id"`
	ProvisionID string     `json:"provision_id"`
	LogChunk    string     `json:"log_chunk"`
	StreamType  StreamType `json:"stream_type"`
	CreatedAt   time.Time  `json:"created_at"`
}
