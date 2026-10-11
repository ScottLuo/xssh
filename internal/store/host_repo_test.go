package store

import (
	"context"
	"encoding/base64"
	"testing"
)

func TestHostRepo_RoundTrip(t *testing.T) {
	edb, _ := openTestDB(t)
	repo := NewHostRepo(edb.db, edb.Key())
	ctx := context.Background()

	h := Host{
		ID:         "host-1",
		Name:       "Production",
		Host:       "10.0.0.1",
		Port:       2222,
		User:       "deploy",
		AuthType:   "key",
		AuthSecret: "my-secret-key",
		Shell:      "/bin/bash",
		InitCmds:   []string{"cd /work", "export PATH=/usr/bin:$PATH"},
		Color:      "#FF0000",
	}

	if err := repo.Put(ctx, h); err != nil {
		t.Fatalf("Put: %v", err)
	}

	got, err := repo.Get(ctx, "host-1")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}

	if got.ID != h.ID {
		t.Errorf("ID: got %q, want %q", got.ID, h.ID)
	}
	if got.Name != h.Name {
		t.Errorf("Name: got %q, want %q", got.Name, h.Name)
	}
	if got.Host != h.Host {
		t.Errorf("Host: got %q, want %q", got.Host, h.Host)
	}
	if got.Port != h.Port {
		t.Errorf("Port: got %d, want %d", got.Port, h.Port)
	}
	if got.User != h.User {
		t.Errorf("User: got %q, want %q", got.User, h.User)
	}
	if got.AuthType != h.AuthType {
		t.Errorf("AuthType: got %q, want %q", got.AuthType, h.AuthType)
	}
	if got.AuthSecret != h.AuthSecret {
		t.Errorf("AuthSecret: got %q, want %q", got.AuthSecret, h.AuthSecret)
	}
	if got.Shell != h.Shell {
		t.Errorf("Shell: got %q, want %q", got.Shell, h.Shell)
	}
	if len(got.InitCmds) != len(h.InitCmds) {
		t.Fatalf("InitCmds length: got %d, want %d", len(got.InitCmds), len(h.InitCmds))
	}
	for i, cmd := range h.InitCmds {
		if got.InitCmds[i] != cmd {
			t.Errorf("InitCmds[%d]: got %q, want %q", i, got.InitCmds[i], cmd)
		}
	}
	if got.Color != h.Color {
		t.Errorf("Color: got %q, want %q", got.Color, h.Color)
	}
	if got.CreatedAt == "" {
		t.Error("CreatedAt should not be empty")
	}
}

func TestHostRepo_Upsert(t *testing.T) {
	edb, _ := openTestDB(t)
	repo := NewHostRepo(edb.db, edb.Key())
	ctx := context.Background()

	original := Host{
		ID:       "host-upsert",
		Name:     "original-name",
		Host:     "1.1.1.1",
		Port:     22,
		User:     "user1",
		AuthType: "password",
	}
	if err := repo.Put(ctx, original); err != nil {
		t.Fatalf("Put original: %v", err)
	}

	updated := original
	updated.Name = "updated-name"
	updated.Port = 8080
	if err := repo.Put(ctx, updated); err != nil {
		t.Fatalf("Put updated: %v", err)
	}

	got, err := repo.Get(ctx, "host-upsert")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got.Name != "updated-name" {
		t.Errorf("Name: got %q, want %q", got.Name, "updated-name")
	}
	if got.Port != 8080 {
		t.Errorf("Port: got %d, want 8080", got.Port)
	}

	// Verify only one row.
	hosts, err := repo.List(ctx)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(hosts) != 1 {
		t.Fatalf("expected 1 host, got %d", len(hosts))
	}
}

func TestHostRepo_List(t *testing.T) {
	edb, _ := openTestDB(t)
	repo := NewHostRepo(edb.db, edb.Key())
	ctx := context.Background()

	hosts := []Host{
		{ID: "h1", Name: "Alpha", Host: "a.com", Port: 22, User: "u", AuthType: "key"},
		{ID: "h2", Name: "Beta", Host: "b.com", Port: 22, User: "u", AuthType: "key"},
		{ID: "h3", Name: "Gamma", Host: "c.com", Port: 22, User: "u", AuthType: "key"},
	}
	for _, h := range hosts {
		if err := repo.Put(ctx, h); err != nil {
			t.Fatalf("Put %s: %v", h.ID, err)
		}
	}

	got, err := repo.List(ctx)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(got) != 3 {
		t.Fatalf("expected 3 hosts, got %d", len(got))
	}
	// Should be ordered by name.
	if got[0].Name != "Alpha" || got[1].Name != "Beta" || got[2].Name != "Gamma" {
		t.Errorf("unexpected order: %s, %s, %s", got[0].Name, got[1].Name, got[2].Name)
	}
}

