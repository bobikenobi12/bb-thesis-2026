package main

import (
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/bobikenobi12/bb-thesis-2026/apps/tendril/internal/agent"
	"github.com/supabase-community/supabase-go"
)

func main() {
	log.Println("Starting Tendril Agent...")

	// 1. Read Configuration from Env
	clusterID := os.Getenv("TENDRIL_CLUSTER_ID")
	apiToken := os.Getenv("TENDRIL_API_TOKEN")
	supabaseURL := os.Getenv("SUPABASE_URL")
	supabaseKey := os.Getenv("SUPABASE_KEY")

	if clusterID == "" || apiToken == "" || supabaseURL == "" || supabaseKey == "" {
		log.Fatal("Missing required environment variables: TENDRIL_CLUSTER_ID, TENDRIL_API_TOKEN, SUPABASE_URL, SUPABASE_KEY")
	}

	// 2. Initialize Supabase Client (Singleton)
	// We inject the Agent Token into every request header for security/auditing.
	clientOptions := &supabase.ClientOptions{
		Headers: map[string]string{
			"X-Agent-Token": apiToken,
			"X-Cluster-ID":  clusterID,
		},
	}

	client, err := supabase.NewClient(supabaseURL, supabaseKey, clientOptions)
	if err != nil {
		log.Fatalf("Failed to initialize Supabase client: %v", err)
	}

	// 3. Initialize Poller with the shared client
	poller := agent.NewPoller(clusterID, apiToken, client)

	// 4. Start Heartbeat (Background)
	go poller.StartHeartbeat(30 * time.Second)

	// 5. Start Job Loop
	go poller.StartJobLoop(5 * time.Second)

	// 6. Wait for Shutdown Signal
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop

	log.Println("Shutting down Tendril Agent...")
}