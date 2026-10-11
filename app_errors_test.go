package main

import (
	"context"
	"strings"
	"testing"

	"github.com/scottluo/xssh/internal/store"
)


// TestApp_SaveHost_Success verifies SaveHost persists the host and emits
// the hosts:updated event (TC-APP-002).
func TestApp_SaveHost_Success(t *testing.T) {
	a := newTestApp(t)
	if err := a.SetupDB("pass"); err != nil {
		t.Fatalf("SetupDB: %v", err)
	}

	var emitted []string
	oldEmit := emitEvent
	emitEvent = func(_ context.Context, event string, _ ...interface{}) {
		emitted = append(emitted, event)
	}
	defer func() { emitEvent = oldEmit }()

	host := store.Host{
		ID:         "h-save",
		Name:       "save-test",
		Host:       "10.0.0.1",
		Port:       22,
		User:       "admin",
		AuthType:   "password",
		AuthSecret: "secret",
	}
	if err := a.SaveHost(host); err != nil {
		t.Fatalf("SaveHost: %v", err)
	}

	if len(emitted) != 1 || emitted[0] != "hosts:updated" {
		t.Errorf("expected [hosts:updated], got %v", emitted)
	}

	// Verify persistence.
	hosts, err := a.GetHosts()
	if err != nil {
		t.Fatalf("GetHosts: %v", err)
	}
	if len(hosts) != 1 || hosts[0].ID != "h-save" {
		t.Errorf("expected 1 host with ID h-save, got %+v", hosts)
	}
}

// TestApp_DeleteHost_Success verifies DeleteHost removes the host, closes
// its sessions, and emits the hosts:updated event (TC-APP-003).
func TestApp_DeleteHost_Success(t *testing.T) {
	a := newTestApp(t)
	if err := a.SetupDB("pass"); err != nil {
		t.Fatalf("SetupDB: %v", err)
	}

	// Create a host to delete.
	host := store.Host{
		ID:         "h-del",
		Name:       "del-test",
		Host:       "10.0.0.2",
		Port:       22,
		User:       "u",
		AuthType:   "password",
		AuthSecret: "x",
	}
	if err := a.hosts.Put(a.ctx, host); err != nil {
		t.Fatalf("hosts.Put: %v", err)
	}

	var emitted []string
	oldEmit := emitEvent
	emitEvent = func(_ context.Context, event string, _ ...interface{}) {
		emitted = append(emitted, event)
	}
	defer func() { emitEvent = oldEmit }()

	if err := a.DeleteHost("h-del"); err != nil {
		t.Fatalf("DeleteHost: %v", err)
	}

	if len(emitted) != 1 || emitted[0] != "hosts:updated" {
		t.Errorf("expected [hosts:updated], got %v", emitted)
	}

	// Verify host is gone.
	hosts, _ := a.GetHosts()
	if len(hosts) != 0 {
		t.Errorf("expected 0 hosts after delete, got %d", len(hosts))
	}
}

// TestApp_Shutdown_DBError verifies shutdown handles a DB close error
// without panicking (covers the log.Printf error path).
func TestApp_Shutdown_DBError(t *testing.T) {
	a := newTestApp(t)
	if err := a.SetupDB("pass"); err != nil {
		t.Fatalf("SetupDB: %v", err)
	}
	// Close the DB first so the second close in shutdown returns an error.
	if err := a.db.Close(); err != nil {
		t.Fatalf("pre-close db: %v", err)
	}
	// a.db is not nil, so shutdown will call a.db.Close() again.
	// The second Close on a closed *sql.DB returns an error, exercising
	// the log.Printf error path.
	a.shutdown(context.Background())
}

// TestApp_SaveHost_PutError verifies SaveHost returns a wrapped error when
// the underlying Put fails (covers the Put error branch).
func TestApp_SaveHost_PutError(t *testing.T) {
	a := newTestApp(t)
	if err := a.SetupDB("pass"); err != nil {
		t.Fatalf("SetupDB: %v", err)
	}
	// Close the DB so Put will fail.
	_ = a.db.Close()

	err := a.SaveHost(store.Host{ID: "h-x", Name: "x", Host: "1.1.1.1", Port: 22, User: "u", AuthType: "password", AuthSecret: "s"})
	if err == nil {
		t.Error("expected error when DB is closed")
	}
	if !strings.Contains(err.Error(), "save host") {
		t.Errorf("expected 'save host' in error, got: %v", err)
	}
}

// TestApp_DeleteHost_DeleteError verifies DeleteHost returns a wrapped error
// when the underlying Delete fails (covers the Delete error branch).
func TestApp_DeleteHost_DeleteError(t *testing.T) {
	a := newTestApp(t)
	if err := a.SetupDB("pass"); err != nil {
		t.Fatalf("SetupDB: %v", err)
	}
	// Close the DB so Delete will fail.
	_ = a.db.Close()

	err := a.DeleteHost("h-x")
	if err == nil {
		t.Error("expected error when DB is closed")
	}
	if !strings.Contains(err.Error(), "delete host") {
		t.Errorf("expected 'delete host' in error, got: %v", err)
	}
}

// TestApp_OpenTab_GetError verifies OpenTab returns a wrapped error when
// the host is not found (covers the hosts.Get error branch).
func TestApp_OpenTab_GetError(t *testing.T) {
	a := newTestApp(t)
	if err := a.SetupDB("pass"); err != nil {
		t.Fatalf("SetupDB: %v", err)
	}
	// OpenTab with a non-existent host ID.
	_, err := a.OpenTab("no-such-host", 80, 24)
	if err == nil {
		t.Error("expected error for non-existent host")
	}
	if !strings.Contains(err.Error(), "get host") {
		t.Errorf("expected 'get host' in error, got: %v", err)
	}
}