func TestHostRepo_Delete(t *testing.T) {
	edb, _ := openTestDB(t)
	repo := NewHostRepo(edb.db, edb.Key())
	ctx := context.Background()

	h := Host{ID: "del-1", Name: "To Delete", Host: "x.com", Port: 22, User: "u", AuthType: "key"}
	if err := repo.Put(ctx, h); err != nil {
		t.Fatalf("Put: %v", err)
	}

	if err := repo.Delete(ctx, "del-1"); err != nil {
		t.Fatalf("Delete: %v", err)
	}

	_, err := repo.Get(ctx, "del-1")
	if err == nil {
		t.Fatal("expected error after delete")
	}

	hosts, err := repo.List(ctx)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(hosts) != 0 {
		t.Fatalf("expected 0 hosts, got %d", len(hosts))
	}
}

func TestHostRepo_DeleteIdempotent(t *testing.T) {
	edb, _ := openTestDB(t)
	repo := NewHostRepo(edb.db, edb.Key())
	ctx := context.Background()

	// Delete a non-existent host should not error.
	if err := repo.Delete(ctx, "non-existent"); err != nil {
		t.Fatalf("Delete non-existent: %v", err)
	}
}

func TestHostRepo_GetNotFound(t *testing.T) {
	edb, _ := openTestDB(t)
	repo := NewHostRepo(edb.db, edb.Key())
	ctx := context.Background()

	_, err := repo.Get(ctx, "no-such-id")
	if err == nil {
		t.Fatal("expected error for missing host")
	}
}

func TestHostRepo_AuthSecretEncrypted(t *testing.T) {
	edb, _ := openTestDB(t)
	repo := NewHostRepo(edb.db, edb.Key())
	ctx := context.Background()

	plaintext := "super-secret-password"
	h := Host{
		ID:         "enc-1",
		Name:       "Encrypted",
		Host:       "e.com",
		Port:       22,
		User:       "u",
		AuthType:   "password",
		AuthSecret: plaintext,
	}
	if err := repo.Put(ctx, h); err != nil {
		t.Fatalf("Put: %v", err)
	}

	// Query raw auth_secret from DB.
	var rawSecret string
	err := edb.db.QueryRowContext(ctx,
		"SELECT auth_secret FROM hosts WHERE id = ?", "enc-1").Scan(&rawSecret)
	if err != nil {
		t.Fatalf("raw query: %v", err)
	}

	if rawSecret == plaintext {
		t.Fatal("auth_secret is stored in plaintext!")
	}
	if rawSecret == "" {
		t.Fatal("auth_secret is empty")
	}
	// Should be valid base64.
	if _, err := base64.StdEncoding.DecodeString(rawSecret); err != nil {
		t.Errorf("auth_secret is not valid base64: %v", err)
	}
}

func TestHostRepo_EmptyInitCmds(t *testing.T) {
	edb, _ := openTestDB(t)
	repo := NewHostRepo(edb.db, edb.Key())
	ctx := context.Background()

	h := Host{
		ID:       "empty-cmds",
		Name:     "No Commands",
		Host:     "n.com",
		Port:     22,
		User:     "u",
		AuthType: "key",
		InitCmds: []string{},
	}
	if err := repo.Put(ctx, h); err != nil {
		t.Fatalf("Put: %v", err)
	}

	got, err := repo.Get(ctx, "empty-cmds")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got.InitCmds == nil {
		t.Error("InitCmds should not be nil, should be empty slice")
	}
	if len(got.InitCmds) != 0 {
		t.Errorf("expected empty InitCmds, got %v", got.InitCmds)
	}
}

func TestHostRepo_NilInitCmds(t *testing.T) {
	edb, _ := openTestDB(t)
	repo := NewHostRepo(edb.db, edb.Key())
	ctx := context.Background()

	h := Host{
		ID:       "nil-cmds",
		Name:     "Nil Cmds",
		Host:     "n.com",
		Port:     22,
		User:     "u",
		AuthType: "key",
		InitCmds: nil,
	}
	if err := repo.Put(ctx, h); err != nil {
		t.Fatalf("Put with nil InitCmds: %v", err)
	}

	got, err := repo.Get(ctx, "nil-cmds")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if len(got.InitCmds) != 0 {
		t.Errorf("expected empty InitCmds for nil input, got %v", got.InitCmds)
	}
}
