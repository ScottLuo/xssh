package main

import (
	"context"

	"github.com/scottluo/xssh/internal/store"
)

// App is the Wails application struct that exposes binding methods to the frontend.
type App struct {
	ctx context.Context
}

// NewApp creates a new App instance.
func NewApp() *App {
	return &App{}
}

// startup is called when the app starts.
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
}

// shutdown is called when the app is closing.
func (a *App) shutdown(ctx context.Context) {}

// --- Stub methods (to be implemented in T2) ---

// GetHosts returns all saved host cards.
func (a *App) GetHosts() ([]store.Host, error) {
	return nil, nil
}

// SaveHost creates or updates a host card.
func (a *App) SaveHost(h store.Host) error {
	return nil
}

// DeleteHost removes a host card and closes its sessions.
func (a *App) DeleteHost(id string) error {
	return nil
}

// OpenTab opens a new SSH session for the given host.
// Returns a session ID.
func (a *App) OpenTab(hostID string, cols, rows int) (string, error) {
	return "", nil
}

// Write writes base64-encoded keystrokes to the session's stdin.
func (a *App) Write(sid string, data string) error {
	return nil
}

// Resize resizes the remote PTY for the session.
func (a *App) Resize(sid string, cols, rows int) error {
	return nil
}

// CloseTab closes the SSH session tab.
func (a *App) CloseTab(sid string) error {
	return nil
}

// UnlockDB unlocks the encrypted database with the given passphrase.
func (a *App) UnlockDB(passphrase string) error {
	return nil
}

// SetupDB sets up the database on first run with the given passphrase.
func (a *App) SetupDB(passphrase string) error {
	return nil
}

// GetSettings returns all application settings.
func (a *App) GetSettings() (map[string]string, error) {
	return nil, nil
}

// SetSetting sets a single application setting.
func (a *App) SetSetting(key, value string) error {
	return nil
}
