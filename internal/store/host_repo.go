package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
)

// ErrHostNotFound is returned when a host ID does not exist in the database.
var ErrHostNotFound = errors.New("host not found")

// HostRepo provides CRUD operations for host cards.
type HostRepo struct {
	db  *sql.DB
	key []byte // for field-level encryption
}

// NewHostRepo creates a HostRepo backed by the given database handle.
func NewHostRepo(db *sql.DB, key []byte) *HostRepo {
	return &HostRepo{db: db, key: key}
}

// List returns all host cards, ordered by name.
func (r *HostRepo) List(ctx context.Context) ([]Host, error) {
	rows, err := r.db.QueryContext(ctx,
		`SELECT id, name, host, port, user, auth_type, auth_secret, shell, init_cmds, color, created_at, updated_at
		 FROM hosts ORDER BY name`)
	if err != nil {
		return nil, fmt.Errorf("list hosts: %w", err)
	}
	defer func() { _ = rows.Close() }()

	hosts := make([]Host, 0, 16)
	for rows.Next() {
		h, err := r.scanRow(rows)
		if err != nil {
			return nil, err
		}
		hosts = append(hosts, h)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list hosts: %w", err)
	}
	return hosts, nil
}

// Get returns a single host by ID.
func (r *HostRepo) Get(ctx context.Context, id string) (*Host, error) {
	row := r.db.QueryRowContext(ctx,
		`SELECT id, name, host, port, user, auth_type, auth_secret, shell, init_cmds, color, created_at, updated_at
		 FROM hosts WHERE id = ?`, id)

	h, err := r.scanRow(row)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, fmt.Errorf("%w: %s", ErrHostNotFound, id)
		}
		return nil, fmt.Errorf("get host %s: %w", id, err)
	}
	return &h, nil
}

// Put creates or updates a host card (upsert).
//   - Encrypts AuthSecret before storing.
//   - Uses INSERT ... ON CONFLICT(id) DO UPDATE for upsert.
func (r *HostRepo) Put(ctx context.Context, h Host) error {
	// Encrypt the auth secret field.
	encryptedSecret, err := encryptField([]byte(h.AuthSecret), r.key)
	if err != nil {
		return fmt.Errorf("encrypt auth_secret: %w", err)
	}

	// Marshal InitCmds to JSON.
	initCmdsJSON, err := json.Marshal(h.InitCmds)
	if err != nil {
		return fmt.Errorf("marshal init_cmds: %w", err)
	}

	_, err = r.db.ExecContext(ctx,
		`INSERT INTO hosts (id, name, host, port, user, auth_type, auth_secret, shell, init_cmds, color, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
		 ON CONFLICT(id) DO UPDATE SET
			name=excluded.name, host=excluded.host, port=excluded.port,
			user=excluded.user, auth_type=excluded.auth_type,
			auth_secret=excluded.auth_secret, shell=excluded.shell,
			init_cmds=excluded.init_cmds, color=excluded.color,
			updated_at=datetime('now')`,
		h.ID, h.Name, h.Host, h.Port, h.User, h.AuthType,
		encryptedSecret, h.Shell, string(initCmdsJSON), h.Color)
	if err != nil {
		return fmt.Errorf("put host %s: %w", h.ID, err)
	}
	return nil
}

// Delete removes a host card by ID (cascades to sessions).
func (r *HostRepo) Delete(ctx context.Context, id string) error {
	_, err := r.db.ExecContext(ctx, "DELETE FROM hosts WHERE id = ?", id)
	if err != nil {
		return fmt.Errorf("delete host %s: %w", id, err)
	}
	return nil
}

// rowScanner is an interface that both sql.Row and sql.Rows satisfy.
type rowScanner interface {
	Scan(dest ...any) error
}

// scanRow scans a database row into a Host, decrypting AuthSecret and unmarshalling InitCmds.
func (r *HostRepo) scanRow(rows rowScanner) (Host, error) {
	var (
		h             Host
		authSecretEnc string
		initCmdsJSON  string
	)

	err := rows.Scan(
		&h.ID, &h.Name, &h.Host, &h.Port, &h.User,
		&h.AuthType, &authSecretEnc, &h.Shell,
		&initCmdsJSON, &h.Color, &h.CreatedAt, &h.UpdatedAt,
	)
	if err != nil {
		return h, err
	}

	// Decrypt the auth secret.
	if authSecretEnc != "" {
		secretBytes, err := decryptField(authSecretEnc, r.key)
		if err != nil {
			return h, fmt.Errorf("decrypt auth_secret: %w", err)
		}
		h.AuthSecret = string(secretBytes)
	}

	// Unmarshal InitCmds JSON.
	if initCmdsJSON != "" {
		if err := json.Unmarshal([]byte(initCmdsJSON), &h.InitCmds); err != nil {
			return h, fmt.Errorf("unmarshal init_cmds: %w", err)
		}
	}

	return h, nil
}
