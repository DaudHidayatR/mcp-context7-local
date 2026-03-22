// Package main implements a Go HTTP server for agent memory backed by Postgres.
// It provides read, write, and list operations with TTL expiry, version tracking,
// and tag-based filtering.
package main

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/lib/pq"
)

// ---------------------------------------------------------------------------
// Database schema & migration
// ---------------------------------------------------------------------------

const migrationSQL = `
CREATE TABLE IF NOT EXISTS agent_memory (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scope       TEXT NOT NULL,
    namespace   TEXT NOT NULL,
    key         TEXT NOT NULL,
    value       JSONB NOT NULL,
    version     INT NOT NULL DEFAULT 1,
    expires_at  TIMESTAMPTZ,
    created_by  TEXT,
    accessed_at TIMESTAMPTZ DEFAULT NOW(),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    checksum    TEXT,
    tags        TEXT[]
);

ALTER TABLE agent_memory
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_memory_scope_ns_key
    ON agent_memory (scope, namespace, key);
`

// ---------------------------------------------------------------------------
// Store interface (allows mocking in tests)
// ---------------------------------------------------------------------------

// Store is the persistence interface for agent memory.
type Store interface {
	Read(ctx context.Context, scope, namespace, key string) (*ReadResult, error)
	ReadAll(ctx context.Context, scope, namespace string) ([]KeyValue, error)
	Write(ctx context.Context, req WriteRequest) (*WriteResult, error)
	List(ctx context.Context, scope, namespace string, tags []string) ([]string, error)
}

// KeyValue holds a stored entry returned by bulk reads.
type KeyValue struct {
	Key        string          `json:"key"`
	Value      json.RawMessage `json:"value"`
	AgeSeconds int             `json:"age_seconds"`
	Version    int             `json:"version"`
}

// ReadResult holds data returned by a read operation.
type ReadResult struct {
	Value      json.RawMessage `json:"value"`
	Found      bool            `json:"found"`
	AgeSeconds int             `json:"age_seconds"`
	Version    int             `json:"version"`
}

// WriteRequest is the input for a write operation.
type WriteRequest struct {
	Scope      string          `json:"scope"`
	Namespace  string          `json:"namespace"`
	Key        string          `json:"key"`
	Value      json.RawMessage `json:"value"`
	TTLSeconds *int            `json:"ttl_seconds,omitempty"`
	Tags       []string        `json:"tags,omitempty"`
}

// WriteResult holds data returned by a write operation.
type WriteResult struct {
	OK        bool `json:"ok"`
	VersionID int  `json:"version_id"`
}

// ---------------------------------------------------------------------------
// Postgres store implementation
// ---------------------------------------------------------------------------

// PgStore implements Store using Postgres.
type PgStore struct {
	db *sql.DB
}

// NewPgStore creates a new Postgres-backed store and runs migrations.
func NewPgStore(databaseURL string) (*PgStore, error) {
	db, err := sql.Open("postgres", databaseURL)
	if err != nil {
		return nil, fmt.Errorf("open database: %w", err)
	}

	db.SetMaxOpenConns(25)
	db.SetMaxIdleConns(5)
	db.SetConnMaxLifetime(5 * time.Minute)

	if err := db.Ping(); err != nil {
		return nil, fmt.Errorf("ping database: %w", err)
	}

	if _, err := db.Exec(migrationSQL); err != nil {
		return nil, fmt.Errorf("run migration: %w", err)
	}

	return &PgStore{db: db}, nil
}

func (s *PgStore) Read(ctx context.Context, scope, namespace, key string) (*ReadResult, error) {
	var value json.RawMessage
	var version int
	var createdAt time.Time

	err := s.db.QueryRowContext(ctx, `
		UPDATE agent_memory
		SET accessed_at = NOW()
		WHERE scope = $1 AND namespace = $2 AND key = $3
			AND (expires_at IS NULL OR expires_at > NOW())
		RETURNING value, version, created_at
	`, scope, namespace, key).Scan(&value, &version, &createdAt)

	if err == sql.ErrNoRows {
		return &ReadResult{Found: false}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read query: %w", err)
	}

	age := int(time.Since(createdAt).Seconds())
	return &ReadResult{
		Value:      value,
		Found:      true,
		AgeSeconds: age,
		Version:    version,
	}, nil
}

func (s *PgStore) ReadAll(ctx context.Context, scope, namespace string) ([]KeyValue, error) {
	rows, err := s.db.QueryContext(ctx, `
		UPDATE agent_memory
		SET accessed_at = NOW()
		WHERE scope = $1 AND namespace = $2
			AND (expires_at IS NULL OR expires_at > NOW())
		RETURNING key, value, version, created_at
	`, scope, namespace)
	if err != nil {
		return nil, fmt.Errorf("read all query: %w", err)
	}
	defer rows.Close()

	entries := []KeyValue{}
	for rows.Next() {
		var key string
		var value json.RawMessage
		var version int
		var createdAt time.Time
		if err := rows.Scan(&key, &value, &version, &createdAt); err != nil {
			return nil, fmt.Errorf("scan read all row: %w", err)
		}

		entries = append(entries, KeyValue{
			Key:        key,
			Value:      value,
			AgeSeconds: int(time.Since(createdAt).Seconds()),
			Version:    version,
		})
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read all rows: %w", err)
	}

	return entries, nil
}

