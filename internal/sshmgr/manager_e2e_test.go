package sshmgr

import (
	"context"
	"net"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/scottluo/xssh/internal/store"
)

// hostAt builds a store.Host pointing at addr's port with the given user and
// password auth.
func hostAt(user, authType, secret, host string, port int) store.Host {
	return store.Host{
		ID:         "h-e2e",
		Name:       "e2e",
		Host:       host,
		Port:       port,
		User:       user,
		AuthType:   authType,
		AuthSecret: secret,
	}
}

// splitAddr breaks the "127.0.0.1:port" address into host and port fields.
func splitAddr(t *testing.T, addr string) (string, int) {
	t.Helper()
	host, portStr, err := net.SplitHostPort(addr)
	if err != nil {
		t.Fatalf("parse addr %q: %v", addr, err)
	}
	port, err := strconv.Atoi(portStr)
	if err != nil {
		t.Fatalf("parse port %q: %v", portStr, err)
	}
	return host, port
}

// TestOpenTab_Password verifies a full PTY session over password auth: the
// login banner reaches onOut, and closing the tab is clean and idempotent.
func TestOpenTab_Password(t *testing.T) {
	srv := newTestSSHServer(t)
	defer srv.close()
	srv.banner = "banner-line\n"
	srv.usePassword("secret123")

	host, port := splitAddr(t, srv.addr)
	h := hostAt("alice", "password", "secret123", host, port)

	var mu sync.Mutex
	var out []string
	onOut := func(data []byte) { mu.Lock(); out = append(out, string(data)); mu.Unlock() }

	m := NewManager()
	defer m.CloseAll(context.Background())

	sid, sess, err := m.OpenTab(context.Background(), h.ID, h, 80, 24, onOut)
	if err != nil {
		t.Fatalf("OpenTab: %v", err)
	}
	if sid == "" || sess == nil {
		t.Fatalf("expected non-empty sid and non-nil session")
	}

	if _, ok := m.GetSession(sid); !ok {
		t.Error("session not registered after OpenTab")
	}

	waitFor(t, 2*time.Second, func() bool {
		mu.Lock()
		defer mu.Unlock()
		return strings.Contains(strings.Join(out, ""), "banner-line")
	})

	// Close twice to confirm idempotency.
	if err := m.CloseTab(context.Background(), sid); err != nil {
		t.Errorf("CloseTab: %v", err)
	}
	if err := m.CloseTab(context.Background(), sid); err != nil {
		t.Errorf("CloseTab (second): %v", err)
	}
	if _, ok := m.GetSession(sid); ok {
		t.Error("session still present after CloseTab")
	}
}

// TestOpenTab_KeyAuth verifies public-key authentication succeeds.
func TestOpenTab_KeyAuth(t *testing.T) {
	srv := newTestSSHServer(t)
	defer srv.close()
	keyPEM := srv.addKeyAuth(t)

	host, port := splitAddr(t, srv.addr)
	h := hostAt("bob", "key", keyPEM, host, port)

	m := NewManager()
	defer m.CloseAll(context.Background())

	if _, _, err := m.OpenTab(context.Background(), h.ID, h, 80, 24, func([]byte) {}); err != nil {
		t.Fatalf("OpenTab (key auth): %v", err)
	}
}

// TestOpenTab_AuthFailure verifies that a wrong password surfaces an error.
func TestOpenTab_AuthFailure(t *testing.T) {
	srv := newTestSSHServer(t)
	defer srv.close()
	srv.usePassword("correct")

	host, port := splitAddr(t, srv.addr)
	h := hostAt("carol", "password", "wrong", host, port)

	m := NewManager()
	defer m.CloseAll(context.Background())

	if _, _, err := m.OpenTab(context.Background(), h.ID, h, 80, 24, func([]byte) {}); err == nil {
		t.Error("expected auth failure error, got nil")
	}
}

