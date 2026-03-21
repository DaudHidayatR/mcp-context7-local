package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// ---------------------------------------------------------------------------
// Mock ChromaDB server
// ---------------------------------------------------------------------------

func newMockChromaDB(withResults bool) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		// Handle collection query
		if strings.Contains(r.URL.Path, "/query") {
			if withResults {
				json.NewEncoder(w).Encode(chromaQueryResponse{
					IDs:       [][]string{{"doc-1", "doc-2"}},
					Documents: [][]string{{"Hello world content", "Second document"}},
					Distances: [][]float64{{0.1, 0.3}},
					Metadatas: [][]chromaMeta{
						{
							{"path": "readme.md"},
							{"path": "docs/intro.md"},
						},
					},
				})
			} else {
				// Empty results — no error
				json.NewEncoder(w).Encode(chromaQueryResponse{
					IDs:       [][]string{{}},
					Documents: [][]string{{}},
					Distances: [][]float64{{}},
					Metadatas: [][]chromaMeta{{}},
				})
			}
			return
		}

		// Handle upsert
		if strings.Contains(r.URL.Path, "/upsert") {
			w.WriteHeader(http.StatusOK)
			fmt.Fprint(w, `true`)
			return
		}

		w.WriteHeader(http.StatusNotFound)
	}))
}

// ---------------------------------------------------------------------------
// Mock Embedding server
// ---------------------------------------------------------------------------

func newMockEmbedServer() *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/embeddings" {
			w.WriteHeader(http.StatusNotFound)
			return
		}

		var req embeddingRequest
		json.NewDecoder(r.Body).Decode(&req)

		data := make([]embeddingData, len(req.Input))
		for i := range req.Input {
			// Return a simple deterministic embedding
			data[i] = embeddingData{
				Index:     i,
				Embedding: []float64{0.1, 0.2, 0.3, 0.4},
			}
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(embeddingResponse{Data: data})
	}))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

func TestSearchEndpoint(t *testing.T) {
	tests := []struct {
		name           string
		chromaResults  bool
		body           string
		wantStatus     int
		wantEmpty      bool
		wantResultsLen int
	}{
		{
			name:           "returns empty array when ChromaDB has no results",
			chromaResults:  false,
			body:           `{"query":"nonexistent topic","top_k":5,"namespace":"test-collection"}`,
			wantStatus:     http.StatusOK,
			wantEmpty:      true,
			wantResultsLen: 0,
		},
		{
			name:           "returns results when ChromaDB has matching documents",
			chromaResults:  true,
			body:           `{"query":"hello world","top_k":5,"namespace":"test-collection"}`,
			wantStatus:     http.StatusOK,
			wantEmpty:      false,
			wantResultsLen: 2,
		},
		{
			name:       "returns 400 when query is missing",
			body:       `{"top_k":5,"namespace":"test-collection"}`,
			wantStatus: http.StatusBadRequest,
		},
		{
			name:           "defaults top_k to 5 when not provided",
			chromaResults:  true,
			body:           `{"query":"hello","namespace":"test-collection"}`,
			wantStatus:     http.StatusOK,
			wantResultsLen: 2,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			chromaServer := newMockChromaDB(tt.chromaResults)
			defer chromaServer.Close()

			embedServer := newMockEmbedServer()
			defer embedServer.Close()

			srv := NewServer(config{
				chromaURL: chromaServer.URL,
				embedURL:  embedServer.URL,
				port:      "0",
			})

			ragServer := httptest.NewServer(srv.Handler())
			defer ragServer.Close()

			resp, err := http.Post(ragServer.URL+"/search", "application/json", strings.NewReader(tt.body))
			if err != nil {
				t.Fatalf("request failed: %v", err)
			}
			defer resp.Body.Close()

			if resp.StatusCode != tt.wantStatus {
				t.Fatalf("status = %d, want %d", resp.StatusCode, tt.wantStatus)
			}

			if tt.wantStatus != http.StatusOK {
				return
			}

			var result SearchResponse
			if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
				t.Fatalf("decode response: %v", err)
			}

			if result.Results == nil {
				t.Fatal("results should not be nil, expected empty array")
			}

			if len(result.Results) != tt.wantResultsLen {
				t.Fatalf("results len = %d, want %d", len(result.Results), tt.wantResultsLen)
			}

			if tt.wantEmpty && len(result.Results) != 0 {
				t.Fatalf("expected empty results, got %d", len(result.Results))
			}

			if !tt.wantEmpty && len(result.Results) > 0 {
				if result.Results[0].Content == "" {
					t.Error("first result content should not be empty")
				}
				if result.Results[0].Score <= 0 {
					t.Error("first result score should be positive")
				}
			}
		})
	}
}

