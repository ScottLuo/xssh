package sshmgr

import (
	"context"
	"crypto/rand"
	"fmt"
	"net"
	"strconv"
	"sync"
	"time"

	"github.com/oklog/ulid/v2"
	"golang.org/x/crypto/ssh"

	"github.com/scottluo/xssh/internal/store"
)

const (
	dialTimeout    = 10 * time.Second
	keepaliveIntvl = 30 * time.Second
	initCmdDelay   = 100 * time.Millisecond
)

// randReader is the entropy source used for ULID session ID generation.
var randReader = rand.Reader

// sshClient wraps an *ssh.Client with keepalive/liveness tracking.
// x/crypto does not expose a built-in keepalive or a health check on
// *ssh.Client, so we drive them here: a keepalive goroutine periodically
// pings the connection and marks it dead when the ping fails (SM-04).
type sshClient struct {
	client *ssh.Client
	dead   chan struct{} // closed once the connection is determined dead
	stop   chan struct{} // closed to stop the keepalive goroutine
	once   sync.Once
}

// markDead records that the connection is no longer usable.
func (sc *sshClient) markDead() {
	sc.once.Do(func() { close(sc.dead) })
}

// alive reports whether the connection is still considered healthy.
func (sc *sshClient) alive() bool {
	select {
	case <-sc.dead:
		return false
	default:
		return true
	}
}

// releaseClient stops the keepalive goroutine and closes the SSH client.
func releaseClient(sc *sshClient) {
	close(sc.stop)
	_ = sc.client.Close()
}

// Manager manages SSH connections and terminal sessions.
type Manager struct {
	mu       sync.Mutex
	clients  map[string]*sshClient // hostID → persistent SSH client
	sessions map[string]*Session   // sessionID → live tab session
}

// NewManager creates a Manager with its registries initialized.
func NewManager() *Manager {
	return &Manager{
		clients:  make(map[string]*sshClient),
		sessions: make(map[string]*Session),
	}
}

// clientFor returns a live SSH client for hostID, dialing a new one if the
// cached client is missing or dead (SM-01..SM-05).
func (m *Manager) clientFor(ctx context.Context, hostID string, h store.Host) (*sshClient, error) {
	m.mu.Lock()
	if sc, ok := m.clients[hostID]; ok && sc.alive() {
		m.mu.Unlock()
		return sc, nil // SM-01: reuse cached, alive client
	}
	old := m.clients[hostID]
	delete(m.clients, hostID) // SM-03: drop a missing/dead entry
	m.mu.Unlock()

	if old != nil {
		releaseClient(old)
	}

	nc, err := m.dialClient(ctx, h)
	if err != nil {
		return nil, err
	}

	// Store-if-free so a concurrent dialer for the same host does not orphan
	// a client that has already been registered.
	m.mu.Lock()
	if existing, ok := m.clients[hostID]; ok {
		m.mu.Unlock()
		releaseClient(nc)
		return existing, nil
	}
	m.clients[hostID] = nc
	m.mu.Unlock()
	return nc, nil // SM-05: cache and return
}

// dialClient establishes a new SSH connection for the given host.
func (m *Manager) dialClient(ctx context.Context, h store.Host) (*sshClient, error) {
	cfg := &ssh.ClientConfig{
		User:            h.User,
		Auth:            m.authMethods(h),
		HostKeyCallback: ssh.InsecureIgnoreHostKey(),
	}

	// Dial with a timeout that honors both the caller's context and the
	// fixed 10 s cap (spec §3.7).
	dialCtx, cancel := context.WithTimeout(ctx, dialTimeout)
	defer cancel()

	addr := net.JoinHostPort(h.Host, strconv.Itoa(h.Port))
	conn, err := (&net.Dialer{}).DialContext(dialCtx, "tcp", addr)
	if err != nil {
		return nil, fmt.Errorf("ssh dial %s: %w", addr, err)
	}
	clientConn, chans, reqs, err := ssh.NewClientConn(conn, addr, cfg)
	if err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("ssh handshake %s: %w", addr, err)
	}

	sc := &sshClient{
		client: ssh.NewClient(clientConn, chans, reqs),
		dead:   make(chan struct{}),
		stop:   make(chan struct{}),
	}
	// SM-04: keepalive every 30 s.
	go startKeepalive(sc)
	return sc, nil
}

// startKeepalive pings the connection on an interval and marks it dead when
// the ping fails, so idle connections are detected without active sessions.
func startKeepalive(sc *sshClient) {
	ticker := time.NewTicker(keepaliveIntvl)
	defer ticker.Stop()
	for {
		select {
		case <-sc.stop:
			return
		case <-ticker.C:
			if err := pingClient(sc.client); err != nil {
				sc.markDead()
				_ = sc.client.Close()
			}
		}
	}
}

// pingClient exercises the connection by sending a keepalive request. A
// failure indicates the connection is no longer usable.
func pingClient(c *ssh.Client) error {
	sess, err := c.NewSession()
	if err != nil {
		return err
	}
	defer func() { _ = sess.Close() }()
	_, err = sess.SendRequest("keepalive@openssh.com", false, nil)
	return err
}

// authMethods builds the SSH auth methods from the host record.
func (m *Manager) authMethods(h store.Host) []ssh.AuthMethod {
	switch h.AuthType {
	case "key":
		signer, err := ssh.ParsePrivateKey([]byte(h.AuthSecret))
		if err != nil {
			// Fall back to password auth if the key cannot be parsed; the
			// dial will surface a descriptive error.
			return []ssh.AuthMethod{ssh.Password(h.AuthSecret)}
		}
		return []ssh.AuthMethod{ssh.PublicKeys(signer)}
	default: // "password"
		return []ssh.AuthMethod{ssh.Password(h.AuthSecret)}
	}
}

