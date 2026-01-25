package logger

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"log"
	"os"
	"sync"
	"time"

	"github.com/bobikenobi12/bb-thesis-2026/apps/tendril/internal/types"
	"github.com/supabase-community/supabase-go"
)

const (
	FlushInterval = 500 * time.Millisecond
	MaxBufferSize = 10 * 1024 // 10KB
)

// LogStreamer implements io.Writer to capture output and stream it to Supabase
type LogStreamer struct {
	client      *supabase.Client
	provisionID string
	clusterID   string
	apiToken    string
	streamType  types.StreamType

	buffer     bytes.Buffer
	mu         sync.Mutex
	lastFlush  time.Time
	flushTimer *time.Timer
	done       chan bool
}

func NewLogStreamer(client *supabase.Client, provisionID string, streamType types.StreamType) *LogStreamer {
	ls := &LogStreamer{
		client:      client,
		provisionID: provisionID,
		clusterID:   os.Getenv("TENDRIL_CLUSTER_ID"),
		apiToken:    os.Getenv("TENDRIL_API_TOKEN"),
		streamType:  streamType,
		lastFlush:   time.Now(),
		done:        make(chan bool),
	}

	// Start a background loop to flush periodically
	ls.flushTimer = time.AfterFunc(FlushInterval, ls.periodicFlush)
	return ls
}

// Write implements io.Writer. It buffers data and flushes if buffer is full or time has passed.
func (ls *LogStreamer) Write(p []byte) (n int, err error) {
	ls.mu.Lock()
	defer ls.mu.Unlock()

	n, err = ls.buffer.Write(p)

	if ls.buffer.Len() >= MaxBufferSize {
		ls.flushLocked()
	}

	return n, err
}

func (ls *LogStreamer) periodicFlush() {
	ls.mu.Lock()
	defer ls.mu.Unlock()

	if ls.buffer.Len() > 0 {
		ls.flushLocked()
	}
	// Reset timer
	ls.flushTimer.Reset(FlushInterval)
}

// Close ensures any remaining data is flushed and stops the timer
func (ls *LogStreamer) Close() error {
	ls.flushTimer.Stop()
	ls.mu.Lock()
	defer ls.mu.Unlock()
	ls.flushLocked()
	return nil
}

// flushLocked sends the buffer content to the DB. Caller must hold the lock.
func (ls *LogStreamer) flushLocked() {
	if ls.buffer.Len() == 0 {
		return
	}

	chunk := ls.buffer.String()
	ls.buffer.Reset()
	ls.lastFlush = time.Now()

	// Hash the token
	hasher := sha256.New()
	hasher.Write([]byte(ls.apiToken))
	tokenHash := hex.EncodeToString(hasher.Sum(nil))

	// Perform DB Insert asynchronously
	go func(chunk, tokenHash string) {
		payload := map[string]interface{}{
			"p_cluster_id":   ls.clusterID,
			"p_token_hash":   tokenHash,
			"p_provision_id": ls.provisionID,
			"p_log_chunk":    chunk,
			"p_stream_type":  string(ls.streamType),
		}

		resp := ls.client.Rpc("insert_provision_log", "", payload)
		if len(resp) > 0 && resp[0] == '{' && (contains(resp, "error") || contains(resp, "code")) {
			log.Printf("Failed to upload log chunk for provision %s: %s", ls.provisionID, resp)
		}
	}(chunk, tokenHash)
}

func contains(s, substr string) bool {
	for i := 0; i < len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}

// Helper to wrap the streamer in a scanner if line-by-line processing is needed locally
func (ls *LogStreamer) Scanner() *bufio.Scanner {
	// Not used for streaming to DB, but useful if we wanted to process output logic locally
	return nil
}
