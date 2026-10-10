package store

import (
	"bytes"
	"context"
	"encoding/hex"
	"os"
	"path/filepath"
	"testing"
)

// ---------- Helpers (shared across test files in this package) ----------

func testKey(t *testing.T) []byte {
	t.Helper()
	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i + 1)
	}
	return key
}

func openTestDB(t *testing.T) (*EncryptedDB, string) {
	t.Helper()
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "test.db")
	key := testKey(t)
	edb, err := OpenWithKey(context.Background(), dbPath, key)
	if err != nil {
		t.Fatalf("OpenWithKey: %v", err)
	}
	t.Cleanup(func() { _ = edb.Close() })
	return edb, dbPath
}

// ---------- DeriveKey ----------

func TestDeriveKey_Deterministic(t *testing.T) {
	salt := []byte("01234567890123456789012345678901") // 32 bytes
	pass := []byte("mypassword")

	key1, err := DeriveKey(pass, salt)
	if err != nil {
		t.Fatalf("DeriveKey 1: %v", err)
	}
	key2, err := DeriveKey(pass, salt)
	if err != nil {
		t.Fatalf("DeriveKey 2: %v", err)
	}

	if len(key1) != 32 {
		t.Fatalf("expected 32 bytes, got %d", len(key1))
	}
	if !bytes.Equal(key1, key2) {
		t.Fatal("expected deterministic output, got different keys")
	}
}

func TestDeriveKey_DifferentSalt(t *testing.T) {
	pass := []byte("mypassword")
	salt1 := []byte("salt-one-0000000000000000000000")
	salt2 := []byte("salt-two-0000000000000000000000")

	key1, err := DeriveKey(pass, salt1)
	if err != nil {
		t.Fatalf("DeriveKey 1: %v", err)
	}
	key2, err := DeriveKey(pass, salt2)
	if err != nil {
		t.Fatalf("DeriveKey 2: %v", err)
	}
	if bytes.Equal(key1, key2) {
		t.Fatal("expected different keys for different salts")
	}
}

func TestDeriveKey_DifferentPassphrase(t *testing.T) {
	salt := []byte("01234567890123456789012345678901")

	key1, err := DeriveKey([]byte("pass1"), salt)
	if err != nil {
		t.Fatalf("DeriveKey 1: %v", err)
	}
	key2, err := DeriveKey([]byte("pass2"), salt)
	if err != nil {
		t.Fatalf("DeriveKey 2: %v", err)
	}
	if bytes.Equal(key1, key2) {
		t.Fatal("expected different keys for different passphrases")
	}
}

func TestDeriveKey_EmptyPassphrase(t *testing.T) {
	salt := []byte("01234567890123456789012345678901")
	key, err := DeriveKey([]byte(""), salt)
	if err != nil {
		t.Fatalf("DeriveKey with empty passphrase: %v", err)
	}
	if len(key) != 32 {
		t.Fatalf("expected 32 bytes, got %d", len(key))
	}
}

// ---------- GenerateSalt ----------

func TestGenerateSalt(t *testing.T) {
	salt1, err := GenerateSalt()
	if err != nil {
		t.Fatalf("GenerateSalt 1: %v", err)
	}
	salt2, err := GenerateSalt()
	if err != nil {
		t.Fatalf("GenerateSalt 2: %v", err)
	}

	if len(salt1) != 32 {
		t.Fatalf("expected 32 bytes, got %d", len(salt1))
	}
	if bytes.Equal(salt1, salt2) {
		t.Fatal("expected different salts")
	}
}

// ---------- OpenWithKey ----------

func TestOpenWithKey_CreatesDB(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "test.db")
	key := testKey(t)

	edb, err := OpenWithKey(context.Background(), dbPath, key)
	if err != nil {
		t.Fatalf("OpenWithKey: %v", err)
	}
	defer func() { _ = edb.Close() }()

	// Verify tables exist.
	ctx := context.Background()
	tables := []string{"schema_migrations", "hosts", "sessions", "settings"}
	for _, table := range tables {
		var count int
		err := edb.db.QueryRowContext(ctx,
			"SELECT count(*) FROM sqlite_master WHERE type='table' AND name=?", table).Scan(&count)
		if err != nil {
			t.Fatalf("query table %q: %v", table, err)
		}
		if count != 1 {
			t.Errorf("table %q not found (count=%d)", table, count)
		}
	}
}

func TestOpenWithKey_WrongKey(t *testing.T) {
	// Create DB with key A.
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "test.db")
	keyA := testKey(t)

	edb, err := OpenWithKey(context.Background(), dbPath, keyA)
	if err != nil {
		t.Fatalf("create DB: %v", err)
	}
	_ = edb.Close()

	// Open with key B (wrong).
	keyB := make([]byte, 32)
	for i := range keyB {
		keyB[i] = byte(0xFF - i)
	}
	_, err = OpenWithKey(context.Background(), dbPath, keyB)
	if err == nil {
		t.Fatal("expected error with wrong key, got nil")
	}
}

func TestOpenWithKey_InvalidKeyLength(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "test.db")
	shortKey := make([]byte, 16)
	_, err := OpenWithKey(context.Background(), dbPath, shortKey)
	if err == nil {
		t.Fatal("expected error for short key")
	}
}