func (s *PgStore) Write(ctx context.Context, req WriteRequest) (*WriteResult, error) {
	checksum := fmt.Sprintf("%x", sha256.Sum256(req.Value))

	var expiresAt *time.Time
	if req.TTLSeconds != nil && *req.TTLSeconds > 0 {
		t := time.Now().Add(time.Duration(*req.TTLSeconds) * time.Second)
		expiresAt = &t
	}

	var version int
	err := s.db.QueryRowContext(ctx, `
		INSERT INTO agent_memory (scope, namespace, key, value, version, expires_at, checksum, tags)
		VALUES ($1, $2, $3, $4, 1, $5, $6, $7)
		ON CONFLICT (scope, namespace, key) DO UPDATE SET
			value = EXCLUDED.value,
			version = agent_memory.version + 1,
			expires_at = EXCLUDED.expires_at,
			checksum = EXCLUDED.checksum,
			tags = EXCLUDED.tags,
			accessed_at = NOW(),
			created_at = NOW()
		RETURNING version
	`, req.Scope, req.Namespace, req.Key, req.Value, expiresAt, checksum, pq.Array(req.Tags)).Scan(&version)

	if err != nil {
		return nil, fmt.Errorf("write query: %w", err)
	}

	return &WriteResult{OK: true, VersionID: version}, nil
}

func (s *PgStore) List(ctx context.Context, scope, namespace string, tags []string) ([]string, error) {
	var rows *sql.Rows
	var err error

	if len(tags) > 0 {
		rows, err = s.db.QueryContext(ctx, `
			SELECT key FROM agent_memory
			WHERE scope = $1 AND namespace = $2
				AND (expires_at IS NULL OR expires_at > NOW())
				AND tags @> $3
			ORDER BY key
		`, scope, namespace, pq.Array(tags))
	} else {
		rows, err = s.db.QueryContext(ctx, `
			SELECT key FROM agent_memory
			WHERE scope = $1 AND namespace = $2
				AND (expires_at IS NULL OR expires_at > NOW())
			ORDER BY key
		`, scope, namespace)
	}

	if err != nil {
		return nil, fmt.Errorf("list query: %w", err)
	}
	defer rows.Close()

	var keys []string
	for rows.Next() {
		var key string
		if err := rows.Scan(&key); err != nil {
			return nil, fmt.Errorf("scan key: %w", err)
		}
		keys = append(keys, key)
	}

	if keys == nil {
		keys = []string{}
	}
	return keys, rows.Err()
}

// ---------------------------------------------------------------------------
// In-memory store (for testing without Postgres)
// ---------------------------------------------------------------------------

type memEntry struct {
	Value     json.RawMessage
	Version   int
	ExpiresAt *time.Time
	Tags      []string
	WrittenAt time.Time
}

// MemStore is an in-memory Store implementation for testing.
type MemStore struct {
	data map[string]*memEntry
}

// NewMemStore creates a new in-memory store.
func NewMemStore() *MemStore {
	return &MemStore{data: make(map[string]*memEntry)}
}

func memKey(scope, namespace, key string) string {
	return scope + "::" + namespace + "::" + key
}

func (s *MemStore) Read(_ context.Context, scope, namespace, key string) (*ReadResult, error) {
	k := memKey(scope, namespace, key)
	entry, ok := s.data[k]
	if !ok {
		return &ReadResult{Found: false}, nil
	}

	if entry.ExpiresAt != nil && entry.ExpiresAt.Before(time.Now()) {
		delete(s.data, k)
		return &ReadResult{Found: false}, nil
	}

	age := int(time.Since(entry.WrittenAt).Seconds())
	return &ReadResult{
		Value:      entry.Value,
		Found:      true,
		AgeSeconds: age,
		Version:    entry.Version,
	}, nil
}

func (s *MemStore) Write(_ context.Context, req WriteRequest) (*WriteResult, error) {
	k := memKey(req.Scope, req.Namespace, req.Key)

	version := 1
	if existing, ok := s.data[k]; ok {
		version = existing.Version + 1
	}

	var expiresAt *time.Time
	if req.TTLSeconds != nil && *req.TTLSeconds > 0 {
		t := time.Now().Add(time.Duration(*req.TTLSeconds) * time.Second)
		expiresAt = &t
	}

	s.data[k] = &memEntry{
		Value:     req.Value,
		Version:   version,
		ExpiresAt: expiresAt,
		Tags:      req.Tags,
		WrittenAt: time.Now(),
	}

	return &WriteResult{OK: true, VersionID: version}, nil
}

func (s *MemStore) ReadAll(_ context.Context, scope, namespace string) ([]KeyValue, error) {
	prefix := scope + "::" + namespace + "::"
	entries := []KeyValue{}

	for k, entry := range s.data {
		if !strings.HasPrefix(k, prefix) {
			continue
		}

		if entry.ExpiresAt != nil && entry.ExpiresAt.Before(time.Now()) {
			delete(s.data, k)
			continue
		}

		entries = append(entries, KeyValue{
			Key:        strings.TrimPrefix(k, prefix),
			Value:      entry.Value,
			AgeSeconds: int(time.Since(entry.WrittenAt).Seconds()),
			Version:    entry.Version,
		})
	}

	return entries, nil
}

