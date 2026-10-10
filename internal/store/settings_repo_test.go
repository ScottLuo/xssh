package store

import (
	"context"
	"database/sql"
	"errors"
	"testing"
)

func TestSettingsRepo_RoundTrip(t *testing.T) {
	edb, _ := openTestDB(t)
	repo := NewSettingsRepo(edb.db)
	ctx := context.Background()

	if err := repo.Set(ctx, "theme", "dark"); err != nil {
		t.Fatalf("Set: %v", err)
	}

	val, err := repo.Get(ctx, "theme")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if val != "dark" {
		t.Errorf("got %q, want %q", val, "dark")
	}
}

func TestSettingsRepo_Upsert(t *testing.T) {
	edb, _ := openTestDB(t)
	repo := NewSettingsRepo(edb.db)
	ctx := context.Background()

	if err := repo.Set(ctx, "fontsize", "12"); err != nil {
		t.Fatalf("Set 1: %v", err)
	}
	if err := repo.Set(ctx, "fontsize", "14"); err != nil {
		t.Fatalf("Set 2: %v", err)
	}

	val, err := repo.Get(ctx, "fontsize")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if val != "14" {
		t.Errorf("got %q, want %q", val, "14")
	}
}

func TestSettingsRepo_List(t *testing.T) {
	edb, _ := openTestDB(t)
	repo := NewSettingsRepo(edb.db)
	ctx := context.Background()

	keys := []struct {
		k, v string
	}{
		{"theme", "dark"},
		{"fontsize", "14"},
		{"lang", "en"},
	}
	for _, kv := range keys {
		if err := repo.Set(ctx, kv.k, kv.v); err != nil {
			t.Fatalf("Set %q: %v", kv.k, err)
		}
	}

	m, err := repo.List(ctx)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(m) != 3 {
		t.Fatalf("expected 3 entries, got %d", len(m))
	}
	for _, kv := range keys {
		if m[kv.k] != kv.v {
			t.Errorf("List[%q] = %q, want %q", kv.k, m[kv.k], kv.v)
		}
	}
}

func TestSettingsRepo_GetMissing(t *testing.T) {
	edb, _ := openTestDB(t)
	repo := NewSettingsRepo(edb.db)
	ctx := context.Background()

	_, err := repo.Get(ctx, "nonexistent")
	if err == nil {
		t.Fatal("expected error for missing key")
	}
	if !errors.Is(err, sql.ErrNoRows) {
		t.Errorf("expected wrapped sql.ErrNoRows, got: %v", err)
	}
}

func TestSettingsRepo_EmptyValue(t *testing.T) {
	edb, _ := openTestDB(t)
	repo := NewSettingsRepo(edb.db)
	ctx := context.Background()

	if err := repo.Set(ctx, "empty", ""); err != nil {
		t.Fatalf("Set: %v", err)
	}
	val, err := repo.Get(ctx, "empty")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if val != "" {
		t.Errorf("expected empty string, got %q", val)
	}
}

func TestSettingsRepo_ListEmpty(t *testing.T) {
	edb, _ := openTestDB(t)
	repo := NewSettingsRepo(edb.db)
	ctx := context.Background()

	m, err := repo.List(ctx)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(m) != 0 {
		t.Errorf("expected empty map, got %v", m)
	}
}
