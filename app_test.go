package main

import (
	"context"
	"testing"

	"github.com/scottluo/xssh/internal/store"
)

func TestNewApp(t *testing.T) {
	a := NewApp()
	if a == nil {
		t.Fatal("NewApp returned nil")
	}
	if a.ctx != nil {
		t.Fatal("expected ctx to be nil before startup")
	}
}

func TestApp_Startup(t *testing.T) {
	a := NewApp()
	ctx := context.Background()
	a.startup(ctx)
	if a.ctx != ctx {
		t.Fatal("startup did not set ctx")
	}
}

func TestApp_Shutdown(t *testing.T) {
	a := NewApp()
	a.shutdown(context.Background())
	// No panic is the success criterion.
}

func TestApp_GetHosts(t *testing.T) {
	a := NewApp()
	hosts, err := a.GetHosts()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if hosts != nil {
		t.Fatalf("expected nil hosts, got %v", hosts)
	}
}

func TestApp_SaveHost(t *testing.T) {
	a := NewApp()
	h := store.Host{ID: "1", Name: "test", Host: "localhost", Port: 22, User: "root"}
	err := a.SaveHost(h)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestApp_DeleteHost(t *testing.T) {
	a := NewApp()
	err := a.DeleteHost("1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestApp_OpenTab(t *testing.T) {
	a := NewApp()
	sid, err := a.OpenTab("host1", 80, 24)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if sid != "" {
		t.Fatalf("expected empty session ID, got %q", sid)
	}
}

func TestApp_Write(t *testing.T) {
	a := NewApp()
	err := a.Write("sid1", "base64data")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestApp_Resize(t *testing.T) {
	a := NewApp()
	err := a.Resize("sid1", 100, 30)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestApp_CloseTab(t *testing.T) {
	a := NewApp()
	err := a.CloseTab("sid1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestApp_UnlockDB(t *testing.T) {
	a := NewApp()
	err := a.UnlockDB("passphrase")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestApp_SetupDB(t *testing.T) {
	a := NewApp()
	err := a.SetupDB("passphrase")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestApp_GetSettings(t *testing.T) {
	a := NewApp()
	settings, err := a.GetSettings()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if settings != nil {
		t.Fatalf("expected nil settings, got %v", settings)
	}
}

func TestApp_SetSetting(t *testing.T) {
	a := NewApp()
	err := a.SetSetting("key", "value")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestApp_DomReady(t *testing.T) {
	a := NewApp()
	a.domReady(context.Background())
	// No panic is the success criterion.
}