func (s *MemStore) List(_ context.Context, scope, namespace string, tags []string) ([]string, error) {
	prefix := scope + "::" + namespace + "::"
	var keys []string

	for k, entry := range s.data {
		if !strings.HasPrefix(k, prefix) {
			continue
		}

		if entry.ExpiresAt != nil && entry.ExpiresAt.Before(time.Now()) {
			delete(s.data, k)
			continue
		}

		if len(tags) > 0 && !containsAll(entry.Tags, tags) {
			continue
		}

		key := strings.TrimPrefix(k, prefix)
		keys = append(keys, key)
	}

	if keys == nil {
		keys = []string{}
	}
	return keys, nil
}

func containsAll(haystack, needles []string) bool {
	set := make(map[string]bool, len(haystack))
	for _, s := range haystack {
		set[s] = true
	}
	for _, n := range needles {
		if !set[n] {
			return false
		}
	}
	return true
}

// ---------------------------------------------------------------------------
// HTTP Handlers
// ---------------------------------------------------------------------------

// Server holds shared dependencies for request handlers.
type Server struct {
	store Store
}

// NewHTTPServer creates a new server with the given store.
func NewHTTPServer(store Store) *Server {
	return &Server{store: store}
}

// ReadRequest is the JSON body for POST /read.
type ReadRequest struct {
	Scope     string `json:"scope"`
	Namespace string `json:"namespace"`
	Key       string `json:"key"`
}

// ReadAllRequest is the JSON body for POST /read-all.
type ReadAllRequest struct {
	Scope     string `json:"scope"`
	Namespace string `json:"namespace"`
}

// ReadAllResponse is the JSON response for POST /read-all.
type ReadAllResponse struct {
	Entries []KeyValue `json:"entries"`
}

// ListRequest is the JSON body for POST /list.
type ListRequest struct {
	Scope     string   `json:"scope"`
	Namespace string   `json:"namespace"`
	Tags      []string `json:"tags,omitempty"`
}

// ListResponse is the JSON response for POST /list.
type ListResponse struct {
	Keys []string `json:"keys"`
}

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleRead(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}

	var req ReadRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON: " + err.Error()})
		return
	}

	if req.Scope == "" || req.Namespace == "" || req.Key == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "scope, namespace, and key are required"})
		return
	}

	result, err := s.store.Read(r.Context(), req.Scope, req.Namespace, req.Key)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	writeJSON(w, http.StatusOK, result)
}

func (s *Server) handleReadAll(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}

	var req ReadAllRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON: " + err.Error()})
		return
	}

	if req.Scope == "" || req.Namespace == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "scope and namespace are required"})
		return
	}

	entries, err := s.store.ReadAll(r.Context(), req.Scope, req.Namespace)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	writeJSON(w, http.StatusOK, ReadAllResponse{Entries: entries})
}

func (s *Server) handleWrite(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}

	var req WriteRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON: " + err.Error()})
		return
	}

	if req.Scope == "" || req.Namespace == "" || req.Key == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "scope, namespace, and key are required"})
		return
	}

	if req.Value == nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "value is required"})
		return
	}

	result, err := s.store.Write(r.Context(), req)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	writeJSON(w, http.StatusOK, result)
}

func (s *Server) handleList(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}

	var req ListRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON: " + err.Error()})
		return
	}

	if req.Scope == "" || req.Namespace == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "scope and namespace are required"})
		return
	}

	keys, err := s.store.List(r.Context(), req.Scope, req.Namespace, req.Tags)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	writeJSON(w, http.StatusOK, ListResponse{Keys: keys})
}

// Handler returns the http.Handler for this server.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/health", s.handleHealth)
	mux.HandleFunc("/read", s.handleRead)
	mux.HandleFunc("/read-all", s.handleReadAll)
	mux.HandleFunc("/write", s.handleWrite)
	mux.HandleFunc("/list", s.handleList)
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
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		log.Fatal("DATABASE_URL environment variable is required")
	}

	port := os.Getenv("PORT")
	if port == "" {
		port = "8082"
	}

	store, err := NewPgStore(databaseURL)
	if err != nil {
		log.Fatalf("failed to initialize store: %v", err)
	}

	srv := NewHTTPServer(store)
	httpServer := &http.Server{
		Addr:         ":" + port,
		Handler:      srv.Handler(),
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 30 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	// Graceful shutdown.
	done := make(chan os.Signal, 1)
	signal.Notify(done, os.Interrupt, syscall.SIGTERM)

	go func() {
		log.Printf("[memory] listening on :%s", port)
		if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("[memory] server error: %v", err)
		}
	}()

	<-done
	log.Println("[memory] shutting down...")

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := httpServer.Shutdown(ctx); err != nil {
		log.Fatalf("[memory] shutdown error: %v", err)
	}
}
