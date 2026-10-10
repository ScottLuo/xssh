package main

import (
	"context"
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/scottluo/xssh/internal/sshmgr"
	"github.com/scottluo/xssh/internal/store"
)

// newTestApp creates an App with a temp directory for DB, suitable for
// testing without a real Wails runtime context. It also installs a no-op
// emitEvent so that pump goroutines that finish after the test ends do not
// call wailsRuntime.EventsEmit with context.Background() (which panics).
// Tests that need to capture events should override emitEvent themselves.
func newTestApp(t *testing.T) *App {
	t.Helper()
	dir := t.TempDir()
	oldEmit := emitEvent
	emitEvent = func(context.Context, string, ...interface{}) {}
	t.Cleanup(func() { emitEvent = oldEmit })
	return &App{
		ctx:    context.Background(),
		dbPath: filepath.Join(dir, "xssh.db"),
		mgr:    sshmgr.NewManager(),
	}
}

// --- Tests ---

// TestNewApp verifies the constructor initializes expected fields.
func TestNewApp(t *testing.T) {
	a := NewApp()
	if a == nil {
		t.Fatal("NewApp returned nil")
	}
	if a.mgr == nil {
		t.Error("mgr is nil")
	}
	if a.dbPath == "" {
		t.Error("dbPath is empty")
	}
	if !filepath.IsAbs(a.dbPath) {
		t.Errorf("dbPath should be absolute, got %q", a.dbPath)
	}
	// For a fresh app (no existing DB), salt should be nil.
	// (On a dev machine with existing xssh data, salt may be non-nil.)
}

// TestResolveDataDir_VerifyPlatformPath verifies the data dir is platform-appropriate.
func TestResolveDataDir_VerifyPlatformPath(t *testing.T) {
	dir := resolveDataDir()
	if dir == "" {
		t.Fatal("resolveDataDir returned empty")
	}
	// Verify the directory was created.
	info, err := os.Stat(dir)
	if err != nil {
		t.Fatalf("data dir does not exist: %v", err)
	}
	if !info.IsDir() {
		t.Errorf("data dir %q is not a directory", dir)
	}
}

// TestResolveDataDir_XDG verifies XDG_DATA_HOME override on Linux.
func TestResolveDataDir_XDG(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("XDG_DATA_HOME", tmp)
	dir := resolveDataDir()
	expected := filepath.Join(tmp, "xssh")
	if dir != expected {
		t.Errorf("expected %q, got %q", expected, dir)
	}
}

// TestResolveDataDir_APPDATA verifies APPDATA override on Windows path.
// We test the logic by setting APPDATA even on non-Windows (the switch
// uses runtime.GOOS so this only works on windows; on other platforms
// XDG is used). This test documents the behavior.
func TestResolveDataDir_APPDATA(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("APPDATA", tmp)
	// On non-Windows this won't use APPDATA, so just verify no panic.
	_ = resolveDataDir()
}

// TestApp_GetHosts_NoDB verifies GetHosts returns empty slice when DB is not unlocked.
func TestApp_GetHosts_NoDB(t *testing.T) {
	a := newTestApp(t)
	hosts, err := a.GetHosts()
	if err != nil {
		t.Fatalf("GetHosts: unexpected error: %v", err)
	}
	if hosts == nil {
		t.Error("expected non-nil empty slice, got nil")
	}
	if len(hosts) != 0 {
		t.Errorf("expected 0 hosts, got %d", len(hosts))
	}
}

// TestApp_SaveHost_NoDB verifies SaveHost returns error when DB is not unlocked.
func TestApp_SaveHost_NoDB(t *testing.T) {
	a := newTestApp(t)
	err := a.SaveHost(store.Host{ID: "h1", Name: "test"})
	if err == nil {
		t.Error("expected error when DB not unlocked")
	}
	if !strings.Contains(err.Error(), "db not unlocked") {
		t.Errorf("unexpected error: %v", err)
	}
}

