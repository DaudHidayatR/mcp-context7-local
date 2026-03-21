// Package main implements a Go HTTP server that provides RAG (Retrieval-Augmented Generation)
// search and ingestion over ChromaDB, using an OpenAI-compatible embedding endpoint.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

type config struct {
	chromaURL string
	embedURL  string
	port      string
}

func loadConfig() config {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8081"
	}
	return config{
		chromaURL: strings.TrimRight(os.Getenv("CHROMA_URL"), "/"),
		embedURL:  strings.TrimRight(os.Getenv("EMBED_URL"), "/"),
		port:      port,
	}
}

// ---------------------------------------------------------------------------
// Request / response types
// ---------------------------------------------------------------------------

// SearchRequest is the JSON body for POST /search.
type SearchRequest struct {
	Query     string `json:"query"`
	TopK      int    `json:"top_k"`
	Namespace string `json:"namespace"`
}

// SearchResult is a single item in the search response.
type SearchResult struct {
	Content string  `json:"content"`
	Score   float64 `json:"score"`
	Source  string  `json:"source"`
}

// SearchResponse is the JSON response for POST /search.
type SearchResponse struct {
	Results []SearchResult `json:"results"`
}

// IngestDoc is a single document in an ingest request.
type IngestDoc struct {
	ID       string            `json:"id"`
	Content  string            `json:"content"`
	Metadata map[string]string `json:"metadata"`
}

// IngestRequest is the JSON body for POST /ingest.
type IngestRequest struct {
	Documents []IngestDoc `json:"documents"`
	Namespace string      `json:"namespace"`
}

// IngestResponse is the JSON response for POST /ingest.
type IngestResponse struct {
	Ingested int `json:"ingested"`
}

// ---------------------------------------------------------------------------
// Embedding client (OpenAI-compatible /v1/embeddings)
// ---------------------------------------------------------------------------

type embeddingRequest struct {
	Input []string `json:"input"`
	Model string   `json:"model"`
}

type embeddingData struct {
	Embedding []float64 `json:"embedding"`
	Index     int       `json:"index"`
}

type embeddingResponse struct {
	Data []embeddingData `json:"data"`
}

func getEmbeddings(ctx context.Context, client *http.Client, embedURL string, texts []string) ([][]float64, error) {
	body, err := json.Marshal(embeddingRequest{
		Input: texts,
		Model: "text-embedding-ada-002",
	})
	if err != nil {
		return nil, fmt.Errorf("marshal embedding request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, embedURL+"/v1/embeddings", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("create embedding request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("embedding request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("embedding endpoint returned %d: %s", resp.StatusCode, string(b))
	}

	var result embeddingResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("decode embedding response: %w", err)
	}

	embeddings := make([][]float64, len(result.Data))
	for _, d := range result.Data {
		if d.Index < len(embeddings) {
			embeddings[d.Index] = d.Embedding
		}
	}
	return embeddings, nil
}

// ---------------------------------------------------------------------------
// ChromaDB client (REST API v2)
// ---------------------------------------------------------------------------

type chromaQueryRequest struct {
	QueryEmbeddings [][]float64 `json:"query_embeddings"`
	NResults        int         `json:"n_results"`
	Include         []string    `json:"include"`
}

type chromaQueryResponse struct {
	IDs       [][]string    `json:"ids"`
	Documents [][]string    `json:"documents"`
	Distances [][]float64   `json:"distances"`
	Metadatas [][]chromaMeta `json:"metadatas"`
}

type chromaMeta map[string]interface{}

func chromaQuery(ctx context.Context, client *http.Client, chromaURL, namespace string, embedding []float64, topK int) (*chromaQueryResponse, error) {
	body, err := json.Marshal(chromaQueryRequest{
		QueryEmbeddings: [][]float64{embedding},
		NResults:        topK,
		Include:         []string{"documents", "metadatas", "distances"},
	})
	if err != nil {
		return nil, fmt.Errorf("marshal chroma query: %w", err)
	}

	url := fmt.Sprintf("%s/api/v2/collections/%s/query", chromaURL, namespace)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("create chroma query request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("chroma query failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("chroma returned %d: %s", resp.StatusCode, string(b))
	}

	var result chromaQueryResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("decode chroma response: %w", err)
	}
	return &result, nil
}

