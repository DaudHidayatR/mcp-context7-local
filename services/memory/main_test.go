package main

import (
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// ---------------------------------------------------------------------------
// Tests — Memory Service
// ---------------------------------------------------------------------------

func newTestListener(t *testing.T) net.Listener {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Skipf("cannot bind test listener: %v", err)
	}
	return l
}

func newTestServer(t *testing.T, handler http.Handler) *httptest.Server {
	t.Helper()
	ts := &httptest.Server{
		Listener: newTestListener(t),
		Config:   &http.Server{Handler: handler},
	}
	ts.Start()
	return ts
}

func TestWriteAndRead(t *testing.T) {
	store := NewMemStore()
	srv := NewHTTPServer(store)
	ts := newTestServer(t, srv.Handler())
	defer ts.Close()

	tests := []struct {
		name        string
		writeBody   string
		readBody    string
		wantVersion int
		wantFound   bool
	}{
		{
			name:        "first write creates version 1",
			writeBody:   `{"scope":"project","namespace":"my-app","key":"config","value":{"db":"pg"}}`,
			readBody:    `{"scope":"project","namespace":"my-app","key":"config"}`,
			wantVersion: 1,
			wantFound:   true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// Write
			resp, err := http.Post(ts.URL+"/write", "application/json", strings.NewReader(tt.writeBody))
			if err != nil {
				t.Fatalf("write request failed: %v", err)
			}
			defer resp.Body.Close()

			if resp.StatusCode != http.StatusOK {
				t.Fatalf("write status = %d, want 200", resp.StatusCode)
			}

			var writeResult WriteResult
			json.NewDecoder(resp.Body).Decode(&writeResult)
			if !writeResult.OK {
				t.Fatal("expected ok: true")
			}
			if writeResult.VersionID != tt.wantVersion {
				t.Fatalf("version = %d, want %d", writeResult.VersionID, tt.wantVersion)
			}

			// Read
			resp2, err := http.Post(ts.URL+"/read", "application/json", strings.NewReader(tt.readBody))
			if err != nil {
				t.Fatalf("read request failed: %v", err)
			}
			defer resp2.Body.Close()

			var readResult ReadResult
			json.NewDecoder(resp2.Body).Decode(&readResult)
			if readResult.Found != tt.wantFound {
				t.Fatalf("found = %v, want %v", readResult.Found, tt.wantFound)
			}
			if readResult.Version != tt.wantVersion {
				t.Fatalf("version = %d, want %d", readResult.Version, tt.wantVersion)
			}
		})
	}
}

func TestUpsertIncrementsVersion(t *testing.T) {
	store := NewMemStore()
	srv := NewHTTPServer(store)
	ts := newTestServer(t, srv.Handler())
	defer ts.Close()

	tests := []struct {
		name        string
		writeCount  int
		wantVersion int
	}{
		{
			name:        "single write gives version 1",
			writeCount:  1,
			wantVersion: 1,
		},
		{
			name:        "double write gives version 2",
			writeCount:  2,
			wantVersion: 2,
		},
		{
			name:        "triple write gives version 3",
			writeCount:  3,
			wantVersion: 3,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			testStore := NewMemStore()
			testSrv := NewHTTPServer(testStore)
			testTS := newTestServer(t, testSrv.Handler())
			defer testTS.Close()

			var lastVersion int
			for i := 0; i < tt.writeCount; i++ {
				body := `{"scope":"test","namespace":"ns","key":"k1","value":{"attempt":` +
					strings.Repeat("1", i+1) + `}}`

				resp, err := http.Post(testTS.URL+"/write", "application/json", strings.NewReader(body))
				if err != nil {
					t.Fatalf("write %d failed: %v", i+1, err)
				}

				var result WriteResult
				json.NewDecoder(resp.Body).Decode(&result)
				resp.Body.Close()

				if !result.OK {
					t.Fatalf("write %d: expected ok", i+1)
				}
				lastVersion = result.VersionID
			}

			if lastVersion != tt.wantVersion {
				t.Fatalf("final version = %d, want %d", lastVersion, tt.wantVersion)
			}

			// Verify via read
			resp, _ := http.Post(testTS.URL+"/read", "application/json",
				strings.NewReader(`{"scope":"test","namespace":"ns","key":"k1"}`))
			var readResult ReadResult
			json.NewDecoder(resp.Body).Decode(&readResult)
			resp.Body.Close()

			if readResult.Version != tt.wantVersion {
				t.Fatalf("read version = %d, want %d", readResult.Version, tt.wantVersion)
			}
		})
	}
}

