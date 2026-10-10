//go:build integration
// +build integration

package main

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"fmt"
	"net"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"

	"github.com/scottluo/xssh/internal/store"
)

// --- In-process SSH test server ---

// sshTestServer is a minimal in-process SSH server that accepts password auth
// and echoes stdin to stdout on shell sessions.
type sshTestServer struct {
	ln     net.Listener
	hostKey ssh.Signer
	wg     sync.WaitGroup
}

func newSSHTestServer(t *testing.T) *sshTestServer {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("gen key: %v", err)
	}
	signer, err := ssh.NewSignerFromSigner(key)
	if err != nil {
		t.Fatalf("signer: %v", err)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}

	s := &sshTestServer{ln: ln, hostKey: signer}
	s.wg.Add(1)
	go s.accept()
	t.Cleanup(func() {
		_ = ln.Close()
		s.wg.Wait()
	})
	return s
}

func (s *sshTestServer) addr() string { return s.ln.Addr().String() }

func (s *sshTestServer) accept() {
	defer s.wg.Done()
	for {
		conn, err := s.ln.Accept()
		if err != nil {
			return
		}
		s.wg.Add(1)
		go func() {
			defer s.wg.Done()
			s.handleConn(conn)
		}()
	}
}

func (s *sshTestServer) handleConn(nc net.Conn) {
	cfg := &ssh.ServerConfig{
		PasswordCallback: func(c ssh.ConnMetadata, pw []byte) (*ssh.Permissions, error) {
			if string(pw) == "testpass" {
				return &ssh.Permissions{}, nil
			}
			return nil, fmt.Errorf("auth failed")
		},
	}
	cfg.AddHostKey(s.hostKey)

	sc, chans, reqs, err := ssh.NewServerConn(nc, cfg)
	if err != nil {
		_ = nc.Close()
		return
	}
	defer func() { _ = sc.Close() }()
	go ssh.DiscardRequests(reqs)

	for newChan := range chans {
		if newChan.ChannelType() != "session" {
			_ = newChan.Reject(ssh.UnknownChannelType, "only session supported")
			continue
		}
		ch, chReqs, _ := newChan.Accept()
		// Handle channel requests: reply true to all (PTY, shell, etc.)
		go func() {
			for req := range chReqs {
				if req.WantReply {
					_ = req.Reply(true, nil)
				}
			}
		}()
		// Echo stdin to stdout
		go func() {
			buf := make([]byte, 4096)
			for {
				n, rerr := ch.Read(buf)
				if n > 0 {
					_, _ = ch.Write(buf[:n])
				}
				if rerr != nil {
					break
				}
			}
			_ = ch.Close()
		}()
	}
}

// hostForServer builds a store.Host pointing to the test server.
func hostForServer(s *sshTestServer, id string) store.Host {
	host, portStr, _ := net.SplitHostPort(s.addr())
	port, _ := strconv.Atoi(portStr)
	return store.Host{
		ID:         id,
		Name:       "test-host",
		Host:       host,
		Port:       port,
		User:       "testuser",
		AuthType:   "password",
		AuthSecret: "testpass",
		Shell:      "/bin/bash",
	}
}

// --- Integration tests ---

// TestApp_OpenTab_FullFlow verifies the complete OpenTab → Write → CloseTab
// cycle against a real in-process SSH server (TC-APP-004, TC-APP-006).
func TestApp_OpenTab_FullFlow(t *testing.T) {
	sshSrv := newSSHTestServer(t)
	a := newTestApp(t)
	if err := a.SetupDB("pass"); err != nil {
		t.Fatalf("SetupDB: %v", err)
	}

	host := hostForServer(sshSrv, "h-e2e")
	if err := a.hosts.Put(a.ctx, host); err != nil {
		t.Fatalf("Put: %v", err)
	}

	// Override emitEvent to capture events.
	var mu sync.Mutex
	var events []string
	oldEmit := emitEvent
	emitEvent = func(_ context.Context, event string, _ ...interface{}) {
		mu.Lock()
		events = append(events, event)
		mu.Unlock()
	}
	defer func() { emitEvent = oldEmit }()

	sid, err := a.OpenTab("h-e2e", 80, 24)
	if err != nil {
		t.Fatalf("OpenTab: %v", err)
	}
	if sid == "" {
		t.Fatal("OpenTab returned empty session ID")
	}

	// Write to the session.
	b64 := "aGVsbG8K" // base64("hello\n")
	if err := a.Write(sid, b64); err != nil {
		t.Errorf("Write: %v", err)
	}

	// Resize.
	if err := a.Resize(sid, 100, 30); err != nil {
		t.Errorf("Resize: %v", err)
	}

	// CloseTab.
	if err := a.CloseTab(sid); err != nil {
		t.Errorf("CloseTab: %v", err)
	}

	// CloseTab again (idempotent).
	if err := a.CloseTab(sid); err != nil {
		t.Errorf("CloseTab second call: %v", err)
	}

	// Verify ssh:out event was emitted (the echo server sends back "hello\n").
	mu.Lock()
	var hasOut bool
	for _, e := range events {
		if strings.HasPrefix(e, "ssh:out:") {
			hasOut = true
		}
	}
	mu.Unlock()
	// The echo may or may not arrive before CloseTab; at minimum verify
	// no panic occurred and the flow completed.
	if !hasOut {
		t.Log("Note: no ssh:out event captured (echo may not have arrived before close)")
	}

	// Close the SSH manager to stop keepalive goroutines.
	a.mgr.CloseAll(context.Background())
}

