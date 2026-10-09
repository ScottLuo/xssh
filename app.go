package main

import (
	"context"
	"encoding/base64"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/scottluo/xssh/internal/sshmgr"
	"github.com/scottluo/xssh/internal/store"
	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// App is the Wails application struct that exposes binding methods to the frontend.
type App struct {
	ctx      context.Context
	db       *store.EncryptedDB
	hosts    *store.HostRepo
	settings *store.SettingsRepo
	mgr      *sshmgr.Manager
	dbPath   string
	salt     []byte
}

// NewApp creates a new App instance with the data directory resolved and
// the SSH manager initialized.
func NewApp() *App {
	dataDir := resolveDataDir()
	app := &App{
		dbPath: filepath.Join(dataDir, "xssh.db"),
		mgr:    sshmgr.NewManager(),
	}
	// Try to read existing salt; if none, the app is in "setup needed" state.
	if salt, err := store.ReadSalt(dataDir); err == nil {
		app.salt = salt
	}
	return app
}

// resolveDataDir returns the platform-specific data directory for xssh,
// creating it if it does not exist (spec §4.3).
func resolveDataDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		// Fallback to current directory; log the issue.
		log.Printf("xssh: failed to resolve home dir: %v; using current dir", err)
		home = "."
	}

	var dir string
	switch runtime.GOOS {
	case "windows":
		if appData := os.Getenv("APPDATA"); appData != "" {
			dir = filepath.Join(appData, "xssh")
		} else {
			dir = filepath.Join(home, "AppData", "Roaming", "xssh")
		}
	case "darwin":
		dir = filepath.Join(home, "Library", "Application Support", "xssh")
	default: // linux and others
		if xdg := os.Getenv("XDG_DATA_HOME"); xdg != "" {
			dir = filepath.Join(xdg, "xssh")
		} else {
			dir = filepath.Join(home, ".local", "share", "xssh")
		}
	}

	if err := os.MkdirAll(dir, 0o700); err != nil {
		log.Printf("xssh: create data dir %s: %v", dir, err)
	}
	return dir
}

// dataDir returns the parent directory of a.dbPath.
func (a *App) dataDir() string {
	return filepath.Dir(a.dbPath)
}

// startup is called when the app starts (Wails lifecycle hook).
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	log.Printf("xssh: app started, data dir=%s, db exists=%v",
		a.dataDir(), a.salt != nil)
}

// shutdown is called when the app is closing (Wails lifecycle hook).
func (a *App) shutdown(ctx context.Context) {
	log.Printf("xssh: shutting down")
	a.mgr.CloseAll(ctx)
	if a.db != nil {
		if err := a.db.Close(); err != nil {
			log.Printf("xssh: close db: %v", err)
		}
	}
}

// --- Binding Methods ---

// GetHosts returns all saved host cards.
// Returns an empty slice (not nil) when the DB is not yet unlocked.
func (a *App) GetHosts() ([]store.Host, error) {
	if a.hosts == nil {
		return []store.Host{}, nil
	}
	return a.hosts.List(a.ctx)
}

// SaveHost creates or updates a host card and emits the hosts:updated event.
func (a *App) SaveHost(h store.Host) error {
	if a.hosts == nil {
		return fmt.Errorf("db not unlocked")
	}
	if err := a.hosts.Put(a.ctx, h); err != nil {
		return fmt.Errorf("save host: %w", err)
	}
	wailsRuntime.EventsEmit(a.ctx, "hosts:updated")
	return nil
}

// DeleteHost removes a host card, closes its sessions, and emits
// the hosts:updated event.
func (a *App) DeleteHost(id string) error {
	if a.hosts == nil {
		return fmt.Errorf("db not unlocked")
	}
	if err := a.hosts.Delete(a.ctx, id); err != nil {
		return fmt.Errorf("delete host: %w", err)
	}
	a.mgr.CloseSessionsForHost(id)
	wailsRuntime.EventsEmit(a.ctx, "hosts:updated")
	return nil
}