// OpenTab creates a new PTY-backed terminal session for the host.
// It returns the generated ULID session ID, the live session, and any error.
// The onOut callback is invoked for each chunk of PTY output, and onClosed
// is invoked when the session's pump goroutines have all finished.
func (m *Manager) OpenTab(ctx context.Context, hostID string, h store.Host, cols, rows uint16, onOut func(sid string, data []byte), onClosed func(sid string)) (string, *Session, error) {
	sc, err := m.clientFor(ctx, hostID, h)
	if err != nil {
		return "", nil, err
	}
	client := sc.client

	sess, err := client.NewSession()
	if err != nil {
		return "", nil, fmt.Errorf("new session: %w", err)
	}

	// Request a PTY; fail clearly if rejected (spec §3.7).
	modes := ssh.TerminalModes{
		ssh.ECHO:          1,
		ssh.TTY_OP_ISPEED: 14400,
		ssh.TTY_OP_OSPEED: 14400,
	}
	if err := sess.RequestPty("xterm-256color", int(rows), int(cols), modes); err != nil {
		_ = sess.Close()
		return "", nil, fmt.Errorf("pty request: %w", err)
	}

	// Establish the I/O pipes before starting the shell: x/crypto requires
	// Stdin/Stdout/StderrPipe to be requested before the session process runs.
	stdin, err := sess.StdinPipe()
	if err != nil {
		_ = sess.Close()
		return "", nil, fmt.Errorf("stdin pipe: %w", err)
	}
	stdout, err := sess.StdoutPipe()
	if err != nil {
		_ = sess.Close()
		_ = stdin.Close()
		return "", nil, fmt.Errorf("stdout pipe: %w", err)
	}
	stderr, err := sess.StderrPipe()
	if err != nil {
		_ = sess.Close()
		_ = stdin.Close()
		return "", nil, fmt.Errorf("stderr pipe: %w", err)
	}

	// Start an interactive login shell so shell builtins and rc files apply.
	if err := sess.Shell(); err != nil {
		_ = sess.Close()
		_ = stdin.Close()
		return "", nil, fmt.Errorf("start shell: %w", err)
	}

	id, err := ulid.New(ulid.Now(), randReader)
	if err != nil {
		_ = sess.Close()
		_ = stdin.Close()
		return "", nil, fmt.Errorf("generate session id: %w", err)
	}
	sid := id.String()

	sCtx, sCancel := context.WithCancel(ctx)
	session := &Session{
		ID:       sid,
		hostID:   hostID,
		client:   client,
		sess:     sess,
		stdin:    stdin,
		stdout:   stdout,
		stderr:   stderr,
		onOut:    onOut,
		onClosed: onClosed,
		ctx:      sCtx,
		cancel:   sCancel,
	}

	m.mu.Lock()
	m.sessions[sid] = session
	m.mu.Unlock()

	// Start I/O pump goroutines (stdout + stderr + watcher).
	startPump(session)

	// Write initial commands to the live shell after a short delay so the
	// shell prompt is ready (spec §3.6).
	if len(h.InitCmds) > 0 {
		go m.writeInitCmds(session, h.InitCmds)
	}

	return sid, session, nil
}

// writeInitCmds writes each initial command to the shell stdin sequentially,
// after a short delay to let the login shell initialize.
func (m *Manager) writeInitCmds(s *Session, cmds []string) {
	select {
	case <-time.After(initCmdDelay):
	case <-s.ctx.Done():
		return
	}
	for _, cmd := range cmds {
		if s.ctx.Err() != nil {
			return
		}
		if _, err := fmt.Fprintf(s.stdin, "%s\n", cmd); err != nil {
			return
		}
	}
}

// GetSession returns the live session for sid, if it exists.
func (m *Manager) GetSession(sid string) (*Session, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.sessions[sid]
	return s, ok
}

// CloseTab closes the session with the given ID and waits for its pump
// goroutines to finish. It is idempotent: closing an unknown ID returns nil.
func (m *Manager) CloseTab(ctx context.Context, sid string) error {
	m.mu.Lock()
	s, ok := m.sessions[sid]
	if !ok {
		m.mu.Unlock()
		return nil // idempotent
	}
	delete(m.sessions, sid)
	m.mu.Unlock()

	// Close stdin + SSH session and cancel context.
	// The session is fully drained asynchronously; the onClosed callback
	// is invoked by the pump watcher once all reader goroutines exit.
	s.Close()
	return nil
}

// CloseAll closes every open session and every cached client, clearing the
// registries. Intended for application shutdown.
func (m *Manager) CloseAll(ctx context.Context) {
	m.mu.Lock()
	sessions := make(map[string]*Session, len(m.sessions))
	for k, v := range m.sessions {
		sessions[k] = v
	}
	clients := make(map[string]*sshClient, len(m.clients))
	for k, v := range m.clients {
		clients[k] = v
	}
	m.sessions = make(map[string]*Session)
	m.clients = make(map[string]*sshClient)
	m.mu.Unlock()

	for _, s := range sessions {
		s.Close()
	}
	for _, c := range clients {
		releaseClient(c)
	}
}

// CloseSessionsForHost closes all sessions that belong to hostID.
// Used when a host card is deleted (cascade close).
func (m *Manager) CloseSessionsForHost(hostID string) {
	m.mu.Lock()
	var toClose []*Session
	for sid, s := range m.sessions {
		if s.hostID == hostID {
			toClose = append(toClose, s)
			delete(m.sessions, sid)
		}
	}
	m.mu.Unlock()

	for _, s := range toClose {
		s.Close()
	}
}
