package sshmgr

import (
	"bytes"
	"context"
	"io"
	"testing"
	"time"
)

// eofReader is an io.Reader that delivers any buffered bytes once and then
// returns io.EOF, used to drive the pump goroutines to completion.
type eofReader struct{ r io.Reader }

func (e *eofReader) Read(p []byte) (int, error) {
	if e.r != nil {
		return e.r.Read(p)
	}
	return 0, io.EOF
}

// newPumpedSession builds a Session with stdout/stderr readers and starts the
// I/O pump so the Done() channel becomes meaningful.
func newPumpedSession(t *testing.T, stdout, stderr io.Reader, onOut func(sid string, data []byte)) *Session {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	s := &Session{
		ID:     "sid-pump",
		hostID: "host-pump",
		stdin:  &mockWriteCloser{},
		stdout: stdout,
		stderr: stderr,
		onOut:  onOut,
		ctx:    ctx,
		cancel: cancel,
	}
	startPump(s)
	return s
}

// TestSession_Write_Empty verifies that writing an empty slice is a no-op and
// returns no error.
func TestSession_Write_Empty(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s := &Session{
		stdin:  &mockWriteCloser{},
		ctx:    ctx,
		cancel: cancel,
	}
	if err := s.Write(nil); err != nil {
		t.Errorf("Write(nil): expected nil, got %v", err)
	}
	if err := s.Write([]byte{}); err != nil {
		t.Errorf("Write([]byte{}): expected nil, got %v", err)
	}
}

// TestSession_Write_ShortWrite verifies io.ErrShortWrite on a partial write.
func TestSession_Write_ShortWrite(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s := &Session{
		stdin:  &shortWriteCloser{},
		ctx:    ctx,
		cancel: cancel,
	}
	if err := s.Write([]byte("abcde")); err != io.ErrShortWrite {
		t.Errorf("expected io.ErrShortWrite, got %v", err)
	}
}

// shortWriteCloser always reports that it wrote only one byte.
type shortWriteCloser struct{}

func (shortWriteCloser) Write(p []byte) (int, error) { return 1, nil }
func (shortWriteCloser) Close() error                { return nil }

// TestSession_Close_Multiple verifies Close is idempotent and panic-free.
func TestSession_Close_Multiple(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	s := &Session{
		stdin:  &mockWriteCloser{},
		ctx:    ctx,
		cancel: cancel,
	}
	s.Close()
	s.Close()
	s.Close() // must not panic
	if s.ctx.Err() == nil {
		t.Error("expected context to be cancelled after Close")
	}
}

// TestSession_Done_Channel verifies startPump creates a Done channel that is
// closed once the pump goroutines drain (readers reach EOF).
func TestSession_Done_Channel(t *testing.T) {
	var out bytes.Buffer
	s := newPumpedSession(t,
		bytes.NewReader([]byte("hello\n")), // stdout delivers then EOF
		&eofReader{},                       // stderr EOF immediately
		func(sid string, data []byte) { out.Write(data) },
	)

	if s.Done() == nil {
		t.Fatal("Done() returned nil channel before pump completion")
	}

	select {
	case <-s.Done():
		// expected: both pumps drained
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for pump goroutines to finish")
	}

	if got := out.String(); got != "hello\n" {
		t.Errorf("expected %q in output, got %q", "hello\n", got)
	}
}

// TestSession_Pump_StderrDelivery verifies stderr data is pumped to onOut.
func TestSession_Pump_StderrDelivery(t *testing.T) {
	var out bytes.Buffer
	s := newPumpedSession(t,
		&eofReader{},                        // stdout EOF immediately
		bytes.NewReader([]byte("err-line")), // stderr delivers then EOF
		func(sid string, data []byte) { out.Write(data) },
	)
	select {
	case <-s.Done():
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for pump goroutines to finish")
	}
	if got := out.String(); got != "err-line" {
		t.Errorf("expected %q, got %q", "err-line", got)
	}
}

// TestSession_Close_StopsPump verifies that closing the session (cancelling
// the context) and draining the reader causes the pump goroutines to exit
// cleanly, i.e. no goroutine leak (PUMP-04/PUMP-06).
func TestSession_Close_StopsPump(t *testing.T) {
	// A reader that blocks in Read until released, then returns EOF.
	b := &blockingReader{release: make(chan struct{})}
	s := newPumpedSession(t, b, &eofReader{}, nil)
	if s.Done() == nil {
		t.Fatal("Done() is nil after startPump")
	}

	s.Close()        // cancel ctx + close stdin
	close(b.release) // unblock the stdout pump so it observes EOF

	select {
	case <-s.Done():
	case <-time.After(2 * time.Second):
		t.Fatal("pump did not stop after close")
	}
}

// blockingReader blocks in Read until its release channel is closed.
type blockingReader struct{ release chan struct{} }

func (b *blockingReader) Read(p []byte) (int, error) {
	<-b.release
	return 0, io.EOF
}
