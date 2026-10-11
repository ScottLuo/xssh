# Chapter 04: Encrypted Storage (`internal/store`)

## 4.1 Library & Encryption Strategy

| Decision | Choice | Rationale |
|----------|--------|-----------|
| SQLite driver | `github.com/ncruces/go-sqlite3` | Pure Go implementation with native SQLCipher 4 support; no CGO required, ideal for Wails cross-compilation |
| File-level encryption | SQLCipher 4 (AES-256-CBC) | Encrypts every 4 KB page of the DB file; standard, well-audited |
| Key derivation | scrypt (N=2^15, r=8, p=1) | Memory-hard KDF, resistant to GPU/ASIC attacks; stronger than PBKDF2 for passphrase-based keys |
| Field-level encryption | AES-256-GCM | Defense-in-depth on sensitive fields (`auth_secret`); authenticates and encrypts in one step |
| Salt storage | Separate metadata file (`xssh-meta.json`) | Salt is not secret; stores it outside the encrypted DB to avoid circular dependency |

## 4.2 Package Structure

```
internal/store/
├── store.go          // EncryptedDB: Open, Close, key derivation
├── host_repo.go      // HostRepo: CRUD for host cards
├── settings_repo.go  // SettingsRepo: key-value app settings
├── crypto.go         // encryptField / decryptField helpers
├── store_test.go     // Unit tests (temp file, no external deps)
└── store_integration_test.go  // //go:build integration
```

## 4.3 Data Directory

| Platform | Path |
|----------|------|
| Linux | `~/.local/share/xssh/` |
| macOS | `~/Library/Application Support/xssh/` |
| Windows | `%APPDATA%/xssh/` |

Contents:
```
<data_dir>/
├── xssh.db           # Encrypted SQLite database (SQLCipher 4)
├── xssh-meta.json    # { "salt": "<hex>", "version": 1 }
└── logs/             # Optional: app log files
```

## 4.4 Key Derivation

```
User passphrase (UTF-8 string)
       │
       ▼
  scrypt(passphrase, salt, N=32768, r=8, p=1, keyLen=32)
       │
       ▼
  32-byte derived key (held in memory)
       │
       ├──► SQLCipher file-level encryption key
       │
       └──► AES-256-GCM key for field-level encryption
```

### Implementation

```go
package store

import (
    "crypto/rand"
    "golang.org/x/crypto/scrypt"
)

const (
    scryptN = 32768 // 2^15
    scryptR = 8
    scryptP = 1
    keyLen  = 32
)

// DeriveKey derives a 32-byte encryption key from a passphrase and salt.
func DeriveKey(passphrase []byte, salt []byte) ([]byte, error) {
    return scrypt.Key(passphrase, salt, scryptN, scryptR, scryptP, keyLen)
}

// GenerateSalt generates a random 32-byte salt.
func GenerateSalt() ([]byte, error) {
    salt := make([]byte, 32)
    _, err := rand.Read(salt)
    return salt, err
}
```

## 4.5 Database Schema

```sql
-- Migration version tracking
CREATE TABLE IF NOT EXISTS schema_migrations (
    version     INTEGER PRIMARY KEY,
    applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- hosts: host card configuration
CREATE TABLE IF NOT EXISTS hosts (
    id           TEXT PRIMARY KEY,          -- ULID: time-ordered, sortable, unique
    name         TEXT NOT NULL,
    host         TEXT NOT NULL,             -- hostname or IP
    port         INTEGER NOT NULL DEFAULT 22,
    user         TEXT NOT NULL,
    auth_type    TEXT NOT NULL CHECK(auth_type IN ('key', 'password')),
    auth_secret  TEXT,                      -- encrypted (AES-GCM), base64-encoded
    shell        TEXT NOT NULL DEFAULT '',  -- empty = system default
    init_cmds    TEXT NOT NULL DEFAULT '[]',-- JSON array of strings
    color        TEXT NOT NULL DEFAULT '',  -- CSS color for card
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_hosts_name ON hosts(name);

-- sessions: session history (optional, for analytics/restore)
CREATE TABLE IF NOT EXISTS sessions (
    id          TEXT PRIMARY KEY,           -- ULID
    host_id     TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
    started_at  TEXT NOT NULL DEFAULT (datetime('now')),
    ended_at    TEXT,
    cols        INTEGER,
    rows        INTEGER,
    exit_code   INTEGER
);

CREATE INDEX IF NOT EXISTS idx_sessions_host ON sessions(host_id);

-- settings: application-level key-value settings
CREATE TABLE IF NOT EXISTS settings (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL
);
```

