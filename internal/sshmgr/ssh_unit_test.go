package sshmgr

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
	"net"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/scottluo/xssh/internal/store"
)

// --- Helpers shared with manager_e2e_test.go (integration) ---

// unitHostAt builds a store.Host pointing at addr's port with the given user
// and password/key auth.
func unitHostAt(user, authType, secret, host string, port int) store.Host {
	return store.Host{
		ID:         "h-unit",
		Name:       "unit",
		Host:       host,
		Port:       port,
		User:       user,
		AuthType:   authType,
		AuthSecret: secret,
	}
}

// unitSplitAddr breaks "127.0.0.1:port" into host and port.
func unitSplitAddr(t *testing.T, addr string) (string, int) {
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

// --- Unit tests for dialClient / clientFor / OpenTab / writeInitCmds ---

// TestClientFor_DialPassword verifies clientFor dials a new connection with
// password auth and caches it (SM-03, SM-05).
func TestClientFor_DialPassword(t *testing.T) {
	srv := newTestSSHServer(t)
	defer srv.close()
	srv.usePassword("pw123")

	host, port := unitSplitAddr(t, srv.addr)
	h := unitHostAt("alice", "password", "pw123", host, port)

	m := NewManager()
	defer m.CloseAll(context.Background())

	sc, err := m.clientFor(context.Background(), h.ID, h)
	if err != nil {
		t.Fatalf("clientFor: %v", err)
	}
	if sc == nil || sc.client == nil {
		t.Fatal("clientFor returned nil client")
	}

	// Verify it is cached.
	m.mu.Lock()
	cached, ok := m.clients[h.ID]
	m.mu.Unlock()
	if !ok {
		t.Fatal("client not cached in map")
	}
	if cached != sc {
		t.Error("cached client is not the same instance returned")
	}

	// Second call should return the cached client (SM-01).
	sc2, err := m.clientFor(context.Background(), h.ID, h)
	if err != nil {
		t.Fatalf("second clientFor: %v", err)
	}
	if sc2 != sc {
		t.Error("expected cached client to be reused")
	}
}

// TestClientFor_DialKey verifies clientFor dials with public-key auth.
func TestClientFor_DialKey(t *testing.T) {
	srv := newTestSSHServer(t)
	defer srv.close()
	keyPEM := srv.addKeyAuth(t)

	host, port := unitSplitAddr(t, srv.addr)
	h := unitHostAt("bob", "key", keyPEM, host, port)

	m := NewManager()
	defer m.CloseAll(context.Background())

	sc, err := m.clientFor(context.Background(), h.ID, h)
	if err != nil {
		t.Fatalf("clientFor (key): %v", err)
	}
	if sc == nil || sc.client == nil {
		t.Fatal("clientFor returned nil client")
	}
}

// TestClientFor_AuthFailure verifies clientFor returns an error on bad password.
func TestClientFor_AuthFailure(t *testing.T) {
	srv := newTestSSHServer(t)
	defer srv.close()
	srv.usePassword("correct")

	host, port := unitSplitAddr(t, srv.addr)
	h := unitHostAt("carol", "password", "wrong", host, port)

	m := NewManager()
	defer m.CloseAll(context.Background())

	_, err := m.clientFor(context.Background(), h.ID, h)
	if err == nil {
		t.Error("expected auth failure error, got nil")
	}
}

// TestClientFor_DeadClientReplaced verifies that a dead client is replaced
// on the next call (SM-03).
func TestClientFor_DeadClientReplaced(t *testing.T) {
	srv := newTestSSHServer(t)
	defer srv.close()
	srv.usePassword("pw")

	host, port := unitSplitAddr(t, srv.addr)
	h := unitHostAt("dave", "password", "pw", host, port)

	m := NewManager()
	defer m.CloseAll(context.Background())

	sc1, err := m.clientFor(context.Background(), h.ID, h)
	if err != nil {
		t.Fatalf("first clientFor: %v", err)
	}

	// Simulate death.
	sc1.markDead()

	sc2, err := m.clientFor(context.Background(), h.ID, h)
	if err != nil {
		t.Fatalf("second clientFor: %v", err)
	}
	if sc2 == sc1 {
		t.Error("expected a new client after the old one was marked dead")
	}
}

// TestOpenTab_Success verifies a full OpenTab round-trip against the in-process
// SSH server (PTY, shell, pipe setup, session registration, pump start).
func TestOpenTab_Success(t *testing.T) {
	srv := newTestSSHServer(t)
	defer srv.close()
	srv.usePassword("pw")

	host, port := unitSplitAddr(t, srv.addr)
	h := unitHostAt("erin", "password", "pw", host, port)

	m := NewManager()
	defer m.CloseAll(context.Background())

	var mu sync.Mutex
	var out []string
	onOut := func(sid string, data []byte) {
		mu.Lock()
		out = append(out, string(data))
		mu.Unlock()
	}

	sid, sess, err := m.OpenTab(context.Background(), h.ID, h, 80, 24, onOut, nil)
	if err != nil {
		t.Fatalf("OpenTab: %v", err)
	}
	if sid == "" {
		t.Error("OpenTab returned empty session ID")
	}
	if sess == nil {
		t.Fatalf("OpenTab returned nil session")
	}
	if sess.ID != sid {
		t.Errorf("session.ID = %q, want %q", sess.ID, sid)
	}

	// Verify session is registered.
	if _, ok := m.GetSession(sid); !ok {
		t.Error("session not registered after OpenTab")
	}

	// Close the tab.
	if err := m.CloseTab(context.Background(), sid); err != nil {
		t.Errorf("CloseTab: %v", err)
	}
}

// TestOpenTab_WithInitCmds verifies initial commands are written to the shell
// stdin (spec §3.6). The in-process server echoes stdin back to stdout, so
// we can observe the commands in the output.
func TestOpenTab_WithInitCmds(t *testing.T) {
	srv := newTestSSHServer(t)
	defer srv.close()
	srv.usePassword("pw")

	host, port := unitSplitAddr(t, srv.addr)
	h := unitHostAt("frank", "password", "pw", host, port)
	h.InitCmds = []string{"echo hello-init"}

	m := NewManager()
	defer m.CloseAll(context.Background())

	var mu sync.Mutex
	var out []string
	onOut := func(sid string, data []byte) {
		mu.Lock()
		out = append(out, string(data))
		mu.Unlock()
	}

	sid, _, err := m.OpenTab(context.Background(), h.ID, h, 80, 24, onOut, nil)
	if err != nil {
		t.Fatalf("OpenTab: %v", err)
	}
	defer func() { _ = m.CloseTab(context.Background(), sid) }()

	// Wait for the echoed init command to appear.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		joined := strings.Join(out, "")
		mu.Unlock()
		if strings.Contains(joined, "echo hello-init") {
			return // success
		}
		time.Sleep(20 * time.Millisecond)
	}
	mu.Lock()
	joined := strings.Join(out, "")
	mu.Unlock()
	if !strings.Contains(joined, "echo hello-init") {
		t.Errorf("expected init command echo, got: %q", joined)
	}
}

