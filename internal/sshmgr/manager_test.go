package sshmgr

import (
	"bytes"
	"context"
	"testing"
)

// mockWriteCloser is a minimal io.WriteCloser used to stand in for a session's
// stdin in unit tests.
type mockWriteCloser struct {
	buf bytes.Buffer
}

func (w *mockWriteCloser) Write(p []byte) (int, error) { return w.buf.Write(p) }
func (w *mockWriteCloser) Close() error                { return nil }

// newMockSession builds a Session with the internal state needed to exercise
// the state-machine methods without a live SSH connection.
func newMockSession(t *testing.T, hostID, id string) *Session {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	return &Session{
		ID:     id,
		hostID: hostID,
		stdin:  &mockWriteCloser{},
		ctx:    ctx,
		cancel: cancel,
	}
}

// TestNewManager verifies the constructor initializes both registries.
func TestNewManager(t *testing.T) {
	m := NewManager()
	if m == nil {
		t.Fatal("NewManager returned nil")
	}
	if m.clients == nil {
		t.Error("clients map is nil")
	}
	if m.sessions == nil {
		t.Error("sessions map is nil")
	}
	if len(m.clients) != 0 {
		t.Errorf("expected empty clients map, got %d", len(m.clients))
	}
	if len(m.sessions) != 0 {
		t.Errorf("expected empty sessions map, got %d", len(m.sessions))
	}
}

// TestGetSession_Missing verifies lookup of a non-existent session.
func TestGetSession_Missing(t *testing.T) {
	m := NewManager()
	s, ok := m.GetSession("nonexistent")
	if ok {
		t.Error("expected ok=false for missing session")
	}
	if s != nil {
		t.Errorf("expected nil session, got %+v", s)
	}
}

// TestCloseTab_Idempotent verifies closing an unknown session is a no-op.
func TestCloseTab_Idempotent(t *testing.T) {
	m := NewManager()
	ctx := context.Background()
	if err := m.CloseTab(ctx, "no-such"); err != nil {
		t.Errorf("first CloseTab: expected nil, got %v", err)
	}
	if err := m.CloseTab(ctx, "no-such"); err != nil {
		t.Errorf("second CloseTab: expected nil, got %v", err)
	}
}

// TestCloseAll_Empty verifies CloseAll with no state does not panic.
func TestCloseAll_Empty(t *testing.T) {
	m := NewManager()
	m.CloseAll(context.Background()) // must not panic
}

// TestCloseSessionsForHost_NoSessions verifies the cascade close handles an
// empty registry without panicking.
func TestCloseSessionsForHost_NoSessions(t *testing.T) {
	m := NewManager()
	m.CloseSessionsForHost("h2") // no session for h2; must not panic
}

// TestCloseSessionsForHost_RemovesMatching verifies that only the sessions
// belonging to the given host are closed and removed.
func TestCloseSessionsForHost_RemovesMatching(t *testing.T) {
	m := NewManager()
	sa := newMockSession(t, "hostA", "sid-a")
	sb := newMockSession(t, "hostB", "sid-b")
	m.sessions["sid-a"] = sa
	m.sessions["sid-b"] = sb

	m.CloseSessionsForHost("hostA")

	if _, ok := m.GetSession("sid-a"); ok {
		t.Error("session for closed host still present")
	}
	if _, ok := m.GetSession("sid-b"); !ok {
		t.Error("session for other host was removed")
	}
	if sa.ctx.Err() == nil {
		t.Error("expected closed host session context to be cancelled")
	}
	if sb.ctx.Err() != nil {
		t.Error("expected other host session context to remain alive")
	}
}

// TestGetSession_Found verifies a registered session can be retrieved.
func TestGetSession_Found(t *testing.T) {
	m := NewManager()
	s := newMockSession(t, "h1", "sid-1")
	m.mu.Lock()
	m.sessions["sid-1"] = s
	m.mu.Unlock()

	got, ok := m.GetSession("sid-1")
	if !ok {
		t.Fatal("expected session to be found")
	}
	if got != s {
		t.Error("returned a different session object")
	}
}