## 4.6 Host Model (Go)

```go
package store

// Host represents an SSH host card.
type Host struct {
    ID        string   `json:"id"`
    Name      string   `json:"name"`
    Host      string   `json:"host"`
    Port      int      `json:"port"`
    User      string   `json:"user"`
    AuthType  string   `json:"auth_type"`  // "key" | "password"
    AuthSecret string  `json:"auth_secret"`// AES-GCM encrypted, base64
    Shell     string   `json:"shell"`
    InitCmds  []string `json:"init_cmds"`
    Color     string   `json:"color"`
    CreatedAt string   `json:"created_at"`
    UpdatedAt string   `json:"updated_at"`
}
```

## 4.7 Field-Level Encryption

### Purpose

SQLCipher encrypts the **file** at rest. Field-level encryption adds a second layer: even if the DB file and the file-level key both leak, the password remains protected.

### Format

`auth_secret` column stores: `base64(nonce || ciphertext || tag)` where:
- `nonce` = 12 bytes (random)
- `ciphertext` = AES-256-GCM encrypted plaintext
- `tag` = 16 bytes (authentication tag, appended by GCM)

### Implementation

```go
package store

import (
    "crypto/aes"
    "crypto/cipher"
    "encoding/base64"
    "fmt"
)

// encryptField encrypts plaintext with AES-256-GCM. Returns base64(nonce+ct+tag).
func encryptField(plaintext []byte, key []byte) (string, error) {
    block, err := aes.NewCipher(key)
    if err != nil {
        return "", fmt.Errorf("aes.NewCipher: %w", err)
    }
    gcm, err := cipher.NewGCM(block)
    if err != nil {
        return "", fmt.Errorf("cipher.NewGCM: %w", err)
    }
    nonce := make([]byte, gcm.NonceSize())
    ciphertext := gcm.Seal(nonce, nonce, plaintext, nil)
    return base64.StdEncoding.EncodeToString(ciphertext), nil
}

// decryptField decrypts a base64-encoded AES-256-GCM field.
func decryptField(encoded string, key []byte) ([]byte, error) {
    data, err := base64.StdEncoding.DecodeString(encoded)
    if err != nil {
        return nil, fmt.Errorf("base64 decode: %w", err)
    }
    block, err := aes.NewCipher(key)
    if err != nil {
        return nil, fmt.Errorf("aes.NewCipher: %w", err)
    }
    gcm, err := cipher.NewGCM(block)
    if err != nil {
        return nil, fmt.Errorf("cipher.NewGCM: %w", err)
    }
    plaintext, err := gcm.Open(nil, data[:gcm.NonceSize()], data[gcm.NonceSize():], nil)
    if err != nil {
        return nil, fmt.Errorf("gcm.Open: %w", err)
    }
    return plaintext, nil
}
```

## 4.8 EncryptedDB

```go
package store

// EncryptedDB is a handle to an open encrypted SQLite database.
type EncryptedDB struct {
    db   *sql.DB
    path string
    key  []byte // 32-byte derived key (in memory)
}

// Open opens (or creates) an encrypted SQLite database at the given path.
//   - If pass is nil and DB doesn't exist: creates a fresh unencrypted-then-encrypts DB.
//   - If pass is nil and DB exists: returns ErrNoPassphrase.
//   - If pass is provided: derives key and opens with SQLCipher.
func Open(ctx context.Context, path string, pass []byte) (*EncryptedDB, error) {
    // 1. Ensure directory exists
    // 2. If pass != nil: read salt from meta file, derive key
    // 3. Open SQLite with SQLCipher DSN (key in hex)
    // 4. Verify: SELECT count(*) FROM sqlite_master
    // 5. Run migrations
    // 6. Return EncryptedDB
}

// Close closes the database and zeros the in-memory key.
func (edb *EncryptedDB) Close() error {
    // Zero the key bytes
    for i := range edb.key {
        edb.key[i] = 0
    }
    return edb.db.Close()
}

// DB returns the underlying *sql.DB for use by repositories.
func (edb *EncryptedDB) DB() *sql.DB {
    return edb.db
}
```

### SQLCipher DSN