type chromaAddRequest struct {
	IDs        []string          `json:"ids"`
	Documents  []string          `json:"documents"`
	Embeddings [][]float64       `json:"embeddings"`
	Metadatas  []map[string]string `json:"metadatas"`
}

func chromaUpsert(ctx context.Context, client *http.Client, chromaURL, namespace string, docs []IngestDoc, embeddings [][]float64) error {
	ids := make([]string, len(docs))
	documents := make([]string, len(docs))
	metadatas := make([]map[string]string, len(docs))

	for i, d := range docs {
		ids[i] = d.ID
		documents[i] = d.Content
		if d.Metadata != nil {
			metadatas[i] = d.Metadata
		} else {
			metadatas[i] = map[string]string{}
		}
	}

	body, err := json.Marshal(chromaAddRequest{
		IDs:        ids,
		Documents:  documents,
		Embeddings: embeddings,
		Metadatas:  metadatas,
	})
	if err != nil {
		return fmt.Errorf("marshal chroma upsert: %w", err)
	}

	url := fmt.Sprintf("%s/api/v2/collections/%s/upsert", chromaURL, namespace)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("create chroma upsert request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("chroma upsert failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		b, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("chroma upsert returned %d: %s", resp.StatusCode, string(b))
	}
	return nil
}

// chromaEnsureCollection creates a ChromaDB collection if it does not already exist.
func chromaEnsureCollection(ctx context.Context, client *http.Client, chromaURL, namespace string) error {
	// Check if collection exists: GET /api/v2/collections/{namespace}
	checkURL := fmt.Sprintf("%s/api/v2/collections/%s", chromaURL, namespace)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, checkURL, nil)
	if err != nil {
		return fmt.Errorf("create check request: %w", err)
	}

	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("check collection failed: %w", err)
	}
	resp.Body.Close()

	if resp.StatusCode == http.StatusOK {
		return nil // collection already exists
	}

	// Collection does not exist — create it
	createBody, err := json.Marshal(map[string]interface{}{
		"name":     namespace,
		"metadata": map[string]string{"namespace": namespace},
	})
	if err != nil {
		return fmt.Errorf("marshal create request: %w", err)
	}

	createURL := fmt.Sprintf("%s/api/v2/collections", chromaURL)
	createReq, err := http.NewRequestWithContext(ctx, http.MethodPost, createURL, bytes.NewReader(createBody))
	if err != nil {
		return fmt.Errorf("create collection request: %w", err)
	}
	createReq.Header.Set("Content-Type", "application/json")

	createResp, err := client.Do(createReq)
	if err != nil {
		return fmt.Errorf("create collection failed: %w", err)
	}
	defer createResp.Body.Close()

	if createResp.StatusCode != http.StatusOK && createResp.StatusCode != http.StatusCreated {
		b, _ := io.ReadAll(createResp.Body)
		return fmt.Errorf("create collection returned %d: %s", createResp.StatusCode, string(b))
	}
	return nil
}

// ---------------------------------------------------------------------------
// HTTP Handlers
// ---------------------------------------------------------------------------

// Server holds shared dependencies for request handlers.
type Server struct {
	cfg    config
	client *http.Client
}

// NewServer creates a new Server with the given config.
func NewServer(cfg config) *Server {
	return &Server{
		cfg: cfg,
		client: &http.Client{
			Timeout: 30 * time.Second,
		},
	}
}