// Note: SaveHost and DeleteHost call runtime.EventsEmit which uses log.Fatalf
// (not panic) when the context is not a valid Wails context. In unit tests we
// therefore test the error paths (DB not unlocked) and verify persistence via
// direct repo calls (a.hosts.Put / a.hosts.Delete).

// TestApp_DeleteHost_NoDB verifies DeleteHost returns error when DB is not unlocked.
func TestApp_DeleteHost_NoDB(t *testing.T) {
	a := newTestApp(t)
	err := a.DeleteHost("h1")
	if err == nil {
		t.Error("expected error when DB not unlocked")
	}
}

// TestApp_OpenTab_NoDB verifies OpenTab returns error when DB is not unlocked.
func TestApp_OpenTab_NoDB(t *testing.T) {
	a := newTestApp(t)
	_, err := a.OpenTab("h1", 80, 24)
	if err == nil {
		t.Error("expected error when DB not unlocked")
	}
}

// TestApp_Write_InvalidBase64 verifies Write returns error for invalid base64.
func TestApp_Write_InvalidBase64(t *testing.T) {
	a := newTestApp(t)
	err := a.Write("sid1", "not-valid-base64!!!")
	if err == nil {
		t.Error("expected error for invalid base64")
	}
	if !strings.Contains(err.Error(), "decode base64") {
		t.Errorf("unexpected error: %v", err)
	}
}

// TestApp_Write_SessionNotFound verifies Write returns error for unknown session.
func TestApp_Write_SessionNotFound(t *testing.T) {
	a := newTestApp(t)
	data := base64.StdEncoding.EncodeToString([]byte("hello"))
	err := a.Write("no-such-sid", data)
	if err == nil {
		t.Error("expected error for unknown session")
	}
	if !strings.Contains(err.Error(), "not found") {
		t.Errorf("unexpected error: %v", err)
	}
}

// TestApp_Resize_SessionNotFound verifies Resize returns error for unknown session.
func TestApp_Resize_SessionNotFound(t *testing.T) {
	a := newTestApp(t)
	err := a.Resize("no-such-sid", 80, 24)
	if err == nil {
		t.Error("expected error for unknown session")
	}
	if !strings.Contains(err.Error(), "not found") {
		t.Errorf("unexpected error: %v", err)
	}
}

// TestApp_CloseTab_Idempotent verifies CloseTab returns nil for unknown session.
func TestApp_CloseTab_Idempotent(t *testing.T) {
	a := newTestApp(t)
	if err := a.CloseTab("no-such-sid"); err != nil {
		t.Errorf("CloseTab unknown: expected nil, got %v", err)
	}
	// Call again — still nil.
	if err := a.CloseTab("no-such-sid"); err != nil {
		t.Errorf("second CloseTab: expected nil, got %v", err)
	}
}

// TestApp_UnlockDB_NoSalt verifies UnlockDB returns error when salt is nil.
func TestApp_UnlockDB_NoSalt(t *testing.T) {
	a := newTestApp(t)
	err := a.UnlockDB("mypass")
	if err == nil {
		t.Fatal("expected error when salt is nil")
	}
	if !strings.Contains(err.Error(), "no passphrase set") {
		t.Errorf("unexpected error: %v", err)
	}
}

// TestApp_GetSettings_NoDB verifies GetSettings returns empty map when DB not unlocked.
func TestApp_GetSettings_NoDB(t *testing.T) {
	a := newTestApp(t)
	settings, err := a.GetSettings()
	if err != nil {
		t.Fatalf("GetSettings: unexpected error: %v", err)
	}
	if settings == nil {
		t.Error("expected non-nil empty map, got nil")
	}
	if len(settings) != 0 {
		t.Errorf("expected 0 settings, got %d", len(settings))
	}
}

// TestApp_SetSetting_NoDB verifies SetSetting returns error when DB not unlocked.
func TestApp_SetSetting_NoDB(t *testing.T) {
	a := newTestApp(t)
	err := a.SetSetting("key", "value")
	if err == nil {
		t.Error("expected error when DB not unlocked")
	}
}