For `ncruces/go-sqlite3`, the DSN to open an encrypted database:

```
file:<path>?cache=shared&key=<hex-encoded-32-byte-key>
```

The key is the hex-encoded output of scrypt. SQLCipher automatically applies AES-256-CBC to all 4 KB pages.

## 4.9 HostRepo

```go
package store

// HostRepo provides CRUD operations for host cards.
type HostRepo struct {
    db  *sql.DB
    key []byte // for field-level encryption
}

func NewHostRepo(db *sql.DB, key []byte) *HostRepo {
    return &HostRepo{db: db, key: key}
}

// List returns all host cards, ordered by name.
func (r *HostRepo) List(ctx context.Context) ([]Host, error)

// Get returns a single host by ID.
func (r *HostRepo) Get(ctx context.Context, id string) (*Host, error)

// Put creates or updates a host card.
//   - Encrypts AuthSecret before storing.
//   - Uses INSERT ... ON CONFLICT(id) DO UPDATE for upsert.
func (r *HostRepo) Put(ctx context.Context, h Host) error

// Delete removes a host card by ID (cascades to sessions).
func (r *HostRepo) Delete(ctx context.Context, id string) error
```

### SQL Patterns

All queries use **parameterized** statements (no string interpolation):

```go
// List
rows, err := r.db.QueryContext(ctx,
    "SELECT id, name, host, port, user, auth_type, auth_secret, shell, init_cmds, color, created_at, updated_at FROM hosts ORDER BY name")

// Put (upsert)
_, err := r.db.ExecContext(ctx, `
    INSERT INTO hosts (id, name, host, port, user, auth_type, auth_secret, shell, init_cmds, color, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
        name=excluded.name, host=excluded.host, port=excluded.port,
        user=excluded.user, auth_type=excluded.auth_type,
        auth_secret=excluded.auth_secret, shell=excluded.shell,
        init_cmds=excluded.init_cmds, color=excluded.color,
        updated_at=datetime('now')`,
    h.ID, h.Name, h.Host, h.Port, h.User, h.AuthType,
    encryptedSecret, h.Shell, initCmdsJSON, h.Color)

// Delete
_, err := r.db.ExecContext(ctx, "DELETE FROM hosts WHERE id = ?", id)
```

## 4.10 SettingsRepo

```go
type SettingsRepo struct {
    db *sql.DB
}

func (r *SettingsRepo) Get(ctx context.Context, key string) (string, error)
func (r *SettingsRepo) Set(ctx context.Context, key, value string) error
func (r *SettingsRepo) List(ctx context.Context) (map[string]string, error)
```

Used for: terminal font size, color theme, default initial commands, etc.

## 4.11 Migration Strategy

For v1, use `CREATE TABLE IF NOT EXISTS` with a `schema_migrations` table:

```go
func migrate(ctx context.Context, db *sql.DB) error {
    current := getSchemaVersion(ctx, db)
    for _, m := range migrations {
        if m.version > current {
            if err := apply(ctx, db, m); err != nil {
                return err
            }
            setSchemaVersion(ctx, db, m.version)
        }
    }
    return nil
}
```

Each migration is a struct with `version int` and `sql string` (or a function for complex migrations).

## 4.12 Security Considerations

| Concern | Mitigation |
|---------|-----------|
| DB file stolen without passphrase | SQLCipher AES-256-CBC makes all pages unreadable |
| Both DB file and key leak | AES-GCM field-level encryption on `auth_secret` |
| In-memory key exposure | Zeroed on `Close()`; single 32-byte buffer |
| Salt predictability | 32 random bytes via `crypto/rand` |
| Key derivation weakness | scrypt with N=32768 (memory-hard, ~128 MB RAM per attempt) |
| SQL injection | Parameterized queries only (`?` or `$1` placeholders) |
| Timing attacks on passphrase check | Constant-time compare: open DB and `SELECT` — wrong key fails at SQLCipher layer |

## 4.13 Dependencies

| Package | Purpose |
|---------|---------|
| `github.com/ncruces/go-sqlite3` | Pure-Go SQLite + SQLCipher driver |
| `github.com/ncruces/go-sqlite3/libsqlite3` | Embedded SQLite library (auto-selected variant) |
| `golang.org/x/crypto/scrypt` | Key derivation function |
| `crypto/aes`, `crypto/cipher` | AES-256-GCM field encryption |
| `database/sql` | Standard DB interface |
