package sshmgr

import (
	"io"
	"sync"
)

const pumpBufSize = 32 * 1024 // 32 KB read buffer

// startPump launches stdout and stderr pump goroutines and a watcher that
// closes s.done when both pumps have finished.
func startPump(s *Session) {
	s.wg = &sync.WaitGroup{}
	s.done = make(chan struct{})
	s.wg.Add(2)
	go func() {
		defer s.wg.Done()
		pumpReader(s, s.stdout)
	}()
	go func() {
		defer s.wg.Done()
		pumpReader(s, s.stderr)
	}()
	go func() {
		s.wg.Wait()
		if s.onClosed != nil {
			s.onClosed(s.ID)
		}
		close(s.done)
	}()
}

// pumpReader reads from r in a loop, calling s.onOut for each chunk of data.
// Exits when the reader returns an error (EOF or channel closed) or when the
// session context is cancelled.
func pumpReader(s *Session, r io.Reader) {
	buf := make([]byte, pumpBufSize)
	for {
		select {
		case <-s.ctx.Done():
			return
		default:
		}
		n, err := r.Read(buf)
		if n > 0 && s.onOut != nil {
			s.onOut(s.ID, buf[:n])
		}
		if err != nil {
			return // io.EOF or channel closed
		}
	}
}