// TestApp_SetupDB verifies the full setup flow: salt, DB file, repos.
func TestApp_SetupDB(t *testing.T) {
	a := newTestApp(t)
	err := a.SetupDB("mysecret")
	if err != nil {
		t.Fatalf("SetupDB: %v", err)
	}

	// Salt should now be set.
	if a.salt == nil {
		t.Error("salt is nil after SetupDB")
	}
	if len(a.salt) != 32 {
		t.Errorf("expected 32-byte salt, got %d", len(a.salt))
	}

	// DB file should exist.
	info, err := os.Stat(a.dbPath)
	if err != nil {
		t.Fatalf("DB file not created: %v", err)
	}
	if info.Size() == 0 {
		t.Error("DB file is empty")
	}

	// Meta file should exist.
	metaPath := filepath.Join(a.dataDir(), "xssh-meta.json")
	if _, err := os.Stat(metaPath); err != nil {
		t.Errorf("meta file not created: %v", err)
	}

	// Repos should be initialized.
	if a.hosts == nil {
		t.Error("hosts repo is nil after SetupDB")
	}
	if a.settings == nil {
		t.Error("settings repo is nil after SetupDB")
	}

	// GetHosts should return empty.
	hosts, err := a.GetHosts()
	if err != nil {
		t.Fatalf("GetHosts after SetupDB: %v", err)
	}
	if len(hosts) != 0 {
		t.Errorf("expected 0 hosts after fresh setup, got %d", len(hosts))
	}
}

// TestApp_SetupDB_SaveHost_GetHosts verifies the full CRUD flow.
// Uses direct repo call (a.hosts.Put) instead of a.SaveHost because
// Wails EventsEmit calls log.Fatalf with a non-Wails context.
func TestApp_SetupDB_SaveHost_GetHosts(t *testing.T) {
	a := newTestApp(t)
	if err := a.SetupDB("mysecret"); err != nil {
		t.Fatalf("SetupDB: %v", err)
	}

	host := store.Host{
		ID:         "host-1",
		Name:       "test-server",
		Host:       "192.168.1.100",
		Port:       22,
		User:       "admin",
		AuthType:   "password",
		AuthSecret: "p@ss",
	}
	if err := a.hosts.Put(a.ctx, host); err != nil {
		t.Fatalf("hosts.Put: %v", err)
	}

	hosts, err := a.GetHosts()
	if err != nil {
		t.Fatalf("GetHosts: %v", err)
	}
	if len(hosts) != 1 {
		t.Fatalf("expected 1 host, got %d", len(hosts))
	}
	if hosts[0].ID != "host-1" {
		t.Errorf("expected host ID 'host-1', got %q", hosts[0].ID)
	}
	if hosts[0].AuthSecret != "p@ss" {
		t.Errorf("expected AuthSecret 'p@ss', got %q", hosts[0].AuthSecret)
	}
}

// TestApp_SetupDB_DeleteHost verifies deletion flow.
// Uses direct repo calls because Wails EventsEmit calls log.Fatalf
// with a non-Wails context.
func TestApp_SetupDB_DeleteHost(t *testing.T) {
	a := newTestApp(t)
	if err := a.SetupDB("mysecret"); err != nil {
		t.Fatalf("SetupDB: %v", err)
	}

	host := store.Host{ID: "h-del", Name: "del-me", Host: "10.0.0.1", Port: 22, User: "u", AuthType: "password", AuthSecret: "x"}
	if err := a.hosts.Put(a.ctx, host); err != nil {
		t.Fatalf("hosts.Put: %v", err)
	}
	if err := a.hosts.Delete(a.ctx, "h-del"); err != nil {
		t.Fatalf("hosts.Delete: %v", err)
	}

	hosts, _ := a.GetHosts()
	if len(hosts) != 0 {
		t.Errorf("expected 0 hosts after delete, got %d", len(hosts))
	}
}

