package store

import (
	"bytes"
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	_ "github.com/ncruces/go-sqlite3/driver" // driver registration
	"golang.org/x/crypto/scrypt"
)

const (
	scryptN  = 32768 // 2^15
	scryptR  = 8
	scryptP  = 1
	keyLen   = 32
	saltLen  = 32
)

// ErrNoPassphrase is returned when Open is called with a nil passphrase on a non-existent DB.
var ErrNoPassphrase = errors.New("passphrase required")

// EncryptedDB is a handle to an open encrypted SQLite database.
type EncryptedDB struct {
	db   *sql.DB
	path string
	key  []byte // 32-byte derived key (in memory)
}

// metaFile is the JSON structure stored in xssh-meta.json.
type metaFile struct {
	Salt    string `json:"salt"`    // hex-encoded 32-byte salt
	Version int    `json:"version"` // schema version
}

// Open opens (or creates) an encrypted SQLite database at the given path.
//   - If pass is nil and the DB doesn't exist: returns ErrNoPassphrase.
//   - If pass is provided: reads salt from meta file (generating one if new), derives key, opens with SQLCipher.
func Open(ctx context.Context, path string, pass []byte) (*EncryptedDB, error) {
	// Ensure directory exists.
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("create data dir: %w", err)
	}

	metaPath := metaPathFor(path)

	// Check if DB file already exists.
	dbExists := false
	if _, err := os.Stat(path); err == nil {
		dbExists = true
	}

	if pass == nil {
		if dbExists {
			return nil, fmt.Errorf("database exists at %s but no passphrase provided", path)
		}
		return nil, ErrNoPassphrase
	}

	// Read or generate salt.
	var salt []byte
	if dbExists {
		var err error
		salt, err = readSalt(metaPath)
		if err != nil {
			return nil, fmt.Errorf("read salt: %w", err)
		}
	} else {
		var err error
		salt, err = GenerateSalt()
		if err != nil {
			return nil, fmt.Errorf("generate salt: %w", err)
		}
		if err := writeSalt(metaPath, salt); err != nil {
			return nil, fmt.Errorf("write salt: %w", err)
		}
	}

	// Derive key via scrypt.
	key, err := DeriveKey(pass, salt)
	if err != nil {
		return nil, fmt.Errorf("derive key: %w", err)
	}

	return OpenWithKey(ctx, path, key)
}

// keyCheckPlaintext is a known plaintext used to verify the encryption key.
const keyCheckPlaintext = "xssh-key-check"

// OpenWithKey opens an encrypted SQLite database using a pre-derived 32-byte key.
// This skips scrypt key derivation; used by UnlockDB which derives the key separately.
func OpenWithKey(ctx context.Context, path string, key []byte) (*EncryptedDB, error) {
	if len(key) != keyLen {
		return nil, fmt.Errorf("key must be %d bytes, got %d", keyLen, len(key))
	}

	// Build DSN with key parameter (for SQLCipher-compatible drivers).
	dsn := "file:" + path + "?cache=shared&key=" + hex.EncodeToString(key)

	db, err := sql.Open("sqlite3", dsn)
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}

	// Run idempotent migrations (creates tables if they don't exist).
	if err := migrate(ctx, db); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("migrate: %w", err)
	}

	// Verify or initialize the key check value.
	if err := verifyOrInitKey(ctx, db, key); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("verify key: %w", err)
	}

	return &EncryptedDB{db: db, path: path, key: key}, nil
}

// verifyOrInitKey verifies the encryption key against the stored key check value.
// If no value is stored (new database), it initializes the key check.
func verifyOrInitKey(ctx context.Context, db *sql.DB, key []byte) error {
	var stored string
	err := db.QueryRowContext(ctx, "SELECT value FROM db_meta WHERE id = 'key_check'").Scan(&stored)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		// New database: store the encrypted key check value.
		enc, err := encryptField([]byte(keyCheckPlaintext), key)
		if err != nil {
			return fmt.Errorf("encrypt key check: %w", err)
		}
		if _, err := db.ExecContext(ctx,
			"INSERT INTO db_meta (id, value) VALUES ('key_check', ?)", enc); err != nil {
			return fmt.Errorf("store key check: %w", err)
		}
		return nil
	case err != nil:
		return fmt.Errorf("query key check: %w", err)
	default:
		// Existing database: decrypt and verify.
		dec, err := decryptField(stored, key)
		if err != nil {
			return fmt.Errorf("wrong passphrase: %w", err)
		}
		if !bytes.Equal(dec, []byte(keyCheckPlaintext)) {
			return fmt.Errorf("wrong passphrase: key check mismatch")
		}
		return nil
	}
}

