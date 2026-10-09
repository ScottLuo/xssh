package sshmgr

import (
	"context"
	"io"
	"sync"

	"golang.org/x/crypto/ssh"
)

// Session represents a single terminal tab backed by an SSH PTY session.
//
// stdout and stderr are io.Reader (the types returned by ssh.Session's
// StdoutPipe/StderrPipe). Closing the underlying SSH session ends the reads.
type Session struct {
	ID       string
	hostID   string
	client   *ssh.Client
	sess     *ssh.Session
	stdin    io.WriteCloser
	stdout   io.Reader
	stderr   io.Reader
	onOut    func(data []byte)
	onClosed func()
	ctx      context.Context
	cancel   context.CancelFunc
	wg       *sync.WaitGroup
	done     chan struct{}

	closeOnce sync.Once
}

// Write sends data to the remote shell's stdin.
// Returns io.ErrShortWrite if fewer bytes than len(data) were written.
func (s *Session) Write(data []byte) error {
	n, err := s.stdin.Write(data)
	if n < len(data) {
		return io.ErrShortWrite
	}
	return err
}

// Resize sends a window-change request to the remote PTY.
func (s *Session) Resize(cols, rows uint16) error {
	return s.sess.WindowChange(int(rows), int(cols))
}

// Close cancels the session context, closes stdin (EOF to remote), and closes
// the SSH session. Safe to call multiple times.
func (s *Session) Close() {
	s.closeOnce.Do(func() {
		s.cancel()
		if s.stdin != nil {
			_ = s.stdin.Close()
		}
		if s.sess != nil {
			_ = s.sess.Close()
		}
	})
}

// Done returns a channel that is closed when both pump goroutines have exited.
func (s *Session) Done() <-chan struct{} {
	return s.done
}