// TestWriteInitCmds_ContextCancelled verifies writeInitCmds exits promptly
// when the session context is cancelled before the delay elapses.
func TestWriteInitCmds_ContextCancelled(t *testing.T) {
	m := NewManager()
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // cancel immediately

	s := &Session{
		ID:     "s1",
		ctx:    ctx,
		cancel: func() {},
	}
	done := make(chan struct{})
	go func() {
		m.writeInitCmds(s, []string{"cmd1", "cmd2"})
		close(done)
	}()

	select {
	case <-done:
		// exited promptly — good
	case <-time.After(500 * time.Millisecond):
		t.Error("writeInitCmds did not exit after context cancellation")
	}
}

// TestAuthMethods verifies the auth method selection logic.
func TestAuthMethods(t *testing.T) {
	m := NewManager()

	// Password auth.
	hPw := store.Host{AuthType: "password", AuthSecret: "secret"}
	methods := m.authMethods(hPw)
	if len(methods) != 1 {
		t.Fatalf("expected 1 auth method, got %d", len(methods))
	}

	// Key auth (valid PEM).
	priv, _ := rsa.GenerateKey(rand.Reader, 2048)
	keyPEM := string(pem.EncodeToMemory(&pem.Block{
		Type:  "RSA PRIVATE KEY",
		Bytes: x509.MarshalPKCS1PrivateKey(priv),
	}))
	hKey := store.Host{AuthType: "key", AuthSecret: keyPEM}
	methods = m.authMethods(hKey)
	if len(methods) != 1 {
		t.Fatalf("expected 1 auth method for key, got %d", len(methods))
	}

	// Key auth (invalid PEM → fallback to password).
	hBad := store.Host{AuthType: "key", AuthSecret: "not-a-valid-key"}
	methods = m.authMethods(hBad)
	if len(methods) != 1 {
		t.Fatalf("expected 1 auth method (fallback), got %d", len(methods))
	}
}

