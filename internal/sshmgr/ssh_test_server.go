package sshmgr

// This file provides an in-process SSH server used by the unit tests to
// exercise the Manager and Session against a real local SSH endpoint. It
// needs no external sshd, so the tests remain self-contained.

import (
	"crypto/rsa"
	"crypto/x509"
	"encoding/binary"
	"encoding/pem"
	"errors"
	"net"
	"sync"
	"testing"

	"golang.org/x/crypto/ssh"
)

// windowSize captures a PTY resize request observed on the server.
type windowSize struct{ cols, rows uint16 }

// testSSHServer is a minimal in-process SSH server that supports password and
// public-key auth, honours pty/shell/window-change requests, echoes session
// stdin to stdout, and optionally emits a login banner. It lets the tests
// verify connection reuse, I/O pumping, and resize without a real host.
type testSSHServer struct {
	ln       net.Listener
	addr     string
	hostSign ssh.Signer
	banner   string
	password string
	pubKeys  map[string]bool
	changes  []windowSize
	mu       sync.Mutex
	closed   bool
}

func newTestSSHServer(t *testing.T) *testSSHServer {
	hostPriv, err := rsa.GenerateKey(randReader, 2048)
	if err != nil {
		t.Fatalf("generate host key: %v", err)
	}
	hostSign, err := ssh.NewSignerFromSigner(hostPriv)
	if err != nil {
		t.Fatalf("wrap host key: %v", err)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	s := &testSSHServer{
		ln:       ln,
		addr:     ln.Addr().String(),
		hostSign: hostSign,
		pubKeys:  make(map[string]bool),
	}
	go s.serve()
	return s
}

// close stops the listener. Safe to call multiple times.
func (s *testSSHServer) close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return
	}
	s.closed = true
	_ = s.ln.Close()
}

// usePassword enables password auth with the given password.
func (s *testSSHServer) usePassword(pw string) {
	s.mu.Lock()
	s.password = pw
	s.mu.Unlock()
}

// addKeyAuth authorizes a fresh client key and returns its PKCS#1 PEM form,
// suitable for store.Host.AuthSecret with AuthType "key".
func (s *testSSHServer) addKeyAuth(t *testing.T) string {
	t.Helper()
	priv, err := rsa.GenerateKey(randReader, 2048)
	if err != nil {
		t.Fatalf("generate client key: %v", err)
	}
	signer, err := ssh.NewSignerFromSigner(priv)
	if err != nil {
		t.Fatalf("wrap client key: %v", err)
	}
	s.mu.Lock()
	s.pubKeys[string(signer.PublicKey().Marshal())] = true
	s.mu.Unlock()
	return string(pem.EncodeToMemory(&pem.Block{
		Type:  "RSA PRIVATE KEY",
		Bytes: x509.MarshalPKCS1PrivateKey(priv),
	}))
}

// lastWindowChange returns the most recent PTY resize observed, if any.
func (s *testSSHServer) lastWindowChange() (windowSize, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.changes) == 0 {
		return windowSize{}, false
	}
	return s.changes[len(s.changes)-1], true
}

func (s *testSSHServer) serve() {
	for {
		conn, err := s.ln.Accept()
		if err != nil {
			return
		}
		go s.handleConn(conn)
	}
}

func (s *testSSHServer) handleConn(conn net.Conn) {
	cfg := &ssh.ServerConfig{
		PasswordCallback: func(_ ssh.ConnMetadata, pw []byte) (*ssh.Permissions, error) {
			s.mu.Lock()
			want := s.password
			s.mu.Unlock()
			if want != "" && string(pw) == want {
				return &ssh.Permissions{}, nil
			}
			return nil, errors.New("bad password")
		},
		PublicKeyCallback: func(_ ssh.ConnMetadata, key ssh.PublicKey) (*ssh.Permissions, error) {
			s.mu.Lock()
			ok := s.pubKeys[string(key.Marshal())]
			s.mu.Unlock()
			if ok {
				return &ssh.Permissions{}, nil
			}
			return nil, errors.New("unknown public key")
		},
	}
	cfg.AddHostKey(s.hostSign)

	sc, chans, reqs, err := ssh.NewServerConn(conn, cfg)
	if err != nil {
		_ = conn.Close()
		return
	}
	_ = sc
	go ssh.DiscardRequests(reqs)
	for newChan := range chans {
		if newChan.ChannelType() != "session" {
			_ = newChan.Reject(ssh.UnknownChannelType, "unsupported channel type")
			continue
		}
		ch, chReqs, err := newChan.Accept()
		if err != nil {
			continue
		}
		go s.handleSession(ch, chReqs)
	}
	_ = conn.Close()
}

// handleSession echoes stdin to stdout and services channel requests for one
// accepted session channel.
func (s *testSSHServer) handleSession(ch ssh.Channel, reqs <-chan *ssh.Request) {
	defer func() { _ = ch.Close() }()

	// Echo loop: reflect every stdin byte back to stdout.
	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := ch.Read(buf)
			if n > 0 {
				if _, werr := ch.Write(buf[:n]); werr != nil {
					return
				}
			}
			if err != nil {
				return
			}
		}
	}()

	// Optional login banner so stdout delivery can be observed up front.
	if s.banner != "" {
		_, _ = ch.Write([]byte(s.banner))
	}

	for req := range reqs {
		switch req.Type {
		case "pty-req":
			_ = req.Reply(true, nil)
		case "window-change":
			s.recordWindowChange(req.Payload)
			_ = req.Reply(true, nil)
		default:
			if req.WantReply {
				_ = req.Reply(true, nil)
			}
		}
	}
}

func (s *testSSHServer) recordWindowChange(payload []byte) {
	if len(payload) < 8 {
		return
	}
	// Payload layout: width u32, height u32 (big-endian).
	ws := windowSize{
		cols: uint16(binary.BigEndian.Uint32(payload[0:4])),
		rows: uint16(binary.BigEndian.Uint32(payload[4:8])),
	}
	s.mu.Lock()
	s.changes = append(s.changes, ws)
	s.mu.Unlock()
}