// NewServerWithClient creates a Server with a custom HTTP client (for testing).
func NewServerWithClient(cfg config, client *http.Client) *Server {
	return &Server{cfg: cfg, client: client}
}

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleSearch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}

	var req SearchRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON: " + err.Error()})
		return
	}

	if req.Query == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "query is required"})
		return
	}
	if req.TopK <= 0 {
		req.TopK = 5
	}
	if req.Namespace == "" {
		req.Namespace = "default"
	}

	// Get embedding for the query.
	embeddings, err := getEmbeddings(r.Context(), s.client, s.cfg.embedURL, []string{req.Query})
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "embedding failed: " + err.Error()})
		return
	}
	if len(embeddings) == 0 || len(embeddings[0]) == 0 {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "embedding returned no vectors"})
		return
	}

	// Query ChromaDB.
	chromaResp, err := chromaQuery(r.Context(), s.client, s.cfg.chromaURL, req.Namespace, embeddings[0], req.TopK)
	if err != nil {
		// Return empty results on ChromaDB errors (collection not found, etc.)
		writeJSON(w, http.StatusOK, SearchResponse{Results: []SearchResult{}})
		return
	}

	results := buildSearchResults(chromaResp)
	writeJSON(w, http.StatusOK, SearchResponse{Results: results})
}

func buildSearchResults(resp *chromaQueryResponse) []SearchResult {
	if resp == nil || len(resp.IDs) == 0 || len(resp.IDs[0]) == 0 {
		return []SearchResult{}
	}

	ids := resp.IDs[0]
	results := make([]SearchResult, 0, len(ids))

	for i, id := range ids {
		var content string
		if i < len(resp.Documents) && i < len(resp.Documents[0]) {
			content = resp.Documents[0][i]
		}

		var score float64
		if i < len(resp.Distances) && i < len(resp.Distances[0]) {
			score = 1.0 - resp.Distances[0][i] // convert distance to similarity
		}

		source := id
		if i < len(resp.Metadatas) && i < len(resp.Metadatas[0]) {
			if path, ok := resp.Metadatas[0][i]["path"]; ok {
				if pathStr, ok := path.(string); ok {
					source = pathStr
				}
			}
		}

		results = append(results, SearchResult{
			Content: content,
			Score:   score,
			Source:  source,
		})
	}
	return results
}

func (s *Server) handleIngest(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}

	var req IngestRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON: " + err.Error()})
		return
	}

	if len(req.Documents) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "documents array is required"})
		return
	}
	if req.Namespace == "" {
		req.Namespace = "default"
	}

	// Ensure collection exists before ingest.
	if err := chromaEnsureCollection(r.Context(), s.client, s.cfg.chromaURL, req.Namespace); err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "ensure collection failed: " + err.Error()})
		return
	}

	// Get embeddings for all documents.
	texts := make([]string, len(req.Documents))
	for i, d := range req.Documents {
		texts[i] = d.Content
	}

	embeddings, err := getEmbeddings(r.Context(), s.client, s.cfg.embedURL, texts)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "embedding failed: " + err.Error()})
		return
	}

	// Upsert into ChromaDB.
	if err := chromaUpsert(r.Context(), s.client, s.cfg.chromaURL, req.Namespace, req.Documents, embeddings); err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "chroma upsert failed: " + err.Error()})
		return
	}

	writeJSON(w, http.StatusOK, IngestResponse{Ingested: len(req.Documents)})
}

// Handler returns the http.Handler for this server.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/health", s.handleHealth)
	mux.HandleFunc("/search", s.handleSearch)
	mux.HandleFunc("/ingest", s.handleIngest)
	return mux
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func writeJSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		log.Printf("error encoding JSON response: %v", err)
	}
}



// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

func main() {
	cfg := loadConfig()

	if cfg.chromaURL == "" {
		log.Fatal("CHROMA_URL environment variable is required")
	}
	if cfg.embedURL == "" {
		log.Fatal("EMBED_URL environment variable is required")
	}

	srv := NewServer(cfg)
	httpServer := &http.Server{
		Addr:         ":" + cfg.port,
		Handler:      srv.Handler(),
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 30 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	// Graceful shutdown.
	done := make(chan os.Signal, 1)
	signal.Notify(done, os.Interrupt, syscall.SIGTERM)

	go func() {
		log.Printf("[rag] listening on :%s", cfg.port)
		if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("[rag] server error: %v", err)
		}
	}()

	<-done
	log.Println("[rag] shutting down...")

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := httpServer.Shutdown(ctx); err != nil {
		log.Fatalf("[rag] shutdown error: %v", err)
	}

}