func TestSearchReturnsEmptyNotError(t *testing.T) {
	// This is the specific test required by the spec:
	// "RAG service: /search returns empty array (not error) when ChromaDB has no results"
	chromaServer := newMockChromaDB(false)
	defer chromaServer.Close()

	embedServer := newMockEmbedServer()
	defer embedServer.Close()

	srv := NewServer(config{
		chromaURL: chromaServer.URL,
		embedURL:  embedServer.URL,
		port:      "0",
	})

	ragServer := httptest.NewServer(srv.Handler())
	defer ragServer.Close()

	resp, err := http.Post(
		ragServer.URL+"/search",
		"application/json",
		strings.NewReader(`{"query":"anything","top_k":3,"namespace":"empty-ns"}`),
	)
	if err != nil {
		t.Fatalf("request failed: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}

	var result SearchResponse
	json.NewDecoder(resp.Body).Decode(&result)

	if result.Results == nil {
		t.Fatal("results must be non-nil empty array")
	}
	if len(result.Results) != 0 {
		t.Fatalf("expected 0 results, got %d", len(result.Results))
	}
}

func TestSearchChromaError(t *testing.T) {
	// When ChromaDB is unreachable / errors, /search still returns empty array.
	badChroma := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		fmt.Fprint(w, `{"error":"internal"}`)
	}))
	defer badChroma.Close()

	embedServer := newMockEmbedServer()
	defer embedServer.Close()

	srv := NewServer(config{
		chromaURL: badChroma.URL,
		embedURL:  embedServer.URL,
		port:      "0",
	})

	ragServer := httptest.NewServer(srv.Handler())
	defer ragServer.Close()

	resp, err := http.Post(
		ragServer.URL+"/search",
		"application/json",
		strings.NewReader(`{"query":"test","top_k":3,"namespace":"ns"}`),
	)
	if err != nil {
		t.Fatalf("request failed: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d (should degrade gracefully)", resp.StatusCode)
	}

	var result SearchResponse
	json.NewDecoder(resp.Body).Decode(&result)
	if len(result.Results) != 0 {
		t.Fatalf("expected empty results on ChromaDB error, got %d", len(result.Results))
	}
}

func TestHealthEndpoint(t *testing.T) {
	srv := NewServer(config{port: "0"})
	ragServer := httptest.NewServer(srv.Handler())
	defer ragServer.Close()

	resp, err := http.Get(ragServer.URL + "/health")
	if err != nil {
		t.Fatalf("request failed: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}

	var result map[string]bool
	json.NewDecoder(resp.Body).Decode(&result)
	if !result["ok"] {
		t.Fatal("health should return ok: true")
	}
}

func TestIngestEndpoint(t *testing.T) {
	chromaServer := newMockChromaDB(false)
	defer chromaServer.Close()

	embedServer := newMockEmbedServer()
	defer embedServer.Close()

	srv := NewServer(config{
		chromaURL: chromaServer.URL,
		embedURL:  embedServer.URL,
		port:      "0",
	})

	ragServer := httptest.NewServer(srv.Handler())
	defer ragServer.Close()

	body := `{
		"documents": [
			{"id": "d1", "content": "test content", "metadata": {"source": "test"}},
			{"id": "d2", "content": "more content", "metadata": {"source": "test"}}
		],
		"namespace": "test-ns"
	}`

	resp, err := http.Post(ragServer.URL+"/ingest", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatalf("request failed: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}

	var result IngestResponse
	json.NewDecoder(resp.Body).Decode(&result)
	if result.Ingested != 2 {
		t.Fatalf("expected 2 ingested, got %d", result.Ingested)
	}
}

func TestIngestAutoCreatesCollection(t *testing.T) {
	// Mock ChromaDB: 404 on GET collection, 201 on POST create, 200 on upsert
	collectionCreated := false
	mockChroma := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		// GET /api/v2/collections/new-ns → 404 (collection doesn't exist)
		if r.Method == http.MethodGet && strings.Contains(r.URL.Path, "/collections/") {
			w.WriteHeader(http.StatusNotFound)
			fmt.Fprint(w, `{"error":"not found"}`)
			return
		}

		// POST /api/v2/collections → 201 (create collection)
		if r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/collections") {
			collectionCreated = true
			w.WriteHeader(http.StatusCreated)
			fmt.Fprint(w, `{"name":"new-ns"}`)
			return
		}

		// POST /api/v2/collections/new-ns/upsert → 200
		if r.Method == http.MethodPost && strings.Contains(r.URL.Path, "/upsert") {
			w.WriteHeader(http.StatusOK)
			fmt.Fprint(w, `true`)
			return
		}

		w.WriteHeader(http.StatusNotFound)
	}))
	defer mockChroma.Close()

	embedServer := newMockEmbedServer()
	defer embedServer.Close()

	srv := NewServer(config{
		chromaURL: mockChroma.URL,
		embedURL:  embedServer.URL,
		port:      "0",
	})

	ragServer := httptest.NewServer(srv.Handler())
	defer ragServer.Close()

	body := `{
		"documents": [
			{"id": "d1", "content": "auto-create test", "metadata": {"source": "test"}}
		],
		"namespace": "new-ns"
	}`

	resp, err := http.Post(ragServer.URL+"/ingest", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatalf("request failed: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}

	var result IngestResponse
	json.NewDecoder(resp.Body).Decode(&result)
	if result.Ingested != 1 {
		t.Fatalf("expected 1 ingested, got %d", result.Ingested)
	}

	if !collectionCreated {
		t.Fatal("expected chromaEnsureCollection to create the collection")
	}
}