func TestUpsertResetsAge(t *testing.T) {
	store := NewMemStore()
	srv := NewHTTPServer(store)
	ts := newTestServer(t, srv.Handler())
	defer ts.Close()

	resp, err := http.Post(ts.URL+"/write", "application/json",
		strings.NewReader(`{"scope":"project","namespace":"my-app","key":"config","value":{"attempt":1}}`))
	if err != nil {
		t.Fatalf("first write failed: %v", err)
	}
	resp.Body.Close()

	time.Sleep(1100 * time.Millisecond)

	resp, err = http.Post(ts.URL+"/write", "application/json",
		strings.NewReader(`{"scope":"project","namespace":"my-app","key":"config","value":{"attempt":2}}`))
	if err != nil {
		t.Fatalf("second write failed: %v", err)
	}
	resp.Body.Close()

	resp, err = http.Post(ts.URL+"/read", "application/json",
		strings.NewReader(`{"scope":"project","namespace":"my-app","key":"config"}`))
	if err != nil {
		t.Fatalf("read failed: %v", err)
	}
	defer resp.Body.Close()

	var readResult ReadResult
	json.NewDecoder(resp.Body).Decode(&readResult)

	if readResult.AgeSeconds != 0 {
		t.Fatalf("age_seconds = %d, want 0 after overwrite", readResult.AgeSeconds)
	}
}

func TestExpiredRowsNotReturnedByList(t *testing.T) {
	tests := []struct {
		name       string
		ttl        int
		sleepMs    int
		wantKeys   int
		wantInList bool
	}{
		{
			name:       "non-expired entry is listed",
			ttl:        60,
			sleepMs:    0,
			wantKeys:   1,
			wantInList: true,
		},
		{
			name:       "expired entry is not listed",
			ttl:        1,    // 1 second TTL
			sleepMs:    1100, // sleep 1.1 seconds
			wantKeys:   0,
			wantInList: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store := NewMemStore()
			srv := NewHTTPServer(store)
			ts := newTestServer(t, srv.Handler())
			defer ts.Close()

			// Write an entry with TTL
			writeBody := `{"scope":"s","namespace":"n","key":"expiring-key","value":{"x":1},"ttl_seconds":` +
				strings.ReplaceAll(strings.Repeat("0", 0)+itoa(tt.ttl), " ", "") + `}`

			resp, err := http.Post(ts.URL+"/write", "application/json", strings.NewReader(writeBody))
			if err != nil {
				t.Fatalf("write failed: %v", err)
			}
			resp.Body.Close()

			if tt.sleepMs > 0 {
				time.Sleep(time.Duration(tt.sleepMs) * time.Millisecond)
			}

			// List entries
			listResp, err := http.Post(ts.URL+"/list", "application/json",
				strings.NewReader(`{"scope":"s","namespace":"n"}`))
			if err != nil {
				t.Fatalf("list failed: %v", err)
			}
			defer listResp.Body.Close()

			var listResult ListResponse
			json.NewDecoder(listResp.Body).Decode(&listResult)

			if len(listResult.Keys) != tt.wantKeys {
				t.Fatalf("keys count = %d, want %d", len(listResult.Keys), tt.wantKeys)
			}

			if tt.wantInList && len(listResult.Keys) > 0 && listResult.Keys[0] != "expiring-key" {
				t.Fatalf("expected key 'expiring-key', got %q", listResult.Keys[0])
			}
		})
	}
}

func TestExpiredRowsNotReturnedByRead(t *testing.T) {
	store := NewMemStore()
	srv := NewHTTPServer(store)
	ts := newTestServer(t, srv.Handler())
	defer ts.Close()

	// Write with 1-second TTL
	resp, _ := http.Post(ts.URL+"/write", "application/json",
		strings.NewReader(`{"scope":"s","namespace":"n","key":"ttl-key","value":{"x":1},"ttl_seconds":1}`))
	resp.Body.Close()

	// Wait for expiry
	time.Sleep(1100 * time.Millisecond)

	// Read should return not found
	resp2, _ := http.Post(ts.URL+"/read", "application/json",
		strings.NewReader(`{"scope":"s","namespace":"n","key":"ttl-key"}`))
	defer resp2.Body.Close()

	var result ReadResult
	json.NewDecoder(resp2.Body).Decode(&result)
	if result.Found {
		t.Fatal("expected expired entry to not be found")
	}
}