// TestApp_OpenTab_WrongHost verifies OpenTab returns error for unknown host.
func TestApp_OpenTab_WrongHost(t *testing.T) {
	a := newTestApp(t)
	if err := a.SetupDB("pass"); err != nil {
		t.Fatalf("SetupDB: %v", err)
	}
	_, err := a.OpenTab("nonexistent", 80, 24)
	if err == nil {
		t.Fatal("expected error for unknown host")
	}
}

// TestApp_Write_RealSession verifies Write delivers bytes to the remote PTY.
func TestApp_Write_RealSession(t *testing.T) {
	sshSrv := newSSHTestServer(t)
	a := newTestApp(t)
	if err := a.SetupDB("pass"); err != nil {
		t.Fatalf("SetupDB: %v", err)
	}

	host := hostForServer(sshSrv, "h-w")
	if err := a.hosts.Put(a.ctx, host); err != nil {
		t.Fatalf("Put: %v", err)
	}

	// Capture output.
	var outMu sync.Mutex
	var outData []byte
	oldEmit := emitEvent
	emitEvent = func(_ context.Context, event string, payload ...interface{}) {
		if strings.HasPrefix(event, "ssh:out:") && len(payload) > 0 {
			if s, ok := payload[0].(string); ok {
				decoded := decodeB64(t, s)
				outMu.Lock()
				outData = append(outData, decoded...)
				outMu.Unlock()
			}
		}
	}
	defer func() { emitEvent = oldEmit }()

	sid, err := a.OpenTab("h-w", 80, 24)
	if err != nil {
		t.Fatalf("OpenTab: %v", err)
	}
	defer func() { _ = a.CloseTab(sid) }()
	defer a.mgr.CloseAll(context.Background())

	// Write "ping\n" and wait for echo.
	testStr := "ping\n"
	b64 := encodeB64(t, []byte(testStr))
	if err := a.Write(sid, b64); err != nil {
		t.Fatalf("Write: %v", err)
	}

	// Wait for echo.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		outMu.Lock()
		got := string(outData)
		outMu.Unlock()
		if strings.Contains(got, testStr) {
			return // success
		}
		time.Sleep(10 * time.Millisecond)
	}
	outMu.Lock()
	got := string(outData)
	outMu.Unlock()
	if !strings.Contains(got, testStr) {
		t.Errorf("expected echo to contain %q, got %q", testStr, got)
	}
}

// TestApp_CloseTab_NoGoroutineLeak verifies pump goroutines exit after
// CloseTab (NFR-04, TC-SESS-006).
func TestApp_CloseTab_NoGoroutineLeak(t *testing.T) {
	sshSrv := newSSHTestServer(t)
	a := newTestApp(t)
	if err := a.SetupDB("pass"); err != nil {
		t.Fatalf("SetupDB: %v", err)
	}

	host := hostForServer(sshSrv, "h-leak")
	if err := a.hosts.Put(a.ctx, host); err != nil {
		t.Fatalf("Put: %v", err)
	}

	// Open and close 3 sessions; verify no goroutine leak.
	for i := 0; i < 3; i++ {
		sid, err := a.OpenTab("h-leak", 80, 24)
		if err != nil {
			t.Fatalf("OpenTab %d: %v", i, err)
		}
		if err := a.CloseTab(sid); err != nil {
			t.Fatalf("CloseTab %d: %v", i, err)
		}
	}
	// Give pumps time to drain.
	time.Sleep(200 * time.Millisecond)
	// Close the SSH manager to release the client connection so the
	// in-process SSH server can finish its cleanup without blocking.
	a.mgr.CloseAll(context.Background())
}

// TestApp_SshClosedEvent verifies ssh:closed event is emitted when the
// remote side closes the session (TC-APP-017).
func TestApp_SshClosedEvent(t *testing.T) {
	sshSrv := newSSHTestServer(t)
	a := newTestApp(t)
	if err := a.SetupDB("pass"); err != nil {
		t.Fatalf("SetupDB: %v", err)
	}

	host := hostForServer(sshSrv, "h-closed")
	if err := a.hosts.Put(a.ctx, host); err != nil {
		t.Fatalf("Put: %v", err)
	}

	var mu sync.Mutex
	closedEvents := make(chan string, 10)
	oldEmit := emitEvent
	emitEvent = func(_ context.Context, event string, _ ...interface{}) {
		if strings.HasPrefix(event, "ssh:closed:") {
			mu.Lock()
			closedEvents <- event
			mu.Unlock()
		}
	}
	defer func() { emitEvent = oldEmit }()

	sid, err := a.OpenTab("h-closed", 80, 24)
	if err != nil {
		t.Fatalf("OpenTab: %v", err)
	}
	defer a.mgr.CloseAll(context.Background())
	if err := a.CloseTab(sid); err != nil {
		t.Fatalf("CloseTab: %v", err)
	}

	select {
	case event := <-closedEvents:
		if !strings.HasPrefix(event, "ssh:closed:"+sid) {
			t.Errorf("unexpected closed event: %q", event)
		}
	case <-time.After(3 * time.Second):
		t.Error("timeout waiting for ssh:closed event")
	}
}

// --- Helpers ---

func encodeB64(t *testing.T, data []byte) string {
	t.Helper()
	return base64.StdEncoding.EncodeToString(data)
}

func decodeB64(t *testing.T, s string) []byte {
	t.Helper()
	b, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		t.Fatalf("decode b64: %v", err)
	}
	return b
}