// TestPingClient verifies pingClient sends a keepalive request.
func TestPingClient(t *testing.T) {
	srv := newTestSSHServer(t)
	defer srv.close()
	srv.usePassword("pw")

	host, port := unitSplitAddr(t, srv.addr)
	h := unitHostAt("gina", "password", "pw", host, port)

	m := NewManager()
	defer m.CloseAll(context.Background())

	sc, err := m.clientFor(context.Background(), h.ID, h)
	if err != nil {
		t.Fatalf("clientFor: %v", err)
	}
	// pingClient should succeed on a live connection.
	if err := pingClient(sc.client); err != nil {
		t.Errorf("pingClient: %v", err)
	}
}

// TestPingClient_DeadClient verifies pingClient returns an error on a dead
// connection.
func TestPingClient_DeadClient(t *testing.T) {
	srv := newTestSSHServer(t)
	defer srv.close()
	srv.usePassword("pw")

	host, port := unitSplitAddr(t, srv.addr)
	h := unitHostAt("hank", "password", "pw", host, port)

	m := NewManager()
	defer m.CloseAll(context.Background())

	sc, err := m.clientFor(context.Background(), h.ID, h)
	if err != nil {
		t.Fatalf("clientFor: %v", err)
	}
	// Close the client to make it dead.
	_ = sc.client.Close()
	if err := pingClient(sc.client); err == nil {
		t.Error("expected error from pingClient on dead client")
	}
}

// TestSSHClient_Alive verifies the liveness check on sshClient.
func TestSSHClient_Alive(t *testing.T) {
	srv := newTestSSHServer(t)
	defer srv.close()
	srv.usePassword("pw")

	host, port := unitSplitAddr(t, srv.addr)
	h := unitHostAt("ivy", "password", "pw", host, port)

	m := NewManager()
	defer m.CloseAll(context.Background())

	sc, err := m.clientFor(context.Background(), h.ID, h)
	if err != nil {
		t.Fatalf("clientFor: %v", err)
	}
	if !sc.alive() {
		t.Fatal("client should be alive initially")
	}

	// Mark it dead; alive() should now return false.
	sc.markDead()
	if sc.alive() {
		t.Error("client should be dead after markDead")
	}

	// markDead is idempotent (safe to call twice).
	sc.markDead() // must not panic
}

// TestSession_Close_Idempotent_SSH verifies Session.Close is idempotent when
// backed by a live SSH session (safe to call multiple times without panic).
func TestSession_Close_Idempotent_SSH(t *testing.T) {
	srv := newTestSSHServer(t)
	defer srv.close()
	srv.usePassword("pw")

	host, port := unitSplitAddr(t, srv.addr)
	h := unitHostAt("jack", "password", "pw", host, port)

	m := NewManager()
	defer m.CloseAll(context.Background())

	sid, sess, err := m.OpenTab(context.Background(), h.ID, h, 80, 24, func(string, []byte) {}, nil)
	if err != nil {
		t.Fatalf("OpenTab: %v", err)
	}
	_ = sid

	// Close multiple times — must not panic.
	sess.Close()
	sess.Close()
	sess.Close()
}

// TestSession_Done verifies the Done channel is closed after the pump
// goroutines finish.
func TestSession_Done(t *testing.T) {
	srv := newTestSSHServer(t)
	defer srv.close()
	srv.usePassword("pw")

	host, port := unitSplitAddr(t, srv.addr)
	h := unitHostAt("kate", "password", "pw", host, port)

	m := NewManager()
	defer m.CloseAll(context.Background())

	sid, sess, err := m.OpenTab(context.Background(), h.ID, h, 80, 24, func(string, []byte) {}, nil)
	if err != nil {
		t.Fatalf("OpenTab: %v", err)
	}

	if err := m.CloseTab(context.Background(), sid); err != nil {
		t.Fatalf("CloseTab: %v", err)
	}

	select {
	case <-sess.Done():
		// pump goroutines finished — good
	case <-time.After(3 * time.Second):
		t.Error("Done channel not closed after CloseTab (possible goroutine leak)")
	}
}

// end of file