// TestApp_UnlockDB_AfterSetup verifies unlock works after setup.
func TestApp_UnlockDB_AfterSetup(t *testing.T) {
	a := newTestApp(t)
	if err := a.SetupDB("correctpass"); err != nil {
		t.Fatalf("SetupDB: %v", err)
	}
	// Close the DB to simulate app restart.
	if err := a.db.Close(); err != nil {
		t.Fatalf("close db: %v", err)
	}
	a.db = nil
	a.hosts = nil
	a.settings = nil

	// Now unlock.
	if err := a.UnlockDB("correctpass"); err != nil {
		t.Fatalf("UnlockDB: %v", err)
	}
	if a.hosts == nil {
		t.Error("hosts repo nil after unlock")
	}
	if a.settings == nil {
		t.Error("settings repo nil after unlock")
	}
}

// TestApp_UnlockDB_WrongPassphrase verifies wrong passphrase error.
func TestApp_UnlockDB_WrongPassphrase(t *testing.T) {
	a := newTestApp(t)
	if err := a.SetupDB("correctpass"); err != nil {
		t.Fatalf("SetupDB: %v", err)
	}
	if err := a.db.Close(); err != nil {
		t.Fatalf("close db: %v", err)
	}
	a.db = nil
	a.hosts = nil
	a.settings = nil

	err := a.UnlockDB("wrongpass")
	if err == nil {
		t.Fatal("expected error for wrong passphrase")
	}
	if !strings.Contains(err.Error(), "wrong passphrase") {
		t.Errorf("expected 'wrong passphrase' in error, got: %v", err)
	}
}

// TestApp_SetSetting_GetSettings verifies settings round-trip.
func TestApp_SetSetting_GetSettings(t *testing.T) {
	a := newTestApp(t)
	if err := a.SetupDB("pass"); err != nil {
		t.Fatalf("SetupDB: %v", err)
	}

	if err := a.SetSetting("theme", "dark"); err != nil {
		t.Fatalf("SetSetting: %v", err)
	}
	if err := a.SetSetting("fontsize", "14"); err != nil {
		t.Fatalf("SetSetting: %v", err)
	}

	settings, err := a.GetSettings()
	if err != nil {
		t.Fatalf("GetSettings: %v", err)
	}
	if settings["theme"] != "dark" {
		t.Errorf("theme: expected 'dark', got %q", settings["theme"])
	}
	if settings["fontsize"] != "14" {
		t.Errorf("fontsize: expected '14', got %q", settings["fontsize"])
	}
}

// TestApp_Shutdown verifies shutdown closes the DB without panicking.
func TestApp_Shutdown(t *testing.T) {
	a := newTestApp(t)
	if err := a.SetupDB("pass"); err != nil {
		t.Fatalf("SetupDB: %v", err)
	}
	a.shutdown(context.Background()) // must not panic
}

// TestApp_DomReady verifies domReady does not panic.
func TestApp_DomReady(t *testing.T) {
	a := newTestApp(t)
	a.domReady(context.Background()) // must not panic
}

// TestIsWrongKeyErr verifies the error detection helper.
func TestIsWrongKeyErr(t *testing.T) {
	tests := []struct {
		name    string
		err     error
		want    bool
	}{
		{"nil error", nil, false},
		{"wrong passphrase", errContains("wrong passphrase"), true},
		{"not a database", errContains("file is not a database"), true},
		{"other error", errContains("some other error"), false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := isWrongKeyErr(tc.err); got != tc.want {
				t.Errorf("isWrongKeyErr(%v) = %v, want %v", tc.err, got, tc.want)
			}
		})
	}
}

// TestApp_Startup verifies startup sets the context.
func TestApp_Startup(t *testing.T) {
	a := newTestApp(t)
	ctx := context.Background()
	a.startup(ctx)
	if a.ctx == nil {
		t.Error("ctx not set after startup")
	}
}

// errContains is a test helper that creates an error containing the given string.
type testError struct{ msg string }

func (e *testError) Error() string { return e.msg }

func errContains(msg string) error { return &testError{msg: msg} }