// ---------- Open ----------

func TestOpen_AutoGeneratesSaltOnNewDB(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "test.db")
	pass := []byte("testpass")

	edb, err := Open(context.Background(), dbPath, pass)
	if err != nil {
		t.Fatalf("Open new DB: %v", err)
	}
	defer func() { _ = edb.Close() }()

	// Verify meta file was created.
	metaPath := metaPathFor(dbPath)
	if _, err := os.Stat(metaPath); err != nil {
		t.Fatalf("meta file not created: %v", err)
	}
}

func TestOpen_ReopenWithSamePassphrase(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "test.db")
	pass := []byte("testpass")

	// First open creates the DB.
	edb, err := Open(context.Background(), dbPath, pass)
	if err != nil {
		t.Fatalf("first Open: %v", err)
	}
	_ = edb.Close()

	// Re-open with same passphrase.
	edb2, err := Open(context.Background(), dbPath, pass)
	if err != nil {
		t.Fatalf("second Open: %v", err)
	}
	_ = edb2.Close()
}

func TestOpen_WrongPassphrase(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "test.db")

	// Create DB with "correct" passphrase.
	edb, err := Open(context.Background(), dbPath, []byte("correct"))
	if err != nil {
		t.Fatalf("first Open: %v", err)
	}
	_ = edb.Close()

	// Try to open with "wrong" passphrase.
	_, err = Open(context.Background(), dbPath, []byte("wrong"))
	if err == nil {
		t.Fatal("expected error with wrong passphrase")
	}
}

func TestOpen_NilPassNoMetaFile(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "test.db")

	_, err := Open(context.Background(), dbPath, nil)
	if err == nil {
		t.Fatal("expected ErrNoPassphrase")
	}
}

func TestOpen_NilPassExistingDB(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "test.db")

	// Create DB first.
	edb, err := Open(context.Background(), dbPath, []byte("pass"))
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	_ = edb.Close()

	// Try nil pass on existing DB.
	_, err = Open(context.Background(), dbPath, nil)
	if err == nil {
		t.Fatal("expected error for nil pass on existing DB")
	}
}

// ---------- Close zeros key ----------

func TestClose_ZerosKey(t *testing.T) {
	edb, _ := openTestDB(t)

	// Grab reference to the key slice before close.
	keyRef := edb.Key()
	keyCopy := make([]byte, len(keyRef))
	copy(keyCopy, keyRef)

	// Ensure key is not already zero.
	allZero := true
	for _, b := range keyCopy {
		if b != 0 {
			allZero = false
			break
		}
	}
	if allZero {
		t.Fatal("key was already zero before Close")
	}

	_ = edb.Close()

	// After close, key bytes should be zeroed.
	for _, b := range keyRef {
		if b != 0 {
			t.Fatal("key not zeroed after Close")
		}
	}
}

// ---------- readSalt / writeSalt ----------

func TestSalt_RoundTrip(t *testing.T) {
	dir := t.TempDir()
	metaPath := filepath.Join(dir, "xssh-meta.json")

	originalSalt := make([]byte, 32)
	for i := range originalSalt {
		originalSalt[i] = byte(i + 1)
	}

	if err := writeSalt(metaPath, originalSalt); err != nil {
		t.Fatalf("writeSalt: %v", err)
	}

	got, err := readSalt(metaPath)
	if err != nil {
		t.Fatalf("readSalt: %v", err)
	}

	if !bytes.Equal(got, originalSalt) {
		t.Fatal("salt round-trip mismatch")
	}
}

func TestReadSalt_FileNotFound(t *testing.T) {
	_, err := readSalt("/nonexistent/path/xssh-meta.json")
	if err == nil {
		t.Fatal("expected error for missing file")
	}
}

// ---------- metaPathFor ----------

func TestMetaPathFor(t *testing.T) {
	// Absolute path.
	got := metaPathFor("/home/user/.xssh/data.db")
	want := filepath.Join("/home/user/.xssh", "xssh-meta.json")
	if got != want {
		t.Errorf("metaPathFor: got %q, want %q", got, want)
	}

	// Root dir.
	got = metaPathFor("/data.db")
	want = filepath.Join("/", "xssh-meta.json")
	if got != want {
		t.Errorf("metaPathFor root: got %q, want %q", got, want)
	}
}

// ---------- writeSalt file content ----------

func TestWriteSalt_FileContent(t *testing.T) {
	dir := t.TempDir()
	metaPath := filepath.Join(dir, "xssh-meta.json")

	salt := []byte{0x01, 0x02, 0x03}
	if err := writeSalt(metaPath, salt); err != nil {
		t.Fatalf("writeSalt: %v", err)
	}

	data, err := os.ReadFile(metaPath)
	if err != nil {
		t.Fatalf("read file: %v", err)
	}

	// Verify it contains the hex-encoded salt.
	expectedHex := hex.EncodeToString(salt)
	if !bytes.Contains(data, []byte(expectedHex)) {
		t.Errorf("file does not contain expected hex salt: %s", expectedHex)
	}
}