// TestClientReuse verifies that two tabs to the same host share one SSH
// client (SM-01/SM-05, FR-02.3).
func TestClientReuse(t *testing.T) {
	srv := newTestSSHServer(t)
	defer srv.close()
	srv.usePassword("pw")

	host, port := splitAddr(t, srv.addr)
	h := hostAt("dave", "password", "pw", host, port)

	m := NewManager()
	defer m.CloseAll(context.Background())

	if _, _, err := m.OpenTab(context.Background(), h.ID, h, 80, 24, func([]byte) {}); err != nil {
		t.Fatalf("first OpenTab: %v", err)
	}
	if _, _, err := m.OpenTab(context.Background(), h.ID, h, 80, 24, func([]byte) {}); err != nil {
		t.Fatalf("second OpenTab: %v", err)
	}

	m.mu.Lock()
	clients := len(m.clients)
	m.mu.Unlock()
	if clients != 1 {
		t.Errorf("expected 1 shared client, got %d", clients)
	}
}

// TestSession_WriteEcho verifies that bytes written to a session are echoed
// back through the PTY (FR-02.1).
func TestSession_WriteEcho(t *testing.T) {
	srv := newTestSSHServer(t)
	defer srv.close()
	srv.usePassword("pw")

	host, port := splitAddr(t, srv.addr)
	h := hostAt("erin", "password", "pw", host, port)

	var mu sync.Mutex
	var got []string
	onOut := func(data []byte) { mu.Lock(); got = append(got, string(data)); mu.Unlock() }

	m := NewManager()
	defer m.CloseAll(context.Background())

	sid, sess, err := m.OpenTab(context.Background(), h.ID, h, 80, 24, onOut)
	if err != nil {
		t.Fatalf("OpenTab: %v", err)
	}
	defer func() { _ = m.CloseTab(context.Background(), sid) }()

	if err := sess.Write([]byte("hello-echo\n")); err != nil {
		t.Fatalf("Write: %v", err)
	}

	waitFor(t, 2*time.Second, func() bool {
		mu.Lock()
		defer mu.Unlock()
		return strings.Contains(strings.Join(got, ""), "hello-echo")
	})
}

// TestSession_Resize verifies the WindowChange request reaches the server.
func TestSession_Resize(t *testing.T) {
	srv := newTestSSHServer(t)
	defer srv.close()
	srv.usePassword("pw")

	host, port := splitAddr(t, srv.addr)
	h := hostAt("frank", "password", "pw", host, port)

	m := NewManager()
	defer m.CloseAll(context.Background())

	sid, sess, err := m.OpenTab(context.Background(), h.ID, h, 80, 24, func([]byte) {})
	if err != nil {
		t.Fatalf("OpenTab: %v", err)
	}
	defer func() { _ = m.CloseTab(context.Background(), sid) }()

	if err := sess.Resize(120, 40); err != nil {
		t.Fatalf("Resize: %v", err)
	}

	waitFor(t, 2*time.Second, func() bool {
		ws, ok := srv.lastWindowChange()
		return ok && ws.cols == 120 && ws.rows == 40
	})
}

// TestNoGoroutineLeak verifies that closing a tab does not leak pump
// goroutines (NFR-04): after CloseTab the session's Done channel is closed,
// proving the stdout/stderr pump goroutines have finished.
func TestNoGoroutineLeak(t *testing.T) {
	srv := newTestSSHServer(t)
	defer srv.close()
	srv.usePassword("pw")

	host, port := splitAddr(t, srv.addr)
	h := hostAt("gina", "password", "pw", host, port)

	m := NewManager()
	defer m.CloseAll(context.Background())

	sid, sess, err := m.OpenTab(context.Background(), h.ID, h, 80, 24, func([]byte) {})
	if err != nil {
		t.Fatalf("OpenTab: %v", err)
	}

	// Give the pump a moment to observe the (eventually empty) PTY, then close.
	time.Sleep(50 * time.Millisecond)
	if err := m.CloseTab(context.Background(), sid); err != nil {
		t.Fatalf("CloseTab: %v", err)
	}

	if _, ok := m.GetSession(sid); ok {
		t.Error("session should be removed after CloseTab")
	}

	// The Done channel must close once the pump goroutines drain.
	select {
	case <-sess.Done():
	case <-time.After(2 * time.Second):
		t.Error("pump goroutines did not finish after CloseTab (goroutine leak)")
	}
}

// waitFor polls cond until true or the timeout elapses, failing the test.
func waitFor(t *testing.T, d time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	if !cond() {
		t.Errorf("condition not met within %s", d)
	}
}
