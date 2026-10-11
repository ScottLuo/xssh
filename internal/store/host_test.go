package store

import (
	"encoding/json"
	"testing"
)

func TestHost_JSONRoundTrip(t *testing.T) {
	original := Host{
		ID:         "abc-123",
		Name:       "Production Server",
		Host:       "192.168.1.100",
		Port:       22,
		User:       "deploy",
		AuthType:   "key",
		AuthSecret: "secret-data",
		Shell:      "/bin/bash",
		InitCmds:   []string{"cd /var/www", "export PATH=/usr/local/bin:$PATH"},
		Color:      "#4CAF50",
		CreatedAt:  "2026-01-01T00:00:00Z",
		UpdatedAt:  "2026-01-02T00:00:00Z",
	}

	data, err := json.Marshal(original)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var decoded Host
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	// Re-marshal decoded and compare byte-for-byte.
	reData, err := json.Marshal(decoded)
	if err != nil {
		t.Fatalf("re-marshal: %v", err)
	}
	if string(data) != string(reData) {
		t.Fatalf("round-trip mismatch:\noriginal: %s\ndecoded:  %s", data, reData)
	}
}

func TestHost_JSONTags(t *testing.T) {
	h := Host{
		ID:         "id1",
		Name:       "name1",
		Host:       "host1",
		Port:       22,
		User:       "user1",
		AuthType:   "key",
		AuthSecret: "sec1",
		Shell:      "/bin/sh",
		InitCmds:   []string{"cmd1"},
		Color:      "#FF0000",
		CreatedAt:  "2026-01-01T00:00:00Z",
		UpdatedAt:  "2026-01-02T00:00:00Z",
	}

	data, err := json.Marshal(&h)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var m map[string]interface{}
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatalf("unmarshal to map: %v", err)
	}

	expectedKeys := []string{
		"id", "name", "host", "port", "user",
		"auth_type", "auth_secret", "shell", "init_cmds",
		"color", "created_at", "updated_at",
	}
	for _, key := range expectedKeys {
		if _, ok := m[key]; !ok {
			t.Errorf("missing expected JSON key: %q in %s", key, data)
		}
	}
}

func TestHost_ZeroValue(t *testing.T) {
	var h Host
	if h.ID != "" || h.Port != 0 || h.Host != "" {
		t.Fatal("zero value Host should have empty fields")
	}
	if h.InitCmds != nil {
		t.Fatal("zero value Host should have nil InitCmds")
	}
}