// Close closes the database and zeros the in-memory key bytes.
func (edb *EncryptedDB) Close() error {
	// Zero the key bytes for security.
	for i := range edb.key {
		edb.key[i] = 0
	}
	return edb.db.Close()
}

// DB returns the underlying *sql.DB for use by repositories.
func (edb *EncryptedDB) DB() *sql.DB {
	return edb.db
}

// Key returns the in-memory 32-byte encryption key.
// The caller must not modify the returned slice.
func (edb *EncryptedDB) Key() []byte {
	return edb.key
}

// DeriveKey derives a 32-byte encryption key from a passphrase and salt using scrypt.
func DeriveKey(passphrase []byte, salt []byte) ([]byte, error) {
	return scrypt.Key(passphrase, salt, scryptN, scryptR, scryptP, keyLen)
}

// GenerateSalt generates a random 32-byte salt.
func GenerateSalt() ([]byte, error) {
	salt := make([]byte, saltLen)
	_, err := rand.Read(salt)
	return salt, err
}

// readSalt reads the salt from xssh-meta.json.
func readSalt(metaPath string) ([]byte, error) {
	data, err := os.ReadFile(metaPath)
	if err != nil {
		return nil, fmt.Errorf("read meta file: %w", err)
	}

	var mf metaFile
	if err := json.Unmarshal(data, &mf); err != nil {
		return nil, fmt.Errorf("parse meta file: %w", err)
	}

	salt, err := hex.DecodeString(mf.Salt)
	if err != nil {
		return nil, fmt.Errorf("decode salt hex: %w", err)
	}
	return salt, nil
}

// writeSalt writes the salt to xssh-meta.json with 0600 permissions.
func writeSalt(metaPath string, salt []byte) error {
	mf := metaFile{
		Salt:    hex.EncodeToString(salt),
		Version: 1,
	}
	data, err := json.Marshal(mf)
	if err != nil {
		return fmt.Errorf("marshal meta: %w", err)
	}
	if err := os.WriteFile(metaPath, data, 0o600); err != nil {
		return fmt.Errorf("write meta file: %w", err)
	}
	return nil
}

// metaPathFor returns the path to xssh-meta.json given a DB file path.
func metaPathFor(dbPath string) string {
	return filepath.Join(filepath.Dir(dbPath), "xssh-meta.json")
}

// migrate runs idempotent schema migrations (CREATE TABLE IF NOT EXISTS).
func migrate(ctx context.Context, db *sql.DB) error {
	statements := []string{
		`CREATE TABLE IF NOT EXISTS db_meta (
			id        TEXT PRIMARY KEY,
			value     TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS schema_migrations (
			version     INTEGER PRIMARY KEY,
			applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
		)`,
		`CREATE TABLE IF NOT EXISTS hosts (
			id           TEXT PRIMARY KEY,
			name         TEXT NOT NULL,
			host         TEXT NOT NULL,
			port         INTEGER NOT NULL DEFAULT 22,
			user         TEXT NOT NULL,
			auth_type    TEXT NOT NULL CHECK(auth_type IN ('key', 'password')),
			auth_secret  TEXT,
			shell        TEXT NOT NULL DEFAULT '',
			init_cmds    TEXT NOT NULL DEFAULT '[]',
			color        TEXT NOT NULL DEFAULT '',
			created_at   TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
		)`,
		`CREATE INDEX IF NOT EXISTS idx_hosts_name ON hosts(name)`,
		`CREATE TABLE IF NOT EXISTS sessions (
			id          TEXT PRIMARY KEY,
			host_id     TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
			started_at  TEXT NOT NULL DEFAULT (datetime('now')),
			ended_at    TEXT,
			cols        INTEGER,
			rows        INTEGER,
			exit_code   INTEGER
		)`,
		`CREATE INDEX IF NOT EXISTS idx_sessions_host ON sessions(host_id)`,
		`CREATE TABLE IF NOT EXISTS settings (
			key         TEXT PRIMARY KEY,
			value       TEXT NOT NULL
		)`,
	}

	for _, stmt := range statements {
		if _, err := db.ExecContext(ctx, stmt); err != nil {
			return fmt.Errorf("migrate: %w", err)
		}
	}
	return nil
}