func TestListWithTags(t *testing.T) {
	store := NewMemStore()
	srv := NewHTTPServer(store)
	ts := newTestServer(t, srv.Handler())
	defer ts.Close()

	// Write entries with different tags
	entries := []string{
		`{"scope":"s","namespace":"n","key":"k1","value":{},"tags":["frontend","react"]}`,
		`{"scope":"s","namespace":"n","key":"k2","value":{},"tags":["backend","go"]}`,
		`{"scope":"s","namespace":"n","key":"k3","value":{},"tags":["frontend","vue"]}`,
	}
	for _, body := range entries {
		resp, _ := http.Post(ts.URL+"/write", "application/json", strings.NewReader(body))
		resp.Body.Close()
	}

	tests := []struct {
		name     string
		listBody string
		wantKeys int
	}{
		{
			name:     "filter by frontend tag",
			listBody: `{"scope":"s","namespace":"n","tags":["frontend"]}`,
			wantKeys: 2,
		},
		{
			name:     "filter by backend tag",
			listBody: `{"scope":"s","namespace":"n","tags":["backend"]}`,
			wantKeys: 1,
		},
		{
			name:     "filter by multiple tags (intersection)",
			listBody: `{"scope":"s","namespace":"n","tags":["frontend","react"]}`,
			wantKeys: 1,
		},
		{
			name:     "no filter returns all",
			listBody: `{"scope":"s","namespace":"n"}`,
			wantKeys: 3,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			resp, _ := http.Post(ts.URL+"/list", "application/json", strings.NewReader(tt.listBody))
			defer resp.Body.Close()

			var result ListResponse
			json.NewDecoder(resp.Body).Decode(&result)
			if len(result.Keys) != tt.wantKeys {
				t.Fatalf("keys count = %d, want %d (keys: %v)", len(result.Keys), tt.wantKeys, result.Keys)
			}
		})
	}
}

func TestHealthEndpoint(t *testing.T) {
	store := NewMemStore()
	srv := NewHTTPServer(store)
	ts := newTestServer(t, srv.Handler())
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/health")
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

func TestReadNotFound(t *testing.T) {
	store := NewMemStore()
	srv := NewHTTPServer(store)
	ts := newTestServer(t, srv.Handler())
	defer ts.Close()

	resp, _ := http.Post(ts.URL+"/read", "application/json",
		strings.NewReader(`{"scope":"s","namespace":"n","key":"nonexistent"}`))
	defer resp.Body.Close()

	var result ReadResult
	json.NewDecoder(resp.Body).Decode(&result)
	if result.Found {
		t.Fatal("expected not found for nonexistent key")
	}
}

func TestTagFilteringWorks(t *testing.T) {
	store := NewMemStore()
	srv := NewHTTPServer(store)
	ts := newTestServer(t, srv.Handler())
	defer ts.Close()

	// Write two entries with different tag sets
	entries := []string{
		`{"scope":"project","namespace":"app","key":"decision-1","value":{"x":1},"tags":["session","feature_dev"]}`,
		`{"scope":"project","namespace":"app","key":"decision-2","value":{"x":2},"tags":["session","incident"]}`,
	}
	for _, body := range entries {
		resp, err := http.Post(ts.URL+"/write", "application/json", strings.NewReader(body))
		if err != nil {
			t.Fatalf("write failed: %v", err)
		}
		resp.Body.Close()
	}

	// Filter by "incident" tag — should return only decision-2
	resp, err := http.Post(ts.URL+"/list", "application/json",
		strings.NewReader(`{"scope":"project","namespace":"app","tags":["incident"]}`))
	if err != nil {
		t.Fatalf("list failed: %v", err)
	}
	defer resp.Body.Close()

	var result ListResponse
	json.NewDecoder(resp.Body).Decode(&result)

	if len(result.Keys) != 1 {
		t.Fatalf("expected 1 key, got %d (keys: %v)", len(result.Keys), result.Keys)
	}
	if result.Keys[0] != "decision-2" {
		t.Fatalf("expected key 'decision-2', got %q", result.Keys[0])
	}
}

// itoa is a minimal int-to-string for test data.
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	result := ""
	for n > 0 {
		result = string(rune('0'+n%10)) + result
		n /= 10
	}
	return result
}