// OpenTab opens a new SSH session for the given host.
// Returns a session ID that the frontend uses for subsequent operations.
func (a *App) OpenTab(hostID string, cols, rows int) (string, error) {
	if a.hosts == nil {
		return "", fmt.Errorf("db not unlocked")
	}
	h, err := a.hosts.Get(a.ctx, hostID)
	if err != nil {
		return "", fmt.Errorf("get host: %w", err)
	}

	// onOut is called from the pump goroutine with the session ID; we
	// base64-encode the data and emit a Wails event.
	onOut := func(sid string, data []byte) {
		b64 := base64.StdEncoding.EncodeToString(data)
		wailsRuntime.EventsEmit(a.ctx, "ssh:out:"+sid, b64)
	}
	// onClosed is called when the session's pump goroutines have finished.
	onClosed := func(sid string) {
		wailsRuntime.EventsEmit(a.ctx, "ssh:closed:"+sid)
	}

	sid, _, err := a.mgr.OpenTab(a.ctx, hostID, *h, uint16(cols), uint16(rows), onOut, onClosed)
	if err != nil {
		return "", fmt.Errorf("open tab: %w", err)
	}
	return sid, nil
}

// Write writes base64-encoded keystrokes to the session's stdin.
func (a *App) Write(sid string, data string) error {
	raw, err := base64.StdEncoding.DecodeString(data)
	if err != nil {
		return fmt.Errorf("decode base64: %w", err)
	}
	sess, ok := a.mgr.GetSession(sid)
	if !ok {
		return fmt.Errorf("session %q not found", sid)
	}
	return sess.Write(raw)
}

// Resize resizes the remote PTY for the session.
func (a *App) Resize(sid string, cols, rows int) error {
	sess, ok := a.mgr.GetSession(sid)
	if !ok {
		return fmt.Errorf("session %q not found", sid)
	}
	return sess.Resize(uint16(cols), uint16(rows))
}

// CloseTab closes the SSH session tab.
func (a *App) CloseTab(sid string) error {
	return a.mgr.CloseTab(a.ctx, sid)
}

// UnlockDB unlocks the encrypted database with the given passphrase.
// It derives the encryption key from the stored salt and opens the DB.
func (a *App) UnlockDB(passphrase string) error {
	if a.salt == nil {
		return fmt.Errorf("no passphrase set, use SetupDB")
	}
	key, err := store.DeriveKey([]byte(passphrase), a.salt)
	if err != nil {
		return fmt.Errorf("derive key: %w", err)
	}
	db, err := store.OpenWithKey(a.ctx, a.dbPath, key)
	if err != nil {
		// A wrong key will cause "wrong passphrase" or a SQLCipher error.
		if isWrongKeyErr(err) {
			return fmt.Errorf("wrong passphrase")
		}
		return fmt.Errorf("open db: %w", err)
	}
	a.db = db
	a.hosts = store.NewHostRepo(db.DB(), key)
	a.settings = store.NewSettingsRepo(db.DB())
	log.Printf("xssh: db unlocked")
	return nil
}

// SetupDB sets up the database on first run with the given passphrase.
// It generates a new salt, writes the meta file, creates the encrypted DB,
// and initializes the repositories.
func (a *App) SetupDB(passphrase string) error {
	salt, err := store.GenerateSalt()
	if err != nil {
		return fmt.Errorf("generate salt: %w", err)
	}
	if err := store.WriteSalt(a.dataDir(), salt); err != nil {
		return fmt.Errorf("write salt: %w", err)
	}
	key, err := store.DeriveKey([]byte(passphrase), salt)
	if err != nil {
		return fmt.Errorf("derive key: %w", err)
	}
	db, err := store.OpenWithKey(a.ctx, a.dbPath, key)
	if err != nil {
		return fmt.Errorf("create db: %w", err)
	}
	a.db = db
	a.hosts = store.NewHostRepo(db.DB(), key)
	a.settings = store.NewSettingsRepo(db.DB())
	a.salt = salt
	log.Printf("xssh: db set up at %s", a.dbPath)
	return nil
}

// GetSettings returns all application settings.
// Returns an empty map (not nil) when the DB is not yet unlocked.
func (a *App) GetSettings() (map[string]string, error) {
	if a.settings == nil {
		return map[string]string{}, nil
	}
	return a.settings.List(a.ctx)
}

// SetSetting sets a single application setting.
func (a *App) SetSetting(key, value string) error {
	if a.settings == nil {
		return fmt.Errorf("db not unlocked")
	}
	return a.settings.Set(a.ctx, key, value)
}

// domReady is called when the DOM is ready in the frontend.
// Reserved for frontend initialization signals.
func (a *App) domReady(ctx context.Context) {}

// isWrongKeyErr checks whether an error from OpenWithKey indicates the
// wrong encryption key was used (wrong passphrase).
func isWrongKeyErr(err error) bool {
	// The store package wraps the verification error with "wrong passphrase".
	return err != nil && (strings.Contains(err.Error(), "wrong passphrase") ||
		strings.Contains(err.Error(), "not a database"))
}
